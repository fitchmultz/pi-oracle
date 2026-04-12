export const ORACLE_METADATA_WRITE_GRACE_MS: number;
export const ORACLE_TMP_STATE_DIR_GRACE_MS: number;

export declare function hashOracleStateKey(kind: string, key: string): string;
export declare function getStateLocksDir(stateDir: string): string;
export declare function getStateLeasesDir(stateDir: string): string;
export declare function sweepStaleStateLocks(stateDir: string, now?: number): Promise<string[]>;
export declare function acquireStateLock(
  stateDir: string,
  kind: string,
  key: string,
  metadata: unknown,
  timeoutMs?: number,
): Promise<string>;
export declare function releaseStatePath(path: string | undefined): Promise<void>;
export declare function withStateLock<T>(
  stateDir: string,
  kind: string,
  key: string,
  metadata: unknown,
  fn: () => Promise<T>,
  timeoutMs?: number,
): Promise<T>;
export declare function createStateLease(
  stateDir: string,
  kind: string,
  key: string,
  metadata: unknown,
  timeoutMs?: number,
): Promise<string>;
export declare function writeStateLeaseMetadata(
  stateDir: string,
  kind: string,
  key: string,
  metadata: unknown,
): Promise<string>;
export declare function readStateLeaseMetadata<T = unknown>(
  stateDir: string,
  kind: string,
  key: string,
): Promise<T | undefined>;
export declare function listStateLeaseMetadata<T = unknown>(stateDir: string, kind: string): T[];
export declare function releaseStateLease(stateDir: string, kind: string, key: string | undefined): Promise<void>;
