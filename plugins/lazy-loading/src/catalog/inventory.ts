import type { InventoryOrigin, ToolSource } from "./schema.js";

/** A tool as seen by the model, normalized from whatever the host reports. */
export type RawTool = {
  name: string;
  description?: string;
  /** JSON Schema of the tool input. */
  parameters?: unknown;
  source?: ToolSource;
  pluginId?: string;
  /** `catalogMode: "direct-only"`: the host keeps this tool model-visible. */
  directOnly?: boolean;
};

export type ToolInventory = {
  agentId: string;
  tools: RawTool[];
  origin: InventoryOrigin;
  /** Epoch milliseconds. */
  capturedAt: number;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function normalizeOne(value: unknown): RawTool | undefined {
  if (!isRecord(value)) return undefined;
  const name = typeof value.name === "string" ? value.name : typeof value.id === "string" ? value.id : undefined;
  if (!name) return undefined;
  const parameters = value.parameters ?? value.inputSchema ?? value.input_schema;
  const source = value.source;
  return {
    name,
    ...(typeof value.description === "string" ? { description: value.description } : {}),
    ...(parameters !== undefined ? { parameters } : {}),
    ...(source === "core" || source === "plugin" || source === "mcp" || source === "client" || source === "channel"
      ? { source }
      : {}),
    ...(typeof value.pluginId === "string" ? { pluginId: value.pluginId } : {}),
    ...(value.catalogMode === "direct-only" || value.directOnly === true ? { directOnly: true } : {}),
  };
}

/**
 * Normalize a host tool list (for example `llm_input.tools`, a `tools.catalog`
 * response flattened by the caller, or Codex dynamic tools with namespaces) into
 * `RawTool[]`. Unknown shapes are skipped; duplicates keep the first occurrence.
 */
export function normalizeRawTools(input: unknown): RawTool[] {
  const out = new Map<string, RawTool>();
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (!isRecord(value)) return;
    if (Array.isArray(value.tools) && value.type === "namespace") {
      visit(value.tools);
      return;
    }
    const tool = normalizeOne(value);
    if (tool && !out.has(tool.name)) out.set(tool.name, tool);
  };
  visit(input);
  return [...out.values()];
}

/**
 * In-memory inventory of the tools each agent last exposed. The plugin has no
 * supported API to ask the host for an agent's effective tools (the gateway
 * `tools.catalog` method is not available to external plugins), so the inventory
 * is fed by observation (`llm_input` hook) or provided by a caller that can.
 */
export class InventoryStore {
  private readonly byAgent = new Map<string, ToolInventory>();

  record(agentId: string, tools: unknown, origin: InventoryOrigin, now: number): ToolInventory | undefined {
    const normalized = normalizeRawTools(tools);
    if (normalized.length === 0) return undefined;
    const inventory: ToolInventory = { agentId, tools: normalized, origin, capturedAt: now };
    this.byAgent.set(agentId, inventory);
    return inventory;
  }

  get(agentId: string): ToolInventory | undefined {
    return this.byAgent.get(agentId);
  }

  agents(): string[] {
    return [...this.byAgent.keys()].sort();
  }

  clear(agentId?: string): void {
    if (agentId === undefined) this.byAgent.clear();
    else this.byAgent.delete(agentId);
  }
}
