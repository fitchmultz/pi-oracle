// Purpose: Parse agent-browser snapshots and infer likely downloadable artifact labels from response UI structure.
// Responsibilities: Extract snapshot entries, detect candidate filenames, and partition strong versus suspicious artifact signals.
// Scope: Pure heuristic parsing only; browser interaction and artifact download orchestration stay in the worker.
// Usage: Imported by worker runtime code, UI helper modules, and sanity tests to keep artifact detection behavior deterministic.
// Invariants/Assumptions: Snapshot text comes from agent-browser `snapshot -i`, and heuristics should prefer false negatives over noisy false positives.
export const FILE_LABEL_PATTERN_SOURCE = String.raw`(?:^|[^A-Za-z0-9._~/-])((?:(?:[A-Za-z]:)?[\\/]|[.~][\\/])?(?:[^\\/\s"'<>|]+[\\/])*[^\\/\s"'<>|]+\.[A-Za-z0-9]{1,12})(?=$|[^A-Za-z0-9._~/-])`;
const FILE_LABEL_PATTERN = new RegExp(FILE_LABEL_PATTERN_SOURCE, "g");
export const GENERIC_ARTIFACT_LABELS = ["ATTACHED", "DONE"];
const GENERIC_ARTIFACT_LABEL_SET = new Set(GENERIC_ARTIFACT_LABELS);
const GENERIC_DOWNLOAD_CONTROL_PATTERN = /(?:^|\b)(?:download|save)(?:\b|$)/i;
const CODE_MEMBER_CALL_LABEL_PATTERN = /^[A-Za-z_$][\w$]*\.(?:catch|close|filter|join|json|map|match|open|read|slice|split|text|then|trim|write)$/;

export function parseSnapshotEntries(snapshot) {
  return String(snapshot || "")
    .split("\n")
    .map((line, lineIndex) => {
      const refMatch = line.match(/\bref=(e\d+)\b/);
      if (!refMatch) return undefined;
      const kindMatch = line.match(/^\s*-\s*([^\s]+)/);
      const quotedMatch = line.match(/"([^"]*)"/);
      const valueMatch = line.match(/:\s*(.+)$/);
      return {
        line,
        lineIndex,
        ref: `@${refMatch[1]}`,
        kind: kindMatch ? kindMatch[1] : undefined,
        label: quotedMatch ? quotedMatch[1] : undefined,
        value: valueMatch ? valueMatch[1].trim() : undefined,
        disabled: /\bdisabled\b/.test(line),
      };
    })
    .filter(Boolean);
}

function normalizeText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function sanitizeArtifactLabel(value) {
  const normalized = normalizeText(value).replace(/^[^A-Za-z0-9._~/-]+|[^A-Za-z0-9._~/-]+$/g, "");
  if (!normalized) return "";
  const basename = normalized.split(/[\\/]/).filter(Boolean).at(-1) || "";
  return basename.replace(/^[^A-Za-z0-9._-]+|[^A-Za-z0-9._-]+$/g, "");
}

export function extractArtifactLabels(value) {
  const seen = new Set();
  const labels = [];
  for (const match of String(value || "").matchAll(FILE_LABEL_PATTERN)) {
    const normalized = sanitizeArtifactLabel(match[1] || match[0] || "");
    if (!normalized || CODE_MEMBER_CALL_LABEL_PATTERN.test(normalized) || seen.has(normalized)) continue;
    seen.add(normalized);
    labels.push(normalized);
  }
  return labels;
}

export function isLikelyArtifactLabel(label) {
  const normalized = normalizeText(label);
  if (!normalized) return false;
  if (GENERIC_ARTIFACT_LABEL_SET.has(normalized.toUpperCase())) return true;
  return extractArtifactLabels(normalized).length > 0;
}

function hasGenericDownloadControl(controlLabel) {
  return GENERIC_DOWNLOAD_CONTROL_PATTERN.test(normalizeText(controlLabel));
}

function normalizeCandidate(candidate) {
  const label = normalizeText(candidate?.label);
  return label ? { ...candidate, label } : undefined;
}

function hasArtifactSignal(candidate) {
  const label = normalizeText(candidate?.label);
  if (!isLikelyArtifactLabel(label)) return false;

  const paragraphInteractiveCount = Number(candidate?.paragraphInteractiveCount || 0);
  const listItemInteractiveCount = Number(candidate?.listItemInteractiveCount || 0);
  const focusableInteractiveCount = Number(candidate?.focusableInteractiveCount || 0);
  const paragraphArtifactLabelCount = Number(candidate?.paragraphArtifactLabelCount || 0);
  const listItemArtifactLabelCount = Number(candidate?.listItemArtifactLabelCount || 0);
  const focusableArtifactLabelCount = Number(candidate?.focusableArtifactLabelCount || 0);

  return (
    hasGenericDownloadControl(candidate?.controlLabel) ||
    paragraphInteractiveCount > 0 ||
    listItemInteractiveCount > 0 ||
    focusableInteractiveCount > 0 ||
    paragraphArtifactLabelCount > 0 ||
    listItemArtifactLabelCount > 0 ||
    focusableArtifactLabelCount > 0
  );
}

export function isStructuralArtifactCandidate(candidate) {
  const label = normalizeText(candidate?.label);
  if (!isLikelyArtifactLabel(label)) return false;

  const listItemText = normalizeText(candidate?.listItemText);
  const listItemInteractiveCount = Number(candidate?.listItemInteractiveCount || 0);
  const listItemArtifactLabelCount = Number(candidate?.listItemArtifactLabelCount || 0);
  const paragraphInteractiveCount = Number(candidate?.paragraphInteractiveCount || 0);
  const paragraphArtifactLabelCount = Number(candidate?.paragraphArtifactLabelCount || 0);
  const paragraphOtherTextLength = Number(candidate?.paragraphOtherTextLength ?? Number.POSITIVE_INFINITY);
  const focusableInteractiveCount = Number(candidate?.focusableInteractiveCount || 0);
  const focusableArtifactLabelCount = Number(candidate?.focusableArtifactLabelCount || 0);
  const focusableOtherTextLength = Number(candidate?.focusableOtherTextLength ?? Number.POSITIVE_INFINITY);

  if (listItemText === label && listItemInteractiveCount === 1 && listItemArtifactLabelCount === 1) {
    return true;
  }

  if (paragraphArtifactLabelCount === 1 && paragraphInteractiveCount === 1 && paragraphOtherTextLength <= 32) {
    return true;
  }

  if (focusableArtifactLabelCount >= 1 && focusableInteractiveCount >= 1 && focusableOtherTextLength <= 64) {
    return true;
  }

  return false;
}

export function partitionStructuralArtifactCandidates(candidates) {
  const confirmedSeen = new Set();
  const suspiciousSeen = new Set();
  const confirmed = [];
  const suspicious = [];

  for (const candidate of candidates || []) {
    const normalized = normalizeCandidate(candidate);
    if (!normalized) continue;
    if (!hasArtifactSignal(normalized)) continue;

    if (isStructuralArtifactCandidate(normalized)) {
      if (confirmedSeen.has(normalized.label)) continue;
      confirmedSeen.add(normalized.label);
      confirmed.push(normalized);
      continue;
    }

    if (suspiciousSeen.has(normalized.label)) continue;
    suspiciousSeen.add(normalized.label);
    suspicious.push(normalized);
  }

  return { confirmed, suspicious: suspicious.filter((candidate) => !confirmedSeen.has(candidate.label)) };
}

export function filterStructuralArtifactCandidates(candidates) {
  return partitionStructuralArtifactCandidates(candidates).confirmed;
}
