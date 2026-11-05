import { defineFeaturePlugin } from "openclaw/plugin-sdk/feature-plugin";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk/plugin-entry";
import { contract } from "./contract.js";
import { composeFeatureEntry } from "./entry.js";
import { LAZY_LOAD_TOOLS_DESCRIPTION, LAZY_LOAD_TOOLS_NAME, LazyLoadToolsParams } from "./tools/lazy-load-tools.js";

const feature = defineFeaturePlugin({
  contract,
  name: "Lazy Loading",
  description: "Load agent tools on demand to cut time-to-first-token.",
  setup() {
    return {
      status: () => ({ ok: true, version: "0.1.0" }),
    };
  },
});

export default composeFeatureEntry(feature, {
  configSchema: emptyPluginConfigSchema,
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
