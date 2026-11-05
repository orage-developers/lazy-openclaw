import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SessionStore } from "../src/state/session-store.js";

describe("session store", () => {
  it("keeps loaded tools sticky for the configured number of turns and expires them", () => {
    const store = new SessionStore();
    store.activate("agent:chat", "agent", ["browser"], 2, 10);
    assert.deepEqual(store.advance("agent:chat", 2).tools.map((tool) => [tool.name, tool.turnsRemaining]), [["browser", 2]]);
    assert.deepEqual(store.advance("agent:chat", 2).tools.map((tool) => [tool.name, tool.turnsRemaining]), [["browser", 1]]);
    assert.deepEqual(store.advance("agent:chat", 2).tools, []);
  });

  it("resets by session or agent without affecting other agents", () => {
    const store = new SessionStore();
    store.activate("a:one", "a", ["read"], 3, 1);
    store.activate("b:one", "b", ["write"], 3, 1);
    assert.equal(store.clear(undefined, "a"), 1);
    assert.deepEqual(store.get("b:one").tools.map((tool) => tool.name), ["write"]);
    assert.equal(store.clear("b:one"), 1);
  });

  it("retains origin metadata for predicted tools", () => {
    const store = new SessionStore();
    store.activate("x", "agent", ["browser"], 4, 5, "predicted");
    assert.equal(store.get("x").tools[0]?.origin, "predicted");
  });
});
