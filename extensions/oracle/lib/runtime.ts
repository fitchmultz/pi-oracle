// Purpose: Manage oracle browser runtime allocation, lease admission, seed/runtime profile handling, and runtime cleanup for the extension side.
// Responsibilities: Allocate runtimes, enforce persisted-session requirements, acquire/release runtime and conversation leases, and clean up runtime artifacts safely.
// Scope: Extension-side runtime coordination only; shared concurrency/process primitives live in extensions/oracle/shared.
// Usage: Imported by jobs, tools, and queue logic to provision or tear down isolated oracle browser runtimes.
// Invariants/Assumptions: Lease metadata is the admission source of truth, tracked worker identity checks defend against PID reuse, and runtime cleanup always attempts lease release.
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { constants as fsConstants, existsSync, realpathSync, readFileSync } from "node:fs";
import { access, cp as copyDirectory, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { delimiter, dirname, join } from "node:path";
import { assertNotKnownBrowserUserDataPath, sweetCookieSafeStoragePasswordScrubbedEnv } from "../shared/browser-profile-helpers.mjs";
import { jobBlocksAdmission } from "../shared/job-coordination-helpers.mjs";
import { isTrackedProcessAlive } from "../shared/process-helpers.mjs";
import { getOracleJobsDir } from "../shared/state-path-helpers.mjs";
import type { OracleConfig, OracleProvider } from "./config.js";
import { getOracleHostDisplayName, getOracleProjectConfigDirName } from "./host.js";
import { createLease, listLeaseMetadata, readLeaseMetadata, releaseLease, withAuthLock } from "./locks.js";
import { resolveOracleProviderArchivePlan } from "./provider-capabilities.js";

const SEED_GENERATION_FILE = ".oracle-seed-generation";
const AGENT_BROWSER_BIN = [process.env.AGENT_BROWSER_PATH, "/opt/homebrew/bin/agent-browser", "/usr/local/bin/agent-browser"].find(
  (candidate) => typeof candidate === "string" && candidate && existsSync(candidate),
) || "agent-browser";
const PROFILE_CLONE_TIMEOUT_MS = 120_000;
const ORACLE_SUBPROCESS_KILL_GRACE_MS = 2_000;

function killProcessTree(child: ReturnType<typeof spawn>): void {
  if (process.platform === "win32" && child.pid) {
    spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore", windowsHide: true })
      .on("error", () => undefined);
    return;
  }
  child.kill("SIGTERM");
}

function killProcess(child: ReturnType<typeof spawn>): void {
  if (process.platform === "win32" && child.pid) {
    spawn("taskkill", ["/pid", String(child.pid), "/f"], { stdio: "ignore", windowsHide: true })
      .on("error", () => undefined);
    return;
  }
  child.kill("SIGKILL");
}

const ORACLE_PROJECT_CONFIG_DIR = getOracleProjectConfigDirName();
const WORKSPACE_ROOT_MARKERS = [
  join(ORACLE_PROJECT_CONFIG_DIR, "extensions", "oracle.json"),
  ORACLE_PROJECT_CONFIG_DIR,
  "AGENTS.md",
] as const;

function cpCommand(): string {
  return process.env.PI_ORACLE_CP_PATH?.trim() || "cp";
}

function requiredOracleDependencies(config: OracleConfig, provider = config.defaults.provider): Array<{ name: string; command: string }> {
  const archivePlan = resolveOracleProviderArchivePlan(provider);
  const dependencies = [
    { name: "agent-browser", command: AGENT_BROWSER_BIN },
    { name: "tar", command: "tar" },
  ];
  if (archivePlan.requiresZstd) {
    dependencies.push({ name: "zstd", command: "zstd" });
  }
  if (config.browser.cloneStrategy === "apfs-clone" && process.platform === "darwin") {
    dependencies.push({ name: "cp", command: cpCommand() });
  }
  return dependencies;
}

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

function resolveRealCwd(cwd: string): string {
  try {
    return realpathSync(cwd);
  } catch {
    return cwd;
  }
}

function hasWorkspaceRootMarker(path: string): boolean {
  return WORKSPACE_ROOT_MARKERS.some((marker) => existsSync(join(path, marker)));
}

function resolveWorkspaceRoot(realCwd: string): string {
  let current = realCwd;
  let nearestMarkerRoot: string | undefined;
  while (true) {
    if (!nearestMarkerRoot && hasWorkspaceRootMarker(current)) nearestMarkerRoot = current;
    if (existsSync(join(current, ".git"))) return nearestMarkerRoot ?? current;
    const parent = dirname(current);
    if (parent === current) return nearestMarkerRoot ?? realCwd;
    current = parent;
  }
}

export function getProjectId(cwd: string): string {
  return resolveWorkspaceRoot(resolveRealCwd(cwd));
}

export function hasPersistedSessionFile(originSessionFile: string | undefined): originSessionFile is string {
  return Boolean(originSessionFile);
}

export function requirePersistedSessionFile(originSessionFile: string | undefined, action = "use oracle"): string {
  if (!originSessionFile) {
    throw new Error(`Oracle requires a persisted ${getOracleHostDisplayName()} session to ${action}. Start or save a real session before using oracle.`);
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

function missingAuthSeedProfileMessage(seedDir: string): string {
  return `Oracle auth seed profile not found: ${seedDir}. Run /oracle-auth first.`;
}

function invalidAuthSeedProfileTypeMessage(seedDir: string): string {
  return `Oracle auth seed profile is not a directory: ${seedDir}. Remove the invalid path or rerun /oracle-auth.`;
}

function unreadableAuthSeedProfileMessage(seedDir: string): string {
  return `Oracle auth seed profile is not readable: ${seedDir}. Fix its permissions or rerun /oracle-auth.`;
}

function unauthenticatedAuthSeedProfileMessage(seedDir: string): string {
  return `Oracle auth seed profile exists but is not authenticated: ${seedDir}. Run /oracle-auth to create a verified auth seed before submitting oracle jobs.`;
}

function missingBrowserExecutableMessage(executablePath: string): string {
  return `Configured oracle browser executable does not exist: ${executablePath}. Fix browser.executablePath or install Chrome there.`;
}

function nonExecutableBrowserMessage(executablePath: string): string {
  return `Configured oracle browser executable is not executable: ${executablePath}. Fix browser.executablePath permissions or point it at a runnable Chrome binary.`;
}

function missingLocalDependencyMessage(name: string): string {
  return `Oracle prerequisite not found on PATH: ${name}. Install ${name} and retry.`;
}

function unsafeOracleProfilePathMessage(label: string, path: string, error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return `Oracle ${label} path is unsafe: ${path}. ${message}`;
}

function assertSafeOracleProfilePath(
  path: string,
  label: "auth seed profile" | "runtime profile" | "runtime profiles",
  config?: OracleConfig,
): void {
  try {
    assertNotKnownBrowserUserDataPath(path, `Oracle ${label}`, {
      cookieSources: config ? { chromeProfile: config.auth.chromeProfile, chromeCookiePath: config.auth.chromeCookiePath } : undefined,
    });
  } catch (error) {
    throw new Error(unsafeOracleProfilePathMessage(label, path, error));
  }
}

function unwritableOracleDirectoryMessage(label: "runtime profiles" | "jobs", path: string): string {
  return `Oracle ${label} directory is not writable: ${path}. Fix its permissions or configure a writable path, then retry.`;
}

async function isExecutableFile(path: string): Promise<boolean> {
  try {
    const stats = await stat(path);
    if (!stats.isFile()) return false;
    await access(path, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function executableNameCandidates(command: string): string[] {
  if (process.platform !== "win32" || /\.[^\\/]+$/.test(command)) return [command];
  const extensions = (process.env.PATHEXT || ".COM;.EXE;.BAT;.CMD;.PS1").split(";").filter(Boolean);
  return [command, ...extensions.map((extension) => `${command}${extension.toLowerCase()}`), ...extensions.map((extension) => `${command}${extension.toUpperCase()}`)];
}

async function resolveExecutableOnPath(command: string): Promise<string | undefined> {
  if (!command) return undefined;
  if (command.includes("/") || command.includes("\\")) {
    for (const candidate of executableNameCandidates(command)) {
      if (await isExecutableFile(candidate)) return candidate;
    }
    return undefined;
  }

  const pathValue = process.env.PATH ?? "";
  for (const segment of pathValue.split(delimiter)) {
    if (!segment) continue;
    for (const name of executableNameCandidates(command)) {
      const candidate = join(segment, name);
      if (await isExecutableFile(candidate)) return candidate;
    }
  }
  return undefined;
}

async function assertConfiguredBrowserExecutableReady(executablePath: string | undefined): Promise<void> {
  if (!executablePath) return;
  let executableStats;
  try {
    executableStats = await stat(executablePath);
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
    if (code === "ENOENT") throw new Error(missingBrowserExecutableMessage(executablePath));
    if (code === "EACCES" || code === "EPERM") throw new Error(nonExecutableBrowserMessage(executablePath));
    throw new Error(`Failed to inspect configured oracle browser executable ${executablePath}: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (!executableStats.isFile()) {
    throw new Error(nonExecutableBrowserMessage(executablePath));
  }

  try {
    await access(executablePath, fsConstants.X_OK);
  } catch {
    throw new Error(nonExecutableBrowserMessage(executablePath));
  }
}

async function assertRequiredLocalDependencyReady(name: string, command: string): Promise<void> {
  const resolved = await resolveExecutableOnPath(command);
  if (!resolved) throw new Error(missingLocalDependencyMessage(name));
}

async function assertWritableDirectory(path: string, label: "runtime profiles" | "jobs"): Promise<void> {
  try {
    await mkdir(path, { recursive: true, mode: 0o700 });
  } catch {
    throw new Error(unwritableOracleDirectoryMessage(label, path));
  }

  let directoryStats;
  try {
    directoryStats = await stat(path);
  } catch {
    throw new Error(unwritableOracleDirectoryMessage(label, path));
  }
  if (!directoryStats.isDirectory()) {
    throw new Error(unwritableOracleDirectoryMessage(label, path));
  }

  try {
    await access(path, fsConstants.W_OK | fsConstants.X_OK);
  } catch {
    throw new Error(unwritableOracleDirectoryMessage(label, path));
  }
}

export async function assertOracleAuthSeedProfileReady(config: OracleConfig): Promise<void> {
  const seedDir = config.browser.authSeedProfileDir;
  assertSafeOracleProfilePath(seedDir, "auth seed profile", config);
  let seedStats;
  try {
    seedStats = await stat(seedDir);
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
    if (code === "ENOENT") throw new Error(missingAuthSeedProfileMessage(seedDir));
    if (code === "EACCES" || code === "EPERM") throw new Error(unreadableAuthSeedProfileMessage(seedDir));
    throw new Error(`Failed to inspect oracle auth seed profile ${seedDir}: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (!seedStats.isDirectory()) {
    throw new Error(invalidAuthSeedProfileTypeMessage(seedDir));
  }

  try {
    await access(seedDir, fsConstants.R_OK | fsConstants.X_OK);
  } catch {
    throw new Error(unreadableAuthSeedProfileMessage(seedDir));
  }

  if (!getSeedGeneration(config)) {
    throw new Error(unauthenticatedAuthSeedProfileMessage(seedDir));
  }
}

export async function assertOracleSubmitPrerequisites(config: OracleConfig, provider: OracleProvider = config.defaults.provider): Promise<void> {
  assertSafeOracleProfilePath(config.browser.runtimeProfilesDir, "runtime profiles", config);
  await assertOracleAuthSeedProfileReady(config);
  await assertConfiguredBrowserExecutableReady(config.browser.executablePath);
  for (const dependency of requiredOracleDependencies(config, provider)) {
    await assertRequiredLocalDependencyReady(dependency.name, dependency.command);
  }
  await assertWritableDirectory(config.browser.runtimeProfilesDir, "runtime profiles");
  await assertWritableDirectory(getOracleJobsDir(), "jobs");
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
  const path = join(getOracleJobsDir(), `oracle-${jobId}`, "job.json");
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
  if (config.browser.cloneStrategy === "apfs-clone" && process.platform === "darwin") {
    return ["-cR", sourceDir, destinationDir];
  }
  return ["-R", sourceDir, destinationDir];
}

async function spawnCp(args: string[], options?: { timeoutMs?: number }): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(cpCommand(), args, { env: sweetCookieSafeStoragePasswordScrubbedEnv(), stdio: ["ignore", "pipe", "pipe"], shell: process.platform === "win32" });
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
        killProcessTree(child);
        killGraceTimer = setTimeout(() => {
          killProcess(child);
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

async function removeChromiumProcessSingletonArtifacts(profileDir: string): Promise<void> {
  await Promise.all([
    rm(join(profileDir, "SingletonLock"), { force: true }),
    rm(join(profileDir, "SingletonSocket"), { force: true }),
    rm(join(profileDir, "SingletonCookie"), { force: true }),
    rm(join(profileDir, "DevToolsActivePort"), { force: true }),
  ]);
}

export async function cloneSeedProfileToRuntime(
  config: OracleConfig,
  runtimeProfileDir: string,
  options?: { cpTimeoutMs?: number },
): Promise<string | undefined> {
  const seedDir = config.browser.authSeedProfileDir;
  await assertOracleAuthSeedProfileReady(config);
  assertSafeOracleProfilePath(runtimeProfileDir, "runtime profile", config);

  await withAuthLock({ runtimeProfileDir, seedDir }, async () => {
    await rm(runtimeProfileDir, { recursive: true, force: true }).catch(() => undefined);
    await mkdir(dirname(runtimeProfileDir), { recursive: true, mode: 0o700 }).catch(() => undefined);
    if (config.browser.cloneStrategy === "apfs-clone" && process.platform === "darwin") {
      await spawnCp(profileCloneArgs(config, seedDir, runtimeProfileDir), { timeoutMs: options?.cpTimeoutMs ?? PROFILE_CLONE_TIMEOUT_MS });
    } else {
      await copyDirectory(seedDir, runtimeProfileDir, { recursive: true, force: true, verbatimSymlinks: true });
    }
    await removeChromiumProcessSingletonArtifacts(runtimeProfileDir);
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
    const child = spawn(AGENT_BROWSER_BIN, ["--session", runtimeSessionName, "close"], { env: sweetCookieSafeStoragePasswordScrubbedEnv(), stdio: "ignore", shell: process.platform === "win32" });
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
      killProcessTree(child);
      setTimeout(() => {
        killProcess(child);
        finish(`Timed out closing agent-browser session ${runtimeSessionName} after ${AGENT_BROWSER_CLOSE_TIMEOUT_MS}ms`);
      }, 2_000).unref?.();
    }, AGENT_BROWSER_CLOSE_TIMEOUT_MS);
    timeout.unref?.();

    child.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") {
        finish();
        return;
      }
      finish(`Failed to close agent-browser session ${runtimeSessionName}: ${error.message}`);
    });
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
    try {
      assertSafeOracleProfilePath(runtime.runtimeProfileDir, "runtime profile");
      await rm(runtime.runtimeProfileDir, { recursive: true, force: true });
    } catch (error) {
      report.warnings.push(`Failed to remove runtime profile ${runtime.runtimeProfileDir}: ${error instanceof Error ? error.message : String(error)}`);
    }
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
