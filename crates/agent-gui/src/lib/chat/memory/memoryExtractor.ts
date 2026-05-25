import type { Message } from "@mariozechner/pi-ai";

import { assistantMessageToText } from "../../providers/llm";
import { memoryApplyBatch, memoryTodayLocalDate } from "../../memory/api";
import type { ConversationViewState } from "../conversation/conversationState";

const EXTRACTOR_THROTTLE_MS = 5 * 60_000;
const EXTRACTOR_STATE_CONVERSATION_LIMIT = 128;
const extractorStateByConversation = new Map<
  string,
  { lastRunAt: number; lastMessageCount: number; pending: boolean }
>();

type ExtractedDecision = {
  op: "upsert";
  slug: string;
  scope: "global" | "project";
  memoryType: "user" | "feedback" | "project" | "reference";
  description: string;
  body: string;
};

type LatestTurn = {
  userText: string;
  assistantText: string;
};

function messageText(message: Message): string {
  if (message.role === "assistant") return assistantMessageToText(message);
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((item) => {
        if (typeof item === "string") return item;
        if (item && typeof item === "object" && "text" in item) {
          const text = (item as { text?: unknown }).text;
          return typeof text === "string" ? text : "";
        }
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

function flattenMessages(state: ConversationViewState) {
  return state.segments.flatMap((segment) => segment.messages);
}

function countRuntimeMessages(state: ConversationViewState) {
  return state.segments.reduce((count, segment) => count + segment.messages.length, 0);
}

function pruneExtractorState() {
  if (extractorStateByConversation.size <= EXTRACTOR_STATE_CONVERSATION_LIMIT) return;
  const entries = Array.from(extractorStateByConversation.entries()).sort(
    (a, b) => a[1].lastRunAt - b[1].lastRunAt,
  );
  for (const [conversationId] of entries.slice(
    0,
    extractorStateByConversation.size - EXTRACTOR_STATE_CONVERSATION_LIMIT,
  )) {
    extractorStateByConversation.delete(conversationId);
  }
}

export function clearMemoryExtractorState(conversationId: string): void {
  const key = conversationId.trim();
  if (!key) return;
  extractorStateByConversation.delete(key);
}

function slugify(input: string, fallback: string) {
  const ascii = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  if (ascii.length >= 3) return ascii;
  return fallback;
}

function uniqueDecisions(decisions: ExtractedDecision[]) {
  const byKey = new Map<string, ExtractedDecision>();
  for (const decision of decisions) {
    byKey.set(`${decision.scope}:${decision.slug}`, decision);
  }
  return Array.from(byKey.values()).slice(0, 8);
}

function extractIdentity(text: string): ExtractedDecision[] {
  const out: ExtractedDecision[] = [];
  const nameMatch =
    text.match(/(?:我叫|我的名字是|请叫我)\s*([A-Za-z0-9_\-\u4e00-\u9fa5]{1,40})/) ??
    text.match(/my name is\s+([A-Za-z0-9_\-]{1,40})/i);
  const profileMatch =
    text.match(/我叫\s*[^，,。.\n]+[，,]\s*(?:是|我是)?(?:一个|一名)?([^。.\n]{2,80})/) ??
    text.match(/我是(?:一个|一名)?([^。.\n]{2,80})/);

  if (nameMatch?.[1]) {
    const name = nameMatch[1].trim();
    out.push({
      op: "upsert",
      slug: "user-name",
      scope: "global",
      memoryType: "user",
      description: `用户名字是 ${name}`,
      body: `用户的名字是 ${name}。`,
    });
  }

  if (profileMatch?.[1]) {
    const profile = profileMatch[1].trim();
    if (/学生|工程师|开发者|专业|研究|teacher|student|engineer|developer/i.test(profile)) {
      out.push({
        op: "upsert",
        slug: "user-profile",
        scope: "global",
        memoryType: "user",
        description: `用户身份：${profile}`,
        body: `用户身份与背景：${profile}。`,
      });
    }
  }

  return out;
}

function extractExplicitRemember(text: string): ExtractedDecision[] {
  const matches = Array.from(
    text.matchAll(
      /(?:^|[。.\n!?！？；;，,])\s*(?:请你?|麻烦你?|帮我|替我)?(?:记住|remember that|please remember)\s*[:：]?\s*([^。.\n!?！？]{4,180})/gi,
    ),
  );
  return matches.flatMap((match, index) => {
    const fact = match[1].trim();
    if (/^(?:了|什么|哪些|啥|吗|么)/.test(fact)) return [];
    if (/[?？]$/.test(fact)) return [];
    const looksLikePreference = /以后|默认|偏好|喜欢|不要|必须|回答|使用|prefer|always|never/i.test(fact);
    const slug = slugify(fact, `user-note-${index + 1}`);
    return [{
      op: "upsert",
      slug: looksLikePreference ? `feedback-${slug}`.slice(0, 64) : `reference-${slug}`.slice(0, 64),
      scope: looksLikePreference ? "global" : "project",
      memoryType: looksLikePreference ? "feedback" : "reference",
      description: fact.slice(0, 120),
      body: looksLikePreference
        ? `${fact}\n\n**Why:** 用户明确要求记住这条偏好或约束。\n**How to apply:** 未来相关任务中优先参考，但以当前用户消息为准。`
        : fact,
    } satisfies ExtractedDecision];
  });
}

function extractPreference(text: string): ExtractedDecision[] {
  const patterns = [
    /以后([^。.\n]{4,120})/g,
    /我(?:更)?(?:偏好|喜欢)([^。.\n]{4,120})/g,
    /默认([^。.\n]{4,120})/g,
  ];
  const out: ExtractedDecision[] = [];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const fact = match[0].trim();
      if (!/回复|回答|使用|不要|必须|偏好|默认|测试|代码|UI|中文|英文/.test(fact)) continue;
      const slug = `feedback-${slugify(fact, "preference")}`.slice(0, 64);
      out.push({
        op: "upsert",
        slug,
        scope: "global",
        memoryType: "feedback",
        description: fact.slice(0, 120),
        body: `${fact}\n\n**Why:** 用户在对话中表达了可复用偏好。\n**How to apply:** 未来相同场景优先遵守；如果当前请求另有说明，以当前请求为准。`,
      });
    }
  }
  return out;
}

function latestCompletedTurn(messages: Message[]): LatestTurn | null {
  for (let assistantIndex = messages.length - 1; assistantIndex >= 0; assistantIndex -= 1) {
    const assistant = messages[assistantIndex];
    if (assistant?.role !== "assistant") continue;
    const assistantText = messageText(assistant).trim();
    if (!assistantText) continue;
    for (let userIndex = assistantIndex - 1; userIndex >= 0; userIndex -= 1) {
      const user = messages[userIndex];
      if (user?.role !== "user") continue;
      const userText = messageText(user).trim();
      if (!userText) continue;
      return { userText, assistantText };
    }
  }
  return null;
}

function isMemoryIntrospection(text: string) {
  return /(?:今天|当前|现在)?.{0,12}(?:记忆|memory).{0,12}(?:哪些|什么|啥|优先级|权重|读取|展示|查看|回顾)/i.test(text);
}

function shouldWriteDaily(userText: string, assistantText: string) {
  if (isMemoryIntrospection(userText)) return false;
  return /完成|实现|修复|决定|采用|排查|验证|测试|重构|上线|blocked|fixed|implemented|decided/i.test(
    `${userText}\n${assistantText}`,
  );
}

function buildDailyAppend(params: {
  conversationId: string;
  workdir?: string;
  userText: string;
  assistantText: string;
}) {
  const project = params.workdir?.split(/[\\/]/).filter(Boolean).pop() || "workspace";
  const time = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const userSummary = params.userText.split(/\n+/).find(Boolean)?.slice(0, 160) || "用户推进了一轮任务";
  const assistantSummary =
    params.assistantText.split(/\n+/).find(Boolean)?.slice(0, 160) || "助手完成了本轮处理";
  return {
    bullet: [
      `## ${time} — conversation ${params.conversationId.slice(0, 8)} — ${project}`,
      `- User: ${userSummary}`,
      `- Assistant: ${assistantSummary}`,
    ].join("\n"),
  };
}

export const __memoryExtractorTestInternals = {
  extractExplicitRemember,
  latestCompletedTurn,
  isMemoryIntrospection,
  shouldWriteDaily,
  buildDailyAppend,
};

export type HeuristicMemorySuggestion = {
  slug: string;
  scope: "global" | "project";
  memoryType: "user" | "feedback" | "project" | "reference";
  description: string;
};

/**
 * Run the regex-based extractors on the latest user message and return them
 * as suggestions (NOT writes). Designed as input to the silent-memory LLM
 * round so the model can confirm or reject heuristic candidates rather than
 * having two extractors race to write the same slug.
 */
export function collectHeuristicSuggestions(userText: string): HeuristicMemorySuggestion[] {
  const text = userText.trim();
  if (!text) return [];
  const decisions = uniqueDecisions([
    ...extractIdentity(text),
    ...extractExplicitRemember(text),
    ...extractPreference(text),
  ]);
  return decisions.map((decision) => ({
    slug: decision.slug,
    scope: decision.scope,
    memoryType: decision.memoryType,
    description: decision.description,
  }));
}

export async function runMemoryExtractor(params: {
  trigger: "end" | "compaction";
  conversationId: string;
  workdir?: string;
  model?: string;
  state: ConversationViewState;
}) {
  const messageCount = countRuntimeMessages(params.state);
  const previous = extractorStateByConversation.get(params.conversationId);
  const now = Date.now();
  if (
    previous &&
    previous.lastMessageCount === messageCount &&
    previous.pending !== true
  ) {
    return;
  }
  if (previous && now - previous.lastRunAt < EXTRACTOR_THROTTLE_MS) {
    extractorStateByConversation.set(params.conversationId, {
      ...previous,
      pending: true,
    });
    pruneExtractorState();
    return;
  }

  const messages = flattenMessages(params.state).slice(-12);
  const latestTurn = latestCompletedTurn(messages);
  const userText = latestTurn?.userText ?? "";
  if (!userText.trim()) return;
  const assistantText = latestTurn?.assistantText ?? "";

  // Durable memory writes are handled by the silent LLM extractor so every
  // mutation goes through read-before-decide, four-block validation, and
  // rejection/candidate checks. Keep this legacy path daily-only.
  const decisions: ExtractedDecision[] = [];
  const dailyAppend = shouldWriteDaily(userText, assistantText)
    ? buildDailyAppend({
        conversationId: params.conversationId,
        workdir: params.workdir,
        userText,
        assistantText,
      })
    : undefined;

  if (!dailyAppend && decisions.length === 0) {
    extractorStateByConversation.set(params.conversationId, {
      lastRunAt: now,
      lastMessageCount: messageCount,
      pending: false,
    });
    pruneExtractorState();
    return;
  }

  const localDate = await memoryTodayLocalDate();
  await memoryApplyBatch({
    workdir: params.workdir,
    conversationId: params.conversationId,
    trigger: params.trigger,
    model: params.model,
    localDate,
    dailyAppend,
    decisions,
  });
  extractorStateByConversation.set(params.conversationId, {
    lastRunAt: now,
    lastMessageCount: messageCount,
    pending: false,
  });
  pruneExtractorState();
}
