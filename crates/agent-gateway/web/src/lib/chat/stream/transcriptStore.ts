import type { ChatEntry, PushChatEventOptions } from "@/lib/chatUi";
import { chatEntryDedupKey, pushChatEvent } from "@/lib/chatUi";
import type { ChatEvent } from "@/lib/gatewayTypes";
import type {
  ConversationStreamEvent,
  ConversationSubscribeResult,
  StreamRunActivity,
} from "./streamTypes";
import { readEventRunId, readEventSeq } from "./streamTypes";

// One transcript store per conversation, modeled after the GUI's proven
// split between committed history and an append-only live tail:
//
//   committed  — history-backed entries (stable ids, virtualized region)
//   settled    — entries of finished runs, not yet folded into committed;
//                they stay in the (non-virtualized) tail region so the end
//                of a reply moves zero DOM nodes
//   live       — entries of the current in-flight segment
//
// Entry ids never change. Completion is supersession, not refetch: at the
// next run_started the settled tail folds into committed in one commit,
// together with the incoming user bubble.

export type TranscriptSnapshot = {
  committed: ChatEntry[];
  // settled + live — everything rendered in the tail region.
  tail: ChatEntry[];
  activeRun: StreamRunActivity | null;
  toolStatus: string | null;
  toolStatusIsCompaction: boolean;
  // Bumped whenever the settled tail folds into committed (the one moment a
  // scroll-preserving flushSync commit is warranted).
  foldRevision: number;
  revision: number;
};

export type TranscriptStore = {
  getSnapshot(): TranscriptSnapshot;
  subscribe(listener: () => void): () => void;
  // Stream plumbing.
  applySync(result: ConversationSubscribeResult): void;
  applyEvent(event: ConversationStreamEvent): void;
  // Optimistic local echo for a command this client is submitting. The
  // matching seeded user_message adopts the entry by client_request_id,
  // keeping this id — the user bubble never remounts.
  addOptimisticUserEntry(params: {
    clientRequestId: string;
    text: string;
    attachments?: UserAttachments;
  }): void;
  removeOptimisticUserEntry(clientRequestId: string): void;
  // Failure surfaced outside the stream (command never bound).
  appendLocalError(message: string): void;
  // History snapshot (initial load / quiet upsert merge). Preserves existing
  // ids by dedup key and leaves tail entries in place — committed only takes
  // history entries the tail is not already showing.
  applyHistorySnapshot(entries: ChatEntry[]): void;
  // Fold the settled tail into committed outside of run_started (used when
  // the conversation is switched away; keeps the next mount clean).
  foldSettledTail(): void;
  reset(): void;
  flush(): void;
};

type UserAttachments = Extract<ChatEntry, { kind: "user" }>["attachments"];

const EMPTY_SNAPSHOT: TranscriptSnapshot = {
  committed: [],
  tail: [],
  activeRun: null,
  toolStatus: null,
  toolStatusIsCompaction: false,
  foldRevision: 0,
  revision: 0,
};

function runIdPrefix(runId: string): string {
  return runId ? `${runId}/` : "";
}

function optimisticEntryId(clientRequestId: string): string {
  return `optimistic-user-${clientRequestId}`;
}

export function createTranscriptStore(): TranscriptStore {
  let committed: ChatEntry[] = [];
  let settled: ChatEntry[] = [];
  let live: ChatEntry[] = [];
  let activeRun: StreamRunActivity | null = null;
  let toolStatus: string | null = null;
  let toolStatusIsCompaction = false;
  let foldRevision = 0;
  // Idempotency cursor: the highest log seq already applied. Re-subscribes
  // replay the buffered log into a store that persists across conversation
  // switches; without the cursor every replayed event would duplicate its
  // entry (or double-append token text).
  let lastSeq = 0;

  let snapshot = EMPTY_SNAPSHOT;
  let dirty = false;
  let rafId: number | null = null;
  const listeners = new Set<() => void>();
  // clientRequestId → optimistic entry id, until adopted or removed.
  const pendingOptimistic = new Map<string, string>();
  // runId → ids of entries that belong to it but carry foreign ids (adopted
  // optimistic entries), so run_queued compensation can remove them too.
  const adoptedEntryIds = new Map<string, string[]>();

  const buildSnapshot = (): TranscriptSnapshot => ({
    committed,
    tail: settled.length === 0 ? live : live.length === 0 ? settled : [...settled, ...live],
    activeRun,
    toolStatus,
    toolStatusIsCompaction,
    foldRevision,
    revision: snapshot.revision + 1,
  });

  const emit = () => {
    for (const listener of listeners) {
      listener();
    }
  };
  const commit = () => {
    rafId = null;
    if (!dirty) {
      return;
    }
    dirty = false;
    snapshot = buildSnapshot();
    emit();
  };
  const schedule = (flush?: boolean) => {
    dirty = true;
    if (flush) {
      if (rafId !== null) {
        cancelAnimationFrame(rafId);
        rafId = null;
      }
      commit();
      return;
    }
    if (rafId === null && typeof requestAnimationFrame === "function") {
      rafId = requestAnimationFrame(commit);
    } else if (typeof requestAnimationFrame !== "function") {
      commit();
    }
  };

  const foldSettled = (flush: boolean) => {
    if (settled.length === 0) {
      return;
    }
    committed = [...committed, ...settled];
    settled = [];
    foldRevision += 1;
    schedule(flush);
  };

  const setToolStatus = (status: string | null, isCompaction: boolean, flush?: boolean) => {
    const next = status && status.trim() ? status.trim() : null;
    const nextCompaction = Boolean(next) && isCompaction;
    if (toolStatus === next && toolStatusIsCompaction === nextCompaction) {
      return;
    }
    toolStatus = next;
    toolStatusIsCompaction = nextCompaction;
    schedule(flush);
  };

  const adoptOptimisticEntry = (event: ConversationStreamEvent, runId: string): boolean => {
    const clientRequestId =
      typeof (event as { client_request_id?: unknown }).client_request_id === "string"
        ? ((event as { client_request_id: string }).client_request_id ?? "").trim()
        : "";
    if (!clientRequestId) {
      return false;
    }
    const entryId = pendingOptimistic.get(clientRequestId);
    if (!entryId) {
      return false;
    }
    pendingOptimistic.delete(clientRequestId);
    // The optimistic entry already shows this exact message; keep it (and its
    // id) and record the ownership for run_queued compensation.
    if (runId) {
      const owned = adoptedEntryIds.get(runId) ?? [];
      owned.push(entryId);
      adoptedEntryIds.set(runId, owned);
    }
    return live.some((entry) => entry.id === entryId);
  };

  const removeRunEntries = (runId: string) => {
    const prefix = runIdPrefix(runId);
    const adopted = new Set(adoptedEntryIds.get(runId) ?? []);
    adoptedEntryIds.delete(runId);
    const matches = (entry: ChatEntry) =>
      (prefix !== "" && entry.id.startsWith(prefix)) || adopted.has(entry.id);
    const nextLive = live.filter((entry) => !matches(entry));
    const nextSettled = settled.filter((entry) => !matches(entry));
    if (nextLive.length !== live.length || nextSettled.length !== settled.length) {
      live = nextLive;
      settled = nextSettled;
      schedule(true);
    }
  };

  // True when the entry belongs to another run than `runId`: prefixed with a
  // foreign run id, adopted by a foreign run, or a not-yet-adopted optimistic
  // echo. Such entries must survive the finishing run's settle sweep.
  const isForeignOwnedEntry = (entry: ChatEntry, runId: string): boolean => {
    const prefix = runIdPrefix(runId);
    if (prefix !== "" && entry.id.startsWith(prefix)) {
      return false;
    }
    if (adoptedEntryIds.get(runId)?.includes(entry.id)) {
      return false;
    }
    if (pendingOptimistic.size > 0) {
      for (const optimisticId of pendingOptimistic.values()) {
        if (optimisticId === entry.id) {
          return true;
        }
      }
    }
    for (const [otherRunId, ownedIds] of adoptedEntryIds) {
      if (otherRunId !== runId && ownedIds.includes(entry.id)) {
        return true;
      }
    }
    const slashIndex = entry.id.indexOf("/");
    return slashIndex > 0 && !entry.id.startsWith("local/");
  };

  const applyRunFinished = (event: ConversationStreamEvent) => {
    const runId = readEventRunId(event);
    if (activeRun && runId !== "" && runId !== activeRun.runId) {
      // Stray terminal for a non-active run (the gateway appends these
      // deliberately, e.g. failing a superseded queued run). Never settle the
      // active segment; just drop the stray run's provisional entries.
      removeRunEntries(runId);
      return;
    }
    const payload = event as {
      status?: string;
      message?: string;
      reason?: string;
    };
    if (payload.status === "failed" && payload.message && payload.reason !== "superseded") {
      live = pushChatEvent(
        live,
        { type: "error", message: payload.message } as ChatEvent,
        { entryIdPrefix: runIdPrefix(runId) },
      );
    }
    // Settle only entries owned by the finished run (or unowned, e.g. local/
    // errors); foreign-owned entries — seeded user_messages and optimistic
    // echoes of not-yet-started runs — stay live for their own run.
    const settling = live.filter((entry) => !isForeignOwnedEntry(entry, runId));
    const remaining = live.filter((entry) => isForeignOwnedEntry(entry, runId));
    adoptedEntryIds.delete(runId);
    settled = settling.length === 0 ? settled : [...settled, ...settling];
    live = remaining;
    activeRun = null;
    setToolStatus(null, false);
    schedule(true);
  };

  const applyDelta = (event: ConversationStreamEvent, runId: string) => {
    if (event.type === "user_message" && adoptOptimisticEntry(event, runId)) {
      schedule(true);
      return;
    }
    const options: PushChatEventOptions = { entryIdPrefix: runIdPrefix(runId) };
    const next = pushChatEvent(live, event as ChatEvent, options);
    if (next !== live) {
      live = next;
      schedule(event.type === "user_message");
    }
  };

  const rebuildLiveFromSnapshot = (entriesJson: string, runId: string) => {
    const entries = parseSnapshotEntries(entriesJson);
    if (entries.length === 0 && live.length === 0) {
      return;
    }
    // Snapshot entries carry their own (runtime-assigned) ids; prefix them so
    // they cannot collide with entries of other runs.
    const prefix = runIdPrefix(runId);
    live = entries.map((entry) =>
      prefix && !entry.id.startsWith(prefix) ? { ...entry, id: `${prefix}${entry.id}` } : entry,
    );
    schedule(true);
  };

  return {
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    applySync: (result) => {
      if (result.reset) {
        // Seq continuity broke (gateway restart / buffer gap). Committed
        // history stays valid; the settled tail is finished-run content with
        // stable ids, so fold it into committed instead of dropping the last
        // reply, then rebuild the live segment from scratch. The replay after
        // a reset only carries events the tail was not built from (gap
        // resets replay past the evicted prefix; epoch resets replay
        // new-epoch runs with disjoint id prefixes), so zero the cursor.
        lastSeq = 0;
        foldSettled(false);
        live = [];
        activeRun = null;
        toolStatus = null;
        toolStatusIsCompaction = false;
        if (result.snapshot) {
          rebuildLiveFromSnapshot(result.snapshot.entriesJson, result.snapshot.runId);
          lastSeq = Math.max(lastSeq, result.snapshot.asOfSeq);
        }
      } else if (result.snapshot && live.length === 0) {
        // Late join mid-run where the buffer cannot cover the run start. The
        // snapshot folds every event through asOfSeq into its entries;
        // advancing the cursor drops the overlapping replay below.
        rebuildLiveFromSnapshot(result.snapshot.entriesJson, result.snapshot.runId);
        lastSeq = Math.max(lastSeq, result.snapshot.asOfSeq);
      }
      activeRun = result.activity;
      if (result.activity) {
        setToolStatus(result.activity.toolStatus, result.activity.toolStatusIsCompaction);
      } else if (result.reset) {
        setToolStatus(null, false);
      }
      for (const event of result.events) {
        applyOne(event);
      }
      lastSeq = Math.max(lastSeq, result.latestSeq);
      schedule(true);
    },

    applyEvent: (event) => {
      applyOne(event);
    },

    addOptimisticUserEntry: ({ clientRequestId, text, attachments }) => {
      const id = optimisticEntryId(clientRequestId);
      if (live.some((entry) => entry.id === id)) {
        return;
      }
      pendingOptimistic.set(clientRequestId, id);
      live = [
        ...live,
        {
          id,
          kind: "user",
          text,
          attachments: (attachments ?? []) as UserAttachments,
        },
      ];
      schedule(true);
    },

    removeOptimisticUserEntry: (clientRequestId) => {
      const id = pendingOptimistic.get(clientRequestId) ?? optimisticEntryId(clientRequestId);
      pendingOptimistic.delete(clientRequestId);
      const next = live.filter((entry) => entry.id !== id);
      if (next.length !== live.length) {
        live = next;
        schedule(true);
      }
    },

    appendLocalError: (message) => {
      live = pushChatEvent(live, { type: "error", message } as ChatEvent, {
        entryIdPrefix: "local/",
      });
      schedule(true);
    },

    applyHistorySnapshot: (entries) => {
      // Preserve ids of entries we already render (matched by dedup key —
      // tool entries match by tool-call identity, immune to live-path
      // trimming) and keep tail entries where they are: committed only takes
      // what the tail is not showing.
      //
      // Dedup keys are NOT unique across the transcript (a repeated user
      // prompt, id-less tool calls sharing name + round across runs), so
      // matching is occurrence-aware: each rendered occurrence can be
      // adopted at most once, consumed in transcript order — committed
      // copies (older) before tail copies (newest). Two history entries can
      // therefore never adopt the same id; duplicate ids corrupt both React
      // keying and the virtualizer's measurement cache.
      const committedQueueByKey = new Map<string, ChatEntry[]>();
      for (const entry of committed) {
        const key = chatEntryDedupKey(entry);
        const queue = committedQueueByKey.get(key);
        if (queue) {
          queue.push(entry);
        } else {
          committedQueueByKey.set(key, [entry]);
        }
      }
      const settledIndexQueueByKey = new Map<string, number[]>();
      settled.forEach((entry, index) => {
        const key = chatEntryDedupKey(entry);
        const queue = settledIndexQueueByKey.get(key);
        if (queue) {
          queue.push(index);
        } else {
          settledIndexQueueByKey.set(key, [index]);
        }
      });
      const liveIndexQueueByKey = new Map<string, number[]>();
      live.forEach((entry, index) => {
        const key = chatEntryDedupKey(entry);
        const queue = liveIndexQueueByKey.get(key);
        if (queue) {
          queue.push(index);
        } else {
          liveIndexQueueByKey.set(key, [index]);
        }
      });

      // Tail ids stay as-is and must never be re-issued to a committed entry.
      const usedIds = new Set<string>();
      for (const entry of settled) {
        usedIds.add(entry.id);
      }
      for (const entry of live) {
        usedIds.add(entry.id);
      }
      const uniqueId = (candidate: string) => {
        if (!usedIds.has(candidate)) {
          return candidate;
        }
        let suffix = 2;
        while (usedIds.has(`${candidate}#${suffix}`)) {
          suffix += 1;
        }
        return `${candidate}#${suffix}`;
      };

      const nextCommitted: ChatEntry[] = [];
      let nextSettled = settled;
      let nextLive = live;
      let tailChanged = false;
      for (const entry of entries) {
        const key = chatEntryDedupKey(entry);
        const committedMatch = committedQueueByKey.get(key)?.shift();
        if (committedMatch) {
          // Same logical entry: keep the rendered id, upgrade the payload
          // (history carries full, untrimmed tool content).
          const id = uniqueId(committedMatch.id);
          nextCommitted.push(entry.id === id ? entry : { ...entry, id });
          usedIds.add(id);
          continue;
        }
        const settledIndex = settledIndexQueueByKey.get(key)?.shift();
        if (settledIndex !== undefined) {
          // Already rendered in the tail region (folds in at run_started).
          // Upgrade the tail entry in place — same id, same position — with
          // the history payload: this is what gives the just-settled user
          // bubble its messageRef (edit-resend affordance) and tool cards
          // their full, untrimmed content.
          const existing = nextSettled[settledIndex];
          if (existing) {
            if (nextSettled === settled) {
              nextSettled = settled.slice();
            }
            nextSettled[settledIndex] = { ...entry, id: existing.id };
            tailChanged = true;
          }
          continue;
        }
        const liveIndex = liveIndexQueueByKey.get(key)?.shift();
        if (liveIndex !== undefined) {
          const existing = nextLive[liveIndex];
          if (existing) {
            if (nextLive === live) {
              nextLive = live.slice();
            }
            nextLive[liveIndex] = { ...entry, id: existing.id };
            tailChanged = true;
          }
          continue;
        }
        const id = uniqueId(entry.id);
        nextCommitted.push(entry.id === id ? entry : { ...entry, id });
        usedIds.add(id);
      }
      if (tailChanged) {
        settled = nextSettled;
        live = nextLive;
      }
      const committedUnchanged =
        nextCommitted.length === committed.length &&
        nextCommitted.every((entry, index) => entry === committed[index]);
      if (!tailChanged && committedUnchanged) {
        return;
      }
      committed = nextCommitted;
      schedule(true);
    },

    foldSettledTail: () => {
      foldSettled(true);
    },

    reset: () => {
      committed = [];
      settled = [];
      live = [];
      activeRun = null;
      toolStatus = null;
      toolStatusIsCompaction = false;
      lastSeq = 0;
      pendingOptimistic.clear();
      adoptedEntryIds.clear();
      schedule(true);
    },

    flush: () => {
      if (rafId !== null) {
        cancelAnimationFrame(rafId);
        rafId = null;
      }
      commit();
    },
  };

  // edit_resend: truncate the transcript at the edited user message. The new
  // user_message (adopting the optimistic entry) follows in the stream.
  function applyRebased(event: ConversationStreamEvent) {
    const ref = (event as { base_message_ref?: unknown }).base_message_ref;
    if (!ref || typeof ref !== "object") {
      return;
    }
    const refValue = ref as Record<string, unknown>;
    const messageId =
      typeof refValue.message_id === "string" ? refValue.message_id.trim() : "";
    const contentHash =
      typeof refValue.content_hash === "string" ? refValue.content_hash.trim() : "";
    if (!messageId && !contentHash) {
      return;
    }
    foldSettled(true);
    const index = committed.findIndex(
      (entry) =>
        entry.kind === "user" &&
        entry.messageRef != null &&
        ((messageId !== "" && entry.messageRef.messageId === messageId) ||
          (contentHash !== "" && entry.messageRef.contentHash === contentHash)),
    );
    if (index < 0) {
      return;
    }
    committed = committed.slice(0, index);
    schedule(true);
  }

  function applyOne(event: ConversationStreamEvent) {
    const seq = readEventSeq(event);
    if (seq > 0) {
      if (seq <= lastSeq) {
        // Already applied (resubscribe replay / snapshot overlap).
        return;
      }
      lastSeq = seq;
    }
    const runId = readEventRunId(event);
    switch (event.type) {
      case "run_started": {
        // Fold the previous reply into history in the same commit that will
        // render the new run — the one intentional layout change.
        foldSettled(true);
        activeRun = {
          runId,
          state: "running",
          startedSeq: readEventSeq(event),
          toolStatus: null,
          toolStatusIsCompaction: false,
          clientRequestId:
            typeof (event as { client_request_id?: unknown }).client_request_id === "string"
              ? (event as { client_request_id: string }).client_request_id
              : undefined,
          updatedAt: Date.now(),
        };
        setToolStatus(null, false, true);
        return;
      }
      case "run_finished": {
        applyRunFinished(event);
        return;
      }
      case "run_queued": {
        // The prompt went into the desktop queue: drop its provisional
        // entries; the queue UI shows it instead.
        removeRunEntries(runId);
        if (activeRun?.runId === runId) {
          activeRun = null;
          schedule(true);
        }
        return;
      }
      case "rebased": {
        applyRebased(event);
        return;
      }
      case "snapshot": {
        const payload = event as { entries_json?: string; as_of_seq?: number };
        rebuildLiveFromSnapshot(payload.entries_json ?? "", runId);
        if (typeof payload.as_of_seq === "number" && Number.isFinite(payload.as_of_seq)) {
          // The snapshot content covers the log through as_of_seq; drop the
          // overlapping tail of any concurrent replay.
          lastSeq = Math.max(lastSeq, Math.floor(payload.as_of_seq));
        }
        const status = (event as { tool_status?: string | null }).tool_status ?? null;
        setToolStatus(
          typeof status === "string" ? status : null,
          (event as { tool_status_is_compaction?: boolean }).tool_status_is_compaction === true,
          true,
        );
        return;
      }
      case "tool_status": {
        const status = (event as { status?: string | null }).status ?? null;
        setToolStatus(
          typeof status === "string" ? status : null,
          (event as { isCompaction?: boolean }).isCompaction === true,
        );
        if (activeRun && activeRun.runId === runId) {
          activeRun = { ...activeRun, toolStatus, toolStatusIsCompaction };
        }
        return;
      }
      default: {
        applyDelta(event, runId);
      }
    }
  }
}

function isSnapshotChatEntry(value: unknown): value is ChatEntry {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const v = value as Record<string, unknown>;
  if (typeof v.id !== "string" || typeof v.kind !== "string") {
    return false;
  }
  switch (v.kind) {
    case "user":
      return typeof v.text === "string" && Array.isArray(v.attachments);
    case "assistant":
    case "thinking":
    case "error":
      return typeof v.text === "string";
    case "tool_call":
      return v.toolCall != null && typeof v.toolCall === "object";
    case "tool_result":
      return v.toolResult != null && typeof v.toolResult === "object";
    case "hosted_search":
      return v.hostedSearch != null && typeof v.hostedSearch === "object";
    default:
      return false;
  }
}

export function parseSnapshotEntries(json: string | undefined): ChatEntry[] {
  const raw = typeof json === "string" ? json.trim() : "";
  if (!raw) {
    return [];
  }
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(isSnapshotChatEntry) : [];
  } catch {
    return [];
  }
}
