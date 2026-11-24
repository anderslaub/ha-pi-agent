import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as history from "../src/history.ts";
import { CONTEXT_END, CONTEXT_START } from "../src/memory.ts";

function session(dir: string, id: string, at: string, lines: { id: string; parent: string | null; role: string; text: string }[]) {
  const sub = path.join(dir, "--workspace--");
  fs.mkdirSync(sub, { recursive: true });
  const file = path.join(sub, `${at.replace(/:/g, "-")}_${id}.jsonl`);
  const out = [JSON.stringify({ type: "session", version: 3, id, timestamp: at, cwd: "/workspace" })];
  for (const l of lines) {
    out.push(JSON.stringify({ type: "message", id: l.id, parentId: l.parent, timestamp: at, message: { role: l.role, content: [{ type: "text", text: l.text }] } }));
  }
  fs.writeFileSync(file, out.join("\n") + "\n");
  return file;
}

test("past conversations: search, read, delete, expire", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hist-"));
  const a = session(dir, "01a20a0e-0000-7000-8000-00000000aaaa", "2026-11-20T18:00:00.000Z", [
    { id: "s", parent: null, role: "system", text: "You are Kattio" },
    { id: "u1", parent: "s", role: "user", text: `${CONTEXT_START}\nnow\n${CONTEXT_END}\n[System: unknown voice 3f2a.] [Anders] what should I plant in the garden` },
    { id: "a1", parent: "u1", role: "assistant", text: "Tomatoes, obviously." },
    // an early answer that was thrown away: a branch off u1
    { id: "u2x", parent: "a1", role: "user", text: "[Time: 18:01] [Anders] and the carrots" },
    { id: "a2x", parent: "u2x", role: "assistant", text: "THROWN AWAY" },
    { id: "u2", parent: "a1", role: "user", text: "[Time: 18:01] [Anders] and the carrots, when?" },
    { id: "a2", parent: "u2", role: "assistant", text: "In April." },
  ]);
  session(dir, "01a20a0e-0000-7000-8000-00000000bbbb", "2026-11-22T09:00:00.000Z", [
    { id: "u1", parent: null, role: "user", text: "[Anders] turn on the kitchen light" },
    { id: "a1", parent: "u1", role: "assistant", text: "Done." },
  ]);

  const c = history.readConversation(a)!;
  assert.equal(c.id, "00aaaa");
  assert.deepEqual(c.lines.map((l) => l.text), [
    "[Anders] what should I plant in the garden",
    "Tomatoes, obviously.",
    "[Anders] and the carrots, when?",
    "In April.",
  ]);

  const hits = history.search(dir, { query: "garden carrots" });
  assert.equal(hits.length, 1);
  assert.equal(hits[0].score, 2);
  assert.equal(history.search(dir, {}).length, 2);
  assert.equal(history.search(dir, { from: Date.parse("2026-11-21") }).length, 1);
  assert.match(history.describeHits(hits, "Europe/Copenhagen"), /Conversation 00aaaa, Fri, 20 Nov 2026, 19:00/);
  assert.match(history.describeConversation(c, "UTC"), /You: In April\./);

  assert.equal(history.remove(dir, "aaaa", new Set([path.resolve(a)])), undefined, "in use");
  assert.ok(history.remove(dir, "aaaa"));
  assert.ok(!fs.existsSync(a));
  assert.equal(history.find(dir, "00aaaa"), undefined);

  const gone = history.expire(dir, 30, new Set(), Date.now() + 31 * 86_400_000);
  assert.equal(gone.length, 1);
  assert.deepEqual(history.expire(dir, 0), []);
  fs.rmSync(dir, { recursive: true });
});
