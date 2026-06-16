#!/usr/bin/env node
// Purpose: Release-blocking proof gate for live ChatGPT preset selection.
// Responsibilities: Validate that a fresh manual/live oracle job matrix covered every canonical ChatGPT preset before publish.
// Scope: Maintainer release safety only; the script does not submit jobs or touch provider accounts.
// Usage: npm run release:proof:chatgpt-presets, or `node scripts/oracle-chatgpt-preset-proof.mjs template`.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, "..");
const DEFAULT_PROOF_PATH = ".artifacts/chatgpt-preset-proof/latest.json";
const PROOF_PATH_ENV = "PI_ORACLE_CHATGPT_PRESET_PROOF";
const JOBS_DIR_ENV = "PI_ORACLE_JOBS_DIR";
const MAX_AGE_HOURS_ENV = "PI_ORACLE_CHATGPT_PRESET_PROOF_MAX_AGE_HOURS";
const DEFAULT_MAX_AGE_HOURS = 72;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ZERO_UUID = "00000000-0000-0000-0000-000000000000";

function usage() {
  console.log(`Usage: node scripts/oracle-chatgpt-preset-proof.mjs <check|template>

Commands:
  check      Validate release-blocking live ChatGPT preset proof. Default.
  template   Print a non-valid proof-file template for the current package version/git head.

Environment:
  ${PROOF_PATH_ENV}                 Proof JSON path (default: ${DEFAULT_PROOF_PATH})
  ${JOBS_DIR_ENV}                            Oracle jobs root for job lookup (default also checks /tmp)
  ${MAX_AGE_HOURS_ENV}       Freshness window in hours (default: ${DEFAULT_MAX_AGE_HOURS})

Proof file contract:
  The proof must reference live oracle job state produced by the loaded extension
  after the current git HEAD. It must include one completed ChatGPT job per
  canonical ORACLE_SUBMIT_PRESETS id. Shape-only proof is rejected.
`);
}

function fail(message) {
  console.error(message);
  process.exitCode = 1;
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function git(args) {
  return execFileSync("git", args, { cwd: REPO_ROOT, encoding: "utf8" }).trim();
}

function packageMetadata() {
  const pkg = readJson(resolve(REPO_ROOT, "package.json"));
  return { name: pkg.name, version: pkg.version };
}

function currentGitHead() {
  return git(["rev-parse", "HEAD"]);
}

function currentGitHeadCommittedAt() {
  return git(["show", "-s", "--format=%cI", "HEAD"]);
}

function currentGitStatus() {
  return git(["status", "--short"]);
}

function canonicalPresets() {
  const configSource = readFileSync(resolve(REPO_ROOT, "extensions/oracle/lib/config.ts"), "utf8");
  const registryMatch = configSource.match(/export const ORACLE_SUBMIT_PRESETS = \{([\s\S]*?)\n\} as const;/);
  if (!registryMatch) throw new Error("Could not locate ORACLE_SUBMIT_PRESETS registry in extensions/oracle/lib/config.ts");
  const entries = [...registryMatch[1].matchAll(
    /^\s{2}([a-z0-9_]+):\s*\{\s*label:\s*"[^"]+",\s*modelFamily:\s*"([a-z]+)"\s+as const(?:,\s*effort:\s*"([a-z]+)"\s+as const)?,\s*autoSwitchToThinking:\s*(true|false)\s*\}/gm,
  )];
  if (entries.length === 0) throw new Error("Could not parse ORACLE_SUBMIT_PRESETS registry entries");
  return Object.fromEntries(entries.map((match) => [match[1], {
    modelFamily: match[2],
    effort: match[3],
    autoSwitchToThinking: match[4] === "true",
  }]));
}

function canonicalPresetIds() {
  return Object.keys(canonicalPresets());
}

function proofPath() {
  return resolve(REPO_ROOT, process.env[PROOF_PATH_ENV] || DEFAULT_PROOF_PATH);
}

function maxAgeHours() {
  const raw = process.env[MAX_AGE_HOURS_ENV];
  if (!raw) return DEFAULT_MAX_AGE_HOURS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`${MAX_AGE_HOURS_ENV} must be a positive number of hours`);
  return parsed;
}

function isIsoDate(value) {
  if (typeof value !== "string" || !value.trim()) return false;
  const millis = Date.parse(value);
  return Number.isFinite(millis) && new Date(millis).toISOString() === value;
}

function parseIsoMillis(value) {
  return isIsoDate(value) ? Date.parse(value) : undefined;
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function candidateJobJsonPaths(jobId, proofJob) {
  const paths = [];
  if (typeof proofJob.jobJsonPath === "string" && proofJob.jobJsonPath.trim()) {
    paths.push(resolve(REPO_ROOT, proofJob.jobJsonPath));
  }
  if (typeof proofJob.jobDir === "string" && proofJob.jobDir.trim()) {
    paths.push(resolve(REPO_ROOT, proofJob.jobDir, "job.json"));
  }
  if (process.env[JOBS_DIR_ENV]) {
    paths.push(resolve(process.env[JOBS_DIR_ENV], `oracle-${jobId}`, "job.json"));
  }
  paths.push(resolve("/tmp", `oracle-${jobId}`, "job.json"));
  return unique(paths);
}

function loadOracleJobState(jobId, proofJob) {
  const candidates = candidateJobJsonPaths(jobId, proofJob);
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    return { path: candidate, state: readJson(candidate) };
  }
  return { path: undefined, state: undefined, candidates };
}

function requireActualJobEvidence({ preset, canonicalPreset, proofJob, packageName, packageVersion, gitHead, gitHeadCommittedAtMs, proofValidatedAtMs, errors }) {
  if (!proofJob || typeof proofJob !== "object" || Array.isArray(proofJob)) {
    errors.push(`missing jobs.${preset}`);
    return;
  }
  if (proofJob.preset !== preset) errors.push(`jobs.${preset}.preset must be ${preset}`);
  if (proofJob.provider !== "chatgpt") errors.push(`jobs.${preset}.provider must be chatgpt`);

  const jobId = proofJob.jobId;
  if (typeof jobId !== "string" || !UUID_PATTERN.test(jobId) || jobId === ZERO_UUID) {
    errors.push(`jobs.${preset}.jobId must be a real oracle UUID job id, not a placeholder`);
    return;
  }

  const loaded = loadOracleJobState(jobId, proofJob);
  if (!loaded.state) {
    errors.push(`jobs.${preset} could not find actual oracle job.json for ${jobId}; checked ${loaded.candidates.join(", ")}`);
    return;
  }

  const state = loaded.state;
  const responsePath = typeof state.responsePath === "string" ? state.responsePath : undefined;
  const workerLogPath = typeof state.workerLogPath === "string" ? state.workerLogPath : undefined;
  const response = responsePath && existsSync(responsePath) ? readFileSync(responsePath, "utf8") : "";
  const workerLog = workerLogPath && existsSync(workerLogPath) ? readFileSync(workerLogPath, "utf8") : "";
  const completedAtMs = parseIsoMillis(state.completedAt || state.phaseAt);

  if (state.id !== jobId) errors.push(`jobs.${preset} job.json id mismatch: expected ${jobId}, got ${state.id || "<missing>"}`);
  if (state.status !== "complete") errors.push(`jobs.${preset} actual job status must be complete, got ${state.status || "<missing>"}`);
  if (state.phase !== "complete") errors.push(`jobs.${preset} actual job phase must be complete, got ${state.phase || "<missing>"}`);
  if (state.selection?.provider !== "chatgpt") errors.push(`jobs.${preset} actual provider must be chatgpt`);
  if (state.selection?.preset !== preset) errors.push(`jobs.${preset} actual preset must be ${preset}, got ${state.selection?.preset || "<missing>"}`);
  if (state.selection?.modelFamily !== canonicalPreset.modelFamily) errors.push(`jobs.${preset} actual modelFamily must be ${canonicalPreset.modelFamily}, got ${state.selection?.modelFamily || "<missing>"}`);
  if ((state.selection?.effort || undefined) !== canonicalPreset.effort) errors.push(`jobs.${preset} actual effort must be ${canonicalPreset.effort || "<unset>"}, got ${state.selection?.effort || "<unset>"}`);
  if (state.selection?.autoSwitchToThinking !== canonicalPreset.autoSwitchToThinking) errors.push(`jobs.${preset} actual autoSwitchToThinking must be ${canonicalPreset.autoSwitchToThinking}`);
  if (state.cwd !== REPO_ROOT) errors.push(`jobs.${preset} actual cwd must be this repo (${REPO_ROOT}), got ${state.cwd || "<missing>"}`);
  if (state.projectId !== REPO_ROOT) errors.push(`jobs.${preset} actual projectId must be this repo (${REPO_ROOT}), got ${state.projectId || "<missing>"}`);
  if (state.requestSource !== "tool" && state.requestSource !== "command") errors.push(`jobs.${preset} actual requestSource must be tool or command`);
  if (typeof state.sessionId !== "string" || !state.sessionId.trim()) errors.push(`jobs.${preset} actual job must record sessionId`);
  if (typeof state.originSessionFile !== "string" || !existsSync(state.originSessionFile)) errors.push(`jobs.${preset} actual originSessionFile must exist`);
  if (typeof state.promptPath !== "string" || !existsSync(state.promptPath)) errors.push(`jobs.${preset} actual promptPath must exist`);
  if (typeof state.logsDir !== "string" || !existsSync(state.logsDir)) errors.push(`jobs.${preset} actual logsDir must exist`);
  if (typeof state.runtimeId !== "string" || !state.runtimeId.trim()) errors.push(`jobs.${preset} actual job must record runtimeId`);
  if (typeof state.runtimeSessionName !== "string" || !state.runtimeSessionName.trim()) errors.push(`jobs.${preset} actual job must record runtimeSessionName`);
  if (!state.config?.browser || !state.config?.worker || !state.config?.cleanup) errors.push(`jobs.${preset} actual job must include persisted oracle config with browser, worker, and cleanup sections`);
  const lifecycleKinds = new Set(Array.isArray(state.lifecycleEvents) ? state.lifecycleEvents.map((event) => event?.kind) : []);
  const lifecyclePhases = new Set(Array.isArray(state.lifecycleEvents) ? state.lifecycleEvents.map((event) => event?.phase) : []);
  if (!lifecycleKinds.has("created")) errors.push(`jobs.${preset} lifecycle events must include job creation`);
  if (!lifecyclePhases.has("configuring_model")) errors.push(`jobs.${preset} lifecycle events must include configuring_model phase`);
  if (!lifecyclePhases.has("complete")) errors.push(`jobs.${preset} lifecycle events must include complete phase`);
  if (state.extensionProvenance?.schemaVersion !== 1) errors.push(`jobs.${preset} actual job must record extensionProvenance.schemaVersion=1`);
  if (state.extensionProvenance?.packageName !== packageName) errors.push(`jobs.${preset} actual extension packageName must be ${packageName}`);
  if (state.extensionProvenance?.packageVersion !== packageVersion) errors.push(`jobs.${preset} actual extension packageVersion must be ${packageVersion}`);
  if (state.extensionProvenance?.gitHead !== gitHead) errors.push(`jobs.${preset} actual extension gitHead must be ${gitHead}`);
  if (state.extensionProvenance?.sourcePath !== REPO_ROOT) errors.push(`jobs.${preset} actual extension sourcePath must be this repo (${REPO_ROOT}), got ${state.extensionProvenance?.sourcePath || "<missing>"}`);
  if (typeof state.archivePath !== "string" || !state.archivePath.endsWith(".tar.zst")) errors.push(`jobs.${preset} actual archivePath must end with .tar.zst`);
  if (typeof state.archiveSha256 !== "string" || !/^[0-9a-f]{64}$/i.test(state.archiveSha256)) errors.push(`jobs.${preset} actual job must record archiveSha256`);
  if (typeof state.conversationId !== "string" || !state.conversationId.trim()) errors.push(`jobs.${preset} actual job must record conversationId`);
  if (typeof state.chatUrl !== "string" || !state.chatUrl.startsWith("https://chatgpt.com/c/")) errors.push(`jobs.${preset} actual job must record a ChatGPT conversation URL`);
  if (!responsePath || !existsSync(responsePath)) errors.push(`jobs.${preset} actual responsePath must exist`);
  if (!workerLogPath || !existsSync(workerLogPath)) errors.push(`jobs.${preset} actual workerLogPath must exist`);
  if (!response.includes(`PRESET ${preset} OK`)) errors.push(`jobs.${preset} actual response must include PRESET ${preset} OK`);
  if (!response.includes(`PACKAGE ${packageName}`)) errors.push(`jobs.${preset} actual response must include PACKAGE ${packageName}`);
  if (!workerLog.includes(`Configuring model family=${state.selection?.modelFamily}`) && !workerLog.includes("Model already appears configured")) {
    errors.push(`jobs.${preset} worker log must show model configuration or an explicit already-configured skip`);
  }
  if (!workerLog.includes("Job completed successfully") && !workerLog.includes(`Job ${jobId} complete`)) errors.push(`jobs.${preset} worker log must show successful completion`);

  if (completedAtMs === undefined) {
    errors.push(`jobs.${preset} actual completedAt/phaseAt must be an ISO timestamp`);
  } else {
    if (completedAtMs <= gitHeadCommittedAtMs) errors.push(`jobs.${preset} must complete after current git HEAD commit time`);
    if (proofValidatedAtMs !== undefined && completedAtMs > proofValidatedAtMs) errors.push(`jobs.${preset} completed after proof validatedAt`);
    const maxAgeMs = maxAgeHours() * 60 * 60 * 1000;
    if (Date.now() - completedAtMs > maxAgeMs) errors.push(`jobs.${preset} completedAt is older than ${maxAgeHours()} hours`);
  }

  if (typeof proofJob.conversation === "string" && proofJob.conversation.trim() && proofJob.conversation !== state.conversationId && proofJob.conversation !== state.chatUrl) {
    errors.push(`jobs.${preset}.conversation does not match actual conversationId/chatUrl`);
  }
}

function validateProof(proof, path) {
  const errors = [];
  const { name, version } = packageMetadata();
  const gitHead = currentGitHead();
  const gitHeadCommittedAt = currentGitHeadCommittedAt();
  const gitHeadCommittedAtMs = Date.parse(gitHeadCommittedAt);
  const gitStatus = currentGitStatus();
  const presetRegistry = canonicalPresets();
  const requiredPresets = Object.keys(presetRegistry);
  const allowedPresets = new Set(requiredPresets);

  if (gitStatus) {
    errors.push(`working tree must be clean before release proof is accepted; current changes:\n${gitStatus}`);
  }

  if (!proof || typeof proof !== "object" || Array.isArray(proof)) {
    errors.push("proof root must be a JSON object");
    return errors;
  }

  if (proof.schemaVersion !== 1) errors.push("schemaVersion must be 1");
  if (proof.packageName !== name) errors.push(`packageName must be ${name}`);
  if (proof.packageVersion !== version) errors.push(`packageVersion must match package.json version ${version}`);
  if (proof.gitHead !== gitHead) errors.push(`gitHead must match current HEAD ${gitHead}`);
  if (proof.provider !== "chatgpt") errors.push('provider must be "chatgpt"');
  if (proof.extensionUnderTest !== "loaded-extension") errors.push('extensionUnderTest must be "loaded-extension"');

  let proofValidatedAtMs;
  if (!isIsoDate(proof.validatedAt)) {
    errors.push("validatedAt must be an ISO-8601 UTC timestamp from new Date().toISOString()");
  } else {
    proofValidatedAtMs = Date.parse(proof.validatedAt);
    const ageMs = Date.now() - proofValidatedAtMs;
    const maxAgeMs = maxAgeHours() * 60 * 60 * 1000;
    if (ageMs < 0) errors.push("validatedAt must not be in the future");
    if (ageMs > maxAgeMs) errors.push(`validatedAt is older than ${maxAgeHours()} hours`);
    if (proofValidatedAtMs <= gitHeadCommittedAtMs) errors.push("validatedAt must be after current git HEAD commit time");
  }

  const jobs = proof.jobs;
  if (!jobs || typeof jobs !== "object" || Array.isArray(jobs)) {
    errors.push("jobs must be an object keyed by canonical preset id");
    return errors;
  }

  for (const preset of requiredPresets) {
    requireActualJobEvidence({
      preset,
      canonicalPreset: presetRegistry[preset],
      proofJob: jobs[preset],
      packageName: name,
      packageVersion: version,
      gitHead,
      gitHeadCommittedAtMs,
      proofValidatedAtMs,
      errors,
    });
  }

  for (const preset of Object.keys(jobs)) {
    if (!allowedPresets.has(preset)) errors.push(`jobs.${preset} is not a canonical ORACLE_SUBMIT_PRESETS id`);
  }

  if (errors.length === 0) {
    console.log(`ChatGPT preset release proof accepted: ${path}`);
    console.log(`Validated presets: ${requiredPresets.join(", ")}`);
  }

  return errors;
}

function template() {
  const { name, version } = packageMetadata();
  const gitHead = currentGitHead();
  const jobs = Object.fromEntries(canonicalPresetIds().map((preset) => [preset, {
    preset,
    provider: "chatgpt",
    jobId: `replace-with-completed-${preset}-job-uuid`,
    jobDir: `/tmp/oracle-replace-with-completed-${preset}-job-uuid`,
    conversation: "replace-with-actual-conversation-id-or-chat-url",
  }]));

  console.log(JSON.stringify({
    schemaVersion: 1,
    packageName: name,
    packageVersion: version,
    gitHead,
    provider: "chatgpt",
    extensionUnderTest: "loaded-extension",
    validatedAt: new Date().toISOString(),
    jobs,
  }, null, 2));
}

function main() {
  const command = process.argv[2] || "check";
  if (command === "--help" || command === "-h") {
    usage();
    return;
  }
  if (command === "template") {
    template();
    return;
  }
  if (command !== "check") {
    usage();
    fail(`Unknown command: ${command}`);
    return;
  }

  const path = proofPath();
  if (!existsSync(path)) {
    fail(`Missing ChatGPT preset release proof: ${path}\n\nRun live loaded-extension oracle jobs for every canonical ChatGPT preset, then save proof JSON.\nCreate a non-valid starting template with:\n  mkdir -p .artifacts/chatgpt-preset-proof\n  node scripts/oracle-chatgpt-preset-proof.mjs template > ${DEFAULT_PROOF_PATH}\n\nThis gate is intentional: releases are blocked until every preset has fresh live proof backed by actual oracle job state.`);
    return;
  }

  let proof;
  try {
    proof = readJson(path);
  } catch (error) {
    fail(`Could not read proof JSON at ${path}: ${error.message}`);
    return;
  }

  const errors = validateProof(proof, path);
  if (errors.length > 0) {
    fail(`ChatGPT preset release proof rejected: ${path}\n- ${errors.join("\n- ")}`);
  }
}

main();
