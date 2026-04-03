import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { loadOracleConfig } from "./lib/config.js";
import { registerOracleCommands } from "./lib/commands.js";
import { pruneTerminalOracleJobs, reconcileStaleOracleJobs } from "./lib/jobs.js";
import { isLockTimeoutError, withGlobalReconcileLock } from "./lib/locks.js";
import { refreshOracleStatus, startPoller, stopPoller, stopPollerForSession } from "./lib/poller.js";
import { registerOracleTools } from "./lib/tools.js";

export default function oracleExtension(pi: ExtensionAPI) {
  const extensionDir = dirname(fileURLToPath(import.meta.url));
  const workerPath = join(extensionDir, "worker", "run-job.mjs");
  const authWorkerPath = join(extensionDir, "worker", "auth-bootstrap.mjs");

  registerOracleCommands(pi, authWorkerPath);
  registerOracleTools(pi, workerPath);

  async function runStartupMaintenance(ctx: ExtensionContext): Promise<void> {
    try {
      await withGlobalReconcileLock({ processPid: process.pid, source: "oracle_session_start", cwd: ctx.cwd }, async () => {
        await reconcileStaleOracleJobs();
        await pruneTerminalOracleJobs();
      }, { timeoutMs: 250 });
    } catch (error) {
      if (!isLockTimeoutError(error, "reconcile", "global")) throw error;
    }
  }

  function startPollerForContext(previousSessionFile: string | undefined, ctx: ExtensionContext) {
    stopPollerForSession(previousSessionFile, ctx.cwd);
    try {
      const config = loadOracleConfig(ctx.cwd);
      void runStartupMaintenance(ctx).catch((error) => {
        console.error("Oracle startup maintenance failed:", error);
      });
      startPoller(pi, ctx, config.poller.intervalMs);
      refreshOracleStatus(ctx);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      stopPoller(ctx);
      ctx.ui.setStatus("oracle", ctx.ui.theme.fg("danger", "oracle: config error"));
      ctx.ui.notify(message, "warning");
    }
  }

  pi.on("session_start", async (event, ctx) => {
    startPollerForContext(event.previousSessionFile, ctx);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    stopPoller(ctx);
  });
}
