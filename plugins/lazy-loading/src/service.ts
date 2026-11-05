import type { FeatureEventEmitter, FeatureHandlers } from "openclaw/plugin-sdk/feature-plugin";
import { buildCatalog } from "./catalog/build.js";
import { InventoryStore, normalizeRawTools } from "./catalog/inventory.js";
import type { Catalog, CatalogEntry } from "./catalog/schema.js";
import { applyAgentEnabled, applyAgentMode, applyDefaultMode, applyToolClass, configuredClass } from "./config/mutate.js";
import type { Mode, RawConfig, ResolvedConfig } from "./config/schema.js";
import { type ConfigIssue, formatIssues, parseConfig, resolveAgentConfig } from "./config/validate.js";
import { CONTRACT_VERSION, type LazyLoadingContract } from "./contract.js";
import { LazyLoadingError, notImplemented } from "./errors.js";
import { resolveEffectiveMode, resolveHarness, type Harness, type TurnRuntimeContext } from "./harness.js";
import type { ConfigStore } from "./state/config-store.js";
import { SessionStore } from "./state/session-store.js";
import { LAZY_LOAD_TOOLS_NAME } from "./tools/lazy-load-tools.js";
import { predictTools } from "./predictor/index.js";

export type ServiceDeps = {
  pluginVersion: string;
  configStore: ConfigStore;
  inventory: InventoryStore;
  /** Live OpenClaw config (not the plugin config); used to resolve each agent's runtime. */
  getHostConfig: () => unknown;
  getSessionEntry?: (agentId: string, sessionKey: string) => unknown;
  events?: FeatureEventEmitter<LazyLoadingContract>;
  now?: () => number;
  sessions?: SessionStore;
};

type Handlers = FeatureHandlers<LazyLoadingContract>;

type Loaded = { config: ResolvedConfig; valid: boolean; issues: ConfigIssue[] };

/** Everything off: what the plugin does while its persisted config is invalid. */
function disabledFallback(): ResolvedConfig {
  const parsed = parseConfig({ enabled: false });
  if (!parsed.ok) throw new Error("internal: default config must be valid");
  return parsed.config;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

function hostAgentIds(hostConfig: unknown): string[] {
  const agents = isRecord(hostConfig) && isRecord(hostConfig.agents) ? hostConfig.agents : undefined;
  const entries = agents && isRecord(agents.entries) ? agents.entries : undefined;
  return entries ? Object.keys(entries) : [];
}

function harnessNote(harness: Harness, mode: Mode): string | undefined {
  if (harness === "codex" && mode !== "off") {
    return `Runs on the Codex app-server, which already defers OpenClaw tool schemas and rejects toolsAllow; mode '${mode}' has no effect.`;
  }
  if (harness === "cli" && mode !== "off") return `Runs on a CLI backend; mode '${mode}' has no effect.`;
  if (harness === "unknown" && mode === "plugin") return "Runtime could not be determined; plugin mode is disabled to avoid failing Codex turns.";
  return undefined;
}

export function createHandlers(deps: ServiceDeps): Handlers {
  const now = deps.now ?? Date.now;
  const sessions = deps.sessions ?? new SessionStore();

  async function load(): Promise<Loaded> {
    const parsed = parseConfig(await deps.configStore.read());
    return parsed.ok
      ? { config: parsed.config, valid: true, issues: [] }
      : { config: disabledFallback(), valid: false, issues: parsed.issues };
  }

  async function loadValid(): Promise<ResolvedConfig> {
    const loaded = await load();
    if (!loaded.valid) {
      throw new LazyLoadingError("CONFIG_INVALID", `fix the plugin config first: ${formatIssues(loaded.issues)}`);
    }
    return loaded.config;
  }

  /** Best-effort: the emitter throws until the gateway service has started. */
  const emit: FeatureEventEmitter<LazyLoadingContract>["emit"] = (event, payload) => {
    try {
      deps.events?.emit(event, payload);
    } catch {
      // ignore
    }
  };

  function agentIds(config: ResolvedConfig, only?: string): string[] {
    if (only) return [only];
    return [...new Set([...Object.keys(config.agents), ...deps.inventory.agents(), ...hostAgentIds(deps.getHostConfig())])].sort();
  }

  return {
    // ---------------------------------------------------------------- queries
    async status({ agentId }) {
      const { config, valid, issues } = await load();
      const hostConfig = deps.getHostConfig();
      const agents = agentIds(config, agentId).map((id) => {
        const resolved = resolveAgentConfig(config, id);
        const agentEnabled = config.agents[id]?.enabled ?? true;
        const { harness } = resolveHarness(hostConfig, id);
        const effective = resolveEffectiveMode({ enabled: agentEnabled, pluginEnabled: config.enabled, mode: resolved.mode, harness });
        const catalog = buildCatalog({ agent: resolved, inventory: deps.inventory.get(id) });
        const notes: string[] = [];
        const harnessWarning = config.enabled && agentEnabled ? harnessNote(harness, resolved.mode) : undefined;
        if (harnessWarning) notes.push(harnessWarning);
        if (!valid) notes.push("The plugin config is invalid; lazy loading is off until it is fixed.");
        return {
          agentId: id,
          enabled: resolved.enabled,
          mode: resolved.mode,
          effectiveMode: effective.mode,
          effectiveReason: effective.reason,
          harness,
          hasOverride: resolved.hasOverride,
          counts: catalog.available
            ? { core: catalog.summary.core.count, deferred: catalog.summary.deferred.count, never: catalog.summary.never.count }
            : null,
          schema: catalog.available
            ? { totalBytes: catalog.summary.total.bytes, visibleBytes: catalog.summary.core.bytes, savingPct: catalog.summary.savingPct }
            : null,
          notes,
        };
      });
      return {
        contractVersion: CONTRACT_VERSION,
        pluginVersion: deps.pluginVersion,
        enabled: valid && config.enabled,
        defaultMode: config.defaultMode,
        configValid: valid,
        configIssues: issues.slice(0, 64),
        agents,
      };
    },

    async catalog({ agentId, sort, classes, inventory }) {
      const { config } = await load();
      if (inventory) deps.inventory.record(agentId, normalizeRawTools(inventory), "provided", now());
      const catalog: Catalog = buildCatalog({
        agent: resolveAgentConfig(config, agentId),
        inventory: deps.inventory.get(agentId),
        ...(sort ? { sort } : {}),
      });
      if (!classes || classes.length === 0) return catalog;
      const wanted = new Set<string>(classes);
      const entries: CatalogEntry[] = catalog.entries.filter((entry) => wanted.has(entry.class));
      return { ...catalog, entries };
    },

    async stats() {
      throw notImplemented("stats", "F-09");
    },

    async "session-state"({ sessionKey }) {
      const state = sessions.get(sessionKey);
      return { ...state, tools: state.tools.slice(0, 256), misses: state.misses.slice(-64) };
    },

    // ---------------------------------------------------------------- actions
    async "set-mode"({ mode, agentId }) {
      const config = await loadValid();
      const scope = agentId ? "agent" : "default";
      const previousMode = agentId ? resolveAgentConfig(config, agentId).mode : config.defaultMode;
      const notes: string[] = [];
      if (agentId) {
        const warning = harnessNote(resolveHarness(deps.getHostConfig(), agentId).harness, mode);
        if (warning) notes.push(warning);
      }
      if (mode === "native") {
        notes.push("native mode drives the global tools.toolSearch setting, which applies to every embedded-runner agent.");
      }
      const changed = previousMode !== mode;
      if (changed) {
        await deps.configStore.update((draft: RawConfig) => {
          if (agentId) applyAgentMode(draft, agentId, mode);
          else applyDefaultMode(draft, mode);
        });
        emit("config-changed", { change: "mode", scope, ...(agentId ? { agentId } : {}), at: now() });
      }
      return { changed, scope, ...(agentId ? { agentId } : {}), mode, previousMode, notes };
    },

    async "set-agent-enabled"({ agentId, enabled }) {
      const config = await loadValid();
      const previousEnabled = config.agents[agentId]?.enabled ?? true;
      const notes: string[] = [];
      if (enabled && !config.enabled) notes.push("The plugin is disabled globally (enabled: false); this agent stays off until it is re-enabled.");
      const changed = previousEnabled !== enabled;
      if (changed) {
        await deps.configStore.update((draft: RawConfig) => applyAgentEnabled(draft, agentId, enabled));
        emit("config-changed", { change: "enabled", scope: "agent", agentId, at: now() });
      }
      return { changed, agentId, enabled, previousEnabled, notes };
    },

    async "set-tool-class"({ agentId, tool, class: toolClass }) {
      if (tool === LAZY_LOAD_TOOLS_NAME) {
        throw new LazyLoadingError("INVALID_ARGUMENT", `${LAZY_LOAD_TOOLS_NAME} is the loader and is always visible; its class cannot be changed`);
      }
      const config = await loadValid();
      const agent = resolveAgentConfig(config, agentId);
      const previousClass = configuredClass(agent, tool);
      const changed = previousClass !== toolClass;
      if (changed) {
        await deps.configStore.update((draft: RawConfig) => applyToolClass(draft, agent, tool, toolClass));
        emit("config-changed", { change: "toolClass", scope: "agent", agentId, at: now() });
      }
      const after = resolveAgentConfig(await loadValid(), agentId);
      return { changed, agentId, tool, class: toolClass, previousClass, core: after.core, never: after.never };
    },

    async "reset-session"({ sessionKey, agentId }) {
      if (!sessionKey && !agentId) throw new LazyLoadingError("INVALID_ARGUMENT", "provide sessionKey or agentId; clearing all sessions is not supported");
      return { cleared: sessions.clear(sessionKey, agentId) };
    },

    async "run-benchmark"() {
      throw notImplemented("run-benchmark", "F-11");
    },
  };
}

/** Resolve a conservative per-turn allow list. Unknown/Codex/CLI harnesses never receive toolsAllow. */
export async function buildToolsAllow(deps: ServiceDeps, sessions: SessionStore, params: TurnRuntimeContext & { agentId?: string; sessionKey?: string; message?: string }): Promise<string[] | undefined> {
  if (!params.agentId || !params.sessionKey) return undefined;
  const parsed = parseConfig(await deps.configStore.read());
  if (!parsed.ok) return undefined;
  const config = parsed.config;
  const agent = resolveAgentConfig(config, params.agentId);
  let sessionEntry: unknown;
  try { sessionEntry = deps.getSessionEntry?.(params.agentId, params.sessionKey); }
  catch { return undefined; } // a failed binding lookup is not proof of an embedded turn
  const harness = resolveHarness(deps.getHostConfig(), params.agentId, { ...params, sessionEntry: params.sessionEntry ?? sessionEntry }).harness;
  if (resolveEffectiveMode({ enabled: agent.enabled, pluginEnabled: config.enabled, mode: agent.mode, harness }).mode !== "plugin") return undefined;
  const catalog = buildCatalog({ agent, inventory: deps.inventory.get(params.agentId) });
  const eligible = new Set(catalog.entries.filter((entry) => entry.class === "deferred").map((entry) => entry.name));
  sessions.retain(params.sessionKey, params.agentId, eligible);
  const state = sessions.advance(params.sessionKey, agent.stickyTurns, params.agentId);
  const predicted = agent.predict && config.predictor.enabled
    ? predictTools({ message: params.message ?? "", entries: catalog.entries, maxPredicted: config.predictor.maxPredicted, minScore: config.predictor.minScore, never: agent.never, core: agent.core })
    : [];
  if (predicted.length) sessions.activate(params.sessionKey, params.agentId, predicted.map((tool) => tool.name), agent.stickyTurns, (deps.now ?? Date.now)(), "predicted");
  // Configured core names are a policy restriction, not an invented inventory.
  // The host intersects them with its approved surface, including on cold start.
  const allow = new Set([...agent.core.filter((name) => !agent.never.includes(name)), ...catalog.entries.filter((entry) => entry.class === "core").map((entry) => entry.name), ...state.tools.map((tool) => tool.name), ...predicted.map((tool) => tool.name), LAZY_LOAD_TOOLS_NAME]);
  return [...allow].sort();
}

export async function loadTools(deps: ServiceDeps, sessions: SessionStore, params: { agentId?: string; sessionKey?: string; query?: string; names?: string[] }) {
  if (!params.agentId || !params.sessionKey) throw new LazyLoadingError("INVALID_ARGUMENT", "agentId and sessionKey are required");
  const parsed = parseConfig(await deps.configStore.read());
  if (!parsed.ok) throw new LazyLoadingError("CONFIG_INVALID", `fix the plugin config first: ${formatIssues(parsed.issues)}`);
  const agent = resolveAgentConfig(parsed.config, params.agentId);
  const catalog = buildCatalog({ agent, inventory: deps.inventory.get(params.agentId) });
  if (!catalog.available) throw new LazyLoadingError("INVALID_ARGUMENT", "tool inventory unavailable: this host exposes only post-filter llm_input tools, not a pre-filter catalog. Hidden tools cannot be discovered on cold start; use native mode or a trusted host-provided inventory.");
  const deferred = catalog.entries.filter((entry) => entry.class === "deferred");
  let selected = params.names?.length ? deferred.filter((entry) => params.names!.includes(entry.name)) : [];
  if (!params.names?.length && params.query) {
    const terms = params.query.toLowerCase().match(/[a-z0-9_]+/gu) ?? [];
    selected = deferred.map((entry) => ({ entry, score: terms.filter((term) => `${entry.name} ${entry.description} ${entry.signature}`.toLowerCase().includes(term)).length }))
      .filter((item) => item.score > 0).sort((a, b) => b.score - a.score || a.entry.name.localeCompare(b.entry.name)).slice(0, 8).map(({ entry }) => entry);
  }
  const names = [...new Set(selected.map((entry) => entry.name))].slice(0, 16);
  if (!names.length) return { text: "No eligible tools matched. Only deferred catalog tools can be loaded; never/core tools cannot be changed. The catalog contains only previously observed or explicitly supplied tools; a cold, already-filtered run cannot discover hidden tool schemas.", tools: [] };
  sessions.activate(params.sessionKey, params.agentId, names, agent.stickyTurns, (deps.now ?? Date.now)());
  try { deps.events?.emit("tools-loaded", { sessionKey: params.sessionKey, agentId: params.agentId, tools: names, origin: "loaded", at: (deps.now ?? Date.now)() }); } catch { /* best effort */ }
  return { text: `Activated for the next turn (OpenClaw computes toolsAllow once per attempt; these cannot be called in this turn).`, tools: selected.map((entry) => ({ name: entry.name, signature: entry.signature, description: entry.description })) };
}
