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
import type { BridgeConfig } from "./config.ts";
import { ensureRouterModel, llamaRouter, routerModelId } from "./llama.ts";
import { buildAssistantSection, loadAssistantPrompt, withToolsSection } from "./prompt.ts";
import { SpeechFilter, toSpeech } from "./speech.ts";
import { TurnTiming } from "./timing.ts";

/**
 * pi's built-in extensions (llama.cpp provider, mcp, tool-search, ...). The pi CLI loads them into every
 * session, but the SDK does not export them, so load them from pi's own files. Settings that disable a
 * built-in ("-builtin:llama.cpp") still apply. Empty if a pi version moves them.
 */
/** The language and instructions of the last real turn, for the startup warm-up (the prompt must match) */
const WARMUP_KEY = "__warmup__";
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

export const BRIDGE_VERSION = "0.4.4";

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
  /** "extension" when running inside pi, "headless" for the stand-alone service */
  mode: string;

  constructor(cfg: BridgeConfig, log: Logger = consoleLogger, mode = "headless") {
    this.cfg = cfg;
    this.log = log;
    this.mode = mode;
    this.reaper = setInterval(() => void this.reap(), 60_000);
    this.reaper.unref();
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
      ...(this.cfg.tools ? { tools: this.cfg.tools } : {}),
    });
    await session.bindExtensions({
      mode: "print",
      onError: (err) => this.log.error(`extension error (${err.extensionPath}): ${err.error}`),
    });
    const entry: Entry = { key, session, lastUsed: Date.now() };
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
    for (const [key, p] of this.entries) {
      const e = await p.catch(() => undefined);
      if (e && !e.run && Date.now() - e.lastUsed > limit) this.dispose(key, e);
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
    const meta = { conversation_id: req.conversation_id, device_id: req.device_id, satellite_id: req.satellite_id };

    // Still working on an earlier (detached) request: queue this one behind it
    if (entry.run) {
      entry.run.meta = meta;
      entry.session.prompt(text, { streamingBehavior: "followUp", expandPromptTemplates: false }).catch((err) => {
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
      await entry.session.prompt(text, { expandPromptTemplates: false });
      await entry.session.waitForIdle();
    } catch (err) {
      error = (err as Error).message;
    }
    clearInterval(timer);
    entry.run = undefined;
    entry.lastUsed = Date.now();

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
    const want = JSON.stringify({ language: req.language, instructions: req.instructions });
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
