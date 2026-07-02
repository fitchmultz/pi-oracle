// Purpose: Tiny shared time parsing helper for job timestamps.

export function parseTimestamp(value) {
  if (!value) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}
