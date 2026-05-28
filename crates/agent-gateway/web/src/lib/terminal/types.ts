export type TerminalSession = {
  id: string;
  projectPathKey: string;
  cwd: string;
  shell: string;
  title: string;
  pid?: number | null;
  cols: number;
  rows: number;
  createdAt: number;
  updatedAt: number;
  finishedAt?: number | null;
  exitCode?: number | null;
  running: boolean;
};

export type TerminalSnapshot = {
  session: TerminalSession;
  output: string;
  truncated: boolean;
};

export type TerminalShellOption = {
  id: string;
  label: string;
  command: string;
};

export type TerminalShellOptions = {
  options: TerminalShellOption[];
  defaultShell: string;
};

export type TerminalEvent = {
  kind: string;
  sessionId: string;
  projectPathKey: string;
  session: TerminalSession;
  data?: string;
};

export type TerminalClient = {
  shellOptions(): Promise<TerminalShellOptions>;
  list(projectPathKey?: string): Promise<TerminalSession[]>;
  create(params: {
    cwd: string;
    projectPathKey: string;
    shell?: string;
    title?: string;
    cols?: number;
    rows?: number;
  }): Promise<TerminalSnapshot>;
  snapshot(
    sessionId: string,
    maxBytes?: number,
    projectPathKey?: string,
  ): Promise<TerminalSnapshot>;
  input(sessionId: string, data: string, projectPathKey?: string): Promise<void>;
  resize(
    sessionId: string,
    cols: number,
    rows: number,
    projectPathKey?: string,
  ): Promise<void>;
  rename(sessionId: string, title: string, projectPathKey?: string): Promise<TerminalSession>;
  close(sessionId: string, projectPathKey?: string): Promise<TerminalSession>;
  closeProject(projectPathKey: string): Promise<TerminalSession[]>;
  detach(sessionId: string, projectPathKey?: string): Promise<void>;
  subscribe(listener: (event: TerminalEvent) => void): () => void;
};
