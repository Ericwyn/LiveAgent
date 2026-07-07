import type { ReactNode } from "react";
import { useLocale } from "../../i18n";
import type { RightDockTabKind } from "../../lib/settings";
import { cn } from "../../lib/shared/utils";
import type { TerminalSession } from "../../lib/terminal/types";
import { Check, Cpu, Terminal, X } from "../icons";
import { formatTerminalSessionTitle, type RightDockVisibleTab } from "./rightDockModel";
import { getRightDockToolDefinition, type RightDockSingletonTabKind } from "./rightDockRegistry";

type RightDockTabStripProps = {
  tabs: RightDockVisibleTab[];
  currentActiveTab: RightDockTabKind;
  backgroundTasksRunning: number;
  // Hide-only: clears the tab's session-local visibility and never touches
  // the processes themselves.
  onCloseBackgroundTasks: () => void;
  activeSession: TerminalSession | null;
  pendingCloseSessionId: string;
  closingSessionIds: ReadonlySet<string>;
  draggingTabId: string;
  renderTabDragHandle: (tabId: string, label: string) => ReactNode;
  consumeSuppressedTabClick: (tabId: string) => boolean;
  onActivateTab: (tabId: string) => void;
  onActivateTerminalSession: (session: TerminalSession) => void;
  onCloseToolTab: (kind: RightDockSingletonTabKind) => void;
  onCloseTerminalRequest: (session: TerminalSession) => void;
};

type ToolTabOptions = {
  tab: Extract<RightDockVisibleTab, { kind: RightDockSingletonTabKind }>;
  label: string;
  closeLabel: string;
  closeTitle: string;
  icon: ReactNode;
  onClose: () => void;
};

const TAB_BASE_CLASS =
  "project-tools-panel-tab group relative flex h-8 max-w-[12rem] shrink-0 select-none items-center gap-1 rounded-md border border-transparent px-1.5 text-xs text-muted-foreground transition-[background-color,border-color,color,opacity,transform,box-shadow] hover:bg-muted/80 hover:text-foreground";

const CLOSE_BUTTON_CLASS =
  "relative z-10 ml-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded text-muted-foreground/70 transition-colors hover:bg-background hover:text-foreground focus-visible:bg-background focus-visible:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring md:opacity-0 md:group-hover:opacity-100 md:focus-visible:opacity-100";

export function RightDockTabStrip(props: RightDockTabStripProps) {
  const {
    tabs,
    currentActiveTab,
    backgroundTasksRunning,
    onCloseBackgroundTasks,
    activeSession,
    pendingCloseSessionId,
    closingSessionIds,
    draggingTabId,
    renderTabDragHandle,
    consumeSuppressedTabClick,
    onActivateTab,
    onActivateTerminalSession,
    onCloseToolTab,
    onCloseTerminalRequest,
  } = props;
  const { t } = useLocale();

  const renderToolTab = (options: ToolTabOptions) => {
    const { tab, label, closeLabel, closeTitle, icon, onClose } = options;
    return (
      <div
        key={tab.id}
        data-project-tools-tab-id={tab.id}
        className={cn(
          TAB_BASE_CLASS,
          currentActiveTab === tab.kind && "border-border bg-muted text-foreground shadow-sm",
          draggingTabId === tab.id && "z-10 scale-[0.98] opacity-80 shadow-md ring-1 ring-ring",
        )}
        title={label}
      >
        <button
          type="button"
          aria-label={label}
          className="absolute inset-0 z-0 rounded-md bg-transparent p-0 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          onClick={() => {
            if (consumeSuppressedTabClick(tab.id)) return;
            onActivateTab(tab.id);
          }}
        />
        {renderTabDragHandle(tab.id, label)}
        <div
          aria-hidden="true"
          className="pointer-events-none relative z-10 flex h-full min-w-0 flex-1 items-center gap-1.5 text-left text-inherit"
        >
          {icon}
          <span className="min-w-0 truncate">{label}</span>
        </div>
        <button
          type="button"
          data-project-tools-tab-action="close"
          aria-label={closeLabel}
          title={closeTitle}
          className={CLOSE_BUTTON_CLASS}
          onPointerDown={(event) => {
            event.stopPropagation();
          }}
          onMouseDown={(event) => {
            event.stopPropagation();
          }}
          onClick={(event) => {
            event.stopPropagation();
            consumeSuppressedTabClick(tab.id);
            onClose();
          }}
        >
          <X className="h-3 w-3" />
        </button>
      </div>
    );
  };

  return (
    <>
      {tabs.map((tab) => {
        if (tab.kind === "backgroundTasks") {
          // Derived tab; closing only hides it (a newly started task or the
          // create menu brings it back).
          const label = t("projectTools.backgroundTasksTitle");
          const closeLabel = t("projectTools.bgTaskClosePanel");
          return (
            <div
              key={tab.id}
              data-project-tools-tab-id={tab.id}
              className={cn(
                TAB_BASE_CLASS,
                currentActiveTab === "backgroundTasks" &&
                  "border-border bg-muted text-foreground shadow-sm",
                draggingTabId === tab.id &&
                  "z-10 scale-[0.98] opacity-80 shadow-md ring-1 ring-ring",
              )}
              title={label}
            >
              <button
                type="button"
                aria-label={label}
                className="absolute inset-0 z-0 rounded-md bg-transparent p-0 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                onClick={() => {
                  if (consumeSuppressedTabClick(tab.id)) return;
                  onActivateTab(tab.id);
                }}
              />
              {renderTabDragHandle(tab.id, label)}
              <div
                aria-hidden="true"
                className="pointer-events-none relative z-10 flex h-full min-w-0 flex-1 items-center gap-1.5 text-left text-inherit"
              >
                <Cpu className="h-3.5 w-3.5 shrink-0" />
                <span className="min-w-0 truncate">{label}</span>
                {backgroundTasksRunning > 0 ? (
                  <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-500" />
                ) : (
                  <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-muted-foreground/50" />
                )}
              </div>
              <button
                type="button"
                data-project-tools-tab-action="close"
                aria-label={closeLabel}
                title={closeLabel}
                className={CLOSE_BUTTON_CLASS}
                onPointerDown={(event) => {
                  event.stopPropagation();
                }}
                onMouseDown={(event) => {
                  event.stopPropagation();
                }}
                onClick={(event) => {
                  event.stopPropagation();
                  consumeSuppressedTabClick(tab.id);
                  onCloseBackgroundTasks();
                }}
              >
                <X className="h-3 w-3" />
              </button>
            </div>
          );
        }
        if (tab.kind !== "terminal") {
          const definition = getRightDockToolDefinition(tab.kind);
          if (!definition) return null;
          const closeLabel = t(definition.closeKey);
          return renderToolTab({
            tab,
            label: t(definition.titleKey),
            closeLabel,
            closeTitle: closeLabel,
            icon: definition.icon("h-3.5 w-3.5 shrink-0"),
            onClose: () => onCloseToolTab(tab.kind),
          });
        }

        const session = tab.session;
        const isPendingClose = pendingCloseSessionId === session.id;
        const isClosing = closingSessionIds.has(session.id);
        const sessionTitle = formatTerminalSessionTitle(
          session.title,
          t("projectTools.terminalTitle"),
        );
        return (
          <div
            key={session.id}
            data-project-tools-tab-id={session.id}
            className={cn(
              TAB_BASE_CLASS,
              currentActiveTab === "terminal" &&
                activeSession?.id === session.id &&
                "border-border bg-muted text-foreground shadow-sm",
              isPendingClose && "bg-destructive/10 text-destructive hover:bg-destructive/15",
              draggingTabId === session.id &&
                "z-10 scale-[0.98] opacity-80 shadow-md ring-1 ring-ring",
            )}
            title={sessionTitle}
          >
            <button
              type="button"
              aria-label={sessionTitle}
              className="absolute inset-0 z-0 rounded-md bg-transparent p-0 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              onClick={() => {
                if (consumeSuppressedTabClick(session.id)) return;
                onActivateTerminalSession(session);
              }}
            />
            {renderTabDragHandle(session.id, sessionTitle)}
            <div
              aria-hidden="true"
              className="pointer-events-none relative z-10 flex h-full min-w-0 flex-1 items-center gap-1.5 text-left text-inherit"
            >
              <Terminal className="h-3.5 w-3.5 shrink-0" />
              <span className="min-w-0 truncate">{sessionTitle}</span>
              {!session.running ? (
                <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-muted-foreground/50" />
              ) : (
                <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-500" />
              )}
            </div>
            <button
              type="button"
              data-project-tools-tab-action="close"
              aria-label={`${isPendingClose ? t("projectTools.confirmClose") : t("projectTools.close")} ${sessionTitle}`}
              title={
                isPendingClose
                  ? t("projectTools.confirmCloseTerminal")
                  : t("projectTools.closeTerminal")
              }
              disabled={isClosing}
              className={cn(
                "relative z-10 ml-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded text-muted-foreground/70 transition-colors hover:bg-background hover:text-foreground focus-visible:bg-background focus-visible:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50",
                isPendingClose
                  ? "bg-destructive/10 text-destructive hover:bg-destructive hover:text-destructive-foreground md:opacity-100"
                  : "md:opacity-0 md:group-hover:opacity-100 md:focus-visible:opacity-100",
              )}
              onPointerDown={(event) => {
                event.stopPropagation();
              }}
              onMouseDown={(event) => {
                event.stopPropagation();
              }}
              onClick={(event) => {
                event.stopPropagation();
                consumeSuppressedTabClick(session.id);
                onCloseTerminalRequest(session);
              }}
            >
              {isPendingClose ? <Check className="h-3 w-3" /> : <X className="h-3 w-3" />}
            </button>
          </div>
        );
      })}
    </>
  );
}
