// Purpose: Execute a single oracle worker job from browser launch through response/artifact extraction and cleanup.
// Responsibilities: Drive the isolated browser session, update durable job state, coordinate cleanup, and autonomously promote queued work after successful teardown.
// Scope: Worker runtime behavior only; shared concurrency/process helpers live in extensions/oracle/shared and extension-side policy remains in lib modules.
// Usage: Spawned as a detached Node process with a job id argument by the oracle extension queue/submission flows.
// Invariants/Assumptions: Job state is persisted under worker-held locks, browser/session artifacts live under the configured oracle directories, and cleanup preserves durable recovery semantics.
import { createHash, randomUUID } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { appendFile, chmod, cp as copyDirectory, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
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
import { applyOracleJobCleanupWarnings, clearOracleJobCleanupState, transitionOracleJobPhase } from "../shared/job-lifecycle-helpers.mjs";
import { spawnDetachedNodeProcess, terminateTrackedProcess } from "../shared/process-helpers.mjs";
import { extractArtifactLabels, FILE_LABEL_PATTERN_SOURCE, GENERIC_ARTIFACT_LABELS, parseSnapshotEntries, partitionStructuralArtifactCandidates } from "./artifact-heuristics.mjs";
import {
  buildAllowedChatGptOrigins,
  deriveAssistantCompletionSignature,
  matchesCompactIntelligenceControlLabel,
  matchesCompactIntelligenceOpenerLabel,
  matchesModelFamilyLabel,
  matchesRequestedModelControlLabel,
  requestedEffortLabel,
  effortSelectionVisible,
  snapshotCanSafelySkipModelConfiguration,
  snapshotHasClosedCompactSelection,
  snapshotHasModelConfigurationUi,
  snapshotHasModelOpener,
  snapshotHasUsableComposerControls,
  snapshotStronglyMatchesRequestedModel,
  snapshotWeaklyMatchesRequestedModel,
  autoSwitchToThinkingSelectionVisible,
  stripChatGptResponseChrome,
} from "./chatgpt-ui-helpers.mjs";
import { assistantSnapshotSlice, nextStableValueState, providerSendAccepted, resolveStableConversationUrlCandidate, stripUrlQueryAndHash } from "./chatgpt-flow-helpers.mjs";
import { assertNotKnownBrowserUserDataPath, scrubSweetCookieSafeStoragePasswordEnv, sweetCookieSafeStoragePasswordScrubbedEnv } from "../shared/browser-profile-helpers.mjs";
import { createLease, listLeaseMetadata, readLeaseMetadata, releaseLease, withLock } from "./state-locks.mjs";

const jobId = process.argv[2];
if (!jobId) {
  console.error("Usage: run-job.mjs <job-id>");
  process.exit(1);
}

const DEFAULT_ORACLE_JOBS_DIR = "/tmp";
const ORACLE_JOBS_DIR = process.env.PI_ORACLE_JOBS_DIR?.trim() || DEFAULT_ORACLE_JOBS_DIR;
const jobDir = join(ORACLE_JOBS_DIR, `oracle-${jobId}`);
const jobPath = `${jobDir}/job.json`;
const CHATGPT_LABELS = {
  composer: "Chat with ChatGPT",
  addFiles: "Add files and more",
  send: "Send prompt",
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
const DEFAULT_ORACLE_STATE_DIR = "/tmp/pi-oracle-state";
const ORACLE_STATE_DIR = process.env.PI_ORACLE_STATE_DIR?.trim() || DEFAULT_ORACLE_STATE_DIR;
const SEED_GENERATION_FILE = ".oracle-seed-generation";
const ARTIFACT_CANDIDATE_STABILITY_TIMEOUT_MS = 15_000;
const ARTIFACT_CANDIDATE_STABILITY_POLL_MS = 1_500;
const ARTIFACT_CANDIDATE_STABILITY_POLLS = 2;
const ARTIFACT_DOWNLOAD_HEARTBEAT_MS = 10_000;
const ARTIFACT_DOWNLOAD_TIMEOUT_MS = 90_000;
const ARTIFACT_DOWNLOAD_MAX_ATTEMPTS = 2;
const AGENT_BROWSER_CLOSE_TIMEOUT_MS = 10_000;
const PROFILE_CLONE_TIMEOUT_MS = 120_000;
const MODEL_CONFIGURATION_OPEN_TIMEOUT_MS = 45_000;
const MODEL_CONFIGURATION_SETTLE_TIMEOUT_MS = 20_000;
const MODEL_CONFIGURATION_SETTLE_POLL_MS = 250;
const MODEL_CONFIGURATION_CLOSE_RETRY_MS = 1_000;
const POST_SEND_SETTLE_MS = 15_000;
const AGENT_BROWSER_BIN = [process.env.AGENT_BROWSER_PATH, "/opt/homebrew/bin/agent-browser", "/usr/local/bin/agent-browser"].find(
  (candidate) => typeof candidate === "string" && candidate && existsSync(candidate),
) || "agent-browser";
const CHROME_DEVTOOLS_READY_TIMEOUT_MS = 15_000;
const CP_BIN = process.env.PI_ORACLE_CP_PATH?.trim() || "cp";
scrubSweetCookieSafeStoragePasswordEnv();

let cpSupportsApfsCloneFlag;
let currentJob;
let browserStarted = false;
let browserProcess;
let browserProcessError;
let cleaningUpBrowser = false;
let cleaningUpRuntime = false;
let shuttingDown = false;
let lastHeartbeatMs = 0;

function providerForJob(job) {
  return job?.selection?.provider === "grok" ? "grok" : "chatgpt";
}

function isGrokJob(job) {
  return providerForJob(job) === "grok";
}

function labelsForJob(job) {
  return isGrokJob(job) ? GROK_LABELS : CHATGPT_LABELS;
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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function killProcessTree(child) {
  if (process.platform === "win32" && child.pid) {
    spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore", windowsHide: true }).on("error", () => undefined);
    return;
  }
  child.kill("SIGTERM");
}

function killProcess(child) {
  if (process.platform === "win32" && child.pid) {
    spawn("taskkill", ["/pid", String(child.pid), "/f"], { stdio: "ignore", windowsHide: true }).on("error", () => undefined);
    return;
  }
  child.kill("SIGKILL");
}

function spawnCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const { timeoutMs, ...spawnOptions } = options;
    const child = spawn(command, args, {
      stdio: ["pipe", "pipe", "pipe"],
      ...spawnOptions,
      env: sweetCookieSafeStoragePasswordScrubbedEnv(spawnOptions.env),
      shell: spawnOptions.shell ?? process.platform === "win32",
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let killTimer;
    if (typeof timeoutMs === "number" && timeoutMs > 0) {
      killTimer = setTimeout(() => {
        timedOut = true;
        killProcessTree(child);
        setTimeout(() => killProcess(child), 2_000).unref?.();
      }, timeoutMs);
      killTimer.unref?.();
    }
    if (options.input) child.stdin.end(options.input);
    else child.stdin.end();
    child.stdout.on("data", (data) => {
      stdout += String(data);
    });
    child.stderr.on("data", (data) => {
      stderr += String(data);
    });
    child.on("close", (code) => {
      if (killTimer) clearTimeout(killTimer);
      if (timedOut) {
        const error = new Error(stderr || stdout || `${command} timed out after ${timeoutMs}ms`);
        if (options.allowFailure) resolve({ code, stdout: stdout.trim(), stderr: error.message });
        else reject(error);
        return;
      }
      if (code === 0 || options.allowFailure) resolve({ code, stdout: stdout.trim(), stderr: stderr.trim() });
      else reject(new Error(stderr || stdout || `${command} exited with code ${code}`));
    });
    child.on("error", (error) => {
      if (killTimer) clearTimeout(killTimer);
      reject(error);
    });
  });
}

async function cpSupportsApfsClone() {
  if (process.platform !== "darwin") return false;
  if (cpSupportsApfsCloneFlag !== undefined) return cpSupportsApfsCloneFlag;
  const probe = await spawnCommand(CP_BIN, ["-c"], { allowFailure: true, timeoutMs: 5_000 });
  cpSupportsApfsCloneFlag = !/invalid option\s+--\s+['"]?c/i.test(`${probe.stderr}\n${probe.stdout}`);
  return cpSupportsApfsCloneFlag;
}

function parseConversationId(chatUrl) {
  if (!chatUrl) return undefined;
  try {
    const parsed = new URL(chatUrl);
    const match = parsed.pathname.match(/\/(?:c|chat)\/([^/?#]+)/i);
    return match?.[1];
  } catch {
    return undefined;
  }
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
    if (browserClosed) {
      try {
        assertSafeRuntimeProfilePath(job.runtimeProfileDir, "runtime profile", job.config);
        await rm(job.runtimeProfileDir, { recursive: true, force: true });
      } catch (error) {
        const message = `Runtime profile cleanup warning: ${error instanceof Error ? error.message : String(error)}`;
        warnings.push(message);
        await log(message).catch(() => undefined);
      }
    } else {
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
  const existing = listLeaseMetadata(ORACLE_STATE_DIR, "runtime");
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
  const existing = await readLeaseMetadata(ORACLE_STATE_DIR, "conversation", metadata.conversationId);
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
  cleaningUpBrowser = true;
  try {
    const result = await spawnCommand(AGENT_BROWSER_BIN, [...browserBaseArgs(job), "close"], {
      allowFailure: true,
      timeoutMs: AGENT_BROWSER_CLOSE_TIMEOUT_MS,
    });
    if (result.code !== 0) {
      throw new Error(result.stderr || result.stdout || `agent-browser close exited with code ${result.code}`);
    }
  } finally {
    await terminateBrowserProcess();
    browserStarted = false;
    cleaningUpBrowser = false;
  }
}

function assertSafeBrowserLaunchArg(arg) {
  const value = String(arg).trim().toLowerCase();
  const managedFlags = [
    "--user-data-dir",
    "--remote-debugging-port",
    "--remote-debugging-pipe",
    "--remote-debugging-address",
    "--remote-allow-origins",
  ];
  const flag = managedFlags.find((candidate) => value === candidate || value.startsWith(`${candidate}=`) || value.startsWith(`${candidate} `));
  if (flag) {
    throw new Error(`browser.args cannot override oracle-managed Chrome launch isolation flag ${flag}`);
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

async function launchBrowser(job, url) {
  await closeBrowser(job);
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
  const status = await streamStatus(job);
  if (status.connected === false) {
    throw new Error("The isolated oracle browser disconnected during the job.");
  }
}

async function agentBrowser(job, ...args) {
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
  const result = await evalPage(job, buildLoginProbeScript(5_000));
  if (!result || typeof result !== "object") {
    return { ok: false, status: 0, error: "invalid-probe-result" };
  }
  return {
    ok: result.ok === true,
    status: typeof result.status === "number" ? result.status : 0,
    pageUrl: typeof result.pageUrl === "string" ? result.pageUrl : undefined,
    domLoginCta: result.domLoginCta === true,
    onAuthPage: result.onAuthPage === true,
    error: typeof result.error === "string" ? result.error : undefined,
    bodyKeys: Array.isArray(result.bodyKeys) ? result.bodyKeys : [],
    bodyHasId: result.bodyHasId === true,
    bodyHasEmail: result.bodyHasEmail === true,
  };
}

async function currentUrl(job) {
  const { stdout } = await agentBrowser(job, "get", "url");
  return stdout;
}

function stripQuery(url) {
  return stripUrlQueryAndHash(url);
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
    return (candidate.kind === "menu" && /(?:Intelligence.*Instant.*Medium.*High.*Pro|^(?:Instant|Medium|High|Extra High|Pro Extended)$)/i.test(label))
      || (candidate.kind === "menuitemradio" && /^(?:Instant(?:\s+5s)?|Medium(?:\s+5\s*[–-]\s*30s)?|High(?:\s+15\s*[–-]\s*60s)?|Extra High|Pro\s+5\+\s*min|Pro Standard|Pro Extended)$/i.test(label));
  }));
}

function matchesRequestedModelControl(candidate, selection, options = {}) {
  if (!["button", "radio", "menuitemradio"].includes(candidate.kind || "") || typeof candidate.label !== "string" || candidate.disabled) return false;
  if (candidate.kind === "button") {
    if (/\bexpanded=true\b/.test(String(candidate.line || ""))) return false;
    if (options.ignoreCompactTierButtons && /^(?:Instant|Medium|High|Extra High|Pro|Pro Extended)$/i.test(candidate.label)) return false;
    if (options.ignoreCompactOnlyButtons && /^(?:Medium|High|Extra High)$/i.test(candidate.label)) return false;
  }
  if (selection.modelFamily === "pro" && /^Pro(?:\s+Extended)?$/i.test(candidate.label)) return true;
  return matchesRequestedModelControlLabel(candidate.label, selection);
}

function matchesModelConfigurationOpener(candidate) {
  if (candidate.kind !== "button" || typeof candidate.label !== "string" || candidate.disabled) return false;
  const label = String(candidate.label || "");
  return candidate.label === "Model"
    || candidate.label === "Model selector"
    || matchesCompactIntelligenceOpenerLabel(label)
    || /^(?:Light|Standard|Extended|Heavy)(?:, click to remove)?$/i.test(label)
    || ["instant", "thinking", "pro"].some((family) => matchesModelFamilyLabel(label, /** @type {import("./chatgpt-ui-helpers.d.mts").OracleUiModelFamily} */ (family)))
    || /^(?:(?:Light|Standard|Extended|Heavy) )?Thinking(?:, click to remove)?$/i.test(label)
    || /^(?:(?:Light|Standard|Extended|Heavy) )?Pro(?:, click to remove)?$/i.test(label);
}

function canUseOpenModelMenuForSelection(snapshot, selection) {
  if (selection.modelFamily !== "instant" || selection.autoSwitchToThinking === true) return false;
  return Boolean(findEntry(
    snapshot,
    (candidate) => candidate.kind === "menuitemradio" && matchesModelFamilyControl(candidate, selection.modelFamily),
  ));
}

function composerControlsVisible(snapshot, job = currentJob) {
  const labels = labelsForJob(job);
  const entries = parseSnapshotEntries(snapshot);
  const hasComposer = isGrokJob(job)
    ? entries.some((entry) => !entry.disabled && ((entry.kind === "textbox" && entry.label === labels.composer) || /editable/.test(String(entry.line || ""))))
    : entries.some((entry) => entry.kind === "textbox" && entry.label === labels.composer && !entry.disabled);
  const hasAddFiles = entries.some(
    (entry) => entry.kind === "button" && entry.label === labels.addFiles && !entry.disabled,
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
  const snapshot = await snapshotText(job);
  const labels = labelsForJob(job);
  const entry = findEntry(snapshot, (candidate) => candidate.kind === "textbox" && candidate.label === labels.composer);
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

  const probeHasAccountIdentity = probe?.bodyHasId === true || probe?.bodyHasEmail === true;

  if (probe?.status === 401 || (probe?.status === 403 && (!onAllowedOrigin || !hasUsableComposer))) {
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

  if (onAllowedOrigin && hasUsableComposer && probe?.domLoginCta && !probeHasAccountIdentity) {
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

  while (Date.now() < timeoutAt) {
    const [url, snapshot, body, probe] = await Promise.all([
      currentUrl(job).catch(() => ""),
      snapshotText(job).catch(() => ""),
      pageText(job).catch(() => ""),
      loginProbe(job).catch(() => ({ ok: false, status: 0, error: "probe-failed" })),
    ]);
    const classification = classifyChatPage({ job, url, snapshot, body, probe });
    if (classification.state === "authenticated_and_ready") return;
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

function composerSnapshotSlice(snapshot, job = currentJob) {
  const lines = snapshot.split("\n");
  const labels = labelsForJob(job);
  let composerIndex = -1;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (lines[index].includes(`textbox "${labels.composer}"`) || (isGrokJob(job) && lines[index].includes("contenteditable"))) {
      composerIndex = index;
      break;
    }
  }
  if (composerIndex === -1) return snapshot;
  const startIndex = Math.max(0, composerIndex - 16);
  const endIndex = Math.min(lines.length, composerIndex + 16);
  return lines.slice(startIndex, endIndex).join("\n");
}

function composerFileEntryCount(snapshot, fileLabel, job = currentJob) {
  const composerSlice = composerSnapshotSlice(snapshot, job);
  return parseSnapshotEntries(composerSlice).filter((candidate) => candidate.label === fileLabel).length;
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

    const labels = labelsForJob(job);
    const sendEntry = findEntry(
      snapshot,
      (candidate) => candidate.kind === "button" && candidate.label === labels.send && !candidate.disabled,
    );
    const fileCount = isGrokJob(job) && snapshot.includes(fileLabel)
      ? baselineCount + 1
      : composerFileEntryCount(snapshot, fileLabel, job);

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

    const labels = labelsForJob(job);
    const entry = findEntry(
      snapshot,
      (candidate) => candidate.kind === "button" && candidate.label === labels.send && !candidate.disabled,
    );
    if (entry) return entry;
    await sleep(1000);
  }
  throw new Error(`Timed out waiting for ${labelsForJob(job).send} to become enabled`);
}

async function activateSendButton(job) {
  const result = await evalPage(job, toJsonScript(`
    const labels = ${JSON.stringify(labelsForJob(job))};
    const buttons = Array.from(document.querySelectorAll('button'));
    const button = buttons.find((candidate) => {
      const label = (candidate.getAttribute('aria-label') || candidate.textContent || '').trim();
      return label === labels.send;
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
    stopStreaming: isGrokJob(job) ? snapshot.includes(GROK_LABELS.stop) : snapshot.includes("Stop streaming"),
    transientErrorText: detectProviderVisibleBlockerText(snapshot) || "",
  };
}

async function clickSend(job, baselineAssistantCount) {
  await waitForSendReady(job);
  const beforeSend = await sendAcceptanceState(job, baselineAssistantCount);
  const activation = await activateSendButton(job);
  if (!activation?.ok) throw new Error(`Could not activate ${labelsForJob(job).send}: ${activation?.reason || "DOM activation failed"}`);
  await log(`Activated ${labelsForJob(job).send}; waiting for provider acceptance evidence`);
  if (await waitForSendAccepted(job, beforeSend, { timeoutMs: 20_000 })) return;

  await captureDiagnostics(job, "send-not-accepted");
  throw new Error(`${isGrokJob(job) ? "Grok" : "ChatGPT"} message did not leave the composer after activating ${labelsForJob(job).send}`);
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

async function dismissProFeedbackModal(job, snapshot) {
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
    if (snapshotHasModelConfigurationUi(initialSnapshot)) return initialSnapshot;
    if (await dismissProFeedbackModal(job, initialSnapshot)) continue;

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

async function configureModel(job) {
  if (isGrokJob(job)) return configureGrokModel(job);
  const initialSnapshot = await snapshotText(job);
  if (snapshotCanSafelySkipModelConfiguration(initialSnapshot, job.selection)) {
    await log(`Model already appears configured for family=${job.selection.modelFamily} effort=${job.selection?.effort || "(none)"}; skipping reconfiguration`);
    return;
  }

  await log(`Configuring model family=${job.selection.modelFamily} effort=${job.selection?.effort || "(none)"}`);
  let familySnapshot = await openModelConfiguration(job);
  let verificationSnapshot = familySnapshot;

  const alreadyConfiguredInUi = snapshotStronglyMatchesRequestedModel(familySnapshot, job.selection);
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

  if ((job.selection.modelFamily === "thinking" || job.selection.modelFamily === "pro") && !compactSelectionVerifiedAfterClick) {
    const effortLabel = requestedEffortLabel(job.selection);
    if (effortLabel && !effortSelectionVisible(familySnapshot, effortLabel)) {
      const opened = await openEffortDropdown(job);
      if (!opened) {
        throw new Error(`Could not open effort dropdown for requested effort: ${effortLabel}`);
      }
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

  const stronglyVerified = compactSelectionVerifiedAfterClick || snapshotStronglyMatchesRequestedModel(verificationSnapshot, job.selection);
  if (!stronglyVerified) {
    throw new Error(`Could not verify requested model settings in configuration UI for ${job.selection.modelFamily}`);
  }

  if (!(await maybeClickLabeledEntry(job, CHATGPT_LABELS.close, { kind: "button" }))) {
    await agentBrowser(job, "press", "Escape").catch(() => undefined);
  }
  await waitForModelConfigurationToSettle(job, { stronglyVerified });
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
  const baselineComposerFileCount = composerFileEntryCount(addFilesSnapshot, fileLabel, job);
  const labels = labelsForJob(job);
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

async function assistantMessages(job) {
  if (isGrokJob(job)) return grokAssistantMessages(job);
  const result = await evalPage(
    job,
    toJsonScript(`
      const headings = Array.from(document.querySelectorAll('h1,h2,h3,h4,h5,h6,[role="heading"]'))
        .filter((el) => (el.textContent || '').trim() === 'ChatGPT said:');
      const renderText = (node) => {
        if (!node) return '';
        const clone = node.cloneNode(true);
        const host = document.createElement('div');
        host.style.position = 'fixed';
        host.style.left = '-99999px';
        host.style.top = '0';
        host.style.whiteSpace = 'pre-wrap';
        host.style.pointerEvents = 'none';
        host.appendChild(clone);
        document.body.appendChild(host);
        let text = (host.innerText || host.textContent || '').trim();
        host.remove();
        const endings = ['\\nChatGPT can make mistakes. Check important info.'];
        for (const ending of endings) {
          if (text.includes(ending)) text = text.split(ending)[0].trim();
        }
        text = text
          .split('\\n')
          .map((line) => line.trimEnd())
          .filter((line) => line.trim() && !/^Thought for\\b/i.test(line.trim()))
          .join('\\n')
          .trim();
        return text;
      };
      const headingMessages = headings.map((heading) => ({ text: renderText(heading.nextElementSibling) }));
      const messageNodes = Array.from(document.querySelectorAll('[data-testid="assistant-message"], [data-message-author-role="assistant"]'));
      const nodeMessages = messageNodes.map((node) => ({ text: renderText(node) }));
      return {
        messages: headingMessages.some((message) => message.text) ? headingMessages : nodeMessages,
      };
    `),
  );

  if (!Array.isArray(result?.messages)) return [];
  return result.messages.map((message) => ({ text: typeof message?.text === "string" ? message.text : "" }));
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

async function waitForStableChatUrl(job, previousChatUrl) {
  const timeoutAt = Date.now() + 60_000;
  /** @type {import("./chatgpt-flow-helpers.d.mts").OracleStableValueState | undefined} */
  let stableState;

  while (Date.now() < timeoutAt) {
    await heartbeat();
    const candidateUrl = resolveStableConversationUrlCandidate(await currentUrl(job), previousChatUrl);
    if (candidateUrl) {
      stableState = nextStableValueState(stableState, candidateUrl);
      if (stableState.stableCount >= 2) return candidateUrl;
    }

    await sleep(1000);
  }

  return previousChatUrl || stripQuery(await currentUrl(job));
}

async function waitForChatCompletion(job, baselineAssistantCount) {
  const timeoutAt = Date.now() + job.config.worker.completionTimeoutMs;
  let lastCompletionSignature = "";
  let stableCount = 0;
  let retriedAfterFailure = false;

  while (Date.now() < timeoutAt) {
    await heartbeat();
    const [snapshot, body] = await Promise.all([snapshotText(job), pageText(job).catch(() => "")]);
    const hasStopStreaming = isGrokJob(job) ? snapshot.includes(GROK_LABELS.stop) : snapshot.includes("Stop streaming");
    const hasRetryButton = snapshot.includes('button "Retry"');
    const copyResponseCount = isGrokJob(job) ? (snapshot.match(/button "Copy"/g) || []).length : (snapshot.match(/Copy response/g) || []).length;
    throwIfProviderTransientError(job, snapshot, "waiting for response completion");
    const responseFailureText = detectResponseFailureText(`${snapshot}\n${body}`);
    const messages = await assistantMessages(job);
    const targetMessage = messages[baselineAssistantCount];
    const targetText = targetMessage?.text || "";
    const hasTargetCopyResponse = copyResponseCount > baselineAssistantCount;

    if (!hasStopStreaming && hasRetryButton && responseFailureText) {
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

    let completionSignature;
    if (!hasStopStreaming && targetText && (hasTargetCopyResponse || isGrokJob(job))) {
      completionSignature = deriveAssistantCompletionSignature({
        hasStopStreaming,
        hasTargetCopyResponse: hasTargetCopyResponse || isGrokJob(job),
        responseText: targetText,
      });
    } else if (!hasStopStreaming && hasTargetCopyResponse && !targetText) {
      const artifactSignals = await collectArtifactCandidates(job, baselineAssistantCount, targetText).catch(() => ({ candidates: [], suspiciousLabels: [] }));
      completionSignature = deriveAssistantCompletionSignature({
        hasStopStreaming,
        hasTargetCopyResponse,
        responseText: targetText,
        artifactLabels: artifactSignals.candidates.map((candidate) => candidate.label),
        suspiciousArtifactLabels: artifactSignals.suspiciousLabels,
      });
    }

    if (completionSignature) {
      if (completionSignature === lastCompletionSignature) stableCount += 1;
      else stableCount = 1;
      lastCompletionSignature = completionSignature;
      if (stableCount >= 2) {
        return { responseIndex: baselineAssistantCount, responseText: targetText };
      }
    } else {
      lastCompletionSignature = "";
      stableCount = 0;
    }

    await sleep(job.config.worker.pollMs);
  }

  throw new Error(`Timed out waiting for ${isGrokJob(job) ? "Grok" : "ChatGPT"} response completion`);
}

async function sha256(path) {
  const buffer = await readFile(path);
  return createHash("sha256").update(buffer).digest("hex");
}

async function detectType(path) {
  const result = await spawnCommand("file", ["-b", path], { allowFailure: true });
  return result.stdout || "unknown";
}

function preferredArtifactName(label, index) {
  const normalized = String(label || "").trim();
  const fileNameMatch = normalized.match(/([A-Za-z0-9._-]+\.[A-Za-z0-9]{1,12})(?!.*[A-Za-z0-9._-]+\.[A-Za-z0-9]{1,12})/);
  if (fileNameMatch) return basename(fileNameMatch[1]).replace(/[^a-zA-Z0-9._-]/g, "_");
  return `artifact-${String(index + 1).padStart(2, "0")}`;
}

async function downloadArtifactViaBrowserEval(job, selector, destinationPath) {
  const result = await evalPage(job, toAsyncJsonScript(`
    const selector = ${JSON.stringify(selector)};
    const maxBytes = 25 * 1024 * 1024;
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const element = document.querySelector(selector);
    if (!element) return { ok: false, error: 'artifact selector not found' };

    const urls = [];
    const captures = [];
    const originalOpen = window.open;
    const originalFetch = window.fetch?.bind(window);
    const originalAnchorClick = HTMLAnchorElement.prototype.click;

    const arrayBufferToBase64 = (buffer) => {
      const bytes = new Uint8Array(buffer);
      let binary = '';
      const chunkSize = 0x8000;
      for (let index = 0; index < bytes.length; index += chunkSize) {
        binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
      }
      return btoa(binary);
    };

    const shouldCapture = (url, headers) => {
      const contentDisposition = headers?.get?.('content-disposition') || '';
      const contentType = headers?.get?.('content-type') || '';
      const signal = [url, contentDisposition, contentType].join(' ').toLowerCase();
      return /download|files|oaiusercontent|attachment/i.test(signal) || signal.includes('estuary/content');
    };

    const captureResponse = async (response, source) => {
      if (!response || captures.length > 0 || !shouldCapture(response.url || '', response.headers)) return;
      const contentLength = Number(response.headers.get('content-length') || 0);
      if (contentLength > maxBytes) {
        captures.push({ ok: false, error: 'artifact response too large for browser-eval fallback', url: response.url || '', source });
        return;
      }
      const clone = response.clone();
      const buffer = await clone.arrayBuffer();
      if (buffer.byteLength > maxBytes) {
        captures.push({ ok: false, error: 'artifact response too large for browser-eval fallback', url: response.url || '', source });
        return;
      }
      const contentType = response.headers.get('content-type') || '';
      if (contentType.toLowerCase().includes('application/json') && originalFetch) {
        try {
          const text = new TextDecoder().decode(buffer);
          const payload = JSON.parse(text);
          const downloadUrl = typeof payload?.download_url === 'string' ? payload.download_url : undefined;
          if (downloadUrl) {
            const fileResponse = await originalFetch(downloadUrl, { credentials: 'include' });
            await captureResponse(fileResponse, 'download_url');
            if (captures.length > 0) return;
          }
        } catch (_error) {
          // Fall through and preserve the JSON payload as last-resort evidence.
        }
      }
      captures.push({
        ok: true,
        url: response.url || '',
        source,
        contentType,
        contentDisposition: response.headers.get('content-disposition') || '',
        bytesBase64: arrayBufferToBase64(buffer),
      });
    };

    try {
      window.open = (url, ...args) => {
        if (url) urls.push(String(url));
        return originalOpen.call(window, url, ...args);
      };
      HTMLAnchorElement.prototype.click = function patchedAnchorClick() {
        if (this.href) urls.push(this.href);
        return originalAnchorClick.call(this);
      };
      if (originalFetch) {
        window.fetch = async (...args) => {
          const response = await originalFetch(...args);
          const requestUrl = String(args[0]?.url || args[0] || response?.url || '');
          if (shouldCapture(requestUrl, response?.headers) || shouldCapture(response?.url || '', response?.headers)) {
            await captureResponse(response, 'fetch');
          }
          return response;
        };
      }

      element.click();
      await sleep(3000);
      for (const url of urls) {
        if (captures.length > 0 || !url || !originalFetch) continue;
        try {
          const response = await originalFetch(url, { credentials: 'include' });
          await captureResponse(response, 'url');
        } catch (_error) {
          // Keep trying any other captured URLs.
        }
      }
      return captures[0] || { ok: false, error: 'click did not expose a downloadable artifact response', urls };
    } finally {
      window.open = originalOpen;
      HTMLAnchorElement.prototype.click = originalAnchorClick;
      if (originalFetch) window.fetch = originalFetch;
    }
  `));

  if (!result?.ok || typeof result.bytesBase64 !== "string") {
    throw new Error(result?.error || "browser-eval artifact fallback did not capture a file");
  }

  await writeFile(destinationPath, Buffer.from(result.bytesBase64, "base64"), { mode: 0o600 });
  return result;
}

async function collectArtifactCandidates(job, responseIndex, responseText = "") {
  const snapshot = await snapshotText(job);
  const targetSlice = assistantSnapshotSlice(snapshot, CHATGPT_LABELS.composer, responseIndex) || snapshot;

  const structural = await evalPage(
    job,
    toJsonScript(`
      const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim();
      const genericArtifactLabels = new Set(${JSON.stringify(GENERIC_ARTIFACT_LABELS)});
      const fileLabelPattern = new RegExp(${JSON.stringify(FILE_LABEL_PATTERN_SOURCE)}, 'g');
      const downloadControlPattern = /(?:^|\\b)(?:download|save)(?:\\b|$)/i;
      const artifactMarkerAttr = 'data-pi-oracle-artifact-candidate';
      const artifactPrefix = 'pi-oracle-artifact-${jobId}-${responseIndex}-';
      const sanitize = (value) => normalize(value).replace(/^[^A-Za-z0-9._~/-]+|[^A-Za-z0-9._~/-]+$/g, '');
      const sanitizeArtifactLabel = (value) => {
        const normalized = sanitize(value);
        if (!normalized) return '';
        const basename = normalized.split(/[\\/]/).filter(Boolean).at(-1) || '';
        return basename.replace(/^[^A-Za-z0-9._-]+|[^A-Za-z0-9._-]+$/g, '');
      };
      const extractArtifactLabels = (value) => {
        const seen = new Set();
        const labels = [];
        for (const match of String(value || '').matchAll(fileLabelPattern)) {
          const label = sanitizeArtifactLabel(match[1] || match[0] || '');
          if (!label || seen.has(label)) continue;
          seen.add(label);
          labels.push(label);
        }
        return labels;
      };
      const isFileLabel = (value) => {
        const normalized = normalize(value);
        if (!normalized) return false;
        if (genericArtifactLabels.has(normalized.toUpperCase())) return true;
        return extractArtifactLabels(normalized).length > 0;
      };
      const isDownloadControl = (value) => downloadControlPattern.test(normalize(value));
      const headings = Array.from(document.querySelectorAll('h1,h2,h3,h4,h5,h6,[role="heading"]'))
        .filter((el) => normalize(el.textContent) === 'ChatGPT said:');
      const host = headings[${responseIndex}]?.nextElementSibling || document.querySelector('main') || document.body;
      if (!host) return { candidates: [] };

      const interactiveElements = (node) => node ? Array.from(node.querySelectorAll('button, a')) : [];
      const interactiveLabels = (node) => interactiveElements(node)
        .map((candidate) => normalize(candidate.textContent || candidate.getAttribute('aria-label') || candidate.getAttribute('title')))
        .filter(Boolean);
      const artifactLabelsForNode = (node) => extractArtifactLabels(node?.textContent || '');
      const otherTextLength = (text, labels) => {
        let remaining = normalize(text);
        for (const label of labels || []) {
          remaining = normalize(remaining.replaceAll(label, ' '));
        }
        remaining = normalize(remaining.replaceAll('Coding Citation', ' '));
        return remaining.length;
      };
      const focusableFor = (node) => node?.closest('[tabindex]');
      const uniqueLabel = (...groups) => {
        for (const group of groups) {
          const labels = Array.from(new Set((group || []).map(sanitizeArtifactLabel).filter(Boolean)));
          if (labels.length === 1) return labels[0];
        }
        return undefined;
      };

      const responseTextArtifactLabels = ${JSON.stringify(extractArtifactLabels(responseText))};
      const candidates = interactiveElements(host)
        .map((button, index) => {
          const controlLabel = normalize(button.textContent || button.getAttribute('aria-label') || button.getAttribute('title'));
          const paragraph = button.closest('p');
          const listItem = button.closest('li');
          const focusable = focusableFor(button);
          const ownArtifactLabels = extractArtifactLabels(controlLabel);
          const paragraphArtifactLabels = artifactLabelsForNode(paragraph);
          const listItemArtifactLabels = artifactLabelsForNode(listItem);
          const focusableArtifactLabels = artifactLabelsForNode(focusable);
          const label = uniqueLabel(
            ownArtifactLabels,
            listItemArtifactLabels,
            paragraphArtifactLabels,
            focusableArtifactLabels,
            isDownloadControl(controlLabel) && responseTextArtifactLabels.length > 0 ? [responseTextArtifactLabels.at(-1)] : [],
          );
          if (!label && !isFileLabel(controlLabel) && !isDownloadControl(controlLabel)) return null;
          if (!label) return null;
          const marker = artifactPrefix + index;
          button.setAttribute(artifactMarkerAttr, marker);
          return {
            label,
            selector: '[' + artifactMarkerAttr + '="' + marker + '"]',
            controlLabel,
            paragraphText: normalize(paragraph?.textContent),
            listItemText: normalize(listItem?.textContent),
            paragraphInteractiveCount: interactiveElements(paragraph).length,
            paragraphArtifactLabelCount: Array.from(new Set(paragraphArtifactLabels)).length,
            paragraphOtherTextLength: otherTextLength(paragraph?.textContent, [...paragraphArtifactLabels, ...interactiveLabels(paragraph)]),
            listItemInteractiveCount: interactiveElements(listItem).length,
            listItemArtifactLabelCount: Array.from(new Set(listItemArtifactLabels)).length,
            focusableInteractiveCount: interactiveElements(focusable).length,
            focusableArtifactLabelCount: Array.from(new Set(focusableArtifactLabels)).length,
            focusableOtherTextLength: otherTextLength(focusable?.textContent, [...focusableArtifactLabels, ...interactiveLabels(focusable)]),
            fromResponseTextLabel: responseTextArtifactLabels.includes(label),
          };
        })
        .filter(Boolean);

      return { candidates };
    `),
  );

  const partitioned = partitionStructuralArtifactCandidates(structural?.candidates || []);
  const snapshotEntries = parseSnapshotEntries(targetSlice);
  const hasGenericArtifactControl = snapshotEntries.some(
    (entry) =>
      (entry.kind === "button" || entry.kind === "link") &&
      !entry.disabled &&
      /(?:^|\b)(?:download|save)(?:\b|$)/i.test(`${entry.label || ""} ${entry.value || ""}`),
  );
  const suspiciousFromText = hasGenericArtifactControl
    ? extractArtifactLabels(responseText)
        .filter((label) => !partitioned.confirmed.some((candidate) => candidate.label === label) && !partitioned.suspicious.some((candidate) => candidate.label === label))
        .map((label) => ({ label }))
    : [];

  return {
    snapshot,
    targetSlice,
    candidates: partitioned.confirmed,
    suspiciousLabels: [...partitioned.suspicious.map((candidate) => candidate.label), ...suspiciousFromText.map((candidate) => candidate.label)]
      .filter((label, index, labels) => labels.indexOf(label) === index),
  };
}

async function waitForStableArtifactCandidates(job, responseIndex, responseText = "") {
  const deadline = Date.now() + ARTIFACT_CANDIDATE_STABILITY_TIMEOUT_MS;
  let lastSignature;
  let stablePolls = 0;
  let latest = { snapshot: "", targetSlice: undefined, candidates: [], suspiciousLabels: [] };

  while (Date.now() < deadline) {
    latest = await collectArtifactCandidates(job, responseIndex, responseText);
    const signature = JSON.stringify({
      candidates: latest.candidates.map((candidate) => candidate.label),
      suspiciousLabels: latest.suspiciousLabels,
    });
    if (signature === lastSignature) stablePolls += 1;
    else {
      lastSignature = signature;
      stablePolls = 1;
    }
    if (stablePolls >= ARTIFACT_CANDIDATE_STABILITY_POLLS) return latest;
    await heartbeat();
    await sleep(ARTIFACT_CANDIDATE_STABILITY_POLL_MS);
  }

  return latest;
}

async function reopenConversationForArtifacts(job, responseIndex, responseText, reason) {
  const targetUrl = job.chatUrl || stripQuery(await currentUrl(job));
  await log(`Reopening conversation before artifact capture (${reason}): ${targetUrl}`);
  await agentBrowser(job, "open", targetUrl);
  await agentBrowser(job, "wait", "1500");
  return waitForStableArtifactCandidates(job, responseIndex, responseText);
}

async function withHeartbeatWhile(task, intervalMs = ARTIFACT_DOWNLOAD_HEARTBEAT_MS) {
  let inFlight = true;
  let heartbeatRunning = false;
  const timer = setInterval(() => {
    if (!inFlight || heartbeatRunning) return;
    heartbeatRunning = true;
    void heartbeat()
      .catch(() => undefined)
      .finally(() => {
        heartbeatRunning = false;
      });
  }, intervalMs);
  timer.unref?.();
  try {
    return await task();
  } finally {
    inFlight = false;
    clearInterval(timer);
  }
}

async function flushArtifactsState(artifacts) {
  await secureWriteText(`${jobDir}/artifacts.json`, `${JSON.stringify(artifacts, null, 2)}\n`);
  await mutateJob((current) => ({
    ...current,
    artifactPaths: artifacts.flatMap((artifact) => (artifact.copiedPath && existsSync(artifact.copiedPath) ? [artifact.copiedPath] : [])),
  }));
}

async function downloadArtifacts(job, responseIndex, responseText = "") {
  if (isGrokJob(job)) {
    await secureWriteText(`${jobDir}/artifacts.json`, "[]\n");
    await mutateJob((current) => ({ ...current, artifactPaths: [] }));
    return [];
  }
  if (!job.config.artifacts.capture) {
    await secureWriteText(`${jobDir}/artifacts.json`, "[]\n");
    await mutateJob((current) => ({ ...current, artifactPaths: [] }));
    return [];
  }

  let { targetSlice, candidates, suspiciousLabels } = await reopenConversationForArtifacts(job, responseIndex, responseText, "initial");

  await log(`Artifact candidates: ${candidates.map((candidate) => candidate.label).join(", ") || "(none)"}`);
  if (suspiciousLabels.length > 0) {
    await log(`Suspicious artifact signals: ${suspiciousLabels.join(", ")}`);
  }

  const artifactsDir = `${jobDir}/artifacts`;
  await ensurePrivateDir(artifactsDir);
  const artifacts = [];
  await flushArtifactsState(artifacts);

  for (const [index, originalCandidate] of candidates.entries()) {
    let downloaded = false;
    let activeCandidate = originalCandidate;
    for (let attempt = 1; attempt <= ARTIFACT_DOWNLOAD_MAX_ATTEMPTS && !downloaded; attempt += 1) {
      if (!activeCandidate?.selector) {
        await log(`Artifact "${originalCandidate.label}" has no live selector, marking unconfirmed`);
        artifacts.push({ displayName: originalCandidate.label, unconfirmed: true, error: "Artifact candidate lost its live selector before download." });
        await flushArtifactsState(artifacts);
        break;
      }

      const destinationPath = join(artifactsDir, preferredArtifactName(originalCandidate.label, index));
      await rm(destinationPath, { force: true }).catch(() => undefined);
      try {
        await log(`Artifact "${originalCandidate.label}" download attempt ${attempt}/${ARTIFACT_DOWNLOAD_MAX_ATTEMPTS} using selector ${activeCandidate.selector}`);
        try {
          const fallback = await downloadArtifactViaBrowserEval(job, activeCandidate.selector, destinationPath);
          await log(`Artifact "${originalCandidate.label}" captured via browser-eval fallback (${fallback.source || "unknown"}${fallback.contentType ? `, ${fallback.contentType}` : ""})`);
        } catch (fallbackError) {
          await log(`Artifact "${originalCandidate.label}" browser-eval fallback did not capture file: ${fallbackError instanceof Error ? fallbackError.message : String(fallbackError)}`);
          await withHeartbeatWhile(() =>
            agentBrowser(job, "download", activeCandidate.selector, destinationPath, {
              timeoutMs: ARTIFACT_DOWNLOAD_TIMEOUT_MS,
            }),
          );
        }
        await heartbeat(undefined, { force: true });
        await chmod(destinationPath, 0o600).catch(() => undefined);
        const [size, checksum, detectedType] = await Promise.all([
          stat(destinationPath).then((stats) => stats.size),
          sha256(destinationPath),
          detectType(destinationPath),
        ]);
        artifacts.push({
          displayName: originalCandidate.label,
          fileName: basename(destinationPath),
          copiedPath: destinationPath,
          size,
          sha256: checksum,
          detectedType,
        });
        downloaded = true;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await rm(destinationPath, { force: true }).catch(() => undefined);
        await log(`Artifact "${originalCandidate.label}" download failed on attempt ${attempt}/${ARTIFACT_DOWNLOAD_MAX_ATTEMPTS}: ${message}`);
        if (attempt >= ARTIFACT_DOWNLOAD_MAX_ATTEMPTS) {
          artifacts.push({ displayName: originalCandidate.label, unconfirmed: true, error: message });
        } else {
          const refreshed = await reopenConversationForArtifacts(job, responseIndex, responseText, `retry ${attempt + 1} for ${originalCandidate.label}`);
          targetSlice = refreshed.targetSlice;
          candidates = refreshed.candidates;
          suspiciousLabels = refreshed.suspiciousLabels;
          activeCandidate = candidates.find((candidate) => candidate.label === originalCandidate.label);
          await sleep(1_000);
        }
      } finally {
        await flushArtifactsState(artifacts);
      }
    }
  }

  if (suspiciousLabels.length > 0) {
    await log(`Ignoring plain-text artifact-like labels without downloadable controls: ${suspiciousLabels.join(", ")}`);
  }

  return artifacts;
}

function installSignalHandlers(job) {
  const handleSignal = (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    void (async () => {
      await log(`Received ${signal}, cleaning up oracle runtime`);
      await cleanupRuntime(job);
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
      message: "Cloning the auth seed profile into the isolated runtime.",
      patch: { heartbeatAt: new Date().toISOString() },
    }));
    await closeBrowser(currentJob);

    const seedGeneration = await cloneSeedProfileToRuntime(currentJob);
    currentJob = await mutateJob((job) => transitionOracleJobPhase(job, "launching_browser", {
      at: new Date().toISOString(),
      source: "oracle:worker",
      message: "Launching the isolated oracle browser runtime.",
      patch: { seedGeneration, heartbeatAt: new Date().toISOString() },
    }));

    const targetUrl = currentJob.chatUrl || currentJob.config.browser.chatUrl;
    await launchBrowser(currentJob, targetUrl);
    currentJob = await mutateJob((job) => transitionOracleJobPhase(job, "verifying_auth", {
      at: new Date().toISOString(),
      source: "oracle:worker",
      message: `Verifying the imported ${isGrokJob(currentJob) ? "Grok" : "ChatGPT"} browser session.`,
      patch: { heartbeatAt: new Date().toISOString() },
    }));
    await waitForOracleReady(currentJob);
    currentJob = await mutateJob((job) => transitionOracleJobPhase(job, "configuring_model", {
      at: new Date().toISOString(),
      source: "oracle:worker",
      message: `Configuring the requested ${isGrokJob(currentJob) ? "Grok" : "ChatGPT"} model selection.`,
      patch: { heartbeatAt: new Date().toISOString() },
    }));
    await configureModel(currentJob);
    currentJob = await mutateJob((job) => transitionOracleJobPhase(job, "uploading_archive", {
      at: new Date().toISOString(),
      source: "oracle:worker",
      message: "Uploading the oracle context archive.",
      patch: { heartbeatAt: new Date().toISOString() },
    }));
    await uploadArchive(currentJob);
    await setComposerText(currentJob, await readFile(currentJob.promptPath, "utf8"));
    const baselineAssistantCount = (await assistantMessages(currentJob)).length;
    await log(`Assistant response count before send: ${baselineAssistantCount}`);
    await clickSend(currentJob, baselineAssistantCount);
    await log(`Send accepted; waiting ${POST_SEND_SETTLE_MS}ms after send to avoid streaming interruption`);
    await sleep(POST_SEND_SETTLE_MS);

    const observedChatUrl = isGrokJob(currentJob)
      ? stripQuery(await currentUrl(currentJob))
      : await waitForStableChatUrl(currentJob, currentJob.chatUrl);
    const observedConversationId = parseConversationId(observedChatUrl) || currentJob.conversationId;
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
      const stableGrokConversationId = parseConversationId(stableGrokChatUrl);
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
    await secureWriteText(currentJob.responsePath, `${responseText}\n`);
    currentJob = await mutateJob((job) => transitionOracleJobPhase(job, "downloading_artifacts", {
      at: new Date().toISOString(),
      source: "oracle:worker",
      message: "Downloading any response artifacts.",
      patch: { heartbeatAt: new Date().toISOString() },
    }));
    const artifacts = await downloadArtifacts(currentJob, completion.responseIndex, responseText);
    const artifactFailureCount = artifacts.filter((artifact) => artifact.unconfirmed || artifact.error).length;
    const finalPhase = artifactFailureCount > 0 ? "complete_with_artifact_errors" : "complete";

    currentJob = await mutateJob((job) => transitionOracleJobPhase(job, finalPhase, {
      at: new Date().toISOString(),
      source: "oracle:worker",
      message: artifactFailureCount > 0
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
  } catch (error) {
    if (!shuttingDown) {
      const message = error instanceof Error ? error.message : String(error);
      await captureDiagnostics(currentJob, "failure");
      await log(`Job failed: ${message}`);
      currentJob = await mutateJob((job) => transitionOracleJobPhase(job, "failed", {
        at: new Date().toISOString(),
        source: "oracle:worker",
        message: `Job failed: ${message}`,
        patch: {
          error: message,
          cleanupPending: true,
        },
      }));
      process.exitCode = 1;
    }
  } finally {
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

await run();
