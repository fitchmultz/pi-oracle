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

interface OraclePollerContextSnapshot {
  cwd: string;
  sessionFile: string | undefined;
  hasUI: boolean;
  ui: ExtensionContext["ui"];
}

interface OracleActivePoller {
  active: boolean;
  sessionKey: string;
  timer?: NodeJS.Timeout;
}

interface OraclePollerLifecycle {
  isActive?: () => boolean;
}

const activePollers = new Map<string, OracleActivePoller>();
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

function snapshotPollerContext(ctx: ExtensionContext): OraclePollerContextSnapshot {
  return {
    cwd: ctx.cwd,
    sessionFile: getSessionFile(ctx),
    hasUI: ctx.hasUI,
    ui: ctx.ui,
  };
}

function getJobCountsForSession(sessionFile: string | undefined, cwd: string): { active: number; queued: number } {
  if (!sessionFile) return { active: 0, queued: 0 };
  return listOracleJobDirs()
    .map((jobDir) => readJob(jobDir))
    .filter((job): job is NonNullable<typeof job> => Boolean(job))
    .filter((job) => jobMatchesContext(job, sessionFile, cwd))
    .reduce(
      (counts, job) => {
        if (job.status === "queued") counts.queued += 1;
        else if (isActiveOracleJob(job) && !getStaleOracleJobReason(job)) counts.active += 1;
        return counts;
      },
      { active: 0, queued: 0 },
    );
}

function refreshOracleStatusSnapshot(snapshot: OraclePollerContextSnapshot): void {
  if (!snapshot.sessionFile) {
    snapshot.ui.setStatus("oracle", snapshot.ui.theme.fg("accent", "oracle: unavailable"));
    return;
  }
  const counts = getJobCountsForSession(snapshot.sessionFile, snapshot.cwd);
  const statusText = buildOracleStatusText(counts);
  const tone = counts.active > 0 ? "success" : "accent";
  snapshot.ui.setStatus("oracle", snapshot.ui.theme.fg(tone, statusText));
}

export function refreshOracleStatus(ctx: ExtensionContext): void {
  refreshOracleStatusSnapshot(snapshotPollerContext(ctx));
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

async function releaseWakeupLeaseIfInactive(leaseKey: string, lifecycle: OraclePollerLifecycle): Promise<boolean> {
  if (lifecycle.isActive?.() === false) {
    await releaseLease(WAKEUP_TARGET_LEASE_KIND, leaseKey).catch(() => undefined);
    return true;
  }
  return false;
}

async function scan(
  pi: ExtensionAPI,
  snapshot: OraclePollerContextSnapshot,
  workerPath: string,
  hooks: OraclePollerHooks = {},
  lifecycle: OraclePollerLifecycle = {},
): Promise<void> {
  if (lifecycle.isActive?.() === false) return;
  const currentSessionFile = snapshot.sessionFile;
  const pollerKey = getPollerSessionKey(currentSessionFile, snapshot.cwd);
  const notificationClaimant = `${pollerKey}:${process.pid}`;

  const projectId = getProjectId(snapshot.cwd);
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
  if (await releaseWakeupLeaseIfInactive(wakeupTargetLeaseKey, lifecycle)) return;

  const liveWakeupTargets = await resolveLiveWakeupTargets();
  if (await releaseWakeupLeaseIfInactive(wakeupTargetLeaseKey, lifecycle)) return;

  try {
    await withGlobalReconcileLock(
      { processPid: process.pid, cwd: snapshot.cwd, sessionFile: currentSessionFile, source: "poller" },
      async () => {
        await reconcileStaleOracleJobs();
      },
      { timeoutMs: POLLER_LOCK_TIMEOUT_MS },
    );
  } catch (error) {
    if (!isLockTimeoutError(error, "reconcile", "global")) throw error;
  }
  if (await releaseWakeupLeaseIfInactive(wakeupTargetLeaseKey, lifecycle)) return;

  try {
    await promoteQueuedJobs({ workerPath, source: "poller", lockTimeoutMs: POLLER_LOCK_TIMEOUT_MS });
  } catch (error) {
    if (!isLockTimeoutError(error, "admission", "global")) throw error;
  }
  if (await releaseWakeupLeaseIfInactive(wakeupTargetLeaseKey, lifecycle)) return;

  const terminalJobs = listOracleJobDirs()
    .map((jobDir) => readJob(jobDir))
    .filter((job): job is NonNullable<typeof job> => Boolean(job))
    .filter((job) => job.status === "complete" || job.status === "failed" || job.status === "cancelled");

  const now = Date.now();
  const candidateJobIds = terminalJobs
    .filter((job) => {
      if (!jobCanNotifyContext(job, currentSessionFile, snapshot.cwd, liveWakeupTargets)) return false;
      if (job.notifiedAt) return false;
      if (shouldPruneTerminalJob(job, now)) return false;
      return shouldRequestWakeup(job, now);
    })
    .map((job) => job.id);

  for (const jobId of candidateJobIds) {
    if (await releaseWakeupLeaseIfInactive(wakeupTargetLeaseKey, lifecycle)) return;
    await hooks.beforeNotificationClaim?.(jobId);
    if (await releaseWakeupLeaseIfInactive(wakeupTargetLeaseKey, lifecycle)) return;
    const claimed = await tryClaimNotification(jobId, notificationClaimant);
    if (!claimed) continue;

    try {
      if (await releaseWakeupLeaseIfInactive(wakeupTargetLeaseKey, lifecycle)) {
        await releaseNotificationClaim(jobId, notificationClaimant).catch(() => undefined);
        return;
      }
      await hooks.afterNotificationClaim?.(claimed);
      if (await releaseWakeupLeaseIfInactive(wakeupTargetLeaseKey, lifecycle)) {
        await releaseNotificationClaim(jobId, notificationClaimant).catch(() => undefined);
        return;
      }
      const preNotifyLiveWakeupTargets = await resolveLiveWakeupTargets();
      if (await releaseWakeupLeaseIfInactive(wakeupTargetLeaseKey, lifecycle)) {
        await releaseNotificationClaim(jobId, notificationClaimant).catch(() => undefined);
        return;
      }
      if (!jobCanNotifyContext(claimed, currentSessionFile, snapshot.cwd, preNotifyLiveWakeupTargets)) {
        await releaseNotificationClaim(jobId, notificationClaimant).catch(() => undefined);
        continue;
      }

      if (currentSessionFile) {
        await recordNotificationTarget(jobId, notificationClaimant, {
          notificationSessionKey: pollerKey,
          notificationSessionFile: currentSessionFile,
        });
      }
      if (await releaseWakeupLeaseIfInactive(wakeupTargetLeaseKey, lifecycle)) {
        await releaseNotificationClaim(jobId, notificationClaimant).catch(() => undefined);
        return;
      }
      await hooks.beforeNotificationPersist?.(claimed);
      if (await releaseWakeupLeaseIfInactive(wakeupTargetLeaseKey, lifecycle)) {
        await releaseNotificationClaim(jobId, notificationClaimant).catch(() => undefined);
        return;
      }
      const preWakeupLiveWakeupTargets = await resolveLiveWakeupTargets();
      if (await releaseWakeupLeaseIfInactive(wakeupTargetLeaseKey, lifecycle)) {
        await releaseNotificationClaim(jobId, notificationClaimant).catch(() => undefined);
        return;
      }
      if (!jobCanNotifyContext(claimed, currentSessionFile, snapshot.cwd, preWakeupLiveWakeupTargets)) {
        await releaseNotificationClaim(jobId, notificationClaimant).catch(() => undefined);
        continue;
      }
      const deliverable = readJob(jobId);
      if (!deliverable || shouldPruneTerminalJob(deliverable, Date.now())) {
        await releaseNotificationClaim(jobId, notificationClaimant).catch(() => undefined);
        continue;
      }

      if (await releaseWakeupLeaseIfInactive(wakeupTargetLeaseKey, lifecycle)) {
        await releaseNotificationClaim(jobId, notificationClaimant).catch(() => undefined);
        return;
      }
      requestWakeupTurn(pi, deliverable);
      const notedWakeup = await noteWakeupRequested(jobId);
      if (!notedWakeup) {
        await releaseNotificationClaim(jobId, notificationClaimant).catch(() => undefined);
        continue;
      }
      if (await releaseWakeupLeaseIfInactive(wakeupTargetLeaseKey, lifecycle)) {
        await releaseNotificationClaim(jobId, notificationClaimant).catch(() => undefined);
        return;
      }
      if (snapshot.hasUI) {
        snapshot.ui.notify(`Oracle job ${claimed.id} is ${claimed.status}.`, "info");
      }
      await releaseNotificationClaim(jobId, notificationClaimant).catch(() => undefined);
    } catch (error) {
      await releaseNotificationClaim(jobId, notificationClaimant).catch(() => undefined);
      throw error;
    }
  }
}

export async function scanOracleJobsOnce(pi: ExtensionAPI, ctx: ExtensionContext, workerPath: string, options: OraclePollerOptions = {}): Promise<void> {
  await scan(pi, snapshotPollerContext(ctx), workerPath, options.hooks);
}

export function startPoller(pi: ExtensionAPI, ctx: ExtensionContext, intervalMs: number, workerPath: string, options: OraclePollerOptions = {}): void {
  const snapshot = snapshotPollerContext(ctx);
  const sessionKey = getPollerSessionKey(snapshot.sessionFile, snapshot.cwd);
  const existing = activePollers.get(sessionKey);
  if (existing) {
    existing.active = false;
    if (existing.timer) clearInterval(existing.timer);
  }

  const handle: OracleActivePoller = {
    active: true,
    sessionKey,
  };
  activePollers.set(sessionKey, handle);

  const isCurrentPollerActive = () => handle.active && activePollers.get(sessionKey) === handle;

  const runScan = async () => {
    if (!isCurrentPollerActive()) return;
    if (scansInFlight.has(sessionKey)) return;
    scansInFlight.add(sessionKey);
    try {
      await scan(pi, snapshot, workerPath, options.hooks, { isActive: isCurrentPollerActive });
    } catch (error) {
      if (isCurrentPollerActive()) {
        console.error(`Oracle poller scan failed (${sessionKey}):`, error);
      }
    } finally {
      scansInFlight.delete(sessionKey);
      if (isCurrentPollerActive()) {
        refreshOracleStatusSnapshot(snapshot);
      }
    }
  };

  refreshOracleStatusSnapshot(snapshot);
  void runScan();
  const timer = setInterval(() => {
    void runScan();
  }, intervalMs);
  handle.timer = timer;
}

export function stopPollerForSession(sessionFile: string | undefined, cwd: string): void {
  const sessionKey = getPollerSessionKey(sessionFile, cwd);
  const handle = activePollers.get(sessionKey);
  if (handle) {
    handle.active = false;
    if (handle.timer) clearInterval(handle.timer);
    activePollers.delete(sessionKey);
  }
  const wakeupTargetLeaseKey = getWakeupTargetLeaseKey(sessionKey);
  void releaseLease(WAKEUP_TARGET_LEASE_KIND, wakeupTargetLeaseKey).catch(() => undefined);
}

export async function stopAllPollers(): Promise<void> {
  const handles = [...activePollers.values()];
  for (const handle of handles) {
    handle.active = false;
    if (handle.timer) clearInterval(handle.timer);
  }
  activePollers.clear();
  await Promise.all(handles.map(async (handle) => {
    const wakeupTargetLeaseKey = getWakeupTargetLeaseKey(handle.sessionKey);
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
