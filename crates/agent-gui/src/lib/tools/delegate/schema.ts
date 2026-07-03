import { Type } from "typebox";

import { DEFAULT_CONCURRENCY, MAX_CONCURRENCY } from "./constants";

const DELEGATE_EXECUTION_MODE_SCHEMA = Type.Union(
  [Type.Literal("worktree"), Type.Literal("readonly")],
  {
    description: "readonly for message/research/review agents; worktree for isolated file changes.",
  },
);

const DELEGATE_TASK_INTENT_SCHEMA = Type.Union(
  [
    Type.Literal("communication"),
    Type.Literal("research"),
    Type.Literal("review"),
    Type.Literal("implementation"),
    Type.Literal("document_generation"),
  ],
  {
    description:
      "Optional intent used to choose safe defaults: communication, research, review, implementation, or document_generation.",
  },
);

const DELEGATE_APPLY_POLICY_SCHEMA = Type.Union(
  [Type.Literal("none"), Type.Literal("explicit"), Type.Literal("auto")],
  {
    description:
      "Merge-back policy for worktree agents: none, explicit allowed_output_paths, or auto for implementation patches.",
  },
);

export const DELEGATE_AGENT_PARAMETERS = Type.Object(
  {
    agent_spec: Type.Optional(
      Type.String({
        description:
          "Plain-text manifest for two or more agents, or any long identity/persona. Do not write JSON arrays here. Use blocks like: @agent id=player1 mode=readonly, then one field per line: name=Player 1, role=..., identity=..., prompt=..., and --- between agents. name:/role:/identity:/prompt: are also accepted.",
      }),
    ),
    id: Type.Optional(
      Type.String({
        description: "Stable id for one agent. Reuse the same id to resume that agent.",
      }),
    ),
    name: Type.Optional(
      Type.String({
        description:
          "Short display name for a newly created single agent. Ignored when id already exists.",
      }),
    ),
    role: Type.Optional(
      Type.String({
        description:
          "Short stable role for a newly created single agent. Use agent_spec for long personas.",
      }),
    ),
    identity: Type.Optional(
      Type.String({
        description:
          "Stable identity for a newly created single agent. Use agent_spec for long identity text.",
      }),
    ),
    agent_id: Type.Optional(
      Type.String({
        description: "Optional configured AGENTS template id or name for one agent.",
      }),
    ),
    prompt: Type.Optional(
      Type.String({
        description:
          "Current task prompt for one agent. For an existing id, this is normally the only prompt-like field needed. If this contains @agent blocks, LiveAgent parses it as a plain-text manifest. Do not restate stable identity for an existing id.",
      }),
    ),
    mode: Type.Optional(DELEGATE_EXECUTION_MODE_SCHEMA),
    task_intent: Type.Optional(DELEGATE_TASK_INTENT_SCHEMA),
    apply_policy: Type.Optional(DELEGATE_APPLY_POLICY_SCHEMA),
    allowed_output_paths: Type.Optional(
      Type.Array(Type.String(), {
        description:
          "Workspace files/directories allowed when apply_policy=explicit. Accepts workspace-relative paths exactly as returned by file tools, absolute paths inside the workspace, or file:// values.",
      }),
    ),
    resume: Type.Optional(
      Type.Boolean({
        description:
          "Defaults to true. Set false to start a fresh private context for the same stable id; existing identity/name/role are still reused and cannot be redefined. Use a new stable id for a genuinely new persona.",
      }),
    ),
    retain_worktree: Type.Optional(
      Type.Boolean({
        description:
          "For worktree mode only. Set true to keep the isolated worktree after a successful run even when LiveAgent could safely clean it up. Worktrees with unapplied changes or failed agents are retained automatically.",
      }),
    ),
    concurrency: Type.Optional(
      Type.Integer({
        minimum: 1,
        maximum: MAX_CONCURRENCY,
        description: `Maximum number of delegated subagents to run concurrently. Defaults to ${DEFAULT_CONCURRENCY}, so one Agent call runs a whole independent batch in parallel unless you intentionally lower it.`,
      }),
    ),
  },
  { additionalProperties: false },
);
