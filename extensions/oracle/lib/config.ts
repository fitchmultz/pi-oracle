// Purpose: Define oracle configuration schema, defaults, preset selection, and local config loading behavior.
// Responsibilities: Normalize preset ids, load extension config from disk, expose default browser/auth/runtime settings, and validate config shape.
// Scope: Configuration and preset resolution only; runtime/job execution stays in sibling oracle modules.
// Usage: Imported by oracle tools, commands, runtime helpers, and sanity tests when config or preset resolution is required.
// Invariants/Assumptions: Preset ids remain the canonical model-selection contract and config loading must fail clearly on invalid user overrides.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { getAgentDir } from "@mariozechner/pi-coding-agent";
import { isAbsolute, join, normalize } from "node:path";
import { getProjectId } from "./runtime.js";

export const MODEL_FAMILIES = ["instant", "thinking", "pro"] as const;
export type OracleModelFamily = (typeof MODEL_FAMILIES)[number];

export const EFFORTS = ["light", "standard", "extended", "heavy"] as const;
export type OracleEffort = (typeof EFFORTS)[number];

/**
 * Canonical preset registry for `oracle_submit` preset selection.
 * This is the single authored source of truth — all derived lists come from `Object.keys(...)`.
 */
export const ORACLE_SUBMIT_PRESETS = {
  pro_standard: { label: "Pro - Standard", modelFamily: "pro" as const, effort: "standard" as const, autoSwitchToThinking: false },
  pro_extended: { label: "Pro - Extended", modelFamily: "pro" as const, effort: "extended" as const, autoSwitchToThinking: false },
  thinking_light: { label: "Thinking - Light", modelFamily: "thinking" as const, effort: "light" as const, autoSwitchToThinking: false },
  thinking_standard: { label: "Thinking - Standard", modelFamily: "thinking" as const, effort: "standard" as const, autoSwitchToThinking: false },
  thinking_extended: { label: "Thinking - Extended", modelFamily: "thinking" as const, effort: "extended" as const, autoSwitchToThinking: false },
  thinking_heavy: { label: "Thinking - Heavy", modelFamily: "thinking" as const, effort: "heavy" as const, autoSwitchToThinking: false },
  instant: { label: "Instant", modelFamily: "instant" as const, autoSwitchToThinking: false },
  instant_auto_switch: { label: "Instant - Auto-switch to Thinking Enabled", modelFamily: "instant" as const, autoSwitchToThinking: true },
} as const;

export type OracleSubmitPresetId = keyof typeof ORACLE_SUBMIT_PRESETS;

export type OracleSubmitPreset = typeof ORACLE_SUBMIT_PRESETS[OracleSubmitPresetId];

export const ORACLE_SUBMIT_PRESET_IDS = Object.freeze(Object.keys(ORACLE_SUBMIT_PRESETS) as OracleSubmitPresetId[]);

function normalizeOracleSubmitPresetLookupKey(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[_-]+/g, " ")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ");
}

function splitOracleSubmitPresetWords(value: string): string[] {
  return value
    .trim()
    .replace(/[_-]+/g, " ")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter(Boolean);
}

function lowercaseWords(words: readonly string[]): string[] {
  return words.map((word) => word.toLowerCase());
}

function titleCaseWords(words: readonly string[]): string[] {
  return words.map((word) => (word ? `${word[0]?.toUpperCase() ?? ""}${word.slice(1)}` : word));
}

function buildOracleSubmitPresetSeparatorVariants(words: readonly string[]): string[] {
  const normalizedWords = words.map((word) => word.trim()).filter(Boolean);
  if (normalizedWords.length === 0) return [];

  const variants = new Set<string>();
  const build = (index: number, current: string): void => {
    if (index >= normalizedWords.length) {
      variants.add(current);
      return;
    }
    for (const separator of [" ", "-"] as const) {
      build(index + 1, `${current}${separator}${normalizedWords[index]}`);
    }
  };

  build(1, normalizedWords[0]!);
  return [...variants];
}

function buildOracleSubmitPresetJoinVariants(words: readonly string[]): string[] {
  const normalizedWords = words.map((word) => word.trim()).filter(Boolean);
  if (normalizedWords.length === 0) return [];

  const lowercase = lowercaseWords(normalizedWords);
  const titleWords = titleCaseWords(lowercase);
  return [
    ...buildOracleSubmitPresetSeparatorVariants(normalizedWords),
    ...buildOracleSubmitPresetSeparatorVariants(lowercase),
    ...buildOracleSubmitPresetSeparatorVariants(titleWords),
  ];
}

function buildOracleSubmitPresetAliases(id: OracleSubmitPresetId, preset: OracleSubmitPreset): string[] {
  const idWords = splitOracleSubmitPresetWords(id);
  const labelWords = splitOracleSubmitPresetWords(preset.label);
  return [
    id,
    ...buildOracleSubmitPresetJoinVariants(idWords),
    preset.label,
    preset.label.toLowerCase(),
    ...buildOracleSubmitPresetJoinVariants(labelWords),
  ].filter(Boolean);
}

function buildOracleSubmitPresetLookupArtifacts(): {
  acceptedInputs: readonly string[];
  lookup: ReadonlyMap<string, OracleSubmitPresetId>;
} {
  const lookup = new Map<string, OracleSubmitPresetId>();
  const aliases = new Set<string>();

  for (const [id, preset] of Object.entries(ORACLE_SUBMIT_PRESETS) as [OracleSubmitPresetId, OracleSubmitPreset][]) {
    for (const alias of buildOracleSubmitPresetAliases(id, preset)) {
      const normalized = normalizeOracleSubmitPresetLookupKey(alias);
      if (!normalized) continue;
      const existing = lookup.get(normalized);
      if (existing && existing !== id) {
        throw new Error(`Conflicting oracle_submit preset alias: ${alias} matches both ${existing} and ${id}`);
      }
      lookup.set(normalized, id);
      if (alias !== id) aliases.add(alias);
    }
  }

  return {
    acceptedInputs: Object.freeze([...ORACLE_SUBMIT_PRESET_IDS, ...[...aliases].sort((left, right) => left.localeCompare(right))]),
    lookup,
  };
}

const ORACLE_SUBMIT_PRESET_LOOKUP_ARTIFACTS = buildOracleSubmitPresetLookupArtifacts();

export const ORACLE_SUBMIT_PRESET_ACCEPTED_INPUTS = ORACLE_SUBMIT_PRESET_LOOKUP_ARTIFACTS.acceptedInputs;

export function coerceOracleSubmitPresetId(value: string): OracleSubmitPresetId {
  const normalized = normalizeOracleSubmitPresetLookupKey(value);
  const presetId = ORACLE_SUBMIT_PRESET_LOOKUP_ARTIFACTS.lookup.get(normalized);
  if (presetId) return presetId;
  throw new Error(
    `Unknown oracle_submit preset: ${value}. Use one of the canonical ids (${ORACLE_SUBMIT_PRESET_IDS.join(", ")}) or a matching preset label.`,
  );
}

export function getOracleSubmitPresetById(id: OracleSubmitPresetId): OracleSubmitPreset {
  const found = ORACLE_SUBMIT_PRESETS[id];
  if (!found) {
    throw new Error(`Unknown oracle_submit preset: ${id}`);
  }
  return found;
}

/** Resolved execution snapshot generated from a preset at submit time. */
export type OracleResolvedSelection = {
  preset: OracleSubmitPresetId;
  modelFamily: OracleModelFamily;
  effort?: OracleEffort;
  autoSwitchToThinking: boolean;
};

/**
 * Resolve a preset id into the execution snapshot that gets persisted on the job.
 * @throws if the preset id is unknown.
 */
export function resolveOracleSubmitPreset(presetId: OracleSubmitPresetId): OracleResolvedSelection {
  const def = getOracleSubmitPresetById(presetId);
  return {
    preset: presetId,
    modelFamily: def.modelFamily,
    effort: def.modelFamily === "instant" ? undefined : def.effort,
    autoSwitchToThinking: def.modelFamily === "instant" ? def.autoSwitchToThinking : false,
  };
}

export const BROWSER_RUN_MODES = ["headless", "headed"] as const;
export type OracleBrowserRunMode = (typeof BROWSER_RUN_MODES)[number];

export const CLONE_STRATEGIES = ["apfs-clone", "copy"] as const;
export type OracleCloneStrategy = (typeof CLONE_STRATEGIES)[number];

const ALLOWED_CHATGPT_ORIGINS = new Set(["https://chatgpt.com", "https://chat.openai.com"]);
const PROJECT_OVERRIDE_KEYS = new Set(["defaults", "worker", "poller", "artifacts", "cleanup"]);
const DEFAULT_MAC_CHROME_EXECUTABLE = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const DEFAULT_MAC_CHROME_USER_DATA_DIR = join(homedir(), "Library", "Application Support", "Google", "Chrome");

export interface OracleConfig {
  defaults: {
    preset: OracleSubmitPresetId;
  };
  browser: {
    sessionPrefix: string;
    authSeedProfileDir: string;
    runtimeProfilesDir: string;
    maxConcurrentJobs: number;
    cloneStrategy: OracleCloneStrategy;
    chatUrl: string;
    authUrl: string;
    runMode: OracleBrowserRunMode;
    executablePath?: string;
    userAgent?: string;
    args: string[];
  };
  auth: {
    pollMs: number;
    bootstrapTimeoutMs: number;
    chromeProfile: string;
    chromeCookiePath?: string;
  };
  worker: {
    pollMs: number;
    completionTimeoutMs: number;
  };
  poller: {
    intervalMs: number;
  };
  artifacts: {
    capture: boolean;
  };
  cleanup: {
    completeJobRetentionMs: number;
    failedJobRetentionMs: number;
  };
}

function detectDefaultChromeExecutablePath(): string | undefined {
  return existsSync(DEFAULT_MAC_CHROME_EXECUTABLE) ? DEFAULT_MAC_CHROME_EXECUTABLE : undefined;
}

function detectDefaultChromeUserAgent(executablePath: string | undefined): string | undefined {
  if (!executablePath) return undefined;
  try {
    const versionOutput = execFileSync(executablePath, ["--version"], { encoding: "utf8" }).trim();
    const versionMatch = versionOutput.match(/(\d+\.\d+\.\d+\.\d+)/);
    if (!versionMatch) return undefined;
    return `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${versionMatch[1]} Safari/537.36`;
  } catch {
    return undefined;
  }
}

function detectDefaultChromeProfileName(): string {
  const localStatePath = join(DEFAULT_MAC_CHROME_USER_DATA_DIR, "Local State");
  if (!existsSync(localStatePath)) return "Default";
  try {
    const localState = JSON.parse(readFileSync(localStatePath, "utf8")) as { profile?: { last_used?: string } };
    const lastUsed = localState?.profile?.last_used;
    return typeof lastUsed === "string" && lastUsed.trim() ? lastUsed.trim() : "Default";
  } catch {
    return "Default";
  }
}

const detectedChromeExecutablePath = detectDefaultChromeExecutablePath();
const detectedChromeUserAgent = detectDefaultChromeUserAgent(detectedChromeExecutablePath);
const agentExtensionsDir = join(getAgentDir(), "extensions");
const detectedChromeProfileName = detectDefaultChromeProfileName();

export interface OracleConfigLoadDetails {
  agentDir: string;
  agentConfigPath: string;
  agentConfigExists: boolean;
  projectConfigPath: string;
  projectConfigExists: boolean;
  effectiveAuthConfigPath: string;
  effectiveAuthScope: "agent";
}

export function getOracleConfigLoadDetails(cwd: string): OracleConfigLoadDetails {
  const agentDir = getAgentDir();
  const projectRoot = getProjectId(cwd);
  const agentConfigPath = join(agentDir, "extensions", "oracle.json");
  const projectConfigPath = join(projectRoot, ".pi", "extensions", "oracle.json");
  return {
    agentDir,
    agentConfigPath,
    agentConfigExists: existsSync(agentConfigPath),
    projectConfigPath,
    projectConfigExists: existsSync(projectConfigPath),
    effectiveAuthConfigPath: agentConfigPath,
    effectiveAuthScope: "agent",
  };
}

export function formatOracleAuthConfigRemediation(details: OracleConfigLoadDetails): string {
  if (!details.projectConfigExists) {
    return `Set auth.chromeProfile / auth.chromeCookiePath in ${details.effectiveAuthConfigPath}.`;
  }
  return (
    `Set auth.chromeProfile / auth.chromeCookiePath in ${details.effectiveAuthConfigPath}. ` +
    `Project overrides are also read from ${details.projectConfigPath}, but auth.* is loaded from ${details.effectiveAuthConfigPath}.`
  );
}

export function formatOracleAuthConfigSummary(details: OracleConfigLoadDetails): string {
  const lines = [
    `Effective oracle auth config: ${details.effectiveAuthConfigPath} (agent dir: ${details.agentDir}${details.agentConfigExists ? "" : "; create this file to override auth.*"})`,
  ];
  if (details.projectConfigExists) {
    lines.push(
      `Project oracle config also loaded: ${details.projectConfigPath} ` +
        `(project scope can override ${[...PROJECT_OVERRIDE_KEYS].join("/")} only; auth.* still comes from ${details.effectiveAuthConfigPath}).`,
    );
  }
  return lines.join("\n");
}

export const DEFAULT_CONFIG: OracleConfig = {
  defaults: {
    preset: "pro_extended",
  },
  browser: {
    sessionPrefix: "oracle",
    authSeedProfileDir: join(agentExtensionsDir, "oracle-auth-seed-profile"),
    runtimeProfilesDir: join(agentExtensionsDir, "oracle-runtime-profiles"),
    maxConcurrentJobs: 2,
    cloneStrategy: "apfs-clone",
    chatUrl: "https://chatgpt.com/",
    authUrl: "https://chatgpt.com/auth/login",
    runMode: "headless",
    executablePath: detectedChromeExecutablePath,
    userAgent: detectedChromeUserAgent,
    args: ["--disable-blink-features=AutomationControlled"],
  },
  auth: {
    pollMs: 1000,
    bootstrapTimeoutMs: 10 * 60 * 1000,
    chromeProfile: detectedChromeProfileName,
    chromeCookiePath: undefined,
  },
  worker: {
    pollMs: 5000,
    completionTimeoutMs: 90 * 60 * 1000,
  },
  poller: {
    intervalMs: 5000,
  },
  artifacts: {
    capture: true,
  },
  cleanup: {
    completeJobRetentionMs: 14 * 24 * 60 * 60 * 1000,
    failedJobRetentionMs: 30 * 24 * 60 * 60 * 1000,
  },
};

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function deepMerge<T>(base: T, override: unknown): T {
  if (!isObject(base) || !isObject(override)) {
    return (override as T) ?? base;
  }

  const result: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(override)) {
    const existing = result[key];
    result[key] = isObject(existing) && isObject(value) ? deepMerge(existing, value) : value;
  }
  return result as T;
}

function readJson(path: string): unknown {
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`Failed to parse oracle config ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function expectObject(value: unknown, path: string): Record<string, unknown> {
  if (!isObject(value)) {
    throw new Error(`Invalid oracle config: ${path} must be an object`);
  }
  return value;
}

function expectString(value: unknown, path: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`Invalid oracle config: ${path} must be a non-empty string`);
  }
  return value;
}

function expandHomePath(value: string): string {
  if (value === "~") return homedir();
  if (value.startsWith("~/")) return join(homedir(), value.slice(2));
  return value;
}

function expectAbsoluteNormalizedPath(value: unknown, path: string): string {
  const expanded = expandHomePath(expectString(value, path));
  if (!isAbsolute(expanded)) {
    throw new Error(`Invalid oracle config: ${path} must be an absolute path`);
  }
  return normalize(expanded);
}

function expectSafeProfilePath(pathValue: string, path: string): string {
  if (pathValue === "/" || pathValue === homedir()) {
    throw new Error(`Invalid oracle config: ${path} points to an unsafe directory`);
  }
  if (pathValue === DEFAULT_MAC_CHROME_USER_DATA_DIR || pathValue.startsWith(`${DEFAULT_MAC_CHROME_USER_DATA_DIR}/`)) {
    throw new Error(`Invalid oracle config: ${path} must not point into the real Chrome user-data directory`);
  }
  return pathValue;
}

function expectSafeProfileDir(value: unknown, path: string): string {
  return expectSafeProfilePath(expectAbsoluteNormalizedPath(value, path), path);
}

function expectBoolean(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") {
    throw new Error(`Invalid oracle config: ${path} must be a boolean`);
  }
  return value;
}

function expectOptionalString(value: unknown, path: string): string | undefined {
  if (value === undefined) return undefined;
  return expectString(value, path);
}

function expectOptionalAbsoluteNormalizedPath(value: unknown, path: string): string | undefined {
  if (value === undefined) return undefined;
  return expectAbsoluteNormalizedPath(value, path);
}

function expectStringArray(value: unknown, path: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.trim() === "")) {
    throw new Error(`Invalid oracle config: ${path} must be an array of non-empty strings`);
  }
  return value;
}

function expectInteger(value: unknown, path: string, minimum: number, maximum?: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < minimum || (maximum !== undefined && value > maximum)) {
    const range = maximum === undefined ? `>= ${minimum}` : `between ${minimum} and ${maximum}`;
    throw new Error(`Invalid oracle config: ${path} must be an integer ${range}`);
  }
  return value;
}

function expectEnum<T extends readonly string[]>(value: unknown, path: string, allowed: T): T[number] {
  if (typeof value !== "string" || !allowed.includes(value)) {
    throw new Error(`Invalid oracle config: ${path} must be one of ${allowed.join(", ")}`);
  }
  return value as T[number];
}

function expectChatGptUrl(value: unknown, path: string): string {
  const url = expectString(value, path);
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" || !ALLOWED_CHATGPT_ORIGINS.has(parsed.origin)) {
      throw new Error("unsupported origin");
    }
    return parsed.toString();
  } catch {
    throw new Error(`Invalid oracle config: ${path} must be an https ChatGPT URL on ${Array.from(ALLOWED_CHATGPT_ORIGINS).join(", ")}`);
  }
}

function filterProjectConfig(value: unknown): unknown {
  if (value === undefined) return undefined;
  const root = expectObject(value, "project config root");
  for (const key of Object.keys(root)) {
    if (!PROJECT_OVERRIDE_KEYS.has(key)) {
      throw new Error(`Invalid oracle project config: ${key} cannot be overridden at the project level`);
    }
  }
  return root;
}

function normalizeLegacyBrowserConfig(root: Record<string, unknown>): Record<string, unknown> {
  const browser = expectObject(root.browser, "browser");
  const legacySessionName = browser.sessionName;
  const legacyProfileDir = browser.profileDir;
  if (legacySessionName !== undefined && browser.sessionPrefix === undefined) {
    browser.sessionPrefix = legacySessionName;
  }
  if (legacyProfileDir !== undefined && browser.authSeedProfileDir === undefined) {
    browser.authSeedProfileDir = legacyProfileDir;
  }
  if (browser.runtimeProfilesDir === undefined) {
    const baseProfileDir = typeof browser.authSeedProfileDir === "string" ? expandHomePath(browser.authSeedProfileDir) : DEFAULT_CONFIG.browser.authSeedProfileDir;
    browser.runtimeProfilesDir = join(normalize(baseProfileDir), "..", "oracle-runtime-profiles");
  }
  if (browser.maxConcurrentJobs === undefined) {
    browser.maxConcurrentJobs = DEFAULT_CONFIG.browser.maxConcurrentJobs;
  }
  if (browser.cloneStrategy === undefined) {
    browser.cloneStrategy = DEFAULT_CONFIG.browser.cloneStrategy;
  }
  root.browser = browser;
  return root;
}

const PRESET_IDS = ORACLE_SUBMIT_PRESET_IDS;

function validateOracleConfig(value: unknown): OracleConfig {
  const root = normalizeLegacyBrowserConfig(expectObject(value, "root"));

  const defaults = expectObject(root.defaults, "defaults");
  const preset = expectEnum(defaults.preset, "defaults.preset", PRESET_IDS);

  const browser = expectObject(root.browser, "browser");
  const auth = expectObject(root.auth, "auth");
  const worker = expectObject(root.worker, "worker");
  const poller = expectObject(root.poller, "poller");
  const artifacts = expectObject(root.artifacts, "artifacts");
  const cleanup = expectObject(root.cleanup, "cleanup");

  const authSeedProfileDir = expectSafeProfileDir(browser.authSeedProfileDir, "browser.authSeedProfileDir");
  const runtimeProfilesDir = expectSafeProfileDir(browser.runtimeProfilesDir, "browser.runtimeProfilesDir");
  if (runtimeProfilesDir === authSeedProfileDir || runtimeProfilesDir.startsWith(`${authSeedProfileDir}/`)) {
    throw new Error("Invalid oracle config: browser.runtimeProfilesDir must be separate from browser.authSeedProfileDir");
  }

  return {
    defaults: {
      preset,
    },
    browser: {
      sessionPrefix: expectString(browser.sessionPrefix, "browser.sessionPrefix"),
      authSeedProfileDir,
      runtimeProfilesDir,
      maxConcurrentJobs: expectInteger(browser.maxConcurrentJobs, "browser.maxConcurrentJobs", 1, 32),
      cloneStrategy: expectEnum(browser.cloneStrategy, "browser.cloneStrategy", CLONE_STRATEGIES),
      chatUrl: expectChatGptUrl(browser.chatUrl, "browser.chatUrl"),
      authUrl: expectChatGptUrl(browser.authUrl, "browser.authUrl"),
      runMode: expectEnum(browser.runMode, "browser.runMode", BROWSER_RUN_MODES),
      executablePath: expectOptionalAbsoluteNormalizedPath(browser.executablePath, "browser.executablePath"),
      userAgent: expectOptionalString(browser.userAgent, "browser.userAgent"),
      args: expectStringArray(browser.args, "browser.args"),
    },
    auth: {
      pollMs: expectInteger(auth.pollMs, "auth.pollMs", 100),
      bootstrapTimeoutMs: expectInteger(auth.bootstrapTimeoutMs, "auth.bootstrapTimeoutMs", 1000),
      chromeProfile: expectString(auth.chromeProfile, "auth.chromeProfile"),
      chromeCookiePath: expectOptionalAbsoluteNormalizedPath(auth.chromeCookiePath, "auth.chromeCookiePath"),
    },
    worker: {
      pollMs: expectInteger(worker.pollMs, "worker.pollMs", 100),
      completionTimeoutMs: expectInteger(worker.completionTimeoutMs, "worker.completionTimeoutMs", 1000),
    },
    poller: {
      intervalMs: expectInteger(poller.intervalMs, "poller.intervalMs", 100),
    },
    artifacts: {
      capture: expectBoolean(artifacts.capture, "artifacts.capture"),
    },
    cleanup: {
      completeJobRetentionMs: expectInteger(cleanup.completeJobRetentionMs, "cleanup.completeJobRetentionMs", 0),
      failedJobRetentionMs: expectInteger(cleanup.failedJobRetentionMs, "cleanup.failedJobRetentionMs", 0),
    },
  };
}

export function loadOracleConfig(cwd: string): OracleConfig {
  const details = getOracleConfigLoadDetails(cwd);
  const globalConfig = readJson(details.agentConfigPath);
  const projectConfig = filterProjectConfig(readJson(details.projectConfigPath));
  return validateOracleConfig(deepMerge(deepMerge(DEFAULT_CONFIG, globalConfig), projectConfig));
}
