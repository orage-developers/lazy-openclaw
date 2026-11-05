import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { toolPluginMetadataSymbol } from "openclaw/plugin-sdk/tool-plugin";
import entry from "../src/index.js";

const manifest = JSON.parse(
  readFileSync(new URL("../../openclaw.plugin.json", import.meta.url), "utf8"),
) as { id: string; contracts?: { tools?: string[] }; activation?: { onStartup?: boolean } };

describe("plugin entry", () => {
  it("declares the plugin id used by the manifest", () => {
    assert.equal(entry.id, "lazy-loading");
    assert.equal(manifest.id, entry.id);
  });

  it("declares lazy_load_tools in the manifest and in the entry metadata", () => {
    const metadata = (entry as unknown as Record<symbol, { tools: { name: string }[] }>)[toolPluginMetadataSymbol];
    assert.ok(metadata, "entry must carry tool plugin metadata for `openclaw plugins build`");
    assert.deepEqual(
      metadata.tools.map((tool) => tool.name),
      ["lazy_load_tools"],
    );
    assert.deepEqual(manifest.contracts?.tools, ["lazy_load_tools"]);
  });

  it("starts on gateway startup", () => {
    assert.equal(manifest.activation?.onStartup, true);
  });
});
