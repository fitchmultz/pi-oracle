#!/usr/bin/env node
// Cheap invariant tests for the platform-smoke harness.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import config from "../../platform-smoke.config.mjs";
import { writeManifest } from "./artifacts.mjs";
import { buildTargetBaseArgs } from "./crabbox-runner.mjs";
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

function testEmptyTargetSelectionRejected() {
  const result = runNode(["scripts/platform-smoke.mjs", "run", "--target", ",,", "--suite", "platform-build"]);
  assert.notEqual(result.status, 0, "an --target value that resolves to zero targets must fail instead of running nothing");
  assert.ifError(result.error);
  assert.match(`${result.stdout ?? ""}\n${result.stderr ?? ""}`, /--target did not resolve to any targets/);
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

function withEnv(overrides, run) {
  const names = Object.keys(overrides);
  const saved = {};
  for (const name of names) {
    saved[name] = process.env[name];
    if (overrides[name] === undefined) delete process.env[name];
    else process.env[name] = overrides[name];
  }
  try {
    return run();
  } finally {
    for (const name of names) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
  }
}

function testTargetBaseArgsEnvPrecedence() {
  withEnv({
    PI_ORACLE_SMOKE_UBUNTU_IMAGE: undefined,
    PLATFORM_SMOKE_UBUNTU_IMAGE: undefined,
    PI_ORACLE_SMOKE_MAC_WORK_ROOT: undefined,
    PLATFORM_SMOKE_MAC_WORK_ROOT: undefined,
    PI_ORACLE_SMOKE_WINDOWS_NATIVE_WORK_ROOT: undefined,
    PLATFORM_SMOKE_WINDOWS_WORK_ROOT: undefined,
  }, () => {
    const baseline = buildTargetBaseArgs("ubuntu", {});
    assert.deepEqual(
      baseline,
      ["--provider", "local-container", "--target", "linux", "--local-container-image", "pi-oracle-platform-smoke:node24"],
      "default ubuntu target args should use the documented default image",
    );

    process.env.PLATFORM_SMOKE_UBUNTU_IMAGE = "invariants-shared-image";
    let args = buildTargetBaseArgs("ubuntu", {});
    assert(args.includes("invariants-shared-image"), "shared PLATFORM_SMOKE_UBUNTU_IMAGE override should reach target args");

    process.env.PI_ORACLE_SMOKE_UBUNTU_IMAGE = "invariants-private-image";
    args = buildTargetBaseArgs("ubuntu", {});
    assert(args.includes("invariants-private-image") && !args.includes("invariants-shared-image"), "private PI_ORACLE_SMOKE_UBUNTU_IMAGE alias should win over the shared alias");

    delete process.env.PI_ORACLE_SMOKE_UBUNTU_IMAGE;
    delete process.env.PLATFORM_SMOKE_UBUNTU_IMAGE;

    process.env.PLATFORM_SMOKE_MAC_WORK_ROOT = "/invariants/shared-work";
    args = buildTargetBaseArgs("macos", {});
    assert(args.includes("/invariants/shared-work"), "shared PLATFORM_SMOKE_MAC_WORK_ROOT override should reach target args");

    process.env.PI_ORACLE_SMOKE_MAC_WORK_ROOT = "/invariants/private-work";
    args = buildTargetBaseArgs("macos", {});
    assert(args.includes("/invariants/private-work") && !args.includes("/invariants/shared-work"), "private PI_ORACLE_SMOKE_MAC_WORK_ROOT alias should win over the shared alias");

    process.env.PLATFORM_SMOKE_WINDOWS_WORK_ROOT = "C:\\invariants\\shared-work";
    args = buildTargetBaseArgs("windows-native", {});
    assert(args.includes("C:\\invariants\\shared-work"), "shared PLATFORM_SMOKE_WINDOWS_WORK_ROOT override should reach target args");

    process.env.PI_ORACLE_SMOKE_WINDOWS_NATIVE_WORK_ROOT = "C:\\invariants\\private-work";
    args = buildTargetBaseArgs("windows-native", {});
    assert(args.includes("C:\\invariants\\private-work") && !args.includes("C:\\invariants\\shared-work"), "private PI_ORACLE_SMOKE_WINDOWS_NATIVE_WORK_ROOT alias should win over the shared alias");
  });
}

const DRIVER_SOURCE = [
  "import { writeFileSync } from 'node:fs';",
  "import { pathToFileURL } from 'node:url';",
  "const [targetsPath, artifactRoot, payloadPath] = process.argv.slice(2);",
  "const { runTargetSuites } = await import(pathToFileURL(targetsPath).href);",
  "const config = {",
  "  packageName: 'pi-oracle',",
  "  artifactRoot,",
  "  realSmoke: { authEnvByProvider: { zai: ['ZAI_API_KEY'] } },",
  "};",
  "const result = await runTargetSuites(config, 'ubuntu', ['real-extension']);",
  "writeFileSync(payloadPath, `${JSON.stringify({",
  "  ok: result.ok,",
  "  results: result.results.map((entry) => ({ ok: entry.ok, suiteDir: entry.suiteDir })),",
  "})}\n`);",
].join("\n");

function fakeCrabboxScript(argvLogPath) {
  return [
    "#!/bin/sh",
    `printf '%s\\n' "$*" >> ${JSON.stringify(argvLogPath)}`,
    "case \"$1\" in",
    "  warmup)",
    "    printf '%s\\n' 'leased invariants-fake-lease'",
    "    exit 0",
    "    ;;",
    "  run)",
    "    printf '%s\\n' 'Oracle real smoke doctor ok provider: zai'",
    "    printf '%s\\n' 'mode=packed extension=./node_modules/pi-oracle'",
    "    printf '%s\\n' 'Oracle real smoke passed: invariants-fake-run'",
    "    exit 0",
    "    ;;",
    "  stop)",
    "    if [ -n \"${FAKE_STOP_FAILURE:-}\" ]; then",
    "      printf '%s\\n' 'stop failed FAKE_STOP_TOKEN=abcdefghijklmnop1234' >&2",
    "      exit 3",
    "    fi",
  "    if [ -n \"${FAKE_STOP_SECRET:-}\" ]; then",
  "      printf '%s\\n' 'FAKE_STOP_TOKEN=abcdefghijklmnop1234' >&2",
  "      exit 0",
  "    fi",
    "    printf '%s\\n' 'stopped'",
    "    exit 0",
    "    ;;",
    "esac",
    "printf '%s\\n' \"unexpected subcommand: $1\" >&2",
    "exit 9",
    "",
  ].join("\n");
}

function runFakeLeaseSuites({ dir, modelAgent }) {
  const runRoot = mkdtempSync(join(dir, "run-"));
  const argvLog = join(runRoot, "argv.log");
  const fakeCrabbox = join(runRoot, "crabbox");
  const artifactRoot = join(runRoot, "artifacts");
  const payloadPath = join(runRoot, "payload.json");
  const driverPath = join(runRoot, "driver.mjs");
  writeFileSync(fakeCrabbox, fakeCrabboxScript(argvLog), { mode: 0o700 });
  chmodSync(fakeCrabbox, 0o700);
  writeFileSync(driverPath, DRIVER_SOURCE);
  const childEnv = { ...process.env };
  childEnv.PI_ORACLE_SMOKE_CRABBOX = fakeCrabbox;
  childEnv.PLATFORM_SMOKE_CRABBOX = fakeCrabbox;
  childEnv.PLATFORM_SMOKE_UBUNTU_IMAGE = "invariants-override-image";
  delete childEnv.PI_ORACLE_SMOKE_UBUNTU_IMAGE;
  delete childEnv.PI_ORACLE_REAL_TEST_PROVIDER;
  delete childEnv.PI_ORACLE_REAL_TEST_MODEL;
  delete childEnv.PI_ORACLE_REAL_TEST_MODEL_AGENT;
  if (modelAgent) childEnv.PI_ORACLE_REAL_TEST_MODEL_AGENT = "1";
  const result = spawnSync(process.execPath, [driverPath, join(repoRoot, "scripts", "platform-smoke", "targets.mjs"), artifactRoot, payloadPath], {
    cwd: repoRoot,
    encoding: "utf8",
    env: childEnv,
  });
  assert.equal(result.status, 0, `fake-lease driver should exit cleanly: ${result.stderr}`);
  return { payload: JSON.parse(readFileSync(payloadPath, "utf8")), argvLog, runRoot };
}

function testLeaseStopFailureSurfacesAndRescansEvidence() {
  if (process.platform === "win32") return; // owner-waived Windows gates; execCrabbox cannot spawn a .cmd fake without a shell
  const dir = mkdtempSync(join(tmpdir(), "pi-oracle-stop-invariants-"));
  const savedStopFailure = process.env.FAKE_STOP_FAILURE;
  const savedStopSecret = process.env.FAKE_STOP_SECRET;
  try {
    // Failing stop with a secret in stop stderr: the failure must surface in
    // the overall result, per-suite assertions, and the appended stop evidence
    // must be rescanned for secrets after it exists.
    process.env.FAKE_STOP_FAILURE = "1";
    const failure = runFakeLeaseSuites({ dir, modelAgent: false });
    assert.equal(failure.payload.ok, false, "a failing lease stop must fail the overall multi-suite result");
    const [suite, leaseCleanup] = failure.payload.results;
    assert.ok(suite, "multi-suite run should record the executed suite result");
    const suiteChecks = JSON.parse(readFileSync(join(suite.suiteDir, "assertions.json"), "utf8")).checks;
    const leaseStop = suiteChecks.find((check) => check.id === "lease-stop");
    assert.ok(leaseStop && leaseStop.ok === false && leaseStop.error === "stop exit 3", `failing stop must be recorded as a lease-stop assertion failure, got ${JSON.stringify(leaseStop)}`);
    const noSecrets = suiteChecks.find((check) => check.id === "no-secrets");
    assert.ok(noSecrets && noSecrets.ok === false, "secrets in appended stop output must fail the suite's no-secrets assertion");
    const violationsPath = join(suite.suiteDir, "redaction-violations.json");
    assert.ok(existsSync(violationsPath), "stop-output secrets must be recorded in redaction-violations.json");
    const violations = JSON.parse(readFileSync(violationsPath, "utf8"));
    assert(violations.some((entry) => String(entry).includes("crabbox.stop.stderr.txt")), `recorded violations must attribute the stop-secret to its artifact, got ${JSON.stringify(violations)}`);
    assert.ok(existsSync(join(suite.suiteDir, "crabbox.stop.exit-code.txt")), "stop artifacts must be appended to the suite directory");
    assert.ok(existsSync(join(suite.suiteDir, "failures.md")), "a failing stop must leave a failures.md trail");
    assert.ok(leaseCleanup && leaseCleanup.ok === false, "a failing stop must surface a lease-cleanup result");
    assert.match(readFileSync(failure.argvLog, "utf8"), /invariants-override-image/, "target base args must deliver the env image override to the actual crabbox wrapper");

    // Clean stop: lease-stop passes, evidence stays clean, and the suite stays green.
    delete process.env.FAKE_STOP_FAILURE;
    const clean = runFakeLeaseSuites({ dir, modelAgent: true });
    assert.equal(clean.payload.ok, true, `a clean stop must keep the suite green, got ${JSON.stringify(readFileSync(join(clean.payload.results[0].suiteDir, "assertions.json"), "utf8"))}`);
    const cleanSuite = clean.payload.results[0];
    const cleanLeaseStop = JSON.parse(readFileSync(join(cleanSuite.suiteDir, "assertions.json"), "utf8")).checks.find((check) => check.id === "lease-stop");
    assert.ok(cleanLeaseStop && cleanLeaseStop.ok === true, "a clean stop must be recorded as a passing lease-stop assertion");
    assert.ok(!existsSync(join(cleanSuite.suiteDir, "redaction-violations.json")), "clean stop evidence must not create redaction violations");
    const cleanArgv = readFileSync(clean.argvLog, "utf8");
    assert.match(cleanArgv, /--allow-env ZAI_API_KEY/, "provider auth env may only be forwarded on the opt-in model-agent path");

    const off = runFakeLeaseSuites({ dir, modelAgent: false });
    assert.equal(off.payload.ok, true, "default (non-model-agent) run with a clean stop should stay green");
    const offArgv = readFileSync(off.argvLog, "utf8");
    const offRunLines = offArgv.split("\n").filter((line) => line.startsWith("run "));
    assert.ok(offRunLines.length > 0 && offRunLines.every((line) => !line.includes("--allow-env ZAI_API_KEY")), "default real-extension runs must not forward provider auth env");

    // Clean stop (exit 0) that still emits a secret: the aggregate result must
    // fail with the persisted evidence, not just rewrite artifacts on disk.
    process.env.FAKE_STOP_SECRET = "1";
    const cleanStopSecret = runFakeLeaseSuites({ dir, modelAgent: false });
    assert.equal(cleanStopSecret.payload.ok, false, "a stop-secret failure must propagate into the overall multi-suite result, not only the persisted artifacts");
    const secretSuite = cleanStopSecret.payload.results[0];
    assert.equal(secretSuite.ok, false, "a stop-secret failure must propagate into the suite result object");
    const secretChecks = JSON.parse(readFileSync(join(secretSuite.suiteDir, "assertions.json"), "utf8")).checks;
    const secretNoSecrets = secretChecks.find((check) => check.id === "no-secrets");
    assert.ok(secretNoSecrets && secretNoSecrets.ok === false, "a clean stop with a secret must still flip the suite's no-secrets assertion");
    const secretLeaseStop = secretChecks.find((check) => check.id === "lease-stop");
    assert.ok(secretLeaseStop && secretLeaseStop.ok === true, "a zero-exit stop must still record a passing lease-stop while its evidence fails the secret scan");
  } finally {
    if (savedStopFailure === undefined) delete process.env.FAKE_STOP_FAILURE;
    else process.env.FAKE_STOP_FAILURE = savedStopFailure;
    if (savedStopSecret === undefined) delete process.env.FAKE_STOP_SECRET;
    else process.env.FAKE_STOP_SECRET = savedStopSecret;
    rmSync(dir, { recursive: true, force: true });
  }
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
  assert.equal(config.requiredCrabbox?.minVersion, "0.26.0", "Crabbox baseline should match the documented provider contract");
  assert.equal(pkg.scripts["smoke:platform:all"], "npm run smoke:platform:doctor && node scripts/platform-smoke.mjs run --target macos,ubuntu,windows-native", "full platform smoke should remain doctor-first and cover all required targets");
  assert.match(pkg.scripts["release:check"], /npm run verify:oracle && npm run release:proof:chatgpt-presets && npm run smoke:platform:all/, "release check should combine local verification, ChatGPT preset proof, and full platform smoke");
}

function testRealSmokeExpensiveAgentPathsAreOptIn() {
  const source = readFileSync(new URL("../oracle-real-smoke.mjs", import.meta.url), "utf8");
  assert.match(source, /runPiLoaderStatus/, "default real smoke should execute a deterministic command through Pi's extension loader");
  assert.doesNotMatch(source, /tsx\/cli|runDirectOracleSubmit/, "default real smoke must not bypass Pi's loader through checkout tsx");
  assert.match(source, /const modelAgent = truthy\(env\("PI_ORACLE_REAL_TEST_MODEL_AGENT"\)\);/, "real smoke model-agent dispatch must read the env toggle, not default to the expensive path (full dispatch proof lives in the default packed real-smoke assertions)");
  assert.match(source, /PI_ORACLE_REAL_TEST_NEGATIVE_SYMLINK/, "real smoke should expose the optional negative symlink toggle");
  assert.match(source, /truthy\(env\("PI_ORACLE_REAL_TEST_NEGATIVE_SYMLINK"\)\)/, "negative symlink real-agent check should be opt-in");

  // Rendered-command boundary: the model-agent toggle is off by default and
  // only a truthy env value turns it on. (The credential boundary — auth env
  // forwarding only on the opt-in path — is proven at the crabbox transport
  // boundary in testLeaseStopFailureSurfacesAndRescansEvidence.)
  withEnv({ PI_ORACLE_REAL_TEST_MODEL_AGENT: undefined }, () => {
    const off = buildRealExtensionCommand("ubuntu", {});
    assert.match(off, /export PI_ORACLE_REAL_TEST_MODEL_AGENT=''/, "default real smoke must render the model-agent toggle off");
    process.env.PI_ORACLE_REAL_TEST_MODEL_AGENT = "1";
    const on = buildRealExtensionCommand("ubuntu", {});
    assert.match(on, /export PI_ORACLE_REAL_TEST_MODEL_AGENT='1'/, "opt-in model-agent real smoke should render the toggle on");
  });
}

testHelpTextIncludesTargetsAndExamples();
testTargetSelection();
testEmptyTargetSelectionRejected();
testPackedInstallCommandRendering();
testRealExtensionPackedInstallRendering();
testManifestFailure();
testTargetBaseArgsEnvPrecedence();
testLeaseStopFailureSurfacesAndRescansEvidence();
testPackageExclusion();
testSourceSmokeExplicitlyDebugOnly();
testCanonicalWorkflowConfig();
testRealSmokeExpensiveAgentPathsAreOptIn();
console.log("platform-smoke invariant checks passed");
