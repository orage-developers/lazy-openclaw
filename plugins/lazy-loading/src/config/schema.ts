import Type, { type Static } from "typebox";

/**
 * Configuration of the lazy-loading plugin (`plugins.entries["lazy-loading"].config`).
 *
 * This TypeBox schema is the single source of truth: `openclaw plugins build`
 * writes it into the manifest `configSchema`, and `parseConfig` validates and
 * resolves defaults from it at runtime.
 */

/** How an agent's tool surface is reduced. See docs/baseline.md for the decision record. */
export const MODES = ["native", "plugin", "off"] as const;
export type Mode = (typeof MODES)[number];

/** Role of a tool in the per-agent catalog. */
export const TOOL_CLASSES = ["core", "deferred", "never"] as const;
export type ToolClass = (typeof TOOL_CLASSES)[number];

export const ModeSchema = Type.Enum([...MODES], {
  description:
    "native: manage the global tools.toolSearch setting; plugin: narrow tools per turn via before_prompt_build (embedded runner only); off: host default.",
});

/** Exact tool names only (no globs). Matches OpenClaw tool ids such as `scout_hq_composio__composio_mcp`. */
export const TOOL_NAME_PATTERN = "^[A-Za-z0-9_][A-Za-z0-9_.:-]*$";
export const AGENT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/u;

const ToolNameSchema = Type.String({ pattern: TOOL_NAME_PATTERN, minLength: 1, maxLength: 128 });
const ToolNameListSchema = (description: string) =>
  Type.Array(ToolNameSchema, { maxItems: 256, description });

const StickyTurnsSchema = Type.Integer({
  minimum: 0,
  maximum: 1000,
  default: 10,
  description: "Turns an activated tool stays visible after its last use. 0 disables stickiness.",
});

export const AgentConfigSchema = Type.Object(
  {
    enabled: Type.Optional(Type.Boolean({ description: "Enable lazy loading for this agent (default: inherit)." })),
    mode: Type.Optional(ModeSchema),
    core: Type.Optional(ToolNameListSchema("Tools that are always visible. Replaces defaults.core for this agent.")),
    never: Type.Optional(ToolNameListSchema("Tools that are never loaded. Replaces defaults.never for this agent.")),
    stickyTurns: Type.Optional(StickyTurnsSchema),
    predict: Type.Optional(Type.Boolean({ description: "Preload tools predicted from the user message." })),
  },
  { additionalProperties: false },
);

export const DefaultsConfigSchema = Type.Object(
  {
    core: Type.Optional(ToolNameListSchema("Core tools for agents without their own list.")),
    never: Type.Optional(ToolNameListSchema("Never-loaded tools for agents without their own list.")),
    stickyTurns: Type.Optional(StickyTurnsSchema),
    predict: Type.Optional(Type.Boolean({ default: true })),
  },
  { additionalProperties: false },
);

export const PredictorConfigSchema = Type.Object(
  {
    enabled: Type.Optional(Type.Boolean({ default: true })),
    maxPredicted: Type.Optional(Type.Integer({ minimum: 0, maximum: 50, default: 5 })),
    minScore: Type.Optional(Type.Number({ minimum: 0, maximum: 1, default: 0.3 })),
  },
  { additionalProperties: false },
);

export const MetricsConfigSchema = Type.Object(
  {
    enabled: Type.Optional(Type.Boolean({ default: true })),
    retentionDays: Type.Optional(Type.Integer({ minimum: 1, maximum: 365, default: 14 })),
  },
  { additionalProperties: false },
);

export const ConfigSchema = Type.Object(
  {
    enabled: Type.Optional(Type.Boolean({ default: true, description: "Master switch for the whole plugin." })),
    defaultMode: Type.Optional(ModeSchema),
    defaults: Type.Optional(DefaultsConfigSchema),
    agents: Type.Optional(
      Type.Record(Type.String(), AgentConfigSchema, {
        description: "Per-agent overrides keyed by agent id. Agents without an entry use defaultMode and defaults.",
      }),
    ),
    predictor: Type.Optional(PredictorConfigSchema),
    metrics: Type.Optional(MetricsConfigSchema),
  },
  { additionalProperties: false },
);

export type RawConfig = Static<typeof ConfigSchema>;
export type RawAgentConfig = Static<typeof AgentConfigSchema>;

/**
 * Tools kept visible when nothing else is configured: file and shell primitives
 * plus user-facing delivery. These mirror the "core coding primitives" the host
 * keeps model-visible in Tool Search directory mode.
 */
export const DEFAULT_CORE_TOOLS: readonly string[] = [
  "read",
  "write",
  "edit",
  "apply_patch",
  "ls",
  "exec",
  "process",
  "message",
];

export const DEFAULT_MODE: Mode = "native";
export const DEFAULT_STICKY_TURNS = 10;

/** Fully resolved configuration: every field present, lists sorted and deduplicated. */
export type ResolvedConfig = {
  enabled: boolean;
  defaultMode: Mode;
  defaults: { core: string[]; never: string[]; stickyTurns: number; predict: boolean };
  agents: Record<string, ResolvedAgentOverrides>;
  predictor: { enabled: boolean; maxPredicted: number; minScore: number };
  metrics: { enabled: boolean; retentionDays: number };
};

/** Explicit per-agent values only (undefined = inherit). */
export type ResolvedAgentOverrides = {
  enabled?: boolean;
  mode?: Mode;
  core?: string[];
  never?: string[];
  stickyTurns?: number;
  predict?: boolean;
};

/** Effective settings of one agent after merging overrides, defaults and the master switch. */
export type ResolvedAgentConfig = {
  agentId: string;
  /** False when the plugin or the agent is disabled. */
  enabled: boolean;
  /** Configured mode (before harness resolution). */
  mode: Mode;
  core: string[];
  never: string[];
  stickyTurns: number;
  predict: boolean;
  /** True when `agents[agentId]` exists. */
  hasOverride: boolean;
};
