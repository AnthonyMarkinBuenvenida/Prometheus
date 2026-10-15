import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";

// Minimal in-memory localStorage for node.
const store = new Map<string, string>();
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
  setItem: (k: string, v: string) => void store.set(k, String(v)),
  removeItem: (k: string) => void store.delete(k),
};
const { load, save } = await import("./storage.ts");

beforeEach(() => store.clear());

test("data saved under the old HiveMind prefix is carried over on first read", () => {
  store.set("hivemind.v1.conversations", JSON.stringify([{ id: "c1", title: "Old chat" }]));
  assert.deepEqual(load("conversations", []), [{ id: "c1", title: "Old chat" }]);
  assert.equal(store.get("prometheus.v1.conversations"), JSON.stringify([{ id: "c1", title: "Old chat" }]), "copied to the new key");
  assert.ok(store.has("hivemind.v1.conversations"), "the old copy is left untouched");
});

test("the new prefix wins once it exists", () => {
  store.set("hivemind.v1.settings", JSON.stringify({ theme: "light" }));
  store.set("prometheus.v1.settings", JSON.stringify({ theme: "black" }));
  assert.deepEqual(load("settings", {}), { theme: "black" });
});

test("saves go to the new prefix only", () => {
  save("settings", { theme: "dark" });
  assert.equal(store.get("prometheus.v1.settings"), JSON.stringify({ theme: "dark" }));
  assert.equal(store.has("hivemind.v1.settings"), false);
});

test("nothing saved anywhere → the fallback", () => {
  assert.deepEqual(load("conversations", []), []);
});
