//! Liveness journal for ManagedProcess children, stored in the shared
//! config DB. A row exists iff the process may still be alive: inserted at
//! spawn, deleted the moment an exit is observed. Isolated rows survive
//! restarts and are restored into the registry; non-isolated leftovers are
//! crash residue that gets reaped on the next launch and never displayed.
//!
//! Rows carry the owning LiveAgent instance's identity (pid + start time) so
//! a second concurrently-running instance never treats a live sibling's
//! children as crash residue.

use rusqlite::{params, Connection};

use crate::runtime::managed_process::ManagedProcessRecord;
use crate::services::automation::db::{
    ensure_schema as ensure_automation_meta, now_ms, open_automation_connection, read_revision,
};

pub const MANAGED_PROCESS_REVISION_KEY: &str = "managed_process_revision";

#[derive(Debug)]
pub struct ManagedProcessJournalRow {
    pub record: ManagedProcessRecord,
    pub owner_pid: u32,
    pub owner_started_at: i64,
}

pub fn open_journal() -> Result<Connection, String> {
    let conn = open_automation_connection()?;
    ensure_journal_schema(&conn)?;
    Ok(conn)
}

pub fn ensure_journal_schema(conn: &Connection) -> Result<(), String> {
    // automation_meta hosts the shared revision counter; creating it here
    // keeps the journal independent of automation store init order.
    ensure_automation_meta(conn)?;
    conn.execute_batch(
        "
        CREATE TABLE IF NOT EXISTS managed_processes (
            process_id TEXT PRIMARY KEY,
            payload_json TEXT NOT NULL,
            isolated INTEGER NOT NULL DEFAULT 0,
            pid INTEGER NOT NULL,
            started_at INTEGER NOT NULL,
            owner_pid INTEGER NOT NULL DEFAULT 0,
            owner_started_at INTEGER NOT NULL DEFAULT 0,
            updated_at INTEGER NOT NULL
        );
        ",
    )
    .map_err(|e| format!("初始化 managed_processes 表失败：{e}"))?;
    Ok(())
}

pub fn read_journal_revision(conn: &Connection) -> Result<u64, String> {
    read_revision(conn, MANAGED_PROCESS_REVISION_KEY)
}

/// Monotonic persist: concurrent bump_and_notify callers may persist out of
/// order, so a stale value must never overwrite a newer one.
pub fn persist_journal_revision(conn: &Connection, revision: u64) -> Result<(), String> {
    conn.execute(
        "INSERT INTO automation_meta (key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value
         WHERE CAST(automation_meta.value AS INTEGER) < CAST(excluded.value AS INTEGER)",
        params![MANAGED_PROCESS_REVISION_KEY, (revision as i64).to_string()],
    )
    .map_err(|e| format!("写入 managed process revision 失败：{e}"))?;
    Ok(())
}

pub fn insert_row(
    conn: &Connection,
    record: &ManagedProcessRecord,
    owner_pid: u32,
    owner_started_at: i64,
) -> Result<(), String> {
    let payload = serde_json::to_string(record)
        .map_err(|e| format!("序列化 managed process 记录失败：{e}"))?;
    conn.execute(
        "INSERT OR REPLACE INTO managed_processes
             (process_id, payload_json, isolated, pid, started_at, owner_pid, owner_started_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        params![
            record.id,
            payload,
            record.isolated as i64,
            record.pid as i64,
            record.started_at as i64,
            owner_pid as i64,
            owner_started_at,
            now_ms(),
        ],
    )
    .map_err(|e| format!("写入 managed process journal 失败：{e}"))?;
    Ok(())
}

pub fn delete_row(conn: &Connection, id: &str) -> Result<(), String> {
    conn.execute(
        "DELETE FROM managed_processes WHERE process_id = ?1",
        params![id],
    )
    .map_err(|e| format!("删除 managed process journal 行失败：{e}"))?;
    Ok(())
}

/// Clears this instance's own non-isolated rows on clean shutdown. Rows
/// owned by a sibling instance are left alone.
pub fn delete_non_isolated_rows(
    conn: &Connection,
    owner_pid: u32,
    owner_started_at: i64,
) -> Result<(), String> {
    conn.execute(
        "DELETE FROM managed_processes
         WHERE isolated = 0 AND owner_pid = ?1 AND owner_started_at = ?2",
        params![owner_pid as i64, owner_started_at],
    )
    .map_err(|e| format!("清理 managed process journal 失败：{e}"))?;
    Ok(())
}

/// Reads every journal row. Rows whose payload no longer parses are dropped
/// from the result and deleted (they cannot be reasoned about safely).
pub fn read_rows(conn: &Connection) -> Result<Vec<ManagedProcessJournalRow>, String> {
    let mut stmt = conn
        .prepare("SELECT process_id, payload_json, owner_pid, owner_started_at FROM managed_processes")
        .map_err(|e| format!("读取 managed process journal 失败：{e}"))?;
    let raw_rows = stmt
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, i64>(2)?,
                row.get::<_, i64>(3)?,
            ))
        })
        .map_err(|e| format!("读取 managed process journal 失败：{e}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("读取 managed process journal 失败：{e}"))?;
    drop(stmt);

    let mut rows = Vec::with_capacity(raw_rows.len());
    for (id, payload, owner_pid, owner_started_at) in raw_rows {
        match serde_json::from_str::<ManagedProcessRecord>(&payload) {
            Ok(record) => rows.push(ManagedProcessJournalRow {
                record,
                owner_pid: owner_pid.max(0) as u32,
                owner_started_at,
            }),
            Err(_) => {
                let _ = delete_row(conn, &id);
            }
        }
    }
    Ok(rows)
}
