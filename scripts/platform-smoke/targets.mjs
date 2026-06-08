/**
 * Cross-platform smoke suites for pi-oracle.
 * The suites prove the package builds, packs, installs, loads, and runs through pi's package path.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { runAssertions } from "./assertions.mjs";
import { createSuiteDir, scanArtifacts, scanForSecrets, writeCommand, writeExitCode, writeManifest, writeSummary } from "./artifacts.mjs";
import { runOnLease, stopLease, warmupLease } from "./crabbox-runner.mjs";

function makeRunId() {
  return `run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function platformForTarget(targetName) {
  if (targetName === "macos") return "darwin";
  if (targetName === "windows-native") return "win32";
  return "linux";
}

function section(text, name) {
  const start = `--- ${name} START ---`;
  const end = `--- ${name} END ---`;
  const startIndex = text.indexOf(start);
  if (startIndex === -1) return "";
  const contentStart = startIndex + start.length;
  const endIndex = text.indexOf(end, contentStart);
  const raw = endIndex === -1 ? text.slice(contentStart) : text.slice(contentStart, endIndex);
  return raw.replace(/^\r?\n/, "").replace(/\r?\n$/, "");
}

function markerValue(text, name) {
  return text.match(new RegExp(`^${name}=(.*)$`, "m"))?.[1]?.trim() ?? "";
}

function writeExtracts(suiteDir, stdout) {
  writeFileSync(resolve(suiteDir, "packed-tarball.txt"), `${markerValue(stdout, "PLATFORM_PACKED_TARBALL")}\n`);
  writeFileSync(resolve(suiteDir, "packed-node-install.stdout.txt"), section(stdout, "PACKED_NODE_INSTALL_STDOUT"));
  writeFileSync(resolve(suiteDir, "packed-node-install.stderr.txt"), section(stdout, "PACKED_NODE_INSTALL_STDERR"));
  writeFileSync(resolve(suiteDir, "pi-install.stdout.txt"), section(stdout, "PI_INSTALL_STDOUT"));
  writeFileSync(resolve(suiteDir, "pi-install.stderr.txt"), section(stdout, "PI_INSTALL_STDERR"));
  writeFileSync(resolve(suiteDir, "pi-list.stdout.txt"), section(stdout, "PI_LIST_STDOUT"));
  writeFileSync(resolve(suiteDir, "pi-list.stderr.txt"), section(stdout, "PI_LIST_STDERR"));
}

function posixSection(name, command) {
  return [`echo "--- ${name} START ---"`, command, `echo "--- ${name} END ---"`];
}

function realSmokeProvider(config = {}) {
  return process.env.PI_ORACLE_REAL_TEST_PROVIDER || config.realSmoke?.defaultProvider || "zai";
}

function realSmokeModel(config = {}) {
  return process.env.PI_ORACLE_REAL_TEST_MODEL || config.realSmoke?.defaultModel || "glm-5.1";
}

function truthy(value) {
  return /^(1|true|yes|on)$/i.test(String(value ?? ""));
}

function realSmokeUsesModelAgent() {
  return truthy(process.env.PI_ORACLE_REAL_TEST_MODEL_AGENT);
}

function realSmokeAllowedEnvNames(config = {}) {
  const provider = realSmokeProvider(config);
  const authNames = realSmokeUsesModelAgent() ? config.realSmoke?.authEnvByProvider?.[provider] ?? [] : [];
  return [
    "PI_ORACLE_REAL_TEST_PROVIDER",
    "PI_ORACLE_REAL_TEST_MODEL",
    "PI_ORACLE_REAL_TEST_MODEL_AGENT",
    "PI_ORACLE_REAL_TEST_TIMEOUT_MS",
    ...authNames,
  ];
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function powershellSingleQuote(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

export function buildRealExtensionCommand(targetName = "ubuntu", config = {}) {
  const provider = realSmokeProvider(config);
  const model = realSmokeModel(config);
  const useModelAgent = realSmokeUsesModelAgent();
  if (targetName === "windows-native") {
    return [
      "$ErrorActionPreference = 'Continue'",
      `$env:PI_ORACLE_REAL_TEST_PROVIDER = ${powershellSingleQuote(provider)}`,
      `$env:PI_ORACLE_REAL_TEST_MODEL = ${powershellSingleQuote(model)}`,
      `$env:PI_ORACLE_REAL_TEST_MODEL_AGENT = ${powershellSingleQuote(useModelAgent ? "1" : "")}`,
      "$env:PI_ORACLE_REAL_TEST_TIMEOUT_MS = '360000'",
      "if (-not (Test-Path -LiteralPath 'node_modules')) { npm.cmd ci; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE } }",
      "npm.cmd run smoke:real:doctor",
      "if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }",
      "npm.cmd run smoke:real:packed",
      "exit $LASTEXITCODE",
    ].join("; ");
  }
  return [
    "set -o pipefail",
    `export PI_ORACLE_REAL_TEST_PROVIDER=${shellQuote(provider)}`,
    `export PI_ORACLE_REAL_TEST_MODEL=${shellQuote(model)}`,
    `export PI_ORACLE_REAL_TEST_MODEL_AGENT=${shellQuote(useModelAgent ? "1" : "")}`,
    'if [ ! -d node_modules ]; then npm ci; fi',
    "npm run smoke:real:doctor",
    "npm run smoke:real:packed",
  ].join("\n");
}

export function buildPlatformBuildCommand(targetName = "ubuntu", packageName = "pi-oracle", nodeValidationMajor = 24) {
  if (targetName === "windows-native") {
    return `powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File .\\scripts\\platform-smoke\\platform-build-windows.ps1 -PackageName ${packageName} -NodeValidationMajor ${nodeValidationMajor}`;
  }
  const lines = [];
  lines.push("set -o pipefail");
  if (targetName === "macos") {
    lines.push('if [ -d "$HOME/.local/share/mise/installs/node/24/bin" ]; then export PATH="$HOME/.local/share/mise/installs/node/24/bin:$PATH"; fi');
  }
  lines.push('echo "Starting pi-oracle platform-build in $(pwd) at $(date -u +%Y-%m-%dT%H:%M:%SZ)"');
  lines.push('RUN_ROOT=".platform-smoke-runs/platform-build-$(date -u +%Y%m%dT%H%M%SZ)-$$"');
  lines.push('SOURCE_ROOT="$(pwd)"');
  lines.push('PACK_DIR="$SOURCE_ROOT/$RUN_ROOT/pack"');
  lines.push('TEST_WORKSPACE="$SOURCE_ROOT/$RUN_ROOT/test-workspace"');
  lines.push('PI_PROJECT="$SOURCE_ROOT/$RUN_ROOT/pi-project"');
  lines.push('mkdir -p "$PACK_DIR" "$TEST_WORKSPACE" "$PI_PROJECT"');
  lines.push('echo "PLATFORM_RUN_ROOT=$RUN_ROOT"');
  lines.push('echo "PLATFORM_TEST_WORKSPACE=$TEST_WORKSPACE"');
  lines.push('echo "PLATFORM_PI_PROJECT=$PI_PROJECT"');
  lines.push("");
  lines.push('NODE_VERSION=$(node --version)');
  lines.push('NODE_MAJOR=${NODE_VERSION#v}');
  lines.push('NODE_MAJOR=${NODE_MAJOR%%.*}');
  lines.push('echo "PLATFORM_NODE_VERSION=$NODE_VERSION"');
  lines.push(`if [ "$NODE_MAJOR" -ge ${nodeValidationMajor} ]; then NODE_VERSION_EXIT=0; else NODE_VERSION_EXIT=1; fi`);
  lines.push('echo "PLATFORM_NODE_VERSION_EXIT=$NODE_VERSION_EXIT"');
  lines.push("");
  lines.push('echo "=== npm ci ==="');
  lines.push('npm ci 2>&1');
  lines.push('CI_EXIT=$?');
  lines.push('echo "PLATFORM_NPM_CI_EXIT=$CI_EXIT"');
  lines.push("");
  lines.push('echo "=== platform dependencies ==="');
  lines.push('DEPS_EXIT=0');
  if (targetName === "ubuntu") {
    lines.push('if command -v zstd >/dev/null 2>&1; then ZSTD_INSTALL_EXIT=0; else echo "zstd missing on Ubuntu target; use a smoke image with zstd installed before running platform smoke"; ZSTD_INSTALL_EXIT=1; fi');
  } else {
    lines.push('if command -v zstd >/dev/null 2>&1; then ZSTD_INSTALL_EXIT=0; else echo "zstd missing on macOS target; install it on the host before running platform smoke"; ZSTD_INSTALL_EXIT=1; fi');
  }
  lines.push('if [ "$ZSTD_INSTALL_EXIT" -ne 0 ]; then DEPS_EXIT=1; fi');
  lines.push('AGENT_BROWSER_BIN="$(command -v agent-browser || true)"');
  lines.push('if [ -n "$AGENT_BROWSER_BIN" ]; then AGENT_BROWSER_INSTALL_EXIT=0; else echo "agent-browser missing on target PATH; install it in target setup before running platform smoke"; AGENT_BROWSER_INSTALL_EXIT=1; fi');
  lines.push('if [ "$AGENT_BROWSER_INSTALL_EXIT" -ne 0 ]; then DEPS_EXIT=1; fi');
  lines.push('echo "PLATFORM_ZSTD_INSTALL_EXIT=$ZSTD_INSTALL_EXIT"');
  lines.push('echo "PLATFORM_AGENT_BROWSER_INSTALL_EXIT=$AGENT_BROWSER_INSTALL_EXIT"');
  lines.push('echo "PLATFORM_DEPS_EXIT=$DEPS_EXIT"');
  lines.push('command -v zstd || true');
  lines.push('if [ -n "$AGENT_BROWSER_BIN" ]; then echo "$AGENT_BROWSER_BIN"; fi');
  lines.push("");
  lines.push('echo "=== platform verification ==="');
  lines.push('AGENT_BROWSER_PATH="$AGENT_BROWSER_BIN" npm run verify:oracle:platform 2>&1');
  lines.push('TEST_EXIT=$?');
  lines.push('echo "PLATFORM_NPM_TEST_EXIT=$TEST_EXIT"');
  lines.push("");
  lines.push('echo "=== npm pack ==="');
  lines.push('PACK_TARBALL=$(npm pack --silent 2>"$PACK_DIR/npm-pack.stderr.txt")');
  lines.push('PACK_EXIT=$?');
  lines.push('cat "$PACK_DIR/npm-pack.stderr.txt"');
  lines.push('echo "PLATFORM_NPM_PACK_EXIT=$PACK_EXIT"');
  lines.push('if [ -n "$PACK_TARBALL" ] && [ -f "$PACK_TARBALL" ]; then mv "$PACK_TARBALL" "$PACK_DIR/$PACK_TARBALL"; fi');
  lines.push('echo "PLATFORM_PACKED_TARBALL=$PACK_TARBALL"');
  lines.push('printf "%s\\n" "$PACK_TARBALL" > "$PACK_DIR/packed-tarball.txt"');
  lines.push("");
  lines.push('echo "=== fixture workspace ==="');
  lines.push('cp package.json README.md "$TEST_WORKSPACE"/ 2>"$PACK_DIR/fixture.stderr.txt"');
  lines.push('FIXTURE_COPY_EXIT=$?');
  lines.push('cp -R extensions prompts docs "$TEST_WORKSPACE"/ 2>>"$PACK_DIR/fixture.stderr.txt"');
  lines.push('TREE_COPY_EXIT=$?');
  lines.push('if [ "$FIXTURE_COPY_EXIT" -eq 0 ] && [ "$TREE_COPY_EXIT" -eq 0 ]; then FIXTURE_EXIT=0; else FIXTURE_EXIT=1; fi');
  lines.push('cat "$PACK_DIR/fixture.stderr.txt"');
  lines.push('echo "PLATFORM_FIXTURE_EXIT=$FIXTURE_EXIT"');
  lines.push("");
  lines.push('echo "=== pi install packed package ==="');
  lines.push('PI_CLI="$(pwd)/node_modules/.bin/pi"');
  lines.push('if [ ! -x "$PI_CLI" ]; then PI_CLI="$(command -v pi || true)"; fi');
  lines.push('echo "PLATFORM_PI_CLI=$PI_CLI"');
  lines.push('if [ -n "$PACK_TARBALL" ] && [ -n "$PI_CLI" ] && [ -f "$PACK_DIR/$PACK_TARBALL" ]; then (cd "$PI_PROJECT" && npm init -y >"$PACK_DIR/packed-node-install.stdout.txt" 2>"$PACK_DIR/packed-node-install.stderr.txt" && npm install --no-save "$PACK_DIR/$PACK_TARBALL" >>"$PACK_DIR/packed-node-install.stdout.txt" 2>>"$PACK_DIR/packed-node-install.stderr.txt"); PACKED_NODE_INSTALL_EXIT=$?; else echo "missing pi cli or tarball" >"$PACK_DIR/packed-node-install.stderr.txt"; PACKED_NODE_INSTALL_EXIT=1; fi');
  lines.push('echo "PLATFORM_PACKED_NODE_INSTALL_EXIT=$PACKED_NODE_INSTALL_EXIT"');
  lines.push(...posixSection("PACKED_NODE_INSTALL_STDOUT", 'cat "$PACK_DIR/packed-node-install.stdout.txt" 2>/dev/null || true'));
  lines.push(...posixSection("PACKED_NODE_INSTALL_STDERR", 'cat "$PACK_DIR/packed-node-install.stderr.txt" 2>/dev/null || true'));
  lines.push(`if [ "$PACKED_NODE_INSTALL_EXIT" -eq 0 ] && [ -n "$PI_CLI" ]; then (cd "$PI_PROJECT" && PI_OFFLINE=1 "$PI_CLI" install -l ./node_modules/${packageName} --approve >"$PACK_DIR/pi-install.stdout.txt" 2>"$PACK_DIR/pi-install.stderr.txt"); PI_INSTALL_EXIT=$?; else echo "packed npm install failed or missing pi cli" >"$PACK_DIR/pi-install.stderr.txt"; PI_INSTALL_EXIT=1; fi`);
  lines.push('echo "PLATFORM_PI_INSTALL_EXIT=$PI_INSTALL_EXIT"');
  lines.push(...posixSection("PI_INSTALL_STDOUT", 'cat "$PACK_DIR/pi-install.stdout.txt" 2>/dev/null || true'));
  lines.push(...posixSection("PI_INSTALL_STDERR", 'cat "$PACK_DIR/pi-install.stderr.txt" 2>/dev/null || true'));
  lines.push("");
  lines.push('echo "=== pi list ==="');
  lines.push('if [ -n "$PI_CLI" ]; then (cd "$PI_PROJECT" && PI_OFFLINE=1 "$PI_CLI" list --approve >"$PACK_DIR/pi-list.stdout.txt" 2>"$PACK_DIR/pi-list.stderr.txt"); PI_LIST_EXIT=$?; else echo "missing pi cli" >"$PACK_DIR/pi-list.stderr.txt"; PI_LIST_EXIT=1; fi');
  lines.push('echo "PLATFORM_PI_LIST_EXIT=$PI_LIST_EXIT"');
  lines.push(...posixSection("PI_LIST_STDOUT", 'cat "$PACK_DIR/pi-list.stdout.txt" 2>/dev/null || true'));
  lines.push(...posixSection("PI_LIST_STDERR", 'cat "$PACK_DIR/pi-list.stderr.txt" 2>/dev/null || true'));
  lines.push("");
  lines.push('echo "node=$NODE_VERSION_EXIT ci=$CI_EXIT deps=$DEPS_EXIT test=$TEST_EXIT pack=$PACK_EXIT fixture=$FIXTURE_EXIT packedNodeInstall=$PACKED_NODE_INSTALL_EXIT install=$PI_INSTALL_EXIT list=$PI_LIST_EXIT"');
  lines.push('if [ "$NODE_VERSION_EXIT" -ne 0 ] || [ "$CI_EXIT" -ne 0 ] || [ "$DEPS_EXIT" -ne 0 ] || [ "$TEST_EXIT" -ne 0 ] || [ "$PACK_EXIT" -ne 0 ] || [ "$FIXTURE_EXIT" -ne 0 ] || [ "$PACKED_NODE_INSTALL_EXIT" -ne 0 ] || [ "$PI_INSTALL_EXIT" -ne 0 ] || [ "$PI_LIST_EXIT" -ne 0 ]; then');
  lines.push('  echo "PLATFORM_BUILD_FAILED: node=$NODE_VERSION_EXIT ci=$CI_EXIT deps=$DEPS_EXIT test=$TEST_EXIT pack=$PACK_EXIT fixture=$FIXTURE_EXIT packedNodeInstall=$PACKED_NODE_INSTALL_EXIT install=$PI_INSTALL_EXIT list=$PI_LIST_EXIT"');
  lines.push('  exit 1');
  lines.push('fi');
  lines.push('echo "PLATFORM_BUILD_OK"');
  return lines.join("\n");
}

export async function runTargetSuite(config, targetName, suiteName, leaseSession) {
  if (!["macos", "ubuntu", "windows-native"].includes(targetName)) throw new Error(`unknown target: ${targetName}`);
  if (!["platform-build", "real-extension"].includes(suiteName)) throw new Error(`unknown suite: ${suiteName}`);
  const runId = makeRunId();
  const suiteDir = createSuiteDir(config.artifactRoot, runId, targetName, suiteName);
  const slug = `${config.packageName ?? "pi-oracle"}-${targetName}`;
  writeFileSync(resolve(suiteDir, "target.json"), JSON.stringify({ targetName, platform: platformForTarget(targetName), slug, runId, writtenAt: new Date().toISOString() }, null, 2));
  writeFileSync(resolve(suiteDir, "suite.json"), JSON.stringify({ suiteName, writtenAt: new Date().toISOString() }, null, 2));

  const command = suiteName === "platform-build"
    ? buildPlatformBuildCommand(targetName, config.packageName ?? "pi-oracle", config.nodeValidationMajor ?? 24)
    : buildRealExtensionCommand(targetName, config);
  writeCommand(suiteDir, command);

  let warmup = leaseSession;
  const ownsLease = !warmup;
  if (!warmup) {
    console.log(`  warmup ${targetName}...`);
    warmup = await warmupLease(config, targetName, slug);
    if (!warmup.ok) return failTransportSuite(suiteDir, targetName, suiteName, warmup, "warmup");
  }

  const startedAt = Date.now();
  console.log(`  executing ${suiteName} on ${targetName}...`);
  const result = await runOnLease(config, targetName, warmup.leaseId, command, {
    shell: true,
    timeout: suiteName === "real-extension" ? 900_000 : 900_000,
    sync: leaseSession?.sync,
    allowEnvNames: suiteName === "real-extension" ? realSmokeAllowedEnvNames(config) : undefined,
  });
  const elapsedMs = Date.now() - startedAt;

  writeFileSync(resolve(suiteDir, "crabbox.stdout.txt"), result.stdout);
  writeFileSync(resolve(suiteDir, "crabbox.stderr.txt"), result.stderr);
  writeFileSync(resolve(suiteDir, "crabbox.timing.json"), JSON.stringify({ startedAt: new Date(startedAt).toISOString(), elapsedMs, code: result.code, signal: result.signal }, null, 2));
  writeExitCode(suiteDir, result.code, result.signal);
  if (suiteName === "platform-build") writeExtracts(suiteDir, result.stdout);

  let stopResult;
  if (ownsLease) {
    stopResult = await stopLease(config, targetName, warmup.leaseId);
    writeStopArtifacts(suiteDir, stopResult);
  }

  const violations = [
    ...scanForSecrets(`${result.stdout}\n${result.stderr}`),
    ...scanArtifacts(suiteDir).map((finding) => `${finding.file}: ${finding.violation}`),
  ];
  if (violations.length > 0) writeFileSync(resolve(suiteDir, "redaction-violations.json"), JSON.stringify(violations, null, 2));

  const stdout = result.stdout;
  const packageName = config.packageName ?? "pi-oracle";
  let checks;
  let expectedFiles;
  if (suiteName === "platform-build") {
    const listOutput = section(stdout, "PI_LIST_STDOUT");
    const escapedPackageName = packageName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const packageInstallPattern = new RegExp(`node_modules[\\\\/]${escapedPackageName}`);
    const nodeMajor = Number(stdout.match(/PLATFORM_NODE_VERSION=v?(\d+)\./)?.[1] ?? 0);
    checks = [
      { id: "build-exit-zero", fn: () => result.code === 0, error: `exit ${result.code}` },
      { id: "build-marker", fn: () => stdout.includes("PLATFORM_BUILD_OK") },
      { id: "node-version", fn: () => nodeMajor >= (config.nodeValidationMajor ?? 24) },
      { id: "npm-ci", fn: () => /PLATFORM_NPM_CI_EXIT=0/.test(stdout) },
      { id: "platform-dependencies", fn: () => /PLATFORM_DEPS_EXIT=0/.test(stdout) },
      { id: "platform-verification", fn: () => /PLATFORM_NPM_TEST_EXIT=0/.test(stdout) },
      { id: "npm-pack", fn: () => /PLATFORM_NPM_PACK_EXIT=0/.test(stdout) && /PLATFORM_PACKED_TARBALL=\S+/.test(stdout) },
      { id: "fixture-workspace", fn: () => /PLATFORM_FIXTURE_EXIT=0/.test(stdout) },
      { id: "packed-node-install", fn: () => /PLATFORM_PACKED_NODE_INSTALL_EXIT=0/.test(stdout) },
      { id: "pi-install", fn: () => /PLATFORM_PI_INSTALL_EXIT=0/.test(stdout) },
      { id: "pi-list", fn: () => /PLATFORM_PI_LIST_EXIT=0/.test(stdout) && listOutput.includes(packageName) && packageInstallPattern.test(listOutput) },
      { id: "no-source-extension-path", fn: () => !/\bpi\s+(?:-e|--extension)\s+\./.test(stdout) },
      { id: "no-secrets", fn: () => violations.length === 0, error: "redaction violations found" },
    ];
    expectedFiles = [
      "summary.json", "target.json", "suite.json", "command.txt", "exit-code.txt",
      "crabbox.stdout.txt", "crabbox.stderr.txt", "crabbox.timing.json",
      "packed-tarball.txt", "packed-node-install.stdout.txt", "packed-node-install.stderr.txt",
      "pi-install.stdout.txt", "pi-install.stderr.txt", "pi-list.stdout.txt", "pi-list.stderr.txt",
      "assertions.json",
    ];
  } else {
    const provider = process.env.PI_ORACLE_REAL_TEST_PROVIDER || "zai";
    checks = [
      { id: "real-smoke-exit-zero", fn: () => result.code === 0, error: `exit ${result.code}` },
      { id: "real-smoke-doctor", fn: () => stdout.includes("Oracle real smoke doctor") && stdout.includes(`provider: ${provider}`) },
      { id: "real-smoke-marker", fn: () => stdout.includes("Oracle real smoke passed:") },
      { id: "real-smoke-packed-install", fn: () => stdout.includes("mode=packed") && stdout.includes("extension=./node_modules/pi-oracle") },
      { id: "real-smoke-no-source-extension", fn: () => !stdout.includes("extensions/oracle/index.ts") && !/\bpi\s+(?:-e|--extension)\s+extensions\/oracle/.test(stdout) },
      { id: "no-secrets", fn: () => violations.length === 0, error: "redaction violations found" },
    ];
    expectedFiles = [
      "summary.json", "target.json", "suite.json", "command.txt", "exit-code.txt",
      "crabbox.stdout.txt", "crabbox.stderr.txt", "crabbox.timing.json", "assertions.json",
    ];
  }
  if (stopResult) checks.push({ id: "lease-stop", fn: () => stopResult.code === 0, error: `stop exit ${stopResult.code}` });
  if (stopResult) expectedFiles.push("crabbox.stop.stdout.txt", "crabbox.stop.stderr.txt", "crabbox.stop.exit-code.txt");
  const assertions = finalizeSuiteArtifacts(suiteDir, checks, { target: targetName, suite: suiteName, exitCode: result.code, signal: result.signal, elapsedMs }, expectedFiles);
  console.log(`  ${assertions.ok ? "PASS" : "FAIL"} ${suiteName} on ${targetName} (${elapsedMs}ms)`);
  return { ok: assertions.ok, suiteDir, assertions };
}

export async function runTargetSuites(config, targetName, suiteNames) {
  const slug = `${config.packageName ?? "pi-oracle"}-${targetName}`;
  console.log(`  warmup ${targetName}...`);
  const warmup = await warmupLease(config, targetName, slug);
  if (!warmup.ok) {
    const result = createWarmupFailureResult(config, targetName, suiteNames[0] ?? "platform-build", warmup);
    return { ok: false, results: [result] };
  }

  const results = [];
  let sync = true;
  let stopResult;
  try {
    for (const suiteName of suiteNames) {
      const result = await runTargetSuite(config, targetName, suiteName, { ...warmup, sync });
      results.push(result);
      sync = false;
      if (!result.ok) break;
    }
  } finally {
    stopResult = await stopLease(config, targetName, warmup.leaseId);
    for (const result of results) recordStopResultOnSuite(result.suiteDir, stopResult);
  }
  if (stopResult?.code !== 0) results.push(createStopFailureResult(config, targetName, warmup.leaseId, stopResult));
  return { ok: results.every((result) => result.ok), results };
}

function writeStopArtifacts(suiteDir, stopResult) {
  writeFileSync(resolve(suiteDir, "crabbox.stop.stdout.txt"), stopResult.stdout ?? "");
  writeFileSync(resolve(suiteDir, "crabbox.stop.stderr.txt"), stopResult.stderr ?? "");
  writeFileSync(resolve(suiteDir, "crabbox.stop.exit-code.txt"), `code=${stopResult.code}\nsignal=${stopResult.signal ?? "none"}\n`);
}

function recordStopResultOnSuite(suiteDir, stopResult) {
  if (!suiteDir || !stopResult) return;
  writeStopArtifacts(suiteDir, stopResult);
  const assertionsPath = resolve(suiteDir, "assertions.json");
  const summaryPath = resolve(suiteDir, "summary.json");
  const manifestPath = resolve(suiteDir, "artifact-manifest.json");
  const assertions = JSON.parse(readFileSync(assertionsPath, "utf8"));
  const summary = JSON.parse(readFileSync(summaryPath, "utf8"));
  const stopCheck = { id: "lease-stop", ok: stopResult.code === 0, ...(stopResult.code === 0 ? {} : { error: `stop exit ${stopResult.code}` }) };
  assertions.checks = [...(assertions.checks ?? []).filter((check) => check.id !== "lease-stop"), stopCheck];
  assertions.ok = assertions.checks.every((check) => check.ok);
  writeFileSync(assertionsPath, JSON.stringify({ ...assertions, writtenAt: new Date().toISOString() }, null, 2));
  if (!assertions.ok) {
    const failed = assertions.checks.filter((check) => !check.ok);
    writeFileSync(resolve(suiteDir, "failures.md"), `# Assertion Failures\n\n${failed.map((check) => `- **${check.id}**: ${check.error ?? "failed"}`).join("\n")}\n\nTotal: ${failed.length} failure(s)\n`);
  }
  writeSummary(suiteDir, { ...summary, ok: Boolean(summary.ok && assertions.ok) });
  const previousManifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const expected = [...new Set([...(previousManifest.expected ?? []), "crabbox.stop.stdout.txt", "crabbox.stop.stderr.txt", "crabbox.stop.exit-code.txt", "artifact-manifest.json"])]
  writeManifest(suiteDir, expected);
}

function finalizeSuiteArtifacts(suiteDir, checks, summary, expectedFiles) {
  let assertions = runAssertions(suiteDir, checks);
  writeSummary(suiteDir, { ...summary, ok: assertions.ok });
  let manifest = writeManifest(suiteDir, assertions.ok ? expectedFiles : [...expectedFiles, "failures.md"]);
  if (manifest.missing.length > 0) {
    assertions = runAssertions(suiteDir, [
      ...checks,
      { id: "artifact-manifest-complete", fn: () => false, error: `missing required artifact(s): ${manifest.missing.join(", ")}` },
    ]);
    writeSummary(suiteDir, { ...summary, ok: false });
    manifest = writeManifest(suiteDir, [...expectedFiles, "failures.md"]);
  }
  void manifest;
  return assertions;
}

function failTransportSuite(suiteDir, targetName, suiteName, result, phase) {
  writeFileSync(resolve(suiteDir, `crabbox.${phase}.stdout.txt`), result.stdout ?? "");
  writeFileSync(resolve(suiteDir, `crabbox.${phase}.stderr.txt`), result.stderr ?? "");
  writeExitCode(suiteDir, result.code ?? 1, result.signal);
  const assertions = finalizeSuiteArtifacts(
    suiteDir,
    [{ id: phase, fn: () => false, error: `Crabbox ${phase} failed: ${String(result.stderr || result.stdout || "unknown").slice(-500)}` }],
    { target: targetName, suite: suiteName, exitCode: result.code ?? 1, signal: result.signal, phase },
    ["summary.json", "target.json", "suite.json", "command.txt", "exit-code.txt", `crabbox.${phase}.stdout.txt`, `crabbox.${phase}.stderr.txt`, "assertions.json"],
  );
  return { ok: false, suiteDir, assertions };
}

function createWarmupFailureResult(config, targetName, suiteName, warmup) {
  const runId = makeRunId();
  const suiteDir = createSuiteDir(config.artifactRoot, runId, targetName, suiteName);
  const slug = `${config.packageName ?? "pi-oracle"}-${targetName}`;
  writeFileSync(resolve(suiteDir, "target.json"), JSON.stringify({ targetName, platform: platformForTarget(targetName), slug, runId, writtenAt: new Date().toISOString() }, null, 2));
  writeFileSync(resolve(suiteDir, "suite.json"), JSON.stringify({ suiteName, writtenAt: new Date().toISOString() }, null, 2));
  writeCommand(suiteDir, `crabbox warmup ${targetName}`);
  return failTransportSuite(suiteDir, targetName, suiteName, warmup, "warmup");
}

function createStopFailureResult(config, targetName, leaseId, stopResult) {
  const suiteName = "lease-cleanup";
  const runId = makeRunId();
  const suiteDir = createSuiteDir(config.artifactRoot, runId, targetName, suiteName);
  writeFileSync(resolve(suiteDir, "target.json"), JSON.stringify({ targetName, platform: platformForTarget(targetName), leaseId, runId, writtenAt: new Date().toISOString() }, null, 2));
  writeFileSync(resolve(suiteDir, "suite.json"), JSON.stringify({ suiteName, writtenAt: new Date().toISOString() }, null, 2));
  writeCommand(suiteDir, `crabbox stop ${targetName} --id ${leaseId}`);
  writeExitCode(suiteDir, stopResult.code, stopResult.signal);
  writeStopArtifacts(suiteDir, stopResult);
  const assertions = finalizeSuiteArtifacts(
    suiteDir,
    [{ id: "lease-stop", fn: () => false, error: `stop exit ${stopResult.code}` }],
    { target: targetName, suite: suiteName, exitCode: stopResult.code, signal: stopResult.signal },
    ["summary.json", "target.json", "suite.json", "command.txt", "exit-code.txt", "crabbox.stop.stdout.txt", "crabbox.stop.stderr.txt", "crabbox.stop.exit-code.txt", "assertions.json"],
  );
  return { ok: false, suiteDir, assertions };
}

export function readSuiteSummary(suiteDir) {
  return JSON.parse(readFileSync(resolve(suiteDir, "summary.json"), "utf8"));
}
