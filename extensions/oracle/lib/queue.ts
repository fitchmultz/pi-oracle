// Purpose: Coordinate queued oracle job ordering and promotion into active worker execution.
// Responsibilities: List queued jobs, compute queue position, and promote queued work under admission control using shared coordination helpers.
// Scope: Extension-side queue orchestration only; shared promotion primitives live in extensions/oracle/shared and worker-side autonomous promotion stays in run-job.mjs.
// Usage: Imported by oracle tools/commands when queued jobs may advance after submission or cancellation.
// Invariants/Assumptions: Queue promotion runs under the global admission lock and only promotes jobs with durable archives and acquired runtime/conversation leases.
import {
  buildConversationLeaseMetadata,
  buildRuntimeLeaseMetadata,
  compareQueuedOracleJobs,
  hasDurableWorkerHandoff,
  isQueuedOracleJob,
  runQueuedJobPromotionPass,
} from "../shared/job-coordination-helpers.mjs";
import { transitionOracleJobPhase } from "../shared/job-lifecycle-helpers.mjs";
import { loadOracleConfig } from "./config.js";
import { withLock } from "./locks.js";
import { appendCleanupWarnings, createJob, isTerminalOracleJob, listOracleJobDirs, readJob, spawnWorker, terminateWorkerPid, updateJob, type OracleJob } from "./jobs.js";
import { cleanupRuntimeArtifacts, releaseRuntimeLease, tryAcquireConversationLease, tryAcquireRuntimeLease } from "./runtime.js";

export interface OracleQueuePosition {
  position: number;
  depth: number;
}

export interface PromoteQueuedJobsOptions {
  workerPath: string;
  source: string;
  spawnWorkerFn?: typeof spawnWorker;
  loadConfigFn?: typeof loadOracleConfig;
}

function isQueuedJob(job: OracleJob | undefined): job is OracleJob {
  return isQueuedOracleJob(job);
}

export function compareQueuedJobs(left: OracleJob, right: OracleJob): number {
  return compareQueuedOracleJobs(left, right);
}

export function listQueuedJobs(): OracleJob[] {
  return listOracleJobDirs()
    .map((jobDir) => readJob(jobDir))
    .filter(isQueuedJob)
    .sort(compareQueuedJobs);
}

export function getQueuePosition(jobId: string): OracleQueuePosition | undefined {
  const queuedJobs = listQueuedJobs();
  const index = queuedJobs.findIndex((job) => job.id === jobId);
  if (index === -1) return undefined;
  return {
    position: index + 1,
    depth: queuedJobs.length,
  };
}

async function failQueuedPromotion(job: OracleJob, message: string, at: string): Promise<void> {
  await updateJob(job.id, (current) => transitionOracleJobPhase(current, "failed", {
    at,
    source: "oracle:queue",
    message: `Queued promotion failed: ${message}`,
    clearNotificationClaim: true,
    patch: {
      heartbeatAt: at,
      error: message,
    },
  })).catch(() => undefined);
}

export async function promoteQueuedJobsWithinAdmissionLock(options: PromoteQueuedJobsOptions): Promise<{ promotedJobIds: string[] }> {
  const spawnWorkerFn = options.spawnWorkerFn ?? spawnWorker;
  const loadConfigFn = options.loadConfigFn ?? loadOracleConfig;

  return runQueuedJobPromotionPass<OracleJob, Awaited<ReturnType<typeof spawnWorkerFn>>>({
    listQueuedJobs,
    refreshJob: (jobId) => readJob(jobId),
    readLatestJob: (jobId) => readJob(jobId),
    isQueuedJob,
    acquireRuntimeLease: async (job, at) => {
      const config = job.config ?? loadConfigFn(job.cwd);
      const attempt = await tryAcquireRuntimeLease(config, buildRuntimeLeaseMetadata(job, at));
      return attempt.acquired;
    },
    acquireConversationLease: async (job, at) => {
      const metadata = buildConversationLeaseMetadata(job, at);
      if (!metadata) return true;
      const attempt = await tryAcquireConversationLease(metadata);
      return attempt.acquired;
    },
    releaseRuntimeLease: async (job) => {
      await releaseRuntimeLease(job.runtimeId);
    },
    markSubmitted: async (job, at) => {
      const config = job.config ?? loadConfigFn(job.cwd);
      await updateJob(job.id, (latest) => {
        if (latest.status !== "queued") {
          throw new Error(`Queued job ${latest.id} changed state during promotion (${latest.status})`);
        }
        return transitionOracleJobPhase({
          ...latest,
          config,
        }, "submitted", {
          at,
          source: "oracle:queue",
          message: "Queued job admitted for worker launch.",
          patch: {
            submittedAt: latest.submittedAt || at,
          },
        });
      });
    },
    spawnWorker: async (job) => spawnWorkerFn(options.workerPath, job.id),
    persistWorker: async (job, worker) => {
      await updateJob(job.id, (latest) => ({
        ...latest,
        workerPid: worker.pid,
        workerNonce: worker.nonce,
        workerStartedAt: worker.startedAt,
      }));
    },
    hasDurableWorkerHandoff,
    isTerminalJob: isTerminalOracleJob,
    failQueuedPromotion,
    terminateSpawnedWorker: async (worker) => {
      await terminateWorkerPid(worker.pid, worker.startedAt);
    },
    cleanupAfterFailure: async ({ job, at, spawnedWorker, runtimeLeaseAcquired, conversationLeaseAcquired }) => {
      const cleanupReport = await cleanupRuntimeArtifacts({
        runtimeId: runtimeLeaseAcquired ? job.runtimeId : undefined,
        runtimeProfileDir: runtimeLeaseAcquired ? job.runtimeProfileDir : undefined,
        runtimeSessionName: spawnedWorker ? job.runtimeSessionName : undefined,
        conversationId: conversationLeaseAcquired ? job.conversationId : undefined,
      }).catch(() => ({ attempted: [], warnings: [] }));
      if (cleanupReport.warnings.length > 0) {
        await appendCleanupWarnings(job.id, cleanupReport.warnings, at).catch(() => undefined);
      }
    },
  });
}

export async function promoteQueuedJobs(options: PromoteQueuedJobsOptions): Promise<{ promotedJobIds: string[] }> {
  return withLock("admission", "global", { processPid: process.pid, source: options.source }, async () => {
    return promoteQueuedJobsWithinAdmissionLock(options);
  });
}

export async function createQueuedJob(
  id: string,
  input: Parameters<typeof createJob>[1],
  cwd: string,
  originSessionFile: string | undefined,
  config: Parameters<typeof createJob>[4],
  runtime: Parameters<typeof createJob>[5],
): Promise<OracleJob> {
  return createJob(id, input, cwd, originSessionFile, config, runtime, { initialState: "queued" });
}
