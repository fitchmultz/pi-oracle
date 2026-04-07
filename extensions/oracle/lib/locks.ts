import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";

export const DEFAULT_ORACLE_STATE_DIR = "/tmp/pi-oracle-state";
export const ORACLE_STATE_DIR_ENV = "PI_ORACLE_STATE_DIR";
const ORACLE_STATE_DIR = process.env[ORACLE_STATE_DIR_ENV]?.trim() || DEFAULT_ORACLE_STATE_DIR;
const LOCKS_DIR = join(ORACLE_STATE_DIR, "locks");
const LEASES_DIR = join(ORACLE_STATE_DIR, "leases");
const DEFAULT_WAIT_MS = 30_000;
const POLL_MS = 200;
export const ORACLE_METADATA_WRITE_GRACE_MS = 1_000;

export interface OracleLockHandle {
  path: string;
}

function ensureDirSync(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
}

function leaseKey(kind: string, key: string): string {
  return `${kind}-${createHash("sha256").update(key).digest("hex").slice(0, 24)}`;
}

export function getOracleStateDir(): string {
  ensureDirSync(ORACLE_STATE_DIR);
  return ORACLE_STATE_DIR;
}

export function getLocksDir(): string {
  ensureDirSync(LOCKS_DIR);
  return LOCKS_DIR;
}

export function getLeasesDir(): string {
  ensureDirSync(LEASES_DIR);
  return LEASES_DIR;
}

function lockPath(kind: string, key: string): string {
  return join(getLocksDir(), leaseKey(kind, key));
}

function leasePath(kind: string, key: string): string {
  return join(getLeasesDir(), leaseKey(kind, key));
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function writeMetadata(path: string, metadata: unknown): Promise<void> {
  const targetPath = join(path, "metadata.json");
  const tempPath = join(path, `metadata.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`);
  await writeFile(tempPath, `${JSON.stringify(metadata, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(tempPath, targetPath);
}

async function createStateDirAtomically(parentDir: string, finalPath: string, metadata: unknown): Promise<void> {
  const tempPath = join(parentDir, `.tmp-${basename(finalPath)}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}`);
  await mkdir(tempPath, { recursive: false, mode: 0o700 });
  try {
    await writeMetadata(tempPath, metadata);
    await rename(tempPath, finalPath);
  } catch (error) {
    await rm(tempPath, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

function getMetadataPath(path: string): string {
  return join(path, "metadata.json");
}

function getMetadataState(path: string): "present" | "missing" | "invalid" {
  const metadataPath = getMetadataPath(path);
  if (!existsSync(metadataPath)) return "missing";
  try {
    JSON.parse(readFileSync(metadataPath, "utf8"));
    return "present";
  } catch {
    return "invalid";
  }
}

function isIncompleteStateDirStale(path: string, now = Date.now()): boolean {
  try {
    const stats = statSync(path);
    const baselineMs = Math.max(stats.mtimeMs, stats.ctimeMs);
    return now - baselineMs >= ORACLE_METADATA_WRITE_GRACE_MS;
  } catch {
    return false;
  }
}

function readLockProcessPid(path: string): number | undefined {
  const metadataPath = getMetadataPath(path);
  if (!existsSync(metadataPath)) return undefined;
  try {
    const metadata = JSON.parse(readFileSync(metadataPath, "utf8")) as { processPid?: unknown };
    return typeof metadata.processPid === "number" && Number.isInteger(metadata.processPid) && metadata.processPid > 0
      ? metadata.processPid
      : undefined;
  } catch {
    return undefined;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ESRCH") return false;
    return true;
  }
}

function isStateDirExistsError(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && (error.code === "EEXIST" || error.code === "ENOTEMPTY"));
}

async function maybeReclaimIncompleteStateDir(path: string, now = Date.now()): Promise<boolean> {
  if (getMetadataState(path) === "present") return false;
  if (!isIncompleteStateDirStale(path, now)) return false;
  await rm(path, { recursive: true, force: true }).catch(() => undefined);
  return true;
}

async function maybeReclaimStaleLock(path: string, now = Date.now()): Promise<boolean> {
  if (await maybeReclaimIncompleteStateDir(path, now)) return true;
  const processPid = readLockProcessPid(path);
  if (!processPid || isProcessAlive(processPid)) return false;
  await rm(path, { recursive: true, force: true }).catch(() => undefined);
  return true;
}

export async function sweepStaleLocks(): Promise<string[]> {
  const dir = getLocksDir();
  const removed: string[] = [];

  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (await maybeReclaimStaleLock(path)) {
      removed.push(path);
    }
  }

  return removed;
}

export async function acquireLock(
  kind: string,
  key: string,
  metadata: unknown,
  options?: { timeoutMs?: number },
): Promise<OracleLockHandle> {
  const parentDir = getLocksDir();
  const path = join(parentDir, leaseKey(kind, key));
  const timeoutMs = options?.timeoutMs ?? DEFAULT_WAIT_MS;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    try {
      await createStateDirAtomically(parentDir, path, metadata);
      return { path };
    } catch (error) {
      if (!isStateDirExistsError(error)) throw error;
      if (await maybeReclaimStaleLock(path)) continue;
    }
    await sleep(POLL_MS);
  }

  throw new Error(`Timed out waiting for oracle ${kind} lock: ${key}`);
}

export async function releaseLock(handle: OracleLockHandle | undefined): Promise<void> {
  if (!handle) return;
  await rm(handle.path, { recursive: true, force: true }).catch(() => undefined);
}

export async function withLock<T>(
  kind: string,
  key: string,
  metadata: unknown,
  fn: () => Promise<T>,
  options?: { timeoutMs?: number },
): Promise<T> {
  const handle = await acquireLock(kind, key, metadata, options);
  try {
    return await fn();
  } finally {
    await releaseLock(handle);
  }
}

export function isLockTimeoutError(error: unknown, kind?: string, key?: string): boolean {
  if (!(error instanceof Error)) return false;
  const expected = `Timed out waiting for oracle ${kind ?? ""} lock: ${key ?? ""}`.trim();
  return kind && key ? error.message === expected : /^Timed out waiting for oracle .+ lock: .+$/i.test(error.message);
}

export async function withAuthLock<T>(metadata: unknown, fn: () => Promise<T>): Promise<T> {
  return withLock("auth", "global", metadata, fn, { timeoutMs: 10 * 60 * 1000 });
}

export async function withGlobalReconcileLock<T>(
  metadata: unknown,
  fn: () => Promise<T>,
  options?: { timeoutMs?: number },
): Promise<T> {
  await sweepStaleLocks();
  return withLock("reconcile", "global", metadata, fn, { timeoutMs: options?.timeoutMs ?? 30_000 });
}

export async function withGlobalScanLock<T>(
  metadata: unknown,
  fn: () => Promise<T>,
  options?: { timeoutMs?: number },
): Promise<T> {
  return withLock("scan", "global", metadata, fn, { timeoutMs: options?.timeoutMs ?? 5_000 });
}

export async function withJobLock<T>(jobId: string, metadata: unknown, fn: () => Promise<T>): Promise<T> {
  return withLock("job", jobId, metadata, fn, { timeoutMs: 10_000 });
}

export async function createLease(kind: string, key: string, metadata: unknown): Promise<string> {
  const parentDir = getLeasesDir();
  const path = join(parentDir, leaseKey(kind, key));
  const deadline = Date.now() + DEFAULT_WAIT_MS;

  while (Date.now() < deadline) {
    try {
      await createStateDirAtomically(parentDir, path, metadata);
      return path;
    } catch (error) {
      if (!isStateDirExistsError(error)) throw error;
      if (await maybeReclaimIncompleteStateDir(path)) continue;
      if (getMetadataState(path) === "present") throw error;
    }
    await sleep(POLL_MS);
  }

  throw new Error(`Timed out waiting for oracle ${kind} lease: ${key}`);
}

export async function writeLeaseMetadata(kind: string, key: string, metadata: unknown): Promise<string> {
  const parentDir = getLeasesDir();
  const path = join(parentDir, leaseKey(kind, key));
  if (existsSync(path)) {
    await writeMetadata(path, metadata);
    return path;
  }
  try {
    await createStateDirAtomically(parentDir, path, metadata);
  } catch (error) {
    if (!isStateDirExistsError(error)) throw error;
    if (await maybeReclaimIncompleteStateDir(path)) {
      await createStateDirAtomically(parentDir, path, metadata);
    } else {
      await writeMetadata(path, metadata);
    }
  }
  return path;
}

export async function readLeaseMetadata<T = unknown>(kind: string, key: string): Promise<T | undefined> {
  const path = join(leasePath(kind, key), "metadata.json");
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch {
    return undefined;
  }
}

export async function releaseLease(kind: string, key: string): Promise<void> {
  await rm(leasePath(kind, key), { recursive: true, force: true }).catch(() => undefined);
}

export function listLeaseMetadata<T = unknown>(kind: string): T[] {
  const dir = getLeasesDir();
  return readdirSync(dir)
    .filter((name) => name.startsWith(`${kind}-`))
    .map((name) => join(dir, name, "metadata.json"))
    .filter((path) => existsSync(path))
    .flatMap((path) => {
      try {
        return [JSON.parse(readFileSync(path, "utf8")) as T];
      } catch {
        return [];
      }
    });
}
