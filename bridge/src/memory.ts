/**
 * Short-term memory and a sense of time.
 *
 * After a conversation has been quiet for a few minutes, the chat model (thinking off) rewrites one small note:
 * who the assistant talked to and what about (with links or file names for the details), one line condensing the
 * earlier conversations, and a mini calendar of things coming up or recently past ("Thu 27/11: concert"). Past
 * dates stay a few days, so the assistant can ask how it went.
 *
 * Every new session starts with a context block in front of the first message: the time right now, how long ago
 * the last conversation was, the note, and the wake-ups that are set. Later messages get the time in front. The
 * block goes into the message and not into the system prompt: the system prompt is followed by the tool list in
 * the model's prompt, and changing it would make llama.cpp process the whole prompt again (seconds per session).
 */
import fs from "node:fs";
import path from "node:path";
import { calendar, dayLabel, hhmm, lastConversationLine, nowLine, stamp } from "./clock.ts";

export interface MemoryNote {
  at: Date;
  body: string;
}

/** Most the note may be: the summarizer is asked for less, longer answers are cut */
const MAX_NOTE_CHARS = 1500;
/** How much of a conversation the summarizer gets (the end of it) */
const MAX_TRANSCRIPT_CHARS = 12_000;

export const CONTEXT_START = "[Context for you from the system, not said by the user]";
export const CONTEXT_END = "[End of context]";

export function readNote(file: string): MemoryNote | undefined {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
  const nl = text.indexOf("\n");
  const at = new Date(Date.parse((nl < 0 ? text : text.slice(0, nl)).trim()));
  if (Number.isNaN(at.getTime())) return undefined;
  return { at, body: (nl < 0 ? "" : text.slice(nl + 1)).trim() };
}

export function writeNote(file: string, note: MemoryNote, tz: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, `${stamp(note.at, tz)}\n${note.body.trim()}\n`);
  fs.renameSync(tmp, file);
}

export interface ContextOptions {
  now: Date;
  tz: string;
  note?: MemoryNote;
  /** "Tue 24/11 07:00: remind about the dentist", ... */
  wakeups?: string[];
}

/** The parts of a note: "Last conversation: ...", "Before that: ...", and the calendar items */
export function parseNote(body: string): { last?: string; before?: string; items: string[] } {
  const out: { last?: string; before?: string; items: string[] } = { items: [] };
  for (const raw of body.split("\n")) {
    const line = raw.trim();
    if (/^last conversation:/i.test(line)) out.last = line.replace(/^last conversation:\s*/i, "");
    else if (/^before that:/i.test(line)) out.before = line.replace(/^before that:\s*/i, "");
    else if (line.startsWith("- ") && !/^- nothing\.?$/i.test(line)) out.items.push(line.slice(2));
  }
  return out;
}

/**
 * The block in front of the first message of a session. The note is offered as reference, not as the topic: the
 * assistant should not steer the conversation towards it.
 */
export function contextBlock(o: ContextOptions): string {
  const lines = [CONTEXT_START, nowLine(o.now, o.tz)];
  const note = o.note ? parseNote(o.note.body) : undefined;
  const hasNote = note && (note.last || note.before || note.items.length);
  if (o.note || o.wakeups?.length) {
    lines.push(
      "",
      "Background notes, for reference only. They are probably unrelated to what the user wants now: do not bring " +
        "them up and do not let them steer your answer, unless the user asks about them or a dated item is due " +
        "(today, or just past).",
    );
  }
  if (o.note) lines.push(lastConversationLine(o.note.at, o.now, o.tz));
  if (note && hasNote) {
    if (note.last) lines.push(`In it you talked about: "${note.last}" (this may be irrelevant now)`);
    if (note.before) lines.push(`Earlier: "${note.before}"`);
    if (note.items.length) lines.push("Calendar notes:", ...note.items.map((i) => `- ${i}`));
  } else if (o.note?.body) {
    lines.push(`Notes: "${o.note.body}" (may be irrelevant now)`);
  }
  if (o.wakeups?.length) lines.push("Wake-ups you have set:", ...o.wakeups.map((w) => `- ${w}`));
  lines.push(
    "Mind the time of day, and whether it is a new day since you last talked. Read linked details only when asked.",
    CONTEXT_END,
  );
  return lines.join("\n");
}

/** The time in front of later messages of a session */
export function timePrefix(now: Date, tz: string): string {
  return `[Time: ${hhmm(now, tz)}]`;
}

/**
 * Who sent the message: the Home Assistant user logged in where it was typed or said (the Home Assistant app, the
 * page). Voice devices have none (their speech-to-text may label the voices instead).
 */
export function userNote(name: string): string {
  return `[Home Assistant user: ${name.replace(/[\[\]]/g, "").trim()}]`;
}

const USER_NOTE = /^\s*\[Home Assistant user: ([^\]]*)\]\s*/;

/** The user named in front of a message (see userNote), if any */
export function noteUser(text: string): string | undefined {
  return USER_NOTE.exec(text.replace(/^\s*\[Time: \d{1,2}:\d{2}\]\s*/, ""))?.[1]?.trim() || undefined;
}

function stripContextBlock(text: string): string {
  const a = text.indexOf(CONTEXT_START);
  const b = text.indexOf(CONTEXT_END);
  return a >= 0 && b > a ? text.slice(0, a) + text.slice(b + CONTEXT_END.length) : text;
}

/** A user message without the context block, time prefix or user note the bridge put in front */
export function stripContext(text: string): string {
  let s = text;
  const a = s.indexOf(CONTEXT_START);
  const b = s.indexOf(CONTEXT_END);
  if (a >= 0 && b > a) s = s.slice(0, a) + s.slice(b + CONTEXT_END.length);
  return s.replace(/^\s*\[Time: \d{1,2}:\d{2}\]\s*/, "").replace(USER_NOTE, "").trim();
}

type Part = { type?: string; text?: string; name?: string; arguments?: Record<string, unknown> };
type Msg = { role?: string; content?: unknown };

const partsOf = (m: Msg): Part[] =>
  typeof m.content === "string" ? [{ type: "text", text: m.content }] : Array.isArray(m.content) ? (m.content as Part[]) : [];

const short = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}...` : s);

/** The conversation as plain lines for the summarizer: what was said, and which tools were used on what */
export function transcript(
  messages: readonly unknown[],
  toolSummary: (name: string, args: Record<string, unknown> | undefined) => string,
): string {
  const lines: string[] = [];
  for (const raw of messages) {
    const m = raw as Msg;
    if (m.role === "user") {
      const raw = partsOf(m).map((p) => (p.type === "text" ? p.text ?? "" : "")).join(" ");
      const text = stripContext(raw);
      const who = noteUser(stripContextBlock(raw));
      if (text) lines.push(`User${who ? ` (${who})` : ""}: ${short(text, 600)}`);
    } else if (m.role === "assistant") {
      for (const p of partsOf(m)) {
        if (p.type === "text" && p.text?.trim()) lines.push(`Assistant: ${short(p.text.trim(), 800)}`);
        if (p.type === "toolCall" && p.name) lines.push(`(tool: ${short(toolSummary(p.name, p.arguments), 200)})`);
      }
    }
  }
  const all = lines.join("\n");
  return all.length > MAX_TRANSCRIPT_CHARS ? `...\n${all.slice(-MAX_TRANSCRIPT_CHARS)}` : all;
}

export interface SummaryInput {
  now: Date;
  tz: string;
  keepDays: number;
  old?: MemoryNote;
  device?: string;
  started: Date;
  transcript: string;
}

export function summaryPrompt(i: SummaryInput): string {
  return `You keep the short-term memory of a voice assistant: a small note it reads at the start of every
conversation, so it knows what happened lately and what is coming up. Rewrite the note after the conversation
below.

${nowLine(i.now, i.tz)}
Calendar: ${calendar(i.now, i.tz)}

Write exactly this, in plain text:
Last conversation: <who the assistant talked to (a name if it was said or is clear, e.g. one of the kids;
otherwise "someone"), on which device, what it was about and what was done, in one to three sentences. Add the link
or file name where details can be read again, e.g. a news article or a note.>
Before that: <one sentence condensing "Last conversation" and "Before that" of the old note, only what may still
matter. Leave the line out if there is nothing.>
Coming up / remember:
- <Weekday d/m, and the time if known>: <the event or thing to remember, and who it concerns>

Rules:
- Dates are absolute, with weekday and day/month from the calendar above: never "tomorrow" or "next week".
- Keep the items of the old note. Drop an item only when its date is more than ${i.keepDays} days ago, or when it
  was cancelled. Past items stay (e.g. "Sun 22/11: Ellie's concert (past)") so the assistant can ask how it went.
  An item without a date stays only while it still matters.
- Add events, plans, appointments, visits and things people said they will do or want remembered. Not small
  talk, and not what the assistant only looked up (that belongs in "Last conversation").
- Items sorted by date, at most 8. If the list is empty, write "- nothing".
- At most 900 characters in total. Nothing else: no heading, no markdown except the "- " items.`;
}

export function summaryMessage(i: SummaryInput): string {
  const old = i.old ? `Old note (written ${dayLabel(i.old.at, i.tz)} ${hhmm(i.old.at, i.tz)}):\n${i.old.body}` : "Old note: (none)";
  return `${old}\n\nConversation (${i.device ? `device ${i.device}, ` : ""}${dayLabel(i.started, i.tz)} ${hhmm(i.started, i.tz)} to ${hhmm(i.now, i.tz)}):\n${i.transcript}`;
}

/** The summarizer's answer as a note body; undefined when it does not look like one */
export function cleanNote(text: string): string | undefined {
  const s = text
    .replace(/^```[a-z]*\n?|```$/g, "")
    .replace(/\*\*/g, "")
    .trim();
  const at = s.indexOf("Last conversation:");
  if (at < 0) return undefined;
  const body = s.slice(at).trim();
  return body.length > MAX_NOTE_CHARS ? body.slice(0, MAX_NOTE_CHARS) : body;
}
