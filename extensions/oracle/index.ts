// Purpose: Register the oracle extension, wire commands/tools/workers, and manage per-session background maintenance.
// Responsibilities: Bootstrap oracle commands and tools, start or stop polling, and surface startup/config availability in the pi session UI.
// Scope: Extension entrypoint only; lifecycle mutation lives in lib modules and browser execution lives in worker scripts.
// Usage: Loaded by pi as the extension module declared in package.json.
// Invariants/Assumptions: Oracle only runs against persisted sessions, and startup maintenance should be best-effort without breaking session initialization.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadOracleConfig } from "./lib/config.js";
import { registerOracleCommands } from "./lib/commands.js";
import { getSessionFile, pruneTerminalOracleJobs, reconcileStaleOracleJobs } from "./lib/jobs.js";
import { isLockTimeoutError, withGlobalReconcileLock } from "./lib/locks.js";
import { refreshOracleStatus, setOracleReadiness, startPoller, stopPoller } from "./lib/poller.js";
import { promoteQueuedJobs } from "./lib/queue.js";
import { assertOracleSubmitPrerequisites, hasPersistedSessionFile } from "./lib/runtime.js";
import { registerOracleTools } from "./lib/tools.js";

function readPromptTemplate(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8").replace(/^---\n[\s\S]*?\n---\n/, "");
  } catch {
    return undefined;
  }
}

function oracleReadinessFromError(error: unknown): "auth_needed" | "config_error" {
  const message = error instanceof Error ? error.message : String(error);
  return /auth seed profile/i.test(message) ? "auth_needed" : "config_error";
}

function expandOraclePromptTemplate(source: string, args: string): string {
  return source.replaceAll("$@", args).replaceAll("$ARGUMENTS", args);
}

function parseOracleInput(text: string): { command: "oracle" | "oracle-followup"; args: string } | undefined {
  const match = text.match(/^\/(oracle(?:-followup)?)(?:\s+([\s\S]*))?$/);
  if (!match) return undefined;
  return { command: match[1] as "oracle" | "oracle-followup", args: (match[2] ?? "").trim() };
}

export default function oracleExtension(pi: ExtensionAPI) {
  const extensionDir = dirname(fileURLToPath(import.meta.url));
  const workerPath = join(extensionDir, "worker", "run-job.mjs");
  const authWorkerPath = join(extensionDir, "worker", "auth-bootstrap.mjs");
  const promptDir = join(extensionDir, "..", "..", "prompts");

  const oraclePrompt = readPromptTemplate(join(promptDir, "oracle.md"));
  const oracleFollowupPrompt = readPromptTemplate(join(promptDir, "oracle-followup.md"));

  registerOracleCommands(pi, authWorkerPath, workerPath);
  registerOracleTools(pi, workerPath, authWorkerPath);

  async function runStartupMaintenance(ctx: ExtensionContext): Promise<void> {
    try {
      await withGlobalReconcileLock({ processPid: process.pid, source: "oracle_session_start", cwd: ctx.cwd }, async () => {
        await reconcileStaleOracleJobs();
        await pruneTerminalOracleJobs();
      }, { timeoutMs: 250 });
    } catch (error) {
      if (!isLockTimeoutError(error, "reconcile", "global")) throw error;
    }

    await promoteQueuedJobs({ workerPath, source: "oracle_session_start" });
  }

  function startPollerForContext(ctx: ExtensionContext) {
    try {
      const sessionFile = getSessionFile(ctx);
      if (ctx.mode === "print" || ctx.mode === "json") {
        stopPoller(ctx);
        return;
      }
      if (!hasPersistedSessionFile(sessionFile)) {
        stopPoller(ctx);
        if (ctx.hasUI) ctx.ui.setStatus("oracle", ctx.ui.theme.fg("accent", "oracle: unavailable"));
        return;
      }

      const config = loadOracleConfig(ctx.cwd);
      setOracleReadiness(ctx, "loaded");
      void assertOracleSubmitPrerequisites(config)
        .then(() => setOracleReadiness(ctx, "ready"))
        .catch((error) => setOracleReadiness(ctx, oracleReadinessFromError(error)));
      void runStartupMaintenance(ctx).catch((error) => {
        const message = `Oracle startup maintenance failed: ${error instanceof Error ? error.message : String(error)}`;
        console.error(message);
        if (ctx.hasUI) ctx.ui.notify(message, "warning");
      });
      startPoller(pi, ctx, config.poller.intervalMs, workerPath);
      refreshOracleStatus(ctx);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      stopPoller(ctx);
      setOracleReadiness(ctx, "config_error");
      if (ctx.hasUI) {
        ctx.ui.notify(message, "warning");
      }
    }
  }

  pi.on("resources_discover", async (_event, ctx) => {
    return ["print", "json", "rpc"].includes(ctx.mode) ? { promptPaths: [promptDir] } : undefined;
  });

  pi.on("input", (event, ctx) => {
    if (ctx.mode !== "tui" || event.source !== "interactive") return { action: "continue" };
    const parsed = parseOracleInput(event.text);
    if (!parsed) return { action: "continue" };
    if (!parsed.args || (parsed.command === "oracle-followup" && !/^\S+\s+\S/.test(parsed.args))) {
      ctx.ui.notify(parsed.command === "oracle" ? "Usage: /oracle <request>" : "Usage: /oracle-followup <job-id> <request>", "warning");
      return { action: "handled" };
    }
    const template = parsed.command === "oracle" ? oraclePrompt : oracleFollowupPrompt;
    if (!template?.trim()) {
      ctx.ui.notify(`/${parsed.command} is unavailable because its internal dispatch prompt could not be loaded.`, "warning");
      return { action: "handled" };
    }
    ctx.ui.notify("Preparing oracle job… running preflight", "info");
    pi.sendMessage(
      {
        customType: "oracle-dispatch-request",
        content: expandOraclePromptTemplate(template, parsed.args),
        display: false,
        details: { command: parsed.command, userRequest: parsed.args },
      },
      { triggerTurn: true },
    );
    return { action: "handled" };
  });

  pi.on("session_start", async (_event, ctx) => {
    startPollerForContext(ctx);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    stopPoller(ctx);
  });
}
