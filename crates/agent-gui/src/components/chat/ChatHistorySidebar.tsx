import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import iconSimpleUrl from "../../../src-tauri/icons/icon-simple.png";
import { useLocale } from "../../i18n";
import {
  Edit3,
  Link2,
  MessageSquareText,
  MoreHorizontal,
  PanelLeftClose,
  Pin,
  PinOff,
  Plug,
  Share2,
  Sparkles,
  SquarePen,
  Trash2,
} from "../icons";

import type { ChatHistorySummary } from "../../lib/chat/history/chatHistory";
import { cn } from "../../lib/shared/utils";
import { Button } from "../ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import { Input } from "../ui/input";

type ChatHistorySidebarProps = {
  items: ChatHistorySummary[];
  currentConversationId: string;
  isDraftConversation: boolean;
  isBusy: boolean;
  runningConversationIds: ReadonlySet<string>;
  isLoading: boolean;
  totalItems: number;
  hasMore: boolean;
  isLoadingMore: boolean;
  errorMessage: string | null;
  renamingId: string | null;
  renameDraft: string;
  isOpen: boolean;
  activeView?: "chat" | "skills-hub" | "mcp-hub";
  onNewConversation: () => void;
  onSelectConversation: (id: string) => void;
  onStartRenaming: (item: ChatHistorySummary) => void;
  onRenameDraftChange: (value: string) => void;
  onCommitRename: () => void;
  onCancelRename: () => void;
  onSetPinned: (id: string, isPinned: boolean) => void;
  canShareConversations: boolean;
  onShareConversation: (item: ChatHistorySummary) => void;
  onOpenSharedConversations: () => void;
  onDeleteConversation: (id: string) => void;
  onLoadMore: () => void;
  onCloseSidebar: () => void;
  onOpenSkillsHub?: () => void;
  onOpenMcpHub?: () => void;
};

const HISTORY_ROW_ESTIMATED_HEIGHT = 44;
const HISTORY_ROW_GAP = 6;
const HISTORY_ROW_OVERSCAN_COUNT = 8;
const HISTORY_LOAD_MORE_THRESHOLD = 12;

function useStableEvent<Args extends unknown[], Return>(
  handler: (...args: Args) => Return,
): (...args: Args) => Return {
  const handlerRef = useRef(handler);
  handlerRef.current = handler;

  return useCallback((...args: Args) => handlerRef.current(...args), []);
}

const HistoryRow = memo(function HistoryRow(props: {
  item: ChatHistorySummary;
  isActive: boolean;
  isBusy: boolean;
  isRunning: boolean;
  isDeleteDisabled: boolean;
  canShareConversation: boolean;
  isRenaming: boolean;
  isPendingDelete: boolean;
  renameDraft: string;
  onSelectConversation: (id: string) => void;
  onStartRenaming: (item: ChatHistorySummary) => void;
  onRenameDraftChange: (value: string) => void;
  onCommitRename: () => void;
  onCancelRename: () => void;
  onSetPinned: (id: string, isPinned: boolean) => void;
  onShareConversation: (item: ChatHistorySummary) => void;
  onDeleteConversation: (id: string) => void;
  onSetPendingDelete: (id: string | null) => void;
}) {
  const {
    item,
    isActive,
    isBusy,
    isRunning,
    isDeleteDisabled,
    canShareConversation,
    isRenaming,
    isPendingDelete,
    renameDraft,
    onSelectConversation,
    onStartRenaming,
    onRenameDraftChange,
    onCommitRename,
    onCancelRename,
    onSetPinned,
    onShareConversation,
    onDeleteConversation,
    onSetPendingDelete,
  } = props;

  const inputRef = useRef<HTMLInputElement | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);

  const handleSelect = useCallback(() => {
    onSelectConversation(item.id);
  }, [item.id, onSelectConversation]);

  const handleStartRenaming = useCallback(() => {
    onStartRenaming(item);
  }, [item, onStartRenaming]);

  const handleRequestDelete = useCallback(() => {
    onSetPendingDelete(item.id);
  }, [item.id, onSetPendingDelete]);

  const handleTogglePinned = useCallback(() => {
    onSetPinned(item.id, item.isPinned !== true);
  }, [item.id, item.isPinned, onSetPinned]);

  const handleShare = useCallback(() => {
    onShareConversation(item);
  }, [item, onShareConversation]);

  const handleConfirmDelete = useCallback(() => {
    onSetPendingDelete(null);
    onDeleteConversation(item.id);
  }, [item.id, onDeleteConversation, onSetPendingDelete]);

  const handleCancelDelete = useCallback(() => {
    onSetPendingDelete(null);
  }, [onSetPendingDelete]);

  useEffect(() => {
    if (!isRenaming) return;
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [isRenaming]);

  if (isPendingDelete) {
    return (
      <div className="chat-history-row rounded-2xl border border-border/70 bg-background px-3 py-2.5 shadow-xs shadow-black/5">
        <p className="truncate text-sm leading-5 text-foreground/80">
          删除「<span className="font-medium text-foreground">{item.title}</span>」？
        </p>
        <p className="mt-0.5 text-[11px] leading-4 text-muted-foreground">
          此操作无法撤销
        </p>
        <div className="mt-2 grid grid-cols-2 gap-1.5">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={handleCancelDelete}
            className="h-7 rounded-xl border-border/60 text-xs font-normal text-muted-foreground hover:text-foreground"
          >
            取消
          </Button>
          <Button
            type="button"
            size="sm"
            onClick={handleConfirmDelete}
            disabled={isBusy || isDeleteDisabled}
            className="h-7 rounded-xl bg-destructive text-xs font-medium text-destructive-foreground hover:bg-destructive/90"
          >
            删除
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div
      className={cn(
        "chat-history-row group/item rounded-2xl border px-1 py-0.5 transition-all",
        isActive
          ? "border-border/70 bg-background shadow-xs shadow-black/5"
          : item.isPinned
            ? "border-primary/20 bg-primary/[0.06] hover:border-primary/30 hover:bg-primary/[0.09]"
            : "border-transparent bg-transparent hover:border-border/50 hover:bg-background/70",
      )}
    >
      {isRenaming ? (
        <div className="px-1 py-0.5">
          <Input
            ref={inputRef}
            value={renameDraft}
            onChange={(e) => onRenameDraftChange(e.currentTarget.value)}
            onBlur={onCommitRename}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                onCommitRename();
              }
              if (e.key === "Escape") {
                e.preventDefault();
                onCancelRename();
              }
            }}
            onClick={(e) => e.stopPropagation()}
            className="h-9 rounded-xl border-border/70 bg-background text-sm shadow-none"
            disabled={isBusy}
          />
        </div>
      ) : (
        <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-1">
          <button
            type="button"
            onClick={handleSelect}
            className={cn(
              "min-w-0 rounded-[1rem] px-1 py-1 text-left outline-hidden transition-colors",
              "focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
              isActive ? "text-foreground" : "text-foreground/90 hover:text-foreground",
            )}
            title={item.title}
          >
            <span className="block truncate text-sm font-medium leading-5">
              {item.title}
            </span>
          </button>

          <div className="flex items-center gap-1.5">
            {item.isPinned ? (
              <span
                className="flex h-8 w-3.5 shrink-0 items-center justify-center text-primary/75"
                aria-label="已置顶"
                title="已置顶"
              >
                <Pin className="h-3.5 w-3.5" />
              </span>
            ) : null}

            {item.isShared ? (
              <span
                className="flex h-8 w-3.5 shrink-0 items-center justify-center text-sky-500/80"
                aria-label="已分享"
                title="已分享"
              >
                <Link2 className="h-3.5 w-3.5" />
              </span>
            ) : null}

            {isRunning ? (
              <span
                className="relative flex h-8 w-3.5 shrink-0 items-center justify-center"
                aria-label="正在回复"
                title="正在回复"
              >
                <span className="absolute h-2 w-2 rounded-full bg-emerald-400/45 animate-ping" />
                <span className="relative h-2 w-2 rounded-full bg-emerald-500 shadow-[0_0_0_2px_rgba(16,185,129,0.14)]" />
              </span>
            ) : null}

            <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
              <DropdownMenuTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  title="更多操作"
                  aria-label="更多操作"
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={(e) => e.stopPropagation()}
                  className={cn(
                    "h-8 w-8 shrink-0 rounded-xl text-muted-foreground opacity-0 pointer-events-none transition-[opacity,colors]",
                    "hover:bg-muted/70 hover:text-foreground",
                    "group-hover/item:opacity-100 group-hover/item:pointer-events-auto",
                    "group-focus-within/item:opacity-100 group-focus-within/item:pointer-events-auto",
                    menuOpen && "bg-muted/70 text-foreground",
                    menuOpen && "opacity-100 pointer-events-auto",
                  )}
                >
                  <MoreHorizontal className="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent
                side="right"
                align="start"
                sideOffset={8}
                className="min-w-[10rem] rounded-xl border-border/60 bg-background/95 backdrop-blur-xl"
              >
                {!item.isPending ? (
                  <DropdownMenuItem onSelect={handleTogglePinned} className="gap-2">
                    {item.isPinned ? (
                      <PinOff className="h-3.5 w-3.5" />
                    ) : (
                      <Pin className="h-3.5 w-3.5" />
                    )}
                    {item.isPinned ? "取消置顶" : "置顶对话"}
                  </DropdownMenuItem>
                ) : null}
                {canShareConversation && !item.isPending ? (
                  <DropdownMenuItem onSelect={handleShare} className="gap-2">
                    <Share2 className="h-3.5 w-3.5" />
                    分享
                  </DropdownMenuItem>
                ) : null}
                <DropdownMenuItem onSelect={handleStartRenaming} className="gap-2">
                  <Edit3 className="h-3.5 w-3.5" />
                  修改标题
                </DropdownMenuItem>
                <DropdownMenuItem
                  disabled={isDeleteDisabled}
                  onSelect={handleRequestDelete}
                  className="gap-2 text-destructive focus:bg-destructive/10 focus:text-destructive"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                  删除对话
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
      )}
    </div>
  );
});

function SidebarStateCard(props: {
  title: string;
  description?: string;
  tone?: "default" | "error";
}) {
  const { title, description, tone = "default" } = props;

  return (
    <div
      className={cn(
        "rounded-2xl border px-3 py-3 text-sm",
        tone === "error"
          ? "border-destructive/20 bg-destructive/5 text-destructive"
          : "border-border/60 bg-background/70 text-muted-foreground",
      )}
    >
      <div className={cn("font-medium", tone === "error" ? "text-destructive" : "text-foreground/85")}>
        {title}
      </div>
      {description ? <div className="mt-1 text-xs leading-5">{description}</div> : null}
    </div>
  );
}

export const ChatHistorySidebar = memo(function ChatHistorySidebar(props: ChatHistorySidebarProps) {
  const {
    items,
    currentConversationId,
    isBusy,
    runningConversationIds,
    isLoading,
    totalItems,
    hasMore,
    isLoadingMore,
    errorMessage,
    renamingId,
    renameDraft,
    isOpen,
    activeView = "chat",
    onNewConversation,
    onSelectConversation,
    onStartRenaming,
    onRenameDraftChange,
    onCommitRename,
    onCancelRename,
    onSetPinned,
    canShareConversations,
    onShareConversation,
    onOpenSharedConversations,
    onDeleteConversation,
    onLoadMore,
    onCloseSidebar,
    onOpenSkillsHub,
    onOpenMcpHub,
  } = props;
  const { t } = useLocale();

  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
  const handleSelectConversation = useStableEvent(onSelectConversation);
  const handleStartRenaming = useStableEvent(onStartRenaming);
  const handleRenameDraftChange = useStableEvent(onRenameDraftChange);
  const handleCommitRename = useStableEvent(onCommitRename);
  const handleCancelRename = useStableEvent(onCancelRename);
  const handleSetPinned = useStableEvent(onSetPinned);
  const handleShareConversation = useStableEvent(onShareConversation);
  const handleOpenSharedConversations = useStableEvent(onOpenSharedConversations);
  const handleDeleteConversation = useStableEvent(onDeleteConversation);
  const sharedConversationCount = useMemo(
    () => items.filter((item) => item.isShared === true).length,
    [items],
  );
  const historyScrollRef = useRef<HTMLDivElement | null>(null);
  const getHistoryItemKey = useCallback(
    (index: number) => items[index]?.id ?? index,
    [items],
  );
  const historyVirtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => historyScrollRef.current,
    estimateSize: () => HISTORY_ROW_ESTIMATED_HEIGHT + HISTORY_ROW_GAP,
    getItemKey: getHistoryItemKey,
    overscan: HISTORY_ROW_OVERSCAN_COUNT,
  });
  const virtualHistoryRows = historyVirtualizer.getVirtualItems();
  const lastVirtualHistoryIndex =
    virtualHistoryRows.length > 0
      ? virtualHistoryRows[virtualHistoryRows.length - 1].index
      : -1;

  useEffect(() => {
    if (
      !hasMore ||
      isLoading ||
      isLoadingMore ||
      items.length === 0 ||
      lastVirtualHistoryIndex < items.length - HISTORY_LOAD_MORE_THRESHOLD
    ) {
      return;
    }
    onLoadMore();
  }, [hasMore, isLoading, isLoadingMore, items.length, lastVirtualHistoryIndex, onLoadMore]);

  const renderHistoryRow = useCallback(
    (item: ChatHistorySummary) => (
      <HistoryRow
        key={item.id}
        item={item}
        isActive={currentConversationId === item.id}
        isBusy={isBusy}
        isRunning={runningConversationIds.has(item.id)}
        isDeleteDisabled={runningConversationIds.has(item.id)}
        canShareConversation={canShareConversations}
        isRenaming={renamingId === item.id}
        isPendingDelete={pendingDeleteId === item.id}
        renameDraft={renamingId === item.id ? renameDraft : ""}
        onSelectConversation={handleSelectConversation}
        onStartRenaming={handleStartRenaming}
        onRenameDraftChange={handleRenameDraftChange}
        onCommitRename={handleCommitRename}
        onCancelRename={handleCancelRename}
        onSetPinned={handleSetPinned}
        onShareConversation={handleShareConversation}
        onDeleteConversation={handleDeleteConversation}
        onSetPendingDelete={setPendingDeleteId}
      />
    ),
    [
      currentConversationId,
      handleCancelRename,
      handleCommitRename,
      handleDeleteConversation,
      handleRenameDraftChange,
      handleSelectConversation,
      handleSetPinned,
      handleShareConversation,
      handleStartRenaming,
      isBusy,
      canShareConversations,
      pendingDeleteId,
      renameDraft,
      renamingId,
      runningConversationIds,
    ],
  );

  return (
    <aside
      className={cn(
        "chat-history-sidebar flex h-full shrink-0 flex-col overflow-hidden border-r border-border/50 bg-[hsl(var(--sidebar-bg))] transition-[width,opacity] duration-200 ease-out",
        isOpen ? "w-[272px] opacity-100" : "w-0 opacity-0",
      )}
    >
      <div className="chat-history-sidebar-inner flex w-[272px] min-w-[272px] min-h-0 flex-1 flex-col">
        <div className="border-b border-border/50 px-3 pb-3 pt-3">
          <div className="flex items-center justify-between gap-2">
            <div className="flex min-w-0 items-center gap-2.5">
              <img
                src={iconSimpleUrl}
                alt=""
                aria-hidden="true"
                draggable={false}
                className="h-9 w-9 shrink-0 select-none rounded-2xl object-contain"
              />
              <div className="min-w-0">
                <div className="truncate text-sm font-semibold tracking-tight">LiveAgent</div>
              </div>
            </div>

            <Button
              type="button"
              variant="ghost"
              size="icon"
              onClick={onCloseSidebar}
              title={t("sidebar.closeSidebar")}
              className="h-9 w-9 shrink-0 rounded-2xl text-muted-foreground hover:text-foreground"
            >
              <PanelLeftClose className="h-4 w-4" />
            </Button>
          </div>

          <div className="mt-3 flex flex-col gap-1">
            <Button
              type="button"
              variant="ghost"
              onClick={() => onOpenSkillsHub?.()}
              className={cn(
                "sidebar-hub-menu-item h-9 w-full justify-start gap-3 rounded-lg px-3 text-[14px] font-normal leading-5 shadow-none transition-colors",
                activeView === "skills-hub"
                  ? "bg-foreground/[0.06] text-foreground hover:bg-foreground/[0.08] hover:text-foreground focus-visible:bg-foreground/[0.08]"
                  : "text-foreground/80 hover:bg-foreground/[0.08] hover:text-foreground focus-visible:bg-foreground/[0.08]",
              )}
              title="Skills Hub"
            >
              <Sparkles
                className={cn(
                  "h-4 w-4 shrink-0",
                  activeView === "skills-hub" ? "text-amber-500" : "text-foreground/85",
                )}
              />
              <span className="truncate">Skills</span>
            </Button>
            <Button
              type="button"
              variant="ghost"
              onClick={() => onOpenMcpHub?.()}
              className={cn(
                "sidebar-hub-menu-item h-9 w-full justify-start gap-3 rounded-lg px-3 text-[14px] font-normal leading-5 shadow-none transition-colors",
                activeView === "mcp-hub"
                  ? "bg-foreground/[0.06] text-foreground hover:bg-foreground/[0.08] hover:text-foreground focus-visible:bg-foreground/[0.08]"
                  : "text-foreground/80 hover:bg-foreground/[0.08] hover:text-foreground focus-visible:bg-foreground/[0.08]",
              )}
              title="MCP Hub"
            >
              <Plug
                className={cn(
                  "h-4 w-4 shrink-0",
                  activeView === "mcp-hub" ? "text-violet-500" : "text-foreground/85",
                )}
              />
              <span className="truncate">MCP</span>
            </Button>
            <Button
              type="button"
              variant="ghost"
              onClick={onNewConversation}
              className={cn(
                "chat-history-new-conversation-button h-9 w-full justify-start gap-3 rounded-lg px-3 text-[14px] font-normal leading-5 shadow-none transition-colors",
                activeView === "chat"
                  ? "text-foreground/90 hover:bg-foreground/[0.08] hover:text-foreground focus-visible:bg-foreground/[0.08]"
                  : "text-foreground/80 hover:bg-foreground/[0.08] hover:text-foreground focus-visible:bg-foreground/[0.08]",
              )}
            >
              <SquarePen className="h-4 w-4 shrink-0 text-foreground/85" />
              <span className="chat-history-new-conversation-label">
                {t("chat.newConversation")}
              </span>
            </Button>
          </div>
        </div>

        <div className="flex items-center justify-between px-3 pb-2 pt-3">
          <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
            <MessageSquareText className="h-3.5 w-3.5" />
            {t("chat.recentConversation")}
          </div>
          <div className="flex items-center gap-1.5">
            <div className="rounded-full border border-border/60 bg-background/80 px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
              {Math.max(totalItems, items.length)}
            </div>
            {canShareConversations ? (
              <Button
                type="button"
                variant="ghost"
                size="icon"
                onClick={handleOpenSharedConversations}
                className="h-7 w-7 rounded-full border border-border/50 bg-background/70 text-muted-foreground shadow-xs shadow-black/5 transition-colors hover:border-sky-500/25 hover:bg-sky-500/10 hover:text-sky-600 dark:hover:text-sky-400"
                title={`管理已分享会话（${sharedConversationCount}）`}
                aria-label={`管理已分享会话（${sharedConversationCount}）`}
              >
                <Share2 className="h-3.5 w-3.5" />
              </Button>
            ) : null}
          </div>
        </div>

        {errorMessage ? (
          <div className="px-3 pb-2">
            <SidebarStateCard title="历史记录读取失败" description={errorMessage} tone="error" />
          </div>
        ) : null}

        <div
          ref={historyScrollRef}
          className="chat-history-list min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-2 pb-3"
        >
          {isLoading ? (
            <SidebarStateCard
              title="正在读取历史记录..."
              description="稍后会自动显示最近保存的对话。"
            />
          ) : items.length === 0 ? (
            <div className="flex flex-col items-center px-4 pt-8 pb-6 text-center">
              <MessageSquareText
                className="h-[22px] w-[22px] text-foreground/35"
                strokeWidth={1.5}
              />
              <p className="mt-3 text-[12.5px] font-medium tracking-tight text-foreground/70">
                {t("chat.emptyChatHistory")}
              </p>
              <p className="mt-1 text-[11.5px] leading-[1.55] text-muted-foreground/70">
                {t("chat.clickNewConversation")}
              </p>
            </div>
          ) : (
            <div
              className="relative"
              style={{ height: historyVirtualizer.getTotalSize() }}
            >
              {virtualHistoryRows.map((virtualRow) => {
                const item = items[virtualRow.index];
                if (!item) return null;

                return (
                  <div
                    key={virtualRow.key}
                    data-index={virtualRow.index}
                    ref={historyVirtualizer.measureElement}
                    className="absolute left-0 right-1 top-0 pb-1.5"
                    style={{ transform: `translateY(${virtualRow.start}px)` }}
                  >
                    {renderHistoryRow(item)}
                  </div>
                );
              })}
            </div>
          )}
          {!isLoading && items.length > 0 && (hasMore || isLoadingMore) ? (
            <div className="px-2 pb-2 pt-1 text-center text-[11px] leading-5 text-muted-foreground/70">
              {isLoadingMore ? "正在加载更多历史记录..." : "继续滚动加载更多"}
            </div>
          ) : null}
        </div>
      </div>
    </aside>
  );
});
