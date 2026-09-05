// @rust-exception rationale: pi-oracle sanity coverage imports TypeScript extension modules directly; rewriting this harness in Rust would block exercising the platform-native Pi extension surface.
// Purpose: Run local regression checks for the pi oracle extension.
// Responsibilities: Exercise config, locking, queueing, worker, tool schema, and documentation contracts without remote CI.
// Scope: Sanity-test orchestration only; production behavior remains in extensions/oracle and prompts/docs.
// Usage: Invoked by npm run sanity:oracle through scripts/oracle-sanity-runner.mjs.
// Invariants/Assumptions: Tests run from the repository root with local development dependencies installed.
import { createCipheriv, createHash, pbkdf2Sync, randomBytes, randomUUID } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { basename, delimiter, dirname, join } from "node:path";
import { ProjectTrustStore, SessionManager, type SessionEntry } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage } from "@earendil-works/pi-ai/compat";
import { Check } from "typebox/value";
import {
  coerceOracleSubmitPresetId,
  DEFAULT_CONFIG,
  formatOracleAuthConfigRemediation,
  formatOracleAuthConfigSummary,
  getOracleConfigLoadDetails,
  loadOracleConfig,
  ORACLE_SUBMIT_PRESETS,
  resolveOracleArchiveFormat,
  resolveOracleConfigForProvider,
  resolveOracleGrokMode,
  resolveOracleSubmitPreset,
  type OracleConfig,
  type OracleSubmitPresetId,
} from "../extensions/oracle/lib/config.ts";
import { ensureAccountCookie, filterImportableAuthCookies, type ImportedAuthCookie } from "../extensions/oracle/worker/auth-cookie-policy.mjs";
import { getCookiesFromConfiguredChromiumSource } from "../extensions/oracle/worker/chromium-cookie-source.mjs";
import { extractArtifactLabels, filterStructuralArtifactCandidates, parseSnapshotEntries, partitionStructuralArtifactCandidates } from "../extensions/oracle/worker/artifact-heuristics.mjs";
import {
  buildAllowedChatGptOrigins,
  buildAssistantCompletionSignature,
  deriveAssistantCompletionSignature,
  effortSelectionVisible,
  matchesCompactIntelligenceControlLabel,
  matchesCompactIntelligenceOpenerLabel,
  matchesRequestedModelControlLabel,
  snapshotCanSafelySkipModelConfiguration,
  snapshotHasClosedCompactSelection,
  snapshotHasModelConfigurationUi,
  snapshotHasModelOpener,
  snapshotHasUsableComposerControls,
  snapshotStronglyMatchesRequestedModel,
  snapshotWeaklyMatchesRequestedModel,
  stripChatGptResponseChrome,
} from "../extensions/oracle/worker/chatgpt-ui-helpers.mjs";
import { buildAccountChooserCandidateLabels, classifyChatAuthPage, normalizeLoginProbeResult } from "../extensions/oracle/worker/auth-flow-helpers.mjs";
import { assistantSnapshotSlice, conversationIdFromUrl, isConversationPathUrl, nextStableValueState, providerSendAccepted, resolveStableConversationUrlCandidate, stripUrlQueryAndHash } from "../extensions/oracle/worker/chatgpt-flow-helpers.mjs";
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
import {
  browserUserDataDirsForPlatform,
  chromiumKeychainSupportedOnPlatform,
  defaultCloneStrategyForPlatform,
  detectDefaultBrowserProfileSource,
  detectDefaultLinuxChromeExecutablePath,
  knownBrowserUserDataPathMatch,
  knownBrowserUserDataPathMatchDetails,
  scrubSweetCookieSafeStoragePasswordEnv,
  sweetCookieSafeStoragePasswordScrubbedEnv,
} from "../extensions/oracle/shared/browser-profile-helpers.mjs";
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
  getOracleJobsDir,
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
import { createArchiveForTesting, mergeArchiveEntryGroupsForTesting, resolveExpandedArchiveEntries } from "../extensions/oracle/lib/archive.ts";
import { getQueueAdmissionFailure, getQueuedArchivePressure, registerOracleTools, resolveChatGptConversationReference } from "../extensions/oracle/lib/tools.ts";
import { registerOracleCommands } from "../extensions/oracle/lib/commands.ts";
import oracleExtension from "../extensions/oracle/index.ts";
import { runPollerSanitySuite } from "./oracle-sanity-poller-suite.ts";
import { createCommandCtx, createExtensionCtx, createPiHarness, removeDirRobust, resetOracleStateDir } from "./oracle-sanity-support.ts";

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

function listArchiveEntries(archivePath: string): string[] {
  if (process.platform === "win32") {
    const args = archivePath.endsWith(".tar.gz")
      ? ["-tzf", basename(archivePath)]
      : ["--zstd", "-tf", basename(archivePath)];
    return execFileSync("tar.exe", args, { cwd: dirname(archivePath), encoding: "utf8" }).split(/\r?\n/).filter(Boolean);
  }
  const command = archivePath.endsWith(".tar.gz")
    ? `tar -tzf ${shellQuote(archivePath)}`
    : `zstd -dc ${shellQuote(archivePath)} | tar -tf -`;
  return execFileSync("sh", ["-c", command], { encoding: "utf8" }).split(/\r?\n/).filter(Boolean);
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

async function testBrowserProfileHelpers(): Promise<void> {
  assert(defaultCloneStrategyForPlatform("darwin") === "apfs-clone", "darwin should default to APFS clone profile copies");
  assert(defaultCloneStrategyForPlatform("linux") === "copy", "linux should default to ordinary recursive profile copies");
  assert(chromiumKeychainSupportedOnPlatform("darwin"), "macOS should support configured Chromium Keychain cookie sources");
  assert(!chromiumKeychainSupportedOnPlatform("linux"), "Linux should reject macOS Keychain cookie-source config");

  const fixtureDir = await mkdtemp(join(tmpdir(), "oracle-browser-profile-helpers-"));
  const xdgConfigHome = join(fixtureDir, "xdg");
  const fakeHome = join(fixtureDir, "home");
  const helperEnv = { XDG_CONFIG_HOME: xdgConfigHome } as NodeJS.ProcessEnv;
  try {
    const macSafetyDirs = browserUserDataDirsForPlatform("darwin", { homeDir: fakeHome });
    assert(macSafetyDirs.includes(join(fakeHome, "Library", "Application Support", "Google", "Chrome")), "macOS safety roots should include Google Chrome");
    assert(macSafetyDirs.includes(join(fakeHome, "Library", "Application Support", "BraveSoftware", "Brave-Browser")), "macOS safety roots should include Brave");
    assert(macSafetyDirs.includes(join(fakeHome, "Library", "Application Support", "Microsoft Edge")), "macOS safety roots should include Edge even though Edge cookies are not an auth backend");
    const windowsSafetyDirs = browserUserDataDirsForPlatform("win32", { homeDir: fakeHome });
    assert(windowsSafetyDirs.includes(join(fakeHome, "AppData", "Local", "Google", "Chrome", "User Data")), "Windows safety roots should include Google Chrome user data");
    assert(knownBrowserUserDataPathMatch(join(fakeHome, "AppData", "Local", "Google", "Chrome", "User Data", "Profile 1"), { platform: "win32", homeDir: fakeHome }), "Windows safety checks should block runtime profiles inside Chrome user data");

    const cookieImportDirs = browserUserDataDirsForPlatform("linux", { env: helperEnv, homeDir: fakeHome, includeUnsupported: false });
    assert(cookieImportDirs.includes(join(xdgConfigHome, "google-chrome")), "linux cookie-import roots should include Google Chrome");
    assert(cookieImportDirs.includes(join(xdgConfigHome, "chromium")), "linux cookie-import roots should include Chromium");
    assert(!cookieImportDirs.includes(join(xdgConfigHome, "microsoft-edge")), "linux cookie-import roots should not imply Edge backend support");
    const safetyDirs = browserUserDataDirsForPlatform("linux", { env: helperEnv, homeDir: fakeHome });
    assert(safetyDirs.includes(join(xdgConfigHome, "microsoft-edge")), "linux safety roots should still protect Edge user-data directories from destructive profile use");

    const chromiumProfile = join(xdgConfigHome, "chromium", "Profile 7");
    await mkdir(chromiumProfile, { recursive: true, mode: 0o700 });
    await writeFile(join(xdgConfigHome, "chromium", "Local State"), `${JSON.stringify({ profile: { last_used: "Profile 7" } })}\n`, { encoding: "utf8", mode: 0o600 });
    assert(
      detectDefaultBrowserProfileSource("linux", { env: helperEnv, homeDir: fakeHome }) === chromiumProfile,
      "linux default cookie source should resolve non-Google Chromium profiles to absolute paths for Sweet Cookie's chrome backend",
    );

    await writeFile(join(xdgConfigHome, "chromium", "Local State"), `${JSON.stringify({ profile: { last_used: "Missing Profile" } })}\n`, { encoding: "utf8", mode: 0o600 });
    await mkdir(join(xdgConfigHome, "chromium", "Default"), { recursive: true, mode: 0o700 });
    assert(
      detectDefaultBrowserProfileSource("linux", { env: helperEnv, homeDir: fakeHome }) === join(xdgConfigHome, "chromium", "Default"),
      "linux default cookie source should fall back to Default when Local State's last_used profile is stale",
    );

    await writeFile(join(xdgConfigHome, "chromium", "Local State"), `${JSON.stringify({ profile: { last_used: "../escape" } })}\n`, { encoding: "utf8", mode: 0o600 });
    assert(
      detectDefaultBrowserProfileSource("linux", { env: helperEnv, homeDir: fakeHome }) === join(xdgConfigHome, "chromium", "Default"),
      "linux default cookie source should ignore traversal-like Local State profile names",
    );

    const firstBinDir = join(fixtureDir, "bin-first");
    const secondBinDir = join(fixtureDir, "bin-second");
    await mkdir(join(firstBinDir, "google-chrome"), { recursive: true, mode: 0o700 });
    await mkdir(secondBinDir, { recursive: true, mode: 0o700 });
    const chromiumBin = join(secondBinDir, "chromium");
    await writeExecutableScript(chromiumBin, "#!/bin/sh\nprintf 'Chromium 1.2.3.4\\n'\n");
    assert(
      detectDefaultLinuxChromeExecutablePath({ pathValue: `${firstBinDir}${delimiter}${secondBinDir}` }) === chromiumBin,
      "linux executable autodetection should skip directories/non-executables and continue to later PATH candidates",
    );

    await mkdir(join(xdgConfigHome, "google-chrome", "Default"), { recursive: true, mode: 0o700 });
    const configHomeLink = join(fixtureDir, "config-link");
    await symlink(xdgConfigHome, configHomeLink, "dir");
    const symlinkedBrowserProfile = join(configHomeLink, "google-chrome", "Default");
    const matchedRoot = knownBrowserUserDataPathMatch(symlinkedBrowserProfile, { platform: "linux", env: helperEnv, homeDir: fakeHome });
    const resolvedGoogleChromeRoot = await realpath(join(xdgConfigHome, "google-chrome"));
    assert(matchedRoot === resolvedGoogleChromeRoot, "browser profile safety checks should resolve symlinked ancestors before destructive profile use");

    const customCookieDb = join(fixtureDir, "CustomBrowser", "Profile 1", "Network", "Cookies");
    const protectedCustomProfile = knownBrowserUserDataPathMatch(join(fixtureDir, "CustomBrowser", "Profile 1", "oracle-seed"), {
      platform: "linux",
      env: helperEnv,
      homeDir: fakeHome,
      cookieSources: { chromeCookiePath: customCookieDb },
    });
    assert(protectedCustomProfile === join(fixtureDir, "CustomBrowser", "Profile 1"), "cookie DB config should protect its containing custom browser profile directory");
    const protectedCustomRoot = knownBrowserUserDataPathMatch(join(fixtureDir, "CustomBrowser", "oracle-runtime"), {
      platform: "linux",
      env: helperEnv,
      homeDir: fakeHome,
      cookieSources: { chromeCookiePath: customCookieDb },
    });
    assert(protectedCustomRoot === join(fixtureDir, "CustomBrowser"), "cookie DB config should protect the likely custom browser user-data root");
    const protectedCustomRootDetails = knownBrowserUserDataPathMatchDetails(join(fixtureDir, "CustomBrowser", "oracle-runtime"), {
      platform: "linux",
      env: helperEnv,
      homeDir: fakeHome,
      cookieSources: { chromeCookiePath: customCookieDb },
    });
    assert(
      protectedCustomRootDetails?.source === "auth.chromeCookiePath" && protectedCustomRootDetails.configuredPath === customCookieDb,
      "cookie DB safety matches should report the config source that made a custom root protected",
    );

    const passwordEnv = {
      SWEET_COOKIE_CHROME_SAFE_STORAGE_PASSWORD: "chrome-secret",
      SWEET_COOKIE_BRAVE_SAFE_STORAGE_PASSWORD: "brave-secret",
      KEEP_ME: "yes",
    } as NodeJS.ProcessEnv;
    const scrubbedChildEnv = sweetCookieSafeStoragePasswordScrubbedEnv(passwordEnv);
    assert(passwordEnv.SWEET_COOKIE_CHROME_SAFE_STORAGE_PASSWORD === "chrome-secret", "child-env scrubbing should not mutate the original env object");
    assert(scrubbedChildEnv.SWEET_COOKIE_CHROME_SAFE_STORAGE_PASSWORD === undefined, "child env should omit Chrome safe-storage passwords");
    assert(scrubbedChildEnv.SWEET_COOKIE_BRAVE_SAFE_STORAGE_PASSWORD === undefined, "child env should omit Brave safe-storage passwords");
    assert(scrubbedChildEnv.KEEP_ME === "yes", "child env scrubbing should preserve unrelated environment variables");
    scrubSweetCookieSafeStoragePasswordEnv(passwordEnv);
    assert(passwordEnv.SWEET_COOKIE_CHROME_SAFE_STORAGE_PASSWORD === undefined, "in-process scrubbing should remove Chrome safe-storage passwords after cookie import");
    assert(passwordEnv.KEEP_ME === "yes", "in-process scrubbing should preserve unrelated environment variables");
  } finally {
    await rm(fixtureDir, { recursive: true, force: true });
  }
}

function readProcessStartedAt(pid: number | undefined): string | undefined {
  if (!pid || pid <= 0) return undefined;
  try {
    if (process.platform === "win32") {
      const startedAt = execFileSync("powershell.exe", [
        "-NoLogo",
        "-NoProfile",
        "-Command",
        `$p = Get-Process -Id ${Number(pid)} -ErrorAction SilentlyContinue; if ($p) { $p.StartTime.ToUniversalTime().ToString('o') }`,
      ], { encoding: "utf8" }).trim();
      return startedAt || undefined;
    }
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

async function waitForPath(path: string, timeoutMs = 2_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await pathExists(path)) return true;
    await sleep(50);
  }
  return pathExists(path);
}

function hashedOracleStatePath(kind: string, key: string, rootDir: string): string {
  return join(rootDir, `${kind}-${createHash("sha256").update(key).digest("hex").slice(0, 24)}`);
}

function assertIsolatedSanityEnvironment(): void {
  const jobsEnv = process.env.PI_ORACLE_JOBS_DIR?.trim();
  const stateEnv = process.env.PI_ORACLE_STATE_DIR?.trim();
  const jobsDir = getOracleJobsDir();
  const stateDir = getOracleStateDir();
  if (!jobsEnv || !stateEnv || jobsDir === "/tmp" || stateDir === "/tmp/pi-oracle-state") {
    throw new Error(
      "Refusing to run oracle sanity checks without isolated PI_ORACLE_STATE_DIR and PI_ORACLE_JOBS_DIR. " +
      "Use `npm run sanity:oracle` so scripts/oracle-sanity-runner.mjs creates private temp dirs.",
    );
  }
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
  await removeDirRobust(getJobDir(id));
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
  assert(created.extensionProvenance?.schemaVersion === 1, "created oracle jobs should record extension provenance for release proof");
  assert(created.extensionProvenance?.packageName === "pi-oracle", "extension provenance should record the package name");
  assert(created.extensionProvenance?.sourcePath.endsWith("pi-oracle"), "extension provenance should record the loaded extension source root");
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
    mode: "tui" as const,
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

async function waitForJobState(
  jobId: string,
  predicate: (job: NonNullable<ReturnType<typeof readJob>>) => boolean,
  timeoutMs = 5_000,
): Promise<NonNullable<ReturnType<typeof readJob>>> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const job = readJob(jobId);
    if (job && predicate(job)) return job;
    await sleep(50);
  }

  const last = readJob(jobId);
  if (last && predicate(last)) return last;
  throw new Error(`Timed out waiting for oracle job ${jobId} to reach the expected state`);
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
  assert(!recoveredJob?.cleanupWarnings?.length, `cleanup-pending recovery should clear resolved cleanup warnings, saw ${recoveredJob?.cleanupWarnings?.join(" | ") ?? "<none>"}`);
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
  if (process.platform !== "darwin") return;
  const fixtureDir = await mkdtemp(join(tmpdir(), "oracle-clone-timeout-"));
  const binDir = await mkdtemp(join(tmpdir(), "oracle-clone-bin-"));
  const seedDir = join(fixtureDir, "seed");
  const runtimeProfileDir = join(fixtureDir, "runtime", "profile");
  const cpPidPath = join(binDir, "cp.pid");
  const originalPath = process.env.PATH ?? "";
  const originalCpPath = process.env.PI_ORACLE_CP_PATH;
  const cloneConfig: OracleConfig = {
    ...config,
    browser: {
      ...config.browser,
      authSeedProfileDir: seedDir,
      runtimeProfilesDir: join(fixtureDir, "runtime"),
      cloneStrategy: "apfs-clone",
    },
  };

  try {
    await mkdir(seedDir, { recursive: true, mode: 0o700 });
    await writeFile(join(seedDir, "Preferences"), "{}\n", { mode: 0o600 });
    await writeFile(join(seedDir, ".oracle-seed-generation"), `${new Date().toISOString()}\n`, { mode: 0o600 });
    await writeExecutableScript(
      join(binDir, "cp"),
      `#!/bin/sh
printf '%s\\n' "$$" > ${shellQuote(cpPidPath)}
trap 'exit 0' TERM INT
while :; do sleep 1; done
`,
    );
    process.env.PATH = `${binDir}${delimiter}${originalPath}`;

    await assertRejects(
      () => cloneSeedProfileToRuntime(cloneConfig, runtimeProfileDir, { cpTimeoutMs: 5_000 }),
      "runtime profile cloning should time out when cp hangs",
      "timed out",
    );

    const cpPid = Number.parseInt((await readFile(cpPidPath, "utf8")).trim(), 10);
    assert(Number.isFinite(cpPid), "clone timeout test should record a cp pid");
    assert(await waitForPidExit(cpPid), "runtime profile cloning timeout should terminate the hung cp process");
  } finally {
    process.env.PATH = originalPath;
    if (originalCpPath === undefined) delete process.env.PI_ORACLE_CP_PATH;
    else process.env.PI_ORACLE_CP_PATH = originalCpPath;
    await rm(fixtureDir, { recursive: true, force: true });
    await rm(binDir, { recursive: true, force: true });
  }
}

async function testAuthBootstrapAgentBrowserTimeoutFailsFast(config: OracleConfig): Promise<void> {
  const fixtureDir = await mkdtemp(join(tmpdir(), "oracle-auth-timeout-"));
  const agentBrowserPath = process.platform === "win32" ? join(fixtureDir, "agent-browser.cmd") : join(fixtureDir, "agent-browser");
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
    if (process.platform === "win32") {
      await writeFile(agentBrowserPath, `@echo off\r\npowershell.exe -NoLogo -NoProfile -Command "$PID | Out-File -Encoding ascii '${browserPidPath.replaceAll("'", "''")}'; while ($true) { Start-Sleep -Seconds 1 }"\r\n`, { encoding: "utf8", mode: 0o700 });
    } else {
      await writeExecutableScript(
        agentBrowserPath,
        `#!/bin/sh
printf '%s\\n' "$$" > ${shellQuote(browserPidPath)}
trap 'exit 0' TERM INT
while :; do sleep 1; done
`,
      );
    }

    const result = await runProcess(
      process.execPath,
      [join(process.cwd(), "extensions/oracle/worker/auth-bootstrap.mjs"), JSON.stringify(authConfig)],
      {
        env: {
          ...process.env,
          AGENT_BROWSER_PATH: agentBrowserPath,
          PI_ORACLE_STATE_DIR: join(fixtureDir, "state"),
          PI_ORACLE_AUTH_AGENT_BROWSER_TIMEOUT_MS: "5000",
          PI_ORACLE_AUTH_CLOSE_TIMEOUT_MS: "5000",
          PI_ORACLE_AUTH_KILL_GRACE_MS: "500",
        },
        timeoutMs: 30_000,
      },
    );

    assert(!result.timedOut, "auth bootstrap should not hang when agent-browser close stalls");
    assert(result.code !== 0, "auth bootstrap timeout smoke test should still fail because source cookies are unavailable");
    if (await waitForPath(browserPidPath)) {
      const browserPid = Number.parseInt((await readFile(browserPidPath, "utf8")).trim(), 10);
      assert(Number.isFinite(browserPid), "auth bootstrap timeout test should record an agent-browser pid");
      assert(await waitForPidExit(browserPid), "auth bootstrap should terminate the hung agent-browser process after timing out");
    }
  } finally {
    await rm(fixtureDir, { recursive: true, force: true });
  }
}

async function testConfigRejectsPartialChromiumKeychain(): Promise<void> {
  const fixtureDir = await mkdtemp(join(tmpdir(), "oracle-chromium-config-"));
  const agentExtensionsDir = join(fixtureDir, "agent", "extensions");
  const originalAgentDir = process.env.PI_CODING_AGENT_DIR;

  try {
    await mkdir(agentExtensionsDir, { recursive: true, mode: 0o700 });
    process.env.PI_CODING_AGENT_DIR = join(fixtureDir, "agent");

    await writeFile(join(agentExtensionsDir, "oracle.json"), `${JSON.stringify({
      auth: {
        chromiumKeychain: {
          account: "Helium",
          services: ["Helium Storage Key"],
        },
      },
    }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    assertThrows(() => loadOracleConfig(process.cwd()), "config should reject chromiumKeychain without chromeCookiePath to avoid silently falling back to another browser source", "auth.chromiumKeychain requires auth.chromeCookiePath");

    await writeFile(join(agentExtensionsDir, "oracle.json"), `${JSON.stringify({
      auth: {
        chromeCookiePath: join(fixtureDir, "Chromium", "Default", "Cookies"),
        chromiumKeychain: {
          account: "Helium",
          services: [],
        },
      },
    }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    assertThrows(() => loadOracleConfig(process.cwd()), "config should reject empty Chromium keychain services", "auth.chromiumKeychain.services must include at least one service name");
  } finally {
    if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
    await rm(fixtureDir, { recursive: true, force: true });
  }
}

async function testConfigRejectsChromiumKeychainOffMac(): Promise<void> {
  if (process.platform === "darwin") return;

  const fixtureDir = await mkdtemp(join(tmpdir(), "oracle-chromium-platform-config-"));
  const agentExtensionsDir = join(fixtureDir, "agent", "extensions");
  const originalAgentDir = process.env.PI_CODING_AGENT_DIR;

  try {
    await mkdir(agentExtensionsDir, { recursive: true, mode: 0o700 });
    process.env.PI_CODING_AGENT_DIR = join(fixtureDir, "agent");
    await writeFile(join(agentExtensionsDir, "oracle.json"), `${JSON.stringify({
      auth: {
        chromeCookiePath: join(fixtureDir, "Chromium", "Default", "Cookies"),
        chromiumKeychain: {
          account: "Helium",
          services: ["Helium Storage Key"],
        },
      },
    }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });

    assertThrows(
      () => loadOracleConfig(process.cwd()),
      "config should reject macOS Keychain cookie-source config on non-macOS platforms",
      "auth.chromiumKeychain is macOS-only",
    );
  } finally {
    if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
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
    const configLoad = getOracleConfigLoadDetails(projectDir, { projectConfigTrusted: true });
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
    assert(result.stderr.includes("Oracle auth failed."), "auth bootstrap failure guidance should start with a compact failure summary");
    assert(result.stderr.includes("Likely causes:"), "auth bootstrap failure guidance should include scannable likely causes");
    assert(result.stderr.includes("Next:"), "auth bootstrap failure guidance should include concrete next steps");
    assert(result.stderr.includes(configLoad.effectiveAuthConfigPath), "auth bootstrap failure guidance should point at the effective agent config path for the active PI_CODING_AGENT_DIR");
    assert(result.stderr.includes(configLoad.projectConfigPath), "auth bootstrap failure guidance should mention the loaded project config path when one is present");
    assert(result.stderr.includes("auth.* still comes from"), "auth bootstrap failure guidance should explain that auth settings still come from the agent config when a project config also exists");
    assert(result.stderr.includes("auth.chromeProfile") && result.stderr.includes("auth.chromeCookiePath"), "auth bootstrap failure guidance should mention configurable browser cookie sources");
    assert(!result.stderr.includes("~/.pi/agent/extensions/oracle.json"), "auth bootstrap failure guidance should not hardcode the default global config path under isolated agent dirs");
  } finally {
    if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
    await rm(fixtureDir, { recursive: true, force: true });
  }
}

async function testProjectConfigRespectsExplicitProjectDistrust(): Promise<void> {
  const fixtureDir = await mkdtemp(join(tmpdir(), `oracle-project-trust-${randomUUID()}-`));
  const projectDir = join(fixtureDir, "project");
  const agentDir = join(fixtureDir, "agent");
  const projectExtensionsDir = join(projectDir, ".pi", "extensions");
  const projectSubdir = join(projectDir, "packages", "app");
  const originalAgentDir = process.env.PI_CODING_AGENT_DIR;

  try {
    await mkdir(projectExtensionsDir, { recursive: true, mode: 0o700 });
    await mkdir(projectSubdir, { recursive: true, mode: 0o700 });
    await mkdir(join(agentDir, "extensions"), { recursive: true, mode: 0o700 });
    await writeFile(join(projectExtensionsDir, "oracle.json"), `${JSON.stringify({ defaults: { preset: "thinking_light" } }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    process.env.PI_CODING_AGENT_DIR = agentDir;

    const untrustedDetails = getOracleConfigLoadDetails(projectDir);
    assert(untrustedDetails.projectConfigExists, "project trust test should create a project oracle config");
    assert(untrustedDetails.projectConfigLoaded, "oracle should preserve historical project config loading when there is no explicit saved distrust decision");
    assert(loadOracleConfig(projectDir).defaults.preset === "thinking_light", "project oracle config should override defaults by default for compatibility");
    assert(getOracleConfigLoadDetails(projectSubdir).projectConfigLoaded, "project oracle config should load from subdirectories by default for compatibility");

    new ProjectTrustStore(agentDir).set(projectDir, false);
    const distrustedDetails = getOracleConfigLoadDetails(projectDir);
    assert(!distrustedDetails.projectConfigLoaded, "saved pi project distrust should suppress project oracle config loading");
    assert(loadOracleConfig(projectDir).defaults.preset === DEFAULT_CONFIG.defaults.preset, "explicitly distrusted project oracle config should not override defaults");
    assert(loadOracleConfig(projectSubdir).defaults.preset === DEFAULT_CONFIG.defaults.preset, "explicitly distrusted project oracle config should not load from subdirectories");
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
  registerOracleTools(pi as unknown as import("@earendil-works/pi-coding-agent").ExtensionAPI, fakeWorkerPath);
  const preflightTool = pi.tools.get("oracle_preflight");
  assert(preflightTool?.execute, "oracle preflight tool should register for readiness testing");

  const sessionFile = `/tmp/oracle-sanity-session-oracle-preflight-${randomUUID()}.jsonl`;
  const persistedCtx = createExtensionCtx({ getSessionFile: () => sessionFile } as import("@earendil-works/pi-coding-agent").ExtensionContext["sessionManager"], createUiStub());
  const noSessionCtx = createExtensionCtx({ getSessionFile: () => undefined } as import("@earendil-works/pi-coding-agent").ExtensionContext["sessionManager"], createUiStub());
  const defaultSeedDir = join(agentExtensionsDir, "oracle-auth-seed-profile");
  const grokSeedDir = `${defaultSeedDir}-grok`;
  const configPath = join(agentExtensionsDir, "oracle.json");

  try {
    process.env.PI_CODING_AGENT_DIR = agentDir;
    await writeFile(configPath, `${JSON.stringify({ browser: { authSeedProfileDir: defaultSeedDir } }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });

    const noSessionResult = await preflightTool.execute!("oracle-preflight-no-session", {}, undefined, () => { }, noSessionCtx) as { details?: unknown };
    const noSessionDetails = asRecord(noSessionResult.details);
    const noSessionError = asRecord(noSessionDetails?.error);
    assert(noSessionDetails?.ready === false, "oracle preflight should report ready=false when the session is not persisted");
    assert(noSessionError?.code === "persisted_session_required", "oracle preflight should surface persisted_session_required for no-session contexts");

    const missingSeedResult = await preflightTool.execute!("oracle-preflight-missing-seed", {}, undefined, () => { }, persistedCtx) as { content?: unknown; details?: unknown };
    const missingSeedText = String(asRecord(Array.isArray(missingSeedResult.content) ? missingSeedResult.content[0] : undefined)?.text ?? "");
    const missingSeedDetails = asRecord(missingSeedResult.details);
    const missingSeedError = asRecord(missingSeedDetails?.error);
    const missingSeedAuth = asRecord(missingSeedDetails?.auth);
    assert(missingSeedDetails?.ready === false, "oracle preflight should report ready=false when the auth seed is missing");
    assert(missingSeedError?.code === "auth_seed_profile_missing", "oracle preflight should surface auth_seed_profile_missing when the seed dir is absent");
    assert(missingSeedAuth?.seedProfileDir === defaultSeedDir, "oracle preflight should report the configured auth seed path");
    assert(missingSeedText.includes("Preflight checks the persisted pi session, local oracle config, and ChatGPT auth seed"), "blocked oracle preflight text should explain what readiness covers before archive work starts");

    await writeFile(configPath, `${JSON.stringify({ defaults: { provider: "grok" }, browser: { authSeedProfileDir: defaultSeedDir } }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    const grokDefaultConfig = loadOracleConfig(process.cwd(), { projectConfigTrusted: true });
    assert(resolveOracleConfigForProvider(grokDefaultConfig, "chatgpt").defaults.provider === "chatgpt", "explicit ChatGPT selection should produce a self-consistent ChatGPT config even when the configured default is Grok");
    const missingGrokSeedResult = await preflightTool.execute!("oracle-preflight-missing-grok-seed", {}, undefined, () => { }, persistedCtx) as { content?: unknown; details?: unknown };
    const missingGrokSeedText = String(asRecord(Array.isArray(missingGrokSeedResult.content) ? missingGrokSeedResult.content[0] : undefined)?.text ?? "");
    const missingGrokSeedDetails = asRecord(missingGrokSeedResult.details);
    const missingGrokSeedAuth = asRecord(missingGrokSeedDetails?.auth);
    assert(missingGrokSeedDetails?.ready === false && missingGrokSeedDetails?.provider === "grok", "oracle preflight should use the configured Grok default provider");
    assert(missingGrokSeedAuth?.seedProfileDir === grokSeedDir, "oracle preflight should check the Grok-specific auth seed path when Grok is selected");
    assert(missingGrokSeedText.includes("Grok auth seed"), "oracle preflight text should name the selected provider auth seed");

    await mkdir(grokSeedDir, { recursive: true, mode: 0o700 });
    const unauthenticatedGrokResult = await preflightTool.execute!("oracle-preflight-grok-unauthenticated", {}, undefined, () => { }, persistedCtx) as { details?: unknown };
    const unauthenticatedGrokDetails = asRecord(unauthenticatedGrokResult.details);
    const unauthenticatedGrokError = asRecord(unauthenticatedGrokDetails?.error);
    assert(unauthenticatedGrokDetails?.ready === false, "oracle preflight should block an auth seed directory without a verified seed-generation marker");
    assert(unauthenticatedGrokError?.code === "auth_seed_profile_unauthenticated", "oracle preflight should classify unverified seed directories as unauthenticated");
    await writeFile(join(grokSeedDir, ".oracle-seed-generation"), `${new Date().toISOString()}\n`, { mode: 0o600 });
    const readyGrokResult = await preflightTool.execute!("oracle-preflight-grok-ready", {}, undefined, () => { }, persistedCtx) as { details?: unknown };
    const readyGrokDetails = asRecord(readyGrokResult.details);
    const readyGrokAuth = asRecord(readyGrokDetails?.auth);
    assert(readyGrokDetails?.ready === true && readyGrokDetails?.provider === "grok", `oracle preflight should pass when the selected Grok auth seed is ready: ${JSON.stringify(readyGrokDetails)}`);
    assert(readyGrokAuth?.seedProfileDir === grokSeedDir, "oracle preflight ready details should report the selected Grok auth seed path");

    const originalNoZstdPath = process.env.PATH;
    const fakeBinDir = join(fixtureDir, "fake-bin-no-zstd");
    await mkdir(fakeBinDir, { recursive: true, mode: 0o700 });
    const fakeCommandSuffix = process.platform === "win32" ? ".cmd" : "";
    const fakeCommandBody = process.platform === "win32" ? "@echo off\r\nexit /b 0\r\n" : "#!/bin/sh\nexit 0\n";
    await writeExecutableScript(join(fakeBinDir, `tar${fakeCommandSuffix}`), fakeCommandBody);
    await writeExecutableScript(join(fakeBinDir, `agent-browser${fakeCommandSuffix}`), fakeCommandBody);
    await mkdir(defaultSeedDir, { recursive: true, mode: 0o700 });
    await writeFile(join(defaultSeedDir, ".oracle-seed-generation"), `${new Date().toISOString()}\n`, { mode: 0o600 });
    await writeFile(configPath, `${JSON.stringify({ defaults: { provider: "grok" }, browser: { authSeedProfileDir: defaultSeedDir, cloneStrategy: "copy" } }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    try {
      process.env.PATH = fakeBinDir;
      const grokNoZstdResult = await preflightTool.execute!("oracle-preflight-grok-no-zstd", {}, undefined, () => { }, persistedCtx) as { details?: unknown };
      assert(asRecord(grokNoZstdResult.details)?.ready === true, "Grok preflight should not require local zstd because Grok archives use tar.gz");
      const chatGptNoZstdResult = await preflightTool.execute!("oracle-preflight-explicit-chatgpt-no-zstd", { provider: "chatgpt" }, undefined, () => { }, persistedCtx) as { details?: unknown };
      const chatGptNoZstdError = asRecord(asRecord(chatGptNoZstdResult.details)?.error);
      assert(chatGptNoZstdError?.code === "local_dependency_missing" && chatGptNoZstdError?.rejectedValue === "zstd", "explicit ChatGPT preflight should require zstd even when the configured default provider is Grok");
    } finally {
      if (originalNoZstdPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalNoZstdPath;
    }

    await writeFile(configPath, `${JSON.stringify({ browser: { authSeedProfileDir: defaultSeedDir } }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await mkdir(defaultSeedDir, { recursive: true, mode: 0o700 });
    await writeFile(join(defaultSeedDir, ".oracle-seed-generation"), `${new Date().toISOString()}\n`, { mode: 0o600 });
    const readyResult = await preflightTool.execute!("oracle-preflight-ready", {}, undefined, () => { }, persistedCtx) as { content?: unknown; details?: unknown };
    const readyText = String(asRecord(Array.isArray(readyResult.content) ? readyResult.content[0] : undefined)?.text ?? "");
    const readyDetails = asRecord(readyResult.details);
    const readyAuth = asRecord(readyDetails?.auth);
    assert(readyDetails?.ready === true, "oracle preflight should report ready=true once persisted session and auth seed prerequisites are satisfied");
    assert(readyAuth?.ready === true && readyAuth?.seedProfileDir === defaultSeedDir, "oracle preflight should report the ready auth seed path");
    assert(readyText.includes("Preflight validates the persisted pi session, local oracle config, and ChatGPT auth seed created by oracle_auth"), "ready oracle preflight text should explain why oracle_auth matters");

    const missingExecutablePath = join(fixtureDir, "missing-chrome");
    await writeFile(configPath, `${JSON.stringify({ browser: { authSeedProfileDir: defaultSeedDir, executablePath: missingExecutablePath } }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    const missingExecutableResult = await preflightTool.execute!("oracle-preflight-missing-executable", {}, undefined, () => { }, persistedCtx) as { details?: unknown };
    const missingExecutableDetails = asRecord(missingExecutableResult.details);
    const missingExecutableError = asRecord(missingExecutableDetails?.error);
    const missingExecutableAuth = asRecord(missingExecutableDetails?.auth);
    assert(missingExecutableDetails?.ready === false, "oracle preflight should report ready=false when a configured browser executable is missing");
    assert(missingExecutableError?.code === "browser_executable_missing", "oracle preflight should surface browser_executable_missing for a missing configured browser path");
    assert(missingExecutableAuth?.ready === true && missingExecutableAuth?.seedProfileDir === defaultSeedDir, "oracle preflight should keep auth marked ready when a later deterministic prerequisite blocks submission");

    if (process.platform !== "win32") {
      const nonExecutablePath = join(fixtureDir, "non-executable-chrome");
      await writeFile(nonExecutablePath, "not executable\n", { encoding: "utf8", mode: 0o600 });
      await writeFile(configPath, `${JSON.stringify({ browser: { authSeedProfileDir: defaultSeedDir, executablePath: nonExecutablePath } }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
      const nonExecutableResult = await preflightTool.execute!("oracle-preflight-non-executable-browser", {}, undefined, () => { }, persistedCtx) as { details?: unknown };
      const nonExecutableError = asRecord(asRecord(nonExecutableResult.details)?.error);
      assert(nonExecutableError?.code === "browser_executable_not_executable", "oracle preflight should surface browser_executable_not_executable for a configured browser path without execute permission");
    }

    const runtimeProfilesFile = join(fixtureDir, "runtime-profiles-file");
    await writeFile(runtimeProfilesFile, "not a directory\n", { encoding: "utf8", mode: 0o600 });
    await writeFile(configPath, `${JSON.stringify({ browser: { authSeedProfileDir: defaultSeedDir, runtimeProfilesDir: runtimeProfilesFile } }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    const runtimeProfilesResult = await preflightTool.execute!("oracle-preflight-runtime-profiles-file", {}, undefined, () => { }, persistedCtx) as { details?: unknown };
    const runtimeProfilesError = asRecord(asRecord(runtimeProfilesResult.details)?.error);
    assert(runtimeProfilesError?.code === "runtime_profiles_dir_unwritable", "oracle preflight should surface runtime_profiles_dir_unwritable when runtimeProfilesDir cannot be prepared as a directory");

    const originalCpPath = process.env.PI_ORACLE_CP_PATH;
    try {
      process.env.PI_ORACLE_CP_PATH = join(fixtureDir, "missing-cp");
      for (const cloneStrategy of ["apfs-clone", "copy"]) {
        await writeFile(configPath, `${JSON.stringify({ browser: { authSeedProfileDir: defaultSeedDir, cloneStrategy } }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
        const missingCpResult = await preflightTool.execute!("oracle-preflight-missing-cp", {}, undefined, () => { }, persistedCtx) as { details?: unknown };
        const missingCpDetails = asRecord(missingCpResult.details);
        if (process.platform === "darwin" && cloneStrategy === "apfs-clone") {
          const missingCpError = asRecord(missingCpDetails?.error);
          assert(missingCpError?.code === "local_dependency_missing", "oracle preflight should surface local_dependency_missing when configured cp is unavailable");
          assert(missingCpError?.rejectedValue === "cp", "oracle preflight should identify cp as the missing configured profile-copy dependency");
        } else {
          assert(missingCpDetails?.ready === true, `oracle preflight should not require cp for ${cloneStrategy} on ${process.platform}: ${JSON.stringify(missingCpDetails)}`);
        }
      }
    } finally {
      if (originalCpPath === undefined) delete process.env.PI_ORACLE_CP_PATH;
      else process.env.PI_ORACLE_CP_PATH = originalCpPath;
    }

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

async function testOracleAuthToolRefreshesSeedProfile(): Promise<void> {
  await resetOracleStateDir();
  const fixtureDir = await mkdtemp(join(tmpdir(), `oracle-sanity-auth-tool-${randomUUID()}-`));
  const agentDir = join(fixtureDir, "agent");
  const agentExtensionsDir = join(agentDir, "extensions");
  const fakeWorkerPath = join(fixtureDir, "fake-worker.mjs");
  const fakeAuthWorkerPath = join(fixtureDir, "fake-auth-worker.mjs");
  const seedDir = join(agentExtensionsDir, "oracle-auth-seed-profile");
  const configPath = join(agentExtensionsDir, "oracle.json");
  const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
  await mkdir(agentExtensionsDir, { recursive: true, mode: 0o700 });
  await mkdir(seedDir, { recursive: true, mode: 0o700 });
  await writeFile(fakeWorkerPath, "process.exit(0);\n", { encoding: "utf8", mode: 0o600 });
  await writeFile(fakeAuthWorkerPath, "process.stdout.write('Auth refreshed via fake worker\\n');\n", { encoding: "utf8", mode: 0o600 });
  await writeFile(configPath, `${JSON.stringify({ browser: { authSeedProfileDir: seedDir } }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });

  const pi = createPiHarness();
  registerOracleTools(pi as unknown as import("@earendil-works/pi-coding-agent").ExtensionAPI, fakeWorkerPath, fakeAuthWorkerPath);
  const authTool = pi.tools.get("oracle_auth");
  assert(authTool?.execute, "oracle auth tool should register for stale-auth recovery testing");

  try {
    process.env.PI_CODING_AGENT_DIR = agentDir;
    const result = await authTool.execute!("oracle-auth-refresh", {}, undefined, () => { }, createExtensionCtx({ getSessionFile: () => undefined } as import("@earendil-works/pi-coding-agent").ExtensionContext["sessionManager"], createUiStub())) as { content?: unknown; details?: unknown };
    const text = Array.isArray(result.content) ? asRecord(result.content[0])?.text : undefined;
    const details = asRecord(result.details);
    assert(typeof text === "string" && text.includes("Auth refreshed via fake worker"), "oracle auth tool should return the shared auth-bootstrap worker output");
    assert(details?.refreshed === true, "oracle auth tool should report a successful auth refresh in its details payload");
    assert(details?.authSeedProfileDir === seedDir, "oracle auth tool should expose the configured auth seed directory in its details payload");
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
  registerOracleTools(pi as unknown as import("@earendil-works/pi-coding-agent").ExtensionAPI, fakeWorkerPath);
  const submitTool = pi.tools.get("oracle_submit");
  assert(submitTool?.execute, "oracle submit tool should register for preflight testing");

  const sessionFile = `/tmp/oracle-sanity-session-submit-preflight-${randomUUID()}.jsonl`;
  const ctx = createExtensionCtx({ getSessionFile: () => sessionFile } as import("@earendil-works/pi-coding-agent").ExtensionContext["sessionManager"], createUiStub());
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
    assert(missingError?.code === "auth_seed_profile_missing", `oracle submit should return a structured missing-auth-seed error code, got ${JSON.stringify(missingError)}`);
    assert(missingError?.rejectedValue === missingSeedDir, "missing auth seed errors should report the missing seed path");
    assert(listOracleJobDirs().length === jobDirCountBefore, "missing auth seed preflight should not create oracle job dirs");

    if (process.platform !== "win32") {
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
    }

    const validSeedDir = join(fixtureDir, "valid-seed");
    const missingExecutablePath = join(fixtureDir, "missing-chrome");
    await mkdir(validSeedDir, { recursive: true, mode: 0o700 });
    await writeFile(join(validSeedDir, ".oracle-seed-generation"), `${new Date().toISOString()}\n`, { mode: 0o600 });
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
  registerOracleTools(pi as unknown as import("@earendil-works/pi-coding-agent").ExtensionAPI, fakeWorkerPath);
  registerOracleCommands(pi as unknown as import("@earendil-works/pi-coding-agent").ExtensionAPI, fakeWorkerPath, fakeWorkerPath);
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
    assert(getOracleConfigLoadDetails(subdirCwd, { projectConfigTrusted: true }).projectConfigPath === join(workspaceRoot, ".pi", "extensions", "oracle.json"), "config loading without git should still resolve the workspace-root project config path from subdirectories");
    assert(loadOracleConfig(subdirCwd, { projectConfigTrusted: true }).defaults.preset === "thinking_light", "config loading without git should still honor trusted workspace-root project overrides from subdirectories");
    assert(resolveArchiveInputs(workspaceRoot, ["README.md"])[0]?.relative === "README.md", "archive input resolution without git should still allow workspace-root files from the derived project root");
    assert(resolveArchiveInputs(workspaceRoot, ["."])[0]?.relative === ".", "archive input resolution without git should still preserve '.' as the explicit whole-workspace sentinel");

    await mkdir(join(innerRoot, ".pi", "extensions"), { recursive: true, mode: 0o700 });
    await mkdir(innerSubdir, { recursive: true, mode: 0o700 });
    await writeFile(join(outerRoot, "package.json"), '{"name":"outer-workspace"}\n', { encoding: "utf8", mode: 0o600 });
    await writeFile(join(innerRoot, "package.json"), '{"name":"inner-workspace"}\n', { encoding: "utf8", mode: 0o600 });
    await writeFile(join(innerRoot, ".pi", "extensions", "oracle.json"), `${JSON.stringify({ defaults: { preset: "thinking_heavy" } }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    assert(getProjectId(innerSubdir) === getProjectId(innerRoot), "workspace-root detection without git should prefer the nearest project markers so nested non-git projects do not widen to parent workspaces");
    assert(loadOracleConfig(innerSubdir, { projectConfigTrusted: true }).defaults.preset === "thinking_heavy", "nested non-git subdirectories should load the nearest trusted project config instead of an outer marker tree");
  } finally {
    await rm(fixtureDir, { recursive: true, force: true });
  }
}

async function testWorkspaceRootPrefersNearestProjectMarkersOverUnrelatedAncestorGit(): Promise<void> {
  const fixtureDir = await mkdtemp(join(tmpdir(), `oracle-sanity-workspace-root-ancestor-git-${randomUUID()}-`));
  const outerGitRoot = join(fixtureDir, "outer-git");
  const projectRoot = join(outerGitRoot, "projects", "sample-app");
  const subdirCwd = join(projectRoot, "src", "feature");

  try {
    await mkdir(join(outerGitRoot, ".git"), { recursive: true, mode: 0o700 });
    await mkdir(subdirCwd, { recursive: true, mode: 0o700 });
    await mkdir(join(projectRoot, ".pi"), { recursive: true, mode: 0o700 });
    await writeFile(join(projectRoot, "AGENTS.md"), "# sample app\n", { encoding: "utf8", mode: 0o600 });
    await writeFile(join(projectRoot, "README.md"), "# sample app\n", { encoding: "utf8", mode: 0o600 });

    assert(getProjectId(subdirCwd) === getProjectId(projectRoot), "workspace-root detection should prefer the nearest project markers over an unrelated ancestor git root");
    assert(resolveArchiveInputs(getProjectId(subdirCwd), ["AGENTS.md"])[0]?.relative === "AGENTS.md", "archive input resolution should stay anchored to the nearest marked project root instead of widening to an unrelated ancestor git repo");
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
  await writeFile(join(seedDir, ".oracle-seed-generation"), `${new Date().toISOString()}\n`, { mode: 0o600 });
  await writeFile(join(projectRoot, "README.md"), "# workspace root\n", { encoding: "utf8", mode: 0o600 });
  await writeFile(join(subdirCwd, "nested.txt"), "nested\n", { encoding: "utf8", mode: 0o600 });
  await writeFile(join(projectRoot, ".pi", "extensions", "oracle.json"), `${JSON.stringify({ defaults: { preset: "thinking_light" } }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await writeFile(join(agentExtensionsDir, "oracle.json"), `${JSON.stringify({ browser: { authSeedProfileDir: seedDir, runtimeProfilesDir } }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await writeFile(fakeWorkerPath, "process.exit(0);\n", { encoding: "utf8", mode: 0o600 });

  const pi = createPiHarness();
  registerOracleTools(pi as unknown as import("@earendil-works/pi-coding-agent").ExtensionAPI, fakeWorkerPath);
  const submitTool = pi.tools.get("oracle_submit");
  assert(submitTool?.execute, "oracle submit tool should register for workspace-root submit testing");

  const sessionFile = `/tmp/oracle-sanity-session-submit-workspace-root-${randomUUID()}.jsonl`;
  const ctx = createExtensionCtx({ getSessionFile: () => sessionFile } as import("@earendil-works/pi-coding-agent").ExtensionContext["sessionManager"], createUiStub(), subdirCwd);
  let jobId: string | undefined;

  try {
    process.env.PI_CODING_AGENT_DIR = agentDir;

    const workspaceRoot = getProjectId(subdirCwd);
    const configLoad = getOracleConfigLoadDetails(subdirCwd, { projectConfigTrusted: true });
    assert(configLoad.projectConfigPath === join(workspaceRoot, ".pi", "extensions", "oracle.json"), "config loading from a subdirectory should resolve the project config at the workspace root");
    assert(configLoad.projectConfigPath !== join(subdirCwd, ".pi", "extensions", "oracle.json"), "config loading from a subdirectory should not look for a nested per-subdirectory project config path");
    assert(loadOracleConfig(subdirCwd, { projectConfigTrusted: true }).defaults.preset === "thinking_light", "oracle submit should load trusted project config defaults from the workspace root when invoked from a subdirectory");
    new ProjectTrustStore(agentDir).set(subdirCwd, true);

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

    const archiveEntries = listArchiveEntries(persistedJob.archivePath);
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

async function testOracleStatusListsRecentJobIdsWhenNoExplicitId(config: OracleConfig): Promise<void> {
  await resetOracleStateDir();
  const fakeWorkerPath = join(tmpdir(), `oracle-sanity-status-recent-jobs-${randomUUID()}.mjs`);
  await writeFile(fakeWorkerPath, "process.exit(0);\n", { encoding: "utf8", mode: 0o600 });

  const pi = createPiHarness();
  registerOracleCommands(pi as unknown as import("@earendil-works/pi-coding-agent").ExtensionAPI, fakeWorkerPath, fakeWorkerPath);
  const statusCommand = pi.commands.get("oracle-status");
  assert(statusCommand, "oracle status command should register for recent-job listing coverage");

  const sessionFile = `/tmp/oracle-sanity-session-status-recent-jobs-${randomUUID()}.jsonl`;
  const firstJobId = await createJobForTest(config, process.cwd(), sessionFile, { initialState: "queued" });
  const secondJobId = await createJobForTest(config, process.cwd(), sessionFile, { initialState: "queued" });
  const ui = createUiStub();
  const ctx = createCommandCtx({ getSessionFile: () => sessionFile } as import("@earendil-works/pi-coding-agent").ExtensionCommandContext["sessionManager"], ui);

  try {
    await statusCommand.handler("", ctx);
    const message = ui.notifications.at(-1)?.message;
    assert(typeof message === "string" && message.includes("Recent jobs:"), "oracle status without an explicit id should include recent job ids so users can discover follow-up/cancel targets");
    assert(message.includes(firstJobId) && message.includes(secondJobId), "oracle status recent-job listing should include the available project job ids");
  } finally {
    await cancelOracleJob(firstJobId);
    await cancelOracleJob(secondJobId);
    await cleanupJob(firstJobId);
    await cleanupJob(secondJobId);
    await rm(fakeWorkerPath, { force: true });
  }
}

async function testOraclePromptCommandsInjectHiddenInstructions(): Promise<void> {
  const pi = createPiHarness();
  oracleExtension(pi as unknown as import("@earendil-works/pi-coding-agent").ExtensionAPI);
  const inputHandler = pi.handlers.get("input");
  assert(inputHandler, "oracle extension should register an input interceptor for TUI /oracle commands");
  assert(!pi.commands.has("oracle") && !pi.commands.has("oracle-followup"), "oracle prompt workflows should not register extension commands that block print-mode prompt templates");

  const ui = createUiStub();
  const tuiCtx = createExtensionCtx({ getSessionFile: () => "/tmp/oracle-sanity-hidden-prompt-session.jsonl" } as import("@earendil-works/pi-coding-agent").ExtensionContext["sessionManager"], ui, process.cwd(), "tui");
  const handled = await inputHandler({ text: "/oracle Read README.md", source: "interactive" }, tuiCtx) as { action?: string };
  assert(handled?.action === "handled", "TUI /oracle input should be handled before prompt-template expansion");
  assert(pi.sentUserMessages.at(-1)?.content === "/oracle Read README.md", "oracle input interceptor should reinject the compact user command so prompt history survives session reloads");
  const beforeAgentStart = pi.handlers.get("before_agent_start");
  assert(beforeAgentStart, "oracle extension should inject hidden dispatch instructions before the reinjected user command reaches the model");
  const injection = await beforeAgentStart({ prompt: "/oracle Read README.md" }, tuiCtx) as { message?: { display?: boolean; content?: unknown } };
  const message = injection?.message;
  assert(message?.display === false, "oracle before-agent injection should hide verbose dispatch instructions from the visible transcript");
  assert(String(message?.content || "").includes("Read README.md"), "oracle before-agent injection should include the user request in hidden dispatch instructions");
  assert(ui.notifications.at(-1)?.message === "Preparing oracle job… running preflight", "oracle input interceptor should show compact user-facing status");

  const followupHandled = await inputHandler({ text: "/oracle-followup job-123 continue", source: "interactive" }, tuiCtx) as { action?: string };
  assert(followupHandled?.action === "handled", "TUI /oracle-followup input should be handled before prompt-template expansion");
  assert(pi.sentUserMessages.at(-1)?.content === "/oracle-followup job-123 continue", "oracle-followup interceptor should reinject the compact user command for prompt history");
  const followupInjection = await beforeAgentStart({ prompt: "/oracle-followup job-123 continue" }, tuiCtx) as { message?: { display?: boolean; content?: unknown } };
  const followupMessage = followupInjection?.message;
  assert(followupMessage?.display === false && String(followupMessage.content || "").includes("job-123 continue"), "oracle-followup before-agent injection should hide verbose dispatch instructions while preserving arguments");

  const usageUi = createUiStub();
  const usageCtx = createExtensionCtx({ getSessionFile: () => "/tmp/oracle-sanity-hidden-prompt-session.jsonl" } as import("@earendil-works/pi-coding-agent").ExtensionContext["sessionManager"], usageUi, process.cwd(), "tui");
  const usageResult = await inputHandler({ text: "/oracle-followup job-123", source: "interactive" }, usageCtx) as { action?: string };
  assert(usageResult?.action === "handled" && usageUi.notifications.at(-1)?.message === "Usage: /oracle-followup <job-id> <request>", "TUI /oracle-followup should report usage before invoking hidden dispatch when the request is missing");

  const printCtx = createExtensionCtx({ getSessionFile: () => "/tmp/oracle-sanity-hidden-prompt-session.jsonl" } as import("@earendil-works/pi-coding-agent").ExtensionContext["sessionManager"], createUiStub(), process.cwd(), "print");
  const printResult = await inputHandler({ text: "/oracle Read README.md", source: "interactive" }, printCtx) as { action?: string };
  assert(printResult?.action === "continue", "print-mode /oracle input should continue to prompt-template expansion");
}

async function testOracleStatusAndReadEmitPrintModeOutput(config: OracleConfig): Promise<void> {
  await resetOracleStateDir();
  const fakeWorkerPath = join(tmpdir(), `oracle-sanity-print-commands-${randomUUID()}.mjs`);
  await writeFile(fakeWorkerPath, "process.exit(0);\n", { encoding: "utf8", mode: 0o600 });

  const pi = createPiHarness();
  registerOracleCommands(pi as unknown as import("@earendil-works/pi-coding-agent").ExtensionAPI, fakeWorkerPath, fakeWorkerPath);
  const statusCommand = pi.commands.get("oracle-status");
  const readCommand = pi.commands.get("oracle-read");
  assert(statusCommand && readCommand, "oracle status/read commands should register for print-mode output coverage");

  const sessionFile = `/tmp/oracle-sanity-session-print-commands-${randomUUID()}.jsonl`;
  const jobId = await createTerminalJob(config, process.cwd(), sessionFile, "command");
  const job = readJob(jobId);
  assert(job?.responsePath, "print-mode command test job should have a response path");
  await writeFile(job.responsePath, "saved response preview\n", { mode: 0o600 });

  const writes: string[] = [];
  const originalWrite = process.stdout.write.bind(process.stdout);
  const patchedWrite = ((chunk: string | Uint8Array, encodingOrCallback?: BufferEncoding | ((error?: Error) => void), callback?: (error?: Error) => void) => {
    writes.push(String(chunk));
    const done = typeof encodingOrCallback === "function" ? encodingOrCallback : callback;
    done?.();
    return true;
  }) as typeof process.stdout.write;
  process.stdout.write = patchedWrite;

  try {
    const ctx = createCommandCtx({ getSessionFile: () => sessionFile } as import("@earendil-works/pi-coding-agent").ExtensionCommandContext["sessionManager"], createUiStub(), process.cwd(), "print");
    await statusCommand.handler(jobId, ctx);
    await readCommand.handler(jobId, ctx);
    const output = writes.join("");
    assert(output.includes(`job: ${jobId}`), "oracle-status should emit a job summary in print mode");
    assert(output.includes("saved response preview"), "oracle-read should emit the saved response preview in print mode");
  } finally {
    process.stdout.write = originalWrite;
    await cleanupJob(jobId);
    await rm(fakeWorkerPath, { force: true });
  }
}

async function testOracleCancelCommandRequiresExplicitJobId(config: OracleConfig): Promise<void> {
  await resetOracleStateDir();
  const fakeWorkerPath = join(tmpdir(), `oracle-sanity-cancel-explicit-id-${randomUUID()}.mjs`);
  await writeFile(fakeWorkerPath, "process.exit(0);\n", { encoding: "utf8", mode: 0o600 });

  const pi = createPiHarness();
  registerOracleCommands(pi as unknown as import("@earendil-works/pi-coding-agent").ExtensionAPI, fakeWorkerPath, fakeWorkerPath);
  const cancelCommand = pi.commands.get("oracle-cancel");
  assert(cancelCommand, "oracle cancel command should register for explicit-id validation");

  const sessionFile = `/tmp/oracle-sanity-session-cancel-explicit-id-${randomUUID()}.jsonl`;
  const queuedId = await createJobForTest(config, process.cwd(), sessionFile, { initialState: "queued" });
  const ui = createUiStub();
  const ctx = createCommandCtx({ getSessionFile: () => sessionFile } as import("@earendil-works/pi-coding-agent").ExtensionCommandContext["sessionManager"], ui);

  try {
    await cancelCommand.handler("", ctx);
    const message = ui.notifications.at(-1)?.message;
    assert(typeof message === "string" && message.includes("Usage: /oracle-cancel <job-id>"), "oracle cancel should require an explicit job id instead of silently cancelling the latest job");
    assert(readJob(queuedId)?.status === "queued", "oracle cancel without an explicit id should leave queued jobs untouched");
  } finally {
    await cancelOracleJob(queuedId);
    await cleanupJob(queuedId);
    await rm(fakeWorkerPath, { force: true });
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
  await writeFile(join(seedDir, ".oracle-seed-generation"), `${new Date().toISOString()}\n`, { mode: 0o600 });
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
  registerOracleTools(pi as unknown as import("@earendil-works/pi-coding-agent").ExtensionAPI, fakeWorkerPath);
  const submitTool = pi.tools.get("oracle_submit");
  const readTool = pi.tools.get("oracle_read");
  const cancelTool = pi.tools.get("oracle_cancel");
  assert(submitTool?.execute, "oracle submit tool should register for details-shape testing");
  assert(readTool?.execute, "oracle read tool should register for details-shape testing");
  assert(cancelTool?.execute, "oracle cancel tool should register for details-shape testing");

  const cwd = process.cwd();
  const sessionFile = `/tmp/oracle-sanity-session-tool-details-${randomUUID()}.jsonl`;
  const ctx = createExtensionCtx({ getSessionFile: () => sessionFile } as import("@earendil-works/pi-coding-agent").ExtensionContext["sessionManager"], createUiStub());
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
  registerOracleTools(pi as unknown as import("@earendil-works/pi-coding-agent").ExtensionAPI, fakeWorkerPath);
  registerOracleCommands(pi as unknown as import("@earendil-works/pi-coding-agent").ExtensionAPI, fakeWorkerPath, fakeWorkerPath);
  const readTool = pi.tools.get("oracle_read");
  const readCommand = pi.commands.get("oracle-read");
  const statusCommand = pi.commands.get("oracle-status");
  assert(readTool?.execute, "oracle read tool should register for terminal summary testing");
  assert(readCommand, "oracle read command should register for terminal summary testing");
  assert(statusCommand, "oracle status command should register for terminal summary testing");

  const cwd = process.cwd();
  const sessionFile = `/tmp/oracle-sanity-session-terminal-summary-${randomUUID()}.jsonl`;
  const readCtx = createExtensionCtx({ getSessionFile: () => sessionFile } as import("@earendil-works/pi-coding-agent").ExtensionContext["sessionManager"], createUiStub());
  const readCommandUi = createUiStub();
  const readCommandCtx = createCommandCtx({ getSessionFile: () => sessionFile } as import("@earendil-works/pi-coding-agent").ExtensionCommandContext["sessionManager"], readCommandUi);
  const statusUi = createUiStub();
  const statusCtx = createCommandCtx({ getSessionFile: () => sessionFile } as import("@earendil-works/pi-coding-agent").ExtensionCommandContext["sessionManager"], statusUi);
  const jobId = await createJobForTest(config, cwd, sessionFile);
  let commandReadJobId: string | undefined;

  try {
    commandReadJobId = await createTerminalJob(config, cwd, sessionFile, "command");
    await writeFile(join(getJobDir(commandReadJobId), "response.md"), "Preview body from oracle-read command.\n", { encoding: "utf8", mode: 0o600 });
    await updateJob(commandReadJobId, (job) => ({
      ...job,
      wakeupAttemptCount: 1,
      wakeupLastRequestedAt: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
      wakeupSettledAt: undefined,
      wakeupSettledSource: undefined,
      wakeupSettledSessionFile: undefined,
      wakeupSettledSessionKey: undefined,
      wakeupSettledBeforeFirstAttempt: undefined,
    }));
    await readCommand!.handler(commandReadJobId, readCommandCtx);
    const readCommandMessage = readCommandUi.notifications.at(-1)?.message;
    assert(typeof readCommandMessage === "string" && readCommandMessage.includes("Preview body from oracle-read command."), "oracle-read should surface the saved response preview in the user-facing command output");
    assert(readJob(commandReadJobId)?.wakeupSettledSource === "oracle_read_command", "oracle-read should settle further wake-up retries through its own command provenance");

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
    if (commandReadJobId) await cleanupJob(commandReadJobId);
    await cleanupJob(jobId);
  }
}

async function testOracleReadSummaryShowsHeartbeatFreshness(config: OracleConfig): Promise<void> {
  await resetOracleStateDir();
  const fakeWorkerPath = join(tmpdir(), `oracle-sanity-heartbeat-summary-worker-${randomUUID()}.mjs`);
  await writeFile(fakeWorkerPath, "process.exit(0);\n", { encoding: "utf8", mode: 0o600 });

  const pi = createPiHarness();
  registerOracleTools(pi as unknown as import("@earendil-works/pi-coding-agent").ExtensionAPI, fakeWorkerPath);
  registerOracleCommands(pi as unknown as import("@earendil-works/pi-coding-agent").ExtensionAPI, fakeWorkerPath, fakeWorkerPath);
  const readTool = pi.tools.get("oracle_read");
  const statusCommand = pi.commands.get("oracle-status");
  assert(readTool?.execute, "oracle read tool should register for heartbeat-summary testing");
  assert(statusCommand, "oracle status command should register for heartbeat-summary testing");

  const cwd = process.cwd();
  const sessionFile = `/tmp/oracle-sanity-session-heartbeat-summary-${randomUUID()}.jsonl`;
  const readCtx = createExtensionCtx({ getSessionFile: () => sessionFile } as import("@earendil-works/pi-coding-agent").ExtensionContext["sessionManager"], createUiStub());
  const statusUi = createUiStub();
  const statusCtx = createCommandCtx({ getSessionFile: () => sessionFile } as import("@earendil-works/pi-coding-agent").ExtensionCommandContext["sessionManager"], statusUi);
  const staleId = await createJobForTest(config, cwd, sessionFile);
  const waitingId = await createJobForTest(config, cwd, sessionFile);

  try {
    const staleAt = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    await updateJob(staleId, (job) => ({
      ...job,
      ...withJobPhase("awaiting_response", {
        status: "waiting",
        submittedAt: staleAt,
        heartbeatAt: staleAt,
      }, staleAt),
    }));

    const waitingAt = new Date(Date.now() - 45_000).toISOString();
    await updateJob(waitingId, (job) => ({
      ...job,
      ...withJobPhase("submitted", {
        status: "submitted",
        submittedAt: waitingAt,
        heartbeatAt: undefined,
      }, waitingAt),
    }));

    const readResult = await readTool.execute!("oracle-read-heartbeat-summary-test", { jobId: staleId }, undefined, () => { }, readCtx) as { content?: Array<{ text?: string }> };
    const readText = readResult.content?.[0]?.text;
    assert(typeof readText === "string" && readText.includes("heartbeat: likely stale"), "oracle read should surface likely-stale heartbeat freshness for active jobs");

    await statusCommand.handler(waitingId, statusCtx);
    const statusMessage = statusUi.notifications.at(-1)?.message;
    assert(typeof statusMessage === "string" && statusMessage.includes("heartbeat: waiting for first worker update"), "oracle status should surface first-heartbeat waiting state for active jobs");
  } finally {
    await rm(fakeWorkerPath, { force: true });
    await cleanupJob(staleId);
    await cleanupJob(waitingId);
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
  registerOracleTools(pi as unknown as import("@earendil-works/pi-coding-agent").ExtensionAPI, fakeWorkerPath);
  const submitTool = pi.tools.get("oracle_submit");
  const readTool = pi.tools.get("oracle_read");
  const toolResultHandler = pi.handlers.get("tool_result");
  assert(submitTool?.execute, "oracle submit tool should register for structured-error testing");
  assert(readTool?.execute, "oracle read tool should register for structured-error testing");
  assert(toolResultHandler, "oracle tools should register a tool_result hook to preserve isError for structured errors");

  const sessionFile = `/tmp/oracle-sanity-session-tool-errors-${randomUUID()}.jsonl`;
  const ctx = createExtensionCtx({ getSessionFile: () => sessionFile } as import("@earendil-works/pi-coding-agent").ExtensionContext["sessionManager"], createUiStub());

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
  registerOracleCommands(pi as unknown as import("@earendil-works/pi-coding-agent").ExtensionAPI, fakeWorkerPath, fakeWorkerPath);

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
  const ctx = createCommandCtx({ getSessionFile: () => sessionFile } as import("@earendil-works/pi-coding-agent").ExtensionCommandContext["sessionManager"], ui);

  try {
    await cleanCommand.handler(jobId, ctx);
    assert(Boolean(readJob(jobId)), "oracle clean should not delete a terminal job during the post-send retention grace window");
    const notice = ui.notifications.at(-1)?.message || "";
    assert(notice.includes("post-send retention grace window"), "oracle clean should explain the hidden retention-grace cleanup blocker");
    assert(notice.includes("Retry after") && notice.includes(retryAfter), "oracle clean should surface the next eligible cleanup time when retention grace blocks removal");
    assert(notice.includes("Job retained for wake-up safety") && notice.includes("Cleanup blockers/warnings"), "oracle clean summary should describe retained jobs with friendly wake-up safety phrasing and blocker details");
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
  registerOracleCommands(pi as unknown as import("@earendil-works/pi-coding-agent").ExtensionAPI, fakeWorkerPath, fakeWorkerPath);

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
  const ctx = createCommandCtx({ getSessionFile: () => sessionFile } as import("@earendil-works/pi-coding-agent").ExtensionCommandContext["sessionManager"], ui);

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

async function testCancelReconcileRacePreservesIntentionalCancellation(config: OracleConfig): Promise<void> {
  await resetOracleStateDir();
  const cwd = process.cwd();
  const sessionId = "/tmp/oracle-sanity-session-cancel-reconcile-race.jsonl";
  const activeId = await createJobForTest(config, cwd, sessionId);
  const worker = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => setTimeout(() => process.exit(0), 500)); setInterval(() => {}, 1000);"]);
  const workerPid = worker.pid;
  assert(workerPid !== undefined, "cancel-reconcile race worker should expose a pid");
  const workerStartedAt = await waitForProcessStartedAtValue(workerPid);
  const staleAt = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  await updateJob(activeId, (job) => ({
    ...job,
    workerPid,
    workerStartedAt,
    heartbeatAt: staleAt,
    submittedAt: staleAt,
  }));

  try {
    const cancelPromise = cancelOracleJob(activeId);
    const cancelRequested = await waitForJobState(activeId, (job) => typeof job.cancelRequestedAt === "string" && job.cancelReason === "Cancelled by user");
    assert(cancelRequested.status === "submitted", "active cancellation should record durable cancel intent before terminal transition");

    const repaired = await reconcileStaleOracleJobs();
    const cancelled = await cancelPromise;
    const repairedAsCancelled = repaired.some((job) => job.id === activeId && job.status === "cancelled");
    assert(repairedAsCancelled || cancelled.status === "cancelled", "reconcile should preserve cancelled semantics when it races an intentional cancel");
    assert(cancelled.status === "cancelled", "intentional cancel/reconcile races should resolve as cancelled instead of failed");

    const finalJob = readJob(activeId);
    assert(finalJob?.status === "cancelled", "intentional cancel/reconcile races should persist cancelled as the final durable status");
    const followUpRepair = await reconcileStaleOracleJobs();
    assert(!followUpRepair.some((job) => job.id === activeId && job.status === "failed"), "follow-up reconcile should not reclassify intentionally cancelled jobs as failed");
    assert(readJob(activeId)?.status === "cancelled", "follow-up reconcile should keep intentionally cancelled jobs in the cancelled state");
  } finally {
    if (isPidAlive(workerPid)) process.kill(workerPid, "SIGKILL");
    await waitForPidExit(workerPid);
    await cleanupJob(activeId);
  }
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
  registerOracleTools(pi as unknown as import("@earendil-works/pi-coding-agent").ExtensionAPI, fakeWorkerPath);
  registerOracleCommands(pi as unknown as import("@earendil-works/pi-coding-agent").ExtensionAPI, fakeWorkerPath, fakeWorkerPath);

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
    const ctx = createCommandCtx({ getSessionFile: () => sessionFile } as import("@earendil-works/pi-coding-agent").ExtensionCommandContext["sessionManager"], ui);
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

async function testCancelToolAndCommandMessagesAreTruthful(config: OracleConfig): Promise<void> {
  await resetOracleStateDir();
  const cwd = process.cwd();
  const fakeWorkerPath = join(tmpdir(), `oracle-sanity-cancel-message-worker-${randomUUID()}.mjs`);
  await writeFile(fakeWorkerPath, "process.exit(0);\n", { mode: 0o600 });

  const pi = createPiHarness();
  registerOracleTools(pi as unknown as import("@earendil-works/pi-coding-agent").ExtensionAPI, fakeWorkerPath);
  registerOracleCommands(pi as unknown as import("@earendil-works/pi-coding-agent").ExtensionAPI, fakeWorkerPath, fakeWorkerPath);

  const cancelTool = pi.tools.get("oracle_cancel");
  const cancelCommand = pi.commands.get("oracle-cancel");
  assert(cancelTool?.execute, "oracle cancel tool should register for message testing");
  assert(cancelCommand, "oracle cancel command should register for message testing");

  const runCancelledCase = async (kind: "tool" | "command") => {
    const sessionFile = `/tmp/oracle-sanity-session-cancel-message-cancelled-${kind}-${randomUUID()}.jsonl`;
    const queuedId = await createJobForTest(config, cwd, sessionFile, { initialState: "queued" });
    const ui = createUiStub();
    const ctx = createCommandCtx({ getSessionFile: () => sessionFile } as import("@earendil-works/pi-coding-agent").ExtensionCommandContext["sessionManager"], ui);
    (ctx as { hasUI: boolean }).hasUI = false;

    try {
      const message = kind === "tool"
        ? (await cancelTool.execute!("oracle-cancel-message-cancelled-test", { jobId: queuedId }, undefined, () => { }, ctx) as { content?: Array<{ text?: string }> }).content?.[0]?.text
        : (await cancelCommand.handler(queuedId, ctx), ui.notifications.at(-1)?.message ?? pi.sentMessages.at(-1)?.content);
      assert(message === `Cancelled oracle job ${queuedId}.`, `${kind} cancel messaging should say cancelled only when the final status is cancelled`);
    } finally {
      await cleanupJob(queuedId);
    }
  };

  const runFailedCase = async (kind: "tool" | "command") => {
    const sessionFile = `/tmp/oracle-sanity-session-cancel-message-failed-${kind}-${randomUUID()}.jsonl`;
    const activeId = await createJobForTest(config, cwd, sessionFile);
    const activeJob = readJob(activeId);
    assert(activeJob, "active cancellation message test job should exist");
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
    assert(stuckWorkerPid !== undefined, `${kind} cancel message test worker should expose a pid`);

    await updateJob(activeId, (job) => ({
      ...job,
      workerPid: stuckWorkerPid,
      workerStartedAt: "mismatched-start-time",
    }));

    const ui = createUiStub();
    const ctx = createCommandCtx({ getSessionFile: () => sessionFile } as import("@earendil-works/pi-coding-agent").ExtensionCommandContext["sessionManager"], ui);
    (ctx as { hasUI: boolean }).hasUI = false;

    try {
      const message = kind === "tool"
        ? (await cancelTool.execute!("oracle-cancel-message-failed-test", { jobId: activeId }, undefined, () => { }, ctx) as { content?: Array<{ text?: string }> }).content?.[0]?.text
        : (await cancelCommand.handler(activeId, ctx), ui.notifications.at(-1)?.message ?? pi.sentMessages.at(-1)?.content);
      assert(readJob(activeId)?.status === "failed", `${kind} cancel message test should drive the job into failed status when worker termination is unsafe`);
      assert(message === `Oracle job ${activeId} failed during cancellation.`, `${kind} cancel messaging should describe failed outcomes explicitly instead of claiming cancellation succeeded`);
    } finally {
      if (isPidAlive(stuckWorkerPid)) process.kill(stuckWorkerPid, "SIGKILL");
      await waitForPidExit(stuckWorkerPid);
      await releaseRuntimeLease(activeJob.runtimeId);
      await cleanupJob(activeId);
    }
  };

  try {
    await runCancelledCase("tool");
    await runCancelledCase("command");
    await runFailedCase("tool");
    await runFailedCase("command");
  } finally {
    await rm(fakeWorkerPath, { force: true });
  }
}

async function testCancelFailureDoesNotPromoteQueuedJobs(config: OracleConfig): Promise<void> {
  await resetOracleStateDir();
  const cwd = process.cwd();
  const fakeWorkerPath = join(tmpdir(), `oracle-sanity-cancel-worker-${randomUUID()}.mjs`);
  await writeFile(fakeWorkerPath, "process.exit(0);\n", { mode: 0o600 });

  const pi = createPiHarness();
  registerOracleTools(pi as unknown as import("@earendil-works/pi-coding-agent").ExtensionAPI, fakeWorkerPath);
  registerOracleCommands(pi as unknown as import("@earendil-works/pi-coding-agent").ExtensionAPI, fakeWorkerPath, fakeWorkerPath);

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
    const ctx = createCommandCtx({ getSessionFile: () => sessionFile } as import("@earendil-works/pi-coding-agent").ExtensionCommandContext["sessionManager"], ui);
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
  const invalidRuntimeProfileDir = process.platform === "win32"
    ? join(process.env.LOCALAPPDATA ?? join(process.env.USERPROFILE ?? "C:\\Users\\Default", "AppData", "Local"), "Google", "Chrome", "User Data", "pi-oracle-invalid-runtime-profile")
    : "/dev/null/pi-oracle-invalid-runtime-profile";
  await updateJob(queuedId, (job) => ({
    ...job,
    runtimeProfileDir: invalidRuntimeProfileDir,
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


function encryptChromiumCookieValue(value: string, password: string, options: { hashPrefix?: boolean } = {}): Buffer {
  const key = pbkdf2Sync(password, "saltysalt", 1003, 16, "sha1");
  const iv = Buffer.alloc(16, 0x20);
  const cipher = createCipheriv("aes-128-cbc", key, iv);
  cipher.setAutoPadding(false);
  const plain = options.hashPrefix ? Buffer.concat([Buffer.alloc(32, 0x01), Buffer.from(value, "utf8")]) : Buffer.from(value, "utf8");
  const remainder = plain.length % 16;
  const padding = remainder === 0 ? 16 : 16 - remainder;
  const padded = Buffer.concat([plain, Buffer.alloc(padding, padding)]);
  return Buffer.concat([Buffer.from("v10"), cipher.update(padded), cipher.final()]);
}

async function testChromiumCookieSourceReadsConfiguredKeychain(): Promise<void> {
  const fixtureDir = await mkdtemp(join(tmpdir(), "oracle-chromium-cookie-source-"));
  const binDir = join(fixtureDir, "bin");
  const dbPath = join(fixtureDir, "Cookies");
  const originalPath = process.env.PATH;
  const keychainPassword = "helium-test-storage-key";

  try {
    await mkdir(binDir, { recursive: true, mode: 0o700 });
    if (process.platform === "win32") {
      await writeFile(join(binDir, "security.cmd"), `@echo off\r\necho ${keychainPassword}\r\n`, { encoding: "utf8", mode: 0o700 });
    } else {
      await writeExecutableScript(
        join(binDir, "security"),
        `#!/bin/sh
printf '%s\\n' ${shellQuote(keychainPassword)}
`,
      );
    }

    const db = new DatabaseSync(dbPath);
    try {
      db.exec("CREATE TABLE meta (key LONGVARCHAR NOT NULL UNIQUE PRIMARY KEY, value LONGVARCHAR);");
      db.prepare("INSERT INTO meta (key, value) VALUES ('version', '24')").run();
      db.exec(`CREATE TABLE cookies (
        creation_utc INTEGER NOT NULL,
        host_key TEXT NOT NULL,
        top_frame_site_key TEXT NOT NULL,
        name TEXT NOT NULL,
        value TEXT NOT NULL,
        encrypted_value BLOB NOT NULL,
        path TEXT NOT NULL,
        expires_utc INTEGER NOT NULL,
        is_secure INTEGER NOT NULL,
        is_httponly INTEGER NOT NULL,
        last_access_utc INTEGER NOT NULL,
        has_expires INTEGER NOT NULL,
        is_persistent INTEGER NOT NULL,
        priority INTEGER NOT NULL,
        samesite INTEGER NOT NULL,
        source_scheme INTEGER NOT NULL,
        source_port INTEGER NOT NULL,
        is_same_party INTEGER NOT NULL
      );`);
      const insertCookie = db.prepare(`INSERT INTO cookies (
        creation_utc, host_key, top_frame_site_key, name, value, encrypted_value, path, expires_utc,
        is_secure, is_httponly, last_access_utc, has_expires, is_persistent, priority, samesite,
        source_scheme, source_port, is_same_party
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);`);
      insertCookie.run(
        0,
        ".chatgpt.com",
        "",
        "__Secure-next-auth.session-token.0",
        "",
        encryptChromiumCookieValue("stale-session-from-helium", keychainPassword, { hashPrefix: true }),
        "/",
        0,
        1,
        1,
        0,
        0,
        0,
        1,
        1,
        2,
        443,
        0,
      );
      insertCookie.run(
        1,
        ".chatgpt.com",
        "",
        "__Secure-next-auth.session-token.0",
        "",
        encryptChromiumCookieValue("session-from-helium", keychainPassword, { hashPrefix: true }),
        "/",
        14_000_000_000_000_000,
        1,
        1,
        0,
        1,
        1,
        1,
        1,
        2,
        443,
        0,
      );
    } finally {
      db.close();
    }

    process.env.PATH = `${binDir}${delimiter}${originalPath}`;
    const result = await getCookiesFromConfiguredChromiumSource({
      dbPath,
      keychain: { account: "Helium", services: ["Helium Storage Key"], label: "Helium Storage Key" },
      origins: ["https://chatgpt.com"],
      profile: "Default",
    });

    assert(result.warnings.length === 0, `expected no Chromium cookie warnings, saw ${result.warnings.join(" | ")}`);
    const sessionCookies = result.cookies.filter((cookie) => cookie.name === "__Secure-next-auth.session-token.0");
    assert(sessionCookies.length === 1, `Chromium cookie source should dedupe duplicate browser session cookies, saw ${sessionCookies.length}`);
    assert(sessionCookies[0]?.value === "session-from-helium", "Chromium cookie source should strip Chromium v24 host-hash prefixes and preserve the newest duplicate browser session cookie by expiry ordering");
  } finally {
    process.env.PATH = originalPath;
    await rm(fixtureDir, { recursive: true, force: true });
  }
}

function testAuthCookiePolicy(): void {
  const rawCookies: ImportedAuthCookie[] = [
    { name: "__Secure-next-auth.session-token.0", value: "session-a", domain: ".chatgpt.com", path: "/", secure: true, httpOnly: true, sameSite: "Lax" },
    { name: "oai-client-auth-info", value: "info", domain: "auth.openai.com", path: "/", secure: true, sameSite: "Lax" },
    { name: "_account_is_fedramp", value: "1", domain: "chatgpt.com", path: "/", secure: false, sameSite: "Lax" },
    { name: "_ga", value: "analytics", domain: "chatgpt.com", path: "/" },
    { name: "cf_clearance", value: "clear", domain: ".chatgpt.com", path: "/", secure: true },
    { name: "__cf_bm", value: "bot", domain: "auth.openai.com", path: "/", secure: true },
    { name: "__cflb", value: "lb", domain: "chatgpt.com", path: "/", secure: true },
    { name: "_cfuvid", value: "visitor", domain: ".chatgpt.com", path: "/", secure: true },
    { name: "totally_unknown_cookie", value: "mystery", domain: "chatgpt.com", path: "/" },
    { name: "sso", value: "grok-session", domain: "grok.com", path: "/", secure: true, httpOnly: true, sameSite: "Lax" },
    { name: "sso-rw", value: "grok-rw", domain: "x.ai", path: "/", secure: true, httpOnly: true, sameSite: "Lax" },
    { name: "auth_token", value: "x-auth", domain: "x.com", path: "/", secure: true, httpOnly: true, sameSite: "Lax" },
    { name: "ct0", value: "x-csrf", domain: "x.com", path: "/", secure: true, sameSite: "Lax" },
    { name: "guest_id", value: "ambient", domain: "x.com", path: "/", secure: true, sameSite: "Lax" },
    { name: "oai-client-auth-info", value: "evil", domain: "evil.example", path: "/", secure: true, sameSite: "Lax" },
  ];

  const filtered = filterImportableAuthCookies(rawCookies, "https://chatgpt.com/");
  const keptNames = filtered.cookies.map((cookie) => `${cookie.name}@${cookie.domain}`).sort();
  const droppedReasons = filtered.dropped.map(({ reason }) => reason).sort();

  assert(keptNames.includes("__Secure-next-auth.session-token.0@chatgpt.com"), "session token cookie should be kept");
  assert(keptNames.includes("oai-client-auth-info@auth.openai.com"), "auth cookie should be kept");
  assert(keptNames.includes("_account_is_fedramp@chatgpt.com"), "fedramp marker should be kept");
  assert(!keptNames.some((name) => name.startsWith("_ga@")), "analytics cookie should be dropped");
  assert(keptNames.includes("cf_clearance@chatgpt.com"), "Cloudflare clearance cookie should be kept for ChatGPT challenge continuity");
  assert(keptNames.includes("__cf_bm@auth.openai.com"), "Cloudflare bot-management cookie should be kept because cf_clearance alone is insufficient for current ChatGPT challenge continuity");
  assert(keptNames.includes("__cflb@chatgpt.com"), "Cloudflare load-balancer cookie should be kept for ChatGPT challenge continuity");
  assert(keptNames.includes("_cfuvid@chatgpt.com"), "Cloudflare visitor cookie should be kept for ChatGPT challenge continuity");
  assert(keptNames.includes("sso@grok.com"), "Grok SSO cookie should be kept for Grok auth continuity");
  assert(keptNames.includes("sso-rw@x.ai"), "x.ai Grok SSO read-write cookie should be kept for Grok auth continuity");
  assert(keptNames.includes("auth_token@x.com"), "X auth token should be kept for Grok auth continuity");
  assert(keptNames.includes("ct0@x.com"), "X CSRF cookie should be kept for Grok auth continuity");
  assert(!keptNames.includes("guest_id@x.com"), "ambient X cookies should be dropped unless explicitly required for Grok auth");
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
  const kind = "job";
  const key = `tmp-lock-grace-${randomUUID()}`;
  const finalPath = hashedOracleStatePath(kind, key, getLocksDir());
  const finalName = basename(finalPath);
  const tempPath = join(getLocksDir(), `.tmp-${finalName}.${process.pid}.${Date.now()}.inflight`);

  try {
    await mkdir(tempPath, { recursive: false, mode: 0o700 });
    await sleep(ORACLE_METADATA_WRITE_GRACE_MS + 200);

    const removed = await sweepStaleLocks();
    assert(!removed.includes(tempPath), "sweep should not reclaim fresh in-flight .tmp-* lock dirs within the tmp grace window");
    assert(await pathExists(tempPath), "fresh in-flight .tmp-* lock dirs should still exist after a sweep");

    await writeFile(join(tempPath, "metadata.json"), `${JSON.stringify({ processPid: process.pid, source: "oracle-sanity-inflight-publisher" }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(tempPath, finalPath);

    const metadata = JSON.parse(await readFile(join(finalPath, "metadata.json"), "utf8")) as { source?: string };
    assert(metadata.source === "oracle-sanity-inflight-publisher", "in-flight publish should finish by atomically promoting the temp lock dir");
  } finally {
    await rm(tempPath, { recursive: true, force: true }).catch(() => undefined);
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

  const invalidRuntimeProfileDir = process.platform === "win32"
    ? join(process.env.LOCALAPPDATA ?? join(process.env.USERPROFILE ?? "C:\\Users\\Default", "AppData", "Local"), "Google", "Chrome", "User Data", "pi-oracle-invalid-runtime-profile")
    : "/dev/null/pi-oracle-invalid-runtime-profile";
  await updateJob(jobId, (job) => ({
    ...job,
    runtimeProfileDir: invalidRuntimeProfileDir,
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
  assert(extensionSource.includes('ctx.mode === "print" || ctx.mode === "json"'), "oracle extension should use Pi 0.78 mode metadata to skip background polling in one-shot modes");
  assert(extensionSource.includes("hasPersistedSessionFile(sessionFile)"), "oracle extension should refuse to start poller routing when the current session has no persisted identity");
  assert(extensionSource.includes("oracle: unavailable"), "oracle extension should mark oracle unavailable when no persisted session identity exists");
  assert(extensionSource.includes("if (ctx.hasUI) ctx.ui.notify"), "oracle extension should surface startup-maintenance failures through available session UI as well as stderr");
}

async function testOraclePromptTemplateCutover(): Promise<void> {
  const indexSource = await readFile(new URL("../extensions/oracle/index.ts", import.meta.url), "utf8");
  const commandsSource = await readFile(new URL("../extensions/oracle/lib/commands.ts", import.meta.url), "utf8");
  const toolsSource = await readFile(new URL("../extensions/oracle/lib/tools.ts", import.meta.url), "utf8");
  const archiveSource = await readFile(new URL("../extensions/oracle/lib/archive.ts", import.meta.url), "utf8");
  const configSource = await readFile(new URL("../extensions/oracle/lib/config.ts", import.meta.url), "utf8");
  const jobsSource = await readFile(new URL("../extensions/oracle/lib/jobs.ts", import.meta.url), "utf8");
  const pollerSource = await readFile(new URL("../extensions/oracle/lib/poller.ts", import.meta.url), "utf8");
  const queueSource = await readFile(new URL("../extensions/oracle/lib/queue.ts", import.meta.url), "utf8");
  const locksSource = await readFile(new URL("../extensions/oracle/lib/locks.ts", import.meta.url), "utf8");
  const runtimeSource = await readFile(new URL("../extensions/oracle/lib/runtime.ts", import.meta.url), "utf8");
  const workerSource = await readFile(new URL("../extensions/oracle/worker/run-job.mjs", import.meta.url), "utf8");
  const sharedStateSource = await readFile(new URL("../extensions/oracle/shared/state-coordination-helpers.mjs", import.meta.url), "utf8");
  const sharedJobCoordinationSource = await readFile(new URL("../extensions/oracle/shared/job-coordination-helpers.mjs", import.meta.url), "utf8");
  const sharedLifecycleSource = await readFile(new URL("../extensions/oracle/shared/job-lifecycle-helpers.mjs", import.meta.url), "utf8");
  const sharedObservabilitySource = await readFile(new URL("../extensions/oracle/shared/job-observability-helpers.mjs", import.meta.url), "utf8");
  const sharedProcessSource = await readFile(new URL("../extensions/oracle/shared/process-helpers.mjs", import.meta.url), "utf8");
  const supportSource = await readFile(new URL("./oracle-sanity-support.ts", import.meta.url), "utf8");
  const promptSource = await readFile(new URL("../prompts/oracle.md", import.meta.url), "utf8");
  const followUpPromptSource = await readFile(new URL("../prompts/oracle-followup.md", import.meta.url), "utf8");
  const designSource = await readFile(new URL("../docs/ORACLE_DESIGN.md", import.meta.url), "utf8");
  const recoveryDrillSource = await readFile(new URL("../docs/ORACLE_RECOVERY_DRILL.md", import.meta.url), "utf8");
  const readmeSource = await readFile(new URL("../README.md", import.meta.url), "utf8");
  const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as {
    files?: string[];
    pi?: { prompts?: string[]; extensions?: string[] };
    engines?: { node?: string };
    os?: string[];
    scripts?: Record<string, string | undefined> & { test?: string; prepublishOnly?: string; "typecheck:worker-helpers"?: string; "verify:oracle"?: string };
    overrides?: { "basic-ftp"?: string; protobufjs?: string };
    devDependencies?: Record<string, string | undefined>;
    peerDependencies?: Record<string, string | undefined>;
    peerDependenciesMeta?: Record<string, { optional?: boolean } | undefined>;
  };
  const pi = createPiHarness();
  registerOracleTools(pi as unknown as import("@earendil-works/pi-coding-agent").ExtensionAPI, "/tmp/fake-oracle-worker.mjs");
  const preflightTool = pi.tools.get("oracle_preflight");
  const authTool = pi.tools.get("oracle_auth");
  const submitTool = pi.tools.get("oracle_submit");
  assert(preflightTool, "oracle preflight tool should register for schema inspection");
  assert(authTool, "oracle auth tool should register for schema inspection");
  assert(submitTool, "oracle submit tool should register for schema inspection");
  const preflightProperties = asRecord(asRecord(preflightTool.parameters)?.properties);
  const authProperties = asRecord(asRecord(authTool.parameters)?.properties);
  const submitProperties = asRecord(asRecord(submitTool.parameters)?.properties);
  const submitFilesItems = asRecord(asRecord(submitProperties?.files)?.items);
  const submitConversationId = asRecord(submitProperties?.chatGptConversationId);
  const preflightConversationId = asRecord(preflightProperties?.chatGptConversationId);
  const gbnfSafeNonBlank = "^.*[^ \\t\\r\\n].*$";
  assert(preflightProperties !== undefined, "oracle preflight tool should expose an object schema");
  assert(authProperties !== undefined, "oracle auth tool should expose an object schema");
  assert(submitProperties, "oracle submit tool should expose an object schema");
  assert(submitFilesItems?.pattern === gbnfSafeNonBlank, "oracle submit files schema pattern should be anchored and avoid \\S (llama.cpp GBNF converter)");
  assert(submitConversationId?.pattern === gbnfSafeNonBlank, "oracle submit chatGptConversationId schema pattern should match the GBNF-safe non-blank guard");
  assert(preflightConversationId?.pattern === gbnfSafeNonBlank, "oracle preflight chatGptConversationId schema pattern should match the GBNF-safe non-blank guard");
  const schemaJson = JSON.stringify([...pi.tools.values()].map((tool) => tool.parameters));
  assert(pi.tools.size >= 5, "oracle should register preflight/auth/submit/read/cancel tools");
  assert(!schemaJson.includes("\\S"), "registered oracle tool schemas must not contain \\S (llama.cpp GBNF converter rejects it)");
  const representativePresetAliases: [string, OracleSubmitPresetId][] = [
    ["Pro-standard", "pro_standard"],
    ["Pro-extended", "pro_extended"],
    ["Thinking-standard", "thinking_standard"],
    ["Instant Auto-switch to Thinking Enabled", "instant_auto_switch"],
  ];

  assert(indexSource.includes('pi.on("input"'), "/oracle should be intercepted before TUI prompt-template expansion so verbose internals stay hidden");
  assert(indexSource.includes('["print", "json", "rpc"].includes(ctx.mode)'), "oracle prompt fallback should keep print/json/rpc prompt-template expansion available");
  assert(indexSource.includes('ctx.mode !== "tui"'), "oracle prompt interceptor should leave non-TUI modes to use prompt-template expansion");
  assert(indexSource.includes('display: false'), "oracle dispatch instructions should be injected as a hidden custom message");
  assert(indexSource.includes('pi.sendUserMessage(formatOracleUserCommand'), "oracle TUI interceptor should persist the compact slash request as a real user message for prompt-history reloads");
  assert(indexSource.includes('pi.on("before_agent_start"'), "oracle TUI interceptor should inject hidden dispatch instructions on the reinjected user-message turn");
  assert(indexSource.includes('Preparing oracle job… running preflight'), "oracle command should show compact user-facing status before hidden dispatch");
  assert(promptSource.includes("You are preparing an /oracle job."), "/oracle internal dispatch prompt should contain the oracle dispatch instructions");
  assert(followUpPromptSource.includes("You are preparing an `/oracle-followup` job."), "/oracle-followup prompt template should contain follow-up dispatch instructions");
  assert(followUpPromptSource.includes("Call `oracle_preflight` immediately"), "/oracle-followup prompt should require an immediate oracle_preflight guard");
  assert(followUpPromptSource.includes("Usage: /oracle-followup <job-id> <request>"), "/oracle-followup prompt should document the required usage contract for job id plus follow-up request");
  assert(followUpPromptSource.includes("followUpJobId"), "/oracle-followup prompt should explicitly route the parsed job id through oracle_submit.followUpJobId");
  assert(followUpPromptSource.includes("Bias toward context-rich submissions when they fit within the provider archive ceiling"), "/oracle-followup prompt should prefer context-rich archives within the configured upload ceiling");
  assert(followUpPromptSource.includes("Do not call `oracle_auth` automatically"), "/oracle-followup prompt should stop on auth blockers instead of launching auth automatically");
  assert(followUpPromptSource.includes("details.error.code === \"archive_too_large\""), "/oracle-followup prompt should explicitly recognize retryable archive_too_large submit failures");
  assert(followUpPromptSource.includes("after at most two total `oracle_submit` attempts"), "/oracle-followup prompt should cap automatic archive-too-large retries");
  assert(followUpPromptSource.includes("nearby files, tests, docs, configs, and adjacent modules"), "/oracle-followup prompt should preserve relevant surrounding context for narrow follow-up requests");
  for (const sharedPromptContract of [
    "Do not plan instead of submitting",
    "Do not claim preflight, auth, archive prep, or submission happened unless the matching tool call actually happened",
    "If a required tool call is unavailable or fails, stop and report that exact blocker instead of fabricating progress",
    "After a successful or queued `oracle_submit`, your final answer must be only a terse dispatch summary",
    "Do not ask questions, offer to watch/poll/read, list next steps, or continue working",
  ]) {
    assert(promptSource.includes(sharedPromptContract), `/oracle prompt should include shared hard dispatch contract: ${sharedPromptContract}`);
    assert(followUpPromptSource.includes(sharedPromptContract), `/oracle-followup prompt should include shared hard dispatch contract: ${sharedPromptContract}`);
  }
  assert(promptSource.includes("Call `oracle_preflight` immediately"), "/oracle prompt should require an immediate oracle_preflight guard before repo context gathering");
  assert(promptSource.includes("Do not read files, search the codebase, prepare archive inputs, or call `oracle_auth` automatically"), "/oracle prompt should forbid expensive prep and automatic auth before preflight passes");
  assert(promptSource.includes("Do not plan instead of submitting"), "/oracle prompt should explicitly forbid planning instead of dispatching");
  assert(promptSource.includes("Do not claim preflight, auth, archive prep, or submission happened unless the matching tool call actually happened"), "/oracle prompt should forbid fabricated preflight/submission claims");
  assert(promptSource.includes("If the user explicitly says ChatGPT Instant or Instant, use provider `chatgpt` and preset `instant`"), "/oracle prompt should hard-route explicit ChatGPT Instant requests to the chatgpt instant preset");
  assert(promptSource.includes("Do not ask questions, offer to watch/poll/read, list next steps, or continue working"), "/oracle prompt should forbid post-dispatch follow-up offers");
  assert(promptSource.includes("Bias toward context-rich submissions when they fit within the provider archive ceiling"), "/oracle prompt should bias toward context-rich pre-submit context gathering within the upload ceiling");
  assert(promptSource.includes("Do not call `oracle_auth` automatically"), "/oracle prompt should stop on auth blockers instead of launching auth automatically");
  assert(promptSource.includes("details.error.code === \"archive_too_large\""), "/oracle prompt should explicitly recognize retryable archive_too_large submit failures");
  assert(promptSource.includes("If the user scope is explicit and narrow"), "/oracle prompt should recognize explicit narrow requests before broad repo exploration");
  assert(promptSource.includes("Do not keep exploring once you already have enough context to submit well"), "/oracle prompt should bias toward dispatch once enough context is in hand");
  assert(promptSource.includes("`preset`"), "/oracle prompt should document oracle_submit preset parameter");
  assert(promptSource.includes("For ChatGPT, **`preset`** is the only model-selection parameter"), "/oracle prompt should state preset is the only ChatGPT selector");
  assert(promptSource.includes("provider: \"grok\""), "/oracle prompt should document Grok provider routing");
  assert(promptSource.includes("chatGptConversationId"), "/oracle prompt should route explicit existing ChatGPT conversation ids through oracle_submit.chatGptConversationId");
  assert(promptSource.includes("Omit `chatGptConversationId` unless the user explicitly asks"), "/oracle prompt should preserve fresh-thread defaults unless an existing ChatGPT thread is explicit");
  assert(promptSource.includes("6a28ab5c-e4d4-83e8-b8be-dd39f38a26d6"), "/oracle prompt should show the existing ChatGPT conversation id shape agents should recognize");
  assert(promptSource.includes("canonical preset registry"), "/oracle prompt should point callers to the canonical registry instead of a hard-coded preset list");
  assert(promptSource.includes("Do not pass `modelFamily`, `effort`, or `autoSwitchToThinking`"), "/oracle prompt should tell callers not to pass legacy fields");
  assert(promptSource.includes("Matching human-readable preset labels"), "/oracle prompt should explain preset label normalization");
  assert(promptSource.includes("If unsure, omit **`preset`** and use the configured default"), "/oracle prompt should prefer the configured default preset instead of asking the user when unsure");
  assert(!promptSource.includes("If unsure which preset fits the task, ask the user."), "/oracle prompt should no longer tell agents to ask the user when preset choice is merely uncertain");
  for (const presetId of Object.keys(ORACLE_SUBMIT_PRESETS)) {
    if (presetId === "instant") continue;
    assert(!promptSource.includes(presetId), `/oracle prompt should not hard-code preset id ${presetId}`);
  }
  assert(promptSource.includes("prefer context-rich archives up to the provider ceiling"), "/oracle prompt should tell agents to use the available archive budget generously when it improves answer quality");
  assert(promptSource.includes("include the whole repository by passing `.`"), "/oracle prompt should default to whole-repo archive selection");
  assert(promptSource.includes("obvious credentials/private data"), "/oracle prompt should mention default exclusion of obvious credentials/private data");
  assert(promptSource.includes("nested `secrets/` directories anywhere in the repo"), "/oracle prompt should exclude nested secrets directories by default");
  assert(promptSource.includes("Do not default to a one-file archive just because the user mentioned one file"), "/oracle prompt should preserve surrounding context even for targeted asks when the archive budget allows it");
  assert(promptSource.includes("the `.git` directory is not included in oracle exports"), "/oracle prompt should tell review/ship-readiness requests to create and include a git diff bundle file");
  assert(promptSource.includes("submit automatically prunes the largest nested directories matching generic generated-output names"), "/oracle prompt should describe whole-repo auto-pruning when archives are still too large");
  assert(promptSource.includes("outside obvious source roots like `src/` and `lib/`"), "/oracle prompt should describe the source-root guard for auto-pruning");
  assert(promptSource.includes("If a submitted oracle job later fails because upload is rejected"), "/oracle prompt should describe the post-submit upload-rejection fallback ladder");
  assert(promptSource.includes("fails before dispatch with `details.error.code === \"archive_too_large\"` or an upload-limit message"), "/oracle prompt should distinguish retryable submit-time oversize failures from other submit-time errors");
  assert(promptSource.includes("after at most two total `oracle_submit` attempts"), "/oracle prompt should cap automatic archive-too-large retries");
  assert(promptSource.includes("For any other `oracle_submit` submit-time error, stop and report the error"), "/oracle prompt should still stop immediately on non-archive submit-time errors");
  assert(promptSource.includes("After a successful or queued `oracle_submit`, end your turn"), "/oracle prompt should only end the turn after successful/queued submit results, not retryable oversize failures");
  assert(promptSource.includes("If `oracle_submit` returns a queued job instead of an immediately dispatched one, treat that as success"), "/oracle prompt should explain queued oracle submissions as successful waits");
  assert(designSource.includes("`oracle_preflight`"), "design doc should document the oracle_preflight tool");
  assert(designSource.includes("`oracle_auth`"), "design doc should document the agent-facing oracle_auth tool");
  assert(designSource.includes("`/oracle-followup <job-id> <request>`"), "design doc should document the user-facing follow-up command");
  assert(designSource.includes("`chatGptConversationId` into a user/browser-created ChatGPT"), "design doc should document explicit existing ChatGPT browser thread targeting");
  assert(designSource.includes("Omit both for the default fresh-thread behavior"), "design doc should state thread-target options preserve fresh-thread defaults when omitted");
  assert(designSource.includes("call `oracle_preflight` immediately"), "design doc should describe the /oracle preflight-first flow");
  assert(designSource.includes("bias toward context-rich archives when they fit within the provider ceiling"), "design doc should describe the context-rich /oracle flow within the upload ceiling");
  assert(designSource.includes("retryable archive-selection miss"), "design doc should explain that archive-too-large submit failures are retryable archive-selection misses");
  assert(designSource.includes("biases toward omitting provider/model fields and using configured defaults"), "design doc should explain the default provider/model bias for /oracle prompt ergonomics");
  assert(designSource.includes("the canonical registry is `ORACLE_SUBMIT_PRESETS`"), "design doc should point to the canonical preset registry");
  assert(designSource.includes("/tmp/pi-oracle-auth-*/oracle-auth.log"), "design doc should reference the per-run oracle-auth diagnostics bundle");
  assert(designSource.includes("returns a retry-after timestamp"), "design doc should explain that oracle-clean returns a retry-after timestamp when retention grace blocks cleanup");
  assert(recoveryDrillSource.includes("/tmp/pi-oracle-auth-*/"), "recovery drill should reference the per-run oracle-auth diagnostics bundle");
  assert(!recoveryDrillSource.includes("/tmp/oracle-auth.log"), "recovery drill should not reference the old fixed oracle-auth log path");
  assert(designSource.includes("For ChatGPT, **`preset` is the only model-selection parameter"), "design doc should state preset is the only ChatGPT selector");
  assert(designSource.includes("matching human-readable labels/common hyphen-space variants"), "design doc should mention preset label normalization");
  assert(designSource.includes("chromiumKeychain"), "design doc should document configured Chromium keychain cookie sources");
  assert(designSource.includes("SWEET_COOKIE_LINUX_KEYRING"), "design doc should document Sweet Cookie Linux keyring options");
  assert(designSource.includes("defaults to `apfs-clone` on macOS and `copy` on Linux"), "design doc should document platform-specific clone strategy defaults");
  for (const presetId of Object.keys(ORACLE_SUBMIT_PRESETS)) {
    assert(!designSource.includes(presetId), `design doc should not hard-code preset id ${presetId}`);
  }
  assert(toolsSource.includes("call oracle_auth at most once before retrying"), "oracle submit tool guidance should tell agents to refresh auth once before retrying stale-auth failures");
  assert(toolsSource.includes("details.error.code is 'archive_too_large'"), "oracle submit tool guidance should explicitly recognize retryable archive_too_large failures");
  assert(toolsSource.includes("retry once with a smaller archive"), "oracle submit tool guidance should tell agents to retry archive-too-large failures once");
  assert(toolsSource.includes("After a successful or queued oracle_submit, stop"), "oracle submit tool guidance should only stop after successful/queued submit results, not retryable oversize failures");
  assert(toolsSource.includes("Use context-rich archives when they fit"), "oracle tool guidance should tell agents to use the available archive budget when it helps");
  assert(toolsSource.includes('name: "oracle_auth"'), "oracle tools should register an agent-facing oracle_auth tool");
  assert(toolsSource.includes("use files='.' for broad repo-wide asks"), "oracle tool guidance should align with whole-repo archive defaults");
  assert(toolsSource.includes("Default exclusions already skip common bulky outputs"), "oracle tool guidance should summarize default archive exclusions");
  assert(toolsSource.includes("resolveOracleSubmitPreset"), "oracle submit should resolve preset via config helper");
  assert(toolsSource.includes("coerceOracleSubmitPresetId"), "oracle submit should normalize preset label aliases before resolving the canonical preset id");
  assert(toolsSource.includes("ORACLE_SUBMIT_PRESETS registry"), "oracle submit tool description should point preset discovery to the canonical registry");
  assert(!toolsSource.includes("see `preset` field for canonical ids"), "oracle submit tool description should not imply the free-form preset schema exposes canonical ids");
  assert(toolsSource.includes("For ChatGPT, use preset only when the user requests model control"), "oracle tool guidance should say preset is the ChatGPT selector");
  assert(toolsSource.includes("omit it for configured defaults") && toolsSource.includes("matching labels are normalized"), "oracle tool description should mention preset defaults and label normalization");
  assert(!toolsSource.includes("Do not pass modelFamily, effort, or autoSwitchToThinking"), "oracle tool guidance should no longer carry legacy-field prose lists when preset-only guidance already covers the contract");
  assert(readmeSource.includes("Start a normal persisted `pi` session"), "README quickstart should surface the persisted-session requirement before oracle usage");
  assert(readmeSource.includes("/oracle-followup <job-id> <request>"), "README should document the user-facing same-thread follow-up command shape");
  assert(readmeSource.includes("chatGptConversationId"), "README should document explicit existing ChatGPT thread targeting through chatGptConversationId");
  assert(readmeSource.includes("Normal `/oracle` jobs still start a fresh provider thread"), "README should state existing ChatGPT thread targeting is opt-in and defaults remain fresh-thread");
  assert(readmeSource.includes("6a28ab5c-e4d4-83e8-b8be-dd39f38a26d6"), "README should include an existing ChatGPT conversation id example");
  assert(readmeSource.includes("/oracle-read [job-id]"), "README should document the user-facing oracle-read command");
  assert(readmeSource.includes("The `/oracle` prompt now runs an early oracle preflight"), "README quickstart should explain the early oracle preflight guard");
  assert(readmeSource.includes("context-rich relevant archive up to the selected provider's upload ceiling"), "README should explain the context-rich archive bias for narrow /oracle requests within the upload ceiling");
  assert(readmeSource.includes("docs/platform-smoke.md") && readmeSource.includes("npm run smoke:platform:all"), "README should document the Crabbox macOS/Ubuntu/Windows platform smoke gate");
  assert(designSource.includes("docs/platform-smoke.md") && designSource.includes("npm run smoke:platform:all"), "design docs should link the macOS/Ubuntu/Windows platform smoke source of truth");
  assert(readmeSource.includes("retryable archive-selection failure"), "README should explain that archive-too-large local packing failures are retryable and should auto-narrow before surfacing to the user");
  assert(readmeSource.includes("omit `preset` and use the configured default model"), "README should explain the default-preset bias for /oracle prompt ergonomics");
  assert(readmeSource.includes("Archive README.md plus any nearby docs or implementation files that help answer accurately"), "README should include a narrow /oracle example that still keeps relevant surrounding context");
  assert(readmeSource.includes("Agent preflights, then gathers a context-rich relevant repo slice"), "README high-level flow should reflect the context-rich /oracle path");
  assert(readmeSource.includes("`oracle_preflight`"), "README should document the oracle_preflight agent-facing tool");
  assert(readmeSource.includes("`oracle_auth`"), "README should document the oracle_auth agent-facing tool");
  assert(readmeSource.includes("chromiumKeychain"), "README should document configured Chromium keychain cookie sources");
  assert(readmeSource.includes("SWEET_COOKIE_LINUX_KEYRING"), "README should document Sweet Cookie Linux keyring options");
  assert(readmeSource.includes("macOS, Linux, or Windows native"), "README should document Linux and Windows native as supported platforms");
  assert(readmeSource.includes("leave `auth.chromiumKeychain` unset"), "README should explain Linux uses Sweet Cookie options instead of macOS Keychain config");
  assert(readmeSource.includes("oracle_auth({})"), "README should explain that agent callers can refresh stale oracle auth through oracle_auth before retrying once");
  assert(readmeSource.includes("/oracle-cancel <job-id>"), "README should document oracle-cancel as an explicit-id command");
  assert(!readmeSource.includes("/oracle-cancel [job-id]"), "README should no longer imply that oracle-cancel guesses a latest-job default");
  assert(readmeSource.includes("Agent callers can use `oracle_read({ jobId })`"), "README should frame oracle_read as the agent-facing fallback instead of the primary user-facing wake-up path");
  assert(readmeSource.includes("list recent job ids when no explicit id is given"), "README should explain that oracle-status helps users discover job ids for follow-up and cancel flows");
  assert(!readmeSource.includes("oracle_read(jobId)"), "README should no longer document the old raw oracle_read(jobId) user-facing wording");
  assert(readmeSource.includes("/oracle-clean <job-id|all>"), "README should document the oracle-clean command");
  assert(readmeSource.includes("recently woken terminal jobs may stay retained briefly"), "README command summary should explain that oracle-clean can briefly retain terminal jobs after wake-up delivery");
  assert(readmeSource.includes("returns the next eligible cleanup time"), "README should explain that oracle-clean returns a retry-after hint when post-send retention grace blocks cleanup");
  assert(readmeSource.includes("### `/oracle-clean` refuses a terminal job right after completion"), "README troubleshooting should explain oracle-clean retention-grace refusals");
  assert(readmeSource.includes("Retry after ..."), "README troubleshooting should mention the oracle-clean retry-after hint");
  assert(readmeSource.includes("## Available providers and presets"), "README should document available oracle preset ids");
  assert(readmeSource.includes("Grok") && readmeSource.includes("200 MiB"), "README should document Grok provider upload ceiling");
  assert(readmeSource.includes("250 MiB for ChatGPT") && designSource.includes("250 MiB for ChatGPT") && promptSource.includes("250 MiB for ChatGPT") && followUpPromptSource.includes("250 MiB for ChatGPT"), "README/design/prompts should use MiB wording for ChatGPT upload ceiling");
  assert(readmeSource.includes("Node.js 22.19.0 or newer") && readmeSource.includes("Node 24+ per `platform-smoke.config.mjs`"), "README should distinguish package Node floor from Node 24 platform validation");
  assert(readmeSource.includes("npm run check:platform-smoke") && readmeSource.includes("npm run sanity:oracle:platform"), "README verification table should include the cheap platform-focused validation commands");
  assert(readmeSource.includes("Grok uploads now use `.tar.gz` archives"), "README should document Grok's gzip archive format because Grok lacks zstd extraction tools");
  assert(readmeSource.includes("defaults.preset"), "README should document defaults.preset");
  assert(readmeSource.includes("human-readable preset label"), "README should mention preset label normalization");
  for (const [presetId, preset] of Object.entries(ORACLE_SUBMIT_PRESETS) as [OracleSubmitPresetId, (typeof ORACLE_SUBMIT_PRESETS)[OracleSubmitPresetId]][]) {
    assert(readmeSource.includes(`\`${presetId}\``), `README should list preset id ${presetId}`);
    assert(readmeSource.includes(preset.label), `README should describe preset ${presetId} with label ${preset.label}`);
  }
  const preflightSchema = preflightTool.parameters as import("typebox").TSchema;
  const authSchema = authTool.parameters as import("typebox").TSchema;
  const submitSchema = submitTool.parameters as import("typebox").TSchema;
  assert(Check(preflightSchema, {}), "oracle_preflight should accept an empty object");
  assert(Check(preflightSchema, { provider: "grok" }), "oracle_preflight should accept optional provider selection");
  assert(!Check(preflightSchema, { provider: "unsupported" }), "oracle_preflight should reject providers outside the Google-compatible StringEnum schema");
  assert(Check(preflightSchema, { followUpJobId: "sanity-job" }), "oracle_preflight should accept optional follow-up job id selection");
  assert(Check(preflightSchema, { provider: "chatgpt", chatGptConversationId: "6a28ab5c-e4d4-83e8-b8be-dd39f38a26d6" }), "oracle_preflight should accept optional existing ChatGPT conversation id selection");
  assert(Check(authSchema, {}), "oracle_auth should accept an empty object");
  assert(asRecord(preflightProperties?.provider)?.type === "string", "oracle_preflight should expose optional provider selection for provider-specific readiness checks");
  assert(asRecord(preflightProperties?.followUpJobId)?.type === "string", "oracle_preflight should expose optional follow-up job id selection for same-thread readiness checks");
  assert(asRecord(preflightProperties?.chatGptConversationId)?.type === "string", "oracle_preflight should expose optional existing ChatGPT conversation id selection for browser-created threads");
  assert(!Array.isArray((asRecord(preflightTool.parameters)?.required)), "oracle_preflight should not require caller arguments");
  assert(asRecord(authProperties?.provider)?.type === "string", "oracle_auth should expose optional provider selection for provider-specific auth refresh");
  assert(!Array.isArray((asRecord(authTool.parameters)?.required)), "oracle_auth should not require caller arguments");
  assert(asRecord(submitProperties.preset)?.type === "string", "oracle submit preset schema should validate preset as a string before execute-time normalization");
  assert(asRecord(submitProperties.chatGptConversationId)?.type === "string", "oracle submit schema should expose optional existing ChatGPT conversation id targeting");
  assert(
    Check(submitSchema, { prompt: "sanity", files: ["README.md"], provider: "chatgpt", chatGptConversationId: "6a28ab5c-e4d4-83e8-b8be-dd39f38a26d6" }),
    "oracle_submit tool-call validation should accept an explicit existing ChatGPT conversation id",
  );
  assert(
    !Check(submitSchema, { prompt: "sanity", files: ["README.md"], chatGptConversationId: "   " }),
    "oracle_submit tool-call validation should reject blank existing ChatGPT conversation ids",
  );
  const normalizedExistingChat = resolveChatGptConversationReference("6a28ab5c-e4d4-83e8-b8be-dd39f38a26d6", DEFAULT_CONFIG);
  assert(normalizedExistingChat?.chatUrl === "https://chatgpt.com/c/6a28ab5c-e4d4-83e8-b8be-dd39f38a26d6", "oracle_submit should normalize raw existing ChatGPT conversation ids to a conversation URL");
  const normalizedExistingChatUrl = resolveChatGptConversationReference("https://chat.openai.com/c/6a28ab5c-e4d4-83e8-b8be-dd39f38a26d6?model=gpt", DEFAULT_CONFIG);
  assert(normalizedExistingChatUrl?.chatUrl === "https://chat.openai.com/c/6a28ab5c-e4d4-83e8-b8be-dd39f38a26d6", "oracle_submit should preserve allowed ChatGPT URL origins while stripping query/hash for existing thread targeting");
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
    !Check(submitSchema, { prompt: "sanity", files: ["README.md"], provider: "grok", mode: "unsupported" }),
    "oracle_submit tool-call validation should reject modes outside the Google-compatible StringEnum schema",
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
  assert(runtimeSource.includes('"AGENTS.md"'), "runtime workspace-root detection should recognize project markers like AGENTS.md before widening to unrelated ancestor git roots");
  assert(runtimeSource.includes("Configured oracle browser executable does not exist"), "runtime submit preflight should surface missing configured browser executables clearly");
  assert(runtimeSource.includes("Oracle prerequisite not found on PATH"), "runtime submit preflight should surface missing local dependencies clearly");
  assert(runtimeSource.includes('await assertWritableDirectory(config.browser.runtimeProfilesDir, "runtime profiles")'), "runtime submit preflight should validate runtime profile directory writability before submit");
  assert(runtimeSource.includes('await assertWritableDirectory(getOracleJobsDir(), "jobs")'), "runtime submit preflight should validate the canonical jobs directory helper before submit");
  assert(runtimeSource.includes("assertOracleSubmitPrerequisites"), "runtime should expose a submit-side preflight helper for locally knowable blockers");
  assert(runtimeSource.includes("Oracle auth seed profile is not readable"), "runtime submit preflight should surface unreadable auth seed profiles clearly");
  assert(toolsSource.includes("const projectCwd = getProjectId(ctx.cwd);"), "oracle submit should derive a stable workspace-root cwd before loading config or resolving archives");
  assert(toolsSource.includes("loadOracleConfig(projectCwd, { projectConfigTrustCwd: ctx.cwd, projectConfigTrusted: isOracleProjectTrusted(ctx) })"), "oracle submit should load config from the stable workspace-root cwd while checking trust against the session cwd");
  assert(toolsSource.includes("resolveArchiveInputs(projectCwd, params.files)"), "oracle submit should resolve archive inputs from the stable workspace-root cwd");
  assert(toolsSource.includes("createArchive(projectCwd, params.files, tempArchivePath"), "oracle submit should build archives from the stable workspace-root cwd");
  assert(toolsSource.includes("resolveOracleProviderArchivePlan(selection.provider)"), "oracle submit should select archive format, extension, and size limit from the resolved provider archive plan");
  assert(toolsSource.includes("requirePersistedSessionFile(getSessionFile(ctx), \"submit oracle jobs\")"), "oracle submit should reject no-session contexts instead of collapsing them onto a project-level ephemeral session id");
  assert(toolsSource.includes("await assertOracleSubmitPrerequisites(config, provider);"), "oracle submit should preflight locally knowable blockers against the selected provider before archiving or persisting jobs");
  assert(toolsSource.includes("buildOracleToolErrorResult"), "oracle tools should centralize structured error payload creation");
  assert(toolsSource.includes('pi.on("tool_result"'), "oracle tools should register a tool_result hook so structured oracle errors still surface with isError=true");
  assert(toolsSource.includes("job: redactJobDetails(job"), "oracle submit should now return structured job details under details.job");
  assert(!toolsSource.includes("details: {\n            jobId:"), "oracle submit should no longer expose legacy top-level detail fields like jobId instead of details.job");
  assert(toolsSource.includes("artifactsPath: `${getJobDir(current.id)}/artifacts`"), "oracle read should derive artifact paths from the configured jobs dir instead of hard-coding /tmp");
  assert(toolsSource.includes("source: \"oracle_read\""), "oracle read should pass explicit settlement provenance when a terminal job has been manually read");
  assert(commandsSource.includes('registerCommand("oracle-read"'), "oracle commands should register a user-facing oracle-read command");
  assert(commandsSource.includes("source: \"oracle_status\""), "oracle status should pass explicit settlement provenance when a terminal job has been manually inspected");
  assert(commandsSource.includes("source: \"oracle_read_command\""), "oracle-read should settle further wake-up retries through explicit command provenance");
  assert(commandsSource.includes("Recent jobs:"), "oracle-status should help users discover job ids when no explicit id is given");
  assert(commandsSource.includes("ctx.mode === \"print\""), "oracle commands should emit stdout-friendly output in pi print mode");
  assert(commandsSource.includes("oracle-command-output"), "oracle commands should emit displayed custom messages when no UI is available, such as pi JSON mode");
  assert(commandsSource.includes("Usage: /oracle-cancel <job-id>"), "oracle cancel command should require an explicit job id instead of silently cancelling the latest job");
  assert(jobsSource.includes("requirePersistedSessionFile(originSessionFile, \"create oracle jobs\")"), "oracle jobs should require a persisted session identity at creation time");
  assert(toolsSource.includes("obvious credentials/private data"), "oracle tool guidance should mention default exclusion of obvious credentials/private data");
  assert(promptSource.includes("submit automatically prunes the largest nested directories matching generic generated-output names"), "oracle prompt should describe whole-repo auto-pruning when archives are still too large");
  assert(promptSource.includes("outside obvious source roots like `src/` and `lib/`"), "oracle prompt should describe the source-root guard for auto-pruning");
  assert(toolsSource.includes("After a successful or queued oracle_submit, stop"), "oracle tool guidance should explain queued oracle submissions as successful waits");
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
  assert(!pollerSource.includes('readiness === "ready" ? "success"'), "poller should not color the idle ready footer as a success state");
  assert(pollerSource.includes('snapshot.ui.setStatus("oracle", statusText);'), "poller should leave idle ready/loaded/queued oracle footer states in the default footer text color");
  assert(pollerSource.includes('counts.active > 0') && pollerSource.includes('snapshot.ui.theme.fg("success", statusText)'), "poller should color running oracle jobs as success");
  assert(pollerSource.includes('readiness === "auth_needed" || readiness === "config_error"') && pollerSource.includes('snapshot.ui.theme.fg("error", statusText)'), "poller should color broken oracle readiness states as error");
  assert(pollerSource.includes("stopAllPollers"), "poller module should expose a way for the sanity harness to stop all background pollers before isolated-state teardown");
  assert(pollerSource.includes("waitForAllPollersToQuiesce"), "poller module should expose a way for the sanity harness to wait for in-flight scans before teardown");
  assert(pollerSource.indexOf("await recordNotificationTarget(jobId, notificationClaimant") < pollerSource.indexOf("const preWakeupLiveWakeupTargets = await resolveLiveWakeupTargets();"), "poller should finish recording the intended wake-up target before the final live-target recheck");
  assert(pollerSource.indexOf("const preWakeupLiveWakeupTargets = await resolveLiveWakeupTargets();") < pollerSource.indexOf("requestWakeupTurn(pi, deliverable)"), "poller should perform the final live-target recheck before sending a best-effort wake-up");
  assert(pollerSource.includes("const deliverable = readJob(jobId);"), "poller should re-read the job immediately before send so deleted/pruned jobs cannot emit stale wake-ups");
  assert(pollerSource.includes("if (!deliverable || shouldPruneTerminalJob(deliverable, Date.now())) {"), "poller should abort wake-up delivery if the job was deleted or became prunable before send");
  assert(pollerSource.indexOf("await noteWakeupRequested(jobId)") < pollerSource.indexOf("requestWakeupTurn(pi, deliverable)"), "poller should record wake-up intent before sending so manual reads cannot race ahead of delivery state");
  assert(pollerSource.indexOf("await markJobNotified(jobId, notificationClaimant") < pollerSource.indexOf("requestWakeupTurn(pi, deliverable)"), "poller should mark one-time wake-up delivery as notified before sending so duplicate scans cannot queue repeated completion messages");
  assert(pollerSource.includes("if (!notedWakeup) {"), "poller should tolerate a job disappearing before the wake-up send path");
  assert(pollerSource.includes("requestWakeupTurn(pi, deliverable)"), "poller should deliver completion follow-ups as best-effort wake-up turns instead of direct durable session-history writes");
  assert(pollerSource.includes("buildOracleWakeupNotificationContent(job"), "poller wake-up turns should include durable response/artifact paths from job state via the shared observability helper");
  assert(pollerSource.includes("responseAvailable: Boolean(job.responsePath && existsSync(job.responsePath))"), "poller wake-up turns should hide missing response paths when no response file was actually written");
  assert(sharedObservabilitySource.includes("Use /oracle-read"), "poller wake-up content should direct receivers to /oracle-read as the primary saved-result path");
  assert(sharedObservabilitySource.includes("/oracle-status"), "poller wake-up content should still mention /oracle-status as the metadata-oriented fallback path");
  assert(sharedObservabilitySource.includes("oracle_read({ jobId:"), "poller wake-up content should still mention oracle_read for agent callers who need tool output in-turn");
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
  assert(jobsSource.includes("maxRetries: ORACLE_JOB_DIR_RM_MAX_RETRIES"), "terminal job removal should retry recursive job-dir deletion to stabilize transient ENOTEMPTY cleanup races");
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
  assert(runtimeSource.includes("copyDirectory(seedDir, runtimeProfileDir"), "extension-side runtime profile cloning should use Node recursive copy off macOS instead of requiring POSIX cp on Windows/Linux");
  assert(runtimeSource.includes("removeChromiumProcessSingletonArtifacts"), "runtime profile cloning should scrub Chromium singleton artifacts copied from seed profiles");
  assert(workerSource.includes("PI_ORACLE_CP_PATH") && !workerSource.includes('spawnCommand("/bin/cp"'), "worker profile cloning should resolve cp from PATH on Linux/Nix instead of hard-coding /bin/cp");
  assert(toolsSource.includes("MAX_QUEUED_JOBS_PER_ACTIVE_RUNTIME"), "oracle submit should cap queued depth to avoid unbounded archive buildup");
  assert(toolsSource.includes("MAX_QUEUED_ARCHIVE_BYTES_PER_ACTIVE_RUNTIME"), "oracle submit should cap queued archive bytes to avoid filling tmp with queued jobs");
  assert(toolsSource.includes("hasRetainedPreSubmitArchive"), "queued archive pressure should count retained pre-submit archives, not just currently queued jobs");
  assert(toolsSource.includes("queued jobs and retained pre-submit archives"), "queued archive admission errors should explain that stranded pre-submit archives count against the byte cap");
  assert(pkg.files?.includes("prompts"), "package.json files should include internal oracle command prompts");
  assert(pkg.pi?.extensions?.includes("./extensions/oracle/index.ts"), "package.json pi.extensions should include oracle extension entrypoint");
  assert(pkg.pi?.prompts?.includes("./prompts"), "package.json should register oracle prompts so TUI slash completion can discover /oracle and /oracle-followup");
  assert(pkg.engines?.node === ">=22.19.0", "package.json should advertise the actual Node.js support floor without an upper bound");
  assert(pkg.os?.includes("darwin") && pkg.os?.includes("linux") && pkg.os?.includes("win32"), "package.json should declare macOS, Linux, and Windows native support");
  assert(pkg.scripts?.test === "npm run verify:oracle", "package.json should expose the local verification gate through npm test");
  assert(pkg.scripts?.["typecheck:worker-helpers"] === "tsc --noEmit -p tsconfig.worker-helpers.json", "package.json should statically typecheck extracted worker/auth helpers");
  assert(pkg.scripts?.["check:platform-smoke"]?.includes("scripts/platform-smoke/targets.mjs"), "package.json should syntax-check the Crabbox platform smoke runner");
  assert(pkg.scripts?.["check:platform-smoke"]?.includes("scripts/platform-smoke/invariants.mjs"), "package.json should run platform-smoke invariants during syntax checks");
  assert(String(pkg.scripts?.["check:oracle-real-smoke"] || "").includes("scripts/oracle-sanity-runner.mjs"), "package.json should syntax-check the oracle sanity runner wrapper");
  assert(pkg.scripts?.["smoke:platform:doctor"] === "node scripts/platform-smoke.mjs doctor", "package.json should expose the Crabbox platform-smoke doctor");
  assert(pkg.scripts?.["smoke:platform:macos"] === "node scripts/platform-smoke.mjs run --target macos", "package.json should expose the macOS Crabbox platform smoke gate");
  assert(pkg.scripts?.["smoke:platform:ubuntu"] === "node scripts/platform-smoke.mjs run --target ubuntu", "package.json should expose the Ubuntu Crabbox platform smoke gate");
  assert(pkg.scripts?.["smoke:platform:windows-native"] === "node scripts/platform-smoke.mjs run --target windows-native", "package.json should expose the Windows native Crabbox platform smoke gate");
  assert(pkg.scripts?.["smoke:platform:all"] === "npm run smoke:platform:doctor && node scripts/platform-smoke.mjs run --target macos,ubuntu,windows-native", "package.json should run the required macOS, Ubuntu, and Windows native Crabbox gates together after doctor");
  assert(pkg.files?.includes("platform-smoke.config.mjs") && pkg.files?.includes("scripts/platform-smoke.mjs") && pkg.files?.includes("scripts/platform-smoke"), "package files should include the Crabbox platform smoke harness");
  assert(String(pkg.scripts?.["verify:oracle"] || "").includes("typecheck:worker-helpers"), "full local verification should include worker/auth helper typechecking");
  assert(String(pkg.scripts?.["verify:oracle"] || "").includes("check:platform-smoke"), "full local verification should include platform smoke syntax checks");
  assert(String(pkg.scripts?.["verify:oracle"] || "").includes("check:oracle-real-smoke"), "full local verification should include real smoke harness syntax checks");
  assert(pkg.scripts?.["smoke:real"] === "npm run smoke:real:packed", "package.json should make the default real isolated pi-agent smoke packed-install proof");
  assert(pkg.scripts?.["smoke:real:packed"] === "node scripts/oracle-real-smoke.mjs run --mode packed", "package.json should expose the packed real isolated pi-agent smoke gate");
  assert(pkg.scripts?.["smoke:real:source"] === "node scripts/oracle-real-smoke.mjs run --mode source", "package.json should expose source-mode real smoke only as an explicit debug path");
  assert(pkg.scripts?.["smoke:real:doctor"] === "node scripts/oracle-real-smoke.mjs doctor", "package.json should expose the real isolated pi-agent smoke doctor");
  assert(String(pkg.scripts?.["release:check"] || "").includes("npm run smoke:platform:all"), "release checks should require the doctor-first platform smoke gate");
  assert(pkg.scripts?.prepublishOnly === "npm run release:check", "package publishing should be guarded by the release verification gate");
  assert(pkg.devDependencies?.["@earendil-works/pi-coding-agent"] === "^0.80.9", "package.json should use the current Pi 0.80.9 local development baseline");
  assert(pkg.devDependencies?.["@earendil-works/pi-ai"] === "^0.80.9", "package.json should use the current pi-ai 0.80.9 local development baseline");
  assert(pkg.peerDependencies?.["@earendil-works/pi-ai"] === "*", "package.json should declare the runtime StringEnum import as an optional wildcard peer");
  assert(pkg.peerDependencies?.["@earendil-works/pi-coding-agent"] === "*", "package.json should keep pi runtime packages as wildcard peers instead of hard-pinning the tested Pi floor");
  for (const peer of ["@earendil-works/pi-ai", "@earendil-works/pi-coding-agent", "typebox"]) {
    assert(pkg.peerDependenciesMeta?.[peer]?.optional === true, `package.json should keep ${peer} optional for Pi loader-provided runtime resolution`);
  }
  assert(Array.isArray(pkg.pi?.prompts) && pkg.pi.prompts.includes("./prompts"), "package manifest should expose prompt templates for slash completion");
  assert(readmeSource.includes("Pi `0.80.9+` is the suggested tested floor") && readmeSource.includes("optional wildcard peers"), "README should document the suggested Pi 0.80.9 floor without making it a hard peer requirement");
  assert(designSource.includes("pi` 0.80.9+") || designSource.includes("`pi` 0.80.9+"), "design doc should name the current suggested Pi 0.80.9 compatibility floor");
  assert(configSource.includes("ProjectTrustStore") && configSource.includes("saved untrusted decision"), "oracle project config loading should preserve compatibility while respecting explicit Pi distrust state");
  assert(pkg.overrides?.["basic-ftp"] === "6.0.1", "package.json should override basic-ftp to the latest patched stable version compatible with @google/genai");
  assert(pkg.overrides?.protobufjs === "7.6.1", "package.json should override protobufjs to a patched stable version compatible with @google/genai");
  assert(commandsSource.includes("Cancel a queued or active oracle job"), "oracle commands should allow queued-job cancellation");
  assert(commandsSource.includes("formatOracleJobSummary"), "oracle commands should format job status output through the shared observability helper");
  assert(commandsSource.includes("recently woken jobs may stay retained briefly"), "oracle-clean help text should mention the short post-send retention grace window");
  assert(commandsSource.includes("Job retained for wake-up safety"), "oracle-clean summary should use friendly wake-up safety phrasing for retention blockers");
  assert(commandsSource.includes("shouldAdvanceQueueAfterCancellation(cancelled)"), "oracle cancel command should only promote queued jobs after a clean cancellation");
  assert(commandsSource.includes("Refusing to remove non-terminal oracle job"), "oracle clean should refuse queued jobs");
  assert(commandsSource.includes("runOracleAuthBootstrap"), "oracle commands should delegate auth refresh through the shared auth-bootstrap helper");
  assert(jobsSource.includes("report.attempted.push(\"queuedArchive\")"), "cleanup retry should treat queued archive deletion as a first-class cleanup target");
  assert(jobsSource.includes("Failed to remove queued archive"), "queued cleanup retries should preserve warnings when archive deletion keeps failing");
  assert(jobsSource.includes("if (cleanupReport.warnings.length > 0)"), "terminal cleanup should retain job state when cleanup reports warnings");
  assert(jobsSource.includes("cleanupPending: terminated"), "terminal cancellation/recovery should mark cleanup pending until teardown finishes");
  assert(jobsSource.includes("markOracleJobCreated"), "job creation should register durable lifecycle breadcrumbs through the shared lifecycle helper");
  assert(jobsSource.includes("cancelRequestedAt"), "oracle jobs should persist durable cancel intent before reconciling worker teardown");
  assert(jobsSource.includes("Recovered requested cancellation"), "reconcile should preserve requested-cancel semantics instead of always failing stale active jobs");
  assert(archiveSource.includes("target.input.on(\"error\", handlePipeError)"), "oracle archive creation should guard compressor input pipes so downstream early exits do not crash the host process");
  assert(sharedObservabilitySource.includes("heartbeat:"), "shared observability helpers should surface heartbeat freshness in active job summaries");
  assert(sharedObservabilitySource.includes("formatOracleCancelOutcome"), "shared observability helpers should centralize truthful cancel outcome messaging");
  assert(commandsSource.includes("formatOracleCancelOutcome"), "oracle cancel command should use the shared truthful cancel outcome formatter");
  assert(toolsSource.includes("formatOracleCancelOutcome"), "oracle cancel tool should use the shared truthful cancel outcome formatter");
}

async function testResponseTimeoutGuard(): Promise<void> {
  const workerSource = await readFile(new URL("../extensions/oracle/worker/run-job.mjs", import.meta.url), "utf8");
  const authBootstrapSource = await readFile(new URL("../extensions/oracle/worker/auth-bootstrap.mjs", import.meta.url), "utf8");
  const authFlowSource = await readFile(new URL("../extensions/oracle/worker/auth-flow-helpers.mjs", import.meta.url), "utf8");
  const stateLocksSource = await readFile(new URL("../extensions/oracle/worker/state-locks.mjs", import.meta.url), "utf8");
  const sharedStateSource = await readFile(new URL("../extensions/oracle/shared/state-coordination-helpers.mjs", import.meta.url), "utf8");
  const sharedJobCoordinationSource = await readFile(new URL("../extensions/oracle/shared/job-coordination-helpers.mjs", import.meta.url), "utf8");
  const sharedLifecycleSource = await readFile(new URL("../extensions/oracle/shared/job-lifecycle-helpers.mjs", import.meta.url), "utf8");
  const sharedObservabilitySource = await readFile(new URL("../extensions/oracle/shared/job-observability-helpers.mjs", import.meta.url), "utf8");
  const sharedProcessSource = await readFile(new URL("../extensions/oracle/shared/process-helpers.mjs", import.meta.url), "utf8");
  const browserProfileHelpersSource = await readFile(new URL("../extensions/oracle/shared/browser-profile-helpers.mjs", import.meta.url), "utf8");
  const queueSource = await readFile(new URL("../extensions/oracle/lib/queue.ts", import.meta.url), "utf8");
  const toolsSource = await readFile(new URL("../extensions/oracle/lib/tools.ts", import.meta.url), "utf8");
  const archiveSource = await readFile(new URL("../extensions/oracle/lib/archive.ts", import.meta.url), "utf8");
  const runtimeSource = await readFile(new URL("../extensions/oracle/lib/runtime.ts", import.meta.url), "utf8");
  const heuristicsSource = await readFile(new URL("../extensions/oracle/worker/artifact-heuristics.mjs", import.meta.url), "utf8");
  const uiHelpersSource = await readFile(new URL("../extensions/oracle/worker/chatgpt-ui-helpers.mjs", import.meta.url), "utf8");
  assert(workerSource.includes("Message delivery timed out"), "worker should detect ChatGPT response timeout text");
  assert(workerSource.includes("Too many requests"), "worker should surface provider rate-limit modals instead of reporting generic UI drift");
  assert(workerSource.includes("waiting for send acceptance"), "worker should surface provider rate-limit modals after clicking send instead of reporting generic send acceptance failure");
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
  assert(workerSource.includes("copyDirectory(seedDir, job.runtimeProfileDir"), "worker runtime profile cloning should use Node recursive copy off macOS instead of requiring POSIX cp on Windows/Linux");
  assert(workerSource.includes("removeChromiumProcessSingletonArtifacts"), "worker runtime profile cloning should scrub Chromium singleton artifacts copied from seed profiles");
  assert(workerSource.includes("jobBlocksAdmission"), "worker queued-promotion admission should delegate blocking checks to the shared job coordination helper");
  assert(workerSource.includes("from \"./state-locks.mjs\""), "worker should use the shared hardened state-lock helper instead of keeping divergent lock/lease crash recovery logic inline");
  assert(workerSource.includes("from \"./chatgpt-ui-helpers.mjs\""), "worker should use the shared ChatGPT UI helper module for model/origin/completion logic");
  assert(workerSource.includes('["button", "radio", "menuitemradio"].includes(candidate.kind || "")'), "worker should accept radio-style model family controls in addition to button controls");
  assert(workerSource.includes('["button", "switch"].includes(candidate.kind || "")'), "worker should treat the auto-switch control as a switch in the current ChatGPT configure modal");
  assert(workerSource.includes("Could not find model family control"), "worker should describe missing family selectors generically instead of assuming button-only controls");
  assert(workerSource.includes('candidate.label === "Model"'), "worker should recognize the current ChatGPT Model button as the configuration opener");
  assert(workerSource.includes("canUseOpenModelMenuForSelection"), "worker should fall back to the top-level model menu for plain Instant when ChatGPT's configure sheet is unavailable");
  assert(workerSource.includes("snapshotHasUsableComposerControls"), "worker readiness should accept authenticated usable composer shells even when model labels drift");
  assert(workerSource.includes("public Log in/Sign up controls"), "worker readiness should not accept ChatGPT's public logged-out composer shell as authenticated");
  assert(workerSource.includes("hasGrokLoginCta"), "worker should reject Grok login shells before accepting composer-like controls as authenticated");
  assert(authBootstrapSource.includes("hasGrokLoginCta"), "auth bootstrap should reject Grok login shells before accepting composer-like controls as authenticated");
  assert(conversationIdFromUrl("https://chatgpt.com/c/chatgpt-abc") === "chatgpt-abc" && conversationIdFromUrl("https://grok.com/chat/grok-abc") === "grok-abc", "conversation helpers should parse both ChatGPT and Grok conversation URL ids");
  assert(workerSource.includes("Grok response completed but the conversation URL did not stabilize"), "Grok jobs should fail clearly rather than persist the Grok home page as a follow-up URL");
  assert(workerSource.includes("hasTargetCopyResponse: hasTargetCopyResponse || isGrokJob(job)"), "Grok completion should not require exact Copy-button evidence once response text is stable");
  assert(workerSource.includes("const errorText = detectUploadErrorText(`${snapshot}\\n${body}`);"), "Grok upload confirmation should preserve visible upload error detection");
  assert(workerSource.includes("document.querySelectorAll('.message-bubble')"), "Grok response extraction should anchor on message bubbles before brittle container class fallbacks");
  assert(workerSource.includes('document.querySelectorAll(\'[data-message-author-role="assistant"]\')'), "ChatGPT response extraction should use current assistant role nodes when message-bubble nodes are absent");
  assert(workerSource.includes("node.getAttribute('data-testid') !== 'user-message'"), "Grok response extraction should exclude user-message bubbles before selecting assistant text");
  assert(workerSource.includes("/^Thought for /i.test"), "Grok response extraction should strip leading thinking-summary labels from answer text");
  assert(workerSource.includes("throw new Error(classification.message"), "worker auth-transition timeout should preserve the specific classifier guidance instead of replacing it with a misleading generic partial-login message");
  assert(workerSource.includes("Math.min(job.config.auth.bootstrapTimeoutMs || 120_000, 120_000)"), "ChatGPT worker readiness should allow Cloudflare verification-successful settling longer than the old 30s fixed timeout");
  assert(workerSource.includes("from \"./chatgpt-flow-helpers.mjs\""), "worker should use the extracted ChatGPT flow helper module for stable URL/snapshot logic");
  assert(workerSource.includes("deriveAssistantCompletionSignature"), "worker should route completion decisions through the shared assistant-completion helper");
  assert(uiHelpersSource.includes("detectSelectedModelFamily"), "ChatGPT UI helpers should infer the selected family from current configure-modal semantics instead of assuming family labels alone identify the active selection");
  assert(uiHelpersSource.includes("selectionMatchesChipSelection"), "ChatGPT UI helpers should recognize composer chips like Heavy thinking or Extended Pro as durable preset indicators");
  assert(uiHelpersSource.includes("snapshotHasModelOpener"), "ChatGPT UI helpers should centralize current model-opener recognition for auth and worker flows");
  assert(authBootstrapSource.includes("from \"./state-locks.mjs\""), "auth bootstrap should use the shared hardened state-lock helper instead of keeping divergent auth-lock crash recovery logic inline");
  assert(authBootstrapSource.includes("from \"./chatgpt-ui-helpers.mjs\""), "auth bootstrap should use the shared ChatGPT origin helper so runtime/auth stay aligned");
  assert(authBootstrapSource.includes("from \"./auth-flow-helpers.mjs\""), "auth bootstrap should use the extracted auth flow helper module for probe normalization and page classification");
  assert(authFlowSource.includes("snapshotHasUsableComposerControls"), "auth classification should treat visible usable ChatGPT composer controls as ready despite model-control label drift");
  assert(!authBootstrapSource.includes('"/tmp/oracle-auth'), "auth bootstrap should not write diagnostics to fixed /tmp/oracle-auth.* paths");
  assert(authBootstrapSource.includes('mkdtemp(join(tmpdir(), "pi-oracle-auth-"))'), "auth bootstrap should isolate diagnostics in a unique private temp directory per run");
  assert(authBootstrapSource.includes("AGENT_BROWSER_COMMAND_TIMEOUT_MS"), "auth bootstrap should enforce process-level timeouts for agent-browser commands");
  assert(authBootstrapSource.includes("PI_ORACLE_AUTH_CLOSE_TIMEOUT_MS"), "auth bootstrap should allow shorter timeout overrides for close-time smoke tests");
  assert(authBootstrapSource.includes("isAbsolute(targetDir)"), "auth bootstrap should accept platform-native absolute paths, including Windows drive-letter paths");
  assert(authBootstrapSource.includes("Object.hasOwn(maybeOptions, \"timeoutMs\")"), "auth bootstrap targetCommand should accept explicit timeout overrides");
  assert(authBootstrapSource.includes("timed out after"), "auth bootstrap subprocess wrapper should report timeout failures clearly");
  assert(!authBootstrapSource.includes("scrubSweetCookieSafeStoragePasswordEnv"), "auth bootstrap should avoid mutating process.env while handling Sweet Cookie safe-storage overrides");
  assert(workerSource.includes("sweetCookieSafeStoragePasswordScrubbedEnv(spawnOptions.env)"), "worker helper subprocesses should scrub safe-storage passwords while preserving caller-provided env vars");
  assert(workerSource.includes("Launching isolated Chrome directly for agent-browser attach"), "worker should launch the isolated Chrome runtime itself instead of depending on global agent-browser daemon launch options");
  assert(workerSource.includes('"connect", endpoint'), "worker should attach agent-browser to the worker-owned Chrome DevTools endpoint so non-oracle sessions can remain active");
  assert(workerSource.includes('"open", url'), "worker should navigate the connected oracle session without relaunch-scoped agent-browser flags after attaching to worker-owned Chrome");
  assert(workerSource.includes("await terminateBrowserProcess()"), "worker should await worker-owned Chrome teardown before profile cleanup");
  assert(workerSource.includes("Runtime profile cleanup skipped because isolated browser close did not complete"), "worker should not delete runtime profiles while its directly spawned browser may still be alive");
  assert(workerSource.includes("browser.args cannot override oracle-managed Chrome launch isolation flag"), "worker should reject browser args that can override profile or DevTools isolation");
  assert(!workerSource.includes('[...browserBaseArgs(job, { withLaunchOptions: true, mode }), "open", url]'), "worker should not launch oracle browsers through agent-browser open with launch-scoped flags that conflict with unrelated sessions");
  assert(!runtimeSource.includes("assertNoForeignAgentBrowserSessions"), "submit preflight should not reject unrelated active agent-browser sessions now that worker-owned Chrome attach avoids global daemon takeover");
  assert(authBootstrapSource.includes("sweetCookieSafeStoragePasswordScrubbedEnv(spawnOptions.env)"), "auth bootstrap subprocesses should scrub safe-storage passwords while preserving caller-provided env vars");
  assert(browserProfileHelpersSource.includes('readFileSync(localStatePath, "utf8")'), "browser profile helpers should read Chromium Local State as utf8 text directly");
  assert(authBootstrapSource.includes("sweetCookieSafeStoragePasswordScrubbedEnv"), "auth bootstrap should still scrub Sweet Cookie safe-storage passwords from helper subprocess environments");
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
  assert(archiveSource.includes("ARCHIVE_COMMAND_TIMEOUT_MS = 120_000"), "archive creation should enforce a subprocess timeout envelope");
  assert(archiveSource.includes("Oracle archive subprocess timed out after"), "archive creation should surface timeout failures clearly");
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
  assert(workerSource.includes("activateSendButton"), "worker should activate provider send through the page DOM instead of relying only on accessibility click refs");
  assert(workerSource.includes("waitForSendAccepted"), "worker should verify that provider send actually leaves the composer before awaiting a response");
  assert(workerSource.includes("send-not-accepted"), "worker should capture diagnostics when provider send activation does not submit the message");
  assert(workerSource.includes("message did not leave the composer"), "worker should fail clearly instead of waiting forever when provider send is not accepted");
  assert(workerSource.includes("document.querySelector('main') || document.body"), "artifact capture should fall back when ChatGPT accessibility snapshots no longer expose ChatGPT-said headings");
  assert(workerSource.includes("downloadArtifactViaBrowserEval"), "artifact capture should use a browser-eval fallback for ChatGPT behavior buttons that do not emit standard browser downloads");
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
    await mkdir(join(fixtureDir, ".artifacts", "platform-smoke"), { recursive: true });
    await mkdir(join(fixtureDir, ".crabbox", "captures"), { recursive: true });
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
    await writeFile(join(fixtureDir, ".artifacts", "platform-smoke", "summary.json"), "{}\n");
    await writeFile(join(fixtureDir, ".crabbox", "captures", "failure.tar.gz"), "capture\n");
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
    assert(!rootEntries.includes(".artifacts/platform-smoke/summary.json"), "root archive expansion should exclude local platform-smoke artifacts by default");
    assert(!rootEntries.includes(".crabbox/captures/failure.tar.gz"), "root archive expansion should exclude local Crabbox captures by default");
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

    const explicitArtifactsEntries = await resolveExpandedArchiveEntries(fixtureDir, [".artifacts"]);
    assert(explicitArtifactsEntries.includes(".artifacts/platform-smoke/summary.json"), "explicitly requested .artifacts directories should be preserved");

    const explicitCrabboxEntries = await resolveExpandedArchiveEntries(fixtureDir, [".crabbox"]);
    assert(explicitCrabboxEntries.includes(".crabbox/captures/failure.tar.gz"), "explicitly requested .crabbox directories should be preserved");

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

async function testGrokArchiveUsesGzipTarFormat(config: OracleConfig): Promise<void> {
  const fixtureDir = await mkdtemp(join(tmpdir(), "oracle-archive-grok-gzip-"));
  const archivePath = join(tmpdir(), `oracle-archive-grok-gzip-${randomUUID()}.tar.gz`);
  const jobId = `sanity-grok-archive-${randomUUID()}`;
  try {
    await writeFile(join(fixtureDir, "README.md"), "# grok archive\n", { encoding: "utf8", mode: 0o600 });
    assert(resolveOracleArchiveFormat("chatgpt") === "tar.zst", "ChatGPT archives should stay zstd-compressed tar files");
    assert(resolveOracleArchiveFormat("grok") === "tar.gz", "Grok archives should use gzip-compressed tar files because Grok lacks zstd extraction tools");

    const archive = await createArchiveForTesting(fixtureDir, ["."], archivePath, {
      archiveFormat: resolveOracleArchiveFormat("grok"),
      maxBytes: 16 * 1024,
    });
    assert(archive.archiveBytes > 0, "Grok tar.gz archive creation should report a non-empty archive size");
    assert(listArchiveEntries(archivePath).includes("README.md"), "Grok tar.gz archives should remain normal tar archives that providers can extract without zstd");

    const runtime = {
      runtimeId: `runtime-${randomUUID()}`,
      runtimeSessionName: `oracle-runtime-${randomUUID()}`,
      runtimeProfileDir: `/tmp/oracle-runtime-${randomUUID()}`,
      seedGeneration: new Date().toISOString(),
    };
    const job = await createJob(
      jobId,
      {
        prompt: "sanity",
        files: ["README.md"],
        selection: resolveOracleGrokMode("heavy"),
        requestSource: "tool",
      },
      fixtureDir,
      `/tmp/oracle-sanity-grok-session-${randomUUID()}.jsonl`,
      config,
      runtime,
    );
    assert(job.archivePath.endsWith(".tar.gz"), "Grok oracle jobs should persist a .tar.gz archive path");
  } finally {
    await rm(archivePath, { force: true });
    await cleanupJob(jobId).catch(() => undefined);
    await rm(fixtureDir, { recursive: true, force: true });
  }
}

function testArchiveEntryGroupMergeHandlesLargeArrays(): void {
  const firstGroup = Array.from({ length: 120_000 }, (_value, index) => `alpha/${index.toString(36)}`);
  const secondGroup = Array.from({ length: 120_000 }, (_value, index) => `beta/${index.toString(36)}`);
  const merged = mergeArchiveEntryGroupsForTesting([firstGroup, secondGroup]);
  assert(merged.length === firstGroup.length + secondGroup.length, "archive entry-group merging should preserve every entry even for very large groups");
  assert(merged[0] === firstGroup[0] && merged[firstGroup.length] === secondGroup[0], "archive entry-group merging should preserve group ordering for large merges");
  assert(merged.at(-1) === secondGroup.at(-1), "archive entry-group merging should preserve the tail entry for large merges");
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
  if (process.platform === "win32") return;
  const fixtureDir = await mkdtemp(join(tmpdir(), "oracle-archive-timeout-"));
  const binDir = await mkdtemp(join(tmpdir(), "oracle-archive-bin-"));
  const archivePath = join(tmpdir(), `oracle-archive-timeout-${randomUUID()}.tar.zst`);
  const tarPidPath = join(binDir, "tar.pid");
  const zstdPidPath = join(binDir, "zstd.pid");
  const originalPath = process.env.PATH ?? "";
  const originalTarBin = process.env.PI_ORACLE_TEST_TAR_BIN;
  const originalZstdBin = process.env.PI_ORACLE_TEST_ZSTD_BIN;

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
    process.env.PI_ORACLE_TEST_TAR_BIN = join(binDir, "tar");
    process.env.PI_ORACLE_TEST_ZSTD_BIN = join(binDir, "zstd");

    await assertRejects(
      () => createArchiveForTesting(fixtureDir, ["."], archivePath, { commandTimeoutMs: 15_000 }),
      "archive creation should time out when tar/zstd hang",
      "timed out",
    );

    if (await waitForPath(tarPidPath)) {
      const tarPid = Number.parseInt((await readFile(tarPidPath, "utf8")).trim(), 10);
      assert(Number.isFinite(tarPid), "archive timeout test should record a tar pid");
      assert(await waitForPidExit(tarPid), "archive timeout should terminate the hung tar process");
    }
    if (await waitForPath(zstdPidPath)) {
      const zstdPid = Number.parseInt((await readFile(zstdPidPath, "utf8")).trim(), 10);
      assert(Number.isFinite(zstdPid), "archive timeout test should record a zstd pid");
      assert(await waitForPidExit(zstdPid), "archive timeout should terminate the hung zstd process");
    }
  } finally {
    process.env.PATH = originalPath;
    if (originalTarBin === undefined) delete process.env.PI_ORACLE_TEST_TAR_BIN;
    else process.env.PI_ORACLE_TEST_TAR_BIN = originalTarBin;
    if (originalZstdBin === undefined) delete process.env.PI_ORACLE_TEST_ZSTD_BIN;
    else process.env.PI_ORACLE_TEST_ZSTD_BIN = originalZstdBin;
    await rm(fixtureDir, { recursive: true, force: true });
    await rm(binDir, { recursive: true, force: true });
    await rm(archivePath, { force: true });
  }
}

async function testArchiveSubprocessesScrubSafeStoragePasswords(): Promise<void> {
  if (process.platform === "win32") return;
  const fixtureDir = await mkdtemp(join(tmpdir(), "oracle-archive-env-scrub-"));
  const binDir = await mkdtemp(join(tmpdir(), "oracle-archive-env-scrub-bin-"));
  const archivePath = join(tmpdir(), `oracle-archive-env-scrub-${randomUUID()}.tar.zst`);
  const tarEnvPath = join(fixtureDir, "tar-safe-storage.txt");
  const zstdEnvPath = join(fixtureDir, "zstd-safe-storage.txt");
  const originalPath = process.env.PATH ?? "";
  const originalTarBin = process.env.PI_ORACLE_TEST_TAR_BIN;
  const originalZstdBin = process.env.PI_ORACLE_TEST_ZSTD_BIN;
  const originalChromePassword = process.env.SWEET_COOKIE_CHROME_SAFE_STORAGE_PASSWORD;
  const originalBravePassword = process.env.SWEET_COOKIE_BRAVE_SAFE_STORAGE_PASSWORD;

  try {
    await writeFile(join(fixtureDir, "main.ts"), "export const main = true;\n");
    await writeExecutableScript(
      join(binDir, "tar"),
      `#!/bin/sh
printf '%s:%s\n' "$SWEET_COOKIE_CHROME_SAFE_STORAGE_PASSWORD" "$SWEET_COOKIE_BRAVE_SAFE_STORAGE_PASSWORD" > ${shellQuote(tarEnvPath)}
printf 'fake archive payload\n'
`,
    );
    await writeExecutableScript(
      join(binDir, "zstd"),
      `#!/bin/sh
printf '%s:%s\n' "$SWEET_COOKIE_CHROME_SAFE_STORAGE_PASSWORD" "$SWEET_COOKIE_BRAVE_SAFE_STORAGE_PASSWORD" > ${shellQuote(zstdEnvPath)}
out=''
while [ "$#" -gt 0 ]; do
  if [ "$1" = '-o' ]; then
    shift
    out="$1"
  fi
  shift || break
done
if [ -z "$out" ]; then
  echo 'missing -o' >&2
  exit 1
fi
cat > "$out"
`,
    );
    process.env.PATH = `${binDir}:${originalPath}`;
    process.env.PI_ORACLE_TEST_TAR_BIN = join(binDir, "tar");
    process.env.PI_ORACLE_TEST_ZSTD_BIN = join(binDir, "zstd");
    process.env.SWEET_COOKIE_CHROME_SAFE_STORAGE_PASSWORD = "chrome-secret";
    process.env.SWEET_COOKIE_BRAVE_SAFE_STORAGE_PASSWORD = "brave-secret";

    await createArchiveForTesting(fixtureDir, ["main.ts"], archivePath, { commandTimeoutMs: 15_000 });
    assert((await readFile(tarEnvPath, "utf8")).trim() === ":", "archive tar subprocess should not inherit Sweet Cookie safe-storage password env vars");
    assert((await readFile(zstdEnvPath, "utf8")).trim() === ":", "archive zstd subprocess should not inherit Sweet Cookie safe-storage password env vars");
  } finally {
    process.env.PATH = originalPath;
    if (originalTarBin === undefined) delete process.env.PI_ORACLE_TEST_TAR_BIN;
    else process.env.PI_ORACLE_TEST_TAR_BIN = originalTarBin;
    if (originalZstdBin === undefined) delete process.env.PI_ORACLE_TEST_ZSTD_BIN;
    else process.env.PI_ORACLE_TEST_ZSTD_BIN = originalZstdBin;
    if (originalChromePassword === undefined) delete process.env.SWEET_COOKIE_CHROME_SAFE_STORAGE_PASSWORD;
    else process.env.SWEET_COOKIE_CHROME_SAFE_STORAGE_PASSWORD = originalChromePassword;
    if (originalBravePassword === undefined) delete process.env.SWEET_COOKIE_BRAVE_SAFE_STORAGE_PASSWORD;
    else process.env.SWEET_COOKIE_BRAVE_SAFE_STORAGE_PASSWORD = originalBravePassword;
    await rm(fixtureDir, { recursive: true, force: true });
    await rm(binDir, { recursive: true, force: true });
    await rm(archivePath, { force: true });
  }
}

async function testArchiveBrokenPipeRejectsCleanly(): Promise<void> {
  if (process.platform === "win32") return;
  const fixtureDir = await mkdtemp(join(tmpdir(), "oracle-archive-broken-pipe-"));
  const binDir = await mkdtemp(join(tmpdir(), "oracle-archive-broken-pipe-bin-"));
  const archivePath = join(tmpdir(), `oracle-archive-broken-pipe-${randomUUID()}.tar.zst`);
  const tarPidPath = join(binDir, "tar.pid");
  const zstdPidPath = join(binDir, "zstd.pid");
  const originalPath = process.env.PATH ?? "";
  const originalTarBin = process.env.PI_ORACLE_TEST_TAR_BIN;
  const originalZstdBin = process.env.PI_ORACLE_TEST_ZSTD_BIN;

  try {
    await mkdir(join(fixtureDir, "src"), { recursive: true });
    await writeFile(join(fixtureDir, "src", "main.ts"), "export const main = true;\n");
    await writeExecutableScript(
      join(binDir, "tar"),
      `#!/bin/sh
printf '%s\\n' "$$" > ${shellQuote(tarPidPath)}
python3 - <<'PY'
import os, sys
block = b'x' * 65536
for _ in range(1024):
    os.write(sys.stdout.fileno(), block)
PY
`,
    );
    await writeExecutableScript(
      join(binDir, "zstd"),
      `#!/bin/sh
printf '%s\\n' "$$" > ${shellQuote(zstdPidPath)}
sleep 0.1
echo 'fake zstd failure' >&2
exit 1
`,
    );
    process.env.PATH = `${binDir}:${originalPath}`;
    process.env.PI_ORACLE_TEST_TAR_BIN = join(binDir, "tar");
    process.env.PI_ORACLE_TEST_ZSTD_BIN = join(binDir, "zstd");

    await assertRejects(
      () => createArchiveForTesting(fixtureDir, ["."], archivePath, { commandTimeoutMs: 15_000 }),
      "archive creation should reject cleanly when zstd closes the pipe early",
      "fake zstd failure",
    );

    assert(await waitForPath(tarPidPath), "broken-pipe archive test should record a tar pid file");
    assert(await waitForPath(zstdPidPath), "broken-pipe archive test should record a zstd pid file");
    const tarPid = Number.parseInt((await readFile(tarPidPath, "utf8")).trim(), 10);
    const zstdPid = Number.parseInt((await readFile(zstdPidPath, "utf8")).trim(), 10);
    assert(Number.isFinite(tarPid), "broken-pipe archive test should record a tar pid");
    assert(Number.isFinite(zstdPid), "broken-pipe archive test should record a zstd pid");
    assert(await waitForPidExit(tarPid), "broken-pipe archive test should clean up the tar process after downstream pipe failure");
    assert(await waitForPidExit(zstdPid), "broken-pipe archive test should observe the early zstd exit");
  } finally {
    process.env.PATH = originalPath;
    if (originalTarBin === undefined) delete process.env.PI_ORACLE_TEST_TAR_BIN;
    else process.env.PI_ORACLE_TEST_TAR_BIN = originalTarBin;
    if (originalZstdBin === undefined) delete process.env.PI_ORACLE_TEST_ZSTD_BIN;
    else process.env.PI_ORACLE_TEST_ZSTD_BIN = originalZstdBin;
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

async function testArchiveOversizeErrorExplainsRetryPlan(): Promise<void> {
  const fixtureDir = await mkdtemp(join(tmpdir(), "oracle-archive-oversize-"));
  const archivePath = join(tmpdir(), `oracle-archive-oversize-${randomUUID()}.tar.zst`);
  try {
    await writeFile(join(fixtureDir, "big.bin"), randomBytes(32 * 1024));
    await assertRejects(
      () => createArchiveForTesting(fixtureDir, ["big.bin"], archivePath, { maxBytes: 8 * 1024 }),
      "archive oversize errors should explain the configured size limit and retry plan",
      "Oracle archive exceeds provider upload limit (0.01 MiB) after default exclusions.",
    );
    await assertRejects(
      () => createArchiveForTesting(fixtureDir, ["big.bin"], archivePath, { maxBytes: 8 * 1024 }),
      "archive oversize errors should report that submission stopped before dispatch",
      "so submission stopped before dispatch",
    );
    await assertRejects(
      () => createArchiveForTesting(fixtureDir, ["big.bin"], archivePath, { maxBytes: 8 * 1024 }),
      "archive oversize errors should describe the retry order for narrowing archives",
      "Recommended retry order:",
    );
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
  assert(notified.notifiedAt === "2026-01-01T00:00:50.000Z" && notified.wakeupAttemptCount === 1 && notified.wakeupLastRequestedAt === "2026-01-01T00:00:35.000Z" && !notified.notifyClaimedBy, "shared lifecycle helpers should clear notification claims while preserving wake-up attempt state for cleanup grace and observability");
}

function testSharedObservabilityHelpers(): void {
  type ObservabilityFixture = OracleLifecycleTrackedJobLike & {
    id: string;
    projectId: string;
    sessionId: string;
    selection: {
      preset: string;
      modelFamily: string;
      effort?: string;
      autoSwitchToThinking: boolean;
    };
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
    selection: {
      preset: "thinking_light",
      modelFamily: "thinking",
      effort: "light",
      autoSwitchToThinking: false,
    },
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

  const freshHeartbeatSummary = formatOracleJobSummary(transitionOracleJobPhase(job, "awaiting_response", {
    at: "2026-01-01T00:00:05.000Z",
    source: "oracle:test",
    message: "Waiting on oracle response.",
    patch: { heartbeatAt: "2026-01-01T00:00:45.000Z" },
  }), {
    nowMs: Date.parse("2026-01-01T00:01:15.000Z"),
  });
  assert(freshHeartbeatSummary.includes("heartbeat: fresh (30s ago)"), "shared observability helpers should label recent active heartbeats as fresh");

  const waitingForFirstHeartbeatSummary = formatOracleJobSummary(transitionOracleJobPhase(job, "submitted", {
    at: "2026-01-01T00:00:05.000Z",
    source: "oracle:test",
    message: "Submitted observability fixture.",
  }), {
    nowMs: Date.parse("2026-01-01T00:04:35.000Z"),
  });
  assert(waitingForFirstHeartbeatSummary.includes("heartbeat: waiting for first worker update; likely stale (4m 30s since submit)"), "shared observability helpers should distinguish waiting-for-first-heartbeat jobs from recently refreshed active jobs");

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
  assert(submitResponse.includes("Model preset: thinking_light (family=thinking, effort=light)"), "submit responses should disclose the resolved oracle model preset snapshot for transparency");
  const grokSubmitResponse = formatOracleSubmitResponse({
    ...job,
    id: "job-observe-grok",
    selection: {
      provider: "grok",
      mode: "heavy",
      modelFamily: "grok",
      effort: "heavy",
      autoSwitchToThinking: false,
    },
  }, {
    autoPrunedPrefixes: [],
    queued: false,
  });
  assert(grokSubmitResponse.includes("Provider model: Grok heavy"), "submit responses should disclose Grok provider/mode selections for transparency");

  const wakeupContent = buildOracleWakeupNotificationContent(job, {
    responsePath: "/tmp/response.md",
    responseAvailable: true,
    artifactsPath: "/tmp/artifacts",
  });
  assert(wakeupContent.includes("Use /oracle-read job-observe") && wakeupContent.includes("/oracle-status job-observe") && wakeupContent.includes("oracle_read({ jobId: \"job-observe\" })") && wakeupContent.includes("Last event:") && wakeupContent.includes("Response file: /tmp/response.md"), "shared observability helpers should include both the /oracle-read guidance, /oracle-status fallback, agent-facing oracle_read hint, and the persisted response path when a response file exists");

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

  assert(buildOracleStatusText({ active: 2, queued: 1 }, "ready") === "oracle: running (2), queued (1)", "shared observability helpers should format mixed active/queued session status text");
  assert(buildOracleStatusText({ active: 0, queued: 0 }, "auth_needed") === "oracle: auth needed", "shared observability helpers should format auth-needed session status text");
  assert(buildOracleStatusText({ active: 1, queued: 0 }, "auth_needed") === "oracle: running, auth needed", "shared observability helpers should overlay readiness with running job counts");
}

function testChatGptUiHelpers(): void {
  const closedThinkingSnapshot = [
    '- button "Thinking, click to remove" [ref=e110]',
    '- button "Thinking" [expanded=false, ref=e111]',
  ].join("\n");
  assert(
    snapshotStronglyMatchesRequestedModel(closedThinkingSnapshot, { modelFamily: "thinking", effort: "standard", autoSwitchToThinking: false }),
    "closed standard-thinking chips should strongly verify the standard thinking preset",
  );
  assert(
    snapshotCanSafelySkipModelConfiguration(closedThinkingSnapshot, { modelFamily: "thinking", effort: "standard", autoSwitchToThinking: false }),
    "closed standard-thinking chips should safely skip model reconfiguration because the chip encodes the preset",
  );

  const closedInstantSnapshot = [
    '- button "Instant, click to remove" [ref=e105]',
    '- button "Instant" [expanded=false, ref=e106]',
  ].join("\n");
  assert(
    snapshotStronglyMatchesRequestedModel(closedInstantSnapshot, { modelFamily: "instant", autoSwitchToThinking: false }),
    "closed instant chips should strongly verify the plain instant preset",
  );
  assert(
    snapshotCanSafelySkipModelConfiguration(closedInstantSnapshot, { modelFamily: "instant", autoSwitchToThinking: false }),
    "closed instant chips should safely skip model reconfiguration because the chip encodes the preset",
  );
  assert(
    !snapshotStronglyMatchesRequestedModel(closedInstantSnapshot, { modelFamily: "instant", autoSwitchToThinking: true }),
    "plain instant chips should not verify auto-switch instant presets",
  );

  const expandedRemovableThinkingChipSnapshot = '- button "Thinking, click to remove" [expanded=true, ref=e110]';
  assert(
    snapshotStronglyMatchesRequestedModel(expandedRemovableThinkingChipSnapshot, { modelFamily: "thinking", effort: "standard", autoSwitchToThinking: false }),
    "expanded removable model chips should still verify their encoded selection",
  );

  const closedExtendedThinkingSnapshot = [
    '- button "Extended thinking, click to remove" [ref=e120]',
    '- button "Extended thinking" [expanded=false, ref=e121]',
  ].join("\n");
  assert(
    snapshotStronglyMatchesRequestedModel(closedExtendedThinkingSnapshot, { modelFamily: "thinking", effort: "extended", autoSwitchToThinking: false }),
    "closed extended-thinking chips should strongly verify the extended thinking preset",
  );
  assert(
    !snapshotStronglyMatchesRequestedModel(closedExtendedThinkingSnapshot, { modelFamily: "pro", effort: "extended", autoSwitchToThinking: false }),
    "thinking chips should not verify pro presets that reuse the same effort label",
  );

  const configureThinkingHeavySnapshot = [
    '- radio "Instant" [checked=false, ref=e130]',
    '- radio "Thinking" [checked=false, ref=e131]',
    '- radio "Pro" [checked=false, ref=e132]',
    '- combobox "Thinking effort" [expanded=false, ref=e133]: Heavy',
  ].join("\n");
  assert(
    snapshotStronglyMatchesRequestedModel(configureThinkingHeavySnapshot, { modelFamily: "thinking", effort: "heavy", autoSwitchToThinking: false }),
    "thinking configure modals should verify heavy thinking even when the family radio itself is not marked checked in the snapshot",
  );
  assert(
    !snapshotStronglyMatchesRequestedModel(configureThinkingHeavySnapshot, { modelFamily: "pro", effort: "heavy", autoSwitchToThinking: false }),
    "thinking configure modals should not misclassify the visible thinking effort combobox as a pro preset",
  );

  const closedExtendedProSnapshot = [
    '- button "Extended Pro, click to remove" [ref=e210]',
    '- button "Extended Pro" [expanded=false, ref=e211]',
  ].join("\n");
  assert(
    snapshotStronglyMatchesRequestedModel(closedExtendedProSnapshot, { modelFamily: "pro", effort: "extended", autoSwitchToThinking: false }),
    "closed extended-pro chips should strongly verify the extended pro preset",
  );
  assert(
    snapshotCanSafelySkipModelConfiguration(closedExtendedProSnapshot, { modelFamily: "pro", effort: "extended", autoSwitchToThinking: false }),
    "closed extended-pro chips should safely skip model reconfiguration because the chip encodes the preset",
  );

  const topMenuProSnapshot = [
    '- menuitemradio "Instant" [checked=false, ref=e220]',
    '- menuitemradio "Thinking" [checked=false, ref=e221]',
    '- menuitemradio "Pro" [checked=true, ref=e222]',
  ].join("\n");
  assert(
    !snapshotHasModelConfigurationUi(topMenuProSnapshot),
    "legacy top-level family menus alone should not be mistaken for compact Intelligence configuration UI",
  );
  assert(
    !snapshotStronglyMatchesRequestedModel(topMenuProSnapshot, { modelFamily: "pro", effort: "standard", autoSwitchToThinking: false }),
    "top-level family menus alone should not strongly verify effort-sensitive pro presets before the configure modal reveals the effort selector",
  );
  assert(
    snapshotWeaklyMatchesRequestedModel(topMenuProSnapshot, { modelFamily: "pro", effort: "standard", autoSwitchToThinking: false }),
    "top-level family menus should still weakly verify the selected family while the configure modal is settling",
  );
  assert(
    !snapshotWeaklyMatchesRequestedModel(topMenuProSnapshot, { modelFamily: "thinking", effort: "standard", autoSwitchToThinking: false }),
    "top-level family menus should not weakly verify the wrong family just because multiple family labels are visible",
  );

  const instantAutoSwitchOnSnapshot = [
    '- radio "Instant" [checked=true, ref=e310]',
    '- radio "Thinking" [checked=false, ref=e311]',
    '- radio "Pro" [checked=false, ref=e312]',
    '- combobox "Thinking effort" [expanded=false, ref=e313]: Standard',
    '- switch "Auto-switch to Thinking" [checked=true, ref=e314]',
  ].join("\n");
  assert(
    snapshotStronglyMatchesRequestedModel(instantAutoSwitchOnSnapshot, { modelFamily: "instant", autoSwitchToThinking: true }),
    "instant auto-switch presets should verify only when the switch is visibly enabled in the configure modal",
  );
  assert(
    !snapshotStronglyMatchesRequestedModel(instantAutoSwitchOnSnapshot, { modelFamily: "instant", autoSwitchToThinking: false }),
    "plain instant presets should not verify when the auto-switch control is enabled",
  );

  const instantAutoSwitchOffSnapshot = [
    '- radio "Instant" [checked=true, ref=e320]',
    '- radio "Thinking" [checked=false, ref=e321]',
    '- radio "Pro" [checked=false, ref=e322]',
    '- switch "Auto-switch to Thinking" [checked=false, ref=e323]',
  ].join("\n");
  assert(
    snapshotStronglyMatchesRequestedModel(instantAutoSwitchOffSnapshot, { modelFamily: "instant", autoSwitchToThinking: false }),
    "plain instant presets should verify when the instant radio is selected and auto-switch is visibly disabled",
  );
  assert(
    !snapshotStronglyMatchesRequestedModel(instantAutoSwitchOffSnapshot, { modelFamily: "instant", autoSwitchToThinking: true }),
    "instant auto-switch presets should not verify when the switch is visibly disabled",
  );

  const closedProSnapshot = '- button "Model selector" [ref=e410]';
  assert(
    !snapshotWeaklyMatchesRequestedModel(closedProSnapshot, { modelFamily: "pro", effort: "standard", autoSwitchToThinking: false }),
    "closed snapshots without an explicit selected family should not weakly verify Pro",
  );

  const currentBareEffortSnapshot = [
    '- button "Add files and more" [expanded=false, ref=e21]',
    '- textbox "Chat with ChatGPT" [ref=e19]',
    '- button "Heavy" [expanded=false, ref=e23]',
  ].join("\n");
  assert(snapshotHasUsableComposerControls(currentBareEffortSnapshot), "current ChatGPT composer shell should be recognized as usable");
  assert(snapshotHasModelOpener(currentBareEffortSnapshot), "current bare-effort model button should be recognized as a model opener");
  assert(
    snapshotStronglyMatchesRequestedModel(currentBareEffortSnapshot, { modelFamily: "thinking", effort: "heavy", autoSwitchToThinking: false }),
    "bare effort composer buttons should strongly verify matching thinking-effort presets",
  );
  assert(
    !snapshotStronglyMatchesRequestedModel(currentBareEffortSnapshot, { modelFamily: "instant", autoSwitchToThinking: false }),
    "bare effort composer buttons should not verify plain instant presets",
  );

  const currentModelButtonSnapshot = [
    '- button "Add files and more" [expanded=false, ref=e21]',
    '- textbox "Chat with ChatGPT" [ref=e19]',
    '- button "Model" [expanded=false, ref=e23]',
  ].join("\n");
  assert(snapshotHasModelOpener(currentModelButtonSnapshot), "current generic Model button should be recognized as a model opener");
  assert(!snapshotCanSafelySkipModelConfiguration(currentModelButtonSnapshot, { modelFamily: "thinking", effort: "standard", autoSwitchToThinking: false }), "generic Model button should not skip explicit model configuration");

  const latestModelDialogSnapshot = [
    '- heading "Intelligence" [level=2, ref=e3]',
    '- button "Close" [ref=e4]',
    '- combobox "Model" [expanded=false, ref=e1]: Latest • 5.3',
    '- radio "Instant" [checked=false, ref=e6]',
    '- radio "Thinking" [checked=false, ref=e7]',
    '- radio "Pro" [checked=false, ref=e8]',
    '- combobox "Thinking effort" [expanded=false, ref=e2]: Standard',
  ].join("\n");
  assert(snapshotHasModelConfigurationUi(latestModelDialogSnapshot), "current Intelligence dialog with radio family controls should be recognized as the model configuration UI");
  assert(
    !snapshotStronglyMatchesRequestedModel(latestModelDialogSnapshot, { modelFamily: "thinking", effort: "standard", autoSwitchToThinking: false }),
    "latest-model dialogs should not infer thinking from a visible effort combobox when no family is selected",
  );

  const legacyProStandardDialogSnapshot = [
    '- heading "Intelligence" [level=2, ref=e3]',
    '- button "Pro" [ref=e8]',
    '- combobox "Pro thinking effort" [expanded=false, ref=e2]: Standard',
  ].join("\n");
  assert(
    !snapshotStronglyMatchesRequestedModel(legacyProStandardDialogSnapshot, { modelFamily: "pro", effort: "extended", autoSwitchToThinking: false }),
    "legacy Pro family controls should not satisfy compact Pro effort matching when a Pro effort combobox is visible",
  );
  const legacyThinkingHeavyDialogSnapshot = [
    '- heading "Intelligence" [level=2, ref=e3]',
    '- button "Medium" [ref=e8]',
    '- combobox "Thinking effort" [expanded=false, ref=e2]: Heavy',
  ].join("\n");
  assert(
    !snapshotStronglyMatchesRequestedModel(legacyThinkingHeavyDialogSnapshot, { modelFamily: "thinking", effort: "standard", autoSwitchToThinking: false }),
    "legacy effort comboboxes should prevent compact-looking family buttons from overriding the visible effort",
  );

  const compactProMenuSnapshot = [
    '- button "Add files and more" [expanded=false, ref=e105]',
    '- textbox "Chat with ChatGPT" [ref=e102]',
    '- button "Pro" [expanded=true, ref=e106]',
    '- menu "IntelligenceInstant5sMedium5–30sHigh15–60sPro5+ minGPT-5.5" [ref=e108]',
    '- menuitemradio "Instant 5s" [checked=false, ref=e109]',
    '- menuitemradio "Medium 5–30s" [checked=false, ref=e110]',
    '- menuitemradio "High 15–60s" [checked=false, ref=e111]',
    '- menuitemradio "Pro 5+ min" [checked=true, ref=e112]',
    '- menuitem "GPT-5.5" [expanded=false, ref=e113]',
  ].join("\n");
  const currentUndifferentiatedProMenuSnapshot = [
    '- button "Pro" [expanded=true, ref=e161]',
    '- menu "Pro" [ref=e2]',
    '- menuitemradio "Instant 5.5" [checked=false, ref=e6]',
    '- menuitemradio "Medium" [checked=false, ref=e7]',
    '- menuitemradio "High" [checked=false, ref=e8]',
    '- menuitemradio "Extra High" [checked=false, ref=e9]',
    '- menuitemradio "Pro" [checked=true, ref=e10]',
    '- menuitem "GPT-5.6 Sol" [expanded=false, ref=e3]',
  ].join("\n");
  assert(
    snapshotStronglyMatchesRequestedModel(currentUndifferentiatedProMenuSnapshot, { modelFamily: "pro", effort: "extended", autoSwitchToThinking: false }),
    "current bare Pro menu selection should verify extended Pro presets when Standard/Extended rows are gone",
  );
  assert(
    snapshotStronglyMatchesRequestedModel(currentUndifferentiatedProMenuSnapshot, { modelFamily: "pro", effort: "standard", autoSwitchToThinking: false }),
    "current bare Pro menu selection should verify standard Pro presets when Standard/Extended rows are gone",
  );
  assert(matchesCompactIntelligenceControlLabel("Instant 5.5"), "current Instant 5.5 controls should be recognized as compact Intelligence controls");
  assert(matchesCompactIntelligenceControlLabel("Pro"), "current bare Pro controls should be recognized as compact Intelligence controls");
  assert(
    snapshotStronglyMatchesRequestedModel(currentUndifferentiatedProMenuSnapshot.replace('menuitemradio "Pro" [checked=true', 'menuitemradio "Pro" [checked=false').replace('Instant 5.5" [checked=false', 'Instant 5.5" [checked=true'), { modelFamily: "instant", autoSwitchToThinking: false }),
    "current Instant 5.5 menu selection should verify plain instant presets",
  );
  assert(!snapshotHasModelConfigurationUi('- heading "Pro feedback" [level=2, ref=e1]\n- button "Close" [ref=e2]'), "Pro feedback dialogs should not be mistaken for model configuration UI just because they have a Close button");
  assert(snapshotHasModelConfigurationUi(compactProMenuSnapshot), "compact Intelligence menus should be recognized as model configuration UI");
  assert(
    snapshotHasModelConfigurationUi('- menu "IntelligenceInstant5sMedium5–30sHigh15–60sPro5+ minGPT-5.5" [ref=e108]'),
    "compact Intelligence menu labels should match even when tier names are concatenated in the accessibility label",
  );
  assert(matchesCompactIntelligenceOpenerLabel("Medium"), "compact Medium pills should be available to the worker as configuration openers");
  assert(matchesCompactIntelligenceOpenerLabel("High"), "compact High pills should be available to the worker as configuration openers");
  assert(
    snapshotStronglyMatchesRequestedModel(compactProMenuSnapshot, { modelFamily: "pro", effort: "extended", autoSwitchToThinking: false }),
    "compact Pro 5+ min selection should verify extended Pro presets when separate Pro efforts are absent",
  );
  assert(
    snapshotStronglyMatchesRequestedModel(compactProMenuSnapshot, { modelFamily: "pro", effort: "standard", autoSwitchToThinking: false }),
    "compact Pro 5+ min selection should verify standard Pro presets when separate Pro efforts are absent",
  );
  assert(
    !snapshotStronglyMatchesRequestedModel(compactProMenuSnapshot, { modelFamily: "thinking", effort: "extended", autoSwitchToThinking: false }),
    "compact Pro selection should not verify thinking presets",
  );

  const currentProEffortMenuSnapshot = [
    '- button "Pro Extended" [expanded=true, ref=e106]',
    '- menu "Pro Extended" [ref=e108]',
    '- menuitemradio "Instant" [checked=false, ref=e109]',
    '- menuitemradio "Medium" [checked=false, ref=e110]',
    '- menuitemradio "High" [checked=false, ref=e111]',
    '- menuitemradio "Extra High" [checked=false, ref=e112]',
    '- menuitemradio "Pro Extended" [checked=true, ref=e113]',
    '- menuitem "Pro effort options" [expanded=true, ref=e114]',
    '- menuitemradio "Pro Standard" [checked=false, ref=e115]',
    '- menuitemradio "Pro Extended" [checked=true, ref=e116]',
  ].join("\n");
  assert(
    snapshotStronglyMatchesRequestedModel(currentProEffortMenuSnapshot, { modelFamily: "pro", effort: "extended", autoSwitchToThinking: false }),
    "current Pro Extended menu selection should verify extended Pro presets",
  );
  assert(
    !snapshotStronglyMatchesRequestedModel(currentProEffortMenuSnapshot, { modelFamily: "pro", effort: "standard", autoSwitchToThinking: false }),
    "current Pro Extended menu selection should not verify standard Pro presets while Pro Standard is unchecked",
  );
  assert(!effortSelectionVisible(currentProEffortMenuSnapshot, "Standard"), "current Pro Extended menu selection should not satisfy Standard effort visibility");
  assert(effortSelectionVisible(currentProEffortMenuSnapshot, "Extended"), "current Pro Extended menu selection should satisfy Extended effort visibility");
  assert(matchesRequestedModelControlLabel("Pro Standard", { modelFamily: "pro", effort: "standard", autoSwitchToThinking: false }), "current Pro Standard controls should target standard Pro");
  assert(!matchesRequestedModelControlLabel("Pro Extended", { modelFamily: "pro", effort: "standard", autoSwitchToThinking: false }), "current Pro Extended controls should not target standard Pro");

  const compactMediumMenuSnapshot = [
    '- button "Medium" [expanded=true, ref=e106]',
    '- menu "IntelligenceInstant5sMedium5–30sHigh15–60sPro5+ minGPT-5.5" [ref=e108]',
    '- menuitemradio "Instant 5s" [checked=false, ref=e109]',
    '- menuitemradio "Medium 5–30s" [checked=true, ref=e110]',
    '- menuitemradio "High 15–60s" [checked=false, ref=e111]',
    '- menuitemradio "Pro 5+ min" [checked=false, ref=e112]',
  ].join("\n");
  assert(
    snapshotStronglyMatchesRequestedModel(compactMediumMenuSnapshot, { modelFamily: "thinking", effort: "standard", autoSwitchToThinking: false }),
    "compact Medium 5–30s selection should verify standard thinking presets",
  );
  assert(
    snapshotStronglyMatchesRequestedModel(compactMediumMenuSnapshot, { modelFamily: "thinking", effort: "light", autoSwitchToThinking: false }),
    "compact Medium 5–30s selection should be the closest available target for light thinking presets",
  );
  assert(
    !snapshotStronglyMatchesRequestedModel(compactMediumMenuSnapshot, { modelFamily: "thinking", effort: "extended", autoSwitchToThinking: false }),
    "compact Medium 5–30s selection should not verify high thinking presets",
  );

  const compactHighMenuSnapshot = [
    '- button "High" [expanded=true, ref=e106]',
    '- menu "IntelligenceInstant5sMedium5–30sHigh15–60sPro5+ minGPT-5.5" [ref=e108]',
    '- menuitemradio "Instant 5s" [checked=false, ref=e109]',
    '- menuitemradio "Medium 5–30s" [checked=false, ref=e110]',
    '- menuitemradio "High 15–60s" [checked=true, ref=e111]',
    '- menuitemradio "Pro 5+ min" [checked=false, ref=e112]',
  ].join("\n");
  assert(
    snapshotStronglyMatchesRequestedModel(compactHighMenuSnapshot, { modelFamily: "thinking", effort: "extended", autoSwitchToThinking: false }),
    "compact High 15–60s selection should verify extended thinking presets",
  );
  assert(
    !snapshotStronglyMatchesRequestedModel(compactHighMenuSnapshot, { modelFamily: "thinking", effort: "heavy", autoSwitchToThinking: false }),
    "compact High selection should not verify heavy thinking now that Extra High is available",
  );
  assert(
    !snapshotStronglyMatchesRequestedModel(compactHighMenuSnapshot, { modelFamily: "thinking", effort: "standard", autoSwitchToThinking: false }),
    "compact High 15–60s selection should not verify medium thinking presets",
  );

  const currentExtraHighMenuSnapshot = [
    '- button "Extra High" [expanded=true, ref=e106]',
    '- menu "Extra High" [ref=e108]',
    '- menuitemradio "Instant" [checked=false, ref=e109]',
    '- menuitemradio "Medium" [checked=false, ref=e110]',
    '- menuitemradio "High" [checked=false, ref=e111]',
    '- menuitemradio "Extra High" [checked=true, ref=e112]',
    '- menuitemradio "Pro Extended" [checked=false, ref=e113]',
    '- menuitem "GPT-5.5" [expanded=false, ref=e114]',
  ].join("\n");
  assert(snapshotHasModelConfigurationUi(currentExtraHighMenuSnapshot), "current ChatGPT model menu should be recognized without old duration suffixes");
  assert(
    snapshotStronglyMatchesRequestedModel(currentExtraHighMenuSnapshot, { modelFamily: "thinking", effort: "heavy", autoSwitchToThinking: false }),
    "current Extra High menu selection should verify heavy thinking presets",
  );
  assert(
    !snapshotStronglyMatchesRequestedModel(currentExtraHighMenuSnapshot, { modelFamily: "thinking", effort: "extended", autoSwitchToThinking: false }),
    "current Extra High menu selection should not verify extended thinking presets",
  );
  assert(
    !effortSelectionVisible(compactHighMenuSnapshot, "Standard"),
    "unchecked compact Medium rows should not satisfy effort verification while High is selected",
  );
  assert(
    effortSelectionVisible(compactHighMenuSnapshot, "Extended"),
    "checked compact High rows should satisfy extended effort verification",
  );

  const staleMediumPillHighMenuSnapshot = [
    '- button "Medium" [expanded=false, ref=e106]',
    '- menu "IntelligenceInstant5sMedium5–30sHigh15–60sPro5+ minGPT-5.5" [ref=e108]',
    '- menuitemradio "Instant 5s" [checked=false, ref=e109]',
    '- menuitemradio "Medium 5–30s" [checked=false, ref=e110]',
    '- menuitemradio "High 15–60s" [checked=true, ref=e111]',
    '- menuitemradio "Pro 5+ min" [checked=false, ref=e112]',
  ].join("\n");
  assert(
    !snapshotStronglyMatchesRequestedModel(staleMediumPillHighMenuSnapshot, { modelFamily: "thinking", effort: "standard", autoSwitchToThinking: false }),
    "checked compact menu rows should take precedence over stale closed tier pills",
  );
  assert(
    snapshotStronglyMatchesRequestedModel(staleMediumPillHighMenuSnapshot, { modelFamily: "thinking", effort: "extended", autoSwitchToThinking: false }),
    "checked compact High rows should verify even when a stale Medium pill is still visible",
  );
  assert(
    !effortSelectionVisible(staleMediumPillHighMenuSnapshot, "Standard"),
    "stale closed tier pills should not satisfy effort verification while a compact menu is open",
  );

  const compactInstantMenuSnapshot = [
    '- button "Instant" [expanded=true, ref=e106]',
    '- menu "IntelligenceInstant5sMedium5–30sHigh15–60sPro5+ minGPT-5.5" [ref=e108]',
    '- menuitemradio "Instant 5s" [checked=true, ref=e109]',
    '- menuitemradio "Medium 5–30s" [checked=false, ref=e110]',
    '- menuitemradio "High 15–60s" [checked=false, ref=e111]',
    '- menuitemradio "Pro 5+ min" [checked=false, ref=e112]',
  ].join("\n");
  assert(
    snapshotStronglyMatchesRequestedModel(compactInstantMenuSnapshot, { modelFamily: "instant", autoSwitchToThinking: false }),
    "compact Instant 5s selection should verify plain instant presets",
  );
  assert(
    snapshotStronglyMatchesRequestedModel(compactInstantMenuSnapshot, { modelFamily: "instant", autoSwitchToThinking: true }),
    "compact Instant 5s selection should be accepted for auto-switch instant presets when the alternate UI omits the switch",
  );
  assert(snapshotHasModelOpener('- button "Medium" [expanded=false, ref=e106]'), "compact Medium composer pills should be recognized as model openers");
  assert(
    !snapshotStronglyMatchesRequestedModel('- button "Medium" [expanded=false, ref=e106]', { modelFamily: "thinking", effort: "standard", autoSwitchToThinking: false }),
    "closed compact Medium composer pills alone should not verify standard thinking after the menu closes",
  );
  const closedMediumComposerSnapshot = [
    '- button "Add files and more" [expanded=false, ref=e105]',
    '- textbox "Chat with ChatGPT" [ref=e102]',
    '- button "Medium" [expanded=false, ref=e106]',
  ].join("\n");
  assert(
    !snapshotCanSafelySkipModelConfiguration(closedMediumComposerSnapshot, { modelFamily: "thinking", effort: "standard", autoSwitchToThinking: false }),
    "closed compact Medium composer pills should reopen configuration instead of blindly skipping when the compact menu is absent",
  );
  assert(
    snapshotHasClosedCompactSelection(closedMediumComposerSnapshot, { modelFamily: "thinking", effort: "standard", autoSwitchToThinking: false }),
    "closed compact Medium composer pills should verify standard thinking immediately after the worker intentionally clicked the compact menu target",
  );
  assert(
    snapshotHasClosedCompactSelection(closedMediumComposerSnapshot, { modelFamily: "thinking", effort: "light", autoSwitchToThinking: false }),
    "closed compact Medium composer pills should verify light thinking immediately after the worker intentionally clicked the compact menu target",
  );
  assert(
    !snapshotHasClosedCompactSelection(closedMediumComposerSnapshot, { modelFamily: "thinking", effort: "extended", autoSwitchToThinking: false }),
    "closed compact Medium composer pills should not verify extended thinking after a compact menu click",
  );
  assert(
    !snapshotHasClosedCompactSelection(staleMediumPillHighMenuSnapshot, { modelFamily: "thinking", effort: "standard", autoSwitchToThinking: false }),
    "closed compact pills should not verify while an open compact menu has a conflicting checked row",
  );
  const closedInstantComposerSnapshot = [
    '- button "Add files and more" [expanded=false, ref=e105]',
    '- textbox "Chat with ChatGPT" [ref=e102]',
    '- button "Instant" [expanded=false, ref=e106]',
  ].join("\n");
  assert(
    snapshotHasClosedCompactSelection(closedInstantComposerSnapshot, { modelFamily: "instant", autoSwitchToThinking: false }),
    "closed compact Instant composer pills should verify plain instant immediately after the worker intentionally clicked the compact menu target",
  );
  assert(
    snapshotHasClosedCompactSelection(closedInstantComposerSnapshot, { modelFamily: "instant", autoSwitchToThinking: true }),
    "closed compact Instant composer pills should verify instant auto-switch when the compact UI omits the legacy auto-switch control",
  );
  assert(
    !snapshotCanSafelySkipModelConfiguration('- button "Pro" [expanded=false, ref=e106]', { modelFamily: "pro", effort: "extended", autoSwitchToThinking: false }),
    "closed compact Pro composer pills should reopen configuration for effort-sensitive verification instead of blindly skipping",
  );
  assert(matchesCompactIntelligenceControlLabel("Medium"), "current Medium controls should be recognized as compact Intelligence controls");
  assert(matchesRequestedModelControlLabel("Medium", { modelFamily: "thinking", effort: "standard", autoSwitchToThinking: false }), "current Medium controls should target standard thinking");
  assert(matchesRequestedModelControlLabel("High", { modelFamily: "thinking", effort: "extended", autoSwitchToThinking: false }), "current High controls should target extended thinking");
  assert(matchesRequestedModelControlLabel("Extra High", { modelFamily: "thinking", effort: "heavy", autoSwitchToThinking: false }), "current Extra High controls should target heavy thinking");
  assert(matchesRequestedModelControlLabel("Pro Extended", { modelFamily: "pro", effort: "extended", autoSwitchToThinking: false }), "current Pro Extended controls should target extended Pro");

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
    '- button "Model" [ref=e3]',
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

  const settlingChallengeState = classifyChatAuthPage({
    url: "https://chatgpt.com/",
    snapshot: '- Iframe "Widget containing a Cloudflare security challenge" [ref=e1]',
    body: "Verification successful. Waiting for chatgpt.com to respond",
    probe: normalizedProbe,
    allowedOrigins,
    cookieSourceLabel: "Chrome profile Default",
    runtimeProfileDir: "/tmp/oracle-auth-profile",
    logPath: "/tmp/oracle-auth.log",
  });
  assert(settlingChallengeState.state === "unknown", "auth classification should wait while Cloudflare reports verification-successful settling");

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

  const publicLoggedOutState = classifyChatAuthPage({
    url: "https://chatgpt.com/",
    snapshot: [
      readySnapshot,
      '- button "Log in" [ref=e4]',
      '- button "Sign up for free" [ref=e5]',
    ].join("\n"),
    body: "",
    probe: { ...normalizedProbe, ok: false, status: 403, domLoginCta: true, bodyHasId: false, bodyHasEmail: false, bodyKeys: [] },
    allowedOrigins,
    cookieSourceLabel: "Chrome profile Default",
    runtimeProfileDir: "/tmp/oracle-auth-profile",
    logPath: "/tmp/oracle-auth.log",
  });
  assert(publicLoggedOutState.state === "login_required", "auth classification should not accept ChatGPT's public logged-out composer shell as authenticated");
  assert(publicLoggedOutState.message.includes("public login controls"), "public composer login-required guidance should name the visible login controls");

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

  const forbiddenButVisibleReadyState = classifyChatAuthPage({
    url: "https://chatgpt.com/",
    snapshot: readySnapshot,
    body: "",
    probe: { ...normalizedProbe, ok: false, status: 403, domLoginCta: false },
    allowedOrigins,
    cookieSourceLabel: "Chrome profile Default",
    runtimeProfileDir: "/tmp/oracle-auth-profile",
    logPath: "/tmp/oracle-auth.log",
  });
  assert(forbiddenButVisibleReadyState.state === "authenticated_and_ready", "auth classification should not reject a visibly usable authenticated shell solely because /backend-api/me returned 403");

  const noModelLabelReadyState = classifyChatAuthPage({
    url: "https://chatgpt.com/",
    snapshot: [
      '- textbox "Chat with ChatGPT" [ref=e20]',
      '- button "Add files and more" [ref=e21]',
    ].join("\n"),
    body: "",
    probe: normalizedProbe,
    allowedOrigins,
    cookieSourceLabel: "Chrome profile Default",
    runtimeProfileDir: "/tmp/oracle-auth-profile",
    logPath: "/tmp/oracle-auth.log",
  });
  assert(noModelLabelReadyState.state === "authenticated_and_ready", "auth classification should let model configuration handle model-label drift after composer readiness is proven");

  const extendedChipReadyState = classifyChatAuthPage({
    url: "https://chatgpt.com/",
    snapshot: [
      '- textbox "Chat with ChatGPT" [ref=e10]',
      '- button "Add files and more" [ref=e11]',
      '- button "Extended Pro, click to remove" [ref=e12]',
      '- button "Extended Pro" [ref=e13]',
    ].join("\n"),
    body: "",
    probe: normalizedProbe,
    allowedOrigins,
    cookieSourceLabel: "Chrome profile Default",
    runtimeProfileDir: "/tmp/oracle-auth-profile",
    logPath: "/tmp/oracle-auth.log",
  });
  assert(extendedChipReadyState.state === "authenticated_and_ready", "auth classification should treat extended model chips as valid ready-state model controls");

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
  assert(isConversationPathUrl("https://grok.com/chat/abc-123"), "conversation helpers should recognize Grok conversation URLs");
  assert(conversationIdFromUrl("https://grok.com/chat/grok-abc") === "grok-abc", "conversation helpers should parse provider conversation ids from /chat URLs");
  assert(!isConversationPathUrl("https://chatgpt.com/gpts"), "conversation helpers should reject non-conversation ChatGPT routes");
  assert(
    providerSendAccepted({ url: "https://chatgpt.com/", assistantCount: 0, stopStreaming: false }, { url: "https://chatgpt.com/c/abc", assistantCount: 0, stopStreaming: false }),
    "provider send acceptance should accept a new conversation URL transition",
  );
  assert(
    !providerSendAccepted({ url: "https://chatgpt.com/c/abc", assistantCount: 1, stopStreaming: false }, { url: "https://chatgpt.com/c/abc", assistantCount: 1, stopStreaming: false }),
    "provider send acceptance should reject unchanged existing conversation URLs without new response evidence",
  );
  assert(
    !providerSendAccepted({ url: "", urlKnown: false, assistantCount: 1, stopStreaming: false }, { url: "https://chatgpt.com/c/abc", assistantCount: 1, stopStreaming: false }),
    "provider send acceptance should reject URL-only evidence when the pre-send URL was not known",
  );
  assert(
    providerSendAccepted({ url: "https://chatgpt.com/c/abc", assistantCount: 1, stopStreaming: false }, { url: "https://chatgpt.com/c/abc", assistantCount: 1, stopStreaming: true }),
    "provider send acceptance should accept stop-streaming transitions on existing conversations",
  );
  assert(
    providerSendAccepted({ url: "https://chatgpt.com/c/abc", assistantCount: 1, stopStreaming: false }, { url: "https://chatgpt.com/c/abc", assistantCount: 2, stopStreaming: false }),
    "provider send acceptance should accept assistant-count increases on existing conversations",
  );
  assert(
    providerSendAccepted({ url: "https://grok.com/chat/abc", assistantCount: 1, stopStreaming: false }, { url: "https://grok.com/chat/def", assistantCount: 1, stopStreaming: false }),
    "provider send acceptance should accept provider conversation id changes",
  );
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

async function testRunnerAndSmokeFailureContracts(): Promise<void> {
  const fakeBinPrefix = "pi-oracle-sanity-bin-";
  const fakeBinsBefore = new Set((await readdir("/tmp")).filter((name) => name.startsWith(fakeBinPrefix)));
  const badMode = await runProcess(process.execPath, ["scripts/oracle-sanity-runner.mjs", "--mode", "nope"], { timeoutMs: 10_000 });
  assert(badMode.code !== 0, "sanity runner should reject unknown --mode values");
  assert(badMode.stderr.includes("unknown --mode"), "sanity runner should explain unknown --mode failures");
  const leakedFakeBins = (await readdir("/tmp")).filter((name) => name.startsWith(fakeBinPrefix) && !fakeBinsBefore.has(name));
  assert(leakedFakeBins.length === 0, `invalid sanity runner arguments should not leak fake binary directories: ${leakedFakeBins.join(", ")}`);

  const badSmokeMode = await runProcess(process.execPath, ["scripts/oracle-real-smoke.mjs", "run", "--mode", "nope"], { timeoutMs: 10_000 });
  assert(badSmokeMode.code !== 0, "real smoke runner should reject unknown --mode values");
  assert(badSmokeMode.stderr.includes("unknown mode"), "real smoke runner should explain unknown --mode failures");

  const badTimeout = await runProcess(process.execPath, ["scripts/oracle-real-smoke.mjs", "run", "--mode", "source"], {
    env: { ...process.env, PI_ORACLE_REAL_TEST_TIMEOUT_MS: "nope" },
    timeoutMs: 10_000,
  });
  assert(badTimeout.code !== 0, "real smoke runner should reject invalid timeout env before setup");
  assert(badTimeout.stderr.includes("finite positive millisecond value"), "real smoke runner should explain invalid timeout env");
  assert(!badTimeout.stdout.includes("Oracle real smoke mode="), "real smoke runner should fail timeout validation before expensive smoke setup");
}

async function testSanityRunnerIsolation(): Promise<void> {
  const runnerSource = await readFile(new URL("./oracle-sanity-runner.mjs", import.meta.url), "utf8");
  assert(runnerSource.includes("/tmp/pi-oracle-sanity-state-"), "sanity runner should force an isolated oracle state dir");
  assert(runnerSource.includes("/tmp/pi-oracle-sanity-jobs-"), "sanity runner should force an isolated oracle jobs dir");
  assert(!runnerSource.includes("process.env.PI_ORACLE_STATE_DIR?.trim()"), "sanity runner should not reuse inherited production state dir env");
  assert(!runnerSource.includes("process.env.PI_ORACLE_JOBS_DIR?.trim()"), "sanity runner should not reuse inherited production jobs dir env");
  assert((await readFile(new URL("./oracle-sanity.ts", import.meta.url), "utf8")).includes("assertIsolatedSanityEnvironment();"), "sanity entrypoint should fail fast when invoked without isolated oracle temp dirs");
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
  assert(
    JSON.stringify(extractArtifactLabels("f.write(\"ARTIFACT_OK\") and oracle-dogfood-artifact.txt")) === JSON.stringify(["oracle-dogfood-artifact.txt"]),
    "artifact label extraction should ignore common code member calls that look like filenames",
  );
  assert(
    stripChatGptResponseChrome("Stopped thinking\nAnswer body\nDo you like this personality?\n") === "Answer body",
    "ChatGPT response extraction should strip assistant chrome/status/personality feedback lines",
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
    {
      label: "oracle-dogfood-artifact.txt",
      controlLabel: "Download the file",
      paragraphText: "Download the file",
      listItemText: "",
      paragraphInteractiveCount: 1,
      paragraphArtifactLabelCount: 0,
      paragraphOtherTextLength: 0,
      listItemInteractiveCount: 0,
      listItemArtifactLabelCount: 0,
      focusableInteractiveCount: 1,
      focusableArtifactLabelCount: 0,
      focusableOtherTextLength: 0,
      fromResponseTextLabel: true,
    },
  ]);
  assert(successCandidates.some((candidate) => candidate.label === "sup-homie.txt"), "artifact heuristics should preserve real downloadable artifacts");
  assert(successCandidates.some((candidate) => candidate.label === "linked-download.txt"), "artifact heuristics should preserve link-rendered downloadable artifacts");
  assert(successCandidates.some((candidate) => candidate.label === "Attached"), "artifact heuristics should preserve generic Attached download controls");
  assert(successCandidates.some((candidate) => candidate.label === "Done"), "artifact heuristics should preserve generic Done download controls");
  assert(successCandidates.some((candidate) => candidate.label === "butterscotch.txt"), "artifact heuristics should map generic Download controls onto nearby file labels");
  assert(successCandidates.some((candidate) => candidate.label === "oracle-dogfood-artifact.txt"), "artifact heuristics should map generic Download controls onto unique filename labels extracted from response text");

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

  const plainTextFileReferenceCandidates = partitionStructuralArtifactCandidates([
    {
      label: "ChatGPT.com",
      paragraphText: "Do not use it for projects that must never be uploaded to ChatGPT.com or Grok.",
      listItemText: "",
      paragraphInteractiveCount: 1,
      paragraphArtifactLabelCount: 1,
      paragraphOtherTextLength: 76,
      listItemInteractiveCount: 0,
      listItemArtifactLabelCount: 0,
      focusableInteractiveCount: 1,
      focusableArtifactLabelCount: 1,
      focusableOtherTextLength: 76,
    },
  ]);
  assert(plainTextFileReferenceCandidates.confirmed.length === 0, "plain linked/file-looking response text should not become downloadable artifact candidates");
}

async function testPollerHostSafety(): Promise<void> {
  const sessionFile = "/tmp/oracle-sanity-session-host-safety.jsonl";
  const pi = createPiHarness();
  pi.sendMessage = () => undefined;
  const ctx = createExtensionCtx({ getSessionFile: () => sessionFile } as import("@earendil-works/pi-coding-agent").ExtensionContext["sessionManager"], {
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

function sanityProgress(label: string): void {
  if (process.env.PI_ORACLE_SANITY_PROGRESS) console.log(`[oracle-sanity] ${label}`);
}

function createSanityConfig(): OracleConfig {
  return {
    ...DEFAULT_CONFIG,
    browser: { ...DEFAULT_CONFIG.browser, maxConcurrentJobs: 1 },
  };
}

async function runSanityPreamble(): Promise<OracleConfig> {
  assertIsolatedSanityEnvironment();
  await ensureNoActiveJobs();
  assert(DEFAULT_CONFIG.browser.maxConcurrentJobs === 2, "default oracle concurrency should be 2");
  assert(DEFAULT_CONFIG.browser.cloneStrategy === defaultCloneStrategyForPlatform(process.platform), "default oracle clone strategy should use APFS clones only on macOS");
  assert("chromiumKeychain" in DEFAULT_CONFIG.auth, "default auth config should expose optional Chromium keychain support for non-Chrome Chromium-family browsers");
  await testRunnerAndSmokeFailureContracts();
  await testBrowserProfileHelpers();
  return createSanityConfig();
}

async function runPlatformSanity(): Promise<void> {
  const config = await runSanityPreamble();

  sanityProgress("platform auth/config/runtime");
  testAuthCookiePolicy();
  await testConfigRejectsPartialChromiumKeychain();
  await testConfigRejectsChromiumKeychainOffMac();
  await testChromiumCookieSourceReadsConfiguredKeychain();
  await testRuntimeConversationLeases(config);
  await testCleanupPendingRecoveryUnblocksAdmission(config);
  await testCleanupPendingRecoveryTerminatesStaleLiveWorker(config);
  await testCleanupPendingBlocksAdmission(config);
  await testCleanupWarningsWithoutLiveWorkerDoNotBlockAdmission(config);
  await testRuntimeProfileCloneTimeoutKillsHungCp(config);
  await testAuthBootstrapAgentBrowserTimeoutFailsFast(config);
  await testAuthBootstrapReportsEffectiveConfigPaths(config);
  await testProjectConfigRespectsExplicitProjectDistrust();
  await testJobCreationPersistsSelectionSnapshot(config);

  sanityProgress("platform archive/process/helpers");
  await testArchiveDefaultExclusions();
  await testGrokArchiveUsesGzipTarFormat(config);
  await testWorkspaceRootPrefersNearestProjectMarkersOverUnrelatedAncestorGit();
  testArchiveEntryGroupMergeHandlesLargeArrays();
  testArchiveRejectsBlankInputs();
  await testArchiveResolutionPreservesSignificantWhitespace();
  await testArchiveRejectsSymlinkEscapes();
  await testArchiveSubprocessTimeoutKillsHungChildren();
  await testArchiveSubprocessesScrubSafeStoragePasswords();
  await testArchiveBrokenPipeRejectsCleanly();
  await testArchiveAutoPrunesNestedBuildDirsWhenWholeRepoIsTooLarge();
  await testArchiveAutoPrunesSubThresholdGeneratedDirsWhenWholeRepoIsTooLarge();
  await testArchiveOversizeErrorExplainsRetryPlan();
  await testSharedProcessHelpers();
  await testSharedQueuedPromotionHelper();
  testSharedJobCoordinationHelpers();
  testSharedLifecycleHelpers();
  testSharedObservabilityHelpers();
  testAuthFlowHelpers();
  testChatGptFlowHelpers();
  testArtifactCandidateHeuristics();
  await resetOracleStateDir().catch(() => undefined);
  console.log("oracle platform sanity checks passed");
}

async function main() {
  const config = await runSanityPreamble();

  sanityProgress("auth/config/runtime");
  testAuthCookiePolicy();
  await testConfigRejectsPartialChromiumKeychain();
  await testConfigRejectsChromiumKeychainOffMac();
  await testChromiumCookieSourceReadsConfiguredKeychain();
  await testRuntimeConversationLeases(config);
  await testCleanupPendingRecoveryUnblocksAdmission(config);
  await testCleanupPendingRecoveryTerminatesStaleLiveWorker(config);
  await testCleanupPendingBlocksAdmission(config);
  await testCleanupWarningsWithoutLiveWorkerDoNotBlockAdmission(config);
  await testRuntimeProfileCloneTimeoutKillsHungCp(config);
  await testAuthBootstrapAgentBrowserTimeoutFailsFast(config);
  await testAuthBootstrapReportsEffectiveConfigPaths(config);
  await testProjectConfigRespectsExplicitProjectDistrust();
  await testJobCreationPersistsSelectionSnapshot(config);
  sanityProgress("submit/preflight/status");
  await testOracleSubmitPresetGuardrails();
  await testOraclePreflightReportsBlockingReadinessStates();
  await testOracleAuthToolRefreshesSeedProfile();
  await testOracleSubmitPreflightRejectsKnownAuthSeedFailures();
  await testWorkspaceRootProjectIdentityCoversSubdirectories(config);
  await testWorkspaceRootFallsBackToProjectMarkersWithoutGit();
  await testOracleSubmitUsesWorkspaceRootForSubdirectoryCwd(config);
  await testOracleStatusListsRecentJobIdsWhenNoExplicitId(config);
  await testOraclePromptCommandsInjectHiddenInstructions();
  await testOracleStatusAndReadEmitPrintModeOutput(config);
  await testOracleCancelCommandRequiresExplicitJobId(config);
  await testOracleToolResultsExposeStructuredJobDetails(config);
  await testOracleReadAndStatusSummariesKeepTerminalFailuresProminent(config);
  await testOracleReadSummaryShowsHeartbeatFreshness(config);
  await testOracleToolErrorsExposeStructuredMetadata();
  await testOracleCleanRefusesTerminalJobsWithinWakeupRetentionGrace(config);
  await testOracleCleanRefusesTerminalJobsWithLiveWorkers(config);
  sanityProgress("queue/reconcile");
  await testStaleReconcileDoesNotOverwriteConcurrentCompletion(config);
  await testActiveCancellationDoesNotOverwriteCompletion(config);
  await testCancelReconcileRacePreservesIntentionalCancellation(config);
  await testQueueAdmissionPromotionAndCancellation(config);
  await testQueuedPromotionUsesPersistedConfigSnapshot(config);
  await testQueuedPromotionRequiresArchiveReadiness(config);
  await testQueuedCancellationSerializesWithPromotion(config);
  await testCancelCleanupWarningsDoNotPromoteQueuedJobs(config);
  await testQueuedCleanupWarningsRetryArchiveDeletion(config);
  await testQueuedArchivePressureCountsRetainedCancelledPreSubmitArchives(config);
  await testCancelToolAndCommandMessagesAreTruthful(config);
  await testCancelFailureDoesNotPromoteQueuedJobs(config);
  await testQueuedPromotionPersistsCleanupWarningsOnTeardownFailure(config);
  await testQueuedPromotionKillsWorkerWhenMetadataWriteFails(config);
  await testQueuedPromotionToleratesWorkerStateAdvance(config);
  await testQueuedPromotionReusesSameJobConversationLease(config);
  await testQueuedPromotionSkipsConversationBlockedJobs(config);
  sanityProgress("poller/locks/lifecycle");
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
  sanityProgress("archive");
  await testArchiveDefaultExclusions();
  await testGrokArchiveUsesGzipTarFormat(config);
  await testWorkspaceRootPrefersNearestProjectMarkersOverUnrelatedAncestorGit();
  testArchiveEntryGroupMergeHandlesLargeArrays();
  testArchiveRejectsBlankInputs();
  await testArchiveResolutionPreservesSignificantWhitespace();
  await testArchiveRejectsSymlinkEscapes();
  await testArchiveSubprocessTimeoutKillsHungChildren();
  await testArchiveSubprocessesScrubSafeStoragePasswords();
  await testArchiveBrokenPipeRejectsCleanly();
  await testArchiveAutoPrunesNestedBuildDirsWhenWholeRepoIsTooLarge();
  await testArchiveAutoPrunesSubThresholdGeneratedDirsWhenWholeRepoIsTooLarge();
  await testArchiveOversizeErrorExplainsRetryPlan();
  sanityProgress("shared/helper suites");
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
  sanityProgress("poller host safety");
  await testPollerHostSafety();
  await resetOracleStateDir().catch(() => undefined);
  console.log("oracle sanity checks passed");
}

if (process.env.PI_ORACLE_SANITY_MODE === "platform") {
  await runPlatformSanity();
} else {
  await main();
}
