use std::sync::Arc;

use tauri::State;

use crate::runtime::terminal::{
    terminal_shell_options as runtime_terminal_shell_options, TerminalListResponse,
    TerminalReadTailResponse, TerminalSessionRecord, TerminalSessionRegistry,
    TerminalShellOptionsResponse, TerminalSnapshotResponse,
};

#[tauri::command(rename_all = "snake_case")]
pub fn terminal_shell_options() -> TerminalShellOptionsResponse {
    runtime_terminal_shell_options()
}

#[tauri::command(rename_all = "snake_case")]
pub fn terminal_list(
    registry: State<'_, Arc<TerminalSessionRegistry>>,
    project_path_key: Option<String>,
) -> TerminalListResponse {
    registry.list(project_path_key)
}

#[tauri::command(rename_all = "snake_case")]
pub fn terminal_create(
    registry: State<'_, Arc<TerminalSessionRegistry>>,
    cwd: String,
    project_path_key: Option<String>,
    shell: Option<String>,
    title: Option<String>,
    cols: Option<u16>,
    rows: Option<u16>,
) -> Result<TerminalSnapshotResponse, String> {
    registry.create(cwd, project_path_key, shell, title, cols, rows)
}

#[tauri::command(rename_all = "snake_case")]
pub fn terminal_snapshot(
    registry: State<'_, Arc<TerminalSessionRegistry>>,
    session_id: String,
    max_bytes: Option<usize>,
) -> Result<TerminalSnapshotResponse, String> {
    registry.snapshot(session_id, max_bytes)
}

#[tauri::command(rename_all = "snake_case")]
pub fn terminal_input(
    registry: State<'_, Arc<TerminalSessionRegistry>>,
    session_id: String,
    data: String,
) -> Result<TerminalSessionRecord, String> {
    registry.input(session_id, data)
}

#[tauri::command(rename_all = "snake_case")]
pub fn terminal_resize(
    registry: State<'_, Arc<TerminalSessionRegistry>>,
    session_id: String,
    cols: u16,
    rows: u16,
) -> Result<TerminalSessionRecord, String> {
    registry.resize(session_id, cols, rows)
}

#[tauri::command(rename_all = "snake_case")]
pub fn terminal_rename(
    registry: State<'_, Arc<TerminalSessionRegistry>>,
    session_id: String,
    title: String,
) -> Result<TerminalSessionRecord, String> {
    registry.rename(session_id, title)
}

#[tauri::command(rename_all = "snake_case")]
pub fn terminal_close(
    registry: State<'_, Arc<TerminalSessionRegistry>>,
    session_id: String,
) -> Result<TerminalSessionRecord, String> {
    registry.close(session_id)
}

#[tauri::command(rename_all = "snake_case")]
pub fn terminal_close_project(
    registry: State<'_, Arc<TerminalSessionRegistry>>,
    project_path_key: String,
) -> Result<TerminalListResponse, String> {
    registry.close_project(project_path_key)
}

#[tauri::command(rename_all = "snake_case")]
pub fn terminal_read_tail(
    registry: State<'_, Arc<TerminalSessionRegistry>>,
    project_path_key: String,
    session_id: Option<String>,
    max_bytes: Option<usize>,
) -> Result<TerminalReadTailResponse, String> {
    registry.read_tail(project_path_key, session_id, max_bytes)
}
