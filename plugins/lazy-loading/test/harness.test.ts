import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { resolveEffectiveMode, resolveHarness } from "../src/harness.js";

// Mirrors the live setup described in docs/baseline.md.
const hostConfig = {
  plugins: { entries: { codex: { enabled: true } } },
  agents: {
    defaults: {
      model: { primary: "openai/gpt-5.6-luna", fallbacks: ["openai/gpt-5.6-terra"] },
      models: { "openai/gpt-6-astra": { agentRuntime: { id: "openclaw" } } },
    },
    entries: {
      coordinator: { model: "openai/gpt-5.6-luna" },
      friday: { model: "openai/gpt-5.6-terra@openai:profile-1" },
      pinned: { model: "openai/gpt-6-astra" },
      "scout-local": { model: "openrouter/z-ai/glm-5.3-flash" },
      inherits: {},
    },
  },
};

describe("resolveHarness", () => {
  it("assumes Codex for openai/* when the codex plugin is enabled", () => {
    assert.deepEqual(resolveHarness(hostConfig, "coordinator"), { harness: "codex", source: "auto-codex", modelRef: "openai/gpt-5.6-luna" });
    assert.equal(resolveHarness(hostConfig, "friday").harness, "codex");
  });

  it("uses the defaults model for agents without their own", () => {
    assert.equal(resolveHarness(hostConfig, "inherits").harness, "codex");
    assert.equal(resolveHarness(hostConfig, "not-listed").harness, "codex");
  });

  it("honours a model-scoped agentRuntime pin", () => {
    assert.deepEqual(resolveHarness(hostConfig, "pinned"), { harness: "embedded", source: "model-policy", modelRef: "openai/gpt-6-astra" });
  });

  it("runs non-openai providers on the embedded runner", () => {
    assert.deepEqual(resolveHarness(hostConfig, "scout-local"), {
      harness: "embedded",
      source: "default",
      modelRef: "openrouter/z-ai/glm-5.3-flash",
    });
  });

  it("applies provider-scoped and wildcard policies", () => {
    const config = {
      models: { providers: { openai: { agentRuntime: { id: "openclaw" } } } },
      agents: { defaults: { model: "openai/gpt-5.6-luna", models: { "anthropic/*": { agentRuntime: { id: "claude-cli" } } } }, entries: { c: { model: "anthropic/claude-opus-5" } } },
    };
    assert.deepEqual(resolveHarness(config, "x"), { harness: "embedded", source: "provider-policy", modelRef: "openai/gpt-5.6-luna" });
    assert.equal(resolveHarness(config, "c").harness, "cli");
  });

  it("treats runtime id 'auto' as unset and unknown ids as unknown", () => {
    const auto = { agents: { defaults: { model: "openai/x", models: { "openai/x": { agentRuntime: { id: "auto" } } } } } };
    assert.equal(resolveHarness(auto, "a").harness, "codex");
    const odd = { agents: { defaults: { model: "foo/x", models: { "foo/x": { agentRuntime: { id: "weird" } } } } } };
    assert.equal(resolveHarness(odd, "a").harness, "unknown");
  });

  it("falls back to embedded when the codex plugin is disabled", () => {
    const config = { ...hostConfig, plugins: { entries: { codex: { enabled: false } } } };
    assert.equal(resolveHarness(config, "coordinator").harness, "embedded");
    assert.equal(resolveHarness({ ...hostConfig, plugins: { deny: ["codex"] } }, "coordinator").harness, "embedded");
  });

  it("reports unknown when no model can be found, and tolerates junk config", () => {
    assert.deepEqual(resolveHarness({}, "a"), { harness: "unknown", source: "no-model" });
    assert.equal(resolveHarness(undefined, "a").harness, "unknown");
    assert.equal(resolveHarness("nonsense", "a").harness, "unknown");
  });
});

describe("resolveEffectiveMode", () => {
  const base = { enabled: true, pluginEnabled: true };

  it("keeps the configured mode on the embedded runner", () => {
    assert.deepEqual(resolveEffectiveMode({ ...base, mode: "native", harness: "embedded" }), { mode: "native", reason: "configured" });
    assert.deepEqual(resolveEffectiveMode({ ...base, mode: "plugin", harness: "embedded" }), { mode: "plugin", reason: "configured" });
    assert.deepEqual(resolveEffectiveMode({ ...base, mode: "plugin", harness: "copilot" }), { mode: "plugin", reason: "configured" });
  });

  it("turns Codex and CLI backends off whatever is configured", () => {
    assert.deepEqual(resolveEffectiveMode({ ...base, mode: "plugin", harness: "codex" }), { mode: "off", reason: "codex-native-deferral" });
    assert.deepEqual(resolveEffectiveMode({ ...base, mode: "native", harness: "codex" }), { mode: "off", reason: "codex-native-deferral" });
    assert.deepEqual(resolveEffectiveMode({ ...base, mode: "native", harness: "cli" }), { mode: "off", reason: "cli-backend" });
  });

  it("never lets plugin mode run when the harness is unknown", () => {
    assert.deepEqual(resolveEffectiveMode({ ...base, mode: "plugin", harness: "unknown" }), { mode: "off", reason: "harness-unknown" });
    assert.deepEqual(resolveEffectiveMode({ ...base, mode: "native", harness: "unknown" }), { mode: "native", reason: "configured" });
  });

  it("explains disabled and off states", () => {
    assert.equal(resolveEffectiveMode({ enabled: true, pluginEnabled: false, mode: "native", harness: "embedded" }).reason, "plugin-disabled");
    assert.equal(resolveEffectiveMode({ enabled: false, pluginEnabled: true, mode: "native", harness: "embedded" }).reason, "agent-disabled");
    assert.deepEqual(resolveEffectiveMode({ ...base, mode: "off", harness: "embedded" }), { mode: "off", reason: "configured" });
  });
});
