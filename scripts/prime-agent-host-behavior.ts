// Purpose: Lock the observable host-adapter behavior shared by legacy pi and Prime Agent.
// Responsibilities: Verify mode handling, prompt discovery, poller policy, and streaming input delivery without browser or job side effects.
// Scope: Host adapter only; browser, archive, and durable job behavior remain in the existing Oracle sanity suites.
// Usage: Run through `npm run check:prime-agent` with tsx.
// Invariants/Assumptions: Legacy pi supplies mode/streamingBehavior; Prime intentionally supplies neither.
import assert from "node:assert/strict";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  getOracleInputDelivery,
  isOracleInteractiveContext,
  isOraclePrintContext,
  shouldExposeOraclePromptPaths,
  shouldRunOraclePoller,
} from "../extensions/oracle/lib/host.js";

type HostContextShape = {
  mode?: "tui" | "rpc" | "print" | "json";
  hasUI: boolean;
  isIdle(): boolean;
};

function context(shape: HostContextShape): ExtensionContext {
  return shape as unknown as ExtensionContext;
}

const legacyTui = context({ mode: "tui", hasUI: true, isIdle: () => false });
const legacyPrint = context({ mode: "print", hasUI: false, isIdle: () => true });
const legacyRpc = context({ mode: "rpc", hasUI: false, isIdle: () => true });
const primeIdle = context({ hasUI: true, isIdle: () => true });
const primeStreaming = context({ hasUI: true, isIdle: () => false });

assert.equal(isOracleInteractiveContext(legacyTui), true);
assert.equal(isOraclePrintContext(legacyPrint), true);
assert.equal(shouldRunOraclePoller(legacyPrint), false);
assert.equal(shouldExposeOraclePromptPaths(legacyRpc), true);
assert.deepEqual(getOracleInputDelivery({ streamingBehavior: "steer" }, legacyTui), { deliverAs: "steer" });
assert.equal(getOracleInputDelivery({}, legacyTui), undefined, "legacy pi must preserve its original no-hint delivery behavior");

assert.equal(isOracleInteractiveContext(primeIdle), true);
assert.equal(isOraclePrintContext(primeIdle), false);
assert.equal(shouldRunOraclePoller(primeIdle), true);
assert.equal(shouldExposeOraclePromptPaths(primeIdle), false);
assert.equal(getOracleInputDelivery({ type: "input", text: "/oracle test", source: "interactive" }, primeIdle), undefined);
assert.deepEqual(
  getOracleInputDelivery({ type: "input", text: "/oracle test", source: "interactive" }, primeStreaming),
  { deliverAs: "followUp" },
);

console.log("Prime Agent and legacy pi host behavior passed");
