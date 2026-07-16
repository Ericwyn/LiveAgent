import type { Model, ModelThinkingLevel, OpenAICompletionsCompat } from "@earendil-works/pi-ai";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { getBuiltinModel } from "@earendil-works/pi-ai/providers/all";
import {
  type CodexRequestFormat,
  getProviderModelDefaults,
  type ProviderId,
  type ProviderModelConfig,
} from "../../settings";
import {
  applyDeepSeekModelDefaults,
  isDeepSeekCodexTarget,
  resolveDeepSeekOpenAICompletionsOverrides,
} from "../deepSeekProviderAdapter";

const CODEX_RESPONSES_SUFFIX = "/responses";
const CODEX_RESPONSE_SUFFIX = "/response";
const CODEX_CHAT_COMPLETIONS_SUFFIX = "/chat/completions";

type CodexApi = "openai-responses" | "openai-completions";

function resolveKnownModel(
  provider: "openai" | "anthropic" | "google",
  modelId: string,
  baseUrl: string,
): Model<any> | undefined {
  const known = getBuiltinModel(provider as any, modelId as any) as Model<any> | undefined;
  return known?.api ? ({ ...known, baseUrl } as Model<any>) : undefined;
}

// ---------------------------------------------------------------------------
// Anthropic 目录回查与自定义模型思考能力推断
// ---------------------------------------------------------------------------

// 中转/网关常给官方 Anthropic 模型 id 加装饰（日期后缀、@版本、大小写变化），逐字
// 匹配会漏检；漏检后模型丢失 compat.forceAdaptiveThinking，思考配置退化成 4.7+/
// Fable 世代已删除的 budget_tokens（官方端点 400、中转剥字段后档位彻底失效）。
// 先精确查，再按规范化候选回查目录；命中则继承完整目录元数据，但保留用户配置的
// 原始 id——请求体里的 model 字段必须是端点认识的字符串。
function normalizeAnthropicModelIdCandidates(modelId: string): string[] {
  const candidates: string[] = [];
  const push = (value: string) => {
    if (value && !candidates.includes(value)) candidates.push(value);
  };
  push(modelId);
  const lower = modelId.toLowerCase();
  push(lower);
  const withoutAtVersion = lower.split("@")[0];
  push(withoutAtVersion);
  push(withoutAtVersion.replace(/-20\d{6}$/, ""));
  return candidates;
}

function resolveKnownAnthropicModel(modelId: string, baseUrl: string): Model<any> | undefined {
  for (const candidate of normalizeAnthropicModelIdCandidates(modelId)) {
    const known = resolveKnownModel("anthropic", candidate, baseUrl);
    if (known) {
      return { ...known, id: modelId, name: modelId } as Model<any>;
    }
  }
  return undefined;
}

function isAnthropicMythosPreview(normalizedModelId: string) {
  return normalizedModelId.includes("mythos-preview");
}

function isClaudeFamilyVersionAtLeast(
  normalizedModelId: string,
  family: "opus" | "sonnet",
  minimumMinor: number,
) {
  // minor 限定 1-2 位数字，避免把日期后缀（如 claude-sonnet-4-20250514）误读成小版本号；
  // 同时接受三方中转的倒序命名（claude-4.6-sonnet）。
  const match = normalizedModelId.match(
    new RegExp(`(?:${family}[-.]4[-.](\\d{1,2})(?!\\d)|4[-.](\\d{1,2})(?!\\d)[-.]${family})`),
  );
  if (!match) return false;
  const minor = Number(match[1] ?? match[2]);
  return Number.isFinite(minor) && minor >= minimumMinor;
}

// Claude 5 起（sonnet-5 / fable-5 / mythos-5 等）整个家族都是 adaptive thinking 且支持 xhigh。
// 倒序写法（claude-5-sonnet）用负向后行断言排除 3-5-sonnet 这类旧世代小版本号。
function isClaudeFamilyMajorVersionAtLeast(normalizedModelId: string, minimumMajor: number) {
  const match = normalizedModelId.match(
    /(?:(?:opus|sonnet|haiku|fable|mythos)[-.](\d{1,2})(?!\d)|(?<!\d[-.])(\d{1,2})[-.](?:opus|sonnet|haiku|fable|mythos))/,
  );
  if (!match) return false;
  const major = Number(match[1] ?? match[2]);
  return Number.isFinite(major) && major >= minimumMajor;
}

// 目录彻底未命中的三方改名 id（如 claude-4.6-sonnet）退回 ee8dba1 之前的 id 启发式：
// 能识别为 adaptive 家族的补上 compat.forceAdaptiveThinking 与 xhigh/max 档位声明，
// pi-ai stream() 与本地 thinkingLevels.ts 都以模型对象上的这两个字段为准。
export function deriveAnthropicThinkingOverridesForCustomModel(modelId: string): {
  compat?: Model<"anthropic-messages">["compat"];
  thinkingLevelMap?: Model<"anthropic-messages">["thinkingLevelMap"];
} {
  const id = modelId.trim().toLowerCase();
  const adaptive =
    isAnthropicMythosPreview(id) ||
    isClaudeFamilyVersionAtLeast(id, "opus", 6) ||
    isClaudeFamilyVersionAtLeast(id, "sonnet", 6) ||
    isClaudeFamilyMajorVersionAtLeast(id, 5);
  if (!adaptive) return {};

  // xhigh：Opus 4.7+ 与 Claude 5 家族；Mythos Preview / Opus 4.6 / Sonnet 4.6 只到 max。
  const supportsXHigh =
    isClaudeFamilyVersionAtLeast(id, "opus", 7) || isClaudeFamilyMajorVersionAtLeast(id, 5);
  return {
    compat: { forceAdaptiveThinking: true },
    thinkingLevelMap: supportsXHigh ? { xhigh: "xhigh", max: "max" } : { max: "max" },
  };
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

export function createModelFromConfig(
  providerId: ProviderId,
  modelId: string,
  baseUrl: string,
  requestFormat?: CodexRequestFormat,
  modelConfig?: ProviderModelConfig,
  upstreamBaseUrl?: string,
): Model<any> {
  const defaults = getProviderModelDefaults(providerId, modelId);
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
      // 目录之外的自定义模型无法从 id 可靠判断推理能力，与 anthropic/gemini
      // 自定义分支一致按可推理处理（标准档位，xhigh/max 仍需目录 opt-in），
      // 是否真的下发思考由用户的开关决定。
      reasoning: true,
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

  const known = resolveKnownAnthropicModel(modelId, baseUrl);
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

  const thinkingOverrides = deriveAnthropicThinkingOverridesForCustomModel(modelId);
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
    ...(thinkingOverrides.compat ? { compat: thinkingOverrides.compat } : {}),
    ...(thinkingOverrides.thinkingLevelMap
      ? { thinkingLevelMap: thinkingOverrides.thinkingLevelMap }
      : {}),
  };
  return applyDeepSeekModelDefaults(custom, {
    providerId,
    baseUrl,
    upstreamBaseUrl,
    modelId,
  });
}

export function getAvailableThinkingLevelsForModel(
  providerId: ProviderId,
  modelId: string,
  baseUrl: string,
  requestFormat?: CodexRequestFormat,
  modelConfig?: ProviderModelConfig,
  upstreamBaseUrl?: string,
): ModelThinkingLevel[] {
  if (!modelId.trim()) return [];
  const model = createModelFromConfig(
    providerId,
    modelId,
    baseUrl,
    requestFormat,
    modelConfig,
    upstreamBaseUrl,
  );
  return getSupportedThinkingLevels(model).filter((level) => level !== "off");
}

export function isThinkingAlwaysOnForModel(
  providerId: ProviderId,
  modelId: string,
  baseUrl: string,
  requestFormat?: CodexRequestFormat,
  modelConfig?: ProviderModelConfig,
  upstreamBaseUrl?: string,
): boolean {
  if (!modelId.trim()) return false;
  const model = createModelFromConfig(
    providerId,
    modelId,
    baseUrl,
    requestFormat,
    modelConfig,
    upstreamBaseUrl,
  );
  return !getSupportedThinkingLevels(model).includes("off");
}
