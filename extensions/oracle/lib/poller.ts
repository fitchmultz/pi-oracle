import { execFileSync } from "node:child_process";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
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

function readProcessStartedAt(pid: number | undefined): string | undefined {
  if (!pid || pid <= 0) return undefined;
  try {
    const startedAt = execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8" }).trim();
    return startedAt || undefined;
  } catch {
    return undefined;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ESRCH") return false;
    return true;
  }
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
  if (counts.active > 0 && counts.queued > 0) {
    ctx.ui.setStatus("oracle", ctx.ui.theme.fg("success", `oracle: running (${counts.active}), queued (${counts.queued})`));
    return;
  }
  if (counts.active > 0) {
    const suffix = counts.active > 1 ? ` (${counts.active})` : "";
    ctx.ui.setStatus("oracle", ctx.ui.theme.fg("success", `oracle: running${suffix}`));
    return;
  }
  if (counts.queued > 0) {
    const suffix = counts.queued > 1 ? ` (${counts.queued})` : "";
    ctx.ui.setStatus("oracle", ctx.ui.theme.fg("accent", `oracle: queued${suffix}`));
    return;
  }

  ctx.ui.setStatus("oracle", ctx.ui.theme.fg("accent", "oracle: ready"));
}

function buildNotificationContent(job: OraclePollerJob): string {
  const responsePath = job.responsePath || `${getJobDir(job.id)}/response.md`;
  const artifactsPath = `${getJobDir(job.id)}/artifacts`;
  return [
    `Oracle job ${job.id} is ${job.status}.`,
    `Read response: ${responsePath}`,
    `Artifacts: ${artifactsPath}`,
    job.error ? `Error: ${job.error}` : "Continue from the oracle output.",
  ].join("\n");
}


function requestWakeupTurn(pi: ExtensionAPI, job: OraclePollerJob): void {
  pi.sendMessage(
    {
      customType: ORACLE_WAKEUP_REMINDER_CUSTOM_TYPE,
      display: false,
      content: buildNotificationContent(job),
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

      requestWakeupTurn(pi, deliverable);
      await noteWakeupRequested(jobId).catch(() => undefined);
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
    scansInFlight.delete(sessionKey);
  }
  const wakeupTargetLeaseKey = getWakeupTargetLeaseKey(sessionKey);
  void releaseLease(WAKEUP_TARGET_LEASE_KIND, wakeupTargetLeaseKey).catch(() => undefined);
}

export function stopPoller(ctx: ExtensionContext): void {
  const sessionFile = getSessionFile(ctx);
  if (!sessionFile) return;
  stopPollerForSession(sessionFile, ctx.cwd);
}
