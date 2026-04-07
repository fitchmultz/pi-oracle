import { createHash, randomBytes, randomUUID } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager, type SessionEntry } from "@mariozechner/pi-coding-agent";
import type { AssistantMessage } from "@mariozechner/pi-ai";
import { DEFAULT_CONFIG, type OracleConfig } from "../extensions/oracle/lib/config.ts";
import { ensureAccountCookie, filterImportableAuthCookies, type ImportedAuthCookie } from "../extensions/oracle/worker/auth-cookie-policy.mjs";
import { filterStructuralArtifactCandidates, parseSnapshotEntries } from "../extensions/oracle/worker/artifact-heuristics.mjs";
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
  readJob,
  reconcileStaleOracleJobs,
  removeTerminalOracleJob,
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
  readLeaseMetadata,
  releaseLease,
  releaseLock,
  sweepStaleLocks,
  withGlobalReconcileLock,
  writeLeaseMetadata,
} from "../extensions/oracle/lib/locks.ts";
import { getPollerSessionKey, scanOracleJobsOnce, startPoller, stopPollerForSession } from "../extensions/oracle/lib/poller.ts";
import { getQueuePosition, promoteQueuedJobs, promoteQueuedJobsWithinAdmissionLock } from "../extensions/oracle/lib/queue.ts";
import { acquireConversationLease, acquireRuntimeLease, getProjectId, releaseConversationLease, releaseRuntimeLease, tryAcquireConversationLease, tryAcquireRuntimeLease } from "../extensions/oracle/lib/runtime.ts";
import { createArchiveForTesting, registerOracleTools, resolveExpandedArchiveEntries } from "../extensions/oracle/lib/tools.ts";
import { registerOracleCommands } from "../extensions/oracle/lib/commands.ts";
import oracleExtension from "../extensions/oracle/index.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
  await rm(getOracleStateDir(), { recursive: true, force: true });
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
  },
) {
  const jobId = `sanity-job-${randomUUID()}`;
  const runtime = {
    runtimeId: `runtime-${randomUUID()}`,
    runtimeSessionName: `oracle-runtime-${randomUUID()}`,
    runtimeProfileDir: `/tmp/oracle-runtime-${randomUUID()}`,
    seedGeneration: new Date().toISOString(),
  };
  await createJob(
    jobId,
    {
      prompt: "sanity",
      files: ["docs/ORACLE_DESIGN.md"],
      modelFamily: "pro",
      effort: "standard",
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
  await rm(getOracleStateDir(), { recursive: true, force: true });
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
  await rm(getOracleStateDir(), { recursive: true, force: true });
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

async function testJobCreationNormalizesEffort(config: OracleConfig): Promise<void> {
  const cwd = process.cwd();
  const sessionId = "/tmp/oracle-sanity-session-normalize.jsonl";

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
      modelFamily: "thinking",
      requestSource: "tool",
    },
    cwd,
    sessionId,
    config,
    thinkingRuntime,
  );
  const thinkingJob = readJob(thinkingJobId);
  assert(thinkingJob?.effort === config.defaults.effort, "thinking jobs should inherit default effort when omitted");
  assert(thinkingJob?.autoSwitchToThinking === false, "thinking jobs should not enable autoSwitchToThinking");
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
      modelFamily: "instant",
      requestSource: "tool",
    },
    cwd,
    sessionId,
    config,
    instantRuntime,
  );
  const instantJob = readJob(instantJobId);
  assert(instantJob?.effort === undefined, "instant jobs should never persist an effort");
  await cleanupJob(instantJobId);
}

async function testCleanupPendingRecoveryTerminatesStaleLiveWorker(config: OracleConfig): Promise<void> {
  await rm(getOracleStateDir(), { recursive: true, force: true });
  const cwd = process.cwd();
  const sessionId = "/tmp/oracle-sanity-session-cleanup-pending-live-worker.jsonl";
  const jobId = await createTerminalJob(config, cwd, sessionId);
  const job = readJob(jobId);
  assert(job, "cleanup-pending live-worker recovery job should exist");
  const conversationId = `conversation-${randomUUID()}`;

  const holder = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000);"] , {
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

async function testOracleCleanRefusesTerminalJobsWithLiveWorkers(config: OracleConfig): Promise<void> {
  await rm(getOracleStateDir(), { recursive: true, force: true });
  const cwd = process.cwd();
  const fakeWorkerPath = join(tmpdir(), `oracle-sanity-clean-worker-${randomUUID()}.mjs`);
  await writeFile(fakeWorkerPath, "process.exit(0);\n", { mode: 0o600 });

  const pi: any = {
    tools: new Map<string, any>(),
    commands: new Map<string, any>(),
    registerTool(definition: any) {
      this.tools.set(definition.name, definition);
    },
    registerCommand(name: string, definition: any) {
      this.commands.set(name, definition);
    },
    sendMessage: () => {},
  };
  registerOracleCommands(pi, fakeWorkerPath, fakeWorkerPath);

  const cleanCommand = pi.commands.get("oracle-clean");
  assert(cleanCommand, "oracle clean command should register");

  const sessionFile = "/tmp/oracle-sanity-session-clean-live-worker.jsonl";
  const jobId = await createTerminalJob(config, cwd, sessionFile);
  const job = readJob(jobId);
  assert(job, "oracle clean live-worker job should exist");
  const conversationId = `conversation-${randomUUID()}`;

  const holder = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000);"] , {
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
  const ctx: any = {
    cwd,
    hasUI: true,
    sessionManager: { getSessionFile: () => sessionFile },
    ui,
  };

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
  await rm(getOracleStateDir(), { recursive: true, force: true });
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
  await rm(getOracleStateDir(), { recursive: true, force: true });
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
  await rm(getOracleStateDir(), { recursive: true, force: true });
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
  await rm(getOracleStateDir(), { recursive: true, force: true });
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
  await rm(getOracleStateDir(), { recursive: true, force: true });
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
  await rm(getOracleStateDir(), { recursive: true, force: true });
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
  await rm(getOracleStateDir(), { recursive: true, force: true });
  const cwd = process.cwd();
  const fakeWorkerPath = join(tmpdir(), `oracle-sanity-cancel-cleanup-worker-${randomUUID()}.mjs`);
  await writeFile(fakeWorkerPath, "process.exit(0);\n", { mode: 0o600 });

  const pi: any = {
    tools: new Map<string, any>(),
    commands: new Map<string, any>(),
    registerTool(definition: any) {
      this.tools.set(definition.name, definition);
    },
    registerCommand(name: string, definition: any) {
      this.commands.set(name, definition);
    },
    sendMessage: () => {},
  };
  registerOracleTools(pi, fakeWorkerPath);
  registerOracleCommands(pi, fakeWorkerPath, fakeWorkerPath);

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
    const ctx: any = {
      cwd,
      hasUI: false,
      sessionManager: { getSessionFile: () => sessionFile },
      ui,
    };

    try {
      if (kind === "tool") {
        await cancelTool.execute("oracle-cancel-cleanup-test", { jobId: cancellingId }, undefined, () => {}, ctx);
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

async function testCancelFailureDoesNotPromoteQueuedJobs(config: OracleConfig): Promise<void> {
  await rm(getOracleStateDir(), { recursive: true, force: true });
  const cwd = process.cwd();
  const fakeWorkerPath = join(tmpdir(), `oracle-sanity-cancel-worker-${randomUUID()}.mjs`);
  await writeFile(fakeWorkerPath, "process.exit(0);\n", { mode: 0o600 });

  const pi: any = {
    tools: new Map<string, any>(),
    commands: new Map<string, any>(),
    registerTool(definition: any) {
      this.tools.set(definition.name, definition);
    },
    registerCommand(name: string, definition: any) {
      this.commands.set(name, definition);
    },
    sendMessage: () => {},
  };
  registerOracleTools(pi, fakeWorkerPath);
  registerOracleCommands(pi, fakeWorkerPath, fakeWorkerPath);

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

    const stuckWorker = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000);"] , {
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
    const ctx: any = {
      cwd,
      hasUI: false,
      sessionManager: { getSessionFile: () => sessionFile },
      ui,
    };

    try {
      if (kind === "tool") {
        await cancelTool.execute("oracle-cancel-test", { jobId: activeId }, undefined, () => {}, ctx);
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
  await rm(getOracleStateDir(), { recursive: true, force: true });
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
  assert(listLeaseMetadata<{ jobId: string }>("runtime").some((lease) => lease.jobId === queuedId), "teardown-warning promotions should retain runtime leases while cleanup warnings remain unresolved");

  await releaseRuntimeLease(failedJob?.runtimeId);
  await cleanupJob(queuedId);
}

async function testQueuedPromotionKillsWorkerWhenMetadataWriteFails(config: OracleConfig): Promise<void> {
  await rm(getOracleStateDir(), { recursive: true, force: true });
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
  await rm(getOracleStateDir(), { recursive: true, force: true });
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
  await rm(getOracleStateDir(), { recursive: true, force: true });
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
  await rm(getOracleStateDir(), { recursive: true, force: true });
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

async function testNotificationClaims(config: OracleConfig): Promise<void> {
  const cwd = process.cwd();
  const sessionId = "/tmp/oracle-sanity-session-a.jsonl";
  const jobId = await createTerminalJob(config, cwd, sessionId);

  const [claimA, claimB] = await Promise.all([
    tryClaimNotification(jobId, "claimant-a"),
    tryClaimNotification(jobId, "claimant-b"),
  ]);
  assert(Boolean(claimA) !== Boolean(claimB), "exactly one concurrent notification claimant should win");
  const winner = claimA ? "claimant-a" : "claimant-b";
  await markJobNotified(jobId, winner);
  const notified = readJob(jobId);
  assert(notified?.notifiedAt, "winning claimant should mark job as notified");
  assert(!notified?.notifyClaimedAt && !notified?.notifyClaimedBy, "notification claim should be cleared after notify");

  const postNotifyClaim = await tryClaimNotification(jobId, "claimant-c");
  assert(!postNotifyClaim, "already-notified job must not be claimed again");
  await cleanupJob(jobId);
}

async function testMarkJobNotifiedRejectsStaleClaimant(config: OracleConfig): Promise<void> {
  const cwd = process.cwd();
  const sessionId = "/tmp/oracle-sanity-session-notify-stale-claim.jsonl";
  const jobId = await createTerminalJob(config, cwd, sessionId);

  await tryClaimNotification(jobId, "claimant-a");
  const staleClaimedAt = new Date(Date.now() - 2 * 60 * 1000).toISOString();
  await updateJob(jobId, (job) => ({
    ...job,
    notifyClaimedBy: "claimant-a",
    notifyClaimedAt: staleClaimedAt,
  }));

  const handoff = await tryClaimNotification(jobId, "claimant-b");
  assert(handoff?.notifyClaimedBy === "claimant-b", "expired notification claims should be claimable by a new claimant");

  let rejected = false;
  try {
    await markJobNotified(jobId, "claimant-a");
  } catch {
    rejected = true;
  }
  assert(rejected, "stale claimants must not finalize notification after ownership has handed off");
  const pending = readJob(jobId);
  assert(!pending?.notifiedAt, "rejected stale notification marks should leave the job undelivered");
  assert(pending?.notifyClaimedBy === "claimant-b", "rejected stale notification marks should preserve the current claim owner");

  await markJobNotified(jobId, "claimant-b");
  assert(Boolean(readJob(jobId)?.notifiedAt), "current notification claimant should still be able to finalize delivery");
  await cleanupJob(jobId);
}

async function testPollerNotification(config: OracleConfig): Promise<void> {
  const sessionManager = createPersistedSessionManager("poller");
  const sessionFile = sessionManager.getSessionFile();
  assert(sessionFile, "poller session manager should persist a session file");
  const jobId = await createJobForTest(config, process.cwd(), sessionFile, { initialState: "queued" });
  await promoteQueuedJobsWithinAdmissionLock({
    workerPath: "/tmp/fake-oracle-worker.mjs",
    source: "oracle-sanity-poller-promote",
    spawnWorkerFn: async () => ({ pid: 4545, nonce: "poller", startedAt: "poller" }),
  });
  await releaseRuntimeLease(readJob(jobId)?.runtimeId);
  await completeJob(jobId);

  const sent: Array<{ details?: { jobId?: string } }> = [];
  const pi: any = {
    sendMessage(message: any) {
      sent.push(message);
    },
  };
  const ctx: any = {
    cwd: process.cwd(),
    sessionManager,
    hasUI: true,
    ui: createUiStub(),
  };

  startPoller(pi, ctx, 50, "/tmp/fake-oracle-worker.mjs");
  await sleep(250);
  stopPollerForSession(sessionFile, ctx.cwd);

  const reopenedSession = SessionManager.open(sessionFile, undefined, process.cwd());
  assert(!findNotificationEntry(reopenedSession, jobId), "same-session live pollers should not append a durable oracle completion message directly into the active session history");
  assert(sent.length >= 1, `expected at least one best-effort wake-up request, saw ${sent.length}`);
  assert(sent[0]?.details?.jobId === jobId, "poller should request wake-up for the expected job id");
  assert(!readJob(jobId)?.notifiedAt, "same-session live pollers should leave jobs unnotified while completion delivery remains best-effort only");
  await cleanupJob(jobId);
}

async function testOracleSubmitRejectsMissingSessionIdentity(): Promise<void> {
  await rm(getOracleStateDir(), { recursive: true, force: true });
  const fakeWorkerPath = join(tmpdir(), `oracle-sanity-missing-session-worker-${randomUUID()}.mjs`);
  await writeFile(fakeWorkerPath, "process.exit(0);\n", { mode: 0o600 });

  const pi: any = {
    tools: new Map<string, any>(),
    registerTool(definition: any) {
      this.tools.set(definition.name, definition);
    },
    registerCommand: () => {},
    sendMessage: () => {},
  };
  registerOracleTools(pi, fakeWorkerPath);
  const submitTool = pi.tools.get("oracle_submit");
  assert(submitTool, "oracle submit tool should register");

  let rejected = false;
  try {
    await submitTool.execute("oracle-submit-missing-session", { prompt: "test", files: ["README.md"] }, undefined, () => {}, {
      cwd: process.cwd(),
      sessionManager: { getSessionFile: () => undefined },
      hasUI: true,
      ui: createUiStub(),
    });
  } catch (error) {
    rejected = error instanceof Error && error.message.includes("persisted pi session");
  }

  await rm(fakeWorkerPath, { force: true });
  assert(rejected, "oracle submit should reject contexts without a persisted session identity");
  assert(listOracleJobDirs().length === 0, "oracle submit should not persist jobs when session identity is unavailable");
}

async function testOracleReadUsesConfiguredJobsDir(config: OracleConfig): Promise<void> {
  await rm(getOracleStateDir(), { recursive: true, force: true });
  const fakeWorkerPath = join(tmpdir(), `oracle-sanity-read-worker-${randomUUID()}.mjs`);
  await writeFile(fakeWorkerPath, "process.exit(0);\n", { mode: 0o600 });

  const pi: any = {
    tools: new Map<string, any>(),
    registerTool(definition: any) {
      this.tools.set(definition.name, definition);
    },
    registerCommand: () => {},
    sendMessage: () => {},
  };
  registerOracleTools(pi, fakeWorkerPath);
  const readTool = pi.tools.get("oracle_read");
  assert(readTool, "oracle read tool should register");

  const sessionManager = createPersistedSessionManager("oracle-read-paths");
  const sessionFile = sessionManager.getSessionFile();
  assert(sessionFile, "oracle read test should persist a session file");
  const jobId = await createTerminalJob(config, process.cwd(), sessionFile);
  const expectedArtifactsPath = `${getJobDir(jobId)}/artifacts`;
  assert(!expectedArtifactsPath.startsWith(`/tmp/oracle-${jobId}/artifacts`), "sanity runner should use a non-default jobs dir for oracle read path coverage");

  try {
    const result = await readTool.execute("oracle-read-path-test", { jobId }, undefined, () => {}, {
      cwd: process.cwd(),
      sessionManager,
      hasUI: true,
      ui: createUiStub(),
    });
    const text = result?.content?.[0]?.text;
    assert(typeof text === "string", "oracle read should return text output");
    assert(text.includes(`artifacts: ${expectedArtifactsPath}`), "oracle read should report the configured jobs dir artifacts path");
    assert(!text.includes(`artifacts: /tmp/oracle-${jobId}/artifacts`), "oracle read should not hard-code the default /tmp oracle artifacts path");
  } finally {
    await rm(fakeWorkerPath, { force: true });
    await cleanupJob(jobId);
  }
}

async function testManualReadsSettleWakeupRetries(config: OracleConfig): Promise<void> {
  await rm(getOracleStateDir(), { recursive: true, force: true });
  const fakeWorkerPath = join(tmpdir(), `oracle-sanity-manual-read-worker-${randomUUID()}.mjs`);
  await writeFile(fakeWorkerPath, "process.exit(0);\n", { mode: 0o600 });

  const pi: any = {
    tools: new Map<string, any>(),
    commands: new Map<string, any>(),
    registerTool(definition: any) {
      this.tools.set(definition.name, definition);
    },
    registerCommand(name: string, definition: any) {
      this.commands.set(name, definition);
    },
    sendMessage: () => {},
  };
  registerOracleTools(pi, fakeWorkerPath);
  registerOracleCommands(pi, fakeWorkerPath, fakeWorkerPath);
  const readTool = pi.tools.get("oracle_read");
  const statusCommand = pi.commands.get("oracle-status");
  assert(readTool, "oracle read tool should register for wake-up settlement coverage");
  assert(statusCommand, "oracle status command should register for wake-up settlement coverage");

  const sessionManager = createPersistedSessionManager("oracle-manual-settle");
  const sessionFile = sessionManager.getSessionFile();
  assert(sessionFile, "manual read wake-up settlement test should persist a session file");
  const ctx: any = {
    cwd: process.cwd(),
    sessionManager,
    hasUI: true,
    ui: createUiStub(),
  };

  const setRetryEligible = async (jobId: string) => {
    await updateJob(jobId, (job) => ({
      ...job,
      wakeupAttemptCount: 1,
      wakeupLastRequestedAt: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
      wakeupSettledAt: undefined,
    }));
  };

  const assertNoFurtherWakeup = async (jobId: string, message: string) => {
    const sent: Array<{ details?: { jobId?: string } }> = [];
    await scanOracleJobsOnce({
      sendMessage(payload: any) {
        sent.push(payload);
      },
    } as any, createPollerCtx(sessionManager) as any, fakeWorkerPath);
    stopPollerForSession(sessionFile, process.cwd());
    assert(sent.length === 0, message);
  };

  const readJobId = await createTerminalJob(config, process.cwd(), sessionFile);
  try {
    await setRetryEligible(readJobId);
    await readTool.execute("oracle-read-settles-wakeup", { jobId: readJobId }, undefined, () => {}, ctx);
    assert(Boolean(readJob(readJobId)?.wakeupSettledAt), "oracle read should mark terminal jobs settled after a manual read");
    await assertNoFurtherWakeup(readJobId, "oracle read should stop further best-effort wake-up retries once the terminal job has been manually inspected");
  } finally {
    await cleanupJob(readJobId);
  }

  const statusJobId = await createTerminalJob(config, process.cwd(), sessionFile);
  try {
    await setRetryEligible(statusJobId);
    await statusCommand.handler(statusJobId, ctx);
    assert(Boolean(readJob(statusJobId)?.wakeupSettledAt), "oracle status should mark terminal jobs settled after a manual status read");
    await assertNoFurtherWakeup(statusJobId, "oracle status should stop further best-effort wake-up retries once the terminal job has been manually inspected");
  } finally {
    await cleanupJob(statusJobId);
    await rm(fakeWorkerPath, { force: true });
  }
}

async function testOracleExtensionSkipsNoSessionWakeupRouting(config: OracleConfig): Promise<void> {
  await rm(getOracleStateDir(), { recursive: true, force: true });
  const sessionManager = createPersistedSessionManager("poller-no-session-submit");
  const sessionFile = sessionManager.getSessionFile();
  assert(sessionFile, "no-session startup test should persist a submitter session file");
  const jobId = await createTerminalJob(config, process.cwd(), sessionFile);
  await updateJob(jobId, (job) => ({
    ...job,
    sessionId: `ephemeral:${getProjectId(process.cwd())}`,
    originSessionFile: undefined,
  }));

  const sent: Array<{ details?: { jobId?: string } }> = [];
  const handlers = new Map<string, any>();
  const pi: any = {
    tools: new Map<string, any>(),
    commands: new Map<string, any>(),
    registerTool(definition: any) {
      this.tools.set(definition.name, definition);
    },
    registerCommand(name: string, definition: any) {
      this.commands.set(name, definition);
    },
    on(event: string, handler: any) {
      handlers.set(event, handler);
    },
    sendMessage(message: any) {
      sent.push(message);
    },
  };
  oracleExtension(pi);
  const sessionStart = handlers.get("session_start");
  assert(sessionStart, "oracle extension should register a session_start handler");

  const ui = createUiStub();
  await sessionStart({}, {
    cwd: process.cwd(),
    sessionManager: { getSessionFile: () => undefined },
    hasUI: true,
    ui,
  });
  await sleep(250);

  assert(sent.length === 0, `oracle extension should not start wake-up routing for no-session contexts, saw ${sent.length}`);
  assert(ui.statuses.some((entry) => entry.value.includes("oracle: unavailable")), "oracle extension should mark oracle unavailable when the current session has no persisted identity");
  await cleanupJob(jobId);
}

async function testPersistedSessionsDoNotAdoptLegacyProjectScopedJobs(config: OracleConfig): Promise<void> {
  await rm(getOracleStateDir(), { recursive: true, force: true });
  const submitterSessionManager = createPersistedSessionManager("legacy-project-scoped-submit");
  const submitterSessionFile = submitterSessionManager.getSessionFile();
  assert(submitterSessionFile, "legacy project-scoped upgrade test should persist the original session file");
  const jobId = await createTerminalJob(config, process.cwd(), submitterSessionFile);
  await updateJob(jobId, (job) => ({
    ...job,
    sessionId: `ephemeral:${getProjectId(process.cwd())}`,
    originSessionFile: undefined,
    notificationSessionKey: undefined,
    notificationSessionFile: undefined,
    notifyClaimedAt: undefined,
    notifyClaimedBy: undefined,
    wakeupAttemptCount: 0,
    wakeupLastRequestedAt: undefined,
  }));

  const adopterSessionManager = createPersistedSessionManager("legacy-project-scoped-adopter");
  const adopterSessionFile = adopterSessionManager.getSessionFile();
  assert(adopterSessionFile, "legacy project-scoped upgrade test should persist the adopter session file");
  const sent: Array<{ details?: { jobId?: string } }> = [];
  await scanOracleJobsOnce({
    sendMessage(message: any) {
      sent.push(message);
    },
  } as any, createPollerCtx(adopterSessionManager) as any, "/tmp/fake-oracle-worker.mjs");
  stopPollerForSession(adopterSessionFile, process.cwd());

  const after = readJob(jobId);
  assert(after, "legacy project-scoped job should remain readable after scan");
  assert(sent.length === 0, `persisted sessions must not adopt legacy project-scoped jobs, saw ${sent.length} wake-ups`);
  assert(!after?.notifyClaimedBy, "legacy project-scoped jobs should not be claimed for wake-up delivery after upgrade");
  assert(!after?.notificationSessionFile, "legacy project-scoped jobs should not be rebound to a different persisted session after upgrade");
  assert(!after?.wakeupLastRequestedAt, "legacy project-scoped jobs should remain manual/status-only instead of emitting wake-ups after upgrade");
  await cleanupJob(jobId);
}

async function testPollerNotificationSkipsContestedSameSessionWriters(config: OracleConfig): Promise<void> {
  await rm(getOracleStateDir(), { recursive: true, force: true });
  const submitterSessionManager = createPersistedSessionManager("poller-same-session-deferred-submit");
  const adopterSessionManager = createPersistedSessionManager("poller-same-session-deferred-adopter");
  const submitterSessionFile = submitterSessionManager.getSessionFile();
  const adopterSessionFile = adopterSessionManager.getSessionFile();
  assert(submitterSessionFile && adopterSessionFile, "deferred same-session notification test should persist both session files");
  appendAssistantMessage(submitterSessionManager, "prime same-session history", { provider: "anthropic", model: "claude-sonnet-4" });
  const jobId = await createTerminalJob(config, process.cwd(), submitterSessionFile);

  const sameSessionSent: Array<{ details?: { jobId?: string } }> = [];
  const sameSessionPi: any = {
    sendMessage(message: any) {
      sameSessionSent.push(message);
    },
  };
  await scanOracleJobsOnce(sameSessionPi, createPollerCtx(submitterSessionManager) as any, "/tmp/fake-oracle-worker.mjs");

  const deferredSession = SessionManager.open(submitterSessionFile, undefined, process.cwd());
  assert(!findNotificationEntry(deferredSession, jobId), "same-session live pollers should defer durable completion messages instead of appending directly into the active session");
  assert(!readJob(jobId)?.notifiedAt, "same-session live pollers should leave jobs unnotified while completion delivery is best-effort only");
  assert(sameSessionSent.length >= 1, `same-session live pollers should still request at least one best-effort wake-up, saw ${sameSessionSent.length}`);
  stopPollerForSession(submitterSessionFile, process.cwd());
  await updateJob(jobId, (job) => ({
    ...job,
    wakeupLastRequestedAt: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
  }));

  const adopterSent: Array<{ details?: { jobId?: string } }> = [];
  const adopterPi: any = {
    sendMessage(message: any) {
      adopterSent.push(message);
    },
  };
  await scanOracleJobsOnce(adopterPi, createPollerCtx(adopterSessionManager) as any, "/tmp/fake-oracle-worker.mjs");

  const reopenedSubmitterSession = SessionManager.open(submitterSessionFile, undefined, process.cwd());
  assert(!findNotificationEntry(reopenedSubmitterSession, jobId), "off-session adopters should not append durable completion messages into the target session history");
  assert(!readJob(jobId)?.notifiedAt, "off-session adopters should still leave jobs unnotified while completion delivery is best-effort only");
  assert(adopterSent.length >= 1, `off-session adopters should still request at least one best-effort wake-up in the adopting live session, saw ${adopterSent.length}`);
  await cleanupJob(jobId);
}

async function testBranchedSameSessionSkipsDurableNotification(config: OracleConfig): Promise<void> {
  await rm(getOracleStateDir(), { recursive: true, force: true });
  const sessionManager = createPersistedSessionManager("poller-same-session-branched");
  const sessionFile = sessionManager.getSessionFile();
  assert(sessionFile, "branched same-session notification test should persist a session file");
  const branchBaseId = appendAssistantMessage(sessionManager, "branch base", { provider: "anthropic", model: "claude-sonnet-4" });
  const headEntryId = sessionManager.appendCustomEntry("oracle-sanity-head", { stage: "newer-head" });
  const branchedSessionManager = SessionManager.open(sessionFile, undefined, process.cwd());
  branchedSessionManager.branch(branchBaseId);
  const jobId = await createTerminalJob(config, process.cwd(), sessionFile);

  const sent: Array<{ details?: { jobId?: string } }> = [];
  const pi: any = {
    sendMessage(message: any) {
      sent.push(message);
    },
  };

  await scanOracleJobsOnce(pi, createPollerCtx(branchedSessionManager) as any, "/tmp/fake-oracle-worker.mjs");

  const reopenedSession = SessionManager.open(sessionFile, undefined, process.cwd());
  assert(reopenedSession.getEntries().some((entry) => entry.id === headEntryId), "branched same-session notification handling should preserve the on-disk head entry");
  assert(!findNotificationEntry(reopenedSession, jobId), "branched same-session notification handling should skip durable notification writes while the original session remains the live current session");
  assert(!readJob(jobId)?.notifiedAt, "branched same-session notification handling should leave the job unnotified while completion delivery is best-effort only");
  assert(sent.length >= 1, `branched same-session notification handling should still request a best-effort wake-up, saw ${sent.length}`);
  await cleanupJob(jobId);
}

async function testPreAssistantSameSessionNotificationPreservesInMemoryHistory(config: OracleConfig): Promise<void> {
  await rm(getOracleStateDir(), { recursive: true, force: true });
  const targetSessionManager = createPersistedSessionManager("poller-preassistant-history-target");
  const adopterSessionManager = createPersistedSessionManager("poller-preassistant-history-adopter");
  const targetSessionFile = targetSessionManager.getSessionFile();
  assert(targetSessionFile, "pre-assistant notification test should persist a target session file path");
  appendUserMessage(targetSessionManager, "check oracle completion");
  targetSessionManager.appendCustomEntry("oracle-sanity-preassistant", { stage: "before-assistant" });
  targetSessionManager.appendModelChange("anthropic", "claude-sonnet-4");
  const preFlushSnapshot = SessionManager.open(targetSessionFile, undefined, process.cwd());
  assert(preFlushSnapshot.getEntries().length === 0, "pre-assistant notification test should start with in-memory-only session history before the first assistant message flushes it");

  const jobId = await createTerminalJob(config, process.cwd(), targetSessionFile);
  const liveSent: Array<{ details?: { jobId?: string } }> = [];
  const livePi: any = {
    sendMessage(message: any) {
      liveSent.push(message);
    },
  };

  await scanOracleJobsOnce(livePi, createPollerCtx(targetSessionManager) as any, "/tmp/fake-oracle-worker.mjs");

  assert(!(await pathExists(targetSessionFile)), "pre-assistant same-session notification handling should not create a notification-only target session file while history is still in memory");
  const deferredSession = SessionManager.open(targetSessionFile, undefined, process.cwd());
  assert(deferredSession.getEntries().length === 0, "pre-assistant same-session notification handling should preserve in-memory-only history by avoiding any direct durable append");
  assert(!findNotificationEntry(deferredSession, jobId), "pre-assistant same-session notification handling should defer durable completion messages while the target session is not durably materialized");
  assert(liveSent.length >= 1, `pre-assistant same-session notification handling should still request at least one best-effort wake-up, saw ${liveSent.length}`);
  assert(!readJob(jobId)?.notifiedAt, "pre-assistant same-session notification handling should leave the job unnotified while completion delivery is best-effort only");

  appendAssistantMessage(targetSessionManager, "materialize original target session history", { provider: "anthropic", model: "claude-sonnet-4" });
  assert(await pathExists(targetSessionFile), "materializing the original target session should create the durable target session file before adoption");
  stopPollerForSession(targetSessionFile, process.cwd());
  await updateJob(jobId, (job) => ({
    ...job,
    wakeupLastRequestedAt: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
  }));

  const adopterSent: Array<{ details?: { jobId?: string } }> = [];
  const adopterPi: any = {
    sendMessage(message: any) {
      adopterSent.push(message);
    },
  };
  await scanOracleJobsOnce(adopterPi, createPollerCtx(adopterSessionManager) as any, "/tmp/fake-oracle-worker.mjs");

  const reopenedSession = SessionManager.open(targetSessionFile, undefined, process.cwd());
  assert(!findNotificationEntry(reopenedSession, jobId), "off-session adopters should still avoid durable completion-message writes even after the target session later materializes on disk");
  assert(!readJob(jobId)?.notifiedAt, "off-session adopters should leave the job unnotified while completion delivery remains best-effort only");
  assert(adopterSent.length >= 1, `off-session adopters should request at least one best-effort wake-up from the adopting session, saw ${adopterSent.length}`);
  await cleanupJob(jobId);
}

async function testPreAssistantBranchedSameSessionSkipsDurableNotification(config: OracleConfig): Promise<void> {
  await rm(getOracleStateDir(), { recursive: true, force: true });
  const sessionManager = createPersistedSessionManager("poller-preassistant-branched");
  const sessionFile = sessionManager.getSessionFile();
  assert(sessionFile, "pre-assistant branched notification test should persist a session file");
  const userEntryId = appendUserMessage(sessionManager, "branch before oracle completion");
  sessionManager.appendCustomEntry("oracle-sanity-preassistant-branched", { stage: "before-assistant" });
  const modelEntryId = sessionManager.appendModelChange("anthropic", "claude-sonnet-4");
  const branchedSessionManager = sessionManager;
  branchedSessionManager.branch(userEntryId);
  const jobId = await createTerminalJob(config, process.cwd(), sessionFile);

  const sent: Array<{ details?: { jobId?: string } }> = [];
  const pi: any = {
    sendMessage(message: any) {
      sent.push(message);
    },
  };

  await scanOracleJobsOnce(pi, createPollerCtx(branchedSessionManager) as any, "/tmp/fake-oracle-worker.mjs");

  const skippedSession = SessionManager.open(sessionFile, undefined, process.cwd());
  assert(skippedSession.getEntries().length === 0, "pre-assistant branched same-session notification handling should not flush hidden history by attempting a direct durable append from an older leaf");
  assert(!findNotificationEntry(skippedSession, jobId), "pre-assistant branched same-session notification handling should skip durable notification writes while the live leaf is behind newer in-memory history");
  assert(!readJob(jobId)?.notifiedAt, "pre-assistant branched same-session notification handling should leave the job unnotified while completion delivery is best-effort only");
  assert(sent.length >= 1, `pre-assistant branched same-session notification handling should still request at least one best-effort wake-up, saw ${sent.length}`);

  branchedSessionManager.branch(modelEntryId);
  await scanOracleJobsOnce(pi, createPollerCtx(branchedSessionManager) as any, "/tmp/fake-oracle-worker.mjs");
  assert(!findNotificationEntry(SessionManager.open(sessionFile, undefined, process.cwd()), jobId), "restoring the latest in-memory leaf in the live same-session manager should still avoid durable completion-message writes under the best-effort-only model");
  await cleanupJob(jobId);
}

async function testNotificationMessagePreservesSessionModel(config: OracleConfig): Promise<void> {
  await rm(getOracleStateDir(), { recursive: true, force: true });
  const targetSessionManager = createPersistedSessionManager("poller-notification-model-target");
  const adopterSessionManager = createPersistedSessionManager("poller-notification-model-adopter");
  const targetSessionFile = targetSessionManager.getSessionFile();
  assert(targetSessionFile, "notification model test should persist a target session file");
  appendAssistantMessage(targetSessionManager, "prime session history", { provider: "openai", model: "gpt-5" });
  targetSessionManager.appendModelChange("anthropic", "claude-sonnet-4");

  const modelBefore = SessionManager.open(targetSessionFile, undefined, process.cwd()).buildSessionContext().model;
  assert(modelBefore?.provider === "anthropic" && modelBefore?.modelId === "claude-sonnet-4", "notification model test should start from an explicit target-session model");

  const jobId = await createTerminalJob(config, process.cwd(), targetSessionFile);
  const sent: Array<{ details?: { jobId?: string } }> = [];
  const pi: any = {
    sendMessage(message: any) {
      sent.push(message);
    },
  };

  await scanOracleJobsOnce(pi, createPollerCtx(adopterSessionManager) as any, "/tmp/fake-oracle-worker.mjs");

  const reopenedSession = SessionManager.open(targetSessionFile, undefined, process.cwd());
  const modelAfter = reopenedSession.buildSessionContext().model;
  assert(modelAfter?.provider === modelBefore.provider && modelAfter?.modelId === modelBefore.modelId, "best-effort-only completion delivery should preserve the target-session model used for resume");
  assert(!findNotificationEntry(reopenedSession, jobId), "best-effort-only completion delivery should not append a synthetic assistant notification message into the target session");
  assert(!readJob(jobId)?.notifiedAt, "best-effort-only completion delivery should leave the job unnotified while no durable session-history append exists");
  assert(sent.length >= 1, `expected notification model preservation test to request at least one wake-up, saw ${sent.length}`);
  await cleanupJob(jobId);
}

async function testPollerNotificationAdoptsOrphanedSessionJobs(config: OracleConfig): Promise<void> {
  const submitterSessionManager = createPersistedSessionManager("poller-orphaned-submit");
  const liveSessionManager = createPersistedSessionManager("poller-orphaned-live");
  const submitterSessionFile = submitterSessionManager.getSessionFile();
  const liveSessionFile = liveSessionManager.getSessionFile();
  assert(submitterSessionFile && liveSessionFile, "orphaned poller test should persist both session files");
  appendAssistantMessage(submitterSessionManager, "prime orphaned target history", { provider: "anthropic", model: "claude-sonnet-4" });
  const jobId = await createTerminalJob(config, process.cwd(), submitterSessionFile);

  const sent: Array<{ details?: { jobId?: string } }> = [];
  const pi: any = {
    sendMessage(message: any) {
      sent.push(message);
    },
  };
  const ctx: any = {
    cwd: process.cwd(),
    sessionManager: liveSessionManager,
    hasUI: true,
    ui: createUiStub(),
  };

  startPoller(pi, ctx, 50, "/tmp/fake-oracle-worker.mjs");
  await sleep(250);
  stopPollerForSession(liveSessionFile, ctx.cwd);

  assert(!findNotificationEntry(SessionManager.open(submitterSessionFile, undefined, process.cwd()), jobId), "adopted orphaned jobs should not append a durable completion message into the original target session under the wake-up-only model");
  assert(sent.length >= 1, `expected orphaned job to trigger at least one wake-up request, saw ${sent.length}`);
  assert(sent[0]?.details?.jobId === jobId, "live poller should notify for orphaned jobs in the same project");
  assert(!readJob(jobId)?.notifiedAt, "adopted orphaned jobs should remain unnotified while completion delivery is best-effort only");
  await cleanupJob(jobId);
}

async function testPollerDoesNotStealNotificationFromLiveSessionTarget(config: OracleConfig): Promise<void> {
  await rm(getOracleStateDir(), { recursive: true, force: true });
  const submitterSessionManager = createPersistedSessionManager("poller-live-submit");
  const liveSessionManager = createPersistedSessionManager("poller-live-other");
  const submitterSessionFile = submitterSessionManager.getSessionFile();
  const liveSessionFile = liveSessionManager.getSessionFile();
  assert(submitterSessionFile && liveSessionFile, "live-target poller test should persist both session files");
  const jobId = await createTerminalJob(config, process.cwd(), submitterSessionFile);
  const job = readJob(jobId);
  assert(job, "live-target notification job should exist");

  const holder = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000);"] , {
    detached: true,
    stdio: "ignore",
  });
  holder.unref();
  const holderPid = holder.pid;
  assert(holderPid !== undefined, "live-target holder should expose a pid");
  const holderStartedAt = readProcessStartedAt(holderPid);
  const wakeupTargetLeaseKey = `${job.projectId}::${job.sessionId}::${holderPid}::${holderStartedAt || "unknown"}`;
  await writeLeaseMetadata("wakeup-target", wakeupTargetLeaseKey, {
    leaseKey: wakeupTargetLeaseKey,
    projectId: job.projectId,
    sessionId: job.sessionId,
    processPid: holderPid,
    processStartedAt: holderStartedAt,
    updatedAt: new Date().toISOString(),
  });

  const sent: Array<{ details?: { jobId?: string } }> = [];
  const pi: any = {
    sendMessage(message: any) {
      sent.push(message);
    },
  };
  const ctx: any = {
    cwd: process.cwd(),
    sessionManager: liveSessionManager,
    hasUI: true,
    ui: createUiStub(),
  };

  try {
    startPoller(pi, ctx, 50, "/tmp/fake-oracle-worker.mjs");
    await sleep(250);
    stopPollerForSession(liveSessionFile, ctx.cwd);

    assert(sent.length === 0, `expected no notification theft while the original session target is live, saw ${sent.length}`);
    assert(!readJob(jobId)?.notifiedAt, "jobs with a live wake-up target should remain unclaimed by other sessions");
  } finally {
    if (isPidAlive(holderPid)) process.kill(holderPid, "SIGKILL");
    await waitForPidExit(holderPid);
    await releaseLease("wakeup-target", wakeupTargetLeaseKey);
    await cleanupJob(jobId);
  }
}

async function testFreshWakeupTargetLeasePublishIsAtomic(): Promise<void> {
  await rm(getOracleStateDir(), { recursive: true, force: true });
  const wakeupTargetLeaseKey = `fresh-wakeup-target-${randomUUID()}`;
  const leasesDir = getLeasesDir();
  const leasePath = hashedOracleStatePath("wakeup-target", wakeupTargetLeaseKey, leasesDir);
  const finalLeaseDirName = leasePath.split("/").pop() || "";
  let settled = false;
  const publishPromise = writeLeaseMetadata("wakeup-target", wakeupTargetLeaseKey, {
    leaseKey: wakeupTargetLeaseKey,
    projectId: process.cwd(),
    sessionId: "/tmp/oracle-sanity-fresh-wakeup-target.jsonl",
    processPid: process.pid,
    processStartedAt: readProcessStartedAt(process.pid),
    updatedAt: new Date().toISOString(),
    padding: "x".repeat(512 * 1024),
  }).finally(() => {
    settled = true;
  });

  let missingWhileLeaseDirVisible = 0;
  let tempNamesVisibleToLeaseReaders = 0;
  while (!settled) {
    const visibleLeaseLikeNames = (await readdir(leasesDir).catch(() => [] as string[])).filter((name) => name.startsWith("wakeup-target-"));
    if (visibleLeaseLikeNames.some((name) => name !== finalLeaseDirName)) {
      tempNamesVisibleToLeaseReaders += 1;
    }
    if (await pathExists(leasePath)) {
      const leases = listLeaseMetadata<{ leaseKey?: string }>("wakeup-target");
      if (!leases.some((lease) => lease.leaseKey === wakeupTargetLeaseKey)) {
        missingWhileLeaseDirVisible += 1;
      }
    }
    await sleep(0);
  }
  await publishPromise;

  assert(listLeaseMetadata<{ leaseKey?: string }>("wakeup-target").some((lease) => lease.leaseKey === wakeupTargetLeaseKey), "fresh wake-up-target lease publish should finish with a readable lease entry");
  assert(tempNamesVisibleToLeaseReaders === 0, `fresh wake-up-target lease publish should not expose temp dir names that look like published wake-up-target leases, saw ${tempNamesVisibleToLeaseReaders}`);
  assert(missingWhileLeaseDirVisible === 0, `fresh wake-up-target lease publish should never expose the final lease dir before metadata is readable, saw ${missingWhileLeaseDirVisible} invisible reads`);
  await releaseLease("wakeup-target", wakeupTargetLeaseKey);
}

async function testWakeupTargetLeaseRenewalStaysVisibleToAdopters(config: OracleConfig): Promise<void> {
  await rm(getOracleStateDir(), { recursive: true, force: true });
  const submitterSessionManager = createPersistedSessionManager("poller-live-renew-submit");
  const liveSessionManager = createPersistedSessionManager("poller-live-renew-other");
  const submitterSessionFile = submitterSessionManager.getSessionFile();
  const liveSessionFile = liveSessionManager.getSessionFile();
  assert(submitterSessionFile && liveSessionFile, "live-renew poller test should persist both session files");
  const jobId = await createTerminalJob(config, process.cwd(), submitterSessionFile);
  const job = readJob(jobId);
  assert(job, "live-renew notification job should exist");

  const holder = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000);"] , {
    detached: true,
    stdio: "ignore",
  });
  holder.unref();
  const holderPid = holder.pid;
  assert(holderPid !== undefined, "live-renew holder should expose a pid");
  const holderStartedAt = await waitForProcessStartedAtValue(holderPid);
  const wakeupTargetLeaseKey = `${getPollerSessionKey(submitterSessionFile, process.cwd())}::${holderPid}::${holderStartedAt || "unknown"}`;
  const padding = "x".repeat(256 * 1024);
  await writeLeaseMetadata("wakeup-target", wakeupTargetLeaseKey, {
    leaseKey: wakeupTargetLeaseKey,
    projectId: job.projectId,
    sessionId: job.sessionId,
    processPid: holderPid,
    processStartedAt: holderStartedAt,
    updatedAt: new Date().toISOString(),
    padding,
  });
  let stopRenewal = false;
  const renewLease = (async () => {
    while (!stopRenewal) {
      await writeLeaseMetadata("wakeup-target", wakeupTargetLeaseKey, {
        leaseKey: wakeupTargetLeaseKey,
        projectId: job.projectId,
        sessionId: job.sessionId,
        processPid: holderPid,
        processStartedAt: holderStartedAt,
        updatedAt: new Date().toISOString(),
        padding,
      });
      await sleep(0);
    }
  })();

  const sent: Array<{ details?: { jobId?: string } }> = [];
  const pi: any = {
    sendMessage(message: any) {
      sent.push(message);
    },
  };

  let missingLeaseReads = 0;
  try {
    for (let i = 0; i < 60; i += 1) {
      const leases = listLeaseMetadata<{ leaseKey?: string }>("wakeup-target");
      if (!leases.some((lease) => lease.leaseKey === wakeupTargetLeaseKey)) {
        missingLeaseReads += 1;
      }
      await scanOracleJobsOnce(pi, createPollerCtx(liveSessionManager) as any, "/tmp/fake-oracle-worker.mjs");
    }

    assert(missingLeaseReads === 0, `wake-up target lease renewal should remain continuously readable during concurrent renewals, saw ${missingLeaseReads} missing reads`);
    assert(sent.length === 0, `expected no notification theft while the original session target lease is being renewed concurrently, saw ${sent.length}`);
    assert((readJob(jobId)?.wakeupAttemptCount ?? 0) === 0, "live wake-up target renewal should prevent competing sessions from recording wake-up attempts");
  } finally {
    stopRenewal = true;
    await renewLease;
    if (isPidAlive(holderPid)) process.kill(holderPid, "SIGKILL");
    await waitForPidExit(holderPid);
    await releaseLease("wakeup-target", wakeupTargetLeaseKey);
    stopPollerForSession(liveSessionFile, process.cwd());
    await cleanupJob(jobId);
  }
}

async function testPollerDoesNotStealNotificationWhenOriginBecomesLiveAfterClaim(config: OracleConfig): Promise<void> {
  await rm(getOracleStateDir(), { recursive: true, force: true });
  const submitterSessionManager = createPersistedSessionManager("poller-transition-submit");
  const liveSessionManager = createPersistedSessionManager("poller-transition-live");
  const submitterSessionFile = submitterSessionManager.getSessionFile();
  const liveSessionFile = liveSessionManager.getSessionFile();
  assert(submitterSessionFile && liveSessionFile, "transition poller test should persist both session files");
  const jobId = await createTerminalJob(config, process.cwd(), submitterSessionFile);
  const job = readJob(jobId);
  assert(job, "transition notification job should exist");

  const sent: Array<{ details?: { jobId?: string } }> = [];
  const pi: any = {
    sendMessage(message: any) {
      sent.push(message);
    },
  };
  const ctx: any = {
    cwd: process.cwd(),
    sessionManager: liveSessionManager,
    hasUI: true,
    ui: createUiStub(),
  };

  const submitterSent: Array<{ details?: { jobId?: string } }> = [];
  const submitterPi: any = {
    sendMessage(message: any) {
      submitterSent.push(message);
    },
  };
  const submitterCtx: any = {
    cwd: process.cwd(),
    sessionManager: submitterSessionManager,
    hasUI: true,
    ui: createUiStub(),
  };

  const holder = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000);"] , {
    detached: true,
    stdio: "ignore",
  });
  holder.unref();
  const holderPid = holder.pid;
  assert(holderPid !== undefined, "transition holder should expose a pid");
  const holderStartedAt = await waitForProcessStartedAtValue(holderPid);
  const wakeupTargetLeaseKey = `${job.projectId}::${job.sessionId}::${holderPid}::${holderStartedAt || "unknown"}`;
  let activatedOrigin = false;

  try {
    await scanOracleJobsOnce(pi, ctx, "/tmp/fake-oracle-worker.mjs", {
      hooks: {
        afterNotificationClaim: async (claimed) => {
          if (claimed.id !== jobId || activatedOrigin) return;
          activatedOrigin = true;
          await writeLeaseMetadata("wakeup-target", wakeupTargetLeaseKey, {
            leaseKey: wakeupTargetLeaseKey,
            projectId: job.projectId,
            sessionId: job.sessionId,
            processPid: holderPid,
            processStartedAt: holderStartedAt,
            updatedAt: new Date().toISOString(),
          });
        },
      },
    });

    assert(activatedOrigin, "transition test should activate the original session wake-up target after the competing poller claims notification");
    assert(sent.length === 0, `expected no notification theft when the original session becomes live after claim, saw ${sent.length}`);
    const pendingJob = readJob(jobId);
    assert(!pendingJob?.notifiedAt, "job should remain unnotified when the original session becomes live after claim");
    assert(!pendingJob?.notifyClaimedAt && !pendingJob?.notifyClaimedBy, "notification claim should be released when the original session becomes live after claim");
    assert(!findNotificationEntry(liveSessionManager, jobId), "competing session should not persist a completion message after the original session becomes live before delivery");

    await releaseLease("wakeup-target", wakeupTargetLeaseKey);
    if (isPidAlive(holderPid)) process.kill(holderPid, "SIGKILL");
    await waitForPidExit(holderPid);

    await scanOracleJobsOnce(submitterPi, submitterCtx, "/tmp/fake-oracle-worker.mjs");
    assert(submitterSent.length >= 1, `expected the original session to receive at least one best-effort wake-up after becoming live, saw ${submitterSent.length}`);
    assert(submitterSent[0]?.details?.jobId === jobId, "original session should receive the expected job wake-up after reclaiming liveness");
    assert(!readJob(jobId)?.notifiedAt, "same-session live wake-up handling should still defer notification finalization under the best-effort-only model");
    assert(!findNotificationEntry(submitterSessionManager, jobId), "same-session live wake-up handling should not append a durable completion message directly into the active session after reclaiming liveness");
  } finally {
    stopPollerForSession(liveSessionFile, ctx.cwd);
    stopPollerForSession(submitterSessionFile, submitterCtx.cwd);
    if (isPidAlive(holderPid)) process.kill(holderPid, "SIGKILL");
    await waitForPidExit(holderPid);
    await releaseLease("wakeup-target", wakeupTargetLeaseKey);
    await cleanupJob(jobId);
  }
}

async function testPollerDoesNotStealNotificationWhenOriginBecomesLiveBeforePersist(config: OracleConfig): Promise<void> {
  await rm(getOracleStateDir(), { recursive: true, force: true });
  const submitterSessionManager = createPersistedSessionManager("poller-transition-late-submit");
  const liveSessionManager = createPersistedSessionManager("poller-transition-late-live");
  const submitterSessionFile = submitterSessionManager.getSessionFile();
  const liveSessionFile = liveSessionManager.getSessionFile();
  assert(submitterSessionFile && liveSessionFile, "late transition poller test should persist both session files");
  appendAssistantMessage(submitterSessionManager, "prime late-transition target history", { provider: "anthropic", model: "claude-sonnet-4" });
  const jobId = await createTerminalJob(config, process.cwd(), submitterSessionFile);
  const job = readJob(jobId);
  assert(job, "late transition notification job should exist");

  const sent: Array<{ details?: { jobId?: string } }> = [];
  const pi: any = {
    sendMessage(message: any) {
      sent.push(message);
    },
  };
  const ctx: any = {
    cwd: process.cwd(),
    sessionManager: liveSessionManager,
    hasUI: true,
    ui: createUiStub(),
  };

  const submitterSent: Array<{ details?: { jobId?: string } }> = [];
  const submitterPi: any = {
    sendMessage(message: any) {
      submitterSent.push(message);
    },
  };
  const submitterCtx: any = {
    cwd: process.cwd(),
    sessionManager: submitterSessionManager,
    hasUI: true,
    ui: createUiStub(),
  };

  const holder = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000);"] , {
    detached: true,
    stdio: "ignore",
  });
  holder.unref();
  const holderPid = holder.pid;
  assert(holderPid !== undefined, "late transition holder should expose a pid");
  const holderStartedAt = await waitForProcessStartedAtValue(holderPid);
  const wakeupTargetLeaseKey = `${job.projectId}::${job.sessionId}::${holderPid}::${holderStartedAt || "unknown"}`;
  let activatedOrigin = false;

  try {
    await scanOracleJobsOnce(pi, ctx, "/tmp/fake-oracle-worker.mjs", {
      hooks: {
        beforeNotificationPersist: async (claimed) => {
          if (claimed.id !== jobId || activatedOrigin) return;
          activatedOrigin = true;
          await writeLeaseMetadata("wakeup-target", wakeupTargetLeaseKey, {
            leaseKey: wakeupTargetLeaseKey,
            projectId: job.projectId,
            sessionId: job.sessionId,
            processPid: holderPid,
            processStartedAt: holderStartedAt,
            updatedAt: new Date().toISOString(),
          });
        },
      },
    });

    assert(activatedOrigin, "late transition test should activate the original session wake-up target immediately before durable notification append");
    assert(sent.length === 0, `expected no notification theft when the original session becomes live immediately before append, saw ${sent.length}`);
    const pendingJob = readJob(jobId);
    assert(!pendingJob?.notifiedAt, "job should remain unnotified when the original session becomes live immediately before append");
    assert(!pendingJob?.notifyClaimedAt && !pendingJob?.notifyClaimedBy, "notification claim should be released when the original session becomes live immediately before append");
    assert(!findNotificationEntry(liveSessionManager, jobId), "competing session should not persist a completion message when the original session becomes live immediately before append");

    await releaseLease("wakeup-target", wakeupTargetLeaseKey);
    if (isPidAlive(holderPid)) process.kill(holderPid, "SIGKILL");
    await waitForPidExit(holderPid);

    await scanOracleJobsOnce(submitterPi, submitterCtx, "/tmp/fake-oracle-worker.mjs");
    assert(submitterSent.length >= 1, `expected the original session to receive at least one best-effort wake-up after reclaiming liveness before append, saw ${submitterSent.length}`);
    assert(submitterSent[0]?.details?.jobId === jobId, "original session should receive the expected job wake-up after reclaiming liveness before append");
    assert(!readJob(jobId)?.notifiedAt, "same-session live wake-up handling should still defer notification finalization after late revalidation hands notification back");
    assert(!findNotificationEntry(submitterSessionManager, jobId), "same-session live wake-up handling should not append a durable completion message directly into the active session after late revalidation hands notification back");
  } finally {
    stopPollerForSession(liveSessionFile, ctx.cwd);
    stopPollerForSession(submitterSessionFile, submitterCtx.cwd);
    if (isPidAlive(holderPid)) process.kill(holderPid, "SIGKILL");
    await waitForPidExit(holderPid);
    await releaseLease("wakeup-target", wakeupTargetLeaseKey);
    await cleanupJob(jobId);
  }
}

async function testOffSessionWakeupsDoNotWriteTargetSessionHistory(config: OracleConfig): Promise<void> {
  await rm(getOracleStateDir(), { recursive: true, force: true });
  const targetSessionManager = createPersistedSessionManager("poller-target-lock-target");
  const adopterSessionManager = createPersistedSessionManager("poller-target-lock-adopter");
  const targetSessionFile = targetSessionManager.getSessionFile();
  assert(targetSessionFile, "off-session wake-up test should persist a target session file");
  const headEntryId = appendAssistantMessage(targetSessionManager, "prime target history for off-session wake-up", { provider: "anthropic", model: "claude-sonnet-4" });
  const jobId = await createTerminalJob(config, process.cwd(), targetSessionFile);

  const sent: Array<{ details?: { jobId?: string } }> = [];
  const pi: any = {
    sendMessage(message: any) {
      sent.push(message);
    },
  };
  const peerSessionManager = SessionManager.open(targetSessionFile, undefined, process.cwd());

  let peerEntryId: string | undefined;
  await scanOracleJobsOnce(pi, createPollerCtx(adopterSessionManager) as any, "/tmp/fake-oracle-worker.mjs", {
    hooks: {
      beforeNotificationPersist: async (claimed) => {
        if (claimed.id !== jobId || peerEntryId) return;
        peerEntryId = appendAssistantMessage(peerSessionManager, "peer append before best-effort wake-up", {
          provider: "anthropic",
          model: "claude-sonnet-4",
          responseId: `peer-notification:${jobId}`,
        });
      },
    },
  });

  const reopenedSession = SessionManager.open(targetSessionFile, undefined, process.cwd());
  assert(reopenedSession.getEntries().some((entry) => entry.id === headEntryId), "off-session wake-up-only handling should preserve the original target-session head entry");
  assert(peerEntryId && reopenedSession.getEntries().some((entry) => entry.id === peerEntryId), "off-session wake-up-only handling should preserve concurrent peer session writes in the target history");
  assert(!findNotificationEntry(reopenedSession, jobId), "off-session wake-up-only handling should not append a durable oracle completion message into the target session");
  assert(!readJob(jobId)?.notifiedAt, "off-session wake-up-only handling should leave the job unnotified while no durable session-history append exists");
  assert(sent.length >= 1, `off-session wake-up-only handling should still request at least one best-effort wake-up, saw ${sent.length}`);
  await cleanupJob(jobId);
}

async function testNotificationClaimRecoveryDoesNotDuplicateWakeups(config: OracleConfig): Promise<void> {
  await rm(getOracleStateDir(), { recursive: true, force: true });
  const submitterSessionManager = createPersistedSessionManager("poller-recovery-submit");
  const adopterSessionManager = createPersistedSessionManager("poller-recovery-adopter");
  const targetSessionFile = submitterSessionManager.getSessionFile();
  const adopterSessionFile = adopterSessionManager.getSessionFile();
  assert(targetSessionFile && adopterSessionFile, "notification recovery test should persist both the submitter and adopter session files");
  appendAssistantMessage(submitterSessionManager, "prime recovery target history", { provider: "anthropic", model: "claude-sonnet-4" });
  const jobId = await createTerminalJob(config, process.cwd(), targetSessionFile);

  const sent: Array<{ details?: { jobId?: string } }> = [];
  const pi: any = {
    sendMessage(message: any) {
      sent.push(message);
    },
  };
  const staleRecoveryCtx: any = createPollerCtx(SessionManager.open(adopterSessionFile, undefined, process.cwd()));

  await scanOracleJobsOnce(pi, createPollerCtx(adopterSessionManager) as any, "/tmp/fake-oracle-worker.mjs");
  assert(sent.length === 1, `first wake-up-only recovery attempt should emit one best-effort wake-up, saw ${sent.length}`);
  assert(!readJob(jobId)?.notifiedAt, "wake-up-only recovery should leave the job unnotified after the first wake-up attempt");
  assert(!findNotificationEntry(SessionManager.open(targetSessionFile, undefined, process.cwd()), jobId), "wake-up-only recovery should not create a durable completion message in the target session");

  await updateJob(jobId, (job) => ({
    ...job,
    notifyClaimedBy: "other-claimant",
    notifyClaimedAt: new Date(Date.now() - 2 * 60 * 1000).toISOString(),
    wakeupLastRequestedAt: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
  }));
  await scanOracleJobsOnce(pi, staleRecoveryCtx, "/tmp/fake-oracle-worker.mjs");
  assert(sent.length >= 2, `recovered wake-up-only delivery should emit an additional best-effort wake-up after claim handoff, saw ${sent.length}`);
  assert(!readJob(jobId)?.notifiedAt, "wake-up-only recovery should still leave the job unnotified after subsequent best-effort wake-up attempts");
  await cleanupJob(jobId);
}

async function testStaleWakeupClaimsDoNotDuplicateReminders(config: OracleConfig): Promise<void> {
  await rm(getOracleStateDir(), { recursive: true, force: true });
  const submitterSessionManager = createPersistedSessionManager("poller-stale-wakeup-submit");
  const firstAdopterSessionManager = createPersistedSessionManager("poller-stale-wakeup-first-adopter");
  const secondAdopterSessionManager = createPersistedSessionManager("poller-stale-wakeup-second-adopter");
  const targetSessionFile = submitterSessionManager.getSessionFile();
  assert(targetSessionFile, "stale wake-up claim test should persist a target session file");
  appendAssistantMessage(submitterSessionManager, "prime stale wake-up target history", { provider: "anthropic", model: "claude-sonnet-4" });
  const jobId = await createTerminalJob(config, process.cwd(), targetSessionFile);

  const firstSent: Array<{ details?: { jobId?: string } }> = [];
  const firstPi: any = {
    sendMessage(message: any) {
      firstSent.push(message);
    },
  };
  const secondSent: Array<{ details?: { jobId?: string } }> = [];
  const secondPi: any = {
    sendMessage(message: any) {
      secondSent.push(message);
    },
  };

  let allowSecondClaim: (() => void) | undefined;
  const secondClaimBlocked = new Promise<void>((resolve) => {
    allowSecondClaim = resolve;
  });
  let signalSecondClaimReady: (() => void) | undefined;
  const secondClaimReady = new Promise<void>((resolve) => {
    signalSecondClaimReady = resolve;
  });

  const secondScan = scanOracleJobsOnce(secondPi, createPollerCtx(secondAdopterSessionManager) as any, "/tmp/fake-oracle-worker.mjs", {
    hooks: {
      beforeNotificationClaim: async (candidateJobId) => {
        if (candidateJobId !== jobId) return;
        signalSecondClaimReady?.();
        await secondClaimBlocked;
      },
    },
  });

  await secondClaimReady;
  await scanOracleJobsOnce(firstPi, createPollerCtx(firstAdopterSessionManager) as any, "/tmp/fake-oracle-worker.mjs");
  allowSecondClaim?.();
  await secondScan;

  assert(firstSent.length === 1, `first claimant should emit exactly one best-effort wake-up, saw ${firstSent.length}`);
  assert(secondSent.length === 0, `stale second claimants must not emit an extra wake-up inside the same retry window, saw ${secondSent.length}`);
  assert(readJob(jobId)?.wakeupAttemptCount === 1, "stale second claimants must not increment the bounded wake-up retry counter");
  await cleanupJob(jobId);
}

async function testStalePruneCandidatesDoNotSendWakeups(config: OracleConfig): Promise<void> {
  await rm(getOracleStateDir(), { recursive: true, force: true });
  const retentionConfig: OracleConfig = {
    ...config,
    cleanup: {
      completeJobRetentionMs: 60_000,
      failedJobRetentionMs: 120_000,
    },
  };
  const sessionManager = createPersistedSessionManager("poller-prunable-target");
  const sessionFile = sessionManager.getSessionFile();
  assert(sessionFile, "stale prune-candidate test should persist a target session file");
  appendAssistantMessage(sessionManager, "prime prunable wake-up target history", { provider: "anthropic", model: "claude-sonnet-4" });
  const jobId = await createTerminalJob(retentionConfig, process.cwd(), sessionFile);

  const sent: Array<{ details?: { jobId?: string } }> = [];
  const pi: any = {
    sendMessage(message: any) {
      sent.push(message);
    },
  };

  let prunedJobIds: string[] = [];
  const pruneTimestamp = new Date(Date.now() - 2 * 60 * 1000).toISOString();
  await scanOracleJobsOnce(pi, createPollerCtx(sessionManager) as any, "/tmp/fake-oracle-worker.mjs", {
    hooks: {
      beforeNotificationClaim: async (candidateJobId) => {
        if (candidateJobId !== jobId || prunedJobIds.length > 0) return;
        await updateJob(jobId, (job) => ({
          ...job,
          createdAt: pruneTimestamp,
          completedAt: pruneTimestamp,
        }));
        prunedJobIds = await pruneTerminalOracleJobs(Date.now());
      },
    },
  });

  assert(prunedJobIds.includes(jobId), "stale prune candidates should be removed before a wake-up is sent once they age into retention");
  assert(sent.length === 0, `stale prune candidates must not emit wake-ups after they become removable, saw ${sent.length}`);
  assert(!readJob(jobId), "stale prune candidates should be deleted before any wake-up send path runs");
}

async function testClaimedJobsBlockRemovalBeforeWakeup(config: OracleConfig): Promise<void> {
  await rm(getOracleStateDir(), { recursive: true, force: true });
  const sessionManager = createPersistedSessionManager("poller-claimed-removal-target");
  const sessionFile = sessionManager.getSessionFile();
  assert(sessionFile, "claimed-removal wake-up test should persist a target session file");
  appendAssistantMessage(sessionManager, "prime claimed-removal wake-up target history", { provider: "anthropic", model: "claude-sonnet-4" });
  const jobId = await createTerminalJob(config, process.cwd(), sessionFile);

  const sent: Array<{ details?: { jobId?: string } }> = [];
  const pi: any = {
    sendMessage(message: any) {
      sent.push(message);
    },
  };

  let removalResult: Awaited<ReturnType<typeof removeTerminalOracleJob>> | undefined;
  await scanOracleJobsOnce(pi, createPollerCtx(sessionManager) as any, "/tmp/fake-oracle-worker.mjs", {
    hooks: {
      beforeNotificationPersist: async (claimed) => {
        if (claimed.id !== jobId || removalResult) return;
        const current = readJob(jobId);
        assert(current, "claimed-removal wake-up test should still have a job to remove");
        removalResult = await removeTerminalOracleJob(current);
      },
    },
  });

  assert(removalResult && !removalResult.removed, "removal paths must not delete terminal jobs while notification delivery is in flight");
  assert(removalResult.cleanupReport.warnings.some((warning) => warning.includes("notification delivery is in flight")), "removal paths should explain that the job is claimed for wake-up delivery");
  assert(Boolean(readJob(jobId)), "claimed-removal wake-up test should retain the job directory until the wake-up send completes");
  assert(sent.length === 1, `claimed jobs should still emit exactly one wake-up after removal is refused, saw ${sent.length}`);
  assert(readJob(jobId)?.wakeupAttemptCount === 1, "claimed-removal wake-up test should still record the single wake-up attempt");
  await cleanupJob(jobId);
}

async function testPostSendWakeupGraceBlocksPrune(config: OracleConfig): Promise<void> {
  await rm(getOracleStateDir(), { recursive: true, force: true });
  const retentionConfig: OracleConfig = {
    ...config,
    cleanup: {
      completeJobRetentionMs: 10_000,
      failedJobRetentionMs: 120_000,
    },
  };
  const sessionManager = createPersistedSessionManager("poller-post-send-prune-grace");
  const sessionFile = sessionManager.getSessionFile();
  assert(sessionFile, "post-send prune-grace test should persist a target session file");
  appendAssistantMessage(sessionManager, "prime post-send prune-grace history", { provider: "anthropic", model: "claude-sonnet-4" });
  const jobId = await createTerminalJob(retentionConfig, process.cwd(), sessionFile);
  const job = readJob(jobId);
  assert(job?.responsePath, "post-send prune-grace test should have a response path");
  const artifactsDir = join(getJobDir(jobId), "artifacts");
  await mkdir(artifactsDir, { recursive: true, mode: 0o700 });
  await writeFile(job.responsePath, "oracle response\n", { mode: 0o600 });
  await writeFile(join(artifactsDir, "artifact.txt"), "artifact\n", { mode: 0o600 });
  const almostExpired = new Date(Date.now() - 5_000).toISOString();
  await updateJob(jobId, (current) => ({
    ...current,
    createdAt: almostExpired,
    completedAt: almostExpired,
    phaseAt: almostExpired,
  }));

  const sent: Array<{ content?: string; details?: { jobId?: string } }> = [];
  const pi: any = {
    sendMessage(message: any) {
      sent.push(message);
    },
  };

  await scanOracleJobsOnce(pi, createPollerCtx(sessionManager) as any, "/tmp/fake-oracle-worker.mjs");
  assert(sent.length === 1, `post-send prune-grace test should emit exactly one wake-up before pruning is attempted, saw ${sent.length}`);
  const pruned = await pruneTerminalOracleJobs(Date.now() + 10_000);
  assert(!pruned.includes(jobId), "recently sent wake-ups should keep their job files retained during the post-send grace window");
  assert(Boolean(readJob(jobId)), "post-send prune-grace test should keep the job directory on disk during the grace window");
  assert(await pathExists(job.responsePath), "post-send prune-grace test should keep the referenced response file on disk during the grace window");
  assert(await pathExists(artifactsDir), "post-send prune-grace test should keep the referenced artifacts directory on disk during the grace window");
  assert(sent[0]?.content?.includes(job.responsePath), "post-send prune-grace wake-up should reference the persisted response path");
  assert(sent[0]?.content?.includes(artifactsDir), "post-send prune-grace wake-up should reference the persisted artifacts directory");
  await cleanupJob(jobId);
}

async function testOracleCleanHonorsPostSendWakeupGrace(config: OracleConfig): Promise<void> {
  await rm(getOracleStateDir(), { recursive: true, force: true });
  const cwd = process.cwd();
  const fakeWorkerPath = join(tmpdir(), `oracle-sanity-clean-post-send-worker-${randomUUID()}.mjs`);
  await writeFile(fakeWorkerPath, "process.exit(0);\n", { mode: 0o600 });

  const sessionManager = createPersistedSessionManager("poller-post-send-clean-grace");
  const sessionFile = sessionManager.getSessionFile();
  assert(sessionFile, "post-send clean-grace test should persist a target session file");
  appendAssistantMessage(sessionManager, "prime post-send clean-grace history", { provider: "anthropic", model: "claude-sonnet-4" });
  const jobId = await createTerminalJob(config, cwd, sessionFile);
  const job = readJob(jobId);
  assert(job?.responsePath, "post-send clean-grace test should have a response path");
  const artifactsDir = join(getJobDir(jobId), "artifacts");
  await mkdir(artifactsDir, { recursive: true, mode: 0o700 });
  await writeFile(job.responsePath, "oracle response\n", { mode: 0o600 });
  await writeFile(join(artifactsDir, "artifact.txt"), "artifact\n", { mode: 0o600 });

  const sent: Array<{ content?: string; details?: { jobId?: string } }> = [];
  const pi: any = {
    commands: new Map<string, any>(),
    registerCommand(name: string, definition: any) {
      this.commands.set(name, definition);
    },
    sendMessage(message: any) {
      sent.push(message);
    },
  };
  registerOracleCommands(pi, fakeWorkerPath, fakeWorkerPath);
  const cleanCommand = pi.commands.get("oracle-clean");
  assert(cleanCommand, "oracle clean command should register for post-send clean-grace test");

  await scanOracleJobsOnce(pi, createPollerCtx(sessionManager) as any, "/tmp/fake-oracle-worker.mjs");
  assert(sent.length === 1, `post-send clean-grace test should emit exactly one wake-up before clean is attempted, saw ${sent.length}`);

  const ui = createUiStub();
  const ctx: any = {
    cwd,
    hasUI: true,
    sessionManager: { getSessionFile: () => sessionFile },
    ui,
  };

  try {
    await cleanCommand.handler(jobId, ctx);
    assert(Boolean(readJob(jobId)), "oracle clean should keep the job directory on disk during the post-send grace window");
    assert(await pathExists(job.responsePath), "oracle clean should keep the referenced response file on disk during the post-send grace window");
    assert(await pathExists(artifactsDir), "oracle clean should keep the referenced artifacts directory on disk during the post-send grace window");
    assert(ui.notifications.some((entry) => entry.message.includes("post-send retention grace window")), "oracle clean should explain when recent wake-up delivery keeps files retained briefly");
  } finally {
    await cleanupJob(jobId);
    await rm(fakeWorkerPath, { force: true });
  }
}

async function testPollerWakeupRetriesStayBoundedWithoutDurableNotifications(config: OracleConfig): Promise<void> {
  await rm(getOracleStateDir(), { recursive: true, force: true });
  const sessionManager = createPersistedSessionManager("poller-wakeup-retry-target");
  const sessionFile = sessionManager.getSessionFile();
  assert(sessionFile, "wakeup retry poller test should persist a target session file");
  appendAssistantMessage(sessionManager, "prime wake-up retry target history", { provider: "anthropic", model: "claude-sonnet-4" });
  const jobId = await createTerminalJob(config, process.cwd(), sessionFile);

  const sent: Array<{ details?: { jobId?: string } }> = [];
  const pi: any = {
    sendMessage(message: any) {
      sent.push(message);
    },
  };

  await scanOracleJobsOnce(pi, createPollerCtx(sessionManager) as any, "/tmp/fake-oracle-worker.mjs");
  assert(sent.length >= 1, `expected at least one best-effort wake-up request after the first scan, saw ${sent.length}`);
  assert(!findNotificationEntry(SessionManager.open(sessionFile, undefined, process.cwd()), jobId), "wake-up retries should not create durable completion messages under the best-effort-only model");
  assert(readJob(jobId)?.wakeupAttemptCount === 1, "first wake-up attempt should record a single best-effort reminder request");

  await updateJob(jobId, (job) => ({
    ...job,
    wakeupLastRequestedAt: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
  }));
  await scanOracleJobsOnce(pi, createPollerCtx(sessionManager) as any, "/tmp/fake-oracle-worker.mjs");
  assert(sent.length >= 2, `expected a second best-effort wake-up retry after backoff, saw ${sent.length}`);
  assert(readJob(jobId)?.wakeupAttemptCount === 2, "wake-up retries should increment the best-effort reminder counter without durable completion messages");

  await updateJob(jobId, (job) => ({
    ...job,
    wakeupLastRequestedAt: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
  }));
  await scanOracleJobsOnce(pi, createPollerCtx(sessionManager) as any, "/tmp/fake-oracle-worker.mjs");
  assert(sent.length >= 3, `expected a third bounded best-effort wake-up retry after backoff, saw ${sent.length}`);
  assert(readJob(jobId)?.wakeupAttemptCount === 3, "bounded wake-up retries should stop after the configured maximum attempts");

  await updateJob(jobId, (job) => ({
    ...job,
    wakeupLastRequestedAt: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
  }));
  await scanOracleJobsOnce(pi, createPollerCtx(sessionManager) as any, "/tmp/fake-oracle-worker.mjs");
  const wakeupAttemptsAtLimit = sent.length;
  assert(wakeupAttemptsAtLimit >= 3, `wake-up retries should reach the configured maximum attempts before stopping, saw ${wakeupAttemptsAtLimit}`);
  assert(sent.length === wakeupAttemptsAtLimit, `wake-up retries should stop once the configured maximum attempts is reached, saw ${sent.length}`);
  assert(!readJob(jobId)?.notifiedAt, "bounded wake-up retries should leave the job unnotified while no durable completion message exists");

  await cleanupJob(jobId);
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
  await rm(getOracleStateDir(), { recursive: true, force: true });
  await acquireLock("reconcile", "global", { processPid: 999_999_999, source: "oracle-sanity-stale-lock" });

  let entered = false;
  await withGlobalReconcileLock({ processPid: process.pid, source: "oracle-sanity-reclaim" }, async () => {
    entered = true;
  });

  assert(entered, "expected stale reconcile lock to be reclaimed");
}

async function testDeadPidLockSweep(): Promise<void> {
  await rm(getOracleStateDir(), { recursive: true, force: true });
  await acquireLock("job", `stale-job-lock-${randomUUID()}`, { processPid: 999_999_999, source: "oracle-sanity-dead-lock" });
  const removed = await sweepStaleLocks();
  assert(removed.length === 1, `expected exactly one stale lock to be removed, saw ${removed.length}`);
}

async function testMetadataLessLockRecovery(): Promise<void> {
  await rm(getOracleStateDir(), { recursive: true, force: true });
  const key = `metadata-less-lock-${randomUUID()}`;
  const path = hashedOracleStatePath("job", key, getLocksDir());
  await mkdir(path, { recursive: false, mode: 0o700 });
  await sleep(ORACLE_METADATA_WRITE_GRACE_MS + 100);

  const handle = await acquireLock("job", key, { processPid: process.pid, source: "oracle-sanity-metadata-less-lock" }, { timeoutMs: 5_000 });
  assert(Boolean(handle), "metadata-less lock directories should be reclaimed after a bounded grace instead of timing out forever");
  await releaseLock(handle);
}

async function testMetadataLessConversationLeaseRecovery(): Promise<void> {
  await rm(getOracleStateDir(), { recursive: true, force: true });
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
  await rm(getOracleStateDir(), { recursive: true, force: true });
  const path = hashedOracleStatePath("auth", "global", getLocksDir());
  await mkdir(path, { recursive: false, mode: 0o700 });
  await sleep(WORKER_METADATA_WRITE_GRACE_MS + 100);

  const handle = await acquireWorkerStateLock(getOracleStateDir(), "auth", "global", { processPid: process.pid, source: "oracle-sanity-worker-auth-lock" }, 5_000);
  assert(Boolean(handle), "worker auth lock acquisition should recover metadata-less auth lock dirs left behind by crashes");
  await releaseWorkerStateLock(handle);
}

async function testWorkerConversationLeaseRecoversMetadataLessDir(): Promise<void> {
  await rm(getOracleStateDir(), { recursive: true, force: true });
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
  await rm(getOracleStateDir(), { recursive: true, force: true });
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
  assert(listLeaseMetadata<{ jobId: string }>("runtime").some((lease) => lease.jobId === jobId), "cleanup-warning terminal job should retain runtime lease until cleanup succeeds");

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
}

async function testOraclePromptTemplateCutover(): Promise<void> {
  const commandsSource = await readFile(new URL("../extensions/oracle/lib/commands.ts", import.meta.url), "utf8");
  const toolsSource = await readFile(new URL("../extensions/oracle/lib/tools.ts", import.meta.url), "utf8");
  const jobsSource = await readFile(new URL("../extensions/oracle/lib/jobs.ts", import.meta.url), "utf8");
  const pollerSource = await readFile(new URL("../extensions/oracle/lib/poller.ts", import.meta.url), "utf8");
  const queueSource = await readFile(new URL("../extensions/oracle/lib/queue.ts", import.meta.url), "utf8");
  const locksSource = await readFile(new URL("../extensions/oracle/lib/locks.ts", import.meta.url), "utf8");
  const runtimeSource = await readFile(new URL("../extensions/oracle/lib/runtime.ts", import.meta.url), "utf8");
  const promptSource = await readFile(new URL("../prompts/oracle.md", import.meta.url), "utf8");
  const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as {
    files?: string[];
    pi?: { prompts?: string[] };
  };

  assert(!commandsSource.includes('registerCommand("oracle"'), "/oracle should not be registered as an extension command");
  assert(promptSource.includes("You are preparing an /oracle job."), "/oracle prompt template should contain the oracle dispatch instructions");
  assert(promptSource.includes("include the whole repository by passing `.`"), "/oracle prompt should default to whole-repo archive selection");
  assert(promptSource.includes("obvious credentials/private data"), "/oracle prompt should mention default exclusion of obvious credentials/private data");
  assert(promptSource.includes("For very targeted asks like reviewing one function or explaining one stack trace"), "/oracle prompt should preserve the targeted-scope exception");
  assert(promptSource.includes("the `.git` directory is not included in oracle exports"), "/oracle prompt should tell review/ship-readiness requests to create and include a git diff bundle file");
  assert(promptSource.includes("submit automatically prunes the largest nested directories matching generic generated-output names"), "/oracle prompt should describe whole-repo auto-pruning when archives are still too large");
  assert(promptSource.includes("outside obvious source roots like `src/` and `lib/`"), "/oracle prompt should describe the source-root guard for auto-pruning");
  assert(promptSource.includes("If a submitted oracle job later fails because upload is rejected"), "/oracle prompt should describe the post-submit upload-rejection fallback ladder");
  assert(promptSource.includes("still exceeds the upload limit after default exclusions and automatic generic generated-output-dir pruning"), "/oracle prompt should distinguish submit-time oversize failures after auto-pruning");
  assert(promptSource.includes("If `oracle_submit` returns a queued job instead of an immediately dispatched one, treat that as success"), "/oracle prompt should explain queued oracle submissions as successful waits");
  assert(toolsSource.includes("archive the whole repo by passing '.'"), "oracle tool guidance should align with whole-repo archive defaults");
  assert(runtimeSource.includes("Oracle requires a persisted pi session"), "runtime should surface a clear error when oracle is used without a persisted session identity");
  assert(!runtimeSource.includes("ephemeral:"), "runtime should no longer collapse no-session oracle contexts onto a shared project-level ephemeral session identity");
  assert(toolsSource.includes("requirePersistedSessionFile(getSessionFile(ctx), \"submit oracle jobs\")"), "oracle submit should reject no-session contexts instead of collapsing them onto a project-level ephemeral session id");
  assert(toolsSource.includes("`artifacts: ${getJobDir(current.id)}/artifacts`"), "oracle read should derive artifact paths from the configured jobs dir instead of hard-coding /tmp");
  assert(toolsSource.includes("await markWakeupSettled(job.id)"), "oracle read should settle further wake-up retries once a terminal job has been manually read");
  assert(commandsSource.includes("await markWakeupSettled(job.id);"), "oracle status should settle further wake-up retries once a terminal job has been manually inspected");
  assert(jobsSource.includes("requirePersistedSessionFile(originSessionFile, \"create oracle jobs\")"), "oracle jobs should require a persisted session identity at creation time");
  assert(toolsSource.includes("obvious credentials/private data"), "oracle tool guidance should mention default exclusion of obvious credentials/private data");
  assert(toolsSource.includes("submit automatically prunes the largest nested directories matching generic generated-output names"), "oracle tool guidance should describe whole-repo auto-pruning when archives are still too large");
  assert(toolsSource.includes("outside obvious source roots like src/ and lib/"), "oracle tool guidance should describe the source-root guard for auto-pruning");
  assert(toolsSource.includes("If oracle_submit returns a queued job instead of an immediately dispatched one, treat that as success"), "oracle tool guidance should explain queued oracle submissions as successful waits");
  assert(toolsSource.includes('if (latest?.status === "queued" && queuedSubmissionDurable)'), "oracle submit should preserve queued jobs only after the archive and metadata persist durably");
  assert(toolsSource.includes("await terminateWorkerPid(spawnedWorker.pid, spawnedWorker.startedAt)"), "oracle submit should terminate a spawned worker if persisting worker metadata fails");
  assert(toolsSource.includes("shouldAdvanceQueueAfterCancellation(cancelled)"), "oracle cancel tool should only promote queued jobs after a clean cancellation");
  assert(jobsSource.includes("return job.status === \"cancelled\" && !job.cleanupPending && !job.cleanupWarnings?.length;"), "queue advancement after cancellation should require a cancelled job with no pending cleanup or cleanup warnings");
  assert(jobsSource.includes("if (job.workerPid) return true;"), "durable worker handoff should require a persisted worker pid");
  assert(!jobsSource.includes('if (job.status === "waiting") return true;'), "worker phase alone should not count as a durable handoff without a persisted pid");
  assert(queueSource.includes("await terminateWorkerPid(spawnedWorker.pid, spawnedWorker.startedAt)"), "queued promotion should terminate a spawned worker if persisting worker metadata fails");
  assert(locksSource.includes("ORACLE_METADATA_WRITE_GRACE_MS = 1_000"), "locks/leases should use a bounded grace window before reclaiming metadata-less state dirs left behind by crashes");
  assert(locksSource.includes("createStateDirAtomically"), "locks/leases should publish new state dirs atomically so first creation never exposes a final dir without metadata");
  assert(locksSource.includes(".tmp-"), "lock/lease first-publish temp dirs should use a hidden prefix that lease readers never mistake for final published state dirs");
  assert(locksSource.includes("await rename(tempPath, finalPath);"), "locks/leases should atomically rename fully populated temp dirs into place for first publish");
  assert(locksSource.includes("await rename(tempPath, targetPath);"), "lock/lease metadata rewrites should stay atomic via temp-file rename so concurrent readers never observe partial JSON");
  assert(locksSource.includes("maybeReclaimIncompleteStateDir"), "locks/leases should reclaim metadata-less state dirs left behind after mkdir succeeds but metadata write never completes");
  assert(locksSource.includes("if (await maybeReclaimIncompleteStateDir(path)) continue;"), "lock/lease acquisition should retry after reclaiming stale metadata-less state dirs");
  assert(!locksSource.includes("await writeFile(join(path, \"metadata.json\")"), "lock/lease metadata should not be written in-place because wake-up routing depends on readers seeing only complete JSON");
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
  assert(pollerSource.indexOf("await recordNotificationTarget(jobId, notificationClaimant") < pollerSource.indexOf("const preWakeupLiveWakeupTargets = await resolveLiveWakeupTargets();"), "poller should finish recording the intended wake-up target before the final live-target recheck");
  assert(pollerSource.indexOf("const preWakeupLiveWakeupTargets = await resolveLiveWakeupTargets();") < pollerSource.indexOf("requestWakeupTurn(pi, deliverable)"), "poller should perform the final live-target recheck immediately before the wake-up send path");
  assert(pollerSource.includes("const deliverable = readJob(jobId);"), "poller should re-read the job immediately before send so deleted/pruned jobs cannot emit stale wake-ups");
  assert(pollerSource.includes("if (!deliverable || shouldPruneTerminalJob(deliverable, Date.now())) {"), "poller should abort wake-up delivery if the job was deleted or became prunable before send");
  assert(pollerSource.includes("requestWakeupTurn(pi, deliverable)"), "poller should deliver completion follow-ups as best-effort wake-up turns instead of direct durable session-history writes");
  assert(pollerSource.includes("buildNotificationContent(job)"), "poller wake-up turns should include durable response/artifact paths from job state");
  assert(pollerSource.includes("getJobDir(job.id)"), "poller wake-up content should derive artifact/response paths from the configured oracle jobs dir instead of hard-coding /tmp");
  assert(pollerSource.includes("beforeNotificationPersist"), "poller should support a last-moment revalidation hook before wake-up delivery for regression coverage");
  assert(!pollerSource.includes("manager.setSessionFile(sessionFile)"), "poller should not discard live in-memory session history by reloading the current session manager before completion delivery");
  assert(!pollerSource.includes("appendMessage(buildNotificationMessage(job, notificationModel))"), "poller should not append synthetic assistant completion messages into session history");
  assert(!pollerSource.includes("reopenAndVerifyNotification"), "poller should no longer rely on post-append session-history verification for completion delivery");
  assert(!pollerSource.includes("findExistingNotificationRecord"), "poller should not rely on durable session-history notification recovery under the wake-up-only model");
  assert(pollerSource.includes("ORACLE_WAKEUP_REMINDER_CUSTOM_TYPE"), "poller should deliver completion reminders via a dedicated best-effort wake-up custom message type");
  assert(pollerSource.includes("await noteWakeupRequested(jobId)"), "poller should track bounded best-effort wake-up reminder attempts");
  assert(jobsSource.includes("if (!hasPersistedOriginSession(current)) return undefined;"), "notification claims should reject legacy jobs that do not have a persisted origin session identity");
  assert(jobsSource.includes("if (shouldPruneTerminalJob(current, nowMs)) return undefined;"), "notification claims should reject already-prunable jobs under the job lock so stale candidates cannot wake after prune eligibility");
  assert(jobsSource.includes("if (!shouldRequestWakeup(current, nowMs)) return undefined;"), "notification claims should re-check wake-up retry eligibility under the job lock to block stale second claimants");
  assert(jobsSource.includes("notificationSessionFile"), "jobs should persist the durable session file path for wake-up-target tracking");
  assert(jobsSource.includes("recordNotificationTarget"), "jobs should persist the intended notification target before best-effort wake-up delivery so retries can recover idempotently");
  assert(jobsSource.includes("ORACLE_WAKEUP_POST_SEND_RETENTION_MS"), "jobs should keep wake-up-target files around for a short post-send retention grace window");
  assert(jobsSource.includes("wakeupRetentionGraceIsActive"), "jobs should detect recently sent wake-ups when deciding whether removal/pruning is safe");
  assert(jobsSource.includes("if (job.status === \"complete\" || job.status === \"cancelled\") {"), "job pruning should treat complete/cancelled retention as an explicit age-based policy under the wake-up-only model");
  assert(jobsSource.includes("return ageMs >= retention.complete;"), "complete/cancelled job pruning should no longer depend on synthetic notification state");
  assert(jobsSource.includes("getTerminalCleanupStaleReason"), "terminal cleanup reconcile should detect live-but-stale cleanup workers");
  assert(jobsSource.includes("Oracle terminal cleanup is stale"), "terminal cleanup reconcile should recover live workers whose terminal cleanup heartbeat is stale");
  assert(jobsSource.includes("notification delivery is in flight"), "terminal job removal should refuse jobs with an in-flight notification claim instead of deleting around wake-up delivery");
  assert(jobsSource.includes("post-send retention grace window"), "terminal job removal should refuse recently woken jobs until their response/artifact files survive a short post-send grace window");
  assert(jobsSource.includes("Refusing to remove terminal oracle job"), "terminal job removal should refuse live terminal workers instead of deleting around them");
  assert(runtimeSource.includes("job.cleanupPending === true"), "runtime admission should stay blocked for jobs with cleanup still pending");
  assert(runtimeSource.includes("Array.isArray(job.cleanupWarnings) && job.cleanupWarnings.length > 0"), "runtime admission should stay blocked for jobs with unresolved cleanup warnings");
  assert(runtimeSource.includes("if (report.warnings.length > 0) {\n    return report;\n  }"), "runtime cleanup should keep leases when teardown leaves warnings");
  assert(toolsSource.includes("MAX_QUEUED_JOBS_PER_ACTIVE_RUNTIME"), "oracle submit should cap queued depth to avoid unbounded archive buildup");
  assert(toolsSource.includes("MAX_QUEUED_ARCHIVE_BYTES_PER_ACTIVE_RUNTIME"), "oracle submit should cap queued archive bytes to avoid filling tmp with queued jobs");
  assert(pkg.files?.includes("prompts"), "package.json files should include prompts");
  assert(pkg.pi?.prompts?.includes("./prompts"), "package.json pi.prompts should include ./prompts");
  assert(commandsSource.includes("Cancel a queued or active oracle job"), "oracle commands should allow queued-job cancellation");
  assert(commandsSource.includes("shouldAdvanceQueueAfterCancellation(cancelled)"), "oracle cancel command should only promote queued jobs after a clean cancellation");
  assert(commandsSource.includes("Refusing to remove non-terminal oracle job"), "oracle clean should refuse queued jobs");
  assert(jobsSource.includes("rm(cancelled.archivePath, { force: true })"), "queued cancellation should delete persisted archives to enforce queue storage caps");
  assert(jobsSource.includes("if (cleanupReport.warnings.length > 0)"), "terminal cleanup should retain job state when cleanup reports warnings");
  assert(jobsSource.includes("cleanupPending: terminated"), "terminal cancellation/recovery should mark cleanup pending until teardown finishes");
}

async function testResponseTimeoutGuard(): Promise<void> {
  const workerSource = await readFile(new URL("../extensions/oracle/worker/run-job.mjs", import.meta.url), "utf8");
  const authBootstrapSource = await readFile(new URL("../extensions/oracle/worker/auth-bootstrap.mjs", import.meta.url), "utf8");
  const stateLocksSource = await readFile(new URL("../extensions/oracle/worker/state-locks.mjs", import.meta.url), "utf8");
  const queueSource = await readFile(new URL("../extensions/oracle/lib/queue.ts", import.meta.url), "utf8");
  const toolsSource = await readFile(new URL("../extensions/oracle/lib/tools.ts", import.meta.url), "utf8");
  const heuristicsSource = await readFile(new URL("../extensions/oracle/worker/artifact-heuristics.mjs", import.meta.url), "utf8");
  assert(workerSource.includes("Message delivery timed out"), "worker should detect ChatGPT response timeout text");
  assert(workerSource.includes("clicking Retry once"), "worker should retry one response-delivery failure before failing");
  assert(workerSource.includes("querySelectorAll('button, a')"), "worker should scan both button and link artifact controls");
  assert(workerSource.includes("ARTIFACT_DOWNLOAD_TIMEOUT_MS = 90_000"), "worker should keep the longer artifact download timeout");
  assert(workerSource.includes("POST_SEND_SETTLE_MS = 15_000"), "worker should wait 15 seconds after send before continuing");
  assert(workerSource.includes("promoteQueuedJobsAfterCleanup"), "worker should promote queued jobs after cleanup for autonomous queue advancement");
  assert(workerSource.includes("Queued oracle archive is missing:"), "cleanup-driven promotion should fail queued jobs whose archive is missing");
  assert(!workerSource.includes("if (!existsSync(current.archivePath)) continue;"), "cleanup-driven promotion should not silently skip archive-missing queued jobs");
  assert(workerSource.includes('if (["complete", "failed", "cancelled"].includes(String(latest.status || ""))) return latest;'), "cleanup-driven promotion failure should mark killed jobs terminal even if they advanced beyond submitted");
  assert(workerSource.includes("workerStartedAt: await waitForProcessStartedAt(child.pid)"), "cleanup-driven worker promotion should capture worker start time for PID-safe cancellation");
  assert(!workerSource.includes("workerStartedAt: undefined"), "cleanup-driven worker promotion should not drop worker start time metadata");
  assert(workerSource.includes("if (job.workerPid) return true;"), "worker-side durable handoff checks should require a persisted pid");
  assert(!workerSource.includes('if (job.status === "waiting") return true;'), "worker-side durable handoff checks should not trust phase alone without a persisted pid");
  assert(workerSource.includes("await terminateWorkerPid(spawnedWorker.pid, spawnedWorker.workerStartedAt)"), "cleanup-driven queued promotion should terminate spawned workers when metadata persistence fails");
  assert(workerSource.includes("cleanupWarnings = await cleanupRuntime(current);"), "cleanup-driven queued promotion should tear down runtime artifacts after spawned-worker failures");
  assert(workerSource.includes("from \"./state-locks.mjs\""), "worker should use the shared hardened state-lock helper instead of keeping divergent lock/lease crash recovery logic inline");
  assert(authBootstrapSource.includes("from \"./state-locks.mjs\""), "auth bootstrap should use the shared hardened state-lock helper instead of keeping divergent auth-lock crash recovery logic inline");
  assert(stateLocksSource.includes("ORACLE_METADATA_WRITE_GRACE_MS = 1_000"), "shared worker state-lock helper should use a bounded grace before reclaiming metadata-less state dirs");
  assert(stateLocksSource.includes("createStateDirAtomically"), "shared worker state-lock helper should publish new state dirs atomically so first creation never exposes a final dir without metadata");
  assert(stateLocksSource.includes(".tmp-"), "shared worker state-lock helper should use hidden temp dir prefixes so fresh publishes are never mistaken for final lease/lock dirs");
  assert(stateLocksSource.includes("maybeReclaimIncompleteStateDir"), "shared worker state-lock helper should reclaim metadata-less state dirs left behind by crashes");
  assert(stateLocksSource.includes("await rename(tempPath, finalPath);"), "shared worker state-lock helper should atomically rename fully populated temp dirs into place for first publish");
  assert(stateLocksSource.includes("await rename(tempPath, targetPath);"), "shared worker state-lock helper should write metadata atomically via temp-file rename");
  assert(queueSource.includes("appendCleanupWarnings"), "global queued promotion should persist cleanup warnings from failed teardown");
  assert(toolsSource.includes("appendCleanupWarnings(job.id, cleanupReport.warnings)"), "submit failure teardown should persist cleanup warnings when runtime cleanup is incomplete");
  assert(workerSource.includes("cleanupWarnings: [...(job.cleanupWarnings || []), ...cleanupWarnings]"), "worker should persist cleanup warnings when runtime teardown is incomplete");
  assert(workerSource.includes("Stopping queued cleanup promotion after"), "cleanup-driven queued promotion should stop when teardown leaves warnings");
  assert(workerSource.includes("if (existing?.jobId === job.id) return true;"), "cleanup-driven queued promotion should reuse same-job conversation leases during retry");
  assert(workerSource.includes("cleanupPending: true"), "worker should mark terminal jobs as cleanup-pending before teardown starts");
  assert(workerSource.includes("cleanupPending: false"), "worker should clear cleanup-pending once teardown finishes");
  assert(workerSource.includes("if (cleanupWarnings.length === 0)"), "worker should only auto-promote queued jobs after a clean runtime teardown");
  assert(workerSource.includes("Skipping queued promotion because runtime cleanup left"), "worker should log when cleanup warnings block auto-promotion");
  assert(!workerSource.includes("Proceeding after model configuration timeout because strong in-dialog verification already succeeded"), "worker should not proceed if the model configuration sheet never closes");
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
    await writeFile(join(fixtureDir, "dev.sqlite"), "sqlite\n");
    await writeFile(join(fixtureDir, "secrets", "prod.pem"), "pem\n");
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
    assert(!rootEntries.includes("dev.sqlite"), "root archive expansion should exclude local database files by default");
    assert(!rootEntries.includes("secrets/prod.pem"), "root archive expansion should exclude root secrets directories by default");
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

    const explicitBuildFileEntries = await resolveExpandedArchiveEntries(fixtureDir, ["build/root-output.js"]);
    assert(explicitBuildFileEntries.length === 1 && explicitBuildFileEntries[0] === "build/root-output.js", "explicitly requested files should always be preserved");

    const explicitEnvEntries = await resolveExpandedArchiveEntries(fixtureDir, [".env"]);
    assert(explicitEnvEntries.length === 1 && explicitEnvEntries[0] === ".env", "explicitly requested secret-bearing files should be preserved");

    const explicitSecretsDirEntries = await resolveExpandedArchiveEntries(fixtureDir, ["secrets"]);
    assert(explicitSecretsDirEntries.includes("secrets/prod.pem"), "explicitly requested root secrets directories should be preserved");

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

function testThinkingClosedStateVerification(): void {
  const closedThinkingSnapshot = [
    '- button "Thinking, click to remove" [ref=e110]',
    '- button "Thinking" [expanded=false, ref=e111]',
  ].join("\n");
  const entries = parseSnapshotEntries(closedThinkingSnapshot);
  const thinkingVisible = entries.some((entry) => {
    if (entry.disabled || entry.kind !== "button") return false;
    const label = String(entry.label || "").toLowerCase();
    return label === "thinking" || label === "thinking, click to remove" || label.startsWith("thinking ");
  });
  assert(thinkingVisible, "closed thinking snapshots should still verify model selection even when effort is hidden");
}

async function testSanityRunnerIsolation(): Promise<void> {
  const runnerSource = await readFile(new URL("./oracle-sanity-runner.mjs", import.meta.url), "utf8");
  assert(runnerSource.includes("/tmp/pi-oracle-sanity-state-"), "sanity runner should force an isolated oracle state dir");
  assert(runnerSource.includes("/tmp/pi-oracle-sanity-jobs-"), "sanity runner should force an isolated oracle jobs dir");
  assert(!runnerSource.includes("process.env.PI_ORACLE_STATE_DIR?.trim()"), "sanity runner should not reuse inherited production state dir env");
  assert(!runnerSource.includes("process.env.PI_ORACLE_JOBS_DIR?.trim()"), "sanity runner should not reuse inherited production jobs dir env");
}

function testArtifactCandidateHeuristics(): void {
  const successCandidates = filterStructuralArtifactCandidates([
    {
      label: "sup-homie.txt",
      paragraphText: "Created the artifact: sup-homie.txt",
      listItemText: "",
      paragraphFileButtonCount: 1,
      paragraphOtherTextLength: 21,
      listItemFileButtonCount: 0,
      focusableFileButtonCount: 1,
      focusableOtherTextLength: 21,
    },
    {
      label: "linked-download.txt",
      paragraphText: "linked-download.txt",
      listItemText: "linked-download.txt",
      paragraphFileButtonCount: 1,
      paragraphOtherTextLength: 0,
      listItemFileButtonCount: 1,
      focusableFileButtonCount: 1,
      focusableOtherTextLength: 0,
    },
    {
      label: "Attached",
      paragraphText: "Attached",
      listItemText: "Attached",
      paragraphFileButtonCount: 1,
      paragraphOtherTextLength: 0,
      listItemFileButtonCount: 1,
      focusableFileButtonCount: 1,
      focusableOtherTextLength: 0,
    },
    {
      label: "Done",
      paragraphText: "Done",
      listItemText: "Done",
      paragraphFileButtonCount: 1,
      paragraphOtherTextLength: 0,
      listItemFileButtonCount: 1,
      focusableFileButtonCount: 1,
      focusableOtherTextLength: 0,
    },
  ]);
  assert(successCandidates.some((candidate) => candidate.label === "sup-homie.txt"), "artifact heuristics should preserve real downloadable artifacts");
  assert(successCandidates.some((candidate) => candidate.label === "linked-download.txt"), "artifact heuristics should preserve link-rendered downloadable artifacts");
  assert(successCandidates.some((candidate) => candidate.label === "Attached"), "artifact heuristics should preserve generic Attached download controls");
  assert(successCandidates.some((candidate) => candidate.label === "Done"), "artifact heuristics should preserve generic Done download controls");

  const falsePositiveCandidates = filterStructuralArtifactCandidates([
    {
      label: "package.json",
      paragraphText: "Related process issue: the current flow is still self-inconsistent. check:release starts with the clean-tree guard in package.json via scripts/check-clean-worktree.mjs, while the README says to regenerate provider QA bundles first and then run release check in README.md.",
      listItemText: "",
      paragraphFileButtonCount: 3,
      paragraphOtherTextLength: 180,
      listItemFileButtonCount: 0,
      focusableFileButtonCount: 3,
      focusableOtherTextLength: 180,
    },
    {
      label: "scripts/check-clean-worktree.mjs",
      paragraphText: "Related process issue: the current flow is still self-inconsistent. check:release starts with the clean-tree guard in package.json via scripts/check-clean-worktree.mjs, while the README says to regenerate provider QA bundles first and then run release check in README.md.",
      listItemText: "",
      paragraphFileButtonCount: 3,
      paragraphOtherTextLength: 180,
      listItemFileButtonCount: 0,
      focusableFileButtonCount: 3,
      focusableOtherTextLength: 180,
    },
  ]);
  assert(falsePositiveCandidates.length === 0, "artifact heuristics should ignore inline file-reference buttons in normal prose responses");

  const artifactOnlyCandidates = filterStructuralArtifactCandidates([
    {
      label: "report.csv",
      paragraphText: "report.csv",
      listItemText: "report.csv",
      paragraphFileButtonCount: 1,
      paragraphOtherTextLength: 0,
      listItemFileButtonCount: 1,
      focusableFileButtonCount: 1,
      focusableOtherTextLength: 0,
    },
    {
      label: "dog.txt",
      paragraphText: "dog.txt cat.txt",
      listItemText: "",
      paragraphFileButtonCount: 2,
      paragraphOtherTextLength: 0,
      listItemFileButtonCount: 0,
      focusableFileButtonCount: 2,
      focusableOtherTextLength: 8,
    },
    {
      label: "cat.txt",
      paragraphText: "dog.txt cat.txt",
      listItemText: "",
      paragraphFileButtonCount: 2,
      paragraphOtherTextLength: 0,
      listItemFileButtonCount: 0,
      focusableFileButtonCount: 2,
      focusableOtherTextLength: 8,
    },
  ]);
  assert(artifactOnlyCandidates.some((candidate) => candidate.label === "report.csv"), "empty artifact-only responses should still allow artifact capture");
  assert(artifactOnlyCandidates.some((candidate) => candidate.label === "dog.txt"), "compact multi-file artifact blocks should still allow artifact capture");
  assert(artifactOnlyCandidates.some((candidate) => candidate.label === "cat.txt"), "compact multi-file artifact blocks should still allow artifact capture");
}

async function testPollerHostSafety(): Promise<void> {
  const sessionFile = "/tmp/oracle-sanity-session-host-safety.jsonl";
  const pi: any = { sendMessage: () => {} };
  const ctx: any = {
    cwd: process.cwd(),
    sessionManager: { getSessionFile: () => sessionFile },
    ui: { setStatus: () => {}, theme: { fg: (_name: string, text: string) => text } },
  };

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
  await testJobCreationNormalizesEffort(config);
  await testOracleCleanRefusesTerminalJobsWithLiveWorkers(config);
  await testStaleReconcileDoesNotOverwriteConcurrentCompletion(config);
  await testActiveCancellationDoesNotOverwriteCompletion(config);
  await testQueueAdmissionPromotionAndCancellation(config);
  await testQueuedPromotionUsesPersistedConfigSnapshot(config);
  await testQueuedPromotionRequiresArchiveReadiness(config);
  await testQueuedCancellationSerializesWithPromotion(config);
  await testCancelCleanupWarningsDoNotPromoteQueuedJobs(config);
  await testCancelFailureDoesNotPromoteQueuedJobs(config);
  await testQueuedPromotionPersistsCleanupWarningsOnTeardownFailure(config);
  await testQueuedPromotionKillsWorkerWhenMetadataWriteFails(config);
  await testQueuedPromotionToleratesWorkerStateAdvance(config);
  await testQueuedPromotionReusesSameJobConversationLease(config);
  await testQueuedPromotionSkipsConversationBlockedJobs(config);
  await testNotificationClaims(config);
  await testMarkJobNotifiedRejectsStaleClaimant(config);
  await testOracleSubmitRejectsMissingSessionIdentity();
  await testOracleReadUsesConfiguredJobsDir(config);
  await testManualReadsSettleWakeupRetries(config);
  await testPollerNotification(config);
  await testOracleExtensionSkipsNoSessionWakeupRouting(config);
  await testPersistedSessionsDoNotAdoptLegacyProjectScopedJobs(config);
  await testPollerNotificationSkipsContestedSameSessionWriters(config);
  await testBranchedSameSessionSkipsDurableNotification(config);
  await testPreAssistantSameSessionNotificationPreservesInMemoryHistory(config);
  await testPreAssistantBranchedSameSessionSkipsDurableNotification(config);
  await testNotificationMessagePreservesSessionModel(config);
  await testPollerNotificationAdoptsOrphanedSessionJobs(config);
  await testPollerDoesNotStealNotificationFromLiveSessionTarget(config);
  await testFreshWakeupTargetLeasePublishIsAtomic();
  await testWakeupTargetLeaseRenewalStaysVisibleToAdopters(config);
  await testPollerDoesNotStealNotificationWhenOriginBecomesLiveAfterClaim(config);
  await testPollerDoesNotStealNotificationWhenOriginBecomesLiveBeforePersist(config);
  await testOffSessionWakeupsDoNotWriteTargetSessionHistory(config);
  await testNotificationClaimRecoveryDoesNotDuplicateWakeups(config);
  await testStaleWakeupClaimsDoNotDuplicateReminders(config);
  await testStalePruneCandidatesDoNotSendWakeups(config);
  await testClaimedJobsBlockRemovalBeforeWakeup(config);
  await testPostSendWakeupGraceBlocksPrune(config);
  await testOracleCleanHonorsPostSendWakeupGrace(config);
  await testPollerWakeupRetriesStayBoundedWithoutDurableNotifications(config);
  await testStaleLockRecovery();
  await testDeadPidLockSweep();
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
  await testArchiveAutoPrunesNestedBuildDirsWhenWholeRepoIsTooLarge();
  await testArchiveAutoPrunesSubThresholdGeneratedDirsWhenWholeRepoIsTooLarge();
  await testSanityRunnerIsolation();
  testDurableWorkerHandoff();
  testThinkingClosedStateVerification();
  testArtifactCandidateHeuristics();
  await testPollerHostSafety();
  await rm(getOracleStateDir(), { recursive: true, force: true }).catch(() => undefined);
  console.log("oracle sanity checks passed");
}

await main();
