import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { Command } from "commander";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import type { FeatureHandlers } from "openclaw/plugin-sdk/feature-plugin";
import { clearConfigCache } from "openclaw/plugin-sdk/config-runtime";
import pluginEntry from "../src/index.js";
import type { LazyLoadingContract } from "../src/contract.js";
import { bindCliHandlers, getCliHandlers } from "../src/cli/handler-bridge.js";
import { registerLazyLoadingCli } from "../src/cli/register.js";

describe("CLI handler bridge", () => {
  it("returns the bound handler set by stable key and replaces a rebinding", () => {
    const key = {};
    const handlers = {} as FeatureHandlers<LazyLoadingContract>;
    bindCliHandlers(key, handlers);
    assert.equal(getCliHandlers(key), handlers);
    const replacement = {} as FeatureHandlers<LazyLoadingContract>;
    bindCliHandlers(key, replacement);
    assert.equal(getCliHandlers(key), replacement);
  });

  it("reports a clear error before setup has bound handlers", () => {
    assert.throws(() => getCliHandlers({}), /not ready.*not bound during plugin setup/i);
  });
});

describe("lazy-loading CLI", () => {
  it("declares parse-time roots in the plugin manifest", () => {
    const manifest = JSON.parse(readFileSync(new URL("../../openclaw.plugin.json", import.meta.url), "utf8")) as {
      cliCommands?: { name: string; description: string; hasSubcommands: boolean }[];
    };
    assert.deepEqual(manifest.cliCommands?.map(({ name }) => name), ["lazy-loading", "lazy"]);
    assert.ok(manifest.cliCommands?.every(({ description, hasSubcommands }) => description.length > 0 && hasSubcommands));
  });

  it("registers only parse-time CLI metadata without touching unavailable runtime", () => {
    const program = new Command();
    const descriptors: { name: string; hasSubcommands: boolean }[] = [];
    const runtime = new Proxy({}, { get() { throw new Error("runtime must not be read during CLI metadata"); } });
    const api = {
      id: "lazy-loading",
      registrationMode: "cli-metadata",
      get runtime() { return runtime; },
      registerCli(registrar: (context: { program: Command }) => void, options: { descriptors: readonly { name: string; hasSubcommands: boolean }[] }) {
        descriptors.push(...options.descriptors);
        registrar({ program });
      },
      on() { throw new Error("feature setup must not run during CLI metadata"); },
      registerTool() { throw new Error("runtime tools must not register during CLI metadata"); },
    } as unknown as OpenClawPluginApi;

    pluginEntry.register(api);

    assert.deepEqual(descriptors.map(({ name }) => name), ["lazy-loading", "lazy"]);
    assert.deepEqual(program.commands.map((command) => command.name()), ["lazy-loading", "lazy"]);
  });

  it("executes status from local config when metadata registration has no bound handlers", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "lazy-loading-cli-state-"));
    const configPath = join(stateDir, "openclaw.json");
    const previousStateDir = process.env.OPENCLAW_STATE_DIR;
    const previousConfigPath = process.env.OPENCLAW_CONFIG_PATH;
    writeFileSync(configPath, JSON.stringify({
      plugins: { entries: { "lazy-loading": { enabled: true, config: { enabled: true, defaultMode: "plugin" } } } },
      agents: { entries: { coordinator: {} } },
    }));
    process.env.OPENCLAW_STATE_DIR = stateDir;
    process.env.OPENCLAW_CONFIG_PATH = configPath;
    clearConfigCache();

    const program = new Command();
    const runtime = { config: {} };
    const api = {
      id: "lazy-loading",
      registrationMode: "discovery",
      get runtime() { return runtime; },
      registerCli(registrar: (context: { program: Command }) => void) { registrar({ program }); },
    } as unknown as OpenClawPluginApi;
    const printed: string[] = [];
    const previousLog = console.log;
    console.log = (...args: unknown[]) => printed.push(args.join(" "));
    try {
      registerLazyLoadingCli(api);
      await program.parseAsync(["node", "openclaw", "lazy-loading", "status", "--agent", "coordinator", "--json"]);
      const result = JSON.parse(printed[0] ?? "{}") as { configValid: boolean; agents: { agentId: string }[] };
      assert.equal(result.configValid, true);
      assert.deepEqual(result.agents.map(({ agentId }) => agentId), ["coordinator"]);
    } finally {
      console.log = previousLog;
      clearConfigCache();
      if (previousStateDir === undefined) delete process.env.OPENCLAW_STATE_DIR;
      else process.env.OPENCLAW_STATE_DIR = previousStateDir;
      if (previousConfigPath === undefined) delete process.env.OPENCLAW_CONFIG_PATH;
      else process.env.OPENCLAW_CONFIG_PATH = previousConfigPath;
      rmSync(stateDir, { recursive: true, force: true });
      clearConfigCache();
    }
  });

  it("registers lazy descriptors and dispatches commands through feature handlers at execution", async () => {
    const key = {};
    const program = new Command();
    const handlers = {
      status: async (input: { agentId?: string }) => ({ agents: [{ agentId: input.agentId ?? "alpha" }] }),
      "set-agent-enabled": async (input: { agentId: string; enabled: boolean }) => input,
      "set-mode": async (input: { agentId?: string; mode: string }) => input,
      "set-tool-class": async (input: { agentId: string; tool: string; class: string }) => input,
      catalog: async (input: { agentId: string; sort?: string; classes?: string[] }) => input,
    } as unknown as FeatureHandlers<LazyLoadingContract>;
    const calls: { operation: string; input: unknown }[] = [];
    for (const operation of Object.keys(handlers) as (keyof typeof handlers)[]) {
      const original = handlers[operation] as (...args: unknown[]) => unknown;
      (handlers as unknown as Record<string, unknown>)[operation] = async (input: unknown, context: unknown) => {
        calls.push({ operation, input });
        return original(input as never, context as never);
      };
    }
    const config = key;
    let descriptors: readonly { name: string; hasSubcommands: boolean }[] = [];
    let registrar: ((context: { program: Command }) => void) | undefined;
    const api = {
      runtime: { config },
      registerCli(callback: typeof registrar, options: { descriptors: typeof descriptors }) {
        registrar = callback;
        descriptors = options.descriptors;
      },
    } as unknown as OpenClawPluginApi;
    registerLazyLoadingCli(api);
    assert.deepEqual(descriptors.map(({ name }) => name), ["lazy-loading", "lazy"]);
    assert.ok(descriptors.every(({ hasSubcommands }) => hasSubcommands));
    assert.equal(calls.length, 0, "registration must not resolve/call feature handlers");

    registrar?.({ program });
    bindCliHandlers(config, handlers);
    const printed: string[] = [];
    const previousLog = console.log;
    console.log = (...args: unknown[]) => printed.push(args.join(" "));
    try {
      await program.parseAsync(["node", "openclaw", "lazy", "status", "--agent", "alpha", "--json"]);
      await program.parseAsync(["node", "openclaw", "lazy-loading", "enable", "--agent", "alpha"]);
      await program.parseAsync(["node", "openclaw", "lazy-loading", "mode", "set", "plugin", "--agent", "alpha"]);
      await program.parseAsync(["node", "openclaw", "lazy-loading", "core", "add", "read", "--agent", "alpha"]);
      await program.parseAsync(["node", "openclaw", "lazy-loading", "never", "remove", "bad_tool", "--agent", "alpha"]);
      await program.parseAsync(["node", "openclaw", "lazy-loading", "catalog", "--agent", "alpha", "--sort", "size"]);
    } finally {
      console.log = previousLog;
    }
    assert.deepEqual(calls.map(({ operation }) => operation), ["status", "set-agent-enabled", "set-mode", "set-tool-class", "set-tool-class", "catalog"]);
    assert.deepEqual(calls[1]?.input, { agentId: "alpha", enabled: true });
    assert.deepEqual(calls[3]?.input, { agentId: "alpha", tool: "read", class: "core" });
    assert.deepEqual(calls[4]?.input, { agentId: "alpha", tool: "bad_tool", class: "deferred" });
    assert.equal(JSON.parse(printed[0] ?? "{}").agents[0].agentId, "alpha");
  });
});
