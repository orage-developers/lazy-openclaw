import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { InventoryStore } from "../src/catalog/inventory.js";
import { buildToolsAllow, loadTools } from "../src/service.js";
import { MemoryConfigStore } from "../src/state/config-store.js";
import { SessionStore } from "../src/state/session-store.js";

const host = { plugins: { entries: { codex: { enabled: true } } }, agents: { entries: { local: { model: "openrouter/test" }, codex: { model: "openai/test" } } } };
const tools = [
  { name: "read", description: "Read files", parameters: { type: "object" } },
  { name: "browser", description: "Browse the web", parameters: { type: "object" } },
];
function fixture() {
  const inventory = new InventoryStore(); inventory.record("local", tools, "provided", 1);
  const configStore = new MemoryConfigStore({ defaultMode: "plugin", agents: { local: { core: ["read"], stickyTurns: 2, predict: false } } });
  const sessions = new SessionStore();
  const deps = { pluginVersion: "test", configStore, inventory, getHostConfig: () => host, now: () => 100 };
  return { deps, sessions };
}

describe("plugin runtime", () => {
  it("narrows deterministically to core, loaded and loader tools", async () => {
    const { deps, sessions } = fixture();
    assert.deepEqual(await buildToolsAllow(deps, sessions, { agentId: "local", sessionKey: "local:1" }), ["lazy_load_tools", "read"]);
  });

  it("skips Codex and unknown runtimes, not a known embedded cold start", async () => {
    const { deps, sessions } = fixture();
    assert.equal(await buildToolsAllow(deps, sessions, { agentId: "codex", sessionKey: "codex:1" }), undefined);
    assert.equal(await buildToolsAllow(deps, sessions, { agentId: "unknown", sessionKey: "unknown:1" }), undefined);
    deps.inventory.clear("local");
    assert.deepEqual(await buildToolsAllow(deps, sessions, { agentId: "local", sessionKey: "cold" }), ["lazy_load_tools", "read"]);
    assert.equal(deps.inventory.get("local"), undefined, "restriction must not invent an inventory");
    await assert.rejects(loadTools(deps, sessions, { agentId: "local", sessionKey: "cold", names: ["browser"] }), /pre-filter catalog/u);
  });

  it("loads deferred exact names for the next run, never expands policy", async () => {
    const { deps, sessions } = fixture();
    const result = await loadTools(deps, sessions, { agentId: "local", sessionKey: "local:1", names: ["browser", "missing"] });
    assert.match(result.text, /next turn/u);
    assert.deepEqual(result.tools.map((tool) => tool.name), ["browser"]);
    assert.deepEqual(await buildToolsAllow(deps, sessions, { agentId: "local", sessionKey: "local:1" }), ["browser", "lazy_load_tools", "read"]);
  });

  it("retains deferred descriptors after a restricted llm_input observation", async () => {
    const { deps, sessions } = fixture();
    deps.inventory.record("local", [{ name: "read" }, { name: "lazy_load_tools" }], "observed-run", 2);
    assert.deepEqual((await loadTools(deps, sessions, { agentId: "local", sessionKey: "s", names: ["browser"] })).tools.map((tool) => tool.name), ["browser"]);
  });

  it("revokes stale activations when never or the provided catalog changes", async () => {
    const { deps, sessions } = fixture();
    await loadTools(deps, sessions, { agentId: "local", sessionKey: "s", names: ["browser"] });
    await deps.configStore.update((draft) => { draft.agents!.local!.never = ["browser"]; });
    assert.deepEqual(await buildToolsAllow(deps, sessions, { agentId: "local", sessionKey: "s" }), ["lazy_load_tools", "read"]);
    assert.deepEqual(sessions.get("s").tools, []);
    assert.deepEqual((await loadTools(deps, sessions, { agentId: "local", sessionKey: "s", names: ["browser", "missing"] })).tools, []);
    await deps.configStore.update((draft) => { draft.agents!.local!.never = []; });
    assert.deepEqual(await buildToolsAllow(deps, sessions, { agentId: "local", sessionKey: "s" }), ["lazy_load_tools", "read"]);
    sessions.activate("s", "local", ["browser", "missing"], 10, 1);
    deps.inventory.record("local", [{ name: "read" }], "provided", 3);
    assert.deepEqual(await buildToolsAllow(deps, sessions, { agentId: "local", sessionKey: "s" }), ["lazy_load_tools", "read"]);
  });

  it("never reuses another agent's session activation", async () => {
    const { deps, sessions } = fixture();
    sessions.activate("s", "other", ["browser"], 10, 1);
    assert.deepEqual(await buildToolsAllow(deps, sessions, { agentId: "local", sessionKey: "s" }), ["lazy_load_tools", "read"]);
  });
});
