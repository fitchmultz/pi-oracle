// Purpose: Bootstrap isolated oracle browser auth by importing real Chromium-family cookies and validating provider session readiness.
// Responsibilities: Copy/import cookies, classify auth pages, drive lightweight account-selection flows, and persist diagnostics for auth failures.
// Scope: Auth bootstrap worker only; long-running oracle job execution stays in run-job.mjs and shared lifecycle/state helpers stay elsewhere.
// Usage: Spawned by /oracle-auth to prepare the shared auth seed profile used by future oracle jobs.
// Invariants/Assumptions: Runs against a local Chromium-family profile, preserves private diagnostics, and must fail clearly when auth state cannot be verified.
import { withLock } from "./state-locks.mjs";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { appendFile, chmod, lstat, mkdir, mkdtemp, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { getCookies } from "@steipete/sweet-cookie";
import {
  assertNotKnownBrowserUserDataPath,
  scrubSweetCookieSafeStoragePasswordEnv,
  sweetCookieSafeStoragePasswordScrubbedEnv,
} from "../shared/browser-profile-helpers.mjs";
import { ensureAccountCookie, filterImportableAuthCookies } from "./auth-cookie-policy.mjs";
import { getCookiesFromConfiguredChromiumSource } from "./chromium-cookie-source.mjs";
import { buildAllowedChatGptOrigins } from "./chatgpt-ui-helpers.mjs";
import { buildAccountChooserCandidateLabels, classifyChatAuthPage, normalizeLoginProbeResult } from "./auth-flow-helpers.mjs";

const rawConfig = process.argv[2];
if (!rawConfig) {
  console.error("Usage: auth-bootstrap.mjs <oracle-config-json>");
  process.exit(1);
}

const parsedConfigPayload = JSON.parse(rawConfig);
const config =
  parsedConfigPayload &&
    typeof parsedConfigPayload === "object" &&
    !Array.isArray(parsedConfigPayload) &&
    Object.hasOwn(parsedConfigPayload, "config")
    ? parsedConfigPayload.config
    : parsedConfigPayload;
const configLoad =
  parsedConfigPayload &&
    typeof parsedConfigPayload === "object" &&
    !Array.isArray(parsedConfigPayload) &&
    Object.hasOwn(parsedConfigPayload, "configLoad") &&
    parsedConfigPayload.configLoad &&
    typeof parsedConfigPayload.configLoad === "object"
    ? parsedConfigPayload.configLoad
    : undefined;
const CHATGPT_LABELS = {
  composer: "Chat with ChatGPT",
  addFiles: "Add files and more",
};
const LOGIN_PROBE_TIMEOUT_MS = 5_000;
const CHATGPT_COOKIE_ORIGINS = [
  "https://chatgpt.com",
  "https://chat.openai.com",
  "https://atlas.openai.com",
  "https://auth.openai.com",
  "https://sentinel.openai.com",
  "https://ws.chatgpt.com",
];
const GROK_COOKIE_ORIGINS = ["https://grok.com", "https://x.ai", "https://x.com"];
let DIAGNOSTICS_DIR;
let LOG_PATH = "(oracle-auth log path unavailable)";
let URL_PATH = "(oracle-auth url path unavailable)";
let SNAPSHOT_PATH = "(oracle-auth snapshot path unavailable)";
let BODY_PATH = "(oracle-auth body path unavailable)";
let SCREENSHOT_PATH = "(oracle-auth screenshot path unavailable)";
const DEFAULT_ORACLE_STATE_DIR = "/tmp/pi-oracle-state";
const ORACLE_STATE_DIR = process.env.PI_ORACLE_STATE_DIR?.trim() || DEFAULT_ORACLE_STATE_DIR;
const STALE_STAGING_PROFILE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const AGENT_BROWSER_BIN = [process.env.AGENT_BROWSER_PATH, "/opt/homebrew/bin/agent-browser", "/usr/local/bin/agent-browser"].find(
  (candidate) => typeof candidate === "string" && candidate && existsSync(candidate),
) || "agent-browser";

function readPositiveIntEnv(name, fallback) {
  const value = process.env[name]?.trim();
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

const AGENT_BROWSER_COMMAND_TIMEOUT_MS = readPositiveIntEnv("PI_ORACLE_AUTH_AGENT_BROWSER_TIMEOUT_MS", 30_000);
const AGENT_BROWSER_CLOSE_TIMEOUT_MS = readPositiveIntEnv("PI_ORACLE_AUTH_CLOSE_TIMEOUT_MS", 10_000);
const AGENT_BROWSER_KILL_GRACE_MS = readPositiveIntEnv("PI_ORACLE_AUTH_KILL_GRACE_MS", 2_000);
const COOKIE_READ_TIMEOUT_MS = readPositiveIntEnv("PI_ORACLE_AUTH_COOKIE_READ_TIMEOUT_MS", 30_000);

let runtimeProfileDir = config.browser.authSeedProfileDir;

function authSessionName() {
  return `${config.browser.sessionPrefix}-auth`;
}

function effectiveAuthConfigPath() {
  return typeof configLoad?.effectiveAuthConfigPath === "string" && configLoad.effectiveAuthConfigPath
    ? configLoad.effectiveAuthConfigPath
    : join(process.env.PI_CODING_AGENT_DIR?.trim() || join(homedir(), ".pi", "agent"), "extensions", "oracle.json");
}

function authConfigRemediation() {
  if (typeof configLoad?.remediation === "string" && configLoad.remediation) return configLoad.remediation;
  if (typeof configLoad?.projectConfigPath === "string" && configLoad.projectConfigPath && configLoad.projectConfigExists) {
    return (
      `Set auth.chromeProfile / auth.chromeCookiePath / auth.chromiumKeychain in ${effectiveAuthConfigPath()}. ` +
      `Project overrides are also read from ${configLoad.projectConfigPath}, but auth.* is loaded from ${effectiveAuthConfigPath()}.`
    );
  }
  return `Set auth.chromeProfile / auth.chromeCookiePath / auth.chromiumKeychain in ${effectiveAuthConfigPath()}.`;
}

function authConfigSummary() {
  if (typeof configLoad?.summary === "string" && configLoad.summary) return configLoad.summary;
  const agentDirSuffix = typeof configLoad?.agentDir === "string" && configLoad.agentDir ? ` (agent dir: ${configLoad.agentDir})` : "";
  const createSuffix = configLoad?.agentConfigExists === false ? " [create this file to override auth.*]" : "";
  const lines = [`Effective oracle auth config: ${effectiveAuthConfigPath()}${agentDirSuffix}${createSuffix}`];
  if (typeof configLoad?.projectConfigPath === "string" && configLoad.projectConfigPath && configLoad.projectConfigExists) {
    lines.push(`Project oracle config also loaded: ${configLoad.projectConfigPath} (auth.* still comes from ${effectiveAuthConfigPath()}).`);
  }
  return lines.join("\n");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function initDiagnosticsBundle() {
  if (DIAGNOSTICS_DIR) return;
  DIAGNOSTICS_DIR = await mkdtemp(join(tmpdir(), "pi-oracle-auth-"));
  await chmod(DIAGNOSTICS_DIR, 0o700).catch(() => undefined);
  LOG_PATH = join(DIAGNOSTICS_DIR, "oracle-auth.log");
  URL_PATH = join(DIAGNOSTICS_DIR, "oracle-auth.url.txt");
  SNAPSHOT_PATH = join(DIAGNOSTICS_DIR, "oracle-auth.snapshot.txt");
  BODY_PATH = join(DIAGNOSTICS_DIR, "oracle-auth.body.txt");
  SCREENSHOT_PATH = join(DIAGNOSTICS_DIR, "oracle-auth.png");
}

async function initLog() {
  await initDiagnosticsBundle();
  await writeFile(LOG_PATH, "", { mode: 0o600 });
  await chmod(LOG_PATH, 0o600).catch(() => undefined);
}

async function log(message) {
  await initDiagnosticsBundle();
  const line = `[${new Date().toISOString()}] ${message}\n`;
  await appendFile(LOG_PATH, line, { encoding: "utf8", mode: 0o600 });
  await chmod(LOG_PATH, 0o600).catch(() => undefined);
}

function spawnCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const { timeoutMs = AGENT_BROWSER_COMMAND_TIMEOUT_MS, ...spawnOptions } = options;
    const child = spawn(command, args, {
      stdio: ["pipe", "pipe", "pipe"],
      ...spawnOptions,
      env: sweetCookieSafeStoragePasswordScrubbedEnv(),
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let killTimer;
    let killGraceTimer;
    if (typeof timeoutMs === "number" && timeoutMs > 0) {
      killTimer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
        killGraceTimer = setTimeout(() => child.kill("SIGKILL"), AGENT_BROWSER_KILL_GRACE_MS);
        killGraceTimer.unref?.();
      }, timeoutMs);
      killTimer.unref?.();
    }
    if (options.input) child.stdin.end(options.input);
    else child.stdin.end();
    child.stdout.on("data", (data) => {
      stdout += String(data);
    });
    child.stderr.on("data", (data) => {
      stderr += String(data);
    });
    child.on("error", (error) => {
      if (killTimer) clearTimeout(killTimer);
      if (killGraceTimer) clearTimeout(killGraceTimer);
      reject(error);
    });
    child.on("close", (code) => {
      if (killTimer) clearTimeout(killTimer);
      if (killGraceTimer) clearTimeout(killGraceTimer);
      if (timedOut) {
        const error = new Error(stderr || stdout || `${command} timed out after ${timeoutMs}ms`);
        if (options.allowFailure) resolve({ code, stdout: stdout.trim(), stderr: error.message });
        else reject(error);
        return;
      }
      if (code === 0 || options.allowFailure) resolve({ code, stdout: stdout.trim(), stderr: stderr.trim() });
      else reject(new Error(stderr || stdout || `${command} exited with code ${code}`));
    });
  });
}

function targetBrowserBaseArgs(options = {}) {
  const args = ["--session", authSessionName()];
  if (options.withLaunchOptions) {
    args.push("--profile", runtimeProfileDir);
    if (config.browser.executablePath) args.push("--executable-path", config.browser.executablePath);
    if (config.browser.userAgent) args.push("--user-agent", config.browser.userAgent);
    if (Array.isArray(config.browser.args) && config.browser.args.length > 0) args.push("--args", config.browser.args.join(","));
    if (options.mode === "headed") args.push("--headed");
  }
  return args;
}

async function closeTargetBrowser() {
  await log(`Closing target browser session ${authSessionName()} if present`);
  const result = await spawnCommand(AGENT_BROWSER_BIN, [...targetBrowserBaseArgs(), "close"], {
    allowFailure: true,
    timeoutMs: AGENT_BROWSER_CLOSE_TIMEOUT_MS,
  });
  await log(`close result: code=${result.code} stdout=${JSON.stringify(result.stdout)} stderr=${JSON.stringify(result.stderr)}`);
}

async function ensureNotSymlink(path, label) {
  try {
    const stats = await lstat(path);
    if (stats.isSymbolicLink()) {
      throw new Error(`${label} must not be a symlink: ${path}`);
    }
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return;
    throw error;
  }
}

async function isAuthBrowserConnected() {
  const result = await spawnCommand(AGENT_BROWSER_BIN, [...targetBrowserBaseArgs(), "--json", "stream", "status"], {
    allowFailure: true,
    timeoutMs: AGENT_BROWSER_COMMAND_TIMEOUT_MS,
  });
  try {
    const parsed = JSON.parse(result.stdout || "{}");
    return parsed?.data?.connected === true;
  } catch {
    return false;
  }
}

async function sweepStaleStagingProfiles(targetDir) {
  const parentDir = dirname(targetDir);
  const prefix = `${basename(targetDir)}.staging-`;
  const now = Date.now();

  if (await isAuthBrowserConnected()) {
    await log(`Skipping stale staging-profile sweep while auth browser session ${authSessionName()} is still connected`);
    return;
  }

  const names = await readdir(parentDir).catch(() => []);
  for (const name of names) {
    if (!name.startsWith(prefix)) continue;
    const candidatePath = join(parentDir, name);
    try {
      const stats = await stat(candidatePath);
      if (!stats.isDirectory()) continue;
      if (now - stats.mtimeMs < STALE_STAGING_PROFILE_MAX_AGE_MS) continue;
      await rm(candidatePath, { recursive: true, force: true });
      await log(`Removed stale auth staging profile ${candidatePath}`);
    } catch (error) {
      await log(`Failed to remove stale auth staging profile ${candidatePath}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

async function createProfilePlan(profileDir) {
  const targetDir = resolve(profileDir);
  if (!targetDir.startsWith("/")) {
    throw new Error(`Oracle profileDir must be an absolute path: ${profileDir}`);
  }
  if (targetDir === "/" || targetDir === homedir()) {
    throw new Error(`Oracle profileDir is unsafe: ${targetDir}`);
  }
  assertNotKnownBrowserUserDataPath(targetDir, "Oracle profileDir", {
    cookieSources: { chromeProfile: config.auth.chromeProfile, chromeCookiePath: config.auth.chromeCookiePath },
  });
  const stagingDir = `${targetDir}.staging-${Date.now()}`;
  const backupDir = `${targetDir}.prev`;
  await mkdir(dirname(targetDir), { recursive: true, mode: 0o700 });
  await ensureNotSymlink(dirname(targetDir), "Oracle profile parent directory");
  await ensureNotSymlink(targetDir, "Oracle profile directory");
  await ensureNotSymlink(backupDir, "Oracle backup profile directory");
  await sweepStaleStagingProfiles(targetDir);
  return { targetDir, stagingDir, backupDir };
}

async function prepareStagedProfile(plan) {
  runtimeProfileDir = plan.stagingDir;
  await log(`Preparing staged oracle profile ${plan.stagingDir}`);
  await rm(plan.stagingDir, { recursive: true, force: true }).catch(async (error) => {
    await log(`Staging profile cleanup warning: ${error instanceof Error ? error.message : String(error)}`);
  });
}

async function commitStagedProfile(plan) {
  await log(`Committing staged oracle profile ${plan.stagingDir} -> ${plan.targetDir}`);
  await rm(plan.backupDir, { recursive: true, force: true }).catch(() => undefined);

  const hadPreviousProfile = existsSync(plan.targetDir);
  if (hadPreviousProfile) {
    await rename(plan.targetDir, plan.backupDir);
  }

  try {
    await rename(plan.stagingDir, plan.targetDir);
    runtimeProfileDir = plan.targetDir;
    if (hadPreviousProfile) {
      await log(`Previous oracle profile moved to ${plan.backupDir}`);
    }
  } catch (error) {
    if (!existsSync(plan.targetDir) && existsSync(plan.backupDir)) {
      await rename(plan.backupDir, plan.targetDir).catch(() => undefined);
    }
    throw error;
  }
}

async function launchTargetBrowser() {
  await closeTargetBrowser();
  const args = [...targetBrowserBaseArgs({ withLaunchOptions: true, mode: "headed" }), "open", "about:blank"];
  await log(`Launching isolated browser: agent-browser ${JSON.stringify(args)}`);
  const result = await spawnCommand(AGENT_BROWSER_BIN, args, { allowFailure: true, timeoutMs: AGENT_BROWSER_COMMAND_TIMEOUT_MS });
  await log(`launch result: code=${result.code} stdout=${JSON.stringify(result.stdout)} stderr=${JSON.stringify(result.stderr)}`);
  if (result.code !== 0) {
    throw new Error(result.stderr || result.stdout || "Failed to launch isolated oracle browser");
  }
}

async function streamStatus() {
  const result = await spawnCommand(AGENT_BROWSER_BIN, [...targetBrowserBaseArgs(), "--json", "stream", "status"], {
    allowFailure: true,
    timeoutMs: AGENT_BROWSER_COMMAND_TIMEOUT_MS,
  });
  await log(`stream status: code=${result.code} stdout=${JSON.stringify(result.stdout)} stderr=${JSON.stringify(result.stderr)}`);
  try {
    const parsed = JSON.parse(result.stdout || "{}");
    return parsed?.data || {};
  } catch {
    return {};
  }
}

async function ensureBrowserConnected() {
  const status = await streamStatus();
  if (status.connected === false) {
    throw new Error("The isolated oracle browser was closed before auth verification completed.");
  }
}

async function targetCommand(...args) {
  let options;
  const maybeOptions = args.at(-1);
  if (
    maybeOptions &&
    typeof maybeOptions === "object" &&
    !Array.isArray(maybeOptions) &&
    (Object.hasOwn(maybeOptions, "allowFailure") ||
      Object.hasOwn(maybeOptions, "input") ||
      Object.hasOwn(maybeOptions, "cwd") ||
      Object.hasOwn(maybeOptions, "logLabel") ||
      Object.hasOwn(maybeOptions, "timeoutMs"))
  ) {
    options = args.pop();
  }
  await ensureBrowserConnected();
  const result = await spawnCommand(AGENT_BROWSER_BIN, [...targetBrowserBaseArgs(), ...args], options);
  const label = options?.logLabel || `agent-browser ${args.join(" ")}`;
  await log(`${label}: code=${result.code} stdout=${JSON.stringify(result.stdout)} stderr=${JSON.stringify(result.stderr)}`);
  return result;
}

function parseEvalResult(stdout) {
  if (!stdout) return undefined;
  let value = stdout.trim();
  try {
    let parsed = JSON.parse(value);
    while (typeof parsed === "string") parsed = JSON.parse(parsed);
    return parsed;
  } catch {
    return value;
  }
}

async function evalPage(script, logLabel = "eval") {
  const result = await targetCommand("eval", "--stdin", { input: script, logLabel });
  return parseEvalResult(result.stdout);
}

function toAsyncJsonScript(expression) {
  return `(async () => JSON.stringify(await (async () => { ${expression} })(), null, 2))()`;
}

async function openUrl(url, label = url) {
  await log(`Opening URL ${url}`);
  await targetCommand("open", url, { logLabel: `open ${label}` });
}

async function getUrl() {
  const { stdout } = await targetCommand("get", "url", { logLabel: "get url" });
  return stdout || "";
}

async function snapshotText() {
  const { stdout } = await targetCommand("snapshot", "-i", { logLabel: "snapshot -i" });
  return stdout || "";
}

async function pageText() {
  const { stdout } = await targetCommand("get", "text", "body", { allowFailure: true, logLabel: "get text body" });
  return stdout || "";
}

function parseSnapshotEntries(snapshot) {
  return snapshot
    .split("\n")
    .map((line) => {
      const refMatch = line.match(/\bref=(e\d+)\b/);
      if (!refMatch) return undefined;
      const kindMatch = line.match(/^\s*-\s*([^\s]+)/);
      const quotedMatch = line.match(/"([^"]*)"/);
      const valueMatch = line.match(/:\s*(.+)$/);
      return {
        line,
        ref: `@${refMatch[1]}`,
        kind: kindMatch ? kindMatch[1] : undefined,
        label: quotedMatch ? quotedMatch[1] : undefined,
        value: valueMatch ? valueMatch[1].trim() : undefined,
        disabled: /\bdisabled\b/.test(line),
      };
    })
    .filter(Boolean);
}

function findEntry(snapshot, predicate) {
  return parseSnapshotEntries(snapshot).find(predicate);
}

function findLastEntry(snapshot, predicate) {
  const entries = parseSnapshotEntries(snapshot);
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    if (predicate(entries[index])) return entries[index];
  }
  return undefined;
}

async function clickRef(ref, logLabel = `click ${ref}`) {
  await targetCommand("click", ref, { logLabel });
}

function stripQuery(url) {
  try {
    const parsed = new URL(url);
    parsed.hash = "";
    parsed.search = "";
    return parsed.toString();
  } catch {
    return url;
  }
}

function preferredProvider() {
  return config?.defaults?.provider === "grok" ? "grok" : "chatgpt";
}

function providerChatUrl() {
  return preferredProvider() === "grok" ? "https://grok.com/" : config.browser.chatUrl;
}

function providerName() {
  return preferredProvider() === "grok" ? "Grok" : "ChatGPT";
}

function cookieOrigins() {
  const providerOrigins = preferredProvider() === "grok" ? GROK_COOKIE_ORIGINS : CHATGPT_COOKIE_ORIGINS;
  return Array.from(new Set([stripQuery(providerChatUrl()), ...providerOrigins]));
}

function cookieSource() {
  return config.auth.chromeCookiePath || config.auth.chromeProfile;
}

function usesConfiguredChromiumCookieSource() {
  return Boolean(config.auth.chromeCookiePath && config.auth.chromiumKeychain);
}

function browserSourceName() {
  if (config.browser.executablePath) return basename(config.browser.executablePath);
  if (usesConfiguredChromiumCookieSource()) return "configured Chromium browser";
  return "Google Chrome";
}

function keychainSummary() {
  const keychain = config.auth.chromiumKeychain;
  if (!keychain) return undefined;
  const services = Array.isArray(keychain.services) && keychain.services.length > 0 ? keychain.services.join(", ") : "(none configured)";
  const label = keychain.label || services;
  return `${label} (account: ${keychain.account}, services: ${services})`;
}

function cookieSourceLabel() {
  if (usesConfiguredChromiumCookieSource()) return `configured Chromium cookie DB ${config.auth.chromeCookiePath}`;
  return config.auth.chromeCookiePath
    ? `Chrome cookie DB ${config.auth.chromeCookiePath}`
    : `Chrome profile ${config.auth.chromeProfile}`;
}

function formatAuthSuccessMessage({ classificationMessage, appliedCount, targetDir }) {
  const lines = [
    "Oracle auth synced.",
    "",
    "Source:",
    `- Browser: ${browserSourceName()}`,
  ];

  if (config.auth.chromeCookiePath) lines.push(`- Cookie DB: ${config.auth.chromeCookiePath}`);
  else lines.push(`- Profile: ${config.auth.chromeProfile}`);

  const keychain = keychainSummary();
  if (keychain) lines.push(`- Keychain: ${keychain}`);
  lines.push(`- Cookies synced: ${appliedCount}`);
  lines.push("", "Auth seed profile:", targetDir, "", "Diagnostics:", DIAGNOSTICS_DIR, "", "Status:", classificationMessage);
  return lines.join("\n");
}

function formatAuthFailureGuidance(error) {
  const reason = error instanceof Error ? error.message : String(error);
  const lines = ["Oracle auth failed.", "", `Reason: ${reason}`, "", "Likely causes:"];

  if (usesConfiguredChromiumCookieSource()) {
    lines.push(
      "- the configured cookie DB is stale or from the wrong browser profile",
      `- ${providerName()} is logged out in that browser profile`,
      "- auth.chromiumKeychain does not match the browser safe-storage item for that cookie DB",
      "- the target browser was still running while /oracle-auth read its Cookies DB",
      "",
      "Next:",
      "1. Open the configured browser profile.",
      `2. Confirm ${providerName()} works there.`,
      "3. Quit the browser fully.",
      "4. Confirm auth.chromeCookiePath points at that profile's Cookies DB.",
      "5. Confirm auth.chromiumKeychain.services names the browser's safe-storage Keychain service.",
      "6. Re-run /oracle-auth.",
    );
  } else {
    lines.push(
      `- ${providerName()} is logged out in the configured local browser profile`,
      "- auth.chromeProfile or auth.chromeCookiePath points at the wrong profile",
      "- the profile cookie store is stale or unreadable",
      "",
      "Next:",
      "1. Open the configured local browser profile.",
      `2. Confirm ${providerName()} works there.`,
      "3. Quit the browser fully.",
      "4. Re-run /oracle-auth.",
    );
    if (process.platform === "linux") {
      lines.push(
        "5. If Chromium encrypted-cookie warnings mention the Linux keyring, install/configure secret-tool or kwallet-query, or set SWEET_COOKIE_LINUX_KEYRING / SWEET_COOKIE_CHROME_SAFE_STORAGE_PASSWORD / SWEET_COOKIE_BRAVE_SAFE_STORAGE_PASSWORD for this run before rerunning.",
      );
    }
  }

  lines.push(
    "",
    "Details:",
    `- Source: ${cookieSourceLabel()}`,
    `- Browser: ${browserSourceName()}`,
    `- Auth seed profile: ${config.browser.authSeedProfileDir}`,
    `- Diagnostics: ${DIAGNOSTICS_DIR || "(oracle-auth diagnostics dir unavailable)"}`,
    `- Log: ${LOG_PATH}`,
    "",
    authConfigSummary(),
  );

  return lines.join("\n");
}

async function readRawSourceCookies() {
  if (config.auth.chromeCookiePath && config.auth.chromiumKeychain) {
    return await getCookiesFromConfiguredChromiumSource({
      dbPath: config.auth.chromeCookiePath,
      keychain: config.auth.chromiumKeychain,
      origins: cookieOrigins(),
      profile: config.auth.chromeProfile,
      timeoutMs: COOKIE_READ_TIMEOUT_MS,
    });
  }

  return await getCookies({
    url: providerChatUrl(),
    origins: cookieOrigins(),
    browsers: ["chrome"],
    mode: "merge",
    chromeProfile: cookieSource(),
    timeoutMs: COOKIE_READ_TIMEOUT_MS,
  });
}

async function readSourceCookies() {
  await log(`Reading ${providerName()} cookies from ${cookieSourceLabel()}`);
  let sourceResult;
  try {
    sourceResult = await readRawSourceCookies();
  } finally {
    scrubSweetCookieSafeStoragePasswordEnv();
  }
  const { cookies, warnings } = sourceResult;

  if (warnings.length) {
    await log(`Cookie source warnings: ${warnings.join(" | ")}`);
  }

  const filtered = filterImportableAuthCookies(cookies, providerChatUrl());
  let normalizedCookies = filtered.cookies;
  await log(
    `Read ${normalizedCookies.length} filtered auth cookies: ${normalizedCookies.map((cookie) => `${cookie.name}@${cookie.domain}`).join(", ")}`,
  );
  if (filtered.dropped.length) {
    await log(
      `Dropped ${filtered.dropped.length} non-importable cookies: ` +
        filtered.dropped.map(({ cookie, reason }) => `${cookie.name}@${cookie.domain}(${reason})`).join(", "),
    );
  }

  const hasSessionToken = normalizedCookies.some((cookie) => cookie.name.startsWith("__Secure-next-auth.session-token"));
  const hasAccountCookie = normalizedCookies.some((cookie) => cookie.name === "_account");
  await log(`Cookie presence: sessionToken=${hasSessionToken} account=${hasAccountCookie}`);

  if (preferredProvider() === "grok") {
    if (normalizedCookies.length === 0) {
      throw new Error(`No Grok cookies were found in ${cookieSourceLabel()}. Make sure Grok is logged into that browser profile. ${authConfigRemediation()}`);
    }
    return normalizedCookies;
  }

  if (!hasSessionToken) {
    throw new Error(
      `No ChatGPT session-token cookies were found in ${cookieSourceLabel()}. Make sure ChatGPT is logged into that browser profile. ${authConfigRemediation()}`,
    );
  }

  if (!hasAccountCookie) {
    const ensured = ensureAccountCookie(normalizedCookies, config.browser.chatUrl);
    normalizedCookies = ensured.cookies;
    if (ensured.synthesized) {
      await log(`Synthesized missing _account cookie with value=${ensured.value}`);
    }
  }

  return normalizedCookies;
}

function cookieSetArgs(cookie) {
  const args = ["cookies", "set", cookie.name, cookie.value, "--domain", cookie.domain, "--path", cookie.path || "/"];
  if (cookie.httpOnly) args.push("--httpOnly");
  if (cookie.secure) args.push("--secure");
  if (cookie.sameSite) args.push("--sameSite", cookie.sameSite);
  if (cookie.expires) args.push("--expires", String(cookie.expires));
  return args;
}

async function seedCookiesIntoTarget(cookies) {
  await log(`Clearing isolated browser cookies before seeding fresh ${providerName()} cookies`);
  await targetCommand("cookies", "clear", { logLabel: "cookies clear" });

  let applied = 0;
  for (const cookie of cookies) {
    const args = cookieSetArgs(cookie);
    await log(`Applying cookie ${cookie.name}@${cookie.domain} path=${cookie.path} httpOnly=${cookie.httpOnly} secure=${cookie.secure} sameSite=${cookie.sameSite || "(none)"} expires=${cookie.expires ?? "session"}`);
    const result = await targetCommand(...args, { logLabel: `cookies set ${cookie.name}@${cookie.domain}` });
    if (result.code === 0) applied += 1;
  }

  await log(`Applied ${applied}/${cookies.length} cookies into isolated browser profile`);
  return applied;
}

function buildLoginProbeScript(timeoutMs) {
  return toAsyncJsonScript(`
    const pageUrl = typeof location === 'object' && location?.href ? location.href : null;
    const onAuthPage =
      typeof location === 'object' &&
      ((typeof location.hostname === 'string' && /^auth\.openai\.com$/i.test(location.hostname)) ||
        (typeof location.pathname === 'string' && /^\\/(auth|login|signin|log-in)/i.test(location.pathname)));

    const hasLoginCta = () => {
      const candidates = Array.from(
        document.querySelectorAll(
          [
            'a[href*="/auth/login"]',
            'a[href*="/auth/signin"]',
            'button[type="submit"]',
            'button[data-testid*="login"]',
            'button[data-testid*="log-in"]',
            'button[data-testid*="sign-in"]',
            'button[data-testid*="signin"]',
            'button',
            'a',
          ].join(','),
        ),
      );
      const textMatches = (text) => {
        if (!text) return false;
        const normalized = text.toLowerCase().trim();
        return ['log in', 'login', 'sign in', 'signin', 'continue with'].some((needle) => normalized.startsWith(needle));
      };
      for (const node of candidates) {
        if (!(node instanceof HTMLElement)) continue;
        const label =
          node.textContent?.trim() ||
          node.getAttribute('aria-label') ||
          node.getAttribute('title') ||
          '';
        if (textMatches(label)) return true;
      }
      return false;
    };

    let status = 0;
    let error = null;
    let bodyKeys = [];
    let bodyHasId = false;
    let bodyHasEmail = false;
    let resultName = '';
    let responsePreview = '';
    try {
      if (typeof fetch === 'function') {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), ${timeoutMs});
        try {
          const response = await fetch('/backend-api/me', {
            cache: 'no-store',
            credentials: 'include',
            signal: controller.signal,
          });
          status = response.status || 0;
          const contentType = response.headers.get('content-type') || '';
          if (contentType.includes('application/json')) {
            const data = await response.clone().json().catch(() => null);
            if (data && typeof data === 'object' && !Array.isArray(data)) {
              bodyKeys = Object.keys(data).slice(0, 12);
              bodyHasId = typeof data.id === 'string' && data.id.length > 0;
              bodyHasEmail = typeof data.email === 'string' && data.email.includes('@');
              const name = typeof data.name === 'string' ? data.name.trim() : '';
              if (name) resultName = name;
              try {
                responsePreview = JSON.stringify(data).slice(0, 2000);
              } catch (_error) {
                responsePreview = '[unserializable]';
              }
            }
          }
        } finally {
          clearTimeout(timeout);
        }
      }
    } catch (err) {
      error = err ? String(err) : 'unknown';
    }

    const domLoginCta = hasLoginCta();
    const loginSignals = domLoginCta || onAuthPage;
    return {
      ok: !loginSignals && (status === 0 || status === 200),
      status,
      pageUrl,
      domLoginCta,
      onAuthPage,
      error,
      bodyKeys,
      bodyHasId,
      bodyHasEmail,
      name: resultName,
      responsePreview,
    };
  `);
}

async function loginProbe() {
  const result = await evalPage(buildLoginProbeScript(LOGIN_PROBE_TIMEOUT_MS), "login probe eval");
  return normalizeLoginProbeResult(result);
}

async function captureDiagnostics(reason) {
  try {
    const [url, snapshot, body] = await Promise.all([getUrl().catch(() => ""), snapshotText().catch(() => ""), pageText().catch(() => "")]);
    await writeFile(URL_PATH, `${url}\n`, { mode: 0o600 });
    await writeFile(SNAPSHOT_PATH, `${snapshot}\n`, { mode: 0o600 });
    await writeFile(BODY_PATH, `${body}\n`, { mode: 0o600 });
    await chmod(URL_PATH, 0o600).catch(() => undefined);
    await chmod(SNAPSHOT_PATH, 0o600).catch(() => undefined);
    await chmod(BODY_PATH, 0o600).catch(() => undefined);
    await targetCommand("screenshot", SCREENSHOT_PATH, { allowFailure: true, logLabel: `screenshot ${reason}` }).catch(() => undefined);
    await log(`Captured diagnostics for ${reason}: ${URL_PATH}, ${SNAPSHOT_PATH}, ${BODY_PATH}, ${SCREENSHOT_PATH}`);
  } catch (error) {
    await log(`Failed to capture diagnostics for ${reason}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function classifyChatPage({ url, snapshot, body, probe }) {
  if (preferredProvider() === "grok") return classifyGrokAuthPage({ url, snapshot, body });
  return classifyChatAuthPage({
    url,
    snapshot,
    body,
    probe,
    allowedOrigins: buildAllowedChatGptOrigins(config.browser.chatUrl, config.browser.authUrl),
    cookieSourceLabel: cookieSourceLabel(),
    runtimeProfileDir,
    logPath: LOG_PATH,
    composerLabel: CHATGPT_LABELS.composer,
    addFilesLabel: CHATGPT_LABELS.addFiles,
  });
}

function hasGrokLoginCta(text) {
  const lines = String(text || "").split("\n").map((line) => line.trim()).filter(Boolean);
  return lines.some((line) => {
    const accessibleControl = line.match(/^-\s*(?:button|link|menuitem)\s+"([^"]+)"/i)?.[1]?.trim();
    const label = accessibleControl || line;
    return /^(?:sign in|log in|continue with x|continue with google|create account)$/i.test(label);
  });
}

function classifyGrokAuthPage({ url, snapshot, body }) {
  const text = `${snapshot}\n${body}`;
  if (/captcha|cloudflare|verify you are human|unusual activity|suspicious activity/i.test(text)) {
    return { state: "challenge_blocking", message: "Grok is showing a challenge/verification page" };
  }
  if (/something went wrong|network error|try again later|rate limit/i.test(text)) {
    return { state: "transient_outage_error", message: "Grok is showing a transient outage/error page" };
  }
  const onGrokOrigin = typeof url === "string" && url.startsWith("https://grok.com");
  const hasComposer = snapshot.includes('button "Attach"') && (snapshot.includes('textbox "Ask Grok anything"') || snapshot.includes("contenteditable"));
  if (onGrokOrigin && hasGrokLoginCta(text)) return { state: "login_required", message: `Grok login is required. Sign in to Grok in ${cookieSourceLabel()}.` };
  if (onGrokOrigin && hasComposer) return { state: "authenticated_and_ready", message: "Grok is authenticated and ready." };
  if (url && !onGrokOrigin) return { state: "login_required", message: "Grok redirected away from grok.com." };
  return { state: "unknown", message: "Grok page is not ready yet." };
}

async function maybeSelectAccountIdentity(snapshot, probe) {
  const candidates = buildAccountChooserCandidateLabels(probe?.name);

  for (const label of candidates) {
    const entry = findEntry(
      snapshot,
      (candidate) => candidate.kind === "button" && candidate.label === label && !candidate.disabled,
    );
    if (!entry) continue;
    await log(`Clicking account chooser button ${JSON.stringify(label)} via ${entry.ref}`);
    await clickRef(entry.ref, `click account chooser ${label}`);
    return true;
  }

  const loginEntry = findLastEntry(
    snapshot,
    (candidate) => candidate.kind === "button" && candidate.label === "Log in" && !candidate.disabled,
  );
  if (loginEntry) {
    await log(`Clicking visible Log in CTA via ${loginEntry.ref} while backend session is already authenticated`);
    await clickRef(loginEntry.ref, "click login cta");
    return true;
  }

  return false;
}

function preserveBrowserError(message) {
  const error = new Error(message);
  error.preserveBrowser = true;
  return error;
}

async function waitForImportedAuthReady() {
  const startedAt = Date.now();
  const timeoutAt = startedAt + config.auth.bootstrapTimeoutMs;
  let retriedOutage = false;
  let retriedAuthTransition = false;
  let attemptedAccountChooser = false;
  let attemptedAuthUrl = false;
  let iteration = 0;
  while (Date.now() < timeoutAt) {
    iteration += 1;
    const [url, snapshot, body, probe] = await Promise.all([getUrl(), snapshotText(), pageText(), loginProbe()]);
    await writeFile(URL_PATH, `${url}\n`, { mode: 0o600 }).catch(() => undefined);
    await writeFile(SNAPSHOT_PATH, `${snapshot}\n`, { mode: 0o600 }).catch(() => undefined);
    await writeFile(BODY_PATH, `${body}\n`, { mode: 0o600 }).catch(() => undefined);
    const classification = classifyChatPage({ url, snapshot, body, probe });
    await log(
      `poll ${iteration}: url=${JSON.stringify(url)} probe=${JSON.stringify(probe)} classification=${classification.state} hasComposer=${preferredProvider() === "grok" ? snapshot.includes('Ask Grok anything') || snapshot.includes('contenteditable') : snapshot.includes(`textbox \"${CHATGPT_LABELS.composer}\"`)} hasAddFiles=${preferredProvider() === "grok" ? snapshot.includes('button \"Attach\"') : snapshot.includes(`button \"${CHATGPT_LABELS.addFiles}\"`)}`,
    );
    if (classification.state === "authenticated_and_ready") return classification;
    if (classification.state === "auth_transitioning") {
      const elapsedMs = Date.now() - startedAt;
      if (!attemptedAuthUrl && (probe?.bodyHasId || probe?.bodyHasEmail)) {
        attemptedAuthUrl = true;
        await log(`Backend session is authenticated but shell is public; opening auth URL ${config.browser.authUrl} to force session resolution`);
        await openUrl(config.browser.authUrl, config.browser.authUrl);
        await sleep(1500);
        continue;
      }
      if (!attemptedAccountChooser && (probe?.bodyHasId || probe?.bodyHasEmail)) {
        attemptedAccountChooser = await maybeSelectAccountIdentity(snapshot, probe);
        if (attemptedAccountChooser) {
          await log("Auth transition click dispatched; waiting for authenticated shell to settle");
          await sleep(1500);
          continue;
        }
        await log(`No account/login resolution click target found. Snapshot entries: ${parseSnapshotEntries(snapshot).map((entry) => `${entry.kind}:${entry.label || entry.value || entry.ref}`).join(' | ')}`);
      }
      if (!retriedAuthTransition && elapsedMs >= 5_000) {
        retriedAuthTransition = true;
        await log("Auth looks accepted but page is still public-looking; reloading once after hydration grace period");
        await targetCommand("reload", { allowFailure: true, logLabel: "reload-after-auth-transition" }).catch(() => undefined);
        await sleep(1500);
        continue;
      }
      if (elapsedMs >= 20_000) {
        await captureDiagnostics("auth-transition-timeout");
        throw new Error(`ChatGPT accepted the session cookies but never left the public-looking homepage. Inspect ${LOG_PATH}.`);
      }
      await sleep(config.auth.pollMs);
      continue;
    }
    if (classification.state === "transient_outage_error" && !retriedOutage) {
      retriedOutage = true;
      await log("Transient outage detected; reloading once");
      await targetCommand("reload", { allowFailure: true, logLabel: "reload" }).catch(() => undefined);
      await sleep(1500);
      continue;
    }
    if (classification.state === "challenge_blocking") {
      await captureDiagnostics("challenge");
      throw preserveBrowserError(classification.message);
    }
    if (classification.state === "login_required") {
      await captureDiagnostics("login-required");
      throw new Error(`${classification.message} ${authConfigRemediation()}`);
    }
    await sleep(config.auth.pollMs);
  }
  await captureDiagnostics("timeout");
  throw new Error(`Timed out verifying synced ${providerName()} cookies in the isolated oracle profile. Logs: ${LOG_PATH}`);
}

async function run() {
  await initLog();
  await withLock(ORACLE_STATE_DIR, "auth", "global", { processPid: process.pid, action: "oracle-auth" }, async () => {
    let shouldPreserveBrowser = false;
    let committedProfile = false;
    let profilePlan;
    try {
      profilePlan = await createProfilePlan(config.browser.authSeedProfileDir);
      await log(`Starting oracle auth bootstrap`);
      await log(
        `Config summary: session=${authSessionName()} seedProfileDir=${profilePlan.targetDir} stagingProfileDir=${profilePlan.stagingDir} executable=${config.browser.executablePath || "(default)"} source=${cookieSourceLabel()}`,
      );
      await log(authConfigSummary());
      const cookies = await readSourceCookies();
      await prepareStagedProfile(profilePlan);
      await launchTargetBrowser();
      const appliedCount = await seedCookiesIntoTarget(cookies);
      await log(`Cookie seeding complete: applied=${appliedCount}`);
      await openUrl(providerChatUrl(), providerChatUrl());
      const classification = await waitForImportedAuthReady();
      await log(`Auth bootstrap success: ${classification.message}`);
      await closeTargetBrowser();
      await commitStagedProfile(profilePlan);
      const generation = new Date().toISOString();
      await writeFile(join(profilePlan.targetDir, ".oracle-seed-generation"), `${generation}\n`, { encoding: "utf8", mode: 0o600 });
      committedProfile = true;
      process.stdout.write(formatAuthSuccessMessage({ classificationMessage: classification.message, appliedCount, targetDir: profilePlan.targetDir }));
    } catch (error) {
      shouldPreserveBrowser = Boolean(error && typeof error === "object" && error.preserveBrowser === true);
      await log(`Auth bootstrap failed: ${error instanceof Error ? error.message : String(error)}`);
      if (!shouldPreserveBrowser) {
        await closeTargetBrowser().catch(() => undefined);
      }
      if (profilePlan && !committedProfile && !shouldPreserveBrowser) {
        await rm(profilePlan.stagingDir, { recursive: true, force: true }).catch(() => undefined);
      }
      throw error;
    }
  }, 10 * 60 * 1000);
}

run().catch((error) => {
  process.stderr.write(formatAuthFailureGuidance(error));
  process.exit(1);
});
