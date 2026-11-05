import { Type, type Static } from "typebox";

export const LAZY_LOAD_TOOLS_NAME = "lazy_load_tools";

/** Input of the model-facing `lazy_load_tools` tool (see PLAN F-05). */
export const LazyLoadToolsParams = Type.Object(
  {
    query: Type.Optional(
      Type.String({
        minLength: 1,
        maxLength: 256,
        description: "Short English description of the capability needed, for example 'create a GitHub issue'.",
      }),
    ),
    names: Type.Optional(
      Type.Array(Type.String({ minLength: 1, maxLength: 128 }), {
        maxItems: 16,
        description: "Exact tool names to activate.",
      }),
    ),
  },
  { additionalProperties: false },
);
export type LazyLoadToolsParams = Static<typeof LazyLoadToolsParams>;

export const LAZY_LOAD_TOOLS_DESCRIPTION =
  "Activate additional tools on demand. Pass a short English query or exact tool names; activated tools become callable on the next turn.";

/** Metadata mirrored into the manifest (`contracts.tools`) by `openclaw plugins build`. */
export const lazyLoadToolsMetadata = {
  name: LAZY_LOAD_TOOLS_NAME,
  label: "Load tools",
  description: LAZY_LOAD_TOOLS_DESCRIPTION,
  parameters: LazyLoadToolsParams,
} as const;
