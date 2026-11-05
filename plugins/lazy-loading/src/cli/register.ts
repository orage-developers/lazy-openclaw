import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import type { FeatureInvocationContext } from "openclaw/plugin-sdk/feature-plugin";
import type { LazyLoadingContract } from "../contract.js";
import { getCliHandlers } from "./handler-bridge.js";
import { getLocalCliHandlers } from "./local-handlers.js";

type CliApi = Pick<OpenClawPluginApi, "registerCli">;
type CliRegistrarContext = Parameters<Parameters<CliApi["registerCli"]>[0]>[0];
type CliCommandContext = FeatureInvocationContext & { source: "command" };

const descriptors = [
  { name: "lazy-loading", description: "Manage lazy-loading tools", hasSubcommands: true },
  { name: "lazy", description: "Manage lazy-loading tools (alias)", hasSubcommands: true },
] as const;

function output(value: unknown, json: boolean): string {
  if (json) return JSON.stringify(value, null, 2);
  if (isStatus(value)) {
    const lines = [`Lazy Loading ${value.enabled ? "enabled" : "disabled"} · mode ${value.defaultMode} · config ${value.configValid ? "valid" : "invalid"}`];
    for (const agent of value.agents) {
      const counts = agent.counts ? `core ${agent.counts.core}, deferred ${agent.counts.deferred}, never ${agent.counts.never}` : "tool inventory unknown";
      lines.push(`${agent.agentId}: ${agent.enabled ? "enabled" : "disabled"} · ${agent.effectiveMode} (${agent.harness}) · ${counts}`);
      if (agent.metrics) lines.push(`  metrics: ${agent.metrics.turns} turns, ${agent.metrics.loads} loads, ${agent.metrics.misses} misses`);
      for (const note of agent.notes) lines.push(`  note: ${note}`);
    }
    return lines.join("\n");
  }
  if (isCatalog(value)) {
    if (!value.available) return `No tool inventory is known for agent ${value.agentId}.`;
    const entries = value.entries.map((tool) => `${tool.class.padEnd(8)} ${tool.name} · ${tool.schemaBytes} B · ${tool.signature}`);
    return [`Catalog ${value.agentId}: ${value.entries.length} tools · ${value.summary.total.bytes} schema bytes`, ...entries].join("\n");
  }
  return JSON.stringify(value, null, 2);
}

function isStatus(value: unknown): value is { enabled: boolean; defaultMode: string; configValid: boolean; agents: { agentId: string; enabled: boolean; effectiveMode: string; harness: string; counts: null | { core: number; deferred: number; never: number }; metrics?: { turns: number; loads: number; misses: number }; notes: string[] }[] } {
  return typeof value === "object" && value !== null && "agents" in value && Array.isArray(value.agents) && "defaultMode" in value;
}

function isCatalog(value: unknown): value is { agentId: string; available: boolean; entries: { class: string; name: string; schemaBytes: number; signature: string }[]; summary: { total: { bytes: number } } } {
  return typeof value === "object" && value !== null && "agentId" in value && "available" in value && "entries" in value && Array.isArray(value.entries) && "summary" in value;
}

function localFallbackIsRequired(error: unknown): boolean {
  return error instanceof Error && (
    error.message.includes("handlers were not bound during plugin setup") ||
    error.message.includes("runtime is intentionally unavailable during \"cli-metadata\"")
  );
}

function registerRoot(program: CliRegistrarContext["program"], alias: boolean, api: OpenClawPluginApi, localConfigMode: boolean): void {
  const name = alias ? "lazy" : "lazy-loading";
  const root = program.command(name).description(alias ? "Manage lazy-loading tools (alias)" : "Manage lazy-loading tools");
  const invoke = async (operation: keyof LazyLoadingContract["operations"], input: Record<string, unknown>) => {
    let handlers: Awaited<ReturnType<typeof getLocalCliHandlers>>;
    if (localConfigMode) {
      handlers = getLocalCliHandlers();
    } else {
      try {
        handlers = getCliHandlers(api.runtime.config as object);
      } catch (error) {
        if (!localFallbackIsRequired(error)) throw error;
        handlers = getLocalCliHandlers();
      }
    }
    const handler = handlers[operation] as (arg: Record<string, unknown>, context: FeatureInvocationContext) => Promise<unknown>;
    return handler(input, { source: "command", api, command: {} } as CliCommandContext);
  };

  root.command("status").description("Show lazy-loading status").option("--agent <id>").option("--json").action(async (options: { agent?: string; json?: boolean }) => {
    const result = await invoke("status", options.agent ? { agentId: options.agent } : {});
    console.log(output(result, Boolean(options.json)));
  });

  for (const enabled of [true, false]) {
    root.command(enabled ? "enable" : "disable")
      .description(`${enabled ? "Enable" : "Disable"} lazy loading for agents`)
      .option("--agent <id>")
      .option("--all")
      .action(async (options: { agent?: string; all?: boolean }) => {
        if (Boolean(options.agent) === Boolean(options.all)) throw new Error("Specify exactly one of --agent <id> or --all.");
        const ids = options.agent ? [options.agent] : (await invoke("status", {}) as { agents: { agentId: string }[] }).agents.map(({ agentId }) => agentId);
        if (ids.length === 0) throw new Error("No agents are known; specify an agent explicitly.");
        const results = await Promise.all(ids.map((agentId) => invoke("set-agent-enabled", { agentId, enabled })));
        console.log(output(results, false));
      });
  }

  root.command("mode").description("Configure lazy-loading mode")
    .command("set <mode>").option("--agent <id>")
    .action(async (mode: string, options: { agent?: string }) => {
      if (!["native", "plugin", "off"].includes(mode)) throw new Error("Mode must be native, plugin, or off.");
      console.log(output(await invoke("set-mode", { mode, ...(options.agent ? { agentId: options.agent } : {}) }), false));
    });

  for (const toolClass of ["core", "never"] as const) {
    const group = root.command(toolClass).description(`Manage ${toolClass} tools`);
    group.command("list").requiredOption("--agent <id>").action(async (options: { agent: string }) => {
      const result = await invoke("catalog", { agentId: options.agent, classes: [toolClass] });
      console.log(output(result, false));
    });
    for (const action of ["add", "remove"] as const) {
      group.command(`${action} <tool...>`).requiredOption("--agent <id>").action(async (tools: string[], options: { agent: string }) => {
        const targetClass = action === "add" ? toolClass : "deferred";
        const results = await Promise.all(tools.map((tool) => invoke("set-tool-class", { agentId: options.agent, tool, class: targetClass })));
        console.log(output(results, false));
      });
    }
  }

  root.command("catalog").description("Show an agent tool catalog").requiredOption("--agent <id>").option("--json").option("--sort <sort>")
    .action(async (options: { agent: string; json?: boolean; sort?: string }) => {
      if (options.sort && !["class", "name", "size"].includes(options.sort)) throw new Error("Sort must be class, name, or size.");
      const result = await invoke("catalog", { agentId: options.agent, ...(options.sort ? { sort: options.sort } : {}) });
      console.log(output(result, Boolean(options.json)));
    });
}

export function registerLazyLoadingCli(api: OpenClawPluginApi): void {
  const localConfigMode = api.registrationMode === "cli-metadata";
  api.registerCli(({ program }) => {
    registerRoot(program, false, api, localConfigMode);
    registerRoot(program, true, api, localConfigMode);
  }, { commands: ["lazy-loading", "lazy"], descriptors });
}
