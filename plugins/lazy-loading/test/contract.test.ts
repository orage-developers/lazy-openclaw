import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import entry from "../src/index.js";
import { CONTRACT_VERSION, contract, EVENT_NAMES, OPERATION_NAMES } from "../src/contract.js";
import { PLUGIN_VERSION } from "../src/version.js";

/** The surface PLAN.md F-10 promises to the CLI, the slash command and the UI. */
const EXPECTED_OPERATIONS = {
  status: "query",
  catalog: "query",
  stats: "query",
  "session-state": "query",
  "set-mode": "action",
  "set-agent-enabled": "action",
  "set-tool-class": "action",
  "reset-session": "action",
  "run-benchmark": "action",
} as const;
const EXPECTED_EVENTS = ["config-changed", "stats-updated", "tools-loaded", "benchmark-progress"];

type ActionResult = { ok: true; result: unknown } | { ok: false; error: string; code: string };
type Action = { id: string; requiredScopes: string[]; handler(action: { payload: unknown }): Promise<ActionResult> };

/** Runs the real entry against a fake plugin API and a fake host config. */
function load(pluginConfig?: unknown) {
  const hostConfig: Record<string, unknown> = {
    plugins: { entries: { "lazy-loading": { config: pluginConfig }, codex: { enabled: true } } },
    agents: { defaults: { model: "openai/gpt-5.6-luna" }, entries: { coordinator: {}, "scout-local": { model: "openrouter/z-ai/glm-5.3-flash" } } },
  };
  const actions = new Map<string, Action>();
  const tools: { name: string; catalogMode?: string }[] = [];
  const hooks: string[] = [];
  const services: { start(context: unknown): void }[] = [];
  const emitted: { event: string; payload: unknown }[] = [];
  const api = {
    id: "lazy-loading",
    registerSessionAction: (action: Action) => void actions.set(action.id, action),
    registerTool: (tool: { name: string; catalogMode?: string } | ((ctx: { agentId: string; sessionKey: string }) => { name: string; catalogMode?: string })) => {
      tools.push(typeof tool === "function" ? tool({ agentId: "scout-local", sessionKey: "scout-local:test" }) : tool);
    },
    registerService: (service: { start(context: unknown): void }) => void services.push(service),
    registerCommand: () => undefined,
    on: (name: string) => void hooks.push(name),
    runtime: {
      config: {
        current: () => hostConfig,
        mutateConfigFile: async ({ mutate }: { mutate: (draft: Record<string, unknown>) => void }) => {
          mutate(hostConfig);
          return {};
        },
      },
    },
  };
  entry.register(api as never);
  for (const service of services) service.start({ gatewayEvents: { emit: (event: string, payload: unknown) => emitted.push({ event, payload }) } });
  const call = (id: string, payload: unknown) => {
    const action = actions.get(id);
    assert.ok(action, `operation ${id} must be registered`);
    return action.handler({ payload });
  };
  return { actions, tools, hooks, emitted, call, hostConfig };
}

describe("contract surface", () => {
  it("declares exactly the operations promised by PLAN.md F-10 with the right kinds", () => {
    const actual = Object.fromEntries(OPERATION_NAMES.map((name) => [name, contract.operations[name].kind]));
    assert.deepEqual(actual, EXPECTED_OPERATIONS);
  });

  it("declares the planned events plus benchmark-progress", () => {
    assert.deepEqual([...EVENT_NAMES].sort(), [...EXPECTED_EVENTS].sort());
  });

  it("describes every operation and keeps plugin ids consistent", () => {
    assert.equal(contract.pluginId, "lazy-loading");
    for (const name of OPERATION_NAMES) assert.ok(contract.operations[name].description.length > 20, name);
  });

  it("exposes a stable version", () => {
    assert.equal(CONTRACT_VERSION, 1);
  });

  it("keeps the plugin version in sync with package.json and the manifest", () => {
    const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { version: string };
    const manifest = JSON.parse(readFileSync(new URL("../../openclaw.plugin.json", import.meta.url), "utf8")) as { version: string };
    assert.equal(PLUGIN_VERSION, pkg.version);
    assert.equal(manifest.version, pkg.version);
  });
});

describe("registration through the OpenClaw feature runtime", () => {
  it("registers one session action per operation with the right scope", () => {
    const { actions } = load();
    assert.deepEqual([...actions.keys()].sort(), Object.keys(EXPECTED_OPERATIONS).sort());
    for (const [name, kind] of Object.entries(EXPECTED_OPERATIONS)) {
      assert.deepEqual(actions.get(name)?.requiredScopes, [kind === "query" ? "operator.read" : "operator.write"]);
    }
  });

  it("registers lazy_load_tools and the inventory, prompt-build and session-end hooks", () => {
    const { tools, hooks } = load();
    assert.deepEqual(tools.map((tool) => [tool.name, tool.catalogMode]), [["lazy_load_tools", "direct-only"]]);
    assert.deepEqual(hooks, ["llm_input", "before_prompt_build", "session_end"]);
  });

  it("validates inputs and outputs at the transport boundary", async () => {
    const { call } = load();
    const bad = await call("set-mode", { mode: "turbo" });
    assert.equal(bad.ok, false);
    assert.equal(!bad.ok && bad.code, "INVALID_INPUT");
    const extra = await call("status", { surprise: true });
    assert.equal(!extra.ok && extra.code, "INVALID_INPUT");
    const badAgent = await call("catalog", { agentId: "has space" });
    assert.equal(!badAgent.ok && badAgent.code, "INVALID_INPUT");
  });

  it("serves status with an output that satisfies the contract schema", async () => {
    const { call } = load({ defaultMode: "plugin" });
    const status = await call("status", {});
    assert.equal(status.ok, true);
    const result = status.ok ? (status.result as { agents: { agentId: string; harness: string; effectiveMode: string }[] }) : undefined;
    assert.deepEqual(result?.agents.map((agent) => [agent.agentId, agent.harness, agent.effectiveMode]), [
      ["coordinator", "codex", "off"],
      ["scout-local", "embedded", "plugin"],
    ]);
  });

  it("serves catalog with a provided inventory", async () => {
    const { call } = load();
    const response = await call("catalog", { agentId: "scout-local", inventory: [{ name: "read", description: "Read files.", parameters: { type: "object" } }] });
    assert.equal(response.ok, true);
    const catalog = response.ok ? (response.result as { available: boolean; entries: { name: string; class: string }[] }) : undefined;
    assert.equal(catalog?.available, true);
    assert.deepEqual(catalog?.entries.map((e) => [e.name, e.class]), [["read", "core"]]);
  });

  it("persists actions through the host config and emits events", async () => {
    const { call, hostConfig, emitted } = load();
    const response = await call("set-mode", { mode: "off", agentId: "scout-local" });
    assert.equal(response.ok, true);
    const plugins = hostConfig.plugins as { entries: { "lazy-loading": { config: unknown } } };
    assert.deepEqual(plugins.entries["lazy-loading"].config, { agents: { "scout-local": { mode: "off" } } });
    assert.equal(emitted[0]?.event, "config-changed");

    const tool = await call("set-tool-class", { agentId: "scout-local", tool: "browser", class: "never" });
    assert.equal(tool.ok, true);
    assert.deepEqual(plugins.entries["lazy-loading"].config, { agents: { "scout-local": { mode: "off", never: ["browser"] } } });
  });

  it("keeps only unfinished operations as typed NOT_IMPLEMENTED errors", async () => {
    const { call } = load();
    await assert.rejects(call("stats", {}), /\[lazy-loading:NOT_IMPLEMENTED\] stats is not implemented yet \(planned: F-09\)/u);
    assert.deepEqual(await call("session-state", { sessionKey: "agent:a:main" }), { ok: true, result: { sessionKey: "agent:a:main", stickyTurns: 0, tools: [], misses: [] } });
    assert.deepEqual(await call("reset-session", { agentId: "a" }), { ok: true, result: { cleared: 0 } });
    await assert.rejects(call("run-benchmark", { agentId: "a", prompt: "hi" }), /NOT_IMPLEMENTED/u);
  });
});
