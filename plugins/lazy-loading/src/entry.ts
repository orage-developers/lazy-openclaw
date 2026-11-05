import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { toolPluginMetadataSymbol } from "openclaw/plugin-sdk/tool-plugin";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { registerLazyLoadingCli } from "./cli/register.js";
import { LAZY_LOAD_TOOLS_NAME, lazyLoadToolsMetadata } from "./tools/lazy-load-tools.js";

type PluginEntry = ReturnType<typeof definePluginEntry>;
type ConfigSchema = NonNullable<Parameters<typeof definePluginEntry>[0]["configSchema"]>;

type FeatureEntry = {
  id: string;
  name: string;
  description: string;
  register: (api: OpenClawPluginApi) => void;
};

type ToolPluginMetadata = {
  tools?: unknown[];
  configSchema?: unknown;
  [key: string]: unknown;
};

/**
 * `defineFeaturePlugin` has no hook for a custom config schema or for tools that
 * are not feature operations, and `openclaw plugins build` derives the manifest
 * (`configSchema`, `contracts.tools`) from the metadata it attaches. This helper
 * re-wraps the feature entry so both are declared once, in code.
 */
export function composeFeatureEntry(
  feature: FeatureEntry,
  extra: {
    configSchema: ConfigSchema & { jsonSchema?: unknown };
    register: (api: OpenClawPluginApi) => void;
  },
): PluginEntry {
  const entry = definePluginEntry({
    id: feature.id,
    name: feature.name,
    description: feature.description,
    configSchema: extra.configSchema,
    register(api: OpenClawPluginApi) {
      feature.register(api);
      extra.register(api);
      // Older host test doubles may omit CLI registration; supported OpenClaw
      // versions always expose it. Keep feature setup independently testable.
      if (typeof api.registerCli === "function") registerLazyLoadingCli(api);
    },
  });
  const baseMetadata = (feature as unknown as Record<symbol, ToolPluginMetadata | undefined>)[
    toolPluginMetadataSymbol
  ];
  if (baseMetadata) {
    Object.defineProperty(entry, toolPluginMetadataSymbol, {
      value: {
        ...baseMetadata,
        configSchema: extra.configSchema.jsonSchema ?? baseMetadata.configSchema,
        tools: [...(baseMetadata.tools ?? []), lazyLoadToolsMetadata],
      },
      enumerable: false,
    });
  }
  return entry;
}

export { LAZY_LOAD_TOOLS_NAME };
