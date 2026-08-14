// Purpose: Build provider-ready oracle context archives from selected project paths.
// Responsibilities: Expand archive inputs with default exclusions, apply whole-repo size pruning, and write .tar.zst or .tar.gz files safely.
// Scope: Archive construction only; tool orchestration, job admission, and worker execution live in sibling modules.
// Usage: Imported by oracle_submit and sanity tests to keep archive behavior provider-aware and regression-testable.
// Invariants/Assumptions: Archive entries are project-relative paths already validated through resolveArchiveInputs, and archive subprocesses must not inherit browser safe-storage secrets.
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createReadStream, createWriteStream } from "node:fs";
import { lstat, mkdtemp, readdir, readlink, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, posix } from "node:path";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";
import { sweetCookieSafeStoragePasswordScrubbedEnv } from "../shared/browser-profile-helpers.mjs";
import { resolveOracleProviderArchivePlan, type OracleArchiveFormat } from "./provider-capabilities.js";
import { resolveArchiveInputs, sha256File } from "./jobs.js";

const ARCHIVE_COMMAND_TIMEOUT_MS = 120_000;
const ARCHIVE_COMMAND_KILL_GRACE_MS = 2_000;
const ARCHIVE_PIPE_FAILURE_ERROR_CODES = new Set(["EPIPE", "ERR_STREAM_DESTROYED"]);
const DEFAULT_ARCHIVE_PLAN = resolveOracleProviderArchivePlan("chatgpt");
const DEFAULT_ARCHIVE_FORMAT = DEFAULT_ARCHIVE_PLAN.archiveFormat;
const DEFAULT_MAX_ARCHIVE_BYTES = DEFAULT_ARCHIVE_PLAN.maxArchiveBytes;

const DEFAULT_ARCHIVE_EXCLUDED_DIR_NAMES_ANYWHERE = new Set([
  ".git",
  ".hg",
  ".svn",
  ".pi",
  ".prime",
  ".oracle-context",
  ".cursor",
  ".artifacts",
  ".crabbox",
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

export type ArchiveSizeBreakdownRow = { relativePath: string; bytes: number };

export type ArchiveCreationResult = {
  sha256: string;
  archiveBytes: number;
  initialArchiveBytes?: number;
  autoPrunedPrefixes: ArchiveSizeBreakdownRow[];
  includedEntries: string[];
};

function appendArchiveEntries(target: string[], source: Iterable<string>): void {
  for (const entry of source) target.push(entry);
}

function getErrorCode(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined;
}

function mergeArchiveEntryGroups(groups: Iterable<Iterable<string>>): string[] {
  const merged: string[] = [];
  for (const group of groups) appendArchiveEntries(merged, group);
  return merged;
}

export function mergeArchiveEntryGroupsForTesting(groups: Iterable<Iterable<string>>): string[] {
  return mergeArchiveEntryGroups(groups);
}

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
      if (child.isDirectory()) appendArchiveEntries(results, await expandArchiveEntries(cwd, childRelative));
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
    if (child.isDirectory()) appendArchiveEntries(results, await expandArchiveEntries(cwd, childRelative, { forceIncludeSubtree: options?.forceIncludeSubtree }));
    else results.push(childRelative);
  }
  return results;
}

async function resolveExpandedArchiveEntriesFromInputs(
  cwd: string,
  entries: Array<{ absolute: string; relative: string }>,
): Promise<string[]> {
  const expandedGroups = await Promise.all(entries.map(async (entry) => {
    const statEntry = await lstat(entry.absolute);
    const forceIncludeSubtree = statEntry.isDirectory() && entry.relative !== "." && shouldExcludeArchivePath(entry.relative, true);
    return expandArchiveEntries(cwd, entry.relative, { forceIncludeSubtree });
  }));
  return Array.from(new Set(mergeArchiveEntryGroups(expandedGroups))).sort();
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
    `Oracle archive exceeds provider upload limit (${formatBytes(args.maxBytes)}) after default exclusions${args.autoPrunedPrefixes.length > 0 ? " and automatic generic generated-output-dir pruning" : ""}.`,
    `The local archive measured ${formatBytes(args.archiveBytes)} (${args.archiveBytes} bytes), so submission stopped before dispatch.`,
    args.autoPrunedPrefixes.length > 0 ? "Automatically pruned generic generated-output paths before failing:" : undefined,
    ...args.autoPrunedPrefixes.map((entry) => `- ${formatDirectoryLabel(entry.relativePath)} — ${formatBytes(entry.bytes)}`),
    topLevel.length > 0 ? "Approx top-level included sizes:" : undefined,
    ...topLevel.map((entry) => `- ${entry.relativePath} — ${formatBytes(entry.bytes)}`),
    adaptiveCandidates.length > 0 ? "Largest remaining generic generated-output-dir candidates:" : undefined,
    ...adaptiveCandidates.map((entry) => `- ${formatDirectoryLabel(entry.relativePath)} — ${formatBytes(entry.bytes)}`),
    "Recommended retry order: (1) remove the largest obviously irrelevant/generated/history/export content, (2) if it still does not fit, keep only the directly relevant subtrees plus adjacent docs/tests/config, (3) if it still does not fit, explain what was cut before asking the user.",
  ]
    .filter(Boolean)
    .join("\n");
}

function writeOctal(value: number, width: number): Buffer {
  const text = Math.max(0, Math.floor(value)).toString(8).slice(-(width - 1)).padStart(width - 1, "0") + "\0";
  return Buffer.from(text, "ascii");
}

function writeTarName(header: Buffer, name: string): void {
  const normalized = name.replaceAll("\\", "/");
  const nameBytes = Buffer.byteLength(normalized);
  if (nameBytes <= 100) {
    header.write(normalized, 0, 100, "utf8");
    return;
  }
  const parts = normalized.split("/");
  const fileName = parts.pop() || "";
  const prefix = parts.join("/");
  if (Buffer.byteLength(fileName) > 100 || Buffer.byteLength(prefix) > 155) {
    throw new Error(`archive path is too long for portable tar header: ${normalized}`);
  }
  header.write(fileName, 0, 100, "utf8");
  header.write(prefix, 345, 155, "utf8");
}

function buildTarHeader(name: string, options: { mode: number; size: number; mtimeMs: number; type: "file" | "directory" | "symlink"; linkName?: string }): Buffer {
  const header = Buffer.alloc(512);
  writeTarName(header, options.type === "directory" && !name.endsWith("/") ? `${name}/` : name);
  writeOctal(options.mode & 0o7777, 8).copy(header, 100);
  writeOctal(0, 8).copy(header, 108);
  writeOctal(0, 8).copy(header, 116);
  writeOctal(options.size, 12).copy(header, 124);
  writeOctal(Math.floor(options.mtimeMs / 1000), 12).copy(header, 136);
  Buffer.from("        ", "ascii").copy(header, 148);
  header[156] = options.type === "directory" ? 53 : options.type === "symlink" ? 50 : 48;
  if (options.linkName) header.write(options.linkName.replaceAll("\\", "/"), 157, 100, "utf8");
  header.write("ustar", 257, 6, "ascii");
  header.write("00", 263, 2, "ascii");
  let checksum = 0;
  for (const byte of header) checksum += byte;
  const checksumText = checksum.toString(8).padStart(6, "0");
  header.write(`${checksumText}\0 `, 148, 8, "ascii");
  return header;
}

async function writeChunk(stream: NodeJS.WritableStream, chunk: Buffer): Promise<void> {
  if (!stream.write(chunk)) await once(stream, "drain");
}

function formatArchiveTimeoutMessage(commandTimeoutMs?: number): string {
  return `Oracle archive subprocess timed out after ${commandTimeoutMs ?? ARCHIVE_COMMAND_TIMEOUT_MS}ms`;
}

function throwIfArchiveTimeoutAborted(timeout?: AbortSignal): void {
  if (timeout?.aborted) throw new Error(formatArchiveTimeoutMessage());
}

async function writePortableTarArchiveToStream(cwd: string, entries: string[], stream: NodeJS.WritableStream, timeout?: AbortSignal): Promise<void> {
  for (const entry of entries) {
    throwIfArchiveTimeoutAborted(timeout);
    const normalizedEntry = entry.replaceAll("\\", "/");
    const absolutePath = join(cwd, normalizedEntry);
    const info = await lstat(absolutePath);
    if (info.isSymbolicLink()) {
      await writeChunk(stream, buildTarHeader(normalizedEntry, { mode: info.mode, size: 0, mtimeMs: info.mtimeMs, type: "symlink", linkName: await readlink(absolutePath) }));
      continue;
    }
    if (info.isDirectory()) {
      await writeChunk(stream, buildTarHeader(normalizedEntry, { mode: info.mode, size: 0, mtimeMs: info.mtimeMs, type: "directory" }));
      continue;
    }
    if (!info.isFile()) continue;
    await writeChunk(stream, buildTarHeader(normalizedEntry, { mode: info.mode, size: info.size, mtimeMs: info.mtimeMs, type: "file" }));
    for await (const chunk of createReadStream(absolutePath)) {
      throwIfArchiveTimeoutAborted(timeout);
      await writeChunk(stream, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    const padding = info.size % 512 === 0 ? 0 : 512 - (info.size % 512);
    if (padding > 0) await writeChunk(stream, Buffer.alloc(padding));
  }
  throwIfArchiveTimeoutAborted(timeout);
  await writeChunk(stream, Buffer.alloc(1024));
}

async function writeWindowsTarArchiveToZstd(cwd: string, entries: string[], archivePath: string, timeout: AbortSignal): Promise<void> {
  const scrubbedEnv = sweetCookieSafeStoragePasswordScrubbedEnv(process.env);
  const zstd = spawn("zstd", ["-19", "-T0", "-f", "-o", archivePath], {
    cwd,
    env: scrubbedEnv,
    stdio: ["pipe", "ignore", "pipe"],
    signal: timeout,
  });
  let stderr = "";
  zstd.stderr?.on("data", (chunk) => {
    stderr += String(chunk);
  });
  try {
    await writePortableTarArchiveToStream(cwd, entries, zstd.stdin, timeout);
    zstd.stdin.end();
  } catch (error) {
    zstd.stdin.destroy();
    zstd.kill();
    throw error;
  }
  const code = await new Promise<number | null>((resolve, reject) => {
    zstd.once("error", reject);
    zstd.once("close", resolve);
  });
  if (code !== 0) throw new Error(`zstd archive compression failed with status ${code}: ${stderr.trim()}`);
}

async function writeWindowsTarArchiveToGzip(cwd: string, entries: string[], archivePath: string, timeout: AbortSignal): Promise<void> {
  const gzip = createGzip({ level: 9 });
  const output = createWriteStream(archivePath, { mode: 0o600 });
  const abort = () => gzip.destroy(new Error(formatArchiveTimeoutMessage()));
  timeout.addEventListener("abort", abort, { once: true });
  const completion = pipeline(gzip, output);
  try {
    await writePortableTarArchiveToStream(cwd, entries, gzip, timeout);
    gzip.end();
    await completion;
  } catch (error) {
    gzip.destroy();
    output.destroy();
    await completion.catch(() => undefined);
    throw error;
  } finally {
    timeout.removeEventListener("abort", abort);
  }
}

type ArchiveCompressionTarget = {
  name: string;
  input: NodeJS.WritableStream;
  done: Promise<number | null | undefined>;
  pipe?: NodeJS.ReadableStream;
  terminate: () => void;
  kill: () => void;
  unpipe: (tarStdout: NodeJS.ReadableStream) => void;
};

function createGzipCompressionTarget(archivePath: string): ArchiveCompressionTarget {
  const gzip = createGzip({ level: 9 });
  const output = createWriteStream(archivePath, { mode: 0o600 });
  return {
    name: "gzip",
    input: gzip,
    done: pipeline(gzip, output).then(() => undefined),
    terminate: () => {
      gzip.destroy();
      output.destroy();
    },
    kill: () => {
      gzip.destroy();
      output.destroy();
    },
    unpipe: (tarStdout) => tarStdout.unpipe(gzip),
  };
}

function createZstdCompressionTarget(archivePath: string, env: NodeJS.ProcessEnv): ArchiveCompressionTarget {
  const zstd = spawn(process.env.PI_ORACLE_TEST_ZSTD_BIN ?? "zstd", ["-19", "-T0", "-f", "-o", archivePath], {
    env,
    stdio: ["pipe", "ignore", "pipe"],
  });
  return {
    name: "zstd",
    input: zstd.stdin,
    pipe: zstd.stderr,
    done: new Promise<number | null>((resolve, reject) => {
      zstd.once("error", reject);
      zstd.once("close", resolve);
    }),
    terminate: () => zstd.kill("SIGTERM"),
    kill: () => zstd.kill("SIGKILL"),
    unpipe: (tarStdout) => tarStdout.unpipe(zstd.stdin),
  };
}

async function writeNonWindowsTarArchiveFile(
  cwd: string,
  archivePath: string,
  listPath: string,
  createCompressionTarget: (env: NodeJS.ProcessEnv) => ArchiveCompressionTarget,
  options?: { commandTimeoutMs?: number },
): Promise<number> {
  await new Promise<void>((resolvePromise, rejectPromise) => {
    const scrubbedEnv = sweetCookieSafeStoragePasswordScrubbedEnv();
    const tarArgs = ["--null", "-cf", "-", "-C", cwd, "-T", basename(listPath)];
    const tar = spawn(process.env.PI_ORACLE_TEST_TAR_BIN ?? "tar", tarArgs, {
      cwd: dirname(listPath),
      env: scrubbedEnv,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const target = createCompressionTarget(scrubbedEnv);

    let stderr = "";
    let settled = false;
    let timedOut = false;
    let targetDone = false;
    let targetCode: number | null | undefined;
    let targetError: Error | undefined;
    let timeout: NodeJS.Timeout | undefined;
    let killGraceTimer: NodeJS.Timeout | undefined;
    let tarCode: number | null | undefined;

    const commandTimeoutMs = options?.commandTimeoutMs ?? ARCHIVE_COMMAND_TIMEOUT_MS;
    const clearTimers = () => {
      if (timeout) clearTimeout(timeout);
      if (killGraceTimer) clearTimeout(killGraceTimer);
    };

    const terminateChildren = () => {
      tar.kill("SIGTERM");
      target.terminate();
      killGraceTimer = setTimeout(() => {
        tar.kill("SIGKILL");
        target.kill();
      }, ARCHIVE_COMMAND_KILL_GRACE_MS);
      killGraceTimer.unref?.();
    };

    const rejectOnce = (error: Error) => {
      if (settled) return;
      settled = true;
      clearTimers();
      terminateChildren();
      rejectPromise(error);
    };

    const finish = () => {
      if (settled || tarCode === undefined || !targetDone) return;
      settled = true;
      clearTimers();
      if (timedOut) {
        rejectPromise(new Error(stderr || formatArchiveTimeoutMessage(commandTimeoutMs)));
        return;
      }
      if (targetError) {
        rejectPromise(targetError);
        return;
      }
      if (tarCode === 0 && (targetCode === undefined || targetCode === 0)) {
        resolvePromise();
        return;
      }
      const compressionStatus = targetCode === undefined ? "" : `, ${target.name}=${targetCode}`;
      rejectPromise(new Error(stderr || `archive command failed (tar=${tarCode}${compressionStatus})`));
    };

    const handlePipeError = (error: unknown) => {
      const normalized = error instanceof Error ? error : new Error(String(error));
      if (ARCHIVE_PIPE_FAILURE_ERROR_CODES.has(getErrorCode(normalized) ?? "")) {
        stderr = `${stderr}${stderr ? "\n" : ""}${normalized.message}`;
        target.unpipe(tar.stdout);
        terminateChildren();
        finish();
        return;
      }
      rejectOnce(normalized);
    };

    if (commandTimeoutMs > 0) {
      timeout = setTimeout(() => {
        timedOut = true;
        stderr = `${stderr}${stderr ? "\n" : ""}${formatArchiveTimeoutMessage(commandTimeoutMs)}`;
        terminateChildren();
      }, commandTimeoutMs);
      timeout.unref?.();
    }

    tar.stderr.on("data", (data) => {
      stderr += String(data);
    });
    target.pipe?.on("data", (data) => {
      stderr += String(data);
    });
    tar.on("error", (error) => rejectOnce(error instanceof Error ? error : new Error(String(error))));
    tar.stdout.on("error", handlePipeError);
    target.input.on("error", handlePipeError);
    tar.on("close", (code) => {
      tarCode = code;
      finish();
    });
    target.done.then(
      (code) => {
        targetCode = code;
        targetDone = true;
        if (code !== 0 && tarCode === undefined) terminateChildren();
        finish();
      },
      (error) => {
        targetError = error instanceof Error ? error : new Error(String(error));
        targetDone = true;
        if (tarCode === undefined) terminateChildren();
        finish();
      },
    );
    tar.stdout.pipe(target.input);
  });

  return (await stat(archivePath)).size;
}

async function writeTarGzipArchiveFile(
  cwd: string,
  entries: string[],
  archivePath: string,
  listPath: string,
  options?: { commandTimeoutMs?: number },
): Promise<number> {
  if (process.platform === "win32") {
    const timeoutController = new AbortController();
    const timeout = setTimeout(() => timeoutController.abort(), options?.commandTimeoutMs ?? ARCHIVE_COMMAND_TIMEOUT_MS);
    try {
      await writeWindowsTarArchiveToGzip(cwd, entries, archivePath, timeoutController.signal);
      return (await stat(archivePath)).size;
    } catch (error) {
      if (timeoutController.signal.aborted) {
        throw new Error(formatArchiveTimeoutMessage(options?.commandTimeoutMs));
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  return writeNonWindowsTarArchiveFile(cwd, archivePath, listPath, () => createGzipCompressionTarget(archivePath), options);
}

async function writeZstdArchiveFile(
  cwd: string,
  entries: string[],
  archivePath: string,
  listPath: string,
  options?: { commandTimeoutMs?: number },
): Promise<number> {
  if (process.platform === "win32") {
    const timeoutController = new AbortController();
    const timeout = setTimeout(() => timeoutController.abort(), options?.commandTimeoutMs ?? ARCHIVE_COMMAND_TIMEOUT_MS);
    try {
      await writeWindowsTarArchiveToZstd(cwd, entries, archivePath, timeoutController.signal);
      return (await stat(archivePath)).size;
    } catch (error) {
      if (timeoutController.signal.aborted) {
        throw new Error(formatArchiveTimeoutMessage(options?.commandTimeoutMs));
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  return writeNonWindowsTarArchiveFile(cwd, archivePath, listPath, (env) => createZstdCompressionTarget(archivePath, env), options);
}

async function writeArchiveFile(
  cwd: string,
  entries: string[],
  archivePath: string,
  listPath: string,
  options?: { commandTimeoutMs?: number; archiveFormat?: OracleArchiveFormat },
): Promise<number> {
  await writeFile(listPath, Buffer.from(`${entries.join("\0")}\0`), { mode: 0o600 });
  await rm(archivePath, { force: true }).catch(() => undefined);

  const archiveFormat = options?.archiveFormat ?? DEFAULT_ARCHIVE_FORMAT;
  return archiveFormat === "tar.gz"
    ? writeTarGzipArchiveFile(cwd, entries, archivePath, listPath, options)
    : writeZstdArchiveFile(cwd, entries, archivePath, listPath, options);
}

export async function createArchiveForTesting(
  cwd: string,
  files: string[],
  archivePath: string,
  options?: { maxBytes?: number; adaptivePruneMinBytes?: number; commandTimeoutMs?: number; archiveFormat?: OracleArchiveFormat },
): Promise<ArchiveCreationResult> {
  const archiveInputs = resolveArchiveInputs(cwd, files);
  const wholeRepoSelection = isWholeRepoArchiveSelection(archiveInputs);
  let expandedEntries = await resolveExpandedArchiveEntriesFromInputs(cwd, archiveInputs);
  if (expandedEntries.length === 0) {
    throw new Error("Oracle archive inputs are empty after default exclusions");
  }

  const listDir = await mkdtemp(join(tmpdir(), "oracle-filelist-"));
  const listPath = join(listDir, "files.list");
  const maxBytes = options?.maxBytes ?? DEFAULT_MAX_ARCHIVE_BYTES;
  const adaptivePruneMinBytes = options?.adaptivePruneMinBytes ?? 0;
  const autoPrunedPrefixes: ArchiveSizeBreakdownRow[] = [];
  let initialArchiveBytes: number | undefined;

  try {
    while (true) {
      if (expandedEntries.length === 0) {
        throw new Error("Oracle archive inputs are empty after default exclusions and automatic size pruning");
      }

      const archiveBytes = await writeArchiveFile(cwd, expandedEntries, archivePath, listPath, { commandTimeoutMs: options?.commandTimeoutMs, archiveFormat: options?.archiveFormat });
      if (archiveBytes <= maxBytes) {
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

export async function createArchive(cwd: string, files: string[], archivePath: string, maxBytes = DEFAULT_MAX_ARCHIVE_BYTES, archiveFormat: OracleArchiveFormat = DEFAULT_ARCHIVE_FORMAT): Promise<ArchiveCreationResult> {
  return createArchiveForTesting(cwd, files, archivePath, { maxBytes, archiveFormat });
}
