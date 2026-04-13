// Purpose: Hold poller, wake-up, and detached-session oracle sanity coverage outside the main sanity entrypoint.
// Responsibilities: Exercise notification claims, wake-up settlement, same-session/off-session delivery rules, and poller retry/prune behavior.
// Scope: Test-only poller suite code for the local oracle sanity harness.
// Usage: Imported by scripts/oracle-sanity.ts and run as part of the full sanity gate.
// Invariants/Assumptions: Tests run with isolated oracle state/jobs directories and use persisted session managers for wake-up routing coverage.
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager, type ExtensionAPI, type ExtensionCommandContext, type ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { OracleConfig } from "../extensions/oracle/lib/config.ts";
import {
  cancelOracleJob,
  getJobDir,
  listOracleJobDirs,
  markJobNotified,
  pruneTerminalOracleJobs,
  readJob,
  removeTerminalOracleJob,
  tryClaimNotification,
  updateJob,
} from "../extensions/oracle/lib/jobs.ts";
import { getLeasesDir, getOracleStateDir, listLeaseMetadata, releaseLease, writeLeaseMetadata } from "../extensions/oracle/lib/locks.ts";
import { getPollerSessionKey, scanOracleJobsOnce, startPoller, stopPollerForSession } from "../extensions/oracle/lib/poller.ts";
import { promoteQueuedJobsWithinAdmissionLock } from "../extensions/oracle/lib/queue.ts";
import { getProjectId, releaseRuntimeLease } from "../extensions/oracle/lib/runtime.ts";
import { registerOracleCommands } from "../extensions/oracle/lib/commands.ts";
import { registerOracleTools } from "../extensions/oracle/lib/tools.ts";
import oracleExtension from "../extensions/oracle/index.ts";
import {
  appendAssistantMessage,
  appendUserMessage,
  asRecord,
  assert,
  cleanupJob,
  completeJob,
  createJobForTest,
  createPersistedSessionManager,
  createPiHarness,
  createPollerCtx,
  createTerminalJob,
  createCommandCtx,
  createExtensionCtx,
  createUiStub,
  type SentMessageLike,
  findNotificationEntry,
  hashedOracleStatePath,
  isPidAlive,
  pathExists,
  readProcessStartedAt,
  resetOracleStateDir,
  sleep,
  waitForCondition,
  waitForPidExit,
  waitForProcessStartedAtValue,
} from "./oracle-sanity-support.ts";

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

  const sent: SentMessageLike[] = [];
  const pi = createPiHarness();
  pi.sendMessage = (message) => {
    sent.push(message);
  };
  const ctx = createExtensionCtx(sessionManager);

  startPoller(pi as unknown as ExtensionAPI, ctx, 50, "/tmp/fake-oracle-worker.mjs");
  await waitForCondition(() => (sent.length >= 1 ? true : undefined), { timeoutMs: 1_500, description: "poller wake-up delivery" });
  stopPollerForSession(sessionFile, ctx.cwd);

  const reopenedSession = SessionManager.open(sessionFile, undefined, process.cwd());
  assert(!findNotificationEntry(reopenedSession, jobId), "same-session live pollers should not append a durable oracle completion message directly into the active session history");
  assert(sent.length >= 1, `expected at least one best-effort wake-up request, saw ${sent.length}`);
  assert((sent[0]?.details as { jobId?: string } | undefined)?.jobId === jobId, "poller should request wake-up for the expected job id");
  const deliveredJob = readJob(jobId);
  assert(deliveredJob?.responsePath, "poller notification coverage should retain the response path");
  const notificationText = sent[0]?.content;
  assert(typeof notificationText === "string", "poller should send text wake-up content");
  assert(notificationText.includes(`Use /oracle-read ${jobId}`), "poller wake-up content should direct the receiving session to /oracle-read as the primary saved-result path");
  assert(notificationText.includes(`/oracle-status ${jobId}`), "poller wake-up content should still mention /oracle-status as the metadata-oriented fallback path");
  assert(notificationText.includes(`oracle_read({ jobId: \"${jobId}\" })`), "poller wake-up content should still mention oracle_read for agent callers who need tool output in-turn");
  assert(notificationText.includes(`Response file: ${deliveredJob.responsePath}`), "poller wake-up content should still include the persisted response path as secondary context");
  assert(notificationText.includes(`Artifacts: ${getJobDir(jobId)}/artifacts`), "poller wake-up content should still include the persisted artifacts directory");
  assert(!notificationText.includes("Read response:"), "poller wake-up content should not steer the receiver toward a raw response-file read as the primary action");
  assert(!readJob(jobId)?.notifiedAt, "same-session live pollers should leave jobs unnotified while completion delivery remains best-effort only");
  await cleanupJob(jobId);
}

async function testOracleSubmitRejectsMissingSessionIdentity(): Promise<void> {
  await resetOracleStateDir();
  const fakeWorkerPath = join(tmpdir(), `oracle-sanity-missing-session-worker-${randomUUID()}.mjs`);
  await writeFile(fakeWorkerPath, "process.exit(0);\n", { mode: 0o600 });

  const pi = createPiHarness();
  registerOracleTools(pi as unknown as ExtensionAPI, fakeWorkerPath);
  const submitTool = pi.tools.get("oracle_submit");
  assert(submitTool, "oracle submit tool should register");

  const result = await submitTool.execute!(
    "oracle-submit-missing-session",
    { prompt: "test", files: ["README.md"] },
    undefined,
    () => { },
    createExtensionCtx({ getSessionFile: () => undefined } as ExtensionContext["sessionManager"]),
  ) as { details?: unknown };
  const errorDetails = asRecord(asRecord(result.details)?.error);

  await rm(fakeWorkerPath, { force: true });
  assert(errorDetails?.code === "persisted_session_required", "oracle submit should return a structured persisted_session_required error when session identity is unavailable");
  assert(listOracleJobDirs().length === 0, "oracle submit should not persist jobs when session identity is unavailable");
}

async function testOracleReadUsesConfiguredJobsDir(config: OracleConfig): Promise<void> {
  await resetOracleStateDir();
  const fakeWorkerPath = join(tmpdir(), `oracle-sanity-read-worker-${randomUUID()}.mjs`);
  await writeFile(fakeWorkerPath, "process.exit(0);\n", { mode: 0o600 });

  const pi = createPiHarness();
  registerOracleTools(pi as unknown as ExtensionAPI, fakeWorkerPath);
  const readTool = pi.tools.get("oracle_read");
  assert(readTool, "oracle read tool should register");

  const sessionManager = createPersistedSessionManager("oracle-read-paths");
  const sessionFile = sessionManager.getSessionFile();
  assert(sessionFile, "oracle read test should persist a session file");
  const jobId = await createTerminalJob(config, process.cwd(), sessionFile);
  const expectedArtifactsPath = `${getJobDir(jobId)}/artifacts`;
  assert(!expectedArtifactsPath.startsWith(`/tmp/oracle-${jobId}/artifacts`), "sanity runner should use a non-default jobs dir for oracle read path coverage");

  try {
    const result = await readTool.execute!("oracle-read-path-test", { jobId }, undefined, () => { }, createExtensionCtx(sessionManager)) as { content?: Array<{ text?: string }> };
    const text = result.content?.[0]?.text;
    assert(typeof text === "string", "oracle read should return text output");
    assert(text.includes(`artifacts: ${expectedArtifactsPath}`), "oracle read should report the configured jobs dir artifacts path");
    assert(!text.includes(`artifacts: /tmp/oracle-${jobId}/artifacts`), "oracle read should not hard-code the default /tmp oracle artifacts path");
  } finally {
    await rm(fakeWorkerPath, { force: true });
    await cleanupJob(jobId);
  }
}

async function testManualReadsSettleWakeupRetries(config: OracleConfig): Promise<void> {
  await resetOracleStateDir();
  const fakeWorkerPath = join(tmpdir(), `oracle-sanity-manual-read-worker-${randomUUID()}.mjs`);
  await writeFile(fakeWorkerPath, "process.exit(0);\n", { mode: 0o600 });

  const pi = createPiHarness();
  registerOracleTools(pi as unknown as ExtensionAPI, fakeWorkerPath);
  registerOracleCommands(pi as unknown as ExtensionAPI, fakeWorkerPath, fakeWorkerPath);
  const readTool = pi.tools.get("oracle_read");
  const statusCommand = pi.commands.get("oracle-status");
  assert(readTool, "oracle read tool should register for wake-up settlement coverage");
  assert(statusCommand, "oracle status command should register for wake-up settlement coverage");

  const sessionManager = createPersistedSessionManager("oracle-manual-settle");
  const sessionFile = sessionManager.getSessionFile();
  assert(sessionFile, "manual read wake-up settlement test should persist a session file");
  const ctx = createCommandCtx(sessionManager);
  const expectedSessionKey = getPollerSessionKey(sessionFile, process.cwd());

  const setRetryEligible = async (jobId: string) => {
    await updateJob(jobId, (job) => ({
      ...job,
      wakeupAttemptCount: 1,
      wakeupLastRequestedAt: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
      wakeupSettledAt: undefined,
      wakeupSettledSource: undefined,
      wakeupSettledSessionFile: undefined,
      wakeupSettledSessionKey: undefined,
      wakeupSettledBeforeFirstAttempt: undefined,
      wakeupObservedAt: undefined,
      wakeupObservedSource: undefined,
      wakeupObservedSessionFile: undefined,
      wakeupObservedSessionKey: undefined,
    }));
  };

  const assertNoFurtherWakeup = async (jobId: string, message: string) => {
    const sent: SentMessageLike[] = [];
    const harness = createPiHarness();
    harness.sendMessage = (payload) => {
      sent.push(payload);
    };
    await scanOracleJobsOnce(harness as unknown as ExtensionAPI, createPollerCtx(sessionManager), fakeWorkerPath);
    stopPollerForSession(sessionFile, process.cwd());
    assert(sent.length === 0, message);
  };

  const readJobId = await createTerminalJob(config, process.cwd(), sessionFile);
  try {
    await setRetryEligible(readJobId);
    await readTool.execute!("oracle-read-settles-wakeup", { jobId: readJobId }, undefined, () => { }, ctx);
    const readSettled = readJob(readJobId);
    assert(Boolean(readSettled?.wakeupSettledAt), "oracle read should mark terminal jobs settled after a manual read");
    assert(readSettled?.wakeupSettledSource === "oracle_read", "oracle read settlement should persist provenance for the settling path");
    assert(readSettled?.wakeupSettledSessionFile === sessionFile, "oracle read settlement should persist the settling session file");
    assert(readSettled?.wakeupSettledSessionKey === expectedSessionKey, "oracle read settlement should persist the settling session key");
    assert(readSettled?.wakeupSettledBeforeFirstAttempt === false, "oracle read settlement after a wake-up attempt should record that it was not a pre-send settle");
    await assertNoFurtherWakeup(readJobId, "oracle read should stop further best-effort wake-up retries once the terminal job has been manually inspected");
  } finally {
    await cleanupJob(readJobId);
  }

  const statusJobId = await createTerminalJob(config, process.cwd(), sessionFile);
  try {
    await setRetryEligible(statusJobId);
    await statusCommand!.handler(statusJobId, ctx);
    const statusSettled = readJob(statusJobId);
    assert(Boolean(statusSettled?.wakeupSettledAt), "oracle status should mark terminal jobs settled after a manual status read");
    assert(statusSettled?.wakeupSettledSource === "oracle_status", "oracle status settlement should persist provenance for the settling path");
    assert(statusSettled?.wakeupSettledSessionFile === sessionFile, "oracle status settlement should persist the settling session file");
    assert(statusSettled?.wakeupSettledSessionKey === expectedSessionKey, "oracle status settlement should persist the settling session key");
    assert(statusSettled?.wakeupSettledBeforeFirstAttempt === false, "oracle status settlement after a wake-up attempt should record that it was not a pre-send settle");
    await assertNoFurtherWakeup(statusJobId, "oracle status should stop further best-effort wake-up retries once the terminal job has been manually inspected");
  } finally {
    await cleanupJob(statusJobId);
    await rm(fakeWorkerPath, { force: true });
  }
}

async function testPreSendStatusObservationDoesNotSuppressFirstWakeup(config: OracleConfig): Promise<void> {
  await resetOracleStateDir();
  const fakeWorkerPath = join(tmpdir(), `oracle-sanity-pre-send-status-worker-${randomUUID()}.mjs`);
  await writeFile(fakeWorkerPath, "process.exit(0);\n", { mode: 0o600 });

  const pi = createPiHarness();
  registerOracleTools(pi as unknown as ExtensionAPI, fakeWorkerPath);
  registerOracleCommands(pi as unknown as ExtensionAPI, fakeWorkerPath, fakeWorkerPath);
  const statusCommand = pi.commands.get("oracle-status");
  assert(statusCommand, "oracle status command should register for pre-send observation coverage");

  const sessionManager = createPersistedSessionManager("oracle-pre-send-status");
  const sessionFile = sessionManager.getSessionFile();
  assert(sessionFile, "pre-send status observation test should persist a session file");
  const expectedSessionKey = getPollerSessionKey(sessionFile, process.cwd());
  const ctx = createCommandCtx(sessionManager);

  const assertWakeupCount = async (jobId: string, expectedCount: number, message: string) => {
    const sent: SentMessageLike[] = [];
    const harness = createPiHarness();
    harness.sendMessage = (payload) => {
      sent.push(payload);
    };
    await scanOracleJobsOnce(harness as unknown as ExtensionAPI, createPollerCtx(sessionManager), fakeWorkerPath);
    stopPollerForSession(sessionFile, process.cwd());
    assert(sent.length === expectedCount, message);
  };

  const jobId = await createTerminalJob(config, process.cwd(), sessionFile);
  try {
    await statusCommand!.handler(jobId, ctx);
    const observed = readJob(jobId);
    assert(!observed?.wakeupSettledAt, "pre-send oracle status inspection should not settle the very first wake-up attempt");
    assert(observed?.wakeupObservedSource === "oracle_status", "pre-send oracle status inspection should persist observation provenance");
    assert(observed?.wakeupObservedSessionFile === sessionFile, "pre-send oracle status inspection should persist the observing session file");
    assert(observed?.wakeupObservedSessionKey === expectedSessionKey, "pre-send oracle status inspection should persist the observing session key");

    await assertWakeupCount(jobId, 1, "pre-send oracle status inspection should still allow the first wake-up attempt to fire");
    assert(readJob(jobId)?.wakeupAttemptCount === 1, "pre-send oracle status inspection should leave the job eligible for the first bounded wake-up attempt");

    await statusCommand!.handler(jobId, ctx);
    const settled = readJob(jobId);
    assert(Boolean(settled?.wakeupSettledAt), "oracle status should settle once a real wake-up attempt has already been sent");
    assert(settled?.wakeupSettledSource === "oracle_status", "post-send oracle status settlement should preserve provenance");
    assert(settled?.wakeupSettledSessionFile === sessionFile, "post-send oracle status settlement should persist the settling session file");
    assert(settled?.wakeupSettledSessionKey === expectedSessionKey, "post-send oracle status settlement should persist the settling session key");
    assert(settled?.wakeupSettledBeforeFirstAttempt === false, "post-send oracle status settlement should record that the first wake-up attempt had already happened");

    await assertWakeupCount(jobId, 0, "settled jobs should not emit any further wake-up retries after the manual post-send status inspection");
  } finally {
    await cleanupJob(jobId);
    await rm(fakeWorkerPath, { force: true });
  }
}

async function testOracleExtensionSkipsNoSessionWakeupRouting(config: OracleConfig): Promise<void> {
  await resetOracleStateDir();
  const sessionManager = createPersistedSessionManager("poller-no-session-submit");
  const sessionFile = sessionManager.getSessionFile();
  assert(sessionFile, "no-session startup test should persist a submitter session file");
  const jobId = await createTerminalJob(config, process.cwd(), sessionFile);
  await updateJob(jobId, (job) => ({
    ...job,
    sessionId: `ephemeral:${getProjectId(process.cwd())}`,
    originSessionFile: undefined,
  }));

  const sent: SentMessageLike[] = [];
  const pi = createPiHarness();
  pi.sendMessage = (message) => {
    sent.push(message);
  };
  oracleExtension(pi as unknown as ExtensionAPI);
  const sessionStart = pi.handlers.get("session_start");
  assert(sessionStart, "oracle extension should register a session_start handler");

  const ui = createUiStub();
  await sessionStart!({}, createExtensionCtx({ getSessionFile: () => undefined } as ExtensionContext["sessionManager"], ui));
  await waitForCondition(() => (ui.statuses.some((entry) => entry.value.includes("oracle: unavailable")) ? true : undefined), {
    timeoutMs: 1_000,
    description: "oracle unavailable status",
  });

  assert(sent.length === 0, `oracle extension should not start wake-up routing for no-session contexts, saw ${sent.length}`);
  assert(ui.statuses.some((entry) => entry.value.includes("oracle: unavailable")), "oracle extension should mark oracle unavailable when the current session has no persisted identity");
  await cleanupJob(jobId);
}

async function testPersistedSessionsDoNotAdoptLegacyProjectScopedJobs(config: OracleConfig): Promise<void> {
  await resetOracleStateDir();
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
  const sent: SentMessageLike[] = [];
  const adopterHarness = createPiHarness();
  adopterHarness.sendMessage = (message) => {
    sent.push(message);
  };
  await scanOracleJobsOnce(adopterHarness as unknown as ExtensionAPI, createPollerCtx(adopterSessionManager), "/tmp/fake-oracle-worker.mjs");
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
  await resetOracleStateDir();
  const submitterSessionManager = createPersistedSessionManager("poller-same-session-deferred-submit");
  const adopterSessionManager = createPersistedSessionManager("poller-same-session-deferred-adopter");
  const submitterSessionFile = submitterSessionManager.getSessionFile();
  const adopterSessionFile = adopterSessionManager.getSessionFile();
  assert(submitterSessionFile && adopterSessionFile, "deferred same-session notification test should persist both session files");
  appendAssistantMessage(submitterSessionManager, "prime same-session history", { provider: "anthropic", model: "claude-sonnet-4" });
  const jobId = await createTerminalJob(config, process.cwd(), submitterSessionFile);

  const sameSessionSent: SentMessageLike[] = [];
  const sameSessionPi = createPiHarness();
  sameSessionPi.sendMessage = (message) => {
    sameSessionSent.push(message);
  };
  await scanOracleJobsOnce(sameSessionPi as unknown as ExtensionAPI, createPollerCtx(submitterSessionManager), "/tmp/fake-oracle-worker.mjs");

  const deferredSession = SessionManager.open(submitterSessionFile, undefined, process.cwd());
  assert(!findNotificationEntry(deferredSession, jobId), "same-session live pollers should defer durable completion messages instead of appending directly into the active session");
  assert(!readJob(jobId)?.notifiedAt, "same-session live pollers should leave jobs unnotified while completion delivery is best-effort only");
  assert(sameSessionSent.length >= 1, `same-session live pollers should still request at least one best-effort wake-up, saw ${sameSessionSent.length}`);
  stopPollerForSession(submitterSessionFile, process.cwd());
  await updateJob(jobId, (job) => ({
    ...job,
    wakeupLastRequestedAt: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
  }));

  const adopterSent: SentMessageLike[] = [];
  const adopterPi = createPiHarness();
  adopterPi.sendMessage = (message) => {
    adopterSent.push(message);
  };
  await scanOracleJobsOnce(adopterPi as unknown as ExtensionAPI, createPollerCtx(adopterSessionManager), "/tmp/fake-oracle-worker.mjs");

  const reopenedSubmitterSession = SessionManager.open(submitterSessionFile, undefined, process.cwd());
  assert(!findNotificationEntry(reopenedSubmitterSession, jobId), "off-session adopters should not append durable completion messages into the target session history");
  assert(!readJob(jobId)?.notifiedAt, "off-session adopters should still leave jobs unnotified while completion delivery is best-effort only");
  assert(adopterSent.length >= 1, `off-session adopters should still request at least one best-effort wake-up in the adopting live session, saw ${adopterSent.length}`);
  await cleanupJob(jobId);
}

async function testBranchedSameSessionSkipsDurableNotification(config: OracleConfig): Promise<void> {
  await resetOracleStateDir();
  const sessionManager = createPersistedSessionManager("poller-same-session-branched");
  const sessionFile = sessionManager.getSessionFile();
  assert(sessionFile, "branched same-session notification test should persist a session file");
  const branchBaseId = appendAssistantMessage(sessionManager, "branch base", { provider: "anthropic", model: "claude-sonnet-4" });
  const headEntryId = sessionManager.appendCustomEntry("oracle-sanity-head", { stage: "newer-head" });
  const branchedSessionManager = SessionManager.open(sessionFile, undefined, process.cwd());
  branchedSessionManager.branch(branchBaseId);
  const jobId = await createTerminalJob(config, process.cwd(), sessionFile);

  const sent: SentMessageLike[] = [];
  const pi = createPiHarness();
  pi.sendMessage = (message) => {
    sent.push(message);
  };

  await scanOracleJobsOnce(pi as unknown as ExtensionAPI, createPollerCtx(branchedSessionManager), "/tmp/fake-oracle-worker.mjs");

  const reopenedSession = SessionManager.open(sessionFile, undefined, process.cwd());
  assert(reopenedSession.getEntries().some((entry) => entry.id === headEntryId), "branched same-session notification handling should preserve the on-disk head entry");
  assert(!findNotificationEntry(reopenedSession, jobId), "branched same-session notification handling should skip durable notification writes while the original session remains the live current session");
  assert(!readJob(jobId)?.notifiedAt, "branched same-session notification handling should leave the job unnotified while completion delivery is best-effort only");
  assert(sent.length >= 1, `branched same-session notification handling should still request a best-effort wake-up, saw ${sent.length}`);
  await cleanupJob(jobId);
}

async function testPreAssistantSameSessionNotificationPreservesInMemoryHistory(config: OracleConfig): Promise<void> {
  await resetOracleStateDir();
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
  const liveSent: SentMessageLike[] = [];
  const livePi = createPiHarness();
  livePi.sendMessage = (message) => {
    liveSent.push(message);
  };

  await scanOracleJobsOnce(livePi as unknown as ExtensionAPI, createPollerCtx(targetSessionManager), "/tmp/fake-oracle-worker.mjs");

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

  const adopterSent: SentMessageLike[] = [];
  const adopterPi = createPiHarness();
  adopterPi.sendMessage = (message) => {
    adopterSent.push(message);
  };
  await scanOracleJobsOnce(adopterPi as unknown as ExtensionAPI, createPollerCtx(adopterSessionManager), "/tmp/fake-oracle-worker.mjs");

  const reopenedSession = SessionManager.open(targetSessionFile, undefined, process.cwd());
  assert(!findNotificationEntry(reopenedSession, jobId), "off-session adopters should still avoid durable completion-message writes even after the target session later materializes on disk");
  assert(!readJob(jobId)?.notifiedAt, "off-session adopters should leave the job unnotified while completion delivery remains best-effort only");
  assert(adopterSent.length >= 1, `off-session adopters should request at least one best-effort wake-up from the adopting session, saw ${adopterSent.length}`);
  await cleanupJob(jobId);
}

async function testPreAssistantBranchedSameSessionSkipsDurableNotification(config: OracleConfig): Promise<void> {
  await resetOracleStateDir();
  const sessionManager = createPersistedSessionManager("poller-preassistant-branched");
  const sessionFile = sessionManager.getSessionFile();
  assert(sessionFile, "pre-assistant branched notification test should persist a session file");
  const userEntryId = appendUserMessage(sessionManager, "branch before oracle completion");
  sessionManager.appendCustomEntry("oracle-sanity-preassistant-branched", { stage: "before-assistant" });
  const modelEntryId = sessionManager.appendModelChange("anthropic", "claude-sonnet-4");
  const branchedSessionManager = sessionManager;
  branchedSessionManager.branch(userEntryId);
  const jobId = await createTerminalJob(config, process.cwd(), sessionFile);

  const sent: SentMessageLike[] = [];
  const pi = createPiHarness();
  pi.sendMessage = (message) => {
    sent.push(message);
  };

  await scanOracleJobsOnce(pi as unknown as ExtensionAPI, createPollerCtx(branchedSessionManager), "/tmp/fake-oracle-worker.mjs");

  const skippedSession = SessionManager.open(sessionFile, undefined, process.cwd());
  assert(skippedSession.getEntries().length === 0, "pre-assistant branched same-session notification handling should not flush hidden history by attempting a direct durable append from an older leaf");
  assert(!findNotificationEntry(skippedSession, jobId), "pre-assistant branched same-session notification handling should skip durable notification writes while the live leaf is behind newer in-memory history");
  assert(!readJob(jobId)?.notifiedAt, "pre-assistant branched same-session notification handling should leave the job unnotified while completion delivery is best-effort only");
  assert(sent.length >= 1, `pre-assistant branched same-session notification handling should still request at least one best-effort wake-up, saw ${sent.length}`);

  branchedSessionManager.branch(modelEntryId);
  await scanOracleJobsOnce(pi as unknown as ExtensionAPI, createPollerCtx(branchedSessionManager), "/tmp/fake-oracle-worker.mjs");
  assert(!findNotificationEntry(SessionManager.open(sessionFile, undefined, process.cwd()), jobId), "restoring the latest in-memory leaf in the live same-session manager should still avoid durable completion-message writes under the best-effort-only model");
  await cleanupJob(jobId);
}

async function testNotificationMessagePreservesSessionModel(config: OracleConfig): Promise<void> {
  await resetOracleStateDir();
  const targetSessionManager = createPersistedSessionManager("poller-notification-model-target");
  const adopterSessionManager = createPersistedSessionManager("poller-notification-model-adopter");
  const targetSessionFile = targetSessionManager.getSessionFile();
  assert(targetSessionFile, "notification model test should persist a target session file");
  appendAssistantMessage(targetSessionManager, "prime session history", { provider: "openai", model: "gpt-5" });
  targetSessionManager.appendModelChange("anthropic", "claude-sonnet-4");

  const modelBefore = SessionManager.open(targetSessionFile, undefined, process.cwd()).buildSessionContext().model;
  assert(modelBefore?.provider === "anthropic" && modelBefore?.modelId === "claude-sonnet-4", "notification model test should start from an explicit target-session model");

  const jobId = await createTerminalJob(config, process.cwd(), targetSessionFile);
  const sent: SentMessageLike[] = [];
  const pi = createPiHarness();
  pi.sendMessage = (message) => {
    sent.push(message);
  };

  await scanOracleJobsOnce(pi as unknown as ExtensionAPI, createPollerCtx(adopterSessionManager), "/tmp/fake-oracle-worker.mjs");

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

  const sent: SentMessageLike[] = [];
  const pi = createPiHarness();
  pi.sendMessage = (message) => {
    sent.push(message);
  };
  const ctx = createExtensionCtx(liveSessionManager);

  startPoller(pi as unknown as ExtensionAPI, ctx, 50, "/tmp/fake-oracle-worker.mjs");
  await sleep(250);
  stopPollerForSession(liveSessionFile, ctx.cwd);

  assert(!findNotificationEntry(SessionManager.open(submitterSessionFile, undefined, process.cwd()), jobId), "adopted orphaned jobs should not append a durable completion message into the original target session under the wake-up-only model");
  assert(sent.length >= 1, `expected orphaned job to trigger at least one wake-up request, saw ${sent.length}`);
  assert((sent[0]?.details as { jobId?: string } | undefined)?.jobId === jobId, "live poller should notify for orphaned jobs in the same project");
  assert(!readJob(jobId)?.notifiedAt, "adopted orphaned jobs should remain unnotified while completion delivery is best-effort only");
  await cleanupJob(jobId);
}

async function testPollerDoesNotStealNotificationFromLiveSessionTarget(config: OracleConfig): Promise<void> {
  await resetOracleStateDir();
  const submitterSessionManager = createPersistedSessionManager("poller-live-submit");
  const liveSessionManager = createPersistedSessionManager("poller-live-other");
  const submitterSessionFile = submitterSessionManager.getSessionFile();
  const liveSessionFile = liveSessionManager.getSessionFile();
  assert(submitterSessionFile && liveSessionFile, "live-target poller test should persist both session files");
  const jobId = await createTerminalJob(config, process.cwd(), submitterSessionFile);
  const job = readJob(jobId);
  assert(job, "live-target notification job should exist");

  const holder = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000);"], {
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

  const sent: SentMessageLike[] = [];
  const pi = createPiHarness();
  pi.sendMessage = (message) => {
    sent.push(message);
  };
  const ctx = createExtensionCtx(liveSessionManager);

  try {
    startPoller(pi as unknown as ExtensionAPI, ctx, 50, "/tmp/fake-oracle-worker.mjs");
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
  await resetOracleStateDir();
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
  await resetOracleStateDir();
  const submitterSessionManager = createPersistedSessionManager("poller-live-renew-submit");
  const liveSessionManager = createPersistedSessionManager("poller-live-renew-other");
  const submitterSessionFile = submitterSessionManager.getSessionFile();
  const liveSessionFile = liveSessionManager.getSessionFile();
  assert(submitterSessionFile && liveSessionFile, "live-renew poller test should persist both session files");
  const jobId = await createTerminalJob(config, process.cwd(), submitterSessionFile);
  const job = readJob(jobId);
  assert(job, "live-renew notification job should exist");

  const holder = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000);"], {
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

  const sent: SentMessageLike[] = [];
  const pi = createPiHarness();
  pi.sendMessage = (message) => {
    sent.push(message);
  };

  let missingLeaseReads = 0;
  try {
    for (let i = 0; i < 60; i += 1) {
      const leases = listLeaseMetadata<{ leaseKey?: string }>("wakeup-target");
      if (!leases.some((lease) => lease.leaseKey === wakeupTargetLeaseKey)) {
        missingLeaseReads += 1;
      }
      await scanOracleJobsOnce(pi as unknown as ExtensionAPI, createPollerCtx(liveSessionManager), "/tmp/fake-oracle-worker.mjs");
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
  await resetOracleStateDir();
  const submitterSessionManager = createPersistedSessionManager("poller-transition-submit");
  const liveSessionManager = createPersistedSessionManager("poller-transition-live");
  const submitterSessionFile = submitterSessionManager.getSessionFile();
  const liveSessionFile = liveSessionManager.getSessionFile();
  assert(submitterSessionFile && liveSessionFile, "transition poller test should persist both session files");
  const jobId = await createTerminalJob(config, process.cwd(), submitterSessionFile);
  const job = readJob(jobId);
  assert(job, "transition notification job should exist");

  const sent: SentMessageLike[] = [];
  const pi = createPiHarness();
  pi.sendMessage = (message) => {
    sent.push(message);
  };
  const ctx = createExtensionCtx(liveSessionManager);

  const submitterSent: SentMessageLike[] = [];
  const submitterPi = createPiHarness();
  submitterPi.sendMessage = (message) => {
    submitterSent.push(message);
  };
  const submitterCtx = createExtensionCtx(submitterSessionManager);

  const holder = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000);"], {
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
    await scanOracleJobsOnce(pi as unknown as ExtensionAPI, ctx, "/tmp/fake-oracle-worker.mjs", {
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

    await scanOracleJobsOnce(submitterPi as unknown as ExtensionAPI, submitterCtx, "/tmp/fake-oracle-worker.mjs");
    assert(submitterSent.length >= 1, `expected the original session to receive at least one best-effort wake-up after becoming live, saw ${submitterSent.length}`);
    assert((submitterSent[0]?.details as { jobId?: string } | undefined)?.jobId === jobId, "original session should receive the expected job wake-up after reclaiming liveness");
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
  await resetOracleStateDir();
  const submitterSessionManager = createPersistedSessionManager("poller-transition-late-submit");
  const liveSessionManager = createPersistedSessionManager("poller-transition-late-live");
  const submitterSessionFile = submitterSessionManager.getSessionFile();
  const liveSessionFile = liveSessionManager.getSessionFile();
  assert(submitterSessionFile && liveSessionFile, "late transition poller test should persist both session files");
  appendAssistantMessage(submitterSessionManager, "prime late-transition target history", { provider: "anthropic", model: "claude-sonnet-4" });
  const jobId = await createTerminalJob(config, process.cwd(), submitterSessionFile);
  const job = readJob(jobId);
  assert(job, "late transition notification job should exist");

  const sent: SentMessageLike[] = [];
  const pi = createPiHarness();
  pi.sendMessage = (message) => {
    sent.push(message);
  };
  const ctx = createExtensionCtx(liveSessionManager);

  const submitterSent: SentMessageLike[] = [];
  const submitterPi = createPiHarness();
  submitterPi.sendMessage = (message) => {
    submitterSent.push(message);
  };
  const submitterCtx = createExtensionCtx(submitterSessionManager);

  const holder = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000);"], {
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
    await scanOracleJobsOnce(pi as unknown as ExtensionAPI, ctx, "/tmp/fake-oracle-worker.mjs", {
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

    await scanOracleJobsOnce(submitterPi as unknown as ExtensionAPI, submitterCtx, "/tmp/fake-oracle-worker.mjs");
    assert(submitterSent.length >= 1, `expected the original session to receive at least one best-effort wake-up after reclaiming liveness before append, saw ${submitterSent.length}`);
    assert((submitterSent[0]?.details as { jobId?: string } | undefined)?.jobId === jobId, "original session should receive the expected job wake-up after reclaiming liveness before append");
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
  await resetOracleStateDir();
  const targetSessionManager = createPersistedSessionManager("poller-target-lock-target");
  const adopterSessionManager = createPersistedSessionManager("poller-target-lock-adopter");
  const targetSessionFile = targetSessionManager.getSessionFile();
  assert(targetSessionFile, "off-session wake-up test should persist a target session file");
  const headEntryId = appendAssistantMessage(targetSessionManager, "prime target history for off-session wake-up", { provider: "anthropic", model: "claude-sonnet-4" });
  const jobId = await createTerminalJob(config, process.cwd(), targetSessionFile);

  const sent: SentMessageLike[] = [];
  const pi = createPiHarness();
  pi.sendMessage = (message) => {
    sent.push(message);
  };
  const peerSessionManager = SessionManager.open(targetSessionFile, undefined, process.cwd());

  let peerEntryId: string | undefined;
  await scanOracleJobsOnce(pi as unknown as ExtensionAPI, createPollerCtx(adopterSessionManager), "/tmp/fake-oracle-worker.mjs", {
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
  await resetOracleStateDir();
  const submitterSessionManager = createPersistedSessionManager("poller-recovery-submit");
  const adopterSessionManager = createPersistedSessionManager("poller-recovery-adopter");
  const targetSessionFile = submitterSessionManager.getSessionFile();
  const adopterSessionFile = adopterSessionManager.getSessionFile();
  assert(targetSessionFile && adopterSessionFile, "notification recovery test should persist both the submitter and adopter session files");
  appendAssistantMessage(submitterSessionManager, "prime recovery target history", { provider: "anthropic", model: "claude-sonnet-4" });
  const jobId = await createTerminalJob(config, process.cwd(), targetSessionFile);

  const sent: SentMessageLike[] = [];
  const pi = createPiHarness();
  pi.sendMessage = (message) => {
    sent.push(message);
  };
  const staleRecoveryCtx = createPollerCtx(SessionManager.open(adopterSessionFile, undefined, process.cwd()));

  await scanOracleJobsOnce(pi as unknown as ExtensionAPI, createPollerCtx(adopterSessionManager), "/tmp/fake-oracle-worker.mjs");
  assert(sent.length === 1, `first wake-up-only recovery attempt should emit one best-effort wake-up, saw ${sent.length}`);
  assert(!readJob(jobId)?.notifiedAt, "wake-up-only recovery should leave the job unnotified after the first wake-up attempt");
  assert(!findNotificationEntry(SessionManager.open(targetSessionFile, undefined, process.cwd()), jobId), "wake-up-only recovery should not create a durable completion message in the target session");

  await updateJob(jobId, (job) => ({
    ...job,
    notifyClaimedBy: "other-claimant",
    notifyClaimedAt: new Date(Date.now() - 2 * 60 * 1000).toISOString(),
    wakeupLastRequestedAt: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
  }));
  await scanOracleJobsOnce(pi as unknown as ExtensionAPI, staleRecoveryCtx, "/tmp/fake-oracle-worker.mjs");
  assert(sent.length >= 2, `recovered wake-up-only delivery should emit an additional best-effort wake-up after claim handoff, saw ${sent.length}`);
  assert(!readJob(jobId)?.notifiedAt, "wake-up-only recovery should still leave the job unnotified after subsequent best-effort wake-up attempts");
  await cleanupJob(jobId);
}

async function testStaleWakeupClaimsDoNotDuplicateReminders(config: OracleConfig): Promise<void> {
  await resetOracleStateDir();
  const submitterSessionManager = createPersistedSessionManager("poller-stale-wakeup-submit");
  const firstAdopterSessionManager = createPersistedSessionManager("poller-stale-wakeup-first-adopter");
  const secondAdopterSessionManager = createPersistedSessionManager("poller-stale-wakeup-second-adopter");
  const targetSessionFile = submitterSessionManager.getSessionFile();
  assert(targetSessionFile, "stale wake-up claim test should persist a target session file");
  appendAssistantMessage(submitterSessionManager, "prime stale wake-up target history", { provider: "anthropic", model: "claude-sonnet-4" });
  const jobId = await createTerminalJob(config, process.cwd(), targetSessionFile);

  const firstSent: SentMessageLike[] = [];
  const firstPi = createPiHarness();
  firstPi.sendMessage = (message) => {
    firstSent.push(message);
  };
  const secondSent: SentMessageLike[] = [];
  const secondPi = createPiHarness();
  secondPi.sendMessage = (message) => {
    secondSent.push(message);
  };

  let allowSecondClaim: (() => void) | undefined;
  const secondClaimBlocked = new Promise<void>((resolve) => {
    allowSecondClaim = resolve;
  });
  let signalSecondClaimReady: (() => void) | undefined;
  const secondClaimReady = new Promise<void>((resolve) => {
    signalSecondClaimReady = resolve;
  });

  const secondScan = scanOracleJobsOnce(secondPi as unknown as ExtensionAPI, createPollerCtx(secondAdopterSessionManager), "/tmp/fake-oracle-worker.mjs", {
    hooks: {
      beforeNotificationClaim: async (candidateJobId) => {
        if (candidateJobId !== jobId) return;
        signalSecondClaimReady?.();
        await secondClaimBlocked;
      },
    },
  });

  await secondClaimReady;
  await scanOracleJobsOnce(firstPi as unknown as ExtensionAPI, createPollerCtx(firstAdopterSessionManager), "/tmp/fake-oracle-worker.mjs");
  allowSecondClaim?.();
  await secondScan;

  assert(firstSent.length === 1, `first claimant should emit exactly one best-effort wake-up, saw ${firstSent.length}`);
  assert(secondSent.length === 0, `stale second claimants must not emit an extra wake-up inside the same retry window, saw ${secondSent.length}`);
  assert(readJob(jobId)?.wakeupAttemptCount === 1, "stale second claimants must not increment the bounded wake-up retry counter");
  await cleanupJob(jobId);
}

async function testStalePruneCandidatesDoNotSendWakeups(config: OracleConfig): Promise<void> {
  await resetOracleStateDir();
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

  const sent: SentMessageLike[] = [];
  const pi = createPiHarness();
  pi.sendMessage = (message) => {
    sent.push(message);
  };

  let prunedJobIds: string[] = [];
  const pruneTimestamp = new Date(Date.now() - 2 * 60 * 1000).toISOString();
  await scanOracleJobsOnce(pi as unknown as ExtensionAPI, createPollerCtx(sessionManager), "/tmp/fake-oracle-worker.mjs", {
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
  await resetOracleStateDir();
  const sessionManager = createPersistedSessionManager("poller-claimed-removal-target");
  const sessionFile = sessionManager.getSessionFile();
  assert(sessionFile, "claimed-removal wake-up test should persist a target session file");
  appendAssistantMessage(sessionManager, "prime claimed-removal wake-up target history", { provider: "anthropic", model: "claude-sonnet-4" });
  const jobId = await createTerminalJob(config, process.cwd(), sessionFile);

  const sent: SentMessageLike[] = [];
  const pi = createPiHarness();
  pi.sendMessage = (message) => {
    sent.push(message);
  };

  let removalResult: Awaited<ReturnType<typeof removeTerminalOracleJob>> | undefined;
  await scanOracleJobsOnce(pi as unknown as ExtensionAPI, createPollerCtx(sessionManager), "/tmp/fake-oracle-worker.mjs", {
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
  await resetOracleStateDir();
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

  const sent: SentMessageLike[] = [];
  const pi = createPiHarness();
  pi.sendMessage = (message) => {
    sent.push(message);
  };

  await scanOracleJobsOnce(pi as unknown as ExtensionAPI, createPollerCtx(sessionManager), "/tmp/fake-oracle-worker.mjs");
  assert(sent.length === 1, `post-send prune-grace test should emit exactly one wake-up before pruning is attempted, saw ${sent.length}`);
  const pruned = await pruneTerminalOracleJobs(Date.now() + 10_000);
  assert(!pruned.includes(jobId), "recently sent wake-ups should keep their job files retained during the post-send grace window");
  assert(Boolean(readJob(jobId)), "post-send prune-grace test should keep the job directory on disk during the grace window");
  assert(await pathExists(job.responsePath), "post-send prune-grace test should keep the referenced response file on disk during the grace window");
  assert(await pathExists(artifactsDir), "post-send prune-grace test should keep the referenced artifacts directory on disk during the grace window");
  const wakeupContent = String(sent[0]?.content ?? "");
  assert(wakeupContent.includes(job.responsePath), "post-send prune-grace wake-up should reference the persisted response path");
  assert(wakeupContent.includes(artifactsDir), "post-send prune-grace wake-up should reference the persisted artifacts directory");
  await cleanupJob(jobId);
}

async function testOracleCleanHonorsPostSendWakeupGrace(config: OracleConfig): Promise<void> {
  await resetOracleStateDir();
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

  const sent: SentMessageLike[] = [];
  const pi = createPiHarness();
  pi.sendMessage = (message) => {
    sent.push(message);
  };
  registerOracleCommands(pi as unknown as ExtensionAPI, fakeWorkerPath, fakeWorkerPath);
  const cleanCommand = pi.commands.get("oracle-clean");
  assert(cleanCommand, "oracle clean command should register for post-send clean-grace test");

  await scanOracleJobsOnce(pi as unknown as ExtensionAPI, createPollerCtx(sessionManager), "/tmp/fake-oracle-worker.mjs");
  assert(sent.length === 1, `post-send clean-grace test should emit exactly one wake-up before clean is attempted, saw ${sent.length}`);

  const ui = createUiStub();
  const ctx = createCommandCtx({ getSessionFile: () => sessionFile } as ExtensionCommandContext["sessionManager"], ui);

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
  await resetOracleStateDir();
  const sessionManager = createPersistedSessionManager("poller-wakeup-retry-target");
  const sessionFile = sessionManager.getSessionFile();
  assert(sessionFile, "wakeup retry poller test should persist a target session file");
  appendAssistantMessage(sessionManager, "prime wake-up retry target history", { provider: "anthropic", model: "claude-sonnet-4" });
  const jobId = await createTerminalJob(config, process.cwd(), sessionFile);

  const sent: SentMessageLike[] = [];
  const pi = createPiHarness();
  pi.sendMessage = (message) => {
    sent.push(message);
  };

  await scanOracleJobsOnce(pi as unknown as ExtensionAPI, createPollerCtx(sessionManager), "/tmp/fake-oracle-worker.mjs");
  assert(sent.length >= 1, `expected at least one best-effort wake-up request after the first scan, saw ${sent.length}`);
  assert(!findNotificationEntry(SessionManager.open(sessionFile, undefined, process.cwd()), jobId), "wake-up retries should not create durable completion messages under the best-effort-only model");
  assert(readJob(jobId)?.wakeupAttemptCount === 1, "first wake-up attempt should record a single best-effort reminder request");

  await updateJob(jobId, (job) => ({
    ...job,
    wakeupLastRequestedAt: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
  }));
  await scanOracleJobsOnce(pi as unknown as ExtensionAPI, createPollerCtx(sessionManager), "/tmp/fake-oracle-worker.mjs");
  assert(sent.length >= 2, `expected a second best-effort wake-up retry after backoff, saw ${sent.length}`);
  assert(readJob(jobId)?.wakeupAttemptCount === 2, "wake-up retries should increment the best-effort reminder counter without durable completion messages");

  await updateJob(jobId, (job) => ({
    ...job,
    wakeupLastRequestedAt: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
  }));
  await scanOracleJobsOnce(pi as unknown as ExtensionAPI, createPollerCtx(sessionManager), "/tmp/fake-oracle-worker.mjs");
  assert(sent.length >= 3, `expected a third bounded best-effort wake-up retry after backoff, saw ${sent.length}`);
  assert(readJob(jobId)?.wakeupAttemptCount === 3, "bounded wake-up retries should stop after the configured maximum attempts");

  await updateJob(jobId, (job) => ({
    ...job,
    wakeupLastRequestedAt: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
  }));
  await scanOracleJobsOnce(pi as unknown as ExtensionAPI, createPollerCtx(sessionManager), "/tmp/fake-oracle-worker.mjs");
  const wakeupAttemptsAtLimit = sent.length;
  assert(wakeupAttemptsAtLimit >= 3, `wake-up retries should reach the configured maximum attempts before stopping, saw ${wakeupAttemptsAtLimit}`);
  assert(sent.length === wakeupAttemptsAtLimit, `wake-up retries should stop once the configured maximum attempts is reached, saw ${sent.length}`);
  assert(!readJob(jobId)?.notifiedAt, "bounded wake-up retries should leave the job unnotified while no durable completion message exists");

  await cleanupJob(jobId);
}

export async function runPollerSanitySuite(config: OracleConfig): Promise<void> {
  await testNotificationClaims(config);
  await testMarkJobNotifiedRejectsStaleClaimant(config);
  await testOracleSubmitRejectsMissingSessionIdentity();
  await testOracleReadUsesConfiguredJobsDir(config);
  await testManualReadsSettleWakeupRetries(config);
  await testPreSendStatusObservationDoesNotSuppressFirstWakeup(config);
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
}
