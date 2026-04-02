import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { loadOracleConfig } from "./lib/config.js";
import { registerOracleCommands } from "./lib/commands.js";
import { refreshOracleStatus, startPoller, stopPoller, stopPollerForSession } from "./lib/poller.js";
import { registerOracleTools } from "./lib/tools.js";

export default function oracleExtension(pi: ExtensionAPI) {
  const extensionDir = dirname(fileURLToPath(import.meta.url));
  const workerPath = join(extensionDir, "worker", "run-job.mjs");
  const authWorkerPath = join(extensionDir, "worker", "auth-bootstrap.mjs");

  registerOracleCommands(pi, authWorkerPath);
  registerOracleTools(pi, workerPath);

  function startPollerForContext(previousSessionFile: string | undefined, ctx: ExtensionContext) {
    stopPollerForSession(previousSessionFile, ctx.cwd);
    try {
      const config = loadOracleConfig(ctx.cwd);
      startPoller(pi, ctx, config.poller.intervalMs);
      refreshOracleStatus(ctx);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      stopPoller(ctx);
      ctx.ui.setStatus("oracle", ctx.ui.theme.fg("danger", "oracle: config error"));
      ctx.ui.notify(message, "warning");
    }
  }

  pi.on("session_start", async (_event, ctx) => {
    startPollerForContext(undefined, ctx);
  });

  pi.on("session_switch", async (event, ctx) => {
    startPollerForContext(event.previousSessionFile, ctx);
  });

  pi.on("session_fork", async (event, ctx) => {
    startPollerForContext(event.previousSessionFile, ctx);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    stopPoller(ctx);
  });
}
