import { parseSnapshotEntries } from "./artifact-heuristics.mjs";

export const CHATGPT_CANONICAL_APP_ORIGINS = Object.freeze([
  "https://chatgpt.com",
  "https://chat.openai.com",
]);

const MODEL_FAMILY_PREFIX = {
  instant: "Instant ",
  thinking: "Thinking ",
  pro: "Pro ",
};

const AUTO_SWITCH_LABEL = "Auto-switch to Thinking";

function originFromUrl(url) {
  if (typeof url !== "string" || !url.trim()) return undefined;
  try {
    return new URL(url).origin;
  } catch {
    return undefined;
  }
}

function uniqueStrings(values) {
  return [...new Set(values.filter((value) => typeof value === "string" && value))];
}

function titleCase(value) {
  return value ? `${value[0].toUpperCase()}${value.slice(1)}` : value;
}

function normalizeText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

export function buildAllowedChatGptOrigins(chatUrl, authUrl) {
  return uniqueStrings([
    ...CHATGPT_CANONICAL_APP_ORIGINS,
    originFromUrl(chatUrl),
    originFromUrl(authUrl),
    "https://auth.openai.com",
  ]);
}

export function matchesModelFamilyLabel(label, family) {
  const normalized = String(label || "");
  const prefix = MODEL_FAMILY_PREFIX[family];
  const exact = prefix.trim();
  return normalized === exact || normalized.startsWith(prefix) || normalized.startsWith(`${exact},`);
}

export function requestedEffortLabel(selection) {
  return selection?.effort ? titleCase(selection.effort) : undefined;
}

export function effortSelectionVisible(snapshot, effortLabel) {
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

export function thinkingChipVisible(snapshot) {
  return /button "(?:Light|Standard|Extended|Heavy)(?: thinking)?(?:, click to remove)?"/i.test(snapshot);
}

export function snapshotHasModelConfigurationUi(snapshot) {
  const entries = parseSnapshotEntries(snapshot);
  const visibleFamilies = new Set(
    entries
      .filter((entry) => entry.kind === "button" && typeof entry.label === "string")
      .flatMap((entry) =>
        Object.keys(MODEL_FAMILY_PREFIX)
          .filter((family) => matchesModelFamilyLabel(entry.label, family))
          .map((family) => family),
      ),
  );
  const hasCloseButton = entries.some((entry) => entry.kind === "button" && entry.label === "Close" && !entry.disabled);
  const hasEffortCombobox = entries.some(
    (entry) => entry.kind === "combobox" && ["Light", "Standard", "Extended", "Heavy"].includes(entry.value || "") && !entry.disabled,
  );
  return visibleFamilies.size >= 2 || hasCloseButton || hasEffortCombobox;
}

export function autoSwitchToThinkingSelectionVisible(snapshot) {
  const entries = parseSnapshotEntries(snapshot);
  let foundControl = false;

  for (const entry of entries) {
    const controlText = normalizeText([entry.label, entry.value, entry.line].filter(Boolean).join(" "));
    if (!controlText.toLowerCase().includes(AUTO_SWITCH_LABEL.toLowerCase())) continue;
    foundControl = true;

    if (/\b(?:checked|selected|enabled|on|active)\b/i.test(controlText)) return true;
    if (/\b(?:unchecked|not checked|disabled|off)\b/i.test(controlText)) return false;
    if (typeof entry.label === "string" && /click to remove/i.test(entry.label)) return true;
  }

  return foundControl ? false : undefined;
}

export function snapshotCanSafelySkipModelConfiguration(snapshot, selection) {
  if (!snapshotStronglyMatchesRequestedModel(snapshot, selection)) return false;

  if (selection.modelFamily === "thinking" || selection.modelFamily === "pro") {
    const effortLabel = requestedEffortLabel(selection);
    if (effortLabel && !effortSelectionVisible(snapshot, effortLabel)) return false;
  }

  if (selection.modelFamily === "instant" && selection.autoSwitchToThinking) {
    return autoSwitchToThinkingSelectionVisible(snapshot) === true;
  }

  return true;
}

export function snapshotStronglyMatchesRequestedModel(snapshot, selection) {
  const entries = parseSnapshotEntries(snapshot);
  const familyMatched = entries.some((entry) => {
    return !entry.disabled && matchesModelFamilyLabel(entry.label, selection.modelFamily);
  });
  if (!familyMatched) return false;

  const configurationUiVisible = snapshotHasModelConfigurationUi(snapshot);
  const effortLabel = requestedEffortLabel(selection);

  if (selection.modelFamily === "thinking" || selection.modelFamily === "pro") {
    if (!effortLabel) return true;
    if (effortSelectionVisible(snapshot, effortLabel)) return true;
    return !configurationUiVisible;
  }

  if (selection.modelFamily === "instant") {
    const autoSwitchState = autoSwitchToThinkingSelectionVisible(snapshot);
    if (selection.autoSwitchToThinking) {
      return autoSwitchState === true || (!configurationUiVisible && autoSwitchState === undefined);
    }
    return autoSwitchState !== true;
  }

  return false;
}

export function snapshotWeaklyMatchesRequestedModel(snapshot, selection) {
  const entries = parseSnapshotEntries(snapshot);
  const familyMatched = entries.some((entry) => {
    return !entry.disabled && matchesModelFamilyLabel(entry.label, selection.modelFamily);
  });

  if (selection.modelFamily === "thinking") {
    return familyMatched || effortSelectionVisible(snapshot, requestedEffortLabel(selection));
  }

  if (!familyMatched) return false;

  if (selection.modelFamily === "pro") {
    return !thinkingChipVisible(snapshot);
  }

  if (selection.modelFamily === "instant") {
    const autoSwitchState = autoSwitchToThinkingSelectionVisible(snapshot);
    return selection.autoSwitchToThinking ? autoSwitchState !== false : autoSwitchState !== true;
  }

  return false;
}

export function buildAssistantCompletionSignature({ responseText, artifactLabels = [], suspiciousArtifactLabels = [] }) {
  const normalizedResponse = normalizeText(responseText);
  if (normalizedResponse) return `text:${normalizedResponse}`;

  const labels = uniqueStrings([...artifactLabels, ...suspiciousArtifactLabels].map((value) => normalizeText(value))).sort((left, right) => left.localeCompare(right));
  if (labels.length > 0) return `artifacts:${labels.join("|")}`;

  return undefined;
}

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
