// Purpose: Register oracle extension tools and implement submit/read/cancel behavior.
// Responsibilities: Validate tool parameters, create archives, enqueue or dispatch jobs, and surface job state.
// Scope: Tool-facing orchestration only; durable job storage, locks, runtime leases, and config live in sibling modules.
// Usage: Imported by the oracle extension entrypoint and sanity tests to register tools against the pi API.
// Invariants/Assumptions: The pi runtime validates TypeBox schemas before execute, while execute owns semantic normalization.
import { randomUUID } from "node:crypto";
import { lstat, mkdtemp, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, posix } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { formatOracleJobSummary, formatOracleSubmitResponse } from "../shared/job-observability-helpers.mjs";
import { getLatestOracleJobLifecycleEvent, getLatestOracleTerminalLifecycleEvent, transitionOracleJobPhase } from "../shared/job-lifecycle-helpers.mjs";
import { isLockTimeoutError, withGlobalReconcileLock, withLock } from "./locks.js";
import {
  coerceOracleSubmitPresetId,
  loadOracleConfig,
  ORACLE_SUBMIT_PRESET_IDS,
  resolveOracleSubmitPreset,
} from "./config.js";
import {
  appendCleanupWarnings,
  cancelOracleJob,
  createJob,
  getJobDir,
  getSessionFile,
  hasDurableWorkerHandoff,
  hasRetainedPreSubmitArchive,
  isOpenOracleJob,
  isTerminalOracleJob,
  listOracleJobDirs,
  markWakeupSettled,
  readJob,
  pruneTerminalOracleJobs,
  reconcileStaleOracleJobs,
  resolveArchiveInputs,
  sha256File,
  shouldAdvanceQueueAfterCancellation,
  spawnWorker,
  terminateWorkerPid,
  updateJob,
  type OracleJob,
} from "./jobs.js";
import { getQueuePosition, promoteQueuedJobs, promoteQueuedJobsWithinAdmissionLock } from "./queue.js";
import { refreshOracleStatus } from "./poller.js";
import {
  allocateRuntime,
  assertOracleSubmitPrerequisites,
  cleanupRuntimeArtifacts,
  getProjectId,
  getSessionId,
  hasPersistedSessionFile,
  parseConversationId,
  requirePersistedSessionFile,
  tryAcquireConversationLease,
  tryAcquireRuntimeLease,
} from "./runtime.js";

const ORACLE_SUBMIT_PARAMS = Type.Object({
  prompt: Type.String({ description: "Prompt text to send to ChatGPT web." }),
  files: Type.Array(Type.String({
    description: "Project-relative file or directory path to include in the archive.",
    minLength: 1,
    pattern: ".*\\S.*",
  }), {
    description: "Exact project-relative files/directories to include in the oracle archive.",
    minItems: 1,
  }),
  preset: Type.Optional(
    Type.String({
      description:
        "ChatGPT model preset. Omit to use the configured default preset. Canonical ids are preferred; matching human-readable preset labels and common hyphen/space variants are normalized automatically.",
    }),
  ),
  followUpJobId: Type.Optional(Type.String({ description: "Earlier oracle job id whose chat thread should be continued." })),
});

const ORACLE_READ_PARAMS = Type.Object({
  jobId: Type.String({ description: "Oracle job id." }),
});

const ORACLE_CANCEL_PARAMS = Type.Object({
  jobId: Type.String({ description: "Oracle job id." }),
});

const MAX_ARCHIVE_BYTES = 250 * 1024 * 1024;
const MAX_QUEUED_JOBS_PER_ACTIVE_RUNTIME = 1;
const MAX_QUEUED_ARCHIVE_BYTES_PER_ACTIVE_RUNTIME = MAX_ARCHIVE_BYTES;
const ARCHIVE_COMMAND_TIMEOUT_MS = 120_000;
const ARCHIVE_COMMAND_KILL_GRACE_MS = 2_000;

const DEFAULT_ARCHIVE_EXCLUDED_DIR_NAMES_ANYWHERE = new Set([
  ".git",
  ".hg",
  ".svn",
  ".pi",
  ".oracle-context",
  ".cursor",
  "node_modules",
  "target",
  ".venv",
  "venv",
  "__pycache__",
  ".pytest_cache",
  ".mypy_cache",
  ".ruff_cache",
  ".tox",
  ".nox",
  ".hypothesis",
  ".next",
  ".nuxt",
  ".svelte-kit",
  ".turbo",
  ".parcel-cache",
  ".cache",
  ".gradle",
  ".terraform",
  "DerivedData",
  ".build",
  ".pnpm-store",
  ".serverless",
  ".aws-sam",
  "secrets",
  ".secrets",
]);
const DEFAULT_ARCHIVE_EXCLUDED_DIR_NAMES_AT_REPO_ROOT = new Set(["coverage", "htmlcov", "tmp", "temp", ".tmp", "dist", "build", "out"]);
const DEFAULT_ARCHIVE_EXCLUDED_FILES = new Set([
  ".coverage",
  ".DS_Store",
  ".env",
  ".netrc",
  ".npmrc",
  ".pypirc",
  ".scratchpad.md",
  "Thumbs.db",
  "id_dsa",
  "id_ecdsa",
  "id_ed25519",
  "id_rsa",
]);
const DEFAULT_ARCHIVE_EXCLUDED_SUFFIXES = [".db", ".key", ".p12", ".pfx", ".pyc", ".pyd", ".pyo", ".pem", ".sqlite", ".sqlite3", ".tsbuildinfo", ".tfstate"];
const DEFAULT_ARCHIVE_EXCLUDED_SUBSTRINGS = [".tfstate."];
const DEFAULT_ARCHIVE_EXCLUDED_ENV_ALLOWLIST = new Set([".env.dist", ".env.example", ".env.sample", ".env.template"]);
const DEFAULT_ARCHIVE_EXCLUDED_PATH_SEQUENCES = [[".yarn", "cache"]] as const;
const ADAPTIVE_ARCHIVE_PRUNE_DIR_NAMES_ANYWHERE = new Set(["build", "dist", "out", "coverage", "htmlcov", "tmp", "temp", ".tmp"]);
const ADAPTIVE_ARCHIVE_PRUNE_PROTECTED_ANCESTOR_DIR_NAMES = new Set(["src", "source", "sources", "lib"]);

type ArchiveSizeBreakdownRow = { relativePath: string; bytes: number };
type ArchiveCreationResult = {
  sha256: string;
  archiveBytes: number;
  initialArchiveBytes?: number;
  autoPrunedPrefixes: ArchiveSizeBreakdownRow[];
  includedEntries: string[];
};

function pathContainsSequence(relativePath: string, sequence: readonly string[]): boolean {
  const segments = relativePath.split("/").filter(Boolean);
  if (sequence.length === 0 || segments.length < sequence.length) return false;
  for (let index = 0; index <= segments.length - sequence.length; index += 1) {
    if (sequence.every((segment, offset) => segments[index + offset] === segment)) return true;
  }
  return false;
}

function getRelativeDepth(relativePath: string): number {
  return relativePath.split("/").filter(Boolean).length;
}

function formatBytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(2)} MiB`;
}

function formatDirectoryLabel(relativePath: string): string {
  return relativePath.endsWith("/") ? relativePath : `${relativePath}/`;
}

function summarizeByKey(
  entrySizes: ArchiveSizeBreakdownRow[],
  keyForEntry: (relativePath: string) => string | undefined,
  limit = 7,
): ArchiveSizeBreakdownRow[] {
  const totals = new Map<string, number>();
  for (const entry of entrySizes) {
    const key = keyForEntry(entry.relativePath);
    if (!key) continue;
    totals.set(key, (totals.get(key) ?? 0) + entry.bytes);
  }
  return [...totals.entries()]
    .map(([relativePath, bytes]) => ({ relativePath, bytes }))
    .sort((left, right) => right.bytes - left.bytes || left.relativePath.localeCompare(right.relativePath))
    .slice(0, limit);
}

function summarizeTopLevelIncludedPaths(entrySizes: ArchiveSizeBreakdownRow[]): ArchiveSizeBreakdownRow[] {
  return summarizeByKey(entrySizes, (relativePath) => {
    const [topLevel, ...rest] = relativePath.split("/").filter(Boolean);
    if (!topLevel) return undefined;
    return rest.length > 0 ? `${topLevel}/` : topLevel;
  });
}

function getAdaptivePrunePrefix(relativePath: string): string | undefined {
  const segments = relativePath.split("/").filter(Boolean);
  for (let index = 0; index < segments.length - 1; index += 1) {
    const name = segments[index];
    if (!ADAPTIVE_ARCHIVE_PRUNE_DIR_NAMES_ANYWHERE.has(name)) continue;
    const ancestors = segments.slice(0, index);
    if (ancestors.some((segment) => ADAPTIVE_ARCHIVE_PRUNE_PROTECTED_ANCESTOR_DIR_NAMES.has(segment))) continue;
    return segments.slice(0, index + 1).join("/");
  }
  return undefined;
}

function summarizeAdaptivePruneCandidates(
  entrySizes: ArchiveSizeBreakdownRow[],
  minimumBytes = 0,
): ArchiveSizeBreakdownRow[] {
  return summarizeByKey(entrySizes, getAdaptivePrunePrefix, Number.POSITIVE_INFINITY).filter((entry) => entry.bytes >= minimumBytes);
}

function pruneEntriesByPrefix(entries: string[], prefix: string): string[] {
  return entries.filter((entry) => entry !== prefix && !entry.startsWith(`${prefix}/`));
}

function shouldExcludeArchivePath(relativePath: string, isDirectory: boolean, options?: { forceInclude?: boolean }): boolean {
  const normalized = posix.normalize(relativePath).replace(/^\.\//, "");
  if (!normalized || normalized === ".") return false;
  if (options?.forceInclude) return false;
  const name = basename(normalized);
  if (DEFAULT_ARCHIVE_EXCLUDED_PATH_SEQUENCES.some((sequence) => pathContainsSequence(normalized, sequence))) return true;
  if (isDirectory) {
    if (DEFAULT_ARCHIVE_EXCLUDED_DIR_NAMES_ANYWHERE.has(name)) return true;
    if (getRelativeDepth(normalized) === 1 && DEFAULT_ARCHIVE_EXCLUDED_DIR_NAMES_AT_REPO_ROOT.has(name)) return true;
    return false;
  }
  if (DEFAULT_ARCHIVE_EXCLUDED_FILES.has(name)) return true;
  if (name.startsWith(".env.") && !DEFAULT_ARCHIVE_EXCLUDED_ENV_ALLOWLIST.has(name)) return true;
  if (DEFAULT_ARCHIVE_EXCLUDED_SUFFIXES.some((suffix) => name.endsWith(suffix))) return true;
  if (DEFAULT_ARCHIVE_EXCLUDED_SUBSTRINGS.some((needle) => name.includes(needle))) return true;
  return false;
}

async function isSymlinkToDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

async function shouldExcludeArchiveChild(
  absolutePath: string,
  relativePath: string,
  child: { isDirectory(): boolean; isSymbolicLink(): boolean },
  options?: { forceInclude?: boolean },
): Promise<boolean> {
  const isDirectoryLike = child.isDirectory() || (child.isSymbolicLink() && await isSymlinkToDirectory(absolutePath));
  return shouldExcludeArchivePath(relativePath, isDirectoryLike, options);
}

async function expandArchiveEntries(cwd: string, relativePath: string, options?: { forceIncludeSubtree?: boolean }): Promise<string[]> {
  const normalized = posix.normalize(relativePath).replace(/^\.\//, "");
  if (normalized === ".") {
    const children = await readdir(cwd, { withFileTypes: true });
    const results: string[] = [];
    for (const child of children.sort((a, b) => a.name.localeCompare(b.name))) {
      const childRelative = child.name;
      if (await shouldExcludeArchiveChild(join(cwd, childRelative), childRelative, child)) continue;
      if (child.isDirectory()) results.push(...await expandArchiveEntries(cwd, childRelative));
      else results.push(childRelative);
    }
    return results;
  }

  const absolute = join(cwd, normalized);
  const entry = await lstat(absolute);
  if (!entry.isDirectory()) return [normalized];
  if (shouldExcludeArchivePath(normalized, true, { forceInclude: options?.forceIncludeSubtree })) return [];

  const children = await readdir(absolute, { withFileTypes: true });
  const results: string[] = [];
  for (const child of children.sort((a, b) => a.name.localeCompare(b.name))) {
    const childRelative = posix.join(normalized, child.name);
    if (await shouldExcludeArchiveChild(join(cwd, childRelative), childRelative, child, { forceInclude: options?.forceIncludeSubtree })) continue;
    if (child.isDirectory()) results.push(...await expandArchiveEntries(cwd, childRelative, { forceIncludeSubtree: options?.forceIncludeSubtree }));
    else results.push(childRelative);
  }
  return results;
}

async function resolveExpandedArchiveEntriesFromInputs(
  cwd: string,
  entries: Array<{ absolute: string; relative: string }>,
): Promise<string[]> {
  return Array.from(new Set((await Promise.all(entries.map(async (entry) => {
    const statEntry = await lstat(entry.absolute);
    const forceIncludeSubtree = statEntry.isDirectory() && entry.relative !== "." && shouldExcludeArchivePath(entry.relative, true);
    return expandArchiveEntries(cwd, entry.relative, { forceIncludeSubtree });
  }))).flat())).sort();
}

export async function resolveExpandedArchiveEntries(cwd: string, files: string[]): Promise<string[]> {
  return resolveExpandedArchiveEntriesFromInputs(cwd, resolveArchiveInputs(cwd, files));
}

function isWholeRepoArchiveSelection(entries: Array<{ absolute: string; relative: string }>): boolean {
  return entries.length === 1 && entries[0]?.relative === ".";
}

async function measureArchiveEntrySizes(cwd: string, entries: string[]): Promise<ArchiveSizeBreakdownRow[]> {
  return Promise.all(entries.map(async (relativePath) => ({ relativePath, bytes: (await lstat(join(cwd, relativePath))).size })));
}

function formatArchiveOversizeError(args: {
  archiveBytes: number;
  maxBytes: number;
  entrySizes: ArchiveSizeBreakdownRow[];
  autoPrunedPrefixes: ArchiveSizeBreakdownRow[];
  adaptivePruneMinBytes?: number;
}): string {
  const topLevel = summarizeTopLevelIncludedPaths(args.entrySizes);
  const adaptiveCandidates = summarizeAdaptivePruneCandidates(args.entrySizes, args.adaptivePruneMinBytes).slice(0, 7);
  return [
    `Oracle archive exceeds ChatGPT upload limit after default exclusions${args.autoPrunedPrefixes.length > 0 ? " and automatic generic generated-output-dir pruning" : ""}: ${args.archiveBytes} bytes >= ${args.maxBytes} bytes`,
    args.autoPrunedPrefixes.length > 0 ? "Automatically pruned generic generated-output paths before failing:" : undefined,
    ...args.autoPrunedPrefixes.map((entry) => `- ${formatDirectoryLabel(entry.relativePath)} — ${formatBytes(entry.bytes)}`),
    topLevel.length > 0 ? "Approx top-level included sizes:" : undefined,
    ...topLevel.map((entry) => `- ${entry.relativePath} — ${formatBytes(entry.bytes)}`),
    adaptiveCandidates.length > 0 ? "Largest remaining generic generated-output-dir candidates:" : undefined,
    ...adaptiveCandidates.map((entry) => `- ${formatDirectoryLabel(entry.relativePath)} — ${formatBytes(entry.bytes)}`),
    "Retry with narrower archive inputs, starting with modified files plus adjacent files plus directly relevant subtrees.",
  ]
    .filter(Boolean)
    .join("\n");
}

async function writeArchiveFile(
  cwd: string,
  entries: string[],
  archivePath: string,
  listPath: string,
  options?: { commandTimeoutMs?: number },
): Promise<number> {
  await writeFile(listPath, Buffer.from(`${entries.join("\0")}\0`), { mode: 0o600 });
  await rm(archivePath, { force: true }).catch(() => undefined);

  const { spawn } = await import("node:child_process");
  await new Promise<void>((resolvePromise, rejectPromise) => {
    const tar = spawn("tar", ["--null", "-cf", "-", "-T", listPath], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const zstd = spawn("zstd", ["-19", "-T0", "-f", "-o", archivePath], {
      stdio: ["pipe", "ignore", "pipe"],
    });

    let stderr = "";
    let settled = false;
    let timedOut = false;
    let timeout: NodeJS.Timeout | undefined;
    let killGraceTimer: NodeJS.Timeout | undefined;
    let tarCode: number | null | undefined;
    let zstdCode: number | null | undefined;

    const clearTimers = () => {
      if (timeout) clearTimeout(timeout);
      if (killGraceTimer) clearTimeout(killGraceTimer);
    };

    const terminateChildren = () => {
      tar.kill("SIGTERM");
      zstd.kill("SIGTERM");
      killGraceTimer = setTimeout(() => {
        tar.kill("SIGKILL");
        zstd.kill("SIGKILL");
      }, ARCHIVE_COMMAND_KILL_GRACE_MS);
      killGraceTimer.unref?.();
    };

    const finish = (error?: Error) => {
      if (settled) return;
      if (error) {
        settled = true;
        clearTimers();
        terminateChildren();
        rejectPromise(error);
        return;
      }
      if (tarCode === undefined || zstdCode === undefined) return;
      settled = true;
      clearTimers();
      if (timedOut) {
        rejectPromise(new Error(stderr || `Oracle archive subprocess timed out after ${options?.commandTimeoutMs ?? ARCHIVE_COMMAND_TIMEOUT_MS}ms`));
        return;
      }
      if (tarCode === 0 && zstdCode === 0) resolvePromise();
      else rejectPromise(new Error(stderr || `archive command failed (tar=${tarCode}, zstd=${zstdCode})`));
    };

    const commandTimeoutMs = options?.commandTimeoutMs ?? ARCHIVE_COMMAND_TIMEOUT_MS;
    if (commandTimeoutMs > 0) {
      timeout = setTimeout(() => {
        timedOut = true;
        stderr = `${stderr}${stderr ? "\n" : ""}Oracle archive subprocess timed out after ${commandTimeoutMs}ms`;
        terminateChildren();
      }, commandTimeoutMs);
      timeout.unref?.();
    }

    tar.stderr.on("data", (data) => {
      stderr += String(data);
    });
    zstd.stderr.on("data", (data) => {
      stderr += String(data);
    });
    tar.on("error", (error) => finish(error instanceof Error ? error : new Error(String(error))));
    zstd.on("error", (error) => finish(error instanceof Error ? error : new Error(String(error))));
    tar.on("close", (code) => {
      tarCode = code;
      finish();
    });
    zstd.on("close", (code) => {
      zstdCode = code;
      finish();
    });
    tar.stdout.pipe(zstd.stdin);
  });

  return (await stat(archivePath)).size;
}

export async function createArchiveForTesting(
  cwd: string,
  files: string[],
  archivePath: string,
  options?: { maxBytes?: number; adaptivePruneMinBytes?: number; commandTimeoutMs?: number },
): Promise<ArchiveCreationResult> {
  const archiveInputs = resolveArchiveInputs(cwd, files);
  const wholeRepoSelection = isWholeRepoArchiveSelection(archiveInputs);
  let expandedEntries = await resolveExpandedArchiveEntriesFromInputs(cwd, archiveInputs);
  if (expandedEntries.length === 0) {
    throw new Error("Oracle archive inputs are empty after default exclusions");
  }

  const listDir = await mkdtemp(join(tmpdir(), "oracle-filelist-"));
  const listPath = join(listDir, "files.list");
  const maxBytes = options?.maxBytes ?? MAX_ARCHIVE_BYTES;
  const adaptivePruneMinBytes = options?.adaptivePruneMinBytes ?? 0;
  const autoPrunedPrefixes: ArchiveSizeBreakdownRow[] = [];
  let initialArchiveBytes: number | undefined;

  try {
    while (true) {
      if (expandedEntries.length === 0) {
        throw new Error("Oracle archive inputs are empty after default exclusions and automatic size pruning");
      }

      const archiveBytes = await writeArchiveFile(cwd, expandedEntries, archivePath, listPath, { commandTimeoutMs: options?.commandTimeoutMs });
      if (archiveBytes < maxBytes) {
        return {
          sha256: await sha256File(archivePath),
          archiveBytes,
          initialArchiveBytes,
          autoPrunedPrefixes,
          includedEntries: [...expandedEntries],
        };
      }

      if (initialArchiveBytes === undefined) initialArchiveBytes = archiveBytes;
      const entrySizes = await measureArchiveEntrySizes(cwd, expandedEntries);
      if (!wholeRepoSelection) {
        throw new Error(formatArchiveOversizeError({ archiveBytes, maxBytes, entrySizes, autoPrunedPrefixes, adaptivePruneMinBytes }));
      }

      const nextCandidate = summarizeAdaptivePruneCandidates(entrySizes, adaptivePruneMinBytes).find(
        (entry) => !autoPrunedPrefixes.some((pruned) => pruned.relativePath === entry.relativePath),
      );
      if (!nextCandidate) {
        throw new Error(formatArchiveOversizeError({ archiveBytes, maxBytes, entrySizes, autoPrunedPrefixes, adaptivePruneMinBytes }));
      }

      autoPrunedPrefixes.push(nextCandidate);
      expandedEntries = pruneEntriesByPrefix(expandedEntries, nextCandidate.relativePath);
    }
  } finally {
    await rm(listDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function createArchive(cwd: string, files: string[], archivePath: string): Promise<ArchiveCreationResult> {
  return createArchiveForTesting(cwd, files, archivePath);
}

export interface QueuedArchivePressure {
  queuedJobs: number;
  queuedArchiveBytes: number;
}

export async function getQueuedArchivePressure(): Promise<QueuedArchivePressure> {
  const jobs = listOracleJobDirs()
    .map((dir) => readJob(dir))
    .filter((job): job is NonNullable<typeof job> => Boolean(job));

  const queuedArchiveBytes = (await Promise.all(
    jobs
      .filter((job) => hasRetainedPreSubmitArchive(job))
      .map(async (job) => {
        try {
          return (await stat(job.archivePath)).size;
        } catch {
          return 0;
        }
      }),
  )).reduce((sum, bytes) => sum + bytes, 0);

  return {
    queuedJobs: jobs.filter((job) => job.status === "queued").length,
    queuedArchiveBytes,
  };
}

export function getQueueAdmissionFailure(args: {
  queuePressure: QueuedArchivePressure;
  archiveBytes: number;
  activeJobs: number;
  maxActiveJobs: number;
  maxQueuedJobs: number;
  maxQueuedArchiveBytes: number;
}): string | undefined {
  if (args.queuePressure.queuedJobs >= args.maxQueuedJobs) {
    return (
      `Oracle is busy (${args.activeJobs}/${args.maxActiveJobs} active, ${args.queuePressure.queuedJobs}/${args.maxQueuedJobs} queued). ` +
      "Retry later instead of enqueuing more archive state."
    );
  }

  const queuedArchiveBytes = args.queuePressure.queuedArchiveBytes + args.archiveBytes;
  if (queuedArchiveBytes > args.maxQueuedArchiveBytes) {
    return (
      `Oracle queued archive storage is full (${queuedArchiveBytes} bytes > ${args.maxQueuedArchiveBytes} bytes across queued jobs and retained pre-submit archives). ` +
      "Retry later or narrow the archive inputs."
    );
  }

  return undefined;
}

function resolveFollowUp(previousJobId: string | undefined, cwd: string): {
  followUpToJobId?: string;
  chatUrl?: string;
  conversationId?: string;
} {
  if (!previousJobId) return {};
  const previous = readJob(previousJobId);
  if (!previous) {
    throw new Error(`Follow-up oracle job not found: ${previousJobId}`);
  }
  if (previous.projectId !== getProjectId(cwd)) {
    throw new Error(`Follow-up oracle job ${previousJobId} belongs to a different project`);
  }
  if (previous.status !== "complete") {
    throw new Error(`Follow-up oracle job ${previousJobId} is not complete`);
  }
  if (!previous.chatUrl) {
    throw new Error(`Follow-up oracle job ${previousJobId} has no persisted chat URL`);
  }
  return {
    followUpToJobId: previous.id,
    chatUrl: previous.chatUrl,
    conversationId: previous.conversationId || parseConversationId(previous.chatUrl),
  };
}

type OracleToolName = "oracle_submit" | "oracle_read" | "oracle_cancel";
type OracleToolErrorSource = OracleToolName | "oracle_preflight";
type OracleQueueSnapshot = { queued: boolean; position?: number; depth?: number };
type OracleToolErrorDetails = {
  code: string;
  message: string;
  rejectedValue?: string;
  allowedValues?: string[];
  suggestedNextStep?: string;
};
type OracleToolJobDetailsOptions = {
  queue?: OracleQueueSnapshot;
  archiveBytes?: number;
  initialArchiveBytes?: number;
  autoPrunedArchivePaths?: ArchiveSizeBreakdownRow[];
  responsePreview?: string;
  responseAvailable?: boolean;
};

const ORACLE_TOOL_NAMES = new Set<OracleToolName>(["oracle_submit", "oracle_read", "oracle_cancel"]);

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function buildOracleQueueSnapshot(
  job: NonNullable<ReturnType<typeof readJob>>,
  queuePosition?: { position: number; depth: number },
): OracleQueueSnapshot {
  return {
    queued: job.status === "queued",
    position: queuePosition?.position,
    depth: queuePosition?.depth,
  };
}

function redactJobDetails(
  job: NonNullable<ReturnType<typeof readJob>>,
  options: OracleToolJobDetailsOptions = {},
) {
  const lastEvent = getLatestOracleJobLifecycleEvent(job);
  const terminalEvent = getLatestOracleTerminalLifecycleEvent(job);
  return {
    id: job.id,
    status: job.status,
    phase: job.phase,
    projectId: job.projectId,
    sessionId: job.sessionId,
    createdAt: job.createdAt,
    queuedAt: job.queuedAt,
    submittedAt: job.submittedAt,
    completedAt: job.completedAt,
    promptPath: job.promptPath,
    archivePath: job.archivePath,
    archiveSha256: job.archiveSha256,
    archiveBytes: options.archiveBytes,
    initialArchiveBytes: options.initialArchiveBytes,
    autoPrunedArchivePaths: options.autoPrunedArchivePaths ?? [],
    queue: options.queue ?? buildOracleQueueSnapshot(job),
    followUpToJobId: job.followUpToJobId,
    chatUrl: job.chatUrl,
    conversationId: job.conversationId,
    responsePath: job.responsePath,
    responseFormat: job.responseFormat,
    responseAvailable: options.responseAvailable ?? false,
    responsePreview: options.responsePreview,
    artifactsPath: `${getJobDir(job.id)}/artifacts`,
    artifactPaths: job.artifactPaths,
    artifactFailureCount: job.artifactFailureCount,
    artifactsManifestPath: job.artifactsManifestPath,
    workerLogPath: job.workerLogPath,
    archiveDeletedAfterUpload: job.archiveDeletedAfterUpload,
    runtimeId: job.runtimeId,
    cleanupWarnings: job.cleanupWarnings,
    lastCleanupAt: job.lastCleanupAt,
    terminalEvent: terminalEvent ? { ...terminalEvent } : undefined,
    lastEvent: lastEvent ? { ...lastEvent } : undefined,
    error: job.error,
    lifecycleEvents: job.lifecycleEvents,
  };
}

function buildOracleToolErrorDetails(toolName: OracleToolErrorSource, error: unknown, params: Record<string, unknown>): OracleToolErrorDetails {
  const message = getErrorMessage(error);

  if (toolName === "oracle_submit" && typeof params.preset === "string" && message.startsWith("Unknown oracle_submit preset:")) {
    return {
      code: "invalid_preset",
      message,
      rejectedValue: params.preset,
      allowedValues: [...ORACLE_SUBMIT_PRESET_IDS],
      suggestedNextStep: "Retry with one of the canonical preset ids, or omit preset to use the configured default.",
    };
  }

  if (message.startsWith("Oracle requires a persisted pi session")) {
    return {
      code: "persisted_session_required",
      message,
      suggestedNextStep: "Start or save a persisted pi session, then retry oracle_submit.",
    };
  }

  if (message.startsWith("Oracle auth seed profile not found: ")) {
    return {
      code: "auth_seed_profile_missing",
      message,
      rejectedValue: message.replace(/^Oracle auth seed profile not found: /, "").replace(/\. Run \/oracle-auth first\.$/, ""),
      suggestedNextStep: "Run /oracle-auth first, then retry the oracle tool call.",
    };
  }

  if (message.startsWith("Oracle auth seed profile is not readable: ")) {
    return {
      code: "auth_seed_profile_unreadable",
      message,
      rejectedValue: message.replace(/^Oracle auth seed profile is not readable: /, "").replace(/\. Fix its permissions or rerun \/oracle-auth\.$/, ""),
      suggestedNextStep: "Fix the auth seed profile permissions or rerun /oracle-auth, then retry.",
    };
  }

  if (message.startsWith("Oracle auth seed profile is not a directory: ")) {
    return {
      code: "auth_seed_profile_invalid_type",
      message,
      rejectedValue: message.replace(/^Oracle auth seed profile is not a directory: /, "").replace(/\. Remove the invalid path or rerun \/oracle-auth\.$/, ""),
      suggestedNextStep: "Remove the invalid auth seed path or rerun /oracle-auth to recreate it.",
    };
  }

  if (message.startsWith("Failed to parse oracle config ") || message.startsWith("Invalid oracle config:") || message.startsWith("Invalid oracle project config:")) {
    return {
      code: "oracle_config_invalid",
      message,
      suggestedNextStep: "Fix the oracle config and retry once the configured paths and values are valid.",
    };
  }

  if (message.startsWith("Configured oracle browser executable does not exist: ")) {
    return {
      code: "browser_executable_missing",
      message,
      rejectedValue: message.replace(/^Configured oracle browser executable does not exist: /, "").replace(/\. Fix browser\.executablePath or install Chrome there\.$/, ""),
      suggestedNextStep: "Fix browser.executablePath or install Chrome at that path, then retry.",
    };
  }

  if (message.startsWith("Configured oracle browser executable is not executable: ")) {
    return {
      code: "browser_executable_not_executable",
      message,
      rejectedValue: message.replace(/^Configured oracle browser executable is not executable: /, "").replace(/\. Fix browser\.executablePath permissions or point it at a runnable Chrome binary\.$/, ""),
      suggestedNextStep: "Fix browser.executablePath permissions or point it at a runnable Chrome binary, then retry.",
    };
  }

  if (message.startsWith("Oracle prerequisite not found on PATH: ")) {
    const rejectedValue = message.replace(/^Oracle prerequisite not found on PATH: /, "").replace(/\. Install .*$/, "");
    return {
      code: "local_dependency_missing",
      message,
      rejectedValue,
      suggestedNextStep: `Install ${rejectedValue || "the missing dependency"} and retry.`,
    };
  }

  if (message.startsWith("Oracle runtime profiles directory is not writable: ")) {
    return {
      code: "runtime_profiles_dir_unwritable",
      message,
      rejectedValue: message.replace(/^Oracle runtime profiles directory is not writable: /, "").replace(/\. Fix its permissions or configure a writable path, then retry\.$/, ""),
      suggestedNextStep: "Fix browser.runtimeProfilesDir permissions or configure a writable directory, then retry.",
    };
  }

  if (message.startsWith("Oracle jobs directory is not writable: ")) {
    return {
      code: "jobs_dir_unwritable",
      message,
      rejectedValue: message.replace(/^Oracle jobs directory is not writable: /, "").replace(/\. Fix its permissions or configure a writable path, then retry\.$/, ""),
      suggestedNextStep: "Fix PI_ORACLE_JOBS_DIR permissions or point it at a writable directory, then retry.",
    };
  }

  if (toolName === "oracle_submit" && message === "oracle_submit requires at least one file or directory to archive") {
    return {
      code: "archive_input_required",
      message,
      suggestedNextStep: "Pass at least one project-relative file or directory in files.",
    };
  }

  if (toolName === "oracle_submit" && message === "Archive input must be a non-empty project-relative path") {
    return {
      code: "archive_input_blank",
      message,
      suggestedNextStep: "Retry with a non-empty project-relative file or directory path. Use '.' only when you intentionally want a whole-repo archive.",
    };
  }

  if (toolName === "oracle_submit" && message === "Archive input must use '.' exactly for a whole-repo archive") {
    return {
      code: "archive_input_whole_repo_sentinel_invalid",
      message,
      suggestedNextStep: "If you want a whole-repo archive, pass '.' exactly. Otherwise pass an exact project-relative path without extra padding.",
    };
  }

  if (toolName === "oracle_submit" && message.startsWith("Archive input does not exist: ")) {
    return {
      code: "archive_input_missing",
      message,
      rejectedValue: message.replace(/^Archive input does not exist: /, ""),
      suggestedNextStep: "Retry with an existing project-relative file or directory.",
    };
  }

  if (toolName === "oracle_submit" && message.startsWith("Archive input must be inside the project cwd: ")) {
    return {
      code: "archive_input_outside_project",
      message,
      rejectedValue: message.replace(/^Archive input must be inside the project cwd: /, ""),
      suggestedNextStep: "Retry with a path inside the current project cwd.",
    };
  }

  if (toolName === "oracle_submit" && message.startsWith("Archive input must resolve inside the project cwd without symlink escapes: ")) {
    return {
      code: "archive_input_symlink_escape",
      message,
      rejectedValue: message.replace(/^Archive input must resolve inside the project cwd without symlink escapes: /, ""),
      suggestedNextStep: "Retry with a real project-relative path that does not escape the repo through symlinks.",
    };
  }

  if (toolName === "oracle_submit" && message.startsWith("Follow-up oracle job not found: ")) {
    return {
      code: "follow_up_job_not_found",
      message,
      rejectedValue: typeof params.followUpJobId === "string" ? params.followUpJobId : undefined,
      suggestedNextStep: "Retry with a completed oracle job id from this project that has a persisted chat URL.",
    };
  }

  if (toolName === "oracle_submit" && message.includes("belongs to a different project")) {
    return {
      code: "follow_up_job_wrong_project",
      message,
      rejectedValue: typeof params.followUpJobId === "string" ? params.followUpJobId : undefined,
      suggestedNextStep: "Retry with a follow-up job id from the current project.",
    };
  }

  if (toolName === "oracle_submit" && message.includes("is not complete")) {
    return {
      code: "follow_up_job_not_complete",
      message,
      rejectedValue: typeof params.followUpJobId === "string" ? params.followUpJobId : undefined,
      suggestedNextStep: "Wait for the earlier oracle job to finish, then retry the follow-up.",
    };
  }

  if (toolName === "oracle_submit" && message.includes("has no persisted chat URL")) {
    return {
      code: "follow_up_job_missing_chat_url",
      message,
      rejectedValue: typeof params.followUpJobId === "string" ? params.followUpJobId : undefined,
      suggestedNextStep: "Retry with an earlier completed oracle job that recorded a chat URL.",
    };
  }

  if ((toolName === "oracle_read" || toolName === "oracle_cancel") && typeof params.jobId === "string" && message.startsWith("Oracle job not found in this project:")) {
    return {
      code: "job_not_found",
      message,
      rejectedValue: params.jobId,
      suggestedNextStep: "Use /oracle-status to discover a valid job id for this project, then retry.",
    };
  }

  if (toolName === "oracle_submit" && message.startsWith("Oracle archive exceeds ChatGPT upload limit")) {
    return {
      code: "archive_too_large",
      message,
      suggestedNextStep: "Retry with a narrower archive, starting with modified files plus adjacent files plus directly relevant subtrees.",
    };
  }

  return {
    code: `${toolName}_failed`,
    message,
    suggestedNextStep: "Inspect the error message, correct the inputs or environment, and retry.",
  };
}

function buildOracleToolErrorResult(
  toolName: OracleToolName,
  error: unknown,
  params: Record<string, unknown>,
  options?: { job?: NonNullable<ReturnType<typeof readJob>>; jobDetails?: OracleToolJobDetailsOptions },
) {
  const errorDetails = buildOracleToolErrorDetails(toolName, error, params);
  return {
    content: [{
      type: "text" as const,
      text: [
        errorDetails.message,
        errorDetails.suggestedNextStep ? `Suggested next step: ${errorDetails.suggestedNextStep}` : undefined,
      ].filter(Boolean).join("\n"),
    }],
    details: {
      job: options?.job ? redactJobDetails(options.job, options.jobDetails) : undefined,
      error: errorDetails,
    },
  };
}

type OraclePreflightDetails = {
  ready: boolean;
  session: {
    persisted: boolean;
    sessionFile?: string;
  };
  config: {
    ready: boolean;
  };
  auth: {
    ready: boolean;
    seedProfileDir?: string;
  };
  error?: OracleToolErrorDetails;
};

function formatOraclePreflightResponse(details: OraclePreflightDetails): string {
  if (details.ready) {
    return [
      "Oracle preflight ready.",
      details.session.sessionFile ? `Persisted session: ${details.session.sessionFile}` : undefined,
      details.auth.seedProfileDir ? `Auth seed profile: ${details.auth.seedProfileDir}` : undefined,
      "You can continue with oracle context gathering and submission.",
    ].filter(Boolean).join("\n");
  }

  return [
    `Oracle preflight blocked: ${details.error?.message ?? "unknown blocker"}`,
    details.error?.suggestedNextStep ? `Suggested next step: ${details.error.suggestedNextStep}` : undefined,
  ].filter(Boolean).join("\n");
}

async function runOraclePreflight(ctx: ExtensionContext): Promise<OraclePreflightDetails> {
  const sessionFile = getSessionFile(ctx);
  if (!hasPersistedSessionFile(sessionFile)) {
    return {
      ready: false,
      session: { persisted: false },
      config: { ready: false },
      auth: { ready: false },
      error: buildOracleToolErrorDetails(
        "oracle_preflight",
        new Error("Oracle requires a persisted pi session to submit oracle jobs. Start or save a real session before using oracle."),
        {},
      ),
    };
  }

  let config;
  try {
    config = loadOracleConfig(ctx.cwd);
  } catch (error) {
    return {
      ready: false,
      session: { persisted: true, sessionFile },
      config: { ready: false },
      auth: { ready: false },
      error: buildOracleToolErrorDetails("oracle_preflight", error, {}),
    };
  }

  try {
    await assertOracleSubmitPrerequisites(config);
  } catch (error) {
    const errorDetails = buildOracleToolErrorDetails("oracle_preflight", error, {});
    return {
      ready: false,
      session: { persisted: true, sessionFile },
      config: { ready: true },
      auth: {
        ready: !["auth_seed_profile_missing", "auth_seed_profile_unreadable", "auth_seed_profile_invalid_type"].includes(errorDetails.code),
        seedProfileDir: config.browser.authSeedProfileDir,
      },
      error: errorDetails,
    };
  }

  return {
    ready: true,
    session: { persisted: true, sessionFile },
    config: { ready: true },
    auth: {
      ready: true,
      seedProfileDir: config.browser.authSeedProfileDir,
    },
  };
}

export function registerOracleTools(pi: ExtensionAPI, workerPath: string): void {
  pi.on("tool_result", async (event) => {
    if (!ORACLE_TOOL_NAMES.has(event.toolName as OracleToolName)) return;
    if (event.isError) return;
    const details = asRecord(event.details);
    const errorDetails = asRecord(details?.error);
    if (typeof errorDetails?.code === "string" && typeof errorDetails?.message === "string") {
      return { isError: true };
    }
  });

  pi.registerTool({
    name: "oracle_preflight",
    label: "Oracle Preflight",
    description: "Check whether oracle is ready in this session before spending time gathering context or preparing a submission.",
    promptSnippet: "Check oracle readiness before expensive /oracle preparation.",
    promptGuidelines: [
      "Call oracle_preflight before doing expensive /oracle preparation. If ready is false, stop immediately and report the suggested next step instead of reading files or crafting archive inputs.",
    ],
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      const details = await runOraclePreflight(ctx);
      return {
        content: [{ type: "text" as const, text: formatOraclePreflightResponse(details) }],
        details,
      };
    },
  });

  pi.registerTool({
    name: "oracle_submit",
    label: "Oracle Submit",
    description:
      "Dispatch a background ChatGPT web oracle job after gathering context. Always pass a prompt and exact project-relative archive inputs. " +
      "Optional ChatGPT model: set parameter `preset`, or omit it for configured defaults; canonical preset ids are listed in the README and ORACLE_SUBMIT_PRESETS registry, and matching labels are normalized at submit time.",
    promptSnippet: "Dispatch a background ChatGPT web oracle job after gathering repo context.",
    promptGuidelines: [
      "Gather context before calling oracle_submit.",
      "By default, archive the whole repo by passing '.'; default archive exclusions apply automatically, including common bulky outputs and obvious credentials/private data like .env files, key material, credential dotfiles, local database files, and nested secrets directories anywhere in the repo.",
      "Only narrow file selection when the user explicitly asks, the task is clearly scoped smaller, or privacy/sensitivity requires it.",
      "For very targeted asks like a single function or stack trace, a smaller archive is preferable.",
      "When files='.' and the post-exclusion archive is still too large, submit automatically prunes the largest nested directories matching generic generated-output names like build/, dist/, out/, coverage/, and tmp/ outside obvious source roots like src/ and lib/ until the archive fits or no candidate remains; successful submissions report what was pruned.",
      "If a submitted oracle job later fails because upload is rejected, retry smaller: remove the largest obviously irrelevant/generated content first, then narrow to modified files plus adjacent files plus directly relevant subtrees, then explain the cut or ask the user if still needed.",
      "If oracle_submit itself fails because the local archive still exceeds the upload limit after default exclusions and automatic generic generated-output-dir pruning, or for any other submit-time error, stop and report the error instead of retrying automatically.",
      "If oracle_submit returns a queued job instead of an immediately dispatched one, treat that as success and stop exactly the same way.",
      "Stop after dispatching oracle_submit; do not continue the task while the oracle job is running.",
      "Use `preset` as the only model-selection parameter on oracle_submit. Canonical ids are preferred, and matching human-readable preset labels are normalized automatically. Omit preset to use the configured default.",
    ],
    parameters: ORACLE_SUBMIT_PARAMS,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      try {
        const projectCwd = getProjectId(ctx.cwd);
        const config = loadOracleConfig(projectCwd);
        const originSessionFile = requirePersistedSessionFile(getSessionFile(ctx), "submit oracle jobs");
        const projectId = getProjectId(projectCwd);
        const sessionId = getSessionId(originSessionFile, projectId);
        const presetId = typeof params.preset === "string" ? coerceOracleSubmitPresetId(params.preset) : config.defaults.preset;
        const selection = resolveOracleSubmitPreset(presetId);
        const followUp = resolveFollowUp(params.followUpJobId, projectCwd);
        // Validate caller-specified archive paths before surfacing unrelated local setup failures such as a missing auth seed profile.
        resolveArchiveInputs(projectCwd, params.files);
        await assertOracleSubmitPrerequisites(config);
        try {
          await withGlobalReconcileLock({ processPid: process.pid, source: "oracle_submit", cwd: projectCwd }, async () => {
            await reconcileStaleOracleJobs();
            await pruneTerminalOracleJobs();
          });
        } catch (error) {
          if (!isLockTimeoutError(error, "reconcile", "global")) throw error;
        }

        const jobId = randomUUID();
        const tempArchivePath = join(tmpdir(), `oracle-archive-${jobId}.tar.zst`);
        const runtime = allocateRuntime(config);
        let job: OracleJob | undefined;
        let archive: ArchiveCreationResult | undefined;
        let queued = false;
        let queuedSubmissionDurable = false;
        let runtimeLeaseAcquired = false;
        let conversationLeaseAcquired = false;
        let workerSpawned = false;
        let spawnedWorker: Awaited<ReturnType<typeof spawnWorker>> | undefined;

        try {
          archive = await createArchive(projectCwd, params.files, tempArchivePath);
          const currentArchive = archive;
          await withLock("admission", "global", { jobId, processPid: process.pid }, async () => {
            await promoteQueuedJobsWithinAdmissionLock({ workerPath, source: "oracle_submit" });

            const admittedAt = new Date().toISOString();
            const runtimeAttempt = await tryAcquireRuntimeLease(config, {
              jobId,
              runtimeId: runtime.runtimeId,
              runtimeSessionName: runtime.runtimeSessionName,
              runtimeProfileDir: runtime.runtimeProfileDir,
              projectId,
              sessionId,
              createdAt: admittedAt,
            });

            if (!runtimeAttempt.acquired) {
              const queuePressure = await getQueuedArchivePressure();
              const maxQueuedJobs = config.browser.maxConcurrentJobs * MAX_QUEUED_JOBS_PER_ACTIVE_RUNTIME;
              const maxQueuedArchiveBytes = config.browser.maxConcurrentJobs * MAX_QUEUED_ARCHIVE_BYTES_PER_ACTIVE_RUNTIME;
              const queueAdmissionFailure = getQueueAdmissionFailure({
                queuePressure,
                archiveBytes: currentArchive.archiveBytes,
                activeJobs: runtimeAttempt.liveLeases.length,
                maxActiveJobs: config.browser.maxConcurrentJobs,
                maxQueuedJobs,
                maxQueuedArchiveBytes,
              });
              if (queueAdmissionFailure) {
                throw new Error(queueAdmissionFailure);
              }

              queued = true;
              job = await createJob(
                jobId,
                {
                  prompt: params.prompt,
                  files: params.files,
                  selection,
                  followUpToJobId: followUp.followUpToJobId,
                  chatUrl: followUp.chatUrl,
                  requestSource: "tool",
                },
                projectCwd,
                originSessionFile,
                config,
                runtime,
                { initialState: "queued", createdAt: admittedAt },
              );
              await rename(tempArchivePath, job.archivePath);
              job = await updateJob(job.id, (current) => ({
                ...current,
                archiveSha256: currentArchive.sha256,
              }));
              queuedSubmissionDurable = true;
              return;
            }

            runtimeLeaseAcquired = true;
            if (followUp.conversationId) {
              const conversationAttempt = await tryAcquireConversationLease({
                jobId,
                conversationId: followUp.conversationId,
                projectId,
                sessionId,
                createdAt: admittedAt,
              });
              if (!conversationAttempt.acquired) {
                throw new Error(
                  `Oracle conversation ${followUp.conversationId} is already in use by job ${conversationAttempt.blocker?.jobId ?? "unknown"}. ` +
                    "Concurrent follow-ups to the same ChatGPT thread are not allowed.",
                );
              }
              conversationLeaseAcquired = true;
            }

            job = await createJob(
              jobId,
              {
                prompt: params.prompt,
                files: params.files,
                selection,
                followUpToJobId: followUp.followUpToJobId,
                chatUrl: followUp.chatUrl,
                requestSource: "tool",
              },
              projectCwd,
              originSessionFile,
              config,
              runtime,
              { initialState: "submitted", createdAt: admittedAt },
            );
            await rename(tempArchivePath, job.archivePath);
            spawnedWorker = await spawnWorker(workerPath, job.id);
            workerSpawned = true;
            const worker = spawnedWorker;
            job = await updateJob(job.id, (current) => ({
              ...current,
              archiveSha256: currentArchive.sha256,
              workerPid: worker.pid,
              workerNonce: worker.nonce,
              workerStartedAt: worker.startedAt,
            }));
          });
          if (!job || !archive) throw new Error(`Oracle submission ${jobId} did not persist job metadata durably`);
          if (ctx.hasUI) refreshOracleStatus(ctx);

          const queuePosition = queued ? getQueuePosition(job.id) : undefined;
          return {
            content: [
              {
                type: "text",
                text: formatOracleSubmitResponse(job, {
                  autoPrunedPrefixes: archive.autoPrunedPrefixes,
                  queued,
                  queuePosition: queuePosition?.position,
                  queueDepth: queuePosition?.depth,
                }),
              },
            ],
            details: {
              job: redactJobDetails(job, {
                queue: buildOracleQueueSnapshot(job, queuePosition),
                archiveBytes: archive.archiveBytes,
                initialArchiveBytes: archive.initialArchiveBytes,
                autoPrunedArchivePaths: archive.autoPrunedPrefixes,
              }),
            },
          };
        } catch (error) {
          const message = getErrorMessage(error);
          const latest = job ? readJob(job.id) : undefined;
          if (latest?.status === "queued" && queuedSubmissionDurable) {
            if (ctx.hasUI) refreshOracleStatus(ctx);
            const queuePosition = getQueuePosition(latest.id);
            return {
              content: [
                {
                  type: "text",
                  text: formatOracleSubmitResponse(latest, {
                    autoPrunedPrefixes: archive?.autoPrunedPrefixes ?? [],
                    queued: true,
                    queuePosition: queuePosition?.position,
                    queueDepth: queuePosition?.depth,
                  }),
                },
              ],
              details: {
                job: redactJobDetails(latest, {
                  queue: buildOracleQueueSnapshot(latest, queuePosition),
                  archiveBytes: archive?.archiveBytes,
                  initialArchiveBytes: archive?.initialArchiveBytes,
                  autoPrunedArchivePaths: archive?.autoPrunedPrefixes,
                }),
              },
            };
          }
          if (workerSpawned && latest && hasDurableWorkerHandoff(latest)) {
            if (ctx.hasUI) refreshOracleStatus(ctx);
            return {
              content: [
                {
                  type: "text",
                  text: formatOracleSubmitResponse(latest, {
                    autoPrunedPrefixes: archive?.autoPrunedPrefixes ?? [],
                    queued: false,
                  }),
                },
              ],
              details: {
                job: redactJobDetails(latest, {
                  queue: buildOracleQueueSnapshot(latest),
                  archiveBytes: archive?.archiveBytes,
                  initialArchiveBytes: archive?.initialArchiveBytes,
                  autoPrunedArchivePaths: archive?.autoPrunedPrefixes,
                }),
              },
            };
          }
          if (spawnedWorker) {
            await terminateWorkerPid(spawnedWorker.pid, spawnedWorker.startedAt).catch(() => undefined);
          }
          if (job && (!latest || !isTerminalOracleJob(latest))) {
            const failedAt = new Date().toISOString();
            await updateJob(job.id, (current) => transitionOracleJobPhase(current, "failed", {
              at: failedAt,
              source: "oracle:submit",
              message: `Submission failed before durable worker handoff: ${message}`,
              patch: {
                error: message,
              },
            })).catch(() => undefined);
          }
          const cleanupReport = await cleanupRuntimeArtifacts({
            runtimeId: runtimeLeaseAcquired ? runtime.runtimeId : undefined,
            runtimeProfileDir: runtimeLeaseAcquired ? runtime.runtimeProfileDir : undefined,
            runtimeSessionName: workerSpawned ? runtime.runtimeSessionName : undefined,
            conversationId: conversationLeaseAcquired ? followUp.conversationId : undefined,
          }).catch(() => ({ attempted: [], warnings: [] }));
          if (job && cleanupReport.warnings.length > 0) {
            await appendCleanupWarnings(job.id, cleanupReport.warnings).catch(() => undefined);
          }
          if (ctx.hasUI) refreshOracleStatus(ctx);
          return buildOracleToolErrorResult("oracle_submit", error, params as unknown as Record<string, unknown>, {
            job: latest ?? job,
            jobDetails: {
              queue: latest ? buildOracleQueueSnapshot(latest, latest.status === "queued" ? getQueuePosition(latest.id) : undefined) : undefined,
              archiveBytes: archive?.archiveBytes,
              initialArchiveBytes: archive?.initialArchiveBytes,
              autoPrunedArchivePaths: archive?.autoPrunedPrefixes,
            },
          });
        } finally {
          await rm(tempArchivePath, { force: true }).catch(() => undefined);
        }
      } catch (error) {
        return buildOracleToolErrorResult("oracle_submit", error, params as unknown as Record<string, unknown>);
      }
    },
  });

  pi.registerTool({
    name: "oracle_read",
    label: "Oracle Read",
    description: "Read the status and outputs of a previously dispatched oracle job.",
    parameters: ORACLE_READ_PARAMS,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      try {
        const job = readJob(params.jobId);
        if (!job || job.projectId !== getProjectId(ctx.cwd)) {
          throw new Error(`Oracle job not found in this project: ${params.jobId}`);
        }
        const latest = isTerminalOracleJob(job)
          ? await markWakeupSettled(job.id, {
            source: "oracle_read",
            sessionFile: getSessionFile(ctx),
            cwd: ctx.cwd,
          })
          : job;
        const current = latest ?? readJob(job.id) ?? job;

        let responsePreview: string | undefined;
        let responseAvailable = false;
        try {
          const response = await import("node:fs/promises").then((fs) => fs.readFile(current.responsePath || "", "utf8"));
          responsePreview = response.slice(0, 4000);
          responseAvailable = true;
        } catch {
          responsePreview = undefined;
        }

        const queuePosition = current.status === "queued" ? getQueuePosition(current.id) : undefined;
        return {
          content: [
            {
              type: "text",
              text: formatOracleJobSummary(current, {
                queuePosition,
                artifactsPath: `${getJobDir(current.id)}/artifacts`,
                responsePreview,
                responseAvailable,
              }),
            },
          ],
          details: {
            job: redactJobDetails(current, {
              queue: buildOracleQueueSnapshot(current, queuePosition),
              responsePreview,
              responseAvailable,
            }),
          },
        };
      } catch (error) {
        return buildOracleToolErrorResult("oracle_read", error, params as unknown as Record<string, unknown>);
      }
    },
  });

  pi.registerTool({
    name: "oracle_cancel",
    label: "Oracle Cancel",
    description: "Cancel a queued or active oracle job.",
    parameters: ORACLE_CANCEL_PARAMS,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      try {
        const job = readJob(params.jobId);
        if (!job || job.projectId !== getProjectId(ctx.cwd)) {
          throw new Error(`Oracle job not found in this project: ${params.jobId}`);
        }
        if (!isOpenOracleJob(job)) {
          return {
            content: [{ type: "text", text: `Oracle job ${job.id} is not cancellable (${job.status}).` }],
            details: { job: redactJobDetails(job, { queue: buildOracleQueueSnapshot(job, job.status === "queued" ? getQueuePosition(job.id) : undefined) }) },
          };
        }

        const cancelled = await cancelOracleJob(params.jobId);
        if (shouldAdvanceQueueAfterCancellation(cancelled)) {
          await promoteQueuedJobs({ workerPath, source: "oracle_cancel_tool" });
        }
        if (ctx.hasUI) refreshOracleStatus(ctx);
        return {
          content: [{ type: "text", text: cancelled.status === "cancelled" || cancelled.status === "failed" ? `Cancelled oracle job ${cancelled.id}.` : `Oracle job ${cancelled.id} was already ${cancelled.status}.` }],
          details: { job: redactJobDetails(cancelled, { queue: buildOracleQueueSnapshot(cancelled, cancelled.status === "queued" ? getQueuePosition(cancelled.id) : undefined) }) },
        };
      } catch (error) {
        return buildOracleToolErrorResult("oracle_cancel", error, params as unknown as Record<string, unknown>);
      }
    },
  });
}
