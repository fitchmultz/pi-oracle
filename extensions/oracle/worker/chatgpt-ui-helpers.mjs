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
const THINKING_CHIP_PATTERN = /^(?:(light|standard|extended|heavy)\s+)?thinking(?:, click to remove)?$/i;
const PRO_CHIP_PATTERN = /^(?:(light|standard|extended|heavy)\s+)?pro(?:, click to remove)?$/i;
const MODEL_FAMILY_CONTROL_KINDS = new Set(["button", "radio", "menuitemradio"]);

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

  const thinkingMatch = normalized.match(THINKING_CHIP_PATTERN);
  if (thinkingMatch) {
    return {
      modelFamily: /** @type {OracleUiModelFamily} */ ("thinking"),
      effort: /** @type {import("./chatgpt-ui-helpers.d.mts").OracleUiEffort} */ ((thinkingMatch[1] || "standard").toLowerCase()),
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

function detectComposerChipSelection(entries) {
  for (const entry of entries) {
    if (entry.disabled || entry.kind !== "button") continue;
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
  for (const entry of entries) {
    if (entry.disabled || !MODEL_FAMILY_CONTROL_KINDS.has(entry.kind || "") || checkedState(entry) !== true) continue;
    for (const family of /** @type {OracleUiModelFamily[]} */ (["instant", "thinking", "pro"])) {
      if (matchesModelFamilyLabel(entry.label, family)) return family;
    }
  }

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
  return entries.some((entry) => {
    if (entry.disabled) return false;
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
  const hasCloseButton = entries.some((entry) => entry.kind === "button" && entry.label === "Close" && !entry.disabled);
  const hasEffortCombobox = entries.some(
    (entry) => entry.kind === "combobox" && ["Light", "Standard", "Extended", "Heavy"].includes(entry.value || "") && !entry.disabled,
  );
  return visibleFamilies.size >= 2 || hasCloseButton || hasEffortCombobox;
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
