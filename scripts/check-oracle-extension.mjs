// Purpose: Run syntax and bundle checks for the oracle extension in a platform-neutral way.
// Responsibilities: Validate worker/helper modules with node --check and bundle the extension entrypoint.
// Scope: Local verification only; runtime behavior belongs under extensions/oracle.
// Usage: Invoked by npm run check:oracle-extension.
// Invariants/Assumptions: The bundle output is disposable and must be written outside the repository on every platform.
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";

const syntaxCheckPaths = [
  "extensions/oracle/shared/process-helpers.mjs",
  "extensions/oracle/shared/state-coordination-helpers.mjs",
  "extensions/oracle/shared/job-coordination-helpers.mjs",
  "extensions/oracle/shared/job-lifecycle-helpers.mjs",
  "extensions/oracle/shared/job-observability-helpers.mjs",
  "extensions/oracle/worker/run-job.mjs",
  "extensions/oracle/worker/state-locks.mjs",
  "extensions/oracle/worker/artifact-heuristics.mjs",
  "extensions/oracle/worker/chatgpt-ui-helpers.mjs",
  "extensions/oracle/worker/chatgpt-flow-helpers.mjs",
  "extensions/oracle/worker/auth-flow-helpers.mjs",
  "extensions/oracle/worker/auth-cookie-policy.mjs",
  "extensions/oracle/worker/chromium-cookie-source.mjs",
  "extensions/oracle/worker/auth-bootstrap.mjs",
];

for (const path of syntaxCheckPaths) {
  const result = spawnSync(process.execPath, ["--check", path], { stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status ?? 1);
  if (result.error) throw result.error;
}

await build({
  entryPoints: ["extensions/oracle/index.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  external: ["@earendil-works/pi-coding-agent", "@earendil-works/pi-ai", "typebox"],
  outfile: join(tmpdir(), "pi-oracle-extension-check.js"),
});
