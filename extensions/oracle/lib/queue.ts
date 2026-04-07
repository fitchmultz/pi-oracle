import { existsSync } from "node:fs";
import { loadOracleConfig } from "./config.js";
import { withLock } from "./locks.js";
import { appendCleanupWarnings, createJob, hasDurableWorkerHandoff, isTerminalOracleJob, listOracleJobDirs, readJob, spawnWorker, terminateWorkerPid, updateJob, withJobPhase, type OracleJob } from "./jobs.js";
import {
  cleanupRuntimeArtifacts,
  releaseRuntimeLease,
  tryAcquireConversationLease,
  tryAcquireRuntimeLease,
  type OracleConversationLeaseMetadata,
  type OracleRuntimeLeaseMetadata,
} from "./runtime.js";

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
  return Boolean(job && job.status === "queued");
}

export function compareQueuedJobs(left: OracleJob, right: OracleJob): number {
  const leftKey = left.queuedAt ?? left.createdAt;
  const rightKey = right.queuedAt ?? right.createdAt;
  return leftKey.localeCompare(rightKey) || left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id);
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

function runtimeLeaseMetadata(job: OracleJob, createdAt: string): OracleRuntimeLeaseMetadata {
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

function conversationLeaseMetadata(job: OracleJob, createdAt: string): OracleConversationLeaseMetadata | undefined {
  if (!job.conversationId) return undefined;
  return {
    jobId: job.id,
    conversationId: job.conversationId,
    projectId: job.projectId,
    sessionId: job.sessionId,
    createdAt,
  };
}

async function failQueuedPromotion(job: OracleJob, message: string, at: string): Promise<void> {
  await updateJob(job.id, (current) => ({
    ...current,
    ...withJobPhase("failed", {
      status: "failed",
      completedAt: at,
      heartbeatAt: at,
      notifyClaimedAt: undefined,
      notifyClaimedBy: undefined,
      error: message,
    }, at),
  })).catch(() => undefined);
}

export async function promoteQueuedJobsWithinAdmissionLock(options: PromoteQueuedJobsOptions): Promise<{ promotedJobIds: string[] }> {
  const spawnWorkerFn = options.spawnWorkerFn ?? spawnWorker;
  const loadConfigFn = options.loadConfigFn ?? loadOracleConfig;
  const promotedJobIds: string[] = [];

  for (const queuedJob of listQueuedJobs()) {
    const now = new Date().toISOString();
    let runtimeLeaseAcquired = false;
    let conversationLeaseAcquired = false;
    let workerSpawned = false;
    let spawnedWorker: Awaited<ReturnType<typeof spawnWorker>> | undefined;

    try {
      const current = readJob(queuedJob.id);
      if (!isQueuedJob(current)) continue;
      if (!existsSync(current.archivePath)) {
        await failQueuedPromotion(current, `Queued oracle archive is missing: ${current.archivePath}`, now);
        continue;
      }

      const config = current.config ?? loadConfigFn(current.cwd);
      const runtimeAttempt = await tryAcquireRuntimeLease(config, runtimeLeaseMetadata(current, now));
      if (!runtimeAttempt.acquired) break;
      runtimeLeaseAcquired = true;

      const conversationMetadata = conversationLeaseMetadata(current, now);
      if (conversationMetadata) {
        const conversationAttempt = await tryAcquireConversationLease(conversationMetadata);
        if (!conversationAttempt.acquired) {
          await releaseRuntimeLease(current.runtimeId).catch(() => undefined);
          runtimeLeaseAcquired = false;
          continue;
        }
        conversationLeaseAcquired = true;
      }

      await updateJob(current.id, (latest) => {
        if (latest.status !== "queued") {
          throw new Error(`Queued job ${latest.id} changed state during promotion (${latest.status})`);
        }
        return {
          ...latest,
          config,
          ...withJobPhase("submitted", {
            status: "submitted",
            submittedAt: latest.submittedAt || now,
          }, now),
        };
      });

      spawnedWorker = await spawnWorkerFn(options.workerPath, current.id);
      workerSpawned = true;
      const worker = spawnedWorker;
      await updateJob(current.id, (latest) => ({
        ...latest,
        workerPid: worker.pid,
        workerNonce: worker.nonce,
        workerStartedAt: worker.startedAt,
      }));
      promotedJobIds.push(current.id);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const latest = readJob(queuedJob.id);
      if (workerSpawned && latest && hasDurableWorkerHandoff(latest)) {
        promotedJobIds.push(queuedJob.id);
        continue;
      }
      if (spawnedWorker) {
        await terminateWorkerPid(spawnedWorker.pid, spawnedWorker.startedAt).catch(() => undefined);
      }
      if (latest && !isTerminalOracleJob(latest)) {
        await failQueuedPromotion(latest, message, now);
      }
      const cleanupReport = await cleanupRuntimeArtifacts({
        runtimeId: runtimeLeaseAcquired ? queuedJob.runtimeId : undefined,
        runtimeProfileDir: runtimeLeaseAcquired ? queuedJob.runtimeProfileDir : undefined,
        runtimeSessionName: workerSpawned ? queuedJob.runtimeSessionName : undefined,
        conversationId: conversationLeaseAcquired ? queuedJob.conversationId : undefined,
      }).catch(() => ({ attempted: [], warnings: [] }));
      if (cleanupReport.warnings.length > 0) {
        await appendCleanupWarnings(queuedJob.id, cleanupReport.warnings, now).catch(() => undefined);
      }
    }
  }

  return { promotedJobIds };
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
