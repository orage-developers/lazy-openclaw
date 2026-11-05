import Type from "typebox";
import { defineFeatureContract } from "openclaw/plugin-sdk/feature-contract";
import { CATALOG_SORTS, CatalogSchema, TOOL_SOURCES, ToolClassEnum } from "./catalog/schema.js";
import { AGENT_ID_PATTERN, MODES, ModeSchema, TOOL_NAME_PATTERN } from "./config/schema.js";
import { EFFECTIVE_REASONS, HARNESSES } from "./harness.js";

/**
 * The lazy-loading feature contract: the only interface the CLI, the slash
 * command and the Control UI use to talk to the plugin (PLAN F-10).
 *
 * Stability rules (see docs/contract.md):
 * - Operation and event names, and existing fields, never change within a
 *   `CONTRACT_VERSION`. New fields are added as optional.
 * - Breaking changes bump `CONTRACT_VERSION`, reported by `status`.
 * - Every payload is bounded JSON: strings, arrays and numbers carry limits.
 */
export const CONTRACT_VERSION = 1;

// ---------------------------------------------------------------- shared fragments

const AgentIdSchema = Type.String({ pattern: AGENT_ID_PATTERN.source, minLength: 1, maxLength: 64 });
const SessionKeySchema = Type.String({ minLength: 1, maxLength: 512 });
const ToolNameSchema = Type.String({ pattern: TOOL_NAME_PATTERN, minLength: 1, maxLength: 128 });
const EpochMsSchema = Type.Integer({ minimum: 0, description: "Epoch milliseconds." });
const NoteListSchema = Type.Array(Type.String({ maxLength: 300 }), { maxItems: 16, description: "Human-readable warnings, for example that a mode has no effect on a Codex agent." });

const HarnessSchema = Type.Enum([...HARNESSES], {
  description: "Runtime that executes the agent: embedded runner, Codex app-server, Copilot, a CLI backend, or unknown.",
});

const ConfigIssueSchema = Type.Object(
  { path: Type.String({ maxLength: 256 }), message: Type.String({ maxLength: 512 }) },
  { additionalProperties: false },
);

const AgentStatusSchema = Type.Object(
  {
    agentId: AgentIdSchema,
    /** False when the plugin or this agent is disabled in config. */
    enabled: Type.Boolean(),
    /** Mode written in the config (agent override or `defaultMode`). */
    mode: ModeSchema,
    /** Mode that actually applies after harness resolution; `off` for Codex agents. */
    effectiveMode: ModeSchema,
    effectiveReason: Type.Enum([...EFFECTIVE_REASONS]),
    harness: HarnessSchema,
    /** True when `agents.<id>` exists in the plugin config. */
    hasOverride: Type.Boolean(),
    /** Tool counts by class; null until an inventory is known for the agent. */
    counts: Type.Union([
      Type.Object(
        { core: Type.Integer({ minimum: 0 }), deferred: Type.Integer({ minimum: 0 }), never: Type.Integer({ minimum: 0 }) },
        { additionalProperties: false },
      ),
      Type.Null(),
    ]),
    /** Schema bytes by visibility; null until an inventory is known. */
    schema: Type.Union([
      Type.Object(
        {
          totalBytes: Type.Integer({ minimum: 0 }),
          visibleBytes: Type.Integer({ minimum: 0 }),
          savingPct: Type.Integer({ minimum: 0, maximum: 100 }),
        },
        { additionalProperties: false },
      ),
      Type.Null(),
    ]),
    /** Latest aggregated metrics (F-09). Absent until metrics exist. */
    metrics: Type.Optional(
      Type.Object(
        {
          turns: Type.Integer({ minimum: 0 }),
          ttftP50Ms: Type.Optional(Type.Number({ minimum: 0 })),
          loads: Type.Integer({ minimum: 0 }),
          misses: Type.Integer({ minimum: 0 }),
        },
        { additionalProperties: false },
      ),
    ),
    notes: NoteListSchema,
  },
  { additionalProperties: false },
);

const ModeStatsSchema = Type.Object(
  {
    mode: ModeSchema,
    turns: Type.Integer({ minimum: 0 }),
    ttftP50Ms: Type.Optional(Type.Number({ minimum: 0 })),
    ttftP95Ms: Type.Optional(Type.Number({ minimum: 0 })),
    avgVisibleTools: Type.Optional(Type.Number({ minimum: 0 })),
    avgSchemaBytes: Type.Optional(Type.Number({ minimum: 0 })),
  },
  { additionalProperties: false },
);

const SessionToolSchema = Type.Object(
  {
    name: ToolNameSchema,
    origin: Type.Enum(["loaded", "predicted"]),
    activatedAt: EpochMsSchema,
    lastUsedAt: Type.Optional(EpochMsSchema),
    /** Turns left before the tool leaves the visible set (sticky window). */
    turnsRemaining: Type.Integer({ minimum: 0 }),
  },
  { additionalProperties: false },
);

/** A tool reported by a caller that can see the effective tool list (for example `tools.effective`). */
const ProvidedToolSchema = Type.Object(
  {
    name: Type.String({ minLength: 1, maxLength: 128 }),
    description: Type.Optional(Type.String({ maxLength: 4000 })),
    /** JSON Schema of the tool input. */
    parameters: Type.Optional(Type.Unknown()),
    source: Type.Optional(Type.Enum([...TOOL_SOURCES])),
    pluginId: Type.Optional(Type.String({ maxLength: 128 })),
    directOnly: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);

const BenchmarkRunSchema = Type.Object(
  {
    mode: ModeSchema,
    index: Type.Integer({ minimum: 0 }),
    ttftMs: Type.Optional(Type.Number({ minimum: 0 })),
    totalMs: Type.Number({ minimum: 0 }),
    promptTokens: Type.Optional(Type.Integer({ minimum: 0 })),
    toolsVisible: Type.Optional(Type.Integer({ minimum: 0 })),
    error: Type.Optional(Type.String({ maxLength: 512 })),
  },
  { additionalProperties: false },
);

// ---------------------------------------------------------------- contract

export const contract = defineFeatureContract({
  pluginId: "lazy-loading",
  operations: {
    // ------------------------------------------------------------ queries
    status: {
      kind: "query",
      description:
        "Plugin-wide status: contract version, master switch, default mode, config validity, and per-agent mode, harness and tool counts.",
      input: Type.Object(
        { agentId: Type.Optional(AgentIdSchema) },
        { additionalProperties: false },
      ),
      output: Type.Object(
        {
          contractVersion: Type.Integer({ minimum: 1 }),
          pluginVersion: Type.String({ maxLength: 64 }),
          enabled: Type.Boolean(),
          defaultMode: ModeSchema,
          /** False when the persisted config fails validation; the plugin then runs with everything off. */
          configValid: Type.Boolean(),
          configIssues: Type.Array(ConfigIssueSchema, { maxItems: 64 }),
          agents: Type.Array(AgentStatusSchema, { maxItems: 256 }),
        },
        { additionalProperties: false },
      ),
    },

    catalog: {
      kind: "query",
      description: "Tool catalog of one agent: every tool classified as core, deferred or never, with schema size and compact descriptors.",
      input: Type.Object(
        {
          agentId: AgentIdSchema,
          sort: Type.Optional(Type.Enum([...CATALOG_SORTS], { default: "class" })),
          classes: Type.Optional(Type.Array(ToolClassEnum, { maxItems: 3, uniqueItems: true, description: "Return only these classes." })),
          /**
           * Effective tool list of the agent, supplied by a caller with operator access
           * (the plugin cannot query the gateway itself). When given, it is classified
           * and remembered as the agent's inventory (origin "provided").
           */
          inventory: Type.Optional(Type.Array(ProvidedToolSchema, { maxItems: 512 })),
        },
        { additionalProperties: false },
      ),
      output: CatalogSchema,
    },

    stats: {
      kind: "query",
      description: "Aggregated metrics (TTFT p50/p95, visible tools, schema bytes, loads, misses) per mode and per agent. Planned: F-09.",
      input: Type.Object(
        {
          agentId: Type.Optional(AgentIdSchema),
          sinceMs: Type.Optional(EpochMsSchema),
          untilMs: Type.Optional(EpochMsSchema),
        },
        { additionalProperties: false },
      ),
      output: Type.Object(
        {
          agentId: Type.Optional(AgentIdSchema),
          sinceMs: EpochMsSchema,
          untilMs: EpochMsSchema,
          totals: Type.Object(
            {
              turns: Type.Integer({ minimum: 0 }),
              loads: Type.Integer({ minimum: 0 }),
              misses: Type.Integer({ minimum: 0 }),
              /** Estimated schema bytes kept out of the initial prompt. */
              schemaBytesSaved: Type.Integer({ minimum: 0 }),
            },
            { additionalProperties: false },
          ),
          byMode: Type.Array(ModeStatsSchema, { maxItems: 3 }),
          byAgent: Type.Array(
            Type.Object(
              {
                agentId: AgentIdSchema,
                turns: Type.Integer({ minimum: 0 }),
                ttftP50Ms: Type.Optional(Type.Number({ minimum: 0 })),
                ttftP95Ms: Type.Optional(Type.Number({ minimum: 0 })),
              },
              { additionalProperties: false },
            ),
            { maxItems: 256 },
          ),
        },
        { additionalProperties: false },
      ),
    },

    "session-state": {
      kind: "query",
      description: "Lazy-loading state of one session: activated and predicted tools, sticky windows and recent misses. Planned: F-06.",
      input: Type.Object({ sessionKey: SessionKeySchema }, { additionalProperties: false }),
      output: Type.Object(
        {
          sessionKey: SessionKeySchema,
          agentId: Type.Optional(AgentIdSchema),
          stickyTurns: Type.Integer({ minimum: 0 }),
          tools: Type.Array(SessionToolSchema, { maxItems: 256 }),
          misses: Type.Array(
            Type.Object({ tool: ToolNameSchema, at: EpochMsSchema }, { additionalProperties: false }),
            { maxItems: 64 },
          ),
        },
        { additionalProperties: false },
      ),
    },

    // ------------------------------------------------------------ actions
    "set-mode": {
      kind: "action",
      description: "Set the lazy-loading mode: for one agent, or for the plugin default when agentId is omitted.",
      input: Type.Object(
        { mode: ModeSchema, agentId: Type.Optional(AgentIdSchema) },
        { additionalProperties: false },
      ),
      output: Type.Object(
        {
          changed: Type.Boolean(),
          scope: Type.Enum(["default", "agent"]),
          agentId: Type.Optional(AgentIdSchema),
          mode: ModeSchema,
          previousMode: ModeSchema,
          notes: NoteListSchema,
        },
        { additionalProperties: false },
      ),
    },

    "set-agent-enabled": {
      kind: "action",
      description: "Enable or disable lazy loading for one agent.",
      input: Type.Object({ agentId: AgentIdSchema, enabled: Type.Boolean() }, { additionalProperties: false }),
      output: Type.Object(
        {
          changed: Type.Boolean(),
          agentId: AgentIdSchema,
          enabled: Type.Boolean(),
          previousEnabled: Type.Boolean(),
          notes: NoteListSchema,
        },
        { additionalProperties: false },
      ),
    },

    "set-tool-class": {
      kind: "action",
      description: "Move a tool to core (always visible), deferred (loaded on demand) or never (never loaded) for one agent.",
      input: Type.Object(
        { agentId: AgentIdSchema, tool: ToolNameSchema, class: ToolClassEnum },
        { additionalProperties: false },
      ),
      output: Type.Object(
        {
          changed: Type.Boolean(),
          agentId: AgentIdSchema,
          tool: ToolNameSchema,
          class: ToolClassEnum,
          previousClass: ToolClassEnum,
          /** The agent's resulting lists, sorted. */
          core: Type.Array(ToolNameSchema, { maxItems: 256 }),
          never: Type.Array(ToolNameSchema, { maxItems: 256 }),
        },
        { additionalProperties: false },
      ),
    },

    "reset-session": {
      kind: "action",
      description: "Clear the activated tools of one session, or of every session of an agent. Planned: F-06.",
      input: Type.Object(
        { sessionKey: Type.Optional(SessionKeySchema), agentId: Type.Optional(AgentIdSchema) },
        { additionalProperties: false },
      ),
      output: Type.Object({ cleared: Type.Integer({ minimum: 0 }) }, { additionalProperties: false }),
    },

    "run-benchmark": {
      kind: "action",
      description:
        "Run one prompt against an agent in several modes and compare TTFT and prompt size. Long-running: emits benchmark-progress events and returns when finished. Planned: F-11.",
      input: Type.Object(
        {
          agentId: AgentIdSchema,
          prompt: Type.String({ minLength: 1, maxLength: 4000 }),
          runs: Type.Optional(Type.Integer({ minimum: 1, maximum: 10, default: 3 })),
          modes: Type.Optional(Type.Array(ModeSchema, { minItems: 1, maxItems: 3, uniqueItems: true, default: ["off", "plugin"] })),
          /** Client-chosen id echoed in events and in the result. */
          runId: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
        },
        { additionalProperties: false },
      ),
      output: Type.Object(
        {
          runId: Type.String({ minLength: 1, maxLength: 64 }),
          agentId: AgentIdSchema,
          startedAt: EpochMsSchema,
          finishedAt: EpochMsSchema,
          runs: Type.Array(BenchmarkRunSchema, { maxItems: 64 }),
          summary: Type.Array(ModeStatsSchema, { maxItems: 3 }),
        },
        { additionalProperties: false },
      ),
    },
  },

  events: {
    "config-changed": Type.Object(
      {
        change: Type.Enum(["mode", "enabled", "toolClass"]),
        scope: Type.Enum(["default", "agent"]),
        agentId: Type.Optional(AgentIdSchema),
        at: EpochMsSchema,
      },
      { additionalProperties: false },
    ),
    "stats-updated": Type.Object(
      { agentId: Type.Optional(AgentIdSchema), at: EpochMsSchema },
      { additionalProperties: false },
    ),
    "tools-loaded": Type.Object(
      {
        sessionKey: SessionKeySchema,
        agentId: Type.Optional(AgentIdSchema),
        tools: Type.Array(ToolNameSchema, { maxItems: 64 }),
        origin: Type.Enum(["loaded", "predicted"]),
        at: EpochMsSchema,
      },
      { additionalProperties: false },
    ),
    "benchmark-progress": Type.Object(
      {
        runId: Type.String({ minLength: 1, maxLength: 64 }),
        agentId: AgentIdSchema,
        state: Type.Enum(["started", "running", "completed", "failed"]),
        completedRuns: Type.Integer({ minimum: 0 }),
        totalRuns: Type.Integer({ minimum: 0 }),
        error: Type.Optional(Type.String({ maxLength: 512 })),
        at: EpochMsSchema,
      },
      { additionalProperties: false },
    ),
  },
});

export type LazyLoadingContract = typeof contract;
export const OPERATION_NAMES = Object.keys(contract.operations) as (keyof LazyLoadingContract["operations"])[];
export const EVENT_NAMES = Object.keys(contract.events) as (keyof LazyLoadingContract["events"])[];
export { MODES };
