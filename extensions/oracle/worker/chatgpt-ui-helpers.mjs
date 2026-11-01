// Purpose: Provide pure ChatGPT UI interpretation helpers shared by oracle worker/auth flows.
// Responsibilities: Normalize allowed origins, interpret model-selection snapshots, and derive assistant-completion signatures.
// Scope: Pure snapshot/text heuristics only; browser I/O and retry loops stay in the worker/auth entrypoints.
// Usage: Imported by worker/auth runtime code and sanity tests to keep browser-driven logic behaviorally testable.
// Invariants/Assumptions: Snapshot text comes from agent-browser `snapshot -i`; helper outputs must stay deterministic and side-effect free.

import { parseSnapshotEntries } from "./artifact-heuristics.mjs";

/** @typedef {import("./chatgpt-ui-helpers.d.mts").OracleUiModelFamily} OracleUiModelFamily */
/** @typedef {import("./chatgpt-ui-helpers.d.mts").OracleUiSelection} OracleUiSelection */
/** @typedef {import("./artifact-heuristics.d.mts").SnapshotEntry} SnapshotEntry */

/** @typedef {{ responseText: string; artifactLabels?: string[] }} CompletionSignatureArgs */
/** @typedef {{ hasStopStreaming: boolean; hasTargetCopyResponse: boolean; responseText: string; artifactLabels?: string[] }} DerivedCompletionSignatureArgs */

export const CHATGPT_CANONICAL_APP_ORIGINS = Object.freeze([
  "https://chatgpt.com",
  "https://chat.openai.com",
]);

// Accessible names of the ChatGPT controls the worker drives. The redesigned web app (observed
// 2026-09-29) comes first; the earlier names stay recognized because the redesign rolls out per
// account, so one operator can meet either shell.
export const CHATGPT_COMPOSER_LABELS = Object.freeze(["Ask ChatGPT", "Chat with ChatGPT"]);
export const CHATGPT_ADD_FILES_LABEL = "Add files and more";
export const CHATGPT_SEND_LABELS = Object.freeze(["Send", "Send prompt"]);
export const CHATGPT_STOP_LABELS = Object.freeze(["Stop", "Stop answering", "Stop streaming", "Stop generating"]);
// The editable composer: the earlier `#prompt-textarea` editor, or the current contenteditable
// textbox, which carries its accessible name as aria-label and has no id.
export const CHATGPT_COMPOSER_EDITOR_SELECTOR = [
  "#prompt-textarea",
  ...CHATGPT_COMPOSER_LABELS.map((label) => `[contenteditable="true"][aria-label="${label}"]`),
].join(", ");
// The composer's submit control while a turn generates. The current shell has no stop test id: one
// button switches its aria-label between Send and Stop.
export const CHATGPT_STOP_CONTROL_SELECTOR = [
  '[data-testid="stop-button"]',
  ...CHATGPT_STOP_LABELS.map((label) => `button[aria-label="${label}"]:not(:disabled)`),
].join(", ");
// The current general file input. Photo and video inputs precede it in document order, so a bare
// `input[type=file]` would hand the archive to an image picker.
export const CHATGPT_ATTACH_FILES_INPUT_SELECTOR = 'input[type="file"][aria-label="Attach files"]';
// A Deep research tool selected in the current composer is an app mention inside the editor.
export const CHATGPT_DEEP_RESEARCH_MENTION_SELECTOR = '[app-mention-name="deep-research"]';
// The current model picker opener and its menu share this name; the preceding shell named the open
// picker and its menu "Thinking effort". Both host the Power slider.
const MODEL_PICKER_LABEL = "Select ChatGPT model";
const POWER_MENU_LABELS = new Set([MODEL_PICKER_LABEL, "Thinking effort"]);
// The current composer's model picker; its visible text names the selected model ("Pro").
export const CHATGPT_MODEL_PICKER_SELECTOR = `button[aria-label="${MODEL_PICKER_LABEL}"]`;
// A product announcement (observed 2026-10-03: "Your Pro plan now includes connected finances")
// opens as a modal over the composer; its only dismissal control carries this name.
const DIALOG_CLOSE_LABEL = "Close dialog";

/** @type {Record<OracleUiModelFamily, string>} */
const MODEL_FAMILY_PREFIX = {
  instant: "Instant ",
  thinking: "Thinking ",
  pro: "Pro ",
};

const AUTO_SWITCH_LABEL = "Auto-switch to Thinking";
const THINKING_EFFORT_COMBOBOX_LABEL = "Thinking effort";
const PRO_THINKING_EFFORT_COMBOBOX_LABEL = "Pro thinking effort";
const EFFORT_LABELS = new Set(["Light", "Standard", "Extended", "Heavy"]);
const COMPACT_INTELLIGENCE_MENU_PATTERN = /(?:Intelligence.*Instant.*Medium.*High.*Pro|^(?:Instant|Medium|High|Extra High|Pro(?: Standard| Extended)?)$)/i;
// Bare Instant is the legacy top-level family radio; compact Instant rows are versioned (Instant 5s / Instant 5.5).
const COMPACT_INTELLIGENCE_CONTROL_PATTERN = /^(?:Instant\s+[\d.]+s?|Medium(?:\s+5\s*[–-]\s*30s)?|High(?:\s+15\s*[–-]\s*60s)?|Extra High|Pro(?:\s+5\+\s*min|\s+Standard|\s+Extended)?)$/i;
const COMPACT_INTELLIGENCE_OPENER_PATTERN = /^(?:Instant(?:\s+[\d.]+s?)?|Medium|High|Extra High|Pro(?: Standard| Extended)?)$/i;
const BARE_EFFORT_PATTERN = /^(light|standard|extended|heavy)(?:, click to remove)?$/i;
const INSTANT_CHIP_PATTERN = /^instant(?:, click to remove)?$/i;
const THINKING_CHIP_PATTERN = /^(?:(light|standard|extended|heavy)\s+)?thinking(?:, click to remove)?$/i;
const PRO_CHIP_PATTERN = /^(?:(light|standard|extended|heavy)\s+)?pro(?:, click to remove)?$/i;
const MODEL_FAMILY_CONTROL_KINDS = new Set(["button", "radio", "menuitemradio"]);
const COMPACT_INTELLIGENCE_CONTROL_KINDS = new Set(["menuitemradio"]);
const CHATGPT_RESPONSE_CHROME_LINE_PATTERNS = Object.freeze([
  /^Stopped thinking$/i,
  /^Worked for (?:[0-9]+(?:[.][0-9]+)?[hms][ ]*)+$/i,
  /^Do you like this personality\?$/i,
]);

/**
 * @param {string | undefined} url
 * @returns {string | undefined}
 */
function originFromUrl(url) {
  if (typeof url !== "string" || !url.trim()) return undefined;
  try {
    return new URL(url).origin;
  } catch {
    return undefined;
  }
}

/**
 * @param {Array<string | undefined>} values
 * @returns {string[]}
 */
function uniqueStrings(values) {
  return [...new Set(values.filter((value) => typeof value === "string" && value))];
}

/**
 * @param {string | undefined} value
 * @returns {string | undefined}
 */
function titleCase(value) {
  return value ? `${value[0].toUpperCase()}${value.slice(1)}` : value;
}

/**
 * @param {string | undefined} value
 * @returns {string}
 */
function normalizeText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

/**
 * @param {string} chatUrl
 * @param {string | undefined} authUrl
 * @returns {string[]}
 */
export function buildAllowedChatGptOrigins(chatUrl, authUrl) {
  return uniqueStrings([
    ...CHATGPT_CANONICAL_APP_ORIGINS,
    originFromUrl(chatUrl),
    originFromUrl(authUrl),
    "https://auth.openai.com",
  ]);
}

/**
 * @param {string | undefined} value
 * @returns {string}
 */
export function stripChatGptResponseChrome(value) {
  return String(value || "")
    .split("\n")
    .filter((line) => !CHATGPT_RESPONSE_CHROME_LINE_PATTERNS.some((pattern) => pattern.test(line.trim())))
    .join("\n")
    .trim();
}

/**
 * @param {string | undefined} label
 * @param {OracleUiModelFamily} family
 * @returns {boolean}
 */
export function matchesModelFamilyLabel(label, family) {
  const normalized = String(label || "").replace(/^\d+(?:\.\d+)*\s+/, "");
  const prefix = MODEL_FAMILY_PREFIX[family];
  const exact = prefix.trim();
  return normalized === exact || normalized.startsWith(prefix) || normalized.startsWith(`${exact},`);
}

/**
 * @param {OracleUiSelection} selection
 * @returns {string | undefined}
 */
export function requestedEffortLabel(selection) {
  return selection?.effort ? titleCase(selection.effort) : undefined;
}

/**
 * @param {string | undefined} label
 * @returns {string}
 */
function normalizeChipLabel(label) {
  return normalizeText(label).replace(/, click to remove$/i, "").trim();
}

function parseComposerChipSelection(label) {
  const normalized = normalizeChipLabel(label).toLowerCase();
  if (!normalized) return undefined;

  const bareEffortMatch = normalized.match(BARE_EFFORT_PATTERN);
  if (bareEffortMatch) {
    return {
      modelFamily: /** @type {OracleUiModelFamily} */ ("thinking"),
      effort: /** @type {import("./chatgpt-ui-helpers.d.mts").OracleUiEffort} */ (bareEffortMatch[1].toLowerCase()),
    };
  }

  if (INSTANT_CHIP_PATTERN.test(normalized)) {
    return {
      modelFamily: /** @type {OracleUiModelFamily} */ ("instant"),
    };
  }

  const thinkingMatch = normalized.match(THINKING_CHIP_PATTERN);
  if (thinkingMatch) {
    return {
      modelFamily: /** @type {OracleUiModelFamily} */ ("thinking"),
      effort: /** @type {import("./chatgpt-ui-helpers.d.mts").OracleUiEffort} */ ((thinkingMatch[1] || "standard").toLowerCase()),
    };
  }

  const proPrefixedEffortMatch = normalized.match(/^pro\s+(standard|extended)$/i);
  if (proPrefixedEffortMatch) {
    return {
      modelFamily: /** @type {OracleUiModelFamily} */ ("pro"),
      effort: /** @type {import("./chatgpt-ui-helpers.d.mts").OracleUiEffort} */ (proPrefixedEffortMatch[1].toLowerCase()),
    };
  }

  const proMatch = normalized.match(PRO_CHIP_PATTERN);
  if (proMatch) {
    return {
      modelFamily: /** @type {OracleUiModelFamily} */ ("pro"),
      effort: /** @type {import("./chatgpt-ui-helpers.d.mts").OracleUiEffort} */ ((proMatch[1] || "standard").toLowerCase()),
    };
  }

  return undefined;
}

function parseCompactIntelligenceSelection(label) {
  if (/click to remove/i.test(String(label || ""))) return undefined;
  const normalized = normalizeChipLabel(label);
  if (!COMPACT_INTELLIGENCE_CONTROL_PATTERN.test(normalized)) return undefined;

  if (/^Instant\s+[\d.]+s?$/i.test(normalized)) {
    return {
      modelFamily: /** @type {OracleUiModelFamily} */ ("instant"),
      compactTier: "instant",
    };
  }
  if (/^Medium(?:\s+5\s*[–-]\s*30s)?$/i.test(normalized)) {
    return {
      modelFamily: /** @type {OracleUiModelFamily} */ ("thinking"),
      effort: /** @type {import("./chatgpt-ui-helpers.d.mts").OracleUiEffort} */ ("standard"),
      compactTier: "medium",
    };
  }
  if (/^High(?:\s+15\s*[–-]\s*60s)?$/i.test(normalized)) {
    return {
      modelFamily: /** @type {OracleUiModelFamily} */ ("thinking"),
      effort: /** @type {import("./chatgpt-ui-helpers.d.mts").OracleUiEffort} */ ("extended"),
      compactTier: "high",
    };
  }
  if (/^Extra High$/i.test(normalized)) {
    return {
      modelFamily: /** @type {OracleUiModelFamily} */ ("thinking"),
      effort: /** @type {import("./chatgpt-ui-helpers.d.mts").OracleUiEffort} */ ("heavy"),
      compactTier: "extra-high",
    };
  }
  const proEffortMatch = normalized.match(/^Pro\s+(Standard|Extended)$/i);
  if (proEffortMatch) {
    return {
      modelFamily: /** @type {OracleUiModelFamily} */ ("pro"),
      effort: /** @type {import("./chatgpt-ui-helpers.d.mts").OracleUiEffort} */ (proEffortMatch[1].toLowerCase()),
      compactTier: "pro",
    };
  }
  // "Pro 5+ min" is always the compact Pro tier. Bare "Pro" is ambiguous with the
// legacy top-level family radio and is handled with sibling context below.
  if (/^Pro\s+5\+\s*min$/i.test(normalized)) {
    return {
      modelFamily: /** @type {OracleUiModelFamily} */ ("pro"),
      compactTier: "pro",
    };
  }

  return undefined;
}

function parseBareProCompactSelection(label) {
  if (/click to remove/i.test(String(label || ""))) return undefined;
  if (!/^Pro$/i.test(normalizeChipLabel(label))) return undefined;
  return {
    modelFamily: /** @type {OracleUiModelFamily} */ ("pro"),
    compactTier: "pro",
  };
}

function snapshotHasCompactTierSiblings(entries, exceptLabel) {
  const except = normalizeChipLabel(exceptLabel).toLowerCase();
  return entries.some((entry) => {
    if (entry.disabled || entry.kind !== "menuitemradio") return false;
    if (normalizeChipLabel(entry.label).toLowerCase() === except) return false;
    return Boolean(parseCompactIntelligenceSelection(entry.label));
  });
}

function hasRemovableComposerModelChip(entries) {
  return entries.some(
    (entry) => entry.kind === "button" && /click to remove/i.test(String(entry.label || "")) && parseComposerChipSelection(entry.label),
  );
}

// ChatGPT can leave a compact intelligence menu mounted after the popup closes: the menu node
// outlives it while the composer opener already reports expanded=false. The opener owns the
// aria-expanded contract, so a menu contradicted by its own collapsed opener is a stale node,
// not open configuration UI. Treating it as open strands every reader that waits for it to go.
function hasCollapsedOpenerFor(entries, menuLabel) {
  const label = normalizeText(menuLabel);
  if (!label) return false;
  return entries.some(
    (entry) => entry.kind === "button"
      && normalizeText(entry.label) === label
      && /\bexpanded=false\b/.test(String(entry.line || "")),
  );
}

function hasOpenCompactIntelligenceMenu(entries) {
  return entries.some(
    (entry) => !entry.disabled
      && entry.kind === "menu"
      && COMPACT_INTELLIGENCE_MENU_PATTERN.test(normalizeText(entry.label))
      && !hasCollapsedOpenerFor(entries, entry.label),
  );
}

function hasCompactIntelligenceMenuContext(entries) {
  return hasOpenCompactIntelligenceMenu(entries)
    || entries.some((entry) => !entry.disabled && entry.kind === "menuitemradio" && checkedState(entry) === true && compactSelectionFromEntry(entry, entries));
}

function hasLegacyEffortCombobox(entries) {
  return entries.some((entry) => {
    if (entry.disabled || entry.kind !== "combobox") return false;
    const label = normalizeText(entry.label).toLowerCase();
    return label === THINKING_EFFORT_COMBOBOX_LABEL.toLowerCase() || label === PRO_THINKING_EFFORT_COMBOBOX_LABEL.toLowerCase();
  });
}

function compactSelectionFromEntry(entry, entries = [], options = {}) {
  if (entry.disabled) return undefined;
  const kind = entry.kind || "";
  if (COMPACT_INTELLIGENCE_CONTROL_KINDS.has(kind)) {
    const parsed = parseCompactIntelligenceSelection(entry.label);
    if (parsed) return parsed;
    // Bare "Pro" is compact only when versioned Instant / Medium / High / Extra High siblings exist.
    if (snapshotHasCompactTierSiblings(entries, entry.label)) {
      return parseBareProCompactSelection(entry.label);
    }
    return undefined;
  }
  if (options.allowClosedButtons && kind === "button" && !/\bexpanded=true\b/.test(String(entry.line || ""))) {
    const parsed = parseCompactIntelligenceSelection(entry.label);
    if (parsed) return parsed;
    const barePro = parseBareProCompactSelection(entry.label);
    if (barePro) return barePro;
    // Closed composer pills keep bare Instant after the compact menu closes.
    if (/^Instant$/i.test(normalizeChipLabel(entry.label))) {
      return {
        modelFamily: /** @type {OracleUiModelFamily} */ ("instant"),
        compactTier: "instant",
      };
    }
  }
  return undefined;
}

export function matchesCompactIntelligenceControlLabel(label) {
  return Boolean(parseCompactIntelligenceSelection(label) || parseBareProCompactSelection(label));
}

export function snapshotHasClosedCompactSelection(snapshot, selection) {
  /** @type {SnapshotEntry[]} */
  const entries = parseSnapshotEntries(snapshot);
  if (hasRemovableComposerModelChip(entries) || hasLegacyEffortCombobox(entries) || hasCompactIntelligenceMenuContext(entries)) return false;
  return entries.some((entry) => {
    if (entry.kind !== "button" || entry.disabled) return false;
    const compactSelection = compactSelectionFromEntry(entry, entries, { allowClosedButtons: true });
    return compactSelectionMatchesRequestedInSnapshot(snapshot, selection, compactSelection);
  });
}

function compactSelectionMatchesRequested(selection, compactSelection) {
  if (!compactSelection || compactSelection.modelFamily !== selection.modelFamily) return false;

  if (selection.modelFamily === "instant") {
    // The compact Intelligence picker has no explicit auto-switch toggle. Treat
    // Instant 5s as the closest available target for both instant presets.
    return compactSelection.compactTier === "instant";
  }

  if (selection.modelFamily === "pro") {
    if (compactSelection.compactTier !== "pro") return false;
    if (!compactSelection.effort) return true;
    return compactSelection.effort === (selection.effort || "standard");
  }

  if (selection.modelFamily === "thinking") {
    const requestedEffort = selection.effort || "standard";
    if (compactSelection.compactTier === "medium") return requestedEffort === "light" || requestedEffort === "standard";
    if (compactSelection.compactTier === "high") return requestedEffort === "extended";
    if (compactSelection.compactTier === "extra-high") return requestedEffort === "heavy";
  }

  return false;
}

function compactSelectionMatchesRequestedInSnapshot(snapshot, selection, compactSelection, { weak = false } = {}) {
  if (!compactSelectionMatchesRequested(selection, compactSelection)) return false;
  if (selection.modelFamily !== "instant") return true;

  const autoSwitchState = autoSwitchToThinkingSelectionVisible(snapshot);
  if (autoSwitchState === undefined) return true;
  if (weak) return selection.autoSwitchToThinking ? autoSwitchState !== false : autoSwitchState !== true;
  return selection.autoSwitchToThinking ? autoSwitchState === true : autoSwitchState !== true;
}

function detectCompactIntelligenceSelection(entries) {
  if (hasRemovableComposerModelChip(entries)) return undefined;
  if (hasLegacyEffortCombobox(entries)) return undefined;

  for (const entry of entries) {
    if (entry.kind !== "menuitemradio" || checkedState(entry) !== true) continue;
    const compactSelection = compactSelectionFromEntry(entry, entries, { allowClosedButtons: false });
    if (compactSelection) return compactSelection;
  }

  if (hasCompactIntelligenceMenuContext(entries)) return undefined;

  for (const entry of entries) {
    if (entry.kind !== "button") continue;
    const compactSelection = compactSelectionFromEntry(entry, entries);
    if (!compactSelection) continue;
    return compactSelection;
  }
  return undefined;
}

export function matchesRequestedModelControlLabel(label, selection) {
  const compactSelection = parseCompactIntelligenceSelection(label) || parseBareProCompactSelection(label);
  if (compactSelection) return compactSelectionMatchesRequested(selection, compactSelection);
  return matchesModelFamilyLabel(label, selection.modelFamily);
}

export function matchesCompactIntelligenceOpenerLabel(label) {
  return COMPACT_INTELLIGENCE_OPENER_PATTERN.test(normalizeChipLabel(label));
}

function detectComposerChipSelection(entries) {
  for (const entry of entries) {
    if (entry.disabled || entry.kind !== "button") continue;
    if (/\bexpanded=true\b/.test(String(entry.line || "")) && !/click to remove/i.test(String(entry.label || ""))) continue;
    const selection = parseComposerChipSelection(entry.label);
    if (selection) return selection;
  }
  return undefined;
}

function checkedState(entry) {
  const line = String(entry?.line || "");
  if (/\bchecked=true\b/.test(line) || /\bselected\b/.test(line)) return true;
  if (/\bchecked=false\b/.test(line)) return false;
  return undefined;
}

function detectSelectedModelFamily(entries) {
  const compactSelection = detectCompactIntelligenceSelection(entries);
  if (compactSelection) return compactSelection.modelFamily;

  for (const entry of entries) {
    if (entry.disabled || !MODEL_FAMILY_CONTROL_KINDS.has(entry.kind || "") || checkedState(entry) !== true) continue;
    for (const family of /** @type {OracleUiModelFamily[]} */ (["instant", "thinking", "pro"])) {
      if (matchesModelFamilyLabel(entry.label, family)) return family;
    }
  }

  const hasLatestModelCombobox = entries.some(
    (entry) => !entry.disabled && entry.kind === "combobox" && normalizeText(entry.label).toLowerCase() === "model" && /^latest\b/i.test(normalizeText(entry.value)),
  );
  if (hasLatestModelCombobox) return undefined;

  const hasProEffortCombobox = entries.some(
    (entry) => !entry.disabled && entry.kind === "combobox" && normalizeText(entry.label).toLowerCase() === PRO_THINKING_EFFORT_COMBOBOX_LABEL.toLowerCase(),
  );
  if (hasProEffortCombobox) return "pro";

  const hasAutoSwitchControl = entries.some((entry) => {
    if (entry.disabled || !["button", "switch"].includes(entry.kind || "")) return false;
    const controlText = normalizeText([entry.label, entry.value, entry.line].filter(Boolean).join(" "));
    return controlText.toLowerCase().includes(AUTO_SWITCH_LABEL.toLowerCase());
  });
  if (hasAutoSwitchControl) return "instant";

  const hasThinkingEffortCombobox = entries.some(
    (entry) => !entry.disabled && entry.kind === "combobox" && normalizeText(entry.label).toLowerCase() === THINKING_EFFORT_COMBOBOX_LABEL.toLowerCase(),
  );
  if (hasThinkingEffortCombobox) return "thinking";

  return undefined;
}

function selectionMatchesChipSelection(selection, chipSelection) {
  if (!chipSelection || chipSelection.modelFamily !== selection.modelFamily) return false;
  if (selection.modelFamily === "thinking" || selection.modelFamily === "pro") {
    return chipSelection.effort === (selection.effort || "standard");
  }
  return selection.autoSwitchToThinking !== true;
}

export function effortSelectionVisible(snapshot, effortLabel) {
  if (!effortLabel) return true;
  /** @type {SnapshotEntry[]} */
  const entries = parseSnapshotEntries(snapshot);
  const normalizedEffort = effortLabel.toLowerCase();
  if (normalizedEffort === "extended" && hasCurrentPowerEffortMenu(entries)) return true;
  const compactClosedButtonsAllowed = !hasRemovableComposerModelChip(entries) && !hasLegacyEffortCombobox(entries) && !hasCompactIntelligenceMenuContext(entries);
  return entries.some((entry) => {
    if (entry.disabled) return false;
    const compactSelection = compactSelectionFromEntry(entry, entries, { allowClosedButtons: compactClosedButtonsAllowed });
    if (compactSelection && entry.kind === "menuitemradio" && checkedState(entry) !== true) return false;
    if (compactSelection?.modelFamily === "thinking") {
      return compactSelectionMatchesRequested({ modelFamily: "thinking", effort: /** @type {import("./chatgpt-ui-helpers.d.mts").OracleUiEffort} */ (normalizedEffort), autoSwitchToThinking: false }, compactSelection);
    }
    if (compactSelection?.modelFamily === "pro") return !compactSelection.effort || compactSelection.effort === normalizedEffort;
    if (entry.kind === "combobox" && normalizeText(entry.value).toLowerCase() === normalizedEffort) return true;
    const chipSelection = entry.kind === "button" ? parseComposerChipSelection(entry.label) : undefined;
    if (chipSelection?.effort === normalizedEffort) return true;
    if (entry.kind !== "button") return false;
    const label = normalizeChipLabel(entry.label).toLowerCase();
    return label === normalizedEffort || label === `${normalizedEffort} thinking` || label === `${normalizedEffort} pro`;
  });
}

// The picker's expanded opener is the authority for "open": the redesigned shell's interactive
// snapshot lists the Power and Select model items but omits the menu node that holds them.
function hasCurrentPowerEffortMenu(entries) {
  const hasExpandedEffortOpener = entries.some(
    (entry) => !entry.disabled && entry.kind === "button" && POWER_MENU_LABELS.has(normalizeText(entry.label)) && /\bexpanded=true\b/.test(String(entry.line || "")),
  );
  const menuItems = new Set(
    entries.filter((entry) => !entry.disabled && entry.kind === "menuitem").map((entry) => normalizeText(entry.label)),
  );
  return hasExpandedEffortOpener && menuItems.has("Power") && menuItems.has("Select model");
}

// Deep Research is a composer tool, not a model tier. The "Add files and more" menu lists it with a
// label that joins title and description: a role-less clickable "Deep researchGet a detailed report"
// in the earlier shell, a button "Deep research Get a detailed report" in the current one. Once
// selected, the earlier composer textbox carried a "Deep research" pill; the current one holds an
// app mention (CHATGPT_DEEP_RESEARCH_MENTION_SELECTOR) that only the DOM exposes reliably. After
// send, a cross-origin App widget renders the actual report.
const DEEP_RESEARCH_MENU_LABEL_PATTERN = /^Deep research\s*\S/i; // the description always follows the title
const DEEP_RESEARCH_MENU_ENTRY_KINDS = new Set(["generic", "button", "menuitem"]);
const DEEP_RESEARCH_PILL_LABEL = "deep research";
const DEEP_RESEARCH_PLACEHOLDER_PATTERN = /^Deep Research has started working on your\b/i; // model-written; the topic varies

/**
 * @param {SnapshotEntry} entry
 * @returns {boolean}
 */
export function isDeepResearchMenuEntry(entry) {
  return !entry.disabled && DEEP_RESEARCH_MENU_ENTRY_KINDS.has(entry.kind || "") && typeof entry.label === "string" && DEEP_RESEARCH_MENU_LABEL_PATTERN.test(normalizeText(entry.label));
}

/**
 * True when the earlier composer textbox carries the Deep research pill: a "Deep research" generic
 * nested directly beneath the composer textbox line.
 * @param {string} snapshot
 * @returns {boolean}
 */
export function snapshotHasDeepResearchPill(snapshot) {
  const lines = String(snapshot || "").split("\n");
  const textboxIndex = lines.findIndex((line) => CHATGPT_COMPOSER_LABELS.some((label) => line.includes(`textbox "${label}"`)));
  if (textboxIndex < 0) return false;
  const textboxIndent = lines[textboxIndex].search(/\S/);
  for (let index = textboxIndex + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.trim()) continue;
    const indent = line.search(/\S/);
    if (line.trimStart().startsWith("- ") && indent <= textboxIndent) return false;
    const match = line.match(/-\s+generic\s+"([^"]+)"/);
    if (match && normalizeText(match[1]).toLowerCase() === DEEP_RESEARCH_PILL_LABEL) return true;
  }
  return false;
}

// The widget iframe's accessible name: the earlier shell titled it internal://deep-research, the
// current one "Deep research".
const DEEP_RESEARCH_WIDGET_PATTERN = /Iframe "(?:internal:\/\/deep-research|Deep research)"/;

/**
 * Classify the assistant turn of a Deep Research submission. "started" means the research widget
 * (a cross-origin App iframe, see DEEP_RESEARCH_WIDGET_PATTERN) is on the page, or the assistant
 * text is the model-written "Deep Research has started working…" placeholder; "reply" means the
 * model answered or asked something instead of starting research.
 * @param {{ snapshot?: string; text?: string }} turn
 * @returns {"started" | "reply"}
 */
export function classifyDeepResearchTurn(turn) {
  if (DEEP_RESEARCH_WIDGET_PATTERN.test(String(turn.snapshot || ""))) return "started";
  return DEEP_RESEARCH_PLACEHOLDER_PATTERN.test(normalizeText(stripChatGptResponseChrome(turn.text))) ? "started" : "reply";
}

// The finished Deep Research widget renders "Research completed in <t> · <n> citations · <m>
// searches" followed by the report. The header's counts are animated tabular-nums counters that
// innerText serializes as one 0–9 digit per line, repeated per digit column, before the
// " citations · … searches" suffix. Single-digit lines inside the body are citation markers and
// must be kept.
const DEEP_RESEARCH_COMPLETED_PATTERN = /^Research completed in\b/i;

/**
 * @param {string | undefined} text innerText of the widget's report frame
 * @returns {{ completed: boolean; report: string }}
 */
export function parseDeepResearchWidgetText(text) {
  const lines = String(text || "").replace(/\r\n?/g, "\n").split("\n");
  const headerIndex = lines.findIndex((line) => DEEP_RESEARCH_COMPLETED_PATTERN.test(line.trim()));
  if (headerIndex < 0) return { completed: false, report: "" };
  // Header region after the marker: for each count, one 0-9 run per digit column, then its label
  // (" citations · " / " searches"). Skip digit runs and label lines until the first body line.
  let index = headerIndex + 1;
  while (index < lines.length) {
    const line = lines[index].trim();
    if (/^\d$/.test(line) || /^(citations?|searches?)\b/i.test(line) || /^(citations?|searches?)?\s*·\s*(citations?|searches?)?$/i.test(line) || line === "") index += 1;
    else break;
  }
  const report = lines.slice(index).join("\n").replace(/^\n+/, "").trimEnd();
  return { completed: true, report };
}

// Current ChatGPT renders the thinking-effort tiers as a discrete slider inside the
// "Thinking effort" menu. Only the current stop is rendered; its live description reads
// "<Label>, <n> of <count>." and the stops step with ArrowLeft/ArrowRight.
export const POWER_SLIDER_TIER_LABELS = Object.freeze(["Instant", "Medium", "High", "Extra High", "Pro"]);

/**
 * Merge only UI-control facts already read by the worker, never requested settings or page text.
 * Unknown labels remain unclassified; a verified research tool takes precedence over the picker.
 * @param {import("../shared/job-observability-helpers.mjs").OracleObservedSelection | undefined} previous
 * @param {Partial<Omit<import("../shared/job-observability-helpers.mjs").OracleObservedSelection, "product">>} observation
 * @returns {import("../shared/job-observability-helpers.mjs").OracleObservedSelection}
 */
export function mergeObservedSelection(previous, observation) {
  const next = { ...previous, at: observation.at ?? new Date().toISOString() };
  if (observation.modelLabel === null) delete next.modelLabel;
  else if (observation.modelLabel) next.modelLabel = observation.modelLabel.slice(0, 80);
  if (observation.effortLabel === null) next.effortLabel = null;
  else if (observation.effortLabel) {
    next.effortLabel = observation.effortLabel.slice(0, 80);
    delete next.effortControls;
  }
  if (observation.effortControls === "absent" || observation.effortControls === "unavailable") {
    next.effortControls = observation.effortControls;
  }
  if (observation.deepResearchVerified === true) next.deepResearchVerified = true;
  if (observation.deepResearchIframeTitle && /^deep research$/i.test(observation.deepResearchIframeTitle)) {
    next.deepResearchIframeTitle = observation.deepResearchIframeTitle;
  }
  const label = (observation.effortLabel || observation.modelLabel || "")
    .replace(/^(?:Pro )?Thinking effort\s+/i, "").replace(/\s+\(\d+ of \d+\)$/, "");
  if (next.deepResearchVerified || next.deepResearchIframeTitle) next.product = "deep_research";
  else if (/\bPro\b/i.test(label)) next.product = "pro";
  else if (/\bInstant\b/i.test(label)) next.product = "instant";
  else if (/\bThinking\b/i.test(label) || /^(?:Medium|High|Extra High)$/i.test(label)) next.product = "thinking";
  else if (label || observation.modelLabel === null || observation.effortLabel === null) delete next.product;
  return next;
}

/**
 * @param {string} snapshot
 * @returns {boolean}
 */
export function snapshotHasPowerSliderMenu(snapshot) {
  return hasCurrentPowerEffortMenu(parseSnapshotEntries(snapshot));
}

/**
 * Whether the thinking-effort picker closed on the requested stop. Stepping down to Instant from a
 * thinking tier can close the whole picker (observed 2026-09-21 right after `thinking_heavy`): the
 * Power slider unmounts mid-stepping and the composer pill already reads the target, which the
 * driver must accept as "set", not as a lost control.
 * @param {string} snapshot
 * @param {OracleUiSelection} selection
 * @returns {boolean}
 */
export function powerSliderClosedIntoSelection(snapshot, selection) {
  return !snapshotHasPowerSliderMenu(snapshot) && snapshotHasClosedCompactSelection(snapshot, selection);
}

/**
 * @param {string | undefined} description
 * @returns {{ label: string; index: number; count: number } | undefined}
 */
export function parsePowerSliderDescription(description) {
  const match = String(description || "").match(/^\s*(.+?),\s*(\d+)\s+of\s+(\d+)\./);
  if (!match) return undefined;
  const index = Number(match[2]);
  const count = Number(match[3]);
  if (!Number.isInteger(index) || !Number.isInteger(count) || index < 1 || count < 1 || index > count) return undefined;
  return { label: normalizeText(match[1]), index, count };
}

/**
 * The slider stop that satisfies a selection, mirroring compactSelectionMatchesRequested:
 * Pro has one undifferentiated stop, and light thinking shares Medium with standard.
 * @param {OracleUiSelection} selection
 * @returns {string}
 */
export function powerSliderTargetLabel(selection) {
  if (selection.modelFamily === "instant") return "Instant";
  if (selection.modelFamily === "pro") return "Pro";
  const effort = selection.effort || "standard";
  if (effort === "extended") return "High";
  if (effort === "heavy") return "Extra High";
  return "Medium";
}

/**
 * @param {string} currentLabel
 * @param {string} targetLabel
 * @returns {"ArrowLeft" | "ArrowRight" | undefined}
 */
export function powerSliderStepKey(currentLabel, targetLabel) {
  const current = POWER_SLIDER_TIER_LABELS.indexOf(normalizeText(currentLabel));
  const target = POWER_SLIDER_TIER_LABELS.indexOf(normalizeText(targetLabel));
  if (current < 0 || target < 0 || current === target) return undefined;
  return target > current ? "ArrowRight" : "ArrowLeft";
}

/**
 * @param {string} snapshot
 * @returns {boolean}
 */
export function snapshotHasModelConfigurationUi(snapshot) {
  /** @type {SnapshotEntry[]} */
  const entries = parseSnapshotEntries(snapshot);
  if (hasCurrentPowerEffortMenu(entries)) return true;
  const hasCollapsedAdvancedOptions = entries.some(
    (entry) => !entry.disabled && entry.kind === "menuitem" && normalizeText(entry.label) === "Show advanced options",
  );
  if (hasCollapsedAdvancedOptions) return false;
  const visibleFamilies = new Set(
    entries
      .filter((entry) => entry.kind === "button" && typeof entry.label === "string")
      .flatMap((entry) =>
        /** @type {OracleUiModelFamily[]} */ (["instant", "thinking", "pro"])
          .filter((family) => matchesModelFamilyLabel(entry.label, family)),
      ),
  );
  const visibleRadioFamilies = new Set(
    entries
      .filter((entry) => entry.kind === "radio" && typeof entry.label === "string")
      .flatMap((entry) =>
        /** @type {OracleUiModelFamily[]} */ (["instant", "thinking", "pro"])
          .filter((family) => matchesModelFamilyLabel(entry.label, family)),
      ),
  );
  const visibleCompactControls = entries.filter(
    (entry) => !entry.disabled && entry.kind === "menuitemradio" && compactSelectionFromEntry(entry, entries),
  );
  const hasCollapsedEffortOptions = entries.some(
    (entry) => !entry.disabled && entry.kind === "menuitem" && normalizeText(entry.label).startsWith("Effort ") && !String(entry.line || "").includes("expanded=true"),
  );
  if (hasCollapsedEffortOptions && visibleCompactControls.length === 0) return false;
  const hasCompactIntelligenceMenu = hasOpenCompactIntelligenceMenu(entries);
  const hasIntelligenceHeading = entries.some((entry) => entry.kind === "heading" && normalizeText(entry.label) === "Intelligence" && !entry.disabled);
  const hasEffortCombobox = entries.some(
    (entry) => entry.kind === "combobox" && EFFORT_LABELS.has(entry.value || "") && !entry.disabled,
  );
  return visibleFamilies.size >= 2 || visibleRadioFamilies.size >= 2 || visibleCompactControls.length >= 2 || hasCompactIntelligenceMenu || hasIntelligenceHeading || hasEffortCombobox;
}

/**
 * A composer textbox of either ChatGPT shell, in any state.
 * @param {SnapshotEntry} entry
 * @returns {boolean}
 */
export function isChatGptComposerEntry(entry) {
  return entry.kind === "textbox" && typeof entry.label === "string" && CHATGPT_COMPOSER_LABELS.includes(entry.label);
}

/**
 * An enabled stop control of either ChatGPT shell: a turn is still generating.
 * @param {SnapshotEntry} entry
 * @returns {boolean}
 */
export function isChatGptStopEntry(entry) {
  return entry.kind === "button" && !entry.disabled && typeof entry.label === "string" && CHATGPT_STOP_LABELS.includes(entry.label);
}

/**
 * @param {string} snapshot
 * @returns {boolean}
 */
export function snapshotHasUsableComposerControls(snapshot) {
  /** @type {SnapshotEntry[]} */
  const entries = parseSnapshotEntries(snapshot);
  const hasComposer = entries.some((entry) => isChatGptComposerEntry(entry) && !entry.disabled);
  const hasAddFiles = entries.some((entry) => entry.kind === "button" && entry.label === CHATGPT_ADD_FILES_LABEL && !entry.disabled);
  return hasComposer && hasAddFiles;
}

/**
 * The dismissal control of a modal that blocks the composer. A modal makes the rest of the page
 * inert, so the interactive snapshot shows only the modal: no composer, and a "Close dialog"
 * button. Only that button is ever offered; actions such as "Get started" never are.
 * @param {string} snapshot
 * @returns {SnapshotEntry | undefined}
 */
export function findDialogCloseEntry(snapshot) {
  /** @type {SnapshotEntry[]} */
  const entries = parseSnapshotEntries(snapshot);
  if (entries.some(isChatGptComposerEntry)) return undefined;
  return entries.find((entry) => entry.kind === "button" && !entry.disabled && entry.label === DIALOG_CLOSE_LABEL);
}

/**
 * Browser-side and closure-free (evaluated in the page through toString): true once the control
 * matching `selector` is visible, enabled, hit-testable at its center, and has not moved for
 * `stableSamples` consecutive samples; false at the deadline. Timer sampling, never
 * requestAnimationFrame: Chrome gives a tab that is not the visible tab of its window no animation
 * frames, and concurrent jobs share one window, so a frame-driven wait never ends in a background
 * job's tab.
 * @param {string} selector
 * @param {{ stableSamples?: number; intervalMs?: number; timeoutMs?: number }} [options]
 * @returns {Promise<boolean>}
 */
export async function waitForStationaryControl(selector, { stableSamples = 3, intervalMs = 100, timeoutMs = 5000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  /** @type {{ x: number; y: number; width: number; height: number } | undefined} */
  let previous;
  let stable = 0;
  for (;;) {
    const control = /** @type {any} */ (globalThis).document.querySelector(selector);
    const rect = control?.getBoundingClientRect();
    const hit = rect && rect.width > 0 && rect.height > 0
      ? /** @type {any} */ (globalThis).document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)
      : null;
    const ready = Boolean(hit) && !control.disabled && control.contains(hit);
    stable = ready && previous && rect.x === previous.x && rect.y === previous.y && rect.width === previous.width && rect.height === previous.height ? stable + 1 : 0;
    previous = ready ? rect : undefined;
    if (stable >= stableSamples) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

/**
 * @param {string} snapshot
 * @returns {boolean}
 */
export function snapshotHasModelOpener(snapshot) {
  return parseSnapshotEntries(snapshot).some(matchesModelConfigurationOpener);
}

/**
 * Composer openers are the current picker button or model chips, not arbitrary family-prefixed
 * response actions.
 * @param {SnapshotEntry} entry
 * @returns {boolean}
 */
export function matchesModelConfigurationOpener(entry) {
  if (entry.disabled || entry.kind !== "button" || typeof entry.label !== "string") return false;
  const label = normalizeChipLabel(entry.label).replace(/^\d+(?:\.\d+)*\s+/, "");
  return label === MODEL_PICKER_LABEL
    || label === "Model"
    || label === "Model selector"
    || COMPACT_INTELLIGENCE_OPENER_PATTERN.test(label)
    || BARE_EFFORT_PATTERN.test(label)
    || THINKING_CHIP_PATTERN.test(label)
    || PRO_CHIP_PATTERN.test(label);
}

export function snapshotHasSelectedLatestModel(snapshot) {
  return parseSnapshotEntries(snapshot).some(
    (entry) => !entry.disabled && entry.kind === "menuitemradio"
      && normalizeText(entry.label) === "Latest" && checkedState(entry) === true,
  );
}

/**
 * @param {string} snapshot
 * @returns {boolean | undefined}
 */
export function autoSwitchToThinkingSelectionVisible(snapshot) {
  /** @type {SnapshotEntry[]} */
  const entries = parseSnapshotEntries(snapshot);
  let foundControl = false;

  for (const entry of entries) {
    const controlText = normalizeText([entry.label, entry.value, entry.line].filter(Boolean).join(" "));
    if (!controlText.toLowerCase().includes(AUTO_SWITCH_LABEL.toLowerCase())) continue;
    foundControl = true;

    if (/\bchecked=true\b/i.test(String(entry.line || ""))) return true;
    if (/\bchecked=false\b/i.test(String(entry.line || ""))) return false;
    if (/\b(?:selected|enabled|on|active)\b/i.test(controlText)) return true;
    if (/\b(?:unchecked|not checked|disabled|off)\b/i.test(controlText)) return false;
    if (typeof entry.label === "string" && /click to remove/i.test(entry.label)) return true;
  }

  return foundControl ? false : undefined;
}

/**
 * @param {string} snapshot
 * @param {OracleUiSelection} selection
 * @returns {boolean}
 */
export function snapshotCanSafelySkipModelConfiguration(snapshot, selection) {
  if (!snapshotStronglyMatchesRequestedModel(snapshot, selection)) return false;
  const hasBareProPill = selection.modelFamily === "pro" && parseSnapshotEntries(snapshot).some(
    (entry) => entry.kind === "button" && !entry.disabled && normalizeChipLabel(entry.label) === "Pro",
  );
  if (hasBareProPill && !snapshotHasModelConfigurationUi(snapshot)) return false;
  if (selection.modelFamily === "instant" && selection.autoSwitchToThinking) {
    return autoSwitchToThinkingSelectionVisible(snapshot) === true;
  }
  return true;
}

/**
 * @param {string} snapshot
 * @param {OracleUiSelection} selection
 * @returns {boolean}
 */
export function snapshotStronglyMatchesRequestedModel(snapshot, selection) {
  /** @type {SnapshotEntry[]} */
  const entries = parseSnapshotEntries(snapshot);
  const compactSelection = detectCompactIntelligenceSelection(entries);
  if (compactSelection) return compactSelectionMatchesRequestedInSnapshot(snapshot, selection, compactSelection);

  const chipSelection = detectComposerChipSelection(entries);
  if (chipSelection) return selectionMatchesChipSelection(selection, chipSelection);

  const selectedModelFamily = detectSelectedModelFamily(entries);
  if (!selectedModelFamily || selectedModelFamily !== selection.modelFamily) return false;

  if (selection.modelFamily === "thinking" || selection.modelFamily === "pro") {
    return effortSelectionVisible(snapshot, requestedEffortLabel(selection));
  }

  if (selection.modelFamily === "instant") {
    const autoSwitchState = autoSwitchToThinkingSelectionVisible(snapshot);
    if (selection.autoSwitchToThinking) return autoSwitchState === true;
    return autoSwitchState !== true;
  }

  return false;
}

/**
 * @param {string} snapshot
 * @param {OracleUiSelection} selection
 * @returns {boolean}
 */
export function snapshotWeaklyMatchesRequestedModel(snapshot, selection) {
  /** @type {SnapshotEntry[]} */
  const entries = parseSnapshotEntries(snapshot);
  const compactSelection = detectCompactIntelligenceSelection(entries);
  if (compactSelection) return compactSelectionMatchesRequestedInSnapshot(snapshot, selection, compactSelection, { weak: true });

  const chipSelection = detectComposerChipSelection(entries);
  if (chipSelection) return selectionMatchesChipSelection(selection, chipSelection);

  const selectedModelFamily = detectSelectedModelFamily(entries);
  if (!selectedModelFamily || selectedModelFamily !== selection.modelFamily) return false;

  if (selection.modelFamily === "instant") {
    const autoSwitchState = autoSwitchToThinkingSelectionVisible(snapshot);
    return selection.autoSwitchToThinking ? autoSwitchState !== false : autoSwitchState !== true;
  }

  return true;
}

/**
 * @param {CompletionSignatureArgs} args
 * @returns {string | undefined}
 */
export function buildAssistantCompletionSignature({ responseText, artifactLabels = [] }) {
  const normalizedResponse = normalizeText(responseText);
  if (normalizedResponse) return `text:${normalizedResponse}`;

  const labels = uniqueStrings(artifactLabels.map((value) => normalizeText(value))).sort((left, right) => left.localeCompare(right));
  if (labels.length > 0) return `artifacts:${labels.join("|")}`;

  return undefined;
}

/**
 * @param {DerivedCompletionSignatureArgs} args
 * @returns {string | undefined}
 */
export function deriveAssistantCompletionSignature({
  hasStopStreaming,
  hasTargetCopyResponse,
  responseText,
  artifactLabels = [],
}) {
  if (hasStopStreaming) return undefined;

  if (hasTargetCopyResponse && normalizeText(responseText)) {
    return buildAssistantCompletionSignature({ responseText });
  }

  if (!normalizeText(responseText)) {
    return buildAssistantCompletionSignature({ responseText, artifactLabels });
  }

  return undefined;
}
