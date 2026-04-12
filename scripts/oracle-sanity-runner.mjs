// Purpose: Run the oracle sanity suite in an isolated temporary oracle state/jobs sandbox.
// Responsibilities: Spawn the TypeScript sanity entrypoint with unique temp directories and clean them up after exit.
// Scope: Test runner wrapper only; actual sanity coverage lives in scripts/oracle-sanity.ts and extracted sanity suites.
// Usage: Invoked by npm run sanity:oracle as the stable local entrypoint for the oracle regression harness.
// Invariants/Assumptions: Each run gets fresh temp state/jobs directories, and cleanup should happen on both normal exit and runner errors.
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { rm } from "node:fs/promises";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const tsxCli = require.resolve("tsx/cli");
const stateDir = `/tmp/pi-oracle-sanity-state-${randomUUID()}`;
const jobsDir = `/tmp/pi-oracle-sanity-jobs-${randomUUID()}`;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function removeDirRobust(path, options = {}) {
  const attempts = options.attempts ?? 5;
  const delayMs = options.delayMs ?? 50;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await rm(path, { recursive: true, force: true });
      return;
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
      const retryable = code === "ENOTEMPTY" || code === "EBUSY" || code === "EPERM";
      if (!retryable || attempt === attempts) throw error;
      await sleep(delayMs * attempt);
    }
  }
}

const child = spawn(process.execPath, [tsxCli, "scripts/oracle-sanity.ts"], {
  stdio: "inherit",
  env: {
    ...process.env,
    PI_ORACLE_STATE_DIR: stateDir,
    PI_ORACLE_JOBS_DIR: jobsDir,
  },
});

async function cleanup() {
  await Promise.all([
    removeDirRobust(stateDir).catch(() => undefined),
    removeDirRobust(jobsDir).catch(() => undefined),
  ]);
}

child.on("exit", (code, signal) => {
  void cleanup().finally(() => {
    if (signal) process.kill(process.pid, signal);
    process.exit(code ?? 0);
  });
});

child.on("error", (error) => {
  void cleanup().finally(() => {
    console.error(error);
    process.exit(1);
  });
});
