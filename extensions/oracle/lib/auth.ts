// Purpose: Share oracle auth-bootstrap orchestration between slash commands and agent-facing tools.
// Responsibilities: Load effective auth guidance, run reconcile maintenance, spawn the auth bootstrap worker, and return user-facing results.
// Scope: Extension-side auth bootstrap orchestration only; browser cookie import and profile validation stay in worker/auth-bootstrap.mjs.
// Usage: Imported by oracle commands and tools whenever the shared oracle auth seed profile must be refreshed.
// Invariants/Assumptions: Auth bootstrap runs under the global reconcile lock when available, uses the effective oracle config for the current workspace root, and returns the worker's stdout/stderr message verbatim on success or failure.
import { spawn } from "node:child_process";
import { formatOracleAuthConfigRemediation, formatOracleAuthConfigSummary, getOracleConfigLoadDetails, loadOracleConfig } from "./config.js";
import { pruneTerminalOracleJobs, reconcileStaleOracleJobs } from "./jobs.js";
import { isLockTimeoutError, withGlobalReconcileLock } from "./locks.js";

export async function runOracleAuthBootstrap(authWorkerPath: string, cwd: string): Promise<string> {
  const config = loadOracleConfig(cwd);
  const configLoad = getOracleConfigLoadDetails(cwd);
  const authConfigGuidance = {
    ...configLoad,
    remediation: formatOracleAuthConfigRemediation(configLoad),
    summary: formatOracleAuthConfigSummary(configLoad),
  };

  try {
    await withGlobalReconcileLock({ processPid: process.pid, source: "oracle_auth", cwd }, async () => {
      await reconcileStaleOracleJobs();
      await pruneTerminalOracleJobs();
    });
  } catch (error) {
    if (!isLockTimeoutError(error, "reconcile", "global")) throw error;
  }

  return await new Promise<string>((resolve, reject) => {
    const child = spawn(process.execPath, [authWorkerPath, JSON.stringify({ config, configLoad: authConfigGuidance })], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (data) => {
      stdout += String(data);
    });
    child.stderr.on("data", (data) => {
      stderr += String(data);
    });
    child.on("error", (error) => reject(error));
    child.on("close", (code) => {
      const message = stdout.trim() || stderr.trim() || "Oracle auth bootstrap finished with no output.";
      if (code === 0) resolve(message);
      else reject(new Error(message));
    });
  });
}
