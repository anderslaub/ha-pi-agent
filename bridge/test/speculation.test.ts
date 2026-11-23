import { test } from "node:test";
import assert from "node:assert/strict";
import { Gate, sameRequest, words } from "../src/speculation.ts";

test("words drop labels, punctuation and case", () => {
  assert.deepEqual(words("[Anders] Tænd lyset i stuen, tak!"), ["tænd", "lyset", "i", "stuen", "tak"]);
});

test("the same request from two speech-to-text passes matches", () => {
  assert.ok(sameRequest("[Anders] Turn on the light in the kitchen.", "[Anders] turn on the light in the kitchen"));
  assert.ok(sameRequest("Set a timer for ten minutes", "Set a timer for 10 minutes")); // one word differs
});

test("a request that went on does not match", () => {
  assert.ok(!sameRequest("Turn on the light", "Turn on the light in the kitchen and close the blinds"));
  assert.ok(!sameRequest("", "anything"));
});

test("the gate opens once", async () => {
  const g = new Gate();
  g.open(false);
  g.open(true);
  assert.equal(await g.opened, false);
  assert.equal(g.settled, false);
});
