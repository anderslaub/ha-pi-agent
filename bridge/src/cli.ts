#!/usr/bin/env node
/**
 * Headless va-bridge, for running it as a service without an interactive pi.
 * Same settings as the pi extension: ~/.pi/agent/va-bridge.json and PI_BRIDGE_* environment variables.
 */
import { loadConfig } from "./config.ts";
import { startBridge } from "./server.ts";

const running = await startBridge(loadConfig()).catch((err) => {
  console.error(`[pi-bridge] ${(err as Error).message}`);
  process.exit(1);
});
const stop = () => void running.stop().then(() => process.exit(0));
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
