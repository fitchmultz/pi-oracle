import { spawn } from "node:child_process";
import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { loadOracleConfig } from "./config.js";
import { buildOracleDispatchPrompt } from "./instructions.js";
import {
  cancelOracleJob,
  isActiveOracleJob,
  listJobsForCwd,
  pruneTerminalOracleJobs,
  readJob,
  reconcileStaleOracleJobs,
  removeTerminalOracleJob,
} from "./jobs.js";
import { refreshOracleStatus } from "./poller.js";
import { isLockTimeoutError, withGlobalReconcileLock } from "./locks.js";
import { getProjectId } from "./runtime.js";

function summarizeJob(jobId: string): string {
  const job = readJob(jobId);
  if (!job) return `Oracle job ${jobId} not found.`;

  return [
    `job: ${job.id}`,
    `status: ${job.status}`,
    `phase: ${job.phase}`,
    `created: ${job.createdAt}`,
    `project: ${job.projectId}`,
    `session: ${job.sessionId}`,
    job.completedAt ? `completed: ${job.completedAt}` : undefined,
    job.followUpToJobId ? `follow-up-to: ${job.followUpToJobId}` : undefined,
    job.chatUrl ? `chat: ${job.chatUrl}` : undefined,
    job.conversationId ? `conversation: ${job.conversationId}` : undefined,
    job.responsePath ? `response: ${job.responsePath}` : undefined,
    job.responseFormat ? `response-format: ${job.responseFormat}` : undefined,
    typeof job.artifactFailureCount === "number" ? `artifact-failures: ${job.artifactFailureCount}` : undefined,
    job.lastCleanupAt ? `last-cleanup: ${job.lastCleanupAt}` : undefined,
    job.cleanupWarnings?.length ? `cleanup-warnings: ${job.cleanupWarnings.join(" | ")}` : undefined,
    job.error ? `error: ${job.error}` : undefined,
  ]
    .filter(Boolean)
    .join("\n");
}

function getLatestJobId(cwd: string): string | undefined {
  return listJobsForCwd(cwd)[0]?.id;
}

function readScopedJob(jobId: string, cwd: string) {
  const job = readJob(jobId);
  if (!job || job.projectId !== getProjectId(cwd)) return undefined;
  return job;
}

async function runAuthBootstrap(authWorkerPath: string, cwd: string): Promise<string> {
  const config = loadOracleConfig(cwd);
  try {
    await withGlobalReconcileLock({ processPid: process.pid, source: "oracle_auth", cwd }, async () => {
      await reconcileStaleOracleJobs();
      await pruneTerminalOracleJobs();
    });
  } catch (error) {
    if (!isLockTimeoutError(error, "reconcile", "global")) throw error;
  }

  return await new Promise<string>((resolve, reject) => {
    const child = spawn(process.execPath, [authWorkerPath, JSON.stringify(config)], {
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

export function registerOracleCommands(pi: ExtensionAPI, authWorkerPath: string): void {
  pi.registerCommand("oracle", {
    description: "Ask the agent to prepare and dispatch a ChatGPT web oracle job",
    handler: async (args, ctx) => {
      const request = args.trim();
      if (!request) {
        ctx.ui.notify("Usage: /oracle <request>", "warning");
        return;
      }

      const message = buildOracleDispatchPrompt(request);
      if (ctx.isIdle()) {
        pi.sendUserMessage(message);
      } else {
        pi.sendUserMessage(message, { deliverAs: "followUp" });
        ctx.ui.notify("Queued oracle preparation as a follow-up", "info");
      }
    },
  });

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
    description: "Show oracle job status",
    handler: async (args, ctx) => {
      const explicitJobId = args.trim();
      const jobId = explicitJobId || getLatestJobId(ctx.cwd);
      if (!jobId) {
        ctx.ui.notify("No oracle jobs found for this project", "info");
        return;
      }
      if (explicitJobId && !readScopedJob(jobId, ctx.cwd)) {
        ctx.ui.notify(`Oracle job ${jobId} was not found in this project`, "warning");
        return;
      }
      ctx.ui.notify(summarizeJob(jobId), "info");
    },
  });

  pi.registerCommand("oracle-cancel", {
    description: "Cancel an active oracle job",
    handler: async (args, ctx) => {
      const explicitJobId = args.trim();
      const jobId = explicitJobId || getLatestJobId(ctx.cwd);
      if (!jobId) {
        ctx.ui.notify("No oracle jobs found for this project", "info");
        return;
      }

      const job = explicitJobId ? readScopedJob(jobId, ctx.cwd) : readJob(jobId);
      if (!job) {
        ctx.ui.notify(`Oracle job ${jobId} not found in this project`, "warning");
        return;
      }
      if (!isActiveOracleJob(job)) {
        ctx.ui.notify(`Oracle job ${jobId} is not active (${job.status})`, "info");
        return;
      }

      const cancelled = await cancelOracleJob(jobId);
      refreshOracleStatus(ctx);
      ctx.ui.notify(`Cancelled oracle job ${cancelled.id}`, "info");
    },
  });

  pi.registerCommand("oracle-clean", {
    description: "Remove oracle temp files for a job or all project jobs",
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

      const activeJobs = jobs.filter((job): job is NonNullable<typeof job> => Boolean(job && isActiveOracleJob(job)));
      if (activeJobs.length > 0) {
        ctx.ui.notify(
          `Refusing to remove active oracle job${activeJobs.length === 1 ? "" : "s"}: ${activeJobs.map((job) => job.id).join(", ")}`,
          "warning",
        );
        return;
      }

      const cleanupWarnings: string[] = [];
      const removeJobs = async () => {
        for (const job of jobs) {
          if (!job) continue;
          const result = await removeTerminalOracleJob(job);
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
      const warningSuffix = cleanupWarnings.length > 0 ? ` Cleanup warnings:\n${cleanupWarnings.join("\n")}` : "";
      ctx.ui.notify(`Removed ${jobs.length} oracle job director${jobs.length === 1 ? "y" : "ies"}.${warningSuffix}`, cleanupWarnings.length > 0 ? "warning" : "info");
    },
  });
}
