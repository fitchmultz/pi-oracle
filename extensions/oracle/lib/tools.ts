import { randomUUID } from "node:crypto";
import { lstat, mkdtemp, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, posix } from "node:path";
import { StringEnum } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { isLockTimeoutError, withGlobalReconcileLock, withLock } from "./locks.js";
import { loadOracleConfig, EFFORTS, MODEL_FAMILIES, type OracleEffort, type OracleModelFamily } from "./config.js";
import {
  cancelOracleJob,
  createJob,
  getSessionFile,
  isActiveOracleJob,
  readJob,
  pruneTerminalOracleJobs,
  reconcileStaleOracleJobs,
  resolveArchiveInputs,
  sha256File,
  spawnWorker,
  updateJob,
  withJobPhase,
} from "./jobs.js";
import { refreshOracleStatus } from "./poller.js";
import {
  acquireConversationLease,
  acquireRuntimeLease,
  allocateRuntime,
  cleanupRuntimeArtifacts,
  getProjectId,
  getSessionId,
  parseConversationId,
} from "./runtime.js";

const ORACLE_SUBMIT_PARAMS = Type.Object({
  prompt: Type.String({ description: "Prompt text to send to ChatGPT web." }),
  files: Type.Array(Type.String({ description: "Project-relative file or directory path to include in the archive." }), {
    description: "Exact project-relative files/directories to include in the oracle archive.",
    minItems: 1,
  }),
  modelFamily: Type.Optional(StringEnum(MODEL_FAMILIES, { description: "ChatGPT model family: instant, thinking, or pro." })),
  effort: Type.Optional(StringEnum(EFFORTS, { description: "Reasoning effort. Use only values supported by the chosen model family." })),
  autoSwitchToThinking: Type.Optional(
    Type.Boolean({ description: "Only valid when modelFamily is instant. Omit for thinking and pro." }),
  ),
  followUpJobId: Type.Optional(Type.String({ description: "Earlier oracle job id whose chat thread should be continued." })),
});

const ORACLE_READ_PARAMS = Type.Object({
  jobId: Type.String({ description: "Oracle job id." }),
});

const ORACLE_CANCEL_PARAMS = Type.Object({
  jobId: Type.String({ description: "Oracle job id." }),
});

const VALID_EFFORTS: Record<OracleModelFamily, readonly OracleEffort[]> = {
  instant: [],
  thinking: ["light", "standard", "extended", "heavy"],
  pro: ["standard", "extended"],
};

const MAX_ARCHIVE_BYTES = 250 * 1024 * 1024;

const DEFAULT_ARCHIVE_EXCLUDED_DIR_NAMES_ANYWHERE = new Set([
  ".git",
  ".hg",
  ".svn",
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
]);
const DEFAULT_ARCHIVE_EXCLUDED_DIR_NAMES_AT_REPO_ROOT = new Set(["coverage", "htmlcov", "tmp", "temp", ".tmp", "dist", "build", "out", "secrets", ".secrets"]);
const DEFAULT_ARCHIVE_EXCLUDED_FILES = new Set([
  ".coverage",
  ".DS_Store",
  ".env",
  ".netrc",
  ".npmrc",
  ".pypirc",
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

async function writeArchiveFile(cwd: string, entries: string[], archivePath: string, listPath: string): Promise<number> {
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
    let tarCode: number | null | undefined;
    let zstdCode: number | null | undefined;

    const finish = (error?: Error) => {
      if (settled) return;
      if (error) {
        settled = true;
        tar.kill("SIGTERM");
        zstd.kill("SIGTERM");
        rejectPromise(error);
        return;
      }
      if (tarCode === undefined || zstdCode === undefined) return;
      settled = true;
      if (tarCode === 0 && zstdCode === 0) resolvePromise();
      else rejectPromise(new Error(stderr || `archive command failed (tar=${tarCode}, zstd=${zstdCode})`));
    };

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
  options?: { maxBytes?: number; adaptivePruneMinBytes?: number },
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

      const archiveBytes = await writeArchiveFile(cwd, expandedEntries, archivePath, listPath);
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

function validateSubmissionOptions(
  params: { effort?: OracleEffort; autoSwitchToThinking?: boolean },
  modelFamily: OracleModelFamily,
  effort: OracleEffort | undefined,
  autoSwitchToThinking: boolean,
): void {
  if (modelFamily === "instant" && params.effort !== undefined) {
    throw new Error("Instant model family does not support effort selection");
  }

  if (effort && !VALID_EFFORTS[modelFamily].includes(effort)) {
    throw new Error(`Invalid effort for ${modelFamily}: ${effort}`);
  }

  if (modelFamily !== "instant" && params.autoSwitchToThinking === true) {
    throw new Error("autoSwitchToThinking is only valid for the instant model family");
  }

  if (modelFamily !== "instant" && autoSwitchToThinking) {
    throw new Error(`autoSwitchToThinking cannot be enabled for ${modelFamily}`);
  }
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

function redactJobDetails(job: NonNullable<ReturnType<typeof readJob>>) {
  return {
    id: job.id,
    status: job.status,
    phase: job.phase,
    projectId: job.projectId,
    sessionId: job.sessionId,
    createdAt: job.createdAt,
    submittedAt: job.submittedAt,
    completedAt: job.completedAt,
    followUpToJobId: job.followUpToJobId,
    chatUrl: job.chatUrl,
    conversationId: job.conversationId,
    responsePath: job.responsePath,
    responseFormat: job.responseFormat,
    artifactPaths: job.artifactPaths,
    artifactFailureCount: job.artifactFailureCount,
    artifactsManifestPath: job.artifactsManifestPath,
    archiveDeletedAfterUpload: job.archiveDeletedAfterUpload,
    runtimeId: job.runtimeId,
    cleanupWarnings: job.cleanupWarnings,
    lastCleanupAt: job.lastCleanupAt,
    error: job.error,
  };
}

export function registerOracleTools(pi: ExtensionAPI, workerPath: string): void {
  pi.registerTool({
    name: "oracle_submit",
    label: "Oracle Submit",
    description:
      "Dispatch a background ChatGPT web oracle job after gathering context. Always pass a prompt and exact project-relative archive inputs.",
    promptSnippet: "Dispatch a background ChatGPT web oracle job after gathering repo context.",
    promptGuidelines: [
      "Gather context before calling oracle_submit.",
      "By default, archive the whole repo by passing '.'; default archive exclusions apply automatically, including common bulky outputs and obvious credentials/private data like .env files, key material, credential dotfiles, local database files, and root secrets directories.",
      "Only narrow file selection when the user explicitly asks, the task is clearly scoped smaller, or privacy/sensitivity requires it.",
      "For very targeted asks like a single function or stack trace, a smaller archive is preferable.",
      "When files='.' and the post-exclusion archive is still too large, submit automatically prunes the largest nested directories matching generic generated-output names like build/, dist/, out/, coverage/, and tmp/ outside obvious source roots like src/ and lib/ until the archive fits or no candidate remains; successful submissions report what was pruned.",
      "If a submitted oracle job later fails because upload is rejected, retry smaller: remove the largest obviously irrelevant/generated content first, then narrow to modified files plus adjacent files plus directly relevant subtrees, then explain the cut or ask the user if still needed.",
      "If oracle_submit itself fails because the local archive still exceeds the upload limit after default exclusions and automatic generic generated-output-dir pruning, or for any other submit-time error, stop and report the error instead of retrying automatically.",
      "Stop after dispatching oracle_submit; do not continue the task while the oracle job is running.",
      "Only use autoSwitchToThinking with modelFamily=instant.",
    ],
    parameters: ORACLE_SUBMIT_PARAMS,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const config = loadOracleConfig(ctx.cwd);
      const originSessionFile = getSessionFile(ctx);
      const projectId = getProjectId(ctx.cwd);
      const sessionId = getSessionId(originSessionFile, projectId);
      const modelFamily = params.modelFamily ?? config.defaults.modelFamily;
      const requestedEffort = params.effort ?? config.defaults.effort;
      const effort = modelFamily === "instant" ? undefined : requestedEffort;
      const rawAutoSwitchToThinking = params.autoSwitchToThinking ?? config.defaults.autoSwitchToThinking;
      const autoSwitchToThinking = modelFamily === "instant" ? rawAutoSwitchToThinking : false;
      const followUp = resolveFollowUp(params.followUpJobId, ctx.cwd);

      validateSubmissionOptions(params, modelFamily, effort, autoSwitchToThinking);
      try {
        await withGlobalReconcileLock({ processPid: process.pid, source: "oracle_submit", cwd: ctx.cwd }, async () => {
          await reconcileStaleOracleJobs();
          await pruneTerminalOracleJobs();
        });
      } catch (error) {
        if (!isLockTimeoutError(error, "reconcile", "global")) throw error;
      }

      const jobId = randomUUID();
      const tempArchivePath = join(tmpdir(), `oracle-archive-${jobId}.tar.zst`);
      const runtime = allocateRuntime(config);
      let job;

      try {
        const archive = await createArchive(ctx.cwd, params.files, tempArchivePath);
        await withLock("admission", "global", { jobId, processPid: process.pid }, async () => {
          await acquireRuntimeLease(config, {
            jobId,
            runtimeId: runtime.runtimeId,
            runtimeSessionName: runtime.runtimeSessionName,
            runtimeProfileDir: runtime.runtimeProfileDir,
            projectId,
            sessionId,
            createdAt: new Date().toISOString(),
          });
          if (followUp.conversationId) {
            await acquireConversationLease({
              jobId,
              conversationId: followUp.conversationId,
              projectId,
              sessionId,
              createdAt: new Date().toISOString(),
            });
          }
          job = await createJob(
            jobId,
            {
              prompt: params.prompt,
              files: params.files,
              modelFamily,
              effort,
              autoSwitchToThinking,
              followUpToJobId: followUp.followUpToJobId,
              chatUrl: followUp.chatUrl,
              requestSource: "tool",
            },
            ctx.cwd,
            originSessionFile,
            config,
            runtime,
          );
        });
        await rename(tempArchivePath, job.archivePath);
        const worker = await spawnWorker(workerPath, job.id);
        await updateJob(job.id, (current) => ({
          ...current,
          archiveSha256: archive.sha256,
          workerPid: worker.pid,
          workerNonce: worker.nonce,
          workerStartedAt: worker.startedAt,
        }));
        if (ctx.hasUI) refreshOracleStatus(ctx);

        return {
          content: [
            {
              type: "text",
              text: [
                `Oracle job dispatched: ${job.id}`,
                followUp.followUpToJobId ? `Follow-up to: ${followUp.followUpToJobId}` : undefined,
                `Prompt: ${job.promptPath}`,
                `Archive: ${job.archivePath}`,
                archive.autoPrunedPrefixes.length > 0
                  ? `Archive auto-pruned generic generated-output-name dirs to fit size limit: ${archive.autoPrunedPrefixes.map((entry) => `${entry.relativePath}/ (${formatBytes(entry.bytes)})`).join(", ")}`
                  : undefined,
                `Response will be written to: ${job.responsePath}`,
                "Stop now and wait for the oracle completion wake-up.",
              ]
                .filter(Boolean)
                .join("\n"),
            },
          ],
          details: {
            jobId: job.id,
            archiveSha256: archive.sha256,
            archiveBytes: archive.archiveBytes,
            initialArchiveBytes: archive.initialArchiveBytes,
            autoPrunedArchivePaths: archive.autoPrunedPrefixes,
            runtimeId: job.runtimeId,
            followUpToJobId: followUp.followUpToJobId,
          },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (job) {
          const failedAt = new Date().toISOString();
          await updateJob(job.id, (current) => ({
            ...current,
            ...withJobPhase("failed", {
              status: "failed",
              completedAt: failedAt,
              error: message,
            }, failedAt),
          })).catch(() => undefined);
        }
        await cleanupRuntimeArtifacts({
          runtimeId: runtime.runtimeId,
          runtimeProfileDir: runtime.runtimeProfileDir,
          runtimeSessionName: runtime.runtimeSessionName,
          conversationId: followUp.conversationId,
        }).catch(() => undefined);
        if (ctx.hasUI) refreshOracleStatus(ctx);
        throw error;
      } finally {
        await rm(tempArchivePath, { force: true }).catch(() => undefined);
      }
    },
  });

  pi.registerTool({
    name: "oracle_read",
    label: "Oracle Read",
    description: "Read the status and outputs of a previously dispatched oracle job.",
    parameters: ORACLE_READ_PARAMS,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const job = readJob(params.jobId);
      if (!job || job.projectId !== getProjectId(ctx.cwd)) {
        throw new Error(`Oracle job not found in this project: ${params.jobId}`);
      }

      let responsePreview = "";
      try {
        const response = await import("node:fs/promises").then((fs) => fs.readFile(job.responsePath || "", "utf8"));
        responsePreview = response.slice(0, 4000);
      } catch {
        responsePreview = "(response not available yet)";
      }

      return {
        content: [
          {
            type: "text",
            text: [
              `job: ${job.id}`,
              `status: ${job.status}`,
              job.followUpToJobId ? `follow-up-to: ${job.followUpToJobId}` : undefined,
              job.chatUrl ? `chat: ${job.chatUrl}` : undefined,
              job.responsePath ? `response: ${job.responsePath}` : undefined,
              job.responseFormat ? `response-format: ${job.responseFormat}` : undefined,
              `artifacts: /tmp/oracle-${job.id}/artifacts`,
              job.error ? `error: ${job.error}` : undefined,
              "",
              responsePreview,
            ]
              .filter(Boolean)
              .join("\n"),
          },
        ],
        details: { job: redactJobDetails(job) },
      };
    },
  });

  pi.registerTool({
    name: "oracle_cancel",
    label: "Oracle Cancel",
    description: "Cancel an active oracle job.",
    parameters: ORACLE_CANCEL_PARAMS,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const job = readJob(params.jobId);
      if (!job || job.projectId !== getProjectId(ctx.cwd)) {
        throw new Error(`Oracle job not found in this project: ${params.jobId}`);
      }
      if (!isActiveOracleJob(job)) {
        return {
          content: [{ type: "text", text: `Oracle job ${job.id} is not active (${job.status}).` }],
          details: { job: redactJobDetails(job) },
        };
      }

      const cancelled = await cancelOracleJob(params.jobId);
      if (ctx.hasUI) refreshOracleStatus(ctx);
      return {
        content: [{ type: "text", text: `Cancelled oracle job ${cancelled.id}.` }],
        details: { job: redactJobDetails(cancelled) },
      };
    },
  });
}
