/**
 * pi extension: runs the Home Assistant assistant bridge (va-bridge) inside pi.
 *
 *   /va-bridge                    status
 *   /va-bridge setup              create ~/.pi/agent/va-bridge.json with a token, show what to enter in HA
 *   /va-bridge start | stop
 *   /va-bridge autostart on|off   start the bridge whenever an interactive pi starts
 *   /va-bridge prompt             create / show the system prompt file (~/.pi/agent/va-bridge/SYSTEM.md)
 *
 * Assistant sessions run in this pi process next to your interactive session, but as their own pi sessions in
 * their own working directory. There is one bridge per process; a second pi that finds the port taken
 * just leaves it to the first one.
 */
import fs from "node:fs";
import path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { configPath, ensureToken, loadConfig, setConfigValue } from "./config.ts";
import { DEFAULT_ASSISTANT_PROMPT, loadAssistantPrompt, PROMPT_DIR } from "./prompt.ts";
import { startBridge } from "./server.ts";
import type { Logger, RunningBridge } from "./server.ts";

// Shared by every copy of this extension in the process (assistant sessions load your extensions too)
interface Shared {
  running?: RunningBridge;
  starting?: Promise<RunningBridge>;
  ui?: ExtensionContext["ui"];
}
const KEY = Symbol.for("pi-va-bridge");
const shared: Shared = ((globalThis as Record<symbol, Shared>)[KEY] ??= {});

const LOG_FILE = path.join(getAgentDir(), "va-bridge.log");

/** Log to a file: writing to stdout would garble pi's TUI */
const fileLogger: Logger = {
  info(msg) {
    append(`${new Date().toISOString()} ${msg}\n`);
  },
  error(msg, err) {
    append(`${new Date().toISOString()} ERROR ${msg} ${err instanceof Error ? err.stack : (err ?? "")}\n`);
    shared.ui?.notify(`va-bridge: ${msg}`, "error");
  },
};

function append(line: string): void {
  try {
    fs.appendFileSync(LOG_FILE, line);
  } catch {
    // nowhere better to report it
  }
}

function showStatus(ui: ExtensionContext["ui"]): void {
  const r = shared.running;
  ui.setStatus("va-bridge", r ? `va-bridge :${r.bridge.config.port}` : undefined);
}

async function start(ctx: ExtensionContext): Promise<RunningBridge> {
  if (shared.running) return shared.running;
  shared.starting ??= (async () => {
    const cfg = loadConfig();
    return startBridge(cfg, fileLogger, "extension");
  })();
  try {
    shared.running = await shared.starting;
    shared.running.server.unref(); // never keep pi alive just for the bridge
    return shared.running;
  } finally {
    shared.starting = undefined;
    showStatus(ctx.ui);
  }
}

async function stop(ctx: ExtensionContext): Promise<boolean> {
  const r = shared.running;
  if (!r) return false;
  shared.running = undefined;
  await r.stop();
  showStatus(ctx.ui);
  return true;
}

function describe(): string {
  const r = shared.running;
  const lines: string[] = [];
  if (r) {
    const c = r.bridge.config;
    lines.push(
      `va-bridge running at ${r.url} (listening on ${c.host}:${c.port})`,
      `Working directory: ${c.cwd}`,
      `Model: ${c.model ?? "pi default"}${c.thinking ? `, thinking ${c.thinking}` : ""}`,
      `Tools: ${c.tools?.join(", ") ?? "pi default"}`,
      `Sessions in memory: ${r.bridge.sessionCount}`,
      `System prompt: ${loadAssistantPrompt(c.cwd, getAgentDir()).path ?? "built-in (run /va-bridge prompt to customize)"}`,
    );
  } else {
    lines.push("va-bridge is not running. /va-bridge start to start it.");
  }
  lines.push(`Settings: ${configPath()}`, `Log: ${LOG_FILE}`);
  return lines.join("\n");
}

const SUBCOMMANDS = ["status", "setup", "start", "stop", "autostart", "prompt"];

export default function (pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    if (ctx.mode !== "tui") return; // not in print/json/rpc runs, nor inside the assistant sessions themselves
    shared.ui = ctx.ui;
    showStatus(ctx.ui);
    if (shared.running || shared.starting) return;
    let autostart = false;
    try {
      autostart = loadConfig().autostart;
    } catch {
      return; // not set up yet
    }
    if (!autostart) return;
    try {
      await start(ctx);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      // another pi already runs the bridge: fine, stay quiet
      if (code !== "EADDRINUSE") ctx.ui.notify(`va-bridge did not start: ${(err as Error).message}`, "warning");
    }
  });

  pi.registerCommand("va-bridge", {
    description: "Home Assistant assistant bridge: status, setup, start, stop, autostart on|off, prompt",
    getArgumentCompletions: (prefix: string) => {
      const items = SUBCOMMANDS.filter((s) => s.startsWith(prefix)).map((s) => ({ value: s, label: s }));
      return items.length ? items : null;
    },
    handler: async (args, ctx) => {
      shared.ui = ctx.ui;
      const [sub = "status", arg] = args.trim().split(/\s+/).filter(Boolean);
      try {
        switch (sub) {
          case "status":
            ctx.ui.notify(describe(), "info");
            return;
          case "setup": {
            const t = ensureToken();
            const cfg = loadConfig();
            ctx.ui.notify(
              [
                t.created ? `Created ${t.file}` : `Using ${t.file}`,
                "In Home Assistant: Settings > Devices & services > Add integration > Pi Agent",
                `  URL:   http://<this machine's IP>:${cfg.port}`,
                `  Token: ${t.token}`,
                "Then /va-bridge start (and /va-bridge autostart on to start it with pi).",
              ].join("\n"),
              "info",
            );
            return;
          }
          case "start": {
            const r = await start(ctx);
            ctx.ui.notify(`va-bridge running at ${r.url}`, "info");
            return;
          }
          case "stop":
            ctx.ui.notify((await stop(ctx)) ? "va-bridge stopped" : "va-bridge was not running", "info");
            return;
          case "autostart": {
            if (arg !== "on" && arg !== "off") {
              ctx.ui.notify("Usage: /va-bridge autostart on|off", "warning");
              return;
            }
            setConfigValue("autostart", arg === "on");
            ctx.ui.notify(`Autostart ${arg}`, "info");
            return;
          }
          case "prompt": {
            const cwd = shared.running?.bridge.config.cwd ?? safeCwd();
            const current = loadAssistantPrompt(cwd, getAgentDir());
            if (current.path) {
              ctx.ui.notify(`System prompt: ${current.path}\nEdits apply to new sessions.`, "info");
              return;
            }
            const file = path.join(getAgentDir(), PROMPT_DIR, "SYSTEM.md");
            fs.mkdirSync(path.dirname(file), { recursive: true });
            fs.writeFileSync(file, `${DEFAULT_ASSISTANT_PROMPT}\n`);
            ctx.ui.notify(
              `Wrote the default system prompt to ${file}\n` +
                `Edit it to change how pi behaves as your assistant. A ${path.join(cwd, ".pi", PROMPT_DIR, "SYSTEM.md")} ` +
                "takes precedence for that working directory.",
              "info",
            );
            return;
          }
          default:
            ctx.ui.notify(`Unknown subcommand "${sub}". Try: ${SUBCOMMANDS.join(", ")}`, "warning");
        }
      } catch (err) {
        const e = err as NodeJS.ErrnoException;
        const msg =
          e.code === "EADDRINUSE"
            ? "The port is taken. Is the bridge already running in another pi or as a service?"
            : e.message;
        ctx.ui.notify(`va-bridge: ${msg}`, "error");
      }
    },
  });
}

function safeCwd(): string {
  try {
    return loadConfig().cwd;
  } catch {
    return process.cwd();
  }
}
