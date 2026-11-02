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
import { isOracleProjectTrusted } from "./lib/trust.js";
import { refreshOracleStatus, setOracleReadiness, startPoller, stopPoller } from "./lib/poller.js";
import { promoteQueuedJobs } from "./lib/queue.js";
import { assertOracleSubmitPrerequisites, hasPersistedSessionFile } from "./lib/runtime.js";
import { classifyOracleReadinessError, registerOracleTools } from "./lib/tools.js";
import { registerOracleRunCommand, type OracleRunToolDefinition } from "./lib/run-command.js";

const PROGRAMMATIC_API_SYMBOL = Symbol.for("omp.pi-oracle.programmatic.v1");
// The captured definitions are the registered ToolDefinitions; /oracle-run reads their schema and prepareArguments.
type ProgrammaticToolDefinition = OracleRunToolDefinition;

function readPromptTemplate(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8").replace(/^---\n[\s\S]*?\n---\n/, "");
  } catch {
    return undefined;
  }
}

function expandOraclePromptTemplate(source: string, args: string): string {
  return source.replaceAll("$@", args).replaceAll("$ARGUMENTS", args);
}

function parseOracleInput(text: string): { command: "oracle" | "oracle-followup"; args: string } | undefined {
  const match = text.match(/^\/(oracle(?:-followup)?)(?:\s+([\s\S]*))?$/);
  if (!match) return undefined;
  return { command: match[1] as "oracle" | "oracle-followup", args: (match[2] ?? "").trim() };
}

function formatOracleUserCommand(command: "oracle" | "oracle-followup", args: string): string {
  return `/${command} ${args}`;
}

function oracleDispatchMessage(command: "oracle" | "oracle-followup", args: string, template: string) {
  return {
    customType: "oracle-dispatch-request",
    content: expandOraclePromptTemplate(template, args),
    display: false,
    details: { command, userRequest: args },
  };
}

// pi consumes input on `action: "handled"` and Oh My Pi on `handled: true`. A consumed /oracle
// command carries both; with only one, the other host also submits the typed text, and the request
// and its hidden dispatch instructions reach the model twice.
const INPUT_CONSUMED = { action: "handled", handled: true } as const;

export default function oracleExtension(pi: ExtensionAPI) {
  const extensionDir = dirname(fileURLToPath(import.meta.url));
  const workerPath = join(extensionDir, "worker", "run-job.mjs");
  const authWorkerPath = join(extensionDir, "worker", "auth-bootstrap.mjs");
  const promptDir = join(extensionDir, "..", "..", "prompts");

  const oraclePrompt = readPromptTemplate(join(promptDir, "oracle.md"));
  const oracleFollowupPrompt = readPromptTemplate(join(promptDir, "oracle-followup.md"));

  registerOracleCommands(pi, authWorkerPath, workerPath);
  const programmaticTools = new Map<string, ProgrammaticToolDefinition>();
  const nativeRegisterTool = pi.registerTool.bind(pi);
  const capturingPi = new Proxy(pi, {
    get(target, property, receiver) {
      if (property === "registerTool") {
        return (definition: ProgrammaticToolDefinition) => {
          if (definition.name === "oracle_preflight" || definition.name === "oracle_submit" || definition.name === "oracle_read") {
            programmaticTools.set(definition.name, definition);
          }
          return Reflect.apply(nativeRegisterTool, target, [definition]);
        };
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as ExtensionAPI;
  registerOracleTools(capturingPi, workerPath, authWorkerPath);
  const preflightTool = programmaticTools.get("oracle_preflight");
  const submitTool = programmaticTools.get("oracle_submit");
  const readTool = programmaticTools.get("oracle_read");
  if (!preflightTool || !submitTool || !readTool) {
    throw new Error("Pi Oracle did not register its programmatic preflight, submit, and read tools");
  }
  registerOracleRunCommand(pi, programmaticTools);
  const abortSignal = new AbortController().signal;
  Object.defineProperty(globalThis, PROGRAMMATIC_API_SYMBOL, {
    configurable: true,
    enumerable: false,
    value: Object.freeze({
      version: 1 as const,
      read: (ctx: ExtensionContext, params: { jobId: string; projectId?: string; action?: "read" | "recollect"; responseIndex?: number; messageId?: string }) =>
        readTool.execute(`oracle-read-${crypto.randomUUID()}`, params, abortSignal, () => undefined, ctx),
      preflight: (ctx: ExtensionContext) =>
        preflightTool.execute(
          `oracle-shadow-preflight-${crypto.randomUUID()}`,
          { provider: "chatgpt" },
          abortSignal,
          () => undefined,
          ctx,
        ),
      submit: (
        ctx: ExtensionContext,
        params: { provider: "chatgpt"; preset: string; prompt: string; files: string[] },
      ) =>
        submitTool.execute(
          `oracle-shadow-submit-${crypto.randomUUID()}`,
          params,
          abortSignal,
          () => undefined,
          ctx,
        ),
    }),
  });

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

      const config = loadOracleConfig(ctx.cwd, { projectConfigTrusted: isOracleProjectTrusted(ctx) });
      setOracleReadiness(ctx, "loaded");
      void runStartupMaintenance(ctx).catch((error) => {
        const message = `Oracle startup maintenance failed: ${error instanceof Error ? error.message : String(error)}`;
        console.error(message);
        if (ctx.hasUI) ctx.ui.notify(message, "warning");
      });
      startPoller(pi, ctx, config.poller.intervalMs, workerPath, {
        checkReadiness: () => assertOracleSubmitPrerequisites(config).then(() => ({ readiness: "ready" as const }), classifyOracleReadinessError),
      });
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

  pi.on("before_agent_start", async (event) => {
    // Newer pi hosts also start custom-message turns (an oracle completion wake-up) through this
    // event, without a prompt (pi 1.2+ types them as a `messageType: "custom"` union member); only
    // a typed /oracle command is dispatched here.
    if (!("prompt" in event)) return;
    const parsed = parseOracleInput(event.prompt);
    if (!parsed?.args || (parsed.command === "oracle-followup" && !/^\S+\s+\S/.test(parsed.args))) return;
    const template = parsed.command === "oracle" ? oraclePrompt : oracleFollowupPrompt;
    if (!template?.trim()) return;
    return { message: oracleDispatchMessage(parsed.command, parsed.args, template) };
  });

  pi.on("input", (event, ctx) => {
    if (ctx.mode !== "tui" || event.source !== "interactive") return { action: "continue" };
    const parsed = parseOracleInput(event.text);
    if (!parsed) return { action: "continue" };
    if (!parsed.args || (parsed.command === "oracle-followup" && !/^\S+\s+\S/.test(parsed.args))) {
      ctx.ui.notify(parsed.command === "oracle" ? "Usage: /oracle <request>" : "Usage: /oracle-followup <job-id> <request>", "warning");
      return INPUT_CONSUMED;
    }
    const template = parsed.command === "oracle" ? oraclePrompt : oracleFollowupPrompt;
    if (!template?.trim()) {
      ctx.ui.notify(`/${parsed.command} is unavailable because its internal dispatch prompt could not be loaded.`, "warning");
      return INPUT_CONSUMED;
    }
    ctx.ui.notify("Preparing oracle job… running preflight", "info");
    const delivery = event.streamingBehavior ? { deliverAs: event.streamingBehavior } : undefined;
    pi.sendUserMessage(formatOracleUserCommand(parsed.command, parsed.args), delivery);
    return INPUT_CONSUMED;
  });

  pi.on("session_start", async (_event, ctx) => {
    startPollerForContext(ctx);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    stopPoller(ctx);
  });
}
