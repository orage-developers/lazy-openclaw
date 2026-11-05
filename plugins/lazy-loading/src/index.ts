import { defineFeaturePlugin } from "openclaw/plugin-sdk/feature-plugin";
import { InventoryStore } from "./catalog/inventory.js";
import { pluginConfigSchema } from "./config/plugin-schema.js";
import { contract } from "./contract.js";
import { composeFeatureEntry } from "./entry.js";
import { buildToolsAllow, createHandlers, loadTools } from "./service.js";
import { HostConfigStore } from "./state/config-store.js";
import { SessionStore } from "./state/session-store.js";
import { bindCliHandlers } from "./cli/handler-bridge.js";
import { LAZY_LOAD_TOOLS_DESCRIPTION, LAZY_LOAD_TOOLS_NAME, LazyLoadToolsParams } from "./tools/lazy-load-tools.js";
import { PLUGIN_VERSION } from "./version.js";

/** Tools each agent last exposed to the model, observed through `llm_input` (see catalog/inventory.ts). */
const inventory = new InventoryStore();
const sessions = new SessionStore();
let serviceDeps: Parameters<typeof loadTools>[0] | undefined;

const feature = defineFeaturePlugin({
  contract,
  name: "Lazy Loading",
  description: "Load agent tools on demand to cut time-to-first-token.",
  setup(api, events) {
    // Conversation hooks need `plugins.entries.lazy-loading.hooks.allowConversationAccess: true`.
    api.on("llm_input", (event, ctx) => {
      if (ctx.agentId) inventory.record(ctx.agentId, event.tools, "observed-run", Date.now());
    });
    serviceDeps = {
      pluginVersion: PLUGIN_VERSION,
      configStore: new HostConfigStore(api.runtime.config),
      inventory,
      sessions,
      getHostConfig: () => api.runtime.config.current(),
      events,
    };
    const handlers = createHandlers(serviceDeps);
    bindCliHandlers(api.runtime.config, handlers);
    api.on("before_prompt_build", async (event, ctx) => {
      if (!serviceDeps) return;
      return buildToolsAllow(serviceDeps, sessions, { agentId: ctx.agentId, sessionKey: ctx.sessionKey, message: event.currentUserMessage ?? event.prompt })
        .then((toolsAllow) => toolsAllow ? { toolsAllow } : undefined);
    });
    api.on("session_end", (_event, ctx) => {
      if (ctx.sessionKey) sessions.clear(ctx.sessionKey);
    });
    return handlers;
  },
});

export default composeFeatureEntry(feature, {
  configSchema: pluginConfigSchema,
  register(api) {
    // A tool factory receives the runtime's session identity without adding it to model input.
    api.registerTool((toolContext) => ({
      name: LAZY_LOAD_TOOLS_NAME,
      label: "Load tools",
      description: LAZY_LOAD_TOOLS_DESCRIPTION,
      parameters: LazyLoadToolsParams,
      catalogMode: "direct-only",
      async execute(_toolCallId, params: LazyLoadToolsParams) {
        if (!serviceDeps) return { content: [{ type: "text" as const, text: "Lazy loading is not ready." }], details: { activated: [] } };
        try {
          const result = await loadTools(serviceDeps, sessions, { ...params, agentId: toolContext.agentId, sessionKey: toolContext.sessionKey });
          return { content: [{ type: "text" as const, text: result.text }], details: { activated: result.tools } };
        } catch (error) {
          return { content: [{ type: "text" as const, text: error instanceof Error ? error.message : String(error) }], details: { activated: [] } };
        }
      },
    }));
  },
});
