// Purpose: Provide typed oracle lock/lease wrappers bound to the configured shared oracle state directory.
// Responsibilities: Expose extension-facing lock helpers, sweep stale lock dirs, and preserve existing typed APIs over the shared state helper core.
// Scope: Extension-process wrappers only; atomic filesystem coordination semantics live in shared/state-coordination-helpers.mjs.
// Usage: Imported by oracle lib modules that need admission locks, job locks, reconcile locks, or lease metadata persistence.
// Invariants/Assumptions: All lock/lease paths live under the single configured oracle state directory for this machine.

import { mkdirSync } from "node:fs";
import {
  acquireStateLock,
  createStateLease,
  getStateLeasesDir,
  getStateLocksDir,
  listStateLeaseMetadata,
  ORACLE_METADATA_WRITE_GRACE_MS,
  ORACLE_TMP_STATE_DIR_GRACE_MS,
  readStateLeaseMetadata,
  releaseStateLease,
  releaseStatePath,
  sweepStaleStateLocks,
  withStateLock,
  writeStateLeaseMetadata,
} from "../shared/state-coordination-helpers.mjs";

export const DEFAULT_ORACLE_STATE_DIR = "/tmp/pi-oracle-state";
export const ORACLE_STATE_DIR_ENV = "PI_ORACLE_STATE_DIR";
const ORACLE_STATE_DIR = process.env[ORACLE_STATE_DIR_ENV]?.trim() || DEFAULT_ORACLE_STATE_DIR;

export { ORACLE_METADATA_WRITE_GRACE_MS, ORACLE_TMP_STATE_DIR_GRACE_MS };

export interface OracleLockHandle {
  path: string;
}

function ensureDirSync(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
}

export function getOracleStateDir(): string {
  ensureDirSync(ORACLE_STATE_DIR);
  return ORACLE_STATE_DIR;
}

export function getLocksDir(): string {
  const dir = getStateLocksDir(getOracleStateDir());
  ensureDirSync(dir);
  return dir;
}

export function getLeasesDir(): string {
  const dir = getStateLeasesDir(getOracleStateDir());
  ensureDirSync(dir);
  return dir;
}

export async function sweepStaleLocks(now = Date.now()): Promise<string[]> {
  return sweepStaleStateLocks(getOracleStateDir(), now);
}

export async function acquireLock(
  kind: string,
  key: string,
  metadata: unknown,
  options?: { timeoutMs?: number },
): Promise<OracleLockHandle> {
  return {
    path: await acquireStateLock(getOracleStateDir(), kind, key, metadata, options?.timeoutMs),
  };
}

export async function releaseLock(handle: OracleLockHandle | undefined): Promise<void> {
  await releaseStatePath(handle?.path);
}

export async function withLock<T>(
  kind: string,
  key: string,
  metadata: unknown,
  fn: () => Promise<T>,
  options?: { timeoutMs?: number },
): Promise<T> {
  return withStateLock(getOracleStateDir(), kind, key, metadata, fn, options?.timeoutMs);
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
  return createStateLease(getOracleStateDir(), kind, key, metadata);
}

export async function writeLeaseMetadata(kind: string, key: string, metadata: unknown): Promise<string> {
  return writeStateLeaseMetadata(getOracleStateDir(), kind, key, metadata);
}

export async function readLeaseMetadata<T = unknown>(kind: string, key: string): Promise<T | undefined> {
  return readStateLeaseMetadata<T>(getOracleStateDir(), kind, key);
}

export async function releaseLease(kind: string, key: string): Promise<void> {
  await releaseStateLease(getOracleStateDir(), kind, key);
}

export function listLeaseMetadata<T = unknown>(kind: string): T[] {
  return listStateLeaseMetadata<T>(getOracleStateDir(), kind);
}
