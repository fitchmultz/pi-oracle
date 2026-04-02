import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DEFAULT_CONFIG, type OracleConfig } from "../extensions/oracle/lib/config.ts";
import {
  createJob,
  getJobDir,
  isActiveOracleJob,
  listOracleJobDirs,
  markJobNotified,
  readJob,
  releaseNotificationClaim,
  tryClaimNotification,
  updateJob,
  withJobPhase,
} from "../extensions/oracle/lib/jobs.ts";
import { withGlobalReconcileLock } from "../extensions/oracle/lib/locks.ts";
import { startPoller, stopPollerForSession } from "../extensions/oracle/lib/poller.ts";
import { acquireConversationLease, acquireRuntimeLease, releaseConversationLease, releaseRuntimeLease } from "../extensions/oracle/lib/runtime.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function ensureNoActiveJobs(): Promise<void> {
  const activeJobs = listOracleJobDirs()
    .map((dir) => readJob(dir))
    .filter((job): job is NonNullable<typeof job> => Boolean(job))
    .filter((job) => isActiveOracleJob(job));
  if (activeJobs.length > 0) {
    throw new Error(`Refusing to run oracle sanity checks while active jobs exist: ${activeJobs.map((job) => job.id).join(", ")}`);
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
  await rm("/tmp/pi-oracle-state", { recursive: true, force: true });
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

async function createTerminalJob(config: OracleConfig, cwd: string, sessionId: string, requestSource: "tool" | "command" = "tool") {
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
      requestSource,
    },
    cwd,
    sessionId,
    config,
    runtime,
  );
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

async function testPollerNotification(config: OracleConfig): Promise<void> {
  const sessionFile = "/tmp/oracle-sanity-session-poller.jsonl";
  const jobId = await createTerminalJob(config, process.cwd(), sessionFile);
  const sent: Array<{ details?: { jobId?: string } }> = [];
  const pi: any = {
    sendMessage(message: any) {
      sent.push(message);
    },
  };
  const ctx: any = {
    cwd: process.cwd(),
    sessionManager: { getSessionFile: () => sessionFile },
    ui: { setStatus: () => {}, theme: { fg: (_name: string, text: string) => text } },
  };

  startPoller(pi, ctx, 50);
  await sleep(250);
  stopPollerForSession(sessionFile, ctx.cwd);

  assert(sent.length === 1, `expected exactly one poller notification, saw ${sent.length}`);
  assert(sent[0]?.details?.jobId === jobId, "poller should notify for the expected job id");
  assert(Boolean(readJob(jobId)?.notifiedAt), "poller should persist notifiedAt");
  await cleanupJob(jobId);
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
      startPoller(pi, ctx, 50);
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
  const config: OracleConfig = {
    ...DEFAULT_CONFIG,
    browser: { ...DEFAULT_CONFIG.browser, maxConcurrentJobs: 1 },
  };

  await testRuntimeConversationLeases(config);
  await testNotificationClaims(config);
  await testPollerNotification(config);
  await testPollerHostSafety();
  await rm("/tmp/pi-oracle-state", { recursive: true, force: true });
  console.log("oracle sanity checks passed");
}

await main();
