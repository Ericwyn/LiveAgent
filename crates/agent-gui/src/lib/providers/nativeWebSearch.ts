import type { ToolCall, ToolResultMessage } from "@earendil-works/pi-ai";
import type { HostedSearchBlock } from "../chat/messages/hostedSearch";
import type { ProviderId } from "../settings";

export const HIDDEN_PROVIDER_NATIVE_WEB_SEARCH_TOOL_NAMES = [
  "WebSearch",
  "web_search",
  "builtin_web_search",
  "web_search_20250305",
  "web_search_20260209",
  "web_search_preview",
] as const;

export function isProviderNativeWebSearchToolName(toolName: string | undefined) {
  const normalized = toolName?.trim().toLowerCase() ?? "";
  return (
    normalized === "builtin_web_search" ||
    normalized === "websearch" ||
    normalized === "web_search" ||
    normalized === "web_search_20250305" ||
    normalized === "web_search_20260209" ||
    normalized === "web_search_preview" ||
    normalized.startsWith("web_search_call")
  );
}

function readToolCallStringArgument(toolCall: ToolCall, name: string) {
  const args = toolCall.arguments;
  if (!args || typeof args !== "object") return "";
  const value = (args as Record<string, unknown>)[name];
  return typeof value === "string" ? value.trim() : "";
}

export function readProviderNativeWebSearchQuery(toolCall: ToolCall) {
  return (
    readToolCallStringArgument(toolCall, "query") ||
    readToolCallStringArgument(toolCall, "search_query") ||
    readToolCallStringArgument(toolCall, "additionalContext")
  );
}

export function buildProviderNativeWebSearchBridgeResult(params: {
  toolCall: ToolCall;
  hostedSearchBlocks: HostedSearchBlock[];
  sourcesIntro: string;
  fallbackText: string;
  extraInstructions?: string[];
}): ToolResultMessage {
  const query = readProviderNativeWebSearchQuery(params.toolCall);
  const sources = params.hostedSearchBlocks
    .flatMap((block) => block.sources)
    .filter((source, index, all) => all.findIndex((item) => item.url === source.url) === index)
    .slice(0, 10);
  const sourceLines = sources.map((source, index) => {
    const title = source.title?.trim() || source.url;
    return `${index + 1}. ${title} - ${source.url}`;
  });
  const text = [
    "Recovered a provider-native web search request that was emitted as raw tool-call markup instead of a structured provider tool call.",
    query ? `Requested query: ${query}` : "",
    sourceLines.length > 0 ? [params.sourcesIntro, ...sourceLines].join("\n") : params.fallbackText,
    ...(params.extraInstructions ?? []),
  ]
    .filter(Boolean)
    .join("\n\n");

  return {
    role: "toolResult",
    toolCallId: params.toolCall.id,
    toolName: params.toolCall.name,
    content: [{ type: "text", text }],
    details: {
      recoveredProviderNativeWebSearch: true,
      query,
      sourceCount: sources.length,
      sources,
    },
    isError: false,
    timestamp: Date.now(),
  };
}

export function providerSupportsNativeWebSearch(
  providerId: ProviderId,
  api: string | undefined,
  options?: {
    baseUrl?: string;
    modelId?: string;
  },
) {
  if (providerId === "codex" && api === "openai-completions") {
    if (!options?.baseUrl?.trim()) return false;
    if (isOfficialOpenAIBaseUrl(options.baseUrl)) {
      return supportsOpenAIChatCompletionsNativeWebSearchModel(options.modelId);
    }
    return true;
  }

  return (
    (providerId === "codex" && api === "openai-responses") ||
    (providerId === "claude_code" && api === "anthropic-messages") ||
    (providerId === "gemini" && api === "google-generative-ai")
  );
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

function supportsOpenAIChatCompletionsNativeWebSearchModel(modelId: string | undefined) {
  const normalized = modelId?.trim().toLowerCase() ?? "";
  return normalized.includes("search-preview");
}
