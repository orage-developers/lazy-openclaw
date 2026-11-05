import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { pluginConfigSchema } from "../src/config/plugin-schema.js";
import { DEFAULT_CORE_TOOLS } from "../src/config/schema.js";
import { ConfigError, formatIssues, parseConfig, parseConfigOrThrow, resolveAgentConfig } from "../src/config/validate.js";

function issuesOf(raw: unknown) {
  const result = parseConfig(raw);
  assert.equal(result.ok, false, "expected the config to be rejected");
  return result.ok ? [] : result.issues;
}

describe("parseConfig defaults", () => {
  it("accepts undefined, null and {} and fills every default", () => {
    for (const raw of [undefined, null, {}]) {
      const result = parseConfig(raw);
      assert.ok(result.ok);
      assert.equal(result.config.enabled, true);
      assert.equal(result.config.defaultMode, "native");
      assert.deepEqual(result.config.defaults.core, [...DEFAULT_CORE_TOOLS].sort());
      assert.deepEqual(result.config.defaults.never, []);
      assert.equal(result.config.defaults.stickyTurns, 10);
      assert.equal(result.config.defaults.predict, true);
      assert.deepEqual(result.config.predictor, { enabled: true, maxPredicted: 5, minScore: 0.3 });
      assert.deepEqual(result.config.metrics, { enabled: true, retentionDays: 14 });
      assert.deepEqual(result.config.agents, {});
    }
  });

  it("accepts the example config from PLAN.md F-02", () => {
    const result = parseConfig({
      enabled: true,
      defaultMode: "plugin",
      agents: {
        coordinator: {
          enabled: true,
          mode: "plugin",
          core: ["read", "write", "scout_ask_user"],
          never: [],
          stickyTurns: 10,
          predict: true,
        },
      },
      predictor: { enabled: true, maxPredicted: 5, minScore: 0.3 },
      metrics: { enabled: true, retentionDays: 14 },
    });
    assert.ok(result.ok);
    assert.equal(result.config.defaultMode, "plugin");
    assert.deepEqual(result.config.agents.coordinator?.core, ["read", "scout_ask_user", "write"]);
  });

  it("sorts and deduplicates tool lists for a deterministic order", () => {
    const result = parseConfig({ defaults: { core: ["write", "read", "read"] } });
    assert.ok(result.ok);
    assert.deepEqual(result.config.defaults.core, ["read", "write"]);
  });
});

describe("resolveAgentConfig", () => {
  const parsed = parseConfig({
    defaultMode: "native",
    defaults: { core: ["read"], never: ["browser"], stickyTurns: 4 },
    agents: {
      friday: { mode: "plugin", core: ["read", "write"], stickyTurns: 0, predict: false },
      writer: { enabled: false },
    },
  });
  assert.ok(parsed.ok);
  const config = parsed.config;

  it("inherits defaultMode and defaults for agents without an entry", () => {
    const agent = resolveAgentConfig(config, "researcher");
    assert.deepEqual(
      { enabled: agent.enabled, mode: agent.mode, core: agent.core, never: agent.never, stickyTurns: agent.stickyTurns, hasOverride: agent.hasOverride },
      { enabled: true, mode: "native", core: ["read"], never: ["browser"], stickyTurns: 4, hasOverride: false },
    );
  });

  it("lets an agent entry replace lists and scalars", () => {
    const agent = resolveAgentConfig(config, "friday");
    assert.equal(agent.mode, "plugin");
    assert.deepEqual(agent.core, ["read", "write"]);
    assert.deepEqual(agent.never, ["browser"]);
    assert.equal(agent.stickyTurns, 0);
    assert.equal(agent.predict, false);
    assert.equal(agent.hasOverride, true);
  });

  it("honours per-agent and global disable switches", () => {
    assert.equal(resolveAgentConfig(config, "writer").enabled, false);
    const off = parseConfig({ enabled: false, agents: { friday: { enabled: true } } });
    assert.ok(off.ok);
    assert.equal(resolveAgentConfig(off.config, "friday").enabled, false);
  });

  it("turns prediction off for every agent when the predictor is disabled", () => {
    const noPredictor = parseConfig({ predictor: { enabled: false } });
    assert.ok(noPredictor.ok);
    assert.equal(resolveAgentConfig(noPredictor.config, "any").predict, false);
  });
});

describe("parseConfig rejects invalid input with clear messages", () => {
  it("rejects non-object config", () => {
    assert.deepEqual(issuesOf("nope"), [{ path: "", message: "config must be an object" }]);
    assert.deepEqual(issuesOf([]), [{ path: "", message: "config must be an object" }]);
  });

  it("rejects unknown keys at every level", () => {
    const issues = issuesOf({ surprise: 1, agents: { a: { colour: "red" } }, predictor: { turbo: true } });
    const text = formatIssues(issues);
    assert.match(text, /\(root\): unknown key: surprise/u);
    assert.match(text, /agents\.a: unknown key: colour/u);
    assert.match(text, /predictor: unknown key: turbo/u);
  });

  it("rejects an unknown mode and lists the valid ones", () => {
    const issues = issuesOf({ defaultMode: "turbo", agents: { a: { mode: "auto" } } });
    assert.deepEqual(
      issues.map((issue) => issue.path).sort(),
      ["agents.a.mode", "defaultMode"],
    );
    for (const issue of issues) assert.match(issue.message, /must be one of: native, plugin, off/u);
  });

  it("rejects out-of-range numbers", () => {
    const issues = issuesOf({
      predictor: { maxPredicted: -1, minScore: 1.5 },
      metrics: { retentionDays: 0 },
      defaults: { stickyTurns: 5000 },
    });
    assert.deepEqual(
      issues.map((issue) => issue.path).sort(),
      ["defaults.stickyTurns", "metrics.retentionDays", "predictor.maxPredicted", "predictor.minScore"],
    );
  });

  it("rejects tool names with spaces or globs", () => {
    const issues = issuesOf({ agents: { a: { core: ["read file", "web_*"] } } });
    assert.equal(issues.length, 2);
    for (const issue of issues) assert.match(issue.message, /exact tool name/u);
  });

  it("rejects wrong types", () => {
    const issues = issuesOf({ enabled: "yes" });
    assert.deepEqual(issues, [{ path: "enabled", message: "must be boolean" }]);
  });

  it("rejects tools that are both core and never, per agent and for defaults", () => {
    const perAgent = issuesOf({ agents: { a: { core: ["read"], never: ["read"] } } });
    assert.deepEqual(perAgent, [{ path: "agents.a", message: "tools cannot be both core and never: read" }]);
    const defaults = issuesOf({ defaults: { core: ["read"], never: ["read"] } });
    assert.equal(defaults[0]?.path, "defaults");
  });

  it("detects conflicts introduced by inheritance", () => {
    const issues = issuesOf({ defaults: { core: ["read"] }, agents: { a: { never: ["read"] } } });
    assert.deepEqual(issues, [{ path: "agents.a", message: "tools cannot be both core and never: read" }]);
  });

  it("forbids hiding the loader tool", () => {
    const issues = issuesOf({ defaults: { never: ["lazy_load_tools"] } });
    assert.match(issues[0]?.message ?? "", /lazy_load_tools is the loader/u);
  });

  it("rejects malformed agent ids", () => {
    const issues = issuesOf({ agents: { "bad id": {} } });
    assert.equal(issues[0]?.path, "agents.bad id");
  });

  it("collects every problem in one pass", () => {
    const issues = issuesOf({ defaultMode: "x", enabled: 3, predictor: { minScore: 9 } });
    assert.equal(issues.length, 3);
  });
});

describe("parseConfigOrThrow", () => {
  it("returns the resolved config", () => {
    assert.equal(parseConfigOrThrow({ defaultMode: "off" }).defaultMode, "off");
  });

  it("throws ConfigError carrying the issues", () => {
    assert.throws(
      () => parseConfigOrThrow({ defaultMode: "x" }),
      (error: unknown) => error instanceof ConfigError && error.issues.length === 1 && /defaultMode/u.test(error.message),
    );
  });
});

describe("plugin config schema (host integration)", () => {
  it("exposes a JSON schema that rejects unknown keys", () => {
    const schema = pluginConfigSchema.jsonSchema as { additionalProperties?: boolean; properties?: Record<string, unknown> };
    assert.equal(schema.additionalProperties, false);
    assert.ok(schema.properties && "defaultMode" in schema.properties && "agents" in schema.properties);
  });

  it("maps issues to host-style paths in safeParse", () => {
    const result = pluginConfigSchema.safeParse?.({ agents: { a: { mode: "bad" } } });
    assert.ok(result && !result.success);
    assert.deepEqual(result.error?.issues?.[0]?.path, ["agents", "a", "mode"]);
    assert.match(result.error?.issues?.[0]?.message ?? "", /must be one of/u);
  });

  it("accepts valid config in safeParse", () => {
    assert.equal(pluginConfigSchema.safeParse?.({ defaultMode: "off" })?.success, true);
  });

  it("keeps openclaw.plugin.json in sync with the code (run `npm run build`)", () => {
    const manifest = JSON.parse(readFileSync(new URL("../../openclaw.plugin.json", import.meta.url), "utf8")) as {
      configSchema: unknown;
    };
    assert.deepEqual(manifest.configSchema, JSON.parse(JSON.stringify(pluginConfigSchema.jsonSchema)));
  });
});
