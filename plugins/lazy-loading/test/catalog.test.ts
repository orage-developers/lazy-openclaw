import assert from "node:assert/strict";
import { describe, it } from "node:test";
import Value from "typebox/value";
import { buildCatalog, classifyTool, estimateTokens, measureSchemaBytes, sortEntries, summarize } from "../src/catalog/build.js";
import { InventoryStore, normalizeRawTools, type RawTool, type ToolInventory } from "../src/catalog/inventory.js";
import { CatalogSchema } from "../src/catalog/schema.js";
import { renderSignature, shortDescription } from "../src/catalog/signature.js";
import { parseConfigOrThrow, resolveAgentConfig } from "../src/config/validate.js";

const tool = (name: string, extra: Partial<RawTool> = {}): RawTool => ({
  name,
  description: `Tool ${name}. Does something useful.`,
  parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
  ...extra,
});

function inventory(tools: RawTool[]): ToolInventory {
  return { agentId: "coordinator", tools, origin: "provided", capturedAt: 1_000 };
}

const agent = resolveAgentConfig(
  parseConfigOrThrow({
    defaults: { core: ["read", "write"], never: ["browser"] },
    agents: { coordinator: { core: ["read", "scout_ask_user", "ghost_core"], never: ["browser", "ghost_never"] } },
  }),
  "coordinator",
);

describe("size estimation", () => {
  it("measures the UTF-8 bytes of name, description and parameters", () => {
    const spec = tool("read", { description: "Lé", parameters: { type: "object" } });
    const expected = Buffer.byteLength(JSON.stringify({ name: "read", description: "Lé", parameters: { type: "object" } }), "utf8");
    assert.equal(measureSchemaBytes(spec), expected);
  });

  it("estimates tokens as bytes / 4 rounded up", () => {
    assert.equal(estimateTokens(0), 0);
    assert.equal(estimateTokens(1), 1);
    assert.equal(estimateTokens(4), 1);
    assert.equal(estimateTokens(5), 2);
  });

  it("treats missing description and parameters as empty", () => {
    assert.ok(measureSchemaBytes({ name: "x" }) > 0);
  });
});

describe("compact descriptors", () => {
  it("renders the signature style used by Tool Search", () => {
    const schema = {
      type: "object",
      required: ["id"],
      properties: { id: { type: "string" }, mode: { type: "string", enum: ["drip", "flood"] } },
    };
    assert.equal(renderSignature(schema), '{ id: string; mode?: "drip" | "flood" }');
  });

  it("renders arrays, unions, nullables and nested objects", () => {
    const schema = {
      type: "object",
      properties: {
        tags: { type: "array", items: { type: "string" } },
        either: { anyOf: [{ type: "string" }, { type: "number" }] },
        maybe: { type: ["string", "null"] },
        list: { type: "array", items: { anyOf: [{ type: "string" }, { type: "integer" }] } },
        nested: { type: "object", properties: { a: { type: "boolean" }, deep: { type: "object", properties: { z: { type: "string" } } } } },
      },
    };
    assert.equal(
      renderSignature(schema),
      "{ either?: string | number; list?: Array<string | number>; maybe?: string | null; nested?: { a?: boolean; deep?: object }; tags?: string[] }",
    );
  });

  it("handles missing, empty and non-object schemas", () => {
    assert.equal(renderSignature(undefined), "unknown");
    assert.equal(renderSignature({ type: "object" }), "{}");
    assert.equal(renderSignature("nope"), "unknown");
  });

  it("truncates long signatures", () => {
    const properties = Object.fromEntries(Array.from({ length: 40 }, (_, index) => [`field_${index}`, { type: "string" }]));
    const text = renderSignature({ type: "object", properties }, 60);
    assert.equal(text.length, 60);
    assert.ok(text.endsWith("…"));
  });

  it("keeps the first sentence of a description and caps its length", () => {
    assert.equal(shortDescription("Ask the user.  Use only when blocked.\nMore text."), "Ask the user.");
    assert.equal(shortDescription(undefined), "");
    const long = shortDescription("x".repeat(500));
    assert.equal(long.length, 140);
    assert.ok(long.endsWith("…"));
  });
});

describe("inventory normalization", () => {
  it("accepts name/description/parameters and the inputSchema / input_schema aliases", () => {
    const tools = normalizeRawTools([
      { name: "a", description: "A", parameters: { type: "object" } },
      { name: "b", inputSchema: { type: "object" } },
      { name: "c", input_schema: { type: "object" }, catalogMode: "direct-only", source: "plugin", pluginId: "p" },
    ]);
    assert.deepEqual(
      tools.map((entry) => [entry.name, entry.parameters !== undefined, entry.directOnly ?? false, entry.source]),
      [
        ["a", true, false, undefined],
        ["b", true, false, undefined],
        ["c", true, true, "plugin"],
      ],
    );
  });

  it("flattens Codex-style namespaces and drops duplicates and junk", () => {
    const tools = normalizeRawTools([
      { type: "function", name: "sessions_spawn" },
      { type: "namespace", name: "openclaw", tools: [{ name: "read" }, { name: "write" }, { name: "read" }] },
      null,
      42,
      { description: "no name" },
    ]);
    assert.deepEqual(tools.map((entry) => entry.name), ["sessions_spawn", "read", "write"]);
  });

  it("stores the latest inventory per agent and ignores empty reports", () => {
    const store = new InventoryStore();
    assert.equal(store.record("a", [], "observed-run", 1), undefined);
    store.record("a", [{ name: "read" }], "observed-run", 1);
    store.record("a", [{ name: "read" }, { name: "write" }], "observed-run", 2);
    store.record("b", [{ name: "x" }], "provided", 3);
    assert.equal(store.get("a")?.tools.length, 2);
    assert.equal(store.get("a")?.capturedAt, 2);
    assert.deepEqual(store.agents(), ["a", "b"]);
    store.clear("a");
    assert.equal(store.get("a"), undefined);
    store.clear();
    assert.deepEqual(store.agents(), []);
  });
});

describe("classifyTool", () => {
  it("applies precedence: loader, direct-only, never, core, deferred", () => {
    assert.deepEqual(classifyTool({ name: "lazy_load_tools" }, { core: [], never: ["lazy_load_tools"] }), { class: "core", reason: "loader" });
    assert.deepEqual(classifyTool({ name: "message", directOnly: true }, { core: [], never: ["message"] }), { class: "core", reason: "direct-only" });
    assert.deepEqual(classifyTool({ name: "browser" }, agent), { class: "never", reason: "config-never" });
    assert.deepEqual(classifyTool({ name: "read" }, agent), { class: "core", reason: "config-core" });
    assert.deepEqual(classifyTool({ name: "automations" }, agent), { class: "deferred", reason: "default" });
  });
});

describe("buildCatalog", () => {
  const tools = [
    tool("automations", { parameters: { type: "object", properties: { big: { type: "string", description: "x".repeat(400) } } } }),
    tool("browser"),
    tool("read"),
    tool("scout_ask_user"),
    tool("sessions_list"),
    tool("lazy_load_tools"),
    tool("message", { directOnly: true }),
  ];

  it("returns an empty, unavailable catalog when the inventory is unknown", () => {
    const catalog = buildCatalog({ agent, inventory: undefined });
    assert.equal(catalog.available, false);
    assert.deepEqual(catalog.entries, []);
    assert.equal(catalog.summary.total.count, 0);
    assert.equal(catalog.summary.savingPct, 0);
  });

  it("classifies every tool and reports totals that add up", () => {
    const catalog = buildCatalog({ agent, inventory: inventory(tools) });
    const byName = new Map(catalog.entries.map((entry) => [entry.name, entry]));
    assert.equal(byName.get("read")?.class, "core");
    assert.equal(byName.get("scout_ask_user")?.class, "core");
    assert.equal(byName.get("lazy_load_tools")?.reason, "loader");
    assert.equal(byName.get("message")?.reason, "direct-only");
    assert.equal(byName.get("browser")?.class, "never");
    assert.equal(byName.get("automations")?.class, "deferred");
    assert.equal(byName.get("sessions_list")?.class, "deferred");

    const { summary } = catalog;
    assert.equal(summary.total.count, tools.length);
    assert.equal(summary.core.count + summary.deferred.count + summary.never.count, tools.length);
    assert.equal(summary.core.bytes + summary.deferred.bytes + summary.never.bytes, summary.total.bytes);
    assert.equal(summary.total.bytes, catalog.entries.reduce((sum, entry) => sum + entry.schemaBytes, 0));
    const hidden = summary.deferred.bytes + summary.never.bytes;
    assert.equal(summary.savingPct, Math.round((hidden / summary.total.bytes) * 100));
    assert.ok(summary.savingPct > 0 && summary.savingPct < 100);
  });

  it("reports configured names missing from the inventory", () => {
    const catalog = buildCatalog({ agent, inventory: inventory(tools) });
    assert.deepEqual(catalog.missing, { core: ["ghost_core"], never: ["ghost_never"] });
  });

  it("orders deterministically by class then name, with size and name alternatives", () => {
    const catalog = buildCatalog({ agent, inventory: inventory(tools) });
    assert.deepEqual(
      catalog.entries.map((entry) => `${entry.class}:${entry.name}`),
      [
        "core:lazy_load_tools",
        "core:message",
        "core:read",
        "core:scout_ask_user",
        "deferred:automations",
        "deferred:sessions_list",
        "never:browser",
      ],
    );
    const shuffled = buildCatalog({ agent, inventory: inventory([...tools].reverse()) });
    assert.deepEqual(shuffled.entries, catalog.entries);

    assert.equal(sortEntries(catalog.entries, "size")[0]?.name, "automations");
    assert.deepEqual(
      sortEntries(catalog.entries, "name").map((entry) => entry.name),
      [...catalog.entries.map((entry) => entry.name)].sort(),
    );
  });

  it("carries compact descriptors and provenance", () => {
    const catalog = buildCatalog({
      agent,
      inventory: inventory([tool("read", { source: "core" }), tool("scout_ask_user", { source: "plugin", pluginId: "scout-ask-user" })]),
    });
    const read = catalog.entries.find((entry) => entry.name === "read");
    assert.equal(read?.description, "Tool read.");
    assert.equal(read?.signature, "{ id: string }");
    assert.equal(read?.source, "core");
    const ask = catalog.entries.find((entry) => entry.name === "scout_ask_user");
    assert.equal(ask?.pluginId, "scout-ask-user");
  });

  it("produces output that satisfies the wire schema", () => {
    const catalog = buildCatalog({ agent, inventory: inventory(tools) });
    assert.equal(Value.Check(CatalogSchema, catalog), true, JSON.stringify([...Value.Errors(CatalogSchema, catalog)]));
    assert.equal(Value.Check(CatalogSchema, buildCatalog({ agent, inventory: undefined })), true);
  });

  it("reproduces the baseline order of magnitude for a coordinator-like inventory", () => {
    const big = Array.from({ length: 47 }, (_, index) =>
      tool(`deferred_${index}`, { parameters: { type: "object", properties: { text: { type: "string", description: "y".repeat(1500) } } } }),
    );
    const catalog = buildCatalog({ agent, inventory: inventory([tool("read"), tool("write"), ...big]) });
    assert.ok(catalog.summary.savingPct >= 95, `expected >= 95% saving, got ${catalog.summary.savingPct}`);
    assert.equal(summarize(catalog.entries).total.count, 49);
  });
});
