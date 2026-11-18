import { test } from "node:test";
import assert from "node:assert/strict";
import { SpeechFilter, toSpeech } from "../src/speech.ts";

test("strips markdown", () => {
  assert.equal(toSpeech("## Result\nThis is **bold** and `code` and *italic*."), "Result.\nThis is bold and code and italic.");
  assert.equal(toSpeech("- one\n- two\n1. first"), "one\ntwo\n1, first");
  assert.equal(toSpeech("See [the docs](https://x.y/z) or https://example.com/a."), "See the docs or a link.");
});

test("drops code blocks and tables separators", () => {
  assert.equal(toSpeech("Here:\n```py\nprint('hi')\n```\nDone."), "Here:\nDone.");
  assert.equal(toSpeech("| a | b |\n|---|:-:|\n| 1 | 2 |"), "a, b.\n1, 2.");
});

test("keeps snake_case and math", () => {
  assert.equal(toSpeech("Set foo_bar to 2 * 3 now."), "Set foo_bar to 2 * 3 now.");
});

test("streams sentences early", () => {
  const f = new SpeechFilter();
  assert.equal(f.push("Hello **wor"), "");
  assert.equal(f.push("ld**. How are"), "Hello world.");
  assert.equal(f.push(" you?\n"), " How are you?\n");
  assert.equal(f.push("```\ncode"), "");
  assert.equal(f.push("\n```\nAfter"), "");
  assert.equal(f.flush(), "After");
  assert.equal(f.takeSkippedCode(), true);
});
