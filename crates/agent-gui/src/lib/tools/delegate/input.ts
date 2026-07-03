import { MAX_AGENTS } from "./constants";
import type {
  DelegateAgentInput,
  DelegateApplyPolicy,
  DelegateExecutionMode,
  DelegateTaskIntent,
} from "./types";
import { optionalString } from "./utils";

function normalizeExecutionModeOpt(value: unknown): DelegateExecutionMode | undefined {
  return value === "readonly" || value === "worktree" ? value : undefined;
}

function normalizeTaskIntent(value: unknown): DelegateTaskIntent | undefined {
  return value === "communication" ||
    value === "research" ||
    value === "review" ||
    value === "implementation" ||
    value === "document_generation"
    ? value
    : undefined;
}

function normalizeApplyPolicy(value: unknown): DelegateApplyPolicy | undefined {
  return value === "none" || value === "explicit" || value === "auto" ? value : undefined;
}

function normalizeBoolean(value: unknown, fallback: boolean) {
  return typeof value === "boolean" ? value : fallback;
}

function normalizePathList(value: unknown): string[] {
  const rawItems = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(/[,\n]/g)
      : [];
  const out: string[] = [];
  for (const raw of rawItems) {
    if (typeof raw !== "string") continue;
    const normalized = raw.trim().replace(/\\/g, "/").replace(/^\.\//, "");
    if (normalized && !out.includes(normalized)) out.push(normalized);
  }
  return out;
}

function maybeOutputPath(value: string) {
  const text = value.trim().replace(/^[`"'“”‘’]+|[`"'“”‘’，,。.；;:：)）\]]+$/g, "");
  if (!text || /[*?[\]]/.test(text) || /^https?:\/\//i.test(text)) return "";
  if (/\s/.test(text)) return "";
  if (!/\.[a-z0-9]{1,12}$/i.test(text)) return "";
  return text.replace(/\\/g, "/").replace(/^\.\//, "");
}

function inferAllowedOutputPaths(params: { prompt?: string }): string[] {
  const text = params.prompt ?? "";
  const out: string[] = [];
  const pushPath = (value: string) => {
    const normalized = maybeOutputPath(value);
    if (normalized && !out.includes(normalized)) out.push(normalized);
  };

  for (const match of text.matchAll(/`([^`\r\n]{1,240})`/g)) {
    pushPath(match[1] ?? "");
  }
  for (const match of text.matchAll(/["“'‘]([^"“”'‘’\r\n]{1,240}\.[a-z0-9]{1,12})["”'’]/gi)) {
    pushPath(match[1] ?? "");
  }
  for (const match of text.matchAll(
    /(?:^|[\s(（])((?:[A-Za-z0-9._\-\u4e00-\u9fff]+\/)+[A-Za-z0-9._\-\u4e00-\u9fff]+\.[A-Za-z0-9]{1,12})(?=$|[\s)）。；;，,])/g,
  )) {
    pushPath(match[1] ?? "");
  }

  return out;
}

function textMatches(text: string, pattern: RegExp) {
  return pattern.test(text);
}

function inferTaskIntent(params: { prompt?: string }): DelegateTaskIntent {
  const text = (params.prompt ?? "").toLowerCase();
  if (
    textMatches(
      text,
      /(\.md\b|\.txt\b|\.markdown\b|\.rst\b|save\s+(it\s+)?to\s+(a\s+)?file|create\s+(a\s+)?(file|document)|write\s+(a\s+)?(file|document)|生成.*(文件|文档)|保存.*(文件|文档)|写(入|到|成).*(文件|文档))/i,
    )
  ) {
    return "document_generation";
  }
  if (
    textMatches(
      text,
      /(implement|fix|patch|refactor|modify\s+files?|edit\s+files?|write\s+(code|tests?)|run\s+tests?|add\s+(tests?|feature)|update\s+(code|files?)|实现|修复|补丁|重构|修改(代码|文件)?|编辑(代码|文件)?|新增(测试|功能)|补充测试|运行测试)/i,
    )
  ) {
    return "implementation";
  }
  if (textMatches(text, /(review|audit|inspect|verify|check|评审|审查|审核|复核|验证|检查)/i)) {
    return "review";
  }
  if (
    textMatches(
      text,
      /(research|investigate|analy[sz]e|analysis|look up|调研|调查|分析|研究|查找)/i,
    )
  ) {
    return "research";
  }
  if (
    textMatches(
      text,
      /(discuss|debate|conversation|dialogue|roundtable|reply|respond|brainstorm|role|opinion|talk|讨论|对话|辩论|圆桌|回应|回复|发言|观点|头脑风暴|品鉴|专家团队|生命的意义)/i,
    )
  ) {
    return "communication";
  }
  return "research";
}

function defaultModeForIntent(intent: DelegateTaskIntent): DelegateExecutionMode {
  return intent === "implementation" || intent === "document_generation" ? "worktree" : "readonly";
}

function defaultApplyPolicyForTask(params: {
  mode: DelegateExecutionMode;
  taskIntent: DelegateTaskIntent;
}): DelegateApplyPolicy {
  if (params.mode === "readonly") return "none";
  if (params.taskIntent === "implementation") return "auto";
  if (params.taskIntent === "document_generation") return "explicit";
  return "none";
}

function taskIntentRequiresWorktree(intent: DelegateTaskIntent) {
  return intent === "implementation" || intent === "document_generation";
}

export function resolveResumedAgentExecutionMode(params: {
  task: DelegateAgentInput;
  existingMode?: DelegateExecutionMode;
}): DelegateAgentInput {
  if (!params.existingMode || params.task.modeSpecified) return params.task;
  if (
    params.existingMode === "readonly" &&
    params.task.mode === "worktree" &&
    taskIntentRequiresWorktree(params.task.taskIntent)
  ) {
    return params.task;
  }
  if (params.existingMode === params.task.mode) return params.task;
  const mode = params.existingMode;
  return {
    ...params.task,
    mode,
    applyPolicy: params.task.applyPolicySpecified
      ? params.task.applyPolicy
      : defaultApplyPolicyForTask({
          mode,
          taskIntent: params.task.taskIntent,
        }),
  };
}

function normalizeAgentSpecKey(value: string) {
  const key = value
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
  if (key === "id" || key === "agent" || key === "agent_id_for_resume") return "id";
  if (key === "name" || key === "agent_name") return "name";
  if (key === "agent_id" || key === "template" || key === "template_id") return "agent_id";
  if (key === "mode" || key === "execution_mode") return "mode";
  if (key === "task_intent" || key === "intent" || key === "task_type") return "task_intent";
  if (key === "apply_policy" || key === "apply") return "apply_policy";
  if (
    key === "allowed_output_paths" ||
    key === "allowed_paths" ||
    key === "output_paths" ||
    key === "apply_paths"
  ) {
    return "allowed_output_paths";
  }
  if (key === "resume") return "resume";
  if (key === "retain_worktree" || key === "keep_worktree" || key === "preserve_worktree") {
    return "retain_worktree";
  }
  if (key === "role" || key === "persona") return "role";
  if (key === "identity" || key === "system_prompt" || key === "system" || key === "profile") {
    return "identity";
  }
  if (
    key === "prompt" ||
    key === "goal" ||
    key === "instruction" ||
    key === "instructions" ||
    key === "task"
  ) {
    return "prompt";
  }
  return "";
}

function unquoteAgentSpecValue(value: string) {
  const text = value.trim();
  if (
    (text.startsWith('"') && text.endsWith('"')) ||
    (text.startsWith("'") && text.endsWith("'"))
  ) {
    return text.slice(1, -1);
  }
  return text;
}

function parseAgentSpecAttributes(value: string) {
  const attrs: Record<string, unknown> = {};
  const pattern = /([a-zA-Z_][\w-]*)=("[^"]*"|'[^']*'|[^\s]+)/g;
  let match: RegExpExecArray | null = null;
  match = pattern.exec(value);
  while (match !== null) {
    const key = normalizeAgentSpecKey(match[1] ?? "");
    if (key) {
      attrs[key] = parseAgentSpecScalar(match[2] ?? "");
    }
    match = pattern.exec(value);
  }
  return attrs;
}

function parseAgentSpecScalar(value: string): unknown {
  const text = unquoteAgentSpecValue(value);
  if (/^(true|false)$/i.test(text)) return text.toLowerCase() === "true";
  return text;
}

function appendAgentSpecField(record: Record<string, unknown>, key: string, value: string) {
  const normalizedKey = normalizeAgentSpecKey(key);
  if (!normalizedKey) return "";
  if (normalizedKey === "resume" || normalizedKey === "retain_worktree") {
    record[normalizedKey] = parseAgentSpecScalar(value);
    return normalizedKey;
  }
  if (normalizedKey === "allowed_output_paths") {
    const previous = normalizePathList(record[normalizedKey]);
    record[normalizedKey] = [...previous, ...normalizePathList(value)];
    return normalizedKey;
  }
  const next = unquoteAgentSpecValue(value);
  if (normalizedKey === "prompt" || normalizedKey === "identity") {
    const previous = optionalString(record[normalizedKey]);
    record[normalizedKey] = previous ? `${previous}\n${next}` : next;
    return normalizedKey;
  }
  record[normalizedKey] = next;
  return normalizedKey;
}

function splitAgentSpecBlocks(spec: string) {
  const blocks: string[][] = [];
  let current: string[] = [];
  for (const line of spec.replace(/\r\n/g, "\n").split("\n")) {
    const trimmed = line.trim();
    if (/^---+$/.test(trimmed)) {
      if (current.some((item) => item.trim())) blocks.push(current);
      current = [];
      continue;
    }
    if (/^@agent\b/i.test(trimmed) && current.some((item) => item.trim())) {
      blocks.push(current);
      current = [];
    }
    current.push(line);
  }
  if (current.some((item) => item.trim())) blocks.push(current);
  return blocks;
}

function parseAgentSpecBlock(lines: string[]) {
  const record: Record<string, unknown> = {};
  let activeKey = "";
  const freeText: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      if (activeKey === "prompt" || activeKey === "identity") {
        appendAgentSpecField(record, activeKey, "");
      }
      continue;
    }

    if (/^@agent\b/i.test(trimmed)) {
      Object.assign(record, parseAgentSpecAttributes(trimmed.replace(/^@agent\b/i, "")));
      activeKey = "";
      continue;
    }
    if (/^agent\s+\d+\s*:$/i.test(trimmed) || /^agent\s*:$/i.test(trimmed)) {
      activeKey = "";
      continue;
    }

    const fieldMatch = /^([a-zA-Z_][\w\s-]{0,40})\s*[:=]\s*(.*)$/.exec(trimmed);
    const normalizedField = fieldMatch ? normalizeAgentSpecKey(fieldMatch[1] ?? "") : "";
    if (fieldMatch && normalizedField) {
      const rawValue = (fieldMatch[2] ?? "").trim();
      activeKey = normalizedField;
      if (rawValue && rawValue !== "|" && rawValue !== ">") {
        appendAgentSpecField(record, activeKey, rawValue);
      } else if (!(activeKey in record)) {
        record[activeKey] = "";
      }
      continue;
    }
    if (fieldMatch) {
      activeKey = "";
      continue;
    }

    if (activeKey === "prompt" || activeKey === "identity") {
      appendAgentSpecField(record, activeKey, line.replace(/^\s{0,4}/, ""));
    } else {
      freeText.push(line);
    }
  }

  if (!optionalString(record.prompt) && freeText.length > 0) {
    record.prompt = freeText.join("\n").trim();
  }
  return record;
}

function parseAgentSpec(spec: string) {
  return splitAgentSpecBlocks(spec).map(parseAgentSpecBlock);
}

function shouldTreatTextAsAgentSpec(value: unknown) {
  const text = optionalString(value);
  if (!text) return false;
  if (/^\s*@agent\b/im.test(text)) return true;
  return (
    /^\s*agent\s+\d+\s*:/im.test(text) && /^\s*(name|role|identity|prompt|task)\s*[:=]/im.test(text)
  );
}

function normalizeAgentInput(
  rawAgent: Record<string, unknown>,
  index: number,
  inheritedAgentId?: string,
  inheritedMode?: DelegateExecutionMode,
  inheritedModeSpecified = false,
  inheritedTaskIntent?: DelegateTaskIntent,
  inheritedTaskIntentSpecified = false,
  inheritedApplyPolicy?: DelegateApplyPolicy,
  inheritedApplyPolicySpecified = false,
  inheritedAllowedOutputPaths: string[] = [],
): DelegateAgentInput {
  const prompt = optionalString(rawAgent.prompt);
  if (!prompt) {
    throw new Error(`Agent input ${index + 1} must include prompt.`);
  }
  const id = optionalString(rawAgent.id) ?? `agent-${index + 1}`;
  const taskIntent =
    normalizeTaskIntent(rawAgent.task_intent) ?? inheritedTaskIntent ?? inferTaskIntent({ prompt });
  const taskIntentSpecified =
    normalizeTaskIntent(rawAgent.task_intent) !== undefined || inheritedTaskIntentSpecified;
  const rawMode = normalizeExecutionModeOpt(rawAgent.mode);
  const mode =
    rawMode ??
    (inheritedModeSpecified ? inheritedMode : undefined) ??
    defaultModeForIntent(taskIntent);
  const applyPolicy =
    normalizeApplyPolicy(rawAgent.apply_policy) ??
    inheritedApplyPolicy ??
    defaultApplyPolicyForTask({ mode, taskIntent });
  const applyPolicySpecified =
    normalizeApplyPolicy(rawAgent.apply_policy) !== undefined || inheritedApplyPolicySpecified;
  const inferredAllowedOutputPaths =
    taskIntent === "document_generation" && applyPolicy === "explicit"
      ? inferAllowedOutputPaths({ prompt })
      : [];
  const allowedOutputPaths = [
    ...inheritedAllowedOutputPaths,
    ...normalizePathList(rawAgent.allowed_output_paths),
    ...inferredAllowedOutputPaths,
  ].filter((path, position, paths) => paths.indexOf(path) === position);
  return {
    id,
    name: optionalString(rawAgent.name),
    role: optionalString(rawAgent.role),
    identity: optionalString(rawAgent.identity),
    prompt,
    agentId: optionalString(rawAgent.agent_id) ?? inheritedAgentId,
    mode,
    modeSpecified: rawMode !== undefined || inheritedModeSpecified,
    taskIntent,
    taskIntentSpecified,
    applyPolicy,
    applyPolicySpecified,
    allowedOutputPaths,
    resume: normalizeBoolean(rawAgent.resume, true),
    retainWorktree: normalizeBoolean(rawAgent.retain_worktree, false),
  };
}

export function normalizeDelegateAgents(args: Record<string, unknown>): DelegateAgentInput[] {
  const inheritedAgentId = optionalString(args.agent_id);
  const inheritedMode = normalizeExecutionModeOpt(args.mode);
  const inheritedModeSpecified = inheritedMode !== undefined;
  const inheritedTaskIntent = normalizeTaskIntent(args.task_intent);
  const inheritedTaskIntentSpecified = inheritedTaskIntent !== undefined;
  const inheritedApplyPolicy = normalizeApplyPolicy(args.apply_policy);
  const inheritedApplyPolicySpecified = inheritedApplyPolicy !== undefined;
  const inheritedAllowedOutputPaths = normalizePathList(args.allowed_output_paths);
  const inheritedResume = normalizeBoolean(args.resume, true);
  const inheritedRetainWorktree = normalizeBoolean(args.retain_worktree, false);
  const explicitAgentSpec = optionalString(args.agent_spec) ?? optionalString(args.spec);
  const promptAgentSpec =
    !explicitAgentSpec && shouldTreatTextAsAgentSpec(args.prompt)
      ? optionalString(args.prompt)
      : undefined;
  const agentSpec = explicitAgentSpec ?? promptAgentSpec;
  if (agentSpec) {
    const specItems = parseAgentSpec(agentSpec).filter((item) => optionalString(item.prompt));
    if (specItems.length === 0) {
      throw new Error("Agent.agent_spec must include at least one agent with prompt.");
    }
    if (specItems.length > MAX_AGENTS) {
      throw new Error(`Agent.agent_spec supports at most ${MAX_AGENTS} delegated agents.`);
    }
    return specItems.map((item, index) =>
      normalizeAgentInput(
        {
          resume: inheritedResume,
          retain_worktree: inheritedRetainWorktree,
          ...item,
        },
        index,
        inheritedAgentId,
        inheritedMode,
        inheritedModeSpecified,
        inheritedTaskIntent,
        inheritedTaskIntentSpecified,
        inheritedApplyPolicy,
        inheritedApplyPolicySpecified,
        inheritedAllowedOutputPaths,
      ),
    );
  }
  return [
    normalizeAgentInput(
      args,
      0,
      inheritedAgentId,
      inheritedMode,
      inheritedModeSpecified,
      inheritedTaskIntent,
      inheritedTaskIntentSpecified,
      inheritedApplyPolicy,
      inheritedApplyPolicySpecified,
      inheritedAllowedOutputPaths,
    ),
  ];
}

export function normalizeSubagentRunMode(value: string): DelegateExecutionMode | undefined {
  return value === "readonly" || value === "worktree" ? value : undefined;
}
