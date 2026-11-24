/**
 * Who is speaking. A speech-to-text with speaker recognition names who said what:
 *
 *   [Anders] tænd lyset i stuen [unknown voice 3f2a] og nu til vejret
 *
 * The voice that starts the turn (the one that said the wake word) is the speaker. Later stretches by voices
 * nobody knows are dropped: that is the TV, the radio, or someone in the background. Known voices stay, they
 * may be part of the conversation. When the speaker's own voice is unknown, the assistant asks who is speaking
 * (once, and again only after a while: PI_BRIDGE_VOICE_ASK_AGAIN_DAYS) and remembers the answer with the
 * voice_learn tool, which names the voice in the speaker recognition service. A voice that stays unnamed (a guest)
 * is still recognised later: the assistant is told it has heard it before.
 *
 * The labels: "[Name] " for a known voice, "[unknown voice <4 hex>] " for one that is not (the id stays the same
 * for that voice for a while). The speaker recognition service's API (any service with it works; wygate has it):
 *   GET  speakers                          {known: [{name, count}], recent: [{id, count, first_seen, last_seen,
 *                                          asked}]} (times in epoch seconds; asked: when the assistant asked)
 *   POST speakers/learn   {voice, name}    name an unknown voice (or add to a known one)
 *   POST speakers/asked   {voice}          the assistant asked who it is (optional: else kept in memory here)
 *   POST speakers/forget  {name}           a known voice by name, or an unknown one by its id
 * with an optional bearer token.
 */

export interface VoicePart {
  /** the name for a known voice */
  name?: string;
  /** the id of an unknown voice ("3f2a") */
  id?: string;
  text: string;
}

const LABEL = /\[(?:unknown voice ([0-9a-f]{4})|([^\]\[]{1,40}))\]\s*/gi;

/** The labelled parts of a transcript; undefined when the text has no labels at its start */
export function parseLabels(text: string): VoicePart[] | undefined {
  const s = text.trim();
  if (!s.startsWith("[")) return undefined;
  const parts: VoicePart[] = [];
  const marks = [...s.matchAll(LABEL)];
  if (!marks.length || marks[0].index !== 0) return undefined;
  for (let i = 0; i < marks.length; i++) {
    const m = marks[i];
    const from = m.index! + m[0].length;
    const to = i + 1 < marks.length ? marks[i + 1].index! : s.length;
    const said = s.slice(from, to).trim();
    if (!said) continue;
    parts.push(m[1] ? { id: m[1].toLowerCase(), text: said } : { name: m[2].trim(), text: said });
  }
  return parts.length ? parts : undefined;
}

/** The words only, without the labels */
export function stripLabels(text: string): string {
  const parts = parseLabels(text);
  return parts ? parts.map((p) => p.text).join(" ") : text;
}

export const voiceLabel = (p: VoicePart) => (p.name ? p.name : `unknown voice ${p.id}`);

const sameVoice = (a: VoicePart, b: VoicePart) => (a.name ? a.name === b.name : a.id === b.id);

export interface Filtered {
  text: string;
  /** who started the turn */
  speaker?: VoicePart;
  /** what was left out (later unknown voices) */
  dropped: VoicePart[];
}

/** Keep the speaker (the first voice) and known voices; drop later stretches by other unknown voices */
export function filterVoices(text: string): Filtered {
  const parts = parseLabels(text);
  if (!parts) return { text, dropped: [] };
  const speaker = parts[0];
  const kept: VoicePart[] = [];
  const dropped: VoicePart[] = [];
  for (const p of parts) {
    if (sameVoice(p, speaker) || p.name) {
      const last = kept[kept.length - 1];
      if (last && sameVoice(last, p)) last.text = `${last.text} ${p.text}`;
      else kept.push({ ...p });
    } else dropped.push(p);
  }
  return { text: kept.map((p) => `[${voiceLabel(p)}] ${p.text}`).join(" "), speaker, dropped };
}

/** Whose voice starts the text: one the assistant knows by name, an unknown one, or no labels (no speaker recognition) */
export function speakerKind(text: string): "known" | "unknown" | undefined {
  const first = parseLabels(text)?.[0];
  if (!first || first.name === "?") return undefined;
  return first.name ? "known" : "unknown";
}

export interface UnknownVoice {
  id: string;
  /** how many stretches of speech were matched to it */
  count?: number;
  /** epoch seconds */
  first_seen?: number;
  last_seen?: number;
  /** when the assistant last asked who it is (epoch seconds) */
  asked?: number | null;
}

export interface AskDecision {
  ask: boolean;
  /** what the speaker recognition service knows about the voice */
  voice?: UnknownVoice;
  /** when it was asked before (ms), if it was */
  askedBefore?: number;
}

/**
 * Whether to ask an unknown voice who it is: never asked, or asked longer than askAgainMs ago. When it was asked is
 * kept by the speaker recognition service (POST speakers/asked), so it lasts as long as the voice is remembered
 * there; a service without that route: in memory here (until the bridge restarts).
 */
export class VoiceAsker {
  private local = new Map<string, number>();
  private readonly client: Pick<VoiceIndexClient, "list" | "asked">;
  private readonly askAgainMs: number;

  constructor(client: Pick<VoiceIndexClient, "list" | "asked">, askAgainMs: number) {
    this.client = client;
    this.askAgainMs = askAgainMs;
  }

  async decide(id: string, now = Date.now()): Promise<AskDecision> {
    let voice: UnknownVoice | undefined;
    try {
      voice = (await this.client.list()).recent.find((v) => v.id === id);
    } catch {
      // the service is unreachable: decide from memory
    }
    const stored = voice?.asked ? voice.asked * 1000 : undefined;
    const askedBefore = Math.max(stored ?? -Infinity, this.local.get(id) ?? -Infinity);
    const before = Number.isFinite(askedBefore) ? askedBefore : undefined;
    const ask = before === undefined || now - before >= this.askAgainMs;
    if (ask) {
      this.local.set(id, now);
      await this.client.asked(id).catch(() => undefined);
    }
    return { ask, voice, askedBefore: before };
  }
}

const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** The note in front of the user's words when the speaker's voice is unknown */
export function unknownSpeakerNote(id: string, d: boolean | AskDecision, now = Date.now(), playing?: string): string {
  const decision: AskDecision = typeof d === "boolean" ? { ask: d } : d;
  const v = decision.voice;
  // heard before this conversation: more than a few stretches, first more than an hour ago
  const known = v?.first_seen && now - v.first_seen * 1000 > 3600_000 && (v.count ?? 1) > 1;
  const heard = known
    ? ` You have heard this voice before (first on ${day(v!.first_seen! * 1000)}, ${v!.count} times), but never ` +
      "learned whose it is."
    : "";
  const askedNote = decision.askedBefore ? ` You asked who it was on ${day(decision.askedBefore)}.` : "";
  // an unknown voice is as likely the TV as a guest: first decide whether it talks to you at all
  const notForYou =
    " It may well be the TV, the radio or someone talking to somebody else: first decide whether this was said " +
    "to you. If it was not, call not_for_me (with a short offhand remark, or none to stay quiet) and say nothing " +
    "else; do not answer it, look anything up or ask who it is.";
  const media = playing ? ` ${playing}` : "";
  if (decision.ask) {
    return (
      `[System: the voice speaking (unknown voice ${id}) is not one you know by name.${heard}${askedNote}${media}${notForYou} ` +
      `If it was said to you, ask who is speaking before anything else, in a few words. When they tell you, ` +
      `remember it with voice_learn (voice "${id}"), then do what they asked. If they are a guest or would rather ` +
      `not say, just carry on.]`
    );
  }
  return (
    `[System: unknown voice ${id}.${heard}${askedNote}${media}${notForYou} Do not ask who it is again. If they tell you ` +
    `who they are, remember it with voice_learn (voice "${id}").]`
  );
}

/** The tool text about labels, for the assistant */
export const LABELS_EXPLAINED =
  "What you hear is labelled with who said it: [Name] for a voice you know, [unknown voice 3f2a] for one you " +
  "do not. Background voices nobody knows (TV, radio) are already left out, except when such a voice is all you " +
  "heard: then it is often the TV. Speaker recognition also misses now and then, so a voice you know can come " +
  "labelled unknown.";

/** The speaker recognition service (see the top of this file) */
export class VoiceIndexClient {
  readonly baseUrl: string;
  private readonly token?: string;
  private cached?: { at: number; data: any };

  constructor(baseUrl: string, token?: string) {
    this.baseUrl = baseUrl;
    this.token = token;
  }

  private async call(path: string, body?: unknown): Promise<any> {
    const res = await fetch(new URL(path, this.baseUrl.replace(/\/?$/, "/")), {
      method: body ? "POST" : "GET",
      headers: {
        ...(body ? { "content-type": "application/json" } : {}),
        ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(5000),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(typeof data?.detail === "string" ? data.detail : `HTTP ${res.status}`);
    return data;
  }

  learn(voice: string, name: string): Promise<{ name: string; count: number }> {
    this.cached = undefined;
    return this.call("speakers/learn", { voice, name });
  }

  forget(name: string): Promise<unknown> {
    this.cached = undefined;
    return this.call("speakers/forget", { name });
  }

  /** The listing, cached for a few seconds (it is read on every turn by an unknown voice) */
  async list(): Promise<{ known: { name: string; count: number }[]; recent: UnknownVoice[] }> {
    if (this.cached && Date.now() - this.cached.at < 5000) return this.cached.data;
    const data = await this.call("speakers");
    this.cached = { at: Date.now(), data };
    return data;
  }

  asked(voice: string): Promise<UnknownVoice> {
    this.cached = undefined;
    return this.call("speakers/asked", { voice });
  }
}
