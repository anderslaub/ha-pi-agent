import assert from "node:assert/strict";
import { test } from "node:test";

import { TurnTiming } from "../src/timing.ts";

test("turn timing records model calls, tools and the longest gap between spoken pieces", async () => {
  const t = new TurnTiming();
  t.llmStart();
  t.llmDelta(0); // thinking
  t.llmDelta(5);
  t.textSent();
  t.toolStart("a", "bash");
  await new Promise((r) => setTimeout(r, 30));
  t.toolEnd("a");
  t.llmEnd();
  t.llmDelta(3); // a new call without message_start
  t.textSent();
  const j = t.toJSON();
  assert.equal(j.llm.length, 2);
  assert.equal(j.llm[0].chars, 5);
  assert.ok(j.llm[0].first_token !== undefined && j.llm[0].first_text !== undefined);
  assert.equal(j.tools[0].name, "bash");
  assert.ok((j.tools[0].ms ?? 0) >= 25);
  assert.equal(j.text_pieces, 2);
  assert.ok(j.longest_text_gap >= 25);
});
