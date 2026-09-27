import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import test from "node:test";
import * as ui from "../extensions/oracle/worker/chatgpt-ui-helpers.mjs";
import { parseSnapshotEntries } from "../extensions/oracle/worker/artifact-heuristics.mjs";

const worker = await readFile(new URL("../extensions/oracle/worker/run-job.mjs", import.meta.url), "utf8");
const names = ["findEntry", "matchesModelConfigurationOpener", "canUseOpenModelMenuForSelection",
  "openModelConfiguration", "configurePowerSlider", "configureModel", "waitForModelConfigurationToSettle", "toJsonScript"];
const functions = names.flatMap((name) => {
  const start = worker.indexOf(`function ${name}(`);
  if (start < 0) return []; // Allows the same regression to run against the pre-slider worker.
  const end = worker.indexOf("\n}", start) + 2;
  return `${worker.slice(start - 6, start) === "async " ? "async " : ""}${worker.slice(start, end)}`;
}).join("\n");

function harness({ initial = 3, max = "4", wrongLabel = false, stuck = false, mountingReads = 0 } = {}) {
  const labels = ["Instant", "Medium", "High", "Extra High", "Pro"];
  let value = initial;
  let open = false;
  let verified = false;
  const snapshot = () => open
    ? '- button "Thinking effort" [expanded=true, ref=e1]\n- menu "Thinking effort" [ref=e2]\n- menuitem "Select model" [ref=e3]\n- menuitem "Power" [ref=e4]'
    : `- button "${value === 4 ? "6 Pro" : labels[value]}" [expanded=false, ref=e1]\n- textbox "Ask ChatGPT" [ref=e5]\n- button "Add files and more" [ref=e6]`;
  const control = {
    closest: () => null,
    getAttribute: () => "description",
    querySelector: () => mountingReads-- > 0 ? null : ({ getAttribute: (name) => ({ "aria-valuemin": "0", "aria-valuemax": max, "aria-valuenow": String(value) })[name] }),
  };
  const context = vm.createContext({ ...ui, parseSnapshotEntries, Date, Error, JSON, Number,
    CHATGPT_LABELS: { configure: "Configure..." },
    MODEL_CONFIGURATION_OPEN_TIMEOUT_MS: 30, MODEL_CONFIGURATION_SETTLE_TIMEOUT_MS: 30,
    MODEL_CONFIGURATION_CLOSE_RETRY_MS: 1, MODEL_CONFIGURATION_SETTLE_POLL_MS: 0,
    isGrokJob: () => false, snapshotText: async () => snapshot(),
    throwIfProviderTransientError: () => {}, dismissProFeedbackModal: async () => false,
    clickRef: async () => { open = !open; }, sleep: async () => {},
    composerControlsVisible: ui.snapshotHasUsableComposerControls,
    log: async (line) => { if (line.startsWith("Verified ChatGPT Power tier")) verified = true; },
    agentBrowser: async (_job, command, arg) => {
      if (command === "focus") { assert(open); return; }
      if (command !== "press") return;
      if (arg === "Escape") open = false;
      else if (!stuck) value = Math.max(0, Math.min(4, value + (arg === "ArrowRight" ? 1 : -1)));
    },
    evalPage: async (_job, script) => JSON.parse(vm.runInNewContext(script, { document: {
      querySelector: () => open ? control : null,
      getElementById: () => ({ textContent: `${wrongLabel ? "Unknown" : labels[value]}, ${value + 1} of 5.` }),
    } })),
  });
  vm.runInContext(functions, context);
  return { configure: (selection) => context.configureModel({ selection }),
    get state() { return { value, open, verified }; } };
}

test("worker configures every preset through the current Power picker and closes it", async () => {
  for (const [selection, expected] of [
    [{ modelFamily: "instant", autoSwitchToThinking: false }, 0],
    [{ modelFamily: "instant", autoSwitchToThinking: true }, 0],
    [{ modelFamily: "thinking", effort: "light" }, 1],
    [{ modelFamily: "thinking", effort: "standard" }, 1],
    [{ modelFamily: "thinking", effort: "extended" }, 2],
    [{ modelFamily: "thinking", effort: "heavy" }, 3],
    [{ modelFamily: "pro", effort: "standard" }, 4],
    [{ modelFamily: "pro", effort: "extended" }, 4],
  ]) {
    const h = harness({ initial: expected === 4 ? 0 : 4, mountingReads: 2 });
    await h.configure(selection);
    assert.deepEqual(h.state, { value: expected, open: false, verified: true });
  }
});

test("worker refuses unknown, mislabelled, or unresponsive Power controls", async () => {
  for (const [options, error] of [
    [{ max: "5" }, /unrecognized range/],
    [{ wrongLabel: true }, /Could not verify ChatGPT Power tier/],
    [{ stuck: true }, /did not reach requested tier/],
  ]) {
    const h = harness(options);
    await assert.rejects(h.configure({ modelFamily: "instant", autoSwitchToThinking: false }), error);
    assert.equal(h.state.verified, false);
  }
});
