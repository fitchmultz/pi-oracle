// Purpose: Provide shared atomic lock/lease state helpers for oracle coordination across extension and worker processes.
// Responsibilities: Create lock/lease directories atomically, publish metadata safely, reclaim stale incomplete state, and enumerate lease metadata.
// Scope: Filesystem-backed concurrency primitives only; higher-level admission and queue behavior stays in wrapper modules.
// Usage: Imported by lib/locks.ts and worker/state-locks.mjs so both layers share identical crash-recovery semantics.
// Invariants/Assumptions: State lives under a private per-machine directory, and final published state dirs must never appear without complete metadata.

import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { isProcessAlive } from "./process-helpers.mjs";

const DEFAULT_WAIT_MS = 30_000;
const POLL_MS = 200;
export const ORACLE_METADATA_WRITE_GRACE_MS = 1_000;
/** Incomplete `.tmp-*` dirs are in-flight atomic creates; a 1s grace is too short under multi-process sweep + slow FS. */
export const ORACLE_TMP_STATE_DIR_GRACE_MS = 60_000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * @param {string} path
 * @returns {Promise<void>}
 */
async function ensurePrivateDir(path) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  await chmod(path, 0o700).catch(() => undefined);
}

/**
 * @param {string} kind
 * @param {string} key
 * @returns {string}
 */
export function hashOracleStateKey(kind, key) {
  return `${kind}-${createHash("sha256").update(key).digest("hex").slice(0, 24)}`;
}

/**
 * @param {string} stateDir
 * @returns {string}
 */
export function getStateLocksDir(stateDir) {
  return join(stateDir, "locks");
}

/**
 * @param {string} stateDir
 * @returns {string}
 */
export function getStateLeasesDir(stateDir) {
  return join(stateDir, "leases");
}

/**
 * @param {string} stateDir
 * @param {string} kind
 * @param {string} key
 * @returns {string}
 */
function lockPath(stateDir, kind, key) {
  return join(getStateLocksDir(stateDir), hashOracleStateKey(kind, key));
}

/**
 * @param {string} stateDir
 * @param {string} kind
 * @param {string} key
 * @returns {string}
 */
function leasePath(stateDir, kind, key) {
  return join(getStateLeasesDir(stateDir), hashOracleStateKey(kind, key));
}

/**
 * @param {string} path
 * @returns {string}
 */
function getMetadataPath(path) {
  return join(path, "metadata.json");
}

/**
 * @param {string} path
 * @param {unknown} metadata
 * @returns {Promise<void>}
 */
async function writeMetadata(path, metadata) {
  const targetPath = getMetadataPath(path);
  const tempPath = join(path, `metadata.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`);
  await writeFile(tempPath, `${JSON.stringify(metadata, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await chmod(tempPath, 0o600).catch(() => undefined);
  await rename(tempPath, targetPath);
  await chmod(targetPath, 0o600).catch(() => undefined);
}

/**
 * @param {string} parentDir
 * @param {string} finalPath
 * @param {unknown} metadata
 * @returns {Promise<void>}
 */
async function createStateDirAtomically(parentDir, finalPath, metadata) {
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

/**
 * @param {string} path
 * @returns {"present" | "missing" | "invalid"}
 */
function getMetadataState(path) {
  const metadataPath = getMetadataPath(path);
  if (!existsSync(metadataPath)) return "missing";
  try {
    JSON.parse(readFileSync(metadataPath, "utf8"));
    return "present";
  } catch {
    return "invalid";
  }
}

/**
 * @param {string} path
 * @param {number} [now]
 * @returns {boolean}
 */
function isIncompleteStateDirStale(path, now = Date.now()) {
  try {
    const stats = statSync(path);
    const baselineMs = Math.max(stats.mtimeMs, stats.ctimeMs);
    const graceMs = basename(path).startsWith(".tmp-") ? ORACLE_TMP_STATE_DIR_GRACE_MS : ORACLE_METADATA_WRITE_GRACE_MS;
    return now - baselineMs >= graceMs;
  } catch {
    return false;
  }
}

/**
 * @param {string} path
 * @returns {number | undefined}
 */
function readLockProcessPid(path) {
  const metadataPath = getMetadataPath(path);
  if (!existsSync(metadataPath)) return undefined;
  try {
    const metadata = JSON.parse(readFileSync(metadataPath, "utf8"));
    return typeof metadata?.processPid === "number" && Number.isInteger(metadata.processPid) && metadata.processPid > 0
      ? metadata.processPid
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * @param {unknown} error
 * @returns {boolean}
 */
function isStateDirExistsError(error) {
  return Boolean(error && typeof error === "object" && "code" in error && (error.code === "EEXIST" || error.code === "ENOTEMPTY"));
}

/**
 * @param {string} path
 * @param {number} [now]
 * @returns {Promise<boolean>}
 */
async function maybeReclaimIncompleteStateDir(path, now = Date.now()) {
  if (getMetadataState(path) === "present") return false;
  if (!isIncompleteStateDirStale(path, now)) return false;
  await rm(path, { recursive: true, force: true }).catch(() => undefined);
  return true;
}

/**
 * @param {string} path
 * @param {number} [now]
 * @returns {Promise<boolean>}
 */
async function maybeReclaimStaleLock(path, now = Date.now()) {
  if (await maybeReclaimIncompleteStateDir(path, now)) return true;
  const processPid = readLockProcessPid(path);
  if (!processPid || isProcessAlive(processPid)) return false;
  await rm(path, { recursive: true, force: true }).catch(() => undefined);
  return true;
}

/**
 * @param {string} stateDir
 * @param {number} [now]
 * @returns {Promise<string[]>}
 */
export async function sweepStaleStateLocks(stateDir, now = Date.now()) {
  const dir = getStateLocksDir(stateDir);
  if (!existsSync(dir)) return [];
  const removed = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (await maybeReclaimStaleLock(path, now)) {
      removed.push(path);
    }
  }
  return removed;
}

/**
 * @param {string} stateDir
 * @param {string} kind
 * @param {string} key
 * @param {unknown} metadata
 * @param {number} [timeoutMs]
 * @returns {Promise<string>}
 */
export async function acquireStateLock(stateDir, kind, key, metadata, timeoutMs = DEFAULT_WAIT_MS) {
  const parentDir = getStateLocksDir(stateDir);
  const path = join(parentDir, hashOracleStateKey(kind, key));
  const deadline = Date.now() + timeoutMs;
  await ensurePrivateDir(stateDir);
  await ensurePrivateDir(parentDir);

  while (Date.now() < deadline) {
    try {
      await createStateDirAtomically(parentDir, path, metadata);
      return path;
    } catch (error) {
      if (!isStateDirExistsError(error)) throw error;
      if (await maybeReclaimStaleLock(path)) continue;
    }
    await sleep(POLL_MS);
  }

  throw new Error(`Timed out waiting for oracle ${kind} lock: ${key}`);
}

/**
 * @param {string | undefined} path
 * @returns {Promise<void>}
 */
export async function releaseStatePath(path) {
  if (!path) return;
  await rm(path, { recursive: true, force: true }).catch(() => undefined);
}

/**
 * @template T
 * @param {string} stateDir
 * @param {string} kind
 * @param {string} key
 * @param {unknown} metadata
 * @param {() => Promise<T>} fn
 * @param {number} [timeoutMs]
 * @returns {Promise<T>}
 */
export async function withStateLock(stateDir, kind, key, metadata, fn, timeoutMs = DEFAULT_WAIT_MS) {
  const handle = await acquireStateLock(stateDir, kind, key, metadata, timeoutMs);
  try {
    return await fn();
  } finally {
    await releaseStatePath(handle);
  }
}

/**
 * @param {string} stateDir
 * @param {string} kind
 * @param {string} key
 * @param {unknown} metadata
 * @param {number} [timeoutMs]
 * @returns {Promise<string>}
 */
export async function createStateLease(stateDir, kind, key, metadata, timeoutMs = DEFAULT_WAIT_MS) {
  const parentDir = getStateLeasesDir(stateDir);
  const path = join(parentDir, hashOracleStateKey(kind, key));
  const deadline = Date.now() + timeoutMs;
  await ensurePrivateDir(stateDir);
  await ensurePrivateDir(parentDir);

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

/**
 * @param {string} stateDir
 * @param {string} kind
 * @param {string} key
 * @param {unknown} metadata
 * @returns {Promise<string>}
 */
export async function writeStateLeaseMetadata(stateDir, kind, key, metadata) {
  const parentDir = getStateLeasesDir(stateDir);
  const path = join(parentDir, hashOracleStateKey(kind, key));
  await ensurePrivateDir(stateDir);
  await ensurePrivateDir(parentDir);
  if (existsSync(path)) {
    await chmod(path, 0o700).catch(() => undefined);
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

/**
 * @template T
 * @param {string} stateDir
 * @param {string} kind
 * @param {string} key
 * @returns {Promise<T | undefined>}
 */
export async function readStateLeaseMetadata(stateDir, kind, key) {
  const path = getMetadataPath(leasePath(stateDir, kind, key));
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return undefined;
  }
}

/**
 * @template T
 * @param {string} stateDir
 * @param {string} kind
 * @returns {T[]}
 */
export function listStateLeaseMetadata(stateDir, kind) {
  const dir = getStateLeasesDir(stateDir);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.startsWith(`${kind}-`))
    .map((name) => join(dir, name, "metadata.json"))
    .filter((path) => existsSync(path))
    .flatMap((path) => {
      try {
        return [JSON.parse(readFileSync(path, "utf8"))];
      } catch {
        return [];
      }
    });
}

/**
 * @param {string} stateDir
 * @param {string} kind
 * @param {string | undefined} key
 * @returns {Promise<void>}
 */
export async function releaseStateLease(stateDir, kind, key) {
  if (!key) return;
  await rm(leasePath(stateDir, kind, key), { recursive: true, force: true }).catch(() => undefined);
}
