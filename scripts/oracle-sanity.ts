import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DEFAULT_CONFIG, type OracleConfig } from "../extensions/oracle/lib/config.ts";
import { ensureAccountCookie, filterImportableAuthCookies } from "../extensions/oracle/worker/auth-cookie-policy.mjs";
import { filterStructuralArtifactCandidates, parseSnapshotEntries } from "../extensions/oracle/worker/artifact-heuristics.mjs";
import {
  createJob,
  getJobDir,
  isActiveOracleJob,
  listOracleJobDirs,
  markJobNotified,
  pruneTerminalOracleJobs,
  readJob,
  removeTerminalOracleJob,
  tryClaimNotification,
  updateJob,
  withJobPhase,
} from "../extensions/oracle/lib/jobs.ts";
import { acquireLock, getOracleStateDir, sweepStaleLocks, withGlobalReconcileLock } from "../extensions/oracle/lib/locks.ts";
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

function testAuthCookiePolicy(): void {
  const rawCookies = [
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
  await updateJob(oldCompleteJobId, (job) => ({ ...job, createdAt: completePruneTimestamp, completedAt: completePruneTimestamp, notifiedAt: completePruneTimestamp }));
  await updateJob(oldFailedJobId, (job) => ({
    ...job,
    status: "failed",
    phase: "failed",
    createdAt: oldTimestamp,
    completedAt: oldTimestamp,
    phaseAt: oldTimestamp,
  }));
  await updateJob(retainedJobId, (job) => ({ ...job, createdAt: completePruneTimestamp, completedAt: completePruneTimestamp, notifiedAt: undefined }));

  const pruned = await pruneTerminalOracleJobs(Date.now());
  assert(pruned.includes(oldCompleteJobId), "old notified complete job should be pruned");
  assert(pruned.includes(oldFailedJobId), "old failed job should be pruned");
  assert(!pruned.includes(retainedJobId), "unnotified complete job should be retained");
  assert(!readJob(oldCompleteJobId), "pruned complete job should be removed");
  assert(!readJob(oldFailedJobId), "pruned failed job should be removed");
  assert(Boolean(readJob(retainedJobId)), "retained job should still exist");
  await cleanupJob(retainedJobId);
}

async function testLifecycleEventCutover(): Promise<void> {
  const extensionSource = await readFile(new URL("../extensions/oracle/index.ts", import.meta.url), "utf8");
  assert(extensionSource.includes('pi.on("session_start"'), "oracle extension should bind session_start");
  assert(!extensionSource.includes('pi.on("session_switch"'), "oracle extension must not bind removed session_switch event");
  assert(!extensionSource.includes('pi.on("session_fork"'), "oracle extension must not bind removed session_fork event");
}

async function testOraclePromptTemplateCutover(): Promise<void> {
  const commandsSource = await readFile(new URL("../extensions/oracle/lib/commands.ts", import.meta.url), "utf8");
  const promptSource = await readFile(new URL("../prompts/oracle.md", import.meta.url), "utf8");
  const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as {
    files?: string[];
    pi?: { prompts?: string[] };
  };

  assert(!commandsSource.includes('registerCommand("oracle"'), "/oracle should not be registered as an extension command");
  assert(promptSource.includes("You are preparing an /oracle job."), "/oracle prompt template should contain the oracle dispatch instructions");
  assert(pkg.files?.includes("prompts"), "package.json files should include prompts");
  assert(pkg.pi?.prompts?.includes("./prompts"), "package.json pi.prompts should include ./prompts");
}

async function testResponseTimeoutGuard(): Promise<void> {
  const workerSource = await readFile(new URL("../extensions/oracle/worker/run-job.mjs", import.meta.url), "utf8");
  const heuristicsSource = await readFile(new URL("../extensions/oracle/worker/artifact-heuristics.mjs", import.meta.url), "utf8");
  assert(workerSource.includes("Message delivery timed out"), "worker should detect ChatGPT response timeout text");
  assert(workerSource.includes("clicking Retry once"), "worker should retry one response-delivery failure before failing");
  assert(workerSource.includes("querySelectorAll('button, a')"), "worker should scan both button and link artifact controls");
  assert(workerSource.includes("ARTIFACT_DOWNLOAD_TIMEOUT_MS = 90_000"), "worker should keep the longer artifact download timeout");
  assert(!workerSource.includes("Proceeding after model configuration timeout because strong in-dialog verification already succeeded"), "worker should not proceed if the model configuration sheet never closes");
  assert(heuristicsSource.includes("GENERIC_ARTIFACT_LABELS"), "artifact heuristics should preserve generic attachment labels");
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

  testAuthCookiePolicy();
  await testRuntimeConversationLeases(config);
  await testJobCreationNormalizesEffort(config);
  await testNotificationClaims(config);
  await testPollerNotification(config);
  await testStaleLockRecovery();
  await testDeadPidLockSweep();
  await testTerminalJobPruningAndCleanup(config);
  await testLifecycleEventCutover();
  await testOraclePromptTemplateCutover();
  await testResponseTimeoutGuard();
  await testSanityRunnerIsolation();
  testThinkingClosedStateVerification();
  testArtifactCandidateHeuristics();
  await testPollerHostSafety();
  await rm(getOracleStateDir(), { recursive: true, force: true });
  console.log("oracle sanity checks passed");
}

await main();
