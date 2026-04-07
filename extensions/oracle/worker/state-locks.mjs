import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";

const DEFAULT_WAIT_MS = 30_000;
const POLL_MS = 200;
export const ORACLE_METADATA_WRITE_GRACE_MS = 1_000;

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function ensurePrivateDir(path) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  await chmod(path, 0o700).catch(() => undefined);
}

function leaseKey(kind, key) {
  return `${kind}-${createHash("sha256").update(key).digest("hex").slice(0, 24)}`;
}

function getLocksDir(stateDir) {
  return join(stateDir, "locks");
}

function getLeasesDir(stateDir) {
  return join(stateDir, "leases");
}

function lockPath(stateDir, kind, key) {
  return join(getLocksDir(stateDir), leaseKey(kind, key));
}

function leasePath(stateDir, kind, key) {
  return join(getLeasesDir(stateDir), leaseKey(kind, key));
}

function getMetadataPath(path) {
  return join(path, "metadata.json");
}

async function writeMetadata(path, metadata) {
  const targetPath = getMetadataPath(path);
  const tempPath = join(path, `metadata.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`);
  await writeFile(tempPath, `${JSON.stringify(metadata, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await chmod(tempPath, 0o600).catch(() => undefined);
  await rename(tempPath, targetPath);
  await chmod(targetPath, 0o600).catch(() => undefined);
}

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

function isIncompleteStateDirStale(path, now = Date.now()) {
  try {
    const stats = statSync(path);
    const baselineMs = Math.max(stats.mtimeMs, stats.ctimeMs);
    return now - baselineMs >= ORACLE_METADATA_WRITE_GRACE_MS;
  } catch {
    return false;
  }
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ESRCH") return false;
    return true;
  }
}

function isStateDirExistsError(error) {
  return Boolean(error && typeof error === "object" && "code" in error && (error.code === "EEXIST" || error.code === "ENOTEMPTY"));
}

async function readLockProcessPid(path) {
  const metadataPath = getMetadataPath(path);
  if (!existsSync(metadataPath)) return undefined;
  try {
    const metadata = JSON.parse(await readFile(metadataPath, "utf8"));
    return typeof metadata?.processPid === "number" && Number.isInteger(metadata.processPid) && metadata.processPid > 0
      ? metadata.processPid
      : undefined;
  } catch {
    return undefined;
  }
}

async function maybeReclaimIncompleteStateDir(path, now = Date.now()) {
  if (getMetadataState(path) === "present") return false;
  if (!isIncompleteStateDirStale(path, now)) return false;
  await rm(path, { recursive: true, force: true }).catch(() => undefined);
  return true;
}

async function maybeReclaimStaleLock(path, now = Date.now()) {
  if (await maybeReclaimIncompleteStateDir(path, now)) return true;
  const processPid = await readLockProcessPid(path);
  if (!processPid || isProcessAlive(processPid)) return false;
  await rm(path, { recursive: true, force: true }).catch(() => undefined);
  return true;
}

export async function acquireLock(stateDir, kind, key, metadata, timeoutMs = DEFAULT_WAIT_MS) {
  const parentDir = getLocksDir(stateDir);
  const path = join(parentDir, leaseKey(kind, key));
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

export async function releaseLock(path) {
  if (!path) return;
  await rm(path, { recursive: true, force: true }).catch(() => undefined);
}

export async function withLock(stateDir, kind, key, metadata, fn, timeoutMs) {
  const handle = await acquireLock(stateDir, kind, key, metadata, timeoutMs);
  try {
    return await fn();
  } finally {
    await releaseLock(handle);
  }
}

export async function createLease(stateDir, kind, key, metadata, timeoutMs = DEFAULT_WAIT_MS) {
  const parentDir = getLeasesDir(stateDir);
  const path = join(parentDir, leaseKey(kind, key));
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

export async function writeLeaseMetadata(stateDir, kind, key, metadata) {
  const parentDir = getLeasesDir(stateDir);
  const path = join(parentDir, leaseKey(kind, key));
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

export async function readLeaseMetadata(stateDir, kind, key) {
  const path = getMetadataPath(leasePath(stateDir, kind, key));
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return undefined;
  }
}

export function listLeaseMetadata(stateDir, kind) {
  const dir = getLeasesDir(stateDir);
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

export async function releaseLease(stateDir, kind, key) {
  await rm(leasePath(stateDir, kind, key), { recursive: true, force: true }).catch(() => undefined);
}
