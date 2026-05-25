import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
import { listen } from "@tauri-apps/api/event";

import type { ChatHistorySummary } from "../../lib/chat/history/chatHistory";
import { listChatHistory } from "../../lib/chat/history/chatHistory";
import { sortHistoryItems } from "../../lib/chat/page/chatPageHelpers";
import {
  applyChatHistorySyncEvent,
  CHAT_HISTORY_SYNC_EVENT,
  type ChatHistorySyncEvent,
} from "../../lib/chat/history/chatHistorySync";

const HISTORY_LIST_RECONCILE_INTERVAL_MS = 60_000;
const HISTORY_LIST_PAGE_SIZE = 80;

type HistoryItemsSetter = Dispatch<SetStateAction<ChatHistorySummary[]>>;

function applyHistoryItemsUpdate(
  current: ChatHistorySummary[],
  update: SetStateAction<ChatHistorySummary[]>,
) {
  return typeof update === "function"
    ? (update as (value: ChatHistorySummary[]) => ChatHistorySummary[])(current)
    : update;
}

function persistedHistoryCount(items: ChatHistorySummary[]) {
  return items.reduce((count, item) => count + (item.isPending ? 0 : 1), 0);
}

function mergeHistoryPage(
  current: ChatHistorySummary[],
  nextPage: ChatHistorySummary[],
) {
  const byId = new Map(current.map((item) => [item.id, item]));
  for (const item of nextPage) {
    byId.set(item.id, item);
  }
  return sortHistoryItems(Array.from(byId.values()));
}

export function useChatHistoryList() {
  const [historyItems, setHistoryItemsState] = useState<ChatHistorySummary[]>([]);
  const [historyTotal, setHistoryTotal] = useState(0);
  const [historyHasMore, setHistoryHasMore] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(true);
  const [historyLoadingMore, setHistoryLoadingMore] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const historyItemsRef = useRef<ChatHistorySummary[]>([]);
  const historyTotalRef = useRef(0);
  const historyHasMoreRef = useRef(false);
  const loadedHistoryOffsetRef = useRef(0);
  const disposedRef = useRef(false);
  const requestInFlightRef = useRef(false);
  const loadMoreInFlightRef = useRef(false);
  const queuedRefreshRef = useRef<{ silent: boolean } | null>(null);

  const commitHistoryItems = useCallback(
    (items: ChatHistorySummary[], total: number, loadedOffset: number) => {
      const nextTotal = Math.max(0, total);
      const nextOffset = Math.max(0, loadedOffset);
      const nextHasMore = nextOffset < nextTotal;

      historyItemsRef.current = items;
      historyTotalRef.current = nextTotal;
      historyHasMoreRef.current = nextHasMore;
      loadedHistoryOffsetRef.current = nextOffset;
      setHistoryItemsState(items);
      setHistoryTotal(nextTotal);
      setHistoryHasMore(nextHasMore);
    },
    [],
  );

  const setHistoryItems = useCallback<HistoryItemsSetter>(
    (update) => {
      const current = historyItemsRef.current;
      const next = applyHistoryItemsUpdate(current, update);
      const persistedDelta = persistedHistoryCount(next) - persistedHistoryCount(current);
      const nextTotal = Math.max(next.length, historyTotalRef.current + persistedDelta);
      const nextOffset = Math.max(0, loadedHistoryOffsetRef.current + persistedDelta);
      commitHistoryItems(next, nextTotal, nextOffset);
    },
    [commitHistoryItems],
  );

  const refreshHistory = useCallback(
    async (options?: { silent?: boolean }) => {
      if (disposedRef.current) {
        return;
      }

      const requestedSilent = options?.silent === true;
      if (requestInFlightRef.current) {
        const queued = queuedRefreshRef.current;
        queuedRefreshRef.current = {
          silent: queued ? queued.silent && requestedSilent : requestedSilent,
        };
        return;
      }

      requestInFlightRef.current = true;
      let nextOptions: { silent: boolean } | null = { silent: requestedSilent };

      try {
        while (nextOptions && !disposedRef.current) {
          const silent = nextOptions.silent;
          queuedRefreshRef.current = null;
          if (!silent) {
            setHistoryLoading(true);
          }

          try {
            const page = await listChatHistory(1, HISTORY_LIST_PAGE_SIZE);
            if (disposedRef.current) {
              break;
            }
            const nextItems = silent
              ? mergeHistoryPage(historyItemsRef.current, page.items)
              : sortHistoryItems(page.items);
            commitHistoryItems(
              nextItems,
              page.totalCount,
              silent
                ? Math.max(loadedHistoryOffsetRef.current, page.items.length)
                : page.items.length,
            );
            setHistoryError(null);
          } catch (err) {
            if (disposedRef.current) {
              break;
            }
            const msg = err instanceof Error ? err.message : String(err);
            if (!silent) {
              commitHistoryItems([], 0, 0);
            }
            setHistoryError(msg || "读取历史列表失败");
          } finally {
            if (!silent && !disposedRef.current) {
              setHistoryLoading(false);
            }
          }

          nextOptions = queuedRefreshRef.current;
        }
      } finally {
        requestInFlightRef.current = false;
      }
    },
    [commitHistoryItems],
  );

  const loadMoreHistory = useCallback(async () => {
    if (
      disposedRef.current ||
      requestInFlightRef.current ||
      loadMoreInFlightRef.current ||
      !historyHasMoreRef.current
    ) {
      return;
    }

    loadMoreInFlightRef.current = true;
    setHistoryLoadingMore(true);
    try {
      const offset = loadedHistoryOffsetRef.current;
      const pageNumber = Math.floor(offset / HISTORY_LIST_PAGE_SIZE) + 1;
      const page = await listChatHistory(pageNumber, HISTORY_LIST_PAGE_SIZE);
      if (disposedRef.current) {
        return;
      }
      const nextItems = mergeHistoryPage(historyItemsRef.current, page.items);
      commitHistoryItems(
        nextItems,
        page.totalCount,
        page.items.length === 0 ? page.totalCount : offset + page.items.length,
      );
      setHistoryError(null);
    } catch (err) {
      if (disposedRef.current) {
        return;
      }
      const msg = err instanceof Error ? err.message : String(err);
      setHistoryError(msg || "读取更多历史列表失败");
    } finally {
      loadMoreInFlightRef.current = false;
      if (!disposedRef.current) {
        setHistoryLoadingMore(false);
      }
    }
  }, [commitHistoryItems]);

  useEffect(() => {
    disposedRef.current = false;
    let cancelled = false;
    const unlistenPromise = listen<ChatHistorySyncEvent>(
      CHAT_HISTORY_SYNC_EVENT,
      (event) => {
        if (disposedRef.current) {
          return;
        }

        setHistoryItems((current) => applyChatHistorySyncEvent(current, event.payload));
        setHistoryError(null);
      },
    );

    async function runRefresh(options?: { silent?: boolean }) {
      try {
        await refreshHistory(options);
        if (cancelled) return;
      } catch (err) {
        if (cancelled) return;
      }
    }

    void runRefresh();
    const timer = window.setInterval(() => {
      void runRefresh({ silent: true });
    }, HISTORY_LIST_RECONCILE_INTERVAL_MS);

    return () => {
      cancelled = true;
      disposedRef.current = true;
      void unlistenPromise.then((unlisten) => unlisten());
      window.clearInterval(timer);
    };
  }, [refreshHistory, setHistoryItems]);

  return {
    historyItems,
    setHistoryItems,
    historyItemsRef,
    historyTotal,
    historyHasMore,
    historyLoading,
    historyLoadingMore,
    historyError,
    setHistoryError,
    refreshHistory,
    loadMoreHistory,
  };
}
