import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createWebModuleLoader } from "../../test/helpers/load-web-module.mjs";

const loader = createWebModuleLoader({
  rootDir: fileURLToPath(new URL("../", import.meta.url)),
});

const { createTranscriptStore } = loader.loadModule("src/lib/chat/stream/transcriptStore.ts");

function runStarted(runId, seq, extra = {}) {
  return { type: "run_started", conversation_id: "conv-1", run_id: runId, seq, ...extra };
}

function runFinished(runId, seq, status = "completed", extra = {}) {
  return { type: "run_finished", conversation_id: "conv-1", run_id: runId, seq, status, ...extra };
}

function token(runId, seq, text) {
  return { type: "token", conversation_id: "conv-1", run_id: runId, seq, text };
}

function userMessage(runId, seq, message, extra = {}) {
  return { type: "user_message", conversation_id: "conv-1", run_id: runId, seq, message, ...extra };
}

test("run lifecycle: reply settles in the tail and folds at the next run_started", () => {
  const store = createTranscriptStore();
  store.applyEvent(userMessage("run-1", 1, "hello"));
  store.applyEvent(runStarted("run-1", 2));
  store.applyEvent(token("run-1", 3, "answer "));
  store.applyEvent(token("run-1", 4, "text"));
  store.flush();

  let snapshot = store.getSnapshot();
  assert.equal(snapshot.committed.length, 0);
  assert.equal(snapshot.tail.length, 2);
  assert.equal(snapshot.activeRun?.runId, "run-1");

  const assistantId = snapshot.tail[1].id;
  assert.equal(snapshot.tail[1].text, "answer text");

  // Reply end: entries stay in the tail (zero DOM movement), busy clears.
  store.applyEvent(runFinished("run-1", 5));
  store.flush();
  snapshot = store.getSnapshot();
  assert.equal(snapshot.activeRun, null);
  assert.equal(snapshot.committed.length, 0);
  assert.equal(snapshot.tail.length, 2);
  assert.equal(snapshot.tail[1].id, assistantId, "settled entry keeps its id");
  const foldRevisionBefore = snapshot.foldRevision;

  // Queue auto-send handoff: the next run folds the settled tail into
  // committed and streams into a fresh live segment.
  store.applyEvent(userMessage("run-2", 6, "queued prompt"));
  store.applyEvent(runStarted("run-2", 7));
  store.applyEvent(token("run-2", 8, "second"));
  store.flush();
  snapshot = store.getSnapshot();
  assert.equal(snapshot.committed.length, 2, "previous reply folded into committed");
  assert.equal(snapshot.committed[1].id, assistantId, "fold preserves ids");
  assert.ok(snapshot.foldRevision > foldRevisionBefore);
  assert.equal(snapshot.activeRun?.runId, "run-2");
  assert.deepEqual(
    snapshot.tail.map((entry) => entry.kind),
    ["user", "assistant"],
  );
  assert.equal(snapshot.tail[0].text, "queued prompt");
  assert.equal(snapshot.tail[1].text, "second");
});

test("cross-run entries never collide on id", () => {
  const store = createTranscriptStore();
  for (const runId of ["run-1", "run-2"]) {
    store.applyEvent(runStarted(runId, runId === "run-1" ? 1 : 4));
    store.applyEvent(token(runId, runId === "run-1" ? 2 : 5, "same text"));
    store.applyEvent(runFinished(runId, runId === "run-1" ? 3 : 6));
  }
  store.applyEvent(runStarted("run-3", 7));
  store.flush();

  const snapshot = store.getSnapshot();
  const ids = [...snapshot.committed, ...snapshot.tail].map((entry) => entry.id);
  assert.equal(new Set(ids).size, ids.length, `duplicate ids: ${ids.join(", ")}`);
});

test("optimistic user entry is adopted by client_request_id keeping its id", () => {
  const store = createTranscriptStore();
  store.addOptimisticUserEntry({ clientRequestId: "client-1", text: "hi there" });
  store.flush();
  const optimisticId = store.getSnapshot().tail[0].id;

  store.applyEvent(userMessage("run-1", 1, "hi there", { client_request_id: "client-1" }));
  store.flush();
  const snapshot = store.getSnapshot();
  assert.equal(snapshot.tail.length, 1, "seeded echo must not duplicate the bubble");
  assert.equal(snapshot.tail[0].id, optimisticId, "user bubble keeps its identity");
});

test("failed run appends an error entry and clears busy", () => {
  const store = createTranscriptStore();
  store.applyEvent(runStarted("run-1", 1));
  store.applyEvent(runFinished("run-1", 2, "failed", { message: "model exploded" }));
  store.flush();
  const snapshot = store.getSnapshot();
  assert.equal(snapshot.activeRun, null);
  const tailText = snapshot.tail.map((entry) => entry.text ?? "").join("\n");
  assert.match(tailText, /model exploded/);
});

test("run_queued removes the run's provisional entries", () => {
  const store = createTranscriptStore();
  store.addOptimisticUserEntry({ clientRequestId: "client-1", text: "park me" });
  store.applyEvent(userMessage("run-1", 1, "park me", { client_request_id: "client-1" }));
  store.flush();
  assert.equal(store.getSnapshot().tail.length, 1);

  store.applyEvent({
    type: "run_queued",
    conversation_id: "conv-1",
    run_id: "run-1",
    seq: 2,
    client_request_id: "client-1",
  });
  store.flush();
  assert.equal(store.getSnapshot().tail.length, 0, "queued prompt leaves the transcript");
});

test("history snapshot merge preserves rendered ids and upgrades content", () => {
  const store = createTranscriptStore();
  store.applyEvent(userMessage("run-1", 1, "question"));
  store.applyEvent(runStarted("run-1", 2));
  store.applyEvent(token("run-1", 3, "reply"));
  store.applyEvent(runFinished("run-1", 4));
  store.applyEvent(userMessage("run-2", 5, "next"));
  store.applyEvent(runStarted("run-2", 6));
  store.flush();
  const settledAssistantId = store.getSnapshot().committed.find(
    (entry) => entry.kind === "assistant",
  )?.id;
  assert.ok(settledAssistantId, "first reply folded into committed");

  // History arrives with its own ids for the same logical entries plus the
  // tail entries; tail entries must stay in the tail region.
  store.applyHistorySnapshot([
    { id: "hist-1", kind: "user", text: "question", attachments: [] },
    { id: "hist-2", kind: "assistant", text: "reply", round: 0 },
    { id: "hist-3", kind: "user", text: "next", attachments: [] },
  ]);
  store.flush();
  const snapshot = store.getSnapshot();
  const committedAssistant = snapshot.committed.find((entry) => entry.kind === "assistant");
  assert.equal(
    committedAssistant?.id,
    settledAssistantId,
    "history merge keeps the rendered id",
  );
  assert.equal(
    snapshot.committed.some((entry) => entry.text === "next" && entry.kind === "user"),
    false,
    "entries still rendered in the tail stay out of committed",
  );
  assert.equal(snapshot.tail.some((entry) => entry.text === "next"), true);
});

test("rebased truncates committed at the edited user message", () => {
  const store = createTranscriptStore();
  store.applyHistorySnapshot([
    {
      id: "hist-1",
      kind: "user",
      text: "first",
      attachments: [],
      messageRef: {
        segmentIndex: 0,
        messageIndex: 0,
        segmentId: "segment-1",
        messageId: "message-1",
        role: "user",
        contentHash: "hash-1",
      },
    },
    { id: "hist-2", kind: "assistant", text: "answer", round: 0 },
    {
      id: "hist-3",
      kind: "user",
      text: "second",
      attachments: [],
      messageRef: {
        segmentIndex: 0,
        messageIndex: 2,
        segmentId: "segment-1",
        messageId: "message-3",
        role: "user",
        contentHash: "hash-3",
      },
    },
  ]);
  store.applyEvent({
    type: "rebased",
    conversation_id: "conv-1",
    run_id: "run-9",
    seq: 1,
    base_message_ref: {
      segment_index: 0,
      message_index: 2,
      segment_id: "segment-1",
      message_id: "message-3",
      role: "user",
      content_hash: "hash-3",
    },
  });
  store.flush();
  const snapshot = store.getSnapshot();
  assert.deepEqual(
    snapshot.committed.map((entry) => entry.id),
    ["hist-1", "hist-2"],
    "committed truncated at the edited message",
  );
});

test("reset sync rebuilds the tail from a runtime snapshot", () => {
  const store = createTranscriptStore();
  store.applyEvent(runStarted("run-1", 1));
  store.applyEvent(token("run-1", 2, "will be lost"));
  store.flush();

  store.applySync({
    conversationId: "conv-1",
    streamEpoch: "epoch-2",
    latestSeq: 3,
    reset: true,
    activity: {
      runId: "run-2",
      state: "running",
      startedSeq: 1,
      toolStatus: "Vibing",
      toolStatusIsCompaction: false,
      updatedAt: 1,
    },
    snapshot: {
      runId: "run-2",
      revision: 5,
      entriesJson: JSON.stringify([
        { id: "snap-1", kind: "assistant", text: "rebuilt from snapshot", round: 0 },
      ]),
      toolStatus: "Vibing",
      toolStatusIsCompaction: false,
    },
    events: [{ type: "token", conversation_id: "conv-1", run_id: "run-2", seq: 3, text: "!" }],
  });
  store.flush();

  const snapshot = store.getSnapshot();
  assert.equal(snapshot.activeRun?.runId, "run-2");
  assert.equal(snapshot.toolStatus, "Vibing");
  const text = snapshot.tail.map((entry) => entry.text ?? "").join("");
  assert.match(text, /rebuilt from snapshot/);
  assert.doesNotMatch(text, /will be lost/);
});

test("tool status mirrors into the snapshot and clears on run end", () => {
  const store = createTranscriptStore();
  store.applyEvent(runStarted("run-1", 1));
  store.applyEvent({
    type: "tool_status",
    conversation_id: "conv-1",
    run_id: "run-1",
    seq: 2,
    status: "Vibing",
  });
  store.flush();
  assert.equal(store.getSnapshot().toolStatus, "Vibing");

  store.applyEvent(runFinished("run-1", 3));
  store.flush();
  assert.equal(store.getSnapshot().toolStatus, null);
});

test("replay idempotency: a resubscribe replaying applied events changes nothing", () => {
  const store = createTranscriptStore();
  const events = [
    userMessage("run-1", 1, "hello", { client_request_id: "client-1" }),
    runStarted("run-1", 2),
    token("run-1", 3, "answer "),
    token("run-1", 4, "text"),
  ];
  for (const event of events) {
    store.applyEvent(event);
  }
  store.flush();
  const before = store.getSnapshot();
  assert.equal(before.tail.length, 2);
  assert.equal(before.tail[1].text, "answer text");

  // Conversation switch-back: the transport re-subscribes from after_seq=0
  // and the gateway replays the whole buffered log plus one new event.
  store.applySync({
    conversationId: "conv-1",
    streamEpoch: "epoch-1",
    latestSeq: 5,
    reset: false,
    activity: {
      runId: "run-1",
      state: "running",
      startedSeq: 2,
      toolStatus: null,
      toolStatusIsCompaction: false,
      updatedAt: 1,
    },
    snapshot: null,
    events: [...events, token("run-1", 5, "!")],
  });
  store.flush();

  const snapshot = store.getSnapshot();
  const userBubbles = snapshot.tail.filter((entry) => entry.kind === "user");
  const assistants = snapshot.tail.filter((entry) => entry.kind === "assistant");
  assert.equal(userBubbles.length, 1, "exactly one user bubble after replay");
  assert.equal(assistants.length, 1, "exactly one assistant entry after replay");
  assert.equal(assistants[0].text, "answer text!", "only the new token applied");
  const ids = [...snapshot.committed, ...snapshot.tail].map((entry) => entry.id);
  assert.equal(new Set(ids).size, ids.length, `duplicate ids: ${ids.join(", ")}`);
});

test("snapshot as_of_seq is a replay barrier: overlapping events are dropped", () => {
  const store = createTranscriptStore();
  // Late join mid-run: the subscribe response carries a runtime snapshot
  // covering the log through seq 4, plus a replay that overlaps it.
  store.applySync({
    conversationId: "conv-1",
    streamEpoch: "epoch-1",
    latestSeq: 5,
    reset: false,
    activity: {
      runId: "run-1",
      state: "running",
      startedSeq: 2,
      toolStatus: null,
      toolStatusIsCompaction: false,
      updatedAt: 1,
    },
    snapshot: {
      runId: "run-1",
      revision: 3,
      entriesJson: JSON.stringify([
        { id: "snap-assistant", kind: "assistant", text: "answer text", round: 0 },
      ]),
      toolStatus: null,
      toolStatusIsCompaction: false,
      asOfSeq: 4,
    },
    events: [
      token("run-1", 3, "answer "),
      token("run-1", 4, "text"),
      token("run-1", 5, "!"),
    ],
  });
  store.flush();
  const snapshot = store.getSnapshot();
  const text = snapshot.tail.map((entry) => entry.text ?? "").join("");
  assert.equal(text, "answer text!", "snapshot content is not double-applied");
});

test("inline snapshot events carry as_of_seq and drop the overlapping tail", () => {
  const store = createTranscriptStore();
  store.applyEvent(runStarted("run-1", 1));
  store.applyEvent({
    type: "snapshot",
    conversation_id: "conv-1",
    run_id: "run-1",
    revision: 7,
    entries_json: JSON.stringify([
      { id: "snap-assistant", kind: "assistant", text: "full text so far", round: 0 },
    ]),
    as_of_seq: 6,
  });
  // Events at or below the snapshot's coverage must be ignored; newer ones apply.
  store.applyEvent(token("run-1", 5, "stale "));
  store.applyEvent(token("run-1", 6, "stale"));
  store.applyEvent(token("run-1", 7, " and more"));
  store.flush();
  const text = store.getSnapshot().tail.map((entry) => entry.text ?? "").join("");
  assert.equal(text, "full text so far and more");
});

test("stray run_finished for a non-active run never settles the streaming tail", () => {
  const store = createTranscriptStore();
  store.applyEvent(runStarted("run-b", 1));
  store.applyEvent(token("run-b", 2, "streaming"));
  store.applyEvent({
    type: "tool_status",
    conversation_id: "conv-1",
    run_id: "run-b",
    seq: 3,
    status: "Vibing",
  });
  store.flush();

  // The gateway deliberately appends terminals for non-active runs (e.g.
  // failing a superseded queued run). The active segment must not settle.
  store.applyEvent(runFinished("run-a", 4, "failed", { message: "queued run failed" }));
  store.flush();
  const snapshot = store.getSnapshot();
  assert.equal(snapshot.activeRun?.runId, "run-b", "active run unchanged");
  assert.equal(snapshot.toolStatus, "Vibing", "tool status unchanged");
  assert.equal(
    snapshot.tail.some((entry) => entry.text === "streaming"),
    true,
    "streaming entry still live",
  );

  // The active run's own terminal still settles normally afterwards.
  store.applyEvent(runFinished("run-b", 5));
  store.flush();
  assert.equal(store.getSnapshot().activeRun, null);
});

test("run_finished settles only entries owned by the finished run", () => {
  const store = createTranscriptStore();
  store.applyEvent(runStarted("run-a", 1));
  store.applyEvent(token("run-a", 2, "reply a"));
  // A queued command's seeded user message (run-b) plus a not-yet-adopted
  // optimistic echo arrive while run-a is still streaming.
  store.applyEvent(userMessage("run-b", 3, "queued prompt"));
  store.addOptimisticUserEntry({ clientRequestId: "client-c", text: "pending echo" });
  store.applyEvent(runFinished("run-a", 4));
  store.flush();

  let snapshot = store.getSnapshot();
  assert.equal(snapshot.activeRun, null);
  // run-a's reply settled; run-b's seeded user message and the optimistic
  // echo stay live for their own runs.
  store.applyEvent(runStarted("run-b", 5));
  store.applyEvent(token("run-b", 6, "reply b"));
  store.flush();
  snapshot = store.getSnapshot();
  assert.deepEqual(
    snapshot.committed.map((entry) => entry.text),
    ["reply a"],
    "fold took only run-a's settled entries",
  );
  assert.deepEqual(
    snapshot.tail.map((entry) => entry.text),
    ["queued prompt", "pending echo", "reply b"],
    "foreign entries stayed in the live region",
  );
  const ids = [...snapshot.committed, ...snapshot.tail].map((entry) => entry.id);
  assert.equal(new Set(ids).size, ids.length);
});

test("interleaved run_queued compensation still removes the adopted bubble", () => {
  const store = createTranscriptStore();
  store.applyEvent(runStarted("run-a", 1));
  store.addOptimisticUserEntry({ clientRequestId: "client-b", text: "park me" });
  store.applyEvent(userMessage("run-b", 2, "park me", { client_request_id: "client-b" }));
  store.applyEvent(runFinished("run-a", 3));
  store.applyEvent(runStarted("run-x", 4));
  store.applyEvent({
    type: "run_queued",
    conversation_id: "conv-1",
    run_id: "run-b",
    seq: 5,
    client_request_id: "client-b",
  });
  store.flush();
  const snapshot = store.getSnapshot();
  assert.equal(
    [...snapshot.committed, ...snapshot.tail].some((entry) => entry.text === "park me"),
    false,
    "queued prompt left the transcript entirely",
  );
});

test("reset folds the settled tail into committed instead of dropping the last reply", () => {
  const store = createTranscriptStore();
  store.applyEvent(userMessage("run-1", 1, "question"));
  store.applyEvent(runStarted("run-1", 2));
  store.applyEvent(token("run-1", 3, "the reply"));
  store.applyEvent(runFinished("run-1", 4));
  store.flush();
  const settledIds = store.getSnapshot().tail.map((entry) => entry.id);
  assert.equal(settledIds.length, 2);

  // Gateway restart while idle: epoch reset with nothing to replay.
  store.applySync({
    conversationId: "conv-1",
    streamEpoch: "epoch-2",
    latestSeq: 0,
    reset: true,
    activity: null,
    snapshot: null,
    events: [],
  });
  store.flush();
  const snapshot = store.getSnapshot();
  assert.deepEqual(
    snapshot.committed.map((entry) => entry.id),
    settledIds,
    "settled reply folded into committed with stable ids",
  );
  assert.equal(snapshot.tail.length, 0);
});

test("history snapshot upgrades matching tail entries in place (messageRef arrives)", () => {
  const store = createTranscriptStore();
  store.addOptimisticUserEntry({ clientRequestId: "client-1", text: "edit me" });
  store.applyEvent(userMessage("run-1", 1, "edit me", { client_request_id: "client-1" }));
  store.applyEvent(runStarted("run-1", 2));
  store.applyEvent(token("run-1", 3, "reply"));
  store.applyEvent(runFinished("run-1", 4));
  store.flush();
  const before = store.getSnapshot();
  const userId = before.tail.find((entry) => entry.kind === "user")?.id;
  assert.ok(userId);
  assert.equal(before.tail.find((entry) => entry.kind === "user")?.messageRef, undefined);

  const messageRef = {
    segmentIndex: 0,
    messageIndex: 0,
    segmentId: "segment-1",
    messageId: "message-1",
    role: "user",
    contentHash: "hash-1",
  };
  store.applyHistorySnapshot([
    { id: "hist-user", kind: "user", text: "edit me", attachments: [], messageRef },
    { id: "hist-assistant", kind: "assistant", text: "reply", round: 0 },
  ]);
  store.flush();
  const snapshot = store.getSnapshot();
  const tailUser = snapshot.tail.find((entry) => entry.kind === "user");
  assert.equal(tailUser?.id, userId, "tail entry keeps its rendered id");
  assert.deepEqual(tailUser?.messageRef, messageRef, "history payload upgraded in place");
  assert.equal(
    snapshot.committed.some((entry) => entry.kind === "user" && entry.text === "edit me"),
    false,
    "still excluded from committed",
  );
});


test("history merge is occurrence-aware: repeated dedup keys never share an id", () => {
  const store = createTranscriptStore();
  // Two identical user prompts and two id-less same-name tool calls in the
  // same round across runs — every dedup key below collides.
  store.applyHistorySnapshot([
    { id: "hist-1", kind: "user", text: "继续", attachments: [] },
    { id: "hist-2", kind: "assistant", text: "第一次回复", round: 0 },
    { id: "hist-3", kind: "user", text: "继续", attachments: [] },
    { id: "hist-4", kind: "assistant", text: "第二次回复", round: 0 },
  ]);
  store.flush();
  let snapshot = store.getSnapshot();
  assert.equal(snapshot.committed.length, 4);
  let ids = snapshot.committed.map((entry) => entry.id);
  assert.equal(new Set(ids).size, ids.length, `duplicate ids: ${ids.join(", ")}`);

  // Re-merging the same snapshot keeps every occurrence, ids stay unique and
  // stable (each occurrence adopts its own previous id, in order).
  const before = snapshot.committed.map((entry) => entry.id);
  store.applyHistorySnapshot([
    { id: "hist-1b", kind: "user", text: "继续", attachments: [] },
    { id: "hist-2b", kind: "assistant", text: "第一次回复", round: 0 },
    { id: "hist-3b", kind: "user", text: "继续", attachments: [] },
    { id: "hist-4b", kind: "assistant", text: "第二次回复", round: 0 },
  ]);
  store.flush();
  snapshot = store.getSnapshot();
  assert.deepEqual(
    snapshot.committed.map((entry) => entry.id),
    before,
    "occurrences adopt their own previous ids in order",
  );
  assert.equal(snapshot.committed.length, 4, "no occurrence dropped");
});

test("history merge with a committed copy and an identical tail copy keeps both", () => {
  const store = createTranscriptStore();
  // Older identical prompt already in committed…
  store.applyHistorySnapshot([
    { id: "hist-1", kind: "user", text: "ok", attachments: [] },
    { id: "hist-2", kind: "assistant", text: "先前的回复", round: 0 },
  ]);
  // …and the same text sent again in the current run (tail).
  store.applyEvent(userMessage("run-2", 10, "ok"));
  store.applyEvent(runStarted("run-2", 11));
  store.applyEvent(runFinished("run-2", 12));
  store.flush();

  const tailUserId = store.getSnapshot().tail.find((entry) => entry.kind === "user")?.id;
  assert.ok(tailUserId, "tail keeps the new occurrence");

  // History now holds both occurrences: the older one matches the committed
  // copy (id preserved), the newer one upgrades the tail copy in place with
  // its messageRef — neither is dropped, no id is shared.
  store.applyHistorySnapshot([
    { id: "hist-1", kind: "user", text: "ok", attachments: [] },
    { id: "hist-2", kind: "assistant", text: "先前的回复", round: 0 },
    {
      id: "hist-3",
      kind: "user",
      text: "ok",
      attachments: [],
      messageRef: {
        segmentIndex: 0,
        messageIndex: 2,
        segmentId: "segment-1",
        messageId: "message-3",
        role: "user",
        contentHash: "hash-3",
      },
    },
    { id: "hist-4", kind: "assistant", text: "新的回复", round: 0 },
  ]);
  store.flush();
  const snapshot = store.getSnapshot();
  assert.equal(
    snapshot.committed.filter((entry) => entry.kind === "user" && entry.text === "ok").length,
    1,
    "committed keeps the older occurrence",
  );
  const tailUser = snapshot.tail.find((entry) => entry.kind === "user");
  assert.equal(tailUser?.id, tailUserId, "tail occurrence keeps its id");
  assert.equal(tailUser?.messageRef?.messageId, "message-3", "tail occurrence gains its messageRef");
  const allIds = [...snapshot.committed, ...snapshot.tail].map((entry) => entry.id);
  assert.equal(new Set(allIds).size, allIds.length, `duplicate ids: ${allIds.join(", ")}`);
});
