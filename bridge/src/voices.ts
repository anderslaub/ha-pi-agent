/**
 * Who is speaking. A speech-to-text with speaker recognition names who said what:
 *
 *   [Anders] tænd lyset i stuen [unknown voice 3f2a] og nu til vejret
 *
 * The voice that starts the turn (the one that said the wake word) is the speaker. Later stretches by voices
 * nobody knows are dropped: that is the TV, the radio, or someone in the background. Known voices stay, they
 * may be part of the conversation. When the speaker's own voice is unknown, the assistant asks who is speaking
 * (once per voice per day) and remembers the answer with the voice_learn tool, which names the voice in the
 * speaker recognition service.
 *
 * The labels: "[Name] " for a known voice, "[unknown voice <4 hex>] " for one that is not (the id stays the same
 * for that voice for a while). The speaker recognition service's API (any service with it works; wygate has it):
 *   GET  speakers                          {known: [{name, count}], recent: [{id, last_seen}]}
 *   POST speakers/learn   {voice, name}    name an unknown voice (or add to a known one)
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

/** Unknown voices the assistant asked about lately (id -> when): it asks each one once a day */
export class AskedVoices {
  private asked = new Map<string, number>();
  private readonly ttlMs: number;

  constructor(ttlMs = 24 * 3600_000) {
    this.ttlMs = ttlMs;
  }

  /** True the first time for this voice (within a day): the assistant should ask who it is */
  shouldAsk(id: string, now = Date.now()): boolean {
    for (const [k, t] of this.asked) if (now - t > this.ttlMs) this.asked.delete(k);
    if (this.asked.has(id)) return false;
    this.asked.set(id, now);
    return true;
  }
}

/** The note in front of the user's words when the speaker's voice is unknown */
export function unknownSpeakerNote(id: string, ask: boolean): string {
  if (ask) {
    return (
      `[System: the voice speaking (unknown voice ${id}) is not one you know yet. Ask who is speaking before ` +
      `anything else, in a few words. When they tell you, remember it with voice_learn (voice "${id}"), then ` +
      "do what they asked. If they are a guest or would rather not say, just carry on.]"
    );
  }
  return `[System: unknown voice ${id}. If they have told you who they are, remember it with voice_learn (voice "${id}").]`;
}

/** The tool text about labels, for the assistant */
export const LABELS_EXPLAINED =
  "What you hear is labelled with who said it: [Name] for a voice you know, [unknown voice 3f2a] for one you " +
  "do not. Background voices nobody knows (TV, radio) are already left out.";

/** The speaker recognition service (see the top of this file) */
export class VoiceIndexClient {
  readonly baseUrl: string;
  private readonly token?: string;

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
    return this.call("speakers/learn", { voice, name });
  }

  forget(name: string): Promise<unknown> {
    return this.call("speakers/forget", { name });
  }

  list(): Promise<{ known: { name: string; count: number }[]; recent: { id: string; last_seen: number }[] }> {
    return this.call("speakers");
  }
}
