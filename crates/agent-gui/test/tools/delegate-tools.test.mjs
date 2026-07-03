import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const rootDir = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const agentRunnerModulePath = path.join(rootDir, "src/lib/chat/runner/agentRunner.ts");
const contextCompactionModulePath = path.join(rootDir, "src/lib/chat/compaction/contextCompaction.ts");

function createUsage() {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: 0,
    },
  };
}

function createAssistant(text) {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "openai-responses",
    provider: "openai",
    model: "gpt-5",
    usage: createUsage(),
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

function createTool(name, description = name) {
  return {
    name,
    description,
    parameters: { type: "object", properties: {} },
  };
}

function createMetadata(groupId, kind, isReadOnly, displayCategory = "file") {
  return { groupId, kind, isReadOnly, displayCategory };
}

function createToolCall(argumentsValue) {
  return {
    type: "toolCall",
    id: "call-agent",
    name: "Agent",
    arguments: argumentsValue,
  };
}

function createSubagentIdentity(overrides = {}) {
  const logicalAgentId = overrides.logicalAgentId ?? "expert-a";
  const displayName = overrides.displayName ?? overrides.name ?? "Existing Expert";
  const role = overrides.role ?? overrides.description ?? displayName;
  return {
    parentConversationId: "conversation-1",
    logicalAgentId,
    displayName,
    role,
    identityPrompt:
      overrides.identityPrompt ?? `Stable identity for ${displayName}: ${role}`,
    agentId: overrides.agentId,
    templateName: overrides.templateName,
    defaultMode: overrides.defaultMode ?? "readonly",
    defaultTaskIntent: overrides.defaultTaskIntent ?? "research",
    defaultApplyPolicy: overrides.defaultApplyPolicy ?? "none",
    createdParentToolCallId: overrides.createdParentToolCallId ?? "call-agent-old",
    createdAt: overrides.createdAt ?? 1,
    updatedAt: overrides.updatedAt ?? 2,
  };
}

function createConversationState(messages) {
  return {
    meta: {
      schemaVersion: 3,
      systemPrompt: "hot system",
      tools: [],
      totalSegmentCount: 1,
      totalMessageCount: messages.length,
      activeSegmentIndex: 0,
    },
    activeSegmentIndex: 0,
    segments: [
      {
        segmentIndex: 0,
        segmentId: "segment-hot",
        messages,
        messageCount: messages.length,
        createdAt: 1,
        updatedAt: 2,
      },
    ],
    historyRenderItems: [],
  };
}

function createDelegateHarness(options = {}) {
  const runnerCalls = [];
  let activeRuns = 0;
  let maxActiveRuns = 0;
  const runnerDelayMs = options.runnerDelayMs ?? 0;
  const executedBaseToolCalls = [];
  const executedChildToolCalls = [];
  const worktreeCreates = [];
  const worktreeStatuses = [];
  const worktreeApplies = [];
  const worktreeCleanups = [];
  const subagentRunStates = [];
  const subagentIdentities = [];
  const subagentEvents = [];
  const subagentMessages = [...(options.subagentMessages ?? [])];
  const compactionCalls = [];
  const runnerTurnOverrides = [];

  const mocks = {
    [agentRunnerModulePath]: {
      async runAssistantWithTools(params) {
        runnerCalls.push(params);
        activeRuns += 1;
        maxActiveRuns = Math.max(maxActiveRuns, activeRuns);
        try {
          if (runnerDelayMs > 0) {
            await new Promise((resolve) => setTimeout(resolve, runnerDelayMs));
          }
          if (options.runnerError) {
            throw options.runnerError;
          }
          params.onTurnStart?.(1);
          params.onTextDelta?.("partial report", 1);
          for (const delta of options.thinkingDeltas ?? []) {
            params.onThinkingDelta?.(delta, 1);
          }
          if (options.triggerCompaction) {
            const assistant = {
              ...createAssistant("tool round"),
              stopReason: "toolUse",
            };
            const toolResult = {
              role: "toolResult",
              toolCallId: "call-read",
              toolName: "Read",
              content: [{ type: "text", text: "large tool result" }],
              details: {},
              isError: false,
              timestamp: Date.now(),
            };
            const override = await params.onBeforeNextTurn?.({
              round: 1,
              assistant,
              toolResults: [toolResult],
              runtimeContext: params.context,
              emittedMessages: [assistant, toolResult],
              signal: undefined,
            });
            runnerTurnOverrides.push(override);
          }
          for (const toolCall of options.runnerToolCalls ?? []) {
            params.onToolCall?.(toolCall, 1);
            params.onToolExecutionStart?.(toolCall, 1);
            const toolResult = await params.executeToolCall(toolCall);
            params.onToolResult?.(toolCall, toolResult, 1);
          }
          return {
            assistant: createAssistant(`report:${runnerCalls.length}`),
            messages: [createAssistant(`report:${runnerCalls.length}`)],
            emittedMessages: [createAssistant(`report:${runnerCalls.length}`)],
          };
        } finally {
          activeRuns -= 1;
        }
      },
    },
  };

  if (options.mockCompaction) {
    mocks[contextCompactionModulePath] = {
      createCompactionThrottleState() {
        return {};
      },
      noteCompactionApplied(state) {
        state.applied = (state.applied ?? 0) + 1;
      },
      noteCompactionRound(state) {
        state.rounds = (state.rounds ?? 0) + 1;
      },
      async runPreCompactConversation(params) {
        compactionCalls.push({ ...params, phase: "pre" });
        if (options.compactionError) {
          throw options.compactionError;
        }
        if (!options.preCompactionApplied) {
          return {
            applied: false,
            state: params.state,
            decision: { shouldCompact: false, trigger: "below_threshold" },
          };
        }
        const now = Date.now();
        const nextSegmentIndex = params.state.segments.length;
        return {
          applied: true,
          state: {
            ...params.state,
            activeSegmentIndex: nextSegmentIndex,
            meta: {
              ...params.state.meta,
              activeSegmentIndex: nextSegmentIndex,
              totalSegmentCount: nextSegmentIndex + 1,
            },
            segments: [
              ...params.state.segments,
              {
                segmentIndex: nextSegmentIndex,
                segmentId: "mock-pre-compacted-segment",
                summary: {
                  role: "summary",
                  id: "mock-pre-summary",
                  timestamp: now,
                  content: "Mock pre compacted summary",
                  summaryMeta: {
                    format: "plain-text-v1",
                    strategy: "cumulative-checkpoint",
                    coversThroughMessageId: "previous-answer",
                    coveredMessageCount: params.state.meta.totalMessageCount,
                    generatedBy: {
                      providerId: "codex",
                      model: "gpt-5",
                      promptVersion: "summary-v1",
                    },
                  },
                },
                messages: [],
                messageCount: 0,
                createdAt: now,
                updatedAt: now,
              },
            ],
          },
          decision: { shouldCompact: true, trigger: "token_budget" },
        };
      },
      async runMidTurnCompaction(params) {
        compactionCalls.push({ ...params, phase: "mid" });
        if (options.compactionError) {
          throw options.compactionError;
        }
        if (!options.compactionApplied) {
          return {
            applied: false,
            state: params.state,
            decision: { shouldCompact: false, trigger: "below_threshold" },
          };
        }
        const now = Date.now();
        const nextSegmentIndex = params.state.segments.length;
        const compactedState = {
          ...params.state,
          activeSegmentIndex: nextSegmentIndex,
          meta: {
            ...params.state.meta,
            activeSegmentIndex: nextSegmentIndex,
            totalSegmentCount: nextSegmentIndex + 1,
          },
          segments: [
            ...params.state.segments,
            {
              segmentIndex: nextSegmentIndex,
              segmentId: "mock-compacted-segment",
              summary: {
                role: "summary",
                id: "mock-summary",
                timestamp: now,
                content: "Mock compacted summary",
                summaryMeta: {
                  format: "plain-text-v1",
                  strategy: "cumulative-checkpoint",
                  coversThroughMessageId: "call-read",
                  coveredMessageCount: params.state.meta.totalMessageCount,
                  generatedBy: {
                    providerId: "codex",
                    model: "gpt-5",
                    promptVersion: "summary-v1",
                  },
                },
              },
              messages: [],
              messageCount: 0,
              createdAt: now,
              updatedAt: now,
            },
          ],
        };
        return {
          applied: true,
          state: compactedState,
          decision: { shouldCompact: true, trigger: "token_budget" },
          resumeMessage: {
            role: "user",
            content: [{ type: "text", text: "Continue." }],
            timestamp: now + 1,
          },
        };
      },
    };
  }

  const loader = createTsModuleLoader({
    mocks,
  });

  const delegateTools = loader.loadModule("src/lib/tools/delegateTools.ts");
  const { createSubagentScheduler } = loader.loadModule(
    "src/lib/chat/subagent/subagentScheduler.ts",
  );
  const subagentScheduler = options.subagentSchedulerLimits
    ? createSubagentScheduler(options.subagentSchedulerLimits)
    : undefined;
  const baseTools = [
    createTool("Read"),
    createTool("Grep"),
    createTool("Write"),
    createTool("McpManager"),
    createTool("mcp_docs_search"),
    createTool("Agent"),
  ];
  const metadataByName = new Map([
    ["Read", createMetadata("fs", "read", true)],
    ["Grep", createMetadata("fs", "grep", true, "search")],
    ["Write", createMetadata("fs", "write", false)],
    ["McpManager", createMetadata("mcp", "manage_mcp", false, "mcp")],
    ["mcp_docs_search", createMetadata("mcp", "mcp", false, "mcp")],
    ["Agent", createMetadata("delegate", "delegate_agent", false, "system")],
  ]);
  const bundle = delegateTools.createDelegateTools({
    providerId: "codex",
    model: "gpt-5",
    runtime: {
      baseUrl: "https://api.example.test/v1",
      apiKey: "test-key",
      reasoning: "medium",
    },
    workdir: options.workdir ?? "/tmp/liveagent-delegate-test",
    sessionId: "parent-session",
    parentConversationId: "conversation-1",
    existingSubagentIdentities: options.existingSubagentIdentities ?? [],
    existingSubagentRuns: options.existingSubagentRuns ?? [],
    subagentRuntimeManager: options.subagentRuntimeManager,
    subagentScheduler,
    agentTemplates: [
      {
        id: "reviewer",
        name: "Reviewer",
        description: "Review code paths",
        prompt: "Focus on concrete defects.",
      },
    ],
    baseTools,
    metadataByName,
    async executeToolCall(toolCall) {
      executedBaseToolCalls.push(toolCall);
      return {
        role: "toolResult",
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        content: [{ type: "text", text: `base:${toolCall.name}` }],
        details: {},
        isError: false,
        timestamp: Date.now(),
      };
    },
    async createSubagentToolRegistry(workdir) {
      const childTools = [
        createTool("Read"),
        createTool("Grep"),
        createTool("Write"),
        createTool("Bash"),
        createTool("Agent"),
        createTool("McpManager"),
        createTool("mcp_docs_search"),
      ];
      const childMetadataByName = new Map([
        ["Read", createMetadata("fs", "read", true)],
        ["Grep", createMetadata("fs", "grep", true, "search")],
        ["Write", createMetadata("fs", "write", false)],
        ["Bash", createMetadata("shell", "bash", false, "terminal")],
        ["Agent", createMetadata("delegate", "delegate_agent", false, "system")],
        ["McpManager", createMetadata("mcp", "manage_mcp", false, "mcp")],
        ["mcp_docs_search", createMetadata("mcp", "mcp", false, "mcp")],
      ]);
      return {
        tools: childTools,
        metadataByName: childMetadataByName,
        async executeToolCall(toolCall) {
          executedChildToolCalls.push({ workdir, toolCall });
          return {
            role: "toolResult",
            toolCallId: toolCall.id,
            toolName: toolCall.name,
            content: [{ type: "text", text: `child:${toolCall.name}` }],
            details: {},
            isError: false,
            timestamp: Date.now(),
          };
        },
      };
    },
    async createWorktree(request) {
      worktreeCreates.push(request);
      return {
        repo_root: "/repo",
        worktree_root: "/tmp/liveagent-subagents/agent-a",
        workdir: "/tmp/liveagent-subagents/agent-a",
        branch_name: "liveagent/subagent/agent-a",
      };
    },
    async getWorktreeStatus(request) {
      worktreeStatuses.push(request);
      return options.worktreeStatus ?? {
        changed: true,
        status: " M src/app.ts\n?? src/new.ts",
        diff_stat: " src/app.ts | 2 +",
        diff: "diff --git a/src/app.ts b/src/app.ts",
        diff_truncated: false,
        untracked_files: ["src/new.ts"],
      };
    },
    async applyWorktreeChanges(request) {
      worktreeApplies.push(request);
      if (options.applyError) {
        throw options.applyError;
      }
      if (typeof options.applyWorktreeChanges === "function") {
        return options.applyWorktreeChanges(request);
      }
      return {
        applied: true,
        changed: true,
        status: " M src/app.ts\n?? src/new.ts",
        patch_bytes: 123,
        apply_method: "git_apply",
        copied_files: [],
        deleted_files: [],
        conflict_files: [],
      };
    },
    async cleanupWorktree(request) {
      worktreeCleanups.push(request);
      if (typeof options.cleanupWorktree === "function") {
        return options.cleanupWorktree(request);
      }
      return {
        worktreeRoot: request.worktreeRoot,
        branchName: request.branchName,
        removed: true,
        branchDeleted: true,
      };
    },
    subagentHistory: {
      async upsertIdentity(input) {
        const existing = subagentIdentities.find(
          (identity) =>
            identity.parentConversationId === input.parentConversationId &&
            identity.logicalAgentId === input.logicalAgentId,
        );
        if (existing) {
          existing.updatedAt = input.updatedAt ?? Date.now();
          return existing;
        }
        const identity = {
          parentConversationId: input.parentConversationId,
          logicalAgentId: input.logicalAgentId,
          displayName: input.displayName,
          role: input.role,
          identityPrompt: input.identityPrompt,
          agentId: input.agentId,
          templateName: input.templateName,
          defaultMode: input.defaultMode,
          defaultTaskIntent: input.defaultTaskIntent,
          defaultApplyPolicy: input.defaultApplyPolicy,
          createdParentToolCallId: input.createdParentToolCallId,
          createdAt: input.createdAt ?? Date.now(),
          updatedAt: input.updatedAt ?? Date.now(),
        };
        subagentIdentities.push(identity);
        return identity;
      },
      async persistRunState(input) {
        subagentRunStates.push(input);
      },
      async appendEvent(input) {
        subagentEvents.push(input);
      },
      async appendMessage(input) {
        const record = {
          id: subagentMessages.length + 1,
          parentConversationId: input.parentConversationId,
          seq: subagentMessages.length + 1,
          senderAgentId: input.senderAgentId,
          senderDisplayName: input.senderDisplayName,
          recipientAgentId: input.recipientAgentId,
          recipientDisplayName: input.recipientDisplayName,
          channel: input.channel,
          subject: input.subject,
          bodyMarkdown: input.bodyMarkdown,
          sourceRunId: input.sourceRunId,
          sourceToolCallId: input.sourceToolCallId,
          createdAt: input.createdAt ?? Date.now(),
        };
        subagentMessages.push(record);
        return record;
      },
      async listMessages(input) {
        return subagentMessages.filter((message) => {
          if (message.parentConversationId !== input.parentConversationId) return false;
          if (!input.recipientAgentId) return true;
          return (
            message.recipientAgentId === input.recipientAgentId ||
            (input.includeShared !== false &&
              message.recipientAgentId === "*") ||
            (input.includeSent !== false && message.senderAgentId === input.recipientAgentId)
          );
        });
      },
      async getRun(id) {
        if (typeof options.getSubagentRun === "function") {
          return options.getSubagentRun(id);
        }
        return options.existingSubagentRunRecords?.[id] ?? null;
      },
      async getRunState(id) {
        if (typeof options.getSubagentRunState === "function") {
          return options.getSubagentRunState(id);
        }
        return (
          options.existingSubagentRunStateRecords?.[id] ??
          options.existingSubagentRunRecords?.[id] ??
          null
        );
      },
    },
  });

  return {
    bundle,
    runnerCalls,
    executedBaseToolCalls,
    executedChildToolCalls,
    worktreeCreates,
    worktreeStatuses,
    worktreeApplies,
    worktreeCleanups,
    subagentRunStates,
    subagentIdentities,
    subagentEvents,
    subagentMessages,
    compactionCalls,
    runnerTurnOverrides,
    getMaxActiveRuns: () => maxActiveRuns,
  };
}

test("Agent tool runs delegated subagents with only read-only base tools", async () => {
  const { bundle, runnerCalls, subagentRunStates, subagentIdentities, subagentEvents } =
    createDelegateHarness();

  assert.equal(bundle.groupId, "delegate");
  assert.equal(bundle.tools[0].name, "Agent");
  assert.equal(bundle.metadataByName.get("Agent").isReadOnly, false);
  assert.match(bundle.tools[0].description, /JSON stability rule/);
  assert.match(bundle.tools[0].description, /one Agent call with agent_spec/);
  assert.doesNotMatch(bundle.tools[0].description, /agents\[\]/);
  assert.match(bundle.tools[0].description, /task_intent=communication/);
  assert.match(bundle.tools[0].description, /Messages sent to parent are private/);
  assert.match(bundle.tools[0].description, /apply_policy controls/);
  assert.match(bundle.tools[0].description, /Do not make separate sequential Agent calls/);
  assert.match(bundle.tools[0].description, /fresh private context for the same stable id/);
  assert.equal(bundle.tools[0].parameters.properties.agents, undefined);
  assert.equal(bundle.tools[0].parameters.properties.description, undefined);
  assert.match(
    bundle.tools[0].parameters.properties.agent_spec.description,
    /Plain-text manifest/,
  );
  assert.match(
    bundle.tools[0].parameters.properties.prompt.description,
    /Current task prompt/,
  );
  assert.match(
    bundle.tools[0].parameters.properties.concurrency.description,
    /whole independent batch in parallel/,
  );
  assert.match(
    bundle.tools[0].parameters.properties.resume.description,
    /fresh private context for the same stable id/,
  );

  const result = await bundle.executeToolCall(
    createToolCall({
      agent_id: "reviewer",
      prompt: "Inspect the implementation for obvious issues.",
      mode: "readonly",
    }),
  );

  assert.equal(result.isError, false);
  assert.equal(result.details.kind, "delegate_agent");
  assert.equal(result.details.agentCount, 1);
  assert.equal(result.details.agents[0].agentName, "Reviewer");
  assert.match(result.details.agents[0].runId, /^call-agent:agent:1:/);
  assert.equal(result.details.agents[0].status, "completed");
  assert.match(result.content[0].text, /Delegated agent results: 1 agent/);
  assert.equal(subagentRunStates.at(-1).status, "completed");
  assert.equal(subagentRunStates.at(-1).parentToolCallId, "call-agent");
  assert.equal(subagentRunStates.at(-1).logicalAgentId, "agent-1");
  assert.equal(subagentEvents[0].eventType, "run_start");
  assert.ok(subagentEvents.some((event) => event.eventType === "text_delta"));

  assert.equal(runnerCalls.length, 1);
  assert.deepEqual(
    runnerCalls[0].tools.map((tool) => tool.name),
    ["Read", "Grep", "mcp_docs_search", "SendMessage"],
  );
  assert.match(runnerCalls[0].context.systemPrompt, /isolated read-only context/);
  assert.match(runnerCalls[0].context.systemPrompt, /You are Reviewer, a named delegated LiveAgent subagent/);
  assert.match(runnerCalls[0].context.systemPrompt, /Stable subagent identity:/);
  assert.match(runnerCalls[0].context.systemPrompt, /- Name: Reviewer/);
  assert.match(runnerCalls[0].context.systemPrompt, /- Stable id: agent-1/);
  assert.match(runnerCalls[0].context.systemPrompt, /- Role: Review code paths/);
  assert.match(runnerCalls[0].context.systemPrompt, /- Team position: 1 of 1/);
  assert.match(runnerCalls[0].context.systemPrompt, /Identity instructions:/);
  assert.match(runnerCalls[0].context.messages[0].content, /Delegated agent name: Reviewer/);
  assert.match(runnerCalls[0].context.messages[0].content, /Delegated agent id: agent-1/);
  assert.match(runnerCalls[0].context.messages[0].content, /Delegated agent role: Review code paths/);
  assert.match(runnerCalls[0].context.messages[0].content, /Current task:/);
  assert.match(runnerCalls[0].context.systemPrompt, /MCP business tools/);
  assert.match(runnerCalls[0].context.systemPrompt, /Focus on concrete defects/);
  assert.doesNotMatch(runnerCalls[0].context.systemPrompt, /model turns|turn budget|max_turns/);
  assert.equal(typeof runnerCalls[0].onBeforeNextTurn, "function");
  assert.equal(runnerCalls[0].sessionId, "parent-session:subagent:agent-1");
  assert.equal(subagentIdentities.length, 1);
  assert.equal(subagentIdentities[0].displayName, "Reviewer");
  assert.equal(subagentIdentities[0].role, "Review code paths");
});

test("Agent tool rejects legacy description-only input", async () => {
  const { bundle } = createDelegateHarness();
  const legacyKey = "description";

  await assert.rejects(
    () => bundle.executeToolCall(createToolCall({ [legacyKey]: "Inspect safely." })),
    /must include prompt/,
  );
  await assert.rejects(
    () =>
      bundle.executeToolCall(
        createToolCall({
          agent_spec: [`@agent id=legacy`, `${legacyKey}: Inspect safely.`].join("\n"),
        }),
      ),
    /must include at least one agent with prompt/,
  );
});

test("Agent history chunks thinking delta events", async () => {
  const { bundle, subagentEvents } = createDelegateHarness({
    thinkingDeltas: [
      "a".repeat(800),
      "b".repeat(800),
      "c".repeat(800),
      "d".repeat(800),
      "e".repeat(800),
    ],
  });

  const result = await bundle.executeToolCall(
    createToolCall({
      prompt: "Return a short answer.",
    }),
  );

  assert.equal(result.isError, false);
  const thinkingEvents = subagentEvents.filter(
    (event) => event.eventType === "thinking_delta",
  );
  assert.equal(thinkingEvents.length, 2);
  assert.equal(thinkingEvents[0].payload.delta.length, 2400);
  assert.equal(thinkingEvents[1].payload.delta.length, 1600);
});

test("Agent exposes SendMessage to delegated subagents and persists Markdown bus entries", async () => {
  const { bundle, runnerCalls, subagentMessages, subagentEvents } = createDelegateHarness({
    runnerToolCalls: [
      {
        type: "toolCall",
        id: "call-send-message",
        name: "SendMessage",
        arguments: {
          to: "parent",
          channel: "question",
          subject: "Need decision",
          message: "Should we keep the readonly path?",
        },
      },
    ],
  });

  const result = await bundle.executeToolCall(
    createToolCall({
      prompt: "Ask the parent a question through the bus.",
      mode: "readonly",
    }),
  );

  assert.equal(result.isError, false);
  assert.deepEqual(
    runnerCalls[0].tools.map((tool) => tool.name),
    ["Read", "Grep", "mcp_docs_search", "SendMessage"],
  );
  assert.equal(subagentMessages.length, 1);
  assert.equal(subagentMessages[0].senderAgentId, "agent-1");
  assert.equal(subagentMessages[0].senderDisplayName, "Agent 1");
  assert.equal(subagentMessages[0].recipientAgentId, "parent");
  assert.equal(subagentMessages[0].channel, "question");
  assert.equal(subagentMessages[0].subject, "Need decision");
  assert.equal(subagentMessages[0].bodyMarkdown, "Should we keep the readonly path?");
  assert.match(subagentMessages[0].sourceRunId, /^call-agent:agent:1:/);
  assert.equal(subagentMessages[0].sourceToolCallId, "call-send-message");
  assert.ok(
    subagentEvents.some(
      (event) =>
        event.eventType === "tool_result" &&
        event.toolName === "SendMessage" &&
        event.payload?.toolResult?.details?.kind === "subagent_message",
    ),
  );
});

test("SendMessage defaults shared-channel messages to all agents when to is omitted", async () => {
  const { bundle, subagentMessages } = createDelegateHarness({
    runnerToolCalls: [
      {
        type: "toolCall",
        id: "call-shared-no-to",
        name: "SendMessage",
        arguments: {
          channel: "shared",
          subject: "Shared update",
          message: "Peer-visible Markdown update.",
        },
      },
    ],
  });

  const result = await bundle.executeToolCall(
    createToolCall({
      prompt: "Broadcast one shared update through the bus.",
      mode: "readonly",
    }),
  );

  assert.equal(result.isError, false);
  assert.equal(subagentMessages.length, 1);
  assert.equal(subagentMessages[0].recipientAgentId, "*");
  assert.equal(subagentMessages[0].recipientDisplayName, "All Agents");
  assert.equal(subagentMessages[0].channel, "shared");
  assert.equal(subagentMessages[0].subject, "Shared update");
  assert.equal(subagentMessages[0].bodyMarkdown, "Peer-visible Markdown update.");
});

test("SendMessage keeps parent-targeted messages private even with shared channel", async () => {
  const { bundle, subagentMessages } = createDelegateHarness({
    runnerToolCalls: [
      {
        type: "toolCall",
        id: "call-parent-shared-channel",
        name: "SendMessage",
        arguments: {
          to: "parent",
          channel: "shared",
          subject: "Private parent note",
          message: "This should stay in the parent inbox.",
        },
      },
    ],
  });

  const result = await bundle.executeToolCall(
    createToolCall({
      prompt: "Send one parent-private update.",
      mode: "readonly",
    }),
  );

  assert.equal(result.isError, false);
  assert.equal(subagentMessages.length, 1);
  assert.equal(subagentMessages[0].recipientAgentId, "parent");
  assert.equal(subagentMessages[0].recipientDisplayName, "Parent Agent");
  assert.equal(subagentMessages[0].channel, "direct");
  assert.equal(subagentMessages[0].bodyMarkdown, "This should stay in the parent inbox.");
});

test("Agent resumes existing delegated subagents by stable id", async () => {
  const previousRun = {
    id: "run-existing-expert",
    parentConversationId: "conversation-1",
    parentToolCallId: "call-agent-old",
    parentToolName: "Agent",
    agentIndex: 0,
    agentTotal: 1,
    logicalAgentId: "expert-a",
    agentName: "Existing Expert",
    description: "Existing expert",
    mode: "readonly",
    status: "completed",
    providerId: "codex",
    model: "gpt-5",
    sessionId: "parent-session:subagent:expert-a",
    messageCount: 2,
    roundCount: 1,
    toolCallCount: 0,
    compactionCount: 0,
    summary: "Previous expert summary",
    startedAt: 1,
    endedAt: 2,
    updatedAt: 3,
  };
  const previousRecord = {
    ...previousRun,
    contextMetaJson: JSON.stringify({
      schemaVersion: 3,
      systemPrompt: "previous system",
      activeSegmentIndex: 0,
      totalSegmentCount: 1,
      totalMessageCount: 2,
    }),
    activeSegmentIndex: 0,
    totalSegmentCount: 1,
    totalMessageCount: 2,
    createdAt: 1,
    segments: [
      {
        segmentIndex: 0,
        segmentId: "segment-existing",
        messagesJson: JSON.stringify([
          {
            role: "user",
            content: "Original expert task",
            timestamp: 1,
          },
          createAssistant("previous answer from expert"),
        ]),
        messageCount: 2,
        createdAt: 1,
        updatedAt: 2,
      },
    ],
    events: [],
  };
  const { bundle, runnerCalls, subagentRunStates, subagentEvents } = createDelegateHarness({
    existingSubagentIdentities: [
      createSubagentIdentity({
        logicalAgentId: "expert-a",
        displayName: "Existing Expert",
        role: "Existing expert",
      }),
    ],
    existingSubagentRuns: [previousRun],
    existingSubagentRunRecords: {
      "run-existing-expert": previousRecord,
    },
  });

  const result = await bundle.executeToolCall(
    createToolCall({
      id: "expert-a",
      prompt: "Answer the new follow-up in one sentence.",
    }),
  );

  assert.equal(result.isError, false);
  assert.equal(result.details.agents[0].name, "Existing Expert");
  assert.equal(result.details.agents[0].mode, "readonly");
  assert.equal(runnerCalls[0].sessionId, "parent-session:subagent:expert-a");
  assert.deepEqual(
    runnerCalls[0].tools.map((tool) => tool.name),
    ["Read", "Grep", "mcp_docs_search", "SendMessage"],
  );
  assert.match(runnerCalls[0].context.systemPrompt, /You are Existing Expert, a named delegated LiveAgent subagent/);
  assert.match(runnerCalls[0].context.messages.at(-1).content[0].text, /Agent name: Existing Expert/);
  assert.match(runnerCalls[0].context.messages[1].content[0].text, /previous answer from expert/);
  assert.match(runnerCalls[0].context.messages.at(-1).content[0].text, /Continue your existing delegated agent session/);
  assert.match(runnerCalls[0].context.messages.at(-1).content[0].text, /Answer the new follow-up/);
  assert.ok(subagentEvents.some((event) => event.eventType === "resume_loaded"));
  assert.equal(subagentRunStates.at(-1).logicalAgentId, "expert-a");
  assert.equal(subagentRunStates.at(-1).agentName, "Existing Expert");
});

test("Agent resume=false starts fresh context while preserving existing identity", async () => {
  const previousRun = {
    id: "run-existing-expert",
    parentConversationId: "conversation-1",
    parentToolCallId: "call-agent-old",
    parentToolName: "Agent",
    agentIndex: 0,
    agentTotal: 1,
    logicalAgentId: "expert-a",
    agentName: "Existing Expert",
    description: "Existing expert",
    mode: "readonly",
    status: "completed",
    providerId: "codex",
    model: "gpt-5",
    sessionId: "parent-session:subagent:expert-a",
    messageCount: 2,
    roundCount: 1,
    toolCallCount: 0,
    compactionCount: 0,
    summary: "Previous expert summary",
    startedAt: 1,
    endedAt: 2,
    updatedAt: 3,
  };
  let getRunStateCalls = 0;
  const { bundle, runnerCalls, subagentRunStates, subagentEvents } =
    createDelegateHarness({
      existingSubagentIdentities: [
        createSubagentIdentity({
          logicalAgentId: "expert-a",
          displayName: "Existing Expert",
          role: "Existing expert",
          identityPrompt: "Original expert identity prompt",
        }),
      ],
      existingSubagentRuns: [previousRun],
      getSubagentRunState() {
        getRunStateCalls += 1;
        throw new Error("resume=false should not load previous state");
      },
    });

  const result = await bundle.executeToolCall(
    createToolCall({
      id: "expert-a",
      name: "Different Persona",
      role: "Different role",
      identity: "Different identity prompt",
      prompt: "Start from a clean private context for this one question.",
      resume: false,
    }),
  );

  assert.equal(result.isError, false);
  assert.equal(result.details.agents[0].id, "expert-a");
  assert.equal(result.details.agents[0].name, "Existing Expert");
  assert.equal(result.details.agents[0].role, "Existing expert");
  assert.equal(getRunStateCalls, 0);
  assert.match(
    runnerCalls[0].sessionId,
    /^parent-session:subagent:expert-a:fresh:/,
  );
  assert.equal(runnerCalls[0].context.messages.length, 1);
  assert.match(runnerCalls[0].context.systemPrompt, /You are Existing Expert, a named delegated LiveAgent subagent/);
  assert.match(runnerCalls[0].context.systemPrompt, /Original expert identity prompt/);
  assert.doesNotMatch(runnerCalls[0].context.systemPrompt, /Different Persona/);
  assert.doesNotMatch(runnerCalls[0].context.systemPrompt, /Different identity prompt/);
  assert.match(runnerCalls[0].context.messages[0].content, /Start from a clean private context/);
  assert.doesNotMatch(runnerCalls[0].context.messages[0].content, /Continue your existing delegated agent session/);
  assert.ok(!subagentEvents.some((event) => event.eventType === "resume_loaded"));
  assert.equal(subagentRunStates.at(-1).logicalAgentId, "expert-a");
  assert.equal(subagentRunStates.at(-1).agentName, "Existing Expert");
});

test("Agent prefers state-only subagent history when resuming", async () => {
  const previousRun = {
    id: "run-state-only",
    parentConversationId: "conversation-1",
    parentToolCallId: "call-agent-old",
    parentToolName: "Agent",
    agentIndex: 0,
    agentTotal: 1,
    logicalAgentId: "expert-a",
    agentName: "Existing Expert",
    description: "Existing expert",
    mode: "readonly",
    status: "completed",
    providerId: "codex",
    model: "gpt-5",
    sessionId: "parent-session:subagent:expert-a",
    messageCount: 2,
    roundCount: 1,
    toolCallCount: 0,
    compactionCount: 0,
    summary: "Previous expert summary",
    startedAt: 1,
    endedAt: 2,
    updatedAt: 3,
  };
  const previousRecord = {
    ...previousRun,
    contextMetaJson: JSON.stringify({
      schemaVersion: 3,
      systemPrompt: "previous system",
      activeSegmentIndex: 0,
      totalSegmentCount: 1,
      totalMessageCount: 2,
    }),
    activeSegmentIndex: 0,
    totalSegmentCount: 1,
    totalMessageCount: 2,
    createdAt: 1,
    segments: [
      {
        segmentIndex: 0,
        segmentId: "segment-existing",
        messagesJson: JSON.stringify([
          {
            role: "user",
            content: "Original expert task",
            timestamp: 1,
          },
          createAssistant("previous answer from expert"),
        ]),
        messageCount: 2,
        createdAt: 1,
        updatedAt: 2,
      },
    ],
    events: [],
  };
  let stateOnlyLoads = 0;
  let fullLoads = 0;
  const { bundle, runnerCalls } = createDelegateHarness({
    existingSubagentIdentities: [
      createSubagentIdentity({
        logicalAgentId: "expert-a",
        displayName: "Existing Expert",
        role: "Existing expert",
      }),
    ],
    existingSubagentRuns: [previousRun],
    async getSubagentRunState(id) {
      stateOnlyLoads += 1;
      assert.equal(id, "run-state-only");
      return previousRecord;
    },
    async getSubagentRun(id) {
      fullLoads += 1;
      assert.equal(id, "run-state-only");
      return previousRecord;
    },
  });

  const result = await bundle.executeToolCall(
    createToolCall({
      id: "expert-a",
      prompt: "Answer the new follow-up in one sentence.",
    }),
  );

  assert.equal(result.isError, false);
  assert.equal(stateOnlyLoads, 1);
  assert.equal(fullLoads, 0);
  assert.match(runnerCalls[0].context.messages[1].content[0].text, /previous answer from expert/);
});

test("Agent resumes existing subagents from hot runtime state before SQLite history", async () => {
  const previousRun = {
    id: "run-hot-expert",
    parentConversationId: "conversation-1",
    parentToolCallId: "call-agent-old",
    parentToolName: "Agent",
    agentIndex: 0,
    agentTotal: 1,
    logicalAgentId: "expert-a",
    agentName: "Existing Expert",
    description: "Existing expert",
    mode: "readonly",
    status: "completed",
    providerId: "codex",
    model: "gpt-5",
    sessionId: "parent-session:subagent:expert-a",
    messageCount: 2,
    roundCount: 1,
    toolCallCount: 0,
    compactionCount: 0,
    summary: "Previous expert summary",
    startedAt: 1,
    endedAt: 2,
    updatedAt: 3,
  };
  const hotState = createConversationState([
    {
      role: "user",
      content: "Original expert task",
      timestamp: 1,
    },
    createAssistant("hot previous answer from expert"),
  ]);
  let historyLoads = 0;
  const runtimeRequests = [];
  const remembered = [];
  const { bundle, runnerCalls, subagentEvents } = createDelegateHarness({
    existingSubagentIdentities: [
      createSubagentIdentity({
        logicalAgentId: "expert-a",
        displayName: "Existing Expert",
        role: "Existing expert",
      }),
    ],
    existingSubagentRuns: [previousRun],
    async getSubagentRunState() {
      historyLoads += 1;
      throw new Error("history state should not be loaded when hot runtime state exists");
    },
    subagentRuntimeManager: {
      warmupConversation() {},
      getHydratedState(input) {
        runtimeRequests.push(input);
        return hotState;
      },
      async hydrateState() {
        return hotState;
      },
      rememberRunState(input) {
        remembered.push(input);
      },
      invalidateConversation() {},
      disposeConversation() {},
      disposeAll() {},
    },
  });

  const result = await bundle.executeToolCall(
    createToolCall({
      id: "expert-a",
      prompt: "Answer the new follow-up in one sentence.",
    }),
  );

  assert.equal(result.isError, false);
  assert.equal(historyLoads, 0);
  assert.equal(runtimeRequests.length, 1);
  assert.match(
    runnerCalls[0].context.messages[1].content[0].text,
    /hot previous answer from expert/,
  );
  assert.ok(
    subagentEvents.some(
      (event) => event.eventType === "resume_loaded" && event.payload?.source === "memory",
    ),
  );
  assert.ok(remembered.some((item) => item.input.logicalAgentId === "expert-a"));
});

test("Agent upgrades resumed readonly subagents to worktree for later file output", async () => {
  const previousRun = {
    id: "run-existing-writer",
    parentConversationId: "conversation-1",
    parentToolCallId: "call-agent-old",
    parentToolName: "Agent",
    agentIndex: 0,
    agentTotal: 1,
    logicalAgentId: "writer-a",
    agentName: "Existing Writer",
    description: "Existing writer",
    mode: "readonly",
    status: "completed",
    providerId: "codex",
    model: "gpt-5",
    sessionId: "parent-session:subagent:writer-a",
    messageCount: 2,
    roundCount: 1,
    toolCallCount: 0,
    compactionCount: 0,
    summary: "Previous writer summary",
    startedAt: 1,
    endedAt: 2,
    updatedAt: 3,
  };
  const previousRecord = {
    ...previousRun,
    contextMetaJson: JSON.stringify({
      schemaVersion: 3,
      systemPrompt: "previous readonly system",
      activeSegmentIndex: 0,
      totalSegmentCount: 1,
      totalMessageCount: 2,
    }),
    activeSegmentIndex: 0,
    totalSegmentCount: 1,
    totalMessageCount: 2,
    createdAt: 1,
    segments: [
      {
        segmentIndex: 0,
        segmentId: "segment-existing-writer",
        messagesJson: JSON.stringify([
          {
            role: "user",
            content: "Original writer task",
            timestamp: 1,
          },
          createAssistant("previous answer from writer"),
        ]),
        messageCount: 2,
        createdAt: 1,
        updatedAt: 2,
      },
    ],
    events: [],
  };
  const {
    bundle,
    runnerCalls,
    worktreeCreates,
    worktreeApplies,
    subagentEvents,
  } = createDelegateHarness({
    existingSubagentIdentities: [
      createSubagentIdentity({
        logicalAgentId: "writer-a",
        displayName: "Existing Writer",
        role: "Existing writer",
      }),
    ],
    existingSubagentRuns: [previousRun],
    existingSubagentRunRecords: {
      "run-existing-writer": previousRecord,
    },
    worktreeStatus: {
      changed: true,
      status: "?? docs/answer.md",
      diff_stat: " docs/answer.md | 20 +",
      diff: "diff --git a/docs/answer.md b/docs/answer.md",
      diff_truncated: false,
      untracked_files: ["docs/answer.md"],
    },
  });

  const result = await bundle.executeToolCall(
    createToolCall({
      id: "writer-a",
      prompt: "请延续之前的分析，并把最终结果写入 docs/answer.md 文件。",
      allowed_output_paths: ["/tmp/liveagent-delegate-test/docs/answer.md"],
    }),
  );

  const agent = result.details.agents[0];
  assert.equal(result.isError, false);
  assert.equal(agent.name, "Existing Writer");
  assert.equal(agent.mode, "worktree");
  assert.equal(agent.taskIntent, "document_generation");
  assert.equal(agent.applyPolicy, "explicit");
  assert.equal(agent.applyStatus, "applied");
  assert.deepEqual(agent.allowedOutputPaths, ["docs/answer.md"]);
  assert.equal(worktreeCreates.length, 1);
  assert.equal(worktreeApplies.length, 1);
  assert.deepEqual(
    runnerCalls[0].tools.map((tool) => tool.name),
    ["Read", "Grep", "Write", "Bash", "mcp_docs_search", "SendMessage"],
  );
  assert.match(runnerCalls[0].context.systemPrompt, /isolated git worktree/);
  assert.match(
    runnerCalls[0].context.messages.at(-1).content[0].text,
    /Execution mode changed: readonly -> worktree/,
  );
  assert.ok(subagentEvents.some((event) => event.eventType === "resume_loaded"));
});

test("Agent uses stored identity when the latest run snapshot has a generated name", async () => {
  const originalRun = {
    id: "run-original-philosopher",
    parentConversationId: "conversation-1",
    parentToolCallId: "call-agent-original",
    parentToolName: "Agent",
    agentIndex: 0,
    agentTotal: 4,
    logicalAgentId: "agent-1",
    agentName: "哲学家 - 苏格拉底",
    description: "哲学视角探讨生命的意义",
    mode: "readonly",
    status: "completed",
    providerId: "codex",
    model: "gpt-5",
    sessionId: "parent-session:subagent:agent-1",
    messageCount: 2,
    roundCount: 1,
    toolCallCount: 0,
    compactionCount: 0,
    summary: "Original philosopher summary",
    startedAt: 1,
    endedAt: 2,
    updatedAt: 10,
  };
  const latestRun = {
    ...originalRun,
    id: "run-latest-generated-name",
    parentToolCallId: "call-agent-latest",
    agentName: "Agent 1",
    description: "哲学家回应神经科学家的观点",
    summary: "Latest generated-name summary",
    updatedAt: 20,
  };
  const latestRecord = {
    ...latestRun,
    contextMetaJson: JSON.stringify({
      schemaVersion: 3,
      systemPrompt: "previous generated-name system",
      activeSegmentIndex: 0,
      totalSegmentCount: 1,
      totalMessageCount: 2,
    }),
    activeSegmentIndex: 0,
    totalSegmentCount: 1,
    totalMessageCount: 2,
    createdAt: 10,
    segments: [
      {
        segmentIndex: 0,
        segmentId: "segment-latest",
        messagesJson: JSON.stringify([
          {
            role: "user",
            content: "Previous generated-name continuation",
            timestamp: 10,
          },
          createAssistant("previous answer from philosopher"),
        ]),
        messageCount: 2,
        createdAt: 10,
        updatedAt: 20,
      },
    ],
    events: [],
  };
  const { bundle, runnerCalls, subagentRunStates } = createDelegateHarness({
    existingSubagentIdentities: [
      createSubagentIdentity({
        logicalAgentId: "agent-1",
        displayName: "哲学家 - 苏格拉底",
        role: "哲学视角探讨生命的意义",
        identityPrompt: "你是哲学家 - 苏格拉底，始终从苏格拉底式哲学视角回应。",
      }),
    ],
    existingSubagentRuns: [latestRun, originalRun],
    existingSubagentRunRecords: {
      "run-latest-generated-name": latestRecord,
    },
  });

  const result = await bundle.executeToolCall(
    createToolCall({
      id: "agent-1",
      prompt: "继续用苏格拉底身份回答。",
    }),
  );

  assert.equal(result.isError, false);
  assert.equal(result.details.agents[0].name, "哲学家 - 苏格拉底");
  assert.equal(subagentRunStates.at(-1).agentName, "哲学家 - 苏格拉底");
  assert.match(runnerCalls[0].context.systemPrompt, /You are 哲学家 - 苏格拉底, a named delegated LiveAgent subagent/);
  assert.match(runnerCalls[0].context.messages.at(-1).content[0].text, /Agent name: 哲学家 - 苏格拉底/);
});

test("Agent canonicalizes phase-specific roleplay calls to the original stable agent", async () => {
  const { bundle, runnerCalls, subagentRunStates } = createDelegateHarness();

  const first = await bundle.executeToolCall(
    createToolCall({
      id: "player-zhangsan",
      name: "张三",
      prompt: "你是张三，45岁商人，狼人。等待法官叫到你时发言。",
      mode: "readonly",
      task_intent: "communication",
    }),
  );

  assert.equal(first.isError, false);
  assert.equal(first.details.agents[0].id, "player-zhangsan");
  assert.equal(first.details.agents[0].name, "张三");

  const second = await bundle.executeToolCall(
    createToolCall({
      id: "day1-player-zhangsan",
      name: "day1-张三",
      prompt: "你是张三，现在是第一天白天。请继续保持沉稳商人的语气发言。",
      mode: "readonly",
      task_intent: "communication",
    }),
  );

  assert.equal(second.isError, false);
  assert.equal(second.details.agents[0].id, "player-zhangsan");
  assert.equal(second.details.agents[0].name, "张三");
  assert.match(second.content[0].text, /Agent roster canonicalization/);
  assert.match(second.content[0].text, /day1-player-zhangsan/);
  assert.equal(subagentRunStates.at(-1).logicalAgentId, "player-zhangsan");
  assert.equal(subagentRunStates.at(-1).agentName, "张三");
  assert.equal(runnerCalls[1].sessionId, "parent-session:subagent:player-zhangsan");
  assert.match(runnerCalls[1].context.systemPrompt, /You are 张三, a named delegated LiveAgent subagent/);
});

test("Agent does not canonicalize boundary-overlapping stable ids", async () => {
  const { bundle, runnerCalls, subagentRunStates } = createDelegateHarness({
    existingSubagentIdentities: [
      createSubagentIdentity({
        logicalAgentId: "player1",
        displayName: "Player 1",
        role: "Existing player one",
        defaultTaskIntent: "communication",
      }),
    ],
  });

  const result = await bundle.executeToolCall(
    createToolCall({
      id: "player10",
      name: "Player 10",
      prompt: "You are Player 10. Reply independently in one sentence.",
      mode: "readonly",
      task_intent: "communication",
    }),
  );

  assert.equal(result.isError, false);
  assert.equal(result.details.agents[0].id, "player10");
  assert.equal(result.details.agents[0].name, "Player 10");
  assert.doesNotMatch(result.content[0].text, /Agent roster canonicalization/);
  assert.equal(subagentRunStates.at(-1).logicalAgentId, "player10");
  assert.equal(subagentRunStates.at(-1).agentName, "Player 10");
  assert.match(runnerCalls[0].context.systemPrompt, /You are Player 10, a named delegated LiveAgent subagent/);
  assert.doesNotMatch(runnerCalls[0].context.systemPrompt, /Existing player one/);
});

test("Agent rejects duplicate stable ids after roster canonicalization", async () => {
  const { bundle, runnerCalls } = createDelegateHarness({
    existingSubagentIdentities: [
      createSubagentIdentity({
        logicalAgentId: "player-zhangsan",
        displayName: "张三",
        role: "狼人 - 沉稳老练的中年商人",
        defaultTaskIntent: "communication",
      }),
    ],
  });

  const result = await bundle.executeToolCall(
    createToolCall({
      mode: "readonly",
      task_intent: "communication",
      agent_spec: `
@agent id=player-zhangsan
name: 张三
prompt: 请继续说明你的第一天策略。
---
@agent id=day1-player-zhangsan
name: day1-张三
prompt: 你是张三，现在是第一天白天。请继续发言。
`,
    }),
  );

  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /multiple delegated-agent requests resolve to the same stable delegated-agent id/);
  assert.match(result.content[0].text, /Duplicate stable id: player-zhangsan/);
  assert.match(result.content[0].text, /Agent roster canonicalization/);
  assert.match(result.content[0].text, /day1-player-zhangsan/);
  assert.equal(runnerCalls.length, 0);
});

test("Agent serializes concurrent runs for the same stable delegated id", async () => {
  const { bundle, runnerCalls, getMaxActiveRuns } = createDelegateHarness({
    runnerDelayMs: 20,
    existingSubagentIdentities: [
      createSubagentIdentity({
        logicalAgentId: "expert-a",
        displayName: "Existing Expert",
        role: "Existing expert",
      }),
    ],
  });
  const firstCall = createToolCall({
    id: "expert-a",
    prompt: "First same-agent request.",
    mode: "readonly",
  });
  firstCall.id = "call-agent-first";
  const secondCall = createToolCall({
    id: "expert-a",
    prompt: "Second same-agent request.",
    mode: "readonly",
  });
  secondCall.id = "call-agent-second";

  const [first, second] = await Promise.all([
    bundle.executeToolCall(firstCall),
    bundle.executeToolCall(secondCall),
  ]);

  assert.equal(first.isError, false);
  assert.equal(second.isError, false);
  assert.equal(runnerCalls.length, 2);
  assert.equal(getMaxActiveRuns(), 1);
});

test("Agent roster is identity-first and ignores contaminated phase runs", async () => {
  const originalRun = {
    id: "run-player-zhangsan",
    parentConversationId: "conversation-1",
    parentToolCallId: "call-agent-original",
    parentToolName: "Agent",
    agentIndex: 0,
    agentTotal: 1,
    logicalAgentId: "player-zhangsan",
    agentName: "张三",
    description: "狼人 - 沉稳老练的中年商人",
    mode: "readonly",
    status: "completed",
    providerId: "codex",
    model: "gpt-5",
    sessionId: "parent-session:subagent:player-zhangsan",
    messageCount: 2,
    roundCount: 1,
    toolCallCount: 0,
    compactionCount: 0,
    summary: "初始身份建立",
    startedAt: 1,
    endedAt: 2,
    updatedAt: 10,
  };
  const contaminatedRun = {
    ...originalRun,
    id: "run-day1-zhangsan",
    parentToolCallId: "call-agent-day1",
    logicalAgentId: "day1-player-zhangsan",
    agentName: "day1-张三",
    description: "张三白天发言-狼人",
    summary: "张三白天继续伪装",
    sessionId: "parent-session:subagent:day1-player-zhangsan",
    updatedAt: 20,
  };
  const { bundle, runnerCalls } = createDelegateHarness({
    existingSubagentIdentities: [
      createSubagentIdentity({
        logicalAgentId: "player-zhangsan",
        displayName: "张三",
        role: "狼人 - 沉稳老练的中年商人",
        defaultTaskIntent: "communication",
      }),
    ],
    existingSubagentRuns: [contaminatedRun, originalRun],
  });

  assert.match(bundle.tools[0].description, /id=player-zhangsan/);
  assert.match(bundle.tools[0].description, /summary=初始身份建立/);
  assert.doesNotMatch(bundle.tools[0].description, /id=day1-player-zhangsan/);
  assert.doesNotMatch(bundle.tools[0].description, /张三白天继续伪装/);

  const result = await bundle.executeToolCall(
    createToolCall({
      id: "day1-player-zhangsan",
      name: "day1-张三",
      prompt: "你是张三，请继续白天发言。",
      mode: "readonly",
      task_intent: "communication",
    }),
  );

  assert.equal(result.isError, false);
  assert.equal(result.details.agents[0].id, "player-zhangsan");
  assert.equal(result.details.agents[0].name, "张三");
  assert.equal(runnerCalls[0].sessionId, "parent-session:subagent:player-zhangsan");
});

test("Agent rejects aggregate phase agents that should resume the existing roster", async () => {
  const { bundle, runnerCalls } = createDelegateHarness();

  const initial = await bundle.executeToolCall(
    createToolCall({
      mode: "readonly",
      task_intent: "communication",
      agent_spec: `
@agent id=player-zhangsan
name: 张三
prompt: 你是张三，狼人。
---
@agent id=player-zhaoliu
name: 赵六
prompt: 你是赵六，狼人。
`,
    }),
  );

  assert.equal(initial.isError, false);
  assert.equal(runnerCalls.length, 2);

  const rejected = await bundle.executeToolCall(
    createToolCall({
      id: "werewolves-night1",
      name: "狼人会议",
      prompt: "【张三】和【赵六】现在要进行夜间商议，并给出最终击杀目标。",
      mode: "readonly",
      task_intent: "communication",
    }),
  );

  assert.equal(rejected.isError, true);
  assert.match(rejected.content[0].text, /appears to create a new communication subagent/);
  assert.match(rejected.content[0].text, /id=player-zhangsan/);
  assert.match(rejected.content[0].text, /id=player-zhaoliu/);
  assert.match(rejected.content[0].text, /Referenced existing agents: .*player-zhangsan.*player-zhaoliu/);
  assert.equal(runnerCalls.length, 2);

  const rejectedWithFreshContext = await bundle.executeToolCall(
    createToolCall({
      id: "werewolves-night1",
      name: "狼人会议",
      prompt: "【张三】和【赵六】现在要进行夜间商议，并给出最终击杀目标。",
      mode: "readonly",
      task_intent: "communication",
      resume: false,
    }),
  );

  assert.equal(rejectedWithFreshContext.isError, true);
  assert.match(
    rejectedWithFreshContext.content[0].text,
    /resume=false only when you need a fresh private context for the same stable id/,
  );
  assert.equal(runnerCalls.length, 2);
});

test("Agent pre-compacts restored delegated subagent history before appending continuation", async () => {
  const previousRun = {
    id: "run-long-lived-expert",
    parentConversationId: "conversation-1",
    parentToolCallId: "call-agent-old",
    parentToolName: "Agent",
    agentIndex: 0,
    agentTotal: 1,
    logicalAgentId: "expert-a",
    description: "Long lived expert",
    mode: "readonly",
    status: "completed",
    providerId: "codex",
    model: "gpt-5",
    sessionId: "parent-session:subagent:expert-a",
    messageCount: 2,
    roundCount: 1,
    toolCallCount: 0,
    compactionCount: 0,
    summary: "Previous expert summary",
    startedAt: 1,
    endedAt: 2,
    updatedAt: 3,
  };
  const previousRecord = {
    ...previousRun,
    contextMetaJson: JSON.stringify({
      schemaVersion: 3,
      systemPrompt: "previous system",
      activeSegmentIndex: 0,
      totalSegmentCount: 1,
      totalMessageCount: 2,
    }),
    activeSegmentIndex: 0,
    totalSegmentCount: 1,
    totalMessageCount: 2,
    createdAt: 1,
    segments: [
      {
        segmentIndex: 0,
        segmentId: "segment-existing",
        messagesJson: JSON.stringify([
          {
            role: "user",
            content: "Original expert task",
            timestamp: 1,
          },
          createAssistant("previous answer from expert"),
        ]),
        messageCount: 2,
        createdAt: 1,
        updatedAt: 2,
      },
    ],
    events: [],
  };
  const { bundle, runnerCalls, compactionCalls, subagentRunStates, subagentEvents } =
    createDelegateHarness({
      existingSubagentIdentities: [
        createSubagentIdentity({
          logicalAgentId: "expert-a",
          displayName: "Existing Expert",
          role: "Long lived expert",
        }),
      ],
      existingSubagentRuns: [previousRun],
      existingSubagentRunRecords: {
        "run-long-lived-expert": previousRecord,
      },
      mockCompaction: true,
      preCompactionApplied: true,
    });

  const result = await bundle.executeToolCall(
    createToolCall({
      id: "expert-a",
      prompt: "Use the prior private history, then answer the new question.",
    }),
  );

  assert.equal(result.isError, false);
  assert.equal(compactionCalls.length, 1);
  assert.equal(compactionCalls[0].phase, "pre");
  assert.match(runnerCalls[0].context.systemPrompt, /Mock pre compacted summary/);
  assert.equal(runnerCalls[0].context.messages.length, 1);
  assert.match(runnerCalls[0].context.messages[0].content[0].text, /Continue your existing delegated agent session/);
  assert.ok(subagentEvents.some((event) => event.eventType === "pre_compaction_completed"));

  const completedState = subagentRunStates.at(-1);
  assert.equal(completedState.status, "completed");
  assert.equal(completedState.compactionCount, 1);
  assert.equal(completedState.state.meta.totalSegmentCount, 2);
});

test("Agent tool enforces concurrency for batched delegated subagents", async () => {
  const { bundle, runnerCalls, getMaxActiveRuns } = createDelegateHarness({
    runnerDelayMs: 20,
  });

  const result = await bundle.executeToolCall(
    createToolCall({
      concurrency: 2,
      mode: "readonly",
      agent_spec: `
@agent id=a
prompt: Inspect A.
---
@agent id=b
prompt: Inspect B.
---
@agent id=c
prompt: Inspect C.
`,
    }),
  );

  assert.equal(result.isError, false);
  assert.equal(result.details.agentCount, 3);
  assert.equal(result.details.concurrency, 2);
  assert.equal(runnerCalls.length, 3);
  assert.equal(getMaxActiveRuns(), 2);
});

test("Agent tool runs independent batches in parallel by default", async () => {
  const { bundle, runnerCalls, getMaxActiveRuns } = createDelegateHarness({
    runnerDelayMs: 20,
  });

  const result = await bundle.executeToolCall(
    createToolCall({
      mode: "readonly",
      agent_spec: `
@agent id=a
prompt: Inspect A.
---
@agent id=b
prompt: Inspect B.
---
@agent id=c
prompt: Inspect C.
`,
    }),
  );

  assert.equal(result.isError, false);
  assert.equal(result.details.agentCount, 3);
  assert.equal(result.details.concurrency, 3);
  assert.equal(runnerCalls.length, 3);
  assert.equal(getMaxActiveRuns(), 3);
});

test("Agent tool shares one scheduler across concurrent delegate calls", async () => {
  const { bundle, runnerCalls, getMaxActiveRuns } = createDelegateHarness({
    runnerDelayMs: 20,
    subagentSchedulerLimits: { maxParallelSubagents: 2 },
  });

  const callA = {
    ...createToolCall({
      mode: "readonly",
      agent_spec: `
@agent id=a1
prompt: Inspect A1.
---
@agent id=a2
prompt: Inspect A2.
---
@agent id=a3
prompt: Inspect A3.
`,
    }),
    id: "call-agent-a",
  };
  const callB = {
    ...createToolCall({
      mode: "readonly",
      agent_spec: `
@agent id=b1
prompt: Inspect B1.
---
@agent id=b2
prompt: Inspect B2.
---
@agent id=b3
prompt: Inspect B3.
`,
    }),
    id: "call-agent-b",
  };

  const [resultA, resultB] = await Promise.all([
    bundle.executeToolCall(callA),
    bundle.executeToolCall(callB),
  ]);

  assert.equal(resultA.isError, false);
  assert.equal(resultB.isError, false);
  assert.equal(runnerCalls.length, 6);
  assert.equal(getMaxActiveRuns(), 2);
});

test("Agent tool accepts plain-text agent_spec manifests for stable batch creation", async () => {
  const { bundle, runnerCalls, getMaxActiveRuns } = createDelegateHarness({
    runnerDelayMs: 20,
  });

  const result = await bundle.executeToolCall(
    createToolCall({
      concurrency: 2,
      mode: "readonly",
      agent_spec: `
@agent id=philosopher name="哲学家 - 苏格拉底"
prompt: |
  请以苏格拉底身份回答用户关于生命意义的问题。
---
@agent id=scientist name="神经科学家 - 艾琳娜"
prompt:
  请以艾琳娜博士身份回答用户关于生命意义的问题。
`,
    }),
  );

  assert.equal(result.isError, false);
  assert.equal(result.details.agentCount, 2);
  assert.equal(result.details.concurrency, 2);
  assert.deepEqual(
    result.details.agents.map((agent) => agent.id),
    ["philosopher", "scientist"],
  );
  assert.deepEqual(
    result.details.agents.map((agent) => agent.name),
    ["哲学家 - 苏格拉底", "神经科学家 - 艾琳娜"],
  );
  assert.equal(runnerCalls.length, 2);
  assert.equal(getMaxActiveRuns(), 2);
  assert.match(runnerCalls[0].context.systemPrompt, /You are 哲学家 - 苏格拉底/);
  assert.match(runnerCalls[0].context.messages[0].content, /苏格拉底身份/);
  assert.match(runnerCalls[1].context.systemPrompt, /You are 神经科学家 - 艾琳娜/);
  assert.match(runnerCalls[1].context.messages[0].content, /艾琳娜博士身份/);
});

test("Agent tool accepts agent_spec key-value field lines", async () => {
  const { bundle, runnerCalls, subagentIdentities } = createDelegateHarness();

  const result = await bundle.executeToolCall(
    createToolCall({
      mode: "readonly",
      agent_spec: `
@agent id=watcher
name=观察者
role=思想内阁·全局观察者
identity=你是首席观察者，负责综合其他角色的公开信息。
prompt=请发送一段自我介绍。
`,
    }),
  );

  assert.equal(result.isError, false);
  assert.equal(result.details.agentCount, 1);
  assert.equal(subagentIdentities.length, 1);
  assert.equal(subagentIdentities[0].logicalAgentId, "watcher");
  assert.equal(subagentIdentities[0].displayName, "观察者");
  assert.equal(subagentIdentities[0].role, "思想内阁·全局观察者");
  assert.match(
    subagentIdentities[0].identityPrompt,
    /你是首席观察者，负责综合其他角色的公开信息/,
  );
  assert.equal(runnerCalls.length, 1);
  assert.match(runnerCalls[0].context.systemPrompt, /You are 观察者/);
  assert.match(runnerCalls[0].context.systemPrompt, /Role: 思想内阁·全局观察者/);
  assert.match(
    runnerCalls[0].context.systemPrompt,
    /你是首席观察者，负责综合其他角色的公开信息/,
  );
  assert.match(runnerCalls[0].context.messages[0].content, /请发送一段自我介绍/);
});

test("Agent tool parses prompt as a string manifest for 8-player role batches", async () => {
  const { bundle, runnerCalls, subagentIdentities } = createDelegateHarness();

  const result = await bundle.executeToolCall(
    createToolCall({
      mode: "readonly",
      task_intent: "communication",
      prompt: `
@agent id=player1
name: 张明
role: 狼人 - 温和理性派
identity: 你是张明，狼人阵营玩家。你的长期身份、秘密阵营和人格在后续调用中保持不变。
prompt: 确认你的狼人杀身份与人设，等待上帝视角主持人发起夜晚行动。
---
@agent id=player2
name: 李婷
role: 狼人 - 情绪表演型
identity: 你是李婷，狼人阵营玩家。你的长期身份、秘密阵营和人格在后续调用中保持不变。
prompt: 确认你的狼人杀身份与人设，等待上帝视角主持人发起夜晚行动。
---
@agent id=player3
name: 王磊
role: 村民 - 直率自信型
identity: 你是王磊，好人阵营村民。你的长期身份、秘密阵营和人格在后续调用中保持不变。
prompt: 确认你的狼人杀身份与人设，等待白天讨论。
---
@agent id=player4
name: 赵雪
role: 村民 - 谨慎沉默型
identity: 你是赵雪，好人阵营村民。你的长期身份、秘密阵营和人格在后续调用中保持不变。
prompt: 确认你的狼人杀身份与人设，等待白天讨论。
---
@agent id=player5
name: 陈浩
role: 预言家 - 正义急躁型
identity: 你是陈浩，好人阵营预言家。你的长期身份、秘密阵营和人格在后续调用中保持不变。
prompt: 确认你的狼人杀身份与人设，等待夜晚查验指令。
---
@agent id=player6
name: 林雪儿
role: 女巫 - 善良多疑型
identity: 你是林雪儿，好人阵营女巫。你的长期身份、秘密阵营和人格在后续调用中保持不变。
prompt: 确认你的狼人杀身份与人设，等待夜晚用药指令。
---
@agent id=player7
name: 周强
role: 猎人 - 冲动带队型
identity: 你是周强，好人阵营猎人。你的长期身份、秘密阵营和人格在后续调用中保持不变。
prompt: 确认你的狼人杀身份与人设，等待白天讨论。
---
@agent id=player8
name: 吴晓
role: 守卫 - 冷静策略型
identity: 你是吴晓，好人阵营守卫。你的长期身份、秘密阵营和人格在后续调用中保持不变。
prompt: 确认你的狼人杀身份与人设，等待夜晚守护指令。
`,
    }),
  );

  assert.equal(result.isError, false);
  assert.equal(result.details.agentCount, 8);
  assert.equal(result.details.concurrency, 8);
  assert.deepEqual(
    result.details.agents.map((agent) => agent.id),
    ["player1", "player2", "player3", "player4", "player5", "player6", "player7", "player8"],
  );
  assert.deepEqual(
    result.details.agents.map((agent) => agent.name),
    ["张明", "李婷", "王磊", "赵雪", "陈浩", "林雪儿", "周强", "吴晓"],
  );
  assert.equal(runnerCalls.length, 8);
  assert.equal(subagentIdentities.length, 8);
  assert.match(runnerCalls[0].context.systemPrompt, /You are 张明/);
  assert.match(runnerCalls[0].context.systemPrompt, /狼人阵营玩家/);
  assert.match(runnerCalls[7].context.systemPrompt, /You are 吴晓/);
  assert.match(runnerCalls[7].context.systemPrompt, /好人阵营守卫/);
});

test("Agent subagent compaction updates child state and history segments", async () => {
  const {
    bundle,
    compactionCalls,
    runnerTurnOverrides,
    subagentRunStates,
    subagentEvents,
  } = createDelegateHarness({
    mockCompaction: true,
    triggerCompaction: true,
    compactionApplied: true,
  });

  const result = await bundle.executeToolCall(
    createToolCall({
      prompt: "Read enough context to trigger compaction.",
      mode: "readonly",
    }),
  );

  assert.equal(result.isError, false);
  assert.equal(compactionCalls.length, 1);
  assert.equal(runnerTurnOverrides.length, 1);
  assert.equal(runnerTurnOverrides[0].emittedMessages.length, 0);
  assert.equal(runnerTurnOverrides[0].context.messages.at(-1).content[0].text, "Continue.");

  assert.ok(subagentEvents.some((event) => event.eventType === "compaction_check"));
  assert.ok(subagentEvents.some((event) => event.eventType === "compaction_completed"));
  assert.equal(result.details.agents[0].status, "completed");

  const compactedRunningState = subagentRunStates.find(
    (state) => state.status === "running" && state.compactionCount === 1,
  );
  assert.ok(compactedRunningState);
  assert.equal(compactedRunningState.state.activeSegmentIndex, 1);
  assert.equal(compactedRunningState.state.meta.totalSegmentCount, 2);
  assert.equal(compactedRunningState.state.segments[1].summary.content, "Mock compacted summary");

  const completedState = subagentRunStates.at(-1);
  assert.equal(completedState.status, "completed");
  assert.equal(completedState.compactionCount, 1);
  assert.equal(completedState.state.meta.totalSegmentCount, 2);
});

test("Agent tool emits one visible card event per delegated agent", async () => {
  const { bundle } = createDelegateHarness();
  const events = [];
  const toolCall = createToolCall({
    concurrency: 1,
    mode: "readonly",
    agent_spec: `
@agent id=a
name: Alpha Agent
prompt: Inspect A.
---
@agent id=b
name: Beta Agent
prompt: Inspect B.
`,
  });

  const result = await bundle.executeToolCall(toolCall, undefined, {
    parentToolCall: toolCall,
    emitToolCall(emittedToolCall) {
      events.push({
        type: "call",
        id: emittedToolCall.id,
        agentId: emittedToolCall.arguments.id,
        name: emittedToolCall.arguments.name,
        delegateCard: emittedToolCall.arguments.delegate_agent_card,
      });
    },
    emitToolExecutionStart(emittedToolCall) {
      events.push({
        type: "start",
        id: emittedToolCall.id,
        agentId: emittedToolCall.arguments.id,
        name: emittedToolCall.arguments.name,
        delegateCard: emittedToolCall.arguments.delegate_agent_card,
      });
    },
    emitToolResult(emittedToolCall, emittedToolResult) {
      events.push({
        type: "result",
        id: emittedToolCall.id,
        agentId: emittedToolCall.arguments.id,
        name: emittedToolCall.arguments.name,
        resultName: emittedToolResult.details.agent.name,
        delegateCard: emittedToolCall.arguments.delegate_agent_card,
        kind: emittedToolResult.details.kind,
        parentToolCallId: emittedToolResult.details.parentToolCallId,
      });
    },
  });

  assert.equal(result.details.kind, "delegate_agent");
  assert.deepEqual(
    events.map((event) => `${event.type}:${event.agentId}`),
    ["call:a", "start:a", "result:a", "call:b", "start:b", "result:b"],
  );
  assert.deepEqual(
    events.map((event) => event.id),
    [
      "call-agent:agent:1",
      "call-agent:agent:1",
      "call-agent:agent:1",
      "call-agent:agent:2",
      "call-agent:agent:2",
      "call-agent:agent:2",
    ],
  );
  assert.ok(events.every((event) => event.delegateCard === true));
  assert.deepEqual(
    events.filter((event) => event.type === "call").map((event) => event.name),
    ["Alpha Agent", "Beta Agent"],
  );
  assert.deepEqual(
    events.filter((event) => event.type === "result").map((event) => event.resultName),
    ["Alpha Agent", "Beta Agent"],
  );
  assert.deepEqual(
    events.filter((event) => event.type === "result").map((event) => [
      event.kind,
      event.parentToolCallId,
    ]),
    [
      ["delegate_agent_item", "call-agent"],
      ["delegate_agent_item", "call-agent"],
    ],
  );
});

test("Agent subagent executor rejects non-read-only tools even if called directly", async () => {
  const { bundle, runnerCalls, executedBaseToolCalls } = createDelegateHarness();

  await bundle.executeToolCall(
    createToolCall({
      prompt: "Inspect safely.",
      mode: "readonly",
    }),
  );

  const rejected = await runnerCalls[0].executeToolCall({
    type: "toolCall",
    id: "call-write",
    name: "Write",
    arguments: { path: "x.txt", content: "bad" },
  });
  assert.equal(rejected.isError, true);
  assert.match(rejected.content[0].text, /not available to delegated subagents/);
  assert.equal(executedBaseToolCalls.length, 0);

  const rejectedMcpManager = await runnerCalls[0].executeToolCall({
    type: "toolCall",
    id: "call-mcp-manager",
    name: "McpManager",
    arguments: { action: "list" },
  });
  assert.equal(rejectedMcpManager.isError, true);
  assert.match(rejectedMcpManager.content[0].text, /not available to delegated subagents/);

  const allowed = await runnerCalls[0].executeToolCall({
    type: "toolCall",
    id: "call-read",
    name: "Read",
    arguments: { path: "README.md" },
  });
  assert.equal(allowed.isError, false);
  assert.equal(executedBaseToolCalls.length, 1);

  const allowedMcp = await runnerCalls[0].executeToolCall({
    type: "toolCall",
    id: "call-mcp-search",
    name: "mcp_docs_search",
    arguments: { query: "agent" },
  });
  assert.equal(allowedMcp.isError, false);
  assert.equal(executedBaseToolCalls.length, 2);
});

test("Agent tool reports unknown configured subagent ids as agent failures", async () => {
  const { bundle, runnerCalls } = createDelegateHarness();

  const result = await bundle.executeToolCall(
    createToolCall({
      agent_id: "missing-agent",
      prompt: "Inspect safely.",
      mode: "readonly",
    }),
  );

  assert.equal(result.isError, true);
  assert.equal(result.details.agents[0].status, "failed");
  assert.match(result.details.agents[0].error, /Unknown subagent template/);
  assert.equal(runnerCalls.length, 0);
});

test("Agent worktree mode creates an isolated writable registry and reports changes", async () => {
  const {
    bundle,
    runnerCalls,
    executedBaseToolCalls,
    executedChildToolCalls,
    worktreeCreates,
    worktreeStatuses,
    worktreeApplies,
    worktreeCleanups,
  } = createDelegateHarness();

  const result = await bundle.executeToolCall(
    createToolCall({
      prompt: "Edit files and run tests.",
    }),
  );

  assert.equal(result.isError, false);
  assert.equal(result.details.readOnly, false);
  assert.equal(result.details.mode, "worktree");
  assert.equal(result.details.agents[0].mode, "worktree");
  assert.equal(result.details.agents[0].worktreeRoot, "/tmp/liveagent-subagents/agent-a");
  assert.equal(result.details.agents[0].branchName, "liveagent/subagent/agent-a");
  assert.equal(result.details.agents[0].changed, true);
  assert.equal(result.details.agents[0].applyStatus, "applied");
  assert.equal(result.details.agents[0].applyMethod, "git_apply");
  assert.equal(result.details.agents[0].applyChanged, true);
  assert.equal(result.details.agents[0].applyPatchBytes, 123);
  assert.equal(result.details.agents[0].appliedToWorkdir, "/tmp/liveagent-delegate-test");
  assert.equal(result.details.agents[0].worktreeCleanupStatus, "removed");
  assert.equal(result.details.agents[0].worktreeCleanupReason, "applied");
  assert.equal(result.details.agents[0].worktreeBranchDeleted, true);
  assert.match(result.content[0].text, /worktree=\/tmp\/liveagent-subagents\/agent-a/);
  assert.match(result.content[0].text, /apply=applied/);
  assert.match(result.content[0].text, /worktree_cleanup=removed/);

  assert.equal(worktreeCreates.length, 1);
  assert.equal(worktreeCreates[0].workdir, "/tmp/liveagent-delegate-test");
  assert.equal(worktreeStatuses.length, 1);
  assert.equal(worktreeApplies.length, 1);
  assert.deepEqual(worktreeApplies[0], {
    parentWorkdir: "/tmp/liveagent-delegate-test",
    worktreeRoot: "/tmp/liveagent-subagents/agent-a",
  });
  assert.deepEqual(worktreeCleanups, [
    {
      worktreeRoot: "/tmp/liveagent-subagents/agent-a",
      branchName: "liveagent/subagent/agent-a",
    },
  ]);
  assert.deepEqual(
    runnerCalls[0].tools.map((tool) => tool.name),
    ["Read", "Grep", "Write", "Bash", "mcp_docs_search", "SendMessage"],
  );
  assert.match(runnerCalls[0].context.systemPrompt, /isolated git worktree/);
  assert.match(runnerCalls[0].context.systemPrompt, /full workspace file\/Bash capability|edit, create, and delete files/);
  assert.match(runnerCalls[0].context.systemPrompt, /MCP business tools/);
  assert.doesNotMatch(runnerCalls[0].context.systemPrompt, /model turns|turn budget|max_turns/);
  assert.equal(typeof runnerCalls[0].onBeforeNextTurn, "function");

  const rejected = await runnerCalls[0].executeToolCall({
    type: "toolCall",
    id: "call-agent-child",
    name: "Agent",
    arguments: { prompt: "nested" },
  });
  assert.equal(rejected.isError, true);
  assert.match(rejected.content[0].text, /not available to delegated subagents/);

  const rejectedMcpManager = await runnerCalls[0].executeToolCall({
    type: "toolCall",
    id: "call-mcp-manager-child",
    name: "McpManager",
    arguments: { action: "list" },
  });
  assert.equal(rejectedMcpManager.isError, true);
  assert.match(rejectedMcpManager.content[0].text, /not available to delegated subagents/);

  const allowed = await runnerCalls[0].executeToolCall({
    type: "toolCall",
    id: "call-write-child",
    name: "Write",
    arguments: { path: "src/app.ts", content: "ok" },
  });
  assert.equal(allowed.isError, false);
  assert.equal(executedChildToolCalls.length, 1);
  assert.equal(executedBaseToolCalls.length, 0);

  const allowedMcp = await runnerCalls[0].executeToolCall({
    type: "toolCall",
    id: "call-mcp-child",
    name: "mcp_docs_search",
    arguments: { query: "agent" },
  });
  assert.equal(allowedMcp.isError, false);
  assert.equal(executedChildToolCalls.length, 2);
  assert.equal(executedChildToolCalls[1].toolCall.name, "mcp_docs_search");
});

test("Agent discussion tasks default to readonly message-only execution", async () => {
  const { bundle, runnerCalls, worktreeCreates, worktreeApplies } = createDelegateHarness();

  const result = await bundle.executeToolCall(
    createToolCall({
      name: "Philosopher",
      prompt: "请以哲学家的身份参与这场关于生命意义的圆桌讨论，并只返回你的发言。",
    }),
  );

  assert.equal(result.isError, false);
  assert.equal(result.details.mode, "readonly");
  assert.equal(result.details.readOnly, true);
  assert.equal(result.details.agents[0].mode, "readonly");
  assert.equal(result.details.agents[0].taskIntent, "communication");
  assert.equal(result.details.agents[0].applyPolicy, "none");
  assert.equal(worktreeCreates.length, 0);
  assert.equal(worktreeApplies.length, 0);
  assert.deepEqual(
    runnerCalls[0].tools.map((tool) => tool.name),
    ["Read", "Grep", "mcp_docs_search", "SendMessage"],
  );
  assert.match(runnerCalls[0].context.systemPrompt, /isolated read-only context/);
  assert.match(runnerCalls[0].context.systemPrompt, /Apply policy: none/);
});

test("Agent worktree discussion keeps markdown reports as candidate artifacts", async () => {
  const { bundle, worktreeApplies, worktreeCleanups } = createDelegateHarness({
    worktreeStatus: {
      changed: true,
      status: "?? 哲学家_回应物理学家.md",
      diff_stat: " 哲学家_回应物理学家.md | 20 +",
      diff: "diff --git a/哲学家_回应物理学家.md b/哲学家_回应物理学家.md",
      diff_truncated: false,
      untracked_files: ["哲学家_回应物理学家.md"],
    },
  });

  const result = await bundle.executeToolCall(
    createToolCall({
      name: "哲学家",
      prompt: "参与圆桌讨论并回应物理学家的观点。",
      mode: "worktree",
    }),
  );

  const agent = result.details.agents[0];
  assert.equal(result.isError, false);
  assert.equal(agent.mode, "worktree");
  assert.equal(agent.taskIntent, "communication");
  assert.equal(agent.applyPolicy, "none");
  assert.equal(agent.applyStatus, "skipped");
  assert.equal(agent.applySkippedReason, "artifact_only");
  assert.deepEqual(agent.candidateArtifacts, ["哲学家_回应物理学家.md"]);
  assert.equal(agent.worktreeCleanupStatus, "retained");
  assert.equal(agent.worktreeCleanupReason, "unapplied_changes");
  assert.match(result.content[0].text, /candidate_artifacts/);
  assert.equal(worktreeApplies.length, 0);
  assert.equal(worktreeCleanups.length, 0);
});

test("Agent explicit apply policy applies only allowed output paths", async () => {
  const { bundle, worktreeApplies } = createDelegateHarness({
    worktreeStatus: {
      changed: true,
      status: "?? docs/final-report.md",
      diff_stat: " docs/final-report.md | 20 +",
      diff: "diff --git a/docs/final-report.md b/docs/final-report.md",
      diff_truncated: false,
      untracked_files: ["docs/final-report.md"],
    },
  });

  const result = await bundle.executeToolCall(
    createToolCall({
      prompt: "请生成 docs/final-report.md 文件。",
      mode: "worktree",
      apply_policy: "explicit",
      allowed_output_paths: ["docs/final-report.md"],
    }),
  );

  const agent = result.details.agents[0];
  assert.equal(result.isError, false);
  assert.equal(agent.taskIntent, "document_generation");
  assert.equal(agent.applyPolicy, "explicit");
  assert.equal(agent.applyStatus, "applied");
  assert.deepEqual(agent.allowedOutputPaths, ["docs/final-report.md"]);
  assert.equal(worktreeApplies.length, 1);
});

test("Agent explicit apply policy normalizes Windows absolute allowed output paths", async () => {
  const { bundle, worktreeApplies } = createDelegateHarness({
    workdir: "C:/Users/Alice/Repo",
    worktreeStatus: {
      changed: true,
      status: "?? docs/final-report.md",
      diff_stat: " docs/final-report.md | 20 +",
      diff: "diff --git a/docs/final-report.md b/docs/final-report.md",
      diff_truncated: false,
      untracked_files: ["docs/final-report.md"],
    },
  });

  const result = await bundle.executeToolCall(
    createToolCall({
      prompt: "请生成 docs/final-report.md 文件。",
      mode: "worktree",
      apply_policy: "explicit",
      allowed_output_paths: ["C:\\Users\\Alice\\Repo\\docs\\final-report.md"],
    }),
  );

  const agent = result.details.agents[0];
  assert.equal(result.isError, false);
  assert.equal(agent.applyStatus, "applied");
  assert.deepEqual(agent.allowedOutputPaths, ["docs/final-report.md"]);
  assert.equal(worktreeApplies.length, 1);
});

test("Agent explicit apply policy supports glob and git-quoted unicode paths", async () => {
  const { bundle, worktreeApplies } = createDelegateHarness({
    worktreeStatus: {
      changed: true,
      status: "?? docs/\n?? .DS_Store",
      diff_stat: "",
      diff: "",
      diff_truncated: false,
      untracked_files: [
        "\"docs/\\345\\217\\257\\346\\216\\247\\346\\240\\270\\350\\201\\232\\345\\217\\230\\347\\232\\204\\347\\273\\217\\346\\265\\216\\345\\217\\257\\350\\241\\214\\346\\200\\247\\345\\210\\206\\346\\236\\220.md\"",
        ".DS_Store",
      ],
    },
  });

  const result = await bundle.executeToolCall(
    createToolCall({
      prompt: "请保存到 `docs/可控核聚变的经济可行性分析.md`。",
      mode: "worktree",
      apply_policy: "explicit",
      allowed_output_paths: ["**/*.md"],
    }),
  );

  const agent = result.details.agents[0];
  assert.equal(result.isError, false);
  assert.equal(agent.applyStatus, "applied");
  assert.deepEqual(agent.changedPaths, ["docs/可控核聚变的经济可行性分析.md"]);
  assert.deepEqual(agent.allowedOutputPaths, [
    "**/*.md",
    "docs/可控核聚变的经济可行性分析.md",
  ]);
  assert.equal(worktreeApplies.length, 1);
});

test("Agent document generation infers explicit allowed output paths from prompt", async () => {
  const { bundle, worktreeApplies } = createDelegateHarness({
    worktreeStatus: {
      changed: true,
      status: "?? docs/final-report.md",
      diff_stat: " docs/final-report.md | 20 +",
      diff: "diff --git a/docs/final-report.md b/docs/final-report.md",
      diff_truncated: false,
      untracked_files: ["docs/final-report.md"],
    },
  });

  const result = await bundle.executeToolCall(
    createToolCall({
      prompt: "请生成并保存到 `docs/final-report.md` 文件。",
    }),
  );

  const agent = result.details.agents[0];
  assert.equal(result.isError, false);
  assert.equal(agent.mode, "worktree");
  assert.equal(agent.taskIntent, "document_generation");
  assert.equal(agent.applyPolicy, "explicit");
  assert.deepEqual(agent.allowedOutputPaths, ["docs/final-report.md"]);
  assert.equal(agent.applyStatus, "applied");
  assert.equal(worktreeApplies.length, 1);
});

test("Agent worktree mode reports auto-apply failures without marking the completed agent failed", async () => {
  const { bundle, worktreeApplies } = createDelegateHarness({
    applyError: new Error("patch does not apply"),
  });

  const result = await bundle.executeToolCall(
    createToolCall({
      prompt: "Edit files.",
    }),
  );

  assert.equal(result.isError, false);
  assert.equal(result.details.agents[0].status, "completed");
  assert.equal(result.details.agents[0].applyStatus, "failed");
  assert.match(result.details.agents[0].applyError, /patch does not apply/);
  assert.match(result.content[0].text, /apply=failed/);
  assert.match(result.content[0].text, /apply_error=patch does not apply/);
  assert.equal(worktreeApplies.length, 1);
});

test("Agent worktree mode skips auto-apply when the subagent made no changes", async () => {
  const { bundle, worktreeApplies, worktreeCleanups } = createDelegateHarness({
    worktreeStatus: {
      changed: false,
      status: "",
      diff_stat: "",
      diff: "",
      diff_truncated: false,
      untracked_files: [],
    },
  });

  const result = await bundle.executeToolCall(
    createToolCall({
      prompt: "Only inspect.",
      mode: "worktree",
    }),
  );

  assert.equal(result.isError, false);
  assert.equal(result.details.agents[0].status, "completed");
  assert.equal(result.details.agents[0].changed, false);
  assert.equal(result.details.agents[0].applyStatus, "skipped");
  assert.equal(result.details.agents[0].applySkippedReason, "no_changes");
  assert.equal(result.details.agents[0].applyPatchBytes, 0);
  assert.equal(result.details.agents[0].worktreeCleanupStatus, "removed");
  assert.equal(result.details.agents[0].worktreeCleanupReason, "no_changes");
  assert.equal(worktreeApplies.length, 0);
  assert.equal(worktreeCleanups.length, 1);
});

test("Agent worktree mode cleans up when changes were already applied", async () => {
  const { bundle, worktreeApplies, worktreeCleanups } = createDelegateHarness({
    applyWorktreeChanges() {
      return {
        applied: false,
        changed: true,
        status: "?? test/agent.md",
        patch_bytes: 120,
        skipped_reason: "already_applied",
        apply_method: "file_copy_fallback",
        fallback_reason: "parent already has the same file",
        copied_files: [],
        deleted_files: [],
        conflict_files: [],
      };
    },
  });

  const result = await bundle.executeToolCall(
    createToolCall({
      prompt: "Create a file already present in parent.",
      task_intent: "implementation",
      apply_policy: "auto",
    }),
  );

  const agent = result.details.agents[0];
  assert.equal(result.isError, false);
  assert.equal(agent.applyStatus, "skipped");
  assert.equal(agent.applySkippedReason, "already_applied");
  assert.equal(agent.worktreeCleanupStatus, "removed");
  assert.equal(agent.worktreeCleanupReason, "already_applied");
  assert.equal(worktreeApplies.length, 1);
  assert.equal(worktreeCleanups.length, 1);
});

test("Agent retain_worktree keeps safely cleanable completed worktrees", async () => {
  const { bundle, worktreeApplies, worktreeCleanups } = createDelegateHarness();

  const result = await bundle.executeToolCall(
    createToolCall({
      prompt: "Edit files and run tests.",
      retain_worktree: true,
    }),
  );

  const agent = result.details.agents[0];
  assert.equal(result.isError, false);
  assert.equal(agent.applyStatus, "applied");
  assert.equal(agent.worktreeCleanupStatus, "retained");
  assert.equal(agent.worktreeCleanupReason, "retain_worktree");
  assert.equal(worktreeApplies.length, 1);
  assert.equal(worktreeCleanups.length, 0);
});

test("Agent worktree mode never auto-applies failed subagent changes", async () => {
  const { bundle, worktreeApplies } = createDelegateHarness({
    runnerError: new Error("subagent failed"),
  });

  const result = await bundle.executeToolCall(
    createToolCall({
      prompt: "Edit files.",
    }),
  );

  assert.equal(result.isError, true);
  assert.equal(result.details.agents[0].status, "failed");
  assert.match(result.details.agents[0].error, /subagent failed/);
  assert.equal(result.details.agents[0].applyStatus, "skipped");
  assert.equal(result.details.agents[0].applySkippedReason, "agent_failed");
  assert.equal(worktreeApplies.length, 0);
});
