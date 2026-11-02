import assert from "node:assert/strict";
import { mkdtemp, mkdir, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { parseOracleRunArgs, summarizeOracleRunResult } from "../extensions/oracle/shared/oracle-run-helpers.mjs";

// /oracle-run is the driver control path: the host executes the registered tool from a JSON request, no model turn.
// Never call oracle_auth or a dispatching oracle_submit here: browser/provider qualification is a separate gate.
test("/oracle-run executes registered oracle tools host-side from JSON requests", { timeout: 30_000 }, async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "oracle-run-")));
  const agentDir = join(root, "agent");
  const jobsDir = join(root, "jobs");
  const exchange = join(root, "exchange");
  await mkdir(agentDir);
  await mkdir(jobsDir);
  await mkdir(exchange);
  const oldEnv = { ...process.env };
  Object.assign(process.env, { HOME: root, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1",
    PI_ORACLE_JOBS_DIR: jobsDir, PI_ORACLE_STATE_DIR: join(root, "state") });
  const fetch = t.mock.method(globalThis, "fetch", async () => { throw new Error("/oracle-run must not access the network"); });
  t.after(async () => {
    for (const key of Object.keys(process.env)) if (!(key in oldEnv)) delete process.env[key];
    Object.assign(process.env, oldEnv);
    await rm(root, { recursive: true, force: true });
  });
  const settingsManager = SettingsManager.inMemory();
  const loader = new DefaultResourceLoader({ cwd: root, agentDir, settingsManager,
    noExtensions: true, noSkills: true, noThemes: true, noContextFiles: true,
    additionalExtensionPaths: [fileURLToPath(new URL("../", import.meta.url))] });
  await loader.reload();
  assert.deepEqual(loader.getExtensions().errors, []);
  const modelRuntime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null,
    modelsStorePath: join(agentDir, "models-store.json"), allowModelNetwork: false });
  const { session } = await createAgentSession({ cwd: root, agentDir, modelRuntime, resourceLoader: loader,
    settingsManager, sessionManager: SessionManager.create(root, join(root, "sessions")), noTools: "builtin" });
  const errors = [];
  const outputs = () => session.sessionManager.getEntries()
    .filter((entry) => entry.type === "custom_message" && entry.customType === "oracle-command-output")
    .map((entry) => ({ summary: JSON.parse(entry.content), level: entry.details.level }));
  try {
    await session.bindExtensions({ mode: "json", onError: (error) => errors.push(error) });

    const at = new Date().toISOString();
    const jobDir = join(jobsDir, "oracle-saved-fixture");
    await mkdir(jobDir);
    await writeFile(join(jobDir, "response.md"), "Saved answer\n");
    await writeFile(join(jobDir, "job.json"), JSON.stringify({
      id: "saved-fixture", projectId: root, cwd: root, sessionId: join(root, "origin.jsonl"),
      status: "complete", phase: "complete", createdAt: at, completedAt: at,
      responsePath: join(jobDir, "response.md"), artifactPaths: [],
      selection: { provider: "chatgpt", preset: "instant", modelFamily: "instant" },
    }));
    const readRequest = join(exchange, "read.request.json");
    const readResult = join(exchange, "read.result.json");
    await writeFile(readRequest, JSON.stringify({ jobId: "saved-fixture" }));
    await session.prompt(`/oracle-run read ${readRequest} ${readResult}`);
    let [latest] = outputs().slice(-1);
    assert.deepEqual(latest, { summary: { operation: "read", ok: true, jobId: "saved-fixture", status: "complete" }, level: "info" });
    const saved = JSON.parse(await readFile(readResult, "utf8"));
    assert.equal(saved.details.job.responsePreview, "Saved answer\n", "the result file carries the exact tool result");
    assert.equal(existsSync(join(exchange, "read.marker.json")), false, "a read without a marker argument writes no marker");

    await session.prompt(`/oracle-run read ${readRequest} ${readResult}`);
    [latest] = outputs().slice(-1);
    assert.equal(latest.summary.ok, false);
    assert.match(latest.summary.error, /Result already exists/, "an existing result is never overwritten");
    assert.equal(latest.level, "warning");

    await session.prompt(`/oracle-run read relative/request.json ${readResult}`);
    [latest] = outputs().slice(-1);
    assert.match(latest.summary.error, /Not an absolute path/);

    await session.prompt(`/oracle-run preflight ${readRequest} ${join(exchange, "wrong.json")} ${join(exchange, "marker.json")}`);
    [latest] = outputs().slice(-1);
    assert.match(latest.summary.error, /takes no marker/);

    const badSubmit = join(exchange, "bad-submit.request.json");
    const badResult = join(exchange, "bad-submit.result.json");
    const badMarker = join(exchange, "bad-submit.marker.json");
    await writeFile(badSubmit, JSON.stringify({ prompt: "x", files: [] }));
    await session.prompt(`/oracle-run submit ${badSubmit} ${badResult} ${badMarker}`);
    [latest] = outputs().slice(-1);
    assert.match(latest.summary.error, /does not match the oracle_submit parameter schema/);
    assert.equal(existsSync(badMarker), false, "a request refused by the schema dispatches nothing and writes no marker");
    assert.equal(existsSync(badResult), false);
    assert.deepEqual((await readdir(jobsDir)).sort(), ["oracle-saved-fixture"], "no job was created");

    const preflightRequest = join(exchange, "preflight.request.json");
    const preflightResult = join(exchange, "preflight.result.json");
    await writeFile(preflightRequest, JSON.stringify({ provider: "chatgpt" }));
    await session.prompt(`/oracle-run preflight ${preflightRequest} ${preflightResult}`);
    [latest] = outputs().slice(-1);
    assert.equal(latest.summary.operation, "preflight");
    assert.equal(typeof latest.summary.ready, "boolean");
    assert.equal(JSON.parse(await readFile(preflightResult, "utf8")).details.ready, latest.summary.ready);

    assert.equal(fetch.mock.callCount(), 0, "/oracle-run must remain offline");
    assert.deepEqual(errors, []);
  } finally {
    session.dispose();
  }
});

test("oracle-run argument parsing and result summaries are strict", () => {
  assert.deepEqual(parseOracleRunArgs(" submit /a/req.json /a/res.json /a/marker.json "),
    { operation: "submit", requestPath: "/a/req.json", resultPath: "/a/res.json", markerPath: "/a/marker.json" });
  assert.throws(() => parseOracleRunArgs("cancel /a/req.json /a/res.json"), /Usage/);
  assert.throws(() => parseOracleRunArgs("read /a/req.json"), /Usage/);
  assert.throws(() => parseOracleRunArgs("read /a/req.json /a/res.json /a/m.json extra"), /Usage/);
  assert.deepEqual(summarizeOracleRunResult("submit", { content: [], details: { job: { id: "j1", status: "submitted" } } }),
    { operation: "submit", ok: true, jobId: "j1", status: "submitted" });
  assert.deepEqual(summarizeOracleRunResult("submit", { content: [], isError: true, details: { error: { code: "archive_too_large", message: "too big" } } }),
    { operation: "submit", ok: false, error: "archive_too_large: too big" });
  assert.deepEqual(summarizeOracleRunResult("read", undefined), { operation: "read", ok: false, error: "tool returned no result object" });
});
