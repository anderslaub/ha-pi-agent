import { test } from "node:test";
import assert from "node:assert/strict";
import { classifierContext, cleanRemark, parseVerdict, remarkPrompt, screenMessage, screenPrompt, withScreenContext } from "../src/screen.ts";

test("verdict: TALK, NOISE with a remark, and anything unclear counts as TALK", () => {
  assert.deepEqual(parseVerdict("TALK", "first"), { verdict: "talk" });
  assert.deepEqual(parseVerdict("NOISE | Fascinating ad. Was that for me?", "first"), {
    verdict: "noise",
    remark: "Fascinating ad. Was that for me?",
  });
  assert.deepEqual(parseVerdict('**NOISE**: "Riveting.\nTalking to me?"', "first"), {
    verdict: "noise",
    remark: "Riveting. Talking to me?",
  });
  assert.deepEqual(parseVerdict("NOISE", "first"), { verdict: "noise", remark: undefined });
  assert.deepEqual(parseVerdict("noise", "retry"), { verdict: "noise" });
  assert.deepEqual(parseVerdict("I think this is noise", "first"), { verdict: "talk" });
  assert.deepEqual(parseVerdict("", "retry"), { verdict: "talk" });
  assert.deepEqual(parseVerdict("NOISEMAKER", "first"), { verdict: "talk" });
});

test("prompts: remark only on the first stage, with persona and language; retry shows what came before", () => {
  const first = screenPrompt({ stage: "first", text: "x", language: "da", persona: "You are a grumpy cat." });
  assert.match(first, /NOISE \| <remark>/);
  assert.match(first, /"da"/);
  assert.match(first, /grumpy cat/);
  const retry = screenPrompt({ stage: "retry", text: "x" });
  assert.match(retry, /only the word TALK or NOISE/);
  assert.doesNotMatch(retry, /<remark>/);
  const msg = screenMessage({ stage: "retry", text: "buy now", previous: { heard: "and in Oslo", said: "Me?" } });
  assert.match(msg, /and in Oslo[\s\S]*Me\?[\s\S]*buy now/);
  assert.equal(withScreenContext("yes, lights on"), "yes, lights on");
  assert.match(withScreenContext("yes", { heard: "h", said: "s" }), /"h".*"s"\] yes$/);
});

test("classifier question: true means meant for the assistant; retry carries the remark", () => {
  const first = classifierContext({ stage: "first", text: "and now the weather" });
  assert.equal(first.state.heard, "and now the weather");
  assert.equal(first.questions.meant.type, "bool");
  const retry = classifierContext({ stage: "retry", text: "no", previous: { heard: "h", said: "Me?" } });
  assert.equal(retry.state.reply_heard_now, "no");
  assert.equal(retry.state.assistant_thought_it_was_noise_and_asked, "Me?");
  assert.match(remarkPrompt({ stage: "first", text: "x", language: "da", persona: "A cat." }), /"da"[\s\S]*A cat\./);
  assert.equal(cleanRemark('"Gripping stuff.\nFor me?"'), "Gripping stuff. For me?");
  assert.equal(cleanRemark("  "), undefined);
});
