import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type {
  TerminalClient,
  TerminalEvent,
  TerminalSession,
  TerminalShellOption,
  TerminalShellOptions,
  TerminalSnapshot,
} from "./types";

type TerminalEventListener = (event: TerminalEvent) => void;

const globalTerminalListeners = new Set<TerminalEventListener>();
let globalListenerStarted = false;

function ensureGlobalTerminalListener() {
  if (globalListenerStarted) return;
  globalListenerStarted = true;
  void listen<RawTerminalEvent>("terminal:event", (event) => {
    const normalized = normalizeEvent(event.payload);
    if (!normalized) return;
    for (const listener of globalTerminalListeners) {
      listener(normalized);
    }
  });
}

type RawTerminalSession = Partial<TerminalSession> & {
  project_path_key?: string;
  created_at?: number;
  updated_at?: number;
  finished_at?: number | null;
  exit_code?: number | null;
};

type RawTerminalSnapshot = {
  session?: RawTerminalSession;
  output?: string;
  truncated?: boolean;
  outputStartOffset?: number;
  output_start_offset?: number;
  outputEndOffset?: number;
  output_end_offset?: number;
};

type RawTerminalListResponse = {
  sessions?: RawTerminalSession[];
};

type RawTerminalShellOption = Partial<TerminalShellOption>;

type RawTerminalShellOptionsResponse = {
  options?: RawTerminalShellOption[];
  defaultShell?: string;
  default_shell?: string;
};

type RawTerminalEvent = {
  kind?: string;
  sessionId?: string;
  session_id?: string;
  projectPathKey?: string;
  project_path_key?: string;
  session?: RawTerminalSession;
  data?: string | null;
  outputStartOffset?: number;
  output_start_offset?: number;
  outputEndOffset?: number;
  output_end_offset?: number;
};

function normalizeSession(input: RawTerminalSession): TerminalSession {
  const projectPathKey = input.projectPathKey ?? input.project_path_key ?? "";
  return {
    id: input.id ?? "",
    projectPathKey,
    cwd: input.cwd ?? "",
    shell: input.shell ?? "",
    title: input.title ?? "Terminal",
    pid: input.pid ?? null,
    cols: Number(input.cols ?? 80),
    rows: Number(input.rows ?? 24),
    createdAt: Number(input.createdAt ?? input.created_at ?? 0),
    updatedAt: Number(input.updatedAt ?? input.updated_at ?? 0),
    finishedAt: input.finishedAt ?? input.finished_at ?? null,
    exitCode: input.exitCode ?? input.exit_code ?? null,
    running: input.running === true,
  };
}

function normalizeSnapshot(input: RawTerminalSnapshot): TerminalSnapshot {
  if (!input.session) {
    throw new Error("Terminal response did not include a session");
  }
  const outputStartOffset = normalizeOptionalOffset(
    input.outputStartOffset ?? input.output_start_offset,
  );
  const outputEndOffset = normalizeOptionalOffset(input.outputEndOffset ?? input.output_end_offset);
  return {
    session: normalizeSession(input.session),
    output: input.output ?? "",
    truncated: input.truncated === true,
    outputStartOffset,
    outputEndOffset,
  };
}

function normalizeShellOptions(input: RawTerminalShellOptionsResponse): TerminalShellOptions {
  const options = (input.options ?? [])
    .map((option) => ({
      id: option.id?.trim() ?? "",
      label: option.label?.trim() ?? "",
      command: option.command?.trim() ?? "",
    }))
    .filter((option) => option.id && option.label);
  return {
    options,
    defaultShell: input.defaultShell ?? input.default_shell ?? options[0]?.id ?? "default",
  };
}

function normalizeEvent(input: RawTerminalEvent): TerminalEvent | null {
  if (!input.session) return null;
  const session = normalizeSession(input.session);
  const outputStartOffset = normalizeOptionalOffset(
    input.outputStartOffset ?? input.output_start_offset,
  );
  const outputEndOffset = normalizeOptionalOffset(input.outputEndOffset ?? input.output_end_offset);
  return {
    kind: input.kind ?? "",
    sessionId: input.sessionId ?? input.session_id ?? session.id,
    projectPathKey: input.projectPathKey ?? input.project_path_key ?? session.projectPathKey,
    session,
    data: input.data ?? undefined,
    outputStartOffset,
    outputEndOffset,
  };
}

function normalizeOptionalOffset(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : undefined;
}

export const tauriTerminalClient: TerminalClient = {
  async shellOptions() {
    return normalizeShellOptions(
      await invoke<RawTerminalShellOptionsResponse>("terminal_shell_options"),
    );
  },
  async list(projectPathKey) {
    const response = await invoke<RawTerminalListResponse>("terminal_list", {
      project_path_key: projectPathKey,
    });
    return (response.sessions ?? []).map(normalizeSession);
  },
  async create(params) {
    return normalizeSnapshot(
      await invoke<RawTerminalSnapshot>("terminal_create", {
        cwd: params.cwd,
        project_path_key: params.projectPathKey,
        shell: params.shell,
        title: params.title,
        cols: params.cols,
        rows: params.rows,
      }),
    );
  },
  async snapshot(sessionId, maxBytes, _projectPathKey) {
    return normalizeSnapshot(
      await invoke<RawTerminalSnapshot>("terminal_snapshot", {
        session_id: sessionId,
        max_bytes: maxBytes,
      }),
    );
  },
  async input(sessionId, data, _projectPathKey) {
    await invoke("terminal_input", {
      session_id: sessionId,
      data,
    });
  },
  async resize(sessionId, cols, rows, _projectPathKey) {
    await invoke("terminal_resize", {
      session_id: sessionId,
      cols,
      rows,
    });
  },
  async rename(sessionId, title, _projectPathKey) {
    return normalizeSession(
      await invoke<RawTerminalSession>("terminal_rename", {
        session_id: sessionId,
        title,
      }),
    );
  },
  async close(sessionId, _projectPathKey) {
    return normalizeSession(
      await invoke<RawTerminalSession>("terminal_close", {
        session_id: sessionId,
      }),
    );
  },
  async closeProject(projectPathKey) {
    const response = await invoke<RawTerminalListResponse>("terminal_close_project", {
      project_path_key: projectPathKey,
    });
    return (response.sessions ?? []).map(normalizeSession);
  },
  async detach(_sessionId, _projectPathKey) {
    // Tauri clients receive local events directly; detach is only meaningful for Gateway fanout.
  },
  subscribe(listener) {
    ensureGlobalTerminalListener();
    globalTerminalListeners.add(listener);
    return () => {
      globalTerminalListeners.delete(listener);
    };
  },
};
