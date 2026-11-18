/**
 * A llama.cpp router (llama serve without -m) loads models on demand, but pi only offers the models the router
 * has loaded already. So when PI_BRIDGE_MODEL names a model the router has but has not loaded, load it.
 * Configured like pi's built-in provider: LLAMA_BASE_URL and LLAMA_API_KEY.
 */

const THINKING = new Set(["off", "minimal", "low", "medium", "high", "xhigh"]);

export interface RouterModel {
  id: string;
  status: string;
  failed?: boolean;
}

export interface LlamaRouter {
  url: string;
  list(): Promise<RouterModel[]>;
  load(id: string): Promise<void>;
}

export function llamaRouter(env: NodeJS.ProcessEnv = process.env): LlamaRouter | undefined {
  const base = env.LLAMA_BASE_URL?.trim();
  if (!base) return undefined;
  const url = base.replace(/\/+$/, "").replace(/\/v1$/, "");
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (env.LLAMA_API_KEY) headers.authorization = `Bearer ${env.LLAMA_API_KEY}`;
  const request = async (path: string, init: RequestInit = {}) => {
    const res = await fetch(`${url}${path}`, { ...init, headers, signal: AbortSignal.timeout(15_000) }).catch((err) => {
      throw new Error(`cannot reach the llama.cpp router at ${url}: ${(err as Error).cause ?? (err as Error).message}`);
    });
    const body = (await res.json().catch(() => undefined)) as { data?: unknown; error?: { message?: string } } | undefined;
    if (!res.ok) throw new Error(`llama.cpp router at ${url}: ${body?.error?.message ?? `HTTP ${res.status}`}`);
    return body;
  };
  return {
    url,
    async list() {
      const body = await request("/models");
      type Raw = { id?: unknown; status?: { value?: unknown; failed?: unknown } };
      const data = Array.isArray(body?.data) ? (body.data as Raw[]) : [];
      return data
        .filter((m) => typeof m.id === "string")
        .map((m) => ({
          id: m.id as string,
          status: typeof m.status?.value === "string" ? m.status.value : "unknown",
          failed: m.status?.failed === true,
        }));
    },
    async load(id) {
      await request("/models/load", { method: "POST", body: JSON.stringify({ model: id }) });
    },
  };
}

/** The router model a PI_BRIDGE_MODEL value means: "llama.cpp/<id>[:thinking]" or a bare "<id>" */
export function routerModelId(spec: string, ids: string[]): string | undefined {
  let s = spec.trim();
  if (s.startsWith("llama.cpp/")) s = s.slice("llama.cpp/".length);
  if (ids.includes(s)) return s;
  const colon = s.lastIndexOf(":");
  if (colon > 0 && THINKING.has(s.slice(colon + 1)) && ids.includes(s.slice(0, colon))) return s.slice(0, colon);
  return undefined;
}

/**
 * Make sure the router has the model loaded. Returns what happened, for the log; throws with the router's
 * model list when the model is not there at all. Does nothing (undefined) for models of other providers.
 */
export async function ensureRouterModel(
  router: LlamaRouter,
  spec: string,
  opts: { timeoutMs?: number; pollMs?: number } = {},
): Promise<string | undefined> {
  const models = await router.list();
  const id = routerModelId(
    spec,
    models.map((m) => m.id),
  );
  if (!id) {
    if (spec.startsWith("llama.cpp/")) {
      throw new Error(
        `the llama.cpp router has no model "${spec.slice("llama.cpp/".length)}". It has: ${models.map((m) => m.id).join(", ") || "none"}`,
      );
    }
    return undefined; // probably another provider's model
  }
  const status = () => models.find((m) => m.id === id)?.status;
  if (status() === "loaded" || status() === "sleeping") return undefined;
  if (status() !== "loading") await router.load(id);
  const deadline = Date.now() + (opts.timeoutMs ?? 180_000);
  for (;;) {
    const now = (await router.list()).find((m) => m.id === id);
    if (now?.status === "loaded" || now?.status === "sleeping") return `loaded ${id} on the llama.cpp router`;
    if (now?.failed) throw new Error(`the llama.cpp router could not load ${id}; see the router's log`);
    if (Date.now() > deadline) throw new Error(`the llama.cpp router did not finish loading ${id} in time`);
    await new Promise((r) => setTimeout(r, opts.pollMs ?? 1000));
  }
}
