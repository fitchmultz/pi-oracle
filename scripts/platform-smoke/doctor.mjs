// Preflight checks for the pi-oracle Crabbox platform smoke gate.

import { execFileSync, execSync } from "node:child_process";
import { accessSync, constants, existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

let failures = 0;

function ok(label) { console.log(`  ✓ ${label}`); }
function warn(label) { console.log(`  ⚠ ${label}`); }
function fail(label) { console.error(`  ✗ ${label}`); failures += 1; }
function env(name) { return process.env[name] ?? ""; }
function truthy(value) { return /^(1|true|yes|on)$/i.test(String(value ?? "")); }

function silent(command, args, opts = {}) {
  try { return execFileSync(command, args, { timeout: 20_000, stdio: "pipe", ...opts }).toString().trim(); }
  catch { return null; }
}

function shell(command, opts = {}) {
  try { return execSync(command, { timeout: 20_000, stdio: "pipe", ...opts }).toString().trim(); }
  catch { return null; }
}

function resolveCommand(command) {
  if (!command) return null;
  if (command.includes("/") || command.includes("\\")) return command;
  return shell(`command -v ${command}`) ?? command;
}

function compareVersions(actual, required) {
  const a = String(actual).split(".").map((part) => Number.parseInt(part, 10));
  const b = String(required).split(".").map((part) => Number.parseInt(part, 10));
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const av = Number.isFinite(a[i]) ? a[i] : 0;
    const bv = Number.isFinite(b[i]) ? b[i] : 0;
    if (av > bv) return 1;
    if (av < bv) return -1;
  }
  return 0;
}

function realSmokeProvider(config) {
  return process.env.PI_ORACLE_REAL_TEST_PROVIDER || config.realSmoke?.defaultProvider || "zai";
}

function windowsVmName(config) {
  return env("PI_ORACLE_SMOKE_WINDOWS_VM") || env("PLATFORM_SMOKE_WINDOWS_VM") || config.windowsParallels?.sourceVm || "pi-extension-windows-template";
}

function windowsSnapshotName(config) {
  return env("PI_ORACLE_SMOKE_WINDOWS_SNAPSHOT") || env("PLATFORM_SMOKE_WINDOWS_SNAPSHOT") || config.windowsParallels?.snapshot || "crabbox-ready";
}

function requiredRealSmokeAuthEnv(config) {
  if (!(config.requiredSuites ?? []).includes("real-extension")) return [];
  if (!truthy(process.env.PI_ORACLE_REAL_TEST_MODEL_AGENT)) return [];
  const provider = realSmokeProvider(config);
  return config.realSmoke?.authEnvByProvider?.[provider] ?? [];
}

function parseJson(text) {
  try { return JSON.parse(text); } catch { return undefined; }
}

function targetBaseArgs(targetName, config) {
  if (targetName === "macos") {
    const host = env("PI_ORACLE_SMOKE_MAC_HOST") || env("PLATFORM_SMOKE_MAC_HOST") || "localhost";
    const user = env("PI_ORACLE_SMOKE_MAC_USER") || env("PLATFORM_SMOKE_MAC_USER") || env("USER");
    const workRoot = env("PI_ORACLE_SMOKE_MAC_WORK_ROOT") || env("PLATFORM_SMOKE_MAC_WORK_ROOT") || `/Users/${env("USER")}/crabbox/${config.packageName}`;
    return ["--provider", "ssh", "--target", "macos", "--static-host", host, "--static-user", user, "--static-port", "22", "--static-work-root", workRoot];
  }
  if (targetName === "ubuntu") {
    const image = env("PI_ORACLE_SMOKE_UBUNTU_IMAGE") || env("PLATFORM_SMOKE_UBUNTU_IMAGE") || config.ubuntuContainerImage || "pi-oracle-platform-smoke:node24";
    return ["--provider", "local-container", "--target", "linux", "--local-container-image", image];
  }
  const vm = windowsVmName(config);
  const snapshot = windowsSnapshotName(config);
  const user = env("PI_ORACLE_SMOKE_WINDOWS_USER") || env("PLATFORM_SMOKE_WINDOWS_USER") || env("USER");
  const workRoot = env("PI_ORACLE_SMOKE_WINDOWS_NATIVE_WORK_ROOT") || env("PLATFORM_SMOKE_WINDOWS_WORK_ROOT") || `C:\\crabbox\\${config.packageName}`;
  return ["--provider", "parallels", "--target", "windows", "--windows-mode", "normal", "--parallels-source", vm, "--parallels-source-snapshot", snapshot, "--parallels-user", user, "--parallels-work-root", workRoot];
}

function runCrabboxDoctor(cbox, label, args, timeout = 120_000) {
  const output = silent(cbox, ["doctor", ...args, "--json"], { env: { ...process.env, CRABBOX_SYNC_GIT_SEED: "false" }, timeout });
  if (!output) {
    fail(`crabbox doctor ${label} failed`);
    return;
  }
  const parsed = parseJson(output);
  if (!parsed) fail(`could not parse ${label} Crabbox doctor JSON`);
  else if (parsed.ok) ok(`${label} provider OK`);
  else fail(`${label} doctor failed: ${parsed.error ?? "not ok"}`);
}

function runTargetToolProbe(cbox, targetName, config) {
  const required = targetName === "windows-native"
    ? ["node", "npm", "git", "tar", "zstd", "agent-browser"]
    : ["node", "npm", "git", "tar", "rsync", "zstd", "agent-browser"];
  const command = targetName === "windows-native"
    ? `cmd.exe /c "where node && where npm && where git && where tar && where zstd && where agent-browser && zstd --version && agent-browser --version && echo tools-ok"`
    : `missing=""; for tool in ${required.join(" ")}; do command -v "$tool" >/dev/null 2>&1 || missing="$missing $tool"; done; if [ -n "$missing" ]; then echo "missing=$missing"; exit 1; fi; zstd --version >/dev/null && agent-browser --version >/dev/null && echo tools-ok`;
  const baseArgs = targetBaseArgs(targetName, config);
  if (targetName === "macos") baseArgs.push("--reclaim");
  const result = silent(cbox, ["run", ...baseArgs, "--no-sync", "--shell", command], {
    env: { ...process.env, CRABBOX_SYNC_GIT_SEED: "false" },
    timeout: targetName === "windows-native" ? 300_000 : 180_000,
  });
  result?.includes("tools-ok") ? ok(`${targetName} required target tools OK`) : fail(`${targetName} required target tools missing or probe failed${result ? `: ${result.split(/\r?\n/).slice(-3).join(" | ")}` : ""}`);
}

function verifyWindowsTemplate(config) {
  const vm = windowsVmName(config);
  const snapshot = windowsSnapshotName(config);
  const prlctl = resolveCommand("prlctl");
  if (!prlctl) {
    fail("prlctl not found on host PATH");
    return;
  }
  ok(`prlctl: ${prlctl}`);
  const list = silent("prlctl", ["list", "--all", "-j"], { timeout: 30_000 });
  const vms = parseJson(list);
  const vmRecord = Array.isArray(vms) ? vms.find((entry) => entry.name === vm || entry.ID === vm) : undefined;
  if (!vmRecord) fail(`Windows source VM not found: ${vm}`);
  else if (vmRecord.status !== "stopped") fail(`Windows source VM ${vm} must be stopped; status=${vmRecord.status}`);
  else ok(`Windows source VM stopped: ${vm}`);

  const snapshotsText = silent("prlctl", ["snapshot-list", vm, "-j"], { timeout: 30_000 });
  const snapshots = parseJson(snapshotsText);
  const snapshotRecord = snapshots ? Object.values(snapshots).find((entry) => entry?.name === snapshot) : undefined;
  if (!snapshotRecord) fail(`Windows snapshot not found: ${snapshot}`);
  else if (snapshotRecord.state !== "poweroff") fail(`Windows snapshot ${snapshot} must be poweroff; state=${snapshotRecord.state}`);
  else ok(`Windows snapshot poweroff/forkable: ${snapshot}`);
}

function verifyPackageExclusions() {
  const forbiddenPatterns = [/^\.env(?:\.|$)/, /^\.artifacts(?:\/|$)/, /^\.crabbox(?:\/|$)/, /^\.debug(?:\/|$)/, /^\.platform-smoke-runs(?:\/|$)/, /\.tgz$/];
  const output = shell("npm pack --dry-run --json", { timeout: 120_000 });
  const parsed = parseJson(output);
  if (!Array.isArray(parsed) || !parsed[0]?.files) {
    warn("could not inspect npm pack file list");
    return;
  }
  const files = parsed[0].files.map((file) => file.path);
  const forbidden = files.filter((file) => forbiddenPatterns.some((pattern) => pattern.test(file)));
  forbidden.length ? fail(`forbidden files in package: ${forbidden.join(", ")}`) : ok("package excludes local env/artifact/debug state");
}

function verifyRepoForbiddenFiles() {
  const forbidden = shell("find . -maxdepth 3 \\( -name '.env' -o -name '.env.*' -o -name '*.tgz' \\) -print 2>/dev/null");
  forbidden ? fail(`forbidden local secret/package artifact(s): ${forbidden}`) : ok("no .env/.env.* or package tarballs at repo root depth");
  for (const dir of [".artifacts", ".crabbox", ".debug", ".platform-smoke-runs"]) {
    const ignored = shell(`git check-ignore -q ${dir}/probe && echo ignored`);
    ignored ? ok(`${dir}/ is gitignored`) : fail(`${dir}/ must be gitignored`);
  }
  const trackedForbidden = shell("git ls-files '.env*' '*.tgz' '.artifacts/*' '.crabbox/*' '.debug/*' '.platform-smoke-runs/*'");
  trackedForbidden ? fail(`forbidden tracked local state: ${trackedForbidden}`) : ok("no forbidden local state is tracked");
  verifyPackageExclusions();
}

export async function runDoctor(config) {
  failures = 0;
  console.log("\n── Environment ──");
  const cbox = env("PI_ORACLE_SMOKE_CRABBOX") || env("PLATFORM_SMOKE_CRABBOX") || "crabbox";
  ok(`Crabbox binary = ${resolveCommand(cbox) ?? cbox}${env("PI_ORACLE_SMOKE_CRABBOX") || env("PLATFORM_SMOKE_CRABBOX") ? " (env override)" : " (PATH)"}`);
  ok(`PI_ORACLE_SMOKE_MAC_HOST = ${env("PI_ORACLE_SMOKE_MAC_HOST") || env("PLATFORM_SMOKE_MAC_HOST") || "localhost"}`);
  ok(`PI_ORACLE_SMOKE_MAC_USER = ${env("PI_ORACLE_SMOKE_MAC_USER") || env("PLATFORM_SMOKE_MAC_USER") || env("USER")}`);
  ok(`PI_ORACLE_SMOKE_UBUNTU_IMAGE = ${env("PI_ORACLE_SMOKE_UBUNTU_IMAGE") || env("PLATFORM_SMOKE_UBUNTU_IMAGE") || config.ubuntuContainerImage || "pi-oracle-platform-smoke:node24"}`);
  ok(`PI_ORACLE_SMOKE_WINDOWS_VM = ${windowsVmName(config)}`);
  ok(`PI_ORACLE_SMOKE_WINDOWS_SNAPSHOT = ${windowsSnapshotName(config)}`);

  console.log("\n── Crabbox ──");
  const resolvedCbox = resolveCommand(cbox);
  try { accessSync(resolvedCbox ?? cbox, constants.X_OK); ok(`binary executable: ${resolvedCbox ?? cbox}`); }
  catch { fail(`${resolvedCbox ?? cbox} is not executable`); }
  const version = silent(cbox, ["--version"]);
  const versionLine = version?.split("\n")[0] ?? "";
  version ? ok(`version: ${versionLine}`) : fail("could not read Crabbox version");
  const requiredVersion = config.requiredCrabbox?.minVersion ?? config.requiredCrabbox?.version;
  if (requiredVersion && versionLine) {
    compareVersions(versionLine, requiredVersion) >= 0 ? ok(`required version: ${requiredVersion}+`) : fail(`Crabbox version mismatch: need ${requiredVersion}+, got ${versionLine}`);
  }
  const providers = silent(cbox, ["providers"], { timeout: 30_000 }) ?? "";
  for (const provider of ["ssh", "local-container", "parallels"]) {
    new RegExp(`^${provider}$`, "m").test(providers) ? ok(`provider available: ${provider}`) : fail(`crabbox providers missing ${provider}`);
  }
  runCrabboxDoctor(cbox, "macOS static SSH", targetBaseArgs("macos", config), 120_000);
  runCrabboxDoctor(cbox, "Windows native Parallels", targetBaseArgs("windows-native", config), 180_000);
  runCrabboxDoctor(cbox, "local-container", targetBaseArgs("ubuntu", config), 120_000);

  console.log("\n── Host tools ──");
  for (const [name, command] of [["Docker", "docker info --format '{{.ServerVersion}}'"], ["Node", "node --version"], ["npm", "npm --version"], ["git", "git --version"], ["tar", "tar --version"], ["rsync", "rsync --version"]]) {
    const output = shell(command);
    output ? ok(`${name}: ${output.split("\n")[0]}`) : fail(`${name} not found or unavailable`);
  }
  const nodeVersion = shell("node --version");
  if (nodeVersion) {
    const major = Number(nodeVersion.replace(/^v/, "").split(".")[0]);
    if (major < (config.nodeValidationMajor ?? 24)) fail(`Node ${nodeVersion}; need ${config.nodeValidationMajor ?? 24}+ for smoke validation`);
  }
  verifyWindowsTemplate(config);

  console.log("\n── Auth environment ──");
  const requiredAuth = requiredRealSmokeAuthEnv(config);
  if (requiredAuth.length === 0) ok("no real-smoke auth env required by configured suites");
  for (const name of requiredAuth) {
    env(name) ? ok(`${name} = (present, redacted)`) : fail(`${name} missing for required real-extension suite`);
  }

  console.log("\n── Target tools ──");
  for (const target of config.requiredTargets ?? []) runTargetToolProbe(cbox, target, config);

  console.log("\n── Artifact root ──");
  const artifactRoot = resolve(process.cwd(), config.artifactRoot ?? ".artifacts/platform-smoke");
  try {
    mkdirSync(artifactRoot, { recursive: true });
    const probe = resolve(artifactRoot, ".doctor-write-test");
    writeFileSync(probe, "ok");
    unlinkSync(probe);
    ok(`writable: ${artifactRoot}`);
  } catch (error) {
    fail(`cannot write artifact root: ${error instanceof Error ? error.message : String(error)}`);
  }

  console.log("\n── Git/package hygiene ──");
  const branch = shell("git branch --show-current");
  branch ? ok(`branch: ${branch}`) : warn("could not determine branch");
  const status = shell("git status --short");
  status ? warn(`${status.split(/\r?\n/).filter(Boolean).length} uncommitted change(s) under test`) : ok("clean worktree");
  verifyRepoForbiddenFiles();

  console.log(`\n=== Results: ${failures} failure(s) ===`);
  if (failures > 0) {
    process.exitCode = 1;
    console.log("Fix the failures above before running npm run smoke:platform:all.");
  } else {
    console.log("Ready for npm run smoke:platform:all.");
  }
}
