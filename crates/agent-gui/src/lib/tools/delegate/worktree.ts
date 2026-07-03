import { invoke } from "@tauri-apps/api/core";

import type { DelegateAgentItemResultDetails } from "../builtinTypes";
import type {
  DelegateAgentInput,
  DelegateWorktreeApplyResult,
  DelegateWorktreeCleanupResult,
  DelegateWorktreeInfo,
  DelegateWorktreeStatus,
  WorktreeApplyDecision,
} from "./types";
import { sanitizeLabelPart } from "./utils";

// Cleans paths coming out of git status/porcelain output. Malformed entries
// are dropped, not surfaced — git plumbing noise is not a tool-input error.
function normalizeGitStatusPath(value: string) {
  const normalized = value.trim().replace(/\\/g, "/").replace(/^\.\//, "");
  if (
    !normalized ||
    /^[a-zA-Z]:\//.test(normalized) ||
    normalized.startsWith("/") ||
    normalized === "." ||
    normalized === ".."
  ) {
    return "";
  }

  const segments: string[] = [];
  for (const segment of normalized.split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === ".." || segment.includes(":")) return "";
    segments.push(segment);
  }
  return segments.join("/");
}

function pathMatchesAllowedOutput(path: string, allowedPath: string) {
  if (!allowedPath || allowedPath === ".") return true;
  if (allowedPath.includes("*") || allowedPath.includes("?") || allowedPath.includes("[")) {
    return globAllowedOutputPathToRegExp(allowedPath).test(path);
  }
  return path === allowedPath || path.startsWith(`${allowedPath}/`);
}

function globAllowedOutputPathToRegExp(pattern: string) {
  let source = "^";
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index] ?? "";
    const next = pattern[index + 1] ?? "";
    if (char === "*" && next === "*") {
      const after = pattern[index + 2] ?? "";
      if (after === "/") {
        source += "(?:.*/)?";
        index += 2;
      } else {
        source += ".*";
        index += 1;
      }
      continue;
    }
    if (char === "*") {
      source += "[^/]*";
      continue;
    }
    if (char === "?") {
      source += "[^/]";
      continue;
    }
    source += char.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
  }
  return new RegExp(`${source}$`);
}

function decodeGitQuotedPath(value: string) {
  const text = value.trim();
  if (!(text.startsWith('"') && text.endsWith('"'))) return text;
  const body = text.slice(1, -1);
  const decoder = new TextDecoder();
  let output = "";
  let bytes: number[] = [];
  const flushBytes = () => {
    if (bytes.length === 0) return;
    output += decoder.decode(new Uint8Array(bytes));
    bytes = [];
  };

  for (let index = 0; index < body.length; index += 1) {
    const char = body[index] ?? "";
    if (char !== "\\") {
      flushBytes();
      output += char;
      continue;
    }

    const octal = body.slice(index + 1, index + 4);
    if (/^[0-7]{3}$/.test(octal)) {
      bytes.push(Number.parseInt(octal, 8));
      index += 3;
      continue;
    }

    flushBytes();
    const escaped = body[index + 1] ?? "";
    const replacements: Record<string, string> = {
      "\\": "\\",
      '"': '"',
      n: "\n",
      r: "\r",
      t: "\t",
      b: "\b",
      f: "\f",
    };
    output += replacements[escaped] ?? escaped;
    index += escaped ? 1 : 0;
  }
  flushBytes();
  return output;
}

function parseWorktreeStatusPath(line: string) {
  const trimmed = line.trim();
  if (!trimmed) return "";
  if (trimmed.startsWith("?? ")) {
    return normalizeGitStatusPath(decodeGitQuotedPath(trimmed.slice(3)));
  }
  const body = line.length > 3 ? line.slice(3).trim() : trimmed.slice(2).trim();
  const renamedPath = body.includes(" -> ") ? (body.split(" -> ").pop() ?? body) : body;
  return normalizeGitStatusPath(decodeGitQuotedPath(renamedPath));
}

function removeParentDirectoryPaths(paths: string[]) {
  return paths.filter((path) => {
    const prefix = `${path}/`;
    return !paths.some((candidate) => candidate !== path && candidate.startsWith(prefix));
  });
}

function shouldIgnoreChangedPath(path: string) {
  const basename = path.split("/").pop() ?? "";
  return basename === ".DS_Store" || basename === "Thumbs.db" || basename === "Desktop.ini";
}

function collectWorktreeChangedPaths(status: DelegateWorktreeStatus) {
  const paths = new Set<string>();
  for (const file of status.untracked_files ?? []) {
    const normalized = normalizeGitStatusPath(decodeGitQuotedPath(file));
    if (normalized && !shouldIgnoreChangedPath(normalized)) paths.add(normalized);
  }
  for (const line of (status.status || "").split(/\r?\n/g)) {
    const normalized = parseWorktreeStatusPath(line);
    if (normalized && !shouldIgnoreChangedPath(normalized)) paths.add(normalized);
  }
  return removeParentDirectoryPaths([...paths].sort());
}

function isLikelyCommunicationArtifact(path: string) {
  const normalized = normalizeGitStatusPath(path);
  if (!normalized) return false;
  const parts = normalized.split("/");
  const basename = (parts[parts.length - 1] ?? "").toLowerCase();
  if (!/\.(md|markdown|txt|rst)$/i.test(basename)) return false;
  if (parts.length <= 2) return true;
  return /(^|[-_.])(report|response|reply|contribution|discussion|roundtable|opening|notes|thoughts|summary|发言|回应|回复|讨论|观点|报告|品鉴|哲学|物理|科学|文学|禅|生命|意义)([-_.]|$)/i.test(
    basename,
  );
}

export function decideWorktreeApply(params: {
  task: DelegateAgentInput;
  status: DelegateWorktreeStatus;
}): WorktreeApplyDecision {
  const changedPaths = collectWorktreeChangedPaths(params.status);
  const candidateArtifacts =
    params.task.taskIntent === "implementation"
      ? []
      : changedPaths.filter(isLikelyCommunicationArtifact);

  if (!params.status.changed || changedPaths.length === 0) {
    return {
      shouldApply: false,
      skippedReason: params.status.changed ? "no_applyable_changes" : "no_changes",
      changedPaths,
      candidateArtifacts,
    };
  }

  if (params.task.applyPolicy === "none") {
    return {
      shouldApply: false,
      skippedReason: candidateArtifacts.length > 0 ? "artifact_only" : "apply_policy_none",
      changedPaths,
      candidateArtifacts: candidateArtifacts.length > 0 ? candidateArtifacts : changedPaths,
    };
  }

  if (params.task.applyPolicy === "explicit") {
    if (params.task.allowedOutputPaths.length === 0) {
      return {
        shouldApply: false,
        skippedReason:
          candidateArtifacts.length > 0
            ? "artifact_explicit_apply_required"
            : "explicit_apply_required",
        changedPaths,
        candidateArtifacts: candidateArtifacts.length > 0 ? candidateArtifacts : changedPaths,
      };
    }
    const disallowedPaths = changedPaths.filter(
      (path) =>
        !params.task.allowedOutputPaths.some((allowedPath) =>
          pathMatchesAllowedOutput(path, allowedPath),
        ),
    );
    if (disallowedPaths.length > 0) {
      return {
        shouldApply: false,
        skippedReason: "explicit_apply_paths_mismatch",
        changedPaths,
        candidateArtifacts: disallowedPaths,
      };
    }
  }

  return {
    shouldApply: true,
    changedPaths,
    candidateArtifacts,
  };
}

export function decideWorktreeCleanup(params: {
  task: DelegateAgentInput;
  status?: DelegateWorktreeStatus;
  statusError?: string;
  applyStatus?: DelegateAgentItemResultDetails["applyStatus"];
  applySkippedReason?: string;
}) {
  if (params.task.retainWorktree) {
    return { shouldCleanup: false, reason: "retain_worktree" };
  }
  if (params.statusError) {
    return { shouldCleanup: false, reason: "status_unavailable" };
  }
  if (params.applyStatus === "failed") {
    return { shouldCleanup: false, reason: "apply_failed" };
  }
  if (params.applyStatus === "applied") {
    return { shouldCleanup: true, reason: "applied" };
  }
  if (params.applySkippedReason === "already_applied") {
    return { shouldCleanup: true, reason: "already_applied" };
  }
  if (params.status && !params.status.changed) {
    return { shouldCleanup: true, reason: "no_changes" };
  }
  if (params.applySkippedReason === "no_changes") {
    return { shouldCleanup: true, reason: "no_changes" };
  }
  return { shouldCleanup: false, reason: "unapplied_changes" };
}

export function buildWorktreeLabel(params: {
  sessionId?: string;
  toolCallId: string;
  agent: DelegateAgentInput;
  index: number;
}) {
  const prefix = params.sessionId
    ? sanitizeLabelPart(params.sessionId.split(":")[0] || params.sessionId, "session")
    : "session";
  const call = sanitizeLabelPart(params.toolCallId, "call");
  const agent = sanitizeLabelPart(params.agent.id, `agent-${params.index + 1}`);
  return `${prefix}-${call}-${params.index + 1}-${agent}`;
}

export async function defaultCreateWorktree(params: {
  workdir: string;
  label: string;
}): Promise<DelegateWorktreeInfo> {
  return invoke<DelegateWorktreeInfo>("delegate_create_worktree", {
    workdir: params.workdir,
    label: params.label,
  } as any);
}

export async function defaultGetWorktreeStatus(params: {
  worktreeRoot: string;
  maxDiffChars: number;
}): Promise<DelegateWorktreeStatus> {
  return invoke<DelegateWorktreeStatus>("delegate_worktree_status", {
    worktree_root: params.worktreeRoot,
    max_diff_chars: params.maxDiffChars,
  } as any);
}

export async function defaultApplyWorktreeChanges(params: {
  parentWorkdir: string;
  worktreeRoot: string;
}): Promise<DelegateWorktreeApplyResult> {
  return invoke<DelegateWorktreeApplyResult>("delegate_apply_worktree_changes", {
    parent_workdir: params.parentWorkdir,
    worktree_root: params.worktreeRoot,
  } as any);
}

export async function defaultCleanupWorktree(params: {
  worktreeRoot: string;
  branchName?: string;
}): Promise<DelegateWorktreeCleanupResult> {
  return invoke<DelegateWorktreeCleanupResult>("delegate_cleanup_worktree", {
    worktree_root: params.worktreeRoot,
    branch_name: params.branchName,
    dry_run: false,
    force: true,
    delete_branch: true,
  } as any);
}
