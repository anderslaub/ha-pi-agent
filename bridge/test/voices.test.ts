import { test } from "node:test";
import assert from "node:assert/strict";
import { filterVoices, parseLabels, speakerKind, stripLabels, unknownSpeakerNote, VoiceAsker } from "../src/voices.ts";
import type { UnknownVoice } from "../src/voices.ts";

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

test("ask who is speaking once, and again only after a while; the service keeps when", async () => {
  const DAY = 86_400_000;
  const stored = new Map<string, UnknownVoice>([["3f2a", { id: "3f2a", count: 1, first_seen: 0, last_seen: 0 }]]);
  const client = {
    list: async () => ({ known: [], recent: [...stored.values()] }),
    asked: async (id: string) => {
      const v = stored.get(id)!;
      v.asked = now / 1000;
      return v;
    },
  };
  let now = 10 * DAY;
  const asker = new VoiceAsker(client, 30 * DAY);
  assert.equal((await asker.decide("3f2a", now)).ask, true);
  now += DAY;
  const later = await asker.decide("3f2a", now);
  assert.equal(later.ask, false);
  assert.equal(later.askedBefore, 10 * DAY);
  // a new bridge (restart) still knows: the service kept it
  assert.equal((await new VoiceAsker(client, 30 * DAY).decide("3f2a", now)).ask, false);
  now += 40 * DAY;
  assert.equal((await asker.decide("3f2a", now)).ask, true);
  // a service without the asked route: remembered in memory
  const bare = new VoiceAsker({ list: async () => ({ known: [], recent: [] }), asked: async () => { throw new Error("404"); } }, DAY);
  assert.equal((await bare.decide("beef", 0)).ask, true);
  assert.equal((await bare.decide("beef", 1000)).ask, false);

  assert.match(unknownSpeakerNote("3f2a", true), /ask who is speaking.*voice_learn \(voice "3f2a"\)/);
  assert.match(unknownSpeakerNote("3f2a", true), /the TV.*not_for_me/);
  assert.match(unknownSpeakerNote("3f2a", false), /not_for_me.*Do not ask who it is again/);
  assert.match(unknownSpeakerNote("3f2a", false, Date.now(), "TV is on."), /TV is on\. It may well be the TV/);
  assert.doesNotMatch(unknownSpeakerNote("3f2a", false), /Ask who/);
  const met = unknownSpeakerNote(
    "3f2a",
    { ask: false, voice: { id: "3f2a", count: 7, first_seen: Date.UTC(2026, 9, 3) / 1000 }, askedBefore: Date.UTC(2026, 9, 3) },
    Date.UTC(2026, 10, 23),
  );
  assert.match(met, /heard this voice before \(first on 2026-10-03, 7 times\)/);
  assert.match(met, /asked who it was on 2026-10-03/);
});

test("whose voice starts a transcript", () => {
  assert.equal(speakerKind("[Anders] hi"), "known");
  assert.equal(speakerKind("[unknown voice 3f2a] hi [Anders] yes"), "unknown");
  assert.equal(speakerKind("[?] hi"), undefined);
  assert.equal(speakerKind("hi"), undefined);
});
