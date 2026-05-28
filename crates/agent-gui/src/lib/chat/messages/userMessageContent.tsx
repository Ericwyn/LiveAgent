import { getFileTypeIcon } from "../../../components/chat/fileTypeIcons";

import {
  type PastedTextDisplayReference,
  type PendingUploadedFile,
  parsePastedTextDisplayReferences,
} from "./uploadedFiles";

export function isMentionToken(token: string) {
  return /^@[^\s@][^\s]*$/.test(token);
}

const COMMON_SKILL_MENTION_ENV_VARS = new Set([
  "PATH",
  "HOME",
  "USER",
  "SHELL",
  "PWD",
  "TMPDIR",
  "TEMP",
  "TMP",
  "LANG",
  "TERM",
  "XDG_CONFIG_HOME",
]);

function isSkillMentionName(value: string) {
  return /^[A-Za-z0-9_:-]+$/.test(value);
}

function isCommonSkillMentionEnvVar(name: string) {
  const upper = name.toUpperCase();
  return (
    COMMON_SKILL_MENTION_ENV_VARS.has(upper) ||
    (upper.endsWith(":") && COMMON_SKILL_MENTION_ENV_VARS.has(upper.slice(0, -1)))
  );
}

export function isSkillMentionToken(token: string) {
  if (!token.startsWith("$")) return false;
  const name = token.slice(1);
  return Boolean(name) && isSkillMentionName(name) && !isCommonSkillMentionEnvVar(name);
}

type UserMessageSegment =
  | { type: "text"; value: string }
  | { type: "mention"; path: string; isDir: boolean }
  | { type: "skill"; name: string }
  | {
      type: "pastedText";
      reference: PastedTextDisplayReference;
      file: PendingUploadedFile;
    };

function pushTextSegment(segments: UserMessageSegment[], value: string) {
  if (!value) return;
  const last = segments[segments.length - 1];
  if (last?.type === "text") {
    last.value += value;
    return;
  }
  segments.push({ type: "text", value });
}

function appendSegments(segments: UserMessageSegment[], incoming: UserMessageSegment[]) {
  for (const segment of incoming) {
    if (segment.type === "text") {
      pushTextSegment(segments, segment.value);
    } else {
      segments.push(segment);
    }
  }
}

function unescapeMarkdown(value: string) {
  return value.replace(/\\([\\[\]()])/g, "$1");
}

function normalizeMarkdownDestination(value: string) {
  const trimmed = value.trim();
  const inner = trimmed.startsWith("<") && trimmed.endsWith(">") ? trimmed.slice(1, -1) : trimmed;
  return unescapeMarkdown(inner).replace(/%3C/gi, "<").replace(/%3E/gi, ">");
}

function normalizeReferencePath(value: string) {
  return value.trim().replace(/\\/g, "/");
}

function buildFileReference(rawPath: string) {
  const normalized = normalizeReferencePath(rawPath);
  const isDir = normalized.endsWith("/");
  const path = normalized.replace(/\/+$/, "");
  if (!path || path.startsWith("/") || path.startsWith("#")) return null;
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(path)) return null;
  if (path.split("/").some((part) => !part || part === "." || part === "..")) {
    return null;
  }
  return { path, isDir };
}

function markdownFileReference(label: string, rawDestination: string) {
  const reference = buildFileReference(normalizeMarkdownDestination(rawDestination));
  if (!reference) return null;

  const fileName = reference.path.split("/").pop() || reference.path;
  const expectedLabel = reference.isDir ? `${fileName}/` : fileName;
  if (unescapeMarkdown(label.trim()) !== expectedLabel) return null;

  return reference;
}

function isTokenBoundary(text: string, index: number) {
  return index === 0 || /\s/.test(text[index - 1] ?? "");
}

function tokenizeInlineMentions(text: string): UserMessageSegment[] {
  const segments: UserMessageSegment[] = [];
  let cursor = 0;

  for (let index = 0; index < text.length; index += 1) {
    const marker = text[index];
    if ((marker !== "@" && marker !== "$") || !isTokenBoundary(text, index)) {
      continue;
    }

    if (marker === "@") {
      let tokenEnd = index + 1;
      while (tokenEnd < text.length && !/\s/.test(text[tokenEnd])) {
        tokenEnd += 1;
      }
      const token = text.slice(index, tokenEnd);
      if (!isMentionToken(token)) continue;
      const reference = buildFileReference(token.slice(1));
      if (reference) {
        if (index > cursor) {
          pushTextSegment(segments, text.slice(cursor, index));
        }
        segments.push({ type: "mention", ...reference });
        cursor = tokenEnd;
        index = tokenEnd - 1;
      }
      continue;
    }

    let nameEnd = index + 1;
    while (nameEnd < text.length && /[A-Za-z0-9_:-]/.test(text[nameEnd])) {
      nameEnd += 1;
    }
    const token = text.slice(index, nameEnd);
    if (!isSkillMentionToken(token)) continue;
    if (index > cursor) {
      pushTextSegment(segments, text.slice(cursor, index));
    }
    segments.push({ type: "skill", name: token.slice(1) });
    cursor = nameEnd;
    index = nameEnd - 1;
  }

  if (cursor < text.length) {
    pushTextSegment(segments, text.slice(cursor));
  }

  if (segments.length === 0) {
    segments.push({ type: "text", value: text });
  }

  return segments;
}

function tokenizeMentions(text: string): UserMessageSegment[] {
  const segments: UserMessageSegment[] = [];
  const markdownPattern = /\[((?:\\.|[^\]\\\r\n])+)]\((<[^>\r\n]+>|[^)\r\n]+)\)/g;
  let cursor = 0;

  for (const match of text.matchAll(markdownPattern)) {
    const raw = match[0] ?? "";
    const label = match[1] ?? "";
    const destination = match[2] ?? "";
    const matchIndex = match.index ?? 0;
    const reference = markdownFileReference(label, destination);
    if (!reference) continue;

    if (matchIndex > cursor) {
      appendSegments(segments, tokenizeInlineMentions(text.slice(cursor, matchIndex)));
    }
    segments.push({ type: "mention", ...reference });
    cursor = matchIndex + raw.length;
  }

  if (cursor < text.length) {
    appendSegments(segments, tokenizeInlineMentions(text.slice(cursor)));
  }

  return segments.length > 0 ? segments : tokenizeInlineMentions(text);
}

function tokenizeUserMessage(
  text: string,
  pastedTextFiles: PendingUploadedFile[],
): UserMessageSegment[] {
  const fileByPath = new Map(pastedTextFiles.map((file) => [file.relativePath, file]));
  const references = parsePastedTextDisplayReferences(text);
  if (references.length === 0 || fileByPath.size === 0) {
    return tokenizeMentions(text);
  }

  const segments: UserMessageSegment[] = [];
  let cursor = 0;
  for (const reference of references) {
    const file = fileByPath.get(reference.relativePath);
    if (!file) continue;
    if (reference.start > cursor) {
      appendSegments(segments, tokenizeMentions(text.slice(cursor, reference.start)));
    }
    segments.push({ type: "pastedText", reference, file });
    cursor = reference.end;
  }

  if (cursor < text.length) {
    appendSegments(segments, tokenizeMentions(text.slice(cursor)));
  }

  return segments.length > 0 ? segments : tokenizeMentions(text);
}

function formatPastedTextCount(value: number) {
  return new Intl.NumberFormat().format(value);
}

function PastedTextChip({
  reference,
  file,
}: {
  reference: PastedTextDisplayReference;
  file: PendingUploadedFile;
}) {
  const label = file.displayLabel || reference.label;
  const hasCounts =
    typeof file.displayCharCount === "number" &&
    Number.isFinite(file.displayCharCount) &&
    typeof file.displayLineCount === "number" &&
    Number.isFinite(file.displayLineCount);
  const chipText = hasCounts
    ? `${label} · ${formatPastedTextCount(file.displayCharCount ?? 0)} chars · ${formatPastedTextCount(file.displayLineCount ?? 0)} lines`
    : label;
  const Icon = getFileTypeIcon(file.relativePath || "pasted.txt", "file");

  return (
    <span
      title={file.relativePath}
      className="mention-chip mx-0.5 inline-flex items-center gap-1 rounded bg-emerald-500/15 px-1.5 text-emerald-700 align-baseline whitespace-nowrap select-none dark:text-emerald-300"
    >
      <Icon className="h-3 w-3 shrink-0" />
      {chipText}
    </span>
  );
}

function MentionChip({ path, isDir }: { path: string; isDir: boolean }) {
  const fileName = path.split("/").pop() || path;
  const Icon = getFileTypeIcon(path, isDir ? "dir" : "file");
  return (
    <span
      title={isDir ? `${path}/` : path}
      className={
        isDir
          ? "mention-chip mx-0.5 inline-flex items-center gap-1 rounded bg-amber-400/25 px-1.5 align-baseline whitespace-nowrap"
          : "mention-chip mx-0.5 inline-flex items-center gap-1 rounded bg-blue-500/20 px-1.5 align-baseline whitespace-nowrap"
      }
    >
      <Icon className="h-3 w-3 shrink-0" />
      {fileName}
    </span>
  );
}

function SkillMentionChip({ name }: { name: string }) {
  return (
    <span
      title={`Skill: ${name}`}
      className="mention-chip mx-0.5 inline-flex items-center gap-1 rounded bg-violet-500/20 px-1.5 text-violet-700 align-baseline whitespace-nowrap select-none dark:text-violet-300"
    >
      <span className="text-[10px] font-semibold opacity-70">$</span>
      {name}
    </span>
  );
}

export function UserMessageContent({
  text,
  pastedTextFiles = [],
}: {
  text: string;
  pastedTextFiles?: PendingUploadedFile[];
}) {
  const parts = tokenizeUserMessage(text, pastedTextFiles);
  const hasChip = parts.some(
    (part) => part.type === "mention" || part.type === "skill" || part.type === "pastedText",
  );
  if (!hasChip) return <>{text}</>;

  return (
    <>
      {parts.map((part, idx) => {
        if (part.type === "mention") {
          return <MentionChip key={idx} path={part.path} isDir={part.isDir} />;
        }
        if (part.type === "skill") {
          return <SkillMentionChip key={idx} name={part.name} />;
        }
        if (part.type === "pastedText") {
          return <PastedTextChip key={idx} reference={part.reference} file={part.file} />;
        }
        return <span key={idx}>{part.value}</span>;
      })}
    </>
  );
}
