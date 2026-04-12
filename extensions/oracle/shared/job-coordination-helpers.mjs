// Purpose: Provide shared oracle job coordination helpers for admission control, lease metadata, and queued promotion orchestration.
// Responsibilities: Normalize queue ordering, derive lease metadata, detect durable handoff/admission blockers, and run a single queued-promotion pass.
// Scope: Pure coordination/state-machine logic only; filesystem I/O and job persistence remain in injected callbacks.
// Usage: Imported by lib/queue.ts, lib/runtime.ts, lib/jobs.ts, and worker/run-job.mjs to keep concurrency semantics aligned.
// Invariants/Assumptions: Queued jobs have durable ids/archive paths, and callers provide side-effect callbacks that preserve atomic job updates.

import { existsSync } from "node:fs";
import { isTrackedProcessAlive } from "./process-helpers.mjs";

/** @typedef {import("./job-coordination-helpers.d.mts").OracleAdmissionBlockingJobLike} OracleAdmissionBlockingJobLike */
/** @typedef {import("./job-coordination-helpers.d.mts").OracleConversationLeaseMetadataLike} OracleConversationLeaseMetadataLike */
/** @typedef {import("./job-coordination-helpers.d.mts").OracleDurableWorkerHandoffJobLike} OracleDurableWorkerHandoffJobLike */
/** @typedef {import("./job-coordination-helpers.d.mts").OracleRuntimeLeaseMetadataLike} OracleRuntimeLeaseMetadataLike */

/**
 * @param {OracleDurableWorkerHandoffJobLike | undefined} job
 * @returns {boolean}
 */
export function isQueuedOracleJob(job) {
  return job?.status === "queued";
}

/**
 * @param {{ createdAt: string; queuedAt?: string; id: string }} left
 * @param {{ createdAt: string; queuedAt?: string; id: string }} right
 * @returns {number}
 */
export function compareQueuedOracleJobs(left, right) {
  const leftKey = left.queuedAt ?? left.createdAt;
  const rightKey = right.queuedAt ?? right.createdAt;
  return leftKey.localeCompare(rightKey) || left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id);
}

/**
 * @param {OracleDurableWorkerHandoffJobLike | undefined} job
 * @returns {boolean}
 */
export function hasDurableWorkerHandoff(job) {
  if (!job || job.status === "queued") return false;
  if (job.workerPid) return true;
  return false;
}

/**
 * @param {OracleAdmissionBlockingJobLike | undefined} job
 * @param {(pid: number | undefined, startedAt?: string) => boolean} [isTrackedProcessAliveFn]
 * @returns {boolean}
 */
export function hasAdmissionBlockingWorker(job, isTrackedProcessAliveFn = isTrackedProcessAlive) {
  if (!job?.workerPid) return false;
  return isTrackedProcessAliveFn(job.workerPid, job.workerStartedAt);
}

/**
 * @param {OracleAdmissionBlockingJobLike | undefined} job
 * @param {(pid: number | undefined, startedAt?: string) => boolean} [isTrackedProcessAliveFn]
 * @returns {boolean}
 */
export function jobBlocksAdmission(job, isTrackedProcessAliveFn = isTrackedProcessAlive) {
  return ["preparing", "submitted", "waiting"].includes(String(job?.status || "")) ||
    job?.cleanupPending === true ||
    hasAdmissionBlockingWorker(job, isTrackedProcessAliveFn);
}

/**
 * @param {{ id: string; runtimeId: string; runtimeSessionName: string; runtimeProfileDir: string; projectId: string; sessionId: string }} job
 * @param {string} createdAt
 * @returns {OracleRuntimeLeaseMetadataLike}
 */
export function buildRuntimeLeaseMetadata(job, createdAt) {
  return {
    jobId: job.id,
    runtimeId: job.runtimeId,
    runtimeSessionName: job.runtimeSessionName,
    runtimeProfileDir: job.runtimeProfileDir,
    projectId: job.projectId,
    sessionId: job.sessionId,
    createdAt,
  };
}

/**
 * @param {{ id: string; conversationId?: string; projectId: string; sessionId: string }} job
 * @param {string} createdAt
 * @returns {OracleConversationLeaseMetadataLike | undefined}
 */
export function buildConversationLeaseMetadata(job, createdAt) {
  if (!job.conversationId) return undefined;
  return {
    jobId: job.id,
    conversationId: job.conversationId,
    projectId: job.projectId,
    sessionId: job.sessionId,
    createdAt,
  };
}

/**
 * @template {{ id: string; archivePath: string }} TJob
 * @template TWorker
 * @param {import("./job-coordination-helpers.d.mts").OracleQueuedPromotionOptions<TJob, TWorker>} options
 * @returns {Promise<{ promotedJobIds: string[] }>}
 */
export async function runQueuedJobPromotionPass(options) {
  const promotedJobIds = [];
  const isQueuedJob = options.isQueuedJob ?? isQueuedOracleJob;
  const durableHandoff = options.hasDurableWorkerHandoff ?? hasDurableWorkerHandoff;

  for (const queuedJob of options.listQueuedJobs()) {
    const promotedAt = new Date().toISOString();
    let runtimeLeaseAcquired = false;
    let conversationLeaseAcquired = false;
    /** @type {TWorker | undefined} */
    let spawnedWorker;

    try {
      const current = options.refreshJob(queuedJob.id);
      if (!isQueuedJob(current)) continue;
      if (!existsSync(current.archivePath)) {
        await options.failQueuedPromotion(current, `Queued oracle archive is missing: ${current.archivePath}`, promotedAt);
        continue;
      }

      const runtimeAttempt = await options.acquireRuntimeLease(current, promotedAt);
      if (!runtimeAttempt) break;
      runtimeLeaseAcquired = true;

      const conversationAttempt = await options.acquireConversationLease(current, promotedAt);
      if (!conversationAttempt) {
        await options.releaseRuntimeLease(current).catch(() => undefined);
        runtimeLeaseAcquired = false;
        continue;
      }
      conversationLeaseAcquired = true;

      await options.markSubmitted(current, promotedAt);
      spawnedWorker = await options.spawnWorker(current);
      await options.persistWorker(current, spawnedWorker);
      promotedJobIds.push(current.id);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const latest = options.readLatestJob(queuedJob.id);
      if (spawnedWorker && durableHandoff(latest)) {
        promotedJobIds.push(queuedJob.id);
        await options.onDurableHandoff?.(queuedJob, latest);
        continue;
      }
      if (spawnedWorker) {
        await options.terminateSpawnedWorker(spawnedWorker).catch(() => undefined);
      }
      if (latest && !options.isTerminalJob(latest)) {
        await options.failQueuedPromotion(latest, message, promotedAt);
      }
      const failureOutcome = await options.cleanupAfterFailure({
        job: queuedJob,
        latest,
        error,
        at: promotedAt,
        spawnedWorker,
        runtimeLeaseAcquired,
        conversationLeaseAcquired,
      });
      if (failureOutcome === "break") break;
    }
  }

  return { promotedJobIds };
}
