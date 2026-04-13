// Purpose: Run local regression checks for the pi oracle extension.
// Responsibilities: Exercise config, locking, queueing, worker, tool schema, and documentation contracts without remote CI.
// Scope: Sanity-test orchestration only; production behavior remains in extensions/oracle and prompts/docs.
// Usage: Invoked by npm run sanity:oracle through scripts/oracle-sanity-runner.mjs.
// Invariants/Assumptions: Tests run from the repository root with local development dependencies installed.
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { SessionManager, type SessionEntry } from "@mariozechner/pi-coding-agent";
import type { AssistantMessage } from "@mariozechner/pi-ai";
import { Check } from "@sinclair/typebox/value";
import {
  coerceOracleSubmitPresetId,
  DEFAULT_CONFIG,
  formatOracleAuthConfigRemediation,
  formatOracleAuthConfigSummary,
  getOracleConfigLoadDetails,
  loadOracleConfig,
  ORACLE_SUBMIT_PRESETS,
  resolveOracleSubmitPreset,
  type OracleConfig,
  type OracleSubmitPresetId,
} from "../extensions/oracle/lib/config.ts";
import { ensureAccountCookie, filterImportableAuthCookies, type ImportedAuthCookie } from "../extensions/oracle/worker/auth-cookie-policy.mjs";
import { extractArtifactLabels, filterStructuralArtifactCandidates, parseSnapshotEntries, partitionStructuralArtifactCandidates } from "../extensions/oracle/worker/artifact-heuristics.mjs";
import {
  buildAllowedChatGptOrigins,
  buildAssistantCompletionSignature,
  deriveAssistantCompletionSignature,
  snapshotCanSafelySkipModelConfiguration,
  snapshotStronglyMatchesRequestedModel,
  snapshotWeaklyMatchesRequestedModel,
} from "../extensions/oracle/worker/chatgpt-ui-helpers.mjs";
import { buildAccountChooserCandidateLabels, classifyChatAuthPage, normalizeLoginProbeResult } from "../extensions/oracle/worker/auth-flow-helpers.mjs";
import { assistantSnapshotSlice, isConversationPathUrl, nextStableValueState, resolveStableConversationUrlCandidate, stripUrlQueryAndHash } from "../extensions/oracle/worker/chatgpt-flow-helpers.mjs";
import {
  buildConversationLeaseMetadata,
  buildRuntimeLeaseMetadata,
  compareQueuedOracleJobs,
  hasAdmissionBlockingWorker,
  jobBlocksAdmission,
  runQueuedJobPromotionPass,
} from "../extensions/oracle/shared/job-coordination-helpers.mjs";
import {
  buildOracleStatusText,
  buildOracleWakeupNotificationContent,
  formatOracleJobSummary,
  formatOracleSubmitResponse,
} from "../extensions/oracle/shared/job-observability-helpers.mjs";
import {
  appendOracleJobLifecycleEvent,
  applyOracleJobCleanupWarnings,
  clearOracleJobCleanupState,
  getLatestOracleJobLifecycleEvent,
  markOracleJobCreated,
  markOracleJobNotified,
  markOracleJobWakeupSettled,
  noteOracleJobWakeupRequested,
  transitionOracleJobPhase,
} from "../extensions/oracle/shared/job-lifecycle-helpers.mjs";
import type { OracleLifecycleTrackedJobLike } from "../extensions/oracle/shared/job-lifecycle-helpers.mjs";
import { isTrackedProcessAlive, spawnDetachedNodeProcess, terminateTrackedProcess } from "../extensions/oracle/shared/process-helpers.mjs";
import {
  acquireLock as acquireWorkerStateLock,
  createLease as createWorkerStateLease,
  ORACLE_METADATA_WRITE_GRACE_MS as WORKER_METADATA_WRITE_GRACE_MS,
  readLeaseMetadata as readWorkerStateLeaseMetadata,
  releaseLease as releaseWorkerStateLease,
  releaseLock as releaseWorkerStateLock,
} from "../extensions/oracle/worker/state-locks.mjs";
import {
  cancelOracleJob,
  createJob,
  getJobDir,
  hasDurableWorkerHandoff,
  isActiveOracleJob,
  listOracleJobDirs,
  markJobNotified,
  pruneTerminalOracleJobs,
  ORACLE_WAKEUP_POST_SEND_RETENTION_MS,
  readJob,
  reconcileStaleOracleJobs,
  removeTerminalOracleJob,
  resolveArchiveInputs,
  tryClaimNotification,
  updateJob,
  withJobPhase,
} from "../extensions/oracle/lib/jobs.ts";
import {
  acquireLock,
  getLeasesDir,
  getLocksDir,
  getOracleStateDir,
  listLeaseMetadata,
  ORACLE_METADATA_WRITE_GRACE_MS,
  ORACLE_TMP_STATE_DIR_GRACE_MS,
  readLeaseMetadata,
  releaseLease,
  releaseLock,
  sweepStaleLocks,
  withGlobalReconcileLock,
  writeLeaseMetadata,
} from "../extensions/oracle/lib/locks.ts";
import { getPollerSessionKey, scanOracleJobsOnce, startPoller, stopPollerForSession } from "../extensions/oracle/lib/poller.ts";
import { getQueuePosition, promoteQueuedJobs, promoteQueuedJobsWithinAdmissionLock } from "../extensions/oracle/lib/queue.ts";
import {
  acquireConversationLease,
  acquireRuntimeLease,
  cloneSeedProfileToRuntime,
  getProjectId,
  releaseConversationLease,
  releaseRuntimeLease,
  tryAcquireConversationLease,
  tryAcquireRuntimeLease,
} from "../extensions/oracle/lib/runtime.ts";
import { createArchiveForTesting, getQueueAdmissionFailure, getQueuedArchivePressure, registerOracleTools, resolveExpandedArchiveEntries } from "../extensions/oracle/lib/tools.ts";
import { registerOracleCommands } from "../extensions/oracle/lib/commands.ts";
import oracleExtension from "../extensions/oracle/index.ts";
import { runPollerSanitySuite } from "./oracle-sanity-poller-suite.ts";
import { createCommandCtx, createExtensionCtx, createPiHarness, resetOracleStateDir } from "./oracle-sanity-support.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function assertThrows(block: () => void, failureMessage: string, expectedSubstring: string): void {
  try {
    block();
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error);
    if (!text.includes(expectedSubstring)) {
      throw new Error(
        `${failureMessage}: expected error message to include ${JSON.stringify(expectedSubstring)}, got ${JSON.stringify(text)}`,
      );
    }
    return;
  }
  throw new Error(`${failureMessage}: expected throw`);
}

async function assertRejects(block: () => Promise<unknown>, failureMessage: string, expectedSubstring: string): Promise<void> {
  try {
    await block();
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error);
    if (!text.includes(expectedSubstring)) {
      throw new Error(
        `${failureMessage}: expected error message to include ${JSON.stringify(expectedSubstring)}, got ${JSON.stringify(text)}`,
      );
    }
    return;
  }
  throw new Error(`${failureMessage}: expected rejection`);
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

async function writeExecutableScript(path: string, content: string): Promise<void> {
  await writeFile(path, content, { encoding: "utf8", mode: 0o755 });
  await chmod(path, 0o755);
}

async function runProcess(
  command: string,
  args: string[],
  options?: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number },
): Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options?.cwd,
      env: options?.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let killTimer: NodeJS.Timeout | undefined;

    if ((options?.timeoutMs ?? 0) > 0) {
      killTimer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
        setTimeout(() => child.kill("SIGKILL"), 2_000).unref?.();
      }, options?.timeoutMs);
      killTimer.unref?.();
    }

    child.stdout.on("data", (data) => {
      stdout += String(data);
    });
    child.stderr.on("data", (data) => {
      stderr += String(data);
    });
    child.on("error", (error) => {
      if (killTimer) clearTimeout(killTimer);
      reject(error);
    });
    child.on("close", (code) => {
      if (killTimer) clearTimeout(killTimer);
      resolve({ code, stdout, stderr, timedOut });
    });
  });
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function findPresetId(
  predicate: (preset: (typeof ORACLE_SUBMIT_PRESETS)[OracleSubmitPresetId]) => boolean,
  failureMessage: string,
): OracleSubmitPresetId {
  const match = (Object.entries(ORACLE_SUBMIT_PRESETS) as [OracleSubmitPresetId, (typeof ORACLE_SUBMIT_PRESETS)[OracleSubmitPresetId]][])
    .find(([, preset]) => predicate(preset));
  if (!match) throw new Error(failureMessage);
  return match[0];
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const IN_FLIGHT_LOCK_PUBLISHER_SCRIPT = [
  'import { createHash } from "node:crypto";',
  'import { mkdir, rename, writeFile } from "node:fs/promises";',
  'import { join } from "node:path";',
  'const [stateDir, kind, key] = process.argv.slice(1);',
  'const finalName = `${kind}-${createHash("sha256").update(key).digest("hex").slice(0, 24)}`;',
  'const parentDir = join(stateDir, "locks");',
  'const tempPath = join(parentDir, `.tmp-${finalName}.${process.pid}.${Date.now()}.child`);',
  'const finalPath = join(parentDir, finalName);',
  'await mkdir(parentDir, { recursive: true, mode: 0o700 });',
  'await mkdir(tempPath, { recursive: false, mode: 0o700 });',
  'process.stdin.resume();',
  'await new Promise((resolve) => process.stdin.once("data", () => resolve(undefined)));',
  'await writeFile(join(tempPath, "metadata.json"), `${JSON.stringify({ processPid: process.pid, source: "oracle-sanity-inflight-publisher" }, null, 2)}\\n`, { encoding: "utf8", mode: 0o600 });',
  'await rename(tempPath, finalPath);',
].join("\n");

function readProcessStartedAt(pid: number | undefined): string | undefined {
  if (!pid || pid <= 0) return undefined;
  try {
    const startedAt = execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8" }).trim();
    return startedAt || undefined;
  } catch {
    return undefined;
  }
}

function isPidAlive(pid: number | undefined): boolean {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForPidExit(pid: number | undefined, timeoutMs = 5_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isPidAlive(pid)) return true;
    await sleep(100);
  }
  return !isPidAlive(pid);
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function waitForTmpStateDir(parentDir: string, finalName: string, timeoutMs: number): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const entries = await readdir(parentDir).catch(() => [] as string[]);
    const match = entries.find((name) => name.startsWith(`.tmp-${finalName}.`));
    if (match) return join(parentDir, match);
    await sleep(25);
  }
  throw new Error(`Timed out waiting for in-flight .tmp-* dir for ${finalName}`);
}

function hashedOracleStatePath(kind: string, key: string, rootDir: string): string {
  return join(rootDir, `${kind}-${createHash("sha256").update(key).digest("hex").slice(0, 24)}`);
}

async function ensureNoActiveJobs(): Promise<void> {
  const activeJobs = listOracleJobDirs()
    .map((dir) => readJob(dir))
    .filter((job): job is NonNullable<typeof job> => Boolean(job))
    .filter((job) => isActiveOracleJob(job));
  if (activeJobs.length > 0) {
    throw new Error(`Refusing to run oracle sanity checks while active jobs exist in the configured jobs dir: ${activeJobs.map((job) => job.id).join(", ")}`);
  }
}

async function writeActiveJob(id: string): Promise<void> {
  const dir = getJobDir(id);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await writeFile(join(dir, "job.json"), `${JSON.stringify({ id, status: "submitted" }, null, 2)}\n`, { mode: 0o600 });
}

async function cleanupJob(id: string): Promise<void> {
  await rm(getJobDir(id), { recursive: true, force: true });
}

async function testRuntimeConversationLeases(config: OracleConfig): Promise<void> {
  await resetOracleStateDir();
  const jobA = `sanity-lease-${randomUUID()}`;
  const jobB = `sanity-lease-${randomUUID()}`;
  await writeActiveJob(jobA);
  await writeActiveJob(jobB);

  await acquireRuntimeLease(config, {
    jobId: jobA,
    runtimeId: "runtime-a",
    runtimeSessionName: "oracle-runtime-a",
    runtimeProfileDir: "/tmp/oracle-runtime-a",
    projectId: "/tmp/project-a",
    sessionId: "session-a",
    createdAt: new Date().toISOString(),
  });

  let runtimeBlocked = false;
  try {
    await acquireRuntimeLease(config, {
      jobId: jobB,
      runtimeId: "runtime-b",
      runtimeSessionName: "oracle-runtime-b",
      runtimeProfileDir: "/tmp/oracle-runtime-b",
      projectId: "/tmp/project-b",
      sessionId: "session-b",
      createdAt: new Date().toISOString(),
    });
  } catch {
    runtimeBlocked = true;
  }
  assert(runtimeBlocked, "second runtime lease should be blocked when maxConcurrentJobs=1");

  await acquireConversationLease({
    jobId: jobA,
    conversationId: "conversation-a",
    projectId: "/tmp/project-a",
    sessionId: "session-a",
    createdAt: new Date().toISOString(),
  });

  let conversationBlocked = false;
  try {
    await acquireConversationLease({
      jobId: jobB,
      conversationId: "conversation-a",
      projectId: "/tmp/project-b",
      sessionId: "session-b",
      createdAt: new Date().toISOString(),
    });
  } catch {
    conversationBlocked = true;
  }
  assert(conversationBlocked, "same-conversation lease should be blocked");

  await releaseConversationLease("conversation-a");
  await releaseRuntimeLease("runtime-a");
  await cleanupJob(jobA);
  await cleanupJob(jobB);
}

async function createJobForTest(
  config: OracleConfig,
  cwd: string,
  sessionId: string,
  options?: {
    requestSource?: "tool" | "command";
    initialState?: "queued" | "submitted";
    followUpToJobId?: string;
    chatUrl?: string;
    preset?: OracleSubmitPresetId;
  },
) {
  const jobId = `sanity-job-${randomUUID()}`;
  const runtime = {
    runtimeId: `runtime-${randomUUID()}`,
    runtimeSessionName: `oracle-runtime-${randomUUID()}`,
    runtimeProfileDir: `/tmp/oracle-runtime-${randomUUID()}`,
    seedGeneration: new Date().toISOString(),
  };
  const preset = options?.preset ?? config.defaults.preset;
  await createJob(
    jobId,
    {
      prompt: "sanity",
      files: ["docs/ORACLE_DESIGN.md"],
      selection: resolveOracleSubmitPreset(preset),
      requestSource: options?.requestSource ?? "tool",
      followUpToJobId: options?.followUpToJobId,
      chatUrl: options?.chatUrl,
    },
    cwd,
    sessionId,
    config,
    runtime,
    { initialState: options?.initialState ?? "submitted" },
  );
  const created = readJob(jobId);
  assert(created, "test job should exist after creation");
  await writeFile(created.archivePath, "sanity archive\n", { mode: 0o600 });
  return jobId;
}

async function createTerminalJob(config: OracleConfig, cwd: string, sessionId: string, requestSource: "tool" | "command" = "tool") {
  const jobId = await createJobForTest(config, cwd, sessionId, { requestSource });
  const completedAt = new Date().toISOString();
  await updateJob(jobId, (job) => ({
    ...job,
    ...withJobPhase("complete", {
      status: "complete",
      completedAt,
      responsePath: join(getJobDir(job.id), "response.md"),
      responseFormat: "text/plain",
    }, completedAt),
  }));
  return jobId;
}

function createUiStub() {
  return {
    notifications: [] as Array<{ message: string; level: string }>,
    statuses: [] as Array<{ key: string; value: string }>,
    setStatus(key: string, value: string) {
      this.statuses.push({ key, value });
    },
    theme: { fg: (_name: string, text: string) => text },
    notify(message: string, level: string) {
      this.notifications.push({ message, level });
    },
  };
}

function createPersistedSessionManager(name: string) {
  return SessionManager.create(process.cwd(), join(tmpdir(), `oracle-sanity-sessions-${name}-${randomUUID()}`));
}

const TEST_ASSISTANT_USAGE: AssistantMessage["usage"] = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    total: 0,
  },
};

function appendUserMessage(sessionManager: Pick<SessionManager, "appendMessage">, text: string): string {
  return sessionManager.appendMessage({
    role: "user",
    content: text,
    timestamp: Date.now(),
  });
}

function appendAssistantMessage(
  sessionManager: Pick<SessionManager, "appendMessage">,
  text: string,
  options?: { api?: AssistantMessage["api"]; provider?: AssistantMessage["provider"]; model?: string; responseId?: string },
): string {
  return sessionManager.appendMessage({
    role: "assistant",
    content: [{ type: "text", text }],
    api: options?.api ?? "openai-responses",
    provider: options?.provider ?? "openai",
    model: options?.model ?? "gpt-5",
    responseId: options?.responseId,
    usage: { ...TEST_ASSISTANT_USAGE, cost: { ...TEST_ASSISTANT_USAGE.cost } },
    stopReason: "stop",
    timestamp: Date.now(),
  });
}

function createPollerCtx(sessionManager: SessionManager) {
  return {
    cwd: process.cwd(),
    sessionManager,
    hasUI: true,
    ui: createUiStub(),
    isIdle: () => true,
    hasPendingMessages: () => false,
  };
}

type AssistantSessionEntry = Extract<SessionEntry, { type: "message" }> & { message: AssistantMessage };

function findNotificationEntry(sessionManager: Pick<SessionManager, "getEntries">, jobId: string): AssistantSessionEntry | undefined {
  const entry = sessionManager.getEntries().find((candidate) => {
    if (candidate.type !== "message" || candidate.message.role !== "assistant") return false;
    return candidate.message.responseId === `oracle-notification:${jobId}`;
  });
  return entry as AssistantSessionEntry | undefined;
}

async function completeJob(jobId: string, status: "complete" | "failed" | "cancelled" = "complete") {
  const completedAt = new Date().toISOString();
  await updateJob(jobId, (job) => ({
    ...job,
    ...withJobPhase(status === "complete" ? "complete" : status, {
      status,
      completedAt,
      responsePath: join(getJobDir(job.id), "response.md"),
      responseFormat: "text/plain",
    }, completedAt),
  }));
}

async function waitForProcessStartedAtValue(pid: number | undefined, timeoutMs = 2_000): Promise<string | undefined> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const startedAt = readProcessStartedAt(pid);
    if (startedAt) return startedAt;
    await sleep(50);
  }
  return readProcessStartedAt(pid);
}

async function testCleanupPendingRecoveryUnblocksAdmission(config: OracleConfig): Promise<void> {
  await resetOracleStateDir();
  const cwd = process.cwd();
  const sessionId = "/tmp/oracle-sanity-session-cleanup-pending-recovery.jsonl";
  const jobId = await createTerminalJob(config, cwd, sessionId);
  const job = readJob(jobId);
  assert(job, "cleanup-pending recovery job should exist");
  const conversationId = `conversation-${randomUUID()}`;
  await updateJob(job.id, (current) => ({
    ...current,
    cleanupPending: true,
    cleanupWarnings: ["stale warning"],
    conversationId,
  }));
  const pendingJob = readJob(jobId);
  assert(pendingJob, "cleanup-pending recovery job should be readable");
  await mkdir(pendingJob.runtimeProfileDir, { recursive: true, mode: 0o700 });
  await acquireRuntimeLease(config, {
    jobId: pendingJob.id,
    runtimeId: pendingJob.runtimeId,
    runtimeSessionName: pendingJob.runtimeSessionName,
    runtimeProfileDir: pendingJob.runtimeProfileDir,
    projectId: pendingJob.projectId,
    sessionId: pendingJob.sessionId,
    createdAt: new Date().toISOString(),
  });
  await acquireConversationLease({
    jobId: pendingJob.id,
    conversationId,
    projectId: pendingJob.projectId,
    sessionId: pendingJob.sessionId,
    createdAt: new Date().toISOString(),
  });

  const repaired = await reconcileStaleOracleJobs();
  assert(repaired.some((entry) => entry.id === jobId), "reconcile should repair terminal jobs stuck in cleanup-pending state");
  const recoveredJob = readJob(jobId);
  assert(recoveredJob?.cleanupPending === false, "cleanup-pending recovery should clear cleanupPending after successful teardown");
  assert(!recoveredJob?.cleanupWarnings?.length, "cleanup-pending recovery should clear resolved cleanup warnings");
  assert(!listLeaseMetadata<{ jobId: string }>("runtime").some((lease) => lease.jobId === jobId), "cleanup-pending recovery should release runtime lease after successful teardown");
  assert(!listLeaseMetadata<{ jobId: string }>("conversation").some((lease) => lease.jobId === jobId), "cleanup-pending recovery should release conversation lease after successful teardown");
  await cleanupJob(jobId);
}

async function testCleanupPendingBlocksAdmission(config: OracleConfig): Promise<void> {
  await resetOracleStateDir();
  const cwd = process.cwd();
  const sessionId = "/tmp/oracle-sanity-session-cleanup-pending.jsonl";
  const ownerId = await createTerminalJob(config, cwd, sessionId);
  const owner = readJob(ownerId);
  assert(owner, "cleanup-pending owner job should exist");
  const conversationId = `conversation-${randomUUID()}`;
  await updateJob(owner.id, (job) => ({ ...job, cleanupPending: true, conversationId }));
  const blockingOwner = readJob(owner.id);
  assert(blockingOwner, "cleanup-pending owner should be readable");

  await acquireRuntimeLease(config, {
    jobId: blockingOwner.id,
    runtimeId: blockingOwner.runtimeId,
    runtimeSessionName: blockingOwner.runtimeSessionName,
    runtimeProfileDir: blockingOwner.runtimeProfileDir,
    projectId: blockingOwner.projectId,
    sessionId: blockingOwner.sessionId,
    createdAt: new Date().toISOString(),
  });
  await acquireConversationLease({
    jobId: blockingOwner.id,
    conversationId,
    projectId: blockingOwner.projectId,
    sessionId: blockingOwner.sessionId,
    createdAt: new Date().toISOString(),
  });

  const runtimeAttempt = await tryAcquireRuntimeLease(config, {
    jobId: `blocked-runtime-${randomUUID()}`,
    runtimeId: `runtime-${randomUUID()}`,
    runtimeSessionName: `oracle-runtime-${randomUUID()}`,
    runtimeProfileDir: `/tmp/oracle-runtime-${randomUUID()}`,
    projectId: "/tmp/project-b",
    sessionId: "session-b",
    createdAt: new Date().toISOString(),
  });
  assert(!runtimeAttempt.acquired, "cleanup-pending jobs should keep runtime admission blocked");

  const conversationAttempt = await tryAcquireConversationLease({
    jobId: `blocked-conversation-${randomUUID()}`,
    conversationId,
    projectId: "/tmp/project-b",
    sessionId: "session-b",
    createdAt: new Date().toISOString(),
  });
  assert(!conversationAttempt.acquired, "cleanup-pending jobs should keep conversation admission blocked");

  await releaseConversationLease(conversationId);
  await releaseRuntimeLease(blockingOwner.runtimeId);
  await cleanupJob(ownerId);
}

async function testCleanupWarningsWithoutLiveWorkerDoNotBlockAdmission(config: OracleConfig): Promise<void> {
  await resetOracleStateDir();
  const cwd = process.cwd();
  const sessionId = "/tmp/oracle-sanity-session-cleanup-warnings.jsonl";
  const ownerId = await createTerminalJob(config, cwd, sessionId);
  const owner = readJob(ownerId);
  assert(owner, "cleanup-warning owner job should exist");
  const conversationId = `conversation-${randomUUID()}`;
  await updateJob(owner.id, (job) => ({
    ...job,
    cleanupWarnings: ["profile cleanup failed"],
    conversationId,
  }));
  const blockingOwner = readJob(owner.id);
  assert(blockingOwner, "cleanup-warning owner should be readable");

  await acquireRuntimeLease(config, {
    jobId: blockingOwner.id,
    runtimeId: blockingOwner.runtimeId,
    runtimeSessionName: blockingOwner.runtimeSessionName,
    runtimeProfileDir: blockingOwner.runtimeProfileDir,
    projectId: blockingOwner.projectId,
    sessionId: blockingOwner.sessionId,
    createdAt: new Date().toISOString(),
  });
  await acquireConversationLease({
    jobId: blockingOwner.id,
    conversationId,
    projectId: blockingOwner.projectId,
    sessionId: blockingOwner.sessionId,
    createdAt: new Date().toISOString(),
  });

  const replacementRuntime = {
    jobId: `cleanup-warning-runtime-${randomUUID()}`,
    runtimeId: `runtime-${randomUUID()}`,
    runtimeSessionName: `oracle-runtime-${randomUUID()}`,
    runtimeProfileDir: `/tmp/oracle-runtime-${randomUUID()}`,
    projectId: "/tmp/project-b",
    sessionId: "session-b",
    createdAt: new Date().toISOString(),
  };
  const runtimeAttempt = await tryAcquireRuntimeLease(config, replacementRuntime);
  assert(runtimeAttempt.acquired, "cleanup warnings without a live worker should not keep runtime admission blocked");
  assert(!listLeaseMetadata<{ jobId: string }>("runtime").some((lease) => lease.jobId === ownerId), "runtime admission should prune stale leases owned only by cleanup-warning terminal jobs");

  const conversationAttempt = await tryAcquireConversationLease({
    jobId: `cleanup-warning-conversation-${randomUUID()}`,
    conversationId,
    projectId: "/tmp/project-b",
    sessionId: "session-b",
    createdAt: new Date().toISOString(),
  });
  assert(conversationAttempt.acquired, "cleanup warnings without a live worker should not keep conversation admission blocked");
  assert(!listLeaseMetadata<{ jobId: string }>("conversation").some((lease) => lease.jobId === ownerId), "conversation admission should prune stale leases owned only by cleanup-warning terminal jobs");

  await releaseConversationLease(conversationId);
  await releaseRuntimeLease(replacementRuntime.runtimeId);
  await releaseRuntimeLease(blockingOwner.runtimeId);
  await cleanupJob(ownerId);
}

async function testRuntimeProfileCloneTimeoutKillsHungCp(config: OracleConfig): Promise<void> {
  const fixtureDir = await mkdtemp(join(tmpdir(), "oracle-clone-timeout-"));
  const binDir = await mkdtemp(join(tmpdir(), "oracle-clone-bin-"));
  const seedDir = join(fixtureDir, "seed");
  const runtimeProfileDir = join(fixtureDir, "runtime", "profile");
  const cpPidPath = join(binDir, "cp.pid");
  const originalPath = process.env.PATH ?? "";
  const cloneConfig: OracleConfig = {
    ...config,
    browser: {
      ...config.browser,
      authSeedProfileDir: seedDir,
      runtimeProfilesDir: join(fixtureDir, "runtime"),
      cloneStrategy: "copy",
    },
  };

  try {
    await mkdir(seedDir, { recursive: true, mode: 0o700 });
    await writeFile(join(seedDir, "Preferences"), "{}\n", { mode: 0o600 });
    await writeExecutableScript(
      join(binDir, "cp"),
      `#!/bin/sh
printf '%s\\n' "$$" > ${shellQuote(cpPidPath)}
trap 'exit 0' TERM INT
while :; do sleep 1; done
`,
    );
    process.env.PATH = `${binDir}:${originalPath}`;

    await assertRejects(
      () => cloneSeedProfileToRuntime(cloneConfig, runtimeProfileDir, { cpTimeoutMs: 250 }),
      "runtime profile cloning should time out when cp hangs",
      "timed out",
    );

    const cpPid = Number.parseInt((await readFile(cpPidPath, "utf8")).trim(), 10);
    assert(Number.isFinite(cpPid), "clone timeout test should record a cp pid");
    assert(await waitForPidExit(cpPid), "runtime profile cloning timeout should terminate the hung cp process");
  } finally {
    process.env.PATH = originalPath;
    await rm(fixtureDir, { recursive: true, force: true });
    await rm(binDir, { recursive: true, force: true });
  }
}

async function testAuthBootstrapAgentBrowserTimeoutFailsFast(config: OracleConfig): Promise<void> {
  const fixtureDir = await mkdtemp(join(tmpdir(), "oracle-auth-timeout-"));
  const agentBrowserPath = join(fixtureDir, "agent-browser");
  const browserPidPath = join(fixtureDir, "agent-browser.pid");
  const authConfig: OracleConfig = {
    ...config,
    browser: {
      ...config.browser,
      sessionPrefix: `oracle-auth-timeout-${randomUUID()}`,
      authSeedProfileDir: join(fixtureDir, "seed-profile"),
      runtimeProfilesDir: join(fixtureDir, "runtime-profiles"),
    },
    auth: {
      ...config.auth,
      chromeCookiePath: join(fixtureDir, "missing-cookies.sqlite"),
    },
  };

  try {
    await writeExecutableScript(
      agentBrowserPath,
      `#!/bin/sh
printf '%s\\n' "$$" > ${shellQuote(browserPidPath)}
trap 'exit 0' TERM INT
while :; do sleep 1; done
`,
    );

    const result = await runProcess(
      process.execPath,
      [join(process.cwd(), "extensions/oracle/worker/auth-bootstrap.mjs"), JSON.stringify(authConfig)],
      {
        env: {
          ...process.env,
          AGENT_BROWSER_PATH: agentBrowserPath,
          PI_ORACLE_STATE_DIR: join(fixtureDir, "state"),
          PI_ORACLE_AUTH_AGENT_BROWSER_TIMEOUT_MS: "250",
          PI_ORACLE_AUTH_CLOSE_TIMEOUT_MS: "250",
          PI_ORACLE_AUTH_KILL_GRACE_MS: "100",
        },
        timeoutMs: 8_000,
      },
    );

    assert(!result.timedOut, "auth bootstrap should not hang when agent-browser close stalls");
    assert(result.code !== 0, "auth bootstrap timeout smoke test should still fail because source cookies are unavailable");
    const browserPid = Number.parseInt((await readFile(browserPidPath, "utf8")).trim(), 10);
    assert(Number.isFinite(browserPid), "auth bootstrap timeout test should record an agent-browser pid");
    assert(await waitForPidExit(browserPid), "auth bootstrap should terminate the hung agent-browser process after timing out");
  } finally {
    await rm(fixtureDir, { recursive: true, force: true });
  }
}

async function testAuthBootstrapReportsEffectiveConfigPaths(config: OracleConfig): Promise<void> {
  const fixtureDir = await mkdtemp(join(tmpdir(), "oracle-auth-config-guidance-"));
  const projectDir = join(fixtureDir, "project");
  const agentDir = join(fixtureDir, "agent");
  const projectExtensionsDir = join(projectDir, ".pi", "extensions");
  const agentExtensionsDir = join(agentDir, "extensions");
  const agentBrowserPath = join(fixtureDir, "agent-browser");
  const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
  const authConfig: OracleConfig = {
    ...config,
    browser: {
      ...config.browser,
      sessionPrefix: `oracle-auth-config-guidance-${randomUUID()}`,
      authSeedProfileDir: join(agentExtensionsDir, "oracle-auth-seed-profile"),
      runtimeProfilesDir: join(agentExtensionsDir, "oracle-runtime-profiles"),
    },
    auth: {
      ...config.auth,
      chromeCookiePath: join(fixtureDir, "missing-cookies.sqlite"),
    },
  };

  try {
    await mkdir(projectExtensionsDir, { recursive: true, mode: 0o700 });
    await mkdir(agentExtensionsDir, { recursive: true, mode: 0o700 });
    await writeFile(join(projectExtensionsDir, "oracle.json"), `${JSON.stringify({ defaults: { preset: "instant" } }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await writeExecutableScript(agentBrowserPath, "#!/bin/sh\nexit 0\n");
    process.env.PI_CODING_AGENT_DIR = agentDir;
    const configLoad = getOracleConfigLoadDetails(projectDir);
    const authConfigGuidance = {
      ...configLoad,
      remediation: formatOracleAuthConfigRemediation(configLoad),
      summary: formatOracleAuthConfigSummary(configLoad),
    };

    const result = await runProcess(
      process.execPath,
      [join(process.cwd(), "extensions/oracle/worker/auth-bootstrap.mjs"), JSON.stringify({ config: authConfig, configLoad: authConfigGuidance })],
      {
        cwd: projectDir,
        env: {
          ...process.env,
          PI_CODING_AGENT_DIR: agentDir,
          AGENT_BROWSER_PATH: agentBrowserPath,
          PI_ORACLE_STATE_DIR: join(fixtureDir, "state"),
        },
        timeoutMs: 8_000,
      },
    );

    assert(result.code !== 0, "auth bootstrap config-guidance test should fail when source cookies are unavailable");
    assert(result.stderr.includes(configLoad.effectiveAuthConfigPath), "auth bootstrap failure guidance should point at the effective agent config path for the active PI_CODING_AGENT_DIR");
    assert(result.stderr.includes(configLoad.projectConfigPath), "auth bootstrap failure guidance should mention the loaded project config path when one is present");
    assert(result.stderr.includes("auth.* still comes from"), "auth bootstrap failure guidance should explain that auth settings still come from the agent config when a project config also exists");
    assert(!result.stderr.includes("~/.pi/agent/extensions/oracle.json"), "auth bootstrap failure guidance should not hardcode the default global config path under isolated agent dirs");
  } finally {
    if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
    await rm(fixtureDir, { recursive: true, force: true });
  }
}

async function testJobCreationPersistsSelectionSnapshot(config: OracleConfig): Promise<void> {
  const cwd = process.cwd();
  const sessionId = "/tmp/oracle-sanity-session-selection.jsonl";
  const thinkingPreset = findPresetId(
    (preset) => preset.modelFamily === "thinking" && preset.effort === "standard",
    "expected a thinking preset with standard effort",
  );
  const instantPreset = findPresetId(
    (preset) => preset.modelFamily === "instant" && preset.autoSwitchToThinking === false,
    "expected an instant preset without auto-switch",
  );
  const instantAutoSwitchPreset = findPresetId(
    (preset) => preset.modelFamily === "instant" && preset.autoSwitchToThinking === true,
    "expected an instant preset with auto-switch enabled",
  );

  const thinkingJobId = `sanity-job-${randomUUID()}`;
  const thinkingRuntime = {
    runtimeId: `runtime-${randomUUID()}`,
    runtimeSessionName: `oracle-runtime-${randomUUID()}`,
    runtimeProfileDir: `/tmp/oracle-runtime-${randomUUID()}`,
    seedGeneration: new Date().toISOString(),
  };
  await createJob(
    thinkingJobId,
    {
      prompt: "sanity",
      files: ["docs/ORACLE_DESIGN.md"],
      selection: resolveOracleSubmitPreset(thinkingPreset),
      requestSource: "tool",
    },
    cwd,
    sessionId,
    config,
    thinkingRuntime,
  );
  const thinkingJob = readJob(thinkingJobId);
  assert(thinkingJob?.selection?.preset === thinkingPreset, "thinking jobs should persist the selected preset id");
  assert(thinkingJob?.selection?.modelFamily === "thinking", "thinking jobs should persist modelFamily in selection");
  assert(thinkingJob?.selection?.effort === "standard", "thinking jobs should persist effort in selection");
  assert(thinkingJob?.selection?.autoSwitchToThinking === false, "thinking jobs should not enable autoSwitchToThinking");
  await cleanupJob(thinkingJobId);

  const instantJobId = `sanity-job-${randomUUID()}`;
  const instantRuntime = {
    runtimeId: `runtime-${randomUUID()}`,
    runtimeSessionName: `oracle-runtime-${randomUUID()}`,
    runtimeProfileDir: `/tmp/oracle-runtime-${randomUUID()}`,
    seedGeneration: new Date().toISOString(),
  };
  await createJob(
    instantJobId,
    {
      prompt: "sanity",
      files: ["docs/ORACLE_DESIGN.md"],
      selection: resolveOracleSubmitPreset(instantPreset),
      requestSource: "tool",
    },
    cwd,
    sessionId,
    config,
    instantRuntime,
  );
  const instantJob = readJob(instantJobId);
  assert(instantJob?.selection?.preset === instantPreset, "instant jobs should persist the selected preset id");
  assert(instantJob?.selection?.effort === undefined, "instant jobs should never persist an effort");
  assert(instantJob?.selection?.autoSwitchToThinking === false, "instant presets without auto-switch should keep it disabled");
  await cleanupJob(instantJobId);

  const instantAutoSwitchJobId = `sanity-job-${randomUUID()}`;
  const instantAutoSwitchRuntime = {
    runtimeId: `runtime-${randomUUID()}`,
    runtimeSessionName: `oracle-runtime-${randomUUID()}`,
    runtimeProfileDir: `/tmp/oracle-runtime-${randomUUID()}`,
    seedGeneration: new Date().toISOString(),
  };
  await createJob(
    instantAutoSwitchJobId,
    {
      prompt: "sanity",
      files: ["docs/ORACLE_DESIGN.md"],
      selection: resolveOracleSubmitPreset(instantAutoSwitchPreset),
      requestSource: "tool",
    },
    cwd,
    sessionId,
    config,
    instantAutoSwitchRuntime,
  );
  const instantAutoSwitchJob = readJob(instantAutoSwitchJobId);
  assert(instantAutoSwitchJob?.selection?.preset === instantAutoSwitchPreset, "instant auto-switch jobs should persist the selected preset id");
  assert(instantAutoSwitchJob?.selection?.autoSwitchToThinking === true, "instant auto-switch presets should enable autoSwitchToThinking");
  assert(instantAutoSwitchJob?.selection?.effort === undefined, "instant auto-switch jobs should not persist effort");
  await cleanupJob(instantAutoSwitchJobId);
}

async function testOracleSubmitPresetGuardrails(): Promise<void> {
  for (const [id, preset] of Object.entries(ORACLE_SUBMIT_PRESETS) as [OracleSubmitPresetId, (typeof ORACLE_SUBMIT_PRESETS)[OracleSubmitPresetId]][]) {
    const resolved = resolveOracleSubmitPreset(id);
    assert(resolved.preset === id, `preset ${id} should carry its id in the resolved selection`);
    assert(resolved.modelFamily === preset.modelFamily, `preset ${id} should map to modelFamily ${preset.modelFamily}`);
    assert(coerceOracleSubmitPresetId(id) === id, `canonical preset id ${id} should resolve to itself`);
    assert(coerceOracleSubmitPresetId(id.replace(/_/g, "-")) === id, `hyphenated preset id for ${id} should normalize correctly`);
    assert(coerceOracleSubmitPresetId(id.replace(/_/g, " ")) === id, `space-normalized preset id for ${id} should normalize correctly`);
    assert(coerceOracleSubmitPresetId(preset.label) === id, `preset label ${preset.label} should normalize to ${id}`);
    assert(
      coerceOracleSubmitPresetId(preset.label.toLowerCase()) === id,
      `lowercase preset label ${preset.label.toLowerCase()} should normalize to ${id}`,
    );
    assert(
      coerceOracleSubmitPresetId(preset.label.replace(/[^A-Za-z0-9]+/g, " ").trim().replace(/\s+/g, " ")) === id,
      `space-normalized preset label for ${id} should normalize correctly`,
    );
    if (preset.modelFamily === "instant") {
      assert(resolved.effort === undefined, `preset ${id} should not set effort`);
      assert(
        resolved.autoSwitchToThinking === preset.autoSwitchToThinking,
        `preset ${id} autoSwitchToThinking should match definition`,
      );
    } else {
      assert(resolved.effort === preset.effort, `preset ${id} should set effort ${preset.effort}`);
      assert(resolved.autoSwitchToThinking === false, `preset ${id} should not enable auto-switch`);
    }
  }

  const instantAutoSwitchPreset = findPresetId(
    (preset) => preset.modelFamily === "instant" && preset.autoSwitchToThinking,
    "expected an instant auto-switch oracle submit preset",
  );
  const mixedHyphenSpaceLabel = "Instant Auto-switch to Thinking Enabled";
  assert(
    coerceOracleSubmitPresetId(mixedHyphenSpaceLabel) === instantAutoSwitchPreset,
    `mixed hyphen/space preset label variant ${mixedHyphenSpaceLabel} should normalize to ${instantAutoSwitchPreset}`,
  );

  assertThrows(
    () => resolveOracleSubmitPreset("__not_a_real_preset__" as OracleSubmitPresetId),
    "unknown oracle_submit preset ids should be rejected",
    "Unknown oracle_submit preset",
  );
  assertThrows(
    () => coerceOracleSubmitPresetId("__not_a_real_preset__"),
    "unknown oracle_submit preset aliases should be rejected",
    "Unknown oracle_submit preset",
  );
}

async function testOraclePreflightReportsBlockingReadinessStates(): Promise<void> {
  await resetOracleStateDir();
  const fixtureDir = await mkdtemp(join(tmpdir(), `oracle-sanity-oracle-preflight-${randomUUID()}-`));
  const agentDir = join(fixtureDir, "agent");
  const agentExtensionsDir = join(agentDir, "extensions");
  const fakeWorkerPath = join(fixtureDir, "fake-worker.mjs");
  const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
  await mkdir(agentExtensionsDir, { recursive: true, mode: 0o700 });
  await writeFile(fakeWorkerPath, "process.exit(0);\n", { encoding: "utf8", mode: 0o600 });

  const pi = createPiHarness();
  registerOracleTools(pi as unknown as import("@mariozechner/pi-coding-agent").ExtensionAPI, fakeWorkerPath);
  const preflightTool = pi.tools.get("oracle_preflight");
  assert(preflightTool?.execute, "oracle preflight tool should register for readiness testing");

  const sessionFile = `/tmp/oracle-sanity-session-oracle-preflight-${randomUUID()}.jsonl`;
  const persistedCtx = createExtensionCtx({ getSessionFile: () => sessionFile } as import("@mariozechner/pi-coding-agent").ExtensionContext["sessionManager"], createUiStub());
  const noSessionCtx = createExtensionCtx({ getSessionFile: () => undefined } as import("@mariozechner/pi-coding-agent").ExtensionContext["sessionManager"], createUiStub());
  const defaultSeedDir = join(agentExtensionsDir, "oracle-auth-seed-profile");
  const configPath = join(agentExtensionsDir, "oracle.json");

  try {
    process.env.PI_CODING_AGENT_DIR = agentDir;
    await writeFile(configPath, `${JSON.stringify({ browser: { authSeedProfileDir: defaultSeedDir } }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });

    const noSessionResult = await preflightTool.execute!("oracle-preflight-no-session", {}, undefined, () => { }, noSessionCtx) as { details?: unknown };
    const noSessionDetails = asRecord(noSessionResult.details);
    const noSessionError = asRecord(noSessionDetails?.error);
    assert(noSessionDetails?.ready === false, "oracle preflight should report ready=false when the session is not persisted");
    assert(noSessionError?.code === "persisted_session_required", "oracle preflight should surface persisted_session_required for no-session contexts");

    const missingSeedResult = await preflightTool.execute!("oracle-preflight-missing-seed", {}, undefined, () => { }, persistedCtx) as { details?: unknown };
    const missingSeedDetails = asRecord(missingSeedResult.details);
    const missingSeedError = asRecord(missingSeedDetails?.error);
    const missingSeedAuth = asRecord(missingSeedDetails?.auth);
    assert(missingSeedDetails?.ready === false, "oracle preflight should report ready=false when the auth seed is missing");
    assert(missingSeedError?.code === "auth_seed_profile_missing", "oracle preflight should surface auth_seed_profile_missing when the seed dir is absent");
    assert(missingSeedAuth?.seedProfileDir === defaultSeedDir, "oracle preflight should report the configured auth seed path");

    await mkdir(defaultSeedDir, { recursive: true, mode: 0o700 });
    const readyResult = await preflightTool.execute!("oracle-preflight-ready", {}, undefined, () => { }, persistedCtx) as { details?: unknown };
    const readyDetails = asRecord(readyResult.details);
    const readyAuth = asRecord(readyDetails?.auth);
    assert(readyDetails?.ready === true, "oracle preflight should report ready=true once persisted session and auth seed prerequisites are satisfied");
    assert(readyAuth?.ready === true && readyAuth?.seedProfileDir === defaultSeedDir, "oracle preflight should report the ready auth seed path");

    const missingExecutablePath = join(fixtureDir, "missing-chrome");
    await writeFile(configPath, `${JSON.stringify({ browser: { authSeedProfileDir: defaultSeedDir, executablePath: missingExecutablePath } }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    const missingExecutableResult = await preflightTool.execute!("oracle-preflight-missing-executable", {}, undefined, () => { }, persistedCtx) as { details?: unknown };
    const missingExecutableDetails = asRecord(missingExecutableResult.details);
    const missingExecutableError = asRecord(missingExecutableDetails?.error);
    const missingExecutableAuth = asRecord(missingExecutableDetails?.auth);
    assert(missingExecutableDetails?.ready === false, "oracle preflight should report ready=false when a configured browser executable is missing");
    assert(missingExecutableError?.code === "browser_executable_missing", "oracle preflight should surface browser_executable_missing for a missing configured browser path");
    assert(missingExecutableAuth?.ready === true && missingExecutableAuth?.seedProfileDir === defaultSeedDir, "oracle preflight should keep auth marked ready when a later deterministic prerequisite blocks submission");

    const nonExecutablePath = join(fixtureDir, "non-executable-chrome");
    await writeFile(nonExecutablePath, "not executable\n", { encoding: "utf8", mode: 0o600 });
    await writeFile(configPath, `${JSON.stringify({ browser: { authSeedProfileDir: defaultSeedDir, executablePath: nonExecutablePath } }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    const nonExecutableResult = await preflightTool.execute!("oracle-preflight-non-executable-browser", {}, undefined, () => { }, persistedCtx) as { details?: unknown };
    const nonExecutableError = asRecord(asRecord(nonExecutableResult.details)?.error);
    assert(nonExecutableError?.code === "browser_executable_not_executable", "oracle preflight should surface browser_executable_not_executable for a configured browser path without execute permission");

    const runtimeProfilesFile = join(fixtureDir, "runtime-profiles-file");
    await writeFile(runtimeProfilesFile, "not a directory\n", { encoding: "utf8", mode: 0o600 });
    await writeFile(configPath, `${JSON.stringify({ browser: { authSeedProfileDir: defaultSeedDir, runtimeProfilesDir: runtimeProfilesFile } }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    const runtimeProfilesResult = await preflightTool.execute!("oracle-preflight-runtime-profiles-file", {}, undefined, () => { }, persistedCtx) as { details?: unknown };
    const runtimeProfilesError = asRecord(asRecord(runtimeProfilesResult.details)?.error);
    assert(runtimeProfilesError?.code === "runtime_profiles_dir_unwritable", "oracle preflight should surface runtime_profiles_dir_unwritable when runtimeProfilesDir cannot be prepared as a directory");

    const originalPath = process.env.PATH;
    try {
      process.env.PATH = "";
      await writeFile(configPath, `${JSON.stringify({ browser: { authSeedProfileDir: defaultSeedDir } }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
      const missingDependencyResult = await preflightTool.execute!("oracle-preflight-missing-dependency", {}, undefined, () => { }, persistedCtx) as { details?: unknown };
      const missingDependencyError = asRecord(asRecord(missingDependencyResult.details)?.error);
      assert(missingDependencyError?.code === "local_dependency_missing", "oracle preflight should surface local_dependency_missing when required local executables are unavailable on PATH");
    } finally {
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;
    }
  } finally {
    if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
    await rm(fixtureDir, { recursive: true, force: true });
  }
}

async function testOracleSubmitPreflightRejectsKnownAuthSeedFailures(): Promise<void> {
  await resetOracleStateDir();
  const fixtureDir = await mkdtemp(join(tmpdir(), `oracle-sanity-submit-preflight-${randomUUID()}-`));
  const agentDir = join(fixtureDir, "agent");
  const agentExtensionsDir = join(agentDir, "extensions");
  const fakeWorkerPath = join(fixtureDir, "fake-worker.mjs");
  const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
  await mkdir(agentExtensionsDir, { recursive: true, mode: 0o700 });
  await writeFile(fakeWorkerPath, "process.exit(0);\n", { encoding: "utf8", mode: 0o600 });

  const pi = createPiHarness();
  registerOracleTools(pi as unknown as import("@mariozechner/pi-coding-agent").ExtensionAPI, fakeWorkerPath);
  const submitTool = pi.tools.get("oracle_submit");
  assert(submitTool?.execute, "oracle submit tool should register for preflight testing");

  const sessionFile = `/tmp/oracle-sanity-session-submit-preflight-${randomUUID()}.jsonl`;
  const ctx = createExtensionCtx({ getSessionFile: () => sessionFile } as import("@mariozechner/pi-coding-agent").ExtensionContext["sessionManager"], createUiStub());
  const configPath = join(agentExtensionsDir, "oracle.json");
  const jobDirCountBefore = listOracleJobDirs().length;

  const writeOracleConfig = async (authSeedProfileDir: string): Promise<void> => {
    await writeFile(configPath, `${JSON.stringify({ browser: { authSeedProfileDir } }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  };

  const submit = async () => submitTool.execute!(
    "oracle-submit-preflight-test",
    { prompt: "sanity", files: ["README.md"], preset: "instant" },
    undefined,
    () => { },
    ctx,
  );

  try {
    process.env.PI_CODING_AGENT_DIR = agentDir;

    const missingSeedDir = join(fixtureDir, "missing-seed");
    await writeOracleConfig(missingSeedDir);
    const missingResult = await submit() as { details?: unknown };
    const missingError = asRecord(asRecord(missingResult.details)?.error);
    assert(missingError?.code === "auth_seed_profile_missing", "oracle submit should return a structured missing-auth-seed error code");
    assert(missingError?.rejectedValue === missingSeedDir, "missing auth seed errors should report the missing seed path");
    assert(listOracleJobDirs().length === jobDirCountBefore, "missing auth seed preflight should not create oracle job dirs");

    const unreadableSeedDir = join(fixtureDir, "unreadable-seed");
    await mkdir(unreadableSeedDir, { recursive: true, mode: 0o700 });
    await chmod(unreadableSeedDir, 0o000);
    try {
      await writeOracleConfig(unreadableSeedDir);
      const unreadableResult = await submit() as { details?: unknown };
      const unreadableError = asRecord(asRecord(unreadableResult.details)?.error);
      assert(unreadableError?.code === "auth_seed_profile_unreadable", "oracle submit should return a structured unreadable-auth-seed error code");
      assert(unreadableError?.rejectedValue === unreadableSeedDir, "unreadable auth seed errors should report the blocked seed path");
    } finally {
      await chmod(unreadableSeedDir, 0o700).catch(() => undefined);
    }
    assert(listOracleJobDirs().length === jobDirCountBefore, "unreadable auth seed preflight should not create oracle job dirs");

    const validSeedDir = join(fixtureDir, "valid-seed");
    const missingExecutablePath = join(fixtureDir, "missing-chrome");
    await mkdir(validSeedDir, { recursive: true, mode: 0o700 });
    await writeFile(configPath, `${JSON.stringify({ browser: { authSeedProfileDir: validSeedDir, executablePath: missingExecutablePath } }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    const missingExecutableResult = await submit() as { details?: unknown };
    const missingExecutableError = asRecord(asRecord(missingExecutableResult.details)?.error);
    assert(missingExecutableError?.code === "browser_executable_missing", "oracle submit should return a structured missing-browser-executable error code");
    assert(missingExecutableError?.rejectedValue === missingExecutablePath, "missing browser executable errors should report the configured browser path");
    assert(listOracleJobDirs().length === jobDirCountBefore, "missing browser executable preflight should not create oracle job dirs");
  } finally {
    if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
    await rm(fixtureDir, { recursive: true, force: true });
  }
}

async function testWorkspaceRootProjectIdentityCoversSubdirectories(config: OracleConfig): Promise<void> {
  await resetOracleStateDir();
  const fakeWorkerPath = join(tmpdir(), `oracle-sanity-workspace-root-${randomUUID()}.mjs`);
  await writeFile(fakeWorkerPath, "process.exit(0);\n", { encoding: "utf8", mode: 0o600 });

  const pi = createPiHarness();
  registerOracleTools(pi as unknown as import("@mariozechner/pi-coding-agent").ExtensionAPI, fakeWorkerPath);
  registerOracleCommands(pi as unknown as import("@mariozechner/pi-coding-agent").ExtensionAPI, fakeWorkerPath, fakeWorkerPath);
  const readTool = pi.tools.get("oracle_read");
  const statusCommand = pi.commands.get("oracle-status");
  const cancelCommand = pi.commands.get("oracle-cancel");
  assert(readTool?.execute, "oracle read tool should register for workspace-root scope testing");
  assert(statusCommand, "oracle status command should register for workspace-root scope testing");
  assert(cancelCommand, "oracle cancel command should register for workspace-root scope testing");

  const rootCwd = process.cwd();
  const subdirCwd = join(rootCwd, "extensions", "oracle");
  assert(getProjectId(rootCwd) === getProjectId(subdirCwd), "project identity should collapse subdirectories onto the same workspace root");

  const sessionManager = createPersistedSessionManager("workspace-root");
  const sessionFile = sessionManager.getSessionFile();
  assert(sessionFile, "workspace-root scope test should persist a session file");
  const queuedId = await createJobForTest(config, rootCwd, sessionFile, { initialState: "queued" });
  const readCtx = createExtensionCtx(sessionManager, createUiStub(), subdirCwd);
  const statusUi = createUiStub();
  const statusCtx = createCommandCtx(sessionManager, statusUi, subdirCwd);
  const cancelUi = createUiStub();
  const cancelCtx = createCommandCtx(sessionManager, cancelUi, subdirCwd);

  try {
    const readResult = await readTool.execute!("oracle-read-workspace-root-test", { jobId: queuedId }, undefined, () => { }, readCtx) as { details?: unknown };
    const readJobDetails = asRecord(asRecord(readResult.details)?.job);
    assert(readJobDetails?.id === queuedId, "oracle read should find jobs from the same repo when invoked from a subdirectory");

    await statusCommand.handler("", statusCtx);
    const statusMessage = statusUi.notifications.at(-1)?.message;
    assert(typeof statusMessage === "string" && statusMessage.includes(`job: ${queuedId}`), "oracle status should resolve the latest job for the repo even from a subdirectory cwd");

    await cancelCommand.handler(queuedId, cancelCtx);
    const cancelMessage = cancelUi.notifications.at(-1)?.message;
    assert(typeof cancelMessage === "string" && cancelMessage.includes(`Cancelled oracle job ${queuedId}`), "oracle cancel should cancel repo-scoped jobs from a subdirectory cwd");
  } finally {
    await rm(fakeWorkerPath, { force: true });
    await cleanupJob(queuedId);
  }
}

async function testWorkspaceRootFallsBackToProjectMarkersWithoutGit(): Promise<void> {
  const fixtureDir = await mkdtemp(join(tmpdir(), `oracle-sanity-workspace-root-markers-${randomUUID()}-`));
  const projectRoot = join(fixtureDir, "workspace");
  const subdirCwd = join(projectRoot, "packages", "app");
  const outerRoot = join(fixtureDir, "outer");
  const innerRoot = join(outerRoot, "inner");
  const innerSubdir = join(innerRoot, "src");

  try {
    await mkdir(join(projectRoot, ".pi", "extensions"), { recursive: true, mode: 0o700 });
    await mkdir(subdirCwd, { recursive: true, mode: 0o700 });
    await writeFile(join(projectRoot, "package.json"), '{"name":"workspace-root-markers"}\n', { encoding: "utf8", mode: 0o600 });
    await writeFile(join(projectRoot, "README.md"), "# workspace markers\n", { encoding: "utf8", mode: 0o600 });
    await writeFile(join(projectRoot, ".pi", "extensions", "oracle.json"), `${JSON.stringify({ defaults: { preset: "thinking_light" } }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });

    const workspaceRoot = getProjectId(subdirCwd);
    assert(workspaceRoot === getProjectId(projectRoot), "workspace-root detection should fall back to shared project markers when no git root exists");
    assert(getOracleConfigLoadDetails(subdirCwd).projectConfigPath === join(workspaceRoot, ".pi", "extensions", "oracle.json"), "config loading without git should still resolve the workspace-root project config path from subdirectories");
    assert(loadOracleConfig(subdirCwd).defaults.preset === "thinking_light", "config loading without git should still honor workspace-root project overrides from subdirectories");
    assert(resolveArchiveInputs(workspaceRoot, ["README.md"])[0]?.relative === "README.md", "archive input resolution without git should still allow workspace-root files from the derived project root");
    assert(resolveArchiveInputs(workspaceRoot, ["."])[0]?.relative === ".", "archive input resolution without git should still preserve '.' as the explicit whole-workspace sentinel");

    await mkdir(join(innerRoot, ".pi", "extensions"), { recursive: true, mode: 0o700 });
    await mkdir(innerSubdir, { recursive: true, mode: 0o700 });
    await writeFile(join(outerRoot, "package.json"), '{"name":"outer-workspace"}\n', { encoding: "utf8", mode: 0o600 });
    await writeFile(join(innerRoot, "package.json"), '{"name":"inner-workspace"}\n', { encoding: "utf8", mode: 0o600 });
    await writeFile(join(innerRoot, ".pi", "extensions", "oracle.json"), `${JSON.stringify({ defaults: { preset: "thinking_heavy" } }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    assert(getProjectId(innerSubdir) === getProjectId(innerRoot), "workspace-root detection without git should prefer the nearest project markers so nested non-git projects do not widen to parent workspaces");
    assert(loadOracleConfig(innerSubdir).defaults.preset === "thinking_heavy", "nested non-git subdirectories should load the nearest project config instead of an outer marker tree");
  } finally {
    await rm(fixtureDir, { recursive: true, force: true });
  }
}

async function testOracleSubmitUsesWorkspaceRootForSubdirectoryCwd(config: OracleConfig): Promise<void> {
  await resetOracleStateDir();
  const fixtureDir = await mkdtemp(join(tmpdir(), `oracle-sanity-submit-workspace-root-${randomUUID()}-`));
  const projectRoot = join(fixtureDir, "repo");
  const subdirCwd = join(projectRoot, "packages", "app");
  const agentDir = join(fixtureDir, "agent");
  const agentExtensionsDir = join(agentDir, "extensions");
  const seedDir = join(agentExtensionsDir, "oracle-auth-seed-profile");
  const runtimeProfilesDir = join(agentExtensionsDir, "oracle-runtime-profiles");
  const fakeWorkerPath = join(fixtureDir, "fake-worker.mjs");
  const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
  await mkdir(join(projectRoot, ".git"), { recursive: true, mode: 0o700 });
  await mkdir(join(projectRoot, ".pi", "extensions"), { recursive: true, mode: 0o700 });
  await mkdir(subdirCwd, { recursive: true, mode: 0o700 });
  await mkdir(agentExtensionsDir, { recursive: true, mode: 0o700 });
  await mkdir(seedDir, { recursive: true, mode: 0o700 });
  await writeFile(join(projectRoot, "README.md"), "# workspace root\n", { encoding: "utf8", mode: 0o600 });
  await writeFile(join(subdirCwd, "nested.txt"), "nested\n", { encoding: "utf8", mode: 0o600 });
  await writeFile(join(projectRoot, ".pi", "extensions", "oracle.json"), `${JSON.stringify({ defaults: { preset: "thinking_light" } }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await writeFile(join(agentExtensionsDir, "oracle.json"), `${JSON.stringify({ browser: { authSeedProfileDir: seedDir, runtimeProfilesDir } }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await writeFile(fakeWorkerPath, "process.exit(0);\n", { encoding: "utf8", mode: 0o600 });

  const pi = createPiHarness();
  registerOracleTools(pi as unknown as import("@mariozechner/pi-coding-agent").ExtensionAPI, fakeWorkerPath);
  const submitTool = pi.tools.get("oracle_submit");
  assert(submitTool?.execute, "oracle submit tool should register for workspace-root submit testing");

  const sessionFile = `/tmp/oracle-sanity-session-submit-workspace-root-${randomUUID()}.jsonl`;
  const ctx = createExtensionCtx({ getSessionFile: () => sessionFile } as import("@mariozechner/pi-coding-agent").ExtensionContext["sessionManager"], createUiStub(), subdirCwd);
  let jobId: string | undefined;

  try {
    process.env.PI_CODING_AGENT_DIR = agentDir;

    const workspaceRoot = getProjectId(subdirCwd);
    const configLoad = getOracleConfigLoadDetails(subdirCwd);
    assert(configLoad.projectConfigPath === join(workspaceRoot, ".pi", "extensions", "oracle.json"), "config loading from a subdirectory should resolve the project config at the workspace root");
    assert(configLoad.projectConfigPath !== join(subdirCwd, ".pi", "extensions", "oracle.json"), "config loading from a subdirectory should not look for a nested per-subdirectory project config path");
    assert(loadOracleConfig(subdirCwd).defaults.preset === "thinking_light", "oracle submit should load project config defaults from the workspace root when invoked from a subdirectory");

    const submitResult = await submitTool.execute!(
      "oracle-submit-workspace-root-test",
      { prompt: "sanity", files: ["."] },
      undefined,
      () => { },
      ctx,
    ) as { details?: unknown };
    const submittedJob = asRecord(asRecord(submitResult.details)?.job);
    jobId = typeof submittedJob?.id === "string" ? submittedJob.id : undefined;
    assert(jobId, "oracle submit should still return a structured job id when invoked from a subdirectory cwd");

    const persistedJob = readJob(jobId);
    assert(persistedJob?.projectId === workspaceRoot, "oracle submit should persist the workspace root as the project id when invoked from a subdirectory cwd");
    assert(persistedJob?.selection.preset === "thinking_light", "oracle submit should honor workspace-root project config defaults when invoked from a subdirectory cwd");

    const archiveEntries = execFileSync("sh", ["-c", `zstd -dc ${shellQuote(persistedJob.archivePath)} | tar -tf -`], { encoding: "utf8" }).split(/\r?\n/).filter(Boolean);
    assert(archiveEntries.includes("README.md"), "whole-repo archive selection from a subdirectory should still include workspace-root files");
    assert(archiveEntries.includes("packages/app/nested.txt"), "whole-repo archive selection from a subdirectory should still include nested project files");
  } finally {
    if (jobId) {
      const persistedJob = readJob(jobId);
      await releaseConversationLease(persistedJob?.conversationId);
      await releaseRuntimeLease(persistedJob?.runtimeId);
      await cleanupJob(jobId);
    }
    if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
    await rm(fixtureDir, { recursive: true, force: true });
  }
}

async function testOracleToolResultsExposeStructuredJobDetails(config: OracleConfig): Promise<void> {
  await resetOracleStateDir();
  const fixtureDir = await mkdtemp(join(tmpdir(), `oracle-sanity-tool-details-${randomUUID()}-`));
  const agentDir = join(fixtureDir, "agent");
  const agentExtensionsDir = join(agentDir, "extensions");
  const seedDir = join(agentExtensionsDir, "oracle-auth-seed-profile");
  const fakeWorkerPath = join(fixtureDir, "fake-worker.mjs");
  const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
  await mkdir(agentExtensionsDir, { recursive: true, mode: 0o700 });
  await mkdir(seedDir, { recursive: true, mode: 0o700 });
  await writeFile(fakeWorkerPath, "process.exit(0);\n", { encoding: "utf8", mode: 0o600 });

  const configured = {
    ...config,
    browser: {
      ...config.browser,
      authSeedProfileDir: seedDir,
      maxConcurrentJobs: 1,
    },
  } satisfies OracleConfig;
  await writeFile(join(agentExtensionsDir, "oracle.json"), `${JSON.stringify({ browser: { authSeedProfileDir: seedDir, maxConcurrentJobs: 1 } }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });

  const pi = createPiHarness();
  registerOracleTools(pi as unknown as import("@mariozechner/pi-coding-agent").ExtensionAPI, fakeWorkerPath);
  const submitTool = pi.tools.get("oracle_submit");
  const readTool = pi.tools.get("oracle_read");
  const cancelTool = pi.tools.get("oracle_cancel");
  assert(submitTool?.execute, "oracle submit tool should register for details-shape testing");
  assert(readTool?.execute, "oracle read tool should register for details-shape testing");
  assert(cancelTool?.execute, "oracle cancel tool should register for details-shape testing");

  const cwd = process.cwd();
  const sessionFile = `/tmp/oracle-sanity-session-tool-details-${randomUUID()}.jsonl`;
  const ctx = createExtensionCtx({ getSessionFile: () => sessionFile } as import("@mariozechner/pi-coding-agent").ExtensionContext["sessionManager"], createUiStub());
  let blockingId: string | undefined;
  let queuedId: string | undefined;

  try {
    process.env.PI_CODING_AGENT_DIR = agentDir;

    blockingId = await createJobForTest(configured, cwd, sessionFile);
    const blockingJob = readJob(blockingId);
    assert(blockingJob, "blocking oracle job should exist for queued submit testing");
    await acquireRuntimeLease(configured, {
      jobId: blockingJob.id,
      runtimeId: blockingJob.runtimeId,
      runtimeSessionName: blockingJob.runtimeSessionName,
      runtimeProfileDir: blockingJob.runtimeProfileDir,
      projectId: blockingJob.projectId,
      sessionId: blockingJob.sessionId,
      createdAt: new Date().toISOString(),
    });

    const submitResult = await (submitTool.execute!(
      "oracle-submit-details-test",
      { prompt: "sanity", files: ["README.md"], preset: "instant" },
      undefined,
      () => { },
      ctx,
    )) as { details?: unknown };
    const submitDetails = asRecord(submitResult.details);
    const submittedJob = asRecord(submitDetails?.job);
    const submitQueue = asRecord(submittedJob?.queue);
    const submitLastEvent = asRecord(submittedJob?.lastEvent);
    assert(submitDetails && !("jobId" in submitDetails), "oracle submit should expose structured details under details.job instead of top-level submit fields");
    assert(typeof submittedJob?.id === "string", "oracle submit should include job.id in structured details");
    assert(typeof submittedJob?.promptPath === "string", "oracle submit should include promptPath in structured details");
    assert(typeof submittedJob?.archivePath === "string", "oracle submit should include archivePath in structured details");
    assert(typeof submittedJob?.responsePath === "string", "oracle submit should include responsePath in structured details");
    assert(Array.isArray(submittedJob?.autoPrunedArchivePaths), "oracle submit should include autoPrunedArchivePaths in structured details");
    assert(submitQueue?.queued === true, "oracle submit queued details should expose queue.queued=true");
    assert(typeof submitQueue?.position === "number" && typeof submitQueue?.depth === "number", "oracle submit queued details should expose queue position and depth");
    assert(typeof submitLastEvent?.message === "string" && typeof submitLastEvent?.source === "string", "oracle submit should expose a structured lastEvent object");
    queuedId = String(submittedJob.id);

    const readResult = await readTool.execute!("oracle-read-details-test", { jobId: queuedId }, undefined, () => { }, ctx) as { details?: unknown };
    const readJobDetails = asRecord(asRecord(readResult.details)?.job);
    const readQueue = asRecord(readJobDetails?.queue);
    assert(readJobDetails?.id === queuedId, "oracle read should preserve the same job.id in structured details");
    assert(typeof readJobDetails?.artifactsPath === "string", "oracle read should include artifactsPath in structured details");
    assert(readQueue?.queued === true, "oracle read should preserve structured queue metadata");
    assert(typeof readJobDetails?.responseAvailable === "boolean", "oracle read should report responseAvailable in structured details");

    const cancelResult = await cancelTool.execute!("oracle-cancel-details-test", { jobId: queuedId }, undefined, () => { }, ctx) as { details?: unknown };
    const cancelledJobDetails = asRecord(asRecord(cancelResult.details)?.job);
    const cancelQueue = asRecord(cancelledJobDetails?.queue);
    assert(cancelledJobDetails?.id === queuedId, "oracle cancel should return structured job details for the cancelled job");
    assert(cancelledJobDetails?.status === "cancelled", "oracle cancel should expose the cancelled job status in structured details");
    assert(cancelQueue?.queued === false, "oracle cancel should update queue.queued once the job is cancelled");
  } finally {
    if (blockingId) {
      const blockingJob = readJob(blockingId);
      await releaseRuntimeLease(blockingJob?.runtimeId);
      await cleanupJob(blockingId);
    }
    if (queuedId) await cleanupJob(queuedId);
    if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
    await rm(fixtureDir, { recursive: true, force: true });
  }
}

async function testOracleReadAndStatusSummariesKeepTerminalFailuresProminent(config: OracleConfig): Promise<void> {
  await resetOracleStateDir();
  const fakeWorkerPath = join(tmpdir(), `oracle-sanity-terminal-summary-worker-${randomUUID()}.mjs`);
  await writeFile(fakeWorkerPath, "process.exit(0);\n", { encoding: "utf8", mode: 0o600 });

  const pi = createPiHarness();
  registerOracleTools(pi as unknown as import("@mariozechner/pi-coding-agent").ExtensionAPI, fakeWorkerPath);
  registerOracleCommands(pi as unknown as import("@mariozechner/pi-coding-agent").ExtensionAPI, fakeWorkerPath, fakeWorkerPath);
  const readTool = pi.tools.get("oracle_read");
  const statusCommand = pi.commands.get("oracle-status");
  assert(readTool?.execute, "oracle read tool should register for terminal summary testing");
  assert(statusCommand, "oracle status command should register for terminal summary testing");

  const cwd = process.cwd();
  const sessionFile = `/tmp/oracle-sanity-session-terminal-summary-${randomUUID()}.jsonl`;
  const readCtx = createExtensionCtx({ getSessionFile: () => sessionFile } as import("@mariozechner/pi-coding-agent").ExtensionContext["sessionManager"], createUiStub());
  const statusUi = createUiStub();
  const statusCtx = createCommandCtx({ getSessionFile: () => sessionFile } as import("@mariozechner/pi-coding-agent").ExtensionCommandContext["sessionManager"], statusUi);
  const jobId = await createJobForTest(config, cwd, sessionFile);

  try {
    const failedAt = "2026-01-01T00:00:20.000Z";
    const wakeupRequestedAt = "2026-01-01T00:00:25.000Z";
    await updateJob(jobId, (job) => noteOracleJobWakeupRequested(transitionOracleJobPhase(job, "failed", {
      at: failedAt,
      source: "oracle:worker",
      message: "Job failed: missing auth seed profile.",
      patch: { error: "missing auth seed profile" },
    }), {
      at: wakeupRequestedAt,
      source: "oracle:poller",
    }));

    const readResult = await readTool.execute!("oracle-read-terminal-summary-test", { jobId }, undefined, () => { }, readCtx) as { content?: Array<{ text?: string }>; details?: unknown };
    const readText = readResult.content?.[0]?.text;
    const readJobDetails = asRecord(asRecord(readResult.details)?.job);
    assert(typeof readText === "string", "oracle read should return textual terminal summaries");
    assert(readText.includes("terminal-event: 2026-01-01T00:00:20.000Z [oracle:worker] Job failed: missing auth seed profile."), "oracle read should keep the worker terminal failure event prominent after wake-up settlement bookkeeping");
    assert(readText.includes("wakeup-event:") && !readText.includes(`response: ${String(readJob(jobId)?.responsePath)}`), "oracle read should separate wake-up bookkeeping and hide unavailable response paths from failed-job summaries");
    assert(readJobDetails?.responseAvailable === false, "oracle read structured details should report responseAvailable=false when the response file is absent");
    const terminalEvent = asRecord(readJobDetails?.terminalEvent);
    assert(terminalEvent?.source === "oracle:worker", "oracle read structured details should expose the terminal worker event separately from the latest wake-up event");

    await statusCommand.handler(jobId, statusCtx);
    const statusMessage = statusUi.notifications.at(-1)?.message;
    assert(typeof statusMessage === "string", "oracle status should emit a textual terminal summary");
    assert(statusMessage.includes("terminal-event: 2026-01-01T00:00:20.000Z [oracle:worker] Job failed: missing auth seed profile."), "oracle status should keep the terminal worker failure event prominent after manual wake-up settlement");
    assert(statusMessage.includes("wakeup-event:") && !statusMessage.includes(`response: ${String(readJob(jobId)?.responsePath)}`), "oracle status should separate wake-up bookkeeping and hide unavailable response paths from failed-job summaries");
  } finally {
    await rm(fakeWorkerPath, { force: true });
    await cleanupJob(jobId);
  }
}

async function testOracleToolErrorsExposeStructuredMetadata(): Promise<void> {
  await resetOracleStateDir();
  const fixtureDir = await mkdtemp(join(tmpdir(), `oracle-sanity-tool-errors-${randomUUID()}-`));
  const agentDir = join(fixtureDir, "agent");
  const agentExtensionsDir = join(agentDir, "extensions");
  const fakeWorkerPath = join(fixtureDir, "fake-worker.mjs");
  const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
  await mkdir(agentExtensionsDir, { recursive: true, mode: 0o700 });
  await writeFile(fakeWorkerPath, "process.exit(0);\n", { encoding: "utf8", mode: 0o600 });

  const pi = createPiHarness();
  registerOracleTools(pi as unknown as import("@mariozechner/pi-coding-agent").ExtensionAPI, fakeWorkerPath);
  const submitTool = pi.tools.get("oracle_submit");
  const readTool = pi.tools.get("oracle_read");
  const toolResultHandler = pi.handlers.get("tool_result");
  assert(submitTool?.execute, "oracle submit tool should register for structured-error testing");
  assert(readTool?.execute, "oracle read tool should register for structured-error testing");
  assert(toolResultHandler, "oracle tools should register a tool_result hook to preserve isError for structured errors");

  const sessionFile = `/tmp/oracle-sanity-session-tool-errors-${randomUUID()}.jsonl`;
  const ctx = createExtensionCtx({ getSessionFile: () => sessionFile } as import("@mariozechner/pi-coding-agent").ExtensionContext["sessionManager"], createUiStub());

  try {
    process.env.PI_CODING_AGENT_DIR = agentDir;

    const invalidPresetResult = await (submitTool.execute!(
      "oracle-submit-invalid-preset-test",
      { prompt: "sanity", files: ["README.md"], preset: "not-a-real-preset" },
      undefined,
      () => { },
      ctx,
    )) as { details?: unknown; content?: unknown };
    const invalidPresetError = asRecord(asRecord(invalidPresetResult.details)?.error);
    const invalidPresetText = (invalidPresetResult.content as Array<{ text?: string }> | undefined)?.[0]?.text;
    assert(invalidPresetError?.code === "invalid_preset", "oracle submit should return a structured invalid_preset error code");
    assert(typeof invalidPresetText === "string" && invalidPresetText.includes("Suggested next step:"), "oracle tool errors should surface the structured retry hint in visible tool text as well as details.error metadata");
    assert(invalidPresetError?.rejectedValue === "not-a-real-preset", "oracle submit should report the rejected preset value");
    const allowedValues = invalidPresetError?.allowedValues;
    assert(Array.isArray(allowedValues) && allowedValues.includes("instant") && allowedValues.includes("thinking_standard"), "oracle submit should report canonical preset ids as allowedValues");
    assert(typeof invalidPresetError?.suggestedNextStep === "string", "oracle submit should include a retry hint for invalid preset errors");
    const invalidPresetPatch = await toolResultHandler({
      toolName: "oracle_submit",
      toolCallId: "oracle-submit-invalid-preset-test",
      input: { prompt: "sanity", files: ["README.md"], preset: "not-a-real-preset" },
      content: invalidPresetResult.content,
      details: invalidPresetResult.details,
      isError: false,
    }, ctx);
    assert(asRecord(invalidPresetPatch)?.isError === true, "oracle tool_result hook should preserve isError for structured oracle tool errors");

    const blankArchiveResult = await (submitTool.execute!(
      "oracle-submit-blank-archive-test",
      { prompt: "sanity", files: ["   "] },
      undefined,
      () => { },
      ctx,
    )) as { details?: unknown };
    const blankArchiveError = asRecord(asRecord(blankArchiveResult.details)?.error);
    assert(blankArchiveError?.code === "archive_input_blank", "oracle submit should return a structured archive_input_blank error code when execute-time callers bypass schema validation with whitespace-only paths");

    const paddedWholeRepoResult = await (submitTool.execute!(
      "oracle-submit-padded-whole-repo-test",
      { prompt: "sanity", files: [" . "] },
      undefined,
      () => { },
      ctx,
    )) as { details?: unknown };
    const paddedWholeRepoError = asRecord(asRecord(paddedWholeRepoResult.details)?.error);
    assert(paddedWholeRepoError?.code === "archive_input_whole_repo_sentinel_invalid", "oracle submit should require '.' exactly when callers request a whole-repo archive");

    const missingJobResult = await readTool.execute!("oracle-read-missing-job-test", { jobId: "missing-job" }, undefined, () => { }, ctx) as { details?: unknown };
    const missingJobError = asRecord(asRecord(missingJobResult.details)?.error);
    assert(missingJobError?.code === "job_not_found", "oracle read should return a structured job_not_found error code");
    assert(missingJobError?.rejectedValue === "missing-job", "oracle read should report the rejected job id");
  } finally {
    if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
    await rm(fixtureDir, { recursive: true, force: true });
  }
}

async function testCleanupPendingRecoveryTerminatesStaleLiveWorker(config: OracleConfig): Promise<void> {
  await resetOracleStateDir();
  const cwd = process.cwd();
  const sessionId = "/tmp/oracle-sanity-session-cleanup-pending-live-worker.jsonl";
  const jobId = await createTerminalJob(config, cwd, sessionId);
  const job = readJob(jobId);
  assert(job, "cleanup-pending live-worker recovery job should exist");
  const conversationId = `conversation-${randomUUID()}`;

  const holder = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000);"], {
    detached: true,
    stdio: "ignore",
  });
  holder.unref();
  const holderPid = holder.pid;
  assert(holderPid !== undefined, "cleanup-pending live-worker recovery should expose a worker pid");
  const holderStartedAt = await waitForProcessStartedAtValue(holderPid);
  const staleAt = new Date(Date.now() - 5 * 60 * 1000).toISOString();

  try {
    await updateJob(job.id, (current) => ({
      ...current,
      cleanupPending: true,
      cleanupWarnings: ["stale warning"],
      conversationId,
      workerPid: holderPid,
      workerStartedAt: holderStartedAt,
      heartbeatAt: staleAt,
      completedAt: staleAt,
      phaseAt: staleAt,
      lastCleanupAt: staleAt,
    }));
    const pendingJob = readJob(jobId);
    assert(pendingJob, "cleanup-pending live-worker recovery job should be readable");
    await mkdir(pendingJob.runtimeProfileDir, { recursive: true, mode: 0o700 });
    await acquireRuntimeLease(config, {
      jobId: pendingJob.id,
      runtimeId: pendingJob.runtimeId,
      runtimeSessionName: pendingJob.runtimeSessionName,
      runtimeProfileDir: pendingJob.runtimeProfileDir,
      projectId: pendingJob.projectId,
      sessionId: pendingJob.sessionId,
      createdAt: new Date().toISOString(),
    });
    await acquireConversationLease({
      jobId: pendingJob.id,
      conversationId,
      projectId: pendingJob.projectId,
      sessionId: pendingJob.sessionId,
      createdAt: new Date().toISOString(),
    });

    const repaired = await reconcileStaleOracleJobs();
    assert(repaired.some((entry) => entry.id === jobId), "reconcile should repair terminal jobs whose cleanup worker is still alive but stale");
    assert(await waitForPidExit(holderPid), "cleanup-pending stale live-worker recovery should terminate the stuck cleanup worker");
    const recoveredJob = readJob(jobId);
    assert(recoveredJob?.cleanupPending === false, "cleanup-pending stale live-worker recovery should clear cleanupPending after successful teardown");
    assert(!recoveredJob?.cleanupWarnings?.length, "cleanup-pending stale live-worker recovery should clear resolved cleanup warnings");
    assert(!listLeaseMetadata<{ jobId: string }>("runtime").some((lease) => lease.jobId === jobId), "cleanup-pending stale live-worker recovery should release runtime lease after successful teardown");
    assert(!listLeaseMetadata<{ jobId: string }>("conversation").some((lease) => lease.jobId === jobId), "cleanup-pending stale live-worker recovery should release conversation lease after successful teardown");
  } finally {
    if (isPidAlive(holderPid)) process.kill(holderPid, "SIGKILL");
    await waitForPidExit(holderPid);
    await cleanupJob(jobId);
  }
}

async function testOracleCleanRefusesTerminalJobsWithinWakeupRetentionGrace(config: OracleConfig): Promise<void> {
  await resetOracleStateDir();
  const cwd = process.cwd();
  const fakeWorkerPath = join(tmpdir(), `oracle-sanity-clean-grace-worker-${randomUUID()}.mjs`);
  await writeFile(fakeWorkerPath, "process.exit(0);\n", { mode: 0o600 });

  const pi = createPiHarness();
  registerOracleCommands(pi as unknown as import("@mariozechner/pi-coding-agent").ExtensionAPI, fakeWorkerPath, fakeWorkerPath);

  const cleanCommand = pi.commands.get("oracle-clean");
  assert(cleanCommand, "oracle clean command should register for retention-grace testing");

  const sessionFile = "/tmp/oracle-sanity-session-clean-retention-grace.jsonl";
  const jobId = await createTerminalJob(config, cwd, sessionFile);
  const job = readJob(jobId);
  assert(job, "oracle clean retention-grace job should exist");
  const wakeupRequestedAt = new Date(Date.now() - 30_000).toISOString();
  const retryAfter = new Date(Date.parse(wakeupRequestedAt) + ORACLE_WAKEUP_POST_SEND_RETENTION_MS).toISOString();
  await updateJob(job.id, (current) => ({
    ...current,
    wakeupAttemptCount: 1,
    wakeupLastRequestedAt: wakeupRequestedAt,
  }));

  const ui = createUiStub();
  const ctx = createCommandCtx({ getSessionFile: () => sessionFile } as import("@mariozechner/pi-coding-agent").ExtensionCommandContext["sessionManager"], ui);

  try {
    await cleanCommand.handler(jobId, ctx);
    assert(Boolean(readJob(jobId)), "oracle clean should not delete a terminal job during the post-send retention grace window");
    const notice = ui.notifications.at(-1)?.message || "";
    assert(notice.includes("post-send retention grace window"), "oracle clean should explain the hidden retention-grace cleanup blocker");
    assert(notice.includes("Retry after") && notice.includes(retryAfter), "oracle clean should surface the next eligible cleanup time when retention grace blocks removal");
    assert(notice.includes("cleanup blockers or warnings"), "oracle clean summary should describe retained jobs as blockers/warnings instead of only cleanup warnings");
  } finally {
    await cleanupJob(jobId);
    await rm(fakeWorkerPath, { force: true });
  }
}

async function testOracleCleanRefusesTerminalJobsWithLiveWorkers(config: OracleConfig): Promise<void> {
  await resetOracleStateDir();
  const cwd = process.cwd();
  const fakeWorkerPath = join(tmpdir(), `oracle-sanity-clean-worker-${randomUUID()}.mjs`);
  await writeFile(fakeWorkerPath, "process.exit(0);\n", { mode: 0o600 });

  const pi = createPiHarness();
  registerOracleCommands(pi as unknown as import("@mariozechner/pi-coding-agent").ExtensionAPI, fakeWorkerPath, fakeWorkerPath);

  const cleanCommand = pi.commands.get("oracle-clean");
  assert(cleanCommand, "oracle clean command should register");

  const sessionFile = "/tmp/oracle-sanity-session-clean-live-worker.jsonl";
  const jobId = await createTerminalJob(config, cwd, sessionFile);
  const job = readJob(jobId);
  assert(job, "oracle clean live-worker job should exist");
  const conversationId = `conversation-${randomUUID()}`;

  const holder = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000);"], {
    detached: true,
    stdio: "ignore",
  });
  holder.unref();
  const holderPid = holder.pid;
  assert(holderPid !== undefined, "oracle clean live-worker test should expose a worker pid");
  const holderStartedAt = await waitForProcessStartedAtValue(holderPid);

  await mkdir(job.runtimeProfileDir, { recursive: true, mode: 0o700 });
  await acquireRuntimeLease(config, {
    jobId: job.id,
    runtimeId: job.runtimeId,
    runtimeSessionName: job.runtimeSessionName,
    runtimeProfileDir: job.runtimeProfileDir,
    projectId: job.projectId,
    sessionId: job.sessionId,
    createdAt: new Date().toISOString(),
  });
  await acquireConversationLease({
    jobId: job.id,
    conversationId,
    projectId: job.projectId,
    sessionId: job.sessionId,
    createdAt: new Date().toISOString(),
  });
  await updateJob(job.id, (current) => ({
    ...current,
    cleanupPending: true,
    conversationId,
    workerPid: holderPid,
    workerStartedAt: holderStartedAt,
    heartbeatAt: new Date().toISOString(),
  }));

  const ui = createUiStub();
  const ctx = createCommandCtx({ getSessionFile: () => sessionFile } as import("@mariozechner/pi-coding-agent").ExtensionCommandContext["sessionManager"], ui);

  try {
    await cleanCommand.handler(jobId, ctx);
    assert(Boolean(readJob(jobId)), "oracle clean should not delete a terminal job while its worker is still live");
    assert(listLeaseMetadata<{ jobId: string }>("runtime").some((lease) => lease.jobId === jobId), "oracle clean should retain runtime leases while a live terminal worker still owns cleanup");
    assert(listLeaseMetadata<{ jobId: string }>("conversation").some((lease) => lease.jobId === jobId), "oracle clean should retain conversation leases while a live terminal worker still owns cleanup");
    assert(ui.notifications.some((entry) => entry.message.includes("still live")), "oracle clean should surface the live-worker refusal to the user");
  } finally {
    if (isPidAlive(holderPid)) process.kill(holderPid, "SIGKILL");
    await waitForPidExit(holderPid);
    await releaseRuntimeLease(job.runtimeId);
    await releaseConversationLease(conversationId);
    await cleanupJob(jobId);
    await rm(fakeWorkerPath, { force: true });
  }
}

async function testStaleReconcileDoesNotOverwriteConcurrentCompletion(config: OracleConfig): Promise<void> {
  await resetOracleStateDir();
  const cwd = process.cwd();
  const sessionId = "/tmp/oracle-sanity-session-stale-race.jsonl";
  const jobId = await createJobForTest(config, cwd, sessionId);
  const worker = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => setTimeout(() => process.exit(0), 250)); setInterval(() => {}, 1000);"]);
  const workerPid = worker.pid;
  assert(workerPid !== undefined, "stale-race worker should expose a pid");
  const workerStartedAt = await waitForProcessStartedAtValue(workerPid);
  const staleAt = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  await updateJob(jobId, (job) => ({
    ...job,
    workerPid,
    workerStartedAt,
    heartbeatAt: staleAt,
    submittedAt: staleAt,
  }));

  const lockHandle = await acquireLock("job", jobId, { processPid: process.pid, source: "oracle-sanity-stale-race" });
  try {
    const reconcilePromise = reconcileStaleOracleJobs();
    await sleep(50);
    const current = readJob(jobId);
    assert(current, "stale-race job should still exist while reconcile waits on the job lock");
    const completedAt = new Date().toISOString();
    await writeFile(join(getJobDir(jobId), "job.json"), `${JSON.stringify({
      ...current,
      status: "complete",
      phase: "complete",
      phaseAt: completedAt,
      completedAt,
      responsePath: join(getJobDir(jobId), "response.md"),
      responseFormat: "text/plain",
    }, null, 2)}\n`, { mode: 0o600 });
    await releaseLock(lockHandle);
    const repaired = await reconcilePromise;
    assert(!repaired.some((job) => job.id === jobId), "stale reconcile should skip jobs that completed during recovery");
    const finalJob = readJob(jobId);
    assert(finalJob?.status === "complete", "stale reconcile must not overwrite a concurrently completed job");
  } finally {
    await releaseLock(lockHandle).catch(() => undefined);
    if (isPidAlive(workerPid)) process.kill(workerPid, "SIGKILL");
    await waitForPidExit(workerPid);
    await cleanupJob(jobId);
  }
}

async function testActiveCancellationDoesNotOverwriteCompletion(config: OracleConfig): Promise<void> {
  await resetOracleStateDir();
  const cwd = process.cwd();
  const sessionId = "/tmp/oracle-sanity-session-active-cancel.jsonl";
  const activeId = await createJobForTest(config, cwd, sessionId);
  const worker = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => setTimeout(() => process.exit(0), 200)); setInterval(() => {}, 1000);"]);
  const workerPid = worker.pid;
  assert(workerPid !== undefined, "active-cancel worker should expose a pid");
  const workerStartedAt = await new Promise<string | undefined>((resolve) => setTimeout(() => resolve(undefined), 50));
  await updateJob(activeId, (job) => ({ ...job, workerPid, workerStartedAt }));

  const cancelPromise = cancelOracleJob(activeId);
  await sleep(50);
  await completeJob(activeId);
  const cancelled = await cancelPromise;
  assert(cancelled.status === "complete", "active cancellation should not overwrite a job that completed first");
  const finalJob = readJob(activeId);
  assert(finalJob?.status === "complete", "completed jobs should remain complete when cancellation loses the race");
  await cleanupJob(activeId);
}

async function testQueueAdmissionPromotionAndCancellation(config: OracleConfig): Promise<void> {
  await resetOracleStateDir();
  const cwd = process.cwd();
  const sessionId = "/tmp/oracle-sanity-session-queue.jsonl";

  const holderId = await createJobForTest(config, cwd, sessionId);
  const holder = readJob(holderId);
  assert(holder, "queue holder job should exist");
  await acquireRuntimeLease(config, {
    jobId: holder.id,
    runtimeId: holder.runtimeId,
    runtimeSessionName: holder.runtimeSessionName,
    runtimeProfileDir: holder.runtimeProfileDir,
    projectId: holder.projectId,
    sessionId: holder.sessionId,
    createdAt: new Date().toISOString(),
  });

  const queuedId = await createJobForTest(config, cwd, sessionId, { initialState: "queued" });
  const queued = readJob(queuedId);
  assert(queued?.status === "queued", "queued jobs should persist queued status");
  assert(queued?.phase === "queued", "queued jobs should persist queued phase");
  assert(Boolean(queued?.queuedAt), "queued jobs should persist queuedAt");
  assert(queued?.submittedAt === undefined, "queued jobs should not persist submittedAt before promotion");
  const queuePosition = getQueuePosition(queuedId);
  assert(queuePosition?.position === 1 && queuePosition.depth === 1, "queued job should report queue position");
  assert(!listLeaseMetadata<{ jobId: string }>("runtime").some((lease) => lease.jobId === queuedId), "queued jobs should not consume runtime leases before promotion");

  const removeQueued = await removeTerminalOracleJob(queued);
  assert(!removeQueued.removed, "queued jobs must not be removable by terminal cleanup");

  const cancelledQueuedId = await createJobForTest(config, cwd, sessionId, { initialState: "queued" });
  const cancelledQueued = readJob(cancelledQueuedId);
  assert(cancelledQueued, "cancelled queued job should exist before cancellation");
  const cancelled = await cancelOracleJob(cancelledQueuedId);
  assert(cancelled.status === "cancelled", "queued jobs should cancel without a worker");
  assert(!cancelled.cleanupWarnings?.length, "queued cancellation should not emit cleanup warnings");
  let cancelledArchiveExists = true;
  await stat(cancelledQueued.archivePath).catch(() => {
    cancelledArchiveExists = false;
  });
  assert(!cancelledArchiveExists, "queued cancellation should remove the persisted archive to avoid quota bypass");
  const removeCancelled = await removeTerminalOracleJob(readJob(cancelledQueuedId)!);
  assert(removeCancelled.removed, "cancelled queued jobs should become removable");

  await releaseRuntimeLease(holder.runtimeId);
  await completeJob(holderId);
  await cleanupJob(holderId);

  const promoted = await promoteQueuedJobsWithinAdmissionLock({
    workerPath: "/tmp/fake-oracle-worker.mjs",
    source: "oracle-sanity-promote",
    spawnWorkerFn: async () => ({ pid: 4242, nonce: "sanity-promoted", startedAt: "sanity-started" }),
  });
  assert(promoted.promotedJobIds.includes(queuedId), "queued jobs should promote once runtime capacity is available");
  const promotedJob = readJob(queuedId);
  assert(promotedJob?.status === "submitted", "promoted queued jobs should become submitted");
  assert(Boolean(promotedJob?.submittedAt), "promoted queued jobs should record submittedAt");
  assert(promotedJob?.workerNonce === "sanity-promoted", "promotion should persist worker metadata");
  assert(listLeaseMetadata<{ jobId: string }>("runtime").some((lease) => lease.jobId === queuedId), "promoted queued jobs should acquire runtime leases");

  await releaseRuntimeLease(promotedJob?.runtimeId);
  await completeJob(queuedId);
  await cleanupJob(queuedId);
}

async function testQueuedPromotionUsesPersistedConfigSnapshot(config: OracleConfig): Promise<void> {
  await resetOracleStateDir();
  const cwd = process.cwd();
  const sessionId = "/tmp/oracle-sanity-session-queue-config.jsonl";
  const queuedId = await createJobForTest(config, cwd, sessionId, { initialState: "queued" });

  let loadConfigCalls = 0;
  const promoted = await promoteQueuedJobsWithinAdmissionLock({
    workerPath: "/tmp/fake-oracle-worker.mjs",
    source: "oracle-sanity-config-snapshot",
    spawnWorkerFn: async () => ({ pid: 7777, nonce: "config-snapshot", startedAt: "config-started" }),
    loadConfigFn: () => {
      loadConfigCalls += 1;
      return {
        ...config,
        browser: {
          ...config.browser,
          maxConcurrentJobs: config.browser.maxConcurrentJobs + 1,
          executablePath: "/tmp/changed-browser",
        },
      };
    },
  });

  assert(promoted.promotedJobIds.includes(queuedId), "queued jobs should still promote using their persisted config snapshot");
  assert(loadConfigCalls === 0, "queued promotion should not reload config from disk when the job already has a persisted snapshot");
  const promotedJob = readJob(queuedId);
  assert(promotedJob?.config.browser.maxConcurrentJobs === config.browser.maxConcurrentJobs, "queued promotion should preserve the submitted config snapshot");
  assert(promotedJob?.config.browser.executablePath === config.browser.executablePath, "queued promotion should not overwrite persisted browser settings");

  await releaseRuntimeLease(promotedJob?.runtimeId);
  await completeJob(queuedId);
  await cleanupJob(queuedId);
}

async function testQueuedPromotionRequiresArchiveReadiness(config: OracleConfig): Promise<void> {
  await resetOracleStateDir();
  const cwd = process.cwd();
  const sessionId = "/tmp/oracle-sanity-session-queue-archive.jsonl";
  const queuedId = await createJobForTest(config, cwd, sessionId, { initialState: "queued" });
  const queued = readJob(queuedId);
  assert(queued, "archive-readiness queued job should exist");
  await rm(queued.archivePath, { force: true });

  const promoted = await promoteQueuedJobsWithinAdmissionLock({
    workerPath: "/tmp/fake-oracle-worker.mjs",
    source: "oracle-sanity-archive-ready",
    spawnWorkerFn: async () => ({ pid: 0, nonce: "unused", startedAt: undefined }),
  });
  assert(!promoted.promotedJobIds.includes(queuedId), "queued jobs without a materialized archive must not promote");
  const failedJob = readJob(queuedId);
  assert(failedJob?.status === "failed", "queued jobs missing their archive should fail instead of silently promoting");
  assert(!listLeaseMetadata<{ jobId: string }>("runtime").some((lease) => lease.jobId === queuedId), "archive-missing queued jobs should not retain runtime leases");
  await cleanupJob(queuedId);
}

async function testQueuedCancellationSerializesWithPromotion(config: OracleConfig): Promise<void> {
  await resetOracleStateDir();
  const cwd = process.cwd();
  const sessionId = "/tmp/oracle-sanity-session-queue-race.jsonl";
  const queuedId = await createJobForTest(config, cwd, sessionId, { initialState: "queued" });

  let releaseSpawn: (() => void) | undefined;
  const spawnGate = new Promise<void>((resolve) => {
    releaseSpawn = resolve;
  });

  const promotionPromise = promoteQueuedJobs({
    workerPath: "/tmp/fake-oracle-worker.mjs",
    source: "oracle-sanity-race-promote",
    spawnWorkerFn: async () => {
      await spawnGate;
      return { pid: 55_555, nonce: "race", startedAt: undefined };
    },
  });
  await sleep(50);
  const cancelPromise = cancelOracleJob(queuedId);
  await sleep(50);
  releaseSpawn?.();

  const [promotionResult, cancelled] = await Promise.all([promotionPromise, cancelPromise]);
  assert(promotionResult.promotedJobIds.includes(queuedId), "race test should promote the queued job before cancellation acquires the admission lock");
  assert(cancelled.status === "cancelled", "cancel should still win once promotion and worker metadata persistence finish");
  const finalJob = readJob(queuedId);
  assert(finalJob?.status === "cancelled", "promotion/cancel race should end in cancelled state, not submitted");
  assert(!listLeaseMetadata<{ jobId: string }>("runtime").some((lease) => lease.jobId === queuedId), "cancel after queued promotion should release runtime leases");
  await cleanupJob(queuedId);
}

async function testCancelCleanupWarningsDoNotPromoteQueuedJobs(config: OracleConfig): Promise<void> {
  await resetOracleStateDir();
  const cwd = process.cwd();
  const fakeWorkerPath = join(tmpdir(), `oracle-sanity-cancel-cleanup-worker-${randomUUID()}.mjs`);
  await writeFile(fakeWorkerPath, "process.exit(0);\n", { mode: 0o600 });

  const pi = createPiHarness();
  registerOracleTools(pi as unknown as import("@mariozechner/pi-coding-agent").ExtensionAPI, fakeWorkerPath);
  registerOracleCommands(pi as unknown as import("@mariozechner/pi-coding-agent").ExtensionAPI, fakeWorkerPath, fakeWorkerPath);

  const cancelTool = pi.tools.get("oracle_cancel");
  const cancelCommand = pi.commands.get("oracle-cancel");
  assert(cancelTool, "oracle cancel tool should register");
  assert(cancelCommand, "oracle cancel command should register");

  const runCase = async (kind: "tool" | "command") => {
    const sessionFile = `/tmp/oracle-sanity-session-cancel-cleanup-warning-${kind}.jsonl`;
    const cancellingId = await createJobForTest(config, cwd, sessionFile, { initialState: "queued" });
    const cancellingJob = readJob(cancellingId);
    assert(cancellingJob, "queued cancellation warning job should exist");
    await rm(cancellingJob.archivePath, { force: true });
    await mkdir(cancellingJob.archivePath, { recursive: true, mode: 0o700 });

    const waitingId = await createJobForTest(config, cwd, sessionFile, { initialState: "queued" });
    const ui = createUiStub();
    const ctx = createCommandCtx({ getSessionFile: () => sessionFile } as import("@mariozechner/pi-coding-agent").ExtensionCommandContext["sessionManager"], ui);
    (ctx as { hasUI: boolean }).hasUI = false;

    try {
      if (kind === "tool") {
        await cancelTool.execute!("oracle-cancel-cleanup-test", { jobId: cancellingId }, undefined, () => { }, ctx);
      } else {
        await cancelCommand.handler(cancellingId, ctx);
      }

      const cancelled = readJob(cancellingId);
      assert(cancelled?.status === "cancelled", `${kind} queued cancellation should still mark the target cancelled`);
      assert(Boolean(cancelled?.cleanupWarnings?.length), `${kind} queued cancellation should surface cleanup warnings when archive cleanup fails`);
      assert(readJob(waitingId)?.status === "queued", `${kind} cancellation should not promote queued jobs when cleanup leaves warnings`);
      assert(!listLeaseMetadata<{ jobId: string }>("runtime").some((lease) => lease.jobId === waitingId), `${kind} cancellation cleanup warnings should keep queued runtime admission blocked`);
    } finally {
      const waitingJob = readJob(waitingId);
      if (waitingJob) {
        if (waitingJob.status === "queued") {
          await cancelOracleJob(waitingId);
        }
        await releaseRuntimeLease(waitingJob.runtimeId);
      }
      await cleanupJob(waitingId);
      await cleanupJob(cancellingId);
    }
  };

  try {
    await runCase("tool");
    await runCase("command");
  } finally {
    await rm(fakeWorkerPath, { force: true });
  }
}

async function testQueuedCleanupWarningsRetryArchiveDeletion(config: OracleConfig): Promise<void> {
  await resetOracleStateDir();
  const cwd = process.cwd();
  const sessionId = "/tmp/oracle-sanity-session-queued-cleanup-retry.jsonl";
  const queuedId = await createJobForTest(config, cwd, sessionId, { initialState: "queued" });
  const queued = readJob(queuedId);
  assert(queued, "queued cleanup retry job should exist");
  await rm(queued.archivePath, { force: true });
  await mkdir(queued.archivePath, { recursive: true, mode: 0o700 });

  try {
    const cancelled = await cancelOracleJob(queuedId);
    assert(Boolean(cancelled.cleanupWarnings?.length), "queued cleanup retry should start with cleanup warnings after the initial archive delete failure");

    const firstRepair = await reconcileStaleOracleJobs();
    assert(firstRepair.some((entry) => entry.id === queuedId), "reconcile should revisit queued cleanup warnings and retry archive deletion");
    const stillBlocked = readJob(queuedId);
    assert(Boolean(stillBlocked?.cleanupWarnings?.length), "reconcile should retain queued cleanup warnings while archive deletion still fails");

    await rm(queued.archivePath, { recursive: true, force: true });
    const secondRepair = await reconcileStaleOracleJobs();
    assert(secondRepair.some((entry) => entry.id === queuedId), "queued cleanup retry should report the follow-up repair after the stranded archive is removed");
    const recovered = readJob(queuedId);
    assert(recovered?.cleanupWarnings === undefined, "queued cleanup retry should only clear cleanup warnings once archive deletion succeeds or the archive is already gone");
    assert(recovered?.cleanupPending !== true, "queued cleanup retry should not leave queued cancellations stuck in cleanupPending once archive cleanup succeeds");
  } finally {
    await cleanupJob(queuedId);
  }
}

async function testQueuedArchivePressureCountsRetainedCancelledPreSubmitArchives(config: OracleConfig): Promise<void> {
  await resetOracleStateDir();
  const cwd = process.cwd();
  const sessionId = "/tmp/oracle-sanity-session-queued-archive-pressure.jsonl";
  const queuedId = await createJobForTest(config, cwd, sessionId, { initialState: "queued" });
  const strandedId = await createJobForTest(config, cwd, sessionId, { initialState: "queued" });
  const queued = readJob(queuedId);
  const stranded = readJob(strandedId);
  assert(queued && stranded, "queued archive pressure test jobs should exist");

  try {
    await writeFile(queued.archivePath, Buffer.alloc(2048, 7), { mode: 0o600 });
    await writeFile(stranded.archivePath, Buffer.alloc(3072, 9), { mode: 0o600 });
    const cancelledAt = new Date().toISOString();
    await updateJob(strandedId, (job) => ({
      ...job,
      ...withJobPhase("cancelled", {
        status: "cancelled",
        completedAt: cancelledAt,
        heartbeatAt: cancelledAt,
        cleanupWarnings: [`Failed to remove queued archive ${stranded.archivePath}: simulated failure`],
        error: "simulated queued archive cleanup failure",
      }, cancelledAt),
    }));

    const pressure = await getQueuedArchivePressure();
    const expectedQueuedBytes = (await stat(queued.archivePath)).size + (await stat(stranded.archivePath)).size;
    assert(pressure.queuedJobs === 1, "queued archive pressure should keep queued-job counts tied to actual queued jobs only");
    assert(pressure.queuedArchiveBytes === expectedQueuedBytes, "queued archive pressure should include stranded cancelled pre-submit archives in byte accounting");

    const queuedArchiveFailure = getQueueAdmissionFailure({
      queuePressure: pressure,
      archiveBytes: 1,
      activeJobs: 1,
      maxActiveJobs: 1,
      maxQueuedJobs: 5,
      maxQueuedArchiveBytes: pressure.queuedArchiveBytes,
    });
    assert(Boolean(queuedArchiveFailure?.includes("retained pre-submit archives")), "queued archive admission failures should explain that retained pre-submit archives count against the byte cap");

    await rm(stranded.archivePath, { force: true });
    await reconcileStaleOracleJobs();
    const pressureAfterCleanup = await getQueuedArchivePressure();
    assert(pressureAfterCleanup.queuedArchiveBytes === (await stat(queued.archivePath)).size, "queued archive pressure should drop after stranded pre-submit archive cleanup succeeds");
  } finally {
    await cancelOracleJob(queuedId).catch(() => undefined);
    await cleanupJob(queuedId);
    await cleanupJob(strandedId);
  }
}

async function testCancelFailureDoesNotPromoteQueuedJobs(config: OracleConfig): Promise<void> {
  await resetOracleStateDir();
  const cwd = process.cwd();
  const fakeWorkerPath = join(tmpdir(), `oracle-sanity-cancel-worker-${randomUUID()}.mjs`);
  await writeFile(fakeWorkerPath, "process.exit(0);\n", { mode: 0o600 });

  const pi = createPiHarness();
  registerOracleTools(pi as unknown as import("@mariozechner/pi-coding-agent").ExtensionAPI, fakeWorkerPath);
  registerOracleCommands(pi as unknown as import("@mariozechner/pi-coding-agent").ExtensionAPI, fakeWorkerPath, fakeWorkerPath);

  const cancelTool = pi.tools.get("oracle_cancel");
  const cancelCommand = pi.commands.get("oracle-cancel");
  assert(cancelTool, "oracle cancel tool should register");
  assert(cancelCommand, "oracle cancel command should register");

  const runCase = async (kind: "tool" | "command") => {
    const sessionFile = `/tmp/oracle-sanity-session-cancel-no-promote-${kind}.jsonl`;
    const activeId = await createJobForTest(config, cwd, sessionFile);
    const activeJob = readJob(activeId);
    assert(activeJob, "active cancellation test job should exist");
    await acquireRuntimeLease(config, {
      jobId: activeJob.id,
      runtimeId: activeJob.runtimeId,
      runtimeSessionName: activeJob.runtimeSessionName,
      runtimeProfileDir: activeJob.runtimeProfileDir,
      projectId: activeJob.projectId,
      sessionId: activeJob.sessionId,
      createdAt: new Date().toISOString(),
    });

    const stuckWorker = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000);"], {
      detached: true,
      stdio: "ignore",
    });
    stuckWorker.unref();
    const stuckWorkerPid = stuckWorker.pid;
    assert(stuckWorkerPid !== undefined, `${kind} cancel-failure test worker should expose a pid`);

    await updateJob(activeId, (job) => ({
      ...job,
      workerPid: stuckWorkerPid,
      workerStartedAt: "mismatched-start-time",
    }));

    const queuedId = await createJobForTest(config, cwd, sessionFile, { initialState: "queued" });
    const ui = createUiStub();
    const ctx = createCommandCtx({ getSessionFile: () => sessionFile } as import("@mariozechner/pi-coding-agent").ExtensionCommandContext["sessionManager"], ui);
    (ctx as { hasUI: boolean }).hasUI = false;

    try {
      if (kind === "tool") {
        await cancelTool.execute!("oracle-cancel-test", { jobId: activeId }, undefined, () => { }, ctx);
      } else {
        await cancelCommand.handler(activeId, ctx);
      }

      const cancelled = readJob(activeId);
      assert(cancelled?.status === "failed", `${kind} cancellation should fail when the worker pid cannot be safely terminated`);
      assert(Boolean(cancelled?.cleanupWarnings?.length), `${kind} cancellation failure should retain cleanup warnings to keep runtime admission blocked`);
      assert(listLeaseMetadata<{ jobId: string }>("runtime").some((lease) => lease.jobId === activeId), `${kind} cancellation failure should retain the runtime lease until cleanup succeeds`);
      assert(readJob(queuedId)?.status === "queued", `${kind} cancellation should not promote queued jobs when the cancelled worker is still alive`);
    } finally {
      if (isPidAlive(stuckWorkerPid)) process.kill(stuckWorkerPid, "SIGKILL");
      await waitForPidExit(stuckWorkerPid);
      await releaseRuntimeLease(activeJob.runtimeId);
      await cleanupJob(activeId);
      const queuedJob = readJob(queuedId);
      if (queuedJob) {
        if (queuedJob.status === "queued") {
          await cancelOracleJob(queuedId);
        }
        await releaseRuntimeLease(queuedJob.runtimeId);
      }
      await cleanupJob(queuedId);
    }
  };

  try {
    await runCase("tool");
    await runCase("command");
  } finally {
    await rm(fakeWorkerPath, { force: true });
  }
}

async function testQueuedPromotionPersistsCleanupWarningsOnTeardownFailure(config: OracleConfig): Promise<void> {
  await resetOracleStateDir();
  const cwd = process.cwd();
  const sessionId = "/tmp/oracle-sanity-session-queue-cleanup-warning.jsonl";
  const queuedId = await createJobForTest(config, cwd, sessionId, { initialState: "queued" });
  await updateJob(queuedId, (job) => ({
    ...job,
    runtimeProfileDir: "/dev/null/pi-oracle-invalid-runtime-profile",
  }));

  const promoted = await promoteQueuedJobsWithinAdmissionLock({
    workerPath: "/tmp/fake-oracle-worker.mjs",
    source: "oracle-sanity-queue-cleanup-warning",
    spawnWorkerFn: async () => {
      throw new Error("simulated promotion failure after admission");
    },
  });

  assert(!promoted.promotedJobIds.includes(queuedId), "teardown-warning promotions should not report success");
  const failedJob = readJob(queuedId);
  assert(failedJob?.status === "failed", "teardown-warning promotions should fail the queued job");
  assert(Boolean(failedJob?.cleanupWarnings?.length), "teardown-warning promotions should persist cleanup warnings when teardown is incomplete");
  assert(!listLeaseMetadata<{ jobId: string }>("runtime").some((lease) => lease.jobId === queuedId), "teardown-warning promotions should release runtime leases even when teardown leaves cleanup warnings");

  await releaseRuntimeLease(failedJob?.runtimeId);
  await cleanupJob(queuedId);
}

async function testQueuedPromotionKillsWorkerWhenMetadataWriteFails(config: OracleConfig): Promise<void> {
  await resetOracleStateDir();
  const cwd = process.cwd();
  const sessionId = "/tmp/oracle-sanity-session-queue-worker-write-fail.jsonl";
  const queuedId = await createJobForTest(config, cwd, sessionId, { initialState: "queued" });
  let spawnedPid: number | undefined;

  try {
    const promoted = await promoteQueuedJobsWithinAdmissionLock({
      workerPath: "/tmp/fake-oracle-worker.mjs",
      source: "oracle-sanity-worker-write-fail",
      spawnWorkerFn: async (_workerPath, targetJobId) => {
        const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000);"], {
          detached: true,
          stdio: "ignore",
        });
        child.unref();
        spawnedPid = child.pid;

        const jobJsonPath = join(getJobDir(targetJobId), "job.json");
        await rename(jobJsonPath, `${jobJsonPath}.bak`);
        await mkdir(jobJsonPath, { recursive: true, mode: 0o700 });

        return { pid: child.pid, nonce: "write-fail", startedAt: undefined };
      },
    });

    assert(!promoted.promotedJobIds.includes(queuedId), "queued promotion should not report success when worker metadata persistence fails");
    assert(spawnedPid, "write-failure promotion test should spawn a worker process");
    assert(await waitForPidExit(spawnedPid), "queued promotion should terminate a spawned worker if worker metadata persistence fails");
  } finally {
    if (isPidAlive(spawnedPid)) process.kill(spawnedPid!, "SIGKILL");
    await cleanupJob(queuedId);
  }
}

async function testQueuedPromotionToleratesWorkerStateAdvance(config: OracleConfig): Promise<void> {
  await resetOracleStateDir();
  const cwd = process.cwd();
  const sessionId = "/tmp/oracle-sanity-session-queue-worker-race.jsonl";
  const queuedId = await createJobForTest(config, cwd, sessionId, { initialState: "queued" });

  const promoted = await promoteQueuedJobsWithinAdmissionLock({
    workerPath: "/tmp/fake-oracle-worker.mjs",
    source: "oracle-sanity-worker-race",
    spawnWorkerFn: async (_workerPath, jobId) => {
      await updateJob(jobId, (job) => ({
        ...job,
        ...withJobPhase("launching_browser", {
          status: "waiting",
          heartbeatAt: new Date().toISOString(),
        }),
      }));
      return { pid: 66_666, nonce: "worker-race", startedAt: "worker-race" };
    },
  });

  assert(promoted.promotedJobIds.includes(queuedId), "worker state advance during promotion should still count as a successful promotion");
  const promotedJob = readJob(queuedId);
  assert(promotedJob?.status === "waiting", "worker-advanced promoted jobs should preserve the worker-updated active status");
  assert(Boolean(promotedJob?.submittedAt), "worker-advanced promoted jobs should still record submittedAt");
  assert(promotedJob?.workerNonce === "worker-race", "worker metadata should still persist when the worker updates state first");
  assert(listLeaseMetadata<{ jobId: string }>("runtime").some((lease) => lease.jobId === queuedId), "worker-advanced promoted jobs should retain runtime leases");

  await releaseRuntimeLease(promotedJob?.runtimeId);
  await completeJob(queuedId);
  await cleanupJob(queuedId);
}

async function testQueuedPromotionReusesSameJobConversationLease(config: OracleConfig): Promise<void> {
  await resetOracleStateDir();
  const cwd = process.cwd();
  const sessionId = "/tmp/oracle-sanity-session-queue-followup-reuse.jsonl";
  const conversationId = `conversation-${randomUUID()}`;

  const queuedId = await createJobForTest(config, cwd, sessionId, {
    initialState: "queued",
    followUpToJobId: `follow-up-${randomUUID()}`,
    chatUrl: `https://chatgpt.com/c/${conversationId}`,
  });
  const queued = readJob(queuedId);
  assert(queued, "queued follow-up should exist");
  assert(queued.conversationId === conversationId, "queued follow-up should persist conversation id");

  const firstAttempt = await tryAcquireConversationLease({
    jobId: queued.id,
    conversationId,
    projectId: queued.projectId,
    sessionId: queued.sessionId,
    createdAt: new Date().toISOString(),
  });
  assert(firstAttempt.acquired, "same-job follow-up should acquire its initial conversation lease");

  const secondAttempt = await tryAcquireConversationLease({
    jobId: queued.id,
    conversationId,
    projectId: queued.projectId,
    sessionId: queued.sessionId,
    createdAt: new Date().toISOString(),
  });
  assert(secondAttempt.acquired, "same-job follow-up should reuse an existing conversation lease during retry");

  const promoted = await promoteQueuedJobsWithinAdmissionLock({
    workerPath: "/tmp/fake-oracle-worker.mjs",
    source: "oracle-sanity-followup-reuse",
    spawnWorkerFn: async () => ({ pid: 4747, nonce: "same-job-followup", startedAt: "same-job-followup" }),
  });
  assert(promoted.promotedJobIds.includes(queuedId), "queued follow-up should still promote when its own conversation lease already exists");
  const promotedJob = readJob(queuedId);
  assert(promotedJob?.status === "submitted", "same-job leased follow-up should become submitted");

  await releaseConversationLease(conversationId);
  await releaseRuntimeLease(promotedJob?.runtimeId);
  await completeJob(queuedId);
  await cleanupJob(queuedId);
}

async function testQueuedPromotionSkipsConversationBlockedJobs(config: OracleConfig): Promise<void> {
  await resetOracleStateDir();
  const cwd = process.cwd();
  const sessionId = "/tmp/oracle-sanity-session-queue-followup.jsonl";
  const conversationId = `conversation-${randomUUID()}`;

  const holderId = await createJobForTest(config, cwd, sessionId);
  const holder = readJob(holderId);
  assert(holder, "conversation holder job should exist");
  await acquireConversationLease({
    jobId: holder.id,
    conversationId,
    projectId: holder.projectId,
    sessionId: holder.sessionId,
    createdAt: new Date().toISOString(),
  });

  const blockedQueuedId = await createJobForTest(config, cwd, sessionId, {
    initialState: "queued",
    followUpToJobId: holder.id,
    chatUrl: `https://chatgpt.com/c/${conversationId}`,
  });
  const readyQueuedId = await createJobForTest(config, cwd, sessionId, { initialState: "queued" });

  const promoted = await promoteQueuedJobsWithinAdmissionLock({
    workerPath: "/tmp/fake-oracle-worker.mjs",
    source: "oracle-sanity-followup-promote",
    spawnWorkerFn: async (_workerPath, jobId) => ({ pid: jobId === readyQueuedId ? 4343 : 4444, nonce: jobId, startedAt: jobId }),
  });
  assert(!promoted.promotedJobIds.includes(blockedQueuedId), "conversation-blocked queued jobs should remain queued");
  assert(promoted.promotedJobIds.includes(readyQueuedId), "later eligible queued jobs should promote when an earlier follow-up is blocked");
  assert(readJob(blockedQueuedId)?.status === "queued", "blocked follow-up job should remain queued");
  assert(readJob(readyQueuedId)?.status === "submitted", "eligible queued job should promote");

  await releaseConversationLease(conversationId);
  await completeJob(holderId);
  await cleanupJob(holderId);
  await releaseRuntimeLease(readJob(readyQueuedId)?.runtimeId);
  await completeJob(readyQueuedId);
  await cleanupJob(readyQueuedId);
  await cancelOracleJob(blockedQueuedId);
  await cleanupJob(blockedQueuedId);
}


function testAuthCookiePolicy(): void {
  const rawCookies: ImportedAuthCookie[] = [
    { name: "__Secure-next-auth.session-token.0", value: "session-a", domain: ".chatgpt.com", path: "/", secure: true, httpOnly: true, sameSite: "Lax" },
    { name: "oai-client-auth-info", value: "info", domain: "auth.openai.com", path: "/", secure: true, sameSite: "Lax" },
    { name: "_account_is_fedramp", value: "1", domain: "chatgpt.com", path: "/", secure: false, sameSite: "Lax" },
    { name: "_ga", value: "analytics", domain: "chatgpt.com", path: "/" },
    { name: "__cf_bm", value: "bot", domain: "auth.openai.com", path: "/", secure: true },
    { name: "totally_unknown_cookie", value: "mystery", domain: "chatgpt.com", path: "/" },
    { name: "oai-client-auth-info", value: "evil", domain: "evil.example", path: "/", secure: true, sameSite: "Lax" },
  ];

  const filtered = filterImportableAuthCookies(rawCookies, "https://chatgpt.com/");
  const keptNames = filtered.cookies.map((cookie) => `${cookie.name}@${cookie.domain}`).sort();
  const droppedReasons = filtered.dropped.map(({ reason }) => reason).sort();

  assert(keptNames.includes("__Secure-next-auth.session-token.0@chatgpt.com"), "session token cookie should be kept");
  assert(keptNames.includes("oai-client-auth-info@auth.openai.com"), "auth cookie should be kept");
  assert(keptNames.includes("_account_is_fedramp@chatgpt.com"), "fedramp marker should be kept");
  assert(!keptNames.some((name) => name.startsWith("_ga@")), "analytics cookie should be dropped");
  assert(!keptNames.some((name) => name.startsWith("__cf_bm@")), "bot-management cookie should be dropped");
  assert(droppedReasons.includes("noise"), "expected noise cookies to be classified and dropped");
  assert(droppedReasons.includes("non-auth"), "expected unknown cookies to be classified and dropped");
  assert(droppedReasons.includes("foreign-domain"), "expected foreign-domain cookies to be classified and dropped");

  const ensured = ensureAccountCookie(filtered.cookies, "https://chatgpt.com/");
  const synthesizedAccount = ensured.cookies.find((cookie) => cookie.name === "_account");
  assert(ensured.synthesized, "missing _account cookie should be synthesized");
  assert(synthesizedAccount?.value === "fedramp", "fedramp marker should synthesize fedramp account value");
}

async function testStaleLockRecovery(): Promise<void> {
  await resetOracleStateDir();
  await acquireLock("reconcile", "global", { processPid: 999_999_999, source: "oracle-sanity-stale-lock" });

  let entered = false;
  await withGlobalReconcileLock({ processPid: process.pid, source: "oracle-sanity-reclaim" }, async () => {
    entered = true;
  });

  assert(entered, "expected stale reconcile lock to be reclaimed");
}

async function testDeadPidLockSweep(): Promise<void> {
  await resetOracleStateDir();
  await acquireLock("job", `stale-job-lock-${randomUUID()}`, { processPid: 999_999_999, source: "oracle-sanity-dead-lock" });
  const removed = await sweepStaleLocks();
  assert(removed.length === 1, `expected exactly one stale lock to be removed, saw ${removed.length}`);
}

async function testTmpLockDirGraceHonorsConfiguredWindow(): Promise<void> {
  await resetOracleStateDir();
  const parentDir = getLocksDir();
  const key = `tmp-lock-grace-window-${randomUUID()}`;
  const finalName = basename(hashedOracleStatePath("job", key, parentDir));
  const tempPath = join(parentDir, `.tmp-${finalName}.${process.pid}.window`);
  await mkdir(tempPath, { recursive: false, mode: 0o700 });

  const stats = await stat(tempPath);
  const baselineMs = Math.max(stats.mtimeMs, stats.ctimeMs);
  const deltaMs = Math.max(1, Math.floor(ORACLE_TMP_STATE_DIR_GRACE_MS / 10));

  const removedBeforeGrace = await sweepStaleLocks(baselineMs + ORACLE_TMP_STATE_DIR_GRACE_MS - deltaMs);
  assert(!removedBeforeGrace.includes(tempPath), "sweep should not reclaim .tmp-* lock dirs before ORACLE_TMP_STATE_DIR_GRACE_MS elapses");
  assert(await pathExists(tempPath), ".tmp-* lock dirs should remain until the configured tmp grace window expires");

  const removedAfterGrace = await sweepStaleLocks(baselineMs + ORACLE_TMP_STATE_DIR_GRACE_MS + deltaMs);
  assert(removedAfterGrace.includes(tempPath), "sweep should reclaim .tmp-* lock dirs once ORACLE_TMP_STATE_DIR_GRACE_MS has elapsed");
  assert(!(await pathExists(tempPath)), "expired .tmp-* lock dirs should be removed after the tmp grace window");
}

async function testTmpLockDirGracePreventsInFlightPublishReclaim(): Promise<void> {
  await resetOracleStateDir();
  const stateDir = getOracleStateDir();
  const kind = "job";
  const key = `tmp-lock-grace-${randomUUID()}`;
  const finalPath = hashedOracleStatePath(kind, key, getLocksDir());
  const finalName = basename(finalPath);
  const child = spawn(process.execPath, ["--input-type=module", "--eval", IN_FLIGHT_LOCK_PUBLISHER_SCRIPT, stateDir, kind, key], {
    stdio: ["pipe", "ignore", "pipe"],
  });
  let stderr = "";
  let exited = false;
  const childExit = new Promise<number>((resolve) => {
    child.on("exit", (code) => {
      exited = true;
      resolve(code ?? 1);
    });
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });

  try {
    const tempPath = await waitForTmpStateDir(getLocksDir(), finalName, 5_000);
    await sleep(ORACLE_METADATA_WRITE_GRACE_MS + 200);

    const removed = await sweepStaleLocks();
    assert(!removed.includes(tempPath), "sweep should not reclaim fresh in-flight .tmp-* lock dirs within the tmp grace window");
    assert(await pathExists(tempPath), "fresh in-flight .tmp-* lock dirs should still exist after a sweep");

    child.stdin?.write("continue\n");
    child.stdin?.end();

    const exitCode = await childExit;
    assert(exitCode === 0, `in-flight lock publisher should finish successfully after sweep, got exit ${exitCode}${stderr ? `: ${stderr}` : ""}`);

    const metadata = JSON.parse(await readFile(join(finalPath, "metadata.json"), "utf8")) as { source?: string };
    assert(metadata.source === "oracle-sanity-inflight-publisher", "in-flight publish should finish by atomically promoting the temp lock dir");
  } finally {
    if (!exited) child.kill("SIGKILL");
    await rm(finalPath, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function testMetadataLessLockRecovery(): Promise<void> {
  await resetOracleStateDir();
  const key = `metadata-less-lock-${randomUUID()}`;
  const path = hashedOracleStatePath("job", key, getLocksDir());
  await mkdir(path, { recursive: false, mode: 0o700 });
  await sleep(ORACLE_METADATA_WRITE_GRACE_MS + 100);

  const handle = await acquireLock("job", key, { processPid: process.pid, source: "oracle-sanity-metadata-less-lock" }, { timeoutMs: 5_000 });
  assert(Boolean(handle), "metadata-less lock directories should be reclaimed after a bounded grace instead of timing out forever");
  await releaseLock(handle);
}

async function testMetadataLessConversationLeaseRecovery(): Promise<void> {
  await resetOracleStateDir();
  const conversationId = `conversation-${randomUUID()}`;
  const path = hashedOracleStatePath("conversation", conversationId, getLeasesDir());
  await mkdir(path, { recursive: false, mode: 0o700 });
  await sleep(ORACLE_METADATA_WRITE_GRACE_MS + 100);

  await acquireConversationLease({
    jobId: `job-${randomUUID()}`,
    conversationId,
    projectId: process.cwd(),
    sessionId: "/tmp/oracle-sanity-metadata-less-conversation.jsonl",
    createdAt: new Date().toISOString(),
  });
  const lease = await readLeaseMetadata<{ conversationId?: string }>("conversation", conversationId);
  assert(lease?.conversationId === conversationId, "metadata-less conversation lease directories should be reclaimed so follow-up acquisition can succeed");
  await releaseConversationLease(conversationId);
}

async function testWorkerAuthLockRecoversMetadataLessDir(): Promise<void> {
  await resetOracleStateDir();
  const path = hashedOracleStatePath("auth", "global", getLocksDir());
  await mkdir(path, { recursive: false, mode: 0o700 });
  await sleep(WORKER_METADATA_WRITE_GRACE_MS + 100);

  const handle = await acquireWorkerStateLock(getOracleStateDir(), "auth", "global", { processPid: process.pid, source: "oracle-sanity-worker-auth-lock" }, 5_000);
  assert(Boolean(handle), "worker auth lock acquisition should recover metadata-less auth lock dirs left behind by crashes");
  await releaseWorkerStateLock(handle);
}

async function testWorkerConversationLeaseRecoversMetadataLessDir(): Promise<void> {
  await resetOracleStateDir();
  const conversationId = `conversation-${randomUUID()}`;
  const path = hashedOracleStatePath("conversation", conversationId, getLeasesDir());
  await mkdir(path, { recursive: false, mode: 0o700 });
  await sleep(WORKER_METADATA_WRITE_GRACE_MS + 100);

  await createWorkerStateLease(getOracleStateDir(), "conversation", conversationId, {
    jobId: `job-${randomUUID()}`,
    conversationId,
    projectId: process.cwd(),
    sessionId: "/tmp/oracle-sanity-worker-state-conversation.jsonl",
    createdAt: new Date().toISOString(),
  }, 5_000);
  const lease = await readWorkerStateLeaseMetadata<{ conversationId?: string }>(getOracleStateDir(), "conversation", conversationId);
  assert(lease?.conversationId === conversationId, "worker conversation lease acquisition should recover metadata-less lease dirs left behind by crashes");
  await releaseWorkerStateLease(getOracleStateDir(), "conversation", conversationId);
}

async function testTerminalCleanupWarningsPreserveJob(config: OracleConfig): Promise<void> {
  await resetOracleStateDir();
  const cwd = process.cwd();
  const sessionId = "/tmp/oracle-sanity-session-cleanup-warnings.jsonl";
  const jobId = await createTerminalJob(config, cwd, sessionId);

  await updateJob(jobId, (job) => ({
    ...job,
    runtimeProfileDir: "/dev/null/pi-oracle-invalid-runtime-profile",
  }));

  const job = readJob(jobId);
  assert(job, "cleanup-warning terminal job should exist");
  await acquireRuntimeLease(config, {
    jobId: job.id,
    runtimeId: job.runtimeId,
    runtimeSessionName: job.runtimeSessionName,
    runtimeProfileDir: job.runtimeProfileDir,
    projectId: job.projectId,
    sessionId: job.sessionId,
    createdAt: new Date().toISOString(),
  });

  const result = await removeTerminalOracleJob(job);
  assert(!result.removed, "terminal jobs should be retained when cleanup reports warnings");
  assert(result.cleanupReport.warnings.length > 0, "cleanup-warning terminal job should report cleanup warnings");
  const retainedJob = readJob(jobId);
  assert(Boolean(retainedJob), "cleanup-warning terminal job should remain on disk");
  assert(Boolean(retainedJob?.cleanupWarnings?.length), "cleanup-warning terminal job should persist cleanup warnings");
  assert(!listLeaseMetadata<{ jobId: string }>("runtime").some((lease) => lease.jobId === jobId), "cleanup-warning terminal job should release runtime leases even when cleanup warnings remain");

  await releaseRuntimeLease(retainedJob?.runtimeId);
  await cleanupJob(jobId);
}

async function testTerminalJobPruningAndCleanup(config: OracleConfig): Promise<void> {
  const retentionConfig: OracleConfig = {
    ...config,
    cleanup: {
      completeJobRetentionMs: 60_000,
      failedJobRetentionMs: 120_000,
    },
  };
  const cwd = process.cwd();
  const sessionId = "/tmp/oracle-sanity-session-prune.jsonl";
  const oldCompleteJobId = await createTerminalJob(retentionConfig, cwd, sessionId);
  const oldCancelledJobId = await createTerminalJob(retentionConfig, cwd, sessionId);
  const oldFailedJobId = await createTerminalJob(retentionConfig, cwd, sessionId);
  const retainedJobId = await createTerminalJob(retentionConfig, cwd, sessionId);
  const cleanupJobId = await createTerminalJob(retentionConfig, cwd, sessionId);

  const cleanupTargetJob = readJob(cleanupJobId);
  assert(cleanupTargetJob, "cleanup target job should exist");
  await mkdir(cleanupTargetJob.runtimeProfileDir, { recursive: true, mode: 0o700 });
  await acquireRuntimeLease(retentionConfig, {
    jobId: cleanupTargetJob.id,
    runtimeId: cleanupTargetJob.runtimeId,
    runtimeSessionName: cleanupTargetJob.runtimeSessionName,
    runtimeProfileDir: cleanupTargetJob.runtimeProfileDir,
    projectId: cleanupTargetJob.projectId,
    sessionId: cleanupTargetJob.sessionId,
    createdAt: new Date().toISOString(),
  });
  const cleanupConversationId = cleanupTargetJob.conversationId || `conversation-${randomUUID()}`;
  await acquireConversationLease({
    jobId: cleanupTargetJob.id,
    conversationId: cleanupConversationId,
    projectId: cleanupTargetJob.projectId,
    sessionId: cleanupTargetJob.sessionId,
    createdAt: new Date().toISOString(),
  });
  await updateJob(cleanupTargetJob.id, (job) => ({ ...job, conversationId: cleanupConversationId }));
  const cleanupReadyJob = readJob(cleanupTargetJob.id);
  assert(cleanupReadyJob, "cleanup-ready job should still exist");
  await removeTerminalOracleJob(cleanupReadyJob);
  assert(!readJob(cleanupReadyJob.id), "removeTerminalOracleJob should delete the job directory");

  const oldTimestamp = new Date(Date.now() - 5 * 60 * 1000).toISOString();
  const completePruneTimestamp = new Date(Date.now() - 2 * 60 * 1000).toISOString();
  const retainedTimestamp = new Date(Date.now() - 15 * 1000).toISOString();
  await updateJob(oldCompleteJobId, (job) => ({ ...job, createdAt: completePruneTimestamp, completedAt: completePruneTimestamp, notifiedAt: undefined }));
  await updateJob(oldCancelledJobId, (job) => ({
    ...job,
    status: "cancelled",
    phase: "cancelled",
    createdAt: completePruneTimestamp,
    completedAt: completePruneTimestamp,
    phaseAt: completePruneTimestamp,
    notifiedAt: undefined,
  }));
  await updateJob(oldFailedJobId, (job) => ({
    ...job,
    status: "failed",
    phase: "failed",
    createdAt: oldTimestamp,
    completedAt: oldTimestamp,
    phaseAt: oldTimestamp,
  }));
  await updateJob(retainedJobId, (job) => ({ ...job, createdAt: retainedTimestamp, completedAt: retainedTimestamp, notifiedAt: undefined }));

  const pruned = await pruneTerminalOracleJobs(Date.now());
  assert(pruned.includes(oldCompleteJobId), "old complete jobs should be pruned even when wake-up delivery stays best-effort only");
  assert(pruned.includes(oldCancelledJobId), "old cancelled jobs should be pruned even when wake-up delivery stays best-effort only");
  assert(pruned.includes(oldFailedJobId), "old failed job should be pruned");
  assert(!pruned.includes(retainedJobId), "recent complete jobs should still be retained within the configured retention window");
  assert(!readJob(oldCompleteJobId), "pruned complete job should be removed");
  assert(!readJob(oldCancelledJobId), "pruned cancelled job should be removed");
  assert(!readJob(oldFailedJobId), "pruned failed job should be removed");
  assert(Boolean(readJob(retainedJobId)), "retained job should still exist");
  await cleanupJob(retainedJobId);
}

async function testLifecycleEventCutover(): Promise<void> {
  const extensionSource = await readFile(new URL("../extensions/oracle/index.ts", import.meta.url), "utf8");
  assert(extensionSource.includes('pi.on("session_start"'), "oracle extension should bind session_start");
  assert(!extensionSource.includes('pi.on("session_switch"'), "oracle extension must not bind removed session_switch event");
  assert(!extensionSource.includes('pi.on("session_fork"'), "oracle extension must not bind removed session_fork event");
  assert(extensionSource.includes("hasPersistedSessionFile(sessionFile)"), "oracle extension should refuse to start poller routing when the current session has no persisted identity");
  assert(extensionSource.includes("oracle: unavailable"), "oracle extension should mark oracle unavailable when no persisted session identity exists");
  assert(extensionSource.includes('ctx.ui.notify(message, "warning")'), "oracle extension should surface startup-maintenance failures through the session UI as well as stderr");
}

async function testOraclePromptTemplateCutover(): Promise<void> {
  const commandsSource = await readFile(new URL("../extensions/oracle/lib/commands.ts", import.meta.url), "utf8");
  const toolsSource = await readFile(new URL("../extensions/oracle/lib/tools.ts", import.meta.url), "utf8");
  const jobsSource = await readFile(new URL("../extensions/oracle/lib/jobs.ts", import.meta.url), "utf8");
  const pollerSource = await readFile(new URL("../extensions/oracle/lib/poller.ts", import.meta.url), "utf8");
  const queueSource = await readFile(new URL("../extensions/oracle/lib/queue.ts", import.meta.url), "utf8");
  const locksSource = await readFile(new URL("../extensions/oracle/lib/locks.ts", import.meta.url), "utf8");
  const runtimeSource = await readFile(new URL("../extensions/oracle/lib/runtime.ts", import.meta.url), "utf8");
  const sharedStateSource = await readFile(new URL("../extensions/oracle/shared/state-coordination-helpers.mjs", import.meta.url), "utf8");
  const sharedJobCoordinationSource = await readFile(new URL("../extensions/oracle/shared/job-coordination-helpers.mjs", import.meta.url), "utf8");
  const sharedLifecycleSource = await readFile(new URL("../extensions/oracle/shared/job-lifecycle-helpers.mjs", import.meta.url), "utf8");
  const sharedObservabilitySource = await readFile(new URL("../extensions/oracle/shared/job-observability-helpers.mjs", import.meta.url), "utf8");
  const sharedProcessSource = await readFile(new URL("../extensions/oracle/shared/process-helpers.mjs", import.meta.url), "utf8");
  const supportSource = await readFile(new URL("./oracle-sanity-support.ts", import.meta.url), "utf8");
  const promptSource = await readFile(new URL("../prompts/oracle.md", import.meta.url), "utf8");
  const designSource = await readFile(new URL("../docs/ORACLE_DESIGN.md", import.meta.url), "utf8");
  const recoveryDrillSource = await readFile(new URL("../docs/ORACLE_RECOVERY_DRILL.md", import.meta.url), "utf8");
  const readmeSource = await readFile(new URL("../README.md", import.meta.url), "utf8");
  const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as {
    files?: string[];
    pi?: { prompts?: string[] };
    engines?: { node?: string };
    os?: string[];
    scripts?: { test?: string; prepublishOnly?: string; "typecheck:worker-helpers"?: string; "verify:oracle"?: string };
    overrides?: { "basic-ftp"?: string };
  };
  const pi = createPiHarness();
  registerOracleTools(pi as unknown as import("@mariozechner/pi-coding-agent").ExtensionAPI, "/tmp/fake-oracle-worker.mjs");
  const preflightTool = pi.tools.get("oracle_preflight");
  const submitTool = pi.tools.get("oracle_submit");
  assert(preflightTool, "oracle preflight tool should register for schema inspection");
  assert(submitTool, "oracle submit tool should register for schema inspection");
  const preflightProperties = asRecord(asRecord(preflightTool.parameters)?.properties);
  const submitProperties = asRecord(asRecord(submitTool.parameters)?.properties);
  assert(preflightProperties !== undefined, "oracle preflight tool should expose an object schema");
  assert(submitProperties, "oracle submit tool should expose an object schema");
  const representativePresetAliases: [string, OracleSubmitPresetId][] = [
    ["Pro-standard", "pro_standard"],
    ["Pro-extended", "pro_extended"],
    ["Thinking-standard", "thinking_standard"],
    ["Instant Auto-switch to Thinking Enabled", "instant_auto_switch"],
  ];

  assert(!commandsSource.includes('registerCommand("oracle"'), "/oracle should not be registered as an extension command");
  assert(promptSource.includes("You are preparing an /oracle job."), "/oracle prompt template should contain the oracle dispatch instructions");
  assert(promptSource.includes("Call `oracle_preflight` immediately"), "/oracle prompt should require an immediate oracle_preflight guard before repo context gathering");
  assert(promptSource.includes("Do not read files, search the codebase, or prepare archive inputs first"), "/oracle prompt should forbid expensive prep before preflight passes");
  assert(promptSource.includes("Gather only the smallest repo context needed"), "/oracle prompt should bias toward minimal pre-submit context gathering");
  assert(promptSource.includes("If the user scope is explicit and narrow"), "/oracle prompt should recognize explicit narrow requests before broad repo exploration");
  assert(promptSource.includes("Do not keep exploring once you already have enough context to submit well"), "/oracle prompt should bias toward dispatch once enough context is in hand");
  assert(promptSource.includes("`preset`"), "/oracle prompt should document oracle_submit preset parameter");
  assert(promptSource.includes("is the only model-selection parameter"), "/oracle prompt should state preset is the only selector");
  assert(promptSource.includes("canonical preset registry"), "/oracle prompt should point callers to the canonical registry instead of a hard-coded preset list");
  assert(promptSource.includes("Do not pass `modelFamily`, `effort`, or `autoSwitchToThinking`"), "/oracle prompt should tell callers not to pass legacy fields");
  assert(promptSource.includes("Matching human-readable preset labels"), "/oracle prompt should explain preset label normalization");
  assert(promptSource.includes("If unsure, omit **`preset`** and use the configured default"), "/oracle prompt should prefer the configured default preset instead of asking the user when unsure");
  assert(!promptSource.includes("If unsure which preset fits the task, ask the user."), "/oracle prompt should no longer tell agents to ask the user when preset choice is merely uncertain");
  for (const presetId of Object.keys(ORACLE_SUBMIT_PRESETS)) {
    assert(!promptSource.includes(presetId), `/oracle prompt should not hard-code preset id ${presetId}`);
  }
  assert(promptSource.includes("include the whole repository by passing `.`"), "/oracle prompt should default to whole-repo archive selection");
  assert(promptSource.includes("obvious credentials/private data"), "/oracle prompt should mention default exclusion of obvious credentials/private data");
  assert(promptSource.includes("nested `secrets/` directories anywhere in the repo"), "/oracle prompt should exclude nested secrets directories by default");
  assert(promptSource.includes("For very targeted asks like reviewing one function, one file, one stack trace"), "/oracle prompt should preserve and strengthen the targeted-scope exception");
  assert(promptSource.includes("the `.git` directory is not included in oracle exports"), "/oracle prompt should tell review/ship-readiness requests to create and include a git diff bundle file");
  assert(promptSource.includes("submit automatically prunes the largest nested directories matching generic generated-output names"), "/oracle prompt should describe whole-repo auto-pruning when archives are still too large");
  assert(promptSource.includes("outside obvious source roots like `src/` and `lib/`"), "/oracle prompt should describe the source-root guard for auto-pruning");
  assert(promptSource.includes("If a submitted oracle job later fails because upload is rejected"), "/oracle prompt should describe the post-submit upload-rejection fallback ladder");
  assert(promptSource.includes("still exceeds the upload limit after default exclusions and automatic generic generated-output-dir pruning"), "/oracle prompt should distinguish submit-time oversize failures after auto-pruning");
  assert(promptSource.includes("If `oracle_submit` returns a queued job instead of an immediately dispatched one, treat that as success"), "/oracle prompt should explain queued oracle submissions as successful waits");
  assert(designSource.includes("`oracle_preflight`"), "design doc should document the oracle_preflight tool");
  assert(designSource.includes("call `oracle_preflight` immediately"), "design doc should describe the /oracle preflight-first flow");
  assert(designSource.includes("gather only the smallest repo context needed"), "design doc should describe the minimal-context /oracle flow for narrow requests");
  assert(designSource.includes("biases toward omitting `preset` and using the configured default"), "design doc should explain the default-preset bias for /oracle prompt ergonomics");
  assert(designSource.includes("the canonical registry is `ORACLE_SUBMIT_PRESETS`"), "design doc should point to the canonical preset registry");
  assert(designSource.includes("/tmp/pi-oracle-auth-*/oracle-auth.log"), "design doc should reference the per-run oracle-auth diagnostics bundle");
  assert(designSource.includes("returns a retry-after timestamp"), "design doc should explain that oracle-clean returns a retry-after timestamp when retention grace blocks cleanup");
  assert(recoveryDrillSource.includes("/tmp/pi-oracle-auth-*/"), "recovery drill should reference the per-run oracle-auth diagnostics bundle");
  assert(!recoveryDrillSource.includes("/tmp/oracle-auth.log"), "recovery drill should not reference the old fixed oracle-auth log path");
  assert(designSource.includes("`preset` is the only model-selection parameter"), "design doc should state preset is the only selector");
  assert(designSource.includes("matching human-readable labels/common hyphen-space variants"), "design doc should mention preset label normalization");
  for (const presetId of Object.keys(ORACLE_SUBMIT_PRESETS)) {
    assert(!designSource.includes(presetId), `design doc should not hard-code preset id ${presetId}`);
  }
  assert(toolsSource.includes("archive the whole repo by passing '.'"), "oracle tool guidance should align with whole-repo archive defaults");
  assert(toolsSource.includes("resolveOracleSubmitPreset"), "oracle submit should resolve preset via config helper");
  assert(toolsSource.includes("coerceOracleSubmitPresetId"), "oracle submit should normalize preset label aliases before resolving the canonical preset id");
  assert(toolsSource.includes("ORACLE_SUBMIT_PRESETS registry"), "oracle submit tool description should point preset discovery to the canonical registry");
  assert(!toolsSource.includes("see `preset` field for canonical ids"), "oracle submit tool description should not imply the free-form preset schema exposes canonical ids");
  assert(toolsSource.includes("Use `preset` as the only model-selection parameter"), "oracle tool guidance should say preset is the only selector");
  assert(toolsSource.includes("matching human-readable preset labels are normalized automatically"), "oracle tool guidance should mention preset label normalization");
  assert(!toolsSource.includes("Do not pass modelFamily, effort, or autoSwitchToThinking"), "oracle tool guidance should no longer carry legacy-field prose lists when preset-only guidance already covers the contract");
  assert(readmeSource.includes("Start a normal persisted `pi` session"), "README quickstart should surface the persisted-session requirement before oracle usage");
  assert(readmeSource.includes("The `/oracle` prompt now runs an early oracle preflight"), "README quickstart should explain the early oracle preflight guard");
  assert(readmeSource.includes("For explicitly narrow requests, `/oracle` should gather only minimal context"), "README should explain the minimal-context bias for narrow /oracle requests");
  assert(readmeSource.includes("omit `preset` and use the configured default model"), "README should explain the default-preset bias for /oracle prompt ergonomics");
  assert(readmeSource.includes("Only archive README.md unless another file is clearly necessary"), "README should include a narrow /oracle example that biases toward minimal archive scope");
  assert(readmeSource.includes("Agent preflights, then gathers only the needed repo context"), "README high-level flow should reflect the minimal-context /oracle path");
  assert(readmeSource.includes("`oracle_preflight`"), "README should document the oracle_preflight agent-facing tool");
  assert(readmeSource.includes("/oracle-clean <job-id|all>"), "README should document the oracle-clean command");
  assert(readmeSource.includes("recently woken terminal jobs may stay retained briefly"), "README command summary should explain that oracle-clean can briefly retain terminal jobs after wake-up delivery");
  assert(readmeSource.includes("returns the next eligible cleanup time"), "README should explain that oracle-clean returns a retry-after hint when post-send retention grace blocks cleanup");
  assert(readmeSource.includes("### `/oracle-clean` refuses a terminal job right after completion"), "README troubleshooting should explain oracle-clean retention-grace refusals");
  assert(readmeSource.includes("Retry after ..."), "README troubleshooting should mention the oracle-clean retry-after hint");
  assert(readmeSource.includes("## Available presets"), "README should document available oracle preset ids");
  assert(readmeSource.includes("defaults.preset"), "README should document defaults.preset");
  assert(readmeSource.includes("human-readable preset label"), "README should mention preset label normalization");
  for (const [presetId, preset] of Object.entries(ORACLE_SUBMIT_PRESETS) as [OracleSubmitPresetId, (typeof ORACLE_SUBMIT_PRESETS)[OracleSubmitPresetId]][]) {
    assert(readmeSource.includes(`\`${presetId}\``), `README should list preset id ${presetId}`);
    assert(readmeSource.includes(preset.label), `README should describe preset ${presetId} with label ${preset.label}`);
  }
  const preflightSchema = preflightTool.parameters as import("@sinclair/typebox").TSchema;
  const submitSchema = submitTool.parameters as import("@sinclair/typebox").TSchema;
  assert(Check(preflightSchema, {}), "oracle_preflight should accept an empty object");
  assert(Object.keys(preflightProperties ?? {}).length === 0, "oracle_preflight should not require caller arguments");
  assert(asRecord(submitProperties.preset)?.type === "string", "oracle submit preset schema should validate preset as a string before execute-time normalization");
  for (const [presetAlias, presetId] of representativePresetAliases) {
    assert(
      Check(submitSchema, { prompt: "sanity", files: ["README.md"], preset: presetAlias }),
      `oracle_submit tool-call validation should accept preset alias ${presetAlias}`,
    );
    assert(
      coerceOracleSubmitPresetId(presetAlias) === presetId,
      `oracle_submit execute-time preset normalization should coerce ${presetAlias} to ${presetId}`,
    );
  }
  assert(
    !Check(submitSchema, { prompt: "sanity", files: ["README.md"], preset: 123 }),
    "oracle_submit tool-call validation should reject non-string preset values",
  );
  assert(
    !Check(submitSchema, { prompt: "sanity", files: ["   "] }),
    "oracle_submit tool-call validation should reject blank archive input strings instead of widening them to whole-repo archives",
  );
  assert(!("modelFamily" in submitProperties), "oracle submit tool schema should not expose legacy modelFamily input");
  assert(!("effort" in submitProperties), "oracle submit tool schema should not expose legacy effort input");
  assert(!("autoSwitchToThinking" in submitProperties), "oracle submit tool schema should not expose legacy autoSwitchToThinking input");
  assert(runtimeSource.includes("Oracle requires a persisted pi session"), "runtime should surface a clear error when oracle is used without a persisted session identity");
  assert(!runtimeSource.includes("ephemeral:"), "runtime should no longer collapse no-session oracle contexts onto a shared project-level ephemeral session identity");
  assert(runtimeSource.includes("resolveWorkspaceRoot"), "runtime should derive project identity from a stable workspace root instead of the raw current working directory");
  assert(runtimeSource.includes("Configured oracle browser executable does not exist"), "runtime submit preflight should surface missing configured browser executables clearly");
  assert(runtimeSource.includes("Oracle prerequisite not found on PATH"), "runtime submit preflight should surface missing local dependencies clearly");
  assert(runtimeSource.includes('await assertWritableDirectory(config.browser.runtimeProfilesDir, "runtime profiles")'), "runtime submit preflight should validate runtime profile directory writability before submit");
  assert(runtimeSource.includes('await assertWritableDirectory(ORACLE_JOBS_DIR, "jobs")'), "runtime submit preflight should validate jobs directory writability before submit");
  assert(runtimeSource.includes("assertOracleSubmitPrerequisites"), "runtime should expose a submit-side preflight helper for locally knowable blockers");
  assert(runtimeSource.includes("Oracle auth seed profile is not readable"), "runtime submit preflight should surface unreadable auth seed profiles clearly");
  assert(toolsSource.includes("const projectCwd = getProjectId(ctx.cwd);"), "oracle submit should derive a stable workspace-root cwd before loading config or resolving archives");
  assert(toolsSource.includes("loadOracleConfig(projectCwd)"), "oracle submit should load config from the stable workspace-root cwd");
  assert(toolsSource.includes("resolveArchiveInputs(projectCwd, params.files)"), "oracle submit should resolve archive inputs from the stable workspace-root cwd");
  assert(toolsSource.includes("createArchive(projectCwd, params.files, tempArchivePath)"), "oracle submit should build archives from the stable workspace-root cwd");
  assert(toolsSource.includes("requirePersistedSessionFile(getSessionFile(ctx), \"submit oracle jobs\")"), "oracle submit should reject no-session contexts instead of collapsing them onto a project-level ephemeral session id");
  assert(toolsSource.includes("await assertOracleSubmitPrerequisites(config);"), "oracle submit should preflight locally knowable blockers before archiving or persisting jobs");
  assert(toolsSource.includes("buildOracleToolErrorResult"), "oracle tools should centralize structured error payload creation");
  assert(toolsSource.includes('pi.on("tool_result"'), "oracle tools should register a tool_result hook so structured oracle errors still surface with isError=true");
  assert(toolsSource.includes("job: redactJobDetails(job"), "oracle submit should now return structured job details under details.job");
  assert(!toolsSource.includes("details: {\n            jobId:"), "oracle submit should no longer expose legacy top-level detail fields like jobId instead of details.job");
  assert(toolsSource.includes("artifactsPath: `${getJobDir(current.id)}/artifacts`"), "oracle read should derive artifact paths from the configured jobs dir instead of hard-coding /tmp");
  assert(toolsSource.includes("source: \"oracle_read\""), "oracle read should pass explicit settlement provenance when a terminal job has been manually read");
  assert(commandsSource.includes("source: \"oracle_status\""), "oracle status should pass explicit settlement provenance when a terminal job has been manually inspected");
  assert(jobsSource.includes("requirePersistedSessionFile(originSessionFile, \"create oracle jobs\")"), "oracle jobs should require a persisted session identity at creation time");
  assert(toolsSource.includes("obvious credentials/private data"), "oracle tool guidance should mention default exclusion of obvious credentials/private data");
  assert(toolsSource.includes("submit automatically prunes the largest nested directories matching generic generated-output names"), "oracle tool guidance should describe whole-repo auto-pruning when archives are still too large");
  assert(toolsSource.includes("outside obvious source roots like src/ and lib/"), "oracle tool guidance should describe the source-root guard for auto-pruning");
  assert(toolsSource.includes("If oracle_submit returns a queued job instead of an immediately dispatched one, treat that as success"), "oracle tool guidance should explain queued oracle submissions as successful waits");
  assert(toolsSource.includes('if (latest?.status === "queued" && queuedSubmissionDurable)'), "oracle submit should preserve queued jobs only after the archive and metadata persist durably");
  assert(toolsSource.includes("await terminateWorkerPid(spawnedWorker.pid, spawnedWorker.startedAt)"), "oracle submit should terminate a spawned worker if persisting worker metadata fails");
  assert(toolsSource.includes("shouldAdvanceQueueAfterCancellation(cancelled)"), "oracle cancel tool should only promote queued jobs after a clean cancellation");
  assert(toolsSource.includes("formatOracleSubmitResponse"), "oracle tools should format submit responses through the shared observability helper");
  assert(toolsSource.includes("formatOracleJobSummary"), "oracle tools should format oracle_read output through the shared observability helper");
  assert(jobsSource.includes("return job.status === \"cancelled\" && !job.cleanupPending && !job.cleanupWarnings?.length;"), "queue advancement after cancellation should require a cancelled job with no pending cleanup or cleanup warnings");
  assert(sharedJobCoordinationSource.includes("if (job.workerPid) return true;"), "durable worker handoff should require a persisted worker pid");
  assert(!sharedJobCoordinationSource.includes('if (job.status === "waiting") return true;'), "worker phase alone should not count as a durable handoff without a persisted pid");
  assert(queueSource.includes("runQueuedJobPromotionPass"), "queued promotion should delegate the shared orchestration pass instead of keeping a divergent loop inline");
  assert(queueSource.includes("transitionOracleJobPhase"), "queued promotion should apply lifecycle transitions through the shared lifecycle helper");
  assert(queueSource.includes("await terminateWorkerPid(worker.pid, worker.startedAt)"), "queued promotion should terminate a spawned worker if persisting worker metadata fails");
  assert(locksSource.includes("state-coordination-helpers.mjs"), "typed lock wrappers should delegate to the shared state coordination helper module");
  assert(sharedStateSource.includes("ORACLE_METADATA_WRITE_GRACE_MS = 1_000"), "locks/leases should use a bounded grace window before reclaiming metadata-less state dirs left behind by crashes");
  assert(sharedStateSource.includes("ORACLE_TMP_STATE_DIR_GRACE_MS = 60_000"), "locks/leases should use a longer grace for in-flight .tmp-* dirs so concurrent sweep cannot delete another process's atomic publish");
  assert(!sharedStateSource.includes("127.0.0.1:7328"), "shipped lock helpers should not contain hidden localhost telemetry endpoints");
  assert(!sharedStateSource.includes("PI_ORACLE_DEBUG_LOCK_PAUSE_AFTER_MKDIR_MS"), "shipped lock helpers should not contain test-only post-mkdir sleep hooks");
  assert(sharedStateSource.includes("createStateDirAtomically"), "locks/leases should publish new state dirs atomically so first creation never exposes a final dir without metadata");
  assert(sharedStateSource.includes(".tmp-"), "lock/lease first-publish temp dirs should use a hidden prefix that lease readers never mistake for final published state dirs");
  assert(sharedStateSource.includes("await rename(tempPath, finalPath);"), "locks/leases should atomically rename fully populated temp dirs into place for first publish");
  assert(sharedStateSource.includes("await rename(tempPath, targetPath);"), "lock/lease metadata rewrites should stay atomic via temp-file rename so concurrent readers never observe partial JSON");
  assert(sharedStateSource.includes("maybeReclaimIncompleteStateDir"), "locks/leases should reclaim metadata-less state dirs left behind after mkdir succeeds but metadata write never completes");
  assert(sharedStateSource.includes("if (await maybeReclaimIncompleteStateDir(path)) continue;"), "lock/lease acquisition should retry after reclaiming stale metadata-less state dirs");
  assert(!sharedStateSource.includes("await writeFile(join(path, \"metadata.json\")"), "lock/lease metadata should not be written in-place because wake-up routing depends on readers seeing only complete JSON");
  assert(pollerSource.includes("writeLeaseMetadata"), "poller should publish durable wake-up-target leases for cross-process notification routing");
  assert(pollerSource.includes("if (!hasPersistedOriginSession(job)) return false;"), "poller should refuse to route wake-ups for legacy jobs that do not have a persisted origin session identity");
  assert(pollerSource.includes("getWakeupTargetLeaseKey"), "poller should key wake-up targets per process so one process cannot clear another session target");
  assert(pollerSource.includes("processStartedAt"), "poller wake-up target leases should persist process identity to defend against PID reuse");
  assert(pollerSource.includes("!jobHasLiveWakeupTarget(job, liveWakeupTargets)"), "poller should adopt completed jobs whose original session no longer has a live wake-up target");
  assert(pollerSource.includes("await hooks.beforeNotificationClaim?.(jobId);"), "poller should support a hook immediately before claiming notification ownership so stale-snapshot retry races can be regression-tested");
  assert(pollerSource.includes("const preNotifyLiveWakeupTargets = await resolveLiveWakeupTargets();"), "poller should re-check live wake-up targets after claiming a notification and before notifying another session");
  assert(pollerSource.includes("if (shouldPruneTerminalJob(job, now)) return false;"), "poller should exclude already-prunable terminal jobs from wake-up candidacy");
  assert(pollerSource.includes("const preWakeupLiveWakeupTargets = await resolveLiveWakeupTargets();"), "poller should re-check live wake-up targets again immediately before sending a best-effort wake-up");
  assert(pollerSource.includes("recordNotificationTarget(jobId, notificationClaimant"), "poller should persist the intended wake-up target before sending a best-effort completion reminder");
  assert(pollerSource.includes("buildOracleWakeupNotificationContent"), "poller wake-up turns should format content through the shared observability helper");
  assert(pollerSource.includes("buildOracleStatusText"), "poller status updates should format session status through the shared observability helper");
  assert(pollerSource.includes("stopAllPollers"), "poller module should expose a way for the sanity harness to stop all background pollers before isolated-state teardown");
  assert(pollerSource.includes("waitForAllPollersToQuiesce"), "poller module should expose a way for the sanity harness to wait for in-flight scans before teardown");
  assert(pollerSource.indexOf("await recordNotificationTarget(jobId, notificationClaimant") < pollerSource.indexOf("const preWakeupLiveWakeupTargets = await resolveLiveWakeupTargets();"), "poller should finish recording the intended wake-up target before the final live-target recheck");
  assert(pollerSource.indexOf("const preWakeupLiveWakeupTargets = await resolveLiveWakeupTargets();") < pollerSource.indexOf("await noteWakeupRequested(jobId)"), "poller should perform the final live-target recheck before persisting a wake-up attempt");
  assert(pollerSource.indexOf("await noteWakeupRequested(jobId)") < pollerSource.indexOf("requestWakeupTurn(pi, deliverableAfterNote)"), "poller should durably record a wake-up attempt before the best-effort wake-up send path");
  assert(pollerSource.includes("const deliverable = readJob(jobId);"), "poller should re-read the job immediately before send so deleted/pruned jobs cannot emit stale wake-ups");
  assert(pollerSource.includes("const deliverableAfterNote = notedWakeup ?? readJob(jobId);"), "poller should re-read the job after persisting the wake-up attempt so the send path uses durable state");
  assert(pollerSource.includes("if (!deliverableAfterNote || shouldPruneTerminalJob(deliverableAfterNote, Date.now())) {"), "poller should abort wake-up delivery if the job was deleted or became prunable after persisting the wake-up attempt");
  assert(pollerSource.includes("requestWakeupTurn(pi, deliverableAfterNote)"), "poller should deliver completion follow-ups as best-effort wake-up turns instead of direct durable session-history writes");
  assert(pollerSource.includes("buildOracleWakeupNotificationContent(job"), "poller wake-up turns should include durable response/artifact paths from job state via the shared observability helper");
  assert(pollerSource.includes("responseAvailable: Boolean(job.responsePath && existsSync(job.responsePath))"), "poller wake-up turns should hide missing response paths when no response file was actually written");
  assert(sharedObservabilitySource.includes("Use oracle_read with jobId"), "poller wake-up content should direct receivers to oracle_read so reminder retries settle through the canonical path");
  assert(!pollerSource.includes("Read response:"), "poller wake-up content should no longer steer receivers toward raw response-file reads as the primary action");
  assert(pollerSource.includes("getJobDir(job.id)"), "poller wake-up content should derive artifact/response paths from the configured oracle jobs dir instead of hard-coding /tmp");
  assert(pollerSource.includes("beforeNotificationPersist"), "poller should support a last-moment revalidation hook before wake-up delivery for regression coverage");
  assert(!pollerSource.includes("manager.setSessionFile(sessionFile)"), "poller should not discard live in-memory session history by reloading the current session manager before completion delivery");
  assert(!pollerSource.includes("appendMessage(buildNotificationMessage(job, notificationModel))"), "poller should not append synthetic assistant completion messages into session history");
  assert(supportSource.includes("await stopAllPollers();"), "sanity support should stop active pollers before removing the isolated oracle state dir");
  assert(supportSource.includes("await waitForAllPollersToQuiesce()"), "sanity support should wait for in-flight poller scans before removing the isolated oracle state dir");
  assert(!pollerSource.includes("reopenAndVerifyNotification"), "poller should no longer rely on post-append session-history verification for completion delivery");
  assert(!pollerSource.includes("findExistingNotificationRecord"), "poller should not rely on durable session-history notification recovery under the wake-up-only model");
  assert(pollerSource.includes("ORACLE_WAKEUP_REMINDER_CUSTOM_TYPE"), "poller should deliver completion reminders via a dedicated best-effort wake-up custom message type");
  assert(pollerSource.includes("await noteWakeupRequested(jobId)"), "poller should track bounded best-effort wake-up reminder attempts");
  assert(jobsSource.includes("if (!hasPersistedOriginSession(current)) return undefined;"), "notification claims should reject legacy jobs that do not have a persisted origin session identity");
  assert(jobsSource.includes("if (shouldPruneTerminalJob(current, nowMs)) return undefined;"), "notification claims should reject already-prunable jobs under the job lock so stale candidates cannot wake after prune eligibility");
  assert(jobsSource.includes("if (!shouldRequestWakeup(current, nowMs)) return undefined;"), "notification claims should re-check wake-up retry eligibility under the job lock to block stale second claimants");
  assert(jobsSource.includes("notificationSessionFile"), "jobs should persist the durable session file path for wake-up-target tracking");
  assert(jobsSource.includes("job-lifecycle-helpers.mjs"), "jobs should delegate lifecycle mutation ownership to the shared lifecycle helper module");
  assert(jobsSource.includes("recordNotificationTarget"), "jobs should persist the intended notification target before best-effort wake-up delivery so retries can recover idempotently");
  assert(jobsSource.includes("wakeupSettledSource"), "wake-up settlement should persist provenance for later RCA attribution");
  assert(jobsSource.includes("wakeupObservedAt"), "pre-send manual observation should be recorded separately from wake-up settlement");
  assert(sharedLifecycleSource.includes("beforeFirstAttempt && !options.allowBeforeFirstAttempt"), "pre-send manual observations should not silently suppress the first wake-up attempt");
  assert(sharedLifecycleSource.includes("wakeupSettledBeforeFirstAttempt"), "wake-up settlement should record whether it happened before the first reminder attempt");
  assert(jobsSource.includes("ORACLE_WAKEUP_POST_SEND_RETENTION_MS"), "jobs should keep wake-up-target files around for a short post-send retention grace window");
  assert(jobsSource.includes("wakeupRetentionGraceIsActive"), "jobs should detect recently sent wake-ups when deciding whether removal/pruning is safe");
  assert(jobsSource.includes("if (job.status === \"complete\" || job.status === \"cancelled\") {"), "job pruning should treat complete/cancelled retention as an explicit age-based policy under the wake-up-only model");
  assert(jobsSource.includes("return ageMs >= retention.complete;"), "complete/cancelled job pruning should no longer depend on synthetic notification state");
  assert(jobsSource.includes("getTerminalCleanupStaleReason"), "terminal cleanup reconcile should detect live-but-stale cleanup workers");
  assert(jobsSource.includes("Oracle terminal cleanup is stale"), "terminal cleanup reconcile should recover live workers whose terminal cleanup heartbeat is stale");
  assert(jobsSource.includes("notification delivery is in flight"), "terminal job removal should refuse jobs with an in-flight notification claim instead of deleting around wake-up delivery");
  assert(jobsSource.includes("post-send retention grace window"), "terminal job removal should refuse recently woken jobs until their response/artifact files survive a short post-send grace window");
  assert(jobsSource.includes("Retry after"), "terminal job removal should return the next eligible cleanup time when post-send retention grace blocks cleanup");
  assert(jobsSource.includes("Refusing to remove terminal oracle job"), "terminal job removal should refuse live terminal workers instead of deleting around them");
  assert(runtimeSource.includes("jobBlocksAdmission"), "runtime admission should delegate cleanup/worker blocking decisions to the shared job coordination helper");
  assert(runtimeSource.includes("isTrackedProcessAlive"), "runtime admission should use the shared tracked-process identity helper when evaluating live workers");
  assert(sharedLifecycleSource.includes("MAX_ORACLE_JOB_LIFECYCLE_EVENTS = 64"), "shared lifecycle helpers should bound stored lifecycle breadcrumbs to keep job state durable and reviewable");
  assert(sharedObservabilitySource.includes("formatOracleJobSummary"), "shared observability helpers should centralize detached job summary formatting");
  assert(sharedObservabilitySource.includes("terminal-event:"), "shared observability helpers should keep terminal lifecycle events prominent in detached job summaries");
  assert(sharedObservabilitySource.includes("response: unavailable yet"), "shared observability helpers should avoid showing response paths as ready when the response file does not exist yet");
  assert(sharedProcessSource.includes("spawnDetachedNodeProcess"), "shared process helpers should centralize detached process spawning semantics for worker handoff");
  assert(!runtimeSource.includes("Array.isArray(job.cleanupWarnings) && job.cleanupWarnings.length > 0"), "runtime admission should not treat cleanup warnings alone as live capacity blockers");
  assert(!runtimeSource.includes("if (report.warnings.length > 0) {\n    return report;\n  }"), "runtime cleanup should not retain leases solely because teardown leaves warnings");
  assert(runtimeSource.includes("await releaseConversationLease(runtime.conversationId)"), "runtime cleanup should always attempt to release conversation leases");
  assert(runtimeSource.includes("await releaseRuntimeLease(runtime.runtimeId)"), "runtime cleanup should always attempt to release runtime leases");
  assert(runtimeSource.includes("PROFILE_CLONE_TIMEOUT_MS = 120_000"), "runtime profile cloning should enforce a subprocess timeout");
  assert(toolsSource.includes("MAX_QUEUED_JOBS_PER_ACTIVE_RUNTIME"), "oracle submit should cap queued depth to avoid unbounded archive buildup");
  assert(toolsSource.includes("MAX_QUEUED_ARCHIVE_BYTES_PER_ACTIVE_RUNTIME"), "oracle submit should cap queued archive bytes to avoid filling tmp with queued jobs");
  assert(toolsSource.includes("hasRetainedPreSubmitArchive"), "queued archive pressure should count retained pre-submit archives, not just currently queued jobs");
  assert(toolsSource.includes("queued jobs and retained pre-submit archives"), "queued archive admission errors should explain that stranded pre-submit archives count against the byte cap");
  assert(pkg.files?.includes("prompts"), "package.json files should include prompts");
  assert(pkg.pi?.prompts?.includes("./prompts"), "package.json pi.prompts should include ./prompts");
  assert(pkg.engines?.node === ">=22", "package.json should advertise the actual Node.js support floor");
  assert(pkg.os?.includes("darwin"), "package.json should declare macOS-only support");
  assert(pkg.scripts?.test === "npm run verify:oracle", "package.json should expose the local verification gate through npm test");
  assert(pkg.scripts?.["typecheck:worker-helpers"] === "tsc --noEmit -p tsconfig.worker-helpers.json", "package.json should statically typecheck extracted worker/auth helpers");
  assert(String(pkg.scripts?.["verify:oracle"] || "").includes("typecheck:worker-helpers"), "full local verification should include worker/auth helper typechecking");
  assert(pkg.scripts?.prepublishOnly === "npm run verify:oracle", "package publishing should be guarded by the full local verification gate");
  assert(pkg.overrides?.["basic-ftp"] === "^5.2.2", "package.json should override basic-ftp to a patched version");
  assert(commandsSource.includes("Cancel a queued or active oracle job"), "oracle commands should allow queued-job cancellation");
  assert(commandsSource.includes("formatOracleJobSummary"), "oracle commands should format job status output through the shared observability helper");
  assert(commandsSource.includes("recently woken jobs may stay retained briefly"), "oracle-clean help text should mention the short post-send retention grace window");
  assert(commandsSource.includes("cleanup blockers or warnings"), "oracle-clean summary should not mislabel retention blockers as cleanup warnings only");
  assert(commandsSource.includes("shouldAdvanceQueueAfterCancellation(cancelled)"), "oracle cancel command should only promote queued jobs after a clean cancellation");
  assert(commandsSource.includes("Refusing to remove non-terminal oracle job"), "oracle clean should refuse queued jobs");
  assert(commandsSource.includes("getOracleConfigLoadDetails"), "oracle auth bootstrap should pass effective config-load metadata into the auth worker");
  assert(jobsSource.includes("report.attempted.push(\"queuedArchive\")"), "cleanup retry should treat queued archive deletion as a first-class cleanup target");
  assert(jobsSource.includes("Failed to remove queued archive"), "queued cleanup retries should preserve warnings when archive deletion keeps failing");
  assert(jobsSource.includes("if (cleanupReport.warnings.length > 0)"), "terminal cleanup should retain job state when cleanup reports warnings");
  assert(jobsSource.includes("cleanupPending: terminated"), "terminal cancellation/recovery should mark cleanup pending until teardown finishes");
  assert(jobsSource.includes("markOracleJobCreated"), "job creation should register durable lifecycle breadcrumbs through the shared lifecycle helper");
}

async function testResponseTimeoutGuard(): Promise<void> {
  const workerSource = await readFile(new URL("../extensions/oracle/worker/run-job.mjs", import.meta.url), "utf8");
  const authBootstrapSource = await readFile(new URL("../extensions/oracle/worker/auth-bootstrap.mjs", import.meta.url), "utf8");
  const stateLocksSource = await readFile(new URL("../extensions/oracle/worker/state-locks.mjs", import.meta.url), "utf8");
  const sharedStateSource = await readFile(new URL("../extensions/oracle/shared/state-coordination-helpers.mjs", import.meta.url), "utf8");
  const sharedJobCoordinationSource = await readFile(new URL("../extensions/oracle/shared/job-coordination-helpers.mjs", import.meta.url), "utf8");
  const sharedLifecycleSource = await readFile(new URL("../extensions/oracle/shared/job-lifecycle-helpers.mjs", import.meta.url), "utf8");
  const sharedObservabilitySource = await readFile(new URL("../extensions/oracle/shared/job-observability-helpers.mjs", import.meta.url), "utf8");
  const sharedProcessSource = await readFile(new URL("../extensions/oracle/shared/process-helpers.mjs", import.meta.url), "utf8");
  const queueSource = await readFile(new URL("../extensions/oracle/lib/queue.ts", import.meta.url), "utf8");
  const toolsSource = await readFile(new URL("../extensions/oracle/lib/tools.ts", import.meta.url), "utf8");
  const heuristicsSource = await readFile(new URL("../extensions/oracle/worker/artifact-heuristics.mjs", import.meta.url), "utf8");
  assert(workerSource.includes("Message delivery timed out"), "worker should detect ChatGPT response timeout text");
  assert(workerSource.includes("clicking Retry once"), "worker should retry one response-delivery failure before failing");
  assert(workerSource.includes("querySelectorAll('button, a')"), "worker should scan both button and link artifact controls");
  assert(workerSource.includes("ARTIFACT_DOWNLOAD_TIMEOUT_MS = 90_000"), "worker should keep the longer artifact download timeout");
  assert(workerSource.includes("POST_SEND_SETTLE_MS = 15_000"), "worker should wait 15 seconds after send before continuing");
  assert(workerSource.includes("promoteQueuedJobsAfterCleanup"), "worker should promote queued jobs after cleanup for autonomous queue advancement");
  assert(sharedJobCoordinationSource.includes("Queued oracle archive is missing:"), "cleanup-driven promotion should fail queued jobs whose archive is missing");
  assert(!workerSource.includes("if (!existsSync(current.archivePath)) continue;"), "cleanup-driven promotion should not silently skip archive-missing queued jobs");
  assert(workerSource.includes('if (["complete", "failed", "cancelled"].includes(String(latest.status || ""))) return latest;'), "cleanup-driven promotion failure should mark killed jobs terminal even if they advanced beyond submitted");
  assert(workerSource.includes("spawnDetachedNodeProcess"), "cleanup-driven worker promotion should capture worker start time through the shared detached-process helper");
  assert(!workerSource.includes("workerStartedAt: undefined"), "cleanup-driven worker promotion should not drop worker start time metadata");
  assert(sharedJobCoordinationSource.includes("if (job.workerPid) return true;"), "worker-side durable handoff checks should require a persisted pid");
  assert(!sharedJobCoordinationSource.includes('if (job.status === "waiting") return true;'), "worker-side durable handoff checks should not trust phase alone without a persisted pid");
  assert(sharedLifecycleSource.includes("transitionOracleJobPhase"), "worker/extension lifecycle changes should flow through the shared lifecycle transition helper");
  assert(workerSource.includes("await terminateWorkerPid(spawnedWorker.pid, spawnedWorker.workerStartedAt)"), "cleanup-driven queued promotion should terminate spawned workers when metadata persistence fails");
  assert(workerSource.includes("cleanupWarnings = await cleanupRuntime(job);"), "cleanup-driven queued promotion should tear down runtime artifacts after spawned-worker failures");
  assert(workerSource.includes("PROFILE_CLONE_TIMEOUT_MS = 120_000"), "worker runtime profile cloning should enforce a subprocess timeout");
  assert(workerSource.includes("jobBlocksAdmission"), "worker queued-promotion admission should delegate blocking checks to the shared job coordination helper");
  assert(workerSource.includes("from \"./state-locks.mjs\""), "worker should use the shared hardened state-lock helper instead of keeping divergent lock/lease crash recovery logic inline");
  assert(workerSource.includes("from \"./chatgpt-ui-helpers.mjs\""), "worker should use the shared ChatGPT UI helper module for model/origin/completion logic");
  assert(workerSource.includes("from \"./chatgpt-flow-helpers.mjs\""), "worker should use the extracted ChatGPT flow helper module for stable URL/snapshot logic");
  assert(workerSource.includes("deriveAssistantCompletionSignature"), "worker should route completion decisions through the shared assistant-completion helper");
  assert(authBootstrapSource.includes("from \"./state-locks.mjs\""), "auth bootstrap should use the shared hardened state-lock helper instead of keeping divergent auth-lock crash recovery logic inline");
  assert(authBootstrapSource.includes("from \"./chatgpt-ui-helpers.mjs\""), "auth bootstrap should use the shared ChatGPT origin helper so runtime/auth stay aligned");
  assert(authBootstrapSource.includes("from \"./auth-flow-helpers.mjs\""), "auth bootstrap should use the extracted auth flow helper module for probe normalization and page classification");
  assert(!authBootstrapSource.includes('"/tmp/oracle-auth'), "auth bootstrap should not write diagnostics to fixed /tmp/oracle-auth.* paths");
  assert(authBootstrapSource.includes('mkdtemp(join(tmpdir(), "pi-oracle-auth-"))'), "auth bootstrap should isolate diagnostics in a unique private temp directory per run");
  assert(authBootstrapSource.includes("AGENT_BROWSER_COMMAND_TIMEOUT_MS"), "auth bootstrap should enforce process-level timeouts for agent-browser commands");
  assert(authBootstrapSource.includes("PI_ORACLE_AUTH_CLOSE_TIMEOUT_MS"), "auth bootstrap should allow shorter timeout overrides for close-time smoke tests");
  assert(authBootstrapSource.includes("Object.hasOwn(maybeOptions, \"timeoutMs\")"), "auth bootstrap targetCommand should accept explicit timeout overrides");
  assert(authBootstrapSource.includes("timed out after"), "auth bootstrap subprocess wrapper should report timeout failures clearly");
  assert(authBootstrapSource.includes("Effective oracle auth config:"), "auth bootstrap failures should report the effective auth config path for the active agent dir");
  assert(!authBootstrapSource.includes("~/.pi/agent/extensions/oracle.json"), "auth bootstrap should not hardcode the default global config path in user-facing remediation guidance");
  assert(stateLocksSource.includes("state-coordination-helpers.mjs"), "worker state-lock wrappers should delegate to the shared state coordination helper module");
  assert(sharedStateSource.includes("ORACLE_METADATA_WRITE_GRACE_MS = 1_000"), "shared worker state-lock helper should use a bounded grace before reclaiming metadata-less state dirs");
  assert(sharedStateSource.includes("ORACLE_TMP_STATE_DIR_GRACE_MS = 60_000"), "shared worker state-lock helper should use a longer grace for in-flight .tmp-* dirs under concurrent sweep");
  assert(sharedStateSource.includes("createStateDirAtomically"), "shared worker state-lock helper should publish new state dirs atomically so first creation never exposes a final dir without metadata");
  assert(sharedStateSource.includes(".tmp-"), "shared worker state-lock helper should use hidden temp dir prefixes so fresh publishes are never mistaken for final lease/lock dirs");
  assert(sharedStateSource.includes("maybeReclaimIncompleteStateDir"), "shared worker state-lock helper should reclaim metadata-less state dirs left behind by crashes");
  assert(sharedStateSource.includes("await rename(tempPath, finalPath);"), "shared worker state-lock helper should atomically rename fully populated temp dirs into place for first publish");
  assert(sharedStateSource.includes("await rename(tempPath, targetPath);"), "shared worker state-lock helper should write metadata atomically via temp-file rename");
  assert(queueSource.includes("appendCleanupWarnings"), "global queued promotion should persist cleanup warnings from failed teardown");
  assert(queueSource.includes("runQueuedJobPromotionPass"), "global queued promotion should delegate the shared queued-promotion orchestration helper");
  assert(queueSource.includes("transitionOracleJobPhase"), "global queued promotion should apply queue state changes through the shared lifecycle helper");
  assert(toolsSource.includes("appendCleanupWarnings(job.id, cleanupReport.warnings)"), "submit failure teardown should persist cleanup warnings when runtime cleanup is incomplete");
  assert(toolsSource.includes("ARCHIVE_COMMAND_TIMEOUT_MS = 120_000"), "archive creation should enforce a subprocess timeout envelope");
  assert(toolsSource.includes("Oracle archive subprocess timed out after"), "archive creation should surface timeout failures clearly");
  assert(workerSource.includes("applyOracleJobCleanupWarnings"), "worker should persist cleanup warnings when runtime teardown is incomplete through the shared lifecycle helper");
  assert(workerSource.includes("Stopping queued cleanup promotion after"), "cleanup-driven queued promotion should stop when teardown leaves warnings");
  assert(workerSource.includes("if (existing?.jobId === job.id) return true;"), "cleanup-driven queued promotion should reuse same-job conversation leases during retry");
  assert(workerSource.includes("runQueuedJobPromotionPass"), "cleanup-driven queued promotion should reuse the shared queued-promotion orchestration helper");
  assert(sharedProcessSource.includes("terminateTrackedProcess"), "shared process helpers should centralize tracked-process termination semantics");
  assert(workerSource.includes("cleanupPending: true"), "worker should mark terminal jobs as cleanup-pending before teardown starts");
  assert(workerSource.includes("clearOracleJobCleanupState"), "worker should clear cleanup-pending through the shared lifecycle helper once teardown finishes");
  assert(workerSource.includes("if (cleanupWarnings.length === 0)"), "worker should only auto-promote queued jobs after a clean runtime teardown");
  assert(workerSource.includes("Skipping queued promotion because runtime cleanup left"), "worker should log when cleanup warnings block auto-promotion");
  assert(!workerSource.includes("Proceeding after model configuration timeout because strong in-dialog verification already succeeded"), "worker should not proceed if the model configuration sheet never closes");
  assert(sharedObservabilitySource.includes("buildOracleWakeupNotificationContent"), "shared observability helpers should centralize wake-up notification formatting");
  assert(sharedObservabilitySource.includes("Response file: unavailable yet"), "shared observability helpers should avoid implying that failed jobs already have a response file when they do not");
  assert(heuristicsSource.includes("GENERIC_ARTIFACT_LABELS"), "artifact heuristics should preserve generic attachment labels");
}

async function testArchiveDefaultExclusions(): Promise<void> {
  const fixtureDir = await mkdtemp(join(tmpdir(), "oracle-archive-sanity-"));
  const excludedOnlyDir = await mkdtemp(join(tmpdir(), "oracle-archive-empty-"));
  try {
    await mkdir(join(fixtureDir, "src", "build"), { recursive: true });
    await mkdir(join(fixtureDir, "build"), { recursive: true });
    await mkdir(join(fixtureDir, "dist"), { recursive: true });
    await mkdir(join(fixtureDir, "node_modules", "pkg"), { recursive: true });
    await mkdir(join(fixtureDir, "apps", "RalphMac", "target"), { recursive: true });
    await mkdir(join(fixtureDir, "packages", "app", ".yarn", "cache"), { recursive: true });
    await mkdir(join(fixtureDir, "linked"), { recursive: true });
    await mkdir(join(fixtureDir, "secrets"), { recursive: true });
    await mkdir(join(fixtureDir, "apps", "api", "secrets"), { recursive: true });
    await mkdir(join(fixtureDir, "apps", "api", ".secrets"), { recursive: true });
    await mkdir(join(fixtureDir, ".pi"), { recursive: true });
    await mkdir(join(fixtureDir, ".oracle-context", "jobs"), { recursive: true });
    await mkdir(join(fixtureDir, ".cursor"), { recursive: true });
    await writeFile(join(fixtureDir, "src", "build", "keeper.ts"), "export const keeper = true;\n");
    await writeFile(join(fixtureDir, "src", "regular.ts"), "export const regular = true;\n");
    await writeFile(join(fixtureDir, "build", "root-output.js"), "console.log('build');\n");
    await writeFile(join(fixtureDir, "dist", "root-output.js"), "console.log('dist');\n");
    await writeFile(join(fixtureDir, "node_modules", "pkg", "index.js"), "module.exports = {};\n");
    await writeFile(join(fixtureDir, "apps", "RalphMac", "target", "debug.bin"), "debug\n");
    await writeFile(join(fixtureDir, "packages", "app", ".yarn", "cache", "pkg.tgz"), "pkg\n");
    await writeFile(join(fixtureDir, ".env"), "API_KEY=secret\n");
    await writeFile(join(fixtureDir, ".env.example"), "API_KEY=example\n");
    await writeFile(join(fixtureDir, ".npmrc"), "//registry.npmjs.org/:_authToken=secret\n");
    await writeFile(join(fixtureDir, ".scratchpad.md"), "private notes\n");
    await writeFile(join(fixtureDir, "dev.sqlite"), "sqlite\n");
    await writeFile(join(fixtureDir, "secrets", "prod.pem"), "pem\n");
    await writeFile(join(fixtureDir, "apps", "api", "secrets", "service.pem"), "pem\n");
    await writeFile(join(fixtureDir, "apps", "api", ".secrets", "token.txt"), "token\n");
    await writeFile(join(fixtureDir, ".pi", "settings.json"), "{}\n");
    await writeFile(join(fixtureDir, ".oracle-context", "jobs", "job.json"), "{}\n");
    await writeFile(join(fixtureDir, ".cursor", "debug-22d6ee.log"), "debug\n");
    await symlink(join(fixtureDir, "src"), join(fixtureDir, "coverage"));
    await symlink(join(fixtureDir, "src"), join(fixtureDir, "linked", "node_modules"));

    const rootEntries = await resolveExpandedArchiveEntries(fixtureDir, ["."]);
    assert(rootEntries.includes("src/build/keeper.ts"), "root archive expansion should preserve legitimate nested src/build content");
    assert(rootEntries.includes("src/regular.ts"), "root archive expansion should preserve regular source files");
    assert(!rootEntries.includes("build/root-output.js"), "root archive expansion should exclude top-level build output");
    assert(!rootEntries.includes("dist/root-output.js"), "root archive expansion should exclude top-level dist output");
    assert(!rootEntries.includes("node_modules/pkg/index.js"), "root archive expansion should exclude node_modules anywhere");
    assert(!rootEntries.includes("apps/RalphMac/target/debug.bin"), "root archive expansion should exclude nested target directories anywhere");
    assert(!rootEntries.includes("packages/app/.yarn/cache/pkg.tgz"), "root archive expansion should exclude nested .yarn/cache content");
    assert(!rootEntries.includes(".env"), "root archive expansion should exclude .env files by default");
    assert(rootEntries.includes(".env.example"), "root archive expansion should preserve .env example files");
    assert(!rootEntries.includes(".npmrc"), "root archive expansion should exclude credential dotfiles by default");
    assert(!rootEntries.includes(".scratchpad.md"), "root archive expansion should exclude scratchpad notes by default");
    assert(!rootEntries.includes("dev.sqlite"), "root archive expansion should exclude local database files by default");
    assert(!rootEntries.includes(".pi/settings.json"), "root archive expansion should exclude local pi state by default");
    assert(!rootEntries.includes(".oracle-context/jobs/job.json"), "root archive expansion should exclude local oracle state by default");
    assert(!rootEntries.includes(".cursor/debug-22d6ee.log"), "root archive expansion should exclude local editor state by default");
    assert(!rootEntries.includes("secrets/prod.pem"), "root archive expansion should exclude root secrets directories by default");
    assert(!rootEntries.includes("apps/api/secrets/service.pem"), "root archive expansion should exclude nested secrets directories anywhere in the repo by default");
    assert(!rootEntries.includes("apps/api/.secrets/token.txt"), "root archive expansion should exclude nested dot-secrets directories anywhere in the repo by default");
    assert(!rootEntries.includes("coverage"), "root archive expansion should exclude symlinked top-level coverage directories");
    assert(!rootEntries.includes("linked/node_modules"), "root archive expansion should exclude symlinked nested node_modules directories");

    const srcEntries = await resolveExpandedArchiveEntries(fixtureDir, ["src"]);
    assert(srcEntries.includes("src/build/keeper.ts"), "explicit source-directory selection should preserve nested build-named directories");
    assert(srcEntries.includes("src/regular.ts"), "explicit source-directory selection should preserve regular source files");

    const explicitBuildDirEntries = await resolveExpandedArchiveEntries(fixtureDir, ["build"]);
    assert(explicitBuildDirEntries.includes("build/root-output.js"), "explicitly requested build directories should not be silently dropped");

    const explicitNodeModulesEntries = await resolveExpandedArchiveEntries(fixtureDir, ["node_modules"]);
    assert(explicitNodeModulesEntries.includes("node_modules/pkg/index.js"), "explicitly requested node_modules directories should include their subtree");

    const explicitYarnCacheEntries = await resolveExpandedArchiveEntries(fixtureDir, ["packages/app/.yarn/cache"]);
    assert(explicitYarnCacheEntries.includes("packages/app/.yarn/cache/pkg.tgz"), "explicitly requested .yarn/cache directories should include their subtree");

    const explicitPiEntries = await resolveExpandedArchiveEntries(fixtureDir, [".pi"]);
    assert(explicitPiEntries.includes(".pi/settings.json"), "explicitly requested .pi directories should be preserved");

    const explicitOracleContextEntries = await resolveExpandedArchiveEntries(fixtureDir, [".oracle-context"]);
    assert(explicitOracleContextEntries.includes(".oracle-context/jobs/job.json"), "explicitly requested .oracle-context directories should be preserved");

    const explicitCursorEntries = await resolveExpandedArchiveEntries(fixtureDir, [".cursor"]);
    assert(explicitCursorEntries.includes(".cursor/debug-22d6ee.log"), "explicitly requested .cursor directories should be preserved");

    const explicitBuildFileEntries = await resolveExpandedArchiveEntries(fixtureDir, ["build/root-output.js"]);
    assert(explicitBuildFileEntries.length === 1 && explicitBuildFileEntries[0] === "build/root-output.js", "explicitly requested files should always be preserved");

    const explicitEnvEntries = await resolveExpandedArchiveEntries(fixtureDir, [".env"]);
    assert(explicitEnvEntries.length === 1 && explicitEnvEntries[0] === ".env", "explicitly requested secret-bearing files should be preserved");

    const explicitScratchpadEntries = await resolveExpandedArchiveEntries(fixtureDir, [".scratchpad.md"]);
    assert(explicitScratchpadEntries.length === 1 && explicitScratchpadEntries[0] === ".scratchpad.md", "explicitly requested scratchpad files should be preserved");

    const explicitSecretsDirEntries = await resolveExpandedArchiveEntries(fixtureDir, ["secrets"]);
    assert(explicitSecretsDirEntries.includes("secrets/prod.pem"), "explicitly requested root secrets directories should be preserved");

    const explicitNestedSecretsEntries = await resolveExpandedArchiveEntries(fixtureDir, ["apps/api/secrets"]);
    assert(explicitNestedSecretsEntries.includes("apps/api/secrets/service.pem"), "explicitly requested nested secrets directories should be preserved");

    const explicitNestedDotSecretsEntries = await resolveExpandedArchiveEntries(fixtureDir, ["apps/api/.secrets"]);
    assert(explicitNestedDotSecretsEntries.includes("apps/api/.secrets/token.txt"), "explicitly requested nested dot-secrets directories should be preserved");

    const explicitCoverageSymlinkEntries = await resolveExpandedArchiveEntries(fixtureDir, ["coverage"]);
    assert(explicitCoverageSymlinkEntries.length === 1 && explicitCoverageSymlinkEntries[0] === "coverage", "explicitly requested excluded-directory symlinks should be preserved as explicit paths");

    const explicitNodeModulesSymlinkEntries = await resolveExpandedArchiveEntries(fixtureDir, ["linked/node_modules"]);
    assert(explicitNodeModulesSymlinkEntries.length === 1 && explicitNodeModulesSymlinkEntries[0] === "linked/node_modules", "explicitly requested nested excluded-directory symlinks should be preserved as explicit paths");

    await mkdir(join(excludedOnlyDir, "build"), { recursive: true });
    await writeFile(join(excludedOnlyDir, "build", "only.js"), "console.log('only');\n");
    const excludedOnlyEntries = await resolveExpandedArchiveEntries(excludedOnlyDir, ["."]);
    assert(excludedOnlyEntries.length === 0, "root expansion should drop only-excluded top-level outputs");
  } finally {
    await rm(fixtureDir, { recursive: true, force: true });
    await rm(excludedOnlyDir, { recursive: true, force: true });
  }
}

function testArchiveRejectsBlankInputs(): void {
  assertThrows(
    () => resolveArchiveInputs(process.cwd(), [""]),
    "archive input resolution should reject empty strings instead of widening to a whole-repo archive",
    "non-empty project-relative path",
  );
  assertThrows(
    () => resolveArchiveInputs(process.cwd(), ["   "]),
    "archive input resolution should reject whitespace-only strings instead of widening to a whole-repo archive",
    "non-empty project-relative path",
  );
  assertThrows(
    () => resolveArchiveInputs(process.cwd(), [" . "]),
    "archive input resolution should reject padded whole-repo sentinels so '.' remains the only explicit whole-repo archive selector",
    "must use '.' exactly",
  );
  assertThrows(
    () => resolveArchiveInputs(process.cwd(), ["./"]),
    "archive input resolution should reject './' so '.' remains the only explicit whole-repo archive selector",
    "must use '.' exactly",
  );
  assertThrows(
    () => resolveArchiveInputs(process.cwd(), ["extensions/.."]),
    "archive input resolution should reject aliases that normalize back to the project root so '.' remains the only explicit whole-repo archive selector",
    "must use '.' exactly",
  );
  const repoInputs = resolveArchiveInputs(process.cwd(), ["."]);
  assert(repoInputs.length === 1 && repoInputs[0]?.relative === ".", "archive input resolution should keep '.' as the explicit whole-repo sentinel");
}

async function testArchiveResolutionPreservesSignificantWhitespace(): Promise<void> {
  const fixtureDir = await mkdtemp(join(tmpdir(), "oracle-archive-whitespace-"));
  const spacedFile = " leading-space.md";
  try {
    await writeFile(join(fixtureDir, spacedFile), "notes\n", { encoding: "utf8", mode: 0o600 });
    const inputs = resolveArchiveInputs(fixtureDir, [spacedFile]);
    assert(inputs.length === 1 && inputs[0]?.relative === spacedFile, "archive input resolution should preserve exact path strings for real files with significant leading whitespace");
  } finally {
    await rm(fixtureDir, { recursive: true, force: true });
  }
}

async function testArchiveRejectsSymlinkEscapes(): Promise<void> {
  const fixtureDir = await mkdtemp(join(tmpdir(), "oracle-archive-symlink-"));
  const outsideDir = await mkdtemp(join(tmpdir(), "oracle-archive-outside-"));
  try {
    await mkdir(join(fixtureDir, "src"), { recursive: true });
    await writeFile(join(fixtureDir, "src", "inside.ts"), "export const inside = true;\n");
    await writeFile(join(outsideDir, "secret.txt"), "secret\n");
    await symlink(join(fixtureDir, "src"), join(fixtureDir, "linked-inside"));
    await symlink(outsideDir, join(fixtureDir, "linked-outside"));

    const insideInputs = resolveArchiveInputs(fixtureDir, ["linked-inside/inside.ts"]);
    assert(insideInputs.length === 1 && insideInputs[0]?.relative === "linked-inside/inside.ts", "archive input resolution should preserve symlinked paths that stay inside the repo");

    assertThrows(
      () => resolveArchiveInputs(fixtureDir, ["linked-outside/secret.txt"]),
      "archive input resolution should reject files that escape the repo through symlinked directories",
      "without symlink escapes",
    );
    assertThrows(
      () => resolveArchiveInputs(fixtureDir, ["linked-outside"]),
      "archive input resolution should reject explicit symlinks that resolve outside the repo",
      "without symlink escapes",
    );
  } finally {
    await rm(fixtureDir, { recursive: true, force: true });
    await rm(outsideDir, { recursive: true, force: true });
  }
}

async function testArchiveSubprocessTimeoutKillsHungChildren(): Promise<void> {
  const fixtureDir = await mkdtemp(join(tmpdir(), "oracle-archive-timeout-"));
  const binDir = await mkdtemp(join(tmpdir(), "oracle-archive-bin-"));
  const archivePath = join(tmpdir(), `oracle-archive-timeout-${randomUUID()}.tar.zst`);
  const tarPidPath = join(binDir, "tar.pid");
  const zstdPidPath = join(binDir, "zstd.pid");
  const originalPath = process.env.PATH ?? "";

  try {
    await mkdir(join(fixtureDir, "src"), { recursive: true });
    await writeFile(join(fixtureDir, "src", "main.ts"), "export const main = true;\n");
    await writeExecutableScript(
      join(binDir, "tar"),
      `#!/bin/sh
printf '%s\\n' "$$" > ${shellQuote(tarPidPath)}
trap 'exit 0' TERM INT
while :; do sleep 1; done
`,
    );
    await writeExecutableScript(
      join(binDir, "zstd"),
      `#!/bin/sh
printf '%s\\n' "$$" > ${shellQuote(zstdPidPath)}
trap 'exit 0' TERM INT
while :; do sleep 1; done
`,
    );
    process.env.PATH = `${binDir}:${originalPath}`;

    await assertRejects(
      () => createArchiveForTesting(fixtureDir, ["."], archivePath, { commandTimeoutMs: 250 }),
      "archive creation should time out when tar/zstd hang",
      "timed out",
    );

    const tarPid = Number.parseInt((await readFile(tarPidPath, "utf8")).trim(), 10);
    const zstdPid = Number.parseInt((await readFile(zstdPidPath, "utf8")).trim(), 10);
    assert(Number.isFinite(tarPid), "archive timeout test should record a tar pid");
    assert(Number.isFinite(zstdPid), "archive timeout test should record a zstd pid");
    assert(await waitForPidExit(tarPid), "archive timeout should terminate the hung tar process");
    assert(await waitForPidExit(zstdPid), "archive timeout should terminate the hung zstd process");
  } finally {
    process.env.PATH = originalPath;
    await rm(fixtureDir, { recursive: true, force: true });
    await rm(binDir, { recursive: true, force: true });
    await rm(archivePath, { force: true });
  }
}

async function testArchiveAutoPrunesNestedBuildDirsWhenWholeRepoIsTooLarge(): Promise<void> {
  const fixtureDir = await mkdtemp(join(tmpdir(), "oracle-archive-prune-"));
  const archivePath = join(tmpdir(), `oracle-archive-prune-${randomUUID()}.tar.zst`);
  try {
    await mkdir(join(fixtureDir, "apps", "RalphMac", "build"), { recursive: true });
    await mkdir(join(fixtureDir, "apps", "RalphMac", "src"), { recursive: true });
    await mkdir(join(fixtureDir, "src", "build"), { recursive: true });
    await writeFile(join(fixtureDir, "apps", "RalphMac", "src", "main.ts"), "export const main = true;\n");
    await writeFile(join(fixtureDir, "src", "build", "keeper.ts"), "export const keeper = true;\n");
    await writeFile(join(fixtureDir, "apps", "RalphMac", "build", "bundle.bin"), randomBytes(192 * 1024));

    const result = await createArchiveForTesting(fixtureDir, ["."], archivePath, {
      maxBytes: 96 * 1024,
      adaptivePruneMinBytes: 0,
    });

    assert(result.autoPrunedPrefixes.some((entry) => entry.relativePath === "apps/RalphMac/build"), "whole-repo archive creation should auto-prune oversized nested build directories");
    assert(!result.autoPrunedPrefixes.some((entry) => entry.relativePath === "src/build"), "whole-repo archive creation should not auto-prune build directories under source roots");
    assert(result.includedEntries.includes("src/build/keeper.ts"), "whole-repo archive creation should preserve legitimate src/build content after pruning");
    assert((result.initialArchiveBytes ?? 0) >= 96 * 1024, "whole-repo archive pruning test should begin over the size limit");
    assert(result.archiveBytes < 96 * 1024, "whole-repo archive pruning should reduce the archive below the configured limit");
  } finally {
    await rm(fixtureDir, { recursive: true, force: true });
    await rm(archivePath, { force: true });
  }
}

async function testArchiveAutoPrunesSubThresholdGeneratedDirsWhenWholeRepoIsTooLarge(): Promise<void> {
  const fixtureDir = await mkdtemp(join(tmpdir(), "oracle-archive-small-prune-"));
  const archivePath = join(tmpdir(), `oracle-archive-small-prune-${randomUUID()}.tar.zst`);
  try {
    await mkdir(join(fixtureDir, "apps", "Tiny", "build"), { recursive: true });
    await mkdir(join(fixtureDir, "src"), { recursive: true });
    await writeFile(join(fixtureDir, "src", "main.ts"), "export const main = true;\n");
    await writeFile(join(fixtureDir, "apps", "Tiny", "build", "bundle.bin"), randomBytes(12 * 1024));

    const result = await createArchiveForTesting(fixtureDir, ["."], archivePath, {
      maxBytes: 8 * 1024,
      adaptivePruneMinBytes: 0,
    });

    assert(result.autoPrunedPrefixes.some((entry) => entry.relativePath === "apps/Tiny/build"), "whole-repo archive creation should prune matching generated dirs even when they are below 4 MiB");
    assert((result.initialArchiveBytes ?? 0) >= 8 * 1024, "sub-threshold pruning test should begin over the size limit");
    assert(result.archiveBytes < 8 * 1024, "sub-threshold pruning should reduce the archive below the configured limit");
  } finally {
    await rm(fixtureDir, { recursive: true, force: true });
    await rm(archivePath, { force: true });
  }
}

function testDurableWorkerHandoff(): void {
  assert(!hasDurableWorkerHandoff({ status: "submitted", phase: "submitted", workerPid: undefined, workerStartedAt: undefined, heartbeatAt: undefined }), "plain submitted state should not count as durable worker handoff");
  assert(hasDurableWorkerHandoff({ status: "submitted", phase: "submitted", workerPid: 123, workerStartedAt: undefined, heartbeatAt: undefined }), "persisted worker pid should count as durable worker handoff");
  assert(!hasDurableWorkerHandoff({ status: "submitted", phase: "launching_browser", workerPid: undefined, workerStartedAt: "started", heartbeatAt: undefined }), "worker start time alone should not count as durable worker handoff without a persisted pid");
  assert(!hasDurableWorkerHandoff({ status: "waiting", phase: "launching_browser", workerPid: undefined, workerStartedAt: undefined, heartbeatAt: undefined }), "worker-advanced state without a persisted pid should not count as durable worker handoff");
}

function testSharedJobCoordinationHelpers(): void {
  const earlier = { id: "job-a", createdAt: "2026-01-01T00:00:00.000Z", queuedAt: "2026-01-01T00:00:05.000Z" };
  const later = { id: "job-b", createdAt: "2026-01-01T00:00:01.000Z", queuedAt: "2026-01-01T00:00:06.000Z" };
  assert(compareQueuedOracleJobs(earlier, later) < 0, "shared queue ordering should prefer earlier queuedAt timestamps");

  const runtimeMetadata = buildRuntimeLeaseMetadata({
    id: "job-runtime",
    runtimeId: "runtime-1",
    runtimeSessionName: "oracle-runtime-1",
    runtimeProfileDir: "/tmp/runtime-1",
    projectId: "/repo",
    sessionId: "/repo/.pi/session.jsonl",
  }, "2026-01-01T00:00:00.000Z");
  assert(runtimeMetadata.runtimeId === "runtime-1" && runtimeMetadata.jobId === "job-runtime", "shared runtime lease helpers should emit consistent lease metadata");

  const conversationMetadata = buildConversationLeaseMetadata({
    id: "job-conversation",
    conversationId: "conversation-1",
    projectId: "/repo",
    sessionId: "/repo/.pi/session.jsonl",
  }, "2026-01-01T00:00:00.000Z");
  assert(conversationMetadata?.conversationId === "conversation-1", "shared conversation lease helpers should emit conversation metadata when a conversation id exists");
  assert(buildConversationLeaseMetadata({ id: "job-none", projectId: "/repo", sessionId: "/repo/.pi/session.jsonl" }, "2026-01-01T00:00:00.000Z") === undefined, "shared conversation lease helpers should skip jobs without a conversation id");

  const liveWorker = (pid: number | undefined, startedAt?: string): boolean => pid === 42 && startedAt === "alive";
  assert(hasAdmissionBlockingWorker({ workerPid: 42, workerStartedAt: "alive" }, liveWorker), "shared admission helper should respect live worker identities");
  assert(!hasAdmissionBlockingWorker({ workerPid: 42, workerStartedAt: "stale" }, liveWorker), "shared admission helper should reject stale worker identities");
  assert(jobBlocksAdmission({ status: "submitted" }, liveWorker), "shared admission helper should block active submitted jobs");
  assert(jobBlocksAdmission({ cleanupPending: true }, liveWorker), "shared admission helper should block cleanup-pending jobs");
  assert(jobBlocksAdmission({ workerPid: 42, workerStartedAt: "alive" }, liveWorker), "shared admission helper should block jobs with a matching live worker");
  assert(!jobBlocksAdmission({ status: "failed", cleanupPending: false, workerPid: 42, workerStartedAt: "stale" }, liveWorker), "shared admission helper should ignore stale workers once the job is otherwise terminal and clean");
}

async function testSharedProcessHelpers(): Promise<void> {
  const fixtureDir = await mkdtemp(join(tmpdir(), "oracle-process-helpers-"));
  const scriptPath = join(fixtureDir, "linger.mjs");
  try {
    await writeFile(scriptPath, "setInterval(() => {}, 1000);\n", { encoding: "utf8", mode: 0o600 });
    const child = await spawnDetachedNodeProcess(scriptPath, []);
    assert(typeof child.pid === "number" && child.pid > 0, "shared process helpers should return a detached child pid");
    assert(typeof child.startedAt === "string" && child.startedAt.length > 0, "shared process helpers should capture a stable process start identity");
    assert(isTrackedProcessAlive(child.pid, child.startedAt), "shared process helpers should recognize a newly spawned tracked process as alive");
    const terminated = await terminateTrackedProcess(child.pid, child.startedAt, { termGraceMs: 1_000, killGraceMs: 1_000 });
    assert(terminated, "shared process helpers should terminate tracked detached processes");
    await sleep(200);
    assert(!isTrackedProcessAlive(child.pid, child.startedAt), "shared process helpers should observe the process as dead after termination");
  } finally {
    await rm(fixtureDir, { recursive: true, force: true });
  }
}

async function testSharedQueuedPromotionHelper(): Promise<void> {
  const fixtureDir = await mkdtemp(join(tmpdir(), "oracle-queued-promotion-"));
  try {
    const promoteArchive = join(fixtureDir, "promote.tar");
    const blockedArchive = join(fixtureDir, "blocked.tar");
    await writeFile(promoteArchive, "promote", "utf8");
    await writeFile(blockedArchive, "blocked", "utf8");

    type QueueJob = {
      id: string;
      archivePath: string;
      status: string;
      createdAt: string;
      queuedAt: string;
      runtimeId: string;
      runtimeProfileDir: string;
      runtimeSessionName: string;
      conversationId?: string;
      error?: string;
      workerPid?: number;
      workerStartedAt?: string;
      workerNonce?: string;
    };

    const jobs = new Map<string, QueueJob>([
      ["job-missing", { id: "job-missing", archivePath: join(fixtureDir, "missing.tar"), status: "queued", createdAt: "2026-01-01T00:00:00.000Z", queuedAt: "2026-01-01T00:00:00.000Z", runtimeId: "runtime-missing", runtimeProfileDir: "/tmp/runtime-missing", runtimeSessionName: "runtime-missing" }],
      ["job-promote", { id: "job-promote", archivePath: promoteArchive, status: "queued", createdAt: "2026-01-01T00:00:01.000Z", queuedAt: "2026-01-01T00:00:01.000Z", runtimeId: "runtime-promote", runtimeProfileDir: "/tmp/runtime-promote", runtimeSessionName: "runtime-promote", conversationId: "conversation-promote" }],
      ["job-blocked", { id: "job-blocked", archivePath: blockedArchive, status: "queued", createdAt: "2026-01-01T00:00:02.000Z", queuedAt: "2026-01-01T00:00:02.000Z", runtimeId: "runtime-blocked", runtimeProfileDir: "/tmp/runtime-blocked", runtimeSessionName: "runtime-blocked" }],
    ]);

    const failed: string[] = [];
    const releasedRuntime: string[] = [];
    const submitted: string[] = [];
    const persisted: string[] = [];
    const spawned: string[] = [];

    const result = await runQueuedJobPromotionPass<QueueJob, { pid: number; startedAt: string; nonce: string }>({
      listQueuedJobs: () => [...jobs.values()].filter((job) => job.status === "queued").sort(compareQueuedOracleJobs),
      refreshJob: (id) => jobs.get(id),
      readLatestJob: (id) => jobs.get(id),
      acquireRuntimeLease: async (job) => job.id !== "job-blocked",
      acquireConversationLease: async () => true,
      releaseRuntimeLease: async (job) => {
        releasedRuntime.push(job.id);
      },
      markSubmitted: async (job, at) => {
        const current = jobs.get(job.id)!;
        jobs.set(job.id, { ...current, status: "submitted", queuedAt: current.queuedAt, createdAt: current.createdAt });
        submitted.push(`${job.id}:${at}`);
      },
      spawnWorker: async (job) => {
        spawned.push(job.id);
        return { pid: 100 + spawned.length, startedAt: `started-${job.id}`, nonce: `nonce-${job.id}` };
      },
      persistWorker: async (job, worker) => {
        const current = jobs.get(job.id)!;
        jobs.set(job.id, { ...current, workerPid: worker.pid, workerStartedAt: worker.startedAt, workerNonce: worker.nonce });
        persisted.push(job.id);
      },
      isTerminalJob: (job) => ["complete", "failed", "cancelled"].includes(job.status),
      failQueuedPromotion: async (job, message) => {
        const current = jobs.get(job.id)!;
        jobs.set(job.id, { ...current, status: "failed", error: message });
        failed.push(job.id);
      },
      terminateSpawnedWorker: async () => {
        throw new Error("terminateSpawnedWorker should not run in the successful promotion pass");
      },
      cleanupAfterFailure: async () => undefined,
    });

    assert(result.promotedJobIds.length === 1 && result.promotedJobIds[0] === "job-promote", "shared queued promotion helper should promote successful queued jobs and stop once runtime capacity is exhausted");
    assert(failed.includes("job-missing"), "shared queued promotion helper should fail missing-archive queued jobs instead of silently skipping them");
    assert(submitted.some((entry) => entry.startsWith("job-promote:")), "shared queued promotion helper should mark promoted jobs submitted before spawning workers");
    assert(spawned.join(",") === "job-promote", "shared queued promotion helper should only spawn workers for promotable jobs before capacity blocks later entries");
    assert(persisted.join(",") === "job-promote", "shared queued promotion helper should persist worker metadata for successfully promoted jobs");
    assert(releasedRuntime.length === 0, "shared queued promotion helper should not release runtime leases on successful conversation acquisition");

    const durableArchive = join(fixtureDir, "durable.tar");
    await writeFile(durableArchive, "durable", "utf8");
    const durableJobs = new Map<string, QueueJob>([
      ["job-durable", { id: "job-durable", archivePath: durableArchive, status: "queued", createdAt: "2026-01-01T00:00:03.000Z", queuedAt: "2026-01-01T00:00:03.000Z", runtimeId: "runtime-durable", runtimeProfileDir: "/tmp/runtime-durable", runtimeSessionName: "runtime-durable" }],
    ]);
    const durableSignals: string[] = [];
    let terminateCalled = false;
    let cleanupCalled = false;

    const durableResult = await runQueuedJobPromotionPass<QueueJob, { pid: number; startedAt: string; nonce: string }>({
      listQueuedJobs: () => [...durableJobs.values()],
      refreshJob: (id) => durableJobs.get(id),
      readLatestJob: (id) => durableJobs.get(id),
      acquireRuntimeLease: async () => true,
      acquireConversationLease: async () => true,
      releaseRuntimeLease: async () => undefined,
      markSubmitted: async (job) => {
        const current = durableJobs.get(job.id)!;
        durableJobs.set(job.id, { ...current, status: "submitted" });
      },
      spawnWorker: async () => ({ pid: 201, startedAt: "started-durable", nonce: "nonce-durable" }),
      persistWorker: async (job, worker) => {
        const current = durableJobs.get(job.id)!;
        durableJobs.set(job.id, { ...current, workerPid: worker.pid, workerStartedAt: worker.startedAt, workerNonce: worker.nonce });
        throw new Error("persist-worker-metadata failed after durable handoff");
      },
      hasDurableWorkerHandoff: (job) => Boolean(job?.workerPid),
      isTerminalJob: (job) => ["complete", "failed", "cancelled"].includes(job.status),
      failQueuedPromotion: async () => {
        throw new Error("failQueuedPromotion should not run once durable handoff is observed");
      },
      terminateSpawnedWorker: async () => {
        terminateCalled = true;
      },
      cleanupAfterFailure: async () => {
        cleanupCalled = true;
        return undefined;
      },
      onDurableHandoff: async (job) => {
        durableSignals.push(job.id);
      },
    });

    assert(durableResult.promotedJobIds.length === 1 && durableResult.promotedJobIds[0] === "job-durable", "shared queued promotion helper should treat persisted worker metadata as a durable handoff even if a later write throws");
    assert(durableSignals.join(",") === "job-durable", "shared queued promotion helper should surface durable handoff callbacks for reconciliation/logging");
    assert(!terminateCalled && !cleanupCalled, "shared queued promotion helper should skip teardown once durable handoff has already been recorded");
  } finally {
    await rm(fixtureDir, { recursive: true, force: true });
  }
}

function testSharedLifecycleHelpers(): void {
  type LifecycleFixture = OracleLifecycleTrackedJobLike & {
    id: string;
    projectId: string;
    sessionId: string;
  };

  const created = markOracleJobCreated<LifecycleFixture>({
    id: "job-lifecycle",
    status: "queued",
    phase: "queued",
    phaseAt: "2026-01-01T00:00:00.000Z",
    createdAt: "2026-01-01T00:00:00.000Z",
    queuedAt: "2026-01-01T00:00:00.000Z",
    projectId: "/repo",
    sessionId: "/repo/.pi/session.jsonl",
  }, {
    at: "2026-01-01T00:00:00.000Z",
    source: "oracle:test",
    message: "Created queued lifecycle fixture.",
  });
  assert(getLatestOracleJobLifecycleEvent(created)?.message === "Created queued lifecycle fixture.", "shared lifecycle helpers should append an initial creation event");

  const submitted = transitionOracleJobPhase(created, "submitted", {
    at: "2026-01-01T00:00:05.000Z",
    source: "oracle:test",
    message: "Submitted lifecycle fixture.",
  });
  assert(submitted.status === "submitted" && submitted.submittedAt === "2026-01-01T00:00:05.000Z", "shared lifecycle helpers should derive submitted status/timestamps from submitted phase transitions");

  const waiting = transitionOracleJobPhase(submitted, "awaiting_response", {
    at: "2026-01-01T00:00:10.000Z",
    source: "oracle:test",
    message: "Waiting for response.",
    patch: { heartbeatAt: "2026-01-01T00:00:10.000Z" },
  });
  assert(waiting.status === "waiting" && waiting.heartbeatAt === "2026-01-01T00:00:10.000Z", "shared lifecycle helpers should map waiting phases onto waiting status");

  const complete = transitionOracleJobPhase(waiting, "complete_with_artifact_errors", {
    at: "2026-01-01T00:00:20.000Z",
    source: "oracle:test",
    message: "Completed with artifact warnings.",
    patch: {
      responsePath: "/tmp/response.md",
      responseFormat: "text/plain",
      artifactFailureCount: 2,
      cleanupPending: true,
    },
  });
  assert(complete.status === "complete" && complete.completedAt === "2026-01-01T00:00:20.000Z", "shared lifecycle helpers should derive complete status/timestamps from terminal completion phases");

  const withWarnings = applyOracleJobCleanupWarnings(complete, ["warning-a", "warning-a", "warning-b"], {
    at: "2026-01-01T00:00:25.000Z",
    source: "oracle:test",
    message: "Cleanup left warnings.",
  });
  assert(withWarnings.cleanupPending === false && withWarnings.cleanupWarnings?.join(",") === "warning-a,warning-b", "shared lifecycle helpers should dedupe cleanup warnings and clear cleanupPending");

  const cleaned = clearOracleJobCleanupState(withWarnings, {
    at: "2026-01-01T00:00:30.000Z",
    source: "oracle:test",
    message: "Cleanup finished cleanly.",
  });
  assert(cleaned.cleanupWarnings === undefined && cleaned.lastCleanupAt === "2026-01-01T00:00:30.000Z", "shared lifecycle helpers should clear cleanup warnings and retain cleanup timestamps");

  const wakeupRequested = noteOracleJobWakeupRequested(cleaned, {
    at: "2026-01-01T00:00:35.000Z",
    source: "oracle:test",
  });
  assert(wakeupRequested.wakeupAttemptCount === 1 && wakeupRequested.wakeupLastRequestedAt === "2026-01-01T00:00:35.000Z", "shared lifecycle helpers should count wake-up reminder attempts");

  const settled = markOracleJobWakeupSettled(wakeupRequested, {
    at: "2026-01-01T00:00:40.000Z",
    source: "oracle_read",
    sessionFile: "/repo/.pi/session.jsonl",
    sessionKey: "/repo::.pi/session.jsonl",
  });
  assert(settled.wakeupSettledSource === "oracle_read" && settled.wakeupSettledAt === "2026-01-01T00:00:40.000Z", "shared lifecycle helpers should settle wake-ups once a reminder attempt already exists");

  const observed = markOracleJobWakeupSettled(cleaned, {
    at: "2026-01-01T00:00:41.000Z",
    source: "oracle_status",
    sessionFile: "/repo/.pi/session.jsonl",
    sessionKey: "/repo::.pi/session.jsonl",
  });
  assert(!observed.wakeupSettledAt && observed.wakeupObservedSource === "oracle_status", "shared lifecycle helpers should record pre-send wake-up observations without suppressing the first reminder");

  const notified = markOracleJobNotified(appendOracleJobLifecycleEvent(settled, {
    at: "2026-01-01T00:00:45.000Z",
    source: "oracle:test",
    kind: "notification",
    message: "Notification target recorded.",
  }), {
    at: "2026-01-01T00:00:50.000Z",
    source: "oracle:test",
    notificationEntryId: "entry-1",
    notificationSessionKey: "project::session",
    notificationSessionFile: "/repo/.pi/session.jsonl",
  });
  assert(notified.notifiedAt === "2026-01-01T00:00:50.000Z" && notified.wakeupAttemptCount === 0 && !notified.notifyClaimedBy, "shared lifecycle helpers should clear wake-up claim/attempt state when delivery is recorded");
}

function testSharedObservabilityHelpers(): void {
  type ObservabilityFixture = OracleLifecycleTrackedJobLike & {
    id: string;
    projectId: string;
    sessionId: string;
    promptPath: string;
    archivePath: string;
    workerLogPath: string;
  };

  const job = markOracleJobCreated<ObservabilityFixture>({
    id: "job-observe",
    status: "queued",
    phase: "queued",
    phaseAt: "2026-01-01T00:00:00.000Z",
    createdAt: "2026-01-01T00:00:00.000Z",
    queuedAt: "2026-01-01T00:00:00.000Z",
    projectId: "/repo",
    sessionId: "/repo/.pi/session.jsonl",
    promptPath: "/tmp/prompt.md",
    archivePath: "/tmp/context.tar.zst",
    responsePath: "/tmp/response.md",
    responseFormat: "text/plain",
    workerLogPath: "/tmp/worker.log",
  }, {
    at: "2026-01-01T00:00:00.000Z",
    source: "oracle:test",
    message: "Created observability fixture.",
  });
  const summary = formatOracleJobSummary(job, {
    queuePosition: { position: 2, depth: 3 },
    artifactsPath: "/tmp/artifacts",
    responsePreview: "Preview body",
    responseAvailable: true,
  });
  assert(summary.includes("queue-position: 2 of 3 global") && summary.includes("last-event:"), "shared observability helpers should include queue position and latest lifecycle breadcrumbs in non-terminal job summaries");
  assert(summary.includes("worker-log: /tmp/worker.log") && summary.includes("Preview body") && summary.includes("response: /tmp/response.md"), "shared observability helpers should include worker log paths, visible response paths, and optional response previews");

  const failedSummary = formatOracleJobSummary(markOracleJobWakeupSettled(transitionOracleJobPhase(job, "failed", {
    at: "2026-01-01T00:00:20.000Z",
    source: "oracle:worker",
    message: "Job failed: missing auth seed profile.",
    patch: { error: "missing auth seed profile" },
  }), {
    at: "2026-01-01T00:00:25.000Z",
    source: "oracle_read",
    allowBeforeFirstAttempt: true,
  }), {
    artifactsPath: "/tmp/artifacts",
    responseAvailable: false,
  });
  assert(failedSummary.includes("terminal-event: 2026-01-01T00:00:20.000Z [oracle:worker] Job failed: missing auth seed profile."), "shared observability helpers should keep the terminal failure event prominent even after wake-up settlement bookkeeping");
  assert(failedSummary.includes("wakeup-event:") && !failedSummary.includes("response: /tmp/response.md"), "shared observability helpers should label wake-up bookkeeping separately and hide unavailable response paths from the summary");

  const submitResponse = formatOracleSubmitResponse(job, {
    autoPrunedPrefixes: [{ relativePath: "build", bytes: 2048 }],
    queued: true,
    queuePosition: 2,
    queueDepth: 3,
  });
  assert(submitResponse.includes("Oracle job queued: job-observe") && submitResponse.includes("Archive auto-pruned"), "shared observability helpers should format queued submit responses and auto-prune notes consistently");

  const wakeupContent = buildOracleWakeupNotificationContent(job, {
    responsePath: "/tmp/response.md",
    responseAvailable: true,
    artifactsPath: "/tmp/artifacts",
  });
  assert(wakeupContent.includes("Use oracle_read with jobId job-observe") && wakeupContent.includes("Last event:") && wakeupContent.includes("Response file: /tmp/response.md"), "shared observability helpers should include both the oracle_read guidance and the persisted response path when a response file exists");

  const failedWakeupContent = buildOracleWakeupNotificationContent(transitionOracleJobPhase(job, "failed", {
    at: "2026-01-01T00:00:20.000Z",
    source: "oracle:worker",
    message: "Job failed: missing auth seed profile.",
    patch: { error: "missing auth seed profile" },
  }), {
    responseAvailable: false,
    artifactsPath: "/tmp/artifacts",
  });
  assert(failedWakeupContent.includes("Response file: unavailable yet") && !failedWakeupContent.includes("Response file: /tmp/response.md"), "shared observability helpers should hide missing response paths in wake-up content for failed jobs without a saved response");

  assert(buildOracleStatusText({ active: 2, queued: 1 }) === "oracle: running (2), queued (1)", "shared observability helpers should format mixed active/queued session status text");
  assert(buildOracleStatusText({ active: 0, queued: 0 }) === "oracle: ready", "shared observability helpers should format empty session status text");
}

function testChatGptUiHelpers(): void {
  const closedThinkingSnapshot = [
    '- button "Thinking, click to remove" [ref=e110]',
    '- button "Thinking" [expanded=false, ref=e111]',
  ].join("\n");
  assert(
    snapshotStronglyMatchesRequestedModel(closedThinkingSnapshot, { modelFamily: "thinking", effort: "standard", autoSwitchToThinking: false }),
    "closed thinking snapshots should still verify the thinking family when effort is hidden after configuration closes",
  );
  assert(
    !snapshotCanSafelySkipModelConfiguration(closedThinkingSnapshot, { modelFamily: "thinking", effort: "standard", autoSwitchToThinking: false }),
    "closed thinking snapshots should not skip reopening model configuration when the requested effort is hidden",
  );

  const proWithStandardSnapshot = [
    '- button "Pro" [ref=e210]',
    '- combobox [ref=e211]: Standard',
  ].join("\n");
  assert(
    !snapshotStronglyMatchesRequestedModel(proWithStandardSnapshot, { modelFamily: "thinking", effort: "standard", autoSwitchToThinking: false }),
    "thinking presets should not verify on effort alone when the selected family is Pro",
  );
  assert(
    snapshotStronglyMatchesRequestedModel(proWithStandardSnapshot, { modelFamily: "pro", effort: "standard", autoSwitchToThinking: false }),
    "pro presets should still verify when the matching family and effort are visible",
  );

  const instantAutoSwitchOnSnapshot = [
    '- button "Instant, click to remove" [ref=e310]',
    '- button "Auto-switch to Thinking, checked" [ref=e311]',
  ].join("\n");
  assert(
    snapshotStronglyMatchesRequestedModel(instantAutoSwitchOnSnapshot, { modelFamily: "instant", autoSwitchToThinking: true }),
    "instant auto-switch presets should verify only when the toggle is visibly enabled",
  );
  assert(
    !snapshotStronglyMatchesRequestedModel(instantAutoSwitchOnSnapshot, { modelFamily: "instant", autoSwitchToThinking: false }),
    "plain instant presets should not verify when auto-switch is visibly enabled",
  );

  const closedProSnapshot = '- button "Model selector" [ref=e410]';
  assert(
    !snapshotWeaklyMatchesRequestedModel(closedProSnapshot, { modelFamily: "pro", effort: "standard", autoSwitchToThinking: false }),
    "closed snapshots without an explicit selected family should not weakly verify Pro",
  );

  const allowedOrigins = buildAllowedChatGptOrigins("https://chatgpt.com/", "https://chatgpt.com/auth/login");
  assert(allowedOrigins.includes("https://chatgpt.com"), "allowed ChatGPT origins should include chatgpt.com");
  assert(allowedOrigins.includes("https://chat.openai.com"), "allowed ChatGPT origins should include chat.openai.com even when config uses chatgpt.com");
  assert(allowedOrigins.includes("https://auth.openai.com"), "allowed ChatGPT origins should include auth.openai.com");

  assert(
    buildAssistantCompletionSignature({ responseText: "Answer body" }) === "text:Answer body",
    "text responses should complete from the normalized response body",
  );
  assert(
    deriveAssistantCompletionSignature({
      hasStopStreaming: false,
      hasTargetCopyResponse: true,
      responseText: "Answer body",
    }) === "text:Answer body",
    "text completion should require a completed turn with copy-response evidence",
  );
  assert(
    deriveAssistantCompletionSignature({
      hasStopStreaming: false,
      hasTargetCopyResponse: false,
      responseText: "",
      artifactLabels: ["report.csv"],
      suspiciousArtifactLabels: ["report.csv", "chart.png"],
    }) === "artifacts:chart.png|report.csv",
    "artifact-only responses should complete from stable artifact labels when no text body is present",
  );
  assert(
    deriveAssistantCompletionSignature({
      hasStopStreaming: true,
      hasTargetCopyResponse: false,
      responseText: "",
      artifactLabels: ["report.csv"],
    }) === undefined,
    "artifact-only completion should wait for streaming to stop before declaring the turn complete",
  );
}

function testAuthFlowHelpers(): void {
  const invalidProbe = normalizeLoginProbeResult(undefined);
  assert(invalidProbe.ok === false && invalidProbe.status === 0 && invalidProbe.error === "invalid-probe-result", "invalid login probe payloads should normalize to a safe fallback result");

  const normalizedProbe = normalizeLoginProbeResult({
    ok: true,
    status: 200,
    pageUrl: "https://chatgpt.com/",
    domLoginCta: false,
    onAuthPage: false,
    bodyKeys: ["id", 42, "email"],
    bodyHasId: true,
    bodyHasEmail: true,
    name: "Ada Lovelace",
  });
  assert(normalizedProbe.ok === true && normalizedProbe.bodyKeys?.join(",") === "id,email", "login probe normalization should preserve typed fields and drop invalid body keys");

  const chooserLabels = buildAccountChooserCandidateLabels("Ada Lovelace");
  assert(chooserLabels.length === 2 && chooserLabels[0] === "Ada Lovelace" && chooserLabels[1] === "Ada", "account chooser helpers should try both the full name and the first token");

  const allowedOrigins = buildAllowedChatGptOrigins("https://chatgpt.com/", "https://chatgpt.com/auth/login");
  const readySnapshot = [
    '- textbox "Chat with ChatGPT" [ref=e1]',
    '- button "Add files and more" [ref=e2]',
    '- button "Model selector" [ref=e3]',
  ].join("\n");

  const challengeState = classifyChatAuthPage({
    url: "https://chatgpt.com/",
    snapshot: readySnapshot,
    body: "Just a moment... verify you are human",
    probe: normalizedProbe,
    allowedOrigins,
    cookieSourceLabel: "Chrome profile Default",
    runtimeProfileDir: "/tmp/oracle-auth-profile",
    logPath: "/tmp/oracle-auth.log",
  });
  assert(challengeState.state === "challenge_blocking", "auth classification should prioritize human-verification challenge pages");

  const rejectedState = classifyChatAuthPage({
    url: "https://chatgpt.com/",
    snapshot: readySnapshot,
    body: "",
    probe: { ...normalizedProbe, ok: false, status: 401 },
    allowedOrigins,
    cookieSourceLabel: "Chrome profile Default",
    runtimeProfileDir: "/tmp/oracle-auth-profile",
    logPath: "/tmp/oracle-auth.log",
  });
  assert(rejectedState.state === "login_required", "auth classification should treat 401 probe results as login-required");

  const transitioningState = classifyChatAuthPage({
    url: "https://chatgpt.com/",
    snapshot: readySnapshot,
    body: "",
    probe: { ...normalizedProbe, domLoginCta: true, bodyHasEmail: true },
    allowedOrigins,
    cookieSourceLabel: "Chrome profile Default",
    runtimeProfileDir: "/tmp/oracle-auth-profile",
    logPath: "/tmp/oracle-auth.log",
  });
  assert(transitioningState.state === "auth_transitioning", "auth classification should treat CTA-visible authenticated shells as transitioning");

  const readyState = classifyChatAuthPage({
    url: "https://chatgpt.com/",
    snapshot: readySnapshot,
    body: "",
    probe: normalizedProbe,
    allowedOrigins,
    cookieSourceLabel: "Chrome profile Default",
    runtimeProfileDir: "/tmp/oracle-auth-profile",
    logPath: "/tmp/oracle-auth.log",
  });
  assert(readyState.state === "authenticated_and_ready", "auth classification should accept fully ready ChatGPT shells on allowed origins");

  const redirectedState = classifyChatAuthPage({
    url: "https://example.com/login",
    snapshot: readySnapshot,
    body: "",
    probe: normalizedProbe,
    allowedOrigins,
    cookieSourceLabel: "Chrome profile Default",
    runtimeProfileDir: "/tmp/oracle-auth-profile",
    logPath: "/tmp/oracle-auth.log",
  });
  assert(redirectedState.state === "login_required", "auth classification should reject redirects away from allowed ChatGPT origins");
}

function testChatGptFlowHelpers(): void {
  const snapshot = [
    '- heading "ChatGPT said:" [level=2, ref=e1]',
    '- paragraph [ref=e2]: First answer',
    '- heading "ChatGPT said:" [level=2, ref=e3]',
    '- paragraph [ref=e4]: Second answer',
    '- textbox "Chat with ChatGPT" [ref=e5]',
  ].join("\n");
  assert(
    assistantSnapshotSlice(snapshot, "Chat with ChatGPT", 1)?.includes("Second answer"),
    "conversation helpers should isolate the requested assistant snapshot slice",
  );
  assert(stripUrlQueryAndHash("https://chatgpt.com/c/abc?model=gpt#section") === "https://chatgpt.com/c/abc", "conversation helpers should strip query/hash components from ChatGPT URLs");
  assert(isConversationPathUrl("https://chatgpt.com/c/abc-123"), "conversation helpers should recognize ChatGPT conversation URLs");
  assert(!isConversationPathUrl("https://chatgpt.com/gpts"), "conversation helpers should reject non-conversation ChatGPT routes");
  assert(
    resolveStableConversationUrlCandidate("https://chatgpt.com/c/abc?model=gpt", undefined) === "https://chatgpt.com/c/abc",
    "conversation helpers should normalize direct conversation URLs into stable candidates",
  );
  assert(
    resolveStableConversationUrlCandidate("https://chatgpt.com/share/xyz?foo=1", "https://chatgpt.com/share/xyz") === "https://chatgpt.com/share/xyz",
    "conversation helpers should accept stable follow-up URLs when they match the previous chat URL",
  );
  assert(
    resolveStableConversationUrlCandidate("https://chatgpt.com/share/xyz", "https://chatgpt.com/share/other") === undefined,
    "conversation helpers should ignore unrelated non-conversation routes",
  );
  const firstStableState = nextStableValueState(undefined, "https://chatgpt.com/c/abc");
  const secondStableState = nextStableValueState(firstStableState, "https://chatgpt.com/c/abc");
  const resetStableState = nextStableValueState(secondStableState, "https://chatgpt.com/c/xyz");
  assert(firstStableState.stableCount === 1 && secondStableState.stableCount === 2 && resetStableState.stableCount === 1, "stable-value helpers should increment matching observations and reset on change");
}

async function testSanityRunnerIsolation(): Promise<void> {
  const runnerSource = await readFile(new URL("./oracle-sanity-runner.mjs", import.meta.url), "utf8");
  assert(runnerSource.includes("/tmp/pi-oracle-sanity-state-"), "sanity runner should force an isolated oracle state dir");
  assert(runnerSource.includes("/tmp/pi-oracle-sanity-jobs-"), "sanity runner should force an isolated oracle jobs dir");
  assert(!runnerSource.includes("process.env.PI_ORACLE_STATE_DIR?.trim()"), "sanity runner should not reuse inherited production state dir env");
  assert(!runnerSource.includes("process.env.PI_ORACLE_JOBS_DIR?.trim()"), "sanity runner should not reuse inherited production jobs dir env");
}

function testArtifactCandidateHeuristics(): void {
  assert(
    JSON.stringify(extractArtifactLabels("Created /mnt/data/butterscotch.txt")) === JSON.stringify(["butterscotch.txt"]),
    "artifact label extraction should collapse paths to basenames",
  );
  assert(
    JSON.stringify(extractArtifactLabels("dog.txt cat.txt")) === JSON.stringify(["dog.txt", "cat.txt"]),
    "artifact label extraction should preserve multiple filenames",
  );
  assert(
    JSON.stringify(extractArtifactLabels("hello\nbutterscotch.txt")) === JSON.stringify(["butterscotch.txt"]),
    "artifact label extraction should ignore surrounding prose lines",
  );

  const successCandidates = filterStructuralArtifactCandidates([
    {
      label: "sup-homie.txt",
      paragraphText: "Created the artifact: sup-homie.txt",
      listItemText: "",
      paragraphInteractiveCount: 1,
      paragraphArtifactLabelCount: 1,
      paragraphOtherTextLength: 21,
      listItemInteractiveCount: 0,
      listItemArtifactLabelCount: 0,
      focusableInteractiveCount: 1,
      focusableArtifactLabelCount: 1,
      focusableOtherTextLength: 21,
    },
    {
      label: "linked-download.txt",
      paragraphText: "linked-download.txt",
      listItemText: "linked-download.txt",
      paragraphInteractiveCount: 1,
      paragraphArtifactLabelCount: 1,
      paragraphOtherTextLength: 0,
      listItemInteractiveCount: 1,
      listItemArtifactLabelCount: 1,
      focusableInteractiveCount: 1,
      focusableArtifactLabelCount: 1,
      focusableOtherTextLength: 0,
    },
    {
      label: "Attached",
      paragraphText: "Attached",
      listItemText: "Attached",
      paragraphInteractiveCount: 1,
      paragraphArtifactLabelCount: 1,
      paragraphOtherTextLength: 0,
      listItemInteractiveCount: 1,
      listItemArtifactLabelCount: 1,
      focusableInteractiveCount: 1,
      focusableArtifactLabelCount: 1,
      focusableOtherTextLength: 0,
    },
    {
      label: "Done",
      paragraphText: "Done",
      listItemText: "Done",
      paragraphInteractiveCount: 1,
      paragraphArtifactLabelCount: 1,
      paragraphOtherTextLength: 0,
      listItemInteractiveCount: 1,
      listItemArtifactLabelCount: 1,
      focusableInteractiveCount: 1,
      focusableArtifactLabelCount: 1,
      focusableOtherTextLength: 0,
    },
    {
      label: "butterscotch.txt",
      controlLabel: "Download",
      paragraphText: "butterscotch.txt Download",
      listItemText: "butterscotch.txt Download",
      paragraphInteractiveCount: 1,
      paragraphArtifactLabelCount: 1,
      paragraphOtherTextLength: 0,
      listItemInteractiveCount: 1,
      listItemArtifactLabelCount: 1,
      focusableInteractiveCount: 1,
      focusableArtifactLabelCount: 1,
      focusableOtherTextLength: 0,
    },
  ]);
  assert(successCandidates.some((candidate) => candidate.label === "sup-homie.txt"), "artifact heuristics should preserve real downloadable artifacts");
  assert(successCandidates.some((candidate) => candidate.label === "linked-download.txt"), "artifact heuristics should preserve link-rendered downloadable artifacts");
  assert(successCandidates.some((candidate) => candidate.label === "Attached"), "artifact heuristics should preserve generic Attached download controls");
  assert(successCandidates.some((candidate) => candidate.label === "Done"), "artifact heuristics should preserve generic Done download controls");
  assert(successCandidates.some((candidate) => candidate.label === "butterscotch.txt"), "artifact heuristics should map generic Download controls onto nearby file labels");

  const falsePositiveCandidates = filterStructuralArtifactCandidates([
    {
      label: "package.json",
      paragraphText: "Related process issue: the current flow is still self-inconsistent. check:release starts with the clean-tree guard in package.json via scripts/check-clean-worktree.mjs, while the README says to regenerate provider QA bundles first and then run release check in README.md.",
      listItemText: "",
      paragraphInteractiveCount: 3,
      paragraphArtifactLabelCount: 3,
      paragraphOtherTextLength: 180,
      listItemInteractiveCount: 0,
      listItemArtifactLabelCount: 0,
      focusableInteractiveCount: 3,
      focusableArtifactLabelCount: 3,
      focusableOtherTextLength: 180,
    },
    {
      label: "scripts/check-clean-worktree.mjs",
      paragraphText: "Related process issue: the current flow is still self-inconsistent. check:release starts with the clean-tree guard in package.json via scripts/check-clean-worktree.mjs, while the README says to regenerate provider QA bundles first and then run release check in README.md.",
      listItemText: "",
      paragraphInteractiveCount: 3,
      paragraphArtifactLabelCount: 3,
      paragraphOtherTextLength: 180,
      listItemInteractiveCount: 0,
      listItemArtifactLabelCount: 0,
      focusableInteractiveCount: 3,
      focusableArtifactLabelCount: 3,
      focusableOtherTextLength: 180,
    },
  ]);
  assert(falsePositiveCandidates.length === 0, "artifact heuristics should ignore inline file-reference buttons in normal prose responses");

  const artifactOnlyCandidates = filterStructuralArtifactCandidates([
    {
      label: "report.csv",
      paragraphText: "report.csv",
      listItemText: "report.csv",
      paragraphInteractiveCount: 1,
      paragraphArtifactLabelCount: 1,
      paragraphOtherTextLength: 0,
      listItemInteractiveCount: 1,
      listItemArtifactLabelCount: 1,
      focusableInteractiveCount: 1,
      focusableArtifactLabelCount: 1,
      focusableOtherTextLength: 0,
    },
    {
      label: "dog.txt",
      paragraphText: "dog.txt cat.txt",
      listItemText: "",
      paragraphInteractiveCount: 2,
      paragraphArtifactLabelCount: 2,
      paragraphOtherTextLength: 0,
      listItemInteractiveCount: 0,
      listItemArtifactLabelCount: 0,
      focusableInteractiveCount: 2,
      focusableArtifactLabelCount: 2,
      focusableOtherTextLength: 8,
    },
    {
      label: "cat.txt",
      paragraphText: "dog.txt cat.txt",
      listItemText: "",
      paragraphInteractiveCount: 2,
      paragraphArtifactLabelCount: 2,
      paragraphOtherTextLength: 0,
      listItemInteractiveCount: 0,
      listItemArtifactLabelCount: 0,
      focusableInteractiveCount: 2,
      focusableArtifactLabelCount: 2,
      focusableOtherTextLength: 8,
    },
  ]);
  assert(artifactOnlyCandidates.some((candidate) => candidate.label === "report.csv"), "empty artifact-only responses should still allow artifact capture");
  assert(artifactOnlyCandidates.some((candidate) => candidate.label === "dog.txt"), "compact multi-file artifact blocks should still allow artifact capture");
  assert(artifactOnlyCandidates.some((candidate) => candidate.label === "cat.txt"), "compact multi-file artifact blocks should still allow artifact capture");

  const suspiciousOnlyCandidates = partitionStructuralArtifactCandidates([
    {
      label: "ghost.txt",
      controlLabel: "Download",
      paragraphText: "ghost.txt Download more context that makes the structure ambiguous and too long to trust safely in one shot",
      listItemText: "",
      paragraphInteractiveCount: 2,
      paragraphArtifactLabelCount: 1,
      paragraphOtherTextLength: 90,
      listItemInteractiveCount: 0,
      listItemArtifactLabelCount: 0,
      focusableInteractiveCount: 2,
      focusableArtifactLabelCount: 1,
      focusableOtherTextLength: 90,
    },
  ]);
  assert(suspiciousOnlyCandidates.confirmed.length === 0, "ambiguous download controls should not be treated as confirmed artifact candidates");
  assert(suspiciousOnlyCandidates.suspicious.some((candidate) => candidate.label === "ghost.txt"), "ambiguous download controls should still surface a suspicious artifact signal");
}

async function testPollerHostSafety(): Promise<void> {
  const sessionFile = "/tmp/oracle-sanity-session-host-safety.jsonl";
  const pi = createPiHarness();
  pi.sendMessage = () => undefined;
  const ctx = createExtensionCtx({ getSessionFile: () => sessionFile } as import("@mariozechner/pi-coding-agent").ExtensionContext["sessionManager"], {
    notifications: [],
    statuses: [],
    setStatus: () => undefined,
    theme: { fg: (_name: string, text: string) => text },
    notify: () => undefined,
  });

  let unhandled = 0;
  const onUnhandled = () => {
    unhandled += 1;
  };
  process.on("unhandledRejection", onUnhandled);
  try {
    await withGlobalReconcileLock({ source: "oracle-sanity-holder", processPid: process.pid }, async () => {
      startPoller(pi, ctx, 50, "/tmp/fake-oracle-worker.mjs");
      await sleep(250);
    });
    await sleep(150);
    stopPollerForSession(sessionFile, ctx.cwd);
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }

  assert(unhandled === 0, `expected no unhandled rejections, saw ${unhandled}`);
}

async function main() {
  await ensureNoActiveJobs();
  assert(DEFAULT_CONFIG.browser.maxConcurrentJobs === 2, "default oracle concurrency should be 2");
  const config: OracleConfig = {
    ...DEFAULT_CONFIG,
    browser: { ...DEFAULT_CONFIG.browser, maxConcurrentJobs: 1 },
  };

  testAuthCookiePolicy();
  await testRuntimeConversationLeases(config);
  await testCleanupPendingRecoveryUnblocksAdmission(config);
  await testCleanupPendingRecoveryTerminatesStaleLiveWorker(config);
  await testCleanupPendingBlocksAdmission(config);
  await testCleanupWarningsWithoutLiveWorkerDoNotBlockAdmission(config);
  await testRuntimeProfileCloneTimeoutKillsHungCp(config);
  await testAuthBootstrapAgentBrowserTimeoutFailsFast(config);
  await testAuthBootstrapReportsEffectiveConfigPaths(config);
  await testJobCreationPersistsSelectionSnapshot(config);
  await testOracleSubmitPresetGuardrails();
  await testOraclePreflightReportsBlockingReadinessStates();
  await testOracleSubmitPreflightRejectsKnownAuthSeedFailures();
  await testWorkspaceRootProjectIdentityCoversSubdirectories(config);
  await testWorkspaceRootFallsBackToProjectMarkersWithoutGit();
  await testOracleSubmitUsesWorkspaceRootForSubdirectoryCwd(config);
  await testOracleToolResultsExposeStructuredJobDetails(config);
  await testOracleReadAndStatusSummariesKeepTerminalFailuresProminent(config);
  await testOracleToolErrorsExposeStructuredMetadata();
  await testOracleCleanRefusesTerminalJobsWithinWakeupRetentionGrace(config);
  await testOracleCleanRefusesTerminalJobsWithLiveWorkers(config);
  await testStaleReconcileDoesNotOverwriteConcurrentCompletion(config);
  await testActiveCancellationDoesNotOverwriteCompletion(config);
  await testQueueAdmissionPromotionAndCancellation(config);
  await testQueuedPromotionUsesPersistedConfigSnapshot(config);
  await testQueuedPromotionRequiresArchiveReadiness(config);
  await testQueuedCancellationSerializesWithPromotion(config);
  await testCancelCleanupWarningsDoNotPromoteQueuedJobs(config);
  await testQueuedCleanupWarningsRetryArchiveDeletion(config);
  await testQueuedArchivePressureCountsRetainedCancelledPreSubmitArchives(config);
  await testCancelFailureDoesNotPromoteQueuedJobs(config);
  await testQueuedPromotionPersistsCleanupWarningsOnTeardownFailure(config);
  await testQueuedPromotionKillsWorkerWhenMetadataWriteFails(config);
  await testQueuedPromotionToleratesWorkerStateAdvance(config);
  await testQueuedPromotionReusesSameJobConversationLease(config);
  await testQueuedPromotionSkipsConversationBlockedJobs(config);
  await runPollerSanitySuite(config);
  await testStaleLockRecovery();
  await testDeadPidLockSweep();
  await testTmpLockDirGraceHonorsConfiguredWindow();
  await testTmpLockDirGracePreventsInFlightPublishReclaim();
  await testMetadataLessLockRecovery();
  await testMetadataLessConversationLeaseRecovery();
  await testWorkerAuthLockRecoversMetadataLessDir();
  await testWorkerConversationLeaseRecoversMetadataLessDir();
  await testTerminalCleanupWarningsPreserveJob(config);
  await testTerminalJobPruningAndCleanup(config);
  await testLifecycleEventCutover();
  await testOraclePromptTemplateCutover();
  await testResponseTimeoutGuard();
  await testArchiveDefaultExclusions();
  testArchiveRejectsBlankInputs();
  await testArchiveResolutionPreservesSignificantWhitespace();
  await testArchiveRejectsSymlinkEscapes();
  await testArchiveSubprocessTimeoutKillsHungChildren();
  await testArchiveAutoPrunesNestedBuildDirsWhenWholeRepoIsTooLarge();
  await testArchiveAutoPrunesSubThresholdGeneratedDirsWhenWholeRepoIsTooLarge();
  await testSanityRunnerIsolation();
  testDurableWorkerHandoff();
  testSharedJobCoordinationHelpers();
  await testSharedProcessHelpers();
  await testSharedQueuedPromotionHelper();
  testSharedLifecycleHelpers();
  testSharedObservabilityHelpers();
  testChatGptUiHelpers();
  testAuthFlowHelpers();
  testChatGptFlowHelpers();
  testArtifactCandidateHeuristics();
  await testPollerHostSafety();
  await resetOracleStateDir().catch(() => undefined);
  console.log("oracle sanity checks passed");
}

await main();
