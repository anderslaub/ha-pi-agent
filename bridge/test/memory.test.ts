import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { calendar, lastConversationLine, nowLine, parseWhen, stamp, validTimeZone } from "../src/clock.ts";
import { cleanNote, contextBlock, readNote, stripContext, transcript, writeNote } from "../src/memory.ts";
import { describeWakeup, WakeupStore } from "../src/wakeups.ts";

const TZ = "Europe/Copenhagen";
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "pi-va-mem-"));

test("clock: the time line, offsets in winter and summer, and how long ago", () => {
  const now = new Date("2026-11-23T06:42:00Z"); // 07:42 in Copenhagen (winter, +01:00)
  assert.equal(nowLine(now, TZ), "The time is right now 07:42, it's Monday the 23/11 2026.");
  assert.equal(stamp(now, TZ), "2026-11-23T07:42+01:00");
  assert.equal(stamp(new Date("2026-07-01T10:00:00Z"), TZ), "2026-07-01T12:00+02:00");
  assert.equal(new Date(Date.parse(stamp(now, TZ))).getTime(), now.getTime());
  const lastNight = new Date("2026-11-22T21:40:00Z"); // 22:40 Sunday
  assert.equal(lastConversationLine(lastNight, now, TZ), "Your last conversation was 9 hours ago, at 22:40 yesterday (Sunday 22/11).");
  assert.match(lastConversationLine(new Date("2026-11-23T06:30:00Z"), now, TZ), /12 minutes ago, at 07:30 today/);
  assert.equal(validTimeZone("Europe/Copenhagen"), true);
  assert.equal(validTimeZone("Mars/Olympus"), false);
  assert.equal(nowLine(now, "UTC"), "The time is right now 06:42, it's Monday the 23/11 2026.");
  assert.match(calendar(now, TZ, 4), /^Mon 23\/11 \(today\), Tue 24\/11 \(tomorrow\), Wed 25\/11, Thu 26\/11$/);
});

test("clock: wake-up times", () => {
  const now = new Date("2026-11-23T06:42:00Z");
  assert.equal(parseWhen("in 20 minutes", now, TZ)?.toISOString(), "2026-11-23T07:02:00.000Z");
  assert.equal(parseWhen("+2h", now, TZ)?.toISOString(), "2026-11-23T08:42:00.000Z");
  assert.equal(parseWhen("18:30", now, TZ)?.toISOString(), "2026-11-23T17:30:00.000Z");
  assert.equal(parseWhen("07:00", now, TZ)?.toISOString(), "2026-11-24T06:00:00.000Z"); // passed today: tomorrow
  assert.equal(parseWhen("2026-11-27 19:00", now, TZ)?.toISOString(), "2026-11-27T18:00:00.000Z");
  assert.equal(parseWhen("2026-07-01T12:00", now, TZ)?.toISOString(), "2026-07-01T10:00:00.000Z");
  assert.equal(parseWhen("Thursday 18:30", now, TZ)?.toISOString(), "2026-11-26T17:30:00.000Z");
  assert.equal(parseWhen("tomorrow at 6:45", now, TZ)?.toISOString(), "2026-11-24T05:45:00.000Z");
  assert.equal(parseWhen("monday 07:00", now, TZ)?.toISOString(), "2026-11-30T06:00:00.000Z"); // today's has passed
  assert.equal(parseWhen("mon 08:00", now, TZ)?.toISOString(), "2026-11-23T07:00:00.000Z");
  assert.equal(parseWhen("next week", now, TZ), undefined);
});

test("memory: note file, context block, and stripping the block from transcripts", () => {
  const file = path.join(tmp(), "short-term-memory.md");
  assert.equal(readNote(file), undefined);
  const at = new Date("2026-11-22T21:40:00Z");
  writeNote(file, { at, body: "Last conversation: someone asked about the news.\nComing up / remember:\n- Thu 26/11: concert" }, TZ);
  assert.match(fs.readFileSync(file, "utf8"), /^2026-11-22T22:40\+01:00\nLast conversation:/);
  const note = readNote(file)!;
  assert.equal(note.at.getTime(), at.getTime());
  const now = new Date("2026-11-23T06:42:00Z");
  const block = contextBlock({ now, tz: TZ, note, wakeups: ["Thu 26/11 23:00: ask how the concert was"] });
  assert.match(block, /The time is right now 07:42[\s\S]*for reference only[\s\S]*9 hours ago/);
  assert.match(block, /In it you talked about: "someone asked about the news\." \(this may be irrelevant now\)/);
  assert.match(block, /Calendar notes:\n- Thu 26\/11: concert\nWake-ups you have set:\n- Thu 26\/11 23:00/);
  assert.doesNotMatch(block, /Last conversation:/);
  assert.equal(stripContext(`${block}\n\nturn on the light`), "turn on the light");
  assert.equal(stripContext("[Time: 07:45] and the kitchen"), "and the kitchen");
  const t = transcript(
    [
      { role: "user", content: `${block}\n\nwhat's new` },
      { role: "assistant", content: [{ type: "toolCall", name: "web_fetch", arguments: { url: "https://x" } }] },
      { role: "toolResult", content: [{ type: "text", text: "lots of html" }] },
      { role: "assistant", content: [{ type: "text", text: "The summit was cancelled." }] },
    ],
    (name, args) => `${name} ${JSON.stringify(args)}`,
  );
  assert.equal(t, 'User: what\'s new\n(tool: web_fetch {"url":"https://x"})\nAssistant: The summit was cancelled.');
  assert.equal(cleanNote("Sure! Here is the note:\n**Last conversation:** x"), "Last conversation: x");
  assert.equal(cleanNote("nothing useful"), undefined);
});

test("wake-ups: stored, listed in time order, due ones taken out", () => {
  const store = new WakeupStore(path.join(tmp(), "wakeups.json"));
  const now = Date.now();
  const late = store.add({ at: now + 3_600_000, note: "later" });
  store.add({ at: now - 1000, note: "due", satellite_id: "assist_satellite.kattio_box_1" });
  assert.deepEqual(store.list().map((w) => w.note), ["due", "later"]);
  assert.deepEqual(store.takeDue(now).map((w) => w.note), ["due"]);
  assert.deepEqual(store.list().map((w) => w.note), ["later"]);
  assert.match(describeWakeup(late, TZ, true), /: later \(id [0-9a-f]{8}\)$/);
  assert.equal(store.cancel(late.id)?.note, "later");
  assert.equal(store.list().length, 0);
});
