import { LazyLoadingError } from "../errors.js";
import { LAZY_LOAD_TOOLS_NAME } from "../tools/lazy-load-tools.js";
import type { Mode, RawAgentConfig, RawConfig, ResolvedAgentConfig, ToolClass } from "./schema.js";

/**
 * Pure edits on the raw (persisted) plugin config. They mutate the draft they are
 * given and return nothing; callers compute "previous" values from the resolved
 * config before editing, so edits stay trivial and testable.
 */

function agentEntry(draft: RawConfig, agentId: string): RawAgentConfig {
  draft.agents ??= {};
  draft.agents[agentId] ??= {};
  return draft.agents[agentId] as RawAgentConfig;
}

export function applyDefaultMode(draft: RawConfig, mode: Mode): void {
  draft.defaultMode = mode;
}

export function applyAgentMode(draft: RawConfig, agentId: string, mode: Mode): void {
  agentEntry(draft, agentId).mode = mode;
}

export function applyAgentEnabled(draft: RawConfig, agentId: string, enabled: boolean): void {
  agentEntry(draft, agentId).enabled = enabled;
}

/** Class of a tool according to an agent's effective lists (ignores host direct-only tools). */
export function configuredClass(agent: Pick<ResolvedAgentConfig, "core" | "never">, tool: string): ToolClass {
  if (agent.never.includes(tool)) return "never";
  if (agent.core.includes(tool)) return "core";
  return "deferred";
}

/**
 * Move `tool` to `toolClass` for one agent. Only the lists that change are
 * written to the agent entry (an entry's list replaces the defaults list, so
 * writing one materializes the inherited names it contains).
 */
export function applyToolClass(
  draft: RawConfig,
  agent: Pick<ResolvedAgentConfig, "agentId" | "core" | "never">,
  tool: string,
  toolClass: ToolClass,
): void {
  if (tool === LAZY_LOAD_TOOLS_NAME) {
    throw new LazyLoadingError("INVALID_ARGUMENT", `${LAZY_LOAD_TOOLS_NAME} is the loader and is always visible; its class cannot be changed`);
  }
  const without = (list: readonly string[]) => list.filter((name) => name !== tool);
  const withTool = (list: readonly string[]) => [...new Set([...list, tool])].sort();

  const nextCore = toolClass === "core" ? withTool(agent.core) : without(agent.core);
  const nextNever = toolClass === "never" ? withTool(agent.never) : without(agent.never);
  const entry = agentEntry(draft, agent.agentId);
  if (nextCore.join("\n") !== agent.core.join("\n")) entry.core = nextCore;
  if (nextNever.join("\n") !== agent.never.join("\n")) entry.never = nextNever;
}
