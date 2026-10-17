import assert from "node:assert/strict";
import { mkdtemp, mkdir, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { fauxAssistantMessage, fauxProvider, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";

// Unlike the sanity harness, command dispatch and session lifecycle here are native Pi.
// Never call oracle_auth/oracle_submit: browser/provider qualification is a separate gate.
test("native Oracle dispatch handles user prompts and idle custom completions without external jobs", { timeout: 30_000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "oracle-native-"));
  const agentDir = join(root, "agent");
  const jobsDir = join(root, "jobs");
  await mkdir(agentDir);
  await mkdir(jobsDir);
  const oldEnv = { ...process.env };
  Object.assign(process.env, { PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1",
    PI_ORACLE_JOBS_DIR: jobsDir, PI_ORACLE_STATE_DIR: join(root, "state") });
  const fetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("Oracle status must not access the network"); };
  t.after(async () => {
    globalThis.fetch = fetch;
    for (const key of Object.keys(process.env)) if (!(key in oldEnv)) delete process.env[key];
    Object.assign(process.env, oldEnv);
    await rm(root, { recursive: true, force: true });
  });
  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
  const starts = [];
  const loader = new DefaultResourceLoader({ cwd: root, agentDir, settingsManager,
    noExtensions: true, noSkills: true, noThemes: true, noContextFiles: true,
    extensionFactories: [(pi) => {
      pi.on("before_agent_start", (event) => { starts.push(event); });
    }],
    additionalExtensionPaths: [fileURLToPath(new URL("../", import.meta.url))] });
  await loader.reload();
  assert.deepEqual(loader.getExtensions().errors, []);
  assert.equal(loader.getExtensions().extensions.length, 2);
  assert.deepEqual(loader.getPrompts().prompts.map((prompt) => prompt.name).sort(), ["oracle", "oracle-followup"]);
  const modelRuntime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null,
    modelsStorePath: join(agentDir, "models-store.json"), allowModelNetwork: false });
  const faux = fauxProvider();
  faux.setResponses([fauxAssistantMessage("user handled"), fauxAssistantMessage("completion handled")]);
  modelRuntime.registerNativeProvider(faux.provider);
  const { session } = await createAgentSession({ cwd: root, agentDir, modelRuntime, resourceLoader: loader,
    model: faux.getModel(),
    settingsManager, sessionManager: SessionManager.inMemory(root), noTools: "builtin" });
  const errors = [];
  try {
    await session.bindExtensions({ mode: "json", onError: (error) => errors.push(error) });
    await session.prompt("/oracle-status");
    const output = session.sessionManager.getEntries().filter((entry) => entry.type === "custom_message" && entry.customType === "oracle-command-output");
    assert.equal(output.length, 1, "native command dispatch must deliver exactly one status response");
    assert.match(JSON.stringify(output[0].content), /oracle|job/i);

    await session.prompt("/oracle Read README.md", { expandPromptTemplates: false });
    assert.equal(session.getLastAssistantText(), "user handled");
    const dispatches = () => session.sessionManager.getEntries().filter((entry) =>
      entry.type === "custom_message" && entry.customType === "oracle-dispatch-request");
    assert.equal(dispatches().length, 1, "a user /oracle prompt must inject dispatch instructions");
    assert.equal(dispatches()[0].display, false);
    assert.match(JSON.stringify(dispatches()[0].content), /Read README\.md/);
    assert.equal(starts[0].prompt, "/oracle Read README.md");

    assert.equal(session.isStreaming, false, "completion must start from idle");
    await session.sendCustomMessage({
      customType: "oracle-job-wakeup", display: false,
      content: "/oracle Do not parse this completion as a user command",
      details: { jobId: "native-completion", status: "complete" },
    }, { triggerTurn: true, deliverAs: "followUp" });
    assert.equal(session.getLastAssistantText(), "completion handled");
    assert.equal(faux.state.callCount, 2, "custom completion must actually trigger a model turn");
    assert.equal(dispatches().length, 1, "custom notification text must never inject /oracle instructions");
    if ("messageType" in starts[0]) {
      assert.equal(starts.length, 2, "the new host must emit a custom start event");
      assert.equal(starts[1].messageType, "custom");
      assert.equal("prompt" in starts[1], false);
    } else {
      assert.equal(starts.length, 1, "the old host only emits user start events");
    }
    assert.deepEqual(await readdir(jobsDir), [], "status must not submit a browser job");
    assert.deepEqual(errors, []);
  } finally {
    await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    session.dispose();
  }
});
