import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { rm } from "node:fs/promises";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const tsxCli = require.resolve("tsx/cli");
const stateDir = `/tmp/pi-oracle-sanity-state-${randomUUID()}`;
const jobsDir = `/tmp/pi-oracle-sanity-jobs-${randomUUID()}`;

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
    rm(stateDir, { recursive: true, force: true }).catch(() => undefined),
    rm(jobsDir, { recursive: true, force: true }).catch(() => undefined),
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
