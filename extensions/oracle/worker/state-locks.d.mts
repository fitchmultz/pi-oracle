export const ORACLE_METADATA_WRITE_GRACE_MS: number;

export function acquireLock(
  stateDir: string,
  kind: string,
  key: string,
  metadata: unknown,
  timeoutMs?: number,
): Promise<string>;

export function releaseLock(path: string | undefined): Promise<void>;

export function withLock<T>(
  stateDir: string,
  kind: string,
  key: string,
  metadata: unknown,
  fn: () => Promise<T>,
  timeoutMs?: number,
): Promise<T>;

export function createLease(
  stateDir: string,
  kind: string,
  key: string,
  metadata: unknown,
  timeoutMs?: number,
): Promise<string>;

export function writeLeaseMetadata(
  stateDir: string,
  kind: string,
  key: string,
  metadata: unknown,
): Promise<string>;

export function readLeaseMetadata<T = unknown>(
  stateDir: string,
  kind: string,
  key: string,
): Promise<T | undefined>;

export function listLeaseMetadata<T = unknown>(stateDir: string, kind: string): T[];

export function releaseLease(stateDir: string, kind: string, key: string | undefined): Promise<void>;
