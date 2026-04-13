// Purpose: Provide typed shared support utilities for the oracle sanity harness and subsystem-specific sanity suites.
// Responsibilities: Expose assertions, polling helpers, typed pi/context doubles, session helpers, and durable job fixture builders.
// Scope: Test-only support code for local sanity coverage; production behavior remains in extensions/oracle.
// Usage: Imported by scripts/oracle-sanity.ts and extracted sanity sub-suites such as poller/wakeup coverage.
// Invariants/Assumptions: Helpers run from the repository root with isolated PI_ORACLE_STATE_DIR/PI_ORACLE_JOBS_DIR and should fail loudly on drift.

import { createHash, randomUUID } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { chmod, mkdir, readdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager, type ExtensionAPI, type ExtensionCommandContext, type ExtensionContext, type SessionEntry } from "@mariozechner/pi-coding-agent";
import type { AssistantMessage } from "@mariozechner/pi-ai";
import {
  resolveOracleSubmitPreset,
  type OracleConfig,
  type OracleSubmitPresetId,
} from "../extensions/oracle/lib/config.ts";
import { getOracleStateDir } from "../extensions/oracle/lib/locks.ts";
import { stopAllPollers, waitForAllPollersToQuiesce } from "../extensions/oracle/lib/poller.ts";
import { createJob, getJobDir, readJob, updateJob } from "../extensions/oracle/lib/jobs.ts";
import { transitionOracleJobPhase } from "../extensions/oracle/shared/job-lifecycle-helpers.mjs";

export function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

export function assertThrows(block: () => void, failureMessage: string, expectedSubstring: string): void {
  try {
    block();
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error);
    if (!text.includes(expectedSubstring)) {
      throw new Error(
        `${failureMessage}: expected error message to include ${JSON.stringify(expectedSubstring)}, got ${JSON.stringify(text)}`,
      );
    }
    return;
  }
  throw new Error(`${failureMessage}: expected throw`);
}

export async function assertRejects(block: () => Promise<unknown>, failureMessage: string, expectedSubstring: string): Promise<void> {
  try {
    await block();
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error);
    if (!text.includes(expectedSubstring)) {
      throw new Error(
        `${failureMessage}: expected error message to include ${JSON.stringify(expectedSubstring)}, got ${JSON.stringify(text)}`,
      );
    }
    return;
  }
  throw new Error(`${failureMessage}: expected rejection`);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function waitForCondition<T>(
  evaluate: () => Promise<T | undefined | false> | T | undefined | false,
  options: { timeoutMs: number; intervalMs?: number; description: string },
): Promise<T> {
  const deadline = Date.now() + options.timeoutMs;
  while (Date.now() < deadline) {
    const result = await evaluate();
    if (result) return result;
    await sleep(options.intervalMs ?? 25);
  }
  throw new Error(`Timed out waiting for ${options.description}`);
}

export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `"'"'`)}'`;
}

export async function writeExecutableScript(path: string, content: string): Promise<void> {
  await writeFile(path, content, { encoding: "utf8", mode: 0o755 });
  await chmod(path, 0o755);
}

export async function runProcess(
  command: string,
  args: string[],
  options?: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number },
): Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options?.cwd,
      env: options?.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let killTimer: NodeJS.Timeout | undefined;

    if ((options?.timeoutMs ?? 0) > 0) {
      killTimer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
        setTimeout(() => child.kill("SIGKILL"), 2_000).unref?.();
      }, options?.timeoutMs);
      killTimer.unref?.();
    }

    child.stdout.on("data", (data) => {
      stdout += String(data);
    });
    child.stderr.on("data", (data) => {
      stderr += String(data);
    });
    child.on("error", (error) => {
      if (killTimer) clearTimeout(killTimer);
      reject(error);
    });
    child.on("close", (code) => {
      if (killTimer) clearTimeout(killTimer);
      resolve({ code, stdout, stderr, timedOut });
    });
  });
}

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

export function readProcessStartedAt(pid: number | undefined): string | undefined {
  if (!pid || pid <= 0) return undefined;
  try {
    const startedAt = execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8" }).trim();
    return startedAt || undefined;
  } catch {
    return undefined;
  }
}

export function isPidAlive(pid: number | undefined): boolean {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function waitForPidExit(pid: number | undefined, timeoutMs = 5_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isPidAlive(pid)) return true;
    await sleep(100);
  }
  return !isPidAlive(pid);
}

export async function waitForProcessStartedAtValue(pid: number | undefined, timeoutMs = 2_000): Promise<string | undefined> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const startedAt = readProcessStartedAt(pid);
    if (startedAt) return startedAt;
    await sleep(25);
  }
  return readProcessStartedAt(pid);
}

export async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

export async function removeDirRobust(path: string, options?: { attempts?: number; delayMs?: number }): Promise<void> {
  const attempts = options?.attempts ?? 5;
  const delayMs = options?.delayMs ?? 50;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const { rm } = await import("node:fs/promises");
      await rm(path, { recursive: true, force: true });
      return;
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
      const retryable = code === "ENOTEMPTY" || code === "EBUSY" || code === "EPERM";
      if (!retryable || attempt === attempts) throw error;
      await sleep(delayMs * attempt);
    }
  }
}

export async function resetOracleStateDir(): Promise<void> {
  await stopAllPollers();
  await waitForAllPollersToQuiesce().catch(() => undefined);
  await removeDirRobust(getOracleStateDir());
}

export async function waitForTmpStateDir(parentDir: string, finalName: string, timeoutMs: number): Promise<string> {
  return waitForCondition(async () => {
    const entries = await readdir(parentDir).catch(() => [] as string[]);
    const match = entries.find((name) => name.startsWith(`.tmp-${finalName}.`));
    return match ? join(parentDir, match) : undefined;
  }, {
    timeoutMs,
    intervalMs: 25,
    description: `in-flight .tmp-* dir for ${finalName}`,
  });
}

export function hashedOracleStatePath(kind: string, key: string, rootDir: string): string {
  return join(rootDir, `${kind}-${createHash("sha256").update(key).digest("hex").slice(0, 24)}`);
}

export interface UiNotification {
  message: string;
  level: string;
}

export interface UiStatus {
  key: string;
  value: string;
}

export interface UiStub {
  notifications: UiNotification[];
  statuses: UiStatus[];
  setStatus(key: string, value: string): void;
  theme: { fg: (_name: string, text: string) => string };
  notify(message: string, level: string): void;
}

export function createUiStub(): UiStub {
  return {
    notifications: [],
    statuses: [],
    setStatus(key, value) {
      this.statuses.push({ key, value });
    },
    theme: { fg: (_name: string, text: string) => text },
    notify(message, level) {
      this.notifications.push({ message, level });
    },
  };
}

export function createPersistedSessionManager(name: string): SessionManager {
  return SessionManager.create(process.cwd(), join(tmpdir(), `oracle-sanity-sessions-${name}-${randomUUID()}`));
}

const TEST_ASSISTANT_USAGE: AssistantMessage["usage"] = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    total: 0,
  },
};

export function appendUserMessage(sessionManager: Pick<SessionManager, "appendMessage">, text: string): string {
  return sessionManager.appendMessage({
    role: "user",
    content: text,
    timestamp: Date.now(),
  });
}

export function appendAssistantMessage(
  sessionManager: Pick<SessionManager, "appendMessage">,
  text: string,
  options?: { api?: AssistantMessage["api"]; provider?: AssistantMessage["provider"]; model?: string; responseId?: string },
): string {
  return sessionManager.appendMessage({
    role: "assistant",
    content: [{ type: "text", text }],
    api: options?.api ?? "openai-responses",
    provider: options?.provider ?? "openai",
    model: options?.model ?? "gpt-5",
    responseId: options?.responseId,
    usage: { ...TEST_ASSISTANT_USAGE, cost: { ...TEST_ASSISTANT_USAGE.cost } },
    stopReason: "stop",
    timestamp: Date.now(),
  });
}

export type PollerTestContext = ExtensionContext & {
  ui: UiStub;
  isIdle: () => boolean;
  hasPendingMessages: () => boolean;
};

export function createPollerCtx(sessionManager: SessionManager, cwd = process.cwd()): PollerTestContext {
  return {
    cwd,
    sessionManager,
    hasUI: true,
    ui: createUiStub(),
    isIdle: () => true,
    hasPendingMessages: () => false,
  } as unknown as PollerTestContext;
}

type AssistantSessionEntry = Extract<SessionEntry, { type: "message" }> & { message: AssistantMessage };

export function findNotificationEntry(sessionManager: Pick<SessionManager, "getEntries">, jobId: string): AssistantSessionEntry | undefined {
  const entry = sessionManager.getEntries().find((candidate) => {
    if (candidate.type !== "message" || candidate.message.role !== "assistant") return false;
    return candidate.message.responseId === `oracle-notification:${jobId}`;
  });
  return entry as AssistantSessionEntry | undefined;
}

export interface ToolDefinitionLike {
  name: string;
  execute?: (...args: unknown[]) => unknown;
  parameters?: unknown;
  [key: string]: unknown;
}

export interface CommandDefinitionLike {
  description?: string;
  handler: (args: string, ctx: ExtensionCommandContext) => unknown;
  [key: string]: unknown;
}

export interface SentMessageLike {
  content?: unknown;
  details?: unknown;
  customType?: string;
  display?: boolean;
  [key: string]: unknown;
}

export interface PiHarness extends ExtensionAPI {
  tools: Map<string, ToolDefinitionLike>;
  commands: Map<string, CommandDefinitionLike>;
  handlers: Map<string, (event: unknown, ctx: ExtensionContext) => unknown>;
  sentMessages: SentMessageLike[];
}

export function createPiHarness(): PiHarness {
  const tools = new Map<string, ToolDefinitionLike>();
  const commands = new Map<string, CommandDefinitionLike>();
  const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
  const sentMessages: SentMessageLike[] = [];
  return {
    tools,
    commands,
    handlers,
    sentMessages,
    registerTool(definition: ToolDefinitionLike) {
      tools.set(definition.name, definition);
    },
    registerCommand(name: string, definition: CommandDefinitionLike) {
      commands.set(name, definition);
    },
    on(event: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) {
      handlers.set(event, handler);
    },
    sendMessage(message: SentMessageLike) {
      sentMessages.push(message);
    },
  } as unknown as PiHarness;
}

export function createCommandCtx(
  sessionManager: ExtensionCommandContext["sessionManager"],
  ui = createUiStub(),
  cwd = process.cwd(),
): ExtensionCommandContext {
  return {
    cwd,
    hasUI: true,
    sessionManager,
    ui,
  } as unknown as ExtensionCommandContext;
}

export function createExtensionCtx(
  sessionManager: ExtensionContext["sessionManager"],
  ui = createUiStub(),
  cwd = process.cwd(),
): ExtensionContext {
  return {
    cwd,
    hasUI: true,
    sessionManager,
    ui,
  } as unknown as ExtensionContext;
}

export interface FixtureJobOptions {
  requestSource?: "tool" | "command";
  initialState?: "queued" | "submitted";
  followUpToJobId?: string;
  chatUrl?: string;
  preset?: OracleSubmitPresetId;
}

export async function createJobForTest(
  config: OracleConfig,
  cwd: string,
  sessionId: string,
  options?: FixtureJobOptions,
): Promise<string> {
  const jobId = `sanity-job-${randomUUID()}`;
  const runtime = {
    runtimeId: `runtime-${randomUUID()}`,
    runtimeSessionName: `oracle-runtime-${randomUUID()}`,
    runtimeProfileDir: `/tmp/oracle-runtime-${randomUUID()}`,
    seedGeneration: new Date().toISOString(),
  };
  const preset = options?.preset ?? config.defaults.preset;
  await createJob(
    jobId,
    {
      prompt: "sanity",
      files: ["docs/ORACLE_DESIGN.md"],
      selection: resolveOracleSubmitPreset(preset),
      requestSource: options?.requestSource ?? "tool",
      followUpToJobId: options?.followUpToJobId,
      chatUrl: options?.chatUrl,
    },
    cwd,
    sessionId,
    config,
    runtime,
    { initialState: options?.initialState ?? "submitted" },
  );
  const created = readJob(jobId);
  assert(created, "test job should exist after creation");
  await writeFile(created.archivePath, "sanity archive\n", { mode: 0o600 });
  return jobId;
}

export async function completeJob(jobId: string, status: "complete" | "failed" | "cancelled" = "complete"): Promise<void> {
  const completedAt = new Date().toISOString();
  const responsePath = join(getJobDir(jobId), "response.md");
  await updateJob(jobId, (job) => transitionOracleJobPhase(job, status === "complete" ? "complete" : status, {
    at: completedAt,
    source: "oracle:test",
    message: `Fixture job moved to ${status}.`,
    patch: {
      responsePath,
      responseFormat: "text/plain",
    },
  }));
  if (status === "complete") {
    await writeFile(responsePath, "fixture oracle response\n", { mode: 0o600 });
  }
}

export async function createTerminalJob(
  config: OracleConfig,
  cwd: string,
  sessionId: string,
  requestSource: "tool" | "command" = "tool",
): Promise<string> {
  const jobId = await createJobForTest(config, cwd, sessionId, { requestSource });
  await completeJob(jobId, "complete");
  return jobId;
}

export async function writeActiveJob(id: string): Promise<void> {
  const dir = getJobDir(id);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await writeFile(join(dir, "job.json"), `${JSON.stringify({ id, status: "submitted" }, null, 2)}\n`, { mode: 0o600 });
}

export async function cleanupJob(id: string): Promise<void> {
  const { rm } = await import("node:fs/promises");
  await rm(getJobDir(id), { recursive: true, force: true });
}
