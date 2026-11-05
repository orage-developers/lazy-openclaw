import { Type } from "typebox";
import { defineFeatureContract } from "openclaw/plugin-sdk/feature-contract";

/** Scaffold contract. Replaced by the full feature contract in F-10. */
export const contract = defineFeatureContract({
  pluginId: "lazy-loading",
  operations: {
    status: {
      kind: "query",
      description: "Report the lazy-loading plugin status.",
      input: Type.Object({}, { additionalProperties: false }),
      output: Type.Object({ ok: Type.Boolean(), version: Type.String() }, { additionalProperties: false }),
    },
  },
  events: {},
});
