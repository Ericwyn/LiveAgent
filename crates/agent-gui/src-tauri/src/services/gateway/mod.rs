//! 网关控制器模块（拆分自原单文件 gateway.rs，代码逐字迁移，行为不变）。
//!
//! - [`types`]：对外事件 / DTO 类型与事件名常量
//! - [`controller`]：`GatewayController` 生命周期与公开 API（new/start/apply_config/publish_*）
//! - [`connection`]：gRPC 连接主循环、出站通道与端点构建
//! - [`envelope_handler`]：网关入站信封（`GatewayEnvelope`）分发
//! - [`terminal`]：终端请求处理、终端流与 proto 转换
//! - [`sftp`]：SFTP 请求处理与 proto 转换
//! - [`chat`]：聊天命令、聊天队列与聊天事件信封构建
//! - [`chat_inbox`]：远程聊天收件箱、租约管理与 chat run ledger 记账
//! - [`settings_sync`]：设置同步快照合并与信封构建
//! - [`history_sync`]：会话历史同步事件与信封构建
//! - [`util`]：时间戳与 JSON 字段工具

use std::collections::HashMap;
use std::sync::{Arc, Mutex, Once};
use std::time::Duration;

use serde_json::Value;
use tokio::sync::{mpsc, oneshot, watch};

use crate::commands::settings::RemoteSettingsPayload;
use crate::runtime::managed_process::ManagedProcessRegistry;
use crate::runtime::sftp::SftpSessionRegistry;
use crate::runtime::terminal::TerminalSessionRegistry;
use crate::services::chat_run_ledger::ChatRunLedger;
use crate::services::automation::AutomationStore;
use crate::services::memory::MemoryStore;
use crate::services::tunnel::{TunnelProxy, TunnelStore};
use crate::services::workspace_watch::WorkspaceWatchService;

pub mod proto {
    tonic::include_proto!("liveagent.gateway.v1");
}

mod chat;
mod chat_inbox;
mod connection;
mod controller;
mod envelope_handler;
mod history_sync;
mod managed_process;
mod settings_sync;
mod sftp;
mod terminal;
#[cfg(test)]
mod tests;
mod types;
mod util;

pub(crate) use chat::*;
pub(crate) use chat_inbox::*;
pub(crate) use connection::*;
pub(crate) use history_sync::*;
pub use history_sync::{build_history_sync_delete, build_history_sync_upsert};
pub(crate) use settings_sync::*;
pub(crate) use sftp::*;
pub(crate) use terminal::*;
pub use types::*;
pub(crate) use util::*;

pub(crate) const UI_ONLY_SETTINGS_SYNC_FIELDS: &[&str] = &[
    "skills",
    "chatRuntimeControls",
    "customSettings",
    "selectedModel",
    "theme",
    "locale",
];
pub(crate) const GATEWAY_GRPC_MAX_MESSAGE_BYTES: usize = 64 * 1024 * 1024;
pub(crate) const GATEWAY_RECONNECT_DELAY: Duration = Duration::from_secs(5);
pub(crate) const GATEWAY_TERMINAL_STREAM_RECONNECT_MIN: Duration = Duration::from_millis(250);
pub(crate) const GATEWAY_TERMINAL_STREAM_RECONNECT_MAX: Duration = Duration::from_secs(5);
pub(crate) const GATEWAY_TERMINAL_STREAM_STABLE_AFTER: Duration = Duration::from_secs(30);
pub(crate) const GATEWAY_TERMINAL_STREAM_KEEPALIVE_INTERVAL: Duration = Duration::from_secs(5);
pub(crate) const GATEWAY_CHAT_LEASE_MS: u64 = 15_000;
pub(crate) const GATEWAY_CHAT_RUNNING_LEASE_MS: u64 = 30 * 60_000;
pub(crate) const GATEWAY_CHAT_LEASE_SWEEP_INTERVAL: Duration = Duration::from_secs(5);

pub struct GatewayController {
    app_handle: tauri::AppHandle,
    automation_store: Arc<AutomationStore>,
    memory_store: Arc<MemoryStore>,
    terminal_registry: Arc<TerminalSessionRegistry>,
    sftp_registry: Arc<SftpSessionRegistry>,
    managed_process_registry: Arc<ManagedProcessRegistry>,
    config_tx: watch::Sender<RemoteSettingsPayload>,
    runner_task: Mutex<Option<tauri::async_runtime::JoinHandle<()>>>,
    status: Mutex<GatewayStatusSnapshot>,
    outbound_tx: Mutex<Option<mpsc::Sender<proto::AgentEnvelope>>>,
    terminal_stream_tx: Mutex<Option<mpsc::Sender<proto::TerminalStreamFrame>>>,
    settings_snapshot: Mutex<Option<Value>>,
    remote_chat_inbox: Mutex<HashMap<String, RemoteChatInboxRecord>>,
    chat_run_ledger: Mutex<ChatRunLedger>,
    pub(crate) tunnel_store: TunnelStore,
    pub(crate) tunnel_proxy: TunnelProxy,
    pub(crate) workspace_watch: Arc<WorkspaceWatchService>,
    pending_chat_queue_requests: Mutex<HashMap<String, oneshot::Sender<proto::ChatQueueResponse>>>,
    terminal_forwarder_once: Once,
    terminal_stream_forwarder_once: Once,
    sftp_forwarder_once: Once,
    remote_chat_inbox_sweeper_once: Once,
    pub(crate) tunnel_store_once: Once,
}
