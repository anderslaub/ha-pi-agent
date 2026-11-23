/**
 * Noise screening: wake words also fire on the TV, the radio or people talking to each other, and the assistant
 * then answers whatever it heard and waits for a reply. Before such a turn reaches pi, the bridge judges whether
 * the text was meant for the assistant (nothing of this is stored in the pi session):
 *
 *   stage "first"  the first text after a wake word. Noise: a short sarcastic remark about what was heard that
 *                  asks whether it was meant for the assistant (the conversation stays open for the answer).
 *   stage "retry"  the answer to that remark. Noise again (or "no, that was the TV"): end quietly.
 *
 * The decision is a classifier question ("was this meant for the assistant?" -> probability): TypeSafe's Jev
 * (fast and cheap, used when TYPESAFE_API_KEY is set), or any classifier model pi knows (PI_BRIDGE_SCREEN_MODEL,
 * e.g. the chat model on llama.cpp: "llama.cpp/<id>"). PI_BRIDGE_SCREEN_MODEL=text has the chat model answer TALK /
 * NOISE in text. Without any of these there is no screening. The remark comes from the chat model, thinking off.
 *
 * When in doubt the text counts as meant for the assistant, and any failure lets the turn through.
 */
import type { ClassifierContext } from "@earendil-works/pi-ai";
import { stripLabels } from "./voices.ts";

export type ScreenStage = "first" | "retry";

export interface ScreenPrevious {
  /** what was heard after the wake word */
  heard: string;
  /** the remark the assistant made about it */
  said: string;
}

export interface ScreenInput {
  stage: ScreenStage;
  text: string;
  language?: string;
  /** the assistant prompt: sets the tone of the remark */
  persona?: string;
  previous?: ScreenPrevious;
}

export interface ScreenVerdict {
  verdict: "talk" | "noise";
  /** stage "first", noise: the remark to say (when the verdict came with one) */
  remark?: string;
  /** probability that the text was meant for the assistant (classifier verdicts) */
  probability?: number;
}

/** How much of the assistant prompt goes along for the tone of the remark */
const PERSONA_CHARS = 1500;

const SITUATION = `A voice assistant was woken by its wake word, and the text is the speech-to-text of what the
microphone heard next. Wake words also trigger by mistake on a TV, radio or people talking to each other nearby;
then the text was not meant for the assistant.`;

const MEANT = `Someone speaks to the assistant: a question, request or command (lights, music, timers, weather,
news, anything at all), a greeting, small talk, or an answer to the assistant. Misheard words, odd grammar and short
or unusual requests still count.`;

const NOT_MEANT = `Background speech not meant for the assistant: TV or radio dialogue, news being read, ads, song
lyrics, a narrator, people talking to each other about something else, or a fragment that starts or ends
mid-sentence with no request in it.`;

const RETRY_MEANT = `The user answers the assistant or asks for something: also a plain "yes", or a real request.`;
const RETRY_NOT_MEANT = `Still background speech, or the user says it was not meant for the assistant ("no", "that was
the TV", "never mind").`;

const flat = (s: string) => s.replace(/\s*\n\s*/g, " ");

// ---------------------------------------------------------------------------------------------- classifier

/** The question for a classifier: answer "true" when the text was meant for the assistant */
export function classifierContext(input: ScreenInput): ClassifierContext {
  if (input.stage === "retry") {
    return {
      state: {
        situation: flat(SITUATION),
        heard_after_wake_word: input.previous?.heard ?? "",
        assistant_thought_it_was_noise_and_asked: input.previous?.said ?? "",
        reply_heard_now: input.text,
      },
      questions: {
        meant: {
          type: "bool",
          instructions: "Is the reply heard now meant for the assistant?",
          criteria: { true: flat(RETRY_MEANT), false: flat(RETRY_NOT_MEANT) },
        },
      },
    };
  }
  return {
    state: { situation: flat(SITUATION), heard: input.text },
    questions: {
      meant: {
        type: "bool",
        instructions: "Was the heard text meant for the assistant?",
        criteria: { true: flat(MEANT), false: flat(NOT_MEANT) },
      },
    },
  };
}

// ---------------------------------------------------------------------------------------------- turn end

/**
 * "Has the speaker finished?" for turn detection (a turn detection service asks while the satellite still listens): the text the
 * speaker said so far (with its voice label) and how long they have been quiet. Jev judges the sentence; the
 * timing stays with the caller (it waits longer when the answer is no).
 */
export function completeContext(text: string, silenceMs: number): ClassifierContext {
  return {
    state: {
      situation: flat(`A voice assistant is listening to someone talking to it. Speech-to-text so far, labelled with
who spoke ([Name] for a known voice, [unknown voice] otherwise). Decide whether to answer now or keep listening.`),
      heard_so_far: text,
      silence_since_last_word_ms: String(silenceMs),
    },
    questions: {
      complete: {
        type: "bool",
        instructions: "Has the speaker finished what they wanted to say, so the assistant should answer now?",
        criteria: {
          true: "The request, question or sentence is complete.",
          false: "They are mid-sentence, hesitating, listing, or the request is not complete yet: wait.",
        },
      },
    },
  };
}

/**
 * "Was that meant as an interruption?" for a turn detection service: someone the assistant knows spoke while it
 * was talking (full-duplex satellite). What they said (with their voice label) and what the assistant was saying.
 */
export function interruptContext(text: string, assistantSaid: string): ClassifierContext {
  return {
    state: {
      situation: flat(`A voice assistant is talking (its reply is below). While it talks, a person in the room
said something (speech-to-text, labelled with who spoke). Decide whether they want the assistant to stop and
listen to them now.`),
      assistant_was_saying: assistantSaid.slice(-600) || "(unknown)",
      person_said: text,
    },
    questions: {
      interrupt: {
        type: "bool",
        instructions: "Is the person interrupting the assistant: talking to it, correcting it, or asking it to stop?",
        criteria: {
          true: "They talk to the assistant: a correction, a new request, a question, 'stop', 'wait', 'no'.",
          false: "Background talk, talking to someone else, laughing, singing along, or reacting without wanting to interrupt.",
        },
      },
    },
  };
}

/** The note in front of the next request after an interruption, so the assistant knows where it was cut off */
export function interruptionNote(n: { who?: string; text: string; heard_part?: string }): string {
  const heard = n.heard_part?.trim();
  const who = n.who ? `${n.who}` : "Someone";
  return (
    `[System: ${who} interrupted your previous answer` +
    (heard ? ` after you had said: "${heard.slice(-300)}"` : "") +
    `. They said: "${n.text.trim()}". What follows is the rest of what they said (it may continue that).]`
  );
}

// ---------------------------------------------------------------------------------------------- remark

/** System prompt for the chat model: one sarcastic remark about what was heard */
export function remarkPrompt(input: ScreenInput): string {
  const lang = input.language ? ` Write it in the language "${input.language}".` : "";
  const persona = input.persona?.trim()
    ? `\n\nYour personality:\n"""\n${input.persona.trim().slice(0, PERSONA_CHARS)}\n"""`
    : "";
  return `You are a voice assistant. You were just woken by your wake word, but what you heard next sounds like the TV,
the radio or people talking to each other, not like someone talking to you.

Reply with one short sarcastic remark about what you heard, ending with a question whether that was really meant
for you.${lang} It is read aloud: plain words, no emojis, no quotes, at most two short sentences, nothing else.${persona}`;
}

export function remarkMessage(input: ScreenInput): string {
  // spoken aloud: the words only, not the speaker labels
  return `Heard: "${stripLabels(input.text)}"`;
}

/** The remark as the model wrote it, cleaned up for speech */
export function cleanRemark(text: string): string | undefined {
  const s = text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .join(" ")
    .replace(/^["'“”]+|["'“”]+$/g, "")
    .replace(/\[[^\]]*\]\s*/g, "") // never speak a speaker label
    .trim();
  return s || undefined;
}

// ------------------------------------------------------------------------- text verdict (no classifier)

const JUDGE = `You screen speech for a voice assistant before it answers. ${SITUATION}

TALK: ${MEANT}
NOISE: ${NOT_MEANT}

When in doubt, it is TALK: ignoring a real request is worse than answering the TV.`;

/** System prompt when there is no classifier: the chat model answers TALK, or NOISE (with the remark) */
export function screenPrompt(input: ScreenInput): string {
  const lang = input.language ? ` Write it in the language "${input.language}".` : "";
  if (input.stage === "retry") {
    return `${JUDGE}

Earlier the assistant thought it heard background noise and asked whether that was meant for it. Now judge the
reply. TALK: ${RETRY_MEANT} NOISE: ${RETRY_NOT_MEANT}

Reply with only the word TALK or NOISE.`;
  }
  const persona = input.persona?.trim()
    ? `\n\nThe assistant's personality, for the tone of the remark only:\n"""\n${input.persona.trim().slice(0, PERSONA_CHARS)}\n"""`
    : "";
  return `${JUDGE}

Reply with only the word TALK, or with NOISE followed by one short sarcastic remark from the assistant about what
it just heard, ending with a question whether that was really meant for it.${lang} The remark is read aloud: plain
words, no emojis, at most two short sentences. Format:
NOISE | <remark>${persona}`;
}

export function screenMessage(input: ScreenInput): string {
  if (input.stage === "retry" && input.previous) {
    return `Heard first: "${input.previous.heard}"\nThe assistant asked: "${input.previous.said}"\nReply heard now: "${input.text}"`;
  }
  return `Heard: "${input.text}"`;
}

/** Read the chat model's text verdict. Anything that is not clearly NOISE counts as TALK. */
export function parseVerdict(answer: string, stage: ScreenStage): ScreenVerdict {
  const m = /^[\s*"'`]*(TALK|NOISE)\b[\s*"'`]*[|:\-–—]?\s*([\s\S]*)$/i.exec(answer.trim());
  if (!m || m[1].toUpperCase() !== "NOISE") return { verdict: "talk" };
  if (stage === "retry") return { verdict: "noise" };
  return { verdict: "noise", remark: cleanRemark(m[2]) };
}

// ---------------------------------------------------------------------------------------------- after

/** The text pi gets when the user answered the remark: what happened before, then what they said now */
export function withScreenContext(text: string, previous?: ScreenPrevious): string {
  if (!previous) return text;
  return `[I was woken by background noise, heard "${previous.heard}" and asked: "${previous.said}"] ${text}`;
}
