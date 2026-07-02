import type { ChatCommandAccepted, ChatCommandUpdate } from "./streamTypes";
import type { TranscriptStore } from "./transcriptStore";

// Command lifecycle for chat submissions from this client. The pipeline owns
// the optimistic user echo and reacts to pre-stream outcomes
// (chat.command_update); everything after run start flows through the
// conversation stream and needs no pipeline involvement.

export type ChatCommandRequest = {
  conversationId: string;
  clientRequestId: string;
  message: string;
  attachments?: Extract<
    Parameters<TranscriptStore["addOptimisticUserEntry"]>[0]["attachments"],
    unknown
  >;
  // edit_resend commands seed an optimistic `rebased` truncation; compensation
  // paths (queued_in_gui / failed) need to know to restore the transcript.
  isEditResend?: boolean;
  // Queue-destined submissions (a run is already streaming) skip the local
  // echo: the prompt belongs in the queue panel, and a transcript bubble
  // would just flash until the queued_in_gui compensation removed it.
  optimistic?: boolean;
  submit: () => Promise<ChatCommandAccepted>;
};

export type PendingChatCommand = {
  runId: string | null;
  clientRequestId: string;
  conversationId: string;
  isEditResend: boolean;
  submittedAt: number;
};

export type ChatCommandOutcome =
  | { kind: "accepted"; accepted: ChatCommandAccepted }
  | { kind: "queued_in_gui"; update: ChatCommandUpdate }
  | { kind: "bound"; update: ChatCommandUpdate }
  | { kind: "failed"; errorCode: string | null; message: string };

export type ChatCommandPipelineHooks = {
  getTranscriptStore(conversationId: string): TranscriptStore;
  // A draft conversation got its real id: re-key stores/subscriptions.
  onBound?(update: ChatCommandUpdate, pending: PendingChatCommand): void;
  onQueuedInGui?(update: ChatCommandUpdate, pending: PendingChatCommand): void;
  onFailed?(pending: PendingChatCommand, errorCode: string | null, message: string): void;
  onPendingChanged?(): void;
};

const PENDING_COMMAND_TIMEOUT_MS = 60_000;

export class ChatCommandPipeline {
  // conversationId → pending command (one in-flight submission per
  // conversation drives the pre-first-token spinner).
  private pending = new Map<string, PendingChatCommand>();
  private byRunId = new Map<string, PendingChatCommand>();
  private timeouts = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(private readonly hooks: ChatCommandPipelineHooks) {}

  hasPending(conversationId: string): boolean {
    return this.pending.has(conversationId);
  }

  async submit(request: ChatCommandRequest): Promise<ChatCommandOutcome> {
    if (request.optimistic !== false) {
      this.hooks.getTranscriptStore(request.conversationId).addOptimisticUserEntry({
        clientRequestId: request.clientRequestId,
        text: request.message,
        attachments: request.attachments as never,
      });
    }

    const pending: PendingChatCommand = {
      runId: null,
      clientRequestId: request.clientRequestId,
      conversationId: request.conversationId,
      isEditResend: request.isEditResend === true,
      submittedAt: Date.now(),
    };
    this.setPending(request.conversationId, pending);

    try {
      const accepted = await request.submit();
      pending.runId = accepted.runId;
      if (this.pending.get(pending.conversationId) === pending) {
        // Only register while the pending is still live: an own run signal
        // (matched by client_request_id) may have settled it before the
        // accept response landed, and a dead registration would leak.
        this.byRunId.set(accepted.runId, pending);
      }
      return { kind: "accepted", accepted };
    } catch (error) {
      const message = error instanceof Error ? error.message : "chat command failed";
      this.fail(pending, null, message);
      return { kind: "failed", errorCode: null, message };
    }
  }

  // chat.command_update push from the gateway (issuing connection only).
  handleCommandUpdate(update: ChatCommandUpdate): void {
    const pending = this.byRunId.get(update.runId);
    if (!pending) {
      return;
    }
    switch (update.phase) {
      case "bound": {
        if (update.conversationId && update.conversationId !== pending.conversationId) {
          // Draft conversation materialized: the app re-keys stores and
          // subscriptions, then the pending command follows the real id.
          const previousConversationId = pending.conversationId;
          pending.conversationId = update.conversationId;
          this.movePending(previousConversationId, update.conversationId, pending);
          this.hooks.onBound?.(update, pending);
        }
        return;
      }
      case "queued_in_gui": {
        // The prompt is parked in the desktop queue: it is not pending
        // anymore, the queue panel shows it. The seeded entries are removed
        // by the stream's run_queued event; the optimistic entry may still
        // exist if the seed never reached the stream (draft conversations).
        this.hooks
          .getTranscriptStore(pending.conversationId)
          .removeOptimisticUserEntry(pending.clientRequestId);
        this.clearPending(pending);
        this.hooks.onQueuedInGui?.(update, pending);
        return;
      }
      case "failed": {
        this.fail(pending, update.errorCode, update.message ?? "chat command failed");
        return;
      }
    }
  }

  // Stream/activity signals that settle the pending command: the run started
  // (tokens will flow), finished (failed fast), or was queued. Identity is
  // strict — a null-runId pending (accept response still in flight) settles
  // only on a signal carrying its own client_request_id; foreign runs (GUI
  // queue auto-sends, another client's commands) never disarm the watchdog.
  handleRunSignal(conversationId: string, runId: string, clientRequestId?: string): void {
    const pending = this.pending.get(conversationId);
    if (!pending) {
      return;
    }
    const matchesRunId = runId !== "" && pending.runId === runId;
    const matchesClientRequest =
      pending.runId === null &&
      typeof clientRequestId === "string" &&
      clientRequestId !== "" &&
      clientRequestId === pending.clientRequestId;
    if (matchesRunId || matchesClientRequest) {
      this.clearPending(pending);
    }
  }

  private fail(pending: PendingChatCommand, errorCode: string | null, message: string): void {
    const store = this.hooks.getTranscriptStore(pending.conversationId);
    store.removeOptimisticUserEntry(pending.clientRequestId);
    store.appendLocalError(message);
    this.clearPending(pending);
    this.hooks.onFailed?.(pending, errorCode, message);
  }

  private setPending(conversationId: string, pending: PendingChatCommand): void {
    const existingTimeout = this.timeouts.get(conversationId);
    if (existingTimeout !== undefined) {
      clearTimeout(existingTimeout);
    }
    this.pending.set(conversationId, pending);
    this.timeouts.set(
      conversationId,
      setTimeout(() => {
        const current = this.pending.get(pending.conversationId);
        if (current === pending) {
          this.fail(
            pending,
            "startup_timeout",
            "The desktop app did not start this request in time. Please retry.",
          );
        }
      }, PENDING_COMMAND_TIMEOUT_MS),
    );
    this.hooks.onPendingChanged?.();
  }

  private movePending(
    from: string,
    to: string,
    pending: PendingChatCommand,
  ): void {
    if (this.pending.get(from) === pending) {
      this.pending.delete(from);
    }
    const timeout = this.timeouts.get(from);
    if (timeout !== undefined) {
      this.timeouts.delete(from);
      this.timeouts.set(to, timeout);
    }
    this.pending.set(to, pending);
    this.hooks.onPendingChanged?.();
  }

  private clearPending(pending: PendingChatCommand): void {
    if (this.pending.get(pending.conversationId) === pending) {
      this.pending.delete(pending.conversationId);
      const timeout = this.timeouts.get(pending.conversationId);
      if (timeout !== undefined) {
        clearTimeout(timeout);
        this.timeouts.delete(pending.conversationId);
      }
    }
    if (pending.runId) {
      this.byRunId.delete(pending.runId);
    }
    this.hooks.onPendingChanged?.();
  }
}
