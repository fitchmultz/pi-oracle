// Purpose: Register slash commands for oracle auth/bootstrap, status inspection, cancellation, and cleanup.
// Responsibilities: Bridge command handlers to shared oracle lifecycle helpers, surface consistent summaries, and coordinate follow-up queue advancement.
// Scope: Command-facing orchestration only; durable lifecycle mutations live in jobs/runtime/tools modules and browser execution stays in worker scripts.
// Usage: Imported by the oracle extension entrypoint to register /oracle-* commands with pi.
// Invariants/Assumptions: Commands operate on persisted project-scoped jobs and rely on shared observability formatting for detached-state clarity.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { formatOracleJobSummary } from "../shared/job-observability-helpers.mjs";
import { formatOracleAuthConfigRemediation, formatOracleAuthConfigSummary, getOracleConfigLoadDetails, loadOracleConfig } from "./config.js";
import {
  cancelOracleJob,
  getJobDir,
  isOpenOracleJob,
  isTerminalOracleJob,
  listJobsForCwd,
  markWakeupSettled,
  pruneTerminalOracleJobs,
  readJob,
  reconcileStaleOracleJobs,
  removeTerminalOracleJob,
  shouldAdvanceQueueAfterCancellation,
} from "./jobs.js";
import { getQueuePosition, promoteQueuedJobs } from "./queue.js";
import { refreshOracleStatus } from "./poller.js";
import { isLockTimeoutError, withGlobalReconcileLock } from "./locks.js";
import { getProjectId } from "./runtime.js";

async function summarizeJob(jobId: string, options?: { responsePreview?: boolean }): Promise<string> {
  const job = readJob(jobId);
  if (!job) return `Oracle job ${jobId} not found.`;

  const responseAvailable = Boolean(job.responsePath && existsSync(job.responsePath));
  let responsePreview: string | undefined;
  if (options?.responsePreview && responseAvailable && job.responsePath) {
    try {
      responsePreview = (await readFile(job.responsePath, "utf8")).slice(0, 4000);
    } catch {
      responsePreview = undefined;
    }
  }

  return formatOracleJobSummary(job, {
    queuePosition: job.status === "queued" ? getQueuePosition(job.id) : undefined,
    artifactsPath: `${getJobDir(job.id)}/artifacts`,
    responseAvailable,
    responsePreview,
  });
}

function getLatestJobId(cwd: string): string | undefined {
  return listJobsForCwd(cwd)[0]?.id;
}

function listRecentJobIds(cwd: string, limit = 5): string | undefined {
  const jobs = listJobsForCwd(cwd).slice(0, limit);
  if (jobs.length === 0) return undefined;
  return jobs.map((job) => `${job.id} (${job.status})`).join(", ");
}

function readScopedJob(jobId: string, cwd: string) {
  const job = readJob(jobId);
  if (!job || job.projectId !== getProjectId(cwd)) return undefined;
  return job;
}

async function runAuthBootstrap(authWorkerPath: string, cwd: string): Promise<string> {
  const config = loadOracleConfig(cwd);
  const configLoad = getOracleConfigLoadDetails(cwd);
  const authConfigGuidance = {
    ...configLoad,
    remediation: formatOracleAuthConfigRemediation(configLoad),
    summary: formatOracleAuthConfigSummary(configLoad),
  };
  try {
    await withGlobalReconcileLock({ processPid: process.pid, source: "oracle_auth", cwd }, async () => {
      await reconcileStaleOracleJobs();
      await pruneTerminalOracleJobs();
    });
  } catch (error) {
    if (!isLockTimeoutError(error, "reconcile", "global")) throw error;
  }

  return await new Promise<string>((resolve, reject) => {
    const child = spawn(process.execPath, [authWorkerPath, JSON.stringify({ config, configLoad: authConfigGuidance })], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (data) => {
      stdout += String(data);
    });
    child.stderr.on("data", (data) => {
      stderr += String(data);
    });
    child.on("error", (error) => reject(error));
    child.on("close", (code) => {
      const message = stdout.trim() || stderr.trim() || "Oracle auth bootstrap finished with no output.";
      if (code === 0) resolve(message);
      else reject(new Error(message));
    });
  });
}

export function registerOracleCommands(pi: ExtensionAPI, authWorkerPath: string, workerPath: string): void {
  pi.registerCommand("oracle-auth", {
    description: "Sync ChatGPT cookies from real Chrome into the oracle auth seed profile",
    handler: async (_args, ctx) => {
      ctx.ui.notify("Syncing ChatGPT cookies from real Chrome into the oracle auth seed profile…", "info");
      try {
        const result = await runAuthBootstrap(authWorkerPath, ctx.cwd);
        ctx.ui.notify(result, "info");
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "warning");
      }
    },
  });

  pi.registerCommand("oracle-status", {
    description: "Show oracle job status and recent job ids",
    handler: async (args, ctx) => {
      const explicitJobId = args.trim();
      const jobId = explicitJobId || getLatestJobId(ctx.cwd);
      if (!jobId) {
        ctx.ui.notify("No oracle jobs found for this project", "info");
        return;
      }
      const job = readScopedJob(jobId, ctx.cwd);
      if (!job) {
        ctx.ui.notify(`Oracle job ${jobId} was not found in this project`, "warning");
        return;
      }
      if (isTerminalOracleJob(job)) {
        await markWakeupSettled(job.id, {
          source: "oracle_status",
          sessionFile: ctx.sessionManager.getSessionFile?.(),
          cwd: ctx.cwd,
        });
      }
      const summary = await summarizeJob(job.id);
      const recentJobs = !explicitJobId ? listRecentJobIds(ctx.cwd) : undefined;
      ctx.ui.notify([summary, recentJobs ? `Recent jobs: ${recentJobs}` : undefined].filter(Boolean).join("\n"), "info");
    },
  });

  pi.registerCommand("oracle-read", {
    description: "Show oracle job status plus saved response preview",
    handler: async (args, ctx) => {
      const explicitJobId = args.trim();
      const jobId = explicitJobId || getLatestJobId(ctx.cwd);
      if (!jobId) {
        ctx.ui.notify("No oracle jobs found for this project", "info");
        return;
      }
      const job = readScopedJob(jobId, ctx.cwd);
      if (!job) {
        ctx.ui.notify(`Oracle job ${jobId} was not found in this project`, "warning");
        return;
      }
      if (isTerminalOracleJob(job)) {
        await markWakeupSettled(job.id, {
          source: "oracle_read_command",
          sessionFile: ctx.sessionManager.getSessionFile?.(),
          cwd: ctx.cwd,
        });
      }
      ctx.ui.notify(await summarizeJob(job.id, { responsePreview: true }), "info");
    },
  });

  pi.registerCommand("oracle-cancel", {
    description: "Cancel a queued or active oracle job by id",
    handler: async (args, ctx) => {
      const jobId = args.trim();
      if (!jobId) {
        ctx.ui.notify("Usage: /oracle-cancel <job-id>\nUse /oracle-status to find the job id you want to cancel.", "warning");
        return;
      }

      const job = readScopedJob(jobId, ctx.cwd);
      if (!job) {
        ctx.ui.notify(`Oracle job ${jobId} not found in this project`, "warning");
        return;
      }
      if (!isOpenOracleJob(job)) {
        ctx.ui.notify(`Oracle job ${jobId} is not cancellable (${job.status})`, "info");
        return;
      }

      const cancelled = await cancelOracleJob(jobId);
      if (shouldAdvanceQueueAfterCancellation(cancelled)) {
        await promoteQueuedJobs({ workerPath, source: "oracle_cancel_command" });
      }
      refreshOracleStatus(ctx);
      const message = cancelled.status === "cancelled" || cancelled.status === "failed"
        ? `Cancelled oracle job ${cancelled.id}`
        : `Oracle job ${cancelled.id} was already ${cancelled.status}`;
      ctx.ui.notify(message, "info");
    },
  });

  pi.registerCommand("oracle-clean", {
    description: "Remove oracle temp files for terminal jobs; recently woken jobs may stay retained briefly",
    handler: async (args, ctx: ExtensionCommandContext) => {
      const target = args.trim();
      if (!target) {
        ctx.ui.notify("Usage: /oracle-clean <job-id|all>", "warning");
        return;
      }

      const jobs = target === "all" ? listJobsForCwd(ctx.cwd) : [readScopedJob(target, ctx.cwd)].filter(Boolean);
      if (jobs.length === 0) {
        ctx.ui.notify("No matching oracle jobs found", "warning");
        return;
      }

      const nonTerminalJobs = jobs.filter((job): job is NonNullable<typeof job> => Boolean(job && !isTerminalOracleJob(job)));
      if (nonTerminalJobs.length > 0) {
        ctx.ui.notify(
          `Refusing to remove non-terminal oracle job${nonTerminalJobs.length === 1 ? "" : "s"}: ${nonTerminalJobs.map((job) => job.id).join(", ")}`,
          "warning",
        );
        return;
      }

      const cleanupWarnings: string[] = [];
      let removedCount = 0;
      const removeJobs = async () => {
        for (const job of jobs) {
          if (!job) continue;
          const result = await removeTerminalOracleJob(job);
          if (result.removed) removedCount += 1;
          cleanupWarnings.push(...result.cleanupReport.warnings.map((warning) => `${job.id}: ${warning}`));
        }
      };

      try {
        await withGlobalReconcileLock({ processPid: process.pid, source: "oracle_clean", cwd: ctx.cwd }, async () => {
          await reconcileStaleOracleJobs();
          await removeJobs();
        });
      } catch (error) {
        if (!isLockTimeoutError(error, "reconcile", "global")) throw error;
        await removeJobs();
      }

      refreshOracleStatus(ctx);
      const warningSuffix = cleanupWarnings.length > 0 ? ` Cleanup blockers/warnings:\n${cleanupWarnings.join("\n")}` : "";
      const removalSummary = removedCount === jobs.length
        ? `Removed ${removedCount} oracle job director${removedCount === 1 ? "y" : "ies"}.`
        : `Removed ${removedCount} of ${jobs.length} oracle job director${jobs.length === 1 ? "y" : "ies"}; retained ${jobs.length - removedCount} due to cleanup blockers or warnings.`;
      ctx.ui.notify(`${removalSummary}${warningSuffix}`, cleanupWarnings.length > 0 ? "warning" : "info");
    },
  });
}
