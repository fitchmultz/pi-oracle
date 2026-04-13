// Purpose: Manage durable oracle job state, lifecycle transitions, reconciliation, and worker orchestration from the extension side.
// Responsibilities: Persist job metadata, detect stale workers, coordinate notification/wake-up state, and spawn or terminate worker processes safely.
// Scope: Extension-facing job management only; low-level shared process and state primitives live in extensions/oracle/shared.
// Usage: Imported by oracle commands, tools, queue logic, poller flows, and runtime cleanup/reconciliation paths.
// Invariants/Assumptions: Job mutations happen under per-job locks, worker identity checks defend against PID reuse, and persisted jobs remain the source of truth.
import { createHash, randomUUID } from "node:crypto";
import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative as relativePath, resolve, sep } from "node:path";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import {
  ACTIVE_ORACLE_JOB_STATUSES,
  applyOracleJobCleanupWarnings,
  claimOracleJobNotification,
  clearOracleJobCleanupState,
  getOracleJobStatusForPhase,
  markOracleJobCreated,
  markOracleJobNotified,
  markOracleJobWakeupSettled,
  noteOracleJobWakeupRequested,
  OPEN_ORACLE_JOB_STATUSES,
  recordOracleJobNotificationTarget,
  releaseOracleJobNotificationClaim,
  TERMINAL_ORACLE_JOB_STATUSES,
  transitionOracleJobPhase,
} from "../shared/job-lifecycle-helpers.mjs";
import type { OracleJobLifecycleEvent as SharedOracleJobLifecycleEvent, OracleJobPhase as SharedOracleJobPhase, OracleJobStatus as SharedOracleJobStatus } from "../shared/job-lifecycle-helpers.mjs";
import { hasDurableWorkerHandoff as sharedHasDurableWorkerHandoff } from "../shared/job-coordination-helpers.mjs";
import { isTrackedProcessAlive, readProcessStartedAt, spawnDetachedNodeProcess, terminateTrackedProcess } from "../shared/process-helpers.mjs";
import type { OracleConfig, OracleResolvedSelection } from "./config.js";
import { withJobLock, withLock } from "./locks.js";
import { cleanupRuntimeArtifacts, getProjectId, getSessionId, parseConversationId, requirePersistedSessionFile, type OracleCleanupReport } from "./runtime.js";

export type OracleJobStatus = SharedOracleJobStatus;
export type OracleJobPhase = SharedOracleJobPhase;

export type OracleWakeupSettlementSource = "oracle_read" | "oracle_status" | "oracle_read_command";

export { ACTIVE_ORACLE_JOB_STATUSES, OPEN_ORACLE_JOB_STATUSES, TERMINAL_ORACLE_JOB_STATUSES };
export const ORACLE_MISSING_WORKER_GRACE_MS = 30_000;
export const ORACLE_STALE_HEARTBEAT_MS = 3 * 60 * 1000;
export const ORACLE_NOTIFICATION_CLAIM_TTL_MS = 60_000;
export const ORACLE_WAKEUP_MAX_ATTEMPTS = 3;
export const ORACLE_WAKEUP_RETRY_DELAYS_MS = [0, 15_000, 60_000] as const;
export const ORACLE_WAKEUP_POST_SEND_RETENTION_MS = 2 * 60 * 1000;
const ORACLE_COMPLETE_JOB_RETENTION_MS = 14 * 24 * 60 * 60 * 1000;
const ORACLE_FAILED_JOB_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
export const DEFAULT_ORACLE_JOBS_DIR = "/tmp";
export const ORACLE_JOBS_DIR_ENV = "PI_ORACLE_JOBS_DIR";
const ORACLE_JOBS_DIR = process.env[ORACLE_JOBS_DIR_ENV]?.trim() || DEFAULT_ORACLE_JOBS_DIR;

export function isActiveOracleJob(job: Pick<OracleJob, "status">): boolean {
  return ACTIVE_ORACLE_JOB_STATUSES.includes(job.status);
}

export function isOpenOracleJob(job: Pick<OracleJob, "status">): boolean {
  return OPEN_ORACLE_JOB_STATUSES.includes(job.status);
}

export function isTerminalOracleJob(job: Pick<OracleJob, "status">): boolean {
  return TERMINAL_ORACLE_JOB_STATUSES.includes(job.status);
}

export function shouldAdvanceQueueAfterCancellation(job: Pick<OracleJob, "status" | "cleanupWarnings" | "cleanupPending">): boolean {
  return job.status === "cancelled" && !job.cleanupPending && !job.cleanupWarnings?.length;
}

export function hasRetainedPreSubmitArchive(job: Pick<OracleJob, "submittedAt" | "archiveDeletedAfterUpload" | "archivePath">): boolean {
  return !job.submittedAt && !job.archiveDeletedAfterUpload && typeof job.archivePath === "string" && job.archivePath.length > 0;
}

export function hasDurableWorkerHandoff(
  job: Pick<OracleJob, "status" | "phase" | "workerPid" | "workerStartedAt" | "heartbeatAt">,
): boolean {
  return sharedHasDurableWorkerHandoff(job);
}

export function hasPersistedOriginSession(
  job: Pick<OracleJob, "originSessionFile" | "sessionId">,
): job is Pick<OracleJob, "originSessionFile" | "sessionId"> & { originSessionFile: string } {
  return typeof job.originSessionFile === "string" && job.originSessionFile.length > 0 && job.sessionId === job.originSessionFile;
}

export function isWorkerProcessAlive(pid: number | undefined, startedAt?: string): boolean {
  return isTrackedProcessAlive(pid, startedAt);
}

export interface OracleArtifactRecord {
  displayName?: string;
  fileName?: string;
  sourcePath?: string;
  copiedPath?: string;
  url?: string;
  state?: number | string;
  size?: number;
  sha256?: string;
  detectedType?: string;
  unconfirmed?: boolean;
  error?: string;
  downloadId?: string;
  matchesUploadedArchive?: boolean;
}

export interface OracleJob {
  id: string;
  status: OracleJobStatus;
  phase: OracleJobPhase;
  phaseAt: string;
  createdAt: string;
  queuedAt?: string;
  submittedAt?: string;
  completedAt?: string;
  heartbeatAt?: string;
  cwd: string;
  projectId: string;
  sessionId: string;
  originSessionFile?: string;
  requestSource: "command" | "tool";
  selection: OracleResolvedSelection;
  followUpToJobId?: string;
  chatUrl?: string;
  conversationId?: string;
  responsePath?: string;
  responseFormat?: "text/plain";
  artifactPaths: string[];
  artifactsManifestPath?: string;
  archivePath: string;
  archiveSha256?: string;
  archiveDeletedAfterUpload: boolean;
  notifiedAt?: string;
  notificationEntryId?: string;
  notificationSessionKey?: string;
  notificationSessionFile?: string;
  wakeupAttemptCount?: number;
  wakeupLastRequestedAt?: string;
  wakeupSettledAt?: string;
  wakeupSettledSource?: OracleWakeupSettlementSource;
  wakeupSettledSessionFile?: string;
  wakeupSettledSessionKey?: string;
  wakeupSettledBeforeFirstAttempt?: boolean;
  wakeupObservedAt?: string;
  wakeupObservedSource?: OracleWakeupSettlementSource;
  wakeupObservedSessionFile?: string;
  wakeupObservedSessionKey?: string;
  notifyClaimedAt?: string;
  notifyClaimedBy?: string;
  artifactFailureCount?: number;
  error?: string;
  promptPath: string;
  reasoningPath?: string;
  logsDir: string;
  workerLogPath: string;
  workerPid?: number;
  workerNonce?: string;
  workerStartedAt?: string;
  runtimeId: string;
  runtimeSessionName: string;
  runtimeProfileDir: string;
  seedGeneration?: string;
  config: OracleConfig;
  cleanupWarnings?: string[];
  lastCleanupAt?: string;
  cleanupPending?: boolean;
  lifecycleEvents?: SharedOracleJobLifecycleEvent[];
}

export interface OracleSubmitInput {
  prompt: string;
  files: string[];
  selection: OracleResolvedSelection;
  followUpToJobId?: string;
  chatUrl?: string;
  requestSource: "command" | "tool";
}

export interface OracleRuntimeAllocation {
  runtimeId: string;
  runtimeSessionName: string;
  runtimeProfileDir: string;
  seedGeneration?: string;
}

export function getSessionFile(ctx: ExtensionContext): string | undefined {
  const manager = ctx.sessionManager as unknown as { getSessionFile?: () => string | undefined };
  return manager.getSessionFile?.();
}

export function getOracleJobsDir(): string {
  return ORACLE_JOBS_DIR;
}

export function getJobDir(id: string): string {
  return join(ORACLE_JOBS_DIR, `oracle-${id}`);
}

export function listOracleJobDirs(): string[] {
  if (!existsSync(ORACLE_JOBS_DIR)) return [];
  return readdirSync(ORACLE_JOBS_DIR)
    .filter((name) => name.startsWith("oracle-"))
    .map((name) => join(ORACLE_JOBS_DIR, name))
    .filter((path) => existsSync(join(path, "job.json")));
}

export function readJob(jobDirOrId: string): OracleJob | undefined {
  const jobDir = existsSync(join(jobDirOrId, "job.json")) ? jobDirOrId : getJobDir(jobDirOrId);
  const jobPath = join(jobDir, "job.json");
  if (!existsSync(jobPath)) return undefined;
  try {
    return JSON.parse(readFileSync(jobPath, "utf8")) as OracleJob;
  } catch {
    return undefined;
  }
}

export function listJobsForCwd(cwd: string): OracleJob[] {
  const projectId = getProjectId(cwd);
  return listOracleJobDirs()
    .map((dir) => readJob(dir))
    .filter((job): job is OracleJob => Boolean(job && job.projectId === projectId))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

async function writeJobUnlocked(job: OracleJob): Promise<void> {
  const jobDir = getJobDir(job.id);
  const jobPath = join(jobDir, "job.json");
  const tmpPath = `${jobPath}.${process.pid}.${Date.now()}.tmp`;
  await mkdir(jobDir, { recursive: true, mode: 0o700 });
  await chmod(jobDir, 0o700).catch(() => undefined);
  await writeFile(tmpPath, `${JSON.stringify(job, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await chmod(tmpPath, 0o600).catch(() => undefined);
  await rename(tmpPath, jobPath);
  await chmod(jobPath, 0o600).catch(() => undefined);
}

export async function writeJob(job: OracleJob): Promise<void> {
  await withJobLock(job.id, { processPid: process.pid, action: "writeJob" }, async () => {
    await writeJobUnlocked(job);
  });
}

export async function updateJob(id: string, mutate: (job: OracleJob) => OracleJob): Promise<OracleJob> {
  return withJobLock(id, { processPid: process.pid, action: "updateJob" }, async () => {
    const current = readJob(id);
    if (!current) throw new Error(`Oracle job not found: ${id}`);
    const next = mutate(current);
    await writeJobUnlocked(next);
    return next;
  });
}

export async function appendCleanupWarnings(jobId: string, warnings: string[], at = new Date().toISOString()): Promise<OracleJob | undefined> {
  if (warnings.length === 0) return readJob(jobId);
  try {
    return await updateJob(jobId, (job) => applyOracleJobCleanupWarnings(job, warnings, { at, source: "oracle:jobs" }));
  } catch {
    return readJob(jobId);
  }
}

export async function clearCleanupPending(jobId: string, at = new Date().toISOString()): Promise<OracleJob | undefined> {
  try {
    return await updateJob(jobId, (job) => clearOracleJobCleanupState(job, { at, source: "oracle:jobs" }));
  } catch {
    return readJob(jobId);
  }
}

function parseTimestamp(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function notificationClaimIsOwnedBy(job: Pick<OracleJob, "notifyClaimedAt" | "notifyClaimedBy">, claimedBy: string, now = Date.now()): boolean {
  if (job.notifyClaimedBy !== claimedBy) return false;
  const claimedAtMs = parseTimestamp(job.notifyClaimedAt);
  if (claimedAtMs === undefined) return false;
  return now - claimedAtMs < ORACLE_NOTIFICATION_CLAIM_TTL_MS;
}

function notificationClaimIsLive(job: Pick<OracleJob, "notifyClaimedAt" | "notifyClaimedBy">, now = Date.now()): boolean {
  if (!job.notifyClaimedBy) return false;
  const claimedAtMs = parseTimestamp(job.notifyClaimedAt);
  if (claimedAtMs === undefined) return false;
  return now - claimedAtMs < ORACLE_NOTIFICATION_CLAIM_TTL_MS;
}

function getWakeupRetentionGraceDeadline(job: Pick<OracleJob, "wakeupLastRequestedAt">, now = Date.now()): { retryAt: string; remainingMs: number } | undefined {
  const lastRequestedAtMs = parseTimestamp(job.wakeupLastRequestedAt);
  if (lastRequestedAtMs === undefined) return undefined;
  const retryAtMs = lastRequestedAtMs + ORACLE_WAKEUP_POST_SEND_RETENTION_MS;
  return {
    retryAt: new Date(retryAtMs).toISOString(),
    remainingMs: Math.max(0, retryAtMs - now),
  };
}

function wakeupRetentionGraceIsActive(job: Pick<OracleJob, "wakeupLastRequestedAt">, now = Date.now()): boolean {
  const lastRequestedAtMs = parseTimestamp(job.wakeupLastRequestedAt);
  if (lastRequestedAtMs === undefined) return false;
  return now - lastRequestedAtMs < ORACLE_WAKEUP_POST_SEND_RETENTION_MS;
}

export function getWakeupRetryDelayMs(attemptCount: number): number {
  return ORACLE_WAKEUP_RETRY_DELAYS_MS[Math.min(attemptCount, ORACLE_WAKEUP_RETRY_DELAYS_MS.length - 1)] ?? ORACLE_WAKEUP_RETRY_DELAYS_MS[ORACLE_WAKEUP_RETRY_DELAYS_MS.length - 1];
}

export function shouldRequestWakeup(job: Pick<OracleJob, "wakeupAttemptCount" | "wakeupLastRequestedAt" | "wakeupSettledAt">, now = Date.now()): boolean {
  if (job.wakeupSettledAt) return false;
  const attempts = job.wakeupAttemptCount ?? 0;
  if (attempts >= ORACLE_WAKEUP_MAX_ATTEMPTS) return false;
  const lastRequestedAtMs = parseTimestamp(job.wakeupLastRequestedAt);
  if (lastRequestedAtMs === undefined) return true;
  return now - lastRequestedAtMs >= getWakeupRetryDelayMs(attempts);
}

export function withJobPhase<T extends Pick<OracleJob, "phase" | "phaseAt" | "status">>(
  phase: OracleJobPhase,
  patch?: Omit<Partial<OracleJob>, "phase" | "phaseAt">,
  at = new Date().toISOString(),
): Partial<OracleJob> {
  return {
    ...(patch || {}),
    status: (patch?.status as OracleJobStatus | undefined) ?? getOracleJobStatusForPhase(phase),
    phase,
    phaseAt: at,
  };
}

function isTerminalOracleJobStatus(status: OracleJobStatus): boolean {
  return TERMINAL_ORACLE_JOB_STATUSES.includes(status);
}

export async function terminateWorkerPid(
  pid: number | undefined,
  startedAt?: string,
  options?: { termGraceMs?: number; killGraceMs?: number },
): Promise<boolean> {
  return terminateTrackedProcess(pid, startedAt, options);
}

export function getStaleOracleJobReason(job: OracleJob, now = Date.now()): string | undefined {
  if (!isActiveOracleJob(job)) return undefined;

  const heartbeatMs = parseTimestamp(job.heartbeatAt);
  const submittedMs = parseTimestamp(job.submittedAt);
  const createdMs = parseTimestamp(job.createdAt);
  const baselineMs = heartbeatMs ?? submittedMs ?? createdMs;
  if (!baselineMs) return "Oracle job has no valid timestamps";

  if (!job.workerPid) {
    if (now - baselineMs > ORACLE_MISSING_WORKER_GRACE_MS) {
      return "Oracle job is active but has no worker PID";
    }
    return undefined;
  }

  const currentStartedAt = readProcessStartedAt(job.workerPid);
  if (!currentStartedAt) {
    return `Oracle worker PID ${job.workerPid} is no longer running`;
  }

  if (job.workerStartedAt && currentStartedAt !== job.workerStartedAt) {
    return `Oracle worker PID ${job.workerPid} no longer matches the recorded process identity`;
  }

  if (now - baselineMs > ORACLE_STALE_HEARTBEAT_MS) {
    return `Oracle worker heartbeat is stale (${Math.round((now - baselineMs) / 1000)}s since last update)`;
  }

  return undefined;
}

function getTerminalCleanupStaleReason(job: Pick<OracleJob, "status" | "cleanupPending" | "cleanupWarnings" | "lastCleanupAt" | "heartbeatAt" | "completedAt" | "phaseAt" | "createdAt" | "workerPid" | "workerStartedAt">, now = Date.now()): string | undefined {
  if (!isTerminalOracleJob(job)) return undefined;
  if (!job.cleanupPending && !job.cleanupWarnings?.length) return undefined;

  const baselineMs =
    parseTimestamp(job.lastCleanupAt) ??
    parseTimestamp(job.heartbeatAt) ??
    parseTimestamp(job.completedAt) ??
    parseTimestamp(job.phaseAt) ??
    parseTimestamp(job.createdAt);
  if (baselineMs === undefined) return "Oracle terminal cleanup has no valid timestamps";
  if (!job.workerPid) return undefined;

  const currentStartedAt = readProcessStartedAt(job.workerPid);
  if (!currentStartedAt) {
    return `Oracle terminal cleanup worker PID ${job.workerPid} is no longer running`;
  }

  if (job.workerStartedAt && currentStartedAt !== job.workerStartedAt) {
    return `Oracle terminal cleanup worker PID ${job.workerPid} no longer matches the recorded process identity`;
  }

  if (now - baselineMs > ORACLE_STALE_HEARTBEAT_MS) {
    return `Oracle terminal cleanup is stale (${Math.round((now - baselineMs) / 1000)}s since last update)`;
  }

  return undefined;
}

export async function cleanupJobResources(
  job: Pick<OracleJob, "submittedAt" | "runtimeId" | "runtimeProfileDir" | "runtimeSessionName" | "conversationId" | "archivePath" | "archiveDeletedAfterUpload">,
): Promise<OracleCleanupReport> {
  const report: OracleCleanupReport = { attempted: [], warnings: [] };

  if (hasRetainedPreSubmitArchive(job)) {
    report.attempted.push("queuedArchive");
    await rm(job.archivePath, { force: true }).catch((error: Error) => {
      report.warnings.push(`Failed to remove queued archive ${job.archivePath}: ${error.message}`);
    });
  }

  if (!job.submittedAt) {
    return report;
  }

  const runtimeReport = await cleanupRuntimeArtifacts({
    runtimeId: job.runtimeId,
    runtimeProfileDir: job.runtimeProfileDir,
    runtimeSessionName: job.runtimeSessionName,
    conversationId: job.conversationId,
  });

  return {
    attempted: [...report.attempted, ...runtimeReport.attempted],
    warnings: [...report.warnings, ...runtimeReport.warnings],
  };
}

function getCleanupRetentionMs(job: OracleJob): { complete: number; failed: number } {
  return {
    complete: job.config.cleanup?.completeJobRetentionMs ?? ORACLE_COMPLETE_JOB_RETENTION_MS,
    failed: job.config.cleanup?.failedJobRetentionMs ?? ORACLE_FAILED_JOB_RETENTION_MS,
  };
}

export function shouldPruneTerminalJob(job: OracleJob, now = Date.now()): boolean {
  if (!isTerminalOracleJobStatus(job.status)) return false;
  if (job.cleanupPending || job.cleanupWarnings?.length) return false;
  if (notificationClaimIsLive(job, now)) return false;
  if (wakeupRetentionGraceIsActive(job, now)) return false;
  const completedMs = parseTimestamp(job.completedAt) ?? parseTimestamp(job.createdAt);
  if (completedMs === undefined) return false;
  const ageMs = now - completedMs;

  const retention = getCleanupRetentionMs(job);

  if (job.status === "complete" || job.status === "cancelled") {
    return ageMs >= retention.complete;
  }

  if (job.status === "failed") {
    return ageMs >= retention.failed;
  }

  return false;
}

export async function removeTerminalOracleJob(job: OracleJob): Promise<{ removed: boolean; cleanupReport: OracleCleanupReport }> {
  if (!isTerminalOracleJob(job)) return { removed: false, cleanupReport: { attempted: [], warnings: [] } };

  return withJobLock(job.id, { processPid: process.pid, action: "removeTerminalOracleJob" }, async () => {
    const current = readJob(job.id);
    if (!current) return { removed: true, cleanupReport: { attempted: [], warnings: [] } };
    if (!isTerminalOracleJob(current)) return { removed: false, cleanupReport: { attempted: [], warnings: [] } };
    if (notificationClaimIsLive(current)) {
      return {
        removed: false,
        cleanupReport: {
          attempted: [],
          warnings: [`Refusing to remove terminal oracle job ${current.id} while a notification delivery is in flight.`],
        },
      };
    }
    const nowMs = Date.now();
    if (wakeupRetentionGraceIsActive(current, nowMs)) {
      const graceDeadline = getWakeupRetentionGraceDeadline(current, nowMs);
      const retryHint = graceDeadline
        ? ` Retry after ${graceDeadline.retryAt} (${Math.ceil(graceDeadline.remainingMs / 1000)}s remaining).`
        : "";
      return {
        removed: false,
        cleanupReport: {
          attempted: [],
          warnings: [`Refusing to remove terminal oracle job ${current.id} because its wake-up delivery is still within the post-send retention grace window.${retryHint}`],
        },
      };
    }
    if (current.workerPid && isWorkerProcessAlive(current.workerPid, current.workerStartedAt)) {
      return {
        removed: false,
        cleanupReport: {
          attempted: [],
          warnings: [`Refusing to remove terminal oracle job ${current.id} while worker PID ${current.workerPid} is still live.`],
        },
      };
    }

    const cleanupReport = await cleanupJobResources(current);
    if (cleanupReport.warnings.length > 0) {
      await writeJobUnlocked(applyOracleJobCleanupWarnings(current, cleanupReport.warnings, {
        at: new Date().toISOString(),
        source: "oracle:cleanup",
        message: "Terminal job cleanup completed with warnings during removal.",
      }));
      return { removed: false, cleanupReport };
    }
    await rm(getJobDir(current.id), { recursive: true, force: true });
    return { removed: true, cleanupReport };
  });
}

export async function pruneTerminalOracleJobs(now = Date.now()): Promise<string[]> {
  const removedJobIds: string[] = [];

  for (const jobDir of listOracleJobDirs()) {
    const job = readJob(jobDir);
    if (!job || !shouldPruneTerminalJob(job, now)) continue;
    const removed = await removeTerminalOracleJob(job);
    if (removed.removed) {
      removedJobIds.push(job.id);
    }
  }

  return removedJobIds;
}

export async function reconcileStaleOracleJobs(): Promise<OracleJob[]> {
  const repaired: OracleJob[] = [];
  const now = Date.now();
  const recoveredAt = new Date(now).toISOString();

  for (const jobDir of listOracleJobDirs()) {
    const job = readJob(jobDir);
    if (!job) continue;

    if (isTerminalOracleJob(job) && (job.cleanupPending || job.cleanupWarnings?.length)) {
      let cleanupTarget: OracleJob | undefined;
      let blockedWarning: string | undefined;

      await withJobLock(job.id, { processPid: process.pid, action: "reconcileTerminalCleanupJob" }, async () => {
        const current = readJob(job.id);
        if (!current || !isTerminalOracleJob(current) || (!current.cleanupPending && !current.cleanupWarnings?.length)) return;

        if (current.workerPid && isWorkerProcessAlive(current.workerPid, current.workerStartedAt)) {
          const staleCleanupReason = getTerminalCleanupStaleReason(current, now);
          if (!staleCleanupReason) return;
          const terminated = await terminateWorkerPid(current.workerPid, current.workerStartedAt);
          if (!terminated) {
            blockedWarning = `Oracle terminal cleanup is blocked because worker PID ${current.workerPid} could not be terminated safely after ${staleCleanupReason}.`;
            return;
          }
        }

        cleanupTarget = current;
      });

      if (blockedWarning) {
        const blocked = await appendCleanupWarnings(job.id, [blockedWarning], recoveredAt);
        if (blocked) repaired.push(blocked);
        continue;
      }
      if (!cleanupTarget) continue;

      const cleanupReport = await cleanupJobResources(cleanupTarget);
      if (cleanupReport.warnings.length > 0) {
        const withWarnings = await appendCleanupWarnings(job.id, cleanupReport.warnings, recoveredAt);
        if (withWarnings) repaired.push(withWarnings);
      } else {
        const recoveredJob = await clearCleanupPending(job.id, recoveredAt);
        if (recoveredJob) repaired.push(recoveredJob);
      }
      continue;
    }

    const staleReason = getStaleOracleJobReason(job, now);
    if (!staleReason) continue;

    let terminated = false;
    let transitioned = false;
    let repairedJob: OracleJob | undefined;

    await withJobLock(job.id, { processPid: process.pid, action: "reconcileStaleOracleJob" }, async () => {
      const current = readJob(job.id);
      if (!current) return;
      const currentStaleReason = getStaleOracleJobReason(current, now);
      if (!currentStaleReason) return;

      terminated = await terminateWorkerPid(current.workerPid, current.workerStartedAt);
      transitioned = true;
      const suffix = current.workerPid
        ? terminated
          ? ` Terminated stale worker PID ${current.workerPid}.`
          : ` Failed to terminate stale worker PID ${current.workerPid}.`
        : "";
      repairedJob = transitionOracleJobPhase(current, "failed", {
        at: recoveredAt,
        source: "oracle:reconcile",
        message: `Recovered stale job: ${currentStaleReason}.${suffix}`.trim(),
        clearNotificationClaim: true,
        patch: {
          heartbeatAt: recoveredAt,
          cleanupPending: terminated,
          error: current.error
            ? `${current.error}\nRecovered stale job: ${currentStaleReason}.${suffix}`.trim()
            : `Recovered stale job: ${currentStaleReason}.${suffix}`.trim(),
        },
      });
      await writeJobUnlocked(repairedJob);
    });

    if (!transitioned || !repairedJob || !isTerminalOracleJob(repairedJob)) continue;

    if (!terminated) {
      const cleanupWarnings = [
        `Oracle runtime cleanup is blocked because worker PID ${job.workerPid ?? "unknown"} could not be terminated safely.`,
      ];
      const blocked = await appendCleanupWarnings(repairedJob.id, cleanupWarnings, recoveredAt);
      repaired.push(blocked ?? repairedJob);
      continue;
    }

    const cleanupReport = await cleanupJobResources(repairedJob);
    if (cleanupReport.warnings.length > 0) {
      const withWarnings = await appendCleanupWarnings(repairedJob.id, cleanupReport.warnings, recoveredAt);
      repaired.push(withWarnings ?? repairedJob);
      continue;
    }

    const finalized = await clearCleanupPending(repairedJob.id, recoveredAt);
    repaired.push(finalized ?? repairedJob);
  }

  return repaired;
}

export async function sha256File(path: string): Promise<string> {
  const buffer = await readFile(path);
  return createHash("sha256").update(buffer).digest("hex");
}

export async function tryClaimNotification(jobId: string, claimedBy: string, now = new Date().toISOString()): Promise<OracleJob | undefined> {
  return withJobLock(jobId, { processPid: process.pid, action: "tryClaimNotification", claimedBy }, async () => {
    const current = readJob(jobId);
    if (!current) return undefined;
    if (!isTerminalOracleJobStatus(current.status)) return undefined;
    if (current.notifiedAt) return undefined;
    if (!hasPersistedOriginSession(current)) return undefined;
    const nowMs = parseTimestamp(now) ?? Date.now();
    if (shouldPruneTerminalJob(current, nowMs)) return undefined;
    if (!shouldRequestWakeup(current, nowMs)) return undefined;

    const claimedAtMs = parseTimestamp(current.notifyClaimedAt);
    const claimIsLive =
      current.notifyClaimedBy &&
      current.notifyClaimedBy !== claimedBy &&
      claimedAtMs !== undefined &&
      Date.now() - claimedAtMs < ORACLE_NOTIFICATION_CLAIM_TTL_MS;
    if (claimIsLive) return undefined;

    const next = claimOracleJobNotification(current, claimedBy, now);
    await writeJobUnlocked(next);
    return next;
  });
}

export async function recordNotificationTarget(
  jobId: string,
  claimedBy: string,
  options: { notificationSessionKey: string; notificationSessionFile?: string },
): Promise<OracleJob> {
  return withJobLock(jobId, { processPid: process.pid, action: "recordNotificationTarget", claimedBy }, async () => {
    const current = readJob(jobId);
    if (!current) throw new Error(`Oracle job not found: ${jobId}`);
    if (current.notifiedAt) return current;
    if (!notificationClaimIsOwnedBy(current, claimedBy)) {
      throw new Error(`Oracle notification claim is not owned by ${claimedBy}: ${jobId}`);
    }
    const next = recordOracleJobNotificationTarget(current, {
      at: new Date().toISOString(),
      source: "oracle:poller",
      notificationSessionKey: options.notificationSessionKey,
      notificationSessionFile: options.notificationSessionFile,
    });
    await writeJobUnlocked(next);
    return next;
  });
}

export async function markJobNotified(
  jobId: string,
  claimedBy: string,
  options?: { at?: string; notificationEntryId?: string; notificationSessionKey?: string; notificationSessionFile?: string },
): Promise<OracleJob> {
  const at = options?.at ?? new Date().toISOString();
  return withJobLock(jobId, { processPid: process.pid, action: "markJobNotified", claimedBy }, async () => {
    const current = readJob(jobId);
    if (!current) throw new Error(`Oracle job not found: ${jobId}`);
    if (current.notifiedAt) return current;
    if (!notificationClaimIsOwnedBy(current, claimedBy)) {
      throw new Error(`Oracle notification claim is not owned by ${claimedBy}: ${jobId}`);
    }
    const next = markOracleJobNotified(current, {
      at,
      source: "oracle:poller",
      notificationEntryId: options?.notificationEntryId,
      notificationSessionKey: options?.notificationSessionKey,
      notificationSessionFile: options?.notificationSessionFile,
    });
    await writeJobUnlocked(next);
    return next;
  });
}

export async function releaseNotificationClaim(jobId: string, claimedBy: string): Promise<OracleJob | undefined> {
  return withJobLock(jobId, { processPid: process.pid, action: "releaseNotificationClaim", claimedBy }, async () => {
    const current = readJob(jobId);
    if (!current) return undefined;
    if (current.notifyClaimedBy && current.notifyClaimedBy !== claimedBy) return current;
    const next = releaseOracleJobNotificationClaim(current);
    await writeJobUnlocked(next);
    return next;
  });
}

export async function noteWakeupRequested(jobId: string, at = new Date().toISOString()): Promise<OracleJob | undefined> {
  try {
    return await updateJob(jobId, (job) => noteOracleJobWakeupRequested(job, { at, source: "oracle:poller" }));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.startsWith("Oracle job not found:")) return undefined;
    throw error;
  }
}

function getWakeupSessionKey(sessionFile: string | undefined, cwd: string | undefined): string | undefined {
  if (!sessionFile || !cwd) return undefined;
  const projectId = getProjectId(cwd);
  return `${projectId}::${getSessionId(sessionFile, projectId)}`;
}

export async function markWakeupSettled(
  jobId: string,
  options: {
    source: OracleWakeupSettlementSource;
    sessionFile?: string;
    cwd?: string;
    at?: string;
    allowBeforeFirstAttempt?: boolean;
  },
): Promise<OracleJob | undefined> {
  const at = options.at ?? new Date().toISOString();
  const sessionKey = getWakeupSessionKey(options.sessionFile, options.cwd);

  try {
    return await updateJob(jobId, (job) => markOracleJobWakeupSettled(job, {
      source: options.source,
      at,
      sessionFile: options.sessionFile,
      sessionKey,
      allowBeforeFirstAttempt: options.allowBeforeFirstAttempt,
    }));
  } catch {
    return readJob(jobId);
  }
}

export async function cancelOracleJob(id: string, reason = "Cancelled by user"): Promise<OracleJob> {
  return withLock("admission", "global", { processPid: process.pid, action: "cancelOracleJob", jobId: id }, async () => {
    const current = readJob(id);
    if (!current) throw new Error(`Oracle job not found: ${id}`);
    if (!isOpenOracleJob(current)) return current;

    const now = new Date().toISOString();
    if (current.status === "queued") {
      const cancelled = await updateJob(id, (job) => transitionOracleJobPhase(job, "cancelled", {
        at: now,
        source: "oracle:cancel",
        message: `Job cancelled: ${reason}`,
        clearNotificationClaim: true,
        patch: {
          heartbeatAt: now,
          error: reason,
        },
      }));

      const cleanupReport = await cleanupJobResources(cancelled);
      if (cleanupReport.warnings.length === 0) return cancelled;

      return updateJob(id, (job) => applyOracleJobCleanupWarnings(job, cleanupReport.warnings, {
        at: now,
        source: "oracle:cancel",
        message: "Queued job cleanup completed with warnings after cancellation.",
      }));
    }

    const terminated = await terminateWorkerPid(current.workerPid, current.workerStartedAt);
    let transitioned = false;
    const cancelled = await updateJob(id, (job) => {
      if (isTerminalOracleJob(job)) return job;
      transitioned = true;
      return transitionOracleJobPhase(job, terminated ? "cancelled" : "failed", {
        at: now,
        source: "oracle:cancel",
        message: terminated
          ? `Job cancelled: ${reason}`
          : `Job cancellation failed because worker PID ${job.workerPid ?? "unknown"} did not exit.`,
        clearNotificationClaim: true,
        patch: {
          heartbeatAt: now,
          cleanupPending: terminated,
          error: terminated ? reason : `${reason}; worker PID ${job.workerPid ?? "unknown"} did not exit`,
        },
      });
    });
    if (!transitioned) return cancelled;

    if (!terminated) {
      const cleanupWarnings = [
        `Oracle runtime cleanup is blocked because worker PID ${current.workerPid ?? "unknown"} could not be terminated safely.`,
      ];
      return updateJob(id, (job) => applyOracleJobCleanupWarnings(job, cleanupWarnings, {
        at: now,
        source: "oracle:cancel",
        message: "Runtime cleanup remained blocked after cancellation.",
      }));
    }

    const cleanupReport = await cleanupJobResources(cancelled);
    if (cleanupReport.warnings.length === 0) {
      const finalized = await clearCleanupPending(id, now);
      return finalized ?? cancelled;
    }

    return updateJob(id, (job) => applyOracleJobCleanupWarnings(job, cleanupReport.warnings, {
      at: now,
      source: "oracle:cancel",
      message: "Runtime cleanup completed with warnings after cancellation.",
    }));
  });
}

export async function createJob(
  id: string,
  input: OracleSubmitInput,
  cwd: string,
  originSessionFile: string | undefined,
  config: OracleConfig,
  runtime: OracleRuntimeAllocation,
  options?: { initialState?: "queued" | "submitted"; createdAt?: string },
): Promise<OracleJob> {
  const jobDir = getJobDir(id);
  const logsDir = join(jobDir, "logs");
  const workerLogPath = join(logsDir, "worker.log");
  const promptPath = join(jobDir, "prompt.md");
  const archivePath = join(jobDir, `context-${id}.tar.zst`);
  const responsePath = join(jobDir, "response.md");
  const reasoningPath = join(jobDir, "reasoning.md");
  const artifactsManifestPath = join(jobDir, "artifacts.json");
  const projectId = getProjectId(cwd);
  const sessionFile = requirePersistedSessionFile(originSessionFile, "create oracle jobs");
  const sessionId = getSessionId(sessionFile, projectId);
  const conversationId = parseConversationId(input.chatUrl);

  await mkdir(jobDir, { recursive: true, mode: 0o700 });
  await chmod(jobDir, 0o700).catch(() => undefined);
  await mkdir(join(jobDir, "artifacts"), { recursive: true, mode: 0o700 });
  await chmod(join(jobDir, "artifacts"), 0o700).catch(() => undefined);
  await mkdir(logsDir, { recursive: true, mode: 0o700 });
  await chmod(logsDir, 0o700).catch(() => undefined);
  await writeFile(promptPath, input.prompt, { encoding: "utf8", mode: 0o600 });
  await chmod(promptPath, 0o600).catch(() => undefined);

  const createdAt = options?.createdAt ?? new Date().toISOString();
  const initialState = options?.initialState ?? "submitted";
  const job = markOracleJobCreated({
    id,
    status: initialState,
    phase: initialState,
    phaseAt: createdAt,
    createdAt,
    queuedAt: initialState === "queued" ? createdAt : undefined,
    submittedAt: initialState === "submitted" ? createdAt : undefined,
    cwd,
    projectId,
    sessionId,
    originSessionFile: sessionFile,
    requestSource: input.requestSource,
    selection: input.selection,
    followUpToJobId: input.followUpToJobId,
    chatUrl: input.followUpToJobId ? input.chatUrl : undefined,
    conversationId,
    responseFormat: "text/plain",
    artifactPaths: [],
    archivePath,
    archiveDeletedAfterUpload: false,
    promptPath,
    responsePath,
    reasoningPath,
    artifactsManifestPath,
    logsDir,
    workerLogPath,
    runtimeId: runtime.runtimeId,
    runtimeSessionName: runtime.runtimeSessionName,
    runtimeProfileDir: runtime.runtimeProfileDir,
    seedGeneration: runtime.seedGeneration,
    config,
  } satisfies OracleJob, {
    at: createdAt,
    source: "oracle:create",
    message: initialState === "queued" ? "Job created and queued for later admission." : "Job created and admitted for worker launch.",
  });

  await writeJob(job);
  return job;
}

function isPathInsideDirectory(rootPath: string, candidatePath: string): boolean {
  const boundary = relativePath(rootPath, candidatePath);
  return boundary === "" || (!boundary.startsWith(`..${sep}`) && boundary !== ".." && !isAbsolute(boundary));
}

export function resolveArchiveInputs(cwd: string, files: string[]): { absolute: string; relative: string }[] {
  if (files.length === 0) {
    throw new Error("oracle_submit requires at least one file or directory to archive");
  }

  const realCwd = realpathSync(cwd);
  return files.map((file) => {
    if (!file.trim()) {
      throw new Error("Archive input must be a non-empty project-relative path");
    }
    if (file.trim() === "." && file !== ".") {
      throw new Error("Archive input must use '.' exactly for a whole-repo archive");
    }
    const absolute = resolve(cwd, file);
    if (absolute === cwd && file !== ".") {
      throw new Error("Archive input must use '.' exactly for a whole-repo archive");
    }
    const relative = absolute.startsWith(`${cwd}/`) ? absolute.slice(cwd.length + 1) : absolute === cwd ? "." : "";
    if (!relative) {
      throw new Error(`Archive input must be inside the project cwd: ${file}`);
    }
    if (!existsSync(absolute)) {
      throw new Error(`Archive input does not exist: ${file}`);
    }
    if (!isPathInsideDirectory(realCwd, realpathSync(absolute))) {
      throw new Error(`Archive input must resolve inside the project cwd without symlink escapes: ${file}`);
    }
    return { absolute, relative };
  });
}

export async function spawnWorker(
  workerPath: string,
  jobId: string,
): Promise<{ pid: number | undefined; nonce: string; startedAt: string | undefined }> {
  const nonce = randomUUID();
  const child = await spawnDetachedNodeProcess(workerPath, [jobId, nonce]);
  return {
    pid: child.pid,
    nonce,
    startedAt: child.startedAt,
  };
}
