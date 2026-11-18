/**
 * pi va-bridge: exposes pi (the coding agent harness) to Home Assistant over HTTP.
 * Runs inside pi (extension.ts, /va-bridge start) or as a stand-alone service (cli.ts).
 *
 *   GET  /v1/health                 -> bridge/pi info
 *   POST /v1/turn                   -> run one conversation turn, streams NDJSON events back
 *   POST /v1/abort                  -> abort whatever a session is doing
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
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  ModelRuntime,
  resolveCliModel,
  SessionManager,
  VERSION as PI_VERSION,
} from "@earendil-works/pi-coding-agent";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { BridgeConfig } from "./config.ts";
import { buildAssistantSection, loadAssistantPrompt } from "./prompt.ts";
import { SpeechFilter, toSpeech } from "./speech.ts";

export const BRIDGE_VERSION = "0.2.0";

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
  meta: { conversation_id?: string; device_id?: string | null; satellite_id?: string | null };
}

interface Entry {
  key: string;
  session: AgentSession;
  lastUsed: number;
  run?: Run;
}

/** pi's own SYSTEM.md that replaces its base prompt, if any (project before global, like pi) */
function piSystemMd(cwd: string, agentDir: string): string | undefined {
  return [path.join(cwd, ".pi", "SYSTEM.md"), path.join(agentDir, "SYSTEM.md")].find((p) => fs.existsSync(p));
}

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

export class Bridge {
  readonly events = new EventLog();
  private entries = new Map<string, Promise<Entry>>();
  private modelRuntime?: ModelRuntime;
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
      bridge_version: BRIDGE_VERSION,
      pi_version: PI_VERSION,
      mode: this.mode,
      model: this.cfg.model ?? "pi default",
      cwd: this.cfg.cwd,
      system_md: piSystemMd(this.cfg.cwd, getAgentDir()) ?? "pi default",
      assistant_prompt: loadAssistantPrompt(this.cfg.cwd, getAgentDir()).path ?? "built-in",
      sessions: this.entries.size,
      last_event_id: this.events.lastId,
    };
  }

  private async runtime(): Promise<ModelRuntime> {
    this.modelRuntime ??= await ModelRuntime.create();
    return this.modelRuntime;
  }

  private async create(key: string, req: TurnRequest): Promise<Entry> {
    const cwd = req.cwd ? path.resolve(req.cwd.replace(/^~(?=$|\/)/, os.homedir())) : this.cfg.cwd;
    const agentDir = getAgentDir();
    fs.mkdirSync(cwd, { recursive: true });
    const section = buildAssistantSection(cwd, agentDir, { language: req.language, instructions: req.instructions });
    // appendSystemPromptOverride (not appendSystemPrompt) keeps pi's own APPEND_SYSTEM.md
    const loader = new DefaultResourceLoader({
      cwd,
      agentDir,
      appendSystemPromptOverride: (base) => [...base, section.text],
    });
    await loader.reload();
    const modelRuntime = await this.runtime();
    let model;
    let thinkingLevel = this.cfg.thinking as never;
    if (this.cfg.model) {
      const r = resolveCliModel({ cliModel: this.cfg.model, modelRuntime });
      if (!r.model) throw new Error(r.error ?? `model ${this.cfg.model} not found`);
      model = r.model;
      thinkingLevel ??= r.thinkingLevel as never;
    }
    const { session } = await createAgentSession({
      cwd,
      agentDir,
      modelRuntime,
      resourceLoader: loader,
      sessionManager: SessionManager.create(cwd),
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
    this.log.info(`session ${session.sessionId} for ${key} (cwd ${cwd}, SYSTEM.md ${piSystemMd(cwd, agentDir) ?? "pi default"}, assistant prompt ${section.path ?? "built-in"})`);
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
      case "message_update": {
        const ame = event.assistantMessageEvent;
        if (ame?.type === "text_delta" && w) {
          const s = run.filter.push(ame.delta);
          if (s) {
            run.lastTextAt = Date.now();
            run.spokeSomething ||= s.trim().length > 0;
            w.write(`${JSON.stringify({ t: "text", d: s })}\n`);
          }
        }
        break;
      }
      case "message_end": {
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
      case "tool_execution_start":
        w?.write(`${JSON.stringify({ t: "activity", d: toolSummary(event.toolName, event.args) })}\n`);
        break;
    }
  }

  async turn(req: TurnRequest, res: http.ServerResponse): Promise<void> {
    const text = (req.text ?? "").trim();
    const key = req.session_key || req.conversation_id || "default";
    res.writeHead(200, { "content-type": "application/x-ndjson", "cache-control": "no-cache" });
    const send = (ev: BridgeEvent) => res.write(`${JSON.stringify(ev)}\n`);
    let entry: Entry;
    try {
      entry = await this.entry(key, req);
    } catch (err) {
      send({ t: "error", message: `Could not start a pi session: ${(err as Error).message}` });
      res.end();
      return;
    }
    entry.lastUsed = Date.now();
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
      send({
        t: "detached",
        task_id: run.taskId,
        d: req.detach_message || "I'm on it. I'll let you know when it's done.",
        session_id: entry.session.sessionId,
      });
      res.end();
      this.log.info(`${key}: turn detached after ${Math.round((Date.now() - started) / 1000)}s`);
    };
    // Detach once the budget is used up, but never in the middle of a sentence that is being streamed
    const timer = setInterval(() => {
      const now = Date.now();
      if (now - started > budgetMs && now - run.lastTextAt > 1500) detach();
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

    if (!run.detached) {
      const rest = run.filter.flush();
      if (rest) send({ t: "text", d: rest });
      if (error) send({ t: "error", message: error });
      send({ t: "done", session_id: entry.session.sessionId });
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
    this.log.info(`${key}: background task ${error ? "failed" : "done"}`);
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
