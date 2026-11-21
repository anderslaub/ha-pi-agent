/**
 * Timing of one conversation turn, so a slow answer can be pinned on the right step: getting the session,
 * the model (time to first token, generation), tools, or the speech stream to Home Assistant.
 * All times are milliseconds since the turn started. Sent with the "done" event; the integration logs it
 * in debug mode.
 */

export interface LlmCall {
  start: number;
  /** first streamed token of any kind (thinking, text or a tool call) */
  first_token?: number;
  /** first visible text token */
  first_text?: number;
  end?: number;
  /** characters of visible text the model produced in this call */
  chars: number;
}

export interface ToolCall {
  name: string;
  start: number;
  ms?: number;
}

export class TurnTiming {
  private readonly t0 = Date.now();
  session_ready?: number;
  first_text?: number;
  detached?: number;
  done?: number;
  readonly llm: LlmCall[] = [];
  readonly tools: ToolCall[] = [];
  /** when each piece of spoken text was sent */
  private readonly sent: number[] = [];
  private readonly openTools = new Map<string, ToolCall>();

  now(): number {
    return Date.now() - this.t0;
  }

  llmStart(): void {
    this.llm.push({ start: this.now(), chars: 0 });
  }

  llmDelta(chars: number): void {
    let call = this.llm.at(-1);
    if (!call || call.end !== undefined) {
      this.llmStart();
      call = this.llm.at(-1)!;
    }
    call.first_token ??= this.now();
    if (chars > 0) call.first_text ??= this.now();
    call.chars += chars;
  }

  llmEnd(): void {
    const call = this.llm.at(-1);
    if (call && call.end === undefined) call.end = this.now();
  }

  toolStart(id: string, name: string): void {
    const call: ToolCall = { name, start: this.now() };
    this.tools.push(call);
    this.openTools.set(id, call);
  }

  toolEnd(id: string): void {
    const call = this.openTools.get(id);
    if (call) {
      call.ms = this.now() - call.start;
      this.openTools.delete(id);
    }
  }

  textSent(): void {
    const t = this.now();
    this.first_text ??= t;
    this.sent.push(t);
  }

  toJSON() {
    let gap = 0;
    let gapAfter = 0;
    for (let i = 1; i < this.sent.length; i++) {
      if (this.sent[i] - this.sent[i - 1] > gap) {
        gap = this.sent[i] - this.sent[i - 1];
        gapAfter = this.sent[i - 1];
      }
    }
    return {
      session_ready: this.session_ready,
      first_text: this.first_text,
      text_pieces: this.sent.length,
      longest_text_gap: gap,
      longest_text_gap_at: gap ? gapAfter : undefined,
      llm: this.llm,
      tools: this.tools,
      detached: this.detached,
      done: this.done ?? this.now(),
    };
  }
}
