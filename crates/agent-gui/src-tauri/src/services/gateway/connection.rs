use std::future::Future;
use std::sync::{Arc, Once};
use std::time::{Duration, Instant};

use futures_util::SinkExt as _;
use reqwest::Url;
use serde_json::Value;
use tauri::Emitter;
use tokio::sync::{mpsc, watch};
use tokio_stream::wrappers::ReceiverStream;
use tokio_stream::StreamExt as _;
use tokio_tungstenite::tungstenite::Message as WsMessage;
use tonic::metadata::MetadataValue;
use tonic::transport::{ClientTlsConfig, Endpoint};

use crate::commands::settings::RemoteSettingsPayload;
use crate::runtime::terminal::TerminalEventPayload;
use crate::services::gateway_bridge;

use super::gateway_proto::v2;
use super::*;

/// v2 链路一次连接尝试的失败分类（模块内部）。
enum WsServeError {
    /// 握手层失败（旧网关无 /ws/v2/agent）：允许同一次尝试内回退 gRPC。
    Handshake(String),
    /// 鉴权拒绝或链路已建立后出错：不回退，按普通连接错误上抛；下次重连仍先试 v2。
    Fatal(String),
}

struct AbortTaskOnDrop(tauri::async_runtime::JoinHandle<()>);

impl Drop for AbortTaskOnDrop {
    fn drop(&mut self) {
        self.0.abort();
    }
}

impl GatewayController {
    pub(crate) async fn run(
        self: Arc<Self>,
        mut config_rx: watch::Receiver<RemoteSettingsPayload>,
    ) {
        let mut reconnect_delay = GATEWAY_RECONNECT_MIN;
        loop {
            let config = config_rx.borrow().clone();
            if !config.enabled || !is_remote_configured(&config) {
                reconnect_delay = GATEWAY_RECONNECT_MIN;
                self.set_outbound_sender(None);
                self.set_outbound_control_sender(None);
                self.set_terminal_stream_sender(None);
                self.publish_disconnected_status(&config, None);
                if config_rx.changed().await.is_err() {
                    break;
                }
                continue;
            }

            let current_config = config.clone();
            let attempt_started = Instant::now();
            let connect_result = self
                .connect_and_serve(current_config.clone(), &mut config_rx)
                .await;
            let latest_config = config_rx.borrow().clone();
            let reconfigured = latest_config != current_config;

            self.set_outbound_sender(None);
            self.set_outbound_control_sender(None);
            self.set_terminal_stream_sender(None);
            if reconfigured {
                reconnect_delay = GATEWAY_RECONNECT_MIN;
                self.publish_disconnected_status(&latest_config, None);
                continue;
            }

            self.publish_disconnected_status(
                &current_config,
                connect_result.as_ref().err().cloned(),
            );

            if config_rx.has_changed().unwrap_or(false) {
                continue;
            }

            if !current_config.auto_reconnect {
                reconnect_delay = GATEWAY_RECONNECT_MIN;
                if config_rx.changed().await.is_err() {
                    break;
                }
                continue;
            }

            let (delay, next_delay) =
                gateway_reconnect_backoff(reconnect_delay, attempt_started.elapsed());
            reconnect_delay = next_delay;

            tokio::select! {
                changed = config_rx.changed() => {
                    if changed.is_err() {
                        break;
                    }
                }
                _ = tokio::time::sleep(delay) => {}
            }
        }
    }

    /// 连接尝试入口：先试 v2；握手层失败（旧网关无 /ws/v2/agent，典型 404/非 101）时同一次尝试内
    /// 回退 v1 gRPC，鉴权被拒不回退直接上抛；每次重连都重新从 v2 试起。
    /// 回退会话最多持续 [`GATEWAY_WS_UPGRADE_RETRY_INTERVAL`] 便主动断开重试 v2——防瞬时抖动
    /// 导致长驻 v1、污染"v1 流量归零"信号（重连亚秒级且会话层幂等对账，中断代价可忽略）。
    pub(crate) async fn connect_and_serve(
        self: &Arc<Self>,
        config: RemoteSettingsPayload,
        config_rx: &mut watch::Receiver<RemoteSettingsPayload>,
    ) -> Result<(), String> {
        match self.connect_and_serve_ws(config.clone(), config_rx).await {
            Ok(()) => Ok(()),
            Err(WsServeError::Fatal(error)) => Err(error),
            Err(WsServeError::Handshake(error)) => {
                eprintln!("gateway v2 handshake failed: {error}; falling back to v1 gRPC");
                #[allow(deprecated)]
                {
                    tokio::select! {
                        result = self.connect_and_serve_grpc(config, config_rx) => result,
                        _ = tokio::time::sleep(GATEWAY_WS_UPGRADE_RETRY_INTERVAL) => {
                            eprintln!(
                                "gateway v1 fallback session reached upgrade-retry window; \
                                 reconnecting to retry v2"
                            );
                            Ok(())
                        }
                    }
                }
            }
        }
    }

    /// v2 主链路：hello 握手（等价 Authenticate）后按 gRPC AgentConnect 完全相同的语义收发信封
    /// （双通道合并、状态迁移、对账、分发），外加取代 h2 keepalive 的存活看门狗。
    async fn connect_and_serve_ws(
        self: &Arc<Self>,
        config: RemoteSettingsPayload,
        config_rx: &mut watch::Receiver<RemoteSettingsPayload>,
    ) -> Result<(), WsServeError> {
        let ws_url = build_ws_url(&config.gateway_url, config.grpc_port, GATEWAY_WS_AGENT_PATH)
            .map_err(WsServeError::Handshake)?;
        let hello = build_client_hello(
            &config.token,
            effective_agent_id(&config),
            crate::app_version().to_string(),
        );

        let connect_result =
            await_abortable_on_reconfigure(&config, config_rx, async move {
                Ok(connect_agent_ws(&ws_url, hello).await)
            })
            .await
            .map_err(WsServeError::Fatal)?;
        let (mut ws, server_hello) = match connect_result {
            None => return Ok(()),
            Some(Ok(established)) => established,
            Some(Err(WsHandshakeError::Handshake(error))) => {
                return Err(WsServeError::Handshake(error))
            }
            Some(Err(WsHandshakeError::AuthRejected(error))) => {
                return Err(WsServeError::Fatal(error))
            }
        };

        let (outbound_tx, outbound_rx) = mpsc::channel::<proto::AgentEnvelope>(4096);
        self.set_outbound_sender(Some(outbound_tx));
        // 控制小通道：Pong 不排在数据信封之后（与 gRPC 路径同策略，下方公平合并进出站流）。
        let (outbound_control_tx, outbound_control_rx) =
            mpsc::channel::<proto::AgentEnvelope>(GATEWAY_OUTBOUND_CONTROL_QUEUE_DEPTH);
        self.set_outbound_control_sender(Some(outbound_control_tx));
        let (terminal_stop_tx, terminal_stop_rx) = watch::channel(false);
        let terminal_task = self.spawn_terminal_stream_ws(config.clone(), terminal_stop_rx);

        let serve_result = async {
            let connected_at = now_unix_seconds();
            self.publish_status(|status| {
                status.online = true;
                status.enabled = true;
                status.configured = true;
                status.gateway_url = config.gateway_url.clone();
                status.agent_id = effective_agent_id(&config);
                status.session_id = Some(server_hello.session_id.clone());
                status.connected_since = Some(connected_at);
                status.last_heartbeat = Some(connected_at);
                status.last_error = None;
                status.protocol = Some("v2".to_string());
            });

            let _reconcile_task = AbortTaskOnDrop(self.spawn_post_connect_reconciliation());

            let mut outbound = ReceiverStream::new(outbound_control_rx)
                .merge(ReceiverStream::new(outbound_rx));

            // 存活看门狗（取代 h2 keepalive）：任何入站帧刷新计时；静默超 3×心跳周期发 WS Ping
            // 探活，宽限期内仍无入站则判链路已死走重连。服务端 Ping 的 Pong 由 tungstenite 自动回。
            let heartbeat_period = if server_hello.heartbeat_period_seconds > 0 {
                Duration::from_secs(u64::from(server_hello.heartbeat_period_seconds))
            } else {
                GATEWAY_WS_DEFAULT_HEARTBEAT_PERIOD
            };
            let idle_timeout = heartbeat_period * 3;
            let mut last_inbound = Instant::now();
            let mut probe_deadline: Option<Instant> = None;

            let receive_result = loop {
                let watchdog_deadline = probe_deadline.unwrap_or(last_inbound + idle_timeout);
                tokio::select! {
                    changed = config_rx.changed() => {
                        if changed.is_err() {
                            break Ok(());
                        }
                        let next = config_rx.borrow().clone();
                        if next != config {
                            break Ok(());
                        }
                    }
                    envelope = outbound.next() => {
                        match envelope {
                            None => break Err("gateway outbound channels closed".to_string()),
                            Some(envelope) => {
                                let frame = v2::AgentClientFrame {
                                    payload: Some(v2::agent_client_frame::Payload::Envelope(envelope)),
                                };
                                if let Err(error) = ws.send(encode_ws_frame(&frame)).await {
                                    break Err(format!("gateway ws send failed: {error}"));
                                }
                            }
                        }
                    }
                    message = ws.next() => {
                        match message {
                            None => break Err("gateway ws stream closed".to_string()),
                            Some(Err(error)) => break Err(format!("gateway ws receive failed: {error}")),
                            Some(Ok(message)) => {
                                last_inbound = Instant::now();
                                probe_deadline = None;
                                match message {
                                    WsMessage::Binary(data) => {
                                        let frame: v2::AgentServerFrame = match decode_ws_frame(&data) {
                                            Ok(frame) => frame,
                                            Err(error) => break Err(error),
                                        };
                                        // 重复 hello 或空帧：忽略（服务端同样宽容）。
                                        if let Some(v2::agent_server_frame::Payload::Envelope(envelope)) = frame.payload {
                                            self.touch_heartbeat();
                                            if let Err(error) = self.handle_gateway_envelope(envelope).await {
                                                break Err(error);
                                            }
                                        }
                                    }
                                    WsMessage::Close(frame) => {
                                        break Err(match frame {
                                            Some(frame) => format!(
                                                "gateway ws closed (code {}): {}",
                                                u16::from(frame.code),
                                                frame.reason
                                            ),
                                            None => "gateway ws closed".to_string(),
                                        });
                                    }
                                    // v2 链路不允许文本帧，视为协议错误。
                                    WsMessage::Text(_) => {
                                        break Err("gateway ws sent unexpected text frame".to_string());
                                    }
                                    // Ping/Pong 由 tungstenite 处理，此处仅刷新看门狗。
                                    _ => {}
                                }
                            }
                        }
                    }
                    _ = tokio::time::sleep_until(tokio::time::Instant::from_std(watchdog_deadline)) => {
                        if probe_deadline.is_some() {
                            break Err(format!(
                                "gateway ws link stale: no inbound frames for {}s",
                                idle_timeout.saturating_add(GATEWAY_WS_PROBE_GRACE).as_secs()
                            ));
                        }
                        if let Err(error) = ws.send(WsMessage::Ping(Vec::new().into())).await {
                            break Err(format!("gateway ws liveness ping failed: {error}"));
                        }
                        probe_deadline = Some(Instant::now() + GATEWAY_WS_PROBE_GRACE);
                    }
                }
            };
            receive_result
        }
        .await;

        let _ = terminal_stop_tx.send(true);
        terminal_task.abort();
        self.set_terminal_stream_sender(None);
        serve_result.map_err(WsServeError::Fatal)
    }

    /// v1 gRPC 主链路（Authenticate + AgentConnect），行为与迁移前逐字一致。
    #[deprecated(note = "v1 gRPC 链路仅作旧网关回退，v1 移除时一并删除")]
    #[allow(deprecated)] // 函数体即回退路径，成串调用同批弃用的 gRPC 辅助函数。
    pub(crate) async fn connect_and_serve_grpc(
        self: &Arc<Self>,
        config: RemoteSettingsPayload,
        config_rx: &mut watch::Receiver<RemoteSettingsPayload>,
    ) -> Result<(), String> {
        let grpc_url = build_grpc_url(&config)?;
        // The heartbeat interval setting drives the h2 keepalive cadence; the
        // lower bound stays above the gateway's keepalive enforcement MinTime.
        let keepalive_interval = Duration::from_secs(config.heartbeat_interval.clamp(10, 60));
        let endpoint = build_endpoint(&grpc_url, keepalive_interval)?;
        let channel = endpoint.connect_lazy();

        let mut client = proto::agent_gateway_client::AgentGatewayClient::new(channel)
            .max_decoding_message_size(GATEWAY_GRPC_MAX_MESSAGE_BYTES)
            .max_encoding_message_size(GATEWAY_GRPC_MAX_MESSAGE_BYTES);
        let mut auth_request = tonic::Request::new(proto::AuthRequest {
            token: config.token.clone(),
            agent_id: effective_agent_id(&config),
            agent_version: crate::app_version().to_string(),
        });
        insert_bearer_metadata(auth_request.metadata_mut(), &config.token)?;

        let auth_call = client.authenticate(auth_request);
        let auth_response = match await_abortable_on_reconfigure(&config, config_rx, async move {
            tokio::time::timeout(Duration::from_secs(10), auth_call)
                .await
                .map_err(|_| "gateway authenticate timed out".to_string())?
                .map_err(|e| format!("gateway authenticate failed: {e}"))
                .map(|response| response.into_inner())
        })
        .await?
        {
            Some(response) => response,
            None => return Ok(()),
        };
        if !auth_response.success {
            return Err(if auth_response.message.trim().is_empty() {
                "gateway authentication failed".to_string()
            } else {
                auth_response.message
            });
        }

        let terminal_client = client.clone();

        let (outbound_tx, outbound_rx) = mpsc::channel::<proto::AgentEnvelope>(4096);
        self.set_outbound_sender(Some(outbound_tx));
        // Control lane: Pong replies must not queue behind streamed data
        // envelopes, or wake probes time out precisely when a reply is
        // saturating the data queue. Merged fairly into the same stream below.
        let (outbound_control_tx, outbound_control_rx) =
            mpsc::channel::<proto::AgentEnvelope>(GATEWAY_OUTBOUND_CONTROL_QUEUE_DEPTH);
        self.set_outbound_control_sender(Some(outbound_control_tx));
        let (terminal_stop_tx, terminal_stop_rx) = watch::channel(false);
        let terminal_task =
            self.spawn_terminal_stream(terminal_client, config.clone(), terminal_stop_rx);

        let serve_result = async {
            let mut connect_request = tonic::Request::new(
                ReceiverStream::new(outbound_control_rx).merge(ReceiverStream::new(outbound_rx)),
            );
            insert_bearer_metadata(connect_request.metadata_mut(), &config.token)?;

            let connect_call = client.agent_connect(connect_request);
            let response = match await_abortable_on_reconfigure(&config, config_rx, async move {
                tokio::time::timeout(Duration::from_secs(10), connect_call)
                    .await
                    .map_err(|_| "open gateway stream timed out".to_string())?
                    .map_err(|e| format!("open gateway stream failed: {e}"))
            })
            .await?
            {
                Some(response) => response,
                None => return Ok(()),
            };
            let mut inbound = response.into_inner();

            let connected_at = now_unix_seconds();
            self.publish_status(|status| {
                status.online = true;
                status.enabled = true;
                status.configured = true;
                status.gateway_url = config.gateway_url.clone();
                status.agent_id = effective_agent_id(&config);
                status.session_id = Some(auth_response.session_id.clone());
                status.connected_since = Some(connected_at);
                status.last_heartbeat = Some(connected_at);
                status.last_error = None;
                status.protocol = Some("v1".to_string());
            });

            let _reconcile_task = AbortTaskOnDrop(self.spawn_post_connect_reconciliation());

            // Dead links are detected by the transport-level HTTP/2 keepalive
            // configured on the endpoint and surface as receive errors here.
            let receive_result = loop {
                tokio::select! {
                    changed = config_rx.changed() => {
                        if changed.is_err() {
                            break Ok(());
                        }
                        let next = config_rx.borrow().clone();
                        if next != config {
                            break Ok(());
                        }
                    }
                    message = inbound.message() => {
                        match message {
                            Err(err) => break Err(format!("gateway stream receive failed: {err}")),
                            Ok(None) => break Err("gateway stream closed".to_string()),
                            Ok(Some(envelope)) => {
                                self.touch_heartbeat();
                                if let Err(error) = self.handle_gateway_envelope(envelope).await {
                                    break Err(error);
                                }
                            }
                        }
                    }
                }
            };
            receive_result
        }
        .await;

        let _ = terminal_stop_tx.send(true);
        terminal_task.abort();
        self.set_terminal_stream_sender(None);
        serve_result
    }

    pub(crate) fn spawn_post_connect_reconciliation(
        self: &Arc<Self>,
    ) -> tauri::async_runtime::JoinHandle<()> {
        let controller = Arc::clone(self);
        tauri::async_runtime::spawn(async move {
            // Runtime readiness is control-plane state: restore it immediately
            // on the fresh stream before low-priority snapshots begin replaying.
            if let Some((worker_id, state, visible, active_run_count)) =
                controller.runtime_status_republish_snapshot()
            {
                if let Err(error) = controller
                    .send_chat_runtime_status_envelope(worker_id, state, visible, active_run_count)
                    .await
                {
                    eprintln!(
                        "republish gateway chat runtime status after connect failed: {error}"
                    );
                }
            }

            // Give Ping/chat control traffic a short uncontended window. The
            // snapshots below are reconciliation data and must never delay the
            // first command received after wake or reconnect.
            tokio::time::sleep(GATEWAY_POST_CONNECT_REPLAY_DELAY).await;

            if let Err(error) = controller.publish_current_settings_sync().await {
                eprintln!("publish gateway settings sync failed: {error}");
            }
            tokio::task::yield_now().await;
            if let Err(error) = controller.publish_current_terminal_sessions().await {
                eprintln!("publish gateway terminal sessions failed: {error}");
            }
            tokio::task::yield_now().await;
            if let Err(error) = controller.publish_desired_tunnels().await {
                eprintln!("publish gateway tunnel desired state failed: {error}");
            }
            tokio::task::yield_now().await;
            if let Err(error) = controller.publish_current_managed_processes().await {
                eprintln!("publish gateway managed processes failed: {error}");
            }
            tokio::task::yield_now().await;
            if let Err(error) = controller.republish_chat_run_states().await {
                eprintln!("republish gateway chat run states failed: {error}");
            }
            controller.spawn_tunnel_probes(None, false);
        })
    }

    pub(crate) async fn send_agent_envelope(
        &self,
        envelope: proto::AgentEnvelope,
    ) -> Result<(), String> {
        let sender = self.current_outbound_sender()?;
        send_agent_envelope_to(sender, envelope).await
    }

    pub(crate) fn current_outbound_sender(
        &self,
    ) -> Result<mpsc::Sender<proto::AgentEnvelope>, String> {
        self.outbound_tx
            .lock()
            .map_err(|_| "gateway outbound sender lock poisoned".to_string())?
            .clone()
            .ok_or_else(|| "gateway outbound stream is offline".to_string())
    }

    pub(crate) fn current_outbound_control_sender(
        &self,
    ) -> Result<mpsc::Sender<proto::AgentEnvelope>, String> {
        self.outbound_control_tx
            .lock()
            .map_err(|_| "gateway outbound control sender lock poisoned".to_string())?
            .clone()
            .ok_or_else(|| "gateway outbound control lane is offline".to_string())
    }

    pub(crate) fn current_terminal_stream_sender(
        &self,
    ) -> Result<mpsc::Sender<proto::TerminalStreamFrame>, String> {
        self.terminal_stream_tx
            .lock()
            .map_err(|_| "gateway terminal stream sender lock poisoned".to_string())?
            .clone()
            .ok_or_else(|| "gateway terminal stream is offline".to_string())
    }

    pub(crate) fn spawn_uploaded_image_preview_response(
        &self,
        request_id: String,
        request: proto::UploadedImagePreviewRequest,
    ) -> Result<(), String> {
        let sender = self.current_outbound_sender()?;
        tauri::async_runtime::spawn(async move {
            let envelope = match gateway_bridge::handle_uploaded_image_preview(request).await {
                Ok(response) => proto::AgentEnvelope {
                    request_id,
                    timestamp: now_unix_seconds(),
                    payload: Some(proto::agent_envelope::Payload::UploadedImagePreviewResp(
                        response,
                    )),
                },
                Err(error) => build_error_response_envelope(request_id, 500, error),
            };
            if let Err(error) = send_agent_envelope_to(sender, envelope).await {
                eprintln!("send gateway uploaded image preview response failed: {error}");
            }
        });
        Ok(())
    }

    pub(crate) async fn send_error_response(
        &self,
        request_id: String,
        code: i32,
        message: String,
    ) -> Result<(), String> {
        self.send_agent_envelope(build_error_response_envelope(request_id, code, message))
            .await
    }

    pub(crate) fn set_outbound_sender(&self, sender: Option<mpsc::Sender<proto::AgentEnvelope>>) {
        if let Ok(mut slot) = self.outbound_tx.lock() {
            *slot = sender;
        }
    }

    pub(crate) fn set_outbound_control_sender(
        &self,
        sender: Option<mpsc::Sender<proto::AgentEnvelope>>,
    ) {
        if let Ok(mut slot) = self.outbound_control_tx.lock() {
            *slot = sender;
        }
    }

    pub(crate) fn set_terminal_stream_sender(
        &self,
        sender: Option<mpsc::Sender<proto::TerminalStreamFrame>>,
    ) {
        if let Ok(mut slot) = self.terminal_stream_tx.lock() {
            *slot = sender;
        }
    }

    pub(crate) fn clear_terminal_stream_sender_if_current(
        &self,
        sender: &mpsc::Sender<proto::TerminalStreamFrame>,
    ) {
        if let Ok(mut slot) = self.terminal_stream_tx.lock() {
            if slot
                .as_ref()
                .map(|current| current.same_channel(sender))
                .unwrap_or(false)
            {
                *slot = None;
            }
        }
    }

    pub(crate) fn touch_heartbeat(&self) {
        self.publish_status(|status| {
            status.last_heartbeat = Some(now_unix_seconds());
        });
    }

    /// Publishes a disconnected gateway status and mirrors the offline state
    /// onto the tunnel event channel: without the mirror, the tunnel panel's
    /// `agentOnline` badge would keep the last gateway snapshot's stale
    /// "online" until the next snapshot — which never arrives while offline.
    pub(crate) fn publish_disconnected_status(
        &self,
        config: &RemoteSettingsPayload,
        last_error: Option<String>,
    ) {
        self.publish_status(|status| set_disconnected_status(status, config, last_error));
        self.emit_local_tunnel_state();
    }

    pub(crate) fn publish_status(&self, mutate: impl FnOnce(&mut GatewayStatusSnapshot)) {
        let next = if let Ok(mut status) = self.status.lock() {
            mutate(&mut status);
            status.clone()
        } else {
            return;
        };
        let _ = self.app_handle.emit("gateway:status", next);
    }

    pub(crate) async fn publish_current_settings_sync(&self) -> Result<(), String> {
        let snapshot = self.current_settings_snapshot().await?;
        self.publish_settings_sync(snapshot).await
    }

    pub(crate) async fn publish_current_terminal_sessions(&self) -> Result<(), String> {
        let sessions = self.terminal_registry.list(None).sessions;
        for session in sessions {
            self.send_agent_envelope(build_terminal_event_envelope(TerminalEventPayload {
                kind: "created".to_string(),
                session_id: session.id.clone(),
                project_path_key: session.project_path_key.clone(),
                session: Some(session),
                data: None,
                output_start_offset: None,
                output_end_offset: None,
                ssh_tabs: None,
            }))
            .await?;
            tokio::task::yield_now().await;
        }
        Ok(())
    }

    pub async fn refresh_settings_sync_from_db(&self) -> Result<Value, String> {
        let snapshot = self.current_settings_snapshot().await?;
        self.app_handle
            .emit(GATEWAY_SETTINGS_SYNC_EVENT, snapshot.clone())
            .map_err(|e| format!("emit gateway settings sync failed: {e}"))?;
        self.publish_settings_sync(snapshot.clone()).await?;
        Ok(snapshot)
    }
}

pub(crate) async fn await_abortable_on_reconfigure<T>(
    config: &RemoteSettingsPayload,
    config_rx: &mut watch::Receiver<RemoteSettingsPayload>,
    fut: impl Future<Output = Result<T, String>>,
) -> Result<Option<T>, String> {
    tokio::pin!(fut);

    loop {
        tokio::select! {
            result = &mut fut => return result.map(Some),
            changed = config_rx.changed() => {
                if changed.is_err() {
                    return Ok(None);
                }
                let next = config_rx.borrow().clone();
                if next != *config {
                    return Ok(None);
                }
            }
        }
    }
}

pub(crate) async fn send_agent_envelope_to(
    sender: mpsc::Sender<proto::AgentEnvelope>,
    envelope: proto::AgentEnvelope,
) -> Result<(), String> {
    sender
        .send(envelope)
        .await
        .map_err(|_| "gateway outbound stream closed".to_string())
}

pub(crate) fn build_error_response_envelope(
    request_id: String,
    code: i32,
    message: String,
) -> proto::AgentEnvelope {
    proto::AgentEnvelope {
        request_id,
        timestamp: now_unix_seconds(),
        payload: Some(proto::agent_envelope::Payload::Error(
            proto::ErrorResponse { code, message },
        )),
    }
}

#[deprecated(note = "v1 gRPC 链路仅作旧网关回退，v1 移除时一并删除")]
pub(crate) fn build_grpc_url(config: &RemoteSettingsPayload) -> Result<String, String> {
    let grpc_endpoint = config.grpc_endpoint.trim();
    if !grpc_endpoint.is_empty() {
        let with_scheme =
            if grpc_endpoint.starts_with("http://") || grpc_endpoint.starts_with("https://") {
                grpc_endpoint.to_string()
            } else {
                format!("http://{grpc_endpoint}")
            };
        let mut url =
            Url::parse(&with_scheme).map_err(|e| format!("invalid gateway gRPC endpoint: {e}"))?;
        if url.scheme() != "http" && url.scheme() != "https" {
            return Err("gateway gRPC endpoint must start with http:// or https://".to_string());
        }
        url.set_path("");
        url.set_query(None);
        url.set_fragment(None);
        return Ok(url.to_string().trim_end_matches('/').to_string());
    }

    let trimmed = config.gateway_url.trim();
    if trimmed.is_empty() {
        return Err("gateway URL is empty".to_string());
    }

    let mut url = Url::parse(trimmed).map_err(|e| format!("invalid gateway URL: {e}"))?;
    if url.scheme() != "http" && url.scheme() != "https" {
        return Err("gateway URL must start with http:// or https://".to_string());
    }
    url.set_port(Some(config.grpc_port))
        .map_err(|_| "failed to apply gRPC port to gateway URL".to_string())?;
    url.set_path("");
    url.set_query(None);
    url.set_fragment(None);
    Ok(url.to_string().trim_end_matches('/').to_string())
}

pub(crate) fn is_h2_protocol_error(message: &str) -> bool {
    let normalized = message.to_ascii_lowercase();
    normalized.contains("h2 protocol error") || normalized.contains("http2 error")
}

#[deprecated(note = "v1 gRPC 链路仅作旧网关回退，v1 移除时一并删除")]
pub(crate) fn build_endpoint(
    grpc_url: &str,
    keepalive_interval: Duration,
) -> Result<Endpoint, String> {
    // HTTP/2 keepalive owns dead-link detection: PING frames bypass stream
    // flow control, so congestion or streaming never delays them.
    let endpoint = Endpoint::from_shared(grpc_url.to_string())
        .map_err(|e| format!("invalid gateway endpoint: {e}"))?
        .connect_timeout(Duration::from_secs(10))
        .tcp_keepalive(Some(Duration::from_secs(30)))
        .http2_keep_alive_interval(keepalive_interval)
        .keep_alive_timeout(Duration::from_secs(15))
        .keep_alive_while_idle(true);

    if grpc_url.starts_with("https://") {
        ensure_rustls_crypto_provider();
        let host = Url::parse(grpc_url)
            .ok()
            .and_then(|url| url.host_str().map(ToString::to_string))
            .ok_or_else(|| "failed to extract TLS host from gateway URL".to_string())?;
        endpoint
            .tls_config(
                ClientTlsConfig::new()
                    .with_enabled_roots()
                    .domain_name(host),
            )
            .map_err(|e| format!("configure gateway TLS failed: {e}"))
    } else {
        Ok(endpoint)
    }
}

pub(crate) fn ensure_rustls_crypto_provider() {
    static INSTALL_DEFAULT_PROVIDER: Once = Once::new();
    INSTALL_DEFAULT_PROVIDER.call_once(|| {
        let _ = rustls::crypto::ring::default_provider().install_default();
    });
}

#[deprecated(note = "v1 gRPC 链路仅作旧网关回退，v1 移除时一并删除")]
pub(crate) fn insert_bearer_metadata(
    metadata: &mut tonic::metadata::MetadataMap,
    token: &str,
) -> Result<(), String> {
    let value = MetadataValue::try_from(format!("Bearer {}", token.trim()))
        .map_err(|e| format!("invalid gateway authorization metadata: {e}"))?;
    metadata.insert("authorization", value);
    Ok(())
}

pub(crate) fn is_remote_configured(config: &RemoteSettingsPayload) -> bool {
    !config.gateway_url.trim().is_empty() && !config.token.trim().is_empty()
}

pub(crate) fn effective_agent_id(config: &RemoteSettingsPayload) -> String {
    if !config.agent_id.trim().is_empty() {
        return config.agent_id.trim().to_string();
    }
    fallback_agent_id()
}

pub(crate) fn fallback_agent_id() -> String {
    std::env::var("HOSTNAME")
        .ok()
        .or_else(|| std::env::var("COMPUTERNAME").ok())
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| "liveagent-desktop".to_string())
}

pub(crate) fn set_disconnected_status(
    status: &mut GatewayStatusSnapshot,
    config: &RemoteSettingsPayload,
    last_error: Option<String>,
) {
    status.online = false;
    status.enabled = config.enabled;
    status.configured = is_remote_configured(config);
    status.gateway_url = config.gateway_url.clone();
    status.agent_id = effective_agent_id(config);
    status.session_id = None;
    status.connected_since = None;
    status.last_heartbeat = None;
    status.last_error = last_error;
    status.protocol = None;
}
