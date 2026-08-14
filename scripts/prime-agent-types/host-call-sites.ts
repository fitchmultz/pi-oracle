// Purpose: Exercise Oracle's host adapter from the current Prime Agent context and input shapes.
// Responsibilities: Prove the adapter accepts Prime contexts without legacy mode or streamingBehavior fields.
// Scope: Compile-time compatibility only; runtime behavior remains covered by Oracle's existing sanity suites.
// Usage: Included only by tsconfig.prime-agent.json.
// Invariants/Assumptions: A Prime input event has text/source but no legacy delivery hint.
import type {
  ExtensionCommandContext,
  ExtensionContext,
  InputEvent,
} from "@earendil-works/pi-coding-agent";
import {
  getOracleInputDelivery,
  getOracleProjectConfigDirName,
  isOracleInteractiveContext,
  isOraclePrintContext,
  resolveOracleSavedProjectTrust,
  shouldExposeOraclePromptPaths,
  shouldRunOraclePoller,
} from "../../extensions/oracle/lib/host.js";

declare const context: ExtensionContext;
declare const commandContext: ExtensionCommandContext;
declare const input: InputEvent;

getOracleInputDelivery(input, context);
getOracleProjectConfigDirName();
isOracleInteractiveContext(context);
isOraclePrintContext(commandContext);
shouldExposeOraclePromptPaths(context);
shouldRunOraclePoller(context);
resolveOracleSavedProjectTrust({
  cwd: "/workspace",
  trustCwd: "/workspace",
  agentDir: "/home/example/.prime/agent",
  projectConfigExists: true,
});
