import Type, { type Static } from "typebox";
import { TOOL_CLASSES } from "../config/schema.js";

/**
 * Wire types of the per-agent tool catalog. Shared by the pure catalog builder and
 * the `catalog` operation of the feature contract, so both stay in sync.
 */

export const ToolClassEnum = Type.Enum([...TOOL_CLASSES], { description: "Role of the tool for this agent." });

/** Why a tool received its class. */
export const CLASS_REASONS = ["config-never", "config-core", "direct-only", "loader", "default"] as const;
export type ClassReason = (typeof CLASS_REASONS)[number];

export const TOOL_SOURCES = ["core", "plugin", "mcp", "client", "channel", "unknown"] as const;
export type ToolSource = (typeof TOOL_SOURCES)[number];

export const CatalogEntrySchema = Type.Object(
  {
    name: Type.String({ minLength: 1, maxLength: 128 }),
    class: ToolClassEnum,
    reason: Type.Enum([...CLASS_REASONS]),
    source: Type.Enum([...TOOL_SOURCES]),
    pluginId: Type.Optional(Type.String({ maxLength: 128 })),
    /** Host marks the tool as always model-visible (`catalogMode: "direct-only"`). */
    directOnly: Type.Boolean(),
    /** First sentence of the description, at most 140 characters. */
    description: Type.String({ maxLength: 160 }),
    /** Compact TypeScript-style input signature, at most 240 characters. */
    signature: Type.String({ maxLength: 260 }),
    /** UTF-8 bytes of the tool spec (name + description + parameters) as sent to the model. */
    schemaBytes: Type.Integer({ minimum: 0 }),
    /** Approximate prompt tokens (bytes / 4, rounded up). */
    schemaTokens: Type.Integer({ minimum: 0 }),
  },
  { additionalProperties: false },
);
export type CatalogEntry = Static<typeof CatalogEntrySchema>;

export const ClassTotalsSchema = Type.Object(
  {
    count: Type.Integer({ minimum: 0 }),
    bytes: Type.Integer({ minimum: 0 }),
    tokens: Type.Integer({ minimum: 0 }),
  },
  { additionalProperties: false },
);
export type ClassTotals = Static<typeof ClassTotalsSchema>;

export const CatalogSummarySchema = Type.Object(
  {
    total: ClassTotalsSchema,
    core: ClassTotalsSchema,
    deferred: ClassTotalsSchema,
    never: ClassTotalsSchema,
    /** Share of the total schema bytes that lazy loading keeps out of the initial prompt (0-100). */
    savingPct: Type.Integer({ minimum: 0, maximum: 100 }),
  },
  { additionalProperties: false },
);
export type CatalogSummary = Static<typeof CatalogSummarySchema>;

export const INVENTORY_ORIGINS = ["observed-run", "gateway-catalog", "provided"] as const;
export type InventoryOrigin = (typeof INVENTORY_ORIGINS)[number];

export const CatalogSchema = Type.Object(
  {
    agentId: Type.String({ minLength: 1, maxLength: 64 }),
    /** False when no tool inventory is known for the agent yet; `entries` is then empty. */
    available: Type.Boolean(),
    origin: Type.Optional(Type.Enum([...INVENTORY_ORIGINS])),
    /** Epoch milliseconds when the inventory was captured. */
    capturedAt: Type.Optional(Type.Integer({ minimum: 0 })),
    entries: Type.Array(CatalogEntrySchema, { maxItems: 1024 }),
    summary: CatalogSummarySchema,
    /** Configured core/never names that are not present in the inventory. */
    missing: Type.Object(
      {
        core: Type.Array(Type.String(), { maxItems: 256 }),
        never: Type.Array(Type.String(), { maxItems: 256 }),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);
export type Catalog = Static<typeof CatalogSchema>;

export const CATALOG_SORTS = ["class", "name", "size"] as const;
export type CatalogSort = (typeof CATALOG_SORTS)[number];
