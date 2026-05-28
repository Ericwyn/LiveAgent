use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, VecDeque};
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::thread;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter};

use crate::runtime::platform::expand_tilde_path;

const DEFAULT_ROWS: u16 = 24;
const DEFAULT_COLS: u16 = 80;
const MAX_RING_CHUNKS: usize = 4096;
const MAX_TAIL_BYTES: usize = 256 * 1024;
pub const TERMINAL_EVENT_NAME: &str = "terminal:event";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalSessionRecord {
    pub id: String,
    pub project_path_key: String,
    pub cwd: String,
    pub shell: String,
    pub title: String,
    pub pid: Option<u32>,
    pub cols: u16,
    pub rows: u16,
    pub created_at: u128,
    pub updated_at: u128,
    pub finished_at: Option<u128>,
    pub exit_code: Option<i32>,
    pub running: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalListResponse {
    pub sessions: Vec<TerminalSessionRecord>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalSnapshotResponse {
    pub session: TerminalSessionRecord,
    pub output: String,
    pub truncated: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalShellOption {
    pub id: String,
    pub label: String,
    pub command: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalShellOptionsResponse {
    pub options: Vec<TerminalShellOption>,
    pub default_shell: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalEventPayload {
    pub kind: String,
    pub session_id: String,
    pub project_path_key: String,
    pub session: TerminalSessionRecord,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<String>,
}

#[derive(Debug, Clone)]
pub struct TerminalEvent {
    pub payload: TerminalEventPayload,
}

#[derive(Debug, Clone, Copy)]
struct TerminalSize {
    cols: u16,
    rows: u16,
}

struct TerminalSessionEntry {
    master: Mutex<Box<dyn MasterPty + Send>>,
    writer: Mutex<Box<dyn Write + Send>>,
    child: Mutex<Box<dyn Child + Send + Sync>>,
    record: Mutex<TerminalSessionRecord>,
    output: Mutex<VecDeque<String>>,
}

#[derive(Default)]
pub struct TerminalSessionRegistry {
    sessions: Mutex<HashMap<String, Arc<TerminalSessionEntry>>>,
    app_handle: Mutex<Option<AppHandle>>,
    subscribers: Arc<Mutex<HashMap<usize, mpsc::Sender<TerminalEvent>>>>,
    next_subscriber_id: AtomicUsize,
}

impl Drop for TerminalSessionRegistry {
    fn drop(&mut self) {
        if let Ok(sessions) = self.sessions.get_mut() {
            for entry in sessions.values() {
                terminate_terminal_entry(entry);
            }
            sessions.clear();
        }
    }
}

impl TerminalSessionRegistry {
    pub fn attach_app_handle(&self, app_handle: AppHandle) {
        if let Ok(mut slot) = self.app_handle.lock() {
            *slot = Some(app_handle);
        }
    }

    pub fn subscribe(&self) -> (mpsc::Receiver<TerminalEvent>, TerminalSubscriberGuard) {
        let (tx, rx) = mpsc::channel();
        let id = self.next_subscriber_id.fetch_add(1, Ordering::SeqCst);
        if let Ok(mut subscribers) = self.subscribers.lock() {
            subscribers.insert(id, tx);
        }
        (
            rx,
            TerminalSubscriberGuard {
                id,
                subscribers: Arc::clone(&self.subscribers),
            },
        )
    }

    pub fn list(&self, project_path_key: Option<String>) -> TerminalListResponse {
        let project_key = project_path_key
            .map(|value| workspace_project_path_key(&value))
            .filter(|value| !value.is_empty());
        let mut sessions = self
            .sessions
            .lock()
            .expect("terminal session registry poisoned")
            .values()
            .filter_map(|entry| entry.record.lock().ok().map(|record| record.clone()))
            .filter(|record| {
                project_key
                    .as_ref()
                    .is_none_or(|wanted| &record.project_path_key == wanted)
            })
            .collect::<Vec<_>>();
        sessions.sort_by(|a, b| {
            a.project_path_key
                .cmp(&b.project_path_key)
                .then(a.created_at.cmp(&b.created_at))
        });
        TerminalListResponse { sessions }
    }

    pub fn create(
        self: &Arc<Self>,
        cwd: String,
        project_path_key: Option<String>,
        shell: Option<String>,
        title: Option<String>,
        cols: Option<u16>,
        rows: Option<u16>,
    ) -> Result<TerminalSnapshotResponse, String> {
        let cwd = canonicalize_workdir(&cwd)?;
        let project_key = project_path_key
            .map(|value| workspace_project_path_key(&value))
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| workspace_project_path_key(&cwd.display().to_string()));
        if project_key.is_empty() {
            return Err("project_path_key is required".to_string());
        }

        let shell_spec = resolve_shell(shell)?;
        let size = TerminalSize {
            cols: cols.unwrap_or(DEFAULT_COLS).clamp(20, 400),
            rows: rows.unwrap_or(DEFAULT_ROWS).clamp(6, 200),
        };
        let pty_system = native_pty_system();
        let pair = pty_system
            .openpty(PtySize {
                rows: size.rows,
                cols: size.cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|err| format!("failed to open terminal pty: {err}"))?;

        let mut cmd = CommandBuilder::new(&shell_spec.command);
        for arg in &shell_spec.args {
            cmd.arg(arg);
        }
        cmd.cwd(&cwd);
        cmd.env("TERM", "xterm-256color");
        cmd.env("COLORTERM", "truecolor");

        let child = pair
            .slave
            .spawn_command(cmd)
            .map_err(|err| format!("failed to spawn terminal shell: {err}"))?;
        let pid = child.process_id();
        let mut reader = pair
            .master
            .try_clone_reader()
            .map_err(|err| format!("failed to open terminal reader: {err}"))?;
        let writer = pair
            .master
            .take_writer()
            .map_err(|err| format!("failed to open terminal writer: {err}"))?;

        let id = uuid::Uuid::new_v4().to_string();
        let title = title
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| self.next_terminal_title(&project_key));
        let now = now_ms();
        let record = TerminalSessionRecord {
            id: id.clone(),
            project_path_key: project_key,
            cwd: cwd.display().to_string(),
            shell: shell_spec.label,
            title,
            pid,
            cols: size.cols,
            rows: size.rows,
            created_at: now,
            updated_at: now,
            finished_at: None,
            exit_code: None,
            running: true,
        };

        let entry = Arc::new(TerminalSessionEntry {
            master: Mutex::new(pair.master),
            writer: Mutex::new(writer),
            child: Mutex::new(child),
            record: Mutex::new(record),
            output: Mutex::new(VecDeque::new()),
        });
        self.sessions
            .lock()
            .expect("terminal session registry poisoned")
            .insert(id.clone(), Arc::clone(&entry));
        self.broadcast("created", &entry, None);

        let registry = Arc::clone(self);
        let reader_session_id = id.clone();
        thread::spawn(move || {
            let mut buffer = [0u8; 8192];
            loop {
                match reader.read(&mut buffer) {
                    Ok(0) => break,
                    Ok(n) => {
                        let data = String::from_utf8_lossy(&buffer[..n]).to_string();
                        registry.append_output(&reader_session_id, data);
                    }
                    Err(_) => break,
                }
            }
            registry.mark_finished(&reader_session_id);
        });

        self.snapshot(id, Some(MAX_TAIL_BYTES))
    }

    pub fn snapshot(
        &self,
        session_id: String,
        max_bytes: Option<usize>,
    ) -> Result<TerminalSnapshotResponse, String> {
        let entry = self.entry(&session_id)?;
        let session = entry
            .record
            .lock()
            .map_err(|_| "terminal session lock poisoned".to_string())?
            .clone();
        let (output, truncated) = read_output_tail(&entry, max_bytes.unwrap_or(MAX_TAIL_BYTES));
        Ok(TerminalSnapshotResponse {
            session,
            output,
            truncated,
        })
    }

    pub fn session_record(&self, session_id: String) -> Result<TerminalSessionRecord, String> {
        self.record(session_id)
    }

    pub fn input(&self, session_id: String, data: String) -> Result<TerminalSessionRecord, String> {
        if data.is_empty() {
            return self.record(session_id);
        }
        let entry = self.entry(&session_id)?;
        let running = entry
            .record
            .lock()
            .map_err(|_| "terminal session lock poisoned".to_string())?
            .running;
        if !running {
            return Err("terminal session is not running".to_string());
        }
        entry
            .writer
            .lock()
            .map_err(|_| "terminal writer lock poisoned".to_string())?
            .write_all(data.as_bytes())
            .map_err(|err| format!("failed to write terminal input: {err}"))?;
        self.touch(&entry);
        self.record(session_id)
    }

    pub fn resize(
        &self,
        session_id: String,
        cols: u16,
        rows: u16,
    ) -> Result<TerminalSessionRecord, String> {
        let entry = self.entry(&session_id)?;
        let cols = cols.clamp(20, 400);
        let rows = rows.clamp(6, 200);
        entry
            .master
            .lock()
            .map_err(|_| "terminal master lock poisoned".to_string())?
            .resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|err| format!("failed to resize terminal: {err}"))?;
        {
            let mut record = entry
                .record
                .lock()
                .map_err(|_| "terminal session lock poisoned".to_string())?;
            record.cols = cols;
            record.rows = rows;
            record.updated_at = now_ms();
        }
        self.broadcast("resized", &entry, None);
        self.record(session_id)
    }

    pub fn rename(
        &self,
        session_id: String,
        title: String,
    ) -> Result<TerminalSessionRecord, String> {
        let entry = self.entry(&session_id)?;
        let next_title = title.trim();
        if next_title.is_empty() {
            return Err("terminal title cannot be empty".to_string());
        }
        {
            let mut record = entry
                .record
                .lock()
                .map_err(|_| "terminal session lock poisoned".to_string())?;
            record.title = next_title.to_string();
            record.updated_at = now_ms();
        }
        self.broadcast("renamed", &entry, None);
        self.record(session_id)
    }

    pub fn close(&self, session_id: String) -> Result<TerminalSessionRecord, String> {
        let entry = self.entry(&session_id)?;
        terminate_terminal_entry(&entry);
        self.mark_finished(&session_id);
        self.sessions
            .lock()
            .expect("terminal session registry poisoned")
            .remove(session_id.trim());
        let session = entry
            .record
            .lock()
            .map_err(|_| "terminal session lock poisoned".to_string())?
            .clone();
        self.broadcast("closed", &entry, None);
        Ok(session)
    }

    pub fn close_all(&self) -> Result<TerminalListResponse, String> {
        let ids = self
            .sessions
            .lock()
            .expect("terminal session registry poisoned")
            .keys()
            .cloned()
            .collect::<Vec<_>>();
        self.close_ids(ids)
    }

    pub fn close_project(&self, project_path_key: String) -> Result<TerminalListResponse, String> {
        let project_key = workspace_project_path_key(&project_path_key);
        if project_key.is_empty() {
            return Err("project_path_key is required".to_string());
        }
        let ids = self
            .sessions
            .lock()
            .expect("terminal session registry poisoned")
            .iter()
            .filter_map(|(id, entry)| {
                entry
                    .record
                    .lock()
                    .ok()
                    .filter(|record| record.project_path_key == project_key)
                    .map(|_| id.clone())
            })
            .collect::<Vec<_>>();
        self.close_ids(ids)
    }

    pub fn running_session_count(&self) -> usize {
        self.sessions
            .lock()
            .ok()
            .map(|sessions| {
                sessions
                    .values()
                    .filter_map(|entry| entry.record.lock().ok())
                    .filter(|record| record.running)
                    .count()
            })
            .unwrap_or(0)
    }

    pub fn read_tail(
        &self,
        project_path_key: String,
        session_id: Option<String>,
        max_bytes: Option<usize>,
    ) -> Result<TerminalReadTailResponse, String> {
        let project_key = workspace_project_path_key(&project_path_key);
        if project_key.is_empty() {
            return Err("project_path_key is required".to_string());
        }
        let sessions = self.list(Some(project_key.clone())).sessions;
        if sessions.is_empty() {
            return Ok(TerminalReadTailResponse {
                sessions: Vec::new(),
                selected_session: None,
                output: String::new(),
                truncated: false,
            });
        }
        let requested_session_id = session_id
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string);
        if requested_session_id.is_none() && sessions.len() > 1 {
            return Ok(TerminalReadTailResponse {
                sessions,
                selected_session: None,
                output: String::new(),
                truncated: false,
            });
        }
        let selected_id = requested_session_id.unwrap_or_else(|| sessions[0].id.clone());
        let snapshot = self.snapshot(selected_id, max_bytes)?;
        if snapshot.session.project_path_key != project_key {
            return Err("terminal session is outside the current project".to_string());
        }
        Ok(TerminalReadTailResponse {
            sessions,
            selected_session: Some(snapshot.session),
            output: snapshot.output,
            truncated: snapshot.truncated,
        })
    }

    fn close_ids(&self, ids: Vec<String>) -> Result<TerminalListResponse, String> {
        let mut sessions = Vec::new();
        for id in ids {
            sessions.push(self.close(id)?);
        }
        Ok(TerminalListResponse { sessions })
    }

    fn next_terminal_title(&self, project_path_key: &str) -> String {
        let count = self
            .sessions
            .lock()
            .ok()
            .map(|sessions| {
                sessions
                    .values()
                    .filter_map(|entry| entry.record.lock().ok())
                    .filter(|record| record.project_path_key == project_path_key)
                    .count()
            })
            .unwrap_or(0);
        format!("Terminal {}", count + 1)
    }

    fn entry(&self, session_id: &str) -> Result<Arc<TerminalSessionEntry>, String> {
        let id = session_id.trim();
        if id.is_empty() {
            return Err("terminal_id is required".to_string());
        }
        self.sessions
            .lock()
            .expect("terminal session registry poisoned")
            .get(id)
            .cloned()
            .ok_or_else(|| format!("terminal session not found: {id}"))
    }

    fn record(&self, session_id: String) -> Result<TerminalSessionRecord, String> {
        let entry = self.entry(&session_id)?;
        entry
            .record
            .lock()
            .map(|record| record.clone())
            .map_err(|_| "terminal session lock poisoned".to_string())
    }

    fn touch(&self, entry: &Arc<TerminalSessionEntry>) {
        if let Ok(mut record) = entry.record.lock() {
            record.updated_at = now_ms();
        }
    }

    fn append_output(&self, session_id: &str, data: String) {
        let Ok(entry) = self.entry(session_id) else {
            return;
        };
        {
            let mut output = match entry.output.lock() {
                Ok(output) => output,
                Err(_) => return,
            };
            output.push_back(data.clone());
            while output.len() > MAX_RING_CHUNKS {
                output.pop_front();
            }
        }
        self.touch(&entry);
        self.broadcast("output", &entry, Some(data));
    }

    fn mark_finished(&self, session_id: &str) {
        let Ok(entry) = self.entry(session_id) else {
            return;
        };
        let mut exit_code = None;
        if let Ok(mut child) = entry.child.lock() {
            if let Ok(status) = child.try_wait() {
                exit_code = status.map(|status| status.exit_code() as i32);
            }
        }
        {
            let mut record = match entry.record.lock() {
                Ok(record) => record,
                Err(_) => return,
            };
            if record.running {
                record.running = false;
                record.finished_at = Some(now_ms());
                record.exit_code = exit_code;
                record.updated_at = now_ms();
            }
        }
        self.broadcast("exit", &entry, None);
    }

    fn broadcast(&self, kind: &str, entry: &Arc<TerminalSessionEntry>, data: Option<String>) {
        let Ok(record) = entry.record.lock().map(|record| record.clone()) else {
            return;
        };
        let payload = TerminalEventPayload {
            kind: kind.to_string(),
            session_id: record.id.clone(),
            project_path_key: record.project_path_key.clone(),
            session: record,
            data,
        };

        if let Ok(app_handle) = self.app_handle.lock() {
            if let Some(app_handle) = app_handle.as_ref() {
                let _ = app_handle.emit(TERMINAL_EVENT_NAME, &payload);
            }
        }

        let subscribers = self
            .subscribers
            .lock()
            .map(|subscribers| subscribers.values().cloned().collect::<Vec<_>>())
            .unwrap_or_default();
        let event = TerminalEvent { payload };
        for subscriber in subscribers {
            let _ = subscriber.send(event.clone());
        }
    }
}

pub struct TerminalSubscriberGuard {
    id: usize,
    subscribers: Arc<Mutex<HashMap<usize, mpsc::Sender<TerminalEvent>>>>,
}

impl Drop for TerminalSubscriberGuard {
    fn drop(&mut self) {
        if let Ok(mut subscribers) = self.subscribers.lock() {
            subscribers.remove(&self.id);
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalReadTailResponse {
    pub sessions: Vec<TerminalSessionRecord>,
    pub selected_session: Option<TerminalSessionRecord>,
    pub output: String,
    pub truncated: bool,
}

fn read_output_tail(entry: &TerminalSessionEntry, max_bytes: usize) -> (String, bool) {
    let output = match entry.output.lock() {
        Ok(output) => output,
        Err(_) => return (String::new(), false),
    };
    read_output_chunks_tail(&output, max_bytes)
}

fn read_output_chunks_tail(output: &VecDeque<String>, max_bytes: usize) -> (String, bool) {
    if max_bytes == 0 {
        return (String::new(), !output.is_empty());
    }
    let mut remaining = max_bytes;
    let mut chunks = VecDeque::new();
    let mut truncated = false;
    for chunk in output.iter().rev() {
        if remaining == 0 {
            truncated = true;
            break;
        }
        let len = chunk.len();
        if len > remaining {
            let start = chunk
                .char_indices()
                .map(|(index, _)| index)
                .find(|index| len.saturating_sub(*index) <= remaining)
                .unwrap_or(len);
            chunks.push_front(chunk[start..].to_string());
            truncated = true;
            break;
        }
        remaining = remaining.saturating_sub(len);
        chunks.push_front(chunk.clone());
    }
    (chunks.into_iter().collect::<String>(), truncated)
}

fn terminate_terminal_entry(entry: &Arc<TerminalSessionEntry>) {
    let pid = entry.record.lock().ok().and_then(|record| record.pid);
    terminate_process_tree_best_effort(pid);
    if let Ok(mut child) = entry.child.lock() {
        let _ = child.kill();
    }
}

fn terminate_process_tree_best_effort(pid: Option<u32>) {
    let Some(pid) = pid else {
        return;
    };
    if pid == 0 {
        return;
    }

    #[cfg(windows)]
    {
        let _ = std::process::Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status();
    }

    #[cfg(unix)]
    {
        let _ = std::process::Command::new("kill")
            .args(["-TERM", &format!("-{pid}")])
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status();
    }
}

fn now_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}

fn workspace_project_path_key(path: &str) -> String {
    path.trim().to_string()
}

fn canonicalize_workdir(workdir: &str) -> Result<PathBuf, String> {
    let raw = workdir.trim();
    if raw.is_empty() {
        return Err("workdir is required".to_string());
    }
    let path = expand_tilde_path(raw);
    if !path.is_absolute() {
        return Err(format!("workdir must be absolute: {workdir}"));
    }
    let metadata = fs::metadata(&path).map_err(|_| format!("workdir does not exist: {workdir}"))?;
    if !metadata.is_dir() {
        return Err(format!("workdir must be a directory: {workdir}"));
    }
    fs::canonicalize(&path).map_err(|err| format!("failed to canonicalize workdir: {err}"))
}

struct ShellSpec {
    label: String,
    command: String,
    args: Vec<String>,
}

fn resolve_shell(shell: Option<String>) -> Result<ShellSpec, String> {
    let requested = shell
        .map(|value| value.trim().to_ascii_lowercase())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "default".to_string());

    if cfg!(windows) {
        match requested.as_str() {
            "powershell" | "pwsh" => Ok(ShellSpec {
                label: "PowerShell".to_string(),
                command: "powershell.exe".to_string(),
                args: vec![
                    "-NoLogo".to_string(),
                    "-ExecutionPolicy".to_string(),
                    "Bypass".to_string(),
                ],
            }),
            "cmd" | "default" => Ok(ShellSpec {
                label: "cmd".to_string(),
                command: "cmd.exe".to_string(),
                args: Vec::new(),
            }),
            other => Err(format!("unsupported Windows terminal shell: {other}")),
        }
    } else {
        let command = std::env::var("SHELL")
            .ok()
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty() && Path::new(value).is_absolute())
            .or_else(resolve_unix_shell_fallback)
            .ok_or_else(|| "failed to resolve login shell".to_string())?;
        let label = Path::new(&command)
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("shell")
            .to_string();
        Ok(ShellSpec {
            label,
            command,
            args: Vec::new(),
        })
    }
}

fn resolve_unix_shell_fallback() -> Option<String> {
    let candidates: &[&str] = if cfg!(target_os = "macos") {
        &["/bin/zsh", "/bin/bash", "/bin/sh"]
    } else {
        &["/bin/bash", "/bin/zsh", "/bin/sh"]
    };
    candidates
        .iter()
        .find(|candidate| Path::new(candidate).exists())
        .map(|value| (*value).to_string())
}

pub fn terminal_shell_options() -> TerminalShellOptionsResponse {
    if cfg!(windows) {
        TerminalShellOptionsResponse {
            default_shell: "cmd".to_string(),
            options: vec![
                TerminalShellOption {
                    id: "cmd".to_string(),
                    label: "cmd".to_string(),
                    command: "cmd.exe".to_string(),
                },
                TerminalShellOption {
                    id: "powershell".to_string(),
                    label: "PowerShell".to_string(),
                    command: "powershell.exe".to_string(),
                },
            ],
        }
    } else {
        let shell = resolve_shell(None).unwrap_or_else(|_| ShellSpec {
            label: "sh".to_string(),
            command: "/bin/sh".to_string(),
            args: Vec::new(),
        });
        TerminalShellOptionsResponse {
            default_shell: "default".to_string(),
            options: vec![TerminalShellOption {
                id: "default".to_string(),
                label: shell.label,
                command: shell.command,
            }],
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shell_options_include_default() {
        let options = terminal_shell_options();
        assert!(!options.default_shell.trim().is_empty());
        assert!(!options.options.is_empty());
    }

    #[test]
    fn output_tail_respects_byte_limit_inside_large_chunk() {
        let mut output = VecDeque::new();
        output.push_back("prefix".to_string());
        output.push_back("abcdefghijklmnopqrstuvwxyz".to_string());

        let (tail, truncated) = read_output_chunks_tail(&output, 8);

        assert_eq!(tail, "stuvwxyz");
        assert!(truncated);
    }

    #[test]
    fn registry_creates_lists_renames_and_closes_session() {
        let registry = Arc::new(TerminalSessionRegistry::default());
        let tempdir = tempfile::tempdir().expect("tempdir");
        let cwd = tempdir.path().display().to_string();

        let created = registry
            .create(
                cwd.clone(),
                Some(cwd.clone()),
                None,
                Some("Test Terminal".to_string()),
                Some(80),
                Some(24),
            )
            .expect("create terminal session");
        assert!(created.session.running);
        assert_eq!(created.session.title, "Test Terminal");

        let listed = registry.list(Some(cwd.clone())).sessions;
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].id, created.session.id);

        let resized = registry
            .resize(created.session.id.clone(), 100, 30)
            .expect("resize terminal session");
        assert_eq!(resized.cols, 100);
        assert_eq!(resized.rows, 30);

        let renamed = registry
            .rename(created.session.id.clone(), "Renamed Terminal".to_string())
            .expect("rename terminal session");
        assert_eq!(renamed.title, "Renamed Terminal");

        let closed = registry
            .close(created.session.id.clone())
            .expect("close terminal session");
        assert!(!closed.running);
        assert!(registry.list(Some(cwd)).sessions.is_empty());
    }

    #[test]
    fn registry_closes_project_sessions() {
        let registry = Arc::new(TerminalSessionRegistry::default());
        let project_a = tempfile::tempdir().expect("project a");
        let project_b = tempfile::tempdir().expect("project b");
        let cwd_a = project_a.path().display().to_string();
        let cwd_b = project_b.path().display().to_string();

        registry
            .create(
                cwd_a.clone(),
                Some(cwd_a.clone()),
                None,
                Some("A".to_string()),
                Some(80),
                Some(24),
            )
            .expect("create project a terminal");
        registry
            .create(
                cwd_b.clone(),
                Some(cwd_b.clone()),
                None,
                Some("B".to_string()),
                Some(80),
                Some(24),
            )
            .expect("create project b terminal");
        assert_eq!(registry.running_session_count(), 2);

        let closed = registry
            .close_project(cwd_a.clone())
            .expect("close project a terminals");
        assert_eq!(closed.sessions.len(), 1);
        assert!(registry.list(Some(cwd_a)).sessions.is_empty());
        assert_eq!(registry.list(Some(cwd_b)).sessions.len(), 1);

        registry.close_all().expect("close remaining terminals");
        assert_eq!(registry.running_session_count(), 0);
    }

    #[test]
    fn read_tail_requires_terminal_id_when_project_has_multiple_sessions() {
        let registry = Arc::new(TerminalSessionRegistry::default());
        let tempdir = tempfile::tempdir().expect("tempdir");
        let cwd = tempdir.path().display().to_string();

        let first = registry
            .create(
                cwd.clone(),
                Some(cwd.clone()),
                None,
                Some("First".to_string()),
                Some(80),
                Some(24),
            )
            .expect("create first terminal session");
        registry
            .create(
                cwd.clone(),
                Some(cwd.clone()),
                None,
                Some("Second".to_string()),
                Some(80),
                Some(24),
            )
            .expect("create second terminal session");

        let ambiguous = registry
            .read_tail(cwd.clone(), None, Some(1024))
            .expect("read ambiguous terminal tail");
        assert_eq!(ambiguous.sessions.len(), 2);
        assert!(ambiguous.selected_session.is_none());
        assert!(ambiguous.output.is_empty());

        let selected = registry
            .read_tail(cwd, Some(first.session.id), Some(1024))
            .expect("read selected terminal tail");
        assert!(selected.selected_session.is_some());
        assert_eq!(selected.sessions.len(), 2);

        registry.close_all().expect("close terminal sessions");
    }
}
