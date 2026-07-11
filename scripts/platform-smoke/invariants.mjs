#!/usr/bin/env node
// Cheap invariant tests for the platform-smoke harness.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import config from "../../platform-smoke.config.mjs";
import { writeManifest } from "./artifacts.mjs";
import { buildPlatformBuildCommand, buildRealExtensionCommand } from "./targets.mjs";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

function runNode(args) {
  return spawnSync(process.execPath, args, { cwd: repoRoot, encoding: "utf8" });
}

function testHelpTextIncludesTargetsAndExamples() {
  const result = runNode(["scripts/platform-smoke.mjs", "--help"]);
  assert.equal(result.status, 0, `help should exit cleanly: ${result.stderr}`);
  assert.match(result.stdout, /Supported: macos,ubuntu,windows-native/, "help should list supported targets");
  assert.match(result.stdout, /--suite\s+Suite name\. Supported: platform-build,real-extension/, "help should list supported suites");
  assert.match(result.stdout, /npm run release:check/, "help should name the full release gate");
  assert.match(result.stdout, /PLATFORM_SMOKE_CRABBOX/, "help should document reusable platform-smoke env knobs");
}

function testTargetSelection() {
  const result = runNode(["scripts/platform-smoke.mjs", "run", "--target", "not-a-target", "--suite", "platform-build"]);
  assert.notEqual(result.status, 0, "unsupported targets should fail before Crabbox runs");
  assert.ifError(result.error);
  assert.match(`${result.stdout ?? ""}\n${result.stderr ?? ""}`, /unsupported target: not-a-target/);
}

function testPackedInstallCommandRendering() {
  const command = buildPlatformBuildCommand("ubuntu", config.packageName, config.nodeValidationMajor);
  assert.match(command, /verify:oracle:platform/, "platform-build should run the platform-focused verification gate");
  assert.doesNotMatch(command, /npm test/, "platform-build should not run the full local iteration gate on every target");
  assert.match(command, /npm pack --silent/, "platform-build should pack the package");
  assert.match(command, /npm install --no-save/, "platform-build should install the packed tarball");
  assert.match(command, /install -l \.\/node_modules\/pi-oracle/, "platform-build should install through pi's package path");
  assert.doesNotMatch(command, /\bpi\s+(?:-e|--extension)\s+\./, "release proof must not use pi -e/--extension source shortcuts");
}

function testRealExtensionPackedInstallRendering() {
  const command = buildRealExtensionCommand("ubuntu", config);
  assert.match(command, /smoke:real:packed/, "required real-extension suite should run packed real smoke");
  assert.doesNotMatch(command, /smoke:real:source|extensions\/oracle\/index\.ts|\bpi\s+-e\b/, "required real-extension suite must not use source extension loading");
}

function testManifestFailure() {
  const dir = mkdtempSync(join(tmpdir(), "pi-oracle-manifest-test-"));
  try {
    writeFileSync(join(dir, "present.txt"), "ok\n");
    const manifest = writeManifest(dir, ["present.txt", "missing.txt"]);
    assert.deepEqual(manifest.missing, ["missing.txt"], "missing manifest entries should be reported");
    assert(manifest.expected.includes("artifact-manifest.json"), "manifest should require itself as an artifact");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function testCleanupFailureInvariant() {
  const source = readFileSync(new URL("./targets.mjs", import.meta.url), "utf8");
  assert.match(source, /recordStopResultOnSuite/, "multi-suite runs should record stop evidence on suite artifacts");
  assert.match(source, /lease-stop/, "cleanup results should be asserted as lease-stop");
  assert.match(source, /stop exit/, "cleanup failure should surface a stop exit error");
}

function testPackageExclusion() {
  const result = spawnSync("npm", ["pack", "--dry-run", "--json"], { cwd: repoRoot, encoding: "utf8", shell: process.platform === "win32" });
  assert.equal(result.status, 0, `npm pack dry-run failed: ${result.stderr}`);
  const files = JSON.parse(result.stdout)[0].files.map((file) => file.path);
  for (const forbidden of [".artifacts/", ".crabbox/", ".debug/", ".platform-smoke-runs/", ".env", "context.md"]) {
    assert(!files.some((file) => file === forbidden || file.startsWith(forbidden)), `package should exclude ${forbidden}`);
  }
}

function testSourceSmokeExplicitlyDebugOnly() {
  const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
  assert.equal(pkg.scripts["smoke:real"], "npm run smoke:real:packed", "default real smoke should be packed-release proof");
  assert.match(pkg.scripts["smoke:real:source"], /--mode source/, "source real smoke should be explicitly named");
}

function testCanonicalWorkflowConfig() {
  const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
  assert.deepEqual(config.workflows?.everyday?.commands, ["npm run verify:oracle"], "everyday workflow should use the local verification gate");
  assert(config.workflows?.platformSensitive?.commands?.includes("npm run smoke:platform:doctor"), "platform-sensitive workflow should start with doctor");
  assert(config.workflows?.platformSensitive?.commands?.some((command) => command.includes("--target <target> --suite <suite>")), "platform-sensitive workflow should document focused target/suite runs");
  assert.deepEqual(config.workflows?.platformMatrix?.commands, ["npm run smoke:platform:all"], "platform matrix workflow should use the full target matrix");
  assert.deepEqual(config.workflows?.release?.commands, ["npm run release:check"], "release workflow should use the full local-plus-platform release gate");
  assert.equal(config.requiredCrabbox?.minVersion, "0.26.0", "Crabbox baseline should match the documented provider contract");
  assert.equal(pkg.scripts["smoke:platform:all"], "npm run smoke:platform:doctor && node scripts/platform-smoke.mjs run --target macos,ubuntu,windows-native", "full platform smoke should remain doctor-first and cover all required targets");
  assert.match(pkg.scripts["release:check"], /npm run verify:oracle && npm run release:proof:chatgpt-presets && npm run smoke:platform:all/, "release check should combine local verification, ChatGPT preset proof, and full platform smoke");
  const runnerSource = readFileSync(new URL("./crabbox-runner.mjs", import.meta.url), "utf8");
  assert.match(runnerSource, /PLATFORM_SMOKE_CRABBOX/, "runner should honor reusable Crabbox binary override");
  assert.match(runnerSource, /PLATFORM_SMOKE_MAC_WORK_ROOT/, "runner should honor reusable macOS work-root override");
  assert.match(runnerSource, /PLATFORM_SMOKE_WINDOWS_WORK_ROOT/, "runner should honor reusable Windows work-root override");
}

function testRealSmokeExpensiveAgentPathsAreOptIn() {
  const source = readFileSync(new URL("../oracle-real-smoke.mjs", import.meta.url), "utf8");
  assert.match(source, /runPiLoaderStatus/, "default real smoke should execute a deterministic command through Pi's extension loader");
  assert.doesNotMatch(source, /tsx\/cli|runDirectOracleSubmit/, "default real smoke must not bypass Pi's loader through checkout tsx");
  assert.match(source, /PI_ORACLE_REAL_TEST_MODEL_AGENT/, "real smoke should expose the optional model-agent toggle");
  const targetsSource = readFileSync(new URL("./targets.mjs", import.meta.url), "utf8");
  assert.match(targetsSource, /PI_ORACLE_REAL_TEST_MODEL_AGENT/, "platform real-extension command should forward the optional model-agent toggle");
  assert.match(targetsSource, /realSmokeUsesModelAgent\(\) \? config\.realSmoke\?\.authEnvByProvider/, "platform smoke should allow provider auth env only for the optional model-agent path");
  assert.match(source, /truthy\(env\("PI_ORACLE_REAL_TEST_MODEL_AGENT"\)\)/, "model-agent real smoke path should be opt-in");
  assert.match(source, /PI_ORACLE_REAL_TEST_NEGATIVE_SYMLINK/, "real smoke should expose the optional negative symlink toggle");
  assert.match(source, /truthy\(env\("PI_ORACLE_REAL_TEST_NEGATIVE_SYMLINK"\)\)/, "negative symlink real-agent check should be opt-in");
}

testHelpTextIncludesTargetsAndExamples();
testTargetSelection();
testPackedInstallCommandRendering();
testRealExtensionPackedInstallRendering();
testManifestFailure();
testCleanupFailureInvariant();
testPackageExclusion();
testSourceSmokeExplicitlyDebugOnly();
testCanonicalWorkflowConfig();
testRealSmokeExpensiveAgentPathsAreOptIn();
console.log("platform-smoke invariant checks passed");
