/**
 * Minimal assertion writer for platform smoke artifacts.
 */

import { writeFileSync } from "node:fs";
import { resolve } from "node:path";

export function runAssertions(dir, checks) {
  let ok = true;
  const results = [];
  for (const check of checks) {
    try {
      const passed = Boolean(check.fn());
      if (!passed) ok = false;
      results.push({ id: check.id, ok: passed, ...(passed ? {} : { error: check.error ?? "failed" }) });
    } catch (error) {
      ok = false;
      results.push({ id: check.id, ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  }
  const assertions = { ok, checks: results, writtenAt: new Date().toISOString() };
  writeFileSync(resolve(dir, "assertions.json"), JSON.stringify(assertions, null, 2));
  if (!ok) {
    const lines = [
      "# Assertion Failures",
      "",
      ...results.filter((result) => !result.ok).map((result) => `- **${result.id}**: ${result.error ?? "failed"}`),
      "",
      `Total: ${results.filter((result) => !result.ok).length} failure(s)`,
    ];
    writeFileSync(resolve(dir, "failures.md"), `${lines.join("\n")}\n`);
  }
  return assertions;
}
