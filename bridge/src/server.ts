/**
 * pi va-bridge: exposes pi (the coding agent harness) to Home Assistant over HTTP.
 * Runs inside pi (extension.ts, /va-bridge start) or as a stand-alone service (cli.ts).
 *
 *   GET  /v1/health                 -> bridge/pi info
 *   POST /v1/turn                   -> run one conversation turn, streams NDJSON events back
 *   POST /v1/abort                  -> abort whatever a session is doing
 *   GET  /v1/tasks/<task_id>        -> status of a background task (running / done / failed)
 *   GET  /v1/events?since=<id>      -> long-lived NDJSON stream of background task results
 *
 * Each Home Assistant conversation (or device, see session_key) maps to a real pi session that is saved to
 * disk like any other pi session, so a conversation can be picked up later with `pi -r`.
 *
 * Turns have a time budget. When the agent is still busy (tools, research, coding) after the budget,
 * the turn is "detached": Home Assistant gets a short acknowledgement right away, the agent keeps
 * working, and the final answer is published on /v1/events so Home Assistant can announce it.
 */
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID, timingSafeEqual } from "node:crypto";
import {
  createAgentSessionFromServices,
  createAgentSessionServices,
  getAgentDir,
  ModelRuntime,
  resolveCliModel,
  SessionManager,
  SettingsManager,
  VERSION as PI_VERSION,
} from "@earendil-works/pi-coding-agent";
import type { AgentSession, InlineExtension } from "@earendil-works/pi-coding-agent";
import type { Api, ClassifierApi, ClassifierModel, Model } from "@earendil-works/pi-ai";
import type { BridgeConfig } from "./config.ts";
import { ensureRouterModel, llamaRouter, routerModelId } from "./llama.ts";
import { buildAssistantSection, loadAssistantPrompt, withToolsSection } from "./prompt.ts";
import {
  classifierContext,
  cleanRemark,
  parseVerdict,
  remarkMessage,
  remarkPrompt,
  screenMessage,
  screenPrompt,
  withScreenContext,
} from "./screen.ts";
import type { ScreenInput, ScreenPrevious, ScreenStage, ScreenVerdict } from "./screen.ts";
import { SpeechFilter, toSpeech } from "./speech.ts";
import { dayLabel, hhmm, hostTimeZone, parseWhen, validTimeZone } from "./clock.ts";
import {
  cleanNote,
  contextBlock,
  readNote,
  summaryMessage,
  summaryPrompt,
  timePrefix,
  transcript,
  writeNote,
} from "./memory.ts";
import { describeWakeup, MAX_LATE_MS, WakeupStore } from "./wakeups.ts";
import type { Wakeup } from "./wakeups.ts";
import { TurnTiming } from "./timing.ts";

/**
 * pi's built-in extensions (llama.cpp provider, mcp, tool-search, ...). The pi CLI loads them into every
 * session, but the SDK does not export them, so load them from pi's own files. Settings that disable a
 * built-in ("-builtin:llama.cpp") still apply. Empty if a pi version moves them.
 */
/** The language and instructions of the last real turn, for the startup warm-up (the prompt must match) */
const WARMUP_KEY = "__warmup__";
const WAKEUP_TOOLS = ["wakeup_set", "wakeup_list", "wakeup_cancel"];
const warmupFile = () => path.join(getAgentDir(), "va-bridge-warmup.json");

let builtins: Promise<InlineExtension[]> | undefined;
function builtInExtensions(log: Logger): Promise<InlineExtension[]> {
  builtins ??= (async () => {
    try {
      const url = new URL("./extensions/index.js", import.meta.resolve("@earendil-works/pi-coding-agent"));
      const mod = (await import(url.href)) as { builtInExtensions?: InlineExtension[] };
      return mod.builtInExtensions ?? [];
    } catch (err) {
      log.error("could not load pi's built-in extensions (llama.cpp provider, mcp, ...)", err);
      return [];
    }
  })();
  return builtins;
}

export const BRIDGE_VERSION = "0.5.0";

export interface Logger {
  info(msg: string): void;
  error(msg: string, err?: unknown): void;
}

export const consoleLogger: Logger = {
  info: (m) => console.log(`[pi-bridge] ${m}`),
  error: (m, e) => console.error(`[pi-bridge] ${m}`, e ?? ""),
};

// ---------------------------------------------------------------------------------------------- events

interface BridgeEvent {
  id?: number;
  t: string;
  [k: string]: unknown;
}

class EventLog {
  private events: BridgeEvent[] = [];
  private nextId = 1;
  private listeners = new Set<http.ServerResponse>();

  get lastId(): number {
    return this.nextId - 1;
  }

  publish(ev: BridgeEvent): void {
    ev.id = this.nextId++;
    this.events.push(ev);
    if (this.events.length > 200) this.events.shift();
    const line = `${JSON.stringify(ev)}\n`;
    for (const l of this.listeners) l.write(line);
  }

  attach(res: http.ServerResponse, since: number): void {
    for (const ev of this.events) if ((ev.id ?? 0) > since) res.write(`${JSON.stringify(ev)}\n`);
    this.listeners.add(res);
    const ping = setInterval(() => res.write(`${JSON.stringify({ t: "ping", last_id: this.lastId })}\n`), 15_000);
    res.on("close", () => {
      clearInterval(ping);
      this.listeners.delete(res);
    });
  }
}

// -------------------------------------------------------------------------------------------- sessions

interface TurnRequest {
  session_key?: string;
  text?: string;
  language?: string;
  conversation_id?: string;
  device_id?: string | null;
  satellite_id?: string | null;
  instructions?: string;
  budget_s?: number;
  reset_after_s?: number;
  cwd?: string;
  detach_message?: string;
  busy_message?: string;
  /** Home Assistant's time zone, e.g. "Europe/Copenhagen" */
  time_zone?: string;
  /** judge first whether the text was meant for the assistant at all (see screen.ts) */
  screen?: ScreenStage;
  /** stage "retry": what was heard after the wake word and the remark made about it */
  screen_previous?: ScreenPrevious;
}

interface Run {
  taskId: string;
  writer?: http.ServerResponse;
  filter: SpeechFilter;
  detached: boolean;
  lastTextAt: number;
  /** raw text of the last finished assistant message */
  lastAssistant: string;
  spokeSomething: boolean;
  timing: TurnTiming;
  /** stopped for running longer than taskTimeoutMinutes */
  timedOut?: boolean;
  meta: { conversation_id?: string; device_id?: string | null; satellite_id?: string | null };
}

interface Entry {
  key: string;
  session: AgentSession;
  lastUsed: number;
  run?: Run;
  /** answered messages since the last summary for the short-term memory */
  turns: number;
  /** the context block (time, short-term memory) went in front of the first message */
  contextSent: boolean;
  /** when the conversation started, and who it was with (for the summary) */
  started?: number;
  device?: string | null;
  /** the request that created it (language, instructions), for wake-ups set in it */
  language?: string;
  satellite_id?: string | null;
  device_id?: string | null;
}

/** pi's own SYSTEM.md that replaces its base prompt, if any (project before global, like pi) */
function toolSummary(name: string, args: Record<string, unknown> | undefined): string {
  const a = args ?? {};
  const pick = (a.command ?? a.path ?? a.file_path ?? a.query ?? a.url ?? a.pattern) as string | undefined;
  const detail = pick !== undefined ? String(pick) : JSON.stringify(a);
  return `${name}: ${detail.length > 120 ? `${detail.slice(0, 117)}...` : detail}`;
}

function assistantText(message: { role?: string; content?: unknown }): string {
  if (message?.role !== "assistant" || !Array.isArray(message.content)) return "";
  return message.content
    .filter((c: { type?: string }) => c?.type === "text")
    .map((c: { text?: string }) => c.text ?? "")
    .join("");
}

/** A background task as GET /v1/tasks/<id> reports it (finished ones are kept for a while) */
export interface TaskStatus {
  task_id: string;
  session_key: string;
  state: "running" | "done" | "failed";
  started: number;
  seconds: number;
  /** the tool pi is running right now, or ran last */
  tool?: string;
  error?: string;
  /** what pi said at the end (done tasks) */
  text?: string;
}

export class Bridge {
  readonly events = new EventLog();
  private tasks = new Map<string, TaskStatus>();
  /** startup warm-up: running now / has finished at least once */
  private warming = false;
  private warmedUp = false;
  private entries = new Map<string, Promise<Entry>>();
  private modelRuntime?: ModelRuntime;
  private runtimeReady?: Promise<ModelRuntime>;
  private cfg: BridgeConfig;
  private log: Logger;
  private reaper: NodeJS.Timeout;
  private ticker: NodeJS.Timeout;
  readonly wakeups: WakeupStore;
  /** Home Assistant's time zone from the last turn (remembered across restarts in the warm-up file) */
  private haTimeZone?: string;
  /** summaries are written one after the other: each one builds on the note the last one wrote */
  private summaries: Promise<void> = Promise.resolve();
  /** "extension" when running inside pi, "headless" for the stand-alone service */
  mode: string;

  constructor(cfg: BridgeConfig, log: Logger = consoleLogger, mode = "headless") {
    this.cfg = cfg;
    this.log = log;
    this.mode = mode;
    this.reaper = setInterval(() => void this.reap(), 15_000);
    this.reaper.unref();
    try {
      const tz = JSON.parse(fs.readFileSync(warmupFile(), "utf8")).time_zone;
      if (validTimeZone(tz)) this.haTimeZone = tz;
    } catch {
      // no turn yet
    }
    this.wakeups = new WakeupStore(path.join(getAgentDir(), "va-bridge-wakeups.json"));
    this.ticker = setInterval(() => void this.tickWakeups(), 15_000);
    this.ticker.unref();
  }

  /** The assistant's time zone: PI_BRIDGE_TIMEZONE, else Home Assistant's, else the host's */
  get tz(): string {
    if (validTimeZone(this.cfg.timezone)) return this.cfg.timezone;
    return this.haTimeZone ?? hostTimeZone();
  }

  get config(): BridgeConfig {
    return this.cfg;
  }

  get sessionCount(): number {
    return this.entries.size;
  }

  /** Stop all sessions (their files stay on disk) */
  async close(): Promise<void> {
    clearInterval(this.reaper);
    clearInterval(this.ticker);
    for (const [key, p] of this.entries) {
      const e = await p.catch(() => undefined);
      if (e) {
        if (e.run) await e.session.abort().catch(() => {});
        this.dispose(key, e);
      }
    }
    this.entries.clear();
  }

  async health(): Promise<Record<string, unknown>> {
    return {
      ok: true,
      ...(await this.readiness()),
      bridge_version: BRIDGE_VERSION,
      pi_version: PI_VERSION,
      mode: this.mode,
      ...(await this.modelInfo()),
      cwd: this.cfg.cwd,
      time_zone: this.tz,
      assistant_prompt: loadAssistantPrompt(this.cfg.cwd, getAgentDir()).path ?? "built-in",
      sessions: this.entries.size,
      last_event_id: this.events.lastId,
    };
  }

  /** Which model new sessions get, and whether pi has any usable model (logged in / API key) at all */
  private async modelInfo(): Promise<Record<string, unknown>> {
    let model = this.cfg.model;
    if (!model) {
      try {
        const s = SettingsManager.create(this.cfg.cwd, getAgentDir());
        const [provider, id] = [s.getDefaultProvider(), s.getDefaultModel()];
        model = provider && id ? `${provider}/${id} (pi default)` : "pi default";
      } catch {
        model = "pi default";
      }
    }
    try {
      const available = (await (await this.runtime()).getAvailable()).length;
      return available
        ? { model, models_available: available }
        : { model, models_available: 0, warning: "no models available: log in to a provider in pi (/login) or set an API key" };
    } catch {
      return { model };
    }
  }

  private async runtime(): Promise<ModelRuntime> {
    this.runtimeReady ??= (async () => {
      const modelRuntime = await ModelRuntime.create();
      // Providers that come from extensions (such as pi's built-in llama.cpp, configured with LLAMA_BASE_URL /
      // LLAMA_API_KEY) are registered when extensions load: load them once here so health and model
      // resolution know them before the first session.
      try {
        const services = await createAgentSessionServices({
          cwd: this.cfg.cwd,
          agentDir: getAgentDir(),
          modelRuntime,
          resourceLoaderOptions: { extensionFactories: await builtInExtensions(this.log) },
        });
        for (const d of services.diagnostics) if (d.type === "error") this.log.error(d.message);
        await this.refreshModels(modelRuntime);
      } catch (err) {
        this.log.error("loading model providers failed", err);
      }
      this.modelRuntime = modelRuntime;
      return modelRuntime;
    })();
    return this.runtimeReady;
  }

  /** Fetch model lists from providers that discover them over the network (llama.cpp router, ...) */
  private async refreshModels(modelRuntime: ModelRuntime): Promise<void> {
    const r = await modelRuntime.refresh({ allowNetwork: true, force: true, signal: AbortSignal.timeout(15_000) });
    // One line per distinct problem, not one per provider
    const byMessage = new Map<string, string[]>();
    for (const [provider, err] of r.errors) byMessage.set(err.message, [...(byMessage.get(err.message) ?? []), provider]);
    for (const [message, providers] of byMessage) {
      const who = providers.length > 3 ? `${providers.length} providers` : providers.join(", ");
      this.log.error(`model list (${who}): ${message}`);
    }
  }

  private async resolveModel(modelRuntime: ModelRuntime, spec: string) {
    let r = resolveCliModel({ cliModel: spec, modelRuntime });
    // A llama.cpp router lists only loaded models, and pi's list may be stale: make sure the router has the
    // model loaded (one quick request per new session; throws when the router does not have it)
    const router = llamaRouter();
    if (router && (!r.model || r.model.provider === "llama.cpp")) {
      const done = await ensureRouterModel(router, spec);
      if (done) this.log.info(done);
      else if (r.model && !r.warning) return r;
    } else if (r.model) {
      // pi accepts an unknown "provider/id" as a custom id, with a warning
      if (r.warning) this.log.info(r.warning);
      return r;
    }
    // ... or it was loaded since the last refresh
    await this.refreshModels(modelRuntime);
    r = resolveCliModel({ cliModel: spec, modelRuntime });
    if (r.model) return r;
    const available = (await modelRuntime.getAvailable()).map((m) => `${m.provider}/${m.id}`);
    throw new Error(
      `model "${spec}" not found. ` +
        (available.length
          ? `Available: ${available.slice(0, 15).join(", ")}${available.length > 15 ? ", ..." : ""}`
          : "pi has no usable models: check the provider login / API key (and LLAMA_BASE_URL)."),
    );
  }

  private async create(key: string, req: TurnRequest): Promise<Entry> {
    const cwd = req.cwd ? path.resolve(req.cwd.replace(/^~(?=$|\/)/, os.homedir())) : this.cfg.cwd;
    const agentDir = getAgentDir();
    fs.mkdirSync(cwd, { recursive: true });
    const section = buildAssistantSection(cwd, agentDir, { language: req.language, instructions: req.instructions });
    // The assistant prompt replaces pi's base prompt (and pi's own SYSTEM.md). pi then leaves out its tools
    // list, so a hidden inline extension puts it back; it runs after your extensions and keeps their edits.
    const modelRuntime = await this.runtime();
    // the wake-up tools need to know the session's device: they get the entry once it exists
    const holder: { entry?: Entry } = {};
    const services = await createAgentSessionServices({
      cwd,
      agentDir,
      modelRuntime,
      resourceLoaderOptions: {
        systemPromptOverride: () => section.text,
        extensionFactories: [
          ...(await builtInExtensions(this.log)),
          {
            name: "va-bridge-prompt",
            hidden: true,
            factory: (pi) => {
              pi.on("before_agent_start", (event) => ({
                systemPrompt: withToolsSection(event.systemPrompt, event.systemPromptOptions),
              }));
            },
          },
          ...(this.cfg.wakeups
            ? [{ name: "va-bridge-wakeups", hidden: true, factory: (pi: any) => this.registerWakeupTools(pi, holder) }]
            : []),
        ],
      },
    });
    for (const d of services.diagnostics) if (d.type === "error") this.log.error(d.message);
    let model;
    let thinkingLevel = this.cfg.thinking as never;
    if (this.cfg.model) {
      const r = await this.resolveModel(modelRuntime, this.cfg.model);
      model = r.model;
      thinkingLevel ??= r.thinkingLevel as never;
    }
    const { session } = await createAgentSessionFromServices({
      services,
      // the warm-up session leaves no history behind
      sessionManager: key === WARMUP_KEY ? SessionManager.inMemory(cwd) : SessionManager.create(cwd),
      ...(model ? { model } : {}),
      ...(thinkingLevel ? { thinkingLevel } : {}),
      // a restricted tool list (PI_BRIDGE_TOOLS) still gets the bridge's own tools
      ...(this.cfg.tools ? { tools: [...this.cfg.tools, ...(this.cfg.wakeups ? WAKEUP_TOOLS : [])] } : {}),
    });
    await session.bindExtensions({
      mode: "print",
      onError: (err) => this.log.error(`extension error (${err.extensionPath}): ${err.error}`),
    });
    const entry: Entry = {
      key,
      session,
      lastUsed: Date.now(),
      turns: 0,
      contextSent: false,
      language: req.language,
      satellite_id: req.satellite_id,
      device_id: req.device_id,
    };
    holder.entry = entry;
    session.subscribe((event) => this.onEvent(entry, event as never));
    this.log.info(`session ${session.sessionId} for ${key} (cwd ${cwd}, system prompt ${section.path ?? "built-in"})`);
    return entry;
  }

  private async entry(key: string, req: TurnRequest): Promise<Entry> {
    const existing = this.entries.get(key);
    if (existing) {
      const e = await existing.catch(() => undefined);
      const stale = e && !e.run && req.reset_after_s && Date.now() - e.lastUsed > req.reset_after_s * 1000;
      if (e && !stale) return e;
      if (e) this.dispose(key, e);
      else this.entries.delete(key);
    }
    const p = this.create(key, req);
    this.entries.set(key, p);
    p.catch(() => this.entries.delete(key));
    return p;
  }

  private dispose(key: string, e: Entry): void {
    this.entries.delete(key);
    try {
      e.session.dispose();
    } catch (err) {
      this.log.error("dispose failed", err);
    }
  }

  private async reap(): Promise<void> {
    const limit = this.cfg.idleMinutes * 60_000;
    const quiet = Math.max(0.25, this.cfg.summaryAfterMinutes) * 60_000;
    for (const [key, p] of this.entries) {
      const e = await p.catch(() => undefined);
      if (!e || e.run) continue;
      // A conversation that has gone quiet goes into the short-term memory
      if (this.cfg.memory && e.turns > 0 && Date.now() - e.lastUsed > quiet) this.summarize(e);
      if (Date.now() - e.lastUsed > limit) this.dispose(key, e);
    }
  }

  /** The text pi gets: the context block in front of a session's first message, the time in front of later ones */
  private decorate(entry: Entry, text: string): string {
    const now = new Date();
    if (entry.contextSent || (!this.cfg.memory && !this.cfg.wakeups)) {
      return this.cfg.memory ? `${timePrefix(now, this.tz)} ${text}` : text;
    }
    entry.contextSent = true;
    const block = contextBlock({
      now,
      tz: this.tz,
      note: this.cfg.memory ? readNote(this.cfg.memoryFile) : undefined,
      wakeups: this.cfg.wakeups ? this.wakeups.list().map((w) => describeWakeup(w, this.tz)) : undefined,
    });
    return `${block}

${text}`;
  }

  /** Rewrite the short-term memory note with this conversation (queued: one summary at a time) */
  private summarize(entry: Entry): void {
    const turns = entry.turns;
    entry.turns = 0;
    const messages = [...entry.session.messages];
    const model = entry.session.model;
    if (!model) return;
    const started = new Date(entry.started ?? entry.lastUsed);
    const device = entry.device ?? undefined;
    this.summaries = this.summaries.then(async () => {
      const t0 = Date.now();
      try {
        const now = new Date();
        const input = {
          now,
          tz: this.tz,
          keepDays: this.cfg.memoryKeepDays,
          old: readNote(this.cfg.memoryFile),
          device,
          started,
          transcript: transcript(messages, toolSummary),
        };
        const modelRuntime = await this.runtime();
        const msg = await modelRuntime.completeSimple(
          model,
          { systemPrompt: summaryPrompt(input), messages: [{ role: "user", content: summaryMessage(input), timestamp: Date.now() }] },
          { maxTokens: 700, signal: AbortSignal.timeout(90_000) },
        );
        if (msg.stopReason === "error" || msg.stopReason === "aborted") throw new Error(msg.errorMessage || msg.stopReason);
        const body = cleanNote(msg.content.map((c) => (c.type === "text" ? c.text : "")).join(""));
        if (!body) throw new Error("the summary did not have the expected form");
        writeNote(this.cfg.memoryFile, { at: now, body }, this.tz);
        this.log.info(`${entry.key}: short-term memory updated (${turns} messages, ${Date.now() - t0} ms)`);
      } catch (err) {
        this.log.error(`${entry.key}: short-term memory not updated: ${(err as Error).message}`);
      }
    });
  }

  // ------------------------------------------------------------------------------------------ wake-ups

  private registerWakeupTools(pi: any, holder: { entry?: Entry }): void {
    const tz = this.tz;
    const text = (t: string) => ({ content: [{ type: "text", text: t }], details: {} });
    pi.registerTool({
      name: "wakeup_set",
      label: "Set a wake-up",
      description:
        "Wake yourself up later: at that time you speak up by yourself on the voice device you are talking on now, " +
        "e.g. to remind someone of something or to ask how something went. Use it when you are asked to remind or " +
        "wake someone, and now and then by yourself when someone mentions something happening at a certain time " +
        "that you might ask about afterwards. Local time.",
      promptSnippet: "Set a time to speak up by yourself later (reminders, asking how something went)",
      parameters: {
        type: "object",
        properties: {
          when: {
            type: "string",
            description:
              '"YYYY-MM-DD HH:MM", "HH:MM" (the next time it is that time), "thursday 18:30", "tomorrow 06:45", or "in 20 minutes" / "in 2 hours"',
          },
          note: { type: "string", description: "What you want to say or ask then, and to whom (a note for yourself)" },
        },
        required: ["when", "note"],
      },
      execute: async (_id: string, params: { when: string; note: string }) => {
        const now = new Date();
        const at = parseWhen(params.when, now, tz);
        if (!at) return text(`Could not read the time "${params.when}". Use "YYYY-MM-DD HH:MM", "HH:MM" or "in 20 minutes".`);
        if (at.getTime() <= now.getTime()) return text("That time has passed already.");
        const e = holder.entry;
        const w = this.wakeups.add({
          at: at.getTime(),
          note: params.note.trim(),
          satellite_id: e?.run?.meta.satellite_id ?? e?.satellite_id,
          device_id: e?.run?.meta.device_id ?? e?.device_id,
          language: e?.language,
        });
        this.log.info(`wake-up set for ${describeWakeup(w, tz)}`);
        const where = w.satellite_id || w.device_id ? "on this device" : "as a notification (no voice device here)";
        return text(`Wake-up set: ${dayLabel(at, tz)} at ${hhmm(at, tz)}, ${where}. Id ${w.id}.`);
      },
    });
    pi.registerTool({
      name: "wakeup_list",
      label: "List wake-ups",
      description: "The wake-ups you have set, with their ids.",
      promptSnippet: "List the wake-ups you have set",
      parameters: { type: "object", properties: {} },
      execute: async () => {
        const all = this.wakeups.list();
        return text(all.length ? all.map((w) => describeWakeup(w, tz, true)).join("\n") : "No wake-ups are set.");
      },
    });
    pi.registerTool({
      name: "wakeup_cancel",
      label: "Cancel a wake-up",
      description: "Cancel a wake-up by its id (see wakeup_list).",
      promptSnippet: "Cancel a wake-up",
      parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
      execute: async (_id: string, params: { id: string }) => {
        const w = this.wakeups.cancel(params.id);
        return text(w ? `Cancelled: ${describeWakeup(w, tz)}` : `No wake-up with id ${params.id}.`);
      },
    });
  }

  private async tickWakeups(): Promise<void> {
    if (!this.cfg.wakeups) return;
    for (const w of this.wakeups.takeDue()) {
      if (Date.now() - w.at > MAX_LATE_MS) {
        this.log.info(`wake-up missed (the bridge was not running): ${describeWakeup(w, this.tz)}`);
        continue;
      }
      void this.fireWakeup(w);
    }
  }

  /** A short turn of its own for a due wake-up; the reply goes out on the event stream for Home Assistant */
  private async fireWakeup(w: Wakeup): Promise<void> {
    const key = `wakeup:${w.id}`;
    const tz = this.tz;
    let last: Pick<TurnRequest, "language" | "instructions"> = {};
    try {
      last = JSON.parse(fs.readFileSync(warmupFile(), "utf8"));
    } catch {
      // no turn yet since the first start
    }
    try {
      const entry = await this.entry(key, {
        language: w.language ?? last.language,
        instructions: last.instructions,
        satellite_id: w.satellite_id,
        device_id: w.device_id,
      });
      const created = new Date(w.created);
      const prompt = this.decorate(
        entry,
        `[Wake-up] On ${dayLabel(created, tz)} at ${hhmm(created, tz)} you set this wake-up for now: "${w.note}". ` +
          "You now speak up by yourself on the voice device, without being asked. Say it in one or two short " +
          "sentences, as you would to the people in the room. End with a question if you want an answer.",
      );
      entry.started ??= Date.now();
      entry.device = w.satellite_id ?? w.device_id;
      await entry.session.prompt(prompt, { expandPromptTemplates: false });
      await entry.session.waitForIdle();
      entry.lastUsed = Date.now();
      entry.turns++;
      const lastMsg = entry.session.messages.at(-1) as { role?: string; stopReason?: string; errorMessage?: string };
      if (lastMsg?.role === "assistant" && (lastMsg.stopReason === "error" || lastMsg.stopReason === "aborted")) {
        throw new Error(lastMsg.errorMessage || lastMsg.stopReason);
      }
      const speech = toSpeech(assistantText(lastMsg as never));
      if (!speech) throw new Error("no reply");
      this.log.info(`wake-up ${w.id}: ${speech}`);
      this.events.publish({
        t: "wakeup",
        wakeup_id: w.id,
        satellite_id: w.satellite_id,
        device_id: w.device_id,
        session_id: entry.session.sessionId,
        note: w.note,
        text: speech,
      });
    } catch (err) {
      this.log.error(`wake-up ${w.id} failed: ${(err as Error).message}`);
      // still say something: the note itself
      this.events.publish({ t: "wakeup", wakeup_id: w.id, satellite_id: w.satellite_id, device_id: w.device_id, note: w.note, text: w.note });
    }
  }

  private onEvent(entry: Entry, event: { type: string; [k: string]: any }): void {
    const run = entry.run;
    if (!run) return;
    const w = run.detached ? undefined : run.writer;
    switch (event.type) {
      case "message_start":
        if (event.message?.role === "assistant") run.timing.llmStart();
        break;
      case "message_update": {
        const ame = event.assistantMessageEvent;
        if (typeof ame?.delta === "string") run.timing.llmDelta(ame.type === "text_delta" ? ame.delta.length : 0);
        if (ame?.type === "text_delta" && w) {
          const s = run.filter.push(ame.delta);
          if (s) {
            run.lastTextAt = Date.now();
            run.spokeSomething ||= s.trim().length > 0;
            run.timing.textSent();
            w.write(`${JSON.stringify({ t: "text", d: s })}\n`);
          }
        }
        break;
      }
      case "message_end": {
        if (event.message?.role === "assistant") run.timing.llmEnd();
        const txt = assistantText(event.message);
        if (txt) run.lastAssistant = txt;
        if (w && event.message?.role === "assistant") {
          const s = run.filter.flush();
          // separate consecutive assistant messages (e.g. "Let me check." ... tools ... "Done.")
          const sep = s.trim() || run.spokeSomething ? " " : "";
          if (s || sep) w.write(`${JSON.stringify({ t: "text", d: `${s}${sep}` })}\n`);
          run.spokeSomething ||= s.trim().length > 0;
        }
        break;
      }
      case "tool_execution_end":
        run.timing.toolEnd(String(event.toolCallId));
        break;
      case "tool_execution_start":
        if (run.detached) {
          const task = this.tasks.get(run.taskId);
          if (task) task.tool = toolSummary(event.toolName, event.args);
        }
        run.timing.toolStart(String(event.toolCallId), String(event.toolName));
        w?.write(`${JSON.stringify({ t: "activity", d: toolSummary(event.toolName, event.args) })}\n`);
        break;
    }
  }

  async turn(req: TurnRequest, res: http.ServerResponse): Promise<void> {
    const text = (req.text ?? "").trim();
    const key = req.session_key || req.conversation_id || "default";
    res.writeHead(200, { "content-type": "application/x-ndjson", "cache-control": "no-cache" });
    const send = (ev: BridgeEvent) => res.write(`${JSON.stringify(ev)}\n`);
    const timing = new TurnTiming();
    if (validTimeZone(req.time_zone)) this.haTimeZone = req.time_zone;
    this.rememberForWarmup(req);
    let entry: Entry;
    try {
      entry = await this.entry(key, req);
    } catch (err) {
      send({ t: "error", message: `Could not start a pi session: ${(err as Error).message}` });
      res.end();
      return;
    }
    entry.lastUsed = Date.now();
    timing.session_ready = timing.now();

    // Woken by the TV? Then pi never sees this text: a remark about it (first), or a quiet end (retry)
    let prompt = text;
    if (req.screen === "first" || req.screen === "retry") {
      const v = await this.screen(entry, req, text);
      timing.screened = timing.now();
      this.log.info(`${key}: screened (${req.screen}) in ${timing.screened - timing.session_ready} ms: ${v.verdict}`);
      if (v.verdict === "noise") {
        if (req.screen === "first") send({ t: "text", d: toSpeech(v.remark || "Was that meant for me?") });
        timing.done = timing.now();
        send({ t: "done", screened: req.screen === "first" ? "noise" : "dismiss", timing });
        res.end();
        return;
      }
      if (req.screen === "retry") prompt = withScreenContext(text, req.screen_previous);
    }

    const meta = { conversation_id: req.conversation_id, device_id: req.device_id, satellite_id: req.satellite_id };

    prompt = this.decorate(entry, prompt);
    entry.started ??= Date.now();
    entry.device = req.satellite_id ?? req.device_id ?? entry.device;

    // Still working on an earlier (detached) request: queue this one behind it
    if (entry.run) {
      entry.run.meta = meta;
      entry.turns++;
      entry.session.prompt(prompt, { streamingBehavior: "followUp", expandPromptTemplates: false }).catch((err) => {
        this.log.error("follow-up failed", err);
      });
      send({ t: "text", d: req.busy_message || "I'm still working on the last thing. I'll get to that right after." });
      send({ t: "done", queued: true, session_id: entry.session.sessionId });
      res.end();
      return;
    }

    const run: Run = {
      taskId: randomUUID(),
      writer: res,
      filter: new SpeechFilter(),
      detached: false,
      lastTextAt: 0,
      lastAssistant: "",
      spokeSomething: false,
      timing,
      meta,
    };
    entry.run = run;
    const started = Date.now();
    const budgetMs = Math.max(2, req.budget_s ?? this.cfg.defaultBudgetS) * 1000;

    const detach = () => {
      if (run.detached || res.writableEnded) return;
      run.detached = true;
      const rest = run.filter.flush();
      if (rest) send({ t: "text", d: rest });
      timing.detached = timing.now();
      send({
        t: "detached",
        task_id: run.taskId,
        timing,
        d: req.detach_message || "I'm on it. I'll let you know when it's done.",
        session_id: entry.session.sessionId,
      });
      res.end();
      this.tasks.set(run.taskId, { task_id: run.taskId, session_key: key, state: "running", started, seconds: 0 });
      this.log.info(`${key}: turn detached after ${Math.round((Date.now() - started) / 1000)}s`);
    };
    const taskTimeoutMs = Math.max(1, this.cfg.taskTimeoutMinutes) * 60_000;
    // Detach once the budget is used up, but never in the middle of a sentence that is being streamed
    const timer = setInterval(() => {
      const now = Date.now();
      if (now - started > budgetMs && now - run.lastTextAt > 1500) detach();
      // A background task must never run forever (e.g. a model going round in circles with its tools)
      if (run.detached && !run.timedOut && now - started > taskTimeoutMs) {
        run.timedOut = true;
        this.log.info(`${key}: background task stopped after ${this.cfg.taskTimeoutMinutes} min`);
        void entry.session.abort();
      }
    }, 250);

    res.on("close", () => {
      if (!run.detached && !res.writableFinished && entry.run === run) {
        this.log.info(`${key}: client went away, aborting`);
        void entry.session.abort();
      }
    });

    let error: string | undefined;
    try {
      await entry.session.prompt(prompt, { expandPromptTemplates: false });
      await entry.session.waitForIdle();
    } catch (err) {
      error = (err as Error).message;
    }
    clearInterval(timer);
    entry.run = undefined;
    entry.lastUsed = Date.now();
    entry.turns++;

    const last = entry.session.messages.at(-1) as { role?: string; stopReason?: string; errorMessage?: string };
    if (!error && last?.role === "assistant" && (last.stopReason === "error" || last.stopReason === "aborted")) {
      error = last.errorMessage || `Request ${last.stopReason}`;
    }
    if (run.timedOut) {
      error = `it was still not done after ${this.cfg.taskTimeoutMinutes} minutes, so I stopped it`;
    }

    if (!run.detached) {
      const rest = run.filter.flush();
      if (rest) send({ t: "text", d: rest });
      if (error) send({ t: "error", message: error });
      timing.done = timing.now();
      send({ t: "done", session_id: entry.session.sessionId, timing });
      res.end();
      return;
    }
    const speech = toSpeech(run.lastAssistant);
    this.events.publish({
      t: error ? "task_failed" : "task_done",
      task_id: run.taskId,
      session_key: key,
      session_id: entry.session.sessionId,
      ...run.meta,
      text: error ? undefined : speech,
      error,
      seconds: Math.round((Date.now() - started) / 1000),
    });
    const task = this.tasks.get(run.taskId);
    if (task) {
      task.state = error ? "failed" : "done";
      task.error = error;
      task.text = error ? undefined : speech;
      task.seconds = Math.round((Date.now() - started) / 1000);
    }
    this.log.info(`${key}: background task ${error ? "failed" : "done"}`);
  }

  /**
   * Was the text meant for the assistant? A classifier question (see screen.ts), else one short text verdict from
   * the chat model. Nothing goes into the session. Any failure lets the turn through.
   */
  private async screen(entry: Entry, req: TurnRequest, text: string): Promise<ScreenVerdict> {
    const model = entry.session.model;
    if (!model) return { verdict: "talk" };
    const cwd = req.cwd ? path.resolve(req.cwd.replace(/^~(?=$|\/)/, os.homedir())) : this.cfg.cwd;
    const input: ScreenInput = {
      stage: req.screen!,
      text,
      language: req.language,
      persona: loadAssistantPrompt(cwd, getAgentDir()).text,
      previous: req.screen_previous,
    };
    const modelRuntime = await this.runtime();
    const textVerdict = this.cfg.screenModel?.trim() === "text";
    const classifier = textVerdict
      ? undefined
      : await this.screenClassifier(modelRuntime, model).catch((err) => {
          this.log.error(`noise screening: ${(err as Error).message}`);
          return undefined;
        });
    // optional: without a classifier (no TypeSafe key, no PI_BRIDGE_SCREEN_MODEL) every turn goes through
    if (!classifier && !textVerdict) return { verdict: "talk" };
    try {
      if (classifier) {
        const r = await modelRuntime.classify(classifier, classifierContext(input), { signal: AbortSignal.timeout(10_000) });
        if (r.stopReason !== "stop") throw new Error(r.errorMessage || r.stopReason);
        const answer = r.answers.meant;
        if (answer?.type !== "bool") throw new Error("the classifier gave no answer");
        const probability = answer.probability;
        this.log.info(`noise screening (${classifier.provider}/${classifier.id}): meant for the assistant ${probability.toFixed(2)}`);
        if (probability >= this.cfg.screenThreshold) return { verdict: "talk", probability };
        if (input.stage === "retry") return { verdict: "noise", probability };
        return { verdict: "noise", probability, remark: await this.remark(modelRuntime, model, input) };
      }
      const msg = await modelRuntime.completeSimple(
        model,
        { systemPrompt: screenPrompt(input), messages: [{ role: "user", content: screenMessage(input), timestamp: Date.now() }] },
        { maxTokens: 120, signal: AbortSignal.timeout(20_000) },
      );
      if (msg.stopReason === "error" || msg.stopReason === "aborted") throw new Error(msg.errorMessage || msg.stopReason);
      return parseVerdict(msg.content.map((c) => (c.type === "text" ? c.text : "")).join(""), input.stage);
    } catch (err) {
      this.log.error(`noise screening failed, letting the turn through: ${(err as Error).message}`);
      return { verdict: "talk" };
    }
  }

  /**
   * The classifier for noise screening: PI_BRIDGE_SCREEN_MODEL, else TypeSafe's Jev when a TypeSafe API key is set,
   * else none (no screening).
   */
  private async screenClassifier(
    modelRuntime: ModelRuntime,
    chat: Model<Api>,
  ): Promise<ClassifierModel<ClassifierApi> | undefined> {
    const find = (provider: string, id: string) => modelRuntime.getModelOfType("classifier", provider, id);
    const spec = this.cfg.screenModel?.trim();
    if (spec) {
      if (spec === "text" || spec === "off") return undefined;
      const slash = spec.indexOf("/");
      const [provider, id] = slash > 0 ? [spec.slice(0, slash), spec.slice(slash + 1)] : [chat.provider, spec];
      let found = find(provider, id);
      const router = llamaRouter();
      if (!found && provider === "llama.cpp" && router) {
        // a classifier model on the router is listed once it is loaded
        const done = await ensureRouterModel(router, `llama.cpp/${id}`);
        if (done) this.log.info(done);
        await this.refreshModels(modelRuntime);
        found = find(provider, id);
      }
      if (!found) throw new Error(`classifier model "${spec}" not found (PI_BRIDGE_SCREEN_MODEL)`);
      return found;
    }
    if (modelRuntime.hasConfiguredAuth("typesafe")) return find("typesafe", "jev-latest");
    return undefined;
  }

  /** The chat model's sarcastic remark about what it heard (thinking off); undefined when that fails */
  private async remark(modelRuntime: ModelRuntime, model: Model<Api>, input: ScreenInput): Promise<string | undefined> {
    try {
      const msg = await modelRuntime.completeSimple(
        model,
        { systemPrompt: remarkPrompt(input), messages: [{ role: "user", content: remarkMessage(input), timestamp: Date.now() }] },
        { maxTokens: 100, signal: AbortSignal.timeout(15_000) },
      );
      if (msg.stopReason === "error" || msg.stopReason === "aborted") throw new Error(msg.errorMessage || msg.stopReason);
      return cleanRemark(msg.content.map((c) => (c.type === "text" ? c.text : "")).join(""));
    } catch (err) {
      this.log.error(`noise remark failed: ${(err as Error).message}`);
      return undefined;
    }
  }

  /**
   * One throwaway turn with the same system prompt and tools as real turns (language and Home Assistant's
   * instructions from the last real turn), so the model server has that long prompt cached: otherwise the
   * first question after a restart waits for the whole prompt to be processed.
   */
  async warmUp(): Promise<void> {
    if (!this.cfg.warmup || this.warming) return;
    this.warming = true;
    const started = Date.now();
    let last: Pick<TurnRequest, "language" | "instructions"> = {};
    try {
      last = JSON.parse(fs.readFileSync(warmupFile(), "utf8"));
    } catch {
      // first start: warm up without them
    }
    let entry: Entry | undefined;
    try {
      entry = await this.entry(WARMUP_KEY, { language: last.language, instructions: last.instructions });
      const session = entry.session;
      // The model may still be loading (llama.cpp router): a failed attempt is retried, and only a real answer
      // counts, so the warm-up never runs on in the background next to the first real question
      for (let attempt = 1; ; attempt++) {
        let error: string | undefined;
        try {
          await session.prompt("This is a warm-up message. Reply with just: OK", { expandPromptTemplates: false });
          await session.waitForIdle();
          while (!session.isIdle) await new Promise((r) => setTimeout(r, 200));
          const lastMsg = session.messages.at(-1) as { role?: string; stopReason?: string; errorMessage?: string };
          if (lastMsg?.role === "assistant" && (lastMsg.stopReason === "error" || lastMsg.stopReason === "aborted")) {
            error = lastMsg.errorMessage || lastMsg.stopReason;
          }
        } catch (err) {
          error = (err as Error).message;
        }
        if (!error) break;
        if (attempt >= 5 || Date.now() - started > 300_000) throw new Error(error);
        this.log.info(`warm-up attempt ${attempt} failed (${error}); retrying`);
        await new Promise((r) => setTimeout(r, 3000));
      }
      this.log.info(`warm-up done in ${((Date.now() - started) / 1000).toFixed(1)}s`);
    } catch (err) {
      this.log.error("warm-up failed", (err as Error).message);
    } finally {
      if (entry) this.dispose(WARMUP_KEY, entry);
      this.warming = false;
      this.warmedUp = true;
    }
  }

  /**
   * Whether the assistant answers without a long wait: the warm-up has finished, and the model is loaded on the
   * llama.cpp router (if one is used). When the router has unloaded the model (or was restarted), this starts a
   * new warm-up. Voice satellites show "loading" while ready is false.
   */
  private async readiness(): Promise<{ ready: boolean; loading?: string }> {
    const warmupApplies = this.cfg.warmup && this.mode === "headless";
    const router = llamaRouter();
    let model: string | undefined;
    if (router && this.cfg.model) {
      try {
        const models = await router.list();
        const id = routerModelId(this.cfg.model, models.map((m) => m.id));
        const status = models.find((m) => m.id === id)?.status;
        if (id && status !== "loaded" && status !== "sleeping") model = `the model is ${status ?? "not loaded"}`;
      } catch {
        model = "the model server is not reachable";
      }
    }
    if (model && warmupApplies && !this.warming && model !== "the model server is not reachable") {
      void this.warmUp(); // loads the model and fills the prompt cache again
    }
    if (model) return { ready: false, loading: model };
    if (warmupApplies && (this.warming || !this.warmedUp)) return { ready: false, loading: "warming up" };
    return { ready: true };
  }

  private rememberForWarmup(req: TurnRequest): void {
    const want = JSON.stringify({ language: req.language, instructions: req.instructions, time_zone: this.haTimeZone });
    try {
      if (fs.existsSync(warmupFile()) && fs.readFileSync(warmupFile(), "utf8") === want) return;
      fs.writeFileSync(warmupFile(), want);
    } catch {
      // only an optimisation
    }
  }

  /** Status of a background task: running, done or failed; undefined when unknown (or long forgotten) */
  task(id: string): TaskStatus | undefined {
    const now = Date.now();
    for (const [tid, t] of this.tasks) {
      if (t.state !== "running" && now - t.started - t.seconds * 1000 > 3_600_000) this.tasks.delete(tid);
    }
    const t = this.tasks.get(id);
    if (t?.state === "running") t.seconds = Math.round((now - t.started) / 1000);
    return t;
  }

  async abort(key: string): Promise<boolean> {
    const p = this.entries.get(key);
    const e = p && (await p.catch(() => undefined));
    if (!e) return false;
    await e.session.abort();
    return true;
  }
}

// ------------------------------------------------------------------------------------------------ http

function authorized(req: http.IncomingMessage, token: string): boolean {
  const h = req.headers.authorization ?? "";
  const given = Buffer.from(h.startsWith("Bearer ") ? h.slice(7) : "");
  const want = Buffer.from(token);
  return given.length === want.length && timingSafeEqual(given, want);
}

async function readJson(req: http.IncomingMessage): Promise<any> {
  let body = "";
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 1_000_000) throw new Error("body too large");
  }
  return body ? JSON.parse(body) : {};
}

export function createServer(cfg: BridgeConfig, bridge: Bridge, log: Logger = consoleLogger): http.Server {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://bridge");
    const json = (code: number, obj: unknown) => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify(obj));
    };
    try {
      if (!authorized(req, cfg.token)) return json(401, { error: "unauthorized" });
      if (req.method === "GET" && url.pathname === "/v1/health") return json(200, await bridge.health());
      if (req.method === "POST" && url.pathname === "/v1/turn") {
        const body = await readJson(req);
        if (typeof body.text !== "string" || !body.text.trim()) return json(400, { error: "text is required" });
        return await bridge.turn(body, res);
      }
      if (req.method === "GET" && url.pathname.startsWith("/v1/tasks/")) {
        const task = bridge.task(decodeURIComponent(url.pathname.slice("/v1/tasks/".length)));
        return task ? json(200, task) : json(404, { error: "unknown task" });
      }
      if (req.method === "POST" && url.pathname === "/v1/abort") {
        const body = await readJson(req);
        return json(200, { aborted: await bridge.abort(String(body.session_key ?? "")) });
      }
      if (req.method === "GET" && url.pathname === "/v1/events") {
        res.writeHead(200, { "content-type": "application/x-ndjson", "cache-control": "no-cache" });
        const since = url.searchParams.has("since") ? Number(url.searchParams.get("since")) : bridge.events.lastId;
        bridge.events.attach(res, Number.isFinite(since) ? since : bridge.events.lastId);
        res.write(`${JSON.stringify({ t: "hello", last_id: bridge.events.lastId })}\n`);
        return;
      }
      return json(404, { error: "not found" });
    } catch (err) {
      log.error("request failed", err);
      if (!res.headersSent) json(500, { error: (err as Error).message });
      else res.end();
    }
  });
}

export interface RunningBridge {
  bridge: Bridge;
  server: http.Server;
  url: string;
  stop(): Promise<void>;
}

/** Start the HTTP server. Rejects when the port is taken. */
export function startBridge(cfg: BridgeConfig, log: Logger = consoleLogger, mode = "headless"): Promise<RunningBridge> {
  const bridge = new Bridge(cfg, log, mode);
  const server = createServer(cfg, bridge, log);
  return new Promise((resolve, reject) => {
    server.once("error", (err) => {
      void bridge.close();
      reject(err);
    });
    server.listen(cfg.port, cfg.host, () => {
      const host = cfg.host === "0.0.0.0" || cfg.host === "::" ? os.hostname() : cfg.host;
      log.info(`${BRIDGE_VERSION} (pi ${PI_VERSION}) listening on ${cfg.host}:${cfg.port}, cwd ${cfg.cwd}`);
      void bridge
        .health()
        .then((h) => log.info(`model ${h.model}${h.warning ? `. WARNING: ${h.warning}` : ""}`))
        .then(() => (mode === "headless" ? bridge.warmUp() : undefined));
      resolve({
        bridge,
        server,
        url: `http://${host}:${cfg.port}`,
        stop: async () => {
          server.closeAllConnections();
          await new Promise<void>((r) => server.close(() => r()));
          await bridge.close();
          log.info("stopped");
        },
      });
    });
  });
}
