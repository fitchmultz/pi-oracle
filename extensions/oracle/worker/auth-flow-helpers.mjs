// Purpose: Provide pure auth-bootstrap classification helpers for ChatGPT browser state handling.
// Responsibilities: Normalize login-probe payloads, classify ChatGPT auth page states, and derive account chooser candidate labels.
// Scope: Pure worker/auth decision logic only; browser I/O, logging, and side effects stay in auth-bootstrap.mjs.
// Usage: Imported by auth-bootstrap.mjs and sanity tests to exercise auth classification behavior without driving a browser.
// Invariants/Assumptions: Inputs are already captured snapshots/probe results from the live browser session; outputs are deterministic and side-effect free.

/** @typedef {import("./auth-flow-helpers.d.mts").OracleAuthLoginProbe} OracleAuthLoginProbe */
/** @typedef {import("./auth-flow-helpers.d.mts").OracleAuthPageClassification} OracleAuthPageClassification */

const DEFAULT_COMPOSER_LABEL = "Chat with ChatGPT";
const DEFAULT_ADD_FILES_LABEL = "Add files and more";

/**
 * @param {unknown} result
 * @returns {OracleAuthLoginProbe}
 */
export function normalizeLoginProbeResult(result) {
  if (!result || typeof result !== "object") {
    return { ok: false, status: 0, error: "invalid-probe-result" };
  }
  const value = /** @type {Record<string, unknown>} */ (result);
  return {
    ok: value.ok === true,
    status: typeof value.status === "number" ? value.status : 0,
    pageUrl: typeof value.pageUrl === "string" ? value.pageUrl : undefined,
    domLoginCta: value.domLoginCta === true,
    onAuthPage: value.onAuthPage === true,
    error: typeof value.error === "string" ? value.error : undefined,
    bodyKeys: Array.isArray(value.bodyKeys) ? value.bodyKeys.filter((entry) => typeof entry === "string") : [],
    bodyHasId: value.bodyHasId === true,
    bodyHasEmail: value.bodyHasEmail === true,
    name: typeof value.name === "string" ? value.name : undefined,
    responsePreview: typeof value.responsePreview === "string" ? value.responsePreview : undefined,
  };
}

/**
 * @param {string | undefined} name
 * @returns {string[]}
 */
export function buildAccountChooserCandidateLabels(name) {
  const normalized = typeof name === "string" ? name.trim() : "";
  if (!normalized) return [];
  const firstToken = normalized.split(/\s+/)[0] || "";
  return firstToken && firstToken !== normalized ? [normalized, firstToken] : [normalized];
}

/**
 * @param {{
 *   url: string;
 *   snapshot: string;
 *   body: string;
 *   probe?: OracleAuthLoginProbe;
 *   allowedOrigins: readonly string[];
 *   cookieSourceLabel: string;
 *   runtimeProfileDir: string;
 *   logPath: string;
 *   composerLabel?: string;
 *   addFilesLabel?: string;
 * }} args
 * @returns {OracleAuthPageClassification}
 */
export function classifyChatAuthPage(args) {
  const text = `${args.snapshot}\n${args.body}`;
  const composerLabel = args.composerLabel || DEFAULT_COMPOSER_LABEL;
  const addFilesLabel = args.addFilesLabel || DEFAULT_ADD_FILES_LABEL;
  const onAllowedOrigin = args.allowedOrigins.some((origin) => args.url.startsWith(origin));
  const hasComposer = args.snapshot.includes(`textbox "${composerLabel}"`);
  const hasAddFiles = args.snapshot.includes(`button "${addFilesLabel}"`);
  const hasModelControl =
    args.snapshot.includes('button "Model selector"') ||
    /button "(?:Instant|(?:(?:Light|Standard|Extended|Heavy) )?Thinking|(?:(?:Light|Standard|Extended|Heavy) )?Pro)(?:, click to remove)?"/i.test(args.snapshot);

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
        `ChatGPT challenge detected after syncing cookies from ${args.cookieSourceLabel}. ` +
        `The isolated oracle browser was left open on profile ${args.runtimeProfileDir}; complete the challenge there, then rerun /oracle-auth. Logs: ${args.logPath}`,
    };
  }

  if (/http error 431|request header or cookie too large/i.test(text)) {
    return {
      state: "login_required",
      message:
        `Imported auth hit HTTP 431 during ChatGPT auth resolution, which usually means the imported cookie set is too large or stale. ` +
        `Inspect ${args.logPath}.`,
    };
  }

  const outagePatterns = [
    /something went wrong/i,
    /a network error occurred/i,
    /an error occurred while connecting to the websocket/i,
    /try again later/i,
  ];
  if (outagePatterns.some((pattern) => pattern.test(text))) {
    return { state: "transient_outage_error", message: `ChatGPT is showing a transient outage/error page. Logs: ${args.logPath}` };
  }

  if (args.probe?.status === 401 || args.probe?.status === 403) {
    return {
      state: "login_required",
      message:
        `Synced cookies from ${args.cookieSourceLabel}, but ChatGPT still rejected the session ` +
        `(status=${args.probe?.status ?? 0}). Check auth.chromeProfile/auth.chromeCookiePath and inspect ${args.logPath}.`,
    };
  }

  if (args.probe?.onAuthPage) {
    if (args.probe?.bodyHasId || args.probe?.bodyHasEmail) {
      return {
        state: "auth_transitioning",
        message:
          `ChatGPT is on /auth/login, but /backend-api/me returned a partial authenticated session. ` +
          `Trying to drive the login resolution flow. Logs: ${args.logPath}`,
      };
    }
    return {
      state: "login_required",
      message:
        `Synced cookies from ${args.cookieSourceLabel}, but ChatGPT still rejected the session ` +
        `(status=${args.probe?.status ?? 0}). Check auth.chromeProfile/auth.chromeCookiePath and inspect ${args.logPath}.`,
    };
  }

  if (onAllowedOrigin && args.probe?.status === 200 && hasComposer && hasAddFiles && hasModelControl) {
    if (!args.probe?.domLoginCta) {
      return {
        state: "authenticated_and_ready",
        message: `Imported ChatGPT auth from ${args.cookieSourceLabel} into the isolated oracle profile. Logs: ${args.logPath}`,
      };
    }

    return {
      state: "auth_transitioning",
      message:
        args.probe?.bodyHasId || args.probe?.bodyHasEmail
          ? `ChatGPT backend session is authenticated but the shell still shows public CTA chrome. Logs: ${args.logPath}`
          : `ChatGPT accepted cookies but is still hydrating/auth-selecting. Logs: ${args.logPath}`,
    };
  }

  if (onAllowedOrigin && args.probe?.ok && hasComposer && hasAddFiles && hasModelControl) {
    return {
      state: "authenticated_and_ready",
      message: `Imported ChatGPT auth from ${args.cookieSourceLabel} into the isolated oracle profile. Logs: ${args.logPath}`,
    };
  }

  if (args.url && !onAllowedOrigin) {
    return { state: "login_required", message: `Imported auth redirected away from the expected ChatGPT origin. Logs: ${args.logPath}` };
  }

  return { state: "unknown", message: `ChatGPT page state is not yet ready. Logs: ${args.logPath}` };
}
