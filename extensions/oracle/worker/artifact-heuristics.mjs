export const FILE_LABEL_PATTERN_SOURCE = String.raw`(?:^|[^\w])[^\n]*\.[A-Za-z0-9]{1,12}(?:$|[^\w])`;
const FILE_LABEL_PATTERN = new RegExp(FILE_LABEL_PATTERN_SOURCE);
export const GENERIC_ARTIFACT_LABELS = ["ATTACHED", "DONE"];
const GENERIC_ARTIFACT_LABEL_SET = new Set(GENERIC_ARTIFACT_LABELS);

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

export function isLikelyArtifactLabel(label) {
  const normalized = normalizeText(label);
  if (!normalized) return false;
  if (GENERIC_ARTIFACT_LABEL_SET.has(normalized.toUpperCase())) return true;
  return FILE_LABEL_PATTERN.test(normalized);
}

export function isStructuralArtifactCandidate(candidate) {
  const label = normalizeText(candidate?.label);
  if (!isLikelyArtifactLabel(label)) return false;

  const listItemText = normalizeText(candidate?.listItemText);
  const listItemFileButtonCount = Number(candidate?.listItemFileButtonCount || 0);
  const paragraphFileButtonCount = Number(candidate?.paragraphFileButtonCount || 0);
  const paragraphOtherTextLength = Number(candidate?.paragraphOtherTextLength ?? Number.POSITIVE_INFINITY);
  const focusableFileButtonCount = Number(candidate?.focusableFileButtonCount || 0);
  const focusableOtherTextLength = Number(candidate?.focusableOtherTextLength ?? Number.POSITIVE_INFINITY);

  if (listItemText === label && listItemFileButtonCount === 1) {
    return true;
  }

  if (paragraphFileButtonCount === 1 && paragraphOtherTextLength <= 32) {
    return true;
  }

  if (focusableFileButtonCount >= 1 && focusableOtherTextLength <= 64) {
    return true;
  }

  return false;
}

export function filterStructuralArtifactCandidates(candidates) {
  const seen = new Set();
  const filtered = [];
  for (const candidate of candidates || []) {
    const label = normalizeText(candidate?.label);
    if (!label || seen.has(label)) continue;
    if (!isStructuralArtifactCandidate(candidate)) continue;
    seen.add(label);
    filtered.push({ label });
  }
  return filtered;
}
