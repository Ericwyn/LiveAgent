import type {
  AssistantMessage,
  CacheRetention,
  Context,
  Model,
  OpenAICompletionsCompat,
  SimpleStreamOptions,
  ToolCall,
  ToolResultMessage,
} from "@earendil-works/pi-ai";
import { getModel } from "@earendil-works/pi-ai";
import { streamAnthropic } from "@earendil-works/pi-ai/anthropic";
import { type GoogleOptions, streamGoogle } from "@earendil-works/pi-ai/google";
import {
  type OpenAICompletionsOptions,
  streamOpenAICompletions,
} from "@earendil-works/pi-ai/openai-completions";
import {
  type OpenAIResponsesOptions,
  streamOpenAIResponses,
} from "@earendil-works/pi-ai/openai-responses";
import {
  appendHostedSearchBlocksToAssistant,
  type HostedSearchBlock,
  type HostedSearchOrderedBlock,
  mergeHostedSearchBlocks,
} from "../chat/messages/hostedSearch";
import { buildStreamRequestDebugPayload, type StreamDebugLogger } from "../debug/agentDebug";
import {
  type CodexRequestFormat,
  getProviderModelDefaults,
  type ProviderId,
  type ProviderModelConfig,
  type ReasoningLevel,
} from "../settings";
import { withPowerActivity } from "../system/powerActivity";
import { wrapDeepSeekDsmlToolCallStream } from "./deepSeekDsmlToolCallStream";
import {
  applyDeepSeekModelDefaults,
  attachDeepSeekProviderPayloadAdapter,
  isDeepSeekAnthropicTarget,
  isDeepSeekCodexTarget,
  isDeepSeekTarget,
  mapDeepSeekReasoningEffort,
  resolveDeepSeekOpenAICompletionsOverrides,
} from "./deepSeekProviderAdapter";
import {
  createHostedSearchEventAggregator,
  createHostedSearchProbeId,
  startHostedSearchFetchProbe,
  withHostedSearchProbeHeader,
} from "./hostedSearchEvents";
import {
  attachAnthropicMessagesNativeAttachments,
  attachGeminiGenerativeAINativeAttachments,
  attachOpenAICompletionsNativeAttachments,
  attachOpenAIResponsesNativeAttachments,
} from "./nativeResponsesAttachments";
import {
  buildProviderNativeWebSearchBridgeResult,
  isProviderNativeWebSearchToolName as isProviderNativeWebSearchToolCallName,
  providerSupportsNativeWebSearch,
} from "./nativeWebSearch";
import { prepareProxyRequest } from "./proxy";

export { providerSupportsNativeWebSearch } from "./nativeWebSearch";

export type ModelOption = {
  value: string; // encodes customProviderId::model
  label: string; // model id
  providerName: string; // provider display name (for grouping)
  providerType: ProviderId; // routes Claude Code, Codex, Gemini, etc.
  model: string;
};

type ProviderRuntimeConfig = {
  baseUrl: string;
  apiKey: string;
  requestFormat?: CodexRequestFormat;
  reasoning?: ReasoningLevel;
  promptCachingEnabled?: boolean;
  nativeWebSearchEnabled?: boolean;
  modelConfig?: ProviderModelConfig;
};

const VALUE_SEP = "::";
const CODEX_RESPONSES_SUFFIX = "/responses";
const CODEX_RESPONSE_SUFFIX = "/response";
const CODEX_CHAT_COMPLETIONS_SUFFIX = "/chat/completions";

type CodexApi = "openai-responses" | "openai-completions";

type AnthropicEffort = "low" | "medium" | "high" | "max" | "xhigh";
type AnthropicThinkingMode = "disabled" | "adaptive" | "budget";
type AnthropicThinkingRuntime = {
  thinkingEnabled: boolean;
  mode: AnthropicThinkingMode;
  maxTokens: number;
  effort?: AnthropicEffort;
  thinkingBudgetTokens?: number;
  display?: "summarized";
  omitDisabledThinking?: boolean;
};

type ToolChoice =
  | "auto"
  | "any"
  | "none"
  | {
      type: "tool";
      name: string;
    };

export type StreamOptionsEx = SimpleStreamOptions & {
  /**
   * 注意：pi-ai 的 streamSimpleAnthropic() 在内部会通过 buildBaseOptions() 丢弃 toolChoice，
   * 所以这里我们自己调用 streamAnthropic() 并把 toolChoice 显式传下去。
   */
  toolChoice?: ToolChoice;
  /**
   * DeepSeek 的 Anthropic 兼容端点偶尔会把工具调用泄漏成 DSML 文本。
   * 开启后在事件流层把 DSML 转回结构化 toolCall，避免 stop 截断工具循环。
   */
  deepSeekDsmlToolCallRepair?: boolean;
  deepSeekProviderAdapter?: boolean;
  deepSeekAnthropicPayloadToolBlockFlattening?: boolean;
};

export function buildDualAuthHeaders(apiKey: string): Record<string, string> {
  return {
    Authorization: `Bearer ${apiKey}`,
    "x-api-key": apiKey,
  };
}

export function buildGeminiAuthHeaders(apiKey: string): Record<string, string> {
  return {
    "x-goog-api-key": apiKey,
  };
}

export function buildProviderAuthHeaders(
  providerId: ProviderId,
  apiKey: string,
): Record<string, string> {
  return providerId === "gemini" ? buildGeminiAuthHeaders(apiKey) : buildDualAuthHeaders(apiKey);
}

function appendSystemPrompt(base: string | undefined, suffix: string) {
  const head = (base || "").trim();
  if (!head) return suffix;
  return `${head}\n\n${suffix}`;
}

function buildTextOnlySystemSuffix(allowJsonOutput = false) {
  return [
    "Important Rules:",
    allowJsonOutput
      ? "- Your final user-visible output must be plain text. Markdown or valid JSON is allowed."
      : "- Your final user-visible output must be plain text. Markdown is allowed.",
    allowJsonOutput
      ? "- Do not output event streams or raw tool-call structures."
      : "- Do not output event streams, raw JSON, or raw tool-call structures.",
    "- You are currently in text-only mode: do not make any tool calls.",
  ].join("\n");
}

function supportsAdaptiveAnthropicThinking(modelId: string) {
  const id = modelId.toLowerCase();
  return (
    isAnthropicMythosPreview(id) ||
    isClaudeFamilyVersionAtLeast(id, "opus", 6) ||
    isClaudeFamilyVersionAtLeast(id, "sonnet", 6)
  );
}

function isAnthropicMythosPreview(modelId: string) {
  return modelId.toLowerCase().includes("mythos-preview");
}

function isClaudeFamilyVersionAtLeast(
  normalizedModelId: string,
  family: "opus" | "sonnet",
  minimumMinor: number,
) {
  const match = normalizedModelId.match(new RegExp(`${family}[-.]4[-.](\\d+)`));
  if (!match) return false;
  const minor = Number(match[1]);
  return Number.isFinite(minor) && minor >= minimumMinor;
}

function supportsXHighAnthropicEffort(modelId: string) {
  const id = modelId.toLowerCase();
  return id.includes("mythos-preview") || isClaudeFamilyVersionAtLeast(id, "opus", 7);
}

function supportsMaxAnthropicEffort(modelId: string) {
  const id = modelId.toLowerCase();
  return (
    id.includes("mythos-preview") ||
    id.includes("opus-4-6") ||
    id.includes("opus-4.6") ||
    id.includes("sonnet-4-6") ||
    id.includes("sonnet-4.6")
  );
}

const ANTHROPIC_THINKING_BUDGETS: Record<NonNullable<SimpleStreamOptions["reasoning"]>, number> = {
  minimal: 1_024,
  low: 2_048,
  medium: 8_192,
  high: 16_384,
  xhigh: 16_384,
};

function mapReasoningToAnthropicEffort(
  reasoning: SimpleStreamOptions["reasoning"] | undefined,
  modelId: string,
): AnthropicEffort {
  // Anthropic effort: low / medium / high / max / xhigh（按模型能力降级）。
  const supportsMax = supportsMaxAnthropicEffort(modelId);

  switch (reasoning) {
    case "minimal":
      return "low";
    case "low":
      return "low";
    case "medium":
      return "medium";
    case "high":
      return "high";
    case "xhigh":
      if (supportsXHighAnthropicEffort(modelId)) return "xhigh";
      return supportsMax ? "max" : "high";
    default:
      return "high";
  }
}

function resolveAnthropicThinkingRuntime(
  model: Model<any>,
  options: StreamOptionsEx,
): AnthropicThinkingRuntime {
  const maxTokens = resolveMaxTokens(options.maxTokens, model.maxTokens);
  if (!options.reasoning) {
    return {
      thinkingEnabled: false,
      mode: "disabled",
      maxTokens,
      omitDisabledThinking: isAnthropicMythosPreview(model.id),
    };
  }

  if (supportsAdaptiveAnthropicThinking(model.id)) {
    return {
      thinkingEnabled: true,
      mode: "adaptive",
      maxTokens,
      effort: mapReasoningToAnthropicEffort(options.reasoning, model.id),
      display: "summarized",
    };
  }

  let thinkingBudgetTokens = ANTHROPIC_THINKING_BUDGETS[options.reasoning];
  const adjustedMaxTokens = Math.min(maxTokens + thinkingBudgetTokens, model.maxTokens);
  if (adjustedMaxTokens <= thinkingBudgetTokens) {
    thinkingBudgetTokens = Math.max(0, adjustedMaxTokens - 1_024);
  }

  return {
    thinkingEnabled: true,
    mode: "budget",
    maxTokens: adjustedMaxTokens,
    thinkingBudgetTokens,
  };
}

function resolveDeepSeekAnthropicThinkingRuntime(
  model: Model<any>,
  options: StreamOptionsEx,
): AnthropicThinkingRuntime {
  const effort = mapDeepSeekReasoningEffort(options.reasoning) as AnthropicEffort | undefined;
  return {
    thinkingEnabled: Boolean(effort),
    mode: effort ? "adaptive" : "disabled",
    maxTokens: resolveMaxTokens(options.maxTokens, model.maxTokens),
    ...(effort ? { effort } : {}),
  };
}

function applyAnthropicThinkingPayloadOverride(
  payload: unknown,
  thinking: AnthropicThinkingRuntime,
): unknown {
  if (!isRecord(payload)) return payload;

  if (thinking.mode === "disabled" && thinking.omitDisabledThinking) {
    const { thinking: _thinking, ...rest } = payload;
    return rest;
  }

  if (thinking.mode !== "adaptive") return payload;

  const outputConfig: Record<string, unknown> = isRecord(payload.output_config)
    ? { ...payload.output_config }
    : {};
  if (thinking.effort) {
    outputConfig.effort = thinking.effort;
  }

  return {
    ...payload,
    thinking: {
      type: "adaptive",
      ...(thinking.display ? { display: thinking.display } : {}),
    },
    ...(Object.keys(outputConfig).length > 0 ? { output_config: outputConfig } : {}),
  };
}

function attachAnthropicThinkingPayloadOverride(
  options: StreamOptionsEx,
  thinking: AnthropicThinkingRuntime,
): StreamOptionsEx {
  if (thinking.mode !== "adaptive" && !thinking.omitDisabledThinking) return options;

  const previousOnPayload = options.onPayload;
  return {
    ...options,
    onPayload: async (payload, model) => {
      let nextPayload = applyAnthropicThinkingPayloadOverride(payload, thinking);
      if (previousOnPayload) {
        const overridden = await previousOnPayload(nextPayload, model);
        if (overridden !== undefined) {
          nextPayload = overridden;
        }
      }
      return nextPayload;
    },
  };
}

export function toSimpleStreamReasoning(
  reasoning: ReasoningLevel | undefined,
): SimpleStreamOptions["reasoning"] | undefined {
  return reasoning && reasoning !== "off" ? reasoning : undefined;
}

function extractStructuredErrorMessage(value: unknown, depth = 0): string | undefined {
  if (depth > 4 || value == null) return undefined;

  if (typeof value === "string") {
    const text = value.trim();
    return text || undefined;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      const nested = extractStructuredErrorMessage(item, depth + 1);
      if (nested) return nested;
    }
    return undefined;
  }

  if (typeof value !== "object") return undefined;

  const record = value as Record<string, unknown>;
  for (const key of ["error", "message", "detail", "details", "errorMessage", "msg", "title"]) {
    const nested = extractStructuredErrorMessage(record[key], depth + 1);
    if (nested) return nested;
  }

  return undefined;
}

export function normalizeErrorMessage(rawMessage: string | undefined, fallback = "Request failed") {
  const raw = (rawMessage || "").trim();
  if (!raw) return fallback;

  const parseCandidates = [raw];
  const objectStart = raw.indexOf("{");
  if (objectStart > 0) parseCandidates.push(raw.slice(objectStart));
  const arrayStart = raw.indexOf("[");
  if (arrayStart > 0) parseCandidates.push(raw.slice(arrayStart));

  for (const candidate of parseCandidates) {
    try {
      const structured = extractStructuredErrorMessage(JSON.parse(candidate));
      if (structured) return structured;
    } catch {
      // Ignore parse failures and fall back to the raw message below.
    }
  }

  return raw;
}

function formatErrorDisplayText(rawMessage: string | undefined, fallback = "Request failed") {
  const message = normalizeErrorMessage(rawMessage, fallback);
  if (!message || message === fallback) return fallback;
  if (message.startsWith(`${fallback}：`) || message.startsWith(`${fallback}:`)) {
    return message;
  }
  return `${fallback}：${message}`;
}

function mapToolChoiceToOpenAI(
  toolChoice: ToolChoice | undefined,
): OpenAICompletionsOptions["toolChoice"] | undefined {
  if (!toolChoice) return undefined;
  if (toolChoice === "any") return "required";
  if (toolChoice === "auto" || toolChoice === "none") return toolChoice;
  return {
    type: "function",
    function: {
      name: toolChoice.name,
    },
  };
}

function mapToolChoiceToGoogle(
  toolChoice: ToolChoice | undefined,
): GoogleOptions["toolChoice"] | undefined {
  if (!toolChoice) return undefined;
  if (toolChoice === "auto" || toolChoice === "none" || toolChoice === "any") {
    return toolChoice;
  }
  return "auto";
}

function buildOpenAIBaseOptions(model: Model<any>, options: StreamOptionsEx) {
  return {
    temperature: options.temperature,
    maxTokens: resolveMaxTokens(options.maxTokens, model.maxTokens),
    signal: options.signal,
    apiKey: options.apiKey,
    cacheRetention: options.cacheRetention,
    sessionId: options.sessionId,
    headers: options.headers,
    onPayload: options.onPayload,
    maxRetryDelayMs: options.maxRetryDelayMs,
    metadata: options.metadata,
  };
}

function resolveMaxTokens(requestedMaxTokens: number | undefined, modelMaxTokens: number) {
  if (!requestedMaxTokens || requestedMaxTokens <= 0) return modelMaxTokens;
  return Math.min(requestedMaxTokens, modelMaxTokens);
}

function normalizeSessionId(sessionId: string | undefined) {
  const value = sessionId?.trim();
  return value ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function buildAnthropicAutomaticCacheControl(
  baseUrl: string,
  cacheRetention?: CacheRetention,
): Record<string, unknown> | undefined {
  if (!cacheRetention || cacheRetention === "none") return undefined;

  return {
    type: "ephemeral",
    ...(cacheRetention === "long" && baseUrl.includes("api.anthropic.com") ? { ttl: "1h" } : {}),
  };
}

function stripNestedAnthropicCacheControl(value: unknown): unknown {
  if (Array.isArray(value)) {
    let changed = false;
    const next = value.map((item) => {
      const stripped = stripNestedAnthropicCacheControl(item);
      if (stripped !== item) changed = true;
      return stripped;
    });
    return changed ? next : value;
  }

  if (!isRecord(value)) return value;

  let changed = false;
  const next: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value)) {
    if (key === "cache_control") {
      changed = true;
      continue;
    }

    const stripped = stripNestedAnthropicCacheControl(nested);
    if (stripped !== nested) changed = true;
    next[key] = stripped;
  }

  return changed ? next : value;
}

function normalizeAnthropicMessagesForCaching(messages: unknown): unknown {
  if (!Array.isArray(messages)) return messages;

  let changed = false;
  const next = messages.map((message) => {
    if (!isRecord(message) || typeof message.content !== "string") {
      return message;
    }

    changed = true;
    return {
      ...message,
      content: [
        {
          type: "text",
          text: message.content,
        },
      ],
    };
  });

  return changed ? next : messages;
}

function markLastCacheableAnthropicBlock(
  blocks: unknown,
  cacheControl: Record<string, unknown>,
): unknown {
  if (!Array.isArray(blocks)) return blocks;

  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    const block = blocks[index];
    if (!isRecord(block)) continue;

    if (block.type === "thinking") continue;
    if (block.type === "text" && typeof block.text === "string" && !block.text.trim()) continue;

    const next = blocks.slice();
    next[index] = {
      ...block,
      cache_control: cacheControl,
    };
    return next;
  }

  return blocks;
}

function applyAnthropicExplicitCacheBreakpoint(
  payload: Record<string, unknown>,
  cacheControl: Record<string, unknown>,
): Record<string, unknown> {
  const normalizedMessages = normalizeAnthropicMessagesForCaching(payload.messages);

  if (Array.isArray(normalizedMessages)) {
    for (let messageIndex = normalizedMessages.length - 1; messageIndex >= 0; messageIndex -= 1) {
      const message = normalizedMessages[messageIndex];
      if (!isRecord(message)) continue;

      const markedContent = markLastCacheableAnthropicBlock(message.content, cacheControl);
      if (markedContent === message.content) continue;

      const nextMessages = normalizedMessages.slice();
      nextMessages[messageIndex] = {
        ...message,
        content: markedContent,
      };

      return {
        ...payload,
        messages: nextMessages,
      };
    }
  }

  const markedSystem = markLastCacheableAnthropicBlock(payload.system, cacheControl);
  if (markedSystem !== payload.system) {
    return {
      ...payload,
      system: markedSystem,
    };
  }

  const markedTools = markLastCacheableAnthropicBlock(payload.tools, cacheControl);
  if (markedTools !== payload.tools) {
    return {
      ...payload,
      tools: markedTools,
    };
  }

  return normalizedMessages === payload.messages
    ? payload
    : {
        ...payload,
        messages: normalizedMessages,
      };
}

function supportsAnthropicTopLevelAutomaticCaching(baseUrl: string) {
  const normalized = baseUrl.trim().toLowerCase();
  return normalized.includes("api.anthropic.com");
}

function normalizeAnthropicPayloadMessages(
  payload: Record<string, unknown>,
): Record<string, unknown> {
  const normalizedMessages = normalizeAnthropicMessagesForCaching(payload.messages);
  return normalizedMessages === payload.messages
    ? payload
    : {
        ...payload,
        messages: normalizedMessages,
      };
}

export function attachAnthropicAutomaticCaching(
  providerId: ProviderId,
  baseUrl: string,
  options: StreamOptionsEx,
): StreamOptionsEx {
  const cacheControl = buildAnthropicAutomaticCacheControl(baseUrl, options.cacheRetention);
  const previousOnPayload = options.onPayload;

  if (providerId !== "claude_code" || !cacheControl) {
    return options;
  }

  return {
    ...options,
    onPayload: async (payload, model) => {
      let nextPayload = payload;

      if (model.api === "anthropic-messages" && isRecord(nextPayload)) {
        // Keep Anthropic payloads in a stable shape for exact-prefix matching.
        // For Anthropic-compatible proxies that ignore top-level automatic caching,
        // fall back to an explicit breakpoint on the last cacheable block.
        const sanitizedPayload = stripNestedAnthropicCacheControl(nextPayload) as Record<
          string,
          unknown
        >;
        nextPayload = supportsAnthropicTopLevelAutomaticCaching(baseUrl)
          ? {
              ...normalizeAnthropicPayloadMessages(sanitizedPayload),
              cache_control: cacheControl,
            }
          : applyAnthropicExplicitCacheBreakpoint(sanitizedPayload, cacheControl);
      }

      if (previousOnPayload) {
        const overridden = await previousOnPayload(nextPayload, model);
        if (overridden !== undefined) {
          nextPayload = overridden;
        }
      }

      return nextPayload;
    },
  };
}

export function resolveProviderCacheRetention(
  providerId: ProviderId,
  promptCachingEnabled?: boolean,
  override?: CacheRetention,
): CacheRetention | undefined {
  if (providerId !== "claude_code") return undefined;
  if (override) return override;
  return promptCachingEnabled === false ? "none" : "short";
}

export function buildProviderRequestMetadata(
  providerId: ProviderId,
  sessionId?: string,
): Record<string, unknown> | undefined {
  const normalizedSessionId = normalizeSessionId(sessionId);
  if (providerId !== "claude_code" || !normalizedSessionId) return undefined;
  return {
    user_id: normalizedSessionId,
  };
}

function hasOpenAIResponsesWebSearchTool(tool: unknown) {
  if (!isRecord(tool)) return false;
  const type = tool.type;
  return (
    type === "web_search" ||
    type === "web_search_2025_08_26" ||
    type === "web_search_preview" ||
    type === "web_search_preview_2025_03_11"
  );
}

function hasOpenAIChatCompletionsWebSearchOptions(payload: Record<string, unknown>) {
  return isRecord(payload.web_search_options);
}

function hasAnthropicWebSearchTool(tool: unknown) {
  if (!isRecord(tool)) return false;
  const type = tool.type;
  const name = tool.name;
  return name === "web_search" || type === "web_search_20260209" || type === "web_search_20250305";
}

function buildTextModeUnsupportedToolResult(toolCall: ToolCall): ToolResultMessage {
  return {
    role: "toolResult",
    toolCallId: toolCall.id,
    toolName: toolCall.name,
    content: [
      {
        type: "text",
        text: "Tool execution result is unavailable for this recovered tool call. Continue without using this tool and do not repeat raw tool-call markup.",
      },
    ],
    details: { unsupportedTextModeTool: true },
    isError: true,
    timestamp: Date.now(),
  };
}

function buildTextModeToolResultsForAssistant(
  assistant: AssistantMessage,
  hostedSearchBlocks: HostedSearchBlock[],
): ToolResultMessage[] {
  if (assistant.stopReason !== "toolUse") return [];
  const toolCalls = assistant.content.filter(
    (block): block is ToolCall => block.type === "toolCall",
  );
  return toolCalls.map((toolCall) =>
    buildTextModeToolResultForToolCall(toolCall, hostedSearchBlocks),
  );
}

function buildTextModeToolResultForToolCall(
  toolCall: ToolCall,
  hostedSearchBlocks: HostedSearchBlock[],
): ToolResultMessage {
  return isProviderNativeWebSearchToolCallName(toolCall.name)
    ? buildProviderNativeWebSearchBridgeResult({
        toolCall,
        hostedSearchBlocks,
        sourcesIntro: "Hosted search sources already captured in this response:",
        fallbackText:
          "No hosted search result was returned for this recovered request. Continue from existing context without repeating raw tool-call markup.",
      })
    : buildTextModeUnsupportedToolResult(toolCall);
}

function findNextNonToolResultMessageIndex(messages: Context["messages"], startIndex: number) {
  let index = startIndex;
  while (index < messages.length && messages[index]?.role === "toolResult") {
    index += 1;
  }
  return index;
}

function normalizeStructuredToolCallHistoryForDeepSeek(context: Context): Context {
  const messages: Context["messages"] = [];
  let changed = false;

  for (let index = 0; index < context.messages.length; index += 1) {
    const message = context.messages[index];
    if (message.role !== "assistant") {
      messages.push(message);
      continue;
    }

    const toolCalls = message.content.filter(
      (block): block is ToolCall => block.type === "toolCall",
    );
    if (toolCalls.length === 0) {
      messages.push(message);
      continue;
    }

    if (message.stopReason === "error" || message.stopReason === "aborted") {
      const assistantContent = message.content.filter((block) => block.type !== "toolCall");
      changed = true;
      if (assistantContent.length > 0) {
        messages.push({
          ...message,
          content: assistantContent,
          stopReason: "stop",
        } as AssistantMessage);
      }
      const afterToolResults = findNextNonToolResultMessageIndex(context.messages, index + 1);
      index = afterToolResults - 1;
      continue;
    }

    messages.push(message);
    const afterToolResults = findNextNonToolResultMessageIndex(context.messages, index + 1);
    const consumedToolResults = context.messages.slice(index + 1, afterToolResults).filter(
      (candidate): candidate is ToolResultMessage => candidate.role === "toolResult",
    );
    const consumedToolResultsById = new Map<string, ToolResultMessage>();
    for (const toolResult of consumedToolResults) {
      if (!consumedToolResultsById.has(toolResult.toolCallId)) {
        consumedToolResultsById.set(toolResult.toolCallId, toolResult);
      } else {
        changed = true;
      }
    }

    const orderedToolResults = toolCalls.map((toolCall) => {
      const existing = consumedToolResultsById.get(toolCall.id);
      if (existing) return existing;
      changed = true;
      return buildTextModeToolResultForToolCall(toolCall, []);
    });
    messages.push(...orderedToolResults);

    const retainedIds = new Set(toolCalls.map((toolCall) => toolCall.id));
    for (const toolResult of consumedToolResults) {
      if (!retainedIds.has(toolResult.toolCallId)) {
        changed = true;
      }
    }

    const alreadyAdjacent = orderedToolResults.every(
      (toolResult, offset) => context.messages[index + 1 + offset] === toolResult,
    );
    if (!alreadyAdjacent || consumedToolResults.length !== orderedToolResults.length) {
      changed = true;
    }
    index = afterToolResults - 1;
  }

  return changed ? { ...context, messages } : context;
}

function hasGeminiGoogleSearchTool(tool: unknown) {
  if (!isRecord(tool)) return false;
  return Boolean(tool.googleSearch || tool.google_search || tool.googleSearchRetrieval);
}

function appendUniqueTool(
  payload: Record<string, unknown>,
  tool: Record<string, unknown>,
  matches: (tool: unknown) => boolean,
) {
  const tools = Array.isArray(payload.tools) ? payload.tools : [];
  if (tools.some(matches)) return payload;
  return {
    ...payload,
    tools: [...tools, tool],
  };
}

function appendGeminiGoogleSearchTool(payload: Record<string, unknown>) {
  const config = isRecord(payload.config) ? payload.config : {};
  const tools = Array.isArray(config.tools) ? config.tools : [];
  if (tools.some(hasGeminiGoogleSearchTool)) return payload;

  return {
    ...payload,
    config: {
      ...config,
      tools: [...tools, { googleSearch: {} }],
    },
  };
}

function appendOpenAIChatCompletionsWebSearchOptions(payload: Record<string, unknown>) {
  if (hasOpenAIChatCompletionsWebSearchOptions(payload)) return payload;
  return {
    ...payload,
    web_search_options: {
      search_context_size: "medium",
    },
  };
}

function hasOpenAIChatCompletionsWebSearchFunctionTool(tool: unknown) {
  if (!isRecord(tool) || tool.type !== "function") return false;
  const fn = isRecord(tool.function) ? tool.function : {};
  const name = typeof fn.name === "string" ? fn.name.trim().toLowerCase() : "";
  return name === "web_search" || name === "web_search_preview";
}

function hasOpenAIChatCompletionsNativeWebSearchTool(tool: unknown) {
  return (
    hasOpenAIResponsesWebSearchTool(tool) || hasOpenAIChatCompletionsWebSearchFunctionTool(tool)
  );
}

function buildOpenAIChatCompletionsWebSearchFunctionTool() {
  return {
    type: "function",
    function: {
      name: "web_search",
      description:
        "Search the web for current information when the answer needs recent or external context.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "The web search query.",
          },
        },
        required: ["query"],
        additionalProperties: false,
      },
    },
  };
}

function supportsOpenAIChatCompletionsWebSearchOptions(params: {
  baseUrl?: string;
  modelId: string;
}) {
  return (
    isOfficialOpenAIBaseUrl(params.baseUrl) &&
    params.modelId.trim().toLowerCase().includes("search-preview")
  );
}

function appendOpenAIChatCompletionsNativeWebSearch(
  payload: Record<string, unknown>,
  params: {
    baseUrl?: string;
    model: Model<any>;
  },
) {
  if (
    supportsOpenAIChatCompletionsWebSearchOptions({
      baseUrl: params.baseUrl,
      modelId: params.model.id,
    })
  ) {
    return appendOpenAIChatCompletionsWebSearchOptions(payload);
  }

  return appendUniqueTool(
    payload,
    buildOpenAIChatCompletionsWebSearchFunctionTool(),
    hasOpenAIChatCompletionsNativeWebSearchTool,
  );
}

function isOpenAIWebSearchMinimalReasoningUnsupportedModel(modelId: string) {
  const normalized = modelId.trim().toLowerCase();
  return normalized === "gpt-5" || normalized.startsWith("gpt-5-");
}

function normalizeOpenAIWebSearchReasoning(payload: Record<string, unknown>, model: Model<any>) {
  if (!isOpenAIWebSearchMinimalReasoningUnsupportedModel(model.id)) return payload;
  if (!isRecord(payload.reasoning) || payload.reasoning.effort !== "minimal") return payload;
  return {
    ...payload,
    reasoning: {
      ...payload.reasoning,
      effort: "low",
    },
  };
}

export function attachProviderNativeWebSearch(
  providerId: ProviderId,
  options: StreamOptionsEx,
  enabled?: boolean,
  params?: {
    baseUrl?: string;
  },
): StreamOptionsEx {
  if (!enabled) return options;

  const previousOnPayload = options.onPayload;
  return {
    ...options,
    onPayload: async (payload, model) => {
      let nextPayload = payload;

      if (previousOnPayload) {
        const overridden = await previousOnPayload(nextPayload, model);
        if (overridden !== undefined) {
          nextPayload = overridden;
        }
      }

      if (
        !isRecord(nextPayload) ||
        !providerSupportsNativeWebSearch(providerId, model.api, {
          baseUrl: params?.baseUrl,
          modelId: model.id,
        })
      ) {
        return nextPayload;
      }

      if (providerId === "codex") {
        if (model.api === "openai-completions") {
          return appendOpenAIChatCompletionsNativeWebSearch(nextPayload, {
            baseUrl: params?.baseUrl,
            model,
          });
        }

        return appendUniqueTool(
          normalizeOpenAIWebSearchReasoning(nextPayload, model),
          { type: "web_search" },
          hasOpenAIResponsesWebSearchTool,
        );
      }

      if (providerId === "claude_code") {
        return appendUniqueTool(
          nextPayload,
          { type: "web_search_20250305", name: "web_search" },
          hasAnthropicWebSearchTool,
        );
      }

      if (providerId === "gemini") {
        return appendGeminiGoogleSearchTool(nextPayload);
      }

      return nextPayload;
    },
  };
}

export function attachCodexResponsesStorage(
  providerId: ProviderId,
  options: StreamOptionsEx,
): StreamOptionsEx {
  const previousOnPayload = options.onPayload;

  if (providerId !== "codex") {
    return options;
  }

  return {
    ...options,
    onPayload: async (payload, model) => {
      let nextPayload = payload;

      if (previousOnPayload) {
        const overridden = await previousOnPayload(nextPayload, model);
        if (overridden !== undefined) {
          nextPayload = overridden;
        }
      }

      if (model.api === "openai-responses" && isRecord(nextPayload)) {
        return {
          ...nextPayload,
          store: true,
        };
      }

      return nextPayload;
    },
  };
}

export function attachPayloadDebugLogging(
  options: StreamOptionsEx,
  debugLogger?: StreamDebugLogger,
  extra?: {
    phase?: string;
    round?: number;
    sessionId?: string;
  },
): StreamOptionsEx {
  const previousOnPayload = options.onPayload;
  if (!debugLogger && !previousOnPayload) return options;

  return {
    ...options,
    onPayload: async (payload, model) => {
      let nextPayload = payload;
      if (previousOnPayload) {
        const overridden = await previousOnPayload(payload, model);
        if (overridden !== undefined) {
          nextPayload = overridden;
        }
      }

      debugLogger?.logRequest({
        phase: extra?.phase ?? "provider_payload",
        round: extra?.round,
        sessionId: extra?.sessionId,
        api: model.api,
        provider: model.provider,
        payload: nextPayload,
      });

      return nextPayload;
    },
  };
}

export function finalizeProviderStreamOptions(params: {
  providerId: ProviderId;
  baseUrl: string;
  options: StreamOptionsEx;
  context?: Context;
  model?: Model<any>;
  workdir?: string;
  nativeWebSearch?: boolean;
  debugLogger?: StreamDebugLogger;
  extra?: {
    phase?: string;
    round?: number;
    sessionId?: string;
  };
}): StreamOptionsEx {
  let options = attachAnthropicAutomaticCaching(params.providerId, params.baseUrl, params.options);
  options = attachCodexResponsesStorage(params.providerId, options);
  options = attachProviderNativeWebSearch(params.providerId, options, params.nativeWebSearch, {
    baseUrl: params.baseUrl,
  });
  if (params.context && params.model) {
    options = attachOpenAIResponsesNativeAttachments(options, {
      context: params.context,
      model: params.model,
      providerId: params.providerId,
      workdir: params.workdir,
    });
    options = attachOpenAICompletionsNativeAttachments(options, {
      context: params.context,
      model: params.model,
      providerId: params.providerId,
      workdir: params.workdir,
    });
    options = attachAnthropicMessagesNativeAttachments(options, {
      context: params.context,
      model: params.model,
      providerId: params.providerId,
      workdir: params.workdir,
    });
    options = attachGeminiGenerativeAINativeAttachments(options, {
      context: params.context,
      model: params.model,
      providerId: params.providerId,
      workdir: params.workdir,
    });
  }
  options = attachDeepSeekProviderPayloadAdapter(options, {
    providerId: params.providerId,
    baseUrl: params.baseUrl,
    model: params.model,
  });
  return attachPayloadDebugLogging(options, params.debugLogger, params.extra);
}

export function toModelValue(customProviderId: string, model: string) {
  return `${customProviderId}${VALUE_SEP}${model}`;
}

export function parseModelValue(value: string): { customProviderId: string; model: string } | null {
  const idx = value.indexOf(VALUE_SEP);
  if (idx <= 0) return null;
  const customProviderId = value.slice(0, idx);
  const model = value.slice(idx + VALUE_SEP.length);
  if (!model || !customProviderId) return null;
  return { customProviderId, model };
}

export function assistantMessageToText(message: AssistantMessage) {
  let text = "";
  for (const block of message.content) {
    if (block.type === "text") text += block.text;
  }
  if (text.trim()) return text;
  if (message.stopReason === "error") {
    return formatErrorDisplayText(message.errorMessage, "Request failed");
  }
  if (message.stopReason === "aborted") {
    return formatErrorDisplayText(message.errorMessage, "Cancelled");
  }
  return text;
}

export function createStreamingTextReconciler() {
  const emittedTextByKey = new Map<string, string>();

  return {
    appendDelta(key: string, delta: string) {
      if (!delta) return "";
      const previous = emittedTextByKey.get(key) ?? "";
      emittedTextByKey.set(key, previous + delta);
      return delta;
    },
    reconcileFinalText(key: string, finalText: string) {
      if (!finalText) return "";

      const previous = emittedTextByKey.get(key) ?? "";
      emittedTextByKey.set(key, finalText);

      if (!previous) {
        return finalText;
      }
      if (finalText.startsWith(previous)) {
        return finalText.slice(previous.length);
      }
      return "";
    },
  };
}

function resolveKnownModel(
  provider: "openai" | "anthropic" | "google",
  modelId: string,
  baseUrl: string,
): Model<any> | undefined {
  const known = getModel(provider as any, modelId as any) as Model<any> | undefined;
  return known?.api ? ({ ...known, baseUrl } as Model<any>) : undefined;
}

function maybeAppendGeminiApiVersion(baseUrl: string) {
  try {
    const url = new URL(baseUrl);
    let pathname = url.pathname.replace(/\/+$/, "");
    const lowerPathname = pathname.toLowerCase();
    for (const suffix of [":streamgeneratecontent", ":generatecontent"]) {
      if (lowerPathname.endsWith(suffix)) {
        pathname = pathname.slice(0, -suffix.length);
        break;
      }
    }
    const modelsIndex = pathname.toLowerCase().lastIndexOf("/models");
    if (
      modelsIndex >= 0 &&
      (pathname.length === modelsIndex + "/models".length ||
        pathname.charAt(modelsIndex + "/models".length) === "/")
    ) {
      pathname = pathname.slice(0, modelsIndex);
    }
    if (!pathname || pathname === "/") {
      url.pathname = "/v1beta";
      return url.toString().replace(/\/+$/, "");
    }
    if (/\/v\d+(?:beta)?$/i.test(pathname)) {
      url.pathname = pathname;
      return url.toString().replace(/\/+$/, "");
    }
    url.pathname = `${pathname}/v1beta`;
    return url.toString().replace(/\/+$/, "");
  } catch {
    return baseUrl;
  }
}

function maybeAppendCodexApiVersion(baseUrl: string) {
  try {
    const url = new URL(baseUrl);
    const pathname = url.pathname.replace(/\/+$/, "");
    if (!/\/v1$/i.test(pathname)) {
      url.pathname = `${pathname}/v1`;
    } else {
      url.pathname = pathname;
    }
    return url.toString().replace(/\/+$/, "");
  } catch {
    return baseUrl;
  }
}

function supportsCodexReasoningModel(modelId: string) {
  const normalizedModelId = modelId.trim().toLowerCase();
  return (
    normalizedModelId.startsWith("gpt-5") ||
    normalizedModelId.includes("codex") ||
    normalizedModelId.startsWith("o1") ||
    normalizedModelId.startsWith("o3") ||
    normalizedModelId.startsWith("o4")
  );
}

function supportsOpenAICompletionsReasoningModel(modelId: string) {
  const normalizedModelId = modelId.trim().toLowerCase();
  return (
    supportsCodexReasoningModel(normalizedModelId) ||
    normalizedModelId.includes("deepseek") ||
    normalizedModelId.includes("gpt-oss") ||
    normalizedModelId.includes("qwen") ||
    normalizedModelId.includes("reason") ||
    normalizedModelId.includes("think")
  );
}

function supportsOpenAICompletionsImageInputModel(modelId: string) {
  const normalizedModelId = modelId.trim().toLowerCase();
  if (normalizedModelId.includes("search-preview")) return false;
  return (
    normalizedModelId.startsWith("gpt-5") ||
    normalizedModelId.startsWith("chat-latest") ||
    normalizedModelId.startsWith("gpt-4o") ||
    normalizedModelId.startsWith("chatgpt-4o") ||
    normalizedModelId.startsWith("gpt-4.1") ||
    normalizedModelId.startsWith("gpt-4.5") ||
    normalizedModelId.startsWith("gpt-4-turbo") ||
    normalizedModelId.startsWith("o3") ||
    normalizedModelId.startsWith("o4") ||
    normalizedModelId.includes("vision") ||
    normalizedModelId.includes("qwen-vl") ||
    normalizedModelId.includes("qwen2-vl") ||
    normalizedModelId.includes("qwen2.5-vl") ||
    normalizedModelId.includes("qwen3-vl") ||
    normalizedModelId.includes("llava") ||
    normalizedModelId.includes("pixtral")
  );
}

function resolveCodexModelInput(api: CodexApi, modelId: string): Model<any>["input"] {
  if (api === "openai-responses" || supportsOpenAICompletionsImageInputModel(modelId)) {
    return ["text", "image"];
  }
  return ["text"];
}

function isOfficialOpenAIBaseUrl(baseUrl: string | undefined) {
  if (!baseUrl?.trim()) return false;
  try {
    const url = new URL(baseUrl);
    return url.hostname === "api.openai.com";
  } catch {
    return false;
  }
}

function normalizeCompatBaseUrl(baseUrl: string | undefined) {
  return baseUrl?.trim().replace(/\/+$/, "").toLowerCase() ?? "";
}

function resolveCodexOpenAICompletionsOverrides(params: {
  baseUrl: string;
  upstreamBaseUrl?: string;
  modelId: string;
}):
  | {
      compat: OpenAICompletionsCompat;
      thinkingLevelMap?: Model<"openai-completions">["thinkingLevelMap"];
    }
  | undefined {
  const compatBaseUrl = normalizeCompatBaseUrl(params.upstreamBaseUrl ?? params.baseUrl);
  if (isOfficialOpenAIBaseUrl(compatBaseUrl)) return undefined;

  const normalizedModelId = params.modelId.trim().toLowerCase();
  const isZai = compatBaseUrl.includes("api.z.ai");
  const isXai = compatBaseUrl.includes("api.x.ai");
  const isOpenRouter = compatBaseUrl.includes("openrouter.ai");
  const isGroq = compatBaseUrl.includes("groq.com");
  const isChutes = compatBaseUrl.includes("chutes.ai");
  const isDeepSeek =
    compatBaseUrl.includes("deepseek.com") || normalizedModelId.includes("deepseek");
  if (isDeepSeek) {
    return resolveDeepSeekOpenAICompletionsOverrides();
  }
  const isKnownNonOpenAIModel =
    normalizedModelId.includes("qwen") ||
    normalizedModelId.includes("gpt-oss") ||
    normalizedModelId.includes("glm") ||
    normalizedModelId.includes("kimi") ||
    normalizedModelId.includes("minimax");
  const shouldUseCompatibleDefaults =
    isKnownNonOpenAIModel ||
    isZai ||
    isXai ||
    isOpenRouter ||
    isGroq ||
    isChutes ||
    compatBaseUrl.includes("cerebras.ai") ||
    compatBaseUrl.includes("opencode.ai") ||
    !isOfficialOpenAIBaseUrl(compatBaseUrl);

  if (!shouldUseCompatibleDefaults) return undefined;

  const compat: OpenAICompletionsCompat = {
    supportsStore: false,
    supportsDeveloperRole: false,
  };

  if (isXai || isZai) {
    compat.supportsReasoningEffort = false;
  }
  if (isChutes) {
    compat.maxTokensField = "max_tokens";
  }
  if (isZai) {
    compat.thinkingFormat = "zai";
  } else if (isOpenRouter) {
    compat.thinkingFormat = "openrouter";
  }
  return {
    compat,
    ...(isGroq && normalizedModelId === "qwen/qwen3-32b"
      ? {
          thinkingLevelMap: {
            minimal: "default",
            low: "default",
            medium: "default",
            high: "default",
            xhigh: "default",
          },
        }
      : {}),
  };
}

function normalizeCodexBaseUrl(baseUrl: string): {
  baseUrl: string;
  preferredApi?: CodexApi;
} {
  let normalized = baseUrl.trim().replace(/\/+$/, "");
  const lower = normalized.toLowerCase();
  let preferredApi: CodexApi | undefined;

  if (lower.endsWith(CODEX_CHAT_COMPLETIONS_SUFFIX)) {
    normalized = normalized.slice(0, -CODEX_CHAT_COMPLETIONS_SUFFIX.length);
    preferredApi = "openai-completions";
  } else if (lower.endsWith(CODEX_RESPONSES_SUFFIX)) {
    normalized = normalized.slice(0, -CODEX_RESPONSES_SUFFIX.length);
    preferredApi = "openai-responses";
  } else if (lower.endsWith(CODEX_RESPONSE_SUFFIX)) {
    normalized = normalized.slice(0, -CODEX_RESPONSE_SUFFIX.length);
    preferredApi = "openai-responses";
  }

  return {
    baseUrl: maybeAppendCodexApiVersion(normalized),
    preferredApi,
  };
}

function inferCodexApi(requestFormat?: CodexRequestFormat, preferredApi?: CodexApi): CodexApi {
  return requestFormat ?? preferredApi ?? "openai-responses";
}

type GeminiThinkingLevel = "MINIMAL" | "LOW" | "MEDIUM" | "HIGH";
type GeminiReasoningLevel = Exclude<NonNullable<StreamOptionsEx["reasoning"]>, "xhigh">;

function normalizeGeminiReasoning(
  reasoning: StreamOptionsEx["reasoning"] | undefined,
): GeminiReasoningLevel | undefined {
  if (reasoning === "xhigh") return "high";
  return reasoning;
}

function isGemini3ProModel(modelId: string) {
  return /gemini-3(?:\.\d+)?-pro/.test(modelId.toLowerCase());
}

function isGemini3FlashModel(modelId: string) {
  return /gemini-3(?:\.\d+)?-flash/.test(modelId.toLowerCase());
}

function mapGeminiThinkingLevel(
  modelId: string,
  reasoning: GeminiReasoningLevel,
): GeminiThinkingLevel {
  if (isGemini3ProModel(modelId)) {
    return reasoning === "minimal" || reasoning === "low" ? "LOW" : "HIGH";
  }

  switch (reasoning) {
    case "minimal":
      return "MINIMAL";
    case "low":
      return "LOW";
    case "medium":
      return "MEDIUM";
    default:
      return "HIGH";
  }
}

function mapGeminiThinkingBudget(modelId: string, reasoning: GeminiReasoningLevel) {
  const normalizedModelId = modelId.toLowerCase();
  if (normalizedModelId.includes("2.5-pro")) {
    return {
      minimal: 128,
      low: 2_048,
      medium: 8_192,
      high: 32_768,
    }[reasoning];
  }
  if (normalizedModelId.includes("2.5-flash")) {
    return {
      minimal: 128,
      low: 2_048,
      medium: 8_192,
      high: 24_576,
    }[reasoning];
  }
  return -1;
}

function resolveGeminiThinkingRuntime(
  model: Model<any>,
  reasoning: StreamOptionsEx["reasoning"] | undefined,
): GoogleOptions["thinking"] {
  const normalizedReasoning = normalizeGeminiReasoning(reasoning);
  if (!normalizedReasoning) {
    return { enabled: false };
  }

  if (isGemini3ProModel(model.id) || isGemini3FlashModel(model.id)) {
    return {
      enabled: true,
      level: mapGeminiThinkingLevel(model.id, normalizedReasoning),
    };
  }

  return {
    enabled: true,
    budgetTokens: mapGeminiThinkingBudget(model.id, normalizedReasoning),
  };
}

export function createModelFromConfig(
  providerId: ProviderId,
  modelId: string,
  baseUrl: string,
  requestFormat?: CodexRequestFormat,
  modelConfig?: ProviderModelConfig,
  upstreamBaseUrl?: string,
): Model<any> {
  const defaults = getProviderModelDefaults(providerId);
  const contextWindow = modelConfig?.contextWindow ?? defaults.contextWindow;
  const maxTokens = modelConfig?.maxOutputToken ?? defaults.maxOutputToken;

  if (providerId === "codex") {
    const { baseUrl: normalizedBaseUrl, preferredApi } = normalizeCodexBaseUrl(baseUrl);
    const isDeepSeekCodex = isDeepSeekCodexTarget({
      providerId,
      baseUrl: normalizedBaseUrl,
      upstreamBaseUrl,
      modelId,
    });
    const api = isDeepSeekCodex ? "openai-completions" : inferCodexApi(requestFormat, preferredApi);
    const known = resolveKnownModel("openai", modelId, normalizedBaseUrl);
    if (known && known.api === api) {
      return applyDeepSeekModelDefaults(
        {
          ...known,
          contextWindow,
          maxTokens,
        },
        {
          providerId,
          baseUrl: normalizedBaseUrl,
          upstreamBaseUrl,
          modelId,
        },
      );
    }

    const custom: Model<any> = {
      id: modelId,
      name: modelId,
      api,
      provider: "openai",
      baseUrl: normalizedBaseUrl,
      reasoning:
        api === "openai-completions"
          ? supportsOpenAICompletionsReasoningModel(modelId)
          : supportsCodexReasoningModel(modelId),
      input: resolveCodexModelInput(api, modelId),
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow,
      maxTokens,
    };
    if (api === "openai-completions") {
      const overrides = resolveCodexOpenAICompletionsOverrides({
        baseUrl: normalizedBaseUrl,
        upstreamBaseUrl,
        modelId,
      });
      if (overrides) {
        custom.compat = overrides.compat;
        if (overrides.thinkingLevelMap) {
          custom.thinkingLevelMap = overrides.thinkingLevelMap;
        }
      }
    }
    return applyDeepSeekModelDefaults(custom, {
      providerId,
      baseUrl: normalizedBaseUrl,
      upstreamBaseUrl,
      modelId,
    });
  }

  if (providerId === "gemini") {
    const normalizedBaseUrl = maybeAppendGeminiApiVersion(baseUrl);
    const known = resolveKnownModel("google", modelId, normalizedBaseUrl);
    if (known && known.api === "google-generative-ai") {
      return {
        ...known,
        contextWindow,
        maxTokens,
      };
    }

    const custom: Model<"google-generative-ai"> = {
      id: modelId,
      name: modelId,
      api: "google-generative-ai",
      provider: "google",
      baseUrl: normalizedBaseUrl,
      reasoning: true,
      input: ["text", "image"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow,
      maxTokens,
    };
    return custom;
  }

  const known = resolveKnownModel("anthropic", modelId, baseUrl);
  if (known) {
    return applyDeepSeekModelDefaults(
      {
        ...known,
        contextWindow,
        maxTokens,
      },
      {
        providerId,
        baseUrl,
        upstreamBaseUrl,
        modelId,
      },
    );
  }

  const custom: Model<"anthropic-messages"> = {
    id: modelId,
    name: modelId,
    api: "anthropic-messages",
    provider: "anthropic",
    baseUrl,
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow,
    maxTokens,
  };
  return applyDeepSeekModelDefaults(custom, {
    providerId,
    baseUrl,
    upstreamBaseUrl,
    modelId,
  });
}

export function streamSimpleByApi(model: Model<any>, context: Context, options: StreamOptionsEx) {
  switch (model.api) {
    case "anthropic-messages": {
      // Anthropic：需要我们自己调用 streamAnthropic()，以便显式传 toolChoice（以及启用/禁用 thinking）。
      const isDeepSeekAnthropic =
        Boolean(options.deepSeekProviderAdapter || options.deepSeekDsmlToolCallRepair) ||
        isDeepSeekAnthropicTarget({
          api: model.api,
          baseUrl: model.baseUrl,
          modelId: model.id,
        });
      const anthropicThinking = isDeepSeekAnthropic
        ? resolveDeepSeekAnthropicThinkingRuntime(model, options)
        : resolveAnthropicThinkingRuntime(model, options);
      const anthropicOptions = isDeepSeekAnthropic
        ? attachDeepSeekProviderPayloadAdapter(options, {
            providerId: "claude_code",
            baseUrl: model.baseUrl,
            model,
          })
        : attachAnthropicThinkingPayloadOverride(options, anthropicThinking);
      const anthropicContext = isDeepSeekAnthropic
        ? normalizeStructuredToolCallHistoryForDeepSeek(context)
        : context;
      const stream = streamAnthropic(model as any, anthropicContext, {
        temperature: anthropicOptions.temperature,
        maxTokens: anthropicThinking.maxTokens,
        signal: anthropicOptions.signal,
        apiKey: anthropicOptions.apiKey,
        cacheRetention: anthropicOptions.cacheRetention,
        sessionId: anthropicOptions.sessionId,
        headers: anthropicOptions.headers,
        onPayload: anthropicOptions.onPayload,
        maxRetryDelayMs: anthropicOptions.maxRetryDelayMs,
        metadata: anthropicOptions.metadata,
        thinkingEnabled: anthropicThinking.thinkingEnabled,
        ...(anthropicThinking.effort ? { effort: anthropicThinking.effort as any } : {}),
        ...(anthropicThinking.thinkingBudgetTokens !== undefined
          ? { thinkingBudgetTokens: anthropicThinking.thinkingBudgetTokens }
          : {}),
        toolChoice: anthropicOptions.toolChoice ?? "none",
      });
      return isDeepSeekAnthropic || anthropicOptions.deepSeekDsmlToolCallRepair
        ? wrapDeepSeekDsmlToolCallStream(stream)
        : stream;
    }
    case "openai-completions": {
      const openAICompletionsOptions = isDeepSeekTarget({
        baseUrl: model.baseUrl,
        modelId: model.id,
      })
        ? attachDeepSeekProviderPayloadAdapter(options, {
            providerId: "codex",
            baseUrl: model.baseUrl,
            model,
          })
        : options;
      const openAICompletionsContext = openAICompletionsOptions.deepSeekProviderAdapter
        ? normalizeStructuredToolCallHistoryForDeepSeek(context)
        : context;
      const openAIOptions: OpenAICompletionsOptions = {
        ...buildOpenAIBaseOptions(model, openAICompletionsOptions),
        reasoningEffort: openAICompletionsOptions.reasoning,
        toolChoice: mapToolChoiceToOpenAI(openAICompletionsOptions.toolChoice),
      };
      return streamOpenAICompletions(model as any, openAICompletionsContext, openAIOptions);
    }
    case "openai-responses": {
      const openAIOptions: OpenAIResponsesOptions = {
        ...buildOpenAIBaseOptions(model, options),
        reasoningEffort: options.reasoning,
      };
      return streamOpenAIResponses(model as any, context, openAIOptions);
    }
    case "google-generative-ai": {
      const googleOptions: GoogleOptions = {
        temperature: options.temperature,
        maxTokens: resolveMaxTokens(options.maxTokens, model.maxTokens),
        signal: options.signal,
        apiKey: options.apiKey,
        headers: options.headers,
        onPayload: options.onPayload,
        maxRetryDelayMs: options.maxRetryDelayMs,
        metadata: options.metadata,
        thinking: resolveGeminiThinkingRuntime(model, options.reasoning),
        toolChoice: mapToolChoiceToGoogle(options.toolChoice) ?? "none",
      };
      return streamGoogle(model as any, context, googleOptions);
    }
    default:
      throw new Error(`Unsupported model API: ${model.api}`);
  }
}

function buildTextOnlyCallContext(
  context: Context,
  options?: { allowJsonOutput?: boolean },
): Context {
  return {
    ...context,
    systemPrompt: appendSystemPrompt(
      context.systemPrompt,
      buildTextOnlySystemSuffix(options?.allowJsonOutput),
    ),
  };
}

function buildTextOnlyStreamOptions(params: {
  providerId: ProviderId;
  runtime: ProviderRuntimeConfig;
  model: Model<any>;
  context?: Context;
  workdir?: string;
  headers: Record<string, string>;
  hostedSearchProbeId?: string;
  signal?: AbortSignal;
  sessionId?: string;
  cacheRetention?: CacheRetention;
  nativeWebSearch?: boolean;
  debugLogger?: StreamDebugLogger;
}): StreamOptionsEx {
  const sessionId = normalizeSessionId(params.sessionId);
  const nativeWebSearch =
    providerSupportsNativeWebSearch(params.providerId, params.model.api, {
      baseUrl: params.runtime.baseUrl,
      modelId: params.model.id,
    }) && params.nativeWebSearch;
  const usesOpenAIChatNativeWebSearch =
    nativeWebSearch && params.providerId === "codex" && params.model.api === "openai-completions";
  const options: StreamOptionsEx = {
    apiKey: params.runtime.apiKey,
    headers: withHostedSearchProbeHeader(params.headers, params.hostedSearchProbeId),
    signal: params.signal,
    sessionId,
    cacheRetention: resolveProviderCacheRetention(
      params.providerId,
      params.runtime.promptCachingEnabled,
      params.cacheRetention,
    ),
    metadata: buildProviderRequestMetadata(params.providerId, sessionId),
    reasoning:
      (params.providerId === "codex" &&
        (params.model.api === "openai-responses" || params.model.api === "openai-completions")) ||
      (params.providerId === "claude_code" && params.model.api === "anthropic-messages") ||
      (params.providerId === "gemini" && params.model.api === "google-generative-ai")
        ? toSimpleStreamReasoning(params.runtime.reasoning)
        : undefined,
    // Text-only mode cannot execute local tools. Provider-native web search is
    // hosted by the upstream provider, so it can stay on auto when explicitly enabled.
    toolChoice: usesOpenAIChatNativeWebSearch ? undefined : nativeWebSearch ? "auto" : "none",
  };
  return finalizeProviderStreamOptions({
    providerId: params.providerId,
    baseUrl: params.runtime.baseUrl,
    options,
    context: params.context,
    model: params.model,
    workdir: params.workdir,
    nativeWebSearch: params.nativeWebSearch,
    debugLogger: params.debugLogger,
    extra: { sessionId },
  });
}

export async function streamAssistantMessage(params: {
  providerId: ProviderId;
  model: string;
  runtime: ProviderRuntimeConfig;
  context: Context;
  workdir?: string;
  onTextDelta: (delta: string) => void;
  sessionId?: string;
  cacheRetention?: CacheRetention;
  signal?: AbortSignal;
  debugLogger?: StreamDebugLogger;
  allowJsonOutput?: boolean;
  nativeWebSearch?: boolean;
  onHostedSearch?: (block: HostedSearchBlock) => void;
}) {
  const modelId = params.model.trim();
  if (!modelId) throw new Error("No model selected");
  if (!params.runtime.baseUrl.trim()) throw new Error("Base URL cannot be empty");
  if (!params.runtime.apiKey.trim()) throw new Error("API Key cannot be empty");

  const proxyRequest = await prepareProxyRequest(
    params.providerId,
    params.runtime.baseUrl.trim(),
    buildProviderAuthHeaders(params.providerId, params.runtime.apiKey),
  );

  const m = createModelFromConfig(
    params.providerId,
    modelId,
    proxyRequest.baseUrl,
    params.runtime.requestFormat,
    params.runtime.modelConfig,
    params.runtime.baseUrl.trim(),
  );

  const callContext = buildTextOnlyCallContext(params.context, {
    allowJsonOutput: params.allowJsonOutput,
  });
  const shouldProbeHostedSearch =
    Boolean(params.nativeWebSearch) &&
    providerSupportsNativeWebSearch(params.providerId, m.api, {
      baseUrl: params.runtime.baseUrl,
      modelId: m.id,
    });
  const hostedSearchProbeId = shouldProbeHostedSearch
    ? createHostedSearchProbeId(params.providerId)
    : undefined;
  const options = buildTextOnlyStreamOptions({
    providerId: params.providerId,
    runtime: params.runtime,
    model: m,
    context: callContext,
    workdir: params.workdir,
    headers: proxyRequest.headers,
    hostedSearchProbeId,
    signal: params.signal,
    sessionId: params.sessionId,
    cacheRetention: params.cacheRetention,
    nativeWebSearch: params.nativeWebSearch,
    debugLogger: params.debugLogger,
  });

  params.debugLogger?.logRequest(
    buildStreamRequestDebugPayload({
      runtime: params.runtime,
      context: callContext,
      options,
    }),
  );

  return withPowerActivity("assistant-stream", `${params.providerId}:${modelId}`, async () => {
    const orderedBlocks: HostedSearchOrderedBlock[] = [];
    const appendOrderedText = (delta: string) => {
      if (!delta) return;
      const last = orderedBlocks[orderedBlocks.length - 1];
      if (last?.kind === "text") {
        orderedBlocks[orderedBlocks.length - 1] = {
          kind: "text",
          text: last.text + delta,
        };
      } else {
        orderedBlocks.push({ kind: "text", text: delta });
      }
    };
    const upsertOrderedHostedSearch = (hostedSearch: HostedSearchBlock) => {
      const idx = orderedBlocks.findIndex(
        (block) => block.kind === "hostedSearch" && block.item.id === hostedSearch.id,
      );
      if (idx >= 0) {
        const existing = orderedBlocks[idx];
        if (existing?.kind === "hostedSearch") {
          orderedBlocks[idx] = {
            kind: "hostedSearch",
            item: mergeHostedSearchBlocks(existing.item, hostedSearch),
          };
        }
        return;
      }
      orderedBlocks.push({ kind: "hostedSearch", item: hostedSearch });
    };
    const hostedSearchAggregator = createHostedSearchEventAggregator({
      providerId: params.providerId,
      onHostedSearch: (hostedSearch) => {
        upsertOrderedHostedSearch(hostedSearch);
        params.onHostedSearch?.(hostedSearch);
      },
    });
    const hostedSearchProbe = startHostedSearchFetchProbe({
      providerId: params.providerId,
      sessionId: normalizeSessionId(params.sessionId),
      requestId: hostedSearchProbeId,
      enabled: shouldProbeHostedSearch,
      onRawEvent: hostedSearchAggregator.accept,
    });
    try {
      let activeContext = callContext;
      for (let toolRecoveryTurn = 0; toolRecoveryTurn < 4; toolRecoveryTurn += 1) {
        const s = streamSimpleByApi(m, activeContext, options);
        const textReconciler = createStreamingTextReconciler();

        for await (const event of s) {
          params.debugLogger?.logResponse(event);
          if (event.type === "text_delta") {
            const delta = textReconciler.appendDelta(String(event.contentIndex), event.delta);
            if (delta) {
              appendOrderedText(delta);
              params.onTextDelta(delta);
            }
          } else if (event.type === "text_end") {
            const delta = textReconciler.reconcileFinalText(
              String(event.contentIndex),
              event.content,
            );
            if (delta) {
              appendOrderedText(delta);
              params.onTextDelta(delta);
            }
          }
        }

        let final = await s.result();
        if (final.stopReason === "error" || final.stopReason === "aborted") {
          throw new Error(
            normalizeErrorMessage(
              final.errorMessage,
              final.stopReason === "aborted" ? "Cancelled" : "Request failed",
            ),
          );
        }

        const textModeToolResults = buildTextModeToolResultsForAssistant(
          final,
          hostedSearchAggregator.getBlocks(),
        );
        if (textModeToolResults.length > 0) {
          params.debugLogger?.logResponse({
            type: "text_mode_tool_result_recovery",
            toolRecoveryTurn,
            toolResults: textModeToolResults,
          });
          activeContext = {
            ...activeContext,
            messages: [...activeContext.messages, final, ...textModeToolResults],
          };
          continue;
        }

        await hostedSearchProbe.finish();
        final = appendHostedSearchBlocksToAssistant(
          final as AssistantMessage & { content: unknown[] },
          hostedSearchAggregator.complete(),
          { orderedBlocks },
        ) as AssistantMessage;
        params.debugLogger?.logResult(final);
        await params.debugLogger?.flush();
        return final;
      }

      throw new Error("Too many text-mode tool-call recovery attempts");
    } catch (error) {
      await hostedSearchProbe.finish();
      if (params.signal?.aborted) {
        hostedSearchAggregator.dispose();
      } else {
        hostedSearchAggregator.fail();
      }
      params.debugLogger?.logError(error);
      await params.debugLogger?.flush();
      throw error;
    }
  });
}

export async function completeAssistantMessage(params: {
  providerId: ProviderId;
  model: string;
  runtime: ProviderRuntimeConfig;
  context: Context;
  sessionId?: string;
  cacheRetention?: CacheRetention;
  signal?: AbortSignal;
  debugLogger?: StreamDebugLogger;
  allowJsonOutput?: boolean;
}) {
  const modelId = params.model.trim();
  if (!modelId) throw new Error("No model selected");
  if (!params.runtime.baseUrl.trim()) throw new Error("Base URL cannot be empty");
  if (!params.runtime.apiKey.trim()) throw new Error("API Key cannot be empty");

  const proxyRequest = await prepareProxyRequest(
    params.providerId,
    params.runtime.baseUrl.trim(),
    buildProviderAuthHeaders(params.providerId, params.runtime.apiKey),
  );

  const m = createModelFromConfig(
    params.providerId,
    modelId,
    proxyRequest.baseUrl,
    params.runtime.requestFormat,
    params.runtime.modelConfig,
    params.runtime.baseUrl.trim(),
  );

  const callContext = buildTextOnlyCallContext(params.context, {
    allowJsonOutput: params.allowJsonOutput,
  });
  const options = buildTextOnlyStreamOptions({
    providerId: params.providerId,
    runtime: params.runtime,
    model: m,
    context: callContext,
    headers: proxyRequest.headers,
    signal: params.signal,
    sessionId: params.sessionId,
    cacheRetention: params.cacheRetention,
    debugLogger: params.debugLogger,
  });

  params.debugLogger?.logRequest(
    buildStreamRequestDebugPayload({
      runtime: params.runtime,
      context: callContext,
      options,
    }),
  );

  return withPowerActivity("assistant-complete", `${params.providerId}:${modelId}`, async () => {
    try {
      const s = streamSimpleByApi(m, callContext, options);
      const final = await s.result();

      if (final.stopReason === "error" || final.stopReason === "aborted") {
        throw new Error(
          normalizeErrorMessage(
            final.errorMessage,
            final.stopReason === "aborted" ? "Cancelled" : "Request failed",
          ),
        );
      }

      params.debugLogger?.logResult(final);
      await params.debugLogger?.flush();
      return final;
    } catch (error) {
      params.debugLogger?.logError(error);
      await params.debugLogger?.flush();
      throw error;
    }
  });
}
