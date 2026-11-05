import test from "node:test";
import assert from "node:assert/strict";
import { predictTools } from "../src/predictor/index.js";
import type { CatalogEntry } from "../src/catalog/schema.js";

function entry(name: string, description: string, signature = "(query: string)"): CatalogEntry {
  return { name, description, signature, class: "deferred", reason: "default", source: "plugin", directOnly: false, schemaBytes: 1, schemaTokens: 1 };
}
const entries = [
  entry("github_create_issue", "Create an issue in a GitHub repository"),
  entry("mail_send", "Send an email message", "(to: string, subject: string)"),
  entry("calendar_create_event", "Create a calendar event or meeting"),
  entry("filesystem_read", "Read a file from disk", "(file: string)"),
  entry("web_search", "Search the web for information"),
];

test("predicts useful tools from Spanish and English current prompts", () => {
  assert.equal(predictTools({ message: "Crea un issue en GitHub", entries, maxPredicted: 3, minScore: 0.1 })[0]?.name, "github_create_issue");
  assert.equal(predictTools({ message: "please send an email", entries, maxPredicted: 3, minScore: 0.1 })[0]?.name, "mail_send");
  assert.equal(predictTools({ message: "crear una reunión en el calendario", entries, maxPredicted: 3, minScore: 0.1 })[0]?.name, "calendar_create_event");
});

test("deterministic, sorted, bounded scores and max count", () => {
  const options = { message: "search the web", entries, maxPredicted: 2, minScore: 0 };
  const first = predictTools(options);
  assert.deepEqual(first, predictTools(options));
  assert.ok(first.length <= 2);
  assert.ok(first.length >= 1);
  assert.ok(first.length < 2 || first[0]!.score >= first[1]!.score);
  assert.ok(first.every(({ score }) => score >= 0 && score <= 1));
});

test("empty input, thresholds, zero/negative limits and never/core exclusions", () => {
  assert.deepEqual(predictTools({ message: "   ", entries, maxPredicted: 4, minScore: 0 }), []);
  assert.deepEqual(predictTools({ message: "email", entries, maxPredicted: 0, minScore: 0 }), []);
  assert.deepEqual(predictTools({ message: "email", entries, maxPredicted: -1, minScore: 0 }), []);
  assert.deepEqual(predictTools({ message: "email", entries, maxPredicted: 2, minScore: 1 }), []);
  assert.deepEqual(predictTools({ message: "email", entries, maxPredicted: 4, minScore: 0, never: ["mail_send"] }), []);
  assert.deepEqual(predictTools({ message: "email", entries, maxPredicted: 4, minScore: 0, core: ["mail_send"] }), []);
  assert.deepEqual(predictTools({ message: "email", entries: [], maxPredicted: 4, minScore: 0 }), []);
});

test("intent fixture set coverage: at least 80% of expected tools are top-five", () => {
  const fixtures = [
    ["Crea un issue en GitHub", "github_create_issue"], ["Send an email to Alex", "mail_send"],
    ["Agendar una reunión en calendario", "calendar_create_event"], ["Read this file", "filesystem_read"],
    ["Busca información en la web", "web_search"], ["create calendar event", "calendar_create_event"],
    ["buscar en la web", "web_search"], ["leer archivo", "filesystem_read"],
    ["email please", "mail_send"], ["GitHub issue", "github_create_issue"],
  ] as const;
  const hits = fixtures.filter(([message, expected]) => predictTools({ message, entries, maxPredicted: 5, minScore: 0.05 }).some((item) => item.name === expected)).length;
  assert.ok(hits / fixtures.length >= 0.8, `${hits}/${fixtures.length}`);
});
