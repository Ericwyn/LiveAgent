package server

import (
	"context"
	"encoding/json"
	"strings"
	"time"

	"github.com/google/uuid"
	gatewayv1 "github.com/liveagent/agent-gateway/internal/proto/v1"
	"github.com/liveagent/agent-gateway/internal/session"
)

// chatStreamSubscription is one persistent per-conversation subscription on a
// websocket connection. It survives run boundaries and ends only on
// chat.unsubscribe, a replacing chat.subscribe, or connection close.
type chatStreamSubscription struct {
	conversationID string
	cancel         func()
}

func (c *websocketConnection) handleChatSubscribe(req websocketRequest) {
	var payload struct {
		ConversationID string `json:"conversation_id"`
		AfterSeq       int64  `json:"after_seq"`
		StreamEpoch    string `json:"stream_epoch"`
	}
	if err := decodeWebSocketPayload(req.Payload, &payload); err != nil {
		_ = c.writeError(req.ID, "invalid chat.subscribe payload")
		return
	}
	conversationID := strings.TrimSpace(payload.ConversationID)
	if conversationID == "" {
		_ = c.writeError(req.ID, "conversation_id is required")
		return
	}

	sub := c.sm.SubscribeConversationStream(conversationID, payload.AfterSeq, payload.StreamEpoch)

	events := make([]map[string]any, 0, len(sub.Events))
	for _, event := range sub.Events {
		events = append(events, event.Payload)
	}
	resp := map[string]any{
		"conversation_id": sub.ConversationID,
		"stream_epoch":    sub.StreamEpoch,
		"latest_seq":      sub.LatestSeq,
		"reset":           sub.Reset,
		"activity":        websocketRunActivityPayload(sub.Activity),
		"snapshot":        websocketRunSnapshotPayload(sub.Snapshot),
		"events":          events,
	}

	// Register (replacing any previous subscription for this conversation)
	// before responding so no live event published after the replay boundary
	// is dropped.
	c.chatStreamsMu.Lock()
	if c.chatStreams == nil {
		c.chatStreams = make(map[string]*chatStreamSubscription)
	}
	if previous := c.chatStreams[conversationID]; previous != nil {
		previous.cancel()
	}
	c.chatStreams[conversationID] = &chatStreamSubscription{
		conversationID: conversationID,
		cancel:         sub.Cleanup,
	}
	c.chatStreamsMu.Unlock()

	if err := c.writeResponse(req.ID, resp); err != nil {
		sub.Cleanup()
		return
	}

	go c.forwardConversationEvents(conversationID, sub)
}

// forwardConversationEvents pushes live stream events to the client. When the
// subscriber channel closes because it overflowed, the client is told to
// re-subscribe (resume by after_seq replays the missed tail from the buffer).
func (c *websocketConnection) forwardConversationEvents(
	conversationID string,
	sub *session.ConversationSubscription,
) {
	defer sub.Cleanup()
	for {
		select {
		case <-c.done:
			return
		case event, ok := <-sub.EventCh:
			if !ok {
				if sub.Overflowed() {
					_ = c.writeEvent("chat.subscription_reset", map[string]any{
						"conversation_id": conversationID,
					})
				}
				return
			}
			if err := c.writeEvent("chat.event", event.Payload); err != nil {
				return
			}
		}
	}
}

func (c *websocketConnection) handleChatUnsubscribe(req websocketRequest) {
	var payload struct {
		ConversationID string `json:"conversation_id"`
	}
	if err := decodeWebSocketPayload(req.Payload, &payload); err != nil {
		_ = c.writeError(req.ID, "invalid chat.unsubscribe payload")
		return
	}
	conversationID := strings.TrimSpace(payload.ConversationID)

	c.chatStreamsMu.Lock()
	if sub := c.chatStreams[conversationID]; sub != nil {
		sub.cancel()
		delete(c.chatStreams, conversationID)
	}
	c.chatStreamsMu.Unlock()

	_ = c.writeResponse(req.ID, map[string]any{"ok": true})
}

func (c *websocketConnection) cleanupChatStreamSubscriptions() {
	c.chatStreamsMu.Lock()
	for conversationID, sub := range c.chatStreams {
		sub.cancel()
		delete(c.chatStreams, conversationID)
	}
	c.chatStreamsMu.Unlock()
}

func (c *websocketConnection) handleChatCommand(req websocketRequest) {
	commandType, body, baseMessageRef, err := decodeChatCommandPayload(req.Payload)
	if err != nil {
		_ = c.writeError(req.ID, "invalid chat command payload")
		return
	}

	switch commandType {
	case "chat.submit":
		baseMessageRef = nil
	case "chat.edit_resend":
		if baseMessageRef == nil {
			_ = c.writeError(req.ID, "base_message_ref is required")
			return
		}
		if err := validateChatMessageRef(baseMessageRef); err != nil {
			_ = c.writeError(req.ID, err.Error())
			return
		}
	case "chat.cancel":
		c.handleChatCancel(req)
		return
	default:
		_ = c.writeError(req.ID, "unsupported chat command")
		return
	}

	if err := normalizeChatRequestBody(&body); err != nil {
		_ = c.writeError(req.ID, err.Error())
		return
	}

	if !c.sm.IsOnline() {
		_ = c.writeError(req.ID, "agent offline")
		return
	}

	runID := "chat-command-" + uuid.NewString()
	updates, cleanupWatch := c.sm.WatchChatCommand(runID)
	start := c.sm.StartChatCommand(
		runID,
		body.ConversationID,
		body.Workdir,
		body.ClientRequestID,
		buildAcceptedChatCommandPayloads(body, baseMessageRef),
	)

	_ = c.writeResponse(req.ID, map[string]any{
		"run_id":          start.RunID,
		"conversation_id": start.ConversationID,
		"accepted_seq":    start.AcceptedSeq,
		"deduped":         false,
	})

	go c.forwardChatCommandUpdates(updates)
	go dispatchAcceptedChatCommand(
		context.Background(), c.cfg, c.sm, cleanupWatch, start, body, baseMessageRef, newChatTraceID(),
	)
}

// forwardChatCommandUpdates relays pre-stream command outcomes (bound /
// queued_in_gui / failed) to the connection that issued the command. The
// watch is closed by the command's startup watchdog.
func (c *websocketConnection) forwardChatCommandUpdates(updates <-chan session.ChatCommandUpdate) {
	for {
		select {
		case <-c.done:
			return
		case update, ok := <-updates:
			if !ok {
				return
			}
			payload := map[string]any{
				"run_id":            update.RunID,
				"client_request_id": update.ClientRequestID,
				"phase":             update.Phase,
			}
			if update.ConversationID != "" {
				payload["conversation_id"] = update.ConversationID
			}
			if update.ErrorCode != "" {
				payload["error_code"] = update.ErrorCode
			}
			if update.Message != "" {
				payload["message"] = update.Message
			}
			if err := c.writeEvent("chat.command_update", payload); err != nil {
				return
			}
		}
	}
}

func (c *websocketConnection) handleChatCancel(req websocketRequest) {
	raw := req.Payload
	// chat.cancel arrives either directly or wrapped in a chat.command
	// envelope ({type, payload}); unwrap the latter.
	var wrapper struct {
		Type    string          `json:"type"`
		Payload json.RawMessage `json:"payload"`
	}
	if err := json.Unmarshal(raw, &wrapper); err == nil &&
		strings.TrimSpace(wrapper.Type) == "chat.cancel" && len(wrapper.Payload) > 0 {
		raw = wrapper.Payload
	}

	var payload struct {
		ConversationID string `json:"conversation_id"`
		RunID          string `json:"run_id"`
	}
	if err := decodeWebSocketPayload(raw, &payload); err != nil {
		_ = c.writeError(req.ID, "invalid chat.cancel payload")
		return
	}
	payload.ConversationID = strings.TrimSpace(payload.ConversationID)
	payload.RunID = strings.TrimSpace(payload.RunID)
	if payload.ConversationID == "" {
		_ = c.writeError(req.ID, "conversation_id is required")
		return
	}
	if !c.sm.IsOnline() {
		_ = c.writeError(req.ID, "agent offline")
		return
	}

	// The run is not terminalized here: the activity flips to "cancelling",
	// the agent's real terminal signal wins, and a watchdog force-finishes if
	// the agent never reports back.
	runID, active := c.sm.MarkConversationCancelling(payload.ConversationID, payload.RunID)
	if !active {
		_ = c.writeResponse(req.ID, map[string]any{
			"ok": true, "run_id": "", "conversation_id": payload.ConversationID,
		})
		return
	}

	timeout := 10 * time.Second
	if c.cfg != nil && c.cfg.WebSocketWriteTimeout > 0 {
		timeout = c.cfg.WebSocketWriteTimeout
	}
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()

	if err := c.sm.SendToAgentContext(ctx, &gatewayv1.GatewayEnvelope{
		RequestId: runID,
		Timestamp: time.Now().Unix(),
		Payload:   buildChatCancelCommandPayload(payload.ConversationID),
	}); err != nil {
		_ = c.writeError(req.ID, websocketErrorMessage(err))
		return
	}

	go watchChatCancel(c.sm, runID)
	_ = c.writeResponse(req.ID, map[string]any{
		"ok": true, "run_id": runID, "conversation_id": payload.ConversationID,
	})
}

const chatCancelWatchdogTimeout = 15 * time.Second

func watchChatCancel(sm *session.Manager, runID string) {
	time.Sleep(chatCancelWatchdogTimeout)
	sm.ForceFinishRun(runID, "cancelled", "cancel_timeout",
		"The desktop runtime did not confirm the cancellation in time.")
}
