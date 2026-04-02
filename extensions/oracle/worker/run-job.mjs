import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { appendFile, chmod, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { spawn } from "node:child_process";

const jobId = process.argv[2];
if (!jobId) {
  console.error("Usage: run-job.mjs <job-id>");
  process.exit(1);
}

const jobDir = `/tmp/oracle-${jobId}`;
const jobPath = `${jobDir}/job.json`;
const CHATGPT_LABELS = {
  composer: "Chat with ChatGPT",
  addFiles: "Add files and more",
  send: "Send prompt",
  close: "Close",
  autoSwitchToThinking: "Auto-switch to Thinking",
  configure: "Configure...",
};
const MODEL_FAMILY_PREFIX = {
  instant: "Instant ",
  thinking: "Thinking ",
  pro: "Pro ",
};

const ORACLE_STATE_DIR = "/tmp/pi-oracle-state";
const LOCKS_DIR = join(ORACLE_STATE_DIR, "locks");
const LEASES_DIR = join(ORACLE_STATE_DIR, "leases");
const SEED_GENERATION_FILE = ".oracle-seed-generation";
const ARTIFACT_CANDIDATE_STABILITY_TIMEOUT_MS = 15_000;
const ARTIFACT_CANDIDATE_STABILITY_POLL_MS = 1_500;
const ARTIFACT_CANDIDATE_STABILITY_POLLS = 2;
const ARTIFACT_DOWNLOAD_HEARTBEAT_MS = 10_000;
const ARTIFACT_DOWNLOAD_TIMEOUT_MS = 90_000;
const ARTIFACT_DOWNLOAD_MAX_ATTEMPTS = 2;

let currentJob;
let browserStarted = false;
let cleaningUpBrowser = false;
let cleaningUpRuntime = false;
let shuttingDown = false;
let lastHeartbeatMs = 0;

async function ensurePrivateDir(path) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  await chmod(path, 0o700).catch(() => undefined);
}

function leaseKey(kind, key) {
  return `${kind}-${createHash("sha256").update(key).digest("hex").slice(0, 24)}`;
}

async function acquireLock(kind, key, metadata, timeoutMs = 30_000) {
  const path = join(LOCKS_DIR, leaseKey(kind, key));
  const deadline = Date.now() + timeoutMs;
  await ensurePrivateDir(ORACLE_STATE_DIR);
  await ensurePrivateDir(LOCKS_DIR);

  while (Date.now() < deadline) {
    try {
      await mkdir(path, { recursive: false, mode: 0o700 });
      await secureWriteText(join(path, "metadata.json"), `${JSON.stringify(metadata, null, 2)}\n`);
      return path;
    } catch (error) {
      if (!(error && typeof error === "object" && "code" in error && error.code === "EEXIST")) throw error;
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

async function releaseLease(kind, key) {
  if (!key) return;
  await rm(join(LEASES_DIR, leaseKey(kind, key)), { recursive: true, force: true }).catch(() => undefined);
}

async function secureWriteText(path, content) {
  const tmpPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmpPath, content, { encoding: "utf8", mode: 0o600 });
  await chmod(tmpPath, 0o600).catch(() => undefined);
  await rename(tmpPath, path);
  await chmod(path, 0o600).catch(() => undefined);
}

async function secureAppendText(path, content) {
  await appendFile(path, content, { encoding: "utf8", mode: 0o600 });
  await chmod(path, 0o600).catch(() => undefined);
}

async function readJobUnlocked() {
  return JSON.parse(await readFile(jobPath, "utf8"));
}

async function readJob() {
  return readJobUnlocked();
}

async function writeJobUnlocked(job) {
  await secureWriteText(jobPath, `${JSON.stringify(job, null, 2)}\n`);
}

async function writeJob(job) {
  await withLock("job", jobId, { processPid: process.pid, action: "writeJob" }, async () => {
    await writeJobUnlocked(job);
  });
}

async function mutateJob(mutator) {
  return withLock("job", jobId, { processPid: process.pid, action: "mutateJob" }, async () => {
    const job = await readJobUnlocked();
    const next = mutator(job);
    await writeJobUnlocked(next);
    currentJob = next;
    return next;
  });
}

function phasePatch(phase, patch = undefined, at = new Date().toISOString()) {
  return {
    ...(patch || {}),
    phase,
    phaseAt: at,
  };
}

async function heartbeat(patch = undefined, options = {}) {
  const now = Date.now();
  const force = options.force === true;
  if (!force && !patch && now - lastHeartbeatMs < 10_000) return;
  lastHeartbeatMs = now;
  const heartbeatAt = new Date(now).toISOString();
  await mutateJob((job) => ({
    ...job,
    ...(patch || {}),
    heartbeatAt,
  }));
}

async function log(message) {
  const line = `[${new Date().toISOString()}] ${message}\n`;
  await secureAppendText(`${jobDir}/logs/worker.log`, line);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function spawnCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const { timeoutMs, ...spawnOptions } = options;
    const child = spawn(command, args, {
      stdio: ["pipe", "pipe", "pipe"],
      ...spawnOptions,
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let killTimer;
    if (typeof timeoutMs === "number" && timeoutMs > 0) {
      killTimer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
        setTimeout(() => child.kill("SIGKILL"), 2_000).unref?.();
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
    child.on("close", (code) => {
      if (killTimer) clearTimeout(killTimer);
      if (timedOut) {
        const error = new Error(stderr || stdout || `${command} timed out after ${timeoutMs}ms`);
        if (options.allowFailure) resolve({ code, stdout: stdout.trim(), stderr: error.message });
        else reject(error);
        return;
      }
      if (code === 0 || options.allowFailure) resolve({ code, stdout: stdout.trim(), stderr: stderr.trim() });
      else reject(new Error(stderr || stdout || `${command} exited with code ${code}`));
    });
    child.on("error", (error) => {
      if (killTimer) clearTimeout(killTimer);
      reject(error);
    });
  });
}

function parseConversationId(chatUrl) {
  if (!chatUrl) return undefined;
  try {
    const parsed = new URL(chatUrl);
    const match = parsed.pathname.match(/\/c\/([^/?#]+)/i);
    return match?.[1];
  } catch {
    return undefined;
  }
}

async function cloneSeedProfileToRuntime(job) {
  const seedDir = job.config.browser.authSeedProfileDir;
  if (!existsSync(seedDir)) {
    throw new Error(`Oracle auth seed profile not found: ${seedDir}. Run /oracle-auth first.`);
  }

  const seedGenerationPath = join(seedDir, SEED_GENERATION_FILE);
  const seedGeneration = existsSync(seedGenerationPath) ? (await readFile(seedGenerationPath, "utf8")).trim() || undefined : undefined;

  await withLock("auth", "global", { jobId: job.id, processPid: process.pid, action: "cloneSeedProfile" }, async () => {
    await rm(job.runtimeProfileDir, { recursive: true, force: true }).catch(() => undefined);
    await ensurePrivateDir(dirname(job.runtimeProfileDir));
    const cloneArgs = job.config.browser.cloneStrategy === "apfs-clone" ? ["-cR", seedDir, job.runtimeProfileDir] : ["-R", seedDir, job.runtimeProfileDir];
    await spawnCommand("cp", cloneArgs);
  }, 10 * 60 * 1000);

  return seedGeneration;
}

async function cleanupRuntime(job) {
  if (!job || cleaningUpRuntime) return;
  cleaningUpRuntime = true;
  try {
    await closeBrowser(job).catch(() => undefined);
    await releaseLease("conversation", job.conversationId).catch(() => undefined);
    await releaseLease("runtime", job.runtimeId).catch(() => undefined);
    await rm(job.runtimeProfileDir, { recursive: true, force: true }).catch(() => undefined);
  } finally {
    cleaningUpRuntime = false;
  }
}

function browserBaseArgs(job, options = {}) {
  const args = ["--session", job.runtimeSessionName];
  if (options.withLaunchOptions) {
    args.push("--profile", job.runtimeProfileDir);
    if (job.config.browser.executablePath) args.push("--executable-path", job.config.browser.executablePath);
    if (job.config.browser.userAgent) args.push("--user-agent", job.config.browser.userAgent);
    if (Array.isArray(job.config.browser.args) && job.config.browser.args.length > 0) args.push("--args", job.config.browser.args.join(","));
    if (options.mode === "headed") args.push("--headed");
  }
  return args;
}

async function closeBrowser(job) {
  if (cleaningUpBrowser) return;
  cleaningUpBrowser = true;
  try {
    await spawnCommand("agent-browser", [...browserBaseArgs(job), "close"], { allowFailure: true });
  } finally {
    browserStarted = false;
    cleaningUpBrowser = false;
  }
}

async function launchBrowser(job, url) {
  await closeBrowser(job);
  const mode = job.config.browser.runMode;
  await spawnCommand("agent-browser", [...browserBaseArgs(job, { withLaunchOptions: true, mode }), "open", url]);
  browserStarted = true;
}

async function streamStatus(job) {
  const { stdout } = await spawnCommand("agent-browser", [...browserBaseArgs(job), "--json", "stream", "status"], { allowFailure: true });
  try {
    const parsed = JSON.parse(stdout || "{}");
    return parsed?.data || {};
  } catch {
    return {};
  }
}

async function ensureBrowserConnected(job) {
  if (!browserStarted || cleaningUpBrowser) return;
  const status = await streamStatus(job);
  if (status.connected === false) {
    throw new Error("The isolated oracle browser disconnected during the job.");
  }
}

async function agentBrowser(job, ...args) {
  let options;
  const maybeOptions = args.at(-1);
  if (
    maybeOptions &&
    typeof maybeOptions === "object" &&
    !Array.isArray(maybeOptions) &&
    (Object.hasOwn(maybeOptions, "allowFailure") ||
      Object.hasOwn(maybeOptions, "input") ||
      Object.hasOwn(maybeOptions, "cwd") ||
      Object.hasOwn(maybeOptions, "timeoutMs"))
  ) {
    options = args.pop();
  }
  await ensureBrowserConnected(job);
  return spawnCommand("agent-browser", [...browserBaseArgs(job), ...args], options);
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

function toJsonScript(expression) {
  return `JSON.stringify((() => { ${expression} })(), null, 2)`;
}

async function evalPage(job, script) {
   const result = await agentBrowser(job, "eval", "--stdin", { input: script });
   return parseEvalResult(result.stdout);
}

async function loginProbe(job) {
  const result = await evalPage(job, buildLoginProbeScript(5_000));
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
  };
}

async function currentUrl(job) {
  const { stdout } = await agentBrowser(job, "get", "url");
  return stdout;
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

async function snapshotText(job) {
  const { stdout } = await agentBrowser(job, "snapshot", "-i");
  return stdout;
}

async function pageText(job) {
  const { stdout } = await agentBrowser(job, "get", "text", "body", { allowFailure: true });
  return stdout || "";
}

function toAsyncJsonScript(expression) {
  return `(async () => JSON.stringify(await (async () => { ${expression} })(), null, 2))()`;
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
    };
  `);
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

function matchesModelFamilyButton(candidate, family) {
  return candidate.kind === "button" && typeof candidate.label === "string" && candidate.label.startsWith(MODEL_FAMILY_PREFIX[family]) && !candidate.disabled;
}

function titleCase(value) {
  return value ? `${value[0].toUpperCase()}${value.slice(1)}` : value;
}

function requestedEffortLabel(job) {
  return job.effort ? titleCase(job.effort) : undefined;
}

function effortSelectionVisible(snapshot, effortLabel) {
  if (!effortLabel) return true;
  const entries = parseSnapshotEntries(snapshot);
  return entries.some((entry) => {
    if (entry.disabled) return false;
    if (entry.kind === "combobox" && entry.value === effortLabel) return true;
    if (entry.kind !== "button") return false;
    const label = String(entry.label || "").toLowerCase();
    const normalizedEffort = effortLabel.toLowerCase();
    return (
      label === normalizedEffort ||
      label === `${normalizedEffort} thinking` ||
      label === `${normalizedEffort}, click to remove` ||
      label === `${normalizedEffort} thinking, click to remove`
    );
  });
}

function thinkingChipVisible(snapshot) {
  return /button "(?:Light|Standard|Extended|Heavy)(?: thinking)?(?:, click to remove)?"/i.test(snapshot);
}

function snapshotHasModelConfigurationUi(snapshot) {
  const entries = parseSnapshotEntries(snapshot);
  const visibleFamilies = new Set(
    entries
      .filter((entry) => entry.kind === "button" && typeof entry.label === "string")
      .flatMap((entry) =>
        Object.entries(MODEL_FAMILY_PREFIX)
          .filter(([, prefix]) => entry.label.startsWith(prefix))
          .map(([family]) => family),
      ),
  );
  const hasCloseButton = entries.some((entry) => entry.kind === "button" && entry.label === CHATGPT_LABELS.close && !entry.disabled);
  const hasEffortCombobox = entries.some(
    (entry) => entry.kind === "combobox" && ["Light", "Standard", "Extended", "Heavy"].includes(entry.value || "") && !entry.disabled,
  );
  return visibleFamilies.size >= 2 || hasCloseButton || hasEffortCombobox;
}

function snapshotStronglyMatchesRequestedModel(snapshot, job) {
  const entries = parseSnapshotEntries(snapshot);
  const familyMatched = entries.some((entry) => matchesModelFamilyButton(entry, job.chatModelFamily));
  if (job.chatModelFamily === "thinking") {
    return familyMatched || effortSelectionVisible(snapshot, requestedEffortLabel(job));
  }
  if (job.chatModelFamily === "pro") {
    return familyMatched;
  }
  return familyMatched;
}

function snapshotWeaklyMatchesRequestedModel(snapshot, job) {
  if (job.chatModelFamily === "thinking") {
    return effortSelectionVisible(snapshot, requestedEffortLabel(job));
  }
  if (job.chatModelFamily === "pro") {
    return !thinkingChipVisible(snapshot);
  }
  if (job.chatModelFamily === "instant") {
    return !thinkingChipVisible(snapshot);
  }
  return false;
}

async function clickRef(job, ref) {
  await agentBrowser(job, "click", ref);
}

async function clickLabeledEntry(job, label, options = {}) {
  const snapshot = await snapshotText(job);
  const entry = (options.last ? findLastEntry : findEntry)(
    snapshot,
    (candidate) => candidate.label === label && (!options.kind || candidate.kind === options.kind) && !candidate.disabled,
  );
  if (!entry) throw new Error(`Could not find labeled entry: ${label}`);
  await clickRef(job, entry.ref);
  return entry;
}

async function maybeClickLabeledEntry(job, label, options = {}) {
  const snapshot = await snapshotText(job);
  const entry = (options.last ? findLastEntry : findEntry)(
    snapshot,
    (candidate) => candidate.label === label && (!options.kind || candidate.kind === options.kind) && !candidate.disabled,
  );
  if (!entry) return false;
  await clickRef(job, entry.ref);
  return true;
}

async function openEffortDropdown(job) {
  const snapshot = await snapshotText(job);
  const effortLabels = new Set(["Light", "Standard", "Extended", "Heavy"]);
  const entry = findEntry(
    snapshot,
    (candidate) => candidate.kind === "combobox" && candidate.value && effortLabels.has(candidate.value) && !candidate.disabled,
  );
  if (!entry) return false;
  await clickRef(job, entry.ref);
  return true;
}

async function setComposerText(job, text) {
  const snapshot = await snapshotText(job);
  const entry = findEntry(snapshot, (candidate) => candidate.kind === "textbox" && candidate.label === CHATGPT_LABELS.composer);
  if (!entry) throw new Error("Could not find ChatGPT composer textbox");
  await agentBrowser(job, "fill", entry.ref, text);
}

function classifyChatPage({ job, url, snapshot, body, probe }) {
  const text = `${snapshot}\n${body}`;
  const challengePatterns = [
    /just a moment/i,
    /verify you are human/i,
    /cloudflare/i,
    /captcha|turnstile|hcaptcha/i,
    /unusual activity detected/i,
    /we detect suspicious activity/i,
  ];
  if (challengePatterns.some((pattern) => pattern.test(text))) {
    return { state: "challenge_blocking", message: "ChatGPT is showing a challenge/verification page" };
  }

  const outagePatterns = [
    /something went wrong/i,
    /a network error occurred/i,
    /an error occurred while connecting to the websocket/i,
    /try again later/i,
    /rate limit/i,
  ];
  if (outagePatterns.some((pattern) => pattern.test(text))) {
    return { state: "transient_outage_error", message: "ChatGPT is showing a transient outage/error page" };
  }

  const allowedOrigins = [new URL(job.config.browser.chatUrl).origin, "https://auth.openai.com"];
  const onAllowedOrigin = typeof url === "string" && allowedOrigins.some((origin) => url.startsWith(origin));
  const onAuthPath = typeof url === "string" && url.includes("/auth/");
  const hasComposer = snapshot.includes(`textbox "${CHATGPT_LABELS.composer}"`);
  const hasAddFiles = snapshot.includes(`button "${CHATGPT_LABELS.addFiles}"`);
  const hasModelControl = snapshot.includes('button "Model selector"') || /button "(Instant|Thinking|Pro)(?: [^"]*)?"/.test(snapshot);

  if (probe?.status === 401 || probe?.status === 403) {
    return { state: "login_required", message: "ChatGPT login is required. Run /oracle-auth." };
  }

  if (onAuthPath || probe?.onAuthPage) {
    if (probe?.bodyHasId || probe?.bodyHasEmail) {
      return {
        state: "auth_transitioning",
        message: "ChatGPT is on an auth page even though the backend session is partially authenticated. Rerun /oracle-auth.",
      };
    }
    return { state: "login_required", message: "ChatGPT login is required. Run /oracle-auth." };
  }

  if (onAllowedOrigin && probe?.status === 200 && hasComposer && hasAddFiles && hasModelControl) {
    if (probe?.domLoginCta && (probe?.bodyHasId || probe?.bodyHasEmail)) {
      return {
        state: "auth_transitioning",
        message: "ChatGPT backend session is authenticated, but the web shell still shows public login CTA chrome. Rerun /oracle-auth.",
      };
    }
    return { state: "authenticated_and_ready", message: "ChatGPT is authenticated and ready." };
  }

  if (url && !onAllowedOrigin) {
    return { state: "login_required", message: "ChatGPT redirected away from the expected authenticated chat origin." };
  }

  return { state: "unknown", message: "ChatGPT page is not ready yet." };
}

async function captureDiagnostics(job, reason) {
  if (!browserStarted) return;
  try {
    const [url, snapshot, body] = await Promise.all([
      currentUrl(job).catch(() => ""),
      snapshotText(job).catch(() => ""),
      pageText(job).catch(() => ""),
    ]);
    await secureWriteText(join(job.logsDir, `${reason}.url.txt`), `${url || ""}\n`);
    await secureWriteText(join(job.logsDir, `${reason}.snapshot.txt`), `${snapshot || ""}\n`);
    await secureWriteText(join(job.logsDir, `${reason}.body.txt`), `${body || ""}\n`);
    await agentBrowser(job, "screenshot", join(job.logsDir, `${reason}.png`)).catch(() => undefined);
  } catch {
    // best effort only
  }
}

async function waitForOracleReady(job) {
  const startedAt = Date.now();
  const timeoutAt = startedAt + 30_000;
  let retriedOutage = false;
  let retriedAuthTransition = false;

  while (Date.now() < timeoutAt) {
    const [url, snapshot, body, probe] = await Promise.all([
      currentUrl(job).catch(() => ""),
      snapshotText(job).catch(() => ""),
      pageText(job).catch(() => ""),
      loginProbe(job).catch(() => ({ ok: false, status: 0, error: "probe-failed" })),
    ]);
    const classification = classifyChatPage({ job, url, snapshot, body, probe });
    if (classification.state === "authenticated_and_ready") return;
    if (classification.state === "auth_transitioning") {
      const elapsedMs = Date.now() - startedAt;
      if (!retriedAuthTransition && elapsedMs >= 5_000) {
        retriedAuthTransition = true;
        await agentBrowser(job, "reload").catch(() => undefined);
        await sleep(1500);
        continue;
      }
      if (elapsedMs >= 15_000) {
        await captureDiagnostics(job, "preflight-auth-transition");
        throw new Error("ChatGPT backend session is authenticated, but the web shell stayed in a partially logged-in state. Rerun /oracle-auth.");
      }
      await sleep(1000);
      continue;
    }
    if (classification.state === "transient_outage_error" && !retriedOutage) {
      retriedOutage = true;
      await agentBrowser(job, "reload").catch(() => undefined);
      await sleep(1500);
      continue;
    }
    if (classification.state !== "unknown") {
      await captureDiagnostics(job, "preflight");
      throw new Error(classification.message);
    }
    await sleep(1000);
  }

  await captureDiagnostics(job, "preflight-timeout");
  throw new Error("Timed out waiting for the ChatGPT chat UI to become ready");
}

function detectUploadErrorText(text) {
  const patterns = [
    "Failed upload",
    "upload failed",
    "files.oaiusercontent.com",
    "Please ensure your network settings allow access to this site",
    "could not upload",
  ];
  return patterns.find((pattern) => text.toLowerCase().includes(pattern.toLowerCase()));
}

function composerSnapshotSlice(snapshot) {
  const lines = snapshot.split("\n");
  let composerIndex = -1;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (lines[index].includes(`textbox "${CHATGPT_LABELS.composer}"`)) {
      composerIndex = index;
      break;
    }
  }
  if (composerIndex === -1) return snapshot;
  const startIndex = Math.max(0, composerIndex - 16);
  const endIndex = Math.min(lines.length, composerIndex + 16);
  return lines.slice(startIndex, endIndex).join("\n");
}

function composerFileEntryCount(snapshot, fileLabel) {
  const composerSlice = composerSnapshotSlice(snapshot);
  return parseSnapshotEntries(composerSlice).filter((candidate) => candidate.label === fileLabel).length;
}

async function waitForUploadConfirmed(job, fileLabel, baselineCount) {
  const timeoutAt = Date.now() + 10 * 60 * 1000;
  let stableCount = 0;

  while (Date.now() < timeoutAt) {
    await heartbeat();
    const [snapshot, body] = await Promise.all([snapshotText(job), pageText(job).catch(() => "")]);

    const errorText = detectUploadErrorText(`${snapshot}\n${body}`);
    if (errorText) {
      throw new Error(`Upload error detected: ${errorText}`);
    }

    const sendEntry = findEntry(
      snapshot,
      (candidate) => candidate.kind === "button" && candidate.label === CHATGPT_LABELS.send && !candidate.disabled,
    );
    const fileCount = composerFileEntryCount(snapshot, fileLabel);

    if (sendEntry && fileCount > baselineCount) {
      stableCount += 1;
      if (stableCount >= 2) return sendEntry;
    } else {
      stableCount = 0;
    }

    await sleep(1000);
  }

  throw new Error(`Timed out waiting for upload confirmation for ${fileLabel}`);
}

async function waitForSendReady(job) {
  const timeoutAt = Date.now() + 5 * 60 * 1000;
  while (Date.now() < timeoutAt) {
    await heartbeat();
    const snapshot = await snapshotText(job);
    const body = await pageText(job).catch(() => "");
    const errorText = detectUploadErrorText(`${snapshot}\n${body}`);
    if (errorText) {
      throw new Error(`Upload error detected: ${errorText}`);
    }

    const entry = findEntry(
      snapshot,
      (candidate) => candidate.kind === "button" && candidate.label === CHATGPT_LABELS.send && !candidate.disabled,
    );
    if (entry) return entry;
    await sleep(1000);
  }
  throw new Error(`Timed out waiting for ${CHATGPT_LABELS.send} to become enabled`);
}

async function clickSend(job) {
  const entry = await waitForSendReady(job);
  await clickRef(job, entry.ref);
}

async function openModelConfiguration(job) {
  const openerPredicates = [
    (candidate) => candidate.kind === "button" && candidate.label === "Model selector" && !candidate.disabled,
    (candidate) => candidate.kind === "button" && ["Instant", "Thinking", "Pro"].includes(candidate.label || "") && !candidate.disabled,
  ];

  const initialSnapshot = await snapshotText(job);
  if (snapshotHasModelConfigurationUi(initialSnapshot)) return initialSnapshot;

  for (const predicate of openerPredicates) {
    const snapshot = await snapshotText(job);
    const entry = findEntry(snapshot, predicate);
    if (!entry) continue;
    await clickRef(job, entry.ref);
    await agentBrowser(job, "wait", "800");
    const after = await snapshotText(job);
    if (snapshotHasModelConfigurationUi(after)) return after;

    const configureEntry = findEntry(
      after,
      (candidate) => candidate.kind === "menuitem" && candidate.label === CHATGPT_LABELS.configure && !candidate.disabled,
    );

    if (configureEntry) {
      await clickRef(job, configureEntry.ref);
      await agentBrowser(job, "wait", "1200");
      const postConfigure = await snapshotText(job);
      if (snapshotHasModelConfigurationUi(postConfigure)) return postConfigure;
    }
  }

  throw new Error("Could not open model configuration UI");
}

async function configureModel(job) {
  const initialSnapshot = await snapshotText(job);
  if (snapshotStronglyMatchesRequestedModel(initialSnapshot, job)) {
    await log(`Model already appears configured for family=${job.chatModelFamily} effort=${job.effort || "(none)"}; skipping reconfiguration`);
    return;
  }

  await log(`Configuring model family=${job.chatModelFamily} effort=${job.effort || "(none)"}`);
  let familySnapshot = await openModelConfiguration(job);

  let familyEntry = findEntry(familySnapshot, (candidate) => matchesModelFamilyButton(candidate, job.chatModelFamily));
  if (!familyEntry && snapshotStronglyMatchesRequestedModel(familySnapshot, job)) {
    await log("Model configuration UI opened with requested settings already selected");
  }
  if (!familyEntry && !snapshotStronglyMatchesRequestedModel(familySnapshot, job)) {
    throw new Error(`Could not find model family button for ${job.chatModelFamily}`);
  }

  if (familyEntry) {
    await clickRef(job, familyEntry.ref);
    await agentBrowser(job, "wait", "800");
    familySnapshot = await snapshotText(job);
  }

  if (job.chatModelFamily === "thinking" || job.chatModelFamily === "pro") {
    const effortLabel = requestedEffortLabel(job);
    if (effortLabel && !effortSelectionVisible(familySnapshot, effortLabel)) {
      const opened = await openEffortDropdown(job);
      if (!opened) {
        throw new Error(`Could not open effort dropdown for requested effort: ${effortLabel}`);
      }
      await agentBrowser(job, "wait", "300");
      await clickLabeledEntry(job, effortLabel, { kind: "option" });
      await agentBrowser(job, "wait", "400");
      const effortSnapshot = await snapshotText(job);
      const selectedEffort = findEntry(
        effortSnapshot,
        (candidate) => candidate.kind === "combobox" && candidate.value === effortLabel && !candidate.disabled,
      );
      if (!selectedEffort && !effortSelectionVisible(effortSnapshot, effortLabel)) {
        throw new Error(`Requested effort did not remain selected: ${effortLabel}`);
      }
    }
  }

  if (job.chatModelFamily === "instant" && job.autoSwitchToThinking) {
    await maybeClickLabeledEntry(job, CHATGPT_LABELS.autoSwitchToThinking);
  }

  if (!(await maybeClickLabeledEntry(job, CHATGPT_LABELS.close, { kind: "button" }))) {
    await agentBrowser(job, "press", "Escape").catch(() => undefined);
  }
  await agentBrowser(job, "wait", "500");

  const postCloseSnapshot = await snapshotText(job);
  if (!snapshotWeaklyMatchesRequestedModel(postCloseSnapshot, job)) {
    throw new Error(`Could not verify requested model settings after configuration for ${job.chatModelFamily}`);
  }
}

async function uploadArchive(job) {
  if (!existsSync(job.archivePath)) {
    throw new Error(`Archive missing: ${job.archivePath}`);
  }

  const fileLabel = basename(job.archivePath);
  const addFilesSnapshot = await snapshotText(job);
  const baselineComposerFileCount = composerFileEntryCount(addFilesSnapshot, fileLabel);
  const addFilesEntry = findEntry(
    addFilesSnapshot,
    (candidate) => candidate.label === CHATGPT_LABELS.addFiles && candidate.kind === "button",
  );
  if (!addFilesEntry) {
    throw new Error(`Could not find "${CHATGPT_LABELS.addFiles}" button`);
  }

  await clickRef(job, addFilesEntry.ref);
  await agentBrowser(job, "wait", "500");
  await agentBrowser(job, "upload", "input[type=file]", job.archivePath);
  await log(`Selected archive for upload: ${job.archivePath}`);
  await waitForUploadConfirmed(job, fileLabel, baselineComposerFileCount);
  await log(`Upload confirmed for: ${fileLabel}`);
  await rm(job.archivePath, { force: true });
  await mutateJob((current) => ({ ...current, archiveDeletedAfterUpload: true }));
}

async function assistantMessages(job) {
  const result = await evalPage(
    job,
    toJsonScript(`
      const headings = Array.from(document.querySelectorAll('h1,h2,h3,h4,h5,h6,[role="heading"]'))
        .filter((el) => (el.textContent || '').trim() === 'ChatGPT said:');
      const renderText = (node) => {
        if (!node) return '';
        const clone = node.cloneNode(true);
        const host = document.createElement('div');
        host.style.position = 'fixed';
        host.style.left = '-99999px';
        host.style.top = '0';
        host.style.whiteSpace = 'pre-wrap';
        host.style.pointerEvents = 'none';
        host.appendChild(clone);
        document.body.appendChild(host);
        let text = (host.innerText || host.textContent || '').trim();
        host.remove();
        const endings = ['\\nChatGPT can make mistakes. Check important info.'];
        for (const ending of endings) {
          if (text.includes(ending)) text = text.split(ending)[0].trim();
        }
        text = text
          .split('\\n')
          .map((line) => line.trimEnd())
          .filter((line) => line.trim() && !/^Thought for\\b/i.test(line.trim()))
          .join('\\n')
          .trim();
        return text;
      };
      return {
        messages: headings.map((heading) => ({ text: renderText(heading.nextElementSibling) })),
      };
    `),
  );

  if (!Array.isArray(result?.messages)) return [];
  return result.messages.map((message) => ({ text: typeof message?.text === "string" ? message.text : "" }));
}

function assistantSnapshotSlice(snapshot, responseIndex) {
  const lines = snapshot.split("\n");
  const assistantHeadingIndices = lines.flatMap((line, index) => (line.includes('heading "ChatGPT said:"') ? [index] : []));
  const startIndex = assistantHeadingIndices[responseIndex];
  if (startIndex === undefined) return undefined;

  const endCandidates = [];
  const nextAssistantIndex = assistantHeadingIndices[responseIndex + 1];
  if (nextAssistantIndex !== undefined) endCandidates.push(nextAssistantIndex);

  const composerIndex = lines.findIndex(
    (line, index) => index > startIndex && line.includes(`textbox "${CHATGPT_LABELS.composer}"`),
  );
  if (composerIndex !== -1) endCandidates.push(composerIndex);

  const endIndex = endCandidates.length > 0 ? Math.min(...endCandidates) : undefined;
  return lines.slice(startIndex, endIndex).join("\n");
}

async function waitForStableChatUrl(job, previousChatUrl) {
  const timeoutAt = Date.now() + 60_000;
  let lastUrl = "";
  let stableCount = 0;

  while (Date.now() < timeoutAt) {
    await heartbeat();
    const url = stripQuery(await currentUrl(job));
    let isConversationUrl = false;
    try {
      isConversationUrl = /\/c\/[A-Za-z0-9-]+$/i.test(new URL(url).pathname);
    } catch {
      isConversationUrl = false;
    }
    const isKnownFollowUpUrl = previousChatUrl ? stripQuery(previousChatUrl) === url : false;

    if (isConversationUrl || isKnownFollowUpUrl) {
      if (url === lastUrl) stableCount += 1;
      else stableCount = 1;
      lastUrl = url;
      if (stableCount >= 2) return url;
    }

    await sleep(1000);
  }

  return previousChatUrl || stripQuery(await currentUrl(job));
}

async function waitForChatCompletion(job, baselineAssistantCount) {
  const timeoutAt = Date.now() + job.config.worker.completionTimeoutMs;
  let lastText = "";
  let stableCount = 0;

  while (Date.now() < timeoutAt) {
    await heartbeat();
    const snapshot = await snapshotText(job);
    const hasStopStreaming = snapshot.includes("Stop streaming");
    const copyResponseCount = (snapshot.match(/Copy response/g) || []).length;
    const messages = await assistantMessages(job);
    const targetMessage = messages[baselineAssistantCount];
    const targetText = targetMessage?.text || "";
    const hasTargetCopyResponse = copyResponseCount > baselineAssistantCount;

    if (!hasStopStreaming && hasTargetCopyResponse && targetText) {
      if (targetText === lastText) stableCount += 1;
      else stableCount = 1;
      lastText = targetText;
      if (stableCount >= 2) {
        return { responseIndex: baselineAssistantCount, responseText: targetText };
      }
    }

    await sleep(job.config.worker.pollMs);
  }

  throw new Error("Timed out waiting for ChatGPT response completion");
}

async function sha256(path) {
  const buffer = await readFile(path);
  return createHash("sha256").update(buffer).digest("hex");
}

async function detectType(path) {
  const result = await spawnCommand("file", ["-b", path], { allowFailure: true });
  return result.stdout || "unknown";
}

function isLikelyArtifactLabel(label) {
  const normalized = String(label || "").trim();
  if (!normalized) return false;
  const upper = normalized.toUpperCase();
  if (upper === "ATTACHED" || upper === "DONE") return true;
  return /(?:^|[^\w])[^\n]*\.[A-Za-z0-9]{1,12}(?:$|[^\w])/.test(normalized);
}

function preferredArtifactName(label, index) {
  const normalized = String(label || "").trim();
  const fileNameMatch = normalized.match(/([A-Za-z0-9._-]+\.[A-Za-z0-9]{1,12})(?!.*[A-Za-z0-9._-]+\.[A-Za-z0-9]{1,12})/);
  if (fileNameMatch) return basename(fileNameMatch[1]).replace(/[^a-zA-Z0-9._-]/g, "_");
  return `artifact-${String(index + 1).padStart(2, "0")}`;
}

function artifactCandidatesFromEntries(entries) {
  const excluded = new Set([
    "Copy response",
    "Good response",
    "Bad response",
    "Share",
    "Switch model",
    "More actions",
    CHATGPT_LABELS.addFiles,
    "Start dictation",
    "Start Voice",
    "Model selector",
    "Open conversation options",
    "Scroll to bottom",
    CHATGPT_LABELS.close,
  ]);

  const seen = new Set();
  const candidates = [];
  for (const entry of entries) {
    if (!entry.label) continue;
    if (excluded.has(entry.label)) continue;
    if (entry.label.startsWith("Thought for ")) continue;
    if (entry.kind !== "button" && entry.kind !== "link") continue;
    if (!isLikelyArtifactLabel(entry.label)) continue;
    if (seen.has(entry.label)) continue;
    seen.add(entry.label);
    candidates.push({ label: entry.label });
  }
  return candidates;
}

async function collectArtifactCandidates(job, responseIndex) {
  const snapshot = await snapshotText(job);
  const targetSlice = assistantSnapshotSlice(snapshot, responseIndex);
  if (!targetSlice) return { snapshot, targetSlice, candidates: [] };
  return {
    snapshot,
    targetSlice,
    candidates: artifactCandidatesFromEntries(parseSnapshotEntries(targetSlice)),
  };
}

async function waitForStableArtifactCandidates(job, responseIndex) {
  const deadline = Date.now() + ARTIFACT_CANDIDATE_STABILITY_TIMEOUT_MS;
  let lastSignature;
  let stablePolls = 0;
  let latest = { snapshot: "", targetSlice: undefined, candidates: [] };

  while (Date.now() < deadline) {
    latest = await collectArtifactCandidates(job, responseIndex);
    const signature = latest.candidates.map((candidate) => candidate.label).join("\n");
    if (signature === lastSignature) stablePolls += 1;
    else {
      lastSignature = signature;
      stablePolls = 1;
    }
    if (stablePolls >= ARTIFACT_CANDIDATE_STABILITY_POLLS) return latest;
    await heartbeat();
    await sleep(ARTIFACT_CANDIDATE_STABILITY_POLL_MS);
  }

  return latest;
}

async function reopenConversationForArtifacts(job, responseIndex, reason) {
  const targetUrl = job.chatUrl || stripQuery(await currentUrl(job));
  await log(`Reopening conversation before artifact capture (${reason}): ${targetUrl}`);
  await agentBrowser(job, "open", targetUrl);
  await agentBrowser(job, "wait", "1500");
  return waitForStableArtifactCandidates(job, responseIndex);
}

async function withHeartbeatWhile(task, intervalMs = ARTIFACT_DOWNLOAD_HEARTBEAT_MS) {
  let inFlight = true;
  let heartbeatRunning = false;
  const timer = setInterval(() => {
    if (!inFlight || heartbeatRunning) return;
    heartbeatRunning = true;
    void heartbeat()
      .catch(() => undefined)
      .finally(() => {
        heartbeatRunning = false;
      });
  }, intervalMs);
  timer.unref?.();
  try {
    return await task();
  } finally {
    inFlight = false;
    clearInterval(timer);
  }
}

async function flushArtifactsState(artifacts) {
  await secureWriteText(`${jobDir}/artifacts.json`, `${JSON.stringify(artifacts, null, 2)}\n`);
  await mutateJob((current) => ({
    ...current,
    artifactPaths: artifacts.flatMap((artifact) => (artifact.copiedPath && existsSync(artifact.copiedPath) ? [artifact.copiedPath] : [])),
  }));
}

async function downloadArtifacts(job, responseIndex) {
  if (!job.config.artifacts.capture) {
    await secureWriteText(`${jobDir}/artifacts.json`, "[]\n");
    await mutateJob((current) => ({ ...current, artifactPaths: [] }));
    return [];
  }

  const { targetSlice, candidates } = await reopenConversationForArtifacts(job, responseIndex, "initial");
  if (!targetSlice) {
    await log(`No assistant response found in snapshot for response index ${responseIndex}`);
    await secureWriteText(`${jobDir}/artifacts.json`, "[]\n");
    await mutateJob((current) => ({ ...current, artifactPaths: [] }));
    return [];
  }

  await log(`Artifact candidates: ${candidates.map((candidate) => candidate.label).join(", ") || "(none)"}`);

  const artifactsDir = `${jobDir}/artifacts`;
  await ensurePrivateDir(artifactsDir);
  const artifacts = [];
  await flushArtifactsState(artifacts);

  for (const [index, candidate] of candidates.entries()) {
    let downloaded = false;
    for (let attempt = 1; attempt <= ARTIFACT_DOWNLOAD_MAX_ATTEMPTS && !downloaded; attempt += 1) {
      const freshSnapshot = await snapshotText(job);
      const freshSlice = assistantSnapshotSlice(freshSnapshot, responseIndex);
      if (!freshSlice) break;
      const freshEntries = parseSnapshotEntries(freshSlice);
      const entry = freshEntries.find(
        (artifactEntry) => artifactEntry.label === candidate.label && (artifactEntry.kind === "button" || artifactEntry.kind === "link") && !artifactEntry.disabled,
      );
      if (!entry) {
        await log(`Artifact "${candidate.label}" not found in fresh snapshot, skipping`);
        break;
      }

      const destinationPath = join(artifactsDir, preferredArtifactName(candidate.label, index));
      await rm(destinationPath, { force: true }).catch(() => undefined);
      try {
        await log(`Artifact "${candidate.label}" download attempt ${attempt}/${ARTIFACT_DOWNLOAD_MAX_ATTEMPTS} using ref ${entry.ref}`);
        await withHeartbeatWhile(() =>
          agentBrowser(job, "download", entry.ref, destinationPath, {
            timeoutMs: ARTIFACT_DOWNLOAD_TIMEOUT_MS,
          }),
        );
        await heartbeat(undefined, { force: true });
        await chmod(destinationPath, 0o600).catch(() => undefined);
        const [size, checksum, detectedType] = await Promise.all([
          stat(destinationPath).then((stats) => stats.size),
          sha256(destinationPath),
          detectType(destinationPath),
        ]);
        artifacts.push({
          displayName: candidate.label,
          fileName: basename(destinationPath),
          copiedPath: destinationPath,
          size,
          sha256: checksum,
          detectedType,
        });
        downloaded = true;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await rm(destinationPath, { force: true }).catch(() => undefined);
        await log(`Artifact "${candidate.label}" download failed on attempt ${attempt}/${ARTIFACT_DOWNLOAD_MAX_ATTEMPTS}: ${message}`);
        if (attempt >= ARTIFACT_DOWNLOAD_MAX_ATTEMPTS) {
          artifacts.push({ displayName: candidate.label, unconfirmed: true, error: message });
        } else {
          await reopenConversationForArtifacts(job, responseIndex, `retry ${attempt + 1} for ${candidate.label}`);
          await sleep(1_000);
        }
      } finally {
        await flushArtifactsState(artifacts);
      }
    }
  }

  return artifacts;
}

function installSignalHandlers(job) {
  const handleSignal = (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    void (async () => {
      await log(`Received ${signal}, cleaning up oracle runtime`);
      await cleanupRuntime(job);
      process.exit(0);
    })();
  };

  process.on("SIGTERM", () => handleSignal("SIGTERM"));
  process.on("SIGINT", () => handleSignal("SIGINT"));
}

async function run() {
  await ensurePrivateDir(jobDir);
  await ensurePrivateDir(`${jobDir}/logs`);
  currentJob = await readJob();
  installSignalHandlers(currentJob);

  try {
    await log(`Starting oracle worker for job ${currentJob.id}`);
    await heartbeat(phasePatch("cloning_runtime", { status: "waiting" }), { force: true });
    await closeBrowser(currentJob);

    const seedGeneration = await cloneSeedProfileToRuntime(currentJob);
    currentJob = await mutateJob((job) => ({ ...job, ...phasePatch("launching_browser", { seedGeneration, heartbeatAt: new Date().toISOString() }) }));

    const targetUrl = currentJob.chatUrl || currentJob.config.browser.chatUrl;
    await launchBrowser(currentJob, targetUrl);
    currentJob = await mutateJob((job) => ({ ...job, ...phasePatch("verifying_auth", { heartbeatAt: new Date().toISOString() }) }));
    await waitForOracleReady(currentJob);
    currentJob = await mutateJob((job) => ({ ...job, ...phasePatch("configuring_model", { heartbeatAt: new Date().toISOString() }) }));
    await configureModel(currentJob);
    currentJob = await mutateJob((job) => ({ ...job, ...phasePatch("uploading_archive", { heartbeatAt: new Date().toISOString() }) }));
    await uploadArchive(currentJob);
    await setComposerText(currentJob, await readFile(currentJob.promptPath, "utf8"));
    const baselineAssistantCount = (await assistantMessages(currentJob)).length;
    await log(`Assistant response count before send: ${baselineAssistantCount}`);
    await clickSend(currentJob);

    const chatUrl = await waitForStableChatUrl(currentJob, currentJob.chatUrl);
    const conversationId = parseConversationId(chatUrl) || currentJob.conversationId;
    currentJob = await mutateJob((job) => ({
      ...job,
      ...phasePatch("awaiting_response", { chatUrl, conversationId, heartbeatAt: new Date().toISOString() }),
    }));

    const completion = await waitForChatCompletion(currentJob, baselineAssistantCount);
    currentJob = await mutateJob((job) => ({ ...job, ...phasePatch("extracting_response", { heartbeatAt: new Date().toISOString() }) }));
    await secureWriteText(currentJob.responsePath, `${completion.responseText.trim()}\n`);
    currentJob = await mutateJob((job) => ({ ...job, ...phasePatch("downloading_artifacts", { heartbeatAt: new Date().toISOString() }) }));
    const artifacts = await downloadArtifacts(currentJob, completion.responseIndex);
    const artifactFailureCount = artifacts.filter((artifact) => artifact.unconfirmed || artifact.error).length;

    await heartbeat(
      phasePatch(artifactFailureCount > 0 ? "complete_with_artifact_errors" : "complete", {
        status: "complete",
        completedAt: new Date().toISOString(),
        responsePath: currentJob.responsePath,
        responseFormat: "text/plain",
        artifactFailureCount,
      }),
      { force: true },
    );
    const persistedJob = await readJob().catch(() => undefined);
    await log(`Persisted final status after completion write: ${persistedJob?.status || "unknown"}`);
    await log(`Job ${currentJob.id} complete`);
  } catch (error) {
    if (!shuttingDown) {
      const message = error instanceof Error ? error.message : String(error);
      await captureDiagnostics(currentJob, "failure");
      await log(`Job failed: ${message}`);
      await heartbeat(
        phasePatch("failed", {
          status: "failed",
          completedAt: new Date().toISOString(),
          error: message,
        }),
        { force: true },
      );
      process.exitCode = 1;
    }
  } finally {
    await cleanupRuntime(currentJob).catch(() => undefined);
  }
}

await run();
