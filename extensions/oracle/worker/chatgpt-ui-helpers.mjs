// Purpose: Provide pure ChatGPT UI interpretation helpers shared by oracle worker/auth flows.
// Responsibilities: Normalize allowed origins, interpret model-selection snapshots, and derive assistant-completion signatures.
// Scope: Pure snapshot/text heuristics only; browser I/O and retry loops stay in the worker/auth entrypoints.
// Usage: Imported by worker/auth runtime code and sanity tests to keep browser-driven logic behaviorally testable.
// Invariants/Assumptions: Snapshot text comes from agent-browser `snapshot -i`; helper outputs must stay deterministic and side-effect free.

import { parseSnapshotEntries } from "./artifact-heuristics.mjs";

/** @typedef {import("./chatgpt-ui-helpers.d.mts").OracleUiModelFamily} OracleUiModelFamily */
/** @typedef {import("./chatgpt-ui-helpers.d.mts").OracleUiSelection} OracleUiSelection */
/** @typedef {import("./artifact-heuristics.d.mts").SnapshotEntry} SnapshotEntry */

/** @typedef {{ responseText: string; artifactLabels?: string[]; suspiciousArtifactLabels?: string[] }} CompletionSignatureArgs */
/** @typedef {{ hasStopStreaming: boolean; hasTargetCopyResponse: boolean; responseText: string; artifactLabels?: string[]; suspiciousArtifactLabels?: string[] }} DerivedCompletionSignatureArgs */

export const CHATGPT_CANONICAL_APP_ORIGINS = Object.freeze([
  "https://chatgpt.com",
  "https://chat.openai.com",
]);

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
  const normalized = String(label || "");
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

function hasCompactIntelligenceMenuContext(entries) {
  return entries.some((entry) => !entry.disabled && entry.kind === "menu" && COMPACT_INTELLIGENCE_MENU_PATTERN.test(normalizeText(entry.label)))
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

/**
 * @param {string} snapshot
 * @returns {boolean}
 */
export function thinkingChipVisible(snapshot) {
  return /button "(?:Light|Standard|Extended|Heavy)(?: thinking)?(?:, click to remove)?"/i.test(snapshot);
}

/**
 * @param {string} snapshot
 * @returns {boolean}
 */
export function snapshotHasModelConfigurationUi(snapshot) {
  /** @type {SnapshotEntry[]} */
  const entries = parseSnapshotEntries(snapshot);
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
  const hasCompactIntelligenceMenu = entries.some(
    (entry) => !entry.disabled && entry.kind === "menu" && COMPACT_INTELLIGENCE_MENU_PATTERN.test(normalizeText(entry.label)),
  );
  const hasIntelligenceHeading = entries.some((entry) => entry.kind === "heading" && normalizeText(entry.label) === "Intelligence" && !entry.disabled);
  const hasEffortCombobox = entries.some(
    (entry) => entry.kind === "combobox" && EFFORT_LABELS.has(entry.value || "") && !entry.disabled,
  );
  return visibleFamilies.size >= 2 || visibleRadioFamilies.size >= 2 || visibleCompactControls.length >= 2 || hasCompactIntelligenceMenu || hasIntelligenceHeading || hasEffortCombobox;
}

/**
 * @param {string} snapshot
 * @returns {boolean}
 */
export function snapshotHasUsableComposerControls(snapshot) {
  /** @type {SnapshotEntry[]} */
  const entries = parseSnapshotEntries(snapshot);
  const hasComposer = entries.some((entry) => entry.kind === "textbox" && entry.label === "Chat with ChatGPT" && !entry.disabled);
  const hasAddFiles = entries.some((entry) => entry.kind === "button" && entry.label === "Add files and more" && !entry.disabled);
  return hasComposer && hasAddFiles;
}

/**
 * @param {string} snapshot
 * @returns {boolean}
 */
export function snapshotHasModelOpener(snapshot) {
  /** @type {SnapshotEntry[]} */
  const entries = parseSnapshotEntries(snapshot);
  return entries.some((entry) => {
    if (entry.disabled || entry.kind !== "button" || typeof entry.label !== "string") return false;
    const label = normalizeChipLabel(entry.label);
    return label === "Model"
      || label === "Model selector"
      || COMPACT_INTELLIGENCE_OPENER_PATTERN.test(label)
      || EFFORT_LABELS.has(label)
      || ["instant", "thinking", "pro"].some((family) => matchesModelFamilyLabel(label, /** @type {OracleUiModelFamily} */ (family)))
      || THINKING_CHIP_PATTERN.test(label)
      || PRO_CHIP_PATTERN.test(label);
  });
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
export function buildAssistantCompletionSignature({ responseText, artifactLabels = [], suspiciousArtifactLabels = [] }) {
  const normalizedResponse = normalizeText(responseText);
  if (normalizedResponse) return `text:${normalizedResponse}`;

  const labels = uniqueStrings([...artifactLabels, ...suspiciousArtifactLabels].map((value) => normalizeText(value))).sort((left, right) => left.localeCompare(right));
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
  suspiciousArtifactLabels = [],
}) {
  if (hasStopStreaming) return undefined;

  if (hasTargetCopyResponse && normalizeText(responseText)) {
    return buildAssistantCompletionSignature({ responseText });
  }

  if (!normalizeText(responseText)) {
    return buildAssistantCompletionSignature({ responseText, artifactLabels, suspiciousArtifactLabels });
  }

  return undefined;
}
