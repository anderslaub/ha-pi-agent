import assert from "node:assert/strict";
import { test } from "node:test";
import { toolsSection, withToolsSection } from "../src/prompt.ts";

const opts = {
  cwd: "/w",
  customPrompt: "You are a cat.",
  selectedTools: ["read", "bash", "hidden"],
  toolSnippets: { read: "Read files", bash: "Run commands" },
  promptGuidelines: ["Use bash for ls", " Use bash for ls ", ""],
};

test("tools section lists tools with snippets and unique guidelines", () => {
  const t = toolsSection(opts);
  assert.match(t, /^Available tools:\n- read: Read files\n- bash: Run commands\n/);
  assert.doesNotMatch(t, /hidden/);
  assert.equal(t.match(/Use bash for ls/g)?.length, 1);
});

test("tools go right after the assistant prompt, keeping what follows", () => {
  const prompt = "You are a cat.\n\nappended\nCurrent working directory: /w";
  const out = withToolsSection(prompt, opts);
  assert.ok(out.startsWith("You are a cat.\n\nAvailable tools:\n"));
  assert.ok(out.endsWith("appended\nCurrent working directory: /w"));
  assert.equal(withToolsSection(out, opts), out); // not twice
});

test("a rewritten prompt gets the tools at the end; no tools, no change", () => {
  assert.ok(withToolsSection("Something else", opts).endsWith("- bash: Run commands\n\nIn addition to the tools above, you may have access to other custom tools.\n\nTool guidelines:\n- Use bash for ls"));
  assert.equal(withToolsSection("x", { cwd: "/w", customPrompt: "x" }), "x");
});
