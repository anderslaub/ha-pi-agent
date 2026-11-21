/**
 * Turns streamed markdown from the agent into text that sounds right when spoken by a TTS engine.
 *
 * Works incrementally: push() returns whatever can be spoken safely so far, flush() returns the rest.
 * Complete lines are always emitted. A partial line is emitted up to its last sentence end, so streaming
 * TTS can start talking before the paragraph is finished.
 *
 *  - code blocks are dropped (nobody wants code read aloud)
 *  - headings, bullets and numbered list markers are removed
 *  - table separator rows are dropped, table cells are joined with commas
 *  - **bold**, *italic*, `inline code`, ~~strike~~ markers are removed
 *  - [text](url) becomes "text", bare URLs become "a link"
 *  - emojis are removed
 */
export class SpeechFilter {
  private buf = "";
  private inCode = false;
  /** True when the start of the current line was already emitted (line-start rules are done). */
  private lineStarted = false;
  /** Whether a code block was skipped since the last call to takeSkippedCode(). */
  private skippedCode = false;

  push(delta: string): string {
    this.buf += delta;
    let out = "";
    let nl: number;
    while ((nl = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, nl);
      this.buf = this.buf.slice(nl + 1);
      out += this.line(line, true);
      this.lineStarted = false;
    }
    // Partial line: speak complete sentences early (not inside code, tables or a possible fence)
    if (!this.inCode && this.buf.length > 0) {
      const t = this.buf.trimStart();
      if (!t.startsWith("`") && !t.startsWith("|")) {
        const m = /^[\s\S]*[^\d\s][.!?:;](?=\s)/.exec(this.buf);
        if (m && m[0].length > 0) {
          const head = m[0];
          this.buf = this.buf.slice(head.length);
          out += this.line(head, false);
          this.lineStarted = true;
        }
      }
    }
    return out;
  }

  flush(): string {
    const rest = this.buf;
    this.buf = "";
    const out = rest.length > 0 ? this.line(rest, false) : "";
    this.lineStarted = false;
    this.inCode = false;
    return out;
  }

  /** True once if a code block was dropped since the last call. */
  takeSkippedCode(): boolean {
    const s = this.skippedCode;
    this.skippedCode = false;
    return s;
  }

  private line(raw: string, complete: boolean): string {
    if (!this.lineStarted && /^\s*(```|~~~)/.test(raw)) {
      this.inCode = !this.inCode;
      if (this.inCode) this.skippedCode = true;
      return "";
    }
    if (this.inCode) return "";
    let s = raw;
    if (!this.lineStarted) {
      // table rows
      if (/^\s*\|/.test(s)) {
        if (/^\s*\|?[\s:|-]+\|?\s*$/.test(s)) return "";
        const cells = s
          .split("|")
          .map((c) => c.trim())
          .filter((c) => c.length > 0);
        s = cells.join(", ") + ".";
      }
      s = s.replace(/^\s{0,3}#{1,6}\s+(.*)$/, (_m, h: string) => (/[.!?:]$/.test(h) ? h : `${h}.`));
      s = s.replace(/^\s*>\s?/, "");
      s = s.replace(/^\s*[-*+•]\s+/, "");
      s = s.replace(/^\s*(\d+)[.)]\s+/, "$1, ");
      if (/^\s*([-*_])\s*(\1\s*){2,}$/.test(s)) return complete ? "\n" : ""; // horizontal rule
    }
    s = inline(s);
    return complete ? `${s}\n` : s;
  }
}

function inline(s: string): string {
  return s
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1") // images
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1") // links
    .replace(/<?https?:\/\/[^\s)>]*[^\s)>.,!?;:]>?/g, "a link")
    .replace(/`+([^`]*)`+/g, "$1")
    .replace(/`/g, "")
    .replace(/\*\*|__|~~/g, "")
    .replace(/(^|[\s(])\*(?=\S)([^*]*?\S)\*(?=$|[\s.,!?;:)])/g, "$1$2") // *italic*
    .replace(/<\/?[a-zA-Z][^>]*>/g, "") // stray html tags
    .replace(EMOJI, "");
}

/**
 * Emojis (with skin tones, flags, keycaps and joined sequences) and the space before them: a TTS engine
 * either reads them out ("hamster face") or spends a whole synthesis on a moment of noise.
 */
const EMOJI =
  / ?(?:\p{Extended_Pictographic}|\p{Regional_Indicator}|[\u{1F3FB}-\u{1F3FF}\u200D\uFE0E\uFE0F\u20E3])+/gu;

/** Convenience for whole strings. */
export function toSpeech(markdown: string): string {
  const f = new SpeechFilter();
  return (f.push(markdown) + f.flush()).replace(/\n{3,}/g, "\n\n").trim();
}
