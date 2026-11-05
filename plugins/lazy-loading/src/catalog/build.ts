import type { ResolvedAgentConfig, ToolClass } from "../config/schema.js";
import { LAZY_LOAD_TOOLS_NAME } from "../tools/lazy-load-tools.js";
import type { RawTool, ToolInventory } from "./inventory.js";
import type { Catalog, CatalogEntry, CatalogSort, CatalogSummary, ClassReason, ClassTotals } from "./schema.js";
import { renderSignature, shortDescription } from "./signature.js";

const CLASS_ORDER: Record<ToolClass, number> = { core: 0, deferred: 1, never: 2 };

/** Approximate prompt tokens for a byte count (same 4 bytes/token estimate as docs/baseline.md). */
export function estimateTokens(bytes: number): number {
  return Math.ceil(bytes / 4);
}

/** UTF-8 size of the tool spec as it is sent to the model. */
export function measureSchemaBytes(tool: RawTool): number {
  const spec = { name: tool.name, description: tool.description ?? "", parameters: tool.parameters ?? {} };
  return Buffer.byteLength(JSON.stringify(spec), "utf8");
}

/**
 * Class of one tool. Precedence: loader and host direct-only tools are always
 * visible; then the agent's `never` list; then its `core` list; everything else
 * is deferred.
 */
export function classifyTool(
  tool: Pick<RawTool, "name" | "directOnly">,
  agent: Pick<ResolvedAgentConfig, "core" | "never">,
): { class: ToolClass; reason: ClassReason } {
  if (tool.name === LAZY_LOAD_TOOLS_NAME) return { class: "core", reason: "loader" };
  if (tool.directOnly) return { class: "core", reason: "direct-only" };
  if (agent.never.includes(tool.name)) return { class: "never", reason: "config-never" };
  if (agent.core.includes(tool.name)) return { class: "core", reason: "config-core" };
  return { class: "deferred", reason: "default" };
}

function emptyTotals(): ClassTotals {
  return { count: 0, bytes: 0, tokens: 0 };
}

function addTo(totals: ClassTotals, bytes: number): void {
  totals.count += 1;
  totals.bytes += bytes;
  totals.tokens += estimateTokens(bytes);
}

export function summarize(entries: readonly CatalogEntry[]): CatalogSummary {
  const summary = { total: emptyTotals(), core: emptyTotals(), deferred: emptyTotals(), never: emptyTotals() };
  for (const entry of entries) {
    addTo(summary.total, entry.schemaBytes);
    addTo(summary[entry.class], entry.schemaBytes);
  }
  const hidden = summary.deferred.bytes + summary.never.bytes;
  const savingPct = summary.total.bytes === 0 ? 0 : Math.round((hidden / summary.total.bytes) * 100);
  return { ...summary, savingPct };
}

export function sortEntries(entries: readonly CatalogEntry[], sort: CatalogSort = "class"): CatalogEntry[] {
  const byName = (a: CatalogEntry, b: CatalogEntry) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  const copy = [...entries];
  switch (sort) {
    case "name":
      return copy.sort(byName);
    case "size":
      return copy.sort((a, b) => b.schemaBytes - a.schemaBytes || byName(a, b));
    default:
      return copy.sort((a, b) => CLASS_ORDER[a.class] - CLASS_ORDER[b.class] || byName(a, b));
  }
}

export function toCatalogEntry(tool: RawTool, agent: Pick<ResolvedAgentConfig, "core" | "never">): CatalogEntry {
  const { class: toolClass, reason } = classifyTool(tool, agent);
  const bytes = measureSchemaBytes(tool);
  return {
    name: tool.name,
    class: toolClass,
    reason,
    source: tool.source ?? "unknown",
    ...(tool.pluginId ? { pluginId: tool.pluginId } : {}),
    directOnly: tool.directOnly === true,
    description: shortDescription(tool.description),
    signature: renderSignature(tool.parameters),
    schemaBytes: bytes,
    schemaTokens: estimateTokens(bytes),
  };
}

/**
 * Per-agent tool catalog: every tool the agent can see, classified as
 * core / deferred / never, with schema size and compact descriptors.
 * Pure function; the inventory is supplied by the caller.
 */
export function buildCatalog(params: {
  agent: ResolvedAgentConfig;
  inventory: ToolInventory | undefined;
  sort?: CatalogSort;
}): Catalog {
  const { agent, inventory } = params;
  if (!inventory) {
    return {
      agentId: agent.agentId,
      available: false,
      entries: [],
      summary: summarize([]),
      missing: { core: [], never: [] },
    };
  }
  const entries = sortEntries(
    inventory.tools.map((tool) => toCatalogEntry(tool, agent)),
    params.sort,
  );
  const present = new Set(inventory.tools.map((tool) => tool.name));
  return {
    agentId: agent.agentId,
    available: true,
    origin: inventory.origin,
    capturedAt: inventory.capturedAt,
    entries,
    summary: summarize(entries),
    missing: {
      core: agent.core.filter((name) => !present.has(name)),
      never: agent.never.filter((name) => !present.has(name)),
    },
  };
}
