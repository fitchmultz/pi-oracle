import { createHash, randomUUID } from "node:crypto";
import { spawn, execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { OracleConfig, OracleEffort, OracleModelFamily } from "./config.js";
import { withJobLock } from "./locks.js";
import { cleanupRuntimeArtifacts, getProjectId, getSessionId, parseConversationId, type OracleCleanupReport } from "./runtime.js";

export type OracleJobStatus = "preparing" | "submitted" | "waiting" | "complete" | "failed" | "cancelled";
export type OracleJobPhase =
  | "submitted"
  | "cloning_runtime"
  | "launching_browser"
  | "verifying_auth"
  | "configuring_model"
  | "uploading_archive"
  | "awaiting_response"
  | "extracting_response"
  | "downloading_artifacts"
  | "complete"
  | "complete_with_artifact_errors"
  | "failed"
  | "cancelled";

export const ACTIVE_ORACLE_JOB_STATUSES: OracleJobStatus[] = ["preparing", "submitted", "waiting"];
export const ORACLE_MISSING_WORKER_GRACE_MS = 30_000;
export const ORACLE_STALE_HEARTBEAT_MS = 3 * 60 * 1000;
export const ORACLE_NOTIFICATION_CLAIM_TTL_MS = 60_000;
const ORACLE_COMPLETE_JOB_RETENTION_MS = 14 * 24 * 60 * 60 * 1000;
const ORACLE_FAILED_JOB_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export function isActiveOracleJob(job: Pick<OracleJob, "status">): boolean {
  return ACTIVE_ORACLE_JOB_STATUSES.includes(job.status);
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

async function waitForProcessStartedAt(pid: number | undefined, timeoutMs = 2_000): Promise<string | undefined> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const startedAt = readProcessStartedAt(pid);
    if (startedAt) return startedAt;
    await sleep(100);
  }
  return readProcessStartedAt(pid);
}

export function isWorkerProcessAlive(pid: number | undefined, startedAt?: string): boolean {
  const currentStartedAt = readProcessStartedAt(pid);
  if (!currentStartedAt) return false;
  return startedAt ? currentStartedAt === startedAt : true;
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
  submittedAt?: string;
  completedAt?: string;
  heartbeatAt?: string;
  cwd: string;
  projectId: string;
  sessionId: string;
  originSessionFile?: string;
  requestSource: "command" | "tool";
  chatModelFamily: OracleModelFamily;
  effort?: OracleEffort;
  autoSwitchToThinking?: boolean;
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
}

export interface OracleSubmitInput {
  prompt: string;
  files: string[];
  modelFamily: OracleModelFamily;
  effort?: OracleEffort;
  autoSwitchToThinking?: boolean;
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

export function getJobDir(id: string): string {
  return join("/tmp", `oracle-${id}`);
}

export function listOracleJobDirs(): string[] {
  if (!existsSync("/tmp")) return [];
  return readdirSync("/tmp")
    .filter((name) => name.startsWith("oracle-"))
    .map((name) => join("/tmp", name))
    .filter((path) => existsSync(join(path, "job.json")));
}

export function readJob(jobDirOrId: string): OracleJob | undefined {
  const jobDir = jobDirOrId.startsWith("/tmp/oracle-") ? jobDirOrId : getJobDir(jobDirOrId);
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseTimestamp(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function withJobPhase<T extends Pick<OracleJob, "phase" | "phaseAt">>(
  phase: OracleJobPhase,
  patch?: Omit<Partial<OracleJob>, "phase" | "phaseAt">,
  at = new Date().toISOString(),
): Partial<OracleJob> {
  return {
    ...(patch || {}),
    phase,
    phaseAt: at,
  };
}

function isTerminalOracleJobStatus(status: OracleJobStatus): boolean {
  return status === "complete" || status === "failed" || status === "cancelled";
}

export async function terminateWorkerPid(
  pid: number | undefined,
  startedAt?: string,
  options?: { termGraceMs?: number; killGraceMs?: number },
): Promise<boolean> {
  if (!pid || pid <= 0) return true;
  const currentStartedAt = readProcessStartedAt(pid);
  if (!currentStartedAt) return true;
  if (startedAt && currentStartedAt !== startedAt) return false;

  const termGraceMs = options?.termGraceMs ?? 5000;
  const killGraceMs = options?.killGraceMs ?? 2000;

  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return !isWorkerProcessAlive(pid, startedAt);
  }

  const termDeadline = Date.now() + termGraceMs;
  while (Date.now() < termDeadline) {
    if (!isWorkerProcessAlive(pid, startedAt)) return true;
    await sleep(250);
  }

  try {
    process.kill(pid, "SIGKILL");
  } catch {
    return !isWorkerProcessAlive(pid, startedAt);
  }

  const killDeadline = Date.now() + killGraceMs;
  while (Date.now() < killDeadline) {
    if (!isWorkerProcessAlive(pid, startedAt)) return true;
    await sleep(250);
  }

  return !isWorkerProcessAlive(pid, startedAt);
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

export async function cleanupJobResources(
  job: Pick<OracleJob, "runtimeId" | "runtimeProfileDir" | "runtimeSessionName" | "conversationId">,
): Promise<OracleCleanupReport> {
  return cleanupRuntimeArtifacts({
    runtimeId: job.runtimeId,
    runtimeProfileDir: job.runtimeProfileDir,
    runtimeSessionName: job.runtimeSessionName,
    conversationId: job.conversationId,
  });
}

function getCleanupRetentionMs(job: OracleJob): { complete: number; failed: number } {
  return {
    complete: job.config.cleanup?.completeJobRetentionMs ?? ORACLE_COMPLETE_JOB_RETENTION_MS,
    failed: job.config.cleanup?.failedJobRetentionMs ?? ORACLE_FAILED_JOB_RETENTION_MS,
  };
}

function shouldPruneTerminalJob(job: OracleJob, now = Date.now()): boolean {
  if (!isTerminalOracleJobStatus(job.status)) return false;
  const completedMs = parseTimestamp(job.completedAt) ?? parseTimestamp(job.createdAt);
  if (completedMs === undefined) return false;
  const ageMs = now - completedMs;

  const retention = getCleanupRetentionMs(job);

  if ((job.status === "complete" || job.status === "cancelled") && job.notifiedAt) {
    return ageMs >= retention.complete;
  }

  if (job.status === "failed") {
    return ageMs >= retention.failed;
  }

  return false;
}

export async function removeTerminalOracleJob(job: OracleJob): Promise<{ removed: boolean; cleanupReport: OracleCleanupReport }> {
  if (isActiveOracleJob(job)) return { removed: false, cleanupReport: { attempted: [], warnings: [] } };
  const cleanupReport = await cleanupJobResources(job);
  await rm(getJobDir(job.id), { recursive: true, force: true });
  return { removed: true, cleanupReport };
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

  for (const jobDir of listOracleJobDirs()) {
    const job = readJob(jobDir);
    if (!job) continue;
    const staleReason = getStaleOracleJobReason(job, now);
    if (!staleReason) continue;

    const terminated = await terminateWorkerPid(job.workerPid, job.workerStartedAt);
    const suffix = job.workerPid
      ? terminated
        ? ` Terminated stale worker PID ${job.workerPid}.`
        : ` Failed to terminate stale worker PID ${job.workerPid}.`
      : "";

    const repairedJob = await updateJob(job.id, (current) => ({
      ...current,
      ...withJobPhase("failed", {
        status: "failed",
        completedAt: new Date(now).toISOString(),
        heartbeatAt: new Date(now).toISOString(),
        notifyClaimedAt: undefined,
        notifyClaimedBy: undefined,
        error: current.error
          ? `${current.error}\nRecovered stale job: ${staleReason}.${suffix}`.trim()
          : `Recovered stale job: ${staleReason}.${suffix}`.trim(),
      }, new Date(now).toISOString()),
    }));
    const cleanupReport = await cleanupJobResources(repairedJob);
    if (cleanupReport.warnings.length > 0) {
      await updateJob(repairedJob.id, (current) => ({
        ...current,
        cleanupWarnings: [...(current.cleanupWarnings || []), ...cleanupReport.warnings],
        lastCleanupAt: new Date(now).toISOString(),
        error: [current.error, ...cleanupReport.warnings].filter(Boolean).join("\n"),
      }));
    }
    repaired.push(repairedJob);
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

    const claimedAtMs = parseTimestamp(current.notifyClaimedAt);
    const claimIsLive =
      current.notifyClaimedBy &&
      current.notifyClaimedBy !== claimedBy &&
      claimedAtMs !== undefined &&
      Date.now() - claimedAtMs < ORACLE_NOTIFICATION_CLAIM_TTL_MS;
    if (claimIsLive) return undefined;

    const next: OracleJob = {
      ...current,
      notifyClaimedBy: claimedBy,
      notifyClaimedAt: now,
    };
    await writeJobUnlocked(next);
    return next;
  });
}

export async function markJobNotified(jobId: string, claimedBy: string, at = new Date().toISOString()): Promise<OracleJob> {
  return withJobLock(jobId, { processPid: process.pid, action: "markJobNotified", claimedBy }, async () => {
    const current = readJob(jobId);
    if (!current) throw new Error(`Oracle job not found: ${jobId}`);
    const next: OracleJob = {
      ...current,
      notifiedAt: current.notifiedAt || at,
      notifyClaimedAt: undefined,
      notifyClaimedBy: undefined,
    };
    await writeJobUnlocked(next);
    return next;
  });
}

export async function releaseNotificationClaim(jobId: string, claimedBy: string): Promise<OracleJob | undefined> {
  return withJobLock(jobId, { processPid: process.pid, action: "releaseNotificationClaim", claimedBy }, async () => {
    const current = readJob(jobId);
    if (!current) return undefined;
    if (current.notifyClaimedBy && current.notifyClaimedBy !== claimedBy) return current;
    const next: OracleJob = {
      ...current,
      notifyClaimedAt: undefined,
      notifyClaimedBy: undefined,
    };
    await writeJobUnlocked(next);
    return next;
  });
}

export async function cancelOracleJob(id: string, reason = "Cancelled by user"): Promise<OracleJob> {
  const current = readJob(id);
  if (!current) throw new Error(`Oracle job not found: ${id}`);
  if (!isActiveOracleJob(current)) return current;

  const terminated = await terminateWorkerPid(current.workerPid, current.workerStartedAt);
  const now = new Date().toISOString();
  const cancelled = await updateJob(id, (job) => ({
    ...job,
    ...withJobPhase(terminated ? "cancelled" : "failed", {
      status: terminated ? "cancelled" : "failed",
      completedAt: now,
      heartbeatAt: now,
      notifyClaimedAt: undefined,
      notifyClaimedBy: undefined,
      error: terminated ? reason : `${reason}; worker PID ${job.workerPid ?? "unknown"} did not exit`,
    }, now),
  }));
  const cleanupReport = await cleanupJobResources(cancelled);
  if (cleanupReport.warnings.length === 0) return cancelled;

  return updateJob(id, (job) => ({
    ...job,
    cleanupWarnings: [...(job.cleanupWarnings || []), ...cleanupReport.warnings],
    lastCleanupAt: now,
    error: [job.error, ...cleanupReport.warnings].filter(Boolean).join("\n"),
  }));
}

export async function createJob(
  id: string,
  input: OracleSubmitInput,
  cwd: string,
  originSessionFile: string | undefined,
  config: OracleConfig,
  runtime: OracleRuntimeAllocation,
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
  const sessionId = getSessionId(originSessionFile, projectId);
  const conversationId = parseConversationId(input.chatUrl);

  await mkdir(jobDir, { recursive: true, mode: 0o700 });
  await chmod(jobDir, 0o700).catch(() => undefined);
  await mkdir(join(jobDir, "artifacts"), { recursive: true, mode: 0o700 });
  await chmod(join(jobDir, "artifacts"), 0o700).catch(() => undefined);
  await mkdir(logsDir, { recursive: true, mode: 0o700 });
  await chmod(logsDir, 0o700).catch(() => undefined);
  await writeFile(promptPath, input.prompt, { encoding: "utf8", mode: 0o600 });
  await chmod(promptPath, 0o600).catch(() => undefined);

  const now = new Date().toISOString();
  const job: OracleJob = {
    id,
    status: "submitted",
    phase: "submitted",
    phaseAt: now,
    createdAt: now,
    submittedAt: now,
    cwd,
    projectId,
    sessionId,
    originSessionFile,
    requestSource: input.requestSource,
    chatModelFamily: input.modelFamily,
    effort: input.effort,
    autoSwitchToThinking: input.autoSwitchToThinking,
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
  };

  await writeJob(job);
  return job;
}

export function resolveArchiveInputs(cwd: string, files: string[]): { absolute: string; relative: string }[] {
  if (files.length === 0) {
    throw new Error("oracle_submit requires at least one file or directory to archive");
  }

  return files.map((file) => {
    const absolute = resolve(cwd, file);
    const relative = absolute.startsWith(`${cwd}/`) ? absolute.slice(cwd.length + 1) : absolute === cwd ? "." : "";
    if (!relative) {
      throw new Error(`Archive input must be inside the project cwd: ${file}`);
    }
    if (!existsSync(absolute)) {
      throw new Error(`Archive input does not exist: ${file}`);
    }
    return { absolute, relative };
  });
}

export async function spawnWorker(
  workerPath: string,
  jobId: string,
): Promise<{ pid: number | undefined; nonce: string; startedAt: string | undefined }> {
  const nonce = randomUUID();
  const child = spawn(process.execPath, [workerPath, jobId, nonce], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  return {
    pid: child.pid,
    nonce,
    startedAt: await waitForProcessStartedAt(child.pid),
  };
}
