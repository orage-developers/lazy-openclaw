import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { InventoryStore } from "../src/catalog/inventory.js";
import { CONTRACT_VERSION } from "../src/contract.js";
import { ERROR_CODES, LazyLoadingError, parseErrorCode } from "../src/errors.js";
import { createHandlers } from "../src/service.js";
import { MemoryConfigStore } from "../src/state/config-store.js";

const hostConfig = {
  plugins: { entries: { codex: { enabled: true } } },
  agents: {
    defaults: { model: "openai/gpt-5.6-luna" },
    entries: {
      coordinator: { model: "openai/gpt-5.6-luna" },
      "scout-local": { model: "openrouter/z-ai/glm-5.3-flash" },
    },
  },
};

const ctx = { source: "session-action" } as never; // handlers here ignore the invocation context

function setup(initial?: unknown) {
  const store = new MemoryConfigStore(initial);
  const inventory = new InventoryStore();
  const emitted: { event: string; payload: unknown }[] = [];
  let clock = 1_000;
  const handlers = createHandlers({
    pluginVersion: "9.9.9",
    configStore: store,
    inventory,
    getHostConfig: () => hostConfig,
    events: { emit: (event, payload) => void emitted.push({ event, payload }) },
    now: () => clock++,
  });
  return { store, inventory, emitted, handlers };
}

const tools = [
  { name: "read", description: "Read files.", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } },
  { name: "browser", description: "Control a browser.", parameters: { type: "object", properties: { url: { type: "string" } } } },
  { name: "automations", description: "Manage automations.", parameters: { type: "object", properties: { job: { type: "object" } } } },
];

describe("status", () => {
  it("reports defaults, contract version and the agents known to the host", async () => {
    const { handlers } = setup();
    const status = await handlers.status({}, ctx);
    assert.equal(status.contractVersion, CONTRACT_VERSION);
    assert.equal(status.pluginVersion, "9.9.9");
    assert.equal(status.enabled, true);
    assert.equal(status.defaultMode, "native");
    assert.equal(status.configValid, true);
    assert.deepEqual(status.agents.map((agent) => agent.agentId), ["coordinator", "scout-local"]);
  });

  it("resolves harness and effective mode per agent", async () => {
    const { handlers } = setup({ defaultMode: "plugin" });
    const { agents } = await handlers.status({}, ctx);
    const coordinator = agents.find((agent) => agent.agentId === "coordinator");
    const local = agents.find((agent) => agent.agentId === "scout-local");
    assert.equal(coordinator?.harness, "codex");
    assert.equal(coordinator?.mode, "plugin");
    assert.equal(coordinator?.effectiveMode, "off");
    assert.equal(coordinator?.effectiveReason, "codex-native-deferral");
    assert.match(coordinator?.notes[0] ?? "", /Codex app-server/u);
    assert.equal(local?.harness, "embedded");
    assert.equal(local?.effectiveMode, "plugin");
    assert.deepEqual(local?.notes, []);
  });

  it("includes configured agents that the host does not list and supports the agentId filter", async () => {
    const { handlers } = setup({ agents: { ghost: { mode: "off" } } });
    const all = await handlers.status({}, ctx);
    assert.ok(all.agents.some((agent) => agent.agentId === "ghost"));
    const one = await handlers.status({ agentId: "scout-local" }, ctx);
    assert.deepEqual(one.agents.map((agent) => agent.agentId), ["scout-local"]);
  });

  it("shows counts and schema sizes once an inventory is known, null before", async () => {
    const { handlers, inventory } = setup({ agents: { "scout-local": { core: ["read"], never: ["browser"] } } });
    assert.equal((await handlers.status({ agentId: "scout-local" }, ctx)).agents[0]?.counts, null);
    inventory.record("scout-local", tools, "observed-run", 5);
    const agent = (await handlers.status({ agentId: "scout-local" }, ctx)).agents[0];
    assert.deepEqual(agent?.counts, { core: 1, deferred: 1, never: 1 });
    assert.ok(agent?.schema && agent.schema.totalBytes > agent.schema.visibleBytes && agent.schema.savingPct > 0);
  });

  it("falls back to everything off and lists the issues when the config is invalid", async () => {
    const { handlers } = setup({ defaultMode: "turbo" });
    const status = await handlers.status({}, ctx);
    assert.equal(status.configValid, false);
    assert.equal(status.enabled, false);
    assert.equal(status.configIssues[0]?.path, "defaultMode");
    assert.ok(status.agents.every((agent) => agent.effectiveMode === "off" && agent.effectiveReason === "plugin-disabled"));
  });

  it("reflects the master and per-agent switches", async () => {
    const { handlers } = setup({ agents: { "scout-local": { enabled: false } } });
    const local = (await handlers.status({ agentId: "scout-local" }, ctx)).agents[0];
    assert.equal(local?.enabled, false);
    assert.equal(local?.effectiveReason, "agent-disabled");
  });
});

describe("catalog", () => {
  it("is unavailable until an inventory is observed or provided", async () => {
    const { handlers } = setup();
    const catalog = await handlers.catalog({ agentId: "scout-local" }, ctx);
    assert.equal(catalog.available, false);
    assert.deepEqual(catalog.entries, []);
  });

  it("classifies the observed inventory with the agent's lists", async () => {
    const { handlers, inventory } = setup({ agents: { "scout-local": { core: ["read"], never: ["browser"] } } });
    inventory.record("scout-local", tools, "observed-run", 7);
    const catalog = await handlers.catalog({ agentId: "scout-local" }, ctx);
    assert.equal(catalog.origin, "observed-run");
    assert.deepEqual(catalog.entries.map((entry) => `${entry.class}:${entry.name}`), ["core:read", "deferred:automations", "never:browser"]);
  });

  it("accepts a provided inventory, remembers it, and filters by class and sort", async () => {
    const { handlers, inventory } = setup({ agents: { coordinator: { core: ["read"] } } });
    const first = await handlers.catalog({ agentId: "coordinator", inventory: tools, classes: ["deferred"], sort: "size" }, ctx);
    assert.equal(first.origin, "provided");
    assert.deepEqual(first.entries.map((entry) => entry.name), ["automations", "browser"]);
    assert.equal(first.summary.total.count, 3, "summary covers all classes even when entries are filtered");
    assert.equal(inventory.get("coordinator")?.tools.length, 3);
    const again = await handlers.catalog({ agentId: "coordinator" }, ctx);
    assert.equal(again.entries.length, 3);
  });
});

describe("set-mode", () => {
  it("changes the plugin default and emits config-changed", async () => {
    const { handlers, store, emitted } = setup();
    const result = await handlers["set-mode"]({ mode: "plugin" }, ctx);
    assert.deepEqual(result, { changed: true, scope: "default", mode: "plugin", previousMode: "native", notes: [] });
    assert.equal(((await store.read()) as { defaultMode: string }).defaultMode, "plugin");
    assert.deepEqual(emitted, [{ event: "config-changed", payload: { change: "mode", scope: "default", at: 1_000 } }]);
  });

  it("changes one agent and warns when its runtime cannot honour the mode", async () => {
    const { handlers, store } = setup();
    const result = await handlers["set-mode"]({ mode: "plugin", agentId: "coordinator" }, ctx);
    assert.equal(result.scope, "agent");
    assert.equal(result.agentId, "coordinator");
    assert.match(result.notes.join(" "), /Codex app-server/u);
    assert.deepEqual(((await store.read()) as { agents: unknown }).agents, { coordinator: { mode: "plugin" } });
  });

  it("notes that native mode is global", async () => {
    const { handlers } = setup({ defaultMode: "off" });
    const result = await handlers["set-mode"]({ mode: "native", agentId: "scout-local" }, ctx);
    assert.match(result.notes.join(" "), /global tools\.toolSearch/u);
  });

  it("is a no-op, with no write and no event, when nothing changes", async () => {
    const { handlers, store, emitted } = setup();
    const result = await handlers["set-mode"]({ mode: "native", agentId: "scout-local" }, ctx);
    assert.equal(result.changed, false);
    assert.equal(await store.read(), undefined, "an inherited value must not create an agent entry");
    assert.deepEqual(emitted, []);
  });

  it("refuses to edit an invalid config", async () => {
    const { handlers } = setup({ defaultMode: "turbo" });
    await assert.rejects(async () => handlers["set-mode"]({ mode: "off" }, ctx), (error: unknown) => error instanceof LazyLoadingError && error.code === "CONFIG_INVALID");
  });
});

describe("set-agent-enabled", () => {
  it("disables and re-enables an agent", async () => {
    const { handlers, store, emitted } = setup();
    const off = await handlers["set-agent-enabled"]({ agentId: "scout-local", enabled: false }, ctx);
    assert.deepEqual(off, { changed: true, agentId: "scout-local", enabled: false, previousEnabled: true, notes: [] });
    const on = await handlers["set-agent-enabled"]({ agentId: "scout-local", enabled: true }, ctx);
    assert.equal(on.changed, true);
    assert.equal(on.previousEnabled, false);
    assert.deepEqual(((await store.read()) as { agents: unknown }).agents, { "scout-local": { enabled: true } });
    assert.equal(emitted.length, 2);
  });

  it("reports a no-op and the global switch", async () => {
    const { handlers } = setup({ enabled: false });
    const result = await handlers["set-agent-enabled"]({ agentId: "scout-local", enabled: true }, ctx);
    assert.equal(result.changed, false);
    assert.match(result.notes.join(" "), /disabled globally/u);
  });
});

describe("set-tool-class", () => {
  it("moves a tool between core, deferred and never, writing only the lists that change", async () => {
    const { handlers, store, emitted } = setup();
    const toNever = await handlers["set-tool-class"]({ agentId: "scout-local", tool: "browser", class: "never" }, ctx);
    assert.equal(toNever.previousClass, "deferred");
    assert.deepEqual(toNever.never, ["browser"]);
    assert.deepEqual(((await store.read()) as { agents: unknown }).agents, { "scout-local": { never: ["browser"] } });

    const toCore = await handlers["set-tool-class"]({ agentId: "scout-local", tool: "browser", class: "core" }, ctx);
    assert.equal(toCore.previousClass, "never");
    assert.ok(toCore.core.includes("browser"));
    assert.deepEqual(toCore.never, []);

    const back = await handlers["set-tool-class"]({ agentId: "scout-local", tool: "browser", class: "deferred" }, ctx);
    assert.equal(back.previousClass, "core");
    assert.ok(!back.core.includes("browser"));
    assert.equal(emitted.length, 3);
  });

  it("starts from the inherited lists when materializing an agent entry", async () => {
    const { handlers } = setup({ defaults: { core: ["read", "write"] } });
    const result = await handlers["set-tool-class"]({ agentId: "coordinator", tool: "ls", class: "core" }, ctx);
    assert.deepEqual(result.core, ["ls", "read", "write"]);
  });

  it("is a no-op for an unchanged class", async () => {
    const { handlers, store } = setup();
    const result = await handlers["set-tool-class"]({ agentId: "scout-local", tool: "read", class: "core" }, ctx);
    assert.equal(result.changed, false);
    assert.equal(await store.read(), undefined);
  });

  it("refuses to change the loader tool", async () => {
    const { handlers } = setup();
    await assert.rejects(
      async () => handlers["set-tool-class"]({ agentId: "scout-local", tool: "lazy_load_tools", class: "never" }, ctx),
      (error: unknown) => error instanceof LazyLoadingError && error.code === "INVALID_ARGUMENT",
    );
  });
});

describe("stubs", () => {
  const stubs = [
    ["stats", "F-09"],
    ["session-state", "F-06"],
    ["reset-session", "F-06"],
    ["run-benchmark", "F-11"],
  ] as const;

  for (const [operation, task] of stubs) {
    it(`${operation} fails with a typed NOT_IMPLEMENTED error (${task})`, async () => {
      const { handlers } = setup();
      await assert.rejects(
        (handlers[operation] as (input: unknown, context: unknown) => Promise<unknown>)({}, ctx),
        (error: unknown) =>
          error instanceof LazyLoadingError &&
          error.code === "NOT_IMPLEMENTED" &&
          error.task === task &&
          parseErrorCode(error.message) === "NOT_IMPLEMENTED" &&
          error.message.includes(operation),
      );
    });
  }
});

describe("error codes", () => {
  it("round-trips every code through the message prefix", () => {
    for (const code of ERROR_CODES) {
      assert.equal(parseErrorCode(new LazyLoadingError(code, "x").message), code);
    }
    assert.equal(parseErrorCode("plain failure"), undefined);
    assert.equal(parseErrorCode("[lazy-loading:BOGUS] nope"), undefined);
  });
});
