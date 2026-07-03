import type { Tool, ToolCall, ToolResultMessage } from "@earendil-works/pi-ai";
import { invoke } from "@tauri-apps/api/core";
import { Type } from "typebox";

import {
  type McpServerConfig,
  type McpSettings,
  normalizeMcpServerConfig,
  normalizeMcpSettings,
} from "../settings";
import {
  type BuiltinToolBundle,
  createBuiltinMetadataMap,
  type McpManagerResultDetails,
} from "./builtinTypes";
import { ToolPathResolver } from "./pathUtils";
import type { SystemToolRuntimeScope } from "./systemToolOptions";

type McpManagerAction =
  | "list"
  | "read"
  | "create"
  | "update"
  | "delete"
  | "enable"
  | "disable"
  | "validate"
  | "test"
  | "diagnose"
  | "restart"
  | "stop"
  | "tools";

type McpDiagnosticToolInfo = {
  serverId: string;
  serverLabel: string;
  name: string;
  description: string;
  inputSchema?: unknown;
};

type McpRuntimeStatus = {
  serverId: string;
  running: boolean;
  initialized: boolean;
  transport: string;
  lastError?: string | null;
};

type McpRuntimeTestResponse = {
  serverId: string;
  ok: boolean;
  phase: string;
  transport: string;
  durationMs: number;
  running: boolean;
  initialized: boolean;
  toolsCount: number;
  tools: McpDiagnosticToolInfo[];
  error?: string | null;
  stderrTail?: string | null;
};

type McpStopServerResponse = {
  serverId: string;
  stopped: boolean;
};

type ValidationResult = {
  ok: boolean;
  errors: string[];
  warnings: string[];
};

type McpManagerExecutionResult = {
  action: McpManagerAction;
  serverId?: string;
  serverIds?: string[];
  servers?: McpServerConfig[];
  server?: McpServerConfig;
  validation?: ValidationResult;
  runtime?: McpRuntimeStatus | null;
  test?: McpRuntimeTestResponse | null;
  tools?: McpDiagnosticToolInfo[];
  stopped?: boolean;
  changed?: boolean;
  runtimeWarnings?: string[];
  suggestions?: string[];
};

const WRITE_ACTIONS = new Set<McpManagerAction>([
  "create",
  "update",
  "delete",
  "enable",
  "disable",
]);

const MCP_STRING_MAP_SCHEMA = Type.Record(Type.String(), Type.String());

const MCP_SERVER_PARAMETERS = Type.Object(
  {
    id: Type.Optional(Type.String()),
    enabled: Type.Optional(Type.Boolean()),
    transport: Type.Optional(
      Type.Union([Type.Literal("stdio"), Type.Literal("http"), Type.Literal("sse")]),
    ),
    command: Type.Optional(Type.String()),
    args: Type.Optional(Type.Array(Type.String())),
    cwd: Type.Optional(
      Type.String({
        description:
          "Optional local working directory for stdio servers. Accepts workspace-relative paths exactly as returned by file tools, absolute paths, ~/..., or file:// values.",
      }),
    ),
    env: Type.Optional(MCP_STRING_MAP_SCHEMA),
    url: Type.Optional(Type.String()),
    headers: Type.Optional(MCP_STRING_MAP_SCHEMA),
    timeoutMs: Type.Optional(Type.Number({ minimum: 1 })),
    messageUrl: Type.Optional(Type.String()),
  },
  { description: "Full MCP Server config for create/test/validate." } as any,
);

const MCP_SERVER_PATCH_PARAMETERS = Type.Object(
  {
    enabled: Type.Optional(Type.Boolean()),
    transport: Type.Optional(
      Type.Union([Type.Literal("stdio"), Type.Literal("http"), Type.Literal("sse")]),
    ),
    command: Type.Optional(Type.String()),
    args: Type.Optional(Type.Array(Type.String())),
    cwd: Type.Optional(
      Type.String({
        description:
          "Optional local working directory for stdio servers. Accepts workspace-relative paths exactly as returned by file tools, absolute paths, ~/..., or file:// values.",
      }),
    ),
    env: Type.Optional(MCP_STRING_MAP_SCHEMA),
    url: Type.Optional(Type.String()),
    headers: Type.Optional(MCP_STRING_MAP_SCHEMA),
    timeoutMs: Type.Optional(Type.Number({ minimum: 1 })),
    messageUrl: Type.Optional(Type.String()),
  },
  { description: "Partial MCP Server config for update. The id field cannot be changed." } as any,
);

const MCP_MANAGER_PARAMETERS = Type.Object({
  action: Type.Union([
    Type.Literal("list"),
    Type.Literal("read"),
    Type.Literal("create"),
    Type.Literal("update"),
    Type.Literal("delete"),
    Type.Literal("enable"),
    Type.Literal("disable"),
    Type.Literal("validate"),
    Type.Literal("test"),
    Type.Literal("diagnose"),
    Type.Literal("restart"),
    Type.Literal("stop"),
    Type.Literal("tools"),
  ]),
  server_id: Type.Optional(Type.String({ description: "Target MCP Server id." })),
  server_ids: Type.Optional(Type.Array(Type.String(), { description: "Target MCP Server ids." })),
  server: Type.Optional(MCP_SERVER_PARAMETERS),
  patch: Type.Optional(MCP_SERVER_PATCH_PARAMETERS),
  conflict: Type.Optional(Type.Union([Type.Literal("fail"), Type.Literal("overwrite")])),
  include_disabled: Type.Optional(Type.Boolean()),
  include_tools: Type.Optional(Type.Boolean()),
  include_schema: Type.Optional(Type.Boolean()),
  include_stderr: Type.Optional(Type.Boolean()),
});

function asErrorMessage(err: unknown) {
  return err instanceof Error ? err.message : String(err);
}

function normalizeAction(value: unknown): McpManagerAction {
  const action = typeof value === "string" ? value.trim() : "";
  switch (action) {
    case "list":
    case "read":
    case "create":
    case "update":
    case "delete":
    case "enable":
    case "disable":
    case "validate":
    case "test":
    case "diagnose":
    case "restart":
    case "stop":
    case "tools":
      return action;
    default:
      throw new Error(`McpManager.action is not supported: ${JSON.stringify(value)}`);
  }
}

function asObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function optionalString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function requireServerId(value: unknown, label = "server_id") {
  const id = optionalString(value);
  if (!id) throw new Error(`McpManager.${label} is required.`);
  return id;
}

function targetServerIds(args: Record<string, unknown>) {
  const ids = new Set<string>();
  const single = optionalString(args.server_id);
  if (single) ids.add(single);
  if (Array.isArray(args.server_ids)) {
    for (const item of args.server_ids) {
      const id = optionalString(item);
      if (id) ids.add(id);
    }
  }
  if (ids.size === 0) {
    throw new Error("McpManager requires server_id or server_ids.");
  }
  return Array.from(ids);
}

function normalizeManagedMcpSettings(input: unknown): McpSettings {
  const normalized = normalizeMcpSettings(input as Partial<McpSettings>);
  const enabledIds = new Set(
    normalized.servers
      .filter((server) => server.enabled && server.id.trim())
      .map((server) => server.id),
  );
  return {
    servers: normalized.servers,
    selected: normalized.selected.filter((id) => enabledIds.has(id)),
  };
}

function normalizeServerForCreate(input: unknown): McpServerConfig {
  const raw = asObject(input, "McpManager.server");
  validateRawServerShape(raw, "McpManager.server");
  return normalizeMcpServerConfig({
    enabled: true,
    transport: "stdio",
    command: "",
    args: [],
    url: "",
    timeoutMs: 60_000,
    ...raw,
  });
}

function normalizeInlineServer(input: unknown): McpServerConfig {
  const raw = asObject(input, "McpManager.server");
  validateRawServerShape(raw, "McpManager.server");
  return normalizeMcpServerConfig({
    enabled: true,
    transport: "stdio",
    command: "",
    args: [],
    url: "",
    timeoutMs: 60_000,
    ...raw,
  });
}

function validateRawServerShape(raw: Record<string, unknown>, label: string) {
  if (Object.hasOwn(raw, "args")) {
    const value = raw.args;
    if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
      throw new Error(`${label}.args must be a string array.`);
    }
  }
  if (Object.hasOwn(raw, "env")) {
    normalizeStringMap(raw.env, `${label}.env`);
  }
  if (Object.hasOwn(raw, "headers")) {
    normalizeStringMap(raw.headers, `${label}.headers`);
  }
}

function normalizePatch(input: unknown): Partial<McpServerConfig> {
  const raw = asObject(input, "McpManager.patch");
  if (Object.hasOwn(raw, "id")) {
    throw new Error("McpManager.update does not allow changing server id.");
  }
  const patch: Partial<McpServerConfig> = {};
  for (const [key, value] of Object.entries(raw)) {
    switch (key) {
      case "enabled":
        if (typeof value !== "boolean")
          throw new Error("McpManager.patch.enabled must be a boolean.");
        patch.enabled = value;
        break;
      case "transport":
        if (value !== "stdio" && value !== "http" && value !== "sse") {
          throw new Error("McpManager.patch.transport must be one of: stdio, http, sse.");
        }
        patch.transport = value;
        break;
      case "command":
      case "url":
      case "cwd":
      case "messageUrl":
        if (typeof value !== "string") throw new Error(`McpManager.patch.${key} must be a string.`);
        (patch as Record<string, unknown>)[key] =
          key === "cwd" || key === "messageUrl" ? value.trim() || undefined : value.trim();
        break;
      case "args":
        if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
          throw new Error("McpManager.patch.args must be a string array.");
        }
        patch.args = value.map((item) => item.trim()).filter(Boolean);
        break;
      case "env":
      case "headers":
        (patch as Record<string, unknown>)[key] = normalizeStringMap(
          value,
          `McpManager.patch.${key}`,
        );
        break;
      case "timeoutMs": {
        const numeric = typeof value === "number" ? value : Number(value);
        if (!Number.isFinite(numeric) || numeric <= 0) {
          throw new Error("McpManager.patch.timeoutMs must be a positive number.");
        }
        patch.timeoutMs = Math.floor(numeric);
        break;
      }
      default:
        throw new Error(`McpManager.patch field is not supported: ${key}`);
    }
  }
  return patch;
}

function normalizeStringMap(value: unknown, label: string): Record<string, string> | undefined {
  if (value === null || typeof value === "undefined") return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object with string values.`);
  }
  const out: Record<string, string> = {};
  for (const [key, rawValue] of Object.entries(value as Record<string, unknown>)) {
    if (typeof rawValue !== "string") {
      throw new Error(`${label}.${key} must be a string.`);
    }
    const normalizedKey = key.trim();
    if (!normalizedKey) continue;
    out[normalizedKey] = rawValue.trim();
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function validateUrl(value: string, label: string, base?: string) {
  try {
    const url = base ? new URL(value, base) : new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return `${label} must use http or https.`;
    }
    return null;
  } catch {
    return `${label} must be a valid URL.`;
  }
}

function validateServer(server: McpServerConfig, existing?: McpSettings): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const id = server.id.trim();
  if (!id) errors.push("id is required.");
  if (existing) {
    const duplicates = existing.servers.filter((item) => item.id === id).length;
    if (id && duplicates > 1) errors.push(`id is duplicated: ${id}`);
  }

  if (server.timeoutMs <= 0) errors.push("timeoutMs must be greater than 0.");
  if (typeof server.cwd === "string" && server.cwd.includes("\0")) {
    errors.push("cwd must not contain NUL bytes.");
  }

  if (server.transport === "stdio") {
    if (!server.command.trim()) errors.push("transport=stdio requires command.");
    if (!Array.isArray(server.args)) errors.push("transport=stdio args must be a string array.");
  } else if (server.transport === "http") {
    if (!server.url.trim()) {
      errors.push("transport=http requires url.");
    } else {
      const error = validateUrl(server.url, "url");
      if (error) errors.push(error);
    }
  } else if (server.transport === "sse") {
    if (!server.url.trim()) {
      errors.push("transport=sse requires url.");
    } else {
      const urlError = validateUrl(server.url, "url");
      if (urlError) errors.push(urlError);
      if (server.messageUrl) {
        const messageUrlError = validateUrl(server.messageUrl, "messageUrl", server.url);
        if (messageUrlError) errors.push(messageUrlError);
      }
    }
  }

  if (!server.enabled) warnings.push("server is disabled and will not be loaded for model use.");
  return { ok: errors.length === 0, errors, warnings };
}

function findServer(settings: McpSettings, serverId: string) {
  return settings.servers.find((server) => server.id === serverId);
}

function requireExistingServer(settings: McpSettings, serverId: string) {
  const server = findServer(settings, serverId);
  if (!server) throw new Error(`MCP server does not exist: ${serverId}`);
  return server;
}

function redactMap(map: Record<string, string> | undefined) {
  if (!map || Object.keys(map).length === 0) return undefined;
  return Object.fromEntries(Object.keys(map).map((key) => [key, "<redacted>"]));
}

export function redactMcpServerConfig(server: McpServerConfig): McpServerConfig {
  return {
    ...server,
    env: redactMap(server.env),
    headers: redactMap(server.headers),
  };
}

function summarizeTool(tool: McpDiagnosticToolInfo, includeSchema: boolean): McpDiagnosticToolInfo {
  if (includeSchema) return tool;
  return {
    serverId: tool.serverId,
    serverLabel: tool.serverLabel,
    name: tool.name,
    description: tool.description,
  };
}

async function stopRuntime(serverId: string, warnings: string[]) {
  try {
    const stopped = await invoke<McpStopServerResponse>("mcp_stop_server", {
      server_id: serverId,
    } as any);
    return stopped.stopped;
  } catch (err) {
    warnings.push(`failed to stop runtime for ${serverId}: ${asErrorMessage(err)}`);
    return false;
  }
}

async function runtimeStatus(serverId: string) {
  return invoke<McpRuntimeStatus>("mcp_runtime_status", { server_id: serverId } as any);
}

async function runtimeTest(
  server: McpServerConfig,
  includeSchema: boolean,
  restart = false,
  persist = true,
) {
  return invoke<McpRuntimeTestResponse>(restart ? "mcp_restart_server" : "mcp_test_server", {
    server,
    include_schema: includeSchema,
    persist,
  } as any);
}

function applyRuntimeTestOutputOptions(
  response: McpRuntimeTestResponse,
  includeStderr: boolean,
): McpRuntimeTestResponse {
  if (includeStderr) return response;
  return {
    ...response,
    stderrTail: undefined,
  };
}

function buildSuggestions(result: {
  validation?: ValidationResult;
  test?: McpRuntimeTestResponse | null;
  server?: McpServerConfig;
}) {
  const suggestions: string[] = [];
  for (const error of result.validation?.errors ?? []) {
    if (error.includes("requires command")) suggestions.push("Set command for stdio transport.");
    if (error.includes("requires url")) suggestions.push("Set a valid MCP endpoint URL.");
    if (error.includes("timeoutMs")) suggestions.push("Increase timeoutMs to a positive value.");
  }
  const message = result.test?.error ?? "";
  if (/No such file|os error 2|启动 MCP server|spawn/i.test(message)) {
    suggestions.push("Check that the stdio command exists in PATH or set cwd/env explicitly.");
  }
  if (/timed out|timeout/i.test(message)) {
    suggestions.push(
      "Increase timeoutMs or check whether the MCP server is hanging during initialize/tools/list.",
    );
  }
  if (/401|403|Unauthorized|Forbidden/i.test(message)) {
    suggestions.push("Check headers/env credentials for this MCP server.");
  }
  if (result.server?.transport === "sse" && /endpoint|Message URL/i.test(message)) {
    suggestions.push("Set messageUrl explicitly for legacy SSE transport.");
  }
  return Array.from(new Set(suggestions));
}

function formatServerLine(server: McpServerConfig) {
  return `- ${server.id} | transport=${server.transport} | enabled=${server.enabled ? "true" : "false"}`;
}

function formatJson(value: unknown) {
  return JSON.stringify(value, null, 2);
}

function formatMcpManagerResult(result: McpManagerExecutionResult) {
  const lines = [`McpManager action=${result.action}`];
  if (result.serverId) lines.push(`server=${result.serverId}`);
  if (result.serverIds?.length) lines.push(`servers=${result.serverIds.join(",")}`);
  if (typeof result.changed === "boolean")
    lines.push(`changed=${result.changed ? "true" : "false"}`);
  if (typeof result.stopped === "boolean")
    lines.push(`stopped=${result.stopped ? "true" : "false"}`);
  if (result.validation) {
    lines.push(`validation=${result.validation.ok ? "ok" : "failed"}`);
    for (const error of result.validation.errors) lines.push(`- error: ${error}`);
    for (const warning of result.validation.warnings) lines.push(`- warning: ${warning}`);
  }
  if (result.runtime) {
    lines.push(
      `runtime=running:${result.runtime.running ? "true" : "false"} initialized:${result.runtime.initialized ? "true" : "false"} transport=${result.runtime.transport}`,
    );
    if (result.runtime.lastError) lines.push(`runtimeError=${result.runtime.lastError}`);
  }
  if (result.test) {
    lines.push(
      `test=${result.test.ok ? "ok" : "failed"} phase=${result.test.phase} durationMs=${result.test.durationMs}`,
    );
    lines.push(`tools=${result.test.toolsCount}`);
    if (result.test.error) lines.push(`error=${result.test.error}`);
    if (result.test.stderrTail) lines.push(result.test.stderrTail);
  }
  if (result.servers) {
    lines.push(`serversCount=${result.servers.length}`);
    for (const server of result.servers) lines.push(formatServerLine(server));
  } else if (result.server) {
    lines.push(formatServerLine(result.server));
    if (result.action === "read") {
      lines.push("serverConfig:");
      lines.push(formatJson(result.server));
    }
  }
  if (result.tools && result.tools.length > 0) {
    const hasSchema = result.tools.some((tool) => typeof tool.inputSchema !== "undefined");
    if (hasSchema) {
      lines.push("toolsJson:");
      lines.push(formatJson(result.tools));
    } else {
      lines.push("tools:");
      for (const tool of result.tools) {
        lines.push(`- ${tool.name}${tool.description ? ` | ${tool.description}` : ""}`);
      }
    }
  }
  if (result.runtimeWarnings?.length) {
    lines.push("runtimeWarnings:");
    for (const warning of result.runtimeWarnings) lines.push(`- ${warning}`);
  }
  if (result.suggestions?.length) {
    lines.push("suggestions:");
    for (const suggestion of result.suggestions) lines.push(`- ${suggestion}`);
  }
  return lines.join("\n");
}

function detailsForResult(result: McpManagerExecutionResult): McpManagerResultDetails {
  return {
    kind: "manage_mcp",
    action: result.action,
    serverId: result.serverId,
    serverIds: result.serverIds,
    transport: result.test?.transport ?? result.runtime?.transport ?? result.server?.transport,
    ok: result.test
      ? result.test.ok && (result.validation?.ok ?? true)
      : result.validation
        ? result.validation.ok
        : true,
    phase: result.test?.phase,
    serverCount: result.servers?.length,
    enabledCount: result.servers
      ? result.servers.filter((server) => server.enabled).length
      : result.server
        ? result.server.enabled
          ? 1
          : 0
        : undefined,
    toolsCount: result.test?.toolsCount ?? result.tools?.length,
    changed: result.changed,
    stopped: result.stopped,
    errors: [
      ...(result.validation?.errors ?? []),
      ...(result.test?.error ? [result.test.error] : []),
      ...(result.runtime?.lastError ? [result.runtime.lastError] : []),
    ],
  };
}

export function createMcpManagerTools(params: {
  workdir: string;
  getMcpSettings: () => McpSettings;
  setMcpSettings?: (next: McpSettings) => void;
  runtimeScope: SystemToolRuntimeScope;
  resolveHomeDir?: () => Promise<string>;
}): BuiltinToolBundle {
  const pathResolver = new ToolPathResolver({
    workdir: params.workdir,
    resolveHomeDir: params.resolveHomeDir,
  });

  async function resolveMcpCwd(cwd: string | undefined, label: string) {
    const input = typeof cwd === "string" ? cwd.trim() : "";
    if (!input) return undefined;
    const resolved = await pathResolver.resolvePath(input, {
      label,
      intent: "cwd",
      required: true,
      allowExternal: true,
    });
    return resolved.absolutePath;
  }

  async function resolveServerCwd(server: McpServerConfig, label: string) {
    const cwd = await resolveMcpCwd(server.cwd, label);
    return cwd ? { ...server, cwd } : { ...server, cwd: undefined };
  }

  async function resolvePatchCwd(patch: Partial<McpServerConfig>, label: string) {
    if (!Object.hasOwn(patch, "cwd")) return patch;
    const cwd = await resolveMcpCwd(patch.cwd, label);
    return { ...patch, cwd };
  }

  function currentSettings() {
    return normalizeManagedMcpSettings(params.getMcpSettings());
  }

  function commitSettings(next: McpSettings) {
    if (!params.setMcpSettings) {
      throw new Error("McpManager cannot modify MCP settings in this runtime scope.");
    }
    const normalized = normalizeManagedMcpSettings(next);
    params.setMcpSettings(normalized);
    return normalized;
  }

  async function executeAction(args: Record<string, unknown>): Promise<McpManagerExecutionResult> {
    const action = normalizeAction(args.action);
    if (WRITE_ACTIONS.has(action) && params.runtimeScope !== "chat") {
      throw new Error(`McpManager action=${action} is not allowed in ${params.runtimeScope}.`);
    }

    const settings = currentSettings();
    const includeSchema = args.include_schema === true;
    const includeStderr = Object.hasOwn(args, "include_stderr")
      ? args.include_stderr === true
      : false;

    if (action === "list") {
      const includeDisabled = args.include_disabled !== false;
      const servers = includeDisabled
        ? settings.servers
        : settings.servers.filter((server) => server.enabled);
      return {
        action,
        servers: servers.map(redactMcpServerConfig),
      };
    }

    if (action === "read") {
      const serverId = requireServerId(args.server_id);
      const server = requireExistingServer(settings, serverId);
      return {
        action,
        serverId,
        server: redactMcpServerConfig(server),
      };
    }

    if (action === "create") {
      const server = await resolveServerCwd(
        normalizeServerForCreate(args.server),
        "McpManager.server.cwd",
      );
      const validation = validateServer(server);
      if (!validation.ok)
        return {
          action,
          serverId: server.id,
          server: redactMcpServerConfig(server),
          validation,
          changed: false,
        };

      const conflict = args.conflict === "overwrite" ? "overwrite" : "fail";
      const existingIndex = settings.servers.findIndex((item) => item.id === server.id);
      if (existingIndex >= 0 && conflict === "fail") {
        throw new Error(`MCP server already exists: ${server.id}`);
      }

      const runtimeWarnings: string[] = [];
      let servers = settings.servers.slice();
      let stopped = false;
      if (existingIndex >= 0) {
        servers[existingIndex] = server;
        stopped = await stopRuntime(server.id, runtimeWarnings);
      } else {
        servers = [...servers, server];
      }
      commitSettings({ servers, selected: settings.selected });
      return {
        action,
        serverId: server.id,
        server: redactMcpServerConfig(server),
        validation,
        changed: true,
        stopped,
        runtimeWarnings,
      };
    }

    if (action === "update") {
      const serverId = requireServerId(args.server_id);
      const existing = requireExistingServer(settings, serverId);
      const patch = await resolvePatchCwd(normalizePatch(args.patch), "McpManager.patch.cwd");
      const updated = normalizeMcpServerConfig({ ...existing, ...patch, id: existing.id });
      const validation = validateServer(updated);
      if (!validation.ok)
        return {
          action,
          serverId,
          server: redactMcpServerConfig(updated),
          validation,
          changed: false,
        };
      const servers = settings.servers.map((server) => (server.id === serverId ? updated : server));
      commitSettings({ servers, selected: settings.selected });
      const runtimeWarnings: string[] = [];
      const stopped = await stopRuntime(serverId, runtimeWarnings);
      return {
        action,
        serverId,
        server: redactMcpServerConfig(updated),
        validation,
        changed: true,
        stopped,
        runtimeWarnings,
      };
    }

    if (action === "delete") {
      const serverId = requireServerId(args.server_id);
      requireExistingServer(settings, serverId);
      commitSettings({
        servers: settings.servers.filter((server) => server.id !== serverId),
        selected: settings.selected.filter((id) => id !== serverId),
      });
      const runtimeWarnings: string[] = [];
      const stopped = await stopRuntime(serverId, runtimeWarnings);
      return { action, serverId, changed: true, stopped, runtimeWarnings };
    }

    if (action === "enable" || action === "disable") {
      const ids = targetServerIds(args);
      for (const id of ids) requireExistingServer(settings, id);
      const enable = action === "enable";
      const servers = settings.servers.map((server) =>
        ids.includes(server.id) ? { ...server, enabled: enable } : server,
      );
      commitSettings({ servers, selected: settings.selected });
      const runtimeWarnings: string[] = [];
      let stopped = false;
      if (!enable) {
        for (const id of ids) {
          stopped = (await stopRuntime(id, runtimeWarnings)) || stopped;
        }
      }
      return { action, serverIds: ids, changed: true, stopped, runtimeWarnings };
    }

    if (action === "validate") {
      const server = args.server
        ? await resolveServerCwd(normalizeInlineServer(args.server), "McpManager.server.cwd")
        : requireExistingServer(settings, requireServerId(args.server_id));
      const validation = validateServer(server, args.server ? undefined : settings);
      return {
        action,
        serverId: server.id,
        server: redactMcpServerConfig(server),
        validation,
        changed: false,
      };
    }

    if (action === "stop") {
      const serverId = requireServerId(args.server_id);
      const stopped = await invoke<McpStopServerResponse>("mcp_stop_server", {
        server_id: serverId,
      } as any);
      return { action, serverId, stopped: stopped.stopped, changed: false };
    }

    if (action === "test" || action === "tools" || action === "restart" || action === "diagnose") {
      const hasInlineServer = Boolean(args.server);
      const server = hasInlineServer
        ? await resolveServerCwd(normalizeInlineServer(args.server), "McpManager.server.cwd")
        : requireExistingServer(settings, requireServerId(args.server_id));
      const validation = validateServer(server, hasInlineServer ? undefined : settings);
      let runtime: McpRuntimeStatus | null = null;
      if (!hasInlineServer) {
        runtime = await runtimeStatus(server.id).catch((err) => ({
          serverId: server.id,
          running: false,
          initialized: false,
          transport: server.transport,
          lastError: asErrorMessage(err),
        }));
      }
      if (!validation.ok) {
        const suggestions = buildSuggestions({ validation, server });
        return {
          action,
          serverId: server.id,
          server: redactMcpServerConfig(server),
          validation,
          runtime,
          changed: false,
          suggestions,
        };
      }
      const shouldIncludeStderr = Object.hasOwn(args, "include_stderr")
        ? includeStderr
        : action === "diagnose";
      const test = applyRuntimeTestOutputOptions(
        await runtimeTest(server, includeSchema, action === "restart", !hasInlineServer),
        shouldIncludeStderr,
      );
      const tools = (test.tools ?? []).map((tool) => summarizeTool(tool, includeSchema));
      return {
        action,
        serverId: server.id,
        server: redactMcpServerConfig(server),
        validation,
        runtime,
        test,
        tools:
          action === "tools" || args.include_tools === true || action === "diagnose"
            ? tools
            : undefined,
        changed: false,
        suggestions: buildSuggestions({ validation, test, server }),
      };
    }

    throw new Error(`McpManager.action is not supported: ${action}`);
  }

  const toolMcpManager: Tool = {
    name: "McpManager",
    description:
      "Manage LiveAgent MCP Server configuration. Use this built-in tool for MCP server CRUD, enable/disable, static validation, connection tests, diagnostics, restart/stop, and tools/list. Enabled MCP servers are automatically loaded as dynamic mcp_* tools. It does not call arbitrary MCP business tools; use the dynamically loaded mcp_* tools for actual MCP tool execution.",
    parameters: MCP_MANAGER_PARAMETERS,
  };

  async function executeToolCall(
    toolCall: ToolCall,
    signal?: AbortSignal,
  ): Promise<ToolResultMessage> {
    const now = Date.now();
    if (signal?.aborted) {
      return {
        role: "toolResult",
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        content: [{ type: "text", text: "Cancelled" }],
        details: {},
        isError: true,
        timestamp: now,
      };
    }
    if (toolCall.name !== "McpManager") {
      return {
        role: "toolResult",
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        content: [{ type: "text", text: `Unknown tool: ${toolCall.name}` }],
        details: {},
        isError: true,
        timestamp: now,
      };
    }

    try {
      const result = await executeAction((toolCall.arguments ?? {}) as Record<string, unknown>);
      return {
        role: "toolResult",
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        content: [{ type: "text", text: formatMcpManagerResult(result) }],
        details: detailsForResult(result),
        isError: false,
        timestamp: now,
      };
    } catch (err) {
      return {
        role: "toolResult",
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        content: [{ type: "text", text: `McpManager failed: ${asErrorMessage(err)}` }],
        details: {
          kind: "manage_mcp",
          action: "unknown",
          ok: false,
          errors: [asErrorMessage(err)],
        },
        isError: true,
        timestamp: now,
      };
    }
  }

  return {
    groupId: "mcp",
    tools: [toolMcpManager],
    executeToolCall,
    metadataByName: createBuiltinMetadataMap([
      [
        "McpManager",
        {
          groupId: "mcp",
          kind: "manage_mcp",
          isReadOnly: false,
          displayCategory: "mcp",
        },
      ],
    ]),
  };
}
