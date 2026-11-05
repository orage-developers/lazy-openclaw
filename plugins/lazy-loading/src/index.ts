import { defineFeaturePlugin } from "openclaw/plugin-sdk/feature-plugin";
import { InventoryStore } from "./catalog/inventory.js";
import { pluginConfigSchema } from "./config/plugin-schema.js";
import { contract } from "./contract.js";
import { composeFeatureEntry } from "./entry.js";
import { createHandlers } from "./service.js";
import { HostConfigStore } from "./state/config-store.js";
import { LAZY_LOAD_TOOLS_DESCRIPTION, LAZY_LOAD_TOOLS_NAME, LazyLoadToolsParams } from "./tools/lazy-load-tools.js";
import { PLUGIN_VERSION } from "./version.js";

/** Tools each agent last exposed to the model, observed through `llm_input` (see catalog/inventory.ts). */
const inventory = new InventoryStore();

const feature = defineFeaturePlugin({
  contract,
  name: "Lazy Loading",
  description: "Load agent tools on demand to cut time-to-first-token.",
  setup(api, events) {
    // Conversation hooks need `plugins.entries.lazy-loading.hooks.allowConversationAccess: true`.
    api.on("llm_input", (event, ctx) => {
      if (ctx.agentId) inventory.record(ctx.agentId, event.tools, "observed-run", Date.now());
    });
    return createHandlers({
      pluginVersion: PLUGIN_VERSION,
      configStore: new HostConfigStore(api.runtime.config),
      inventory,
      getHostConfig: () => api.runtime.config.current(),
      events,
    });
  },
});

export default composeFeatureEntry(feature, {
  configSchema: pluginConfigSchema,
  register(api) {
    // Scaffold stub; the real implementation lands with F-05.
    api.registerTool({
      name: LAZY_LOAD_TOOLS_NAME,
      label: "Load tools",
      description: LAZY_LOAD_TOOLS_DESCRIPTION,
      parameters: LazyLoadToolsParams,
      catalogMode: "direct-only",
      async execute() {
        return {
          content: [{ type: "text" as const, text: "lazy_load_tools is not implemented yet." }],
          details: { implemented: false },
        };
      },
    });
  },
});
