import type { Mode } from "./config/schema.js";

/**
 * Which agent runtime executes an agent's turns. A restrictive `toolsAllow` makes the Codex app-server runtime
 * fail the turn (docs/baseline.md, section 1.4), so the plugin resolves the
 * runtime from configuration and stays conservative when unsure.
 */
export const HARNESSES = ["embedded", "codex", "copilot", "cli", "unknown"] as const;
export type Harness = (typeof HARNESSES)[number];

export const HARNESS_SOURCES = ["runtime-context", "session-entry", "model-policy", "provider-policy", "auto-codex", "default", "no-model"] as const;
export type HarnessSource = (typeof HARNESS_SOURCES)[number];

export type HarnessResolution = {
  harness: Harness;
  source: HarnessSource;
  /** Model ref (`provider/model`) the decision was based on, when known. */
  modelRef?: string;
};

type Json = Record<string, unknown>;
const isRecord = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);

/** Trusted host facts only, never prompt text or model-supplied tool arguments. */
export type TurnRuntimeContext = {
  modelProviderId?: string;
  modelId?: string;
  agentHarnessId?: string;
  sessionEntry?: unknown;
};

function modelRefOf(model: unknown): string | undefined {
  const raw = typeof model === "string" ? model : isRecord(model) && typeof model.primary === "string" ? model.primary : undefined;
  const ref = raw?.split("@")[0]?.trim(); // strip the `@auth-profile` suffix
  return ref && ref.includes("/") ? ref : undefined;
}

function runtimeIdOf(policy: unknown): string | undefined {
  if (!isRecord(policy) || !isRecord(policy.agentRuntime)) return undefined;
  const id = policy.agentRuntime.id;
  return typeof id === "string" && id.length > 0 ? id : undefined;
}

function harnessFromRuntimeId(id: string): Harness | undefined {
  switch (id) {
    case "auto":
      return undefined; // same as unset
    case "openclaw":
      return "embedded";
    case "codex":
      return "codex";
    case "copilot":
      return "copilot";
    case "claude-cli":
      return "cli";
    default:
      return "unknown";
  }
}

/** Model-scoped policy lookup: exact ref first, then the provider wildcard. */
function modelPolicyRuntime(models: unknown, ref: string): string | undefined {
  if (!isRecord(models)) return undefined;
  const provider = ref.split("/")[0] ?? "";
  return runtimeIdOf(models[ref]) ?? runtimeIdOf(models[`${provider}/*`]);
}

/**
 * Resolve the runtime of one agent from the OpenClaw config, following the
 * documented order: agent model policy, defaults model policy, provider policy,
 * then `auto` (Codex claims `openai/*` when the codex plugin is not disabled;
 * everything else runs on the embedded runner).
 */
export function resolveHarness(hostConfig: unknown, agentId: string, turn: TurnRuntimeContext = {}): HarnessResolution {
  const config = isRecord(hostConfig) ? hostConfig : {};
  const agents = isRecord(config.agents) ? config.agents : {};
  const entries = isRecord(agents.entries) ? agents.entries : {};
  const entry = isRecord(entries[agentId]) ? (entries[agentId] as Json) : {};
  const defaults = isRecord(agents.defaults) ? agents.defaults : {};

  const session = isRecord(turn.sessionEntry) ? turn.sessionEntry : {};
  // Runtime/session bindings outrank model policy, including an openclaw pin.
  for (const [id, source] of [[turn.agentHarnessId, "runtime-context"], [session.agentHarnessId ?? session.agentRuntimeOverride, "session-entry"]] as const) {
    if (typeof id === "string") {
      const harness = harnessFromRuntimeId(id);
      if (harness) return { harness, source };
    }
  }
  const contextRef = turn.modelProviderId && turn.modelId ? modelRefOf(`${turn.modelProviderId}/${turn.modelId}`) : undefined;
  // A partial effective route must not silently fall back to the ambient model.
  if ((turn.modelProviderId || turn.modelId) && !contextRef) return { harness: "unknown", source: "no-model" };
  const sessionProvider = session.providerOverride ?? session.modelProvider;
  const sessionModel = session.modelOverride ?? session.model;
  const sessionRef = typeof sessionProvider === "string" && typeof sessionModel === "string" ? modelRefOf(`${sessionProvider}/${sessionModel}`) : undefined;
  const ref = contextRef ?? sessionRef ?? modelRefOf(entry.model) ?? modelRefOf(defaults.model);
  if (!ref) return { harness: "unknown", source: "no-model" };
  const provider = ref.split("/")[0] ?? "";

  const modelRuntime = modelPolicyRuntime(entry.models, ref) ?? modelPolicyRuntime(defaults.models, ref);
  if (modelRuntime) {
    const harness = harnessFromRuntimeId(modelRuntime);
    if (harness) return { harness, source: "model-policy", modelRef: ref };
  }

  const providers = isRecord(config.models) && isRecord(config.models.providers) ? config.models.providers : {};
  const providerRuntime = runtimeIdOf(providers[provider]);
  if (providerRuntime) {
    const harness = harnessFromRuntimeId(providerRuntime);
    if (harness) return { harness, source: "provider-policy", modelRef: ref };
  }

  if (provider === "openai" && !codexPluginDisabled(config)) {
    return { harness: "codex", source: "auto-codex", modelRef: ref };
  }
  return { harness: "embedded", source: "default", modelRef: ref };
}

function codexPluginDisabled(config: Json): boolean {
  const plugins = isRecord(config.plugins) ? config.plugins : {};
  const entries = isRecord(plugins.entries) ? plugins.entries : {};
  const codex = entries.codex;
  if (isRecord(codex) && codex.enabled === false) return true;
  if (plugins.enabled === false) return true;
  const deny = Array.isArray(plugins.deny) ? plugins.deny : [];
  return deny.includes("codex");
}

export const EFFECTIVE_REASONS = [
  "configured",
  "plugin-disabled",
  "agent-disabled",
  "codex-native-deferral",
  "cli-backend",
  "harness-unknown",
] as const;
export type EffectiveReason = (typeof EFFECTIVE_REASONS)[number];

/**
 * The mode that actually applies to an agent, which can differ from the
 * configured one: Codex and CLI backends cannot honour `plugin` or `native`,
 * and `plugin` mode is only safe when the runtime is known to accept `toolsAllow`.
 */
export function resolveEffectiveMode(params: {
  enabled: boolean;
  pluginEnabled: boolean;
  mode: Mode;
  harness: Harness;
}): { mode: Mode; reason: EffectiveReason } {
  if (!params.pluginEnabled) return { mode: "off", reason: "plugin-disabled" };
  if (!params.enabled) return { mode: "off", reason: "agent-disabled" };
  if (params.mode === "off") return { mode: "off", reason: "configured" };
  if (params.harness === "codex") return { mode: "off", reason: "codex-native-deferral" };
  if (params.harness === "cli") return { mode: "off", reason: "cli-backend" };
  if (params.harness === "unknown" && params.mode === "plugin") return { mode: "off", reason: "harness-unknown" };
  return { mode: params.mode, reason: "configured" };
}
