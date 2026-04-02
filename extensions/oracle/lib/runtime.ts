import { randomUUID, createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync, realpathSync, readFileSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { OracleConfig } from "./config.js";
import { createLease, listLeaseMetadata, readLeaseMetadata, releaseLease, withAuthLock } from "./locks.js";

const SEED_GENERATION_FILE = ".oracle-seed-generation";

export interface OracleRuntimeLeaseMetadata {
  jobId: string;
  runtimeId: string;
  runtimeSessionName: string;
  runtimeProfileDir: string;
  projectId: string;
  sessionId: string;
  createdAt: string;
}

export interface OracleConversationLeaseMetadata {
  jobId: string;
  conversationId: string;
  projectId: string;
  sessionId: string;
  createdAt: string;
}

export function getProjectId(cwd: string): string {
  try {
    return realpathSync(cwd);
  } catch {
    return cwd;
  }
}

export function getSessionId(originSessionFile: string | undefined, projectId: string): string {
  return originSessionFile || `ephemeral:${projectId}`;
}

export function parseConversationId(chatUrl: string | undefined): string | undefined {
  if (!chatUrl) return undefined;
  try {
    const parsed = new URL(chatUrl);
    const match = parsed.pathname.match(/\/c\/([^/?#]+)/i);
    return match?.[1];
  } catch {
    return undefined;
  }
}

export function allocateRuntime(config: OracleConfig): { runtimeId: string; runtimeSessionName: string; runtimeProfileDir: string } {
  const runtimeId = randomUUID();
  return {
    runtimeId,
    runtimeSessionName: `${config.browser.sessionPrefix}-${runtimeId}`,
    runtimeProfileDir: join(config.browser.runtimeProfilesDir, runtimeId),
  };
}

export function authSessionName(config: OracleConfig): string {
  return `${config.browser.sessionPrefix}-auth`;
}

export function getSeedGeneration(config: OracleConfig): string | undefined {
  const path = join(config.browser.authSeedProfileDir, SEED_GENERATION_FILE);
  if (!existsSync(path)) return undefined;
  try {
    const value = readFileSync(path, "utf8").trim();
    return value || undefined;
  } catch {
    return undefined;
  }
}

export async function writeSeedGeneration(config: OracleConfig, value = new Date().toISOString()): Promise<string> {
  await mkdir(config.browser.authSeedProfileDir, { recursive: true, mode: 0o700 });
  await writeFile(join(config.browser.authSeedProfileDir, SEED_GENERATION_FILE), `${value}\n`, { encoding: "utf8", mode: 0o600 });
  return value;
}

function activeJobExists(jobId: string): boolean {
  const path = join("/tmp", `oracle-${jobId}`, "job.json");
  if (!existsSync(path)) return false;
  try {
    const job = JSON.parse(readFileSync(path, "utf8")) as { status?: string };
    return ["preparing", "submitted", "waiting"].includes(job.status || "");
  } catch {
    return false;
  }
}

export async function acquireRuntimeLease(config: OracleConfig, metadata: OracleRuntimeLeaseMetadata): Promise<void> {
  const existing = listLeaseMetadata<OracleRuntimeLeaseMetadata>("runtime");
  const liveLeases: OracleRuntimeLeaseMetadata[] = [];
  for (const lease of existing) {
    if (!activeJobExists(lease.jobId)) {
      await releaseLease("runtime", lease.runtimeId).catch(() => undefined);
      continue;
    }
    liveLeases.push(lease);
  }
  if (liveLeases.length >= config.browser.maxConcurrentJobs) {
    const blocker = liveLeases[0];
    throw new Error(
      `Oracle is busy (${liveLeases.length}/${config.browser.maxConcurrentJobs} active). ` +
        `Blocking job ${blocker?.jobId ?? "unknown"} in project ${blocker?.projectId ?? "unknown"}.`,
    );
  }
  await createLease("runtime", metadata.runtimeId, metadata);
}

export async function releaseRuntimeLease(runtimeId: string | undefined): Promise<void> {
  if (!runtimeId) return;
  await releaseLease("runtime", runtimeId);
}

export async function acquireConversationLease(metadata: OracleConversationLeaseMetadata): Promise<void> {
  const existing = await readLeaseMetadata<OracleConversationLeaseMetadata>("conversation", metadata.conversationId);
  if (existing && existing.jobId !== metadata.jobId) {
    if (!activeJobExists(existing.jobId)) {
      await releaseLease("conversation", metadata.conversationId).catch(() => undefined);
    } else {
      throw new Error(
        `Oracle conversation ${metadata.conversationId} is already in use by job ${existing.jobId}. ` +
          `Concurrent follow-ups to the same ChatGPT thread are not allowed.`,
      );
    }
  }
  await createLease("conversation", metadata.conversationId, metadata);
}

export async function releaseConversationLease(conversationId: string | undefined): Promise<void> {
  if (!conversationId) return;
  await releaseLease("conversation", conversationId);
}

function profileCloneArgs(config: OracleConfig, sourceDir: string, destinationDir: string): string[] {
  if (config.browser.cloneStrategy === "apfs-clone") {
    return ["-cR", sourceDir, destinationDir];
  }
  return ["-R", sourceDir, destinationDir];
}

async function spawnCp(args: string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn("cp", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (data) => {
      stderr += String(data);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(stderr || `cp exited with code ${code}`));
    });
  });
}

export async function cloneSeedProfileToRuntime(config: OracleConfig, runtimeProfileDir: string): Promise<string | undefined> {
  const seedDir = config.browser.authSeedProfileDir;
  if (!existsSync(seedDir)) {
    throw new Error(`Oracle auth seed profile not found: ${seedDir}. Run /oracle-auth first.`);
  }

  await withAuthLock({ runtimeProfileDir, seedDir }, async () => {
    await rm(runtimeProfileDir, { recursive: true, force: true }).catch(() => undefined);
    await mkdir(dirname(runtimeProfileDir), { recursive: true, mode: 0o700 }).catch(() => undefined);
    await spawnCp(profileCloneArgs(config, seedDir, runtimeProfileDir));
  });

  return getSeedGeneration(config);
}

export async function cleanupRuntimeArtifacts(runtime: {
  runtimeId?: string;
  runtimeProfileDir?: string;
  runtimeSessionName?: string;
  conversationId?: string;
}): Promise<void> {
  if (runtime.runtimeSessionName) {
    await new Promise<void>((resolve) => {
      const child = spawn("agent-browser", ["--session", runtime.runtimeSessionName, "close"], { stdio: "ignore" });
      child.on("error", () => resolve());
      child.on("close", () => resolve());
    });
  }
  if (runtime.runtimeProfileDir) {
    await rm(runtime.runtimeProfileDir, { recursive: true, force: true }).catch(() => undefined);
  }
  await releaseConversationLease(runtime.conversationId);
  await releaseRuntimeLease(runtime.runtimeId);
}

export function stableProjectLabel(projectId: string): string {
  return basename(projectId) || createHash("sha256").update(projectId).digest("hex").slice(0, 8);
}
