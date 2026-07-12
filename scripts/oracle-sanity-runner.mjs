// Purpose: Run the oracle sanity suite in an isolated temporary oracle state/jobs sandbox.
// Responsibilities: Spawn the TypeScript sanity entrypoint with unique temp directories and clean them up after exit.
// Scope: Test runner wrapper only; actual sanity coverage lives in scripts/oracle-sanity.ts and extracted sanity suites.
// Usage: Invoked by npm run sanity:oracle as the stable local entrypoint for the oracle regression harness.
// Invariants/Assumptions: Each run gets fresh temp state/jobs directories, and cleanup should happen on both normal exit and runner errors.
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const tsxCli = require.resolve("tsx/cli");
const stateDir = `/tmp/pi-oracle-sanity-state-${randomUUID()}`;
const jobsDir = `/tmp/pi-oracle-sanity-jobs-${randomUUID()}`;
const fakeBinDir = `/tmp/pi-oracle-sanity-bin-${randomUUID()}`;
const agentBrowserPath = join(fakeBinDir, process.platform === "win32" ? "agent-browser.cmd" : "agent-browser");

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

function usage() {
  console.error("Usage: node scripts/oracle-sanity-runner.mjs [--mode platform]");
}

function parseArgs(argv) {
  let sanityMode;
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--mode") {
      if (!argv[i + 1]) throw new Error("--mode requires a value");
      sanityMode = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg === "--help" || arg === "-h") return { help: true };
    throw new Error(`unknown argument: ${arg}`);
  }
  if (sanityMode !== undefined && sanityMode !== "platform") throw new Error(`unknown --mode: ${sanityMode}`);
  return { sanityMode };
}

let sanityMode;
try {
  const args = parseArgs(process.argv);
  if (args.help) {
    usage();
    process.exit(0);
  }
  sanityMode = args.sanityMode;
} catch (error) {
  usage();
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

mkdirSync(fakeBinDir, { recursive: true, mode: 0o700 });
writeFileSync(agentBrowserPath, process.platform === "win32" ? "@exit /b 0\r\n" : "#!/bin/sh\nexit 0\n", { mode: 0o700 });
if (process.platform !== "win32") chmodSync(agentBrowserPath, 0o700);

const child = spawn(process.execPath, [tsxCli, "scripts/oracle-sanity.ts"], {
  stdio: "inherit",
  env: {
    ...process.env,
    ...(sanityMode ? { PI_ORACLE_SANITY_MODE: sanityMode } : {}),
    PI_ORACLE_STATE_DIR: stateDir,
    PI_ORACLE_JOBS_DIR: jobsDir,
    AGENT_BROWSER_PATH: agentBrowserPath,
  },
});

async function cleanup() {
  await Promise.all([
    removeDirRobust(stateDir).catch(() => undefined),
    removeDirRobust(jobsDir).catch(() => undefined),
    removeDirRobust(fakeBinDir).catch(() => undefined),
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
