/**
 * Compact descriptors: a one-sentence description and a TypeScript-style input
 * signature rendered from a JSON Schema, bounded so they are safe to put in prompts.
 */

type Json = Record<string, unknown>;

const isRecord = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);

export const MAX_DESCRIPTION_CHARS = 140;
export const MAX_SIGNATURE_CHARS = 240;

/** First sentence of a description, whitespace collapsed, capped at `max` characters. */
export function shortDescription(description: string | undefined, max = MAX_DESCRIPTION_CHARS): string {
  const text = (description ?? "").replace(/\s+/gu, " ").trim();
  if (!text) return "";
  const sentenceEnd = text.search(/[.!?](\s|$)/u);
  const first = sentenceEnd >= 0 ? text.slice(0, sentenceEnd + 1) : text;
  return truncate(first, max);
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

function renderType(schema: unknown, depth: number): string {
  if (!isRecord(schema)) return "unknown";
  if (Array.isArray(schema.enum)) {
    return schema.enum.map((value) => JSON.stringify(value)).join(" | ") || "never";
  }
  if ("const" in schema) return JSON.stringify(schema.const);
  for (const key of ["anyOf", "oneOf"] as const) {
    const variants = schema[key];
    if (Array.isArray(variants) && variants.length > 0) {
      return [...new Set(variants.map((variant) => renderType(variant, depth)))].join(" | ");
    }
  }
  const type = schema.type;
  if (Array.isArray(type)) {
    return [...new Set(type.map((entry) => renderType({ ...schema, type: entry }, depth)))].join(" | ");
  }
  switch (type) {
    case "string":
      return "string";
    case "number":
    case "integer":
      return "number";
    case "boolean":
      return "boolean";
    case "null":
      return "null";
    case "array": {
      const item = renderType(schema.items, depth + 1);
      return /[ |]/u.test(item) ? `Array<${item}>` : `${item}[]`;
    }
    case "object":
      return renderObject(schema, depth);
    default:
      return isRecord(schema.properties) ? renderObject(schema, depth) : "unknown";
  }
}

function renderObject(schema: Json, depth: number): string {
  const properties = isRecord(schema.properties) ? schema.properties : undefined;
  if (!properties || Object.keys(properties).length === 0) return depth === 0 ? "{}" : "object";
  if (depth >= 2) return "object";
  const required = new Set(Array.isArray(schema.required) ? schema.required.filter((entry): entry is string => typeof entry === "string") : []);
  const fields = Object.keys(properties)
    .sort()
    .map((name) => `${name}${required.has(name) ? "" : "?"}: ${renderType(properties[name], depth + 1)}`);
  return `{ ${fields.join("; ")} }`;
}

/** TypeScript-style signature of the tool input, e.g. `{ id: string; mode?: "a" | "b" }`. */
export function renderSignature(schema: unknown, max = MAX_SIGNATURE_CHARS): string {
  return truncate(renderType(schema, 0), max);
}
