import { randomUUID } from "node:crypto";
import { mkdtemp, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StringEnum } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { withGlobalReconcileLock, withLock } from "./locks.js";
import { loadOracleConfig, EFFORTS, MODEL_FAMILIES, type OracleEffort, type OracleModelFamily } from "./config.js";
import {
  cancelOracleJob,
  createJob,
  getSessionFile,
  isActiveOracleJob,
  readJob,
  reconcileStaleOracleJobs,
  resolveArchiveInputs,
  sha256File,
  spawnWorker,
  updateJob,
  withJobPhase,
} from "./jobs.js";
import { refreshOracleStatus } from "./poller.js";
import {
  acquireConversationLease,
  acquireRuntimeLease,
  allocateRuntime,
  cleanupRuntimeArtifacts,
  getProjectId,
  getSessionId,
  parseConversationId,
} from "./runtime.js";

const ORACLE_SUBMIT_PARAMS = Type.Object({
  prompt: Type.String({ description: "Prompt text to send to ChatGPT web." }),
  files: Type.Array(Type.String({ description: "Project-relative file or directory path to include in the archive." }), {
    description: "Exact project-relative files/directories to include in the oracle archive.",
    minItems: 1,
  }),
  modelFamily: Type.Optional(StringEnum(MODEL_FAMILIES)),
  effort: Type.Optional(StringEnum(EFFORTS)),
  autoSwitchToThinking: Type.Optional(Type.Boolean()),
  followUpJobId: Type.Optional(Type.String({ description: "Earlier oracle job id whose chat thread should be continued." })),
});

const ORACLE_READ_PARAMS = Type.Object({
  jobId: Type.String({ description: "Oracle job id." }),
});

const ORACLE_CANCEL_PARAMS = Type.Object({
  jobId: Type.String({ description: "Oracle job id." }),
});

const VALID_EFFORTS: Record<OracleModelFamily, readonly OracleEffort[]> = {
  instant: [],
  thinking: ["light", "standard", "extended", "heavy"],
  pro: ["standard", "extended"],
};

async function createArchive(cwd: string, files: string[], archivePath: string): Promise<string> {
  const entries = resolveArchiveInputs(cwd, files);
  const listDir = await mkdtemp(join(tmpdir(), "oracle-filelist-"));
  const listPath = join(listDir, "files.list");
  await writeFile(listPath, Buffer.from(`${entries.map((entry) => entry.relative).join("\0")}\0`), { mode: 0o600 });

  try {
    const { spawn } = await import("node:child_process");
    await new Promise<void>((resolvePromise, rejectPromise) => {
      const tar = spawn("tar", ["--null", "-cf", "-", "-T", listPath], {
        cwd,
        stdio: ["ignore", "pipe", "pipe"],
      });
      const zstd = spawn("zstd", ["-19", "-T0", "-o", archivePath], {
        stdio: ["pipe", "ignore", "pipe"],
      });

      let stderr = "";
      let settled = false;
      let tarCode: number | null | undefined;
      let zstdCode: number | null | undefined;

      const finish = (error?: Error) => {
        if (settled) return;
        if (error) {
          settled = true;
          tar.kill("SIGTERM");
          zstd.kill("SIGTERM");
          rejectPromise(error);
          return;
        }
        if (tarCode === undefined || zstdCode === undefined) return;
        settled = true;
        if (tarCode === 0 && zstdCode === 0) resolvePromise();
        else rejectPromise(new Error(stderr || `archive command failed (tar=${tarCode}, zstd=${zstdCode})`));
      };

      tar.stderr.on("data", (data) => {
        stderr += String(data);
      });
      zstd.stderr.on("data", (data) => {
        stderr += String(data);
      });
      tar.on("error", (error) => finish(error instanceof Error ? error : new Error(String(error))));
      zstd.on("error", (error) => finish(error instanceof Error ? error : new Error(String(error))));
      tar.on("close", (code) => {
        tarCode = code;
        finish();
      });
      zstd.on("close", (code) => {
        zstdCode = code;
        finish();
      });
      tar.stdout.pipe(zstd.stdin);
    });

    const archiveStat = await stat(archivePath);
    const maxBytes = 250 * 1024 * 1024;
    if (archiveStat.size >= maxBytes) {
      throw new Error(`Oracle archive exceeds ChatGPT upload limit: ${archiveStat.size} bytes`);
    }

    return sha256File(archivePath);
  } finally {
    await rm(listDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

function validateSubmissionOptions(
  params: { effort?: OracleEffort; autoSwitchToThinking?: boolean },
  modelFamily: OracleModelFamily,
  effort: OracleEffort | undefined,
  autoSwitchToThinking: boolean,
): void {
  if (modelFamily === "instant" && params.effort !== undefined) {
    throw new Error("Instant model family does not support effort selection");
  }

  if (effort && !VALID_EFFORTS[modelFamily].includes(effort)) {
    throw new Error(`Invalid effort for ${modelFamily}: ${effort}`);
  }

  if (modelFamily !== "instant" && params.autoSwitchToThinking === true) {
    throw new Error("autoSwitchToThinking is only valid for the instant model family");
  }

  if (modelFamily !== "instant" && autoSwitchToThinking) {
    throw new Error(`autoSwitchToThinking cannot be enabled for ${modelFamily}`);
  }
}

function resolveFollowUp(previousJobId: string | undefined, cwd: string): {
  followUpToJobId?: string;
  chatUrl?: string;
  conversationId?: string;
} {
  if (!previousJobId) return {};
  const previous = readJob(previousJobId);
  if (!previous) {
    throw new Error(`Follow-up oracle job not found: ${previousJobId}`);
  }
  if (previous.projectId !== getProjectId(cwd)) {
    throw new Error(`Follow-up oracle job ${previousJobId} belongs to a different project`);
  }
  if (previous.status !== "complete") {
    throw new Error(`Follow-up oracle job ${previousJobId} is not complete`);
  }
  if (!previous.chatUrl) {
    throw new Error(`Follow-up oracle job ${previousJobId} has no persisted chat URL`);
  }
  return {
    followUpToJobId: previous.id,
    chatUrl: previous.chatUrl,
    conversationId: previous.conversationId || parseConversationId(previous.chatUrl),
  };
}

function redactJobDetails(job: NonNullable<ReturnType<typeof readJob>>) {
  return {
    id: job.id,
    status: job.status,
    phase: job.phase,
    projectId: job.projectId,
    sessionId: job.sessionId,
    createdAt: job.createdAt,
    submittedAt: job.submittedAt,
    completedAt: job.completedAt,
    followUpToJobId: job.followUpToJobId,
    chatUrl: job.chatUrl,
    conversationId: job.conversationId,
    responsePath: job.responsePath,
    responseFormat: job.responseFormat,
    artifactPaths: job.artifactPaths,
    artifactFailureCount: job.artifactFailureCount,
    artifactsManifestPath: job.artifactsManifestPath,
    archiveDeletedAfterUpload: job.archiveDeletedAfterUpload,
    runtimeId: job.runtimeId,
    error: job.error,
  };
}

export function registerOracleTools(pi: ExtensionAPI, workerPath: string): void {
  pi.registerTool({
    name: "oracle_submit",
    label: "Oracle Submit",
    description:
      "Dispatch a background ChatGPT web oracle job after gathering context. Always pass a prompt and exact project-relative archive inputs.",
    promptSnippet: "Dispatch a background ChatGPT web oracle job after gathering repo context.",
    promptGuidelines: [
      "Gather context before calling oracle_submit.",
      "Always include a narrowly scoped archive of exact relevant files/directories.",
      "Stop after dispatching oracle_submit; do not continue the task while the oracle job is running.",
    ],
    parameters: ORACLE_SUBMIT_PARAMS,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const config = loadOracleConfig(ctx.cwd);
      const originSessionFile = getSessionFile(ctx);
      const projectId = getProjectId(ctx.cwd);
      const sessionId = getSessionId(originSessionFile, projectId);
      const modelFamily = params.modelFamily ?? config.defaults.modelFamily;
      const requestedEffort = params.effort ?? config.defaults.effort;
      const effort = modelFamily === "instant" ? undefined : requestedEffort;
      const rawAutoSwitchToThinking = params.autoSwitchToThinking ?? config.defaults.autoSwitchToThinking;
      const autoSwitchToThinking = modelFamily === "instant" ? rawAutoSwitchToThinking : false;
      const followUp = resolveFollowUp(params.followUpJobId, ctx.cwd);

      validateSubmissionOptions(params, modelFamily, effort, autoSwitchToThinking);
      await withGlobalReconcileLock({ processPid: process.pid, source: "oracle_submit", cwd: ctx.cwd }, async () => {
        await reconcileStaleOracleJobs();
      });

      const jobId = randomUUID();
      const tempArchivePath = join(tmpdir(), `oracle-archive-${jobId}.tar.zst`);
      const runtime = allocateRuntime(config);
      let job;

      try {
        const archiveSha256 = await createArchive(ctx.cwd, params.files, tempArchivePath);
        await withLock("admission", "global", { jobId, processPid: process.pid }, async () => {
          await acquireRuntimeLease(config, {
            jobId,
            runtimeId: runtime.runtimeId,
            runtimeSessionName: runtime.runtimeSessionName,
            runtimeProfileDir: runtime.runtimeProfileDir,
            projectId,
            sessionId,
            createdAt: new Date().toISOString(),
          });
          if (followUp.conversationId) {
            await acquireConversationLease({
              jobId,
              conversationId: followUp.conversationId,
              projectId,
              sessionId,
              createdAt: new Date().toISOString(),
            });
          }
          job = await createJob(
            jobId,
            {
              prompt: params.prompt,
              files: params.files,
              modelFamily,
              effort,
              autoSwitchToThinking,
              followUpToJobId: followUp.followUpToJobId,
              chatUrl: followUp.chatUrl,
              requestSource: "tool",
            },
            ctx.cwd,
            originSessionFile,
            config,
            runtime,
          );
        });
        await rename(tempArchivePath, job.archivePath);
        const worker = await spawnWorker(workerPath, job.id);
        await updateJob(job.id, (current) => ({
          ...current,
          archiveSha256,
          workerPid: worker.pid,
          workerNonce: worker.nonce,
          workerStartedAt: worker.startedAt,
        }));
        if (ctx.hasUI) refreshOracleStatus(ctx);

        return {
          content: [
            {
              type: "text",
              text: [
                `Oracle job dispatched: ${job.id}`,
                followUp.followUpToJobId ? `Follow-up to: ${followUp.followUpToJobId}` : undefined,
                `Prompt: ${job.promptPath}`,
                `Archive: ${job.archivePath}`,
                `Response will be written to: ${job.responsePath}`,
                "Stop now and wait for the oracle completion wake-up.",
              ]
                .filter(Boolean)
                .join("\n"),
            },
          ],
          details: { jobId: job.id, archiveSha256, runtimeId: job.runtimeId, followUpToJobId: followUp.followUpToJobId },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (job) {
          const failedAt = new Date().toISOString();
          await updateJob(job.id, (current) => ({
            ...current,
            ...withJobPhase("failed", {
              status: "failed",
              completedAt: failedAt,
              error: message,
            }, failedAt),
          })).catch(() => undefined);
        }
        await cleanupRuntimeArtifacts({
          runtimeId: runtime.runtimeId,
          runtimeProfileDir: runtime.runtimeProfileDir,
          runtimeSessionName: runtime.runtimeSessionName,
          conversationId: followUp.conversationId,
        }).catch(() => undefined);
        if (ctx.hasUI) refreshOracleStatus(ctx);
        throw error;
      } finally {
        await rm(tempArchivePath, { force: true }).catch(() => undefined);
      }
    },
  });

  pi.registerTool({
    name: "oracle_read",
    label: "Oracle Read",
    description: "Read the status and outputs of a previously dispatched oracle job.",
    parameters: ORACLE_READ_PARAMS,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const job = readJob(params.jobId);
      if (!job || job.projectId !== getProjectId(ctx.cwd)) {
        throw new Error(`Oracle job not found in this project: ${params.jobId}`);
      }

      let responsePreview = "";
      try {
        const response = await import("node:fs/promises").then((fs) => fs.readFile(job.responsePath || "", "utf8"));
        responsePreview = response.slice(0, 4000);
      } catch {
        responsePreview = "(response not available yet)";
      }

      return {
        content: [
          {
            type: "text",
            text: [
              `job: ${job.id}`,
              `status: ${job.status}`,
              job.followUpToJobId ? `follow-up-to: ${job.followUpToJobId}` : undefined,
              job.chatUrl ? `chat: ${job.chatUrl}` : undefined,
              job.responsePath ? `response: ${job.responsePath}` : undefined,
              job.responseFormat ? `response-format: ${job.responseFormat}` : undefined,
              `artifacts: /tmp/oracle-${job.id}/artifacts`,
              job.error ? `error: ${job.error}` : undefined,
              "",
              responsePreview,
            ]
              .filter(Boolean)
              .join("\n"),
          },
        ],
        details: { job: redactJobDetails(job) },
      };
    },
  });

  pi.registerTool({
    name: "oracle_cancel",
    label: "Oracle Cancel",
    description: "Cancel an active oracle job.",
    parameters: ORACLE_CANCEL_PARAMS,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const job = readJob(params.jobId);
      if (!job || job.projectId !== getProjectId(ctx.cwd)) {
        throw new Error(`Oracle job not found in this project: ${params.jobId}`);
      }
      if (!isActiveOracleJob(job)) {
        return {
          content: [{ type: "text", text: `Oracle job ${job.id} is not active (${job.status}).` }],
          details: { job: redactJobDetails(job) },
        };
      }

      const cancelled = await cancelOracleJob(params.jobId);
      if (ctx.hasUI) refreshOracleStatus(ctx);
      return {
        content: [{ type: "text", text: `Cancelled oracle job ${cancelled.id}.` }],
        details: { job: redactJobDetails(cancelled) },
      };
    },
  });
}
