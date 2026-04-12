// Purpose: Provide shared process-identity and termination helpers for oracle runtime, worker, and queue coordination.
// Responsibilities: Read stable process start identities, detect liveness, wait for freshly spawned processes, and terminate tracked processes safely.
// Scope: Local process coordination only; job-state mutation and queue semantics stay in higher-level helpers.
// Usage: Imported by lib/jobs.ts, lib/runtime.ts, worker/run-job.mjs, and shared state helpers.
// Invariants/Assumptions: Process identity is validated with `ps -o lstart=` to defend against PID reuse on macOS.

import { spawn, execFileSync } from "node:child_process";

/** @typedef {import("./process-helpers.d.mts").OracleTrackedProcessOptions} OracleTrackedProcessOptions */
/** @typedef {import("./process-helpers.d.mts").OracleDetachedProcessHandle} OracleDetachedProcessHandle */

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * @param {number | undefined} pid
 * @returns {string | undefined}
 */
export function readProcessStartedAt(pid) {
  if (!pid || pid <= 0) return undefined;
  try {
    const startedAt = execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8" }).trim();
    return startedAt || undefined;
  } catch {
    return undefined;
  }
}

/**
 * @param {number | undefined} pid
 * @returns {boolean}
 */
export function isProcessAlive(pid) {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ESRCH") return false;
    return true;
  }
}

/**
 * @param {number | undefined} pid
 * @param {string | undefined} startedAt
 * @returns {boolean}
 */
export function isTrackedProcessAlive(pid, startedAt) {
  const currentStartedAt = readProcessStartedAt(pid);
  if (!currentStartedAt) return false;
  return startedAt ? currentStartedAt === startedAt : true;
}

/**
 * @param {number | undefined} pid
 * @param {number} [timeoutMs]
 * @returns {Promise<string | undefined>}
 */
export async function waitForProcessStartedAt(pid, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const startedAt = readProcessStartedAt(pid);
    if (startedAt) return startedAt;
    await sleep(100);
  }
  return readProcessStartedAt(pid);
}

/**
 * @param {number | undefined} pid
 * @param {string | undefined} startedAt
 * @param {OracleTrackedProcessOptions} [options]
 * @returns {Promise<boolean>}
 */
export async function terminateTrackedProcess(pid, startedAt, options = {}) {
  if (!pid || pid <= 0) return true;
  const currentStartedAt = readProcessStartedAt(pid);
  if (!currentStartedAt) return true;
  if (startedAt && currentStartedAt !== startedAt) return false;

  const termGraceMs = options.termGraceMs ?? 5_000;
  const killGraceMs = options.killGraceMs ?? 2_000;

  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return !isTrackedProcessAlive(pid, startedAt);
  }

  const termDeadline = Date.now() + termGraceMs;
  while (Date.now() < termDeadline) {
    if (!isTrackedProcessAlive(pid, startedAt)) return true;
    await sleep(250);
  }

  try {
    process.kill(pid, "SIGKILL");
  } catch {
    return !isTrackedProcessAlive(pid, startedAt);
  }

  const killDeadline = Date.now() + killGraceMs;
  while (Date.now() < killDeadline) {
    if (!isTrackedProcessAlive(pid, startedAt)) return true;
    await sleep(250);
  }

  return !isTrackedProcessAlive(pid, startedAt);
}

/**
 * @param {string} scriptPath
 * @param {string[]} args
 * @returns {Promise<OracleDetachedProcessHandle>}
 */
export async function spawnDetachedNodeProcess(scriptPath, args = []) {
  const child = spawn(process.execPath, [scriptPath, ...args], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  return {
    pid: child.pid,
    startedAt: await waitForProcessStartedAt(child.pid),
  };
}
