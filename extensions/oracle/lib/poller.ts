// Purpose: Poll oracle jobs in the background, reconcile stale state, and deliver best-effort wake-up reminders to eligible sessions.
// Responsibilities: Track live wake-up targets, promote queued jobs, scan terminal jobs for delivery, and keep session status text current.
// Scope: Poller/orchestration only; durable lifecycle mutations live in jobs.ts and shared observability formatting lives in extensions/oracle/shared.
// Usage: Imported by the oracle extension entrypoint to start or stop per-session oracle polling.
// Invariants/Assumptions: Poller scans are serialized per session key, wake-up delivery is best-effort, and terminal-job notifications always re-read durable job state before send.
import { existsSync } from "node:fs";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { buildOracleStatusText, buildOracleWakeupNotificationContent } from "../shared/job-observability-helpers.mjs";
import { isProcessAlive, readProcessStartedAt } from "../shared/process-helpers.mjs";
import { isLockTimeoutError, listLeaseMetadata, releaseLease, withGlobalReconcileLock, writeLeaseMetadata } from "./locks.js";
import {
  getJobDir,
  getSessionFile,
  getStaleOracleJobReason,
  hasPersistedOriginSession,
  isActiveOracleJob,
  listOracleJobDirs,
  noteWakeupRequested,
  readJob,
  recordNotificationTarget,
  reconcileStaleOracleJobs,
  releaseNotificationClaim,
  shouldPruneTerminalJob,
  shouldRequestWakeup,
  tryClaimNotification,
} from "./jobs.js";
import { promoteQueuedJobs } from "./queue.js";
import { getProjectId, getSessionId } from "./runtime.js";

const activePollers = new Map<string, NodeJS.Timeout>();
const scansInFlight = new Set<string>();
const POLLER_LOCK_TIMEOUT_MS = 50;
const WAKEUP_TARGET_LEASE_KIND = "wakeup-target";
const WAKEUP_TARGET_STALE_MS = 2 * 60 * 1000;
const ORACLE_WAKEUP_REMINDER_CUSTOM_TYPE = "oracle-job-wakeup";

interface OracleWakeupTargetLeaseMetadata {
  leaseKey: string;
  projectId: string;
  sessionId: string;
  processPid: number;
  processStartedAt?: string;
  updatedAt: string;
}


type OraclePollerJob = NonNullable<ReturnType<typeof readJob>>;

export interface OraclePollerHooks {
  collectLiveWakeupTargets?: (now?: number) => Promise<Set<string>>;
  beforeNotificationClaim?: (jobId: string) => Promise<void> | void;
  afterNotificationClaim?: (job: OraclePollerJob) => Promise<void> | void;
  beforeNotificationPersist?: (job: OraclePollerJob) => Promise<void> | void;
  afterNotificationPersisted?: (job: OraclePollerJob) => Promise<void> | void;
  beforeMarkJobNotified?: (job: OraclePollerJob) => Promise<void> | void;
}

export interface OraclePollerOptions {
  hooks?: OraclePollerHooks;
}

export function getPollerSessionKey(sessionFile: string | undefined, cwd: string): string {
  const projectId = getProjectId(cwd);
  const sessionId = getSessionId(sessionFile, projectId);
  return `${projectId}::${sessionId}`;
}

function jobMatchesContext(job: { projectId: string; sessionId: string }, sessionFile: string | undefined, cwd: string): boolean {
  const projectId = getProjectId(cwd);
  const sessionId = getSessionId(sessionFile, projectId);
  return job.projectId === projectId && job.sessionId === sessionId;
}

function parseTimestamp(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function getWakeupTargetLeaseKey(sessionKey: string, processPid = process.pid, processStartedAt = readProcessStartedAt(process.pid) || "unknown"): string {
  return `${sessionKey}::${processPid}::${processStartedAt}`;
}

async function collectLiveWakeupTargetLeases(now = Date.now()): Promise<Array<OracleWakeupTargetLeaseMetadata & { sessionKey: string }>> {
  const liveTargets: Array<OracleWakeupTargetLeaseMetadata & { sessionKey: string }> = [];
  for (const lease of listLeaseMetadata<OracleWakeupTargetLeaseMetadata>(WAKEUP_TARGET_LEASE_KIND)) {
    const sessionKey = `${lease?.projectId ?? ""}::${lease?.sessionId ?? ""}`;
    const leaseKey = lease?.leaseKey;
    const currentStartedAt = readProcessStartedAt(lease?.processPid);
    const updatedAtMs = parseTimestamp(lease?.updatedAt);
    const stale = updatedAtMs !== undefined && now - updatedAtMs > WAKEUP_TARGET_STALE_MS;
    const missingIdentity = !lease?.projectId || !lease?.sessionId || !lease?.processPid || !leaseKey;
    const deadProcess = !missingIdentity && (!isProcessAlive(lease.processPid) || !currentStartedAt || (lease.processStartedAt && currentStartedAt !== lease.processStartedAt));
    if (missingIdentity || deadProcess || stale) {
      if (leaseKey) {
        await releaseLease(WAKEUP_TARGET_LEASE_KIND, leaseKey).catch(() => undefined);
      }
      continue;
    }
    liveTargets.push({ ...lease, sessionKey } as OracleWakeupTargetLeaseMetadata & { sessionKey: string });
  }
  return liveTargets;
}

async function collectLiveWakeupTargets(now = Date.now()): Promise<Set<string>> {
  return new Set((await collectLiveWakeupTargetLeases(now)).map((lease) => lease.sessionKey));
}

function jobHasLiveWakeupTarget(job: { projectId: string; sessionId: string }, liveWakeupTargets: Set<string>): boolean {
  return liveWakeupTargets.has(`${job.projectId}::${job.sessionId}`);
}

function jobCanNotifyContext(
  job: { projectId: string; sessionId: string; originSessionFile?: string },
  sessionFile: string | undefined,
  cwd: string,
  liveWakeupTargets: Set<string>,
): boolean {
  if (!hasPersistedOriginSession(job)) return false;
  if (jobMatchesContext(job, sessionFile, cwd)) return true;
  return job.projectId === getProjectId(cwd) && !jobHasLiveWakeupTarget(job, liveWakeupTargets);
}

function getJobCounts(ctx: ExtensionContext): { active: number; queued: number } {
  const currentSessionFile = getSessionFile(ctx);
  if (!currentSessionFile) return { active: 0, queued: 0 };
  return listOracleJobDirs()
    .map((jobDir) => readJob(jobDir))
    .filter((job): job is NonNullable<typeof job> => Boolean(job))
    .filter((job) => jobMatchesContext(job, currentSessionFile, ctx.cwd))
    .reduce(
      (counts, job) => {
        if (job.status === "queued") counts.queued += 1;
        else if (isActiveOracleJob(job) && !getStaleOracleJobReason(job)) counts.active += 1;
        return counts;
      },
      { active: 0, queued: 0 },
    );
}

export function refreshOracleStatus(ctx: ExtensionContext): void {
  if (!getSessionFile(ctx)) {
    ctx.ui.setStatus("oracle", ctx.ui.theme.fg("accent", "oracle: unavailable"));
    return;
  }
  const counts = getJobCounts(ctx);
  const statusText = buildOracleStatusText(counts);
  const tone = counts.active > 0 ? "success" : "accent";
  ctx.ui.setStatus("oracle", ctx.ui.theme.fg(tone, statusText));
}

function requestWakeupTurn(pi: ExtensionAPI, job: OraclePollerJob): void {
  pi.sendMessage(
    {
      customType: ORACLE_WAKEUP_REMINDER_CUSTOM_TYPE,
      display: false,
      content: buildOracleWakeupNotificationContent(job, {
        responsePath: job.responsePath,
        responseAvailable: Boolean(job.responsePath && existsSync(job.responsePath)),
        artifactsPath: `${getJobDir(job.id)}/artifacts`,
      }),
      details: { jobId: job.id, status: job.status },
    },
    { triggerTurn: true, deliverAs: "followUp" },
  );
}

async function scan(pi: ExtensionAPI, ctx: ExtensionContext, workerPath: string, hooks: OraclePollerHooks = {}): Promise<void> {
  const currentSessionFile = getSessionFile(ctx);
  const pollerKey = getPollerSessionKey(currentSessionFile, ctx.cwd);
  const notificationClaimant = `${pollerKey}:${process.pid}`;

  const projectId = getProjectId(ctx.cwd);
  const sessionId = getSessionId(currentSessionFile, projectId);
  const processStartedAt = readProcessStartedAt(process.pid);
  const wakeupTargetLeaseKey = getWakeupTargetLeaseKey(pollerKey, process.pid, processStartedAt || "unknown");
  const resolveLiveWakeupTargets = hooks.collectLiveWakeupTargets ?? collectLiveWakeupTargets;
  await writeLeaseMetadata(WAKEUP_TARGET_LEASE_KIND, wakeupTargetLeaseKey, {
    leaseKey: wakeupTargetLeaseKey,
    projectId,
    sessionId,
    processPid: process.pid,
    processStartedAt,
    updatedAt: new Date().toISOString(),
  }).catch(() => undefined);
  const liveWakeupTargets = await resolveLiveWakeupTargets();

  try {
    await withGlobalReconcileLock(
      { processPid: process.pid, cwd: ctx.cwd, sessionFile: currentSessionFile, source: "poller" },
      async () => {
        await reconcileStaleOracleJobs();
      },
      { timeoutMs: POLLER_LOCK_TIMEOUT_MS },
    );
  } catch (error) {
    if (!isLockTimeoutError(error, "reconcile", "global")) throw error;
  }

  await promoteQueuedJobs({ workerPath, source: "poller" });

  const terminalJobs = listOracleJobDirs()
    .map((jobDir) => readJob(jobDir))
    .filter((job): job is NonNullable<typeof job> => Boolean(job))
    .filter((job) => job.status === "complete" || job.status === "failed" || job.status === "cancelled");

  const now = Date.now();
  const candidateJobIds = terminalJobs
    .filter((job) => {
      if (!jobCanNotifyContext(job, currentSessionFile, ctx.cwd, liveWakeupTargets)) return false;
      if (job.notifiedAt) return false;
      if (shouldPruneTerminalJob(job, now)) return false;
      return shouldRequestWakeup(job, now);
    })
    .map((job) => job.id);

  for (const jobId of candidateJobIds) {
    await hooks.beforeNotificationClaim?.(jobId);
    const claimed = await tryClaimNotification(jobId, notificationClaimant);
    if (!claimed) continue;

    await hooks.afterNotificationClaim?.(claimed);
    const preNotifyLiveWakeupTargets = await resolveLiveWakeupTargets();
    if (!jobCanNotifyContext(claimed, currentSessionFile, ctx.cwd, preNotifyLiveWakeupTargets)) {
      await releaseNotificationClaim(jobId, notificationClaimant).catch(() => undefined);
      continue;
    }

    try {
      if (currentSessionFile) {
        await recordNotificationTarget(jobId, notificationClaimant, {
          notificationSessionKey: pollerKey,
          notificationSessionFile: currentSessionFile,
        });
      }
      await hooks.beforeNotificationPersist?.(claimed);
      const preWakeupLiveWakeupTargets = await resolveLiveWakeupTargets();
      if (!jobCanNotifyContext(claimed, currentSessionFile, ctx.cwd, preWakeupLiveWakeupTargets)) {
        await releaseNotificationClaim(jobId, notificationClaimant).catch(() => undefined);
        continue;
      }
      const deliverable = readJob(jobId);
      if (!deliverable || shouldPruneTerminalJob(deliverable, Date.now())) {
        await releaseNotificationClaim(jobId, notificationClaimant).catch(() => undefined);
        continue;
      }

      const notedWakeup = await noteWakeupRequested(jobId);
      const deliverableAfterNote = notedWakeup ?? readJob(jobId);
      if (!deliverableAfterNote || shouldPruneTerminalJob(deliverableAfterNote, Date.now())) {
        await releaseNotificationClaim(jobId, notificationClaimant).catch(() => undefined);
        continue;
      }

      requestWakeupTurn(pi, deliverableAfterNote);
      if (ctx.hasUI) {
        ctx.ui.notify(`Oracle job ${claimed.id} is ${claimed.status}.`, "info");
      }
      await releaseNotificationClaim(jobId, notificationClaimant).catch(() => undefined);
    } catch (error) {
      await releaseNotificationClaim(jobId, notificationClaimant).catch(() => undefined);
      throw error;
    }
  }
}

export async function scanOracleJobsOnce(pi: ExtensionAPI, ctx: ExtensionContext, workerPath: string, options: OraclePollerOptions = {}): Promise<void> {
  await scan(pi, ctx, workerPath, options.hooks);
}

export function startPoller(pi: ExtensionAPI, ctx: ExtensionContext, intervalMs: number, workerPath: string, options: OraclePollerOptions = {}): void {
  const sessionKey = getPollerSessionKey(getSessionFile(ctx), ctx.cwd);
  const existing = activePollers.get(sessionKey);
  if (existing) clearInterval(existing);

  const runScan = async () => {
    if (scansInFlight.has(sessionKey)) return;
    scansInFlight.add(sessionKey);
    try {
      await scanOracleJobsOnce(pi, ctx, workerPath, options);
    } catch (error) {
      console.error(`Oracle poller scan failed (${sessionKey}):`, error);
    } finally {
      scansInFlight.delete(sessionKey);
      refreshOracleStatus(ctx);
    }
  };

  refreshOracleStatus(ctx);
  void runScan();
  const timer = setInterval(() => {
    void runScan();
  }, intervalMs);
  activePollers.set(sessionKey, timer);
}

export function stopPollerForSession(sessionFile: string | undefined, cwd: string): void {
  const sessionKey = getPollerSessionKey(sessionFile, cwd);
  const timer = activePollers.get(sessionKey);
  if (timer) {
    clearInterval(timer);
    activePollers.delete(sessionKey);
  }
  const wakeupTargetLeaseKey = getWakeupTargetLeaseKey(sessionKey);
  void releaseLease(WAKEUP_TARGET_LEASE_KIND, wakeupTargetLeaseKey).catch(() => undefined);
}

export async function stopAllPollers(): Promise<void> {
  const sessionKeys = [...activePollers.keys()];
  for (const timer of activePollers.values()) {
    clearInterval(timer);
  }
  activePollers.clear();
  await Promise.all(sessionKeys.map(async (sessionKey) => {
    const wakeupTargetLeaseKey = getWakeupTargetLeaseKey(sessionKey);
    await releaseLease(WAKEUP_TARGET_LEASE_KIND, wakeupTargetLeaseKey).catch(() => undefined);
  }));
}

export async function waitForAllPollersToQuiesce(timeoutMs = 2_000): Promise<void> {
  const startedAt = Date.now();
  while (scansInFlight.size > 0) {
    if (Date.now() - startedAt >= timeoutMs) {
      throw new Error(`Timed out waiting for oracle pollers to quiesce after ${timeoutMs}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

export function stopPoller(ctx: ExtensionContext): void {
  const sessionFile = getSessionFile(ctx);
  if (!sessionFile) return;
  stopPollerForSession(sessionFile, ctx.cwd);
}
