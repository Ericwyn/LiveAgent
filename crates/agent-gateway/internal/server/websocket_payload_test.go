package server

import (
	"testing"

	gatewayv1 "github.com/liveagent/agent-gateway/internal/proto/v1"
)

func TestWebsocketChatEventPayloadPreservesHostedSearch(t *testing.T) {
	payload := websocketChatEventPayload(&gatewayv1.ChatEvent{
		Type:           gatewayv1.ChatEvent_HOSTED_SEARCH,
		ConversationId: "conversation-1",
		Data:           `{"id":"search-1","provider":"codex","status":"completed","queries":["设计模式定义"],"sources":[{"url":"https://example.com/pattern","title":"设计模式"}],"round":2}`,
	}, 7)

	if payload["type"] != "hosted_search" {
		t.Fatalf("expected hosted_search type, got %#v", payload["type"])
	}
	if payload["conversation_id"] != "conversation-1" {
		t.Fatalf("expected conversation id, got %#v", payload["conversation_id"])
	}
	if payload["id"] != "search-1" {
		t.Fatalf("expected search id, got %#v", payload["id"])
	}
	if payload["provider"] != "codex" {
		t.Fatalf("expected provider, got %#v", payload["provider"])
	}
	if payload["status"] != "completed" {
		t.Fatalf("expected status, got %#v", payload["status"])
	}
	if payload["seq"] != int64(7) {
		t.Fatalf("expected seq 7, got %#v", payload["seq"])
	}
}

func TestWebsocketTerminalPayloadsPreserveOutputOffsets(t *testing.T) {
	response := websocketTerminalResponsePayload(&gatewayv1.TerminalResponse{
		Action:            "attach",
		Output:            "uploads\n",
		OutputStartOffset: 8,
		OutputEndOffset:   16,
	})
	if response["output_start_offset"] != uint64(8) {
		t.Fatalf("terminal response output_start_offset = %#v, want 8", response["output_start_offset"])
	}
	if response["output_end_offset"] != uint64(16) {
		t.Fatalf("terminal response output_end_offset = %#v, want 16", response["output_end_offset"])
	}

	event := websocketTerminalEventPayload(&gatewayv1.TerminalEvent{
		Kind:              "output",
		SessionId:         "terminal-1",
		ProjectPathKey:    "/workspace/project",
		Data:              "uploads\n",
		OutputStartOffset: 16,
		OutputEndOffset:   24,
	})
	if event["output_start_offset"] != uint64(16) {
		t.Fatalf("terminal event output_start_offset = %#v, want 16", event["output_start_offset"])
	}
	if event["output_end_offset"] != uint64(24) {
		t.Fatalf("terminal event output_end_offset = %#v, want 24", event["output_end_offset"])
	}
}
