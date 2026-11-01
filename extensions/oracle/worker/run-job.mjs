// Purpose: Execute a single oracle worker job from browser launch through response/artifact extraction and cleanup.
// Responsibilities: Drive the isolated browser session, update durable job state, coordinate cleanup, and autonomously promote queued work after successful teardown.
// Scope: Worker runtime behavior only; shared concurrency/process helpers live in extensions/oracle/shared and extension-side policy remains in lib modules.
// Usage: Spawned as a detached Node process with a job id argument by the oracle extension queue/submission flows.
// Invariants/Assumptions: Job state is persisted under worker-held locks, browser/session artifacts live under the configured oracle directories, and cleanup preserves durable recovery semantics.
import { createHash, randomUUID } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { appendFile, chmod, cp as copyDirectory, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import {
  buildConversationLeaseMetadata,
  buildRuntimeLeaseMetadata,
  compareQueuedOracleJobs,
  hasDurableWorkerHandoff,
  jobBlocksAdmission,
  runQueuedJobPromotionPass,
} from "../shared/job-coordination-helpers.mjs";
import { appendOracleJobLifecycleEvent, applyOracleJobCleanupWarnings, clearOracleJobCleanupState, transitionOracleJobPhase } from "../shared/job-lifecycle-helpers.mjs";
import { closeAgentBrowserSession, disableAgentBrowserWebMcp, killProcess, killProcessTree, readProcessStartedAt, resolveAgentBrowserBinary, runCommand as spawnCommand, spawnDetachedNodeProcess, terminateTrackedProcess } from "../shared/process-helpers.mjs";
import { getOracleJobsDir, getOracleStateDir } from "../shared/state-path-helpers.mjs";
import { sleep } from "../shared/time-helpers.mjs";
import { closeRelayTab } from "../shared/relay-browser-helpers.mjs";
import { acquireManagedBrowser, managedBrowserReplaced, releaseManagedBrowser, sharedBrowserEndpoint, usesSharedBrowser } from "../shared/managed-browser-helpers.mjs";
import { RelayCdpClient } from "../shared/relay-cdp-client.mjs";
import { parseSnapshotEntries } from "./artifact-heuristics.mjs";
import {
  activateDownloadControl,
  captureExpression,
  captureDownload,
  collectNativeDownload,
  collectionOutcome,
  composeResearchResponse,
  durationLabelSeconds,
  observeConversationExpression,
  readResearchReportState,
  redactTransportSecrets,
  turnContentSha256,
  validateArtifactBytes,
} from "./response-capture.mjs";
import {
  buildAllowedChatGptOrigins,
  CHATGPT_ADD_FILES_LABEL,
  CHATGPT_ATTACH_FILES_INPUT_SELECTOR,
  CHATGPT_COMPOSER_EDITOR_SELECTOR,
  CHATGPT_DEEP_RESEARCH_MENTION_SELECTOR,
  CHATGPT_SEND_LABELS,
  CHATGPT_STOP_CONTROL_SELECTOR,
  CHATGPT_MODEL_PICKER_SELECTOR,
  deriveAssistantCompletionSignature,
  findDialogCloseEntry,
  isChatGptComposerEntry,
  matchesCompactIntelligenceControlLabel,
  matchesModelConfigurationOpener,
  matchesModelFamilyLabel,
  matchesRequestedModelControlLabel,
  mergeObservedSelection,
  requestedEffortLabel,
  effortSelectionVisible,
  classifyDeepResearchTurn,
  isDeepResearchMenuEntry,
  parseDeepResearchWidgetText,
  parsePowerSliderDescription,
  powerSliderClosedIntoSelection,
  powerSliderStepKey,
  powerSliderTargetLabel,
  snapshotHasDeepResearchPill,
  snapshotHasPowerSliderMenu,
  snapshotCanSafelySkipModelConfiguration,
  snapshotHasClosedCompactSelection,
  snapshotHasModelConfigurationUi,
  snapshotHasModelOpener,
  snapshotHasSelectedLatestModel,
  snapshotHasUsableComposerControls,
  snapshotStronglyMatchesRequestedModel,
  snapshotWeaklyMatchesRequestedModel,
  autoSwitchToThinkingSelectionVisible,
  stripChatGptResponseChrome,
  waitForStationaryControl,
} from "./chatgpt-ui-helpers.mjs";
import { chatGptGenerationActive, chatGptStreamingVisible, composerFileEntryCount, conversationIdFromUrl, isConversationPathUrl, nextMissingTurnReloadState, nextMissingTurnState, nextStableValueState, nextStaleStopState, providerSendAccepted, resolveStableConversationUrlCandidate, stripUrlQueryAndHash, timedOutRecollectionBinding } from "./chatgpt-flow-helpers.mjs";
import { normalizeLoginProbeResult } from "./auth-flow-helpers.mjs";
import { assertNotKnownBrowserUserDataPath, assertSafeBrowserLaunchArg, scrubSweetCookieSafeStoragePasswordEnv, sweetCookieSafeStoragePasswordScrubbedEnv } from "../shared/browser-profile-helpers.mjs";
import { createLease, listLeaseMetadata, readLeaseMetadata, releaseLease, withLock } from "./state-locks.mjs";

const jobId = process.argv[2];
if (!jobId) {
  console.error("Usage: run-job.mjs <job-id>");
  process.exit(1);
}

const ORACLE_JOBS_DIR = getOracleJobsDir();
const jobDir = join(ORACLE_JOBS_DIR, `oracle-${jobId}`);
const jobPath = `${jobDir}/job.json`;
const CHATGPT_LABELS = {
  addFiles: CHATGPT_ADD_FILES_LABEL,
  close: "Close",
  autoSwitchToThinking: "Auto-switch to Thinking",
  configure: "Configure...",
};
const GROK_LABELS = {
  composer: "Ask Grok anything",
  addFiles: "Attach",
  send: "Submit",
  modelSelect: "Model select",
  stop: "Stop model response",
};
const WORKER_SCRIPT_PATH = fileURLToPath(import.meta.url);
const ORACLE_STATE_DIR = getOracleStateDir();
const SEED_GENERATION_FILE = ".oracle-seed-generation";
const ARTIFACT_DOWNLOAD_HEARTBEAT_MS = 10_000;
const ARTIFACT_DOWNLOAD_TIMEOUT_MS = 90_000;
const AGENT_BROWSER_CLOSE_TIMEOUT_MS = 10_000;
const PROFILE_CLONE_TIMEOUT_MS = 120_000;
const MODEL_CONFIGURATION_OPEN_TIMEOUT_MS = 45_000;
const MODEL_CONFIGURATION_SETTLE_TIMEOUT_MS = 20_000;
const MODEL_CONFIGURATION_SETTLE_POLL_MS = 250;
const MODEL_CONFIGURATION_CLOSE_RETRY_MS = 1_000;
const POST_SEND_SETTLE_MS = 15_000;
const AGENT_BROWSER_BIN = resolveAgentBrowserBinary();
const CHROME_DEVTOOLS_READY_TIMEOUT_MS = 15_000;
const CP_BIN = process.env.PI_ORACLE_CP_PATH?.trim() || "cp";
scrubSweetCookieSafeStoragePasswordEnv();
disableAgentBrowserWebMcp();

// Failures callers must tell apart carry a stable code into job.json (errorCode) and tool results.
class OracleWorkerError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   */
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

let cpSupportsApfsCloneFlag;
let currentJob;
let browserStarted = false;
let browserProcess;
let browserProcessError;
let cleaningUpBrowser = false;
let cleaningUpRuntime = false;
let shuttingDown = false;
let lastHeartbeatMs = 0;
/** Lease that keeps the managed browser open while this worker's job uses it. */
let managedBrowserLeaseKey;

function providerForJob(job) {
  return job?.selection?.provider === "grok" ? "grok" : "chatgpt";
}

function isGrokJob(job) {
  return providerForJob(job) === "grok";
}

function labelsForJob(job) {
  return isGrokJob(job) ? GROK_LABELS : CHATGPT_LABELS;
}

// ChatGPT's send control has carried more than one accessible name; Grok's has one.
function sendLabelsForJob(job) {
  return isGrokJob(job) ? [GROK_LABELS.send] : CHATGPT_SEND_LABELS;
}

function findSendEntry(job, snapshot) {
  const labels = sendLabelsForJob(job);
  return findEntry(snapshot, (candidate) => candidate.kind === "button" && !candidate.disabled && labels.includes(candidate.label));
}

async function ensurePrivateDir(path) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  await chmod(path, 0o700).catch(() => undefined);
}

async function terminateWorkerPid(pid, startedAt, options = {}) {
  return terminateTrackedProcess(pid, startedAt, options);
}

async function secureWriteText(path, content) {
  const tmpPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmpPath, content, { encoding: "utf8", mode: 0o600 });
  await chmod(tmpPath, 0o600).catch(() => undefined);
  await rename(tmpPath, path);
  await chmod(path, 0o600).catch(() => undefined);
}

async function secureAppendText(path, content) {
  await appendFile(path, content, { encoding: "utf8", mode: 0o600 });
  await chmod(path, 0o600).catch(() => undefined);
}

async function readJobUnlocked() {
  return JSON.parse(await readFile(jobPath, "utf8"));
}

async function readJob() {
  return readJobUnlocked();
}

function getAnyJobDir(targetJobId) {
  return join(ORACLE_JOBS_DIR, `oracle-${targetJobId}`);
}

function getAnyJobPath(targetJobId) {
  return join(getAnyJobDir(targetJobId), "job.json");
}

function readAnyJob(targetJobId) {
  const path = getAnyJobPath(targetJobId);
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

function listQueuedJobs() {
  if (!existsSync(ORACLE_JOBS_DIR)) return [];
  return readdirSync(ORACLE_JOBS_DIR)
    .filter((name) => name.startsWith("oracle-"))
    .map((name) => readAnyJob(name.slice("oracle-".length)))
    .filter((job) => job?.status === "queued")
    .sort(compareQueuedOracleJobs);
}

async function mutateAnyJob(targetJobId, mutator) {
  return withLock(ORACLE_STATE_DIR, "job", targetJobId, { processPid: process.pid, action: "mutateJob", targetJobId }, async () => {
    const path = getAnyJobPath(targetJobId);
    const current = JSON.parse(await readFile(path, "utf8"));
    const next = mutator(current);
    await secureWriteText(path, `${JSON.stringify(next, null, 2)}\n`);
    return next;
  });
}

async function writeJobUnlocked(job) {
  await secureWriteText(jobPath, `${JSON.stringify(job, null, 2)}\n`);
}

async function writeJob(job) {
  await withLock(ORACLE_STATE_DIR, "job", jobId, { processPid: process.pid, action: "writeJob" }, async () => {
    await writeJobUnlocked(job);
  });
}

async function mutateJob(mutator) {
  return withLock(ORACLE_STATE_DIR, "job", jobId, { processPid: process.pid, action: "mutateJob" }, async () => {
    const job = await readJobUnlocked();
    const next = mutator(job);
    await writeJobUnlocked(next);
    currentJob = next;
    return next;
  });
}

/** @param {Partial<Omit<import("../shared/job-observability-helpers.mjs").OracleObservedSelection, "product">>} observation */
async function recordObservedSelection(observation) {
  return mutateJob((job) => ({ ...job, observedSelection: mergeObservedSelection(job.observedSelection, observation) }));
}

async function heartbeat(patch = undefined, options = {}) {
  const now = Date.now();
  const force = options.force === true;
  if (!force && !patch && now - lastHeartbeatMs < 10_000) return;
  lastHeartbeatMs = now;
  const heartbeatAt = new Date(now).toISOString();
  await mutateJob((job) => ({
    ...job,
    ...(patch || {}),
    heartbeatAt,
  }));
}

async function log(message) {
  const line = `[${new Date().toISOString()}] ${message}\n`;
  await secureAppendText(`${jobDir}/logs/worker.log`, line);
}

async function cpSupportsApfsClone() {
  if (process.platform !== "darwin") return false;
  if (cpSupportsApfsCloneFlag !== undefined) return cpSupportsApfsCloneFlag;
  const probe = await spawnCommand(CP_BIN, ["-c"], { allowFailure: true, timeoutMs: 5_000 });
  cpSupportsApfsCloneFlag = !/invalid option\s+--\s+['"]?c/i.test(`${probe.stderr}\n${probe.stdout}`);
  return cpSupportsApfsCloneFlag;
}

async function removeChromiumProcessSingletonArtifacts(profileDir) {
  await Promise.all([
    rm(join(profileDir, "SingletonLock"), { force: true }),
    rm(join(profileDir, "SingletonSocket"), { force: true }),
    rm(join(profileDir, "SingletonCookie"), { force: true }),
    rm(join(profileDir, "DevToolsActivePort"), { force: true }),
  ]);
}

function assertSafeRuntimeProfilePath(path, label, config = undefined) {
  try {
    assertNotKnownBrowserUserDataPath(path, label, {
      cookieSources: config ? { chromeProfile: config.auth.chromeProfile, chromeCookiePath: config.auth.chromeCookiePath } : undefined,
    });
  } catch (error) {
    throw new Error(`Oracle ${label} path is unsafe: ${path}. ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function cloneSeedProfileToRuntime(job) {
  const seedDir = job.config.browser.authSeedProfileDir;
  assertSafeRuntimeProfilePath(seedDir, "auth seed profile", job.config);
  assertSafeRuntimeProfilePath(job.runtimeProfileDir, "runtime profile", job.config);
  if (!existsSync(seedDir)) {
    throw new Error(`Oracle auth seed profile not found: ${seedDir}. Run /oracle-auth first.`);
  }

  const seedGenerationPath = join(seedDir, SEED_GENERATION_FILE);
  const seedGeneration = existsSync(seedGenerationPath) ? (await readFile(seedGenerationPath, "utf8")).trim() || undefined : undefined;

  await withLock(ORACLE_STATE_DIR, "auth", "global", { jobId: job.id, processPid: process.pid, action: "cloneSeedProfile" }, async () => {
    await rm(job.runtimeProfileDir, { recursive: true, force: true }).catch(() => undefined);
    await ensurePrivateDir(dirname(job.runtimeProfileDir));
    if (job.config.browser.cloneStrategy === "apfs-clone" && await cpSupportsApfsClone()) {
      try {
        await spawnCommand(CP_BIN, ["-cR", seedDir, job.runtimeProfileDir], { timeoutMs: PROFILE_CLONE_TIMEOUT_MS });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await log(`APFS clone copy failed; falling back to recursive copy: ${message}`);
        await rm(job.runtimeProfileDir, { recursive: true, force: true }).catch(() => undefined);
        await spawnCommand(CP_BIN, ["-R", seedDir, job.runtimeProfileDir], { timeoutMs: PROFILE_CLONE_TIMEOUT_MS });
      }
    } else {
      await copyDirectory(seedDir, job.runtimeProfileDir, { recursive: true, force: true, verbatimSymlinks: true });
    }
    await removeChromiumProcessSingletonArtifacts(job.runtimeProfileDir);
  }, 10 * 60 * 1000);

  return seedGeneration;
}

async function cleanupRuntime(job) {
  if (!job || cleaningUpRuntime) return [];
  cleaningUpRuntime = true;
  const warnings = [];
  try {
    let browserClosed = true;
    await closeBrowser(job).catch(async (error) => {
      browserClosed = false;
      const message = `Browser close warning during cleanup: ${error instanceof Error ? error.message : String(error)}`;
      warnings.push(message);
      await log(message).catch(() => undefined);
    });
    // Once no lease and no page remain, the keeper quits a managed browser Oracle opened; a tab that failed to close keeps it open.
    await releaseManagedBrowser(ORACLE_STATE_DIR, managedBrowserLeaseKey);
    managedBrowserLeaseKey = undefined;
    if (browserClosed && !usesSharedBrowser(job.config)) {
      try {
        assertSafeRuntimeProfilePath(job.runtimeProfileDir, "runtime profile", job.config);
        await rm(job.runtimeProfileDir, { recursive: true, force: true });
      } catch (error) {
        const message = `Runtime profile cleanup warning: ${error instanceof Error ? error.message : String(error)}`;
        warnings.push(message);
        await log(message).catch(() => undefined);
      }
    } else if (!browserClosed && !usesSharedBrowser(job.config)) {
      const message = `Runtime profile cleanup skipped because isolated browser close did not complete: ${job.runtimeProfileDir}`;
      warnings.push(message);
      await log(message).catch(() => undefined);
    }
    await releaseLease(ORACLE_STATE_DIR, "conversation", job.conversationId).catch(async (error) => {
      const message = `Conversation lease cleanup warning: ${error instanceof Error ? error.message : String(error)}`;
      warnings.push(message);
      await log(message).catch(() => undefined);
    });
    await releaseLease(ORACLE_STATE_DIR, "runtime", job.runtimeId).catch(async (error) => {
      const message = `Runtime lease cleanup warning: ${error instanceof Error ? error.message : String(error)}`;
      warnings.push(message);
      await log(message).catch(() => undefined);
    });
    if (warnings.length === 0) {
      await log(`Cleanup summary: runtime ${job.runtimeId} released with no warnings`).catch(() => undefined);
    } else {
      await log(`Cleanup summary: runtime ${job.runtimeId} released after ${warnings.length} warning(s)`).catch(() => undefined);
    }
    return warnings;
  } finally {
    cleaningUpRuntime = false;
  }
}

async function tryAcquireRuntimeLeaseForJob(job, createdAt) {
  // Lease files are untrusted JSON written by other worker processes; every field may be absent.
  const existing = /** @type {Partial<import("../shared/job-coordination-helpers.d.mts").OracleRuntimeLeaseMetadataLike>[]} */ (listLeaseMetadata(ORACLE_STATE_DIR, "runtime"));
  const liveLeases = [];
  for (const lease of existing) {
    const owner = lease?.jobId ? readAnyJob(lease.jobId) : undefined;
    if (!jobBlocksAdmission(owner)) {
      await releaseLease(ORACLE_STATE_DIR, "runtime", lease?.runtimeId).catch(() => undefined);
      continue;
    }
    liveLeases.push(lease);
  }
  if (liveLeases.length >= job.config.browser.maxConcurrentJobs) {
    return false;
  }
  await createLease(ORACLE_STATE_DIR, "runtime", job.runtimeId, buildRuntimeLeaseMetadata(job, createdAt));
  return true;
}

async function tryAcquireConversationLeaseForJob(job, createdAt) {
  const metadata = buildConversationLeaseMetadata(job, createdAt);
  if (!metadata) return true;
  const existing = /** @type {Partial<import("../shared/job-coordination-helpers.d.mts").OracleConversationLeaseMetadataLike> | undefined} */ (await readLeaseMetadata(ORACLE_STATE_DIR, "conversation", metadata.conversationId));
  if (existing?.jobId === job.id) return true;
  if (existing && existing.jobId !== job.id) {
    if (!jobBlocksAdmission(readAnyJob(existing.jobId))) {
      await releaseLease(ORACLE_STATE_DIR, "conversation", metadata.conversationId).catch(() => undefined);
    } else {
      return false;
    }
  }
  await createLease(ORACLE_STATE_DIR, "conversation", metadata.conversationId, metadata);
  return true;
}

async function spawnDetachedWorker(targetJobId) {
  const child = await spawnDetachedNodeProcess(WORKER_SCRIPT_PATH, [targetJobId]);
  return {
    pid: child.pid,
    workerNonce: randomUUID(),
    workerStartedAt: child.startedAt,
  };
}

async function failQueuedPromotion(targetJobId, message, at = new Date().toISOString()) {
  await mutateAnyJob(targetJobId, (latest) => {
    if (["complete", "failed", "cancelled"].includes(String(latest.status || ""))) return latest;
    return transitionOracleJobPhase(latest, "failed", {
      at,
      source: "oracle:worker-cleanup-promotion",
      message: `Queued promotion failed: ${message}`,
      patch: {
        heartbeatAt: at,
        error: message,
      },
    });
  }).catch(() => undefined);
}

async function promoteQueuedJobsAfterCleanup() {
  await withLock(ORACLE_STATE_DIR, "admission", "global", { processPid: process.pid, source: "worker_cleanup_promoter", jobId }, async () => {
    await runQueuedJobPromotionPass({
      listQueuedJobs,
      refreshJob: (targetJobId) => readAnyJob(targetJobId),
      readLatestJob: (targetJobId) => readAnyJob(targetJobId),
      acquireRuntimeLease: async (job, at) => tryAcquireRuntimeLeaseForJob(job, at),
      acquireConversationLease: async (job, at) => tryAcquireConversationLeaseForJob(job, at),
      releaseRuntimeLease: async (job) => {
        await releaseLease(ORACLE_STATE_DIR, "runtime", job.runtimeId);
      },
      markSubmitted: async (job, at) => {
        await mutateAnyJob(job.id, (latest) => {
          if (latest.status !== "queued") throw new Error(`Queued job ${latest.id} changed state during cleanup promotion (${latest.status})`);
          return transitionOracleJobPhase(latest, "submitted", {
            at,
            source: "oracle:worker-cleanup-promotion",
            message: "Queued job admitted after runtime cleanup released capacity.",
            patch: {
              submittedAt: latest.submittedAt || at,
            },
          });
        });
      },
      spawnWorker: async (job) => spawnDetachedWorker(job.id),
      persistWorker: async (job, spawnedWorker) => {
        await mutateAnyJob(job.id, (latest) => {
          if (hasDurableWorkerHandoff(latest)) {
            return {
              ...latest,
              workerPid: latest.workerPid || spawnedWorker.pid,
              workerNonce: latest.workerNonce || spawnedWorker.workerNonce,
              workerStartedAt: latest.workerStartedAt || spawnedWorker.workerStartedAt,
            };
          }
          return {
            ...latest,
            workerPid: spawnedWorker.pid,
            workerNonce: spawnedWorker.workerNonce,
            workerStartedAt: spawnedWorker.workerStartedAt,
          };
        });
      },
      hasDurableWorkerHandoff,
      isTerminalJob: (job) => ["complete", "failed", "cancelled"].includes(String(job.status || "")),
      failQueuedPromotion: async (job, message, at) => failQueuedPromotion(job.id, message, at),
      terminateSpawnedWorker: async (spawnedWorker) => {
        await terminateWorkerPid(spawnedWorker.pid, spawnedWorker.workerStartedAt);
      },
      cleanupAfterFailure: async ({ job, at, spawnedWorker }) => {
        if (spawnedWorker) {
          let cleanupWarnings = [];
          try {
            cleanupWarnings = await cleanupRuntime(job);
          } catch (cleanupError) {
            const message = `Cleanup-driven promotion teardown warning for ${job.id}: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`;
            cleanupWarnings = [message];
            await log(message).catch(() => undefined);
          }
          if (cleanupWarnings.length > 0) {
            await mutateAnyJob(job.id, (current) => applyOracleJobCleanupWarnings(current, cleanupWarnings, {
              at,
              source: "oracle:worker-cleanup-promotion",
              message: `Cleanup-driven queued promotion teardown left ${cleanupWarnings.length} warning(s).`,
            })).catch(() => undefined);
            await log(`Stopping queued cleanup promotion after ${job.id} because teardown left ${cleanupWarnings.length} warning(s)`).catch(() => undefined);
            return "break";
          }
          return;
        }

        await releaseLease(ORACLE_STATE_DIR, "conversation", job.conversationId).catch(() => undefined);
        await releaseLease(ORACLE_STATE_DIR, "runtime", job.runtimeId).catch(() => undefined);
      },
      onDurableHandoff: async (job) => {
        await log(`Queued promotion handoff already durable for ${job.id}; leaving active job intact`).catch(() => undefined);
      },
    });
  }).catch(async (error) => {
    await log(`Queued cleanup promotion warning: ${error instanceof Error ? error.message : String(error)}`).catch(() => undefined);
  });
}

function browserBaseArgs(job, options = {}) {
  const args = ["--session", job.runtimeSessionName];
  const endpoint = sharedBrowserEndpoint(job);
  if (endpoint) args.push("--cdp", endpoint, "--pin-tab");
  if (options.withLaunchOptions) {
    args.push("--profile", job.runtimeProfileDir);
    if (job.config.browser.executablePath) args.push("--executable-path", job.config.browser.executablePath);
    if (job.config.browser.userAgent) args.push("--user-agent", job.config.browser.userAgent);
    if (Array.isArray(job.config.browser.args) && job.config.browser.args.length > 0) args.push("--args", job.config.browser.args.join(","));
    if (options.mode === "headed") args.push("--headed");
  }
  return args;
}

function waitForChildClose(child, timeoutMs) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve(false);
    }, timeoutMs);
    timer.unref?.();
    child.once("close", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(true);
    });
  });
}

async function terminateBrowserProcess() {
  if (!browserProcess) return;
  const child = browserProcess;
  browserProcess = undefined;
  browserProcessError = undefined;
  if (child.exitCode !== null || child.signalCode !== null) return;
  killProcessTree(child);
  if (await waitForChildClose(child, 2_000)) return;
  killProcess(child);
  if (!(await waitForChildClose(child, 2_000))) {
    throw new Error(`Timed out terminating isolated Chrome process ${child.pid ?? "(unknown pid)"}`);
  }
}

async function closeBrowser(job) {
  if (cleaningUpBrowser) return;
  deepResearchCdp?.close();
  deepResearchCdp = undefined;
  if (usesSharedBrowser(job.config) && !job.relayTargetId && !browserStarted) return;
  cleaningUpBrowser = true;
  let tabCleanupError;
  try {
    const endpoint = sharedBrowserEndpoint(job);
    if (endpoint && job.relayTargetId) {
      try {
        const outcome = await closeRelayTab({
          binary: AGENT_BROWSER_BIN, sessionName: job.runtimeSessionName,
          endpoint, targetId: job.relayTargetId, browserUrl: job.managedBrowser?.browserUrl,
        });
        if (outcome === "released") await log("The job tab was its window's last tab; released it to about:blank instead of closing it");
        currentJob = await mutateJob((latest) => ({ ...latest, relayTargetId: undefined }));
      } catch (error) {
        tabCleanupError = error;
      }
    }
    await closeAgentBrowserSession(AGENT_BROWSER_BIN, browserBaseArgs(job), job.runtimeSessionName, { timeoutMs: AGENT_BROWSER_CLOSE_TIMEOUT_MS });
    if (tabCleanupError) throw tabCleanupError;
  } finally {
    await terminateBrowserProcess();
    browserStarted = false;
    cleaningUpBrowser = false;
  }
}

function safeBrowserLaunchArgs(job) {
  if (!Array.isArray(job.config.browser.args)) return [];
  for (const arg of job.config.browser.args) assertSafeBrowserLaunchArg(arg);
  return job.config.browser.args;
}

function chromeLaunchArgs(job, url) {
  const args = [
    "--remote-debugging-port=0",
    "--remote-allow-origins=*",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-networking",
    "--disable-backgrounding-occluded-windows",
    "--disable-component-update",
    "--disable-default-apps",
    "--disable-hang-monitor",
    "--disable-popup-blocking",
    "--disable-prompt-on-repost",
    "--disable-sync",
    "--disable-features=Translate",
    "--enable-features=NetworkService,NetworkServiceInProcess",
    "--metrics-recording-only",
    "--password-store=basic",
    "--use-mock-keychain",
    "--enable-unsafe-swiftshader",
    "--window-size=1280,720",
    `--user-data-dir=${job.runtimeProfileDir}`,
  ];
  if (job.config.browser.runMode !== "headed") args.push("--headless=new", "--hide-scrollbars");
  if (job.config.browser.userAgent) args.push(`--user-agent=${job.config.browser.userAgent}`);
  args.push(...safeBrowserLaunchArgs(job));
  args.push(url);
  return args;
}

async function waitForDevToolsEndpoint(job) {
  const path = join(job.runtimeProfileDir, "DevToolsActivePort");
  const startedAt = Date.now();
  while (Date.now() - startedAt < CHROME_DEVTOOLS_READY_TIMEOUT_MS) {
    if (browserProcessError) {
      throw new Error(`Chrome failed before DevTools became available: ${browserProcessError instanceof Error ? browserProcessError.message : String(browserProcessError)}`);
    }
    if (browserProcess?.exitCode !== null && browserProcess?.exitCode !== undefined) {
      throw new Error(`Chrome exited before DevTools became available (exit code ${browserProcess.exitCode}).`);
    }
    if (existsSync(path)) {
      const lines = (await readFile(path, "utf8")).trim().split(/\r?\n/);
      const port = lines[0]?.trim();
      const browserPath = lines[1]?.trim();
      if (/^\d+$/.test(port)) {
        return browserPath ? `ws://127.0.0.1:${port}${browserPath}` : `http://127.0.0.1:${port}`;
      }
    }
    await sleep(100);
  }
  throw new Error(`Timed out waiting for Chrome DevTools endpoint at ${path}.`);
}

async function attachManagedBrowser(job) {
  const executablePath = job.config.browser.executablePath;
  if (!executablePath) throw new Error("The managed ChatGPT browser needs browser.executablePath, and no Chrome executable was detected.");
  const managed = await acquireManagedBrowser({
    stateDir: ORACLE_STATE_DIR,
    profileDir: job.config.browser.chatGptManagedProfileDir,
    executablePath,
    args: safeBrowserLaunchArgs(job),
    owner: `job:${job.id}`,
  });
  managedBrowserLeaseKey = managed.leaseKey;
  await log(`${managed.launched ? "Opened" : "Reusing"} the managed ChatGPT browser at ${managed.endpoint}`);
  currentJob = await mutateJob((latest) => ({ ...latest, managedBrowser: { endpoint: managed.endpoint, browserUrl: managed.browserUrl } }));
  return currentJob;
}

// A port freed by an exited browser can be taken by another one, and a pinned agent-browser session that
// lost its daemon opens a fresh tab in whatever answers there. So each step on a managed job's tab first
// proves no other browser answers at the endpoint the job attached to; a browser that simply exited is
// left to the disconnect check. The verdict is sticky because polling loops tolerate command errors: a
// swallowed throw still refuses every later command, and both entrypoints report it over whatever ended the run.
/** @type {OracleWorkerError | undefined} */
let managedBrowserChangedError;
async function assertManagedBrowserUnchanged(job) {
  if (managedBrowserChangedError) throw managedBrowserChangedError;
  if (job.managedBrowser && (await managedBrowserReplaced(job.managedBrowser))) {
    managedBrowserChangedError = new OracleWorkerError("managed_browser_changed", `Another browser now answers at the managed ChatGPT browser's endpoint (${job.managedBrowser.endpoint}); the job stopped before sending anything more through it.`);
    throw managedBrowserChangedError;
  }
}

async function launchBrowser(job, url) {
  await closeBrowser(job);
  if (job.config.browser.chatGptManagedProfileDir) job = await attachManagedBrowser(job);
  if (sharedBrowserEndpoint(job)) {
    browserStarted = true;
    await log("Connecting the shared Chrome and acquiring the job-owned pinned tab");
    // A fresh pinned CDP session creates its own tab before executing the command.
    // Navigate that tab instead of creating a second, untracked startup tab.
    await assertManagedBrowserUnchanged(job);
    const { stdout } = await spawnCommand(AGENT_BROWSER_BIN, [...browserBaseArgs(job), "--json", "open", "about:blank"]);
    const created = JSON.parse(stdout);
    if (!created.success || typeof created.data?.targetId !== "string") {
      throw new Error("The relay did not return an identity for the job-owned tab.");
    }
    currentJob = await mutateJob((latest) => ({ ...latest, relayTargetId: created.data.targetId }));
    if (shuttingDown) return;
    await assertManagedBrowserUnchanged(currentJob);
    await log(`Navigating job-owned relay tab ${currentJob.relayTargetId}`);
    await spawnCommand(AGENT_BROWSER_BIN, [...browserBaseArgs(currentJob), "open", url]);
    return;
  }
  const executablePath = job.config.browser.executablePath;
  if (!executablePath) throw new Error("Oracle requires browser.executablePath when launching isolated browser runtimes without owning the global agent-browser daemon.");
  const args = chromeLaunchArgs(job, url);
  await log(`Launching isolated Chrome directly for agent-browser attach: ${JSON.stringify([executablePath, ...args])}`);
  browserProcessError = undefined;
  browserProcess = spawn(executablePath, args, {
    env: sweetCookieSafeStoragePasswordScrubbedEnv(),
    stdio: "ignore",
    detached: false,
    shell: false,
  });
  browserProcess.on("error", (error) => {
    browserProcessError = error;
    log(`Chrome process error: ${error instanceof Error ? error.message : String(error)}`).catch(() => undefined);
  });
  const endpoint = await waitForDevToolsEndpoint(job);
  await log(`Connecting agent-browser session ${job.runtimeSessionName} to isolated Chrome DevTools endpoint`);
  await spawnCommand(AGENT_BROWSER_BIN, [...browserBaseArgs(job), "connect", endpoint]);
  await spawnCommand(AGENT_BROWSER_BIN, [...browserBaseArgs(job), "open", url]);
  browserStarted = true;
}

async function streamStatus(job) {
  const { stdout } = await spawnCommand(AGENT_BROWSER_BIN, [...browserBaseArgs(job), "--json", "stream", "status"], { allowFailure: true });
  try {
    const parsed = JSON.parse(stdout || "{}");
    return parsed?.data || {};
  } catch {
    return {};
  }
}

async function ensureBrowserConnected(job) {
  if (!browserStarted || cleaningUpBrowser) return;
  await assertManagedBrowserUnchanged(job);
  const status = await streamStatus(job);
  if (status.connected === false) {
    throw new Error("The isolated oracle browser disconnected during the job.");
  }
}

async function agentBrowser(job, ...args) {
  if (shuttingDown) throw new Error("Oracle worker is shutting down.");
  let options;
  const maybeOptions = args.at(-1);
  if (
    maybeOptions &&
    typeof maybeOptions === "object" &&
    !Array.isArray(maybeOptions) &&
    (Object.hasOwn(maybeOptions, "allowFailure") ||
      Object.hasOwn(maybeOptions, "input") ||
      Object.hasOwn(maybeOptions, "cwd") ||
      Object.hasOwn(maybeOptions, "timeoutMs"))
  ) {
    options = args.pop();
  }
  await ensureBrowserConnected(job);
  return spawnCommand(AGENT_BROWSER_BIN, [...browserBaseArgs(job), ...args], options);
}
function parseEvalResult(stdout) {
  if (!stdout) return undefined;
  let value = stdout.trim();
  try {
    let parsed = JSON.parse(value);
    while (typeof parsed === "string") parsed = JSON.parse(parsed);
    return parsed;
  } catch {
    return value;
  }
}

function toJsonScript(expression) {
  return `JSON.stringify((() => { ${expression} })(), null, 2)`;
}

async function evalPage(job, script) {
   const result = await agentBrowser(job, "eval", "--stdin", { input: script });
   return parseEvalResult(result.stdout);
}

async function loginProbe(job) {
  return normalizeLoginProbeResult(await evalPage(job, buildLoginProbeScript(5_000)));
}

async function currentUrl(job) {
  const { stdout } = await agentBrowser(job, "get", "url");
  return stdout;
}

// The page's conversation and its assistant turns, read in one evaluation. With `conversationId`,
// a page showing another conversation yields only its location (onConversation false), never turns.
/** @param {any} job @param {{ conversationId?: string; archiveFileName?: string }} [options] */
async function observeTurns(job, { conversationId, archiveFileName } = {}) {
  const observation = await evalPage(job, toJsonScript(`return ${observeConversationExpression({ conversationId, stopSelector: CHATGPT_STOP_CONTROL_SELECTOR, archiveFileName })};`));
  if (!observation || typeof observation !== "object" || typeof observation.onConversation !== "boolean") throw new Error("The conversation observation returned no result.");
  return { ...observation, messages: Array.isArray(observation.messages) ? observation.messages.map((message) => ({ text: typeof message?.text === "string" ? message.text : "" })) : [] };
}

function observedPagePath(href) {
  try { return new URL(href).pathname; } catch { return "an unreadable page"; }
}

// Another client can navigate the job's shared tab (an agent's own CDP connection adopting the
// visible tab), or a person can click another chat in the window. One lifecycle breadcrumb per such
// episode; every recovery reopens only the job's own conversation, within the caller's deadline.
let conversationLeftEpisode = false;
async function returnToOwnConversation(job, observed) {
  if (!conversationLeftEpisode) {
    conversationLeftEpisode = true;
    const at = new Date().toISOString();
    await mutateJob((latest) => appendOracleJobLifecycleEvent(latest, { at, source: "oracle:worker", kind: "navigation",
      message: `The job's tab left its conversation ${job.conversationId} for ${observed}; reopening the job's conversation.` })).catch(() => undefined);
  }
  await log(`The job's tab shows ${observed} instead of conversation ${job.conversationId}; reopening ${job.chatUrl}`);
  await agentBrowser(job, "open", job.chatUrl).catch(async (error) => {
    await log(`Reopening the job's conversation failed; retrying on the next poll: ${error instanceof Error ? error.message : String(error)}`);
  });
}

async function noteOwnConversation() {
  if (!conversationLeftEpisode) return;
  conversationLeftEpisode = false;
  await log("The job's tab is back on its own conversation");
}

async function snapshotText(job) {
  const { stdout } = await agentBrowser(job, "snapshot", "-i");
  return stdout;
}

async function pageText(job) {
  const { stdout } = await agentBrowser(job, "get", "text", "body", { allowFailure: true });
  return stdout || "";
}

function toAsyncJsonScript(expression) {
  return `(async () => JSON.stringify(await (async () => { ${expression} })(), null, 2))()`;
}

function buildLoginProbeScript(timeoutMs) {
  return toAsyncJsonScript(`
    const pageUrl = typeof location === 'object' && location?.href ? location.href : null;
    const onAuthPage =
      typeof location === 'object' &&
      ((typeof location.hostname === 'string' && /^auth\.openai\.com$/i.test(location.hostname)) ||
        (typeof location.pathname === 'string' && /^\\/(auth|login|signin|log-in)/i.test(location.pathname)));

    const hasLoginCta = () => {
      const candidates = Array.from(
        document.querySelectorAll(
          [
            'a[href*="/auth/login"]',
            'a[href*="/auth/signin"]',
            'button[type="submit"]',
            'button[data-testid*="login"]',
            'button[data-testid*="log-in"]',
            'button[data-testid*="sign-in"]',
            'button[data-testid*="signin"]',
            'button',
            'a',
          ].join(','),
        ),
      );
      const textMatches = (text) => {
        if (!text) return false;
        const normalized = text.toLowerCase().trim();
        return ['log in', 'login', 'sign in', 'signin', 'continue with'].some((needle) => normalized.startsWith(needle));
      };
      for (const node of candidates) {
        if (!(node instanceof HTMLElement)) continue;
        const label =
          node.textContent?.trim() ||
          node.getAttribute('aria-label') ||
          node.getAttribute('title') ||
          '';
        if (textMatches(label)) return true;
      }
      return false;
    };

    let status = 0;
    let error = null;
    let bodyKeys = [];
    let bodyHasId = false;
    let bodyHasEmail = false;
    let bodyIsAnonymous = false;
    try {
      if (typeof fetch === 'function') {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), ${timeoutMs});
        try {
          const response = await fetch('/backend-api/me', {
            cache: 'no-store',
            credentials: 'include',
            signal: controller.signal,
          });
          status = response.status || 0;
          const contentType = response.headers.get('content-type') || '';
          if (contentType.includes('application/json')) {
            const data = await response.clone().json().catch(() => null);
            if (data && typeof data === 'object' && !Array.isArray(data)) {
              bodyKeys = Object.keys(data).slice(0, 12);
              bodyHasId = typeof data.id === 'string' && data.id.length > 0;
              bodyIsAnonymous = typeof data.id === 'string' && data.id.startsWith('ua-');
              bodyHasEmail = typeof data.email === 'string' && data.email.includes('@');
            }
          }
        } finally {
          clearTimeout(timeout);
        }
      }
    } catch (err) {
      error = err ? String(err) : 'unknown';
    }

    const domLoginCta = hasLoginCta();
    const loginSignals = domLoginCta || onAuthPage;
    return {
      ok: !loginSignals && (status === 0 || status === 200),
      status,
      pageUrl,
      domLoginCta,
      onAuthPage,
      error,
      bodyKeys,
      bodyHasId,
      bodyHasEmail,
      bodyIsAnonymous,
    };
  `);
}

function findEntry(snapshot, predicate) {
  return parseSnapshotEntries(snapshot).find(predicate);
}

function findLastEntry(snapshot, predicate) {
  const entries = parseSnapshotEntries(snapshot);
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    if (predicate(entries[index])) return entries[index];
  }
  return undefined;
}

function matchesModelFamilyControl(candidate, family) {
  return ["button", "radio", "menuitemradio"].includes(candidate.kind || "") && typeof candidate.label === "string" && matchesModelFamilyLabel(candidate.label, family) && !candidate.disabled;
}

function normalizeSnapshotLabel(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function snapshotHasLegacyEffortCombobox(snapshot) {
  return Boolean(findEntry(snapshot, (candidate) => {
    if (candidate.kind !== "combobox" || candidate.disabled) return false;
    return /^(?:Thinking effort|Pro thinking effort)$/i.test(normalizeSnapshotLabel(candidate.label));
  }));
}

function snapshotHasCompactIntelligenceMenuControls(snapshot) {
  return Boolean(findEntry(snapshot, (candidate) => {
    if (candidate.disabled) return false;
    const label = normalizeSnapshotLabel(candidate.label);
    return (candidate.kind === "menu" && /(?:Intelligence.*Instant.*Medium.*High.*Pro|^(?:Instant|Medium|High|Extra High|Pro(?: Standard| Extended)?)$)/i.test(label))
      || (candidate.kind === "menuitemradio" && /^(?:Instant\s+[\d.]+s?|Medium(?:\s+5\s*[–-]\s*30s)?|High(?:\s+15\s*[–-]\s*60s)?|Extra High|Pro(?:\s+5\+\s*min|\s+Standard|\s+Extended)?)$/i.test(label));
  }));
}

function matchesRequestedModelControl(candidate, selection, options = {}) {
  if (!["button", "radio", "menuitemradio"].includes(candidate.kind || "") || typeof candidate.label !== "string" || candidate.disabled) return false;
  if (candidate.kind === "button") {
    if (/\bexpanded=true\b/.test(String(candidate.line || ""))) return false;
    if (options.ignoreCompactTierButtons && /^(?:Instant(?:\s+[\d.]+s?)?|Medium|High|Extra High|Pro(?: Standard| Extended)?)$/i.test(candidate.label)) return false;
    if (options.ignoreCompactOnlyButtons && /^(?:Medium|High|Extra High)$/i.test(candidate.label)) return false;
  }
  if (selection.modelFamily === "pro" && /^Pro(?:\s+Extended)?$/i.test(candidate.label)) return true;
  return matchesRequestedModelControlLabel(candidate.label, selection);
}

function canUseOpenModelMenuForSelection(snapshot, selection) {
  if (selection.modelFamily !== "instant" || selection.autoSwitchToThinking === true) return false;
  return Boolean(findEntry(
    snapshot,
    (candidate) => candidate.kind === "menuitemradio" && matchesModelFamilyControl(candidate, selection.modelFamily),
  ));
}

async function expandCurrentPowerControls(job, snapshot) {
  let currentSnapshot = snapshot;
  let changed = false;
  const advancedOptions = findEntry(
    currentSnapshot,
    (candidate) => candidate.kind === "menuitem" && candidate.label === "Show advanced options" && !candidate.disabled,
  );
  if (advancedOptions) {
    await clickRef(job, advancedOptions.ref);
    await agentBrowser(job, "wait", "500");
    currentSnapshot = await snapshotText(job);
    changed = true;
  }
  const effortOptions = findEntry(
    currentSnapshot,
    (candidate) => candidate.kind === "menuitem" && normalizeSnapshotLabel(candidate.label).startsWith("Effort ") && !String(candidate.line || "").includes("expanded=true") && !candidate.disabled,
  );
  if (effortOptions) {
    await clickRef(job, effortOptions.ref);
    await agentBrowser(job, "wait", "300");
    currentSnapshot = await snapshotText(job);
    changed = true;
  }
  return changed ? currentSnapshot : undefined;
}

function composerControlsVisible(snapshot, job = currentJob) {
  if (!isGrokJob(job)) return snapshotHasUsableComposerControls(snapshot);
  const entries = parseSnapshotEntries(snapshot);
  const hasComposer = entries.some((entry) => !entry.disabled && ((entry.kind === "textbox" && entry.label === GROK_LABELS.composer) || /editable/.test(String(entry.line || ""))));
  const hasAddFiles = entries.some(
    (entry) => entry.kind === "button" && entry.label === GROK_LABELS.addFiles && !entry.disabled,
  );
  return hasComposer && hasAddFiles;
}

async function clickAutoSwitchToThinkingControl(job) {
  const snapshot = await snapshotText(job);
  const entry = findEntry(
    snapshot,
    (candidate) => ["button", "switch"].includes(candidate.kind || "") && typeof candidate.label === "string" && candidate.label.startsWith(CHATGPT_LABELS.autoSwitchToThinking) && !candidate.disabled,
  );
  if (!entry) throw new Error(`Could not find ${CHATGPT_LABELS.autoSwitchToThinking} control`);
  await clickRef(job, entry.ref);
  return entry;
}

async function clickRef(job, ref) {
  await agentBrowser(job, "click", ref);
}

async function clickLabeledEntry(job, label, options = {}) {
  const snapshot = await snapshotText(job);
  const entry = (options.last ? findLastEntry : findEntry)(
    snapshot,
    (candidate) => candidate.label === label && (!options.kind || candidate.kind === options.kind) && !candidate.disabled,
  );
  if (!entry) throw new Error(`Could not find labeled entry: ${label}`);
  await clickRef(job, entry.ref);
  return entry;
}

async function maybeClickLabeledEntry(job, label, options = {}) {
  const snapshot = await snapshotText(job);
  const entry = (options.last ? findLastEntry : findEntry)(
    snapshot,
    (candidate) => candidate.label === label && (!options.kind || candidate.kind === options.kind) && !candidate.disabled,
  );
  if (!entry) return false;
  await clickRef(job, entry.ref);
  return true;
}

async function openEffortDropdown(job) {
  let snapshot = await snapshotText(job);
  if (job.selection?.modelFamily === "pro") {
    let proEffortEntry = findEntry(
      snapshot,
      (candidate) => candidate.kind === "menuitem" && candidate.label === "Pro effort options" && !candidate.disabled,
    );
    if (!proEffortEntry) {
      const opener = findEntry(snapshot, matchesModelConfigurationOpener);
      if (opener) {
        await clickRef(job, opener.ref);
        await agentBrowser(job, "wait", "500");
        snapshot = await snapshotText(job);
        proEffortEntry = findEntry(
          snapshot,
          (candidate) => candidate.kind === "menuitem" && candidate.label === "Pro effort options" && !candidate.disabled,
        );
      }
    }
    if (proEffortEntry) {
      try {
        await clickRef(job, proEffortEntry.ref);
        return true;
      } catch {
        // Fall through to DOM click. ChatGPT's tiny trailing Pro effort icon can
        // be covered at the accessibility click point by the parent Pro row.
      }
    }
    const clicked = await evalPage(job, toJsonScript(`
      const el = document.querySelector('[aria-label="Pro effort options"], [data-composer-intelligence-pro-effort-action]');
      if (!el) return false;
      el.click();
      return true;
    `));
    if (clicked) return true;
  }
  const effortLabels = new Set(["Light", "Standard", "Extended", "Heavy"]);
  const entry = findEntry(
    snapshot,
    (candidate) => candidate.kind === "combobox" && candidate.value && effortLabels.has(candidate.value) && !candidate.disabled,
  );
  if (!entry) return false;
  await clickRef(job, entry.ref);
  return true;
}

async function setComposerText(job, text) {
  if (isGrokJob(job)) {
    const result = await evalPage(job, toJsonScript(`
      const el = document.querySelector('[contenteditable="true"], [contenteditable=true]');
      if (!el) return { ok: false };
      el.focus();
      document.execCommand('selectAll', false, null);
      document.execCommand('insertText', false, ${JSON.stringify(text)});
      el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: ${JSON.stringify(text)} }));
      return { ok: true };
    `));
    if (!result?.ok) throw new Error("Could not find Grok composer textbox");
    return;
  }
  // Keyboard select-all can miss a large restored draft; fill then appends to it.
  // Use the editor's native editing commands and verify clearing before insertion.
  const cleared = await evalPage(job, toAsyncJsonScript(`
    // The accessible fallback textarea can precede the hydrated editable editor.
    const timeoutAt = Date.now() + 15_000;
    let el;
    while (Date.now() < timeoutAt) {
      el = [...document.querySelectorAll(${JSON.stringify(CHATGPT_COMPOSER_EDITOR_SELECTOR)})]
        .find((candidate) => candidate.isContentEditable && candidate.getClientRects().length);
      if (el) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    if (!el) return false;
    el.focus();
    if (document.activeElement !== el) return false;
    document.execCommand('selectAll', false, null);
    document.execCommand('delete', false, null);
    return !el.innerText.trim();
  `));
  if (!cleared) throw new Error("Could not clear ChatGPT composer draft; prompt was not inserted");
  // Resolve the textbox only after hydration; the old fallback reference is stale.
  const snapshot = await snapshotText(job);
  const entry = findEntry(snapshot, isChatGptComposerEntry);
  if (!entry) throw new Error("Could not find ChatGPT composer textbox");
  await agentBrowser(job, "fill", entry.ref, text);
}

function classifyChatPage({ job, url, snapshot, body, probe }) {
  if (isGrokJob(job)) return classifyGrokPage({ url, snapshot, body });
  const text = `${snapshot}\n${body}`;
  const challengePatterns = [
    /just a moment/i,
    /verify you are human/i,
    /cloudflare/i,
    /captcha|turnstile|hcaptcha/i,
    /unusual activity detected/i,
    /we detect suspicious activity/i,
  ];
  if (challengePatterns.some((pattern) => pattern.test(text))) {
    if (/verification successful|waiting for chatgpt\.com to respond/i.test(text)) {
      return { state: "unknown", message: "ChatGPT verification is still settling." };
    }
    return { state: "challenge_blocking", message: "ChatGPT is showing a challenge/verification page" };
  }

  const outageText = detectProviderTransientErrorText(text);
  if (outageText) {
    return { state: "transient_outage_error", message: `ChatGPT is showing a transient outage/rate-limit page: ${outageText}` };
  }

  const allowedOrigins = buildAllowedChatGptOrigins(job.config.browser.chatUrl, job.config.browser.authUrl);
  const onAllowedOrigin = typeof url === "string" && allowedOrigins.some((origin) => url.startsWith(origin));
  const onAuthPath = typeof url === "string" && url.includes("/auth/");
  const hasUsableComposer = snapshotHasUsableComposerControls(snapshot);

  // /backend-api/me also returns HTTP 200 and an id for anonymous visitors: a ua-* identity
  // beside login controls is a signed-out page, never an account still resolving.
  if (probe?.bodyIsAnonymous && (onAuthPath || probe?.onAuthPage || probe?.domLoginCta)) {
    return {
      state: "login_required",
      message: "ChatGPT login is required: the page shows login controls and returned an anonymous visitor session, not a signed-in account. Run /oracle-auth.",
    };
  }

  const probeHasAccountIdentity = !probe?.bodyIsAnonymous && (probe?.bodyHasId === true || probe?.bodyHasEmail === true);

  // A fresh runtime can see a transient 403 while Cloudflare is still loading.
  // Require explicit authentication evidence before declaring the seed logged out.
  if (probe?.status === 401) {
    return { state: "login_required", message: "ChatGPT login is required. Run /oracle-auth." };
  }

  if (onAuthPath || probe?.onAuthPage) {
    if (probeHasAccountIdentity) {
      return {
        state: "auth_transitioning",
        message: "ChatGPT is on an auth page even though the backend probe returned account-like fields. Rerun /oracle-auth.",
      };
    }
    return { state: "login_required", message: "ChatGPT login is required. Run /oracle-auth." };
  }

  if (onAllowedOrigin && probe?.domLoginCta && !probeHasAccountIdentity) {
    return {
      state: "login_required",
      message: "ChatGPT login is required: the chat shell still shows public Log in/Sign up controls. Run /oracle-auth.",
    };
  }

  if (onAllowedOrigin && (probe?.status === 200 || probe?.status === 403) && hasUsableComposer) {
    if (probe?.domLoginCta) {
      // The public logged-out composer case returned above, so a remaining visible login CTA here still has account-like probe data.
      return {
        state: "auth_transitioning",
        message: "ChatGPT backend probe returned account-like fields, but the web shell still shows public login controls. Rerun /oracle-auth.",
      };
    }
    return { state: "authenticated_and_ready", message: "ChatGPT is authenticated and ready." };
  }

  if (url && !onAllowedOrigin) {
    return { state: "login_required", message: "ChatGPT redirected away from the expected authenticated chat origin." };
  }

  return { state: "unknown", message: "ChatGPT page is not ready yet." };
}

function hasGrokLoginCta(text) {
  const lines = String(text || "").split("\n").map((line) => line.trim()).filter(Boolean);
  return lines.some((line) => {
    const accessibleControl = line.match(/^-\s*(?:button|link|menuitem)\s+"([^"]+)"/i)?.[1]?.trim();
    const label = accessibleControl || line;
    return /^(?:sign in|log in|continue with x|continue with google|create account)$/i.test(label);
  });
}

function classifyGrokPage({ url, snapshot, body }) {
  const text = `${snapshot}\n${body}`;
  if (/captcha|cloudflare|verify you are human|unusual activity|suspicious activity/i.test(text)) {
    return { state: "challenge_blocking", message: "Grok is showing a challenge/verification page" };
  }
  const outageText = detectProviderTransientErrorText(text);
  if (outageText) {
    return { state: "transient_outage_error", message: `Grok is showing a transient outage/rate-limit page: ${outageText}` };
  }
  const onGrokOrigin = typeof url === "string" && url.startsWith("https://grok.com");
  if (onGrokOrigin && hasGrokLoginCta(text)) {
    return { state: "login_required", message: "Grok login is required. Sign in to Grok in the configured browser profile and rerun /oracle-auth grok." };
  }
  const hasComposer = snapshot.includes(`button "${GROK_LABELS.addFiles}"`) && (snapshot.includes(`textbox "${GROK_LABELS.composer}"`) || snapshot.includes("contenteditable"));
  if (onGrokOrigin && hasComposer) return { state: "authenticated_and_ready", message: "Grok is ready." };
  if (url && !onGrokOrigin) return { state: "login_required", message: "Grok redirected away from grok.com. Sign in to Grok in the configured browser profile and rerun /oracle-auth grok if needed." };
  return { state: "unknown", message: "Grok page is not ready yet." };
}

async function captureDiagnostics(job, reason) {
  if (!browserStarted) return;
  try {
    const [url, snapshot, body] = await Promise.all([
      currentUrl(job).catch(() => ""),
      snapshotText(job).catch(() => ""),
      pageText(job).catch(() => ""),
    ]);
    await secureWriteText(join(job.logsDir, `${reason}.url.txt`), `${url || ""}\n`);
    await secureWriteText(join(job.logsDir, `${reason}.snapshot.txt`), `${snapshot || ""}\n`);
    await secureWriteText(join(job.logsDir, `${reason}.body.txt`), `${body || ""}\n`);
    await agentBrowser(job, "screenshot", join(job.logsDir, `${reason}.png`)).catch(() => undefined);
  } catch {
    // best effort only
  }
}

async function waitForOracleReady(job) {
  const startedAt = Date.now();
  const timeoutAt = startedAt + (isGrokJob(job) ? 30_000 : Math.min(job.config.auth.bootstrapTimeoutMs || 120_000, 120_000));
  let retriedOutage = false;
  let retriedAuthTransition = false;
  let challengeStartedAt;
  let retriedChallenge = false;

  while (Date.now() < timeoutAt) {
    // Every probe below tolerates failure, so check the browser here or a change waits out the whole timeout.
    await assertManagedBrowserUnchanged(job);
    const [url, snapshot, body, probe] = await Promise.all([
      currentUrl(job).catch(() => ""),
      snapshotText(job).catch(() => ""),
      pageText(job).catch(() => ""),
      loginProbe(job).catch(() => ({ ok: false, status: 0, error: "probe-failed" })),
    ]);
    const classification = classifyChatPage({ job, url, snapshot, body, probe });
    if (classification.state !== "challenge_blocking") {
      challengeStartedAt = undefined;
      retriedChallenge = false;
    }
    if (classification.state === "authenticated_and_ready") return;
    if (job.config.browser.chatGptRelayEndpoint && ["auth_transitioning", "challenge_blocking"].includes(classification.state)) {
      throw new Error("The existing Chrome session needs login or human verification. Complete it manually; the relay worker will not reload the challenge or import cookies.");
    }
    if (classification.state === "auth_transitioning") {
      const elapsedMs = Date.now() - startedAt;
      if (!retriedAuthTransition && elapsedMs >= 5_000) {
        retriedAuthTransition = true;
        await agentBrowser(job, "reload").catch(() => undefined);
        await sleep(1500);
        continue;
      }
      if (elapsedMs >= 15_000) {
        await captureDiagnostics(job, "preflight-auth-transition");
        throw new Error(classification.message || "ChatGPT auth did not settle into a ready chat shell. Rerun /oracle-auth.");
      }
      await sleep(1000);
      continue;
    }
    if (classification.state === "challenge_blocking") {
      const now = Date.now();
      challengeStartedAt ??= now;
      const challengeElapsedMs = now - challengeStartedAt;
      if (!retriedChallenge && challengeElapsedMs >= 5_000) {
        retriedChallenge = true;
        await agentBrowser(job, "reload").catch(() => undefined);
        await sleep(1500);
        continue;
      }
      if (challengeElapsedMs < 15_000) {
        await sleep(1000);
        continue;
      }
      await captureDiagnostics(job, "preflight-challenge");
      throw new Error(classification.message);
    }
    if (classification.state === "transient_outage_error" && !retriedOutage) {
      retriedOutage = true;
      await agentBrowser(job, "reload").catch(() => undefined);
      await sleep(1500);
      continue;
    }
    if (classification.state !== "unknown") {
      await captureDiagnostics(job, "preflight");
      throw new Error(classification.message);
    }
    await sleep(1000);
  }

  await captureDiagnostics(job, "preflight-timeout");
  throw new Error("Timed out waiting for the ChatGPT chat UI to become ready");
}

function detectUploadErrorText(text) {
  const patterns = [
    "Failed upload",
    "upload failed",
    "files.oaiusercontent.com",
    "Please ensure your network settings allow access to this site",
    "could not upload",
  ];
  return patterns.find((pattern) => text.toLowerCase().includes(pattern.toLowerCase()));
}

function detectProviderTransientErrorText(text) {
  const patterns = [
    "Too many requests",
    "rate limit",
    "try again later",
    "Something went wrong",
    "A network error occurred",
    "An error occurred while connecting to the websocket",
  ];
  return patterns.find((pattern) => text.toLowerCase().includes(pattern.toLowerCase()));
}

function detectProviderVisibleBlockerText(text) {
  const patterns = [
    "Too many requests",
    "rate limit",
  ];
  return patterns.find((pattern) => text.toLowerCase().includes(pattern.toLowerCase()));
}

function formatProviderTransientErrorMessage(job, errorText, context) {
  const providerLabel = isGrokJob(job) ? "Grok" : "ChatGPT";
  return `${providerLabel} is showing a transient outage/rate-limit page${context ? ` while ${context}` : ""}: ${errorText}`;
}

function providerTransientErrorMessage(job, text, context) {
  const errorText = detectProviderVisibleBlockerText(text);
  if (!errorText) return "";
  return formatProviderTransientErrorMessage(job, errorText, context);
}

function throwIfProviderTransientError(job, text, context) {
  const message = providerTransientErrorMessage(job, text, context);
  if (message) throw new Error(message);
}

function detectResponseFailureText(text) {
  const patterns = [
    "Message delivery timed out",
    "A network error occurred",
    "An error occurred while connecting to the websocket",
    "There was an error generating a response",
    "Something went wrong while generating the response",
  ];
  return patterns.find((pattern) => text.toLowerCase().includes(pattern.toLowerCase()));
}

async function waitForUploadConfirmed(job, fileLabel, baselineCount) {
  const timeoutAt = Date.now() + 10 * 60 * 1000;
  let stableCount = 0;

  while (Date.now() < timeoutAt) {
    await heartbeat();
    const [snapshot, body] = await Promise.all([snapshotText(job), pageText(job).catch(() => "")]);
    throwIfProviderTransientError(job, snapshot, "uploading the archive");

    const errorText = detectUploadErrorText(`${snapshot}\n${body}`);
    if (errorText) {
      throw new Error(`Upload error detected: ${errorText}`);
    }

    const sendEntry = findSendEntry(job, snapshot);
    const fileCount = isGrokJob(job) && snapshot.includes(fileLabel)
      ? baselineCount + 1
      : composerFileEntryCount(snapshot, fileLabel);

    if ((sendEntry || isGrokJob(job)) && fileCount > baselineCount) {
      stableCount += 1;
      if (stableCount >= 2) return sendEntry;
    } else {
      stableCount = 0;
    }

    await sleep(1000);
  }

  throw new Error(`Timed out waiting for upload confirmation for ${fileLabel}`);
}

async function waitForSendReady(job) {
  const timeoutAt = Date.now() + 5 * 60 * 1000;
  while (Date.now() < timeoutAt) {
    await heartbeat();
    const snapshot = await snapshotText(job);
    const body = await pageText(job).catch(() => "");
    throwIfProviderTransientError(job, snapshot, "waiting for send readiness");
    const errorText = detectUploadErrorText(`${snapshot}\n${body}`);
    if (errorText) {
      throw new Error(`Upload error detected: ${errorText}`);
    }

    const entry = findSendEntry(job, snapshot);
    if (entry) return entry;
    await sleep(1000);
  }
  throw new Error(`Timed out waiting for ${sendLabelsForJob(job)[0]} to become enabled`);
}

async function activateSendButton(job) {
  const result = await evalPage(job, toJsonScript(`
    const labels = ${JSON.stringify(sendLabelsForJob(job))};
    const buttons = Array.from(document.querySelectorAll('button'));
    const button = buttons.find((candidate) => {
      const label = (candidate.getAttribute('aria-label') || candidate.textContent || '').trim();
      return labels.includes(label);
    });
    if (!button) return { ok: false, reason: 'send button not found' };
    if (button.disabled || button.getAttribute('aria-disabled') === 'true') return { ok: false, reason: 'send button disabled' };
    button.click();
    return { ok: true };
  `));
  return result;
}

async function sendAcceptanceState(job, baselineAssistantCount) {
  const [urlResult, snapshot, messages] = await Promise.all([
    currentUrl(job).then((url) => ({ url, ok: true })).catch(() => ({ url: "", ok: false })),
    snapshotText(job).catch(() => ""),
    assistantMessages(job).catch(() => []),
  ]);
  return {
    url: urlResult.url,
    urlKnown: urlResult.ok,
    assistantCount: Math.max(baselineAssistantCount, messages.length),
    stopStreaming: isGrokJob(job) ? snapshot.includes(GROK_LABELS.stop) : chatGptStreamingVisible(snapshot),
    transientErrorText: detectProviderVisibleBlockerText(snapshot) || "",
  };
}

async function clickSend(job, baselineAssistantCount) {
  await waitForSendReady(job);
  const beforeSend = await sendAcceptanceState(job, baselineAssistantCount);
  // Recorded before the click: from here on, a failure may follow a prompt the provider received.
  await mutateJob((latest) => ({ ...latest, promptSendState: "attempted" }));
  const activation = await activateSendButton(job);
  if (!activation?.ok) {
    await mutateJob((latest) => ({ ...latest, promptSendState: "not_sent" }));
    throw new Error(`Could not activate ${sendLabelsForJob(job)[0]}: ${activation?.reason || "DOM activation failed"}`);
  }
  await log(`Activated ${sendLabelsForJob(job)[0]}; waiting for provider acceptance evidence`);
  if (await waitForSendAccepted(job, beforeSend, { timeoutMs: 20_000 })) {
    await mutateJob((latest) => ({ ...latest, promptSendState: "accepted" }));
    return;
  }

  await captureDiagnostics(job, "send-not-accepted");
  throw new Error(`${isGrokJob(job) ? "Grok" : "ChatGPT"} message did not leave the composer after activating ${sendLabelsForJob(job)[0]}`);
}

async function waitForSendAccepted(job, beforeSend, options = {}) {
  const timeoutAt = Date.now() + (options.timeoutMs || 15_000);
  while (Date.now() < timeoutAt) {
    await heartbeat();
    const afterSend = await sendAcceptanceState(job, beforeSend.assistantCount || 0);
    if (afterSend.transientErrorText) throw new Error(formatProviderTransientErrorMessage(job, afterSend.transientErrorText, "waiting for send acceptance"));
    if (providerSendAccepted(beforeSend, afterSend)) return true;
    await sleep(500);
  }
  return false;
}

// A product announcement can open as a modal over the composer once the page has loaded. Only its
// "Close dialog" control is ever used, never an action such as "Get started".
async function dismissBlockingDialog(job, snapshot) {
  const close = findDialogCloseEntry(snapshot);
  if (!close) return false;
  await log("Dismissing a dialog that covers the composer");
  await clickRef(job, close.ref).catch(() => undefined);
  await agentBrowser(job, "wait", "500");
  return true;
}

async function dismissProFeedbackModal(job, snapshot) {
  if (await dismissBlockingDialog(job, snapshot)) return true;
  const entries = parseSnapshotEntries(snapshot);
  const hasProFeedback = entries.some((entry) => entry.kind === "heading" && entry.label === "Pro feedback" && !entry.disabled);
  if (!hasProFeedback) return false;
  const close = entries.find((entry) => entry.kind === "button" && entry.label === CHATGPT_LABELS.close && !entry.disabled);
  if (close) {
    await clickRef(job, close.ref).catch(() => undefined);
    await agentBrowser(job, "wait", "500");
    if (!(await pageText(job).catch(() => "")).includes("Pro feedback")) return true;
  }
  await agentBrowser(job, "press", "Escape").catch(() => undefined);
  await agentBrowser(job, "wait", "500");
  if (!(await pageText(job).catch(() => "")).includes("Pro feedback")) return true;

  const dismissed = await evalPage(job, toJsonScript(`
    const dialogText = document.body.innerText || '';
    if (!/Pro feedback/.test(dialogText)) return false;
    const button = Array.from(document.querySelectorAll('button'))
      .find((candidate) => (candidate.getAttribute('aria-label') || candidate.textContent || '').trim() === 'Close');
    if (!button) return false;
    button.click();
    return true;
  `));
  if (dismissed) await agentBrowser(job, "wait", "500");
  return Boolean(dismissed);
}

async function openModelConfiguration(job) {
  const timeoutAt = Date.now() + MODEL_CONFIGURATION_OPEN_TIMEOUT_MS;
  let lastSnapshot = "";

  while (Date.now() < timeoutAt) {
    const initialSnapshot = await snapshotText(job);
    lastSnapshot = initialSnapshot;
    throwIfProviderTransientError(job, initialSnapshot, "opening model configuration");
    if (await dismissProFeedbackModal(job, initialSnapshot)) continue;
    const expandedInitialSnapshot = await expandCurrentPowerControls(job, initialSnapshot);
    if (expandedInitialSnapshot) {
      lastSnapshot = expandedInitialSnapshot;
      throwIfProviderTransientError(job, expandedInitialSnapshot, "opening model configuration");
      if (snapshotHasModelConfigurationUi(expandedInitialSnapshot)) return expandedInitialSnapshot;
      if (canUseOpenModelMenuForSelection(expandedInitialSnapshot, job.selection)) return expandedInitialSnapshot;
    }
    if (snapshotHasModelConfigurationUi(initialSnapshot)) return initialSnapshot;

    for (const predicate of [matchesModelConfigurationOpener]) {
      const snapshot = await snapshotText(job);
      lastSnapshot = snapshot;
      const entry = findEntry(snapshot, predicate);
      if (!entry) continue;
      await clickRef(job, entry.ref);
      await agentBrowser(job, "wait", "800");
      const after = await snapshotText(job);
      lastSnapshot = after;
      throwIfProviderTransientError(job, after, "opening model configuration");
      const expandedAfter = await expandCurrentPowerControls(job, after);
      if (expandedAfter) {
        lastSnapshot = expandedAfter;
        throwIfProviderTransientError(job, expandedAfter, "opening model configuration");
        if (snapshotHasModelConfigurationUi(expandedAfter)) return expandedAfter;
        if (canUseOpenModelMenuForSelection(expandedAfter, job.selection)) return expandedAfter;
      }
      if (snapshotHasModelConfigurationUi(after)) return after;
      if (canUseOpenModelMenuForSelection(after, job.selection)) return after;

      const configureEntry = findEntry(
        after,
        (candidate) => candidate.kind === "menuitem" && candidate.label === CHATGPT_LABELS.configure && !candidate.disabled,
      );

      if (configureEntry) {
        await clickRef(job, configureEntry.ref);
        await agentBrowser(job, "wait", "1200");
        const postConfigure = await snapshotText(job);
        lastSnapshot = postConfigure;
        throwIfProviderTransientError(job, postConfigure, "opening model configuration");
        if (snapshotHasModelConfigurationUi(postConfigure)) return postConfigure;
        if (canUseOpenModelMenuForSelection(postConfigure, job.selection)) return postConfigure;
      }
    }

    if (composerControlsVisible(lastSnapshot, job) && !snapshotHasModelOpener(lastSnapshot)) {
      await agentBrowser(job, "wait", "1000");
      continue;
    }
    await agentBrowser(job, "wait", "500");
  }

  throw new Error("Could not open model configuration UI");
}

async function waitForModelConfigurationToSettle(job, options = {}) {
  const deadline = Date.now() + MODEL_CONFIGURATION_SETTLE_TIMEOUT_MS;
  let lastCloseAttemptAt = 0;
  let fallbackLogged = false;
  let lastSnapshot = "";

  while (Date.now() < deadline) {
    const snapshot = await snapshotText(job);
    lastSnapshot = snapshot;
    const configurationUiVisible = snapshotHasModelConfigurationUi(snapshot);

    if (!configurationUiVisible) {
      if (snapshotWeaklyMatchesRequestedModel(snapshot, job.selection)) return;
      if (options.stronglyVerified) {
        if (!fallbackLogged) {
          fallbackLogged = true;
          await log(`Model configuration closed after strong in-dialog verification for family=${job.selection.modelFamily} effort=${job.selection?.effort || "(none)"}`);
        }
        return;
      }
    }

    if (!configurationUiVisible && composerControlsVisible(snapshot) && options.stronglyVerified) {
      if (!fallbackLogged) {
        fallbackLogged = true;
        await log(`Composer became usable after strong in-dialog verification for family=${job.selection.modelFamily} effort=${job.selection?.effort || "(none)"}`);
      }
      return;
    }

    if (Date.now() - lastCloseAttemptAt >= MODEL_CONFIGURATION_CLOSE_RETRY_MS) {
      lastCloseAttemptAt = Date.now();
      if (!(await maybeClickLabeledEntry(job, CHATGPT_LABELS.close, { kind: "button" }))) {
        await agentBrowser(job, "press", "Escape").catch(() => undefined);
        await agentBrowser(job, "wait", "100");
        const afterEscape = await snapshotText(job);
        if (snapshotHasModelConfigurationUi(afterEscape)) {
          const composer = findEntry(afterEscape, (candidate) => isChatGptComposerEntry(candidate) && !candidate.disabled);
          if (composer) await clickRef(job, composer.ref).catch(() => undefined);
        }
      }
    }

    await sleep(MODEL_CONFIGURATION_SETTLE_POLL_MS);
  }

  if (options.stronglyVerified && lastSnapshot && !snapshotHasModelConfigurationUi(lastSnapshot)) {
    await log(`Model configuration closed only after settle-timeout for family=${job.selection.modelFamily} effort=${job.selection?.effort || "(none)"}`);
    return;
  }

  throw new Error(`Could not verify requested model settings after configuration for ${job.selection.modelFamily}`);
}

const POWER_SLIDER_ELEMENT = `document.querySelector('[role="menuitem"][aria-label="Power"]')`;

async function readPowerSliderState(job) {
  // Observation and configuration share this read-only view of the currently mounted control.
  // Bare string results come back JSON-quoted from parseEvalResult; wrap in an object instead.
  const result = await evalPage(job, toJsonScript(`
    const power = ${POWER_SLIDER_ELEMENT};
    if (!power) return { present: false };
    const ids = (power.getAttribute("aria-describedby") || "").split(/\\s+/).filter(Boolean);
    return { description: ids.map((id) => (document.getElementById(id)?.textContent || "").trim()).join(" ") };
  `));
  // Keep absence distinct from a mounted control whose description cannot be read or parsed.
  if (result && typeof result === "object" && result.present === false) return null;
  const description = result && typeof result === "object" && typeof result.description === "string" ? result.description : "";
  return parsePowerSliderDescription(description);
}

async function focusPowerSlider(job) {
  const result = await evalPage(job, toJsonScript(`
    const power = ${POWER_SLIDER_ELEMENT};
    if (!power) return { focused: false };
    power.focus();
    return { focused: document.activeElement === power };
  `));
  return Boolean(result && typeof result === "object" && result.focused === true);
}

// Drive the current slider-based thinking-effort picker: only the current stop is rendered, so
// step with real arrow keys and trust the slider's own description after every step. ChatGPT can
// close the picker after a step: on 2026-09-21 onto the target, which the earlier shell's pill
// named; on 2026-10-18 one step off Pro onto High, behind a pill named only "Select ChatGPT model".
// A closed picker is therefore reopened and stepping resumes from the stop the slider reports.
// It can also swallow a press: on 2026-11-01 the first job in a fresh Chrome read High twice in a
// row after an ArrowRight, one second into configuration. An unmoved stop therefore gets one
// longer settle and one refocused press before the job fails; the step budget bounds both.
const POWER_SLIDER_REOPEN_LIMIT = 2;

async function configurePowerSlider(job) {
  const target = powerSliderTargetLabel(job.selection);
  let state = await readPowerSliderState(job);
  if (!state) throw new Error("Could not read the ChatGPT thinking-effort slider");
  await log(`Thinking-effort slider reads ${state.label} (${state.index} of ${state.count}); target ${target}`);
  await recordObservedSelection({ effortLabel: `${state.label} (${state.index} of ${state.count})` });
  let focused = false;
  let reopens = 0;
  let steps = 0; // since the picker last opened
  while (state.label !== target) {
    if (steps >= state.count) throw new Error(`Could not set the thinking-effort slider to ${target}; it reads ${state.label}`);
    if (!focused) {
      if (!(await focusPowerSlider(job))) throw new Error("Could not focus the ChatGPT thinking-effort slider");
      focused = true;
    }
    const key = powerSliderStepKey(state.label, target);
    if (!key) throw new Error(`Unknown thinking-effort slider position: ${state.label}`);
    const before = state.index;
    await agentBrowser(job, "press", key);
    await agentBrowser(job, "wait", "250");
    steps += 1;
    let next = await readPowerSliderState(job);
    if (next && next.index === before) {
      await agentBrowser(job, "wait", "500");
      next = await readPowerSliderState(job);
      if (next && next.index === before) {
        await log(`Thinking-effort slider still reads ${next.label} after ${key}; refocusing and pressing once more`);
        if (!(await focusPowerSlider(job))) throw new Error("Could not focus the ChatGPT thinking-effort slider");
        await agentBrowser(job, "press", key);
        await agentBrowser(job, "wait", "500");
        steps += 1;
        next = await readPowerSliderState(job);
      }
    }
    if (next) {
      if (next.index === before) throw new Error(`Thinking-effort slider did not move toward ${target} from ${next.label}`);
      state = next;
      continue;
    }
    if (powerSliderClosedIntoSelection(await snapshotText(job), job.selection)) {
      await log(`Thinking-effort picker closed on ${target}; the composer already reads it`);
      await recordObservedSelection({ effortLabel: target });
      return;
    }
    if (reopens >= POWER_SLIDER_REOPEN_LIMIT || !snapshotHasPowerSliderMenu(await openModelConfiguration(job))) {
      throw new Error("Lost the ChatGPT thinking-effort slider while stepping");
    }
    reopens += 1;
    state = await readPowerSliderState(job);
    if (!state) throw new Error("Lost the ChatGPT thinking-effort slider while stepping");
    await log(`Thinking-effort picker closed while stepping; reopened on ${state.label} (${state.index} of ${state.count})`);
    await recordObservedSelection({ effortLabel: `${state.label} (${state.index} of ${state.count})` });
    focused = false;
    steps = 0;
  }
  const observedEffortLabel = `${state.label} (${state.index} of ${state.count})`;
  await log(`Thinking-effort slider set to ${observedEffortLabel}`);
  await recordObservedSelection({ effortLabel: observedEffortLabel });
}

// What the composer shows once configuration finished: the model picker's text, the slider's
// effort, and whether the Deep Research pill was verified. Never inferred from the request.
/**
 * @param {any} job
 * @param {{ deepResearchVerified?: boolean }} [options]
 * @returns {Promise<Partial<Omit<import("../shared/job-observability-helpers.mjs").OracleObservedSelection, "product">> | undefined>}
 */
async function observeSelection(job, { deepResearchVerified } = {}) {
  if (isGrokJob(job)) return undefined;
  // A composer tool runs its own model, so the picker's text says nothing about the job.
  if (job.selection.tool) return { at: new Date().toISOString(), modelLabel: null, effortLabel: null, effortControls: "absent",
    ...(deepResearchVerified ? { deepResearchVerified: true } : {}) };
  const snapshot = await snapshotText(job).catch(() => undefined);
  // The picker nests a caption and the selection ("Thinking effort", "Instant"); its text nodes are
  // joined with spaces, skipping screen-reader-only text.
  const picker = await evalPage(job, toJsonScript(`
    const node = document.querySelector(${JSON.stringify(CHATGPT_MODEL_PICKER_SELECTOR)});
    const parts = [];
    if (node) {
      const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
      for (let text = walker.nextNode(); text; text = walker.nextNode()) {
        if (!text.parentElement?.closest('.sr-only') && text.textContent.trim()) parts.push(text.textContent.trim());
      }
    }
    return { label: parts.join(' ').replace(/\\s+/g, ' ').trim() };
  `)).catch(() => undefined);
  const opener = snapshot === undefined ? undefined : findLastEntry(snapshot, (entry) =>
    matchesModelConfigurationOpener(entry) && !/^(?:Select ChatGPT model|Model(?: selector)?)$/.test(entry.label || ""));
  const modelLabel = typeof picker?.label === "string" && picker.label
    ? picker.label.slice(0, 80) : opener?.label?.slice(0, 80) ?? null;
  // Re-read even when configureModel skipped or already recorded a stop. Never open the picker,
  // focus the slider, or infer an offered count from requested settings or an earlier observation.
  // A retained Power node contradicted by a collapsed opener is not currently offered UI.
  const state = snapshot === undefined ? undefined : !snapshotHasPowerSliderMenu(snapshot) ? null
    : await readPowerSliderState(job).catch(() => undefined);
  return { at: new Date().toISOString(), modelLabel,
    effortLabel: state ? `${state.label} (${state.index} of ${state.count})` : null,
    ...(!state ? { effortControls: state === null ? "absent" : "unavailable" } : {}),
    ...(deepResearchVerified ? { deepResearchVerified: true } : {}) };
}

async function configureModel(job) {
  if (isGrokJob(job)) return configureGrokModel(job);
  await dismissBlockingDialog(job, await snapshotText(job));
  if (job.selection.tool) {
    await log(`Model configuration skipped: composer tool ${job.selection.tool} selects its own model`);
    return;
  }
  const initialSnapshot = await snapshotText(job);
  if (snapshotCanSafelySkipModelConfiguration(initialSnapshot, job.selection)) {
    await log(`Model already appears configured for family=${job.selection.modelFamily} effort=${job.selection?.effort || "(none)"}; skipping reconfiguration`);
    return;
  }

  await log(`Configuring model family=${job.selection.modelFamily} effort=${job.selection?.effort || "(none)"}`);
  let familySnapshot = await openModelConfiguration(job);
  let verificationSnapshot = familySnapshot;
  if (snapshotHasPowerSliderMenu(familySnapshot)) {
    await configurePowerSlider(job);
    if (!(await maybeClickLabeledEntry(job, CHATGPT_LABELS.close, { kind: "button" }))) {
      await agentBrowser(job, "press", "Escape").catch(() => undefined);
    }
    await waitForModelConfigurationToSettle(job, { stronglyVerified: true });
    return;
  }

  const initialFamilyOpener = findEntry(
    initialSnapshot,
    (candidate) => candidate.kind === "button" && matchesModelFamilyControl(candidate, job.selection.modelFamily),
  );
  const powerEffortObserved = Boolean(
    requestedEffortLabel(job.selection) && effortSelectionVisible(familySnapshot, requestedEffortLabel(job.selection)),
  );
  let transitionedPowerSelection = Boolean(
    initialFamilyOpener && powerEffortObserved,
  );
  if (powerEffortObserved && !transitionedPowerSelection) {
    const selectModel = findEntry(
      familySnapshot,
      (candidate) => candidate.kind === "menuitem" && candidate.label === "Select model" && !candidate.disabled,
    );
    if (selectModel) {
      await clickRef(job, selectModel.ref);
      await agentBrowser(job, "wait", "500");
      const modelSnapshot = await snapshotText(job);
      transitionedPowerSelection = snapshotWeaklyMatchesRequestedModel(modelSnapshot, job.selection)
        || (job.selection.modelFamily === "pro" && (job.selection.effort || "standard") === "extended"
          && snapshotHasSelectedLatestModel(modelSnapshot));
      verificationSnapshot = modelSnapshot;
      familySnapshot = modelSnapshot;
    }
  }
  const alreadyConfiguredInUi = transitionedPowerSelection || snapshotStronglyMatchesRequestedModel(familySnapshot, job.selection);
  const legacyEffortComboboxVisible = snapshotHasLegacyEffortCombobox(familySnapshot);
  const familyAlreadySelectedInUi = !alreadyConfiguredInUi && legacyEffortComboboxVisible && snapshotWeaklyMatchesRequestedModel(familySnapshot, job.selection);
  const controlOptions = {
    ignoreCompactTierButtons: snapshotHasCompactIntelligenceMenuControls(familySnapshot),
    ignoreCompactOnlyButtons: legacyEffortComboboxVisible,
  };
  let familyEntry = alreadyConfiguredInUi || familyAlreadySelectedInUi
    ? undefined
    : findEntry(familySnapshot, (candidate) => matchesRequestedModelControl(candidate, job.selection, controlOptions));
  if (alreadyConfiguredInUi) {
    await log("Model configuration UI opened with requested settings already selected");
  } else if (familyAlreadySelectedInUi) {
    await log("Model family already appears selected; verifying effort-specific settings");
  } else if (!familyEntry) {
    throw new Error(`Could not find model family control for ${job.selection.modelFamily}`);
  }

  let compactSelectionVerifiedAfterClick = false;
  if (!alreadyConfiguredInUi && !familyAlreadySelectedInUi && familyEntry) {
    const clickedCompactControl = matchesCompactIntelligenceControlLabel(familyEntry.label);
    await clickRef(job, familyEntry.ref);
    await agentBrowser(job, "wait", "800");
    familySnapshot = await snapshotText(job);
    verificationSnapshot = familySnapshot;
    compactSelectionVerifiedAfterClick = clickedCompactControl && snapshotHasClosedCompactSelection(familySnapshot, job.selection);
    if (compactSelectionVerifiedAfterClick) {
      await log(`Verified compact ChatGPT selection after menu close for family=${job.selection.modelFamily} effort=${job.selection?.effort || "(none)"}`);
    }
    const postClickControlOptions = {
      ignoreCompactTierButtons: snapshotHasCompactIntelligenceMenuControls(familySnapshot),
      ignoreCompactOnlyButtons: snapshotHasLegacyEffortCombobox(familySnapshot),
    };
    familyEntry = findEntry(familySnapshot, (candidate) => matchesRequestedModelControl(candidate, job.selection, postClickControlOptions));
    if (!compactSelectionVerifiedAfterClick && !familyEntry && !snapshotStronglyMatchesRequestedModel(familySnapshot, job.selection)) {
      throw new Error(`Requested model family did not remain selected: ${job.selection.modelFamily}`);
    }
  }

  if ((job.selection.modelFamily === "thinking" || job.selection.modelFamily === "pro")
    && !compactSelectionVerifiedAfterClick && !transitionedPowerSelection) {
    const effortLabel = requestedEffortLabel(job.selection);
    if (effortLabel && !effortSelectionVisible(familySnapshot, effortLabel)) {
      const opened = await openEffortDropdown(job);
      if (!opened) {
        // Current ChatGPT Pro menus sometimes expose only undifferentiated "Pro" with no Standard/Extended rows.
        const afterOpenAttempt = await snapshotText(job);
        if (job.selection.modelFamily === "pro" && snapshotStronglyMatchesRequestedModel(afterOpenAttempt, job.selection)) {
          await log(`Pro effort dropdown unavailable for ${effortLabel}; accepting undifferentiated Pro selection`);
          verificationSnapshot = afterOpenAttempt;
          familySnapshot = afterOpenAttempt;
        } else {
          throw new Error(`Could not open effort dropdown for requested effort: ${effortLabel}`);
        }
      } else {
        await agentBrowser(job, "wait", "300");
        if (job.selection.modelFamily === "pro" && await maybeClickLabeledEntry(job, `Pro ${effortLabel}`, { kind: "menuitemradio" })) {
          // Current ChatGPT exposes Pro effort choices as nested menu radio items.
        } else {
          await clickLabeledEntry(job, effortLabel, { kind: "option" });
        }
        await agentBrowser(job, "wait", "400");
        const effortSnapshot = await snapshotText(job);
        verificationSnapshot = effortSnapshot;
        const selectedEffort = findEntry(
          effortSnapshot,
          (candidate) => candidate.kind === "combobox" && candidate.value === effortLabel && !candidate.disabled,
        );
        if (!selectedEffort && !effortSelectionVisible(effortSnapshot, effortLabel)) {
          throw new Error(`Requested effort did not remain selected: ${effortLabel}`);
        }
        familySnapshot = effortSnapshot;
      }
    }
  }

  if (job.selection.modelFamily === "instant") {
    const desiredAutoSwitchState = job.selection.autoSwitchToThinking === true;
    const currentAutoSwitchState = autoSwitchToThinkingSelectionVisible(familySnapshot);
    const compactInstantAlreadyVerified = compactSelectionVerifiedAfterClick
      || (desiredAutoSwitchState && currentAutoSwitchState === undefined && snapshotStronglyMatchesRequestedModel(familySnapshot, job.selection));
    if (!compactInstantAlreadyVerified && currentAutoSwitchState !== desiredAutoSwitchState && (desiredAutoSwitchState || currentAutoSwitchState === true)) {
      await clickAutoSwitchToThinkingControl(job);
      await agentBrowser(job, "wait", "400");
      verificationSnapshot = await snapshotText(job);
      familySnapshot = verificationSnapshot;
    }
  }

  const stronglyVerified = transitionedPowerSelection || compactSelectionVerifiedAfterClick || snapshotStronglyMatchesRequestedModel(verificationSnapshot, job.selection);
  if (!stronglyVerified) {
    throw new Error(`Could not verify requested model settings in configuration UI for ${job.selection.modelFamily}`);
  }

  if (!(await maybeClickLabeledEntry(job, CHATGPT_LABELS.close, { kind: "button" }))) {
    await agentBrowser(job, "press", "Escape").catch(() => undefined);
  }
  await waitForModelConfigurationToSettle(job, { stronglyVerified });
}

// The earlier composer shows a selected tool as a snapshot pill; the current one holds an app
// mention inside the editor that only the DOM exposes reliably.
async function deepResearchToolSelected(job, snapshot) {
  if (snapshotHasDeepResearchPill(snapshot)) return true;
  const result = await evalPage(job, toJsonScript(`
    const editors = [...document.querySelectorAll(${JSON.stringify(CHATGPT_COMPOSER_EDITOR_SELECTOR)})];
    return { present: editors.some((editor) => Boolean(editor.querySelector(${JSON.stringify(CHATGPT_DEEP_RESEARCH_MENTION_SELECTOR)}))) };
  `));
  return result?.present === true;
}

// Deep Research is enabled after the prompt is in the composer: filling the textbox replaces its
// content, and the tool is a pill that lives inside the textbox. Returns once the pill is verified.
async function enableDeepResearch(job) {
  const before = await snapshotText(job);
  if (await deepResearchToolSelected(job, before)) {
    await log("Deep Research tool already enabled in the composer");
    return true;
  }
  const opener = findEntry(before, (candidate) => candidate.kind === "button" && candidate.label === CHATGPT_LABELS.addFiles && !candidate.disabled);
  if (!opener) throw new OracleWorkerError("deep_research_toggle_not_found", `Could not find the "${CHATGPT_LABELS.addFiles}" menu to enable Deep Research`);
  // Filling expands/animates the composer. Wait for a stationary, uncovered control and keep the
  // tool pill out of the prompt text (not inside a path). The wait samples on timers: a job's tab
  // is usually not the visible tab, and Chrome gives hidden tabs no animation frames.
  const settled = await evalPage(job, toAsyncJsonScript(`
    const editor = [...document.querySelectorAll(${JSON.stringify(CHATGPT_COMPOSER_EDITOR_SELECTOR)})]
      .find((candidate) => candidate.isContentEditable && candidate.getClientRects().length);
    if (!editor) return false;
    editor.focus();
    const range = document.createRange();
    range.selectNodeContents(editor);
    range.collapse(false);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    return await (${waitForStationaryControl.toString()})(${JSON.stringify(`button[aria-label="${CHATGPT_LABELS.addFiles}"]`)}, { timeoutMs: 10000 });
  `));
  if (!settled) throw new OracleWorkerError("deep_research_toggle_not_found", "Deep Research menu control did not become stationary and uncovered");
  await clickRef(job, opener.ref);
  // The menu animates open; a fixed wait snapshotted it half-open once. Poll until expanded.
  let entry;
  for (let attempt = 0; attempt < 10 && !entry; attempt += 1) {
    await agentBrowser(job, "wait", "300");
    const menu = await snapshotText(job);
    entry = findEntry(menu, isDeepResearchMenuEntry);
    if (!entry && !menu.includes(`button "${CHATGPT_LABELS.addFiles}" [expanded=true`)) {
      const reopen = findEntry(menu, (candidate) => candidate.kind === "button" && candidate.label === CHATGPT_LABELS.addFiles && !candidate.disabled);
      if (reopen && attempt >= 3) await clickRef(job, reopen.ref);
    }
  }
  if (!entry) {
    // Leave the menu as it is so the failure diagnostics capture what was offered.
    throw new OracleWorkerError("deep_research_toggle_not_found", "Deep Research is not offered in the composer tools menu for this account or page");
  }
  await clickRef(job, entry.ref);
  await agentBrowser(job, "wait", "800");
  const after = await snapshotText(job);
  if (!(await deepResearchToolSelected(job, after))) {
    throw new OracleWorkerError("deep_research_toggle_not_found", "Deep Research did not appear in the composer after selecting it");
  }
  await log("Deep Research tool enabled and verified in the composer");
  return true;
}

async function configureGrokModel(job) {
  const snapshot = await snapshotText(job);
  if (/\bHeavy\b/.test(snapshot) && !snapshot.includes(`button "${GROK_LABELS.modelSelect}"`)) {
    await log("Grok model already appears configured for Heavy; skipping reconfiguration");
    return;
  }
  const modelButton = findEntry(snapshot, (candidate) => candidate.kind === "button" && candidate.label === GROK_LABELS.modelSelect && !candidate.disabled);
  if (!modelButton) throw new Error("Could not find Grok model selector");
  await clickRef(job, modelButton.ref);
  await agentBrowser(job, "wait", "500");
  const menuSnapshot = await snapshotText(job);
  const heavy = findEntry(menuSnapshot, (candidate) => ["menuitem", "menuitemradio", "option", "button"].includes(candidate.kind || "") && /^Heavy\b/i.test(String(candidate.label || "")) && !candidate.disabled);
  if (!heavy) throw new Error("Could not find Grok Heavy model option");
  await clickRef(job, heavy.ref);
  await agentBrowser(job, "wait", "800");
  const after = await snapshotText(job);
  if (!/\bHeavy\b/i.test(after)) {
    if (after.includes('link "Sign in"') || after.includes('button "Sign in"')) {
      throw new Error("Grok Heavy requires a signed-in Grok session. Set defaults.provider='grok', run /oracle-auth, and retry.");
    }
    throw new Error("Could not verify Grok Heavy selection after model configuration");
  }
}

async function uploadArchive(job) {
  if (!existsSync(job.archivePath)) {
    throw new Error(`Archive missing: ${job.archivePath}`);
  }

  const fileLabel = basename(job.archivePath);
  const addFilesSnapshot = await snapshotText(job);
  const labels = labelsForJob(job);
  const baselineComposerFileCount = composerFileEntryCount(addFilesSnapshot, fileLabel);
  // The current ChatGPT shell keeps its general file input mounted beside photo and video inputs;
  // the earlier shell and Grok mount a single input from the attach menu.
  const directInput = !isGrokJob(job) && (await evalPage(job, toJsonScript(`
    return { present: Boolean(document.querySelector(${JSON.stringify(CHATGPT_ATTACH_FILES_INPUT_SELECTOR)})) };
  `)))?.present === true;
  if (directInput) {
    await agentBrowser(job, "upload", CHATGPT_ATTACH_FILES_INPUT_SELECTOR, job.archivePath);
  } else {
    const addFilesEntry = findEntry(
      addFilesSnapshot,
      (candidate) => candidate.label === labels.addFiles && candidate.kind === "button",
    );
    if (!addFilesEntry) {
      throw new Error(`Could not find "${labels.addFiles}" button`);
    }
    await clickRef(job, addFilesEntry.ref);
    await agentBrowser(job, "wait", "500");
    await agentBrowser(job, "upload", "input[type=file]", job.archivePath);
  }
  await log(`Selected archive for upload: ${job.archivePath}`);
  if (isGrokJob(job)) {
    const deadline = Date.now() + 5 * 60 * 1000;
    let stablePolls = 0;
    while (Date.now() < deadline) {
      await heartbeat();
      const [snapshot, body] = await Promise.all([snapshotText(job), pageText(job).catch(() => "")]);
      const errorText = detectUploadErrorText(`${snapshot}\n${body}`);
      if (errorText) {
        throw new Error(`Upload error detected: ${errorText}`);
      }
      if (`${snapshot}\n${body}`.includes(fileLabel)) {
        stablePolls += 1;
        if (stablePolls >= 2) break;
      } else {
        stablePolls = 0;
      }
      await sleep(1000);
    }
    if (stablePolls < 2) throw new Error(`Timed out waiting for Grok upload confirmation for ${fileLabel}`);
  } else {
    await waitForUploadConfirmed(job, fileLabel, baselineComposerFileCount);
  }
  await log(`Upload confirmed for: ${fileLabel}`);
  if (isGrokJob(job)) await agentBrowser(job, "press", "Escape").catch(() => undefined);
  await rm(job.archivePath, { force: true });
  await mutateJob((current) => ({ ...current, archiveDeletedAfterUpload: true }));
}

// Unguarded turn count and texts, for the moments before the job's conversation exists (send
// readiness and acceptance). Polling after send uses observeTurns with the job's conversation.
async function assistantMessages(job) {
  if (isGrokJob(job)) return grokAssistantMessages(job);
  return (await observeTurns(job)).messages;
}

async function grokAssistantMessages(job) {
  const result = await evalPage(
    job,
    toJsonScript(`
      const normalize = (value) => String(value || '').split('\\n\\n\\n').join('\\n\\n').trim();
      const renderText = (node) => {
        if (!node) return '';
        const clone = node.cloneNode(true);
        clone.querySelectorAll('button,[aria-label="Copy"],[aria-label="Like"],[aria-label="Dislike"],[aria-label="Regenerate"],[aria-label="More actions"],.thinking-container').forEach((el) => el.remove());
        const text = normalize(clone.innerText || clone.textContent || '');
        const lines = text.split('\\n');
        if (/^Thought for /i.test(lines[0] || '')) return lines.slice(1).join('\\n').trim();
        return text;
      };
      const bubbles = Array.from(document.querySelectorAll('.message-bubble'));
      const roleMessages = Array.from(document.querySelectorAll('[data-message-author-role="assistant"]'));
      const sourceNodes = bubbles.length > 0
        ? bubbles
        : roleMessages.length > 0
          ? roleMessages
          : Array.from(document.querySelectorAll('div')).filter((node) => {
              const classText = String(node.className || '');
              return classText.includes('group') && classText.includes('flex') && classText.includes('flex-col') && classText.includes('justify-center');
            });
      const messages = sourceNodes
        .map((node) => node.closest('[data-message-author-role], [data-testid*="message"], .group') || node)
        .filter((node, index, all) => all.indexOf(node) === index)
        .filter((node) => node.getAttribute('data-testid') !== 'user-message' && node.getAttribute('data-message-author-role') !== 'user')
        .filter((node) => !node.querySelector('button[aria-label="Edit"]'))
        .map((node) => ({ text: renderText(node.querySelector('.message-bubble') || node) }))
        .filter((message) => message.text && !message.text.toLowerCase().startsWith('executed code'));
      return { messages };
    `),
  );
  if (!Array.isArray(result?.messages)) return [];
  return result.messages.map((message) => ({ text: typeof message?.text === "string" ? message.text : "" }));
}

// A send's conversation is adopted only from a page that shows this job's own archive in a user
// turn, read in the same evaluation as the page's location: a tab that another client navigated
// right after send never hands the job a foreign conversation. Should the archive never show (page
// drift), the stable URL is adopted unverified after the deadline, and the log says so.
async function waitForStableChatUrl(job, previousChatUrl) {
  const timeoutAt = Date.now() + 60_000;
  const archiveFileName = isGrokJob(job) ? undefined : basename(job.archivePath);
  /** @type {import("./chatgpt-flow-helpers.d.mts").OracleStableValueState | undefined} */
  let stableState;

  while (Date.now() < timeoutAt) {
    await heartbeat();
    const observation = archiveFileName ? await observeTurns(job, { archiveFileName }).catch(() => undefined) : undefined;
    const url = archiveFileName ? observation?.href || "" : await currentUrl(job);
    const candidateUrl = resolveStableConversationUrlCandidate(url, previousChatUrl);
    if (candidateUrl && (!archiveFileName || observation?.archiveTurnCount === 1)) {
      stableState = nextStableValueState(stableState, candidateUrl);
      if (stableState.stableCount >= 2) return candidateUrl;
    } else {
      stableState = undefined;
    }

    await sleep(1000);
  }

  const fallback = previousChatUrl || stripUrlQueryAndHash(await currentUrl(job));
  if (archiveFileName) await log(`No user turn showed ${archiveFileName} within 60 s; adopting ${fallback || "(no URL)"} without verifying that it is this job's conversation`);
  return fallback;
}

// Chrome does not give a hidden tab rendering opportunities, and ChatGPT appends streamed tokens
// from that rendering loop, so the job-owned relay tab stops materializing the turn while it sits
// behind another tab or an occluded window. The stop control still clears (it follows the network
// stream, not the DOM), so a frozen partial turn otherwise reads as a finished one and is captured
// as the whole response. Reloading the persisted conversation re-renders the committed turn in one
// pass, which stays correct while hidden, so the streamed read is only ever a lower bound.
const RELOAD_RECONCILE_TIMEOUT_MS = 45_000;
const RELOAD_RECONCILE_POLL_MS = 1_000;
// A stop control that outlives its stream (see nextStaleStopState) would otherwise hold the job
// until the full completion timeout. Two minutes of unchanged non-empty text is far longer than
// any pause between rendered tokens of a live turn, and a reload of a live turn is harmless.
const STALE_STOP_CONTROL_MS = 120_000;
// No completion signature or generation evidence for this long reloads the conversation so a
// turn that finished without the live page showing it is re-read (see nextMissingTurnState).
// One fresh load recovered job 21363c38; after that, leave recovery to timeout/recollection.
const MISSING_TURN_RELOAD_MS = 300_000;
const MISSING_TURN_RELOAD_MAX = 1;

async function reconcileStreamedTurn(job, responseIndex, streamedText) {
  const conversationUrl = job.chatUrl;
  if (!conversationUrl || !isConversationPathUrl(conversationUrl)) return streamedText;
  const conversationId = isGrokJob(job) ? undefined : job.conversationId;
  let best = streamedText;
  try {
    await agentBrowser(job, "open", conversationUrl);
    const deadline = Date.now() + RELOAD_RECONCILE_TIMEOUT_MS;
    let previous = "";
    let stableReads = 0;
    while (Date.now() < deadline) {
      await heartbeat();
      await sleep(RELOAD_RECONCILE_POLL_MS);
      let reloaded = "";
      if (conversationId) {
        const observation = await observeTurns(job, { conversationId }).catch(() => undefined);
        if (observation && !observation.onConversation) {
          await returnToOwnConversation(job, observedPagePath(observation.href));
          previous = "";
          stableReads = 0;
          continue;
        }
        reloaded = observation?.messages[responseIndex]?.text || "";
      } else {
        reloaded = (await assistantMessages(job).catch(() => []))[responseIndex]?.text || "";
      }
      if (reloaded.length > best.length) best = reloaded;
      // A reload renders the committed turn in one pass, but hydration takes a moment; require
      // two identical non-empty reads so a half-hydrated page is never mistaken for the turn.
      stableReads = reloaded && reloaded === previous ? stableReads + 1 : 0;
      previous = reloaded;
      if (stableReads >= 1) break;
    }
  } catch (error) {
    await log(`Reload reconciliation failed, keeping the streamed read: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (best.length > streamedText.length) {
    await log(`Recovered ${best.length - streamedText.length} character(s) the streamed turn had not rendered (streamed ${streamedText.length}, committed ${best.length})`);
  }
  return best;
}

// ChatGPT's composer swaps Send for a stop control while a turn is generating, and keeps it until
// after the turn's text is final. That control (a stop test id in the earlier shell, the submit
// button labeled Stop in the current one) is the authoritative generation signal; observeTurns reads
// rendered controls (not retained hidden workspaces) in the same evaluation as the turns, and the
// accessibility labels remain a fallback.
async function waitForChatCompletion(job, baselineAssistantCount) {
  const timeoutAt = Date.now() + job.config.worker.completionTimeoutMs;
  const conversationId = isGrokJob(job) ? undefined : job.conversationId;
  let lastCompletionSignature = "";
  let stableCount = 0;
  let retriedAfterFailure = false;
  let failedObservations = 0;
  /** @type {import("./chatgpt-flow-helpers.d.mts").OracleStaleStopState | undefined} */
  let staleStop;
  /** @type {import("./chatgpt-flow-helpers.d.mts").OracleMissingTurnState | undefined} */
  let missingTurn;
  /** @type {import("./chatgpt-flow-helpers.d.mts").OracleMissingTurnReloadState | undefined} */
  let missingTurnReload;

  while (Date.now() < timeoutAt) {
    await heartbeat();
    // A page showing another conversation never contributes text, generation state, or Retry: the
    // job reopens its own conversation and starts the stability count over, within its deadline.
    let observation;
    if (!isGrokJob(job)) {
      try {
        observation = await observeTurns(job, { conversationId });
        failedObservations = 0;
      } catch (error) {
        // A navigation in flight (another client's, or the reopen below) can destroy the page's
        // context mid-read; only repeated failures are the job's error.
        failedObservations += 1;
        if (failedObservations >= 3) throw error;
        lastCompletionSignature = "";
        stableCount = 0;
        await sleep(job.config.worker.pollMs);
        continue;
      }
    }
    if (observation && !observation.onConversation) {
      await returnToOwnConversation(job, observedPagePath(observation.href));
      lastCompletionSignature = "";
      stableCount = 0;
      staleStop = undefined;
      await sleep(job.config.worker.pollMs);
      continue;
    }
    await noteOwnConversation();
    const [snapshot, body] = await Promise.all([snapshotText(job), pageText(job).catch(() => "")]);
    const hasStopStreaming = isGrokJob(job)
      ? snapshot.includes(GROK_LABELS.stop)
      : chatGptGenerationActive({ snapshot, domStopButton: observation?.stopPresent });
    const hasRetryButton = snapshot.includes('button "Retry"');
    throwIfProviderTransientError(job, snapshot, "waiting for response completion");
    const responseFailureText = detectResponseFailureText(`${snapshot}\n${body}`);
    const messages = observation ? observation.messages : await assistantMessages(job);
    const targetMessage = messages[baselineAssistantCount];
    const targetText = targetMessage?.text || "";
    // The bound turn must exist before it can be finished. Generation state is the authority for
    // "finished"; assistant-action labels are not, because ChatGPT renames them on rehydration.
    const hasTargetCopyResponse = Boolean(targetMessage);

    if (!hasStopStreaming && hasRetryButton && responseFailureText) {
      // The snapshot is a separate read: act on a failure only while the page still shows this
      // job's conversation, and never click Retry on another conversation's turn.
      if (conversationId && (await observeTurns(job, { conversationId }).catch(() => undefined))?.onConversation !== true) continue;
      if (!retriedAfterFailure) {
        const retryEntry = findEntry(
          snapshot,
          (candidate) => candidate.kind === "button" && candidate.label === "Retry" && !candidate.disabled,
        );
        if (retryEntry) {
          retriedAfterFailure = true;
          lastCompletionSignature = "";
          stableCount = 0;
          await log(`Response delivery failed (${responseFailureText}); clicking Retry once`);
          await clickRef(job, retryEntry.ref);
          await agentBrowser(job, "wait", "1000").catch(() => undefined);
          continue;
        }
      }
      throw new Error(`${isGrokJob(job) ? "Grok" : "ChatGPT"} response failed: ${responseFailureText}`);
    }

    // Deep Research holds its stop control for the whole run by design and reads the report from
    // the widget frame; Grok has no stale-control history. Only plain ChatGPT turns self-heal here.
    if (!isGrokJob(job) && job.selection.tool !== "deep_research" && job.chatUrl && isConversationPathUrl(job.chatUrl)) {
      staleStop = nextStaleStopState(staleStop, { stopControl: hasStopStreaming, text: targetText, now: Date.now(), staleAfterMs: STALE_STOP_CONTROL_MS });
      if (staleStop.stale) {
        await log(`Stop control still present after ${Math.round((Date.now() - (staleStop.since ?? Date.now())) / 1000)} s with the turn unchanged; reloading the conversation to re-read generation state`);
        await agentBrowser(job, "open", job.chatUrl).catch(async (error) => {
          await log(`Conversation reload failed, continuing to poll: ${error instanceof Error ? error.message : String(error)}`);
        });
        staleStop = undefined;
        lastCompletionSignature = "";
        stableCount = 0;
        await sleep(job.config.worker.pollMs);
        continue;
      }
    }
    let completionSignature;
    if (!hasStopStreaming && targetText && (hasTargetCopyResponse || isGrokJob(job))) {
      completionSignature = deriveAssistantCompletionSignature({
        hasStopStreaming,
        hasTargetCopyResponse: hasTargetCopyResponse || isGrokJob(job),
        responseText: targetText,
      });
    } else if (!hasStopStreaming && hasTargetCopyResponse && !targetText) {
      const artifactCandidates = await collectArtifactCandidates(job, baselineAssistantCount).catch(() => []);
      completionSignature = deriveAssistantCompletionSignature({
        hasStopStreaming,
        hasTargetCopyResponse,
        responseText: targetText,
        artifactLabels: artifactCandidates.map((candidate) => candidate.label),
      });
    }

    if (!isGrokJob(job) && job.selection.tool !== "deep_research" && job.chatUrl && isConversationPathUrl(job.chatUrl)) {
      missingTurn = nextMissingTurnState(missingTurn, { signature: Boolean(completionSignature), generating: hasStopStreaming, now: Date.now(), staleAfterMs: MISSING_TURN_RELOAD_MS });
      if (missingTurn.stale) {
        missingTurnReload = nextMissingTurnReloadState(missingTurnReload, MISSING_TURN_RELOAD_MAX);
        if (missingTurnReload.action === "limit") {
          await log("Missing-turn reload already used for this job; polling until the completion timeout");
        }
        if (missingTurnReload.action === "reload") {
          await log(`No completed bound turn observed for ${Math.round((Date.now() - (missingTurn.since ?? Date.now())) / 1000)} s; reloading the conversation to re-read it`);
          await agentBrowser(job, "open", job.chatUrl).catch(async (error) => {
            await log(`Conversation reload failed, continuing to poll: ${error instanceof Error ? error.message : String(error)}`);
          });
          missingTurn = undefined;
          lastCompletionSignature = "";
          stableCount = 0;
          await sleep(job.config.worker.pollMs);
          continue;
        }
      }
    }
    if (completionSignature) {
      if (completionSignature === lastCompletionSignature) stableCount += 1;
      else stableCount = 1;
      lastCompletionSignature = completionSignature;
      if (stableCount >= 2) {
        if (job.selection.tool === "deep_research") {
          // The turn is stable, but for Deep Research the assistant text is never the report: it
          // renders inside a cross-origin App iframe. Read it from the frame session captured
          // before send; any assistant text without the widget means the model replied instead.
          const conversation = job.chatUrl || (await currentUrl(job).catch(() => "")) || "(unknown)";
          if (classifyDeepResearchTurn({ snapshot, text: targetText }) !== "started") {
            throw new OracleWorkerError(
              "deep_research_clarification_requested",
              `Deep Research did not start in ${conversation}; the assistant replied instead: ${targetText.slice(0, 300)}`,
            );
          }
          const report = await waitForDeepResearchReport(job, timeoutAt, { responseIndex: baselineAssistantCount });
          return { responseIndex: baselineAssistantCount, responseText: report };
        }
        return { responseIndex: baselineAssistantCount, responseText: await reconcileStreamedTurn(job, baselineAssistantCount, targetText) };
      }
    } else {
      lastCompletionSignature = "";
      stableCount = 0;
    }

    await sleep(job.config.worker.pollMs);
  }

  // The reply may still finish in the conversation: keep its position so recollection can
  // bind it through the user turn that carries this job's archive, never by resubmitting.
  if (!isGrokJob(job) && job.conversationId) {
    await mutateJob((latest) => ({ ...latest, collectionBinding: latest.collectionBinding ?? { conversationId: job.conversationId, responseIndex: baselineAssistantCount }, recollectionNeeded: true })).catch(() => undefined);
  }
  throw new Error(`Timed out waiting for ${isGrokJob(job) ? "Grok" : "ChatGPT"} response completion`);
}

// Deep Research renders its report in a cross-origin App iframe (a ~300-byte shell whose
// same-origin child frame holds the report). Chrome surfaces that iframe as a CDP child session
// only if auto-attach was armed before the frame was created, so the client is armed before send.
const DEEP_RESEARCH_REPORT_EXPRESSION = `(() => { try { return (frames[0]?.document || globalThis.document).body.innerText; } catch { return ""; } })()`;
const DEEP_RESEARCH_FRAME_WAIT_MS = 60_000;

/** @type {RelayCdpClient | undefined} */
let deepResearchCdp;
let deepResearchPageSession;

async function armDeepResearchFrameCapture(job) {
  const endpoint = sharedBrowserEndpoint(job);
  if (!endpoint) {
    throw new OracleWorkerError("deep_research_report_unreadable", "Deep Research needs a shared Chrome transport (browser.chatGptRelayEndpoint or browser.chatGptManagedProfileDir); the report frame is not reachable from an isolated runtime.");
  }
  if (!job.relayTargetId) throw new Error("Deep Research frame capture needs the job-owned relay tab identity");
  await assertManagedBrowserUnchanged(job);
  deepResearchCdp = await RelayCdpClient.connect(endpoint);
  deepResearchPageSession = await deepResearchCdp.armFrameCapture(job.relayTargetId);
  await log("Armed frame capture on the job-owned relay tab for the Deep Research widget");
}

async function waitForDeepResearchReport(job, timeoutAt, binding) {
  const cdp = deepResearchCdp;
  const conversation = job.chatUrl || (await currentUrl(job).catch(() => "")) || "(unknown)";
  if (!cdp) throw new OracleWorkerError("deep_research_report_unreadable", `Deep Research started in ${conversation}, but frame capture was not armed; open the conversation for the report.`);
  const conversationId = binding.conversationId || job.conversationId;
  let frameDeadline = Math.min(timeoutAt, Date.now() + DEEP_RESEARCH_FRAME_WAIT_MS);
  let frame;
  let lastLogAt = 0;
  while (Date.now() < timeoutAt) {
    await heartbeat();
    // The report frame lives in the job's tab. A tab that left its conversation loses the frame:
    // the host page is checked first, and the frame is found again once the conversation reopens.
    if (conversationId) {
      const observation = await observeTurns(job, { conversationId }).catch(() => undefined);
      if (observation && !observation.onConversation) {
        await returnToOwnConversation(job, observedPagePath(observation.href));
        frame = undefined;
        frameDeadline = Math.min(timeoutAt, Date.now() + DEEP_RESEARCH_FRAME_WAIT_MS);
        await sleep(job.config.worker.pollMs);
        continue;
      }
      if (observation) await noteOwnConversation();
    }
    if (!frame) {
      frame = await boundResearchFrame(job, { ...binding, conversationId }).catch(() => undefined);
      if (!frame) {
        if (Date.now() >= frameDeadline) {
          throw new OracleWorkerError("deep_research_report_unreadable", `Deep Research started in ${conversation}, but its widget frame never surfaced through the relay; open the conversation for the finished report.`);
        }
        await sleep(1000);
        continue;
      }
      await log(`Deep Research widget frame attached (${frame.sessionId}); waiting for the report`);
    }
    const text = await cdp.evaluate(frame.sessionId, DEEP_RESEARCH_REPORT_EXPRESSION);
    if (typeof text !== "string") {
      // A detached frame answers nothing; find the bound frame again instead of polling a dead session.
      frame = undefined;
      frameDeadline = Math.min(timeoutAt, Date.now() + DEEP_RESEARCH_FRAME_WAIT_MS);
      continue;
    }
    const parsed = parseDeepResearchWidgetText(text);
    if (parsed.completed && parsed.report) {
      await log(`Deep Research report read from the widget frame (${parsed.report.length} chars)`);
      return parsed.report;
    }
    if (Date.now() - lastLogAt >= 60_000) {
      lastLogAt = Date.now();
      await log(`Deep Research in progress (${text.length} chars in widget)`);
    }
    await sleep(job.config.worker.pollMs);
  }
  throw new OracleWorkerError("deep_research_report_unreadable", `Deep Research started in ${conversation}, but the report did not appear before the completion timeout; open the conversation for the finished report.`);
}

/**
 * Structural artifact candidates of one assistant turn, read from the DOM. Used only while the
 * turn has no text body: the labels stand in for text as the completion-stability signal.
 * @param {*} job
 * @param {number} responseIndex
 * @returns {Promise<import("./response-capture.d.mts").OracleArtifactCandidate[]>}
 */
async function collectArtifactCandidates(job, responseIndex) {
  const captured = await evalPage(job, toJsonScript(`return ${captureExpression({ responseIndex, conversationId: job.conversationId })};`));
  if (!captured?.candidates) throw new Error("Bound artifact inspection failed.");
  return captured.candidates;
}

async function withHeartbeatWhile(task) {
  let active = true;
  const timer = setInterval(() => { if (active) void heartbeat().catch(() => undefined); }, ARTIFACT_DOWNLOAD_HEARTBEAT_MS);
  timer.unref?.();
  try { return await task(); }
  finally { active = false; clearInterval(timer); }
}

// The conversation is checked inside the capture's own evaluation (captureScopedResponse), so the
// location that authorizes a capture is always the page the capture read.
async function captureBoundTurn(job, binding) {
  if (!binding.conversationId) throw new Error("Collection needs the job's conversation binding.");
  const captured = await evalPage(job, toJsonScript(`return ${captureExpression(binding)};`));
  if (!captured || typeof captured.rawHtml !== "string") throw new Error("Bound response capture failed.");
  const turnSha256 = turnContentSha256(captured.rawText);
  if (!binding.messageId && binding.turnSha256 && binding.turnSha256 !== turnSha256) throw new Error("Bound response content changed; refusing index-only recollection.");
  const { anchorFileName: _anchor, ...durable } = binding;
  return { captured, binding: { ...durable, ...(captured.messageId ? { messageId: captured.messageId } : {}), turnSha256 } };
}

// Capture the bound turn of the job's own conversation. A page showing another conversation is
// reopened on the job's conversation; any failure is retried while a reopened page hydrates. Bounded,
// and never another conversation's turn.
async function acquireBoundTurn(job, binding, attempts = 20) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    await heartbeat();
    try {
      const turn = await captureBoundTurn(job, binding);
      await noteOwnConversation();
      return turn;
    } catch (error) {
      lastError = error;
      const message = error instanceof Error ? error.message : String(error);
      const foreign = message.match(/Bound conversation mismatch: the page shows (.+?), not /)?.[1];
      if (foreign) await returnToOwnConversation(job, foreign);
      await sleep(attempt < 4 ? 500 : 1000);
    }
  }
  throw lastError instanceof Error ? lastError : new Error("The bound assistant turn could not be captured.");
}

// `binding` is the current turn binding, including a message ID learned moments ago by
// captureBoundTurn; a persisted snapshot could be positional-only and select the wrong frame.
async function boundResearchFrame(job, binding) {
  if (!deepResearchCdp || !deepResearchPageSession) throw new Error("Research frame capture is not armed.");
  const turn = await evalPage(job, toJsonScript(`return ${captureExpression({ responseIndex: binding.responseIndex, messageId: binding.messageId, conversationId: binding.conversationId })};`));
  if (!turn?.frames?.length) throw new Error("No research iframe exists in the bound assistant turn.");
  const documentNode = await deepResearchCdp.send("DOM.getDocument", {}, deepResearchPageSession);
  const boundFrames = [];
  for (const frame of turn.frames) {
    // A frame whose marker no longer resolves stays matchable by its src.
    const found = await deepResearchCdp.send("DOM.querySelector", { nodeId: documentNode.root.nodeId, selector: frame.selector }, deepResearchPageSession);
    const node = found.nodeId ? (await deepResearchCdp.send("DOM.describeNode", { nodeId: found.nodeId }, deepResearchPageSession)).node : undefined;
    const attributes = node?.attributes ?? [];
    let title;
    for (let index = 0; index < attributes.length; index += 2) {
      if (attributes[index] === "title") title = attributes[index + 1];
    }
    boundFrames.push({ frameId: node?.frameId, src: frame.src, title });
  }
  const matches = [];
  for (const candidate of deepResearchCdp.frameSessions()) {
    const href = await deepResearchCdp.evaluate(candidate.sessionId, "location.href");
    if (typeof href !== "string" || !/^https:\/\/[^/]*web-sandbox\.oaiusercontent\.com(?:\/|$)/.test(href)) continue;
    const bound = boundFrames.find((frame) => frame.frameId === candidate.targetId || frame.src === href);
    if (bound) matches.push({ ...candidate, title: bound.title });
  }
  if (matches.length !== 1) throw new Error("The bound report frame is absent or ambiguous.");
  if (matches[0].title) await recordObservedSelection({ deepResearchIframeTitle: matches[0].title });
  return matches[0];
}

// The Export control and its asynchronous "Export to Markdown" option live in the report document
// nested inside the sandboxed widget frame; the download itself is delegated to the host page.
async function activateReportExport(frame, selector) {
  const result = await deepResearchCdp.send("Runtime.evaluate", {
    expression: `(async () => { const document = frames[0]?.document || globalThis.document; return await (${activateDownloadControl.toString()})(${JSON.stringify(selector)}, true); })()`,
    returnByValue: true, awaitPromise: true,
  }, frame.sessionId, ARTIFACT_DOWNLOAD_TIMEOUT_MS);
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description?.split("\n")[0] || result.exceptionDetails.text || "Report export activation failed.");
  return result.result?.value;
}

async function flushArtifactsState(artifacts) {
  await secureWriteText(join(jobDir, "artifacts.json"), redactTransportSecrets(JSON.stringify(artifacts, null, 2)) + "\n");
  await mutateJob((job) => ({ ...job, artifactPaths: [...new Set(artifacts.filter((item) => item.copiedPath && existsSync(item.copiedPath)
    && (item.state === "validated" || (item.state === undefined && !item.error && !item.unconfirmed))).map((item) => item.copiedPath))] }));
}

async function preserveCaptureFile(path, content) {
  const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content);
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (existsSync(path)) {
    const previous = await readFile(path);
    if (previous.equals(bytes)) return { path, sha256: digest, size: bytes.length };
    const previousDigest = createHash("sha256").update(previous).digest("hex");
    const historyPath = path + "." + previousDigest + ".previous";
    if (!existsSync(historyPath)) await secureWriteText(historyPath, previous);
  }
  await secureWriteText(path, bytes);
  return { path, sha256: digest, size: bytes.length };
}

// ChatGPT collection saves only what a bound capture read: a failed capture writes no response, and
// the job records that recollection (never resubmission) recovers it. Grok has no bound capture, so
// its streamed text remains its response.
async function collectBoundResult(job, binding, fallbackText = "") {
  const requiredMissing = [];
  const optionalMissing = [];
  let capture;
  let frame;
  let reportState;
  let citations;
  let turnDurationLabel;
  /** @type {import("./response-capture.d.mts").OracleArtifactInspectionState} */
  let inspection = "not_performed";
  /** @type {import("./response-capture.d.mts").OracleCaptureFidelity} */
  let fidelity = "text_only";
  let method = isGrokJob(job) ? "text_fallback" : "none";
  let response = isGrokJob(job) ? fallbackText : "";
  let oldManifest = [];
  try { oldManifest = JSON.parse(await readFile(join(jobDir, "artifacts.json"), "utf8")); } catch {}
  const artifacts = Array.isArray(oldManifest) ? [...oldManifest] : [];
  const artifactsDir = join(jobDir, "artifacts");
  await ensurePrivateDir(artifactsDir);
  try {
    const turn = await acquireBoundTurn(job, binding);
    binding = turn.binding;
    capture = turn.captured;
    turnDurationLabel = capture.durationLabel;
    // Bind before collection: a later download failure can be retried without sending.
    await mutateJob((latest) => ({ ...latest, collectionBinding: binding }));
    if (job.selection.tool === "deep_research") {
      frame = await boundResearchFrame(job, binding);
      const report = /** @type {import("./response-capture.d.mts").OracleScopedCapture | undefined} */ (await deepResearchCdp.evaluate(frame.sessionId, captureExpression({ report: true }, true)));
      const completionText = await deepResearchCdp.evaluate(frame.sessionId, DEEP_RESEARCH_REPORT_EXPRESSION);
      if (!report?.rawHtml || !parseDeepResearchWidgetText(typeof completionText === "string" ? completionText : "").completed) throw new Error("Bound research frame is not a completed report.");
      // The reply that starts research reads "Worked for 5s"; the research itself is timed by the
      // widget's status line ("Research completed in 7m · …").
      const researchDuration = String(completionText).match(/Research completed in ([^·\n]+)/)?.[1]?.trim();
      if (researchDuration) turnDurationLabel = `Research completed in ${researchDuration}`;
      reportState = /** @type {import("./response-capture.d.mts").OracleResearchReportState | undefined} */ (await deepResearchCdp.evaluate(frame.sessionId, `(${readResearchReportState.toString()})()`));
      if (!reportState?.markdown) optionalMissing.push("research_widget_state");
      capture = report;
      binding = { ...binding, frameId: frame.targetId };
    }
    inspection = "inspected";
    fidelity = "derived_markdown";
    method = "scoped_dom";
    response = capture.markdown;
    const markdownBlocks = capture.codeBlocks.filter((block) => /^(?:markdown|md)$/i.test(block.language));
    if (markdownBlocks.length === 1 && job.selection.tool !== "deep_research") {
      response = markdownBlocks[0].text;
      fidelity = "exact_code";
      method = "code_text_content";
    }
    for (const block of capture.codeBlocks) {
      const content = redactTransportSecrets(block.text);
      block.file = await preserveCaptureFile(join(jobDir, "response.block-" + block.index + ".txt"), content);
      block.exact = content === block.text;
      delete block.text;
    }
    const rawText = await preserveCaptureFile(join(jobDir, "response.raw.txt"), redactTransportSecrets(capture.rawText));
    const rawHtml = await preserveCaptureFile(join(jobDir, "response.raw.html"), redactTransportSecrets(capture.rawHtml));
    capture.rawEvidence = { text: rawText, html: rawHtml, scope: "bound_turn",
      sanitization: "active content, transient attributes, and signed transport URLs removed" };
    if (!job.config.artifacts.capture) inspection = "not_performed";
    else {
      let candidates = capture.candidates;
      if (frame && candidates.some((item) => item.nativeMarkdown)) candidates = candidates.filter((item) => item.nativeMarkdown);
      for (const candidate of candidates) {
        const candidateId = (frame ? "frame:" : "turn:") + candidate.candidateId;
        const existing = artifacts.find((item) => item.candidateId === candidateId);
        if (existing?.state === "validated" && existing.copiedPath && existsSync(existing.copiedPath)) {
          try {
            const validation = validateArtifactBytes(await readFile(existing.copiedPath), { fileName: existing.fileName });
            if (validation.sha256 === existing.sha256) continue;
          } catch {}
        }
        const record = { candidateId, displayName: redactTransportSecrets(candidate.label), state: "discovered", required: false };
        const at = artifacts.findIndex((item) => item.candidateId === candidateId);
        if (at >= 0) artifacts[at] = record; else artifacts.push(record);
        await flushArtifactsState(artifacts);
        try {
          let downloaded;
          let nativeDownloadPath;
          if (frame) {
            downloaded = await withHeartbeatWhile(() => collectNativeDownload({
              cdp: deepResearchCdp, pageSessionId: deepResearchPageSession, frameSessionId: frame.sessionId,
              timeoutMs: ARTIFACT_DOWNLOAD_TIMEOUT_MS,
              activate: () => activateReportExport(frame, candidate.selector),
            }));
            await log(`Native report export collected (${downloaded.native.source} download ${downloaded.native.guid} from frame ${downloaded.native.frameId}, ${downloaded.native.totalBytes} bytes)`);
          } else {
            const expression = "(" + captureDownload.toString() + ")(" + JSON.stringify(candidate.selector) + ")";
            try {
              downloaded = await evalPage(job, toAsyncJsonScript(`return await ${expression};`));
            } catch (browserCaptureError) {
              nativeDownloadPath = join(artifactsDir, `.download-${candidate.candidateId}-${randomUUID()}`);
              await log(`Browser byte capture for ${candidate.candidateId} did not observe a file; using the driver's pre-armed native download listener.`);
              await withHeartbeatWhile(() => agentBrowser(job, "download", candidate.selector, nativeDownloadPath, { timeoutMs: ARTIFACT_DOWNLOAD_TIMEOUT_MS }));
              downloaded = { bytesBase64: (await readFile(nativeDownloadPath)).toString("base64"), fileName: candidate.fileName || "", contentType: "" };
            } finally {
              if (nativeDownloadPath) await rm(nativeDownloadPath, { force: true }).catch(() => undefined);
            }
          }
          if (!downloaded?.bytesBase64) throw new Error("Download did not expose bytes.");
          record.state = "downloaded";
          await flushArtifactsState(artifacts);
          const bytes = Buffer.from(downloaded.bytesBase64, "base64");
          const suggested = downloaded.fileName || candidate.fileName || candidate.label.match(/[A-Za-z0-9._-]+\.[A-Za-z0-9]{1,12}\b/)?.[0] || (frame ? "report.md" : "artifact");
          const fileName = basename(redactTransportSecrets(suggested)).replace(/[^A-Za-z0-9._-]/g, "_") || "artifact";
          const validation = validateArtifactBytes(bytes, { ...downloaded, fileName });
          if (frame && (validation.detectedType !== "text/plain" || !/^#{1,6}\s+/m.test(bytes.toString("utf8")) || (capture.title && !bytes.toString("utf8").includes(capture.title)))) throw new Error("Native research export does not match the bound Markdown report.");
          const sameBytes = artifacts.find((item) => item !== record && item.sha256 === validation.sha256 && item.copiedPath && existsSync(item.copiedPath));
          const destination = sameBytes?.copiedPath || join(artifactsDir, validation.sha256 + "-" + fileName);
          if (!sameBytes) await preserveCaptureFile(destination, bytes);
          Object.assign(record, validation, { state: "validated", fileName, copiedPath: destination, nativeMarkdown: Boolean(frame), ...(downloaded.native ? { nativeDownload: downloaded.native } : {}) });
        } catch (error) {
          Object.assign(record, { state: "failed", unconfirmed: true, error: redactTransportSecrets(error.message || String(error)) });
        }
        await flushArtifactsState(artifacts);
      }
    }
    if (frame) {
      const native = artifacts.find((item) => item.nativeMarkdown && item.state === "validated");
      if (!native) optionalMissing.push("native_markdown_export");
      const research = composeResearchResponse({ capture, reportState, nativeMarkdown: native ? await readFile(native.copiedPath, "utf8") : undefined });
      response = research.markdown;
      fidelity = research.fidelity;
      method = research.method;
      citations = research.citations;
      capture.sources = research.sources;
      requiredMissing.push(...research.requiredMissing);
    }
    if (capture.sources.some((item) => item.kind !== "artifact" && item.unresolved)) requiredMissing.push("unresolved_source_links");
  } catch (error) {
    inspection = "failed";
    // Keep whatever binding is durably persisted right now: a message ID learned by this pass and
    // saved before the failure survives, and a wrong explicit binding never replaces a saved one.
    binding = currentJob?.collectionBinding || job.collectionBinding || binding;
    requiredMissing.push("bound_response_capture");
    optionalMissing.push("capture_error:" + redactTransportSecrets(error.message || String(error)));
  }
  const safeResponse = redactTransportSecrets(response);
  if (safeResponse !== response) { requiredMissing.push("redacted_transport_links"); fidelity = "text_only"; }
  // Never erase usable earlier output when a recollection attempt fails.
  let responseFile;
  if (safeResponse) responseFile = await preserveCaptureFile(job.responsePath || join(jobDir, "response.md"), safeResponse);
  else if (job.responsePath && existsSync(job.responsePath)) {
    const bytes = await readFile(job.responsePath);
    responseFile = { path: job.responsePath, sha256: createHash("sha256").update(bytes).digest("hex"), size: bytes.length };
  }
  const outcome = collectionOutcome({ hasResponse: Boolean(responseFile?.size), fidelity, inspection, artifacts, requiredMissing, optionalMissing });
  const metadata = { schemaVersion: 1, jobId: job.id, binding, collectedAt: new Date().toISOString(), method, fidelity, response: responseFile,
    rawEvidence: capture?.rawEvidence, codeBlocks: capture?.codeBlocks || [], sources: capture?.sources || [], ...(citations ? { citations } : {}),
    artifactInspection: { state: inspection, candidateCount: capture?.candidates?.length || 0, result: inspection === "inspected" ? capture?.candidates?.length ? "candidates_found" : "none_found" : "unconfirmed" }, ...outcome };
  const responseCapturePath = join(jobDir, "response.capture.json");
  await preserveCaptureFile(responseCapturePath, redactTransportSecrets(JSON.stringify(metadata, null, 2)) + "\n");
  await flushArtifactsState(artifacts);
  const at = new Date().toISOString();
  await mutateJob((latest) => ({ ...latest, generationStatus: "completed", collectionBinding: binding, responseCapturePath,
    ...(responseFile ? { responsePath: responseFile.path } : {}), ...outcome,
    // A completed turn without any saved response is recovered by recollection, never by resubmitting.
    recollectionNeeded: responseFile?.size ? undefined : true,
    ...(turnDurationLabel ? { observedTurn: { at, durationLabel: turnDurationLabel, durationSeconds: durationLabelSeconds(turnDurationLabel) } } : {}),
    artifactFailureCount: artifacts.filter((item) => item.state === undefined ? item.error || item.unconfirmed : item.state !== "validated").length + (inspection === "failed" ? 1 : 0) }));
  return artifacts;
}

function installSignalHandlers(job) {
  const handleSignal = (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    void (async () => {
      await log(`Received ${signal}, cleaning up oracle runtime`);
      await cleanupRuntime(await readJob().catch(() => currentJob ?? job));
      process.exit(0);
    })();
  };

  process.on("SIGTERM", () => handleSignal("SIGTERM"));
  process.on("SIGINT", () => handleSignal("SIGINT"));
}

async function run() {
  await ensurePrivateDir(jobDir);
  await ensurePrivateDir(`${jobDir}/logs`);
  currentJob = await readJob();
  installSignalHandlers(currentJob);

  try {
    await log(`Starting oracle worker for job ${currentJob.id}`);
    currentJob = await mutateJob((job) => transitionOracleJobPhase(job, "cloning_runtime", {
      at: new Date().toISOString(),
      source: "oracle:worker",
      message: currentJob.config.browser.chatGptRelayEndpoint
        ? "Preparing a job-owned relay tab without copying a browser profile."
        : currentJob.config.browser.chatGptManagedProfileDir ? "Preparing a job-owned tab in the managed ChatGPT browser." : "Cloning the auth seed profile into the isolated runtime.",
      // Nothing reaches the provider before clickSend records "attempted".
      patch: { heartbeatAt: new Date().toISOString(), promptSendState: "not_sent" },
    }));
    await closeBrowser(currentJob);

    // A profile clone can outlast the reconciler's stale-heartbeat window; keep heartbeating.
    const seedGeneration = usesSharedBrowser(currentJob.config) ? undefined : await withHeartbeatWhile(() => cloneSeedProfileToRuntime(currentJob));
    currentJob = await mutateJob((job) => transitionOracleJobPhase(job, "launching_browser", {
      at: new Date().toISOString(),
      source: "oracle:worker",
      message: currentJob.config.browser.chatGptRelayEndpoint
        ? "Connecting to the existing Chrome relay."
        : currentJob.config.browser.chatGptManagedProfileDir ? "Opening or reusing the managed ChatGPT browser." : "Launching the isolated oracle browser runtime.",
      patch: { seedGeneration, heartbeatAt: new Date().toISOString() },
    }));

    const targetUrl = currentJob.chatUrl || currentJob.config.browser.chatUrl;
    await launchBrowser(currentJob, targetUrl);
    if (shuttingDown) return;
    currentJob = await mutateJob((job) => transitionOracleJobPhase(job, "verifying_auth", {
      at: new Date().toISOString(),
      source: "oracle:worker",
      message: `Verifying the ${isGrokJob(currentJob) ? "Grok" : "ChatGPT"} browser session.`,
      patch: { heartbeatAt: new Date().toISOString() },
    }));
    await waitForOracleReady(currentJob);
    const deepResearch = currentJob.selection.tool === "deep_research";
    currentJob = await mutateJob((job) => transitionOracleJobPhase(job, "configuring_model", {
      at: new Date().toISOString(),
      source: "oracle:worker",
      message: deepResearch ? "Enabling Deep Research in the composer." : `Configuring the requested ${isGrokJob(currentJob) ? "Grok" : "ChatGPT"} model selection.`,
      patch: { heartbeatAt: new Date().toISOString() },
    }));
    await configureModel(currentJob);
    let deepResearchVerified = false;
    if (deepResearch) {
      // The attachment card covers the tools menu button once a file is attached, so the tool
      // is enabled before the upload; the pill survives the upload, and fill would remove it.
      await setComposerText(currentJob, await readFile(currentJob.promptPath, "utf8"));
      deepResearchVerified = await enableDeepResearch(currentJob);
    }
    const observedSelection = await observeSelection(currentJob, { deepResearchVerified });
    if (observedSelection) currentJob = await recordObservedSelection(observedSelection);
    currentJob = await mutateJob((job) => transitionOracleJobPhase(job, "uploading_archive", {
      at: new Date().toISOString(),
      source: "oracle:worker",
      message: "Uploading the oracle context archive.",
      patch: { heartbeatAt: new Date().toISOString() },
    }));
    await uploadArchive(currentJob);
    if (!deepResearch) await setComposerText(currentJob, await readFile(currentJob.promptPath, "utf8"));
    const baselineAssistantCount = (await assistantMessages(currentJob)).length;
    await log(`Assistant response count before send: ${baselineAssistantCount}`);
    if (deepResearch) await armDeepResearchFrameCapture(currentJob);
    await clickSend(currentJob, baselineAssistantCount);
    await log(`Send accepted; waiting ${POST_SEND_SETTLE_MS}ms after send to avoid streaming interruption`);
    await sleep(POST_SEND_SETTLE_MS);

    const observedChatUrl = isGrokJob(currentJob)
      ? stripUrlQueryAndHash(await currentUrl(currentJob))
      : await waitForStableChatUrl(currentJob, currentJob.chatUrl);
    const observedConversationId = conversationIdFromUrl(observedChatUrl) || currentJob.conversationId;
    const awaitingResponsePatch = {
      heartbeatAt: new Date().toISOString(),
      ...(observedConversationId ? { chatUrl: observedChatUrl, conversationId: observedConversationId } : {}),
    };
    currentJob = await mutateJob((job) => transitionOracleJobPhase(job, "awaiting_response", {
      at: new Date().toISOString(),
      source: "oracle:worker",
      message: "Waiting for the assistant response to finish streaming.",
      patch: awaitingResponsePatch,
    }));

    const completion = await waitForChatCompletion(currentJob, baselineAssistantCount);
    if (isGrokJob(currentJob) && !currentJob.conversationId) {
      const stableGrokChatUrl = await waitForStableChatUrl(currentJob, undefined);
      const stableGrokConversationId = conversationIdFromUrl(stableGrokChatUrl);
      if (!stableGrokConversationId) {
        throw new Error(`Grok response completed but the conversation URL did not stabilize; current URL: ${stableGrokChatUrl || "(unknown)"}`);
      }
      currentJob = await mutateJob((job) => ({
        ...job,
        chatUrl: stableGrokChatUrl,
        conversationId: stableGrokConversationId,
        heartbeatAt: new Date().toISOString(),
      }));
    }
    currentJob = await mutateJob((job) => transitionOracleJobPhase(job, "extracting_response", {
      at: new Date().toISOString(),
      source: "oracle:worker",
      message: "Extracting the completed response body.",
      patch: { heartbeatAt: new Date().toISOString() },
    }));
    const responseText = isGrokJob(currentJob) ? completion.responseText.trim() : stripChatGptResponseChrome(completion.responseText);
    const collectionBinding = { conversationId: currentJob.conversationId, responseIndex: completion.responseIndex };
    await mutateJob((job) => ({ ...job, generationStatus: "completed", collectionBinding }));
    currentJob = await mutateJob((job) => transitionOracleJobPhase(job, "downloading_artifacts", {
      at: new Date().toISOString(),
      source: "oracle:worker",
      message: "Downloading any response artifacts.",
      patch: { heartbeatAt: new Date().toISOString() },
    }));
    await collectBoundResult(currentJob, collectionBinding, responseText);
    const artifactFailureCount = currentJob.artifactFailureCount || 0;
    const finalPhase = artifactFailureCount > 0 ? "complete_with_artifact_errors" : "complete";

    currentJob = await mutateJob((job) => transitionOracleJobPhase(job, finalPhase, {
      at: new Date().toISOString(),
      source: "oracle:worker",
      message: currentJob.recollectionNeeded
        ? "The response finished, but its bound turn could not be captured; recollect it instead of resubmitting."
        : artifactFailureCount > 0
          ? `Job completed with ${artifactFailureCount} artifact issue(s).`
          : "Job completed successfully.",
      patch: {
        responsePath: currentJob.responsePath,
        responseFormat: "text/plain",
        artifactFailureCount,
        cleanupPending: true,
      },
    }));
    const persistedJob = await readJob().catch(() => undefined);
    await log(`Persisted final status after completion write: ${persistedJob?.status || "unknown"}`);
    await log(`Job ${currentJob.id} complete (${finalPhase}, artifact failures=${artifactFailureCount})`);
  } catch (thrown) {
    if (!shuttingDown) {
      // A browser change can surface first as a tolerant loop's timeout or as the transport error of a
      // command already in flight when it happened; one more check attributes the failure to it.
      await assertManagedBrowserUnchanged(currentJob).catch(() => undefined);
      const error = managedBrowserChangedError ?? thrown;
      const message = error instanceof Error ? error.message : String(error);
      await captureDiagnostics(currentJob, "failure");
      await log(`Job failed: ${message}`);
      currentJob = await mutateJob((job) => transitionOracleJobPhase(job, "failed", {
        at: new Date().toISOString(),
        source: "oracle:worker",
        message: `Job failed: ${message}`,
        patch: {
          error: message,
          ...(error instanceof OracleWorkerError ? { errorCode: error.code } : {}),
          cleanupPending: true,
        },
      }));
      process.exitCode = 1;
    }
  } finally {
    if (shuttingDown) return;
    let cleanupWarnings = [];
    try {
      cleanupWarnings = await cleanupRuntime(currentJob);
    } catch (error) {
      cleanupWarnings = [`Runtime cleanup failed before queued promotion: ${error instanceof Error ? error.message : String(error)}`];
      await log(cleanupWarnings[0]).catch(() => undefined);
    }
    if (currentJob?.id) {
      const cleanupAt = new Date().toISOString();
      await mutateJob((job) => cleanupWarnings.length > 0
        ? applyOracleJobCleanupWarnings(job, cleanupWarnings, {
          at: cleanupAt,
          source: "oracle:worker",
          message: `Runtime cleanup completed with ${cleanupWarnings.length} warning(s).`,
        })
        : clearOracleJobCleanupState(job, {
          at: cleanupAt,
          source: "oracle:worker",
          message: "Runtime cleanup finished without warnings.",
        })).catch(() => undefined);
    }
    if (cleanupWarnings.length === 0) {
      await promoteQueuedJobsAfterCleanup().catch(() => undefined);
    } else {
      await log(`Skipping queued promotion because runtime cleanup left ${cleanupWarnings.length} warning(s)`).catch(() => undefined);
    }
  }
}

async function runRecollection() {
  // Separate entrypoint: never reaches configure/upload/composer/send or the submit queue.
  await withLock(ORACLE_STATE_DIR, "recollect", jobId, { processPid: process.pid }, async () => {
    currentJob = await readJob();
    const explicit = process.argv[4] ? JSON.parse(process.argv[4]) : undefined;
    // A job that timed out waiting for its reply is recollected through its archive anchor and,
    // on success, becomes complete; nothing is ever resent.
    const timedOut = timedOutRecollectionBinding(currentJob, explicit, basename);
    if (currentJob.status !== "complete" && !timedOut) throw new Error("Recollection requires an already completed job.");
    let binding = timedOut ?? currentJob.collectionBinding;
    if (timedOut) {
      // anchored positional binding; the exact identity is learned by captureBoundTurn below
    } else if (!binding?.messageId && !binding?.turnSha256) {
      if (!explicit && Number.isInteger(binding?.responseIndex) && currentJob.archivePath) {
        // A positional binding saved by a capture that failed: the user turn carrying this job's own
        // archive identifies the exchange, and its reply must still sit at the saved index.
        binding = { conversationId: currentJob.conversationId, responseIndex: binding.responseIndex, anchorFileName: basename(currentJob.archivePath) };
      } else {
        if (!Number.isInteger(explicit?.responseIndex) || explicit.responseIndex < 0 || !explicit.messageId) throw new Error("Legacy recollection requires an explicit responseIndex and messageId.");
        // A saved positional index is still a fact about this job: an explicit pair may add the
        // message identity for that turn, never move the binding to another turn.
        if (Number.isInteger(binding?.responseIndex) && explicit.responseIndex !== binding.responseIndex) throw new Error("Recollection cannot move the saved turn index; supply the messageId of that turn.");
        binding = { conversationId: currentJob.conversationId, responseIndex: explicit.responseIndex, messageId: explicit.messageId };
      }
    } else if (explicit && (explicit.responseIndex !== binding.responseIndex || explicit.messageId !== binding.messageId)) throw new Error("Recollection cannot replace an existing turn binding.");
    if (!binding.conversationId || conversationIdFromUrl(currentJob.chatUrl) !== binding.conversationId) throw new Error("Recollection requires the job's exact saved conversation URL.");
    const priorWorker = { runtimeSessionName: currentJob.runtimeSessionName, workerPid: currentJob.workerPid, workerStartedAt: currentJob.workerStartedAt,
      cleanupPending: currentJob.cleanupPending, cleanupWarnings: currentJob.cleanupWarnings,
      cleanupAttemptCount: currentJob.cleanupAttemptCount, cleanupRetryAt: currentJob.cleanupRetryAt };
    let acquired = false;
    await withLock(ORACLE_STATE_DIR, "admission", "global", { processPid: process.pid, jobId }, async () => {
      currentJob = await readJob();
      if (jobBlocksAdmission(currentJob)) throw new Error("The completed job still has a live worker or pending cleanup.");
      const at = new Date().toISOString();
      if (!await tryAcquireRuntimeLeaseForJob(currentJob, at)) throw new Error("Oracle runtime capacity is busy; recollection was not queued.");
      if (!await tryAcquireConversationLeaseForJob(currentJob, at)) {
        await releaseLease(ORACLE_STATE_DIR, "runtime", currentJob.runtimeId);
        throw new Error("The bound conversation is busy; recollection was not queued.");
      }
      // A completed job with cleanupPending and a worker is judged by lastCleanupAt, then heartbeatAt.
      // Retire the stale cleanup timestamp and heartbeat throughout, or an extension poller kills
      // this live worker as a stale terminal-cleanup worker mid-collection (observed live).
      // The predecessor's provenance is persisted, not held in memory, so a killed worker loses nothing.
      await mutateJob((job) => ({ ...job, runtimeSessionName: `oracle-${randomUUID()}`, recollectionPriorWorker: priorWorker,
        workerPid: process.pid, workerStartedAt: readProcessStartedAt(process.pid), cleanupPending: true, heartbeatAt: at, lastCleanupAt: undefined }));
      acquired = true;
    });
    // After a clean teardown the predecessor's identity returns; after a warning the fresh
    // identity stays persisted so terminal-cleanup reconciliation retries against the resources
    // that actually exist, and the predecessor remains recorded in recollectionPriorWorker.
    const finalizeRecollection = async (warnings) => {
      await mutateJob((job) => {
        const prior = job.recollectionPriorWorker || priorWorker;
        const lastCleanupAt = new Date().toISOString();
        if (warnings.length > 0) {
          // Bounded and scheduled like any worker cleanup: deduplicated warnings, a retry time, and
          // an attempt count that ends automatic retries.
          const warned = { ...job, cleanupWarnings: [...new Set([...(prior.cleanupWarnings || []), ...(job.cleanupWarnings || [])])] };
          return applyOracleJobCleanupWarnings(warned, warnings, { at: lastCleanupAt, source: "oracle:recollect",
            message: `Recollection cleanup completed with ${warnings.length} warning(s).` });
        }
        const { recollectionPriorWorker, ...rest } = job;
        return { ...rest, ...prior, cleanupPending: prior.cleanupPending === true,
          cleanupWarnings: prior.cleanupWarnings?.length ? [...new Set(prior.cleanupWarnings)] : undefined, lastCleanupAt };
      });
    };
    const onSignal = (signal) => {
      if (shuttingDown) return;
      shuttingDown = true;
      void (async () => {
        await log(`Received ${signal} during recollection, cleaning up oracle runtime`).catch(() => undefined);
        const warnings = await cleanupRuntime(currentJob).catch((error) => [`Runtime cleanup failed on ${signal}: ${error instanceof Error ? error.message : String(error)}`]);
        await finalizeRecollection(warnings).catch(() => undefined);
        process.exit(0);
      })();
    };
    process.on("SIGTERM", () => onSignal("SIGTERM"));
    process.on("SIGINT", () => onSignal("SIGINT"));
    try {
      await ensurePrivateDir(join(jobDir, "logs"));
      if (!usesSharedBrowser(currentJob.config)) await withHeartbeatWhile(() => cloneSeedProfileToRuntime(currentJob));
      // Arm before navigation; only the newly owned tab is touched.
      await launchBrowser(currentJob, "about:blank");
      if (currentJob.selection.tool === "deep_research") await armDeepResearchFrameCapture(currentJob);
      await agentBrowser(currentJob, "open", currentJob.chatUrl);
      // Reacquire before collecting: an anchored binding becomes an exact one (message ID and turn
      // hash) here, and a page that shows another conversation is reopened on the job's own.
      binding = (await acquireBoundTurn(currentJob, binding)).binding;
      if (currentJob.selection.tool === "deep_research") await waitForDeepResearchReport(currentJob, Date.now() + DEEP_RESEARCH_FRAME_WAIT_MS, binding);
      await collectBoundResult(currentJob, binding);
      await mutateJob((job) => ({ ...job, recollectionError: undefined }));
      if (timedOut) {
        const artifactFailureCount = currentJob.artifactFailureCount || 0;
        currentJob = await mutateJob((job) => transitionOracleJobPhase(job, artifactFailureCount > 0 ? "complete_with_artifact_errors" : "complete", {
          at: new Date().toISOString(),
          source: "oracle:recollect",
          message: "The reply had finished in the conversation; recollected after the completion timeout, nothing was resent.",
          patch: { error: undefined, generationStatus: "completed", recollectionNeeded: undefined, responsePath: currentJob.responsePath, responseFormat: "text/plain", artifactFailureCount, completedAt: new Date().toISOString() },
        }));
        await log(`Recollected the timed-out turn ${binding.responseIndex}; job ${currentJob.id} is complete`);
      }
    } catch (thrown) {
      if (shuttingDown) return;
      await assertManagedBrowserUnchanged(currentJob).catch(() => undefined);
      const error = managedBrowserChangedError ?? thrown;
      const message = redactTransportSecrets(error.message || String(error));
      await log("Recollection failed: " + message);
      await mutateJob((job) => ({ ...job, collectionStatus: existsSync(job.responsePath || "") ? "partial" : "failed", recollectionError: message,
        collectionRequiredMissing: [...new Set([...(job.collectionRequiredMissing || []), "bound_response_capture"])] }));
    } finally {
      if (acquired && !shuttingDown) await finalizeRecollection(await cleanupRuntime(currentJob));
    }
  });
}

if (process.argv[3] === "--recollect") {
  try { await runRecollection(); }
  catch (error) { console.error(redactTransportSecrets(error.message || String(error))); process.exitCode = 1; }
} else await run();
