// Purpose: Pure argument parsing and result summarizing for the model-free `/oracle-run` command.
// Responsibilities: Turn the command's argument string into an invocation, and a tool result into the one-line JSON summary drivers read.
// Scope: No filesystem, session, or tool access; shared by the extension command and its tests.
// Invariants/Assumptions: Paths are absolute; a preflight takes no dispatch marker; anything that is not a result object is an error.
import { isAbsolute } from "node:path";

export const ORACLE_RUN_OPERATIONS = Object.freeze(["preflight", "submit", "read"]);
export const ORACLE_RUN_USAGE =
  "Usage: /oracle-run <preflight|submit|read> <request.json> <result.json> [<marker.json>] (absolute paths; existing result or marker files are never overwritten)";

/** @param {unknown} value @returns {Record<string, unknown> | undefined} */
function asRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? /** @type {Record<string, unknown>} */ (value) : undefined;
}

/**
 * @param {string} args
 * @returns {{ operation: "preflight" | "submit" | "read", requestPath: string, resultPath: string, markerPath?: string }}
 */
export function parseOracleRunArgs(args) {
  const parts = args.trim().split(/\s+/).filter(Boolean);
  const [operation, requestPath, resultPath, markerPath, ...rest] = parts;
  if (!operation || !requestPath || !resultPath || rest.length > 0) throw new Error(ORACLE_RUN_USAGE);
  if (operation !== "preflight" && operation !== "submit" && operation !== "read") throw new Error(ORACLE_RUN_USAGE);
  for (const path of [requestPath, resultPath, markerPath]) {
    if (path !== undefined && !isAbsolute(path)) throw new Error(`${ORACLE_RUN_USAGE}\nNot an absolute path: ${path}`);
  }
  if (markerPath !== undefined && operation === "preflight") throw new Error(`${ORACLE_RUN_USAGE}\nA preflight dispatches nothing and takes no marker.`);
  return markerPath === undefined ? { operation, requestPath, resultPath } : { operation, requestPath, resultPath, markerPath };
}

/**
 * The host-facing shape of a tool result, read field by field; anything else counts as an error.
 * @param {"preflight" | "submit" | "read"} operation
 * @param {unknown} result
 * @returns {{ operation: "preflight" | "submit" | "read", ok: boolean, jobId?: string, status?: string, ready?: boolean, error?: string }}
 */
export function summarizeOracleRunResult(operation, result) {
  const record = asRecord(result);
  if (!record) return { operation, ok: false, error: "tool returned no result object" };
  const details = asRecord(record.details) ?? {};
  const job = asRecord(details.job) ?? {};
  const error = asRecord(details.error);
  /** @type {{ operation: "preflight" | "submit" | "read", ok: boolean, jobId?: string, status?: string, ready?: boolean, error?: string }} */
  const summary = { operation, ok: record.isError !== true && error === undefined };
  if (typeof job.id === "string") summary.jobId = job.id;
  if (typeof job.status === "string") summary.status = job.status;
  if (typeof details.ready === "boolean") summary.ready = details.ready;
  if (error) summary.error = [error.code, error.message].filter((part) => typeof part === "string").join(": ");
  return summary;
}
