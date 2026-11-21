import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ensureToken, loadConfig, setConfigValue } from "../src/config.ts";
import { buildAssistantSection, DEFAULT_ASSISTANT_PROMPT } from "../src/prompt.ts";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "pi-va-test-"));

test("setup creates a private settings file with a token, and keeps it", () => {
  const file = path.join(tmp(), "va-bridge.json");
  const a = ensureToken(file);
  assert.equal(a.created, true);
  assert.ok(a.token.length >= 32);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  const b = ensureToken(file);
  assert.equal(b.created, false);
  assert.equal(b.token, a.token);
  setConfigValue("autostart", true, file);
  const cfg = loadConfig({}, file);
  assert.equal(cfg.autostart, true);
  assert.equal(cfg.port, 8787);
  assert.equal(cfg.cwd, path.join(os.homedir(), "pi-va"));
});

test("environment overrides the settings file", () => {
  const file = path.join(tmp(), "va-bridge.json");
  fs.writeFileSync(file, JSON.stringify({ token: "x".repeat(20), port: 1, tools: "read, ls" }));
  const cfg = loadConfig({ PI_BRIDGE_PORT: "9000", PI_BRIDGE_TOOLS: "read,grep" }, file);
  assert.equal(cfg.port, 9000);
  assert.deepEqual(cfg.tools, ["read", "grep"]);
  assert.deepEqual(loadConfig({}, file).tools, ["read", "ls"]);
  assert.throws(() => loadConfig({}, path.join(tmp(), "missing.json")), /No bridge token/);
});

test("system prompt: project file beats global file beats built-in", () => {
  const cwd = tmp();
  const agentDir = tmp();
  assert.equal(buildAssistantSection(cwd, agentDir).text, DEFAULT_ASSISTANT_PROMPT);
  fs.mkdirSync(path.join(agentDir, "va-bridge"));
  fs.writeFileSync(path.join(agentDir, "va-bridge", "SYSTEM.md"), "global prompt\n");
  assert.equal(buildAssistantSection(cwd, agentDir).text, "global prompt");
  fs.mkdirSync(path.join(cwd, ".pi", "va-bridge"), { recursive: true });
  fs.writeFileSync(path.join(cwd, ".pi", "va-bridge", "SYSTEM.md"), "project prompt");
  const s = buildAssistantSection(cwd, agentDir, { language: "da", instructions: "Be brief." });
  assert.equal(s.path, path.join(cwd, ".pi", "va-bridge", "SYSTEM.md"));
  assert.match(s.text, /^project prompt\n\nThe user's language is "da".*\n\n# Instructions from Home Assistant\nBe brief\.$/s);
});

test("task timeout and warm-up defaults, and their overrides", () => {
  const file = path.join(tmp(), "va-bridge.json");
  const base = { PI_BRIDGE_TOKEN: "x".repeat(20) };
  let cfg = loadConfig(base, file);
  assert.equal(cfg.taskTimeoutMinutes, 10);
  assert.equal(cfg.warmup, true);
  cfg = loadConfig({ ...base, PI_BRIDGE_TASK_TIMEOUT_MIN: "3", PI_BRIDGE_WARMUP: "0" }, file);
  assert.equal(cfg.taskTimeoutMinutes, 3);
  assert.equal(cfg.warmup, false);
});
