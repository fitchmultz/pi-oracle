// Purpose: Provide pure provider conversation-state helpers used by the oracle worker.
// Responsibilities: Slice assistant snapshot regions, normalize URLs, and track stable conversation URL observations.
// Scope: Pure worker flow logic only; browser I/O and polling loops stay in run-job.mjs.
// Usage: Imported by run-job.mjs and sanity tests to validate conversation-state heuristics without driving a browser.
// Invariants/Assumptions: Snapshot text comes from agent-browser `snapshot -i`; URL inputs may be malformed and must fail safely.

/** @typedef {import("./chatgpt-flow-helpers.d.mts").OracleStableValueState} OracleStableValueState */

/**
 * @param {string} snapshot
 * @param {string} composerLabel
 * @param {number} responseIndex
 * @returns {string | undefined}
 */
export function assistantSnapshotSlice(snapshot, composerLabel, responseIndex) {
  const lines = snapshot.split("\n");
  const assistantHeadingIndices = lines.flatMap((line, index) => (line.includes('heading "ChatGPT said:"') ? [index] : []));
  const startIndex = assistantHeadingIndices[responseIndex];
  if (startIndex === undefined) return undefined;

  const endCandidates = [];
  const nextAssistantIndex = assistantHeadingIndices[responseIndex + 1];
  if (nextAssistantIndex !== undefined) endCandidates.push(nextAssistantIndex);

  const composerIndex = lines.findIndex(
    (line, index) => index > startIndex && line.includes(`textbox "${composerLabel}"`),
  );
  if (composerIndex !== -1) endCandidates.push(composerIndex);

  const endIndex = endCandidates.length > 0 ? Math.min(...endCandidates) : undefined;
  return lines.slice(startIndex, endIndex).join("\n");
}

/**
 * @param {string | undefined} url
 * @returns {string}
 */
export function stripUrlQueryAndHash(url) {
  if (typeof url !== "string") return "";
  try {
    const parsed = new URL(url);
    parsed.hash = "";
    parsed.search = "";
    return parsed.toString();
  } catch {
    return url;
  }
}

/**
 * @param {string} url
 * @returns {boolean}
 */
export function isConversationPathUrl(url) {
  try {
    return /\/(?:c|chat)\/[A-Za-z0-9-]+$/i.test(new URL(url).pathname);
  } catch {
    return false;
  }
}

/**
 * @param {string} url
 * @param {string | undefined} previousChatUrl
 * @returns {string | undefined}
 */
export function resolveStableConversationUrlCandidate(url, previousChatUrl) {
  const normalizedUrl = stripUrlQueryAndHash(url);
  if (!normalizedUrl) return undefined;
  if (isConversationPathUrl(normalizedUrl)) return normalizedUrl;
  const normalizedPrevious = stripUrlQueryAndHash(previousChatUrl);
  return normalizedPrevious && normalizedPrevious === normalizedUrl ? normalizedUrl : undefined;
}

/**
 * @param {Partial<OracleStableValueState> | undefined} state
 * @param {string} nextValue
 * @returns {OracleStableValueState}
 */
export function nextStableValueState(state, nextValue) {
  return {
    lastValue: nextValue,
    stableCount: state?.lastValue === nextValue ? (state?.stableCount ?? 0) + 1 : 1,
  };
}
