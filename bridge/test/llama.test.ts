import assert from "node:assert/strict";
import { test } from "node:test";
import { ensureRouterModel, routerModelId } from "../src/llama.ts";
import type { LlamaRouter, RouterModel } from "../src/llama.ts";

test("router model ids: prefix, bare, thinking suffix, ids with colons", () => {
  const ids = ["qwen3-8b", "gemma:4b"];
  assert.equal(routerModelId("llama.cpp/qwen3-8b", ids), "qwen3-8b");
  assert.equal(routerModelId("qwen3-8b:low", ids), "qwen3-8b");
  assert.equal(routerModelId("llama.cpp/gemma:4b", ids), "gemma:4b");
  assert.equal(routerModelId("anthropic/claude", ids), undefined);
});

function fakeRouter(models: RouterModel[], loadsAfter = 2): LlamaRouter & { loads: string[] } {
  const loads: string[] = [];
  let polls = 0;
  return {
    url: "http://fake",
    loads,
    async list() {
      if (loads.length && ++polls >= loadsAfter) for (const m of models) if (loads.includes(m.id)) m.status = "loaded";
      return models.map((m) => ({ ...m }));
    },
    async load(id) {
      loads.push(id);
      const m = models.find((x) => x.id === id);
      if (m) m.status = "loading";
    },
  };
}

test("loads an unloaded model and waits for it", async () => {
  const r = fakeRouter([{ id: "gemma", status: "unloaded" }]);
  assert.equal(await ensureRouterModel(r, "llama.cpp/gemma", { pollMs: 1 }), "loaded gemma on the llama.cpp router");
  assert.deepEqual(r.loads, ["gemma"]);
});

test("loaded models and other providers' models are left alone", async () => {
  const r = fakeRouter([{ id: "qwen", status: "loaded" }]);
  assert.equal(await ensureRouterModel(r, "qwen", { pollMs: 1 }), undefined);
  assert.equal(await ensureRouterModel(r, "openai/gpt", { pollMs: 1 }), undefined);
  assert.deepEqual(r.loads, []);
});

test("a llama.cpp model the router lacks names what it has; failed loads throw", async () => {
  await assert.rejects(ensureRouterModel(fakeRouter([{ id: "qwen", status: "loaded" }]), "llama.cpp/nope"), /It has: qwen/);
  const r = fakeRouter([{ id: "big", status: "unloaded" }], 99);
  r.load = async () => {};
  r.list = async () => [{ id: "big", status: "unloaded", failed: true }];
  await assert.rejects(ensureRouterModel(r, "big", { pollMs: 1 }), /could not load big/);
});
