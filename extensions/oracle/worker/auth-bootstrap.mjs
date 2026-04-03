import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { appendFile, chmod, lstat, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { getCookies } from "@steipete/sweet-cookie";
import { ensureAccountCookie, filterImportableAuthCookies } from "./auth-cookie-policy.mjs";

const rawConfig = process.argv[2];
if (!rawConfig) {
  console.error("Usage: auth-bootstrap.mjs <oracle-config-json>");
  process.exit(1);
}

const config = JSON.parse(rawConfig);
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
const LOG_PATH = "/tmp/oracle-auth.log";
const URL_PATH = "/tmp/oracle-auth.url.txt";
const SNAPSHOT_PATH = "/tmp/oracle-auth.snapshot.txt";
const BODY_PATH = "/tmp/oracle-auth.body.txt";
const SCREENSHOT_PATH = "/tmp/oracle-auth.png";
const REAL_CHROME_USER_DATA_DIR = resolve(homedir(), "Library", "Application Support", "Google", "Chrome");
const ORACLE_STATE_DIR = "/tmp/pi-oracle-state";
const LOCKS_DIR = join(ORACLE_STATE_DIR, "locks");
const STALE_STAGING_PROFILE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

let runtimeProfileDir = config.browser.authSeedProfileDir;

function authSessionName() {
  return `${config.browser.sessionPrefix}-auth`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function leaseKey(kind, key) {
  return `${kind}-${createHash("sha256").update(key).digest("hex").slice(0, 24)}`;
}

async function readLockProcessPid(path) {
  const metadataPath = join(path, "metadata.json");
  if (!existsSync(metadataPath)) return undefined;
  try {
    const metadata = JSON.parse(await readFile(metadataPath, "utf8"));
    return typeof metadata?.processPid === "number" && Number.isInteger(metadata.processPid) && metadata.processPid > 0
      ? metadata.processPid
      : undefined;
  } catch {
    return undefined;
  }
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ESRCH") return false;
    return true;
  }
}

async function maybeReclaimStaleLock(path) {
  const processPid = await readLockProcessPid(path);
  if (!processPid || isProcessAlive(processPid)) return false;
  await rm(path, { recursive: true, force: true }).catch(() => undefined);
  return true;
}

async function acquireLock(kind, key, metadata, timeoutMs = 30_000) {
  const path = join(LOCKS_DIR, leaseKey(kind, key));
  const deadline = Date.now() + timeoutMs;
  await mkdir(ORACLE_STATE_DIR, { recursive: true, mode: 0o700 });
  await mkdir(LOCKS_DIR, { recursive: true, mode: 0o700 });

  while (Date.now() < deadline) {
    try {
      await mkdir(path, { recursive: false, mode: 0o700 });
      await writeFile(join(path, "metadata.json"), `${JSON.stringify(metadata, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
      return path;
    } catch (error) {
      if (!(error && typeof error === "object" && "code" in error && error.code === "EEXIST")) throw error;
      if (await maybeReclaimStaleLock(path)) continue;
    }
    await sleep(200);
  }

  throw new Error(`Timed out waiting for oracle ${kind} lock: ${key}`);
}

async function releaseLock(path) {
  if (!path) return;
  await rm(path, { recursive: true, force: true }).catch(() => undefined);
}

async function withLock(kind, key, metadata, fn, timeoutMs) {
  const handle = await acquireLock(kind, key, metadata, timeoutMs);
  try {
    return await fn();
  } finally {
    await releaseLock(handle);
  }
}

async function initLog() {
  await writeFile(LOG_PATH, "", { mode: 0o600 });
  await chmod(LOG_PATH, 0o600).catch(() => undefined);
}

async function log(message) {
  const line = `[${new Date().toISOString()}] ${message}\n`;
  await appendFile(LOG_PATH, line, { encoding: "utf8", mode: 0o600 });
  await chmod(LOG_PATH, 0o600).catch(() => undefined);
}

function spawnCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["pipe", "pipe", "pipe"],
      ...options,
    });
    let stdout = "";
    let stderr = "";
    if (options.input) child.stdin.end(options.input);
    else child.stdin.end();
    child.stdout.on("data", (data) => {
      stdout += String(data);
    });
    child.stderr.on("data", (data) => {
      stderr += String(data);
    });
    child.on("error", reject);
    child.on("close", (code) => {
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
  const result = await spawnCommand("agent-browser", [...targetBrowserBaseArgs(), "close"], { allowFailure: true });
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
  const result = await spawnCommand("agent-browser", [...targetBrowserBaseArgs(), "--json", "stream", "status"], { allowFailure: true });
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
  if (targetDir === REAL_CHROME_USER_DATA_DIR || targetDir.startsWith(`${REAL_CHROME_USER_DATA_DIR}/`)) {
    throw new Error(`Oracle profileDir must not point into the real Chrome user-data directory: ${targetDir}`);
  }

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
  const result = await spawnCommand("agent-browser", args, { allowFailure: true });
  await log(`launch result: code=${result.code} stdout=${JSON.stringify(result.stdout)} stderr=${JSON.stringify(result.stderr)}`);
  if (result.code !== 0) {
    throw new Error(result.stderr || result.stdout || "Failed to launch isolated oracle browser");
  }
}

async function streamStatus() {
  const result = await spawnCommand("agent-browser", [...targetBrowserBaseArgs(), "--json", "stream", "status"], { allowFailure: true });
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
    (Object.hasOwn(maybeOptions, "allowFailure") || Object.hasOwn(maybeOptions, "input") || Object.hasOwn(maybeOptions, "cwd") || Object.hasOwn(maybeOptions, "logLabel"))
  ) {
    options = args.pop();
  }
  await ensureBrowserConnected();
  const result = await spawnCommand("agent-browser", [...targetBrowserBaseArgs(), ...args], options);
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

function cookieOrigins() {
  return Array.from(new Set([stripQuery(config.browser.chatUrl), ...CHATGPT_COOKIE_ORIGINS]));
}

function cookieSource() {
  return config.auth.chromeCookiePath || config.auth.chromeProfile;
}

function cookieSourceLabel() {
  return config.auth.chromeCookiePath
    ? `Chrome cookie DB ${config.auth.chromeCookiePath}`
    : `Chrome profile ${config.auth.chromeProfile}`;
}

async function readSourceCookies() {
  await log(`Reading ChatGPT cookies from ${cookieSourceLabel()}`);
  const { cookies, warnings } = await getCookies({
    url: config.browser.chatUrl,
    origins: cookieOrigins(),
    browsers: ["chrome"],
    mode: "merge",
    chromeProfile: cookieSource(),
    timeoutMs: 5_000,
  });

  if (warnings.length) {
    await log(`sweet-cookie warnings: ${warnings.join(" | ")}`);
  }

  const filtered = filterImportableAuthCookies(cookies, config.browser.chatUrl);
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

  if (!hasSessionToken) {
    throw new Error(
      `No ChatGPT session-token cookies were found in ${cookieSourceLabel()}. Make sure ChatGPT is logged into that Chrome profile, or set auth.chromeProfile / auth.chromeCookiePath in ~/.pi/agent/extensions/oracle.json.`,
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
  await log("Clearing isolated browser cookies before seeding fresh ChatGPT cookies");
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
  if (!result || typeof result !== "object") {
    return { ok: false, status: 0, error: "invalid-probe-result" };
  }
  return {
    ok: result.ok === true,
    status: typeof result.status === "number" ? result.status : 0,
    pageUrl: typeof result.pageUrl === "string" ? result.pageUrl : undefined,
    domLoginCta: result.domLoginCta === true,
    onAuthPage: result.onAuthPage === true,
    error: typeof result.error === "string" ? result.error : undefined,
    bodyKeys: Array.isArray(result.bodyKeys) ? result.bodyKeys : [],
    bodyHasId: result.bodyHasId === true,
    bodyHasEmail: result.bodyHasEmail === true,
    name: typeof result.name === "string" ? result.name : undefined,
    responsePreview: typeof result.responsePreview === "string" ? result.responsePreview : undefined,
  };
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
  const text = `${snapshot}\n${body}`;
  const allowedOrigins = [new URL(config.browser.chatUrl).origin, new URL(config.browser.authUrl).origin, "https://auth.openai.com"];

  const challengePatterns = [
    /just a moment/i,
    /verify you are human/i,
    /cloudflare/i,
    /captcha|turnstile|hcaptcha/i,
    /unusual activity detected/i,
    /we detect suspicious activity/i,
  ];
  if (challengePatterns.some((pattern) => pattern.test(text))) {
    return {
      state: "challenge_blocking",
      message:
        `ChatGPT challenge detected after syncing cookies from ${cookieSourceLabel()}. ` +
        `The isolated oracle browser was left open on profile ${runtimeProfileDir}; complete the challenge there, then rerun /oracle-auth. Logs: ${LOG_PATH}`,
    };
  }

  if (/http error 431|request header or cookie too large/i.test(text)) {
    return {
      state: "login_required",
      message:
        `Imported auth hit HTTP 431 during ChatGPT auth resolution, which usually means the imported cookie set is too large or stale. ` +
        `Inspect ${LOG_PATH}.`,
    };
  }

  const outagePatterns = [
    /something went wrong/i,
    /a network error occurred/i,
    /an error occurred while connecting to the websocket/i,
    /try again later/i,
  ];
  if (outagePatterns.some((pattern) => pattern.test(text))) {
    return { state: "transient_outage_error", message: `ChatGPT is showing a transient outage/error page. Logs: ${LOG_PATH}` };
  }

  const onAllowedOrigin = allowedOrigins.some((origin) => url.startsWith(origin));
  const hasComposer = snapshot.includes(`textbox \"${CHATGPT_LABELS.composer}\"`);
  const hasAddFiles = snapshot.includes(`button \"${CHATGPT_LABELS.addFiles}\"`);
  const hasModelControl =
    snapshot.includes('button "Model selector"') ||
    /button "(Instant|Thinking|Pro)(?: [^"]*)?"/.test(snapshot);

  if (probe?.status === 401 || probe?.status === 403) {
    return {
      state: "login_required",
      message:
        `Synced cookies from ${cookieSourceLabel()}, but ChatGPT still rejected the session ` +
        `(status=${probe?.status ?? 0}). Check auth.chromeProfile/auth.chromeCookiePath and inspect ${LOG_PATH}.`,
    };
  }

  if (probe?.onAuthPage) {
    if (probe?.bodyHasId || probe?.bodyHasEmail) {
      return {
        state: "auth_transitioning",
        message:
          `ChatGPT is on /auth/login, but /backend-api/me returned a partial authenticated session. ` +
          `Trying to drive the login resolution flow. Logs: ${LOG_PATH}`,
      };
    }
    return {
      state: "login_required",
      message:
        `Synced cookies from ${cookieSourceLabel()}, but ChatGPT still rejected the session ` +
        `(status=${probe?.status ?? 0}). Check auth.chromeProfile/auth.chromeCookiePath and inspect ${LOG_PATH}.`,
    };
  }

  if (onAllowedOrigin && probe?.status === 200 && hasComposer && hasAddFiles && hasModelControl) {
    if (!probe?.domLoginCta) {
      return {
        state: "authenticated_and_ready",
        message: `Imported ChatGPT auth from ${cookieSourceLabel()} into the isolated oracle profile. Logs: ${LOG_PATH}`,
      };
    }

    return {
      state: "auth_transitioning",
      message:
        probe?.bodyHasId || probe?.bodyHasEmail
          ? `ChatGPT backend session is authenticated but the shell still shows public CTA chrome. Logs: ${LOG_PATH}`
          : `ChatGPT accepted cookies but is still hydrating/auth-selecting. Logs: ${LOG_PATH}`,
    };
  }

  if (onAllowedOrigin && probe?.ok && hasComposer && hasAddFiles && hasModelControl) {
    return {
      state: "authenticated_and_ready",
      message: `Imported ChatGPT auth from ${cookieSourceLabel()} into the isolated oracle profile. Logs: ${LOG_PATH}`,
    };
  }

  if (url && !onAllowedOrigin) {
    return { state: "login_required", message: `Imported auth redirected away from the expected ChatGPT origin. Logs: ${LOG_PATH}` };
  }

  return { state: "unknown", message: `ChatGPT page state is not yet ready. Logs: ${LOG_PATH}` };
}

async function maybeSelectAccountIdentity(snapshot, probe) {
  const candidates = [];
  if (typeof probe?.name === "string" && probe.name.trim()) {
    candidates.push(probe.name.trim());
    const firstToken = probe.name.trim().split(/\s+/)[0];
    if (firstToken && firstToken !== probe.name.trim()) candidates.push(firstToken);
  }

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
      `poll ${iteration}: url=${JSON.stringify(url)} probe=${JSON.stringify(probe)} classification=${classification.state} hasComposer=${snapshot.includes(`textbox \"${CHATGPT_LABELS.composer}\"`)} hasAddFiles=${snapshot.includes(`button \"${CHATGPT_LABELS.addFiles}\"`)}`,
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
      throw new Error(classification.message);
    }
    await sleep(config.auth.pollMs);
  }
  await captureDiagnostics("timeout");
  throw new Error(`Timed out verifying synced ChatGPT cookies in the isolated oracle profile. Logs: ${LOG_PATH}`);
}

async function run() {
  await initLog();
  await withLock("auth", "global", { processPid: process.pid, action: "oracle-auth" }, async () => {
    let shouldPreserveBrowser = false;
    let committedProfile = false;
    let profilePlan;
    try {
      profilePlan = await createProfilePlan(config.browser.authSeedProfileDir);
      await log(`Starting oracle auth bootstrap`);
      await log(
        `Config summary: session=${authSessionName()} seedProfileDir=${profilePlan.targetDir} stagingProfileDir=${profilePlan.stagingDir} executable=${config.browser.executablePath || "(default)"} source=${cookieSourceLabel()}`,
      );
      const cookies = await readSourceCookies();
      await prepareStagedProfile(profilePlan);
      await launchTargetBrowser();
      const appliedCount = await seedCookiesIntoTarget(cookies);
      await log(`Cookie seeding complete: applied=${appliedCount}`);
      await openUrl(config.browser.chatUrl, config.browser.chatUrl);
      const classification = await waitForImportedAuthReady();
      await log(`Auth bootstrap success: ${classification.message}`);
      await closeTargetBrowser();
      await commitStagedProfile(profilePlan);
      const generation = new Date().toISOString();
      await writeFile(join(profilePlan.targetDir, ".oracle-seed-generation"), `${generation}\n`, { encoding: "utf8", mode: 0o600 });
      committedProfile = true;
      process.stdout.write(
        `${classification.message} Synced ${appliedCount} cookies into ${profilePlan.targetDir}`,
      );
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
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\nSee ${LOG_PATH} and diagnostics in /tmp/oracle-auth.*\nIf needed, ensure the configured real Chrome profile is already logged into ChatGPT and grant macOS Keychain access when prompted.`,
  );
  process.exit(1);
});
