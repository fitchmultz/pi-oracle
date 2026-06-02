#!/usr/bin/env node

import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = resolve(__dirname, "..");
const require = createRequire(import.meta.url);

let config;
try {
  config = require(resolve(repoRoot, "platform-smoke.config.mjs"));
  if (config.default) config = config.default;
} catch (error) {
  config = null;
}

function printHelp() {
  console.log(`Usage: node scripts/platform-smoke.mjs <command> [options]

Commands:
  doctor                     Run mandatory Crabbox, host, target-tool, auth, and package preflight checks
  run --target <names>       Run one or more comma-separated targets concurrently
  run --suite <name>         Run one suite on the configured target(s)

Options:
  --target       Comma-separated target names. Supported: macos,ubuntu,windows-native
  --suite        Suite name. Supported: platform-build,real-extension
  --help, -h     Show this help

Examples:
  node scripts/platform-smoke.mjs doctor
  node scripts/platform-smoke.mjs run --target macos
  node scripts/platform-smoke.mjs run --target ubuntu
  node scripts/platform-smoke.mjs run --target windows-native
  node scripts/platform-smoke.mjs run --target macos,ubuntu,windows-native --suite platform-build
  node scripts/platform-smoke.mjs run --target macos,ubuntu,windows-native --suite real-extension

Canonical workflows:
  Everyday local iteration: npm run verify:oracle
  Platform-sensitive changes: npm run smoke:platform:doctor, then focused run --target <target> --suite <suite>
  Publish/release proof: npm run smoke:platform:all

Environment:
  PI_ORACLE_SMOKE_CRABBOX        Optional Crabbox binary override (defaults to PATH)
  PI_ORACLE_SMOKE_MAC_HOST       macOS SSH host (default: localhost)
  PI_ORACLE_SMOKE_MAC_USER       macOS SSH user (default: $USER)
  PI_ORACLE_SMOKE_MAC_WORK_ROOT  macOS Crabbox work root
  PI_ORACLE_SMOKE_UBUNTU_IMAGE   Optional local-container image override
  PI_ORACLE_SMOKE_WINDOWS_VM      Parallels source VM (default from config)
  PI_ORACLE_SMOKE_WINDOWS_SNAPSHOT Parallels snapshot (default from config)
  PI_ORACLE_SMOKE_WINDOWS_USER    Windows SSH user (default: $USER)
  PI_ORACLE_SMOKE_WINDOWS_NATIVE_WORK_ROOT Windows work root
  PI_ORACLE_REAL_TEST_PROVIDER   Real smoke provider (default: zai)
  PI_ORACLE_REAL_TEST_MODEL      Real smoke model (default: glm-5.1)
  ZAI_API_KEY                    Default real-smoke provider API key
`);
}

function parseArgs(argv) {
  const args = { command: null, target: null, suite: null };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      args.command = "help";
      return args;
    }
    if (arg === "doctor" || arg === "run") {
      args.command = arg;
      continue;
    }
    if (arg === "--target" && i + 1 < argv.length) {
      args.target = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg === "--suite" && i + 1 < argv.length) {
      args.suite = argv[i + 1];
      i += 1;
      continue;
    }
    throw new Error(`unknown argument: ${arg}`);
  }
  return args;
}

function splitCsv(value) {
  return value.split(",").map((part) => part.trim()).filter(Boolean);
}

function validateSelection(targets, suites) {
  const supportedTargets = new Set(config.requiredTargets ?? ["ubuntu"]);
  const supportedSuites = new Set(config.requiredSuites ?? ["platform-build"]);
  for (const target of targets) {
    if (!supportedTargets.has(target)) throw new Error(`unsupported target: ${target}`);
  }
  for (const suite of suites) {
    if (!supportedSuites.has(suite)) throw new Error(`unsupported suite: ${suite}`);
  }
}

async function runDoctor() {
  const { runDoctor } = await import("./platform-smoke/doctor.mjs");
  await runDoctor(config);
}

async function runTarget(targetName, suites, singleSuite) {
  const { runTargetSuite, runTargetSuites } = await import("./platform-smoke/targets.mjs");
  if (singleSuite) return runTargetSuite(config, targetName, suites[0]);
  return runTargetSuites(config, targetName, suites);
}

async function main() {
  const args = parseArgs(process.argv);
  if (!args.command || args.command === "help") {
    printHelp();
    process.exit(args.command === "help" ? 0 : 1);
  }
  if (!config) throw new Error("platform-smoke.config.mjs not found or failed to load");

  if (args.command === "doctor") {
    await runDoctor();
    return;
  }

  if (args.command === "run") {
    const targets = args.target ? splitCsv(args.target) : config.requiredTargets;
    const suites = args.suite ? [args.suite] : config.requiredSuites;
    validateSelection(targets, suites);
    const results = await Promise.all(targets.map(async (target) => {
      console.log(`\n=== Target: ${target} ===`);
      return { target, result: await runTarget(target, suites, Boolean(args.suite)) };
    }));
    if (results.some(({ result }) => !result.ok)) {
      console.log("\nOne or more platform smoke suites failed. Check .artifacts/platform-smoke/ for details.");
      process.exit(1);
    }
    return;
  }

  throw new Error(`unknown command: ${args.command}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
