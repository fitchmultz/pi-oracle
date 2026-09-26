// Regression coverage for auth observations interrupted by navigation and
// ChatGPT's anonymous /backend-api/me responses. No real cookies or browser.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import test from "node:test";
import { classifyChatAuthPage, isAuthNavigationError, normalizeLoginProbeResult } from "../extensions/oracle/worker/auth-flow-helpers.mjs";
import { CHATGPT_COMPOSER_LABELS } from "../extensions/oracle/worker/chatgpt-ui-helpers.mjs";

const bootstrap = await readFile(new URL("../extensions/oracle/worker/auth-bootstrap.mjs", import.meta.url), "utf8");
const worker = await readFile(new URL("../extensions/oracle/worker/run-job.mjs", import.meta.url), "utf8");
function functionSource(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1);
  const end = source.indexOf("\n}", start) + 2;
  return `${source.slice(start - 6, start) === "async " ? "async " : ""}${source.slice(start, end)}`;
}
const readySnapshot = '- textbox "Chat with ChatGPT" [ref=e1]\n- button "Add files and more" [ref=e2]';
const readyProbe = { ok: true, status: 200, bodyHasId: true, bodyHasEmail: true };
const classify = (observation) => classifyChatAuthPage({ ...observation,
  allowedOrigins: ["https://chatgpt.com"], cookieSourceLabel: "Chrome profile Default",
  runtimeProfileDir: "/fixture/seed", logPath: "/fixture/auth.log" });
const navigationError = () => new Error("✗ CDP error (Runtime.evaluate): Inspected target navigated or closed");

function pollingHarness(overrides = {}) {
  const logs = [];
  let captures = 0;
  const context = {
    Date, Promise, Error, isAuthNavigationError, CHATGPT_COMPOSER_LABELS,
    config: { auth: { bootstrapTimeoutMs: 2000, pollMs: 1 } },
    getUrl: async () => "https://chatgpt.com/", snapshotText: async () => readySnapshot,
    pageText: async () => "", loginProbe: async () => readyProbe,
    writeFile: async () => {}, URL_PATH: "url", SNAPSHOT_PATH: "snapshot", BODY_PATH: "body", LOG_PATH: "log",
    classifyChatPage: classify, log: async (line) => { logs.push(line); },
    ensureBrowserConnected: async () => {},
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    preferredProvider: () => "chatgpt", providerName: () => "ChatGPT",
    CHATGPT_LABELS: { composer: "Chat with ChatGPT", addFiles: "Add files and more" },
    captureDiagnostics: async () => { captures++; }, authConfigRemediation: () => "Refresh source login.",
    // Any reload/click on an anonymous login page is a regression.
    openUrl: async () => assert.fail("unexpected auth navigation"),
    targetCommand: async () => assert.fail("unexpected reload"),
    ...overrides,
  };
  const poll = vm.runInNewContext(`(${functionSource(bootstrap, "waitForImportedAuthReady")})`, context);
  return { poll, logs, get captures() { return captures; } };
}

test("auth polling retries a complete observation after each navigation-interrupted read", async () => {
  for (const read of ["getUrl", "snapshotText", "pageText", "loginProbe"]) {
    let calls = 0;
    const good = { getUrl: "https://chatgpt.com/", snapshotText: readySnapshot, pageText: "", loginProbe: readyProbe };
    const h = pollingHarness({ [read]: async () => { if (++calls === 1) throw navigationError(); return good[read]; } });
    assert.equal((await h.poll()).state, "authenticated_and_ready");
    assert.equal(calls, 2);
    assert(h.logs.some((line) => line.includes("discarding partial reads")));
  }
});

test("auth polling drains concurrent commands before surfacing a fatal failure", async () => {
  let drained = false;
  const failure = new Error("CDP permission denied");
  const h = pollingHarness({ loginProbe: async () => { throw failure; }, pageText: async () => {
    await new Promise((resolve) => setTimeout(resolve, 10)); drained = true; return "";
  } });
  await assert.rejects(h.poll(), (error) => error === failure && drained);
});

test("fatal failures take precedence over concurrent navigation failures", async () => {
  const h = pollingHarness({ loginProbe: async () => { throw navigationError(); }, getUrl: async () => { throw new Error("Browser disconnected"); } });
  await assert.rejects(h.poll(), /Browser disconnected/);
});

test("closed browsers are not relaunched and persistent navigation respects the deadline", async () => {
  const closed = pollingHarness({ loginProbe: async () => { throw navigationError(); },
    ensureBrowserConnected: async () => { throw new Error("The isolated oracle browser was closed"); } });
  await assert.rejects(closed.poll(), /browser was closed/);
  const navigating = pollingHarness({ loginProbe: async () => { throw navigationError(); },
    config: { auth: { bootstrapTimeoutMs: 20, pollMs: 1 } } });
  await assert.rejects(navigating.poll(), /Timed out verifying/);
  assert.equal(navigating.captures, 1);
});

test("only known navigation/context destruction errors are retryable", () => {
  for (const message of ["Execution context was destroyed, most likely because of a navigation", "Cannot find context with specified id", navigationError().message]) {
    assert(isAuthNavigationError(new Error(message)));
  }
  for (const message of ["Target closed", "Browser disconnected", "CDP permission denied", "command timed out"]) {
    assert.equal(isAuthNavigationError(new Error(message)), false);
  }
});

for (const [name, source] of [["bootstrap", bootstrap], ["job worker", worker]]) {
  test(`${name} probe distinguishes anonymous ua-* IDs from account IDs`, async () => {
    const build = vm.runInNewContext(`(${functionSource(source, "buildLoginProbeScript")})`, {
      toAsyncJsonScript: (body) => `(async () => { ${body} })()`,
    });
    for (const id of ["ua-visitor", "user-signed-in"]) {
      const probe = normalizeLoginProbeResult(await vm.runInNewContext(build(50), {
        location: { href: "https://chatgpt.com/auth/login", hostname: "chatgpt.com", pathname: "/auth/login" },
        document: { querySelectorAll: () => [] }, AbortController, setTimeout, clearTimeout,
        fetch: async () => ({ status: 200, headers: { get: () => "application/json" },
          clone: () => ({ json: async () => ({ id, email: "", name: "" }) }) }),
      }));
      assert.equal(probe.bodyIsAnonymous, id.startsWith("ua-"));
      const result = classify({ url: "https://chatgpt.com/auth/login", snapshot: "", body: "Log in or sign up", probe });
      assert.equal(result.state, id.startsWith("ua-") ? "login_required" : "auth_transitioning");
      if (id.startsWith("ua-")) {
        const h = pollingHarness({ loginProbe: async () => probe });
        await assert.rejects(h.poll(), /anonymous visitor session/);
      }
    }
  });
}

test("auth recognizes current and legacy ready composers without trusting anonymous identity", () => {
  // Cookie-only /me probes may run before hydration or without the app's bearer token.
  const probe = { ...readyProbe, bodyIsAnonymous: true, bodyHasEmail: false };
  const observe = (snapshot, overrides = {}) => classify({ url: "https://chatgpt.com/", snapshot, body: "", probe: { ...probe, ...overrides } }).state;
  assert.equal(observe(""), "unknown");
  for (const label of ["Chat with ChatGPT", "Ask ChatGPT"]) {
    const snapshot = `- button "Open profile menu" [ref=e1]\n- button "Add files and more" [ref=e2]\n- textbox "${label}" [ref=e3]\n- button "Select ChatGPT model" [ref=e4]`;
    assert.equal(observe(snapshot), "authenticated_and_ready", `${label} should finish auth verification`);
    assert.equal(observe(snapshot, { domLoginCta: true }), "login_required");
    assert.equal(observe(snapshot.replace('[ref=e3]', '[disabled, ref=e3]')), "unknown");
    assert.equal(observe(snapshot.replace('- button "Add files and more" [ref=e2]', '')), "unknown");
  }
  assert.equal(observe('- textbox "Search" [ref=e1]\n- button "Add files and more" [ref=e2]'), "unknown");
});
