// Purpose: Execute one registered oracle tool from a slash command, with no model in the loop.
// Responsibilities: Validate the JSON request against the tool's own parameter schema, write the dispatch marker before the tool runs,
// and persist the exact tool result for the calling program.
// Scope: Deterministic host-side control path for drivers that otherwise had to ask a model to type the tool call; the tools themselves are unchanged.
// Usage: Registered by the extension entrypoint once the programmatic tool definitions are captured; drivers invoke it as `omp -p "/oracle-run …"`.
// Invariants/Assumptions: Absolute paths only; a result or marker file that already exists is never overwritten, so a repeated command cannot re-dispatch.
import { closeSync, existsSync, fsyncSync, openSync, writeSync } from "node:fs";
import { readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";
import { Check } from "typebox/value";
import { parseOracleRunArgs, summarizeOracleRunResult, type OracleRunInvocation, type OracleRunSummary } from "../shared/oracle-run-helpers.mjs";
import { asRecord } from "./tools.js";

export type OracleRunToolDefinition = {
  name: string;
  parameters?: TSchema;
  prepareArguments?: (args: unknown) => unknown;
  execute(
    toolCallId: string,
    params: Record<string, unknown>,
    signal: AbortSignal,
    onUpdate: (result: unknown) => void,
    ctx: ExtensionContext,
  ): Promise<unknown>;
};

function writeExclusive(path: string, payload: string): void {
  const descriptor = openSync(path, "wx", 0o600);
  try {
    writeSync(descriptor, payload);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function fsyncDirectory(path: string): void {
  const descriptor = openSync(path, "r");
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

async function readRequest(path: string): Promise<Record<string, unknown>> {
  const parsed = asRecord(JSON.parse(await readFile(path, "utf8")));
  if (!parsed) throw new Error(`Request is not a JSON object: ${path}`);
  return parsed;
}

/**
 * Run one oracle tool exactly as the host would for a model-issued call: `prepareArguments`, schema check, `execute`.
 * The marker is created with O_EXCL immediately before `execute`, so a crash in between leaves the marker and no result
 * ("may have been sent"), while a failure before the marker provably dispatched nothing.
 */
export async function runOracleTool(
  tools: ReadonlyMap<string, OracleRunToolDefinition>,
  invocation: OracleRunInvocation,
  ctx: ExtensionContext,
): Promise<{ result: unknown; summary: OracleRunSummary }> {
  const definition = tools.get(`oracle_${invocation.operation}`);
  if (!definition) throw new Error(`Oracle tool oracle_${invocation.operation} is not registered`);
  if (existsSync(invocation.resultPath)) throw new Error(`Result already exists; inspect it before any further operation: ${invocation.resultPath}`);
  const request = await readRequest(invocation.requestPath);
  const prepared = asRecord(definition.prepareArguments ? definition.prepareArguments(request) : request);
  if (!prepared) throw new Error(`Prepared oracle_${invocation.operation} arguments are not an object`);
  if (definition.parameters !== undefined && !Check(definition.parameters, prepared)) {
    throw new Error(`Request does not match the oracle_${invocation.operation} parameter schema: ${invocation.requestPath}`);
  }
  if (invocation.markerPath) {
    writeExclusive(invocation.markerPath, `${JSON.stringify({ operation: invocation.operation, dispatch_state: "may_have_been_sent", at: new Date().toISOString() })}\n`);
    fsyncDirectory(dirname(invocation.markerPath));
  }
  const result = await definition.execute(`oracle-run-${crypto.randomUUID()}`, prepared, new AbortController().signal, () => undefined, ctx);
  const temporary = join(dirname(invocation.resultPath), `.${crypto.randomUUID()}.oracle-run.tmp`);
  await writeFile(temporary, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  await rename(temporary, invocation.resultPath);
  fsyncDirectory(dirname(invocation.resultPath));
  return { result, summary: summarizeOracleRunResult(invocation.operation, result) };
}

export function registerOracleRunCommand(pi: ExtensionAPI, tools: ReadonlyMap<string, OracleRunToolDefinition>): void {
  pi.registerCommand("oracle-run", {
    description: "Execute oracle_preflight, oracle_submit or oracle_read from a JSON request file without a model turn (driver control path)",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      let summary: OracleRunSummary | { ok: false; error: string };
      try {
        ({ summary } = await runOracleTool(tools, parseOracleRunArgs(args), ctx));
      } catch (error) {
        summary = { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
      const line = JSON.stringify(summary);
      if (ctx.mode === "print") {
        process.stdout.write(`${line}\n`);
        return;
      }
      pi.sendMessage({ customType: "oracle-command-output", content: line, display: true, details: { level: summary.ok ? "info" : "warning" } });
    },
  });
}
