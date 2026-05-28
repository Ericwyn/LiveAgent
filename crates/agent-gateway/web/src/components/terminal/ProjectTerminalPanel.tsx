import "@xterm/xterm/css/xterm.css";

import { FitAddon } from "@xterm/addon-fit";
import { Terminal as XTerm } from "@xterm/xterm";
import {
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { cn } from "@/lib/shared/utils";
import type {
  TerminalClient,
  TerminalSession,
  TerminalShellOption,
} from "@/lib/terminal/types";
import { Check, Plus, Terminal, X } from "../icons";
import { Button } from "../ui/button";

const MIN_PANEL_WIDTH = 320;
const MAX_PANEL_WIDTH = 720;
const DEFAULT_TERMINAL_COLS = 80;
const DEFAULT_TERMINAL_ROWS = 24;

type ProjectTerminalPanelProps = {
  isOpen: boolean;
  projectPathKey: string;
  cwd: string;
  sessions?: TerminalSession[];
  width: number;
  theme: "light" | "dark";
  disabledMessage?: string;
  client: TerminalClient;
  onWidthChange: (width: number) => void;
  onSessionsChange?: (sessions: TerminalSession[]) => void;
};

function sortSessions(sessions: TerminalSession[]) {
  return [...sessions].sort((a, b) => a.createdAt - b.createdAt);
}

function areSessionsEqual(left: TerminalSession[], right: TerminalSession[]) {
  if (left.length !== right.length) return false;
  return left.every((session, index) => {
    const other = right[index];
    return (
      other &&
      session.id === other.id &&
      session.projectPathKey === other.projectPathKey &&
      session.cwd === other.cwd &&
      session.shell === other.shell &&
      session.title === other.title &&
      session.pid === other.pid &&
      session.cols === other.cols &&
      session.rows === other.rows &&
      session.createdAt === other.createdAt &&
      session.updatedAt === other.updatedAt &&
      session.finishedAt === other.finishedAt &&
      session.exitCode === other.exitCode &&
      session.running === other.running
    );
  });
}

function terminalTheme(theme: "light" | "dark") {
  if (theme === "dark") {
    return {
      background: "#0b0f14",
      foreground: "#d6deeb",
      cursor: "#f8fafc",
      selectionBackground: "#334155",
      black: "#0f172a",
      red: "#ef4444",
      green: "#22c55e",
      yellow: "#eab308",
      blue: "#38bdf8",
      magenta: "#c084fc",
      cyan: "#2dd4bf",
      white: "#e5e7eb",
    };
  }
  return {
    background: "#ffffff",
    foreground: "#172033",
    cursor: "#111827",
    selectionBackground: "#dbeafe",
    black: "#111827",
    red: "#dc2626",
    green: "#16a34a",
    yellow: "#ca8a04",
    blue: "#2563eb",
    magenta: "#9333ea",
    cyan: "#0891b2",
    white: "#f8fafc",
  };
}

function XTermViewport({
  client,
  session,
  theme,
  onError,
}: {
  client: TerminalClient;
  session: TerminalSession;
  theme: "light" | "dark";
  onError: (message: string | null) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const resizeTimerRef = useRef<number | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let disposed = false;
    const term = new XTerm({
      convertEol: true,
      cursorBlink: true,
      disableStdin: !session.running,
      fontFamily:
        'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace',
      fontSize: 13,
      lineHeight: 1.2,
      scrollback: 5000,
      theme: terminalTheme(theme),
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(container);

    const fitAndResize = () => {
      if (disposed) return;
      try {
        fit.fit();
        void client
          .resize(session.id, term.cols, term.rows, session.projectPathKey)
          .catch(() => undefined);
      } catch {
        // xterm fit can throw while the panel is hidden or measuring at zero size.
      }
    };

    const resizeObserver = new ResizeObserver(() => {
      if (resizeTimerRef.current !== null) {
        window.clearTimeout(resizeTimerRef.current);
      }
      resizeTimerRef.current = window.setTimeout(fitAndResize, 40);
    });
    resizeObserver.observe(container);
    window.setTimeout(fitAndResize, 0);

    const dataDisposable = term.onData((data) => {
      void client.input(session.id, data, session.projectPathKey).catch((error) => {
        onError(error instanceof Error ? error.message : String(error));
      });
    });

    void client
      .snapshot(session.id, undefined, session.projectPathKey)
      .then((snapshot) => {
        if (disposed) return;
        term.reset();
        if (snapshot.output) {
          term.write(snapshot.output);
        }
        window.setTimeout(fitAndResize, 0);
      })
      .catch((error) => {
        if (!disposed) {
          onError(error instanceof Error ? error.message : String(error));
        }
      });

    const unsubscribe = client.subscribe((event) => {
      if (disposed || event.sessionId !== session.id) return;
      if (event.kind === "output" && event.data) {
        term.write(event.data);
      }
      if (event.kind === "exit" || event.kind === "closed") {
        term.options.disableStdin = true;
      }
    });

    return () => {
      disposed = true;
      unsubscribe();
      dataDisposable.dispose();
      resizeObserver.disconnect();
      if (resizeTimerRef.current !== null) {
        window.clearTimeout(resizeTimerRef.current);
        resizeTimerRef.current = null;
      }
      void client.detach(session.id, session.projectPathKey).catch(() => undefined);
      term.dispose();
    };
  }, [client, onError, session.id, session.projectPathKey, session.running, theme]);

  return <div ref={containerRef} className="h-full min-h-0 w-full overflow-hidden px-2 py-2" />;
}

export function ProjectTerminalPanel(props: ProjectTerminalPanelProps) {
  const {
    isOpen,
    projectPathKey,
    cwd,
    sessions: externalSessions,
    width,
    theme,
    disabledMessage,
    client,
    onWidthChange,
    onSessionsChange,
  } = props;
  const [sessions, setSessions] = useState<TerminalSession[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string>("");
  const [loading, setLoading] = useState(false);
  const [creating, setCreating] = useState(false);
  const [closingSessionId, setClosingSessionId] = useState("");
  const [pendingCloseSessionId, setPendingCloseSessionId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [shellOptions, setShellOptions] = useState<TerminalShellOption[]>([]);
  const [selectedShell, setSelectedShell] = useState("");
  const [shouldRenderContent, setShouldRenderContent] = useState(isOpen);
  const [isResizing, setIsResizing] = useState(false);
  const projectReady = projectPathKey.trim() !== "" && cwd.trim() !== "" && !disabledMessage;
  const clampedWidth = Math.min(MAX_PANEL_WIDTH, Math.max(MIN_PANEL_WIDTH, width));
  const [draftWidth, setDraftWidth] = useState(clampedWidth);
  const lastProjectPathKeyRef = useRef(projectPathKey);
  const pendingResizeWidthRef = useRef(clampedWidth);
  const resizeFrameRef = useRef<number | null>(null);
  const resizingRef = useRef(false);
  const resizeCleanupRef = useRef<(() => void) | null>(null);
  const panelWidth = Math.min(MAX_PANEL_WIDTH, Math.max(MIN_PANEL_WIDTH, draftWidth));
  const panelStyle = { "--terminal-panel-width": `${panelWidth}px` } as CSSProperties;
  const isControlled = externalSessions !== undefined;

  const activeSession = useMemo(
    () => sessions.find((session) => session.id === activeSessionId) ?? sessions[0] ?? null,
    [activeSessionId, sessions],
  );
  const pendingCloseSession = useMemo(
    () => sessions.find((session) => session.id === pendingCloseSessionId) ?? null,
    [pendingCloseSessionId, sessions],
  );

  const publishSessions = useCallback(
    (nextSessions: TerminalSession[], options?: { notifyParent?: boolean }) => {
      const sorted = sortSessions(nextSessions);
      setSessions(sorted);
      if (options?.notifyParent !== false) {
        onSessionsChange?.(sorted);
      }
      setActiveSessionId((current) => {
        if (current && sorted.some((session) => session.id === current)) return current;
        return sorted[0]?.id ?? "";
      });
    },
    [onSessionsChange],
  );

  useEffect(() => {
    if (!externalSessions) return;
    const sorted = sortSessions(externalSessions);
    setSessions((current) => (areSessionsEqual(current, sorted) ? current : sorted));
    setActiveSessionId((current) => {
      if (current && sorted.some((session) => session.id === current)) return current;
      return sorted[0]?.id ?? "";
    });
  }, [externalSessions]);

  const refreshSessions = useCallback(() => {
    if (!projectReady) {
      publishSessions([], { notifyParent: false });
      return;
    }
    setLoading(true);
    setError(null);
    void client
      .list(projectPathKey)
      .then((nextSessions) => {
        publishSessions(nextSessions, { notifyParent: !isControlled });
      })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setLoading(false));
  }, [client, isControlled, projectPathKey, projectReady, publishSessions]);

  useEffect(() => {
    if (!isOpen || isControlled) return;
    refreshSessions();
  }, [isControlled, isOpen, refreshSessions]);

  useEffect(() => {
    if (resizingRef.current) return;
    pendingResizeWidthRef.current = clampedWidth;
    setDraftWidth(clampedWidth);
  }, [clampedWidth]);

  useEffect(() => {
    return () => {
      resizeCleanupRef.current?.();
      if (resizeFrameRef.current !== null) {
        window.cancelAnimationFrame(resizeFrameRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (isOpen) {
      setShouldRenderContent(true);
      return;
    }
    const timer = window.setTimeout(() => setShouldRenderContent(false), 220);
    return () => window.clearTimeout(timer);
  }, [isOpen]);

  useEffect(() => {
    if (!projectReady) {
      setShellOptions([]);
      setSelectedShell("");
      return;
    }
    let cancelled = false;
    void client
      .shellOptions()
      .then((response) => {
        if (cancelled) return;
        setShellOptions(response.options);
        setSelectedShell((current) => {
          if (current && response.options.some((option) => option.id === current)) {
            return current;
          }
          return response.defaultShell || response.options[0]?.id || "";
        });
      })
      .catch(() => {
        if (!cancelled) {
          setShellOptions([]);
          setSelectedShell("");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [client, projectReady]);

  useEffect(() => {
    if (!projectReady) return;
    return client.subscribe((event) => {
      if (event.projectPathKey !== projectPathKey) return;
      if (event.kind === "output") return;
      setSessions((current) => {
        let next = current;
        if (event.kind === "closed") {
          next = current.filter((session) => session.id !== event.sessionId);
        } else {
          const index = current.findIndex((session) => session.id === event.sessionId);
          if (index >= 0) {
            next = [...current];
            next[index] = event.session;
          } else if (event.kind === "created") {
            next = [...current, event.session];
          }
        }
        const sorted = sortSessions(next);
        onSessionsChange?.(sorted);
        return sorted;
      });
    });
  }, [client, onSessionsChange, projectPathKey, projectReady]);

  useEffect(() => {
    if (lastProjectPathKeyRef.current === projectPathKey) return;
    lastProjectPathKeyRef.current = projectPathKey;
    setPendingCloseSessionId("");
    setClosingSessionId("");
  }, [projectPathKey]);

  useEffect(() => {
    if (!pendingCloseSessionId) return;
    if (!sessions.some((session) => session.id === pendingCloseSessionId)) {
      setPendingCloseSessionId("");
    }
  }, [pendingCloseSessionId, sessions]);

  const handleCreate = useCallback(() => {
    if (!projectReady || creating) return;
    setCreating(true);
    setError(null);
    void client
      .create({
        cwd,
        projectPathKey,
        shell: selectedShell || undefined,
        cols: DEFAULT_TERMINAL_COLS,
        rows: DEFAULT_TERMINAL_ROWS,
      })
      .then((snapshot) => {
        setSessions((current) => {
          const next = sortSessions([
            ...current.filter((session) => session.id !== snapshot.session.id),
            snapshot.session,
          ]);
          onSessionsChange?.(next);
          return next;
        });
        setActiveSessionId(snapshot.session.id);
      })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setCreating(false));
  }, [client, creating, cwd, onSessionsChange, projectPathKey, projectReady, selectedShell]);

  const closeSession = useCallback(
    (session: TerminalSession) => {
      if (closingSessionId === session.id) return;
      setError(null);
      setClosingSessionId(session.id);
      void client
        .close(session.id, session.projectPathKey)
        .then(() => {
          setPendingCloseSessionId((current) => (current === session.id ? "" : current));
          setSessions((current) => {
            const next = sortSessions(current.filter((item) => item.id !== session.id));
            onSessionsChange?.(next);
            return next;
          });
        })
        .catch((err) => setError(err instanceof Error ? err.message : String(err)))
        .finally(() => setClosingSessionId((current) => (current === session.id ? "" : current)));
    },
    [client, closingSessionId, onSessionsChange],
  );

  const handleCloseRequest = useCallback(
    (session: TerminalSession) => {
      setError(null);
      if (session.running && pendingCloseSessionId !== session.id) {
        setActiveSessionId(session.id);
        setPendingCloseSessionId(session.id);
        return;
      }
      closeSession(session);
    },
    [closeSession, pendingCloseSessionId],
  );

  const handleResizeStart = useCallback(
    (event: ReactMouseEvent<HTMLButtonElement>) => {
      if (event.button !== 0) return;
      event.preventDefault();
      resizeCleanupRef.current?.();
      const startX = event.clientX;
      const startWidth = panelWidth;
      const previousCursor = document.body.style.cursor;
      const previousUserSelect = document.body.style.userSelect;
      resizingRef.current = true;
      setIsResizing(true);
      pendingResizeWidthRef.current = startWidth;
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";

      const scheduleDraftWidth = (nextWidth: number) => {
        pendingResizeWidthRef.current = nextWidth;
        if (resizeFrameRef.current !== null) return;
        resizeFrameRef.current = window.requestAnimationFrame(() => {
          resizeFrameRef.current = null;
          setDraftWidth(pendingResizeWidthRef.current);
        });
      };

      const cleanupResize = () => {
        window.removeEventListener("mousemove", handleMove);
        window.removeEventListener("mouseup", handleUp);
        window.removeEventListener("blur", handleUp);
        document.body.style.cursor = previousCursor;
        document.body.style.userSelect = previousUserSelect;
        resizingRef.current = false;
        resizeCleanupRef.current = null;
      };

      const handleMove = (moveEvent: globalThis.MouseEvent) => {
        const nextWidth = Math.min(
          MAX_PANEL_WIDTH,
          Math.max(MIN_PANEL_WIDTH, startWidth + startX - moveEvent.clientX),
        );
        scheduleDraftWidth(nextWidth);
      };

      const handleUp = () => {
        cleanupResize();
        if (resizeFrameRef.current !== null) {
          window.cancelAnimationFrame(resizeFrameRef.current);
          resizeFrameRef.current = null;
        }
        const finalWidth = pendingResizeWidthRef.current;
        setDraftWidth(finalWidth);
        if (finalWidth !== clampedWidth) {
          onWidthChange(finalWidth);
        }
        setIsResizing(false);
      };

      resizeCleanupRef.current = cleanupResize;
      window.addEventListener("mousemove", handleMove);
      window.addEventListener("mouseup", handleUp);
      window.addEventListener("blur", handleUp);
    },
    [clampedWidth, onWidthChange, panelWidth],
  );

  return (
    <aside
      aria-hidden={!isOpen}
      inert={!isOpen}
      data-state={isOpen ? "open" : "closed"}
      className={cn(
        "fixed inset-x-0 bottom-0 z-40 flex h-[min(72vh,34rem)] min-h-0 w-full shrink-0 flex-col overflow-hidden bg-background shadow-2xl transition-[opacity,transform] duration-200 ease-out motion-reduce:transition-none md:relative md:inset-auto md:z-10 md:h-full md:shadow-none",
        !isResizing && "md:transition-[width,opacity,transform]",
        isOpen
          ? "pointer-events-auto translate-y-0 border-t border-border opacity-100 md:w-[var(--terminal-panel-width)] md:translate-x-0 md:border-l md:border-t-0"
          : "pointer-events-none translate-y-full border-t border-transparent opacity-0 md:w-0 md:translate-x-3 md:translate-y-0 md:border-l-0 md:border-t-0",
      )}
      style={panelStyle}
    >
      <div
        className={cn(
          "flex h-full min-h-0 w-full flex-col transition-[opacity,transform] duration-200 ease-out motion-reduce:transition-none md:w-[var(--terminal-panel-width)] md:min-w-[var(--terminal-panel-width)]",
          isOpen
            ? "translate-y-0 opacity-100 md:translate-x-0"
            : "translate-y-3 opacity-0 md:translate-x-2 md:translate-y-0",
        )}
      >
        {shouldRenderContent ? (
          <>
            <button
              type="button"
              aria-label="Resize terminal panel"
              title="Resize terminal panel"
              className="absolute inset-y-0 left-0 hidden w-1 cursor-col-resize border-0 bg-transparent p-0 md:block"
              onMouseDown={handleResizeStart}
            />
            <div className="flex h-11 shrink-0 items-center gap-2 border-b border-border px-3">
              <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
                {sessions.map((session) => {
                  const isPendingClose = pendingCloseSessionId === session.id;
                  const isClosing = closingSessionId === session.id;
                  return (
                    <div
                      key={session.id}
                      className={cn(
                        "group flex h-8 max-w-[12rem] shrink-0 items-center gap-1.5 rounded-md px-2 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground",
                        activeSession?.id === session.id && "bg-muted text-foreground",
                        isPendingClose &&
                          "bg-destructive/10 text-destructive hover:bg-destructive/15",
                      )}
                      title={session.title}
                    >
                      <button
                        type="button"
                        onClick={() => setActiveSessionId(session.id)}
                        className="flex min-w-0 flex-1 items-center gap-1.5 bg-transparent p-0 text-left text-inherit"
                      >
                        <Terminal className="h-3.5 w-3.5 shrink-0" />
                        <span className="min-w-0 truncate">{session.title}</span>
                        {!session.running ? (
                          <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-muted-foreground/50" />
                        ) : (
                          <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-500" />
                        )}
                      </button>
                      <button
                        type="button"
                        aria-label={`${isPendingClose ? "Confirm close" : "Close"} ${session.title}`}
                        title={isPendingClose ? "Confirm close terminal" : "Close terminal"}
                        disabled={isClosing}
                        className={cn(
                          "ml-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded text-muted-foreground/70 transition-colors hover:bg-background hover:text-foreground focus-visible:bg-background focus-visible:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50",
                          isPendingClose
                            ? "bg-destructive/10 text-destructive hover:bg-destructive hover:text-destructive-foreground md:opacity-100"
                            : "md:opacity-0 md:group-hover:opacity-100 md:focus-visible:opacity-100",
                        )}
                        onMouseDown={(event) => {
                          event.stopPropagation();
                        }}
                        onClick={(event) => {
                          event.stopPropagation();
                          handleCloseRequest(session);
                        }}
                      >
                        {isPendingClose ? <Check className="h-3 w-3" /> : <X className="h-3 w-3" />}
                      </button>
                    </div>
                  );
                })}
              </div>
              {shellOptions.length > 1 ? (
                <select
                  value={selectedShell}
                  onChange={(event) => setSelectedShell(event.target.value)}
                  disabled={creating}
                  title="Shell"
                  className="h-8 max-w-[8rem] shrink-0 rounded-md border border-border bg-background px-2 text-xs text-foreground outline-none hover:bg-muted focus:ring-2 focus:ring-ring"
                >
                  {shellOptions.map((option) => (
                    <option key={option.id} value={option.id}>
                      {option.label}
                    </option>
                  ))}
                </select>
              ) : null}
              <Button
                variant="ghost"
                size="icon"
                onClick={handleCreate}
                disabled={!projectReady || creating}
                title="New Terminal"
                className="h-8 w-8 rounded-lg text-muted-foreground hover:text-foreground"
              >
                <Plus className="h-4 w-4" />
              </Button>
            </div>

            {pendingCloseSession ? (
              <div className="flex shrink-0 items-center gap-2 border-b border-destructive/20 bg-destructive/5 px-3 py-2 text-xs text-destructive">
                <span className="min-w-0 flex-1 truncate">
                  Close running terminal "{pendingCloseSession.title}"?
                </span>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-7 shrink-0 px-2.5 text-xs"
                  onClick={() => setPendingCloseSessionId("")}
                >
                  Cancel
                </Button>
                <Button
                  type="button"
                  variant="destructive"
                  size="sm"
                  className="h-7 shrink-0 px-2.5 text-xs"
                  disabled={closingSessionId === pendingCloseSession.id}
                  onClick={() => closeSession(pendingCloseSession)}
                >
                  Close
                </Button>
              </div>
            ) : null}

            {disabledMessage ? (
              <div className="flex flex-1 items-center justify-center px-6 text-center text-sm text-muted-foreground">
                {disabledMessage}
              </div>
            ) : activeSession ? (
              <div className="flex min-h-0 flex-1 flex-col">
                {error ? (
                  <div className="border-b border-destructive/20 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                    {error}
                  </div>
                ) : null}
                <div className="min-h-0 flex-1">
                  <XTermViewport
                    key={activeSession.id}
                    client={client}
                    session={activeSession}
                    theme={theme}
                    onError={setError}
                  />
                </div>
              </div>
            ) : (
              <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
                <Terminal className="h-8 w-8 text-muted-foreground" />
                <Button onClick={handleCreate} disabled={!projectReady || creating}>
                  New Terminal
                </Button>
                {loading ? <div className="text-xs text-muted-foreground">Loading...</div> : null}
                {error ? <div className="text-xs text-destructive">{error}</div> : null}
              </div>
            )}
          </>
        ) : null}
      </div>
    </aside>
  );
}
