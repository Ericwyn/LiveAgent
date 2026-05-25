-- LiveAgent chat history virtualization seed data.
-- Target database: ~/.liveagent/chat-history.sqlite3
--
-- Import example:
--   sqlite3 "$HOME/.liveagent/chat-history.sqlite3" < scripts/seed_chat_history_virtualization.sql
--
-- This script creates:
--   - 1 conversation with 1000 alternating user/assistant messages.
--   - 9999 additional lightweight conversations.
--   - 10000 total rows in the conversation sidebar list.

PRAGMA foreign_keys = ON;

BEGIN;

CREATE TABLE IF NOT EXISTS chatHistory (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    provider_id TEXT NOT NULL,
    model TEXT NOT NULL,
    session_id TEXT,
    cwd TEXT,
    context_meta_json TEXT,
    active_segment_index INTEGER,
    total_segment_count INTEGER,
    total_message_count INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    is_pinned INTEGER NOT NULL DEFAULT 0,
    pinned_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_chatHistory_updated_at
    ON chatHistory(updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_chatHistory_pinned
    ON chatHistory(is_pinned DESC, pinned_at DESC, updated_at DESC);

CREATE TABLE IF NOT EXISTS chatHistorySegment (
    conversation_id TEXT NOT NULL,
    segment_index INTEGER NOT NULL,
    segment_id TEXT NOT NULL,
    summary_json TEXT,
    messages_json TEXT NOT NULL,
    message_count INTEGER NOT NULL,
    start_message_id TEXT,
    end_message_id TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (conversation_id, segment_index),
    UNIQUE (conversation_id, segment_id),
    FOREIGN KEY (conversation_id) REFERENCES chatHistory(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_chatHistorySegment_conversation_updated
    ON chatHistorySegment(conversation_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS chatHistoryShare (
    conversation_id TEXT PRIMARY KEY,
    token TEXT UNIQUE,
    enabled INTEGER NOT NULL DEFAULT 0,
    redact_tool_content INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    FOREIGN KEY (conversation_id) REFERENCES chatHistory(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_chatHistoryShare_token
    ON chatHistoryShare(token);

CREATE VIRTUAL TABLE IF NOT EXISTS chatHistorySegmentFts USING fts5(
    conversation_id         UNINDEXED,
    segment_index           UNINDEXED,
    segment_id              UNINDEXED,
    title,
    cwd,
    body,
    segment_updated_at      UNINDEXED,
    conversation_updated_at UNINDEXED,
    tokenize = "trigram"
);

CREATE VIRTUAL TABLE IF NOT EXISTS chatHistoryMessageFts USING fts5(
    conversation_id         UNINDEXED,
    segment_index           UNINDEXED,
    segment_id              UNINDEXED,
    message_index           UNINDEXED,
    message_id              UNINDEXED,
    role                    UNINDEXED,
    title,
    cwd,
    body,
    message_updated_at      UNINDEXED,
    segment_updated_at      UNINDEXED,
    conversation_updated_at UNINDEXED,
    tokenize = "trigram"
);

CREATE TABLE IF NOT EXISTS chatHistoryFtsSegmentIndex (
    conversation_id         TEXT NOT NULL,
    segment_index           INTEGER NOT NULL,
    segment_updated_at      INTEGER NOT NULL,
    conversation_updated_at INTEGER NOT NULL,
    PRIMARY KEY (conversation_id, segment_index)
);

CREATE INDEX IF NOT EXISTS idx_chatHistoryFtsSegmentIndex_segment_updated
    ON chatHistoryFtsSegmentIndex(segment_updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_chatHistoryFtsSegmentIndex_conversation_updated
    ON chatHistoryFtsSegmentIndex(conversation_updated_at DESC);

DELETE FROM chatHistorySegmentFts
WHERE conversation_id = 'seed-transcript-1000'
   OR conversation_id LIKE 'seed-list-%';

DELETE FROM chatHistoryMessageFts
WHERE conversation_id = 'seed-transcript-1000'
   OR conversation_id LIKE 'seed-list-%';

DELETE FROM chatHistoryFtsSegmentIndex
WHERE conversation_id = 'seed-transcript-1000'
   OR conversation_id LIKE 'seed-list-%';

DELETE FROM chatHistory
WHERE id = 'seed-transcript-1000'
   OR id LIKE 'seed-list-%';

WITH seed_clock(now_ms) AS (
    SELECT CAST(strftime('%s', 'now') AS INTEGER) * 1000
)
INSERT INTO chatHistory (
    id,
    title,
    provider_id,
    model,
    session_id,
    cwd,
    context_meta_json,
    active_segment_index,
    total_segment_count,
    total_message_count,
    created_at,
    updated_at,
    is_pinned,
    pinned_at
)
SELECT
    'seed-transcript-1000',
    'Seed: 1000-message transcript',
    'seed-provider',
    'seed-model',
    'seed-session-transcript-1000',
    NULL,
    '{"schemaVersion":3,"activeSegmentIndex":0,"totalSegmentCount":1,"totalMessageCount":1000}',
    0,
    1,
    1000,
    now_ms - 86400000,
    now_ms + 1000,
    0,
    NULL
FROM seed_clock;

WITH RECURSIVE msg(n) AS (
    SELECT 1
    UNION ALL
    SELECT n + 1 FROM msg WHERE n < 1000
),
seed_clock(now_ms) AS (
    SELECT CAST(strftime('%s', 'now') AS INTEGER) * 1000
),
messages(payload) AS (
    SELECT
        '[' || group_concat(
            CASE
                WHEN n % 2 = 1 THEN printf(
                    '{"id":"seed-transcript-msg-%04d","role":"user","content":"Transcript virtualization user message #%04d. This seed row is intentionally short.","timestamp":%d}',
                    n,
                    n,
                    now_ms + n
                )
                ELSE printf(
                    '{"id":"seed-transcript-msg-%04d","role":"assistant","content":[{"type":"text","text":"Transcript virtualization assistant response #%04d. This row verifies dynamic height measurement and virtual scrolling."}],"timestamp":%d,"provider":"seed-provider","model":"seed-model","api":"seed","stopReason":"stop"}',
                    n,
                    n,
                    now_ms + n
                )
            END,
            ','
        ) || ']'
    FROM (SELECT n FROM msg ORDER BY n)
    CROSS JOIN seed_clock
)
INSERT INTO chatHistorySegment (
    conversation_id,
    segment_index,
    segment_id,
    summary_json,
    messages_json,
    message_count,
    start_message_id,
    end_message_id,
    created_at,
    updated_at
)
SELECT
    'seed-transcript-1000',
    0,
    'seed-transcript-1000-segment-0',
    NULL,
    payload,
    1000,
    'seed-transcript-msg-0001',
    'seed-transcript-msg-1000',
    now_ms - 86400000,
    now_ms + 1000
FROM messages
CROSS JOIN seed_clock;

WITH RECURSIVE seq(n) AS (
    SELECT 1
    UNION ALL
    SELECT n + 1 FROM seq WHERE n < 9999
),
seed_clock(now_ms) AS (
    SELECT CAST(strftime('%s', 'now') AS INTEGER) * 1000
)
INSERT INTO chatHistory (
    id,
    title,
    provider_id,
    model,
    session_id,
    cwd,
    context_meta_json,
    active_segment_index,
    total_segment_count,
    total_message_count,
    created_at,
    updated_at,
    is_pinned,
    pinned_at
)
SELECT
    printf('seed-list-%05d', n),
    printf('Seed list conversation %05d', n),
    'seed-provider',
    'seed-model',
    printf('seed-session-list-%05d', n),
    NULL,
    '{"schemaVersion":3,"activeSegmentIndex":0,"totalSegmentCount":1,"totalMessageCount":2}',
    0,
    1,
    2,
    now_ms - 86400000 - (n * 1000),
    now_ms - (n * 1000),
    0,
    NULL
FROM seq
CROSS JOIN seed_clock;

WITH RECURSIVE seq(n) AS (
    SELECT 1
    UNION ALL
    SELECT n + 1 FROM seq WHERE n < 9999
),
seed_clock(now_ms) AS (
    SELECT CAST(strftime('%s', 'now') AS INTEGER) * 1000
)
INSERT INTO chatHistorySegment (
    conversation_id,
    segment_index,
    segment_id,
    summary_json,
    messages_json,
    message_count,
    start_message_id,
    end_message_id,
    created_at,
    updated_at
)
SELECT
    printf('seed-list-%05d', n),
    0,
    printf('seed-list-%05d-segment-0', n),
    NULL,
    printf(
        '[{"id":"seed-list-%05d-msg-0001","role":"user","content":"Open seed conversation %05d.","timestamp":%d},{"id":"seed-list-%05d-msg-0002","role":"assistant","content":[{"type":"text","text":"Seed assistant reply for conversation %05d."}],"timestamp":%d,"provider":"seed-provider","model":"seed-model","api":"seed","stopReason":"stop"}]',
        n,
        n,
        now_ms - (n * 1000) - 1,
        n,
        n,
        now_ms - (n * 1000)
    ),
    2,
    printf('seed-list-%05d-msg-0001', n),
    printf('seed-list-%05d-msg-0002', n),
    now_ms - 86400000 - (n * 1000),
    now_ms - (n * 1000)
FROM seq
CROSS JOIN seed_clock;

COMMIT;
