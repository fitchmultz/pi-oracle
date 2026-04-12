// Purpose: Manage oracle browser runtime allocation, lease admission, seed/runtime profile handling, and runtime cleanup for the extension side.
// Responsibilities: Allocate runtimes, enforce persisted-session requirements, acquire/release runtime and conversation leases, and clean up runtime artifacts safely.
// Scope: Extension-side runtime coordination only; shared concurrency/process primitives live in extensions/oracle/shared.
// Usage: Imported by jobs, tools, and queue logic to provision or tear down isolated oracle browser runtimes.
// Invariants/Assumptions: Lease metadata is the admission source of truth, tracked worker identity checks defend against PID reuse, and runtime cleanup always attempts lease release.
import { randomUUID, createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync, realpathSync, readFileSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { jobBlocksAdmission } from "../shared/job-coordination-helpers.mjs";
import { isTrackedProcessAlive } from "../shared/process-helpers.mjs";
import type { OracleConfig } from "./config.js";
import { createLease, listLeaseMetadata, readLeaseMetadata, releaseLease, withAuthLock } from "./locks.js";

const SEED_GENERATION_FILE = ".oracle-seed-generation";
const DEFAULT_ORACLE_JOBS_DIR = "/tmp";
const ORACLE_JOBS_DIR = process.env.PI_ORACLE_JOBS_DIR?.trim() || DEFAULT_ORACLE_JOBS_DIR;
const AGENT_BROWSER_BIN = [process.env.AGENT_BROWSER_PATH, "/opt/homebrew/bin/agent-browser", "/usr/local/bin/agent-browser"].find(
  (candidate) => typeof candidate === "string" && candidate && existsSync(candidate),
) || "agent-browser";
const PROFILE_CLONE_TIMEOUT_MS = 120_000;
const ORACLE_SUBPROCESS_KILL_GRACE_MS = 2_000;

export interface OracleRuntimeLeaseMetadata {
  jobId: string;
  runtimeId: string;
  runtimeSessionName: string;
  runtimeProfileDir: string;
  projectId: string;
  sessionId: string;
  createdAt: string;
}

export interface OracleConversationLeaseMetadata {
  jobId: string;
  conversationId: string;
  projectId: string;
  sessionId: string;
  createdAt: string;
}

export interface OracleRuntimeLeaseAttempt {
  acquired: boolean;
  liveLeases: OracleRuntimeLeaseMetadata[];
  blocker?: OracleRuntimeLeaseMetadata;
}

export interface OracleConversationLeaseAttempt {
  acquired: boolean;
  blocker?: OracleConversationLeaseMetadata;
}

export function getProjectId(cwd: string): string {
  try {
    return realpathSync(cwd);
  } catch {
    return cwd;
  }
}

export function hasPersistedSessionFile(originSessionFile: string | undefined): originSessionFile is string {
  return Boolean(originSessionFile);
}

export function requirePersistedSessionFile(originSessionFile: string | undefined, action = "use oracle"): string {
  if (!originSessionFile) {
    throw new Error(`Oracle requires a persisted pi session to ${action}. Start or save a real session before using oracle.`);
  }
  return originSessionFile;
}

export function getSessionId(originSessionFile: string | undefined, _projectId: string): string {
  return requirePersistedSessionFile(originSessionFile, "derive oracle session identity");
}

export function parseConversationId(chatUrl: string | undefined): string | undefined {
  if (!chatUrl) return undefined;
  try {
    const parsed = new URL(chatUrl);
    const match = parsed.pathname.match(/\/c\/([^/?#]+)/i);
    return match?.[1];
  } catch {
    return undefined;
  }
}

export function allocateRuntime(config: OracleConfig): { runtimeId: string; runtimeSessionName: string; runtimeProfileDir: string } {
  const runtimeId = randomUUID();
  return {
    runtimeId,
    runtimeSessionName: `${config.browser.sessionPrefix}-${runtimeId}`,
    runtimeProfileDir: join(config.browser.runtimeProfilesDir, runtimeId),
  };
}

export function authSessionName(config: OracleConfig): string {
  return `${config.browser.sessionPrefix}-auth`;
}

export function getSeedGeneration(config: OracleConfig): string | undefined {
  const path = join(config.browser.authSeedProfileDir, SEED_GENERATION_FILE);
  if (!existsSync(path)) return undefined;
  try {
    const value = readFileSync(path, "utf8").trim();
    return value || undefined;
  } catch {
    return undefined;
  }
}

export async function writeSeedGeneration(config: OracleConfig, value = new Date().toISOString()): Promise<string> {
  await mkdir(config.browser.authSeedProfileDir, { recursive: true, mode: 0o700 });
  await writeFile(join(config.browser.authSeedProfileDir, SEED_GENERATION_FILE), `${value}\n`, { encoding: "utf8", mode: 0o600 });
  return value;
}

function activeJobExists(jobId: string): boolean {
  const path = join(ORACLE_JOBS_DIR, `oracle-${jobId}`, "job.json");
  if (!existsSync(path)) return false;
  try {
    const job = JSON.parse(readFileSync(path, "utf8")) as {
      status?: string;
      cleanupPending?: unknown;
      workerPid?: unknown;
      workerStartedAt?: unknown;
    };
    return jobBlocksAdmission({
      status: typeof job.status === "string" ? job.status : undefined,
      cleanupPending: job.cleanupPending === true,
      workerPid: typeof job.workerPid === "number" ? job.workerPid : undefined,
      workerStartedAt: typeof job.workerStartedAt === "string" ? job.workerStartedAt : undefined,
    }, isTrackedProcessAlive);
  } catch {
    return false;
  }
}

async function collectLiveRuntimeLeases(): Promise<OracleRuntimeLeaseMetadata[]> {
  const existing = listLeaseMetadata<OracleRuntimeLeaseMetadata>("runtime");
  const liveLeases: OracleRuntimeLeaseMetadata[] = [];
  for (const lease of existing) {
    if (!activeJobExists(lease.jobId)) {
      await releaseLease("runtime", lease.runtimeId).catch(() => undefined);
      continue;
    }
    liveLeases.push(lease);
  }
  return liveLeases;
}

export async function tryAcquireRuntimeLease(config: OracleConfig, metadata: OracleRuntimeLeaseMetadata): Promise<OracleRuntimeLeaseAttempt> {
  const liveLeases = await collectLiveRuntimeLeases();
  if (liveLeases.length >= config.browser.maxConcurrentJobs) {
    return {
      acquired: false,
      liveLeases,
      blocker: liveLeases[0],
    };
  }
  await createLease("runtime", metadata.runtimeId, metadata);
  return {
    acquired: true,
    liveLeases,
  };
}

export async function acquireRuntimeLease(config: OracleConfig, metadata: OracleRuntimeLeaseMetadata): Promise<void> {
  const attempt = await tryAcquireRuntimeLease(config, metadata);
  if (attempt.acquired) return;
  const blocker = attempt.blocker;
  throw new Error(
    `Oracle is busy (${attempt.liveLeases.length}/${config.browser.maxConcurrentJobs} active). ` +
      `Blocking job ${blocker?.jobId ?? "unknown"} in project ${blocker?.projectId ?? "unknown"}.`,
  );
}

export async function releaseRuntimeLease(runtimeId: string | undefined): Promise<void> {
  if (!runtimeId) return;
  await releaseLease("runtime", runtimeId);
}

export async function tryAcquireConversationLease(metadata: OracleConversationLeaseMetadata): Promise<OracleConversationLeaseAttempt> {
  const existing = await readLeaseMetadata<OracleConversationLeaseMetadata>("conversation", metadata.conversationId);
  if (existing?.jobId === metadata.jobId) {
    return { acquired: true };
  }
  if (existing && existing.jobId !== metadata.jobId) {
    if (!activeJobExists(existing.jobId)) {
      await releaseLease("conversation", metadata.conversationId).catch(() => undefined);
    } else {
      return { acquired: false, blocker: existing };
    }
  }
  await createLease("conversation", metadata.conversationId, metadata);
  return { acquired: true };
}

export async function acquireConversationLease(metadata: OracleConversationLeaseMetadata): Promise<void> {
  const attempt = await tryAcquireConversationLease(metadata);
  if (attempt.acquired) return;
  throw new Error(
    `Oracle conversation ${metadata.conversationId} is already in use by job ${attempt.blocker?.jobId ?? "unknown"}. ` +
      `Concurrent follow-ups to the same ChatGPT thread are not allowed.`,
  );
}

export async function releaseConversationLease(conversationId: string | undefined): Promise<void> {
  if (!conversationId) return;
  await releaseLease("conversation", conversationId);
}

function profileCloneArgs(config: OracleConfig, sourceDir: string, destinationDir: string): string[] {
  if (config.browser.cloneStrategy === "apfs-clone") {
    return ["-cR", sourceDir, destinationDir];
  }
  return ["-R", sourceDir, destinationDir];
}

async function spawnCp(args: string[], options?: { timeoutMs?: number }): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn("cp", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    let timedOut = false;
    let killTimer: NodeJS.Timeout | undefined;
    let killGraceTimer: NodeJS.Timeout | undefined;

    const clearTimers = () => {
      if (killTimer) clearTimeout(killTimer);
      if (killGraceTimer) clearTimeout(killGraceTimer);
    };

    if ((options?.timeoutMs ?? 0) > 0) {
      killTimer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
        killGraceTimer = setTimeout(() => {
          child.kill("SIGKILL");
        }, ORACLE_SUBPROCESS_KILL_GRACE_MS);
        killGraceTimer.unref?.();
      }, options?.timeoutMs);
      killTimer.unref?.();
    }

    child.stderr.on("data", (data) => {
      stderr += String(data);
    });
    child.on("error", (error) => {
      clearTimers();
      reject(error);
    });
    child.on("close", (code) => {
      clearTimers();
      if (timedOut) {
        reject(new Error(stderr || `cp timed out after ${options?.timeoutMs}ms`));
        return;
      }
      if (code === 0) resolve();
      else reject(new Error(stderr || `cp exited with code ${code}`));
    });
  });
}

export async function cloneSeedProfileToRuntime(
  config: OracleConfig,
  runtimeProfileDir: string,
  options?: { cpTimeoutMs?: number },
): Promise<string | undefined> {
  const seedDir = config.browser.authSeedProfileDir;
  if (!existsSync(seedDir)) {
    throw new Error(`Oracle auth seed profile not found: ${seedDir}. Run /oracle-auth first.`);
  }

  await withAuthLock({ runtimeProfileDir, seedDir }, async () => {
    await rm(runtimeProfileDir, { recursive: true, force: true }).catch(() => undefined);
    await mkdir(dirname(runtimeProfileDir), { recursive: true, mode: 0o700 }).catch(() => undefined);
    await spawnCp(profileCloneArgs(config, seedDir, runtimeProfileDir), { timeoutMs: options?.cpTimeoutMs ?? PROFILE_CLONE_TIMEOUT_MS });
  });

  return getSeedGeneration(config);
}

const AGENT_BROWSER_CLOSE_TIMEOUT_MS = 10_000;

export interface OracleCleanupReport {
  attempted: Array<"browser" | "runtimeProfileDir" | "conversationLease" | "runtimeLease" | "queuedArchive">;
  warnings: string[];
}

async function closeRuntimeBrowserSession(runtimeSessionName: string): Promise<string | undefined> {
  return new Promise<string | undefined>((resolve) => {
    const child = spawn(AGENT_BROWSER_BIN, ["--session", runtimeSessionName, "close"], { stdio: "ignore" });
    let settled = false;
    let timeout: NodeJS.Timeout | undefined;
    let timedOut = false;

    const finish = (warning?: string) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      resolve(warning);
    };

    timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => {
        child.kill("SIGKILL");
        finish(`Timed out closing agent-browser session ${runtimeSessionName} after ${AGENT_BROWSER_CLOSE_TIMEOUT_MS}ms`);
      }, 2_000).unref?.();
    }, AGENT_BROWSER_CLOSE_TIMEOUT_MS);
    timeout.unref?.();

    child.on("error", (error) => finish(`Failed to close agent-browser session ${runtimeSessionName}: ${error.message}`));
    child.on("close", (code) => {
      if (timedOut || code === 0) finish();
      else finish(`agent-browser close exited with code ${code} for session ${runtimeSessionName}`);
    });
  });
}

export async function cleanupRuntimeArtifacts(runtime: {
  runtimeId?: string;
  runtimeProfileDir?: string;
  runtimeSessionName?: string;
  conversationId?: string;
}): Promise<OracleCleanupReport> {
  const report: OracleCleanupReport = { attempted: [], warnings: [] };

  if (runtime.runtimeSessionName) {
    report.attempted.push("browser");
    const warning = await closeRuntimeBrowserSession(runtime.runtimeSessionName).catch((error: Error) => error.message);
    if (warning) report.warnings.push(warning);
  }
  if (runtime.runtimeProfileDir) {
    report.attempted.push("runtimeProfileDir");
    await rm(runtime.runtimeProfileDir, { recursive: true, force: true }).catch((error: Error) => {
      report.warnings.push(`Failed to remove runtime profile ${runtime.runtimeProfileDir}: ${error.message}`);
    });
  }
  if (runtime.conversationId) {
    report.attempted.push("conversationLease");
  }
  await releaseConversationLease(runtime.conversationId).catch((error: Error) => {
    report.warnings.push(`Failed to release conversation lease ${runtime.conversationId}: ${error.message}`);
  });
  if (runtime.runtimeId) {
    report.attempted.push("runtimeLease");
  }
  await releaseRuntimeLease(runtime.runtimeId).catch((error: Error) => {
    report.warnings.push(`Failed to release runtime lease ${runtime.runtimeId}: ${error.message}`);
  });

  return report;
}

export function stableProjectLabel(projectId: string): string {
  return basename(projectId) || createHash("sha256").update(projectId).digest("hex").slice(0, 8);
}
