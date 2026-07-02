package server

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"

	"github.com/liveagent/agent-gateway/internal/auth"
	"github.com/liveagent/agent-gateway/internal/config"
	gatewayv1 "github.com/liveagent/agent-gateway/internal/proto/v1"
	"github.com/liveagent/agent-gateway/internal/session"
)

type websocketRequest struct {
	ID      string          `json:"id"`
	Type    string          `json:"type"`
	Payload json.RawMessage `json:"payload,omitempty"`
}

type websocketEnvelope struct {
	ID      string `json:"id,omitempty"`
	Type    string `json:"type"`
	Payload any    `json:"payload,omitempty"`
	Error   string `json:"error,omitempty"`
}

type websocketAuthPayload struct {
	Token string `json:"token"`
}

type websocketTerminalRequestPayload struct {
	SessionID      string `json:"session_id"`
	ProjectPathKey string `json:"project_path_key"`
	Cwd            string `json:"cwd"`
	Shell          string `json:"shell"`
	Title          string `json:"title"`
	Data           string `json:"data"`
	Cols           *int   `json:"cols"`
	Rows           *int   `json:"rows"`
	MaxBytes       *int   `json:"max_bytes"`
	SshHostID      string `json:"ssh_host_id"`
	PromptID       string `json:"prompt_id"`
	PromptAnswer   string `json:"prompt_answer"`
	TrustHostKey   bool   `json:"trust_host_key"`
	SftpEnabled    bool   `json:"sftp_enabled"`
	TabID          string `json:"tab_id"`
	TabKind        string `json:"tab_kind"`
}

type websocketSshKnownHostResetPayload struct {
	Host string `json:"host"`
	Port *int   `json:"port"`
}

type websocketSftpRequestPayload struct {
	SessionID           string `json:"session_id"`
	SessionIDCamel      string `json:"sessionId"`
	ProjectPathKey      string `json:"project_path_key"`
	ProjectPathKeyCamel string `json:"projectPathKey"`
	Workdir             string `json:"workdir"`
	Side                string `json:"side"`
	LocalPath           string `json:"local_path"`
	LocalPathCamel      string `json:"localPath"`
	RemotePath          string `json:"remote_path"`
	RemotePathCamel     string `json:"remotePath"`
	FromPath            string `json:"from_path"`
	FromPathCamel       string `json:"fromPath"`
	SourcePathCamel     string `json:"sourcePath"`
	ToPath              string `json:"to_path"`
	ToPathCamel         string `json:"toPath"`
	Direction           string `json:"direction"`
	TargetPath          string `json:"target_path"`
	TargetPathCamel     string `json:"targetPath"`
	TransferID          string `json:"transfer_id"`
	TransferIDCamel     string `json:"transferId"`
	Recursive           bool   `json:"recursive"`
	Overwrite           bool   `json:"overwrite"`
}

type websocketGitRequestPayload struct {
	Workdir string          `json:"workdir"`
	Args    json.RawMessage `json:"args,omitempty"`
}

const (
	websocketWriteQueueDefault = 512
	websocketMaxWriteRetries   = 2
	websocketRetryBackoff      = 100 * time.Millisecond
)

type websocketConnection struct {
	cfg *config.Config
	sm  *session.Manager

	conn         *websocket.Conn
	req          *http.Request
	writeMu      sync.Mutex
	writeTimeout time.Duration
	outbox       chan websocketEnvelope

	closeOnce  sync.Once
	done       chan struct{}
	authorized bool

	lastPongAt time.Time
	lastPongMu sync.Mutex

	historyEvents             <-chan *gatewayv1.HistorySyncEvent
	historyEventsCleanup      func()
	settingsEvents            <-chan *gatewayv1.SettingsSyncEvent
	settingsEventsCleanup     func()
	terminalEvents            <-chan *gatewayv1.TerminalEvent
	terminalEventsCleanup     func()
	sftpEvents                <-chan *gatewayv1.SftpEvent
	sftpEventsCleanup         func()
	chatQueueEvents           <-chan *gatewayv1.ChatQueueEvent
	chatQueueEventsCleanup    func()
	chatActivityEvents        <-chan session.ConversationActivityEvent
	chatActivityEventsCleanup func()
	heartbeatOnce             sync.Once

	terminalInterest *websocketTerminalInterestTracker

	chatStreamsMu sync.Mutex
	chatStreams   map[string]*chatStreamSubscription
}

const maxHistoryListLimit = 200
const defaultHistoryListPage = 1
const defaultHistoryListPageSize = 80

func NewWebSocketServer(cfg *config.Config, sm *session.Manager) http.Handler {
	upgrader := websocket.Upgrader{
		CheckOrigin: func(r *http.Request) bool {
			return originAllowed(r)
		},
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		conn.SetReadLimit(webSocketReadLimit(cfg))

		queueSize := websocketWriteQueueDefault
		if cfg.WebSocketWriteQueueSize > 0 {
			queueSize = cfg.WebSocketWriteQueueSize
		}
		state := &websocketConnection{
			cfg:              cfg,
			sm:               sm,
			conn:             conn,
			req:              r,
			writeTimeout:     cfg.WebSocketWriteTimeout,
			outbox:           make(chan websocketEnvelope, queueSize),
			done:             make(chan struct{}),
			terminalInterest: newWebsocketTerminalInterestTracker(),
		}
		defer state.close()
		state.serve()
	})
}

func webSocketReadLimit(cfg *config.Config) int64 {
	if cfg != nil && cfg.GRPCMaxMessageBytes > 0 {
		return int64(cfg.GRPCMaxMessageBytes)
	}
	return int64(config.DefaultGRPCMaxMessageBytes)
}

func (c *websocketConnection) serve() {
	for {
		var req websocketRequest
		if err := c.conn.ReadJSON(&req); err != nil {
			if errors.Is(err, io.EOF) {
				return
			}
			return
		}

		req.ID = strings.TrimSpace(req.ID)
		req.Type = strings.TrimSpace(req.Type)
		if req.Type == "pong" {
			c.lastPongMu.Lock()
			c.lastPongAt = time.Now()
			c.lastPongMu.Unlock()
			_ = c.conn.SetReadDeadline(time.Now().Add(c.pongTimeout()))
			continue
		}
		if req.ID == "" {
			_ = c.writeError("", "request id is required")
			continue
		}
		if req.Type == "" {
			_ = c.writeError(req.ID, "request type is required")
			continue
		}

		if req.Type == "auth" {
			c.handleAuth(req)
			continue
		}

		if !c.authorized {
			_ = c.writeError(req.ID, "unauthorized")
			continue
		}

		go c.dispatch(req)
	}
}

func (c *websocketConnection) close() {
	c.closeOnce.Do(func() {
		close(c.done)
		if c.historyEventsCleanup != nil {
			c.historyEventsCleanup()
			c.historyEventsCleanup = nil
		}
		if c.settingsEventsCleanup != nil {
			c.settingsEventsCleanup()
			c.settingsEventsCleanup = nil
		}
		if c.terminalEventsCleanup != nil {
			c.terminalEventsCleanup()
			c.terminalEventsCleanup = nil
		}
		if c.sftpEventsCleanup != nil {
			c.sftpEventsCleanup()
			c.sftpEventsCleanup = nil
		}
		if c.chatQueueEventsCleanup != nil {
			c.chatQueueEventsCleanup()
			c.chatQueueEventsCleanup = nil
		}
		if c.chatActivityEventsCleanup != nil {
			c.chatActivityEventsCleanup()
			c.chatActivityEventsCleanup = nil
		}
		c.cleanupChatStreamSubscriptions()
		_ = c.conn.Close()
	})
}

func (c *websocketConnection) handleAuth(req websocketRequest) {
	var payload websocketAuthPayload
	if err := decodeWebSocketPayload(req.Payload, &payload); err != nil {
		_ = c.writeError(req.ID, "invalid auth payload")
		c.close()
		return
	}

	if !auth.ValidateToken(payload.Token, c.cfg.Token) {
		_ = c.writeError(req.ID, "unauthorized")
		c.close()
		return
	}

	c.authorized = true
	go c.writeLoop()
	_ = c.conn.SetReadDeadline(time.Now().Add(c.pongTimeout()))
	c.startHistorySyncForwarder()
	c.startSettingsSyncForwarder()
	c.startTerminalEventForwarder()
	c.startSftpEventForwarder()
	c.startChatQueueEventForwarder()
	c.startChatActivityForwarder()
	c.startWebSocketHeartbeat()
	if err := c.writeResponse(req.ID, map[string]any{"ok": true}); err != nil {
		c.close()
		return
	}
	c.replayTerminalSessionSnapshot()
}

func (c *websocketConnection) startHistorySyncForwarder() {
	if c.historyEvents != nil || c.historyEventsCleanup != nil {
		return
	}

	historyEvents, cleanup := c.sm.SubscribeHistorySync()
	c.historyEvents = historyEvents
	c.historyEventsCleanup = cleanup

	go func() {
		for {
			select {
			case <-c.done:
				return
			case event, ok := <-historyEvents:
				if !ok {
					return
				}
				if err := c.writeEvent("history.event", websocketHistorySyncPayload(event)); err != nil {
					return
				}
			}
		}
	}()
}

func (c *websocketConnection) startChatActivityForwarder() {
	if c.chatActivityEvents != nil || c.chatActivityEventsCleanup != nil {
		return
	}

	activityEvents, cleanup := c.sm.SubscribeChatActivity()
	c.chatActivityEvents = activityEvents
	c.chatActivityEventsCleanup = cleanup

	go func() {
		for {
			select {
			case <-c.done:
				return
			case event, ok := <-activityEvents:
				if !ok {
					return
				}
				if err := c.writeEvent("chat.activity", websocketChatActivityPayload(event)); err != nil {
					return
				}
			}
		}
	}()
}

func (c *websocketConnection) startSettingsSyncForwarder() {
	if c.settingsEvents != nil || c.settingsEventsCleanup != nil {
		return
	}

	settingsEvents, cleanup := c.sm.SubscribeSettingsSync()
	c.settingsEvents = settingsEvents
	c.settingsEventsCleanup = cleanup

	go func() {
		for {
			select {
			case <-c.done:
				return
			case event, ok := <-settingsEvents:
				if !ok {
					return
				}
				payload, err := websocketSettingsJSONPayload(event.GetSettingsJson())
				if err != nil {
					return
				}
				if err := c.writeEvent("settings.event", payload); err != nil {
					return
				}
			}
		}
	}()
}

func (c *websocketConnection) startTerminalEventForwarder() {
	if c.terminalEvents != nil || c.terminalEventsCleanup != nil {
		return
	}

	terminalEvents, cleanup := c.sm.SubscribeTerminalEvents()
	c.terminalEvents = terminalEvents
	c.terminalEventsCleanup = cleanup

	go func() {
		for {
			select {
			case <-c.done:
				return
			case event, ok := <-terminalEvents:
				if !ok {
					return
				}
				if !c.shouldForwardTerminalEvent(event) {
					continue
				}
				if err := c.writeEvent("terminal.event", websocketTerminalEventPayload(event)); err != nil {
					return
				}
			}
		}
	}()
}

func (c *websocketConnection) startSftpEventForwarder() {
	if c.sftpEvents != nil || c.sftpEventsCleanup != nil {
		return
	}

	sftpEvents, cleanup := c.sm.SubscribeSftpEvents()
	c.sftpEvents = sftpEvents
	c.sftpEventsCleanup = cleanup

	go func() {
		for {
			select {
			case <-c.done:
				return
			case event, ok := <-sftpEvents:
				if !ok {
					return
				}
				if !c.sm.WebSshTerminalEnabled() {
					continue
				}
				if err := c.writeEvent("sftp.event", websocketSftpEventPayload(event)); err != nil {
					return
				}
			}
		}
	}()
}

func (c *websocketConnection) startChatQueueEventForwarder() {
	if c.chatQueueEvents != nil || c.chatQueueEventsCleanup != nil {
		return
	}

	chatQueueEvents, cleanup := c.sm.SubscribeChatQueueEvents()
	c.chatQueueEvents = chatQueueEvents
	c.chatQueueEventsCleanup = cleanup

	go func() {
		for {
			select {
			case <-c.done:
				return
			case event, ok := <-chatQueueEvents:
				if !ok {
					return
				}
				if err := c.writeEvent("chat_queue.event", websocketChatQueueEventPayload(event)); err != nil {
					return
				}
			}
		}
	}()
}

func (c *websocketConnection) replayTerminalSessionSnapshot() {
	if !c.terminalFeaturesEnabled() {
		return
	}
	for _, terminalSession := range c.sm.TerminalSessionSnapshot("") {
		if !c.terminalSessionAllowed(terminalSession) {
			continue
		}
		if err := c.writeEvent("terminal.event", websocketTerminalEventPayload(&gatewayv1.TerminalEvent{
			Kind:           "created",
			SessionId:      terminalSession.GetId(),
			ProjectPathKey: terminalSession.GetProjectPathKey(),
			Session:        terminalSession,
		})); err != nil {
			return
		}
	}
}

func (c *websocketConnection) rememberTerminalProject(projectPathKey string) {
	c.terminalInterest.rememberProject(projectPathKey)
}

func (c *websocketConnection) rememberTerminalSession(sessionID string, projectPathKey string) {
	c.terminalInterest.rememberSession(sessionID, projectPathKey)
}

func (c *websocketConnection) forgetTerminalInterest(sessionID string, projectPathKey string) {
	c.terminalInterest.forget(sessionID, projectPathKey)
}

func (c *websocketConnection) shouldForwardTerminalEvent(event *gatewayv1.TerminalEvent) bool {
	return c.terminalEventAllowed(event) && c.terminalInterest.shouldForward(event)
}

func (c *websocketConnection) startWebSocketHeartbeat() {
	c.heartbeatOnce.Do(func() {
		period := c.cfg.WebSocketHeartbeatPeriod
		if period <= 0 {
			period = 15 * time.Second
		}
		c.lastPongMu.Lock()
		c.lastPongAt = time.Now()
		c.lastPongMu.Unlock()
		go func() {
			ticker := time.NewTicker(period)
			defer ticker.Stop()
			for {
				select {
				case <-c.done:
					return
				case <-ticker.C:
					c.lastPongMu.Lock()
					lastPong := c.lastPongAt
					c.lastPongMu.Unlock()
					if time.Since(lastPong) > c.pongTimeout() {
						c.close()
						return
					}
					if err := c.writeEnvelope(websocketEnvelope{
						Type: "ping",
						Payload: map[string]any{
							"timestamp": time.Now().Unix(),
						},
					}); err != nil {
						return
					}
				}
			}
		}()
	})
}

func (c *websocketConnection) pongTimeout() time.Duration {
	period := c.cfg.WebSocketHeartbeatPeriod
	if period <= 0 {
		period = 15 * time.Second
	}
	return period*3 + 5*time.Second
}

func (c *websocketConnection) dispatch(req websocketRequest) {
	handler := websocketRequestHandlers[req.Type]
	if handler == nil {
		_ = c.writeError(req.ID, "unsupported request type")
		return
	}
	handler(c, req)
}

func (c *websocketConnection) awaitAgentResponse(
	requestID string,
	envelope *gatewayv1.GatewayEnvelope,
) (*gatewayv1.AgentEnvelope, error) {
	ctx, cancel := context.WithTimeout(context.Background(), c.cfg.RequestTimeout)
	defer cancel()

	go func() {
		select {
		case <-c.done:
			cancel()
		case <-ctx.Done():
		}
	}()

	return awaitAgentUnaryResponse(ctx, c.sm, requestID, envelope)
}

func (c *websocketConnection) sendToAgent(envelope *gatewayv1.GatewayEnvelope) error {
	timeout := c.cfg.WebSocketWriteTimeout
	if timeout <= 0 {
		timeout = 10 * time.Second
	}
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()

	go func() {
		select {
		case <-c.done:
			cancel()
		case <-ctx.Done():
		}
	}()

	return c.sm.SendToAgentContext(ctx, envelope)
}

func (c *websocketConnection) writeResponse(requestID string, payload any) error {
	return c.writeEnvelope(websocketEnvelope{
		ID:      requestID,
		Type:    "response",
		Payload: payload,
	})
}

func (c *websocketConnection) writeError(requestID string, message string) error {
	return c.writeEnvelope(websocketEnvelope{
		ID:    requestID,
		Type:  "error",
		Error: message,
	})
}

func (c *websocketConnection) writeEvent(eventType string, payload any) error {
	return c.writeEnvelope(websocketEnvelope{
		Type:    eventType,
		Payload: payload,
	})
}

func (c *websocketConnection) writeEnvelope(envelope websocketEnvelope) error {
	select {
	case <-c.done:
		return errors.New("connection closed")
	case c.outbox <- envelope:
		return nil
	default:
		c.close()
		return errors.New("write queue full")
	}
}

func (c *websocketConnection) writeLoop() {
	for {
		select {
		case <-c.done:
			return
		case envelope := <-c.outbox:
			if err := c.writeEnvelopeDirect(envelope); err != nil {
				ok := false
				for attempt := 0; attempt < websocketMaxWriteRetries; attempt++ {
					select {
					case <-c.done:
						return
					case <-time.After(websocketRetryBackoff):
					}
					if err := c.writeEnvelopeDirect(envelope); err == nil {
						ok = true
						break
					}
				}
				if !ok {
					c.close()
					return
				}
			}
			for drained := 0; drained < 64; drained++ {
				select {
				case extra := <-c.outbox:
					if err := c.writeEnvelopeDirect(extra); err != nil {
						c.close()
						return
					}
				default:
					goto batchDone
				}
			}
		batchDone:
		}
	}
}

func (c *websocketConnection) writeEnvelopeDirect(envelope websocketEnvelope) error {
	c.writeMu.Lock()
	defer c.writeMu.Unlock()
	if c.writeTimeout > 0 {
		if err := c.conn.SetWriteDeadline(time.Now().Add(c.writeTimeout)); err != nil {
			return err
		}
		defer func() {
			_ = c.conn.SetWriteDeadline(time.Time{})
		}()
	}
	return c.conn.WriteJSON(envelope)
}
