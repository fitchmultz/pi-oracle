import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { isLockTimeoutError, withGlobalReconcileLock } from "./locks.js";
import {
  getSessionFile,
  getStaleOracleJobReason,
  isActiveOracleJob,
  listOracleJobDirs,
  markJobNotified,
  readJob,
  reconcileStaleOracleJobs,
  releaseNotificationClaim,
  tryClaimNotification,
} from "./jobs.js";
import { getProjectId, getSessionId } from "./runtime.js";

const activePollers = new Map<string, NodeJS.Timeout>();
const scansInFlight = new Set<string>();
const POLLER_LOCK_TIMEOUT_MS = 50;

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

function getActiveJobCount(ctx: ExtensionContext): number {
  const currentSessionFile = getSessionFile(ctx);
  return listOracleJobDirs()
    .map((jobDir) => readJob(jobDir))
    .filter((job): job is NonNullable<typeof job> => Boolean(job))
    .filter((job) => {
      if (!isActiveOracleJob(job)) return false;
      if (getStaleOracleJobReason(job)) return false;
      return jobMatchesContext(job, currentSessionFile, ctx.cwd);
    }).length;
}

export function refreshOracleStatus(ctx: ExtensionContext): void {
  const activeJobCount = getActiveJobCount(ctx);
  if (activeJobCount > 0) {
    const suffix = activeJobCount > 1 ? ` (${activeJobCount})` : "";
    ctx.ui.setStatus("oracle", ctx.ui.theme.fg("success", `oracle: running${suffix}`));
    return;
  }

  ctx.ui.setStatus("oracle", ctx.ui.theme.fg("accent", "oracle: ready"));
}

function notifyForJob(pi: ExtensionAPI, job: NonNullable<ReturnType<typeof readJob>>): void {
  const responsePath = job.responsePath || `${job.id}/response.md`;
  const artifactsPath = `/tmp/oracle-${job.id}/artifacts`;
  pi.sendMessage(
    {
      customType: "oracle-job-complete",
      display: true,
      content: [
        `Oracle job ${job.id} is ${job.status}.`,
        `Read response: ${responsePath}`,
        `Artifacts: ${artifactsPath}`,
        job.error ? `Error: ${job.error}` : "Continue from the oracle output.",
      ].join("\n"),
      details: { jobId: job.id, status: job.status },
    },
    { triggerTurn: true },
  );
}

async function scan(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
  const currentSessionFile = getSessionFile(ctx);
  const pollerKey = getPollerSessionKey(currentSessionFile, ctx.cwd);
  const notificationClaimant = `${pollerKey}:${process.pid}`;

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

  const candidateJobIds = listOracleJobDirs()
    .map((jobDir) => readJob(jobDir))
    .filter((job): job is NonNullable<typeof job> => Boolean(job))
    .filter((job) => {
      if (job.status !== "complete" && job.status !== "failed" && job.status !== "cancelled") return false;
      if (!jobMatchesContext(job, currentSessionFile, ctx.cwd)) return false;
      return !job.notifiedAt;
    })
    .map((job) => job.id);

  for (const jobId of candidateJobIds) {
    const claimed = await tryClaimNotification(jobId, notificationClaimant);
    if (!claimed) continue;
    if (!jobMatchesContext(claimed, currentSessionFile, ctx.cwd)) {
      await releaseNotificationClaim(jobId, notificationClaimant).catch(() => undefined);
      continue;
    }

    try {
      notifyForJob(pi, claimed);
      await markJobNotified(jobId, notificationClaimant);
    } catch (error) {
      await releaseNotificationClaim(jobId, notificationClaimant).catch(() => undefined);
      throw error;
    }
  }
}

export function startPoller(pi: ExtensionAPI, ctx: ExtensionContext, intervalMs: number): void {
  const sessionKey = getPollerSessionKey(getSessionFile(ctx), ctx.cwd);
  const existing = activePollers.get(sessionKey);
  if (existing) clearInterval(existing);

  const runScan = async () => {
    if (scansInFlight.has(sessionKey)) return;
    scansInFlight.add(sessionKey);
    try {
      await scan(pi, ctx);
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
  if (!timer) return;
  clearInterval(timer);
  activePollers.delete(sessionKey);
  scansInFlight.delete(sessionKey);
}

export function stopPoller(ctx: ExtensionContext): void {
  stopPollerForSession(getSessionFile(ctx), ctx.cwd);
}
