/**
 * Starting the answer early. A turn detection service that hears the speaker in real time (partial transcripts,
 * a judge on them) calls POST /v1/prepare as soon as the request looks complete, before Home Assistant has even
 * ended the turn. The bridge starts pi on that text at once, holding back what it says and every tool call. When
 * Home Assistant's request arrives with the same words, the answer that is already under way is adopted; any other
 * words (the speaker went on), or nothing within a while, and the early answer is thrown away: the session is
 * rewound to where it was, as if it never happened.
 */

import { stripLabels } from "./voices.ts";

/** The words of a transcript, for comparing: no voice labels, no punctuation, lower case */
export function words(text: string): string[] {
  return stripLabels(text)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}' ]+/gu, " ")
    .split(/\s+/)
    .filter(Boolean);
}

/** Word-level edit distance */
function distance(a: string[], b: string[]): number {
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = tmp;
    }
  }
  return prev[b.length];
}

/**
 * Do two transcripts say the same request? The early text and Home Assistant's come from the same audio, but
 * maybe not the same speech-to-text pass: one word in ten may differ (at least one).
 */
export function sameRequest(early: string, final: string): boolean {
  const a = words(early);
  const b = words(final);
  if (!a.length || !b.length) return false;
  return distance(a, b) <= Math.max(1, Math.floor(Math.max(a.length, b.length) / 10));
}

/** A gate that holds tool calls until the early answer is adopted (true) or thrown away (false) */
export class Gate {
  readonly opened: Promise<boolean>;
  private resolve!: (ok: boolean) => void;
  settled?: boolean;

  constructor() {
    this.opened = new Promise((r) => (this.resolve = r));
  }

  open(ok: boolean): void {
    if (this.settled !== undefined) return;
    this.settled = ok;
    this.resolve(ok);
  }
}
