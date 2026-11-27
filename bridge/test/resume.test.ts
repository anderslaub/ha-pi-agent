import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ConversationFiles } from "../src/resume.ts";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "va-resume-"));

test("a conversation's session file is found again after a restart", () => {
  const dir = tmp();
  const session = path.join(dir, "s1.jsonl");
  fs.writeFileSync(session, "{}\n");
  const map = path.join(dir, "map.json");
  new ConversationFiles(map).set("conversation:abc", session);
  assert.equal(new ConversationFiles(map).get("conversation:abc"), session);
  assert.equal(new ConversationFiles(map).get("conversation:other"), undefined);
});

test("devices are not continued, and deleted sessions are forgotten", () => {
  const dir = tmp();
  const session = path.join(dir, "s1.jsonl");
  fs.writeFileSync(session, "{}\n");
  const files = new ConversationFiles(path.join(dir, "map.json"));
  files.set("device:box", session);
  assert.equal(files.get("device:box"), undefined);
  files.set("conversation:abc", session);
  fs.rmSync(session);
  assert.equal(files.get("conversation:abc"), undefined);
});

test("only the most recently used are kept", () => {
  const dir = tmp();
  const session = path.join(dir, "s.jsonl");
  fs.writeFileSync(session, "{}\n");
  const files = new ConversationFiles(path.join(dir, "map.json"));
  for (let i = 0; i < 505; i++) files.set(`conversation:${i}`, session, 1000 + i);
  assert.equal(files.get("conversation:0"), undefined);
  assert.equal(files.get("conversation:504"), session);
  assert.equal(Object.keys(JSON.parse(fs.readFileSync(path.join(dir, "map.json"), "utf8"))).length, 500);
});
