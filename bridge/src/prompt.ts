/**
 * The assistant system prompt.
 *
 * Assistant sessions get pi's normal system prompt (including pi's own SYSTEM.md / APPEND_SYSTEM.md) plus an
 * assistant section: the first of these files that exists, else the built-in DEFAULT_ASSISTANT_PROMPT:
 *
 *   <bridge cwd>/.pi/va-bridge/SYSTEM.md    project: only sessions started in that folder
 *   ~/.pi/agent/va-bridge/SYSTEM.md         global: all sessions of the bridge
 *
 * The file is read whenever a new session starts, so edits apply without a restart.
 */
import fs from "node:fs";
import path from "node:path";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";

export const PROMPT_DIR = "va-bridge";

export const DEFAULT_ASSISTANT_PROMPT = `# Home Assistant conversation
You are the brain of a Home Assistant assistant. Requests usually come from a voice satellite: what the user
says reaches you as speech-to-text (expect misheard words) and your reply is read aloud by text-to-speech.
The same assistant can also be used as a text chat, so write replies that work both ways:
- Plain sentences. No markdown, tables, lists, emojis or code in replies.
- Keep it short: one to three sentences unless asked for detail. Never quote code, logs, paths or URLs;
  say what you did and where the result is instead.
- Before a task that needs tools for a while (research, coding, files), first say one short sentence about
  what you are going to do. If it takes long, the user is told that you are working on it and your final
  message is delivered to them later, so make the final message a short summary of the outcome.
- Ask a short question when the request is ambiguous; a reply that ends with a question mark keeps the
  conversation open for the answer.`;

export function promptCandidates(cwd: string, agentDir: string): string[] {
  return [path.join(cwd, CONFIG_DIR_NAME, PROMPT_DIR, "SYSTEM.md"), path.join(agentDir, PROMPT_DIR, "SYSTEM.md")];
}

export function loadAssistantPrompt(cwd: string, agentDir: string): { text: string; path?: string } {
  for (const p of promptCandidates(cwd, agentDir)) {
    if (!fs.existsSync(p)) continue;
    return { text: fs.readFileSync(p, "utf8").trim(), path: p };
  }
  return { text: DEFAULT_ASSISTANT_PROMPT };
}

/** The complete assistant section for one session */
export function buildAssistantSection(
  cwd: string,
  agentDir: string,
  opts: { language?: string; instructions?: string } = {},
): { text: string; path?: string } {
  const base = loadAssistantPrompt(cwd, agentDir);
  let text = base.text;
  if (opts.language) text += `\n\nThe user's language is "${opts.language}"; reply in it.`;
  if (opts.instructions?.trim()) text += `\n\n# Instructions from Home Assistant\n${opts.instructions.trim()}`;
  return { text, path: base.path };
}
