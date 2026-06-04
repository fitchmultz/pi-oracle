#!/usr/bin/env node
// Purpose: Run real isolated pi-agent smoke tests against pi-oracle.
// Default mode is packed-install release proof. Source mode is inner-loop/debug only.

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const tsxCli = require.resolve("tsx/cli");

const DEFAULT_PROVIDER = "zai";
const DEFAULT_MODEL = "glm-5.1";
const DEFAULT_TIMEOUT_MS = 180_000;
const PACKAGE_NAME = "pi-oracle";

function usage() {
  console.log(`Usage: node scripts/oracle-real-smoke.mjs <doctor|run> [--mode packed|source]

Modes:
  packed  Release proof. npm pack -> clean pi project -> npm install tarball -> pi install -l -> run through installed package. Default.
  source  Inner-loop/debug only. Loads this checkout with pi --no-extensions -e extensions/oracle/index.ts.

Environment:
  PI_ORACLE_REAL_TEST_PROVIDER   pi provider for the test agent (default: ${DEFAULT_PROVIDER})
  PI_ORACLE_REAL_TEST_MODEL      pi model for the test agent (default: ${DEFAULT_MODEL})
  PI_ORACLE_REAL_TEST_TIMEOUT_MS per-agent timeout in ms (default: ${DEFAULT_TIMEOUT_MS})
  PI_ORACLE_REAL_TEST_ARTIFACT_ROOT artifact root (default: .artifacts/real-smoke)
  PI_ORACLE_REAL_TEST_KEEP_TMP   keep temporary fixture directory when set to 1/true/yes
  PI_ORACLE_REAL_TEST_MODEL_AGENT run oracle_submit through a model-agent turn instead of direct installed-tool execution (off by default)
  PI_ORACLE_REAL_TEST_NEGATIVE_SYMLINK run optional second-agent symlink rejection check (off by default; covered by sanity:oracle)
`);
}

function parseArgs(argv) {
  const args = { command: argv[2] ?? "run", mode: "packed" };
  for (let i = 3; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--mode" && argv[i + 1]) {
      args.mode = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg === "--help" || arg === "-h") args.command = "help";
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!["packed", "source"].includes(args.mode)) throw new Error(`unknown mode: ${args.mode}`);
  return args;
}

function env(name) {
  const value = process.env[name];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function truthy(value) {
  return ["1", "true", "yes", "on"].includes(String(value ?? "").toLowerCase());
}

function commandExists(command, args = ["--version"]) {
  return new Promise((resolvePromise) => {
    const child = spawn(command, args, { stdio: "ignore", shell: process.platform === "win32" });
    child.on("error", () => resolvePromise(false));
    child.on("exit", (code) => resolvePromise(code === 0 || code === 1));
  });
}

function apiKeyNameForProvider(provider) {
  return {
    zai: "ZAI_API_KEY",
    openai: "OPENAI_API_KEY",
    anthropic: "ANTHROPIC_API_KEY",
    google: "GEMINI_API_KEY",
    xai: "XAI_API_KEY",
    groq: "GROQ_API_KEY",
    deepseek: "DEEPSEEK_API_KEY",
    cerebras: "CEREBRAS_API_KEY",
    fireworks: "FIREWORKS_API_KEY",
    together: "TOGETHER_API_KEY",
    openrouter: "OPENROUTER_API_KEY",
    ai_gateway: "AI_GATEWAY_API_KEY",
    mistral: "MISTRAL_API_KEY",
    minimax: "MINIMAX_API_KEY",
    "minimax-cn": "MINIMAX_CN_API_KEY",
    "ant-ling": "ANT_LING_API_KEY",
    nvidia: "NVIDIA_API_KEY",
    moonshot: "MOONSHOT_API_KEY",
    opencode: "OPENCODE_API_KEY",
    kimi: "KIMI_API_KEY",
    cloudflare: "CLOUDFLARE_API_KEY",
    xiaomi: "XIAOMI_API_KEY",
  }[provider];
}

async function doctor() {
  const provider = env("PI_ORACLE_REAL_TEST_PROVIDER") ?? DEFAULT_PROVIDER;
  const model = env("PI_ORACLE_REAL_TEST_MODEL") ?? DEFAULT_MODEL;
  const failures = [];
  const warnings = [];
  const requiredCommands = [
    [process.platform === "win32" ? "pi.cmd" : "pi", ["--version"], "pi CLI"],
    [process.platform === "win32" ? "tar.exe" : "tar", ["--version"], "tar"],
    ["zstd", ["--version"], "zstd"],
    [process.platform === "win32" ? "agent-browser.cmd" : "agent-browser", ["--version"], "agent-browser"],
  ];
  for (const [command, args, label] of requiredCommands) {
    if (!(await commandExists(command, args))) failures.push(`${label} is not available on PATH`);
  }
  const keyName = apiKeyNameForProvider(provider);
  if (truthy(env("PI_ORACLE_REAL_TEST_MODEL_AGENT"))) {
    if (keyName && !env(keyName)) failures.push(`${keyName} is not set for provider ${provider}`);
    if (!keyName) warnings.push(`No known API-key env mapping for provider ${provider}; pi may still work if that provider is configured another way.`);
  }

  console.log("Oracle real smoke doctor");
  console.log(`  provider: ${provider}`);
  console.log(`  model: ${model}`);
  console.log(`  artifact root: ${resolve(env("PI_ORACLE_REAL_TEST_ARTIFACT_ROOT") ?? ".artifacts/real-smoke")}`);
  for (const warning of warnings) console.log(`  ⚠ ${warning}`);
  if (failures.length) {
    for (const failure of failures) console.error(`  ✗ ${failure}`);
    process.exitCode = 1;
    return;
  }
  console.log("  ✓ ready");
}

function runCommand(command, args, options) {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return new Promise((resolvePromise) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      shell: process.platform === "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let stoppedAfterCondition = false;
    const stopChild = () => {
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 2_000).unref();
    };
    const timer = setTimeout(() => {
      timedOut = true;
      stopChild();
    }, timeoutMs);
    const conditionTimer = options.until
      ? setInterval(async () => {
        try {
          if (await options.until()) {
            stoppedAfterCondition = true;
            stopChild();
          }
        } catch {
          // Keep the command running; the caller validates artifacts after exit.
        }
      }, 500)
      : undefined;
    conditionTimer?.unref?.();
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => {
      clearTimeout(timer);
      if (conditionTimer) clearInterval(conditionTimer);
      resolvePromise({ code: 1, signal: undefined, timedOut, stoppedAfterCondition, stdout, stderr: `${stderr}${error.stack ?? error.message}\n` });
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (conditionTimer) clearInterval(conditionTimer);
      resolvePromise({ code, signal, timedOut, stoppedAfterCondition, stdout, stderr });
    });
  });
}

function writeRunResult(dir, name, result) {
  writeFileSync(join(dir, `${name}.stdout.txt`), result.stdout);
  writeFileSync(join(dir, `${name}.stderr.txt`), result.stderr);
  writeFileSync(join(dir, `${name}.exit.json`), `${JSON.stringify({ code: result.code, signal: result.signal, timedOut: result.timedOut, stoppedAfterCondition: result.stoppedAfterCondition }, null, 2)}\n`);
}

async function mustRun(dir, name, command, args, options) {
  const result = await runCommand(command, args, options);
  writeRunResult(dir, name, result);
  if (result.timedOut) throw new Error(`${name} timed out after ${options.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms`);
  if (result.code !== 0) throw new Error(`${name} exited ${result.code}; see ${join(dir, `${name}.stderr.txt`)}`);
  return result;
}

function latestJobDir(jobsDir) {
  if (!existsSync(jobsDir)) return undefined;
  let names = [];
  try { names = readdirSync(jobsDir); } catch { return undefined; }
  const candidates = names.filter((name) => name.startsWith("oracle-")).map((name) => join(jobsDir, name));
  candidates.sort();
  return candidates.at(-1);
}

function parseJobArchivePath(jobDir) {
  if (!jobDir) return undefined;
  const jobJsonPath = join(jobDir, "job.json");
  if (!existsSync(jobJsonPath)) return undefined;
  try {
    const job = JSON.parse(readFileSync(jobJsonPath, "utf8"));
    return typeof job.archivePath === "string" ? job.archivePath : undefined;
  } catch {
    return undefined;
  }
}

async function tarList(archivePath) {
  const result = await runCommand(process.platform === "win32" ? "tar.exe" : "tar", ["--zstd", "-tf", process.platform === "win32" ? basename(archivePath) : archivePath], {
    cwd: process.platform === "win32" ? dirname(archivePath) : process.cwd(),
    env: process.env,
    timeoutMs: 60_000,
  });
  if (result.code !== 0) throw new Error(`tar failed for ${archivePath}: ${result.stderr || result.stdout}`);
  return result.stdout.split(/\r?\n/).filter(Boolean);
}

function entryExists(entries, path) {
  return entries.some((entry) => entry === path || entry.startsWith(`${path}/`));
}

function piCommand() {
  return process.platform === "win32" ? "pi.cmd" : "pi";
}

function npmCommand() {
  return process.platform === "win32" ? "npm.cmd" : "npm";
}

async function preparePackedProject({ runDir, provider, model, timeoutMs }) {
  const installDir = join(runDir, "packed-install");
  const packDir = join(installDir, "pack");
  const piProject = join(installDir, "pi-project");
  mkdirSync(packDir, { recursive: true });
  mkdirSync(piProject, { recursive: true });
  const npm = npmCommand();

  const pack = await mustRun(installDir, "npm-pack", npm, ["pack", "--silent", "--pack-destination", packDir], {
    cwd: process.cwd(),
    env: process.env,
    timeoutMs: 120_000,
  });
  const tarballName = pack.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).at(-1);
  const tarballPath = tarballName ? join(packDir, tarballName) : undefined;
  if (!tarballPath || !existsSync(tarballPath)) throw new Error(`npm pack did not produce a tarball in ${packDir}`);
  writeFileSync(join(installDir, "packed-tarball.txt"), `${tarballPath}\n`);

  await mustRun(installDir, "npm-init", npm, ["init", "-y"], { cwd: piProject, env: process.env, timeoutMs: 60_000 });
  await mustRun(installDir, "packed-node-install", npm, ["install", "--no-save", tarballPath], { cwd: piProject, env: process.env, timeoutMs: 120_000 });
  await mustRun(installDir, "pi-install", piCommand(), ["install", "-l", `./node_modules/${PACKAGE_NAME}`], {
    cwd: piProject,
    env: { ...process.env, PI_OFFLINE: "1" },
    timeoutMs: 120_000,
  });
  const piList = await mustRun(installDir, "pi-list", piCommand(), ["list"], {
    cwd: piProject,
    env: { ...process.env, PI_OFFLINE: "1" },
    timeoutMs: 60_000,
  });
  if (!piList.stdout.includes(PACKAGE_NAME) || !new RegExp(`node_modules[\\\\/]${PACKAGE_NAME}`).test(piList.stdout)) {
    throw new Error(`pi list did not show packed ${PACKAGE_NAME} install`);
  }

  writeFileSync(join(piProject, "README.md"), `# ${PACKAGE_NAME} packed real smoke fixture\n`);
  mkdirSync(join(piProject, ".artifacts", "ignored"), { recursive: true });
  writeFileSync(join(piProject, ".artifacts", "ignored", "artifact.txt"), "ignore me\n");
  mkdirSync(join(piProject, ".crabbox", "ignored"), { recursive: true });
  writeFileSync(join(piProject, ".crabbox", "ignored", "capture.txt"), "ignore me\n");

  return { mode: "packed", cwd: piProject, installDir, provider, model, extensionPath: `./node_modules/${PACKAGE_NAME}` };
}

function prepareSourceProject({ provider, model }) {
  const extensionPath = resolve("extensions/oracle/index.ts");
  return { mode: "source", cwd: process.cwd(), installDir: undefined, provider, model, extensionPath };
}

function hasCreatedJobArchive(jobsDir) {
  const jobDir = latestJobDir(jobsDir);
  const archivePath = parseJobArchivePath(jobDir);
  return Boolean(jobDir && archivePath && existsSync(archivePath));
}

async function runDirectOracleSubmit({ prepared, agentDir, sessionDir, jobsDir, outDir, timeoutMs }) {
  mkdirSync(outDir, { recursive: true });
  const sessionFile = join(sessionDir, "real-smoke-session.jsonl");
  const fakeWorkerPath = join(outDir, "fake-worker.mjs");
  const scriptPath = join(outDir, "direct-submit.mjs");
  const packageRoot = prepared.mode === "packed" ? join(prepared.cwd, "node_modules", PACKAGE_NAME) : process.cwd();
  const toolsUrl = pathToFileURL(join(packageRoot, "extensions", "oracle", "lib", "tools.ts")).href;
  mkdirSync(sessionDir, { recursive: true });
  writeFileSync(sessionFile, "");
  writeFileSync(fakeWorkerPath, "process.exit(0);\n");
  writeFileSync(scriptPath, `
import { registerOracleTools } from ${JSON.stringify(toolsUrl)};
const tools = new Map();
const pi = {
  on() { return undefined; },
  registerTool(tool) { tools.set(tool.name, tool); },
};
registerOracleTools(pi, ${JSON.stringify(fakeWorkerPath)});
const submit = tools.get("oracle_submit");
if (!submit) throw new Error("oracle_submit was not registered by the installed package");
const ctx = {
  cwd: process.cwd(),
  sessionManager: { getSessionFile() { return ${JSON.stringify(sessionFile)}; } },
};
const result = await submit.execute("real-smoke", {
  prompt: "Real smoke archive test. Reply OK if this reaches the provider.",
  files: ["."],
  preset: "instant",
}, new AbortController().signal, () => undefined, ctx);
console.log(JSON.stringify(result, null, 2));
`);
  writeFileSync(join(outDir, "command.json"), `${JSON.stringify({ command: process.execPath, args: [tsxCli, scriptPath], cwd: prepared.cwd, mode: prepared.mode, extensionPath: prepared.extensionPath }, null, 2)}\n`);
  const result = await runCommand(process.execPath, [tsxCli, scriptPath], {
    cwd: prepared.cwd,
    env: {
      ...process.env,
      PI_CODING_AGENT_DIR: agentDir,
      PI_ORACLE_JOBS_DIR: jobsDir,
      PI_TELEMETRY: process.env.PI_TELEMETRY ?? "0",
    },
    timeoutMs,
  });
  writeRunResult(outDir, "direct-submit", result);
  if (result.timedOut) throw new Error(`direct oracle_submit timed out after ${timeoutMs}ms`);
  if (result.code !== 0) throw new Error(`direct oracle_submit exited ${result.code}; see ${join(outDir, "direct-submit.stderr.txt")}`);
  return result;
}

async function runPiAgent({ prepared, agentDir, sessionDir, jobsDir, prompt, outDir, label, timeoutMs, stopAfterJobArchive = false }) {
  mkdirSync(outDir, { recursive: true });
  const args = [
    "--print",
    "--provider", prepared.provider,
    "--model", prepared.model,
    "--session-dir", sessionDir,
    "--tools", "oracle_submit",
  ];
  if (prepared.mode === "source") args.push("--no-extensions", "-e", prepared.extensionPath);
  args.push(prompt);

  writeFileSync(join(outDir, "command.json"), `${JSON.stringify({ command: piCommand(), args, cwd: prepared.cwd, mode: prepared.mode, extensionPath: prepared.extensionPath, provider: prepared.provider, model: prepared.model }, null, 2)}\n`);
  const result = await runCommand(piCommand(), args, {
    cwd: prepared.cwd,
    env: {
      ...process.env,
      PI_CODING_AGENT_DIR: agentDir,
      PI_ORACLE_JOBS_DIR: jobsDir,
      PI_TELEMETRY: process.env.PI_TELEMETRY ?? "0",
    },
    timeoutMs,
    until: stopAfterJobArchive ? () => hasCreatedJobArchive(jobsDir) : undefined,
  });
  writeRunResult(outDir, "pi-agent", result);
  if (result.timedOut) throw new Error(`${label} pi agent timed out after ${timeoutMs}ms`);
  if (!result.stoppedAfterCondition && result.code !== 0) throw new Error(`${label} pi agent exited ${result.code}; see ${join(outDir, "pi-agent.stderr.txt")}`);
  return result;
}

async function run(mode = "packed") {
  const provider = env("PI_ORACLE_REAL_TEST_PROVIDER") ?? DEFAULT_PROVIDER;
  const model = env("PI_ORACLE_REAL_TEST_MODEL") ?? DEFAULT_MODEL;
  const timeoutMs = Number(env("PI_ORACLE_REAL_TEST_TIMEOUT_MS") ?? DEFAULT_TIMEOUT_MS);
  const artifactRoot = resolve(env("PI_ORACLE_REAL_TEST_ARTIFACT_ROOT") ?? ".artifacts/real-smoke");
  const runId = `run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const runDir = join(artifactRoot, runId);
  const tmpRoot = mkdtempSync(join(tmpdir(), "pi-oracle-real-smoke-"));
  const assertions = [];

  mkdirSync(runDir, { recursive: true });
  const prepared = mode === "packed"
    ? await preparePackedProject({ runDir, provider, model, timeoutMs })
    : prepareSourceProject({ provider, model });
  console.log(`Oracle real smoke mode=${prepared.mode} extension=${prepared.extensionPath}`);
  writeFileSync(join(runDir, "run.json"), `${JSON.stringify({ runId, mode: prepared.mode, provider, model, extensionPath: prepared.extensionPath, timeoutMs, startedAt: new Date().toISOString() }, null, 2)}\n`);

  function assert(id, condition, message) {
    assertions.push({ id, ok: Boolean(condition), ...(condition ? {} : { error: message }) });
    if (!condition) throw new Error(message);
  }

  try {
    const test1 = join(runDir, "whole-repo-submit");
    const agent1 = join(runDir, "agent1");
    const sessions1 = join(runDir, "sessions1");
    const jobs1 = join(runDir, "jobs1");
    mkdirSync(join(agent1, "extensions", "oracle-auth-seed-profile"), { recursive: true });
    mkdirSync(sessions1, { recursive: true });
    mkdirSync(jobs1, { recursive: true });

    const submitResult = truthy(env("PI_ORACLE_REAL_TEST_MODEL_AGENT"))
      ? await runPiAgent({
        prepared,
        agentDir: agent1,
        sessionDir: sessions1,
        jobsDir: jobs1,
        outDir: test1,
        label: "whole-repo-submit",
        timeoutMs,
        stopAfterJobArchive: true,
        prompt: 'Call oracle_submit directly with prompt "Real smoke archive test. Reply OK if this reaches the provider." files ["."] and preset "instant". Do not use bash, read, edit, write, or any tool except oracle_submit.',
      })
      : await runDirectOracleSubmit({
        prepared,
        agentDir: agent1,
        sessionDir: sessions1,
        jobsDir: jobs1,
        outDir: test1,
        timeoutMs,
      });

    const jobDir1 = latestJobDir(jobs1);
    const archivePath = parseJobArchivePath(jobDir1);
    writeFileSync(join(test1, "job-dir.txt"), `${jobDir1 ?? ""}\n`);
    writeFileSync(join(test1, "archive-path.txt"), `${archivePath ?? ""}\n`);
    assert("whole-repo-job-created", Boolean(jobDir1), `whole-repo submit did not create an oracle job; stdout=${submitResult.stdout.slice(-1000)} stderr=${submitResult.stderr.slice(-1000)}`);
    assert("whole-repo-archive-created", Boolean(archivePath && existsSync(archivePath)), `whole-repo submit did not create a readable archive; jobDir=${jobDir1 ?? "<none>"} stdout=${submitResult.stdout.slice(-1000)} stderr=${submitResult.stderr.slice(-1000)}`);
    const entries = await tarList(archivePath);
    writeFileSync(join(test1, "archive-list.txt"), `${entries.join("\n")}\n`);
    assert("archive-includes-readme", entryExists(entries, "README.md"), "archive should include README.md");
    for (const excluded of [".pi", ".oracle-context", ".scratchpad.md", ".artifacts", ".crabbox", ".debug"]) {
      assert(`archive-excludes-${excluded.replace(/[^a-z0-9]+/gi, "-")}`, !entryExists(entries, excluded), `archive should exclude ${excluded}`);
    }
    if (prepared.mode === "packed") {
      assert("packed-mode-no-source-extension", !readFileSync(join(test1, "command.json"), "utf8").includes("extensions/oracle/index.ts"), "packed real smoke must not use source extension path");
    }

    if (truthy(env("PI_ORACLE_REAL_TEST_NEGATIVE_SYMLINK"))) {
      const test2 = join(runDir, "symlink-escape");
      const agent2 = join(runDir, "agent2");
      const sessions2 = join(runDir, "sessions2");
      const jobs2 = join(runDir, "jobs2");
      const outside = join(tmpRoot, "outside");
      mkdirSync(join(agent2, "extensions", "oracle-auth-seed-profile"), { recursive: true });
      mkdirSync(sessions2, { recursive: true });
      mkdirSync(jobs2, { recursive: true });
      mkdirSync(outside, { recursive: true });
      writeFileSync(join(outside, "secret.txt"), "secret\n");
      const linkPath = join(prepared.mode === "packed" ? prepared.cwd : tmpRoot, "linked-outside");
      try { symlinkSync(outside, linkPath, process.platform === "win32" ? "junction" : "dir"); }
      catch (error) { throw new Error(`could not create symlink fixture: ${error.message}`); }
      const symlinkPrepared = prepared.mode === "source" ? { ...prepared, cwd: tmpRoot } : prepared;

      const symlinkResult = await runPiAgent({
        prepared: symlinkPrepared,
        agentDir: agent2,
        sessionDir: sessions2,
        jobsDir: jobs2,
        outDir: test2,
        label: "symlink-escape",
        timeoutMs,
        prompt: 'Call oracle_submit directly with prompt "Real smoke symlink escape rejection test." files ["linked-outside/secret.txt"] and preset "instant". Do not use bash, read, edit, write, or any tool except oracle_submit. The expected result is rejection because the file resolves outside the project. After the tool returns or errors, answer with one concise sentence starting with REAL_SMOKE_SYMLINK_DONE.',
      });

      const jobDir2 = latestJobDir(jobs2);
      writeFileSync(join(test2, "job-dir.txt"), `${jobDir2 ?? ""}\n`);
      const symlinkOutput = `${symlinkResult.stdout}\n${symlinkResult.stderr}`;
      assert("symlink-rejected", /resolve inside|symlink|outside|escape|must be inside/i.test(symlinkOutput), "symlink escape test output did not show the expected rejection");
      assert("symlink-no-job-created", !jobDir2, "symlink escape rejection should not create an oracle job");
    }

    writeFileSync(join(runDir, "assertions.json"), `${JSON.stringify({ ok: true, assertions, completedAt: new Date().toISOString() }, null, 2)}\n`);
    console.log(`Oracle real smoke passed: ${runDir}`);
  } catch (error) {
    assertions.push({ id: "run-error", ok: false, error: error.message });
    writeFileSync(join(runDir, "assertions.json"), `${JSON.stringify({ ok: false, assertions, completedAt: new Date().toISOString() }, null, 2)}\n`);
    writeFileSync(join(runDir, "failures.md"), `# Oracle real smoke failed\n\n${error.stack ?? error.message}\n`);
    console.error(`Oracle real smoke failed: ${error.message}`);
    console.error(`Artifacts: ${runDir}`);
    process.exitCode = 1;
  } finally {
    if (!truthy(env("PI_ORACLE_REAL_TEST_KEEP_TMP"))) rmSync(tmpRoot, { recursive: true, force: true });
  }
}

try {
  const args = parseArgs(process.argv);
  if (["-h", "--help", "help"].includes(args.command)) usage();
  else if (args.command === "doctor") await doctor();
  else if (args.command === "run") await run(args.mode);
  else {
    usage();
    process.exitCode = 1;
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
