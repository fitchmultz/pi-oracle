// Purpose: Share oracle state path defaults across extension and detached workers.
// Scope: Path/env defaults only; no filesystem mutation.

export const DEFAULT_ORACLE_JOBS_DIR = "/tmp";
export const ORACLE_JOBS_DIR_ENV = "PI_ORACLE_JOBS_DIR";

export function getOracleJobsDir(env = process.env) {
  return env[ORACLE_JOBS_DIR_ENV]?.trim() || DEFAULT_ORACLE_JOBS_DIR;
}
