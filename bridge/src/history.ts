/**
 * Past conversations: what pi saved of each one (its session files, one JSON line per entry), as an index the
 * assistant can search, read and delete from (the conversation_* tools), and expiry after a number of days.
 *
 * Only what was said counts: the user's words (without the context block, the time and the bridge's [System: ...]
 * notes) and the assistant's replies. Answers that were started early and thrown away (speculation.ts) are left out:
 * the conversation is the chain of entries leading to the last one.
 */
import fs from "node:fs";
import path from "node:path";
import { stripContext } from "./memory.ts";

export interface Line {
  role: "user" | "assistant";
  text: string;
  /** ms */
  at: number;
}

export interface Conversation {
  /** short id for the tools: the end of pi's session id */
  id: string;
  file: string;
  /** ms */
  started: number;
  ended: number;
  lines: Line[];
}

const ID_LENGTH = 6;

/** Every session file under pi's sessions directory (one folder per working directory) */
export function sessionFiles(dir: string): string[] {
  const out: string[] = [];
  let subs: fs.Dirent[] = [];
  try {
    subs = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const d of subs) {
    const p = path.join(dir, d.name);
    if (d.isDirectory()) out.push(...sessionFiles(p));
    else if (d.name.endsWith(".jsonl")) out.push(p);
  }
  return out;
}

type Part = { type?: string; text?: string };

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return (content as Part[])
    .filter((p) => p.type === "text" && typeof p.text === "string")
    .map((p) => p.text)
    .join(" ");
}

/** The user's words as they said them */
export function cleanUserText(text: string): string {
  return stripContext(text)
    .replace(/\[System:[^\]]*\]\s*/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** One saved conversation, or undefined when the file has nothing said in it */
export function readConversation(file: string): Conversation | undefined {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
  let sessionId = "";
  const byId = new Map<string, any>();
  let last: any;
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let e: any;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    if (e.type === "session") sessionId = String(e.id ?? "");
    if (e.id) byId.set(e.id, e);
    if (e.type === "message") last = e;
  }
  // the chain to the last message (branches left by thrown-away early answers are not part of it)
  const chain: any[] = [];
  for (let e = last; e; e = e.parentId ? byId.get(e.parentId) : undefined) chain.push(e);
  chain.reverse();
  const lines: Line[] = [];
  for (const e of chain) {
    const role = e.message?.role;
    if (role !== "user" && role !== "assistant") continue;
    let text = textOf(e.message.content);
    if (role === "user") text = cleanUserText(text);
    text = text.trim();
    if (!text) continue;
    lines.push({ role, text, at: Date.parse(e.timestamp) || 0 });
  }
  if (!lines.length) return undefined;
  const id = (sessionId || path.basename(file, ".jsonl")).replace(/-/g, "").slice(-ID_LENGTH);
  return { id, file, started: lines[0].at, ended: lines[lines.length - 1].at, lines };
}

/** All saved conversations, newest first */
export function allConversations(dir: string): Conversation[] {
  return sessionFiles(dir)
    .map(readConversation)
    .filter((c): c is Conversation => c !== undefined)
    .sort((a, b) => b.ended - a.ended);
}

export interface SearchOptions {
  /** words to look for (any of them; conversations with more of them first); empty: all */
  query?: string;
  /** ms */
  from?: number;
  to?: number;
  limit?: number;
}

export interface Hit {
  conversation: Conversation;
  /** how many of the query words it has */
  score: number;
  /** lines with a query word (or the first ones) */
  snippets: Line[];
}

const wordsOf = (s: string) =>
  s
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length > 1);

export function search(dir: string, o: SearchOptions = {}): Hit[] {
  const q = [...new Set(wordsOf(o.query ?? ""))];
  const hits: Hit[] = [];
  for (const c of allConversations(dir)) {
    if (o.from !== undefined && c.ended < o.from) continue;
    if (o.to !== undefined && c.started > o.to) continue;
    if (!q.length) {
      hits.push({ conversation: c, score: 0, snippets: c.lines.slice(0, 2) });
      continue;
    }
    const all = new Set(c.lines.flatMap((l) => wordsOf(l.text)));
    const score = q.filter((w) => all.has(w) || [...all].some((a) => a.startsWith(w))).length;
    if (!score) continue;
    const snippets = c.lines.filter((l) => wordsOf(l.text).some((w) => q.some((x) => w.startsWith(x)))).slice(0, 3);
    hits.push({ conversation: c, score, snippets });
  }
  hits.sort((a, b) => b.score - a.score || b.conversation.ended - a.conversation.ended);
  return hits.slice(0, o.limit ?? 10);
}

export function find(dir: string, id: string): Conversation | undefined {
  const want = id.trim().toLowerCase().replace(/-/g, "");
  if (!want) return undefined;
  return allConversations(dir).find((c) => c.id === want || (want.length >= 4 && c.id.endsWith(want)));
}

/** Delete a saved conversation for good. Undefined: no such conversation (or it is in use). */
export function remove(dir: string, id: string, inUse: Set<string> = new Set()): Conversation | undefined {
  const c = find(dir, id);
  if (!c || inUse.has(path.resolve(c.file))) return undefined;
  fs.rmSync(c.file, { force: true });
  return c;
}

/** Delete session files not written to for keepDays (0: keep all), except those in use. Returns the deleted. */
export function expire(dir: string, keepDays: number, inUse: Set<string> = new Set(), now = Date.now()): string[] {
  if (!(keepDays > 0)) return [];
  const out: string[] = [];
  for (const f of sessionFiles(dir)) {
    if (inUse.has(path.resolve(f))) continue;
    try {
      if (now - fs.statSync(f).mtimeMs > keepDays * 86_400_000) {
        fs.rmSync(f, { force: true });
        out.push(f);
      }
    } catch {
      // gone already
    }
  }
  return out;
}

const fmt = (ms: number, tz: string) =>
  new Intl.DateTimeFormat("en-GB", {
    timeZone: tz,
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(ms));

const short = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}...` : s);

/** Search results as text for the assistant */
export function describeHits(hits: Hit[], tz: string): string {
  if (!hits.length) return "No saved conversations match.";
  return hits
    .map((h) => {
      const c = h.conversation;
      const said = h.snippets.map((l) => `  ${l.role === "user" ? "User" : "You"}: ${short(l.text, 160)}`).join("\n");
      return `Conversation ${c.id}, ${fmt(c.started, tz)} (${c.lines.length} messages):\n${said}`;
    })
    .join("\n");
}

/** A whole conversation as text for the assistant (the end of it, when it is long) */
export function describeConversation(c: Conversation, tz: string, maxChars = 8000): string {
  const body = c.lines.map((l) => `${l.role === "user" ? "User" : "You"}: ${l.text}`).join("\n");
  const cut = body.length > maxChars ? `(earlier part left out)\n${body.slice(-maxChars)}` : body;
  return `Conversation ${c.id}, ${fmt(c.started, tz)} to ${fmt(c.ended, tz)}:\n${cut}`;
}
