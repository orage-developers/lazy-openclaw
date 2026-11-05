import { buildJsonPluginConfigSchema } from "openclaw/plugin-sdk/plugin-entry";
import { ConfigSchema } from "./schema.js";
import { formatIssues, parseConfig } from "./validate.js";

type JsonSchemaArg = Parameters<typeof buildJsonPluginConfigSchema>[0];

/**
 * Config schema handed to the plugin host. `jsonSchema` becomes the manifest
 * `configSchema` (validated by `openclaw plugins validate` and config writes);
 * `safeParse` adds the semantic checks JSON Schema cannot express, with
 * readable messages.
 */
export const pluginConfigSchema = buildJsonPluginConfigSchema(ConfigSchema as unknown as JsonSchemaArg, {
  cacheKey: "plugin-config-schema:lazy-loading",
  safeParse(value: unknown) {
    const result = parseConfig(value);
    if (result.ok) return { success: true, data: value };
    return {
      success: false,
      error: {
        issues: result.issues.map((issue) => ({
          path: issue.path ? issue.path.split(".") : [],
          message: issue.message,
        })),
      },
    };
  },
});

export { formatIssues };
