import assert from "node:assert/strict";
import test from "node:test";

import { parseSnapshotEntries } from "./artifact-heuristics.mjs";
import * as flowHelpers from "./chatgpt-flow-helpers.mjs";
import { matchesModelConfigurationOpener, mergeObservedSelection } from "./chatgpt-ui-helpers.mjs";
import { classifyDeepResearchTurn, effortSelectionVisible, findDialogCloseEntry, isDeepResearchMenuEntry, parseDeepResearchWidgetText, parsePowerSliderDescription, powerSliderStepKey, powerSliderTargetLabel, snapshotCanSafelySkipModelConfiguration, snapshotHasDeepResearchPill, snapshotHasModelConfigurationUi, snapshotHasModelOpener, snapshotHasPowerSliderMenu, snapshotHasSelectedLatestModel, snapshotHasUsableComposerControls, snapshotStronglyMatchesRequestedModel, snapshotWeaklyMatchesRequestedModel, waitForStationaryControl } from "./chatgpt-ui-helpers.mjs";

// Composer fragment of the authenticated redesigned shell, captured 2026-09-29 by a failed job.
const CURRENT_SHELL_COMPOSER = [
  '- button "Temporary chat" [ref=e11]',
  '- button "Chat" [ref=e12]',
  '- button "Work" [ref=e13]',
  '- heading "What’s on the agenda today?" [level=1, ref=e114]',
  '- button "Add files and more" [expanded=false, ref=e117]',
  '- textbox "Ask ChatGPT" [ref=e115]: ',
  '- button "Select ChatGPT model" [expanded=false, ref=e118]',
  '- button "Dictate" [ref=e119]',
  '- button "Start Voice" [ref=e116]',
].join("\n");

test("the redesigned shell is ready only with an enabled Ask ChatGPT composer beside Add files", () => {
  assert.equal(snapshotHasUsableComposerControls(CURRENT_SHELL_COMPOSER), true);
  assert.equal(snapshotHasUsableComposerControls(CURRENT_SHELL_COMPOSER.replace("[ref=e115]", "[disabled, ref=e115]")), false);
  assert.equal(snapshotHasUsableComposerControls(CURRENT_SHELL_COMPOSER.replace('textbox "Ask ChatGPT"', 'textbox "Work with ChatGPT"')), false);
  assert.equal(snapshotHasUsableComposerControls(CURRENT_SHELL_COMPOSER.replace('button "Add files and more"', 'button "Attach"')), false);
});

test("the Select ChatGPT model button opens the Power menu, which is open only while expanded", () => {
  assert.equal(snapshotHasModelOpener(CURRENT_SHELL_COMPOSER), true);
  assert.equal(snapshotCanSafelySkipModelConfiguration(CURRENT_SHELL_COMPOSER, { modelFamily: "pro", effort: "extended" }), false);
  // Live `snapshot -i` of the open picker (2026-09-30): the menu node itself is not listed.
  const open = [
    '- button "Select ChatGPT model" [expanded=true, ref=e118]',
    '- button "Dictate" [ref=e119]',
    '- menuitem "Select model" [ref=e5]',
    '- menuitem "Power" [ref=e3]',
    '  - generic [ref=e15] clickable [cursor:pointer, onclick]',
  ].join("\n");
  assert.equal(snapshotHasPowerSliderMenu(open), true);
  assert.equal(snapshotHasModelConfigurationUi(open), true);
  const lingering = open.replace("[expanded=true, ref=e118]", "[expanded=false, ref=e118]");
  assert.equal(snapshotHasPowerSliderMenu(lingering), false);
});

test("a versioned Pro button opens configuration without attesting its effort", () => {
  const snapshot = '- button "6 Pro" [expanded=false, ref=e48]';
  assert.equal(snapshotHasModelOpener(snapshot), true);
  assert.equal(snapshotCanSafelySkipModelConfiguration(snapshot, { modelFamily: "pro", effort: "extended" }), false);
});

test("bare effort buttons open model configuration case-insensitively", () => {
  for (const label of ["light", "STANDARD", "extended", "hEaVy"]) {
    const snapshot = `- button "${label}" [expanded=false, ref=e1]`;
    assert.equal(snapshotHasModelOpener(snapshot), true, label);
    assert.equal(matchesModelConfigurationOpener(parseSnapshotEntries(snapshot)[0]), true, label);
    assert.equal(snapshotCanSafelySkipModelConfiguration(snapshot, { modelFamily: "pro", effort: "extended" }), false);
  }
});

test("removable effort buttons open model configuration case-insensitively without admitting response actions", () => {
  for (const label of ["light", "STANDARD", "extended", "hEaVy"]) {
    const snapshot = `- button "${label}, click to remove" [ref=e1]`;
    assert.equal(snapshotHasModelOpener(snapshot), true, label);
    assert.equal(matchesModelConfigurationOpener(parseSnapshotEntries(snapshot)[0]), true, label);
    assert.equal(snapshotHasModelOpener(snapshot.replace("[ref=e1]", "[disabled, ref=e1]")), false);
    assert.equal(snapshotHasModelOpener(snapshot.replace("- button ", "- menuitem ")), false);
  }
  for (const label of ["Pro feedback", "Thinking feedback", "Heavy feedback"]) {
    assert.equal(snapshotHasModelOpener(`- button "${label}" [ref=e1]`), false, label);
  }
});

test("a checked versioned Pro row verifies family without inventing effort", () => {
  const snapshot = '- menuitemradio "6 Pro" [checked=true, ref=e60]';
  const selection = { modelFamily: "pro", effort: "extended" };
  assert.equal(snapshotWeaklyMatchesRequestedModel(snapshot, selection), true);
  assert.equal(snapshotStronglyMatchesRequestedModel(snapshot, selection), false);
});

test("only a checked Latest row attests the current model selector", () => {
  assert.equal(snapshotHasSelectedLatestModel('- menuitemradio "Latest" [checked=true, ref=e24]'), true);
  assert.equal(snapshotHasSelectedLatestModel('- menuitemradio "Latest" [checked=false, ref=e24]'), false);
});

test("the current Pro Power menu attests extended effort only while open", () => {
  const snapshot = [
    '- button "Thinking effort" [expanded=true, ref=e49]',
    '- menu "Thinking effort" [ref=e50]',
    '- menuitem "Select model" [expanded=false, ref=e51]',
    '- menuitem "Power" [ref=e52]',
  ].join("\n");
  assert.equal(snapshotHasModelConfigurationUi(snapshot), true);
  assert.equal(effortSelectionVisible(snapshot, "Extended"), true);
  assert.equal(effortSelectionVisible(snapshot, "Standard"), false);
  assert.equal(snapshotStronglyMatchesRequestedModel(snapshot, { modelFamily: "pro", effort: "extended" }), false);
  assert.equal(snapshotStronglyMatchesRequestedModel(snapshot, { modelFamily: "pro", effort: "standard" }), false);
});

test("the slider-based Thinking effort menu is recognized only when open", () => {
  const open = [
    '- button "Thinking effort" [expanded=true, ref=e121]',
    '- menu "Thinking effort" [ref=e2]',
    '- menuitem "Select model" [expanded=false, ref=e15]',
    '- menuitem "Power" [ref=e5]',
  ].join("\n");
  assert.equal(snapshotHasPowerSliderMenu(open), true);
  assert.equal(snapshotHasPowerSliderMenu('- button "Extra High" [expanded=false, ref=e117]'), false);
});

// Observed live on 2026-09-21: thinking_standard and thinking_extended both applied their power
// stop, then failed after the full settle timeout because ChatGPT left the compact intelligence
// menu mounted with its composer opener already reporting expanded=false.
test("a compact intelligence menu contradicted by its collapsed opener is stale, not open UI", () => {
  const stale = [
    '- textbox "Chat with ChatGPT" [ref=e70]',
    '- button "Add files and more" [expanded=false, ref=e69]',
    '- button "Medium" [expanded=false, ref=e73]',
    '- menu "Medium" [ref=e2] clickable [onclick]',
    '- menuitem "Select model" [expanded=false, ref=e15]',
    '- menuitem "Power" [ref=e5]',
  ].join("\n");
  assert.equal(snapshotHasModelConfigurationUi(stale), false);
  assert.equal(snapshotHasUsableComposerControls(stale), true);

  // The same node while the popup is genuinely open still blocks the composer.
  assert.equal(snapshotHasModelConfigurationUi(stale.replace("[expanded=false, ref=e73]", "[expanded=true, ref=e73]")), true);

  // Without an opener to contradict it, the menu is still treated as open.
  const noOpener = stale.split("\n").filter((line) => !line.includes('button "Medium"')).join("\n");
  assert.equal(snapshotHasModelConfigurationUi(noOpener), true);
});

test("the slider description yields the current stop, and anything else yields nothing", () => {
  assert.deepEqual(parsePowerSliderDescription("Extra High, 4 of 5. Use Left and Right arrow keys to adjust power."), { label: "Extra High", index: 4, count: 5 });
  assert.deepEqual(parsePowerSliderDescription("Instant, 1 of 5."), { label: "Instant", index: 1, count: 5 });
  assert.equal(parsePowerSliderDescription("Use Left and Right arrow keys to adjust power."), undefined);
  assert.equal(parsePowerSliderDescription("Pro, 6 of 5."), undefined);
  assert.equal(parsePowerSliderDescription(undefined), undefined);
});

test("observed products use control labels rather than a requested model or page text", () => {
  const at = "2026-10-18T00:00:00.000Z";
  for (const [modelLabel, product] of [
    ["Thinking effort Pro", "pro"], ["Thinking effort Instant", "instant"],
    ["Extra High", "thinking"], ["GPT-5 Thinking", "thinking"], ["Unknown", undefined],
    ["Thinking effort Unknown", undefined],
  ]) {
    const result = mergeObservedSelection(undefined, { at, modelLabel, pageText: "not provenance", product: "pro" });
    assert.equal(result.product, product);
    assert.equal(result.pageText, undefined);
    assert.equal(result.at, at);
  }
  const prior = mergeObservedSelection(undefined, { at, effortLabel: "Pro (5 of 5)" });
  const combined = mergeObservedSelection(prior, { modelLabel: "Thinking effort Pro", at });
  assert.equal(combined.effortLabel, "Pro (5 of 5)");
  assert.equal(mergeObservedSelection(combined, { deepResearchVerified: true, at }).product, "deep_research");
  assert.equal(mergeObservedSelection(undefined, { deepResearchIframeTitle: "unrelated page title", at }).deepResearchIframeTitle, undefined);
});

test("fresh effort observations clear stale values and absence markers without losing unrelated metadata", () => {
  const at = "2026-10-24T00:00:00.000Z";
  const previous = mergeObservedSelection(undefined, {
    at: "2000-01-01T00:00:00.000Z", modelLabel: "Thinking effort Pro", effortLabel: "Pro (5 of 5)",
  });
  for (const effortControls of ["absent", "unavailable"]) {
    const cleared = mergeObservedSelection(previous, { at, effortLabel: null, effortControls });
    assert.equal(cleared.effortLabel, null);
    assert.equal(cleared.effortControls, effortControls);
    assert.equal(cleared.modelLabel, previous.modelLabel);
    assert.equal(cleared.at, at);
    const observed = mergeObservedSelection(cleared, { at, effortLabel: "Medium (3 of 6)" });
    assert.equal(observed.effortLabel, "Medium (3 of 6)");
    assert.equal(observed.effortControls, undefined);
    assert.equal(observed.product, "thinking");
  }
});

test("a full fresh observation clears unreadable model provenance and classifies a readable slider", () => {
  const previous = mergeObservedSelection(undefined, {
    at: "2000-01-01T00:00:00.000Z", modelLabel: "Thinking effort Pro", effortLabel: "Pro (5 of 5)",
  });
  for (const effortControls of ["absent", "unavailable"]) {
    const fresh = { at: "2026-10-24T00:00:00.000Z", modelLabel: null, effortLabel: null, effortControls };
    const cleared = mergeObservedSelection(previous, fresh);
    assert.equal(cleared.modelLabel, undefined);
    assert.equal(cleared.product, undefined);
    const research = mergeObservedSelection(previous, { ...fresh, deepResearchVerified: true });
    assert.equal(research.modelLabel, undefined);
    assert.equal(research.product, "deep_research");
  }
  const slider = mergeObservedSelection(previous, { modelLabel: "Select ChatGPT model", effortLabel: "Medium (2 of 5)" });
  assert.equal(slider.product, "thinking", "a generic picker caption must not shadow the actual effort stop");
});

test("presets map onto the five slider stops the way compact tiers already do", () => {
  assert.equal(powerSliderTargetLabel({ modelFamily: "instant" }), "Instant");
  assert.equal(powerSliderTargetLabel({ modelFamily: "thinking", effort: "light" }), "Medium");
  assert.equal(powerSliderTargetLabel({ modelFamily: "thinking", effort: "standard" }), "Medium");
  assert.equal(powerSliderTargetLabel({ modelFamily: "thinking", effort: "extended" }), "High");
  assert.equal(powerSliderTargetLabel({ modelFamily: "thinking", effort: "heavy" }), "Extra High");
  assert.equal(powerSliderTargetLabel({ modelFamily: "pro", effort: "standard" }), "Pro");
  assert.equal(powerSliderTargetLabel({ modelFamily: "pro", effort: "extended" }), "Pro");
});

test("slider steps move toward the target and stop at unknown or reached positions", () => {
  assert.equal(powerSliderStepKey("Extra High", "Instant"), "ArrowLeft");
  assert.equal(powerSliderStepKey("Medium", "Pro"), "ArrowRight");
  assert.equal(powerSliderStepKey("High", "High"), undefined);
  assert.equal(powerSliderStepKey("Ultra", "Pro"), undefined);
});

// Fixtures below are fragments of accessibility snapshots captured on 2026-09-20 from the live
// ChatGPT composer and a real Deep Research run (.artifacts/deep-research-spike-2026-09-20).

test("the Deep research entry in the tools menu is the role-less clickable whose label starts with the title", () => {
  const menu = [
    '- generic "Add photos & filesUpload from computerAdd from library" [ref=e112] clickable [onclick]',
    '  - generic "Web searchFind real-time news and info" [ref=e124] clickable [cursor:pointer, onclick, tabindex]',
    '  - generic "Deep researchGet a detailed report" [ref=e125] clickable [cursor:pointer, onclick, tabindex]',
    '  - generic "SketchDraw and attach an image" [ref=e126] clickable [cursor:pointer, onclick, tabindex]',
  ].join("\n");
  const entries = parseSnapshotEntries(menu);
  const matches = entries.filter(isDeepResearchMenuEntry);
  assert.equal(matches.length, 1);
  assert.equal(matches[0].ref, "@e125");
});

test("the redesigned tools menu offers Deep research as a button whose name joins title and description", () => {
  const [entry] = parseSnapshotEntries('- button "Deep research Get a detailed report" [ref=e131]');
  assert.equal(isDeepResearchMenuEntry(entry), true);
  // The bare title is a selected-tool pill or navigation, never the menu entry.
  const [pill] = parseSnapshotEntries('- button "Deep research" [expanded=false, ref=e19]');
  assert.equal(isDeepResearchMenuEntry(pill), false);
});

test("the Deep research pill is recognized only inside the composer textbox", () => {
  const enabled = [
    '- generic "(function qCe(e,t){})" [ref=e114] clickable [onclick]',
    '  - button "Add files and more" [expanded=false, ref=e120]',
    '  - textbox "Chat with ChatGPT" [ref=e121]: \ufeff',
    "Deep research",
    " ",
    '    - generic "Deep research" [ref=e126] clickable [onclick]',
    '  - button "Extra High" [expanded=false, ref=e125]',
  ].join("\n");
  assert.equal(snapshotHasDeepResearchPill(enabled), true);
  const plain = [
    '  - button "Add files and more" [expanded=false, ref=e113]',
    '  - textbox "Chat with ChatGPT" [ref=e114]',
    '  - button "Extra High" [expanded=false, ref=e117]',
    '- generic "Deep research" [ref=e200] clickable [onclick]',
  ].join("\n");
  assert.equal(snapshotHasDeepResearchPill(plain), false);
});

test("the Deep Research placeholder turn is never a completed report", () => {
  // This is the turn that satisfies the generic completion predicate (no streaming, text present,
  // a Copy response control) the moment research starts. Classifying it as "started" is what keeps
  // the worker from writing it to response.md as a finished answer.
  const widget = [
    '- button "Worked for 4s" [expanded=false, ref=e113]',
    '- Iframe "internal://deep-research" [ref=e120]',
    '  - Iframe [ref=e126]',
    '- generic "Deep Research has started working on your query. It will first present a research plan" [ref=e109] focusable [tabindex]',
    '- button "Copy response" [ref=e114]',
  ].join("\n");
  assert.equal(classifyDeepResearchTurn({ snapshot: widget, text: "Worked for 4s\nDeep Research has started working on your query." }), "started");
  // The placeholder wording is model-written; the widget alone decides.
  assert.equal(classifyDeepResearchTurn({ snapshot: widget, text: "On it. Researching the omp-oracle package now." }), "started");
  assert.equal(classifyDeepResearchTurn({ snapshot: '- button "Copy response" [ref=e114]', text: "Worked for 6s\nDeep Research has started working on your omp-oracle / pi-oracle query. It will provide a report." }), "started");
  assert.equal(classifyDeepResearchTurn({ snapshot: '- button "Copy response" [ref=e114]', text: "Before I start, which npm registry scope should I focus on?" }), "reply");
  assert.equal(classifyDeepResearchTurn({ snapshot: "", text: "" }), "reply");
  // The redesigned shell names the widget frame for the app.
  assert.equal(classifyDeepResearchTurn({ snapshot: '- button "Open app in tab" [ref=e88]\n- Iframe "Deep research" [ref=e89]', text: "" }), "started");
});

test("the finished widget text yields the report without the animated counter, keeping citation markers", () => {
  // Shapes captured from the report frame's innerText on 2026-09-20. Each count in the header
  // renders as one 0-9 digit per line per digit column followed by its label; a two-count header
  // ("N citations · M searches") therefore carries two runs with " citations · " between them.
  const digits = Array.from({ length: 10 }, (_, digit) => String(digit));
  const body = [
    "`omp-oracle` vs. `pi-oracle`: Package and Relationship Analysis",
    "Executive summary",
    "",
    "omp-oracle is a renamed, history-preserving fork.",
    "1",
    "",
    "Package profile",
  ];
  for (const header of [
    ["Research completed in 2m · ", ...digits, ...digits, ...digits, " citations ·  searches"],
    ["Research completed in 4m · ", ...digits, ...digits, " citations · ", ...digits, ...digits, ...digits, " searches"],
  ]) {
    const parsed = parseDeepResearchWidgetText([...header, ...body].join("\n"));
    assert.equal(parsed.completed, true);
    assert.equal(parsed.report.startsWith("`omp-oracle` vs. `pi-oracle`"), true, `body starts after the header: ${parsed.report.slice(0, 40)}`);
    assert.equal(parsed.report.includes("fork.\n1\n\nPackage profile"), true, "citation markers in the body survive");
    assert.equal(/\n0\n1\n2/.test(parsed.report), false, "the counter runs are stripped");
  }
  assert.deepEqual(parseDeepResearchWidgetText(""), { completed: false, report: "" });
  assert.deepEqual(parseDeepResearchWidgetText("Researching…\nReading sources"), { completed: false, report: "" });
});

// Snapshot of job 0eebc96a's failure on 2026-10-03: a product announcement opened as a modal over
// the composer, so the page offered only the modal and model configuration timed out behind it.
test("a modal that hides the composer is dismissed only through its Close dialog control", () => {
  const announcement = [
    '- heading "Your Pro plan now includes connected finances" [level=2, ref=e1]',
    '- button "Get started" [ref=e2]',
    '- button "Close dialog" [ref=e3]',
  ].join("\n");
  assert.equal(findDialogCloseEntry(announcement)?.ref, "@e3");
  assert.equal(findDialogCloseEntry(announcement.replace('button "Close dialog"', 'button "Learn more"')), undefined, "an action button is never a dismissal");
  assert.equal(findDialogCloseEntry(`${CURRENT_SHELL_COMPOSER}\n- button "Close dialog" [ref=e3]`), undefined, "a reachable composer means no modal blocks it");
  assert.equal(findDialogCloseEntry(announcement.replace("[ref=e3]", "[disabled, ref=e3]")), undefined);
});

// Chrome gives a tab that is not the visible tab of its window no animation frames, and concurrent
// jobs share one window. A frame-driven wait never ended in such a tab (job ffb106b3, 2026-10-05).
test("the stationary-control wait ends without animation frames and refuses a covered control", async () => {
  const rect = { x: 10, y: 20, width: 30, height: 30 };
  const control = { disabled: false, getBoundingClientRect: () => rect, contains: (node) => node === control };
  const cover = {};
  let hit = control;
  const document = { querySelector: () => control, elementFromPoint: () => hit };
  const saved = { document: globalThis.document, requestAnimationFrame: globalThis.requestAnimationFrame };
  Object.assign(globalThis, { document, requestAnimationFrame: () => 0 });
  try {
    assert.equal(await waitForStationaryControl("button", { intervalMs: 5, timeoutMs: 1000 }), true);
    hit = cover;
    assert.equal(await waitForStationaryControl("button", { intervalMs: 5, timeoutMs: 100 }), false, "a control under another element is not ready");
  } finally {
    Object.assign(globalThis, saved);
  }
});

test("missing-turn generation evidence prevents staleness for ten minutes", () => {
  let state;
  for (let now = 0; now <= 600_000; now += 30_000) {
    state = flowHelpers.nextMissingTurnState(state, { signature: false, generating: true, now, staleAfterMs: 300_000 });
    assert.deepEqual(state, { since: undefined, stale: false }, `generation at ${now} ms is not a missing turn`);
  }
});

test("missing-turn resets discard idle time when generation or a signature appears", () => {
  const staleAfterMs = 300_000;
  for (const evidence of [{ signature: false, generating: true }, { signature: true, generating: false }]) {
    const first = flowHelpers.nextMissingTurnState(undefined, { signature: false, generating: false, now: 0, staleAfterMs });
    const reset = flowHelpers.nextMissingTurnState(first, { ...evidence, now: staleAfterMs - 1, staleAfterMs });
    assert.deepEqual(reset, { since: undefined, stale: false });
    const idle = flowHelpers.nextMissingTurnState(reset, { signature: false, generating: false, now: staleAfterMs, staleAfterMs });
    assert.deepEqual(idle, { since: staleAfterMs, stale: false }, "a new idle window starts after generation or completion evidence");
    const held = flowHelpers.nextMissingTurnState(idle, { signature: false, generating: false, now: 2 * staleAfterMs - 1, staleAfterMs });
    assert.deepEqual(held, { since: staleAfterMs, stale: false });
  }
});

test("missing-turn idle time becomes stale at the threshold and restarts after a reload", () => {
  const staleAfterMs = 300_000;
  const first = flowHelpers.nextMissingTurnState(undefined, { signature: false, generating: false, now: 5_000, staleAfterMs });
  const held = flowHelpers.nextMissingTurnState(first, { signature: false, generating: false, now: 5_000 + staleAfterMs - 1, staleAfterMs });
  assert.deepEqual(first, { since: 5_000, stale: false });
  assert.deepEqual(held, first);
  const stale = flowHelpers.nextMissingTurnState(held, { signature: false, generating: false, now: 5_000 + staleAfterMs, staleAfterMs });
  assert.deepEqual(stale, { since: 5_000, stale: true });
  const reloaded = flowHelpers.nextMissingTurnState(undefined, { signature: false, generating: false, now: 5_000 + staleAfterMs + 1, staleAfterMs });
  assert.deepEqual(reloaded, { since: 5_000 + staleAfterMs + 1, stale: false });
});

test("missing-turn reload budget permits one attempt and reports exhaustion once per job", () => {
  const first = flowHelpers.nextMissingTurnReloadState(undefined, 1);
  assert.deepEqual(first, { count: 1, action: "reload" });
  let state = flowHelpers.nextMissingTurnReloadState(first, 1);
  assert.deepEqual(state, { count: 1, action: "limit" });
  for (let poll = 0; poll < 10; poll += 1) {
    state = flowHelpers.nextMissingTurnReloadState(state, 1);
    assert.deepEqual(state, { count: 1, action: "poll" });
  }
  assert.deepEqual(flowHelpers.nextMissingTurnReloadState(undefined, 1), first, "a different job has its own reload budget");
});

test("stale-stop recovery still requires unchanged non-empty text for its full window", () => {
  const staleAfterMs = 120_000;
  const thinking = flowHelpers.nextStaleStopState(undefined, { stopControl: true, text: "", now: 0, staleAfterMs });
  assert.deepEqual(thinking, { text: "", since: undefined, stale: false });
  assert.deepEqual(flowHelpers.nextStaleStopState(thinking, { stopControl: true, text: "", now: 600_000, staleAfterMs }), thinking);
  const first = flowHelpers.nextStaleStopState(thinking, { stopControl: true, text: "Reply", now: 10_000, staleAfterMs });
  const held = flowHelpers.nextStaleStopState(first, { stopControl: true, text: "Reply", now: 10_000 + staleAfterMs - 1, staleAfterMs });
  assert.deepEqual(held, { text: "Reply", since: 10_000, stale: false });
  const stale = flowHelpers.nextStaleStopState(held, { stopControl: true, text: "Reply", now: 10_000 + staleAfterMs, staleAfterMs });
  assert.deepEqual(stale, { text: "Reply", since: 10_000, stale: true });
  const grew = flowHelpers.nextStaleStopState(stale, { stopControl: true, text: "Reply continued", now: 10_000 + staleAfterMs, staleAfterMs });
  assert.deepEqual(grew, { text: "Reply continued", since: 10_000 + staleAfterMs, stale: false });
  assert.deepEqual(flowHelpers.nextStaleStopState(stale, { stopControl: false, text: "Reply", now: 10_000 + staleAfterMs, staleAfterMs }), thinking);
});
