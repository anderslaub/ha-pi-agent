import { test } from "node:test";
import assert from "node:assert/strict";
import { AskedVoices, filterVoices, parseLabels, stripLabels, unknownSpeakerNote } from "../src/voices.ts";

test("labels are read: known names and unknown voice ids", () => {
  assert.deepEqual(parseLabels("[Anders] tænd lyset [unknown voice 3F2A] og nu til vejret"), [
    { name: "Anders", text: "tænd lyset" },
    { id: "3f2a", text: "og nu til vejret" },
  ]);
  assert.equal(parseLabels("turn on the light"), undefined);
  assert.equal(parseLabels("set a timer [for ten] minutes"), undefined);
});

test("later unknown voices are left out, the speaker and known voices stay", () => {
  const f = filterVoices("[Anders] turn on the light [unknown voice 3f2a] in other news [Ellie] and the kitchen too");
  assert.equal(f.text, "[Anders] turn on the light [Ellie] and the kitchen too");
  assert.deepEqual(f.dropped, [{ id: "3f2a", text: "in other news" }]);
  assert.deepEqual(f.speaker, { name: "Anders", text: "turn on the light" });
});

test("an unknown speaker keeps their own later stretches; other unknown voices go", () => {
  const f = filterVoices("[unknown voice aaaa] remind me at five [unknown voice bbbb] stay tuned [unknown voice aaaa] to call mom");
  assert.equal(f.text, "[unknown voice aaaa] remind me at five to call mom");
  assert.equal(f.speaker?.id, "aaaa");
});

test("text without labels passes unchanged", () => {
  assert.deepEqual(filterVoices("what's the weather"), { text: "what's the weather", dropped: [] });
  assert.equal(stripLabels("[Anders] hej [unknown voice 3f2a] med dig"), "hej med dig");
  assert.equal(stripLabels("hej"), "hej");
});

test("ask who is speaking once per voice per day", () => {
  const asked = new AskedVoices(1000);
  assert.equal(asked.shouldAsk("3f2a", 0), true);
  assert.equal(asked.shouldAsk("3f2a", 500), false);
  assert.equal(asked.shouldAsk("beef", 500), true);
  assert.equal(asked.shouldAsk("3f2a", 2000), true);
  assert.match(unknownSpeakerNote("3f2a", true), /Ask who is speaking.*voice_learn \(voice "3f2a"\)/);
  assert.doesNotMatch(unknownSpeakerNote("3f2a", false), /Ask who/);
});
