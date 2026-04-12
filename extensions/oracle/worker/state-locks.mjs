// Purpose: Provide worker-facing wrappers around the shared oracle state lock/lease coordination helpers.
// Responsibilities: Bind shared state helpers to the worker call signatures and re-export crash-recovery constants.
// Scope: Worker wrapper only; atomic lock/lease behavior lives in shared/state-coordination-helpers.mjs.
// Usage: Imported by worker entrypoints that need per-state-dir locks or lease metadata persistence.
// Invariants/Assumptions: Callers pass the oracle state directory explicitly so worker tests can isolate state safely.

import {
  acquireStateLock,
  createStateLease,
  listStateLeaseMetadata,
  ORACLE_METADATA_WRITE_GRACE_MS,
  ORACLE_TMP_STATE_DIR_GRACE_MS,
  readStateLeaseMetadata,
  releaseStateLease,
  releaseStatePath,
  withStateLock,
  writeStateLeaseMetadata,
} from "../shared/state-coordination-helpers.mjs";

export { ORACLE_METADATA_WRITE_GRACE_MS, ORACLE_TMP_STATE_DIR_GRACE_MS };

export async function acquireLock(stateDir, kind, key, metadata, timeoutMs) {
  return acquireStateLock(stateDir, kind, key, metadata, timeoutMs);
}

export async function releaseLock(path) {
  await releaseStatePath(path);
}

export async function withLock(stateDir, kind, key, metadata, fn, timeoutMs) {
  return withStateLock(stateDir, kind, key, metadata, fn, timeoutMs);
}

export async function createLease(stateDir, kind, key, metadata, timeoutMs) {
  return createStateLease(stateDir, kind, key, metadata, timeoutMs);
}

export async function writeLeaseMetadata(stateDir, kind, key, metadata) {
  return writeStateLeaseMetadata(stateDir, kind, key, metadata);
}

export async function readLeaseMetadata(stateDir, kind, key) {
  return readStateLeaseMetadata(stateDir, kind, key);
}

export function listLeaseMetadata(stateDir, kind) {
  return listStateLeaseMetadata(stateDir, kind);
}

export async function releaseLease(stateDir, kind, key) {
  await releaseStateLease(stateDir, kind, key);
}
