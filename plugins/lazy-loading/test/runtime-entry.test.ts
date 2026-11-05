import assert from "node:assert/strict";
import { describe, it } from "node:test";
import entry from "../src/index.js";

type Hook = (event: Record<string, unknown>, ctx: Record<string, unknown>) => Promise<{ toolsAllow?: string[] } | undefined>;
type Tool = { execute(id: string, params: unknown): Promise<{ content: { text: string }[]; details: { activated: { name: string }[] } }> };
const configured = () => ({
  agents: {
    defaults: { model: "openai/gpt-5.6-luna", models: { "openai/gpt-5.6-sol": { agentRuntime: { id: "openclaw" } } } },
    entries: { coordinator: {} },
  },
  plugins: { entries: { "lazy-loading": { config: { defaultMode: "plugin", defaults: { core: ["read"], predict: false } } } } },
});
const ctx = { agentId: "coordinator", sessionKey: "agent:coordinator:internal-session-effects:test", modelProviderId: "openai", modelId: "gpt-5.6-sol" };

/** Actual SDK feature registration, no host services started and no inference. */
function register(config = configured(), sessionEntry?: unknown) {
  const hooks = new Map<string, Hook>();
  let factory: (ctx: unknown) => Tool = () => { throw new Error("not registered"); };
  entry.register({
    id: "lazy-loading", config,
    on: (name: string, handler: Hook) => hooks.set(name, handler),
    registerTool: (value: typeof factory) => { factory = value; },
    registerService() {}, registerSessionAction() {}, registerCommand() {},
    runtime: {
      // Deliberately conflicting process config, as allowed by the SDK contract.
      config: { current: () => ({ agents: { defaults: { model: "openai/gpt-5.6-luna" } }, plugins: { entries: { "lazy-loading": { config: { enabled: false } } } } }) },
      agent: { session: { resolveStorePath: () => "offline", getSessionEntry: () => sessionEntry } },
    },
  } as never);
  return {
    before: (context = ctx) => hooks.get("before_prompt_build")!({ prompt: "RETURN OK", messages: [] }, context),
    observe: (tools: unknown[]) => hooks.get("llm_input")!({ tools }, ctx),
    end: () => hooks.get("session_end")!({}, ctx),
    loader: () => factory(ctx),
  };
}

describe("offline registered runtime hooks", () => {
  it("restricts a cold Sol turn using registry config and actual model, without invented tools", async () => {
    const run = register();
    assert.deepEqual(await run.before(), { toolsAllow: ["lazy_load_tools", "read"] });
    assert.match((await run.loader().execute("call", { names: ["browser"] })).content[0]!.text, /pre-filter catalog/u);
  });

  it("isolates registration generations and preserves deferred tools after filtering", async () => {
    const run = register();
    await run.observe([{ name: "read" }, { name: "browser", description: "Browse pages" }]);
    const otherConfig = configured();
    otherConfig.plugins.entries["lazy-loading"].config.defaultMode = "off";
    const other = register(otherConfig);
    assert.equal(await other.before(), undefined);
    assert.deepEqual(await run.before(), { toolsAllow: ["lazy_load_tools", "read"] });
    await run.observe([{ name: "read" }, { name: "lazy_load_tools" }]);
    assert.deepEqual((await run.loader().execute("load", { names: ["browser"] })).details.activated.map((tool) => tool.name), ["browser"]);
    assert.deepEqual(await run.before(), { toolsAllow: ["browser", "lazy_load_tools", "read"] });
    await run.end();
    assert.deepEqual(await run.before(), { toolsAllow: ["lazy_load_tools", "read"] });
  });

  it("does not narrow Codex, CLI, unknown bindings or missing identities", async () => {
    for (const binding of ["codex", "claude-cli", "future-runtime"]) {
      assert.equal(await register(configured(), { agentHarnessId: binding }).before(), undefined);
    }
    assert.equal(await register().before({ ...ctx, modelId: "gpt-5.6-luna" }), undefined);
    assert.equal(await register().before({ ...ctx, agentId: "" }), undefined);
    assert.equal(await register().before({ ...ctx, sessionKey: "" }), undefined);
  });
});
