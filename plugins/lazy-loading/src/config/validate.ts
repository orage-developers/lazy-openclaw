import Value from "typebox/value";
import {
  AGENT_ID_PATTERN,
  ConfigSchema,
  DEFAULT_CORE_TOOLS,
  DEFAULT_MODE,
  DEFAULT_STICKY_TURNS,
  type RawAgentConfig,
  type RawConfig,
  type ResolvedAgentConfig,
  type ResolvedAgentOverrides,
  type ResolvedConfig,
} from "./schema.js";
import { LAZY_LOAD_TOOLS_NAME } from "../tools/lazy-load-tools.js";

export type ConfigIssue = {
  /** Dotted path from the config root, empty for the root object. */
  path: string;
  message: string;
};

export type ParseConfigResult =
  | { ok: true; config: ResolvedConfig; issues: [] }
  | { ok: false; issues: ConfigIssue[] };

type SchemaError = {
  keyword: string;
  instancePath: string;
  params: Record<string, unknown>;
  message: string;
};

function pointerToPath(pointer: string): string {
  return pointer
    .split("/")
    .filter((segment) => segment.length > 0)
    .map((segment) => segment.replace(/~1/gu, "/").replace(/~0/gu, "~"))
    .join(".");
}

function describeSchemaError(error: SchemaError): ConfigIssue | undefined {
  const path = pointerToPath(error.instancePath);
  switch (error.keyword) {
    case "boolean": // companion of additionalProperties ("schema is false"), already reported once
      return undefined;
    case "additionalProperties": {
      const keys = (error.params.additionalProperties as string[] | undefined) ?? [];
      return { path, message: `unknown key${keys.length === 1 ? "" : "s"}: ${keys.join(", ")}` };
    }
    case "enum": {
      const allowed = (error.params.allowedValues as unknown[] | undefined) ?? [];
      return { path, message: `must be one of: ${allowed.map(String).join(", ")}` };
    }
    case "minimum":
    case "maximum":
    case "exclusiveMinimum":
    case "exclusiveMaximum":
      return { path, message: error.message };
    case "pattern":
      return { path, message: "must be an exact tool name such as 'read' or 'scout_ask_user' (no spaces, no globs)" };
    case "type":
      return { path, message: `must be ${String(error.params.type ?? "of a different type")}` };
    default:
      return { path, message: error.message };
  }
}

function normalizeList(list: readonly string[] | undefined): string[] | undefined {
  if (!list) return undefined;
  return [...new Set(list)].sort();
}

function intersection(left: readonly string[], right: readonly string[]): string[] {
  const rightSet = new Set(right);
  return left.filter((name) => rightSet.has(name));
}

function checkLists(path: string, core: readonly string[] | undefined, never: readonly string[] | undefined, issues: ConfigIssue[]): void {
  if (never?.includes(LAZY_LOAD_TOOLS_NAME)) {
    issues.push({ path: `${path}.never`, message: `${LAZY_LOAD_TOOLS_NAME} is the loader and cannot be listed in never` });
  }
  if (core && never) {
    const both = intersection(core, never);
    if (both.length > 0) {
      issues.push({ path, message: `tools cannot be both core and never: ${both.join(", ")}` });
    }
  }
}

function resolveOverrides(entry: RawAgentConfig): ResolvedAgentOverrides {
  const core = normalizeList(entry.core);
  const never = normalizeList(entry.never);
  return {
    ...(entry.enabled !== undefined ? { enabled: entry.enabled } : {}),
    ...(entry.mode !== undefined ? { mode: entry.mode } : {}),
    ...(core ? { core } : {}),
    ...(never ? { never } : {}),
    ...(entry.stickyTurns !== undefined ? { stickyTurns: entry.stickyTurns } : {}),
    ...(entry.predict !== undefined ? { predict: entry.predict } : {}),
  };
}

/**
 * Validate a raw plugin config value and resolve defaults.
 * Never throws; returns every problem found so the caller can show them at once.
 */
export function parseConfig(raw: unknown): ParseConfigResult {
  const input: unknown = raw === undefined || raw === null ? {} : raw;
  if (typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, issues: [{ path: "", message: "config must be an object" }] };
  }

  const issues: ConfigIssue[] = [];
  for (const error of Value.Errors(ConfigSchema, input) as Iterable<SchemaError>) {
    const issue = describeSchemaError(error);
    if (issue) issues.push(issue);
  }
  if (issues.length > 0) return { ok: false, issues };

  const value = input as RawConfig;
  const defaultsCore = normalizeList(value.defaults?.core) ?? [...DEFAULT_CORE_TOOLS].sort();
  const defaultsNever = normalizeList(value.defaults?.never) ?? [];
  checkLists("defaults", defaultsCore, defaultsNever, issues);

  const agents: Record<string, ResolvedAgentOverrides> = {};
  for (const [agentId, entry] of Object.entries(value.agents ?? {})) {
    const path = `agents.${agentId}`;
    if (!AGENT_ID_PATTERN.test(agentId)) {
      issues.push({ path, message: "agent id must start with a letter or digit and use only letters, digits, '.', '_' and '-' (max 64)" });
      continue;
    }
    const overrides = resolveOverrides(entry);
    checkLists(path, overrides.core ?? defaultsCore, overrides.never ?? defaultsNever, issues);
    agents[agentId] = overrides;
  }
  if (issues.length > 0) return { ok: false, issues };

  const config: ResolvedConfig = {
    enabled: value.enabled ?? true,
    defaultMode: value.defaultMode ?? DEFAULT_MODE,
    defaults: {
      core: defaultsCore,
      never: defaultsNever,
      stickyTurns: value.defaults?.stickyTurns ?? DEFAULT_STICKY_TURNS,
      predict: value.defaults?.predict ?? true,
    },
    agents,
    predictor: {
      enabled: value.predictor?.enabled ?? true,
      maxPredicted: value.predictor?.maxPredicted ?? 5,
      minScore: value.predictor?.minScore ?? 0.3,
    },
    metrics: {
      enabled: value.metrics?.enabled ?? true,
      retentionDays: value.metrics?.retentionDays ?? 14,
    },
  };
  return { ok: true, config, issues: [] };
}

export function formatIssues(issues: readonly ConfigIssue[]): string {
  return issues.map((issue) => `${issue.path || "(root)"}: ${issue.message}`).join("; ");
}

export class ConfigError extends Error {
  readonly issues: readonly ConfigIssue[];
  constructor(issues: readonly ConfigIssue[]) {
    super(`Invalid lazy-loading config: ${formatIssues(issues)}`);
    this.name = "ConfigError";
    this.issues = issues;
  }
}

/** Like `parseConfig` but throws `ConfigError` on invalid input. */
export function parseConfigOrThrow(raw: unknown): ResolvedConfig {
  const result = parseConfig(raw);
  if (!result.ok) throw new ConfigError(result.issues);
  return result.config;
}

/** Effective settings for one agent. Agents without an entry inherit `defaultMode` and `defaults`. */
export function resolveAgentConfig(config: ResolvedConfig, agentId: string): ResolvedAgentConfig {
  const override = config.agents[agentId];
  const agentEnabled = override?.enabled ?? true;
  return {
    agentId,
    enabled: config.enabled && agentEnabled,
    mode: override?.mode ?? config.defaultMode,
    core: override?.core ?? config.defaults.core,
    never: override?.never ?? config.defaults.never,
    stickyTurns: override?.stickyTurns ?? config.defaults.stickyTurns,
    predict: (override?.predict ?? config.defaults.predict) && config.predictor.enabled,
    hasOverride: override !== undefined,
  };
}
