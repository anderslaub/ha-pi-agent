/**
 * Bridge settings: ~/.pi/agent/va-bridge.json, overridden by PI_BRIDGE_* environment variables.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export interface BridgeConfig {
  host: string;
  port: number;
  token: string;
  cwd: string;
  model?: string;
  thinking?: string;
  tools?: string[];
  idleMinutes: number;
  defaultBudgetS: number;
  /** a background task that runs longer than this is stopped (and reported as failed) */
  taskTimeoutMinutes: number;
  /** run one throwaway turn at startup, so the model server has the long prompt cached before the first question */
  warmup: boolean;
  /**
   * Noise screening (screen.ts): the classifier model that judges whether speech was meant for the assistant,
   * e.g. a typesafe decision model on the llama.cpp router. Default: the chat model itself.
   */
  screenModel?: string;
  /** below this probability of "meant for the assistant" the speech counts as background noise */
  screenThreshold: number;
  /**
   * IANA time zone for the assistant's sense of time (the time, dates in its notes, wake-ups). Unset: Home
   * Assistant's time zone (sent with each turn), else the host's.
   */
  timezone?: string;
  /** short-term memory: a note about recent conversations, rewritten after each one (memory.ts) */
  memory: boolean;
  /** where that note is kept */
  memoryFile: string;
  /** a conversation counts as over after this long without a message, and is then summarized */
  summaryAfterMinutes: number;
  /** past dates stay in the note's mini calendar this many days */
  memoryKeepDays: number;
  /** the wake-up tools (wakeups.ts) */
  wakeups: boolean;
  /** extension only: start the bridge when an interactive pi starts */
  autostart: boolean;
}

/** What the settings file may contain (all optional) */
export interface ConfigFile {
  token?: string;
  host?: string;
  port?: number;
  cwd?: string;
  model?: string;
  thinking?: string;
  tools?: string[] | string;
  idleMinutes?: number;
  budgetSeconds?: number;
  taskTimeoutMinutes?: number;
  warmup?: boolean;
  screenModel?: string;
  screenThreshold?: number;
  timezone?: string;
  memory?: boolean;
  memoryFile?: string;
  summaryAfterMinutes?: number;
  memoryKeepDays?: number;
  wakeups?: boolean;
  autostart?: boolean;
}

export const DEFAULT_CWD = "~/pi-va";

export function configPath(agentDir = getAgentDir()): string {
  return path.join(agentDir, "va-bridge.json");
}

export function expandHome(p: string): string {
  const home = os.homedir();
  return path.resolve(p.replace(/^~(?=$|[/\\])/, home));
}

export function readConfigFile(file = configPath()): ConfigFile {
  if (!fs.existsSync(file)) return {};
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as ConfigFile;
  } catch (err) {
    throw new Error(`${file} is not valid JSON: ${(err as Error).message}`);
  }
}

function list(v: string[] | string | undefined): string[] | undefined {
  if (v === undefined || v === null) return undefined;
  const items = (Array.isArray(v) ? v : v.split(",")).map((t) => t.trim()).filter(Boolean);
  return items.length ? items : undefined;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env, file = configPath()): BridgeConfig {
  const f = readConfigFile(file);
  const token = env.PI_BRIDGE_TOKEN || f.token || "";
  if (token.length < 16) {
    throw new Error(
      `No bridge token. Run /va-bridge setup in pi, or set "token" in ${file} (or PI_BRIDGE_TOKEN) ` +
        "to a random string of at least 16 characters.",
    );
  }
  const cwd = expandHome(env.PI_BRIDGE_CWD || f.cwd || DEFAULT_CWD);
  return {
    host: env.PI_BRIDGE_HOST || f.host || "0.0.0.0",
    port: Number(env.PI_BRIDGE_PORT || f.port || 8787),
    token,
    cwd,
    model: env.PI_BRIDGE_MODEL || f.model || undefined,
    thinking: env.PI_BRIDGE_THINKING || f.thinking || undefined,
    tools: list(env.PI_BRIDGE_TOOLS || f.tools),
    idleMinutes: Number(env.PI_BRIDGE_IDLE_MINUTES || f.idleMinutes || 120),
    defaultBudgetS: Number(env.PI_BRIDGE_BUDGET_S || f.budgetSeconds || 15),
    taskTimeoutMinutes: Number(env.PI_BRIDGE_TASK_TIMEOUT_MIN || f.taskTimeoutMinutes || 10),
    warmup: env.PI_BRIDGE_WARMUP ? env.PI_BRIDGE_WARMUP !== "0" : f.warmup !== false,
    screenModel: env.PI_BRIDGE_SCREEN_MODEL || f.screenModel || undefined,
    screenThreshold: Number(env.PI_BRIDGE_SCREEN_THRESHOLD || f.screenThreshold || 0.3),
    timezone: env.PI_BRIDGE_TIMEZONE || f.timezone || undefined,
    memory: env.PI_BRIDGE_MEMORY ? env.PI_BRIDGE_MEMORY !== "0" : f.memory !== false,
    // in the workspace, so it can be read (and corrected) from the host
    memoryFile: expandHome(env.PI_BRIDGE_MEMORY_FILE || f.memoryFile || path.join(cwd, "short-term-memory.md")),
    summaryAfterMinutes: Number(env.PI_BRIDGE_SUMMARY_AFTER_MIN || f.summaryAfterMinutes || 1),
    memoryKeepDays: Number(env.PI_BRIDGE_MEMORY_KEEP_DAYS || f.memoryKeepDays || 3),
    wakeups: env.PI_BRIDGE_WAKEUPS ? env.PI_BRIDGE_WAKEUPS !== "0" : f.wakeups !== false,
    autostart: env.PI_BRIDGE_AUTOSTART ? env.PI_BRIDGE_AUTOSTART === "1" : Boolean(f.autostart),
  };
}

/** Create the settings file with a fresh token if it has none. Returns the token and whether it was new. */
export function ensureToken(file = configPath()): { token: string; created: boolean; file: string } {
  const f = readConfigFile(file);
  if (f.token && f.token.length >= 16) return { token: f.token, created: false, file };
  const next: ConfigFile = {
    host: "0.0.0.0",
    port: 8787,
    cwd: DEFAULT_CWD,
    autostart: false,
    ...f,
    token: randomBytes(24).toString("hex"),
  };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  return { token: next.token!, created: true, file };
}

export function setConfigValue(key: keyof ConfigFile, value: unknown, file = configPath()): void {
  const f = readConfigFile(file) as Record<string, unknown>;
  f[key] = value;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(f, null, 2)}\n`, { mode: 0o600 });
}
