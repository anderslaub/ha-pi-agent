import { test } from "node:test";
import assert from "node:assert/strict";
import { classifierContext, cleanRemark, describeMedia, isQuiet, interruptContext, interruptionNote, parseVerdict, remarkPrompt, screenMessage, screenPrompt, withScreenContext } from "../src/screen.ts";

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
  assert.match(first, /NOISE \| <remark or QUIET>/);
  assert.match(first, /"da"/);
  assert.match(first, /grumpy cat/);
  const retry = screenPrompt({ stage: "retry", text: "x" });
  assert.match(retry, /only the word TALK or NOISE/);
  assert.doesNotMatch(retry, /<remark>/);
  const msg = screenMessage({ stage: "retry", text: "buy now", previous: { heard: "and in Oslo", said: "Me?" } });
  assert.match(msg, /and in Oslo[\s\S]*Me\?[\s\S]*buy now/);
  assert.equal(withScreenContext("yes, lights on"), "yes, lights on");
  assert.match(withScreenContext("yes", { heard: "h", said: "s" }), /"h".*"s".*\] yes$/);
});

test("classifier question: true means meant for the assistant; retry carries the remark", () => {
  const first = classifierContext({ stage: "first", text: "and now the weather" });
  assert.equal(first.state.heard, "and now the weather");
  assert.equal(first.questions.meant.type, "bool");
  const retry = classifierContext({ stage: "retry", text: "no", previous: { heard: "h", said: "Me?" } });
  assert.equal(retry.state.reply_heard_now, "no");
  assert.equal(retry.state.assistant_thought_it_was_noise_and_said, "Me?");
  assert.match(remarkPrompt({ stage: "first", text: "x", language: "da", persona: "A cat." }), /"da"[\s\S]*A cat\./);
  assert.equal(cleanRemark('"Gripping stuff.\nFor me?"'), "Gripping stuff. For me?");
  assert.equal(cleanRemark("  "), undefined);
});

test("turn check asks whether the speaker is done, with the label and the silence", async () => {
  const { completeContext } = await import("../src/screen.ts");
  const c = completeContext("[Anders] turn on the light in the", 450);
  assert.equal(c.state.heard_so_far, "[Anders] turn on the light in the");
  assert.equal(c.state.silence_since_last_word_ms, "450");
  assert.equal(c.questions.complete.type, "bool");
});

test("interruptContext asks one bool question and keeps the end of the reply", () => {
  const c = interruptContext("[Ellie] no wait, the other one", "x".repeat(1000) + " the kitchen light is on");
  assert.deepEqual(Object.keys(c.questions), ["interrupt"]);
  assert.ok(String(c.state.assistant_was_saying).endsWith("the kitchen light is on"));
  assert.ok(String(c.state.assistant_was_saying).length <= 600);
});

test("interruptionNote says where the answer was cut off", () => {
  const n = interruptionNote({ who: "Ellie", text: "no, the bedroom", heard_part: "I turned on the kitchen" });
  assert.match(n, /Ellie interrupted/);
  assert.match(n, /the kitchen"/);
  assert.match(n, /no, the bedroom/);
});

test("the assistant may stay quiet about background noise, and the voice counts", () => {
  assert.deepEqual(parseVerdict("NOISE | QUIET", "first"), { verdict: "noise", quiet: true });
  assert.equal(parseVerdict("NOISE | Quiet, you. Was that for me?", "first").quiet, undefined);
  assert.ok(isQuiet("QUIET") && isQuiet(" (quiet). ") && !isQuiet("quiet please"));
  assert.match(remarkPrompt({ stage: "first", text: "x" }), /only the word QUIET/);
  const c = classifierContext({ stage: "first", text: "and the financials", voice: "unknown" });
  assert.match(c.state.voice, /often the TV/);
  assert.equal(classifierContext({ stage: "first", text: "x" }).state.voice, undefined);
  assert.match(screenMessage({ stage: "retry", text: "hi", previous: { heard: "h", said: "" }, voice: "known" }), /said nothing and listened[\s\S]*knows by name/);
  assert.match(withScreenContext("[Anders] hey", { heard: "h", said: "" }), /said nothing and listened.*what's up.*\] \[Anders\] hey$/);
});

test("what the media players play goes into the question", () => {
  assert.equal(describeMedia(undefined), undefined);
  assert.equal(describeMedia([]), "Nothing is playing on the media players.");
  assert.equal(
    describeMedia([{ name: "Living room TV", state: "playing", title: "Markets", series: "Bloomberg", app: "YouTube" }]),
    "Living room TV is playing: Bloomberg, Markets, in YouTube.",
  );
  assert.equal(describeMedia([{ name: "TCL TV", state: "on" }]), "TCL TV is on.");
  const c = classifierContext({ stage: "first", text: "the financials", voice: "unknown", media: [{ name: "TV", state: "on" }] });
  assert.equal(c.state.playing_now, "TV is on.");
  assert.match(screenMessage({ stage: "first", text: "x", media: [] }), /Playing now: Nothing is playing/);
});
