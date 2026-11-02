// Purpose: Register oracle extension tools and implement submit/read/cancel behavior.
// Responsibilities: Validate tool parameters, create archives, enqueue or dispatch jobs, and surface job state.
// Scope: Tool-facing orchestration only; durable job storage, locks, runtime leases, and config live in sibling modules.
// Usage: Imported by the oracle extension entrypoint and sanity tests to register tools against the pi API.
// Invariants/Assumptions: The pi runtime validates TypeBox schemas before execute, while execute owns semantic normalization.
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolveNodeExecutable } from "../shared/process-helpers.mjs";
import { sharedBrowserCleanupFields, usesSharedBrowser } from "../shared/managed-browser-helpers.mjs";
import { readFile, rename, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createArchive, type ArchiveCreationResult, type ArchiveSizeBreakdownRow } from "./archive.js";
import { runOracleAuthBootstrap } from "./auth.js";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { formatOracleCancelOutcome, formatOracleJobSummary, formatOracleSubmitResponse, type OracleReadinessStatus } from "../shared/job-observability-helpers.mjs";
import { getLatestOracleJobLifecycleEvent, getLatestOracleTerminalLifecycleEvent, transitionOracleJobPhase } from "../shared/job-lifecycle-helpers.mjs";
import { isLockTimeoutError, withGlobalReconcileLock, withLock } from "./locks.js";
import {
  coerceOracleSubmitPresetId,
  loadOracleConfig,
  normalizeOracleProvider,
  GROK_MODES,
  ORACLE_PROVIDERS,
  ORACLE_SUBMIT_PRESET_IDS,
  resolveOracleConfigForProvider,
  resolveOracleGrokMode,
  resolveOracleSubmitPreset,
  type OracleConfig,
  type OracleProvider,
} from "./config.js";
import {
  appendCleanupWarnings,
  cancelOracleJob,
  createJob,
  getJobDir,
  getSessionFile,
  getWakeupSessionKey,
  hasDurableWorkerHandoff,
  hasRetainedPreSubmitArchive,
  isOpenOracleJob,
  isTerminalOracleJob,
  listOracleJobDirs,
  markWakeupSettled,
  OracleJobProjectMismatchError,
  ORACLE_STALE_HEARTBEAT_MS,
  readJob,
  readJobForProject,
  pruneTerminalOracleJobs,
  reconcileStaleOracleJobs,
  resolveArchiveInputs,
  shouldAdvanceQueueAfterCancellation,
  spawnWorker,
  terminateWorkerPid,
  updateJob,
  type OracleJob,
} from "./jobs.js";
import { isOracleProjectTrusted } from "./trust.js";
import { getQueuePosition, promoteQueuedJobs, promoteQueuedJobsWithinAdmissionLock } from "./queue.js";
import { resolveOracleProviderArchivePlan } from "./provider-capabilities.js";
import { refreshOracleStatus } from "./poller.js";
import {
  allocateRuntime,
  assertOracleSubmitPrerequisites,
  cleanupRuntimeArtifacts,
  countLiveRuntimeLeases,
  getProjectId,
  getSessionId,
  hasPersistedSessionFile,
  parseConversationId,
  requirePersistedSessionFile,
  tryAcquireConversationLease,
  tryAcquireRuntimeLease,
} from "./runtime.js";

const execFileAsync = promisify(execFile);

const ORACLE_PROVIDER_PARAM_DESCRIPTION = `Oracle web provider. Omit to use the configured default provider. Supported providers: ${ORACLE_PROVIDERS.join(", ")}.`;
const ORACLE_PROVIDER_PARAM = Type.Optional(StringEnum(ORACLE_PROVIDERS, {
  description: ORACLE_PROVIDER_PARAM_DESCRIPTION,
}));
const ORACLE_GROK_MODE_PARAM = Type.Optional(StringEnum(GROK_MODES, {
  description: "Provider mode. For Grok, only heavy is currently supported. Omit to use the configured default mode.",
}));

const ORACLE_SUBMIT_PARAMS = Type.Object({
  prompt: Type.String({ description: "Prompt text to send to ChatGPT or Grok web." }),
  files: Type.Array(Type.String({
    description: "Project-relative file or directory path to include in the archive.",
    minLength: 1,
    pattern: "^.*[^ \\t\\r\\n].*$",
  }), {
    description: "Exact project-relative files/directories to include in the oracle archive.",
    minItems: 1,
  }),
  provider: ORACLE_PROVIDER_PARAM,
  preset: Type.Optional(
    Type.String({
      description:
        `ChatGPT model preset. Omit to use the configured default preset. Canonical ids: ${ORACLE_SUBMIT_PRESET_IDS.join(", ")}. ` +
        "Matching human-readable preset labels and common hyphen/space variants are normalized automatically. Do not pass preset when provider is grok.",
    }),
  ),
  mode: ORACLE_GROK_MODE_PARAM,
  followUpJobId: Type.Optional(Type.String({ description: "Earlier oracle job id whose chat thread should be continued." })),
  chatGptConversationId: Type.Optional(Type.String({
    description: "Existing ChatGPT conversation id, or full https://chatgpt.com/c/... URL, to continue. Omit for default behavior: starting a fresh oracle thread. Do not combine with followUpJobId.",
    minLength: 1,
    pattern: "^.*[^ \\t\\r\\n].*$",
  })),
}, { additionalProperties: false });

const ORACLE_PREFLIGHT_PARAMS = Type.Object({
  provider: ORACLE_PROVIDER_PARAM,
  followUpJobId: Type.Optional(Type.String({ description: "Earlier oracle job id whose provider/thread readiness should be checked." })),
  chatGptConversationId: Type.Optional(Type.String({
    description: "Existing ChatGPT conversation id, or full https://chatgpt.com/c/... URL, whose provider/thread readiness should be checked. Do not combine with followUpJobId.",
    minLength: 1,
    pattern: "^.*[^ \\t\\r\\n].*$",
  })),
}, { additionalProperties: false });

const ORACLE_AUTH_PARAMS = Type.Object({
  provider: ORACLE_PROVIDER_PARAM,
}, { additionalProperties: false });

const ORACLE_READ_PARAMS = Type.Object({
  jobId: Type.String({ description: "Oracle job id." }),
  projectId: Type.Optional(Type.String({ minLength: 1, description: "Owning project root recorded at submission. Defaults to the current project; another project's job requires this explicit acknowledgment." })),
  action: Type.Optional(StringEnum(["read", "recollect"], { description: "Recollect the saved turn of an already completed job without sending a prompt: by its message ID, its content hash, or the user turn that carries the job's archive. Default: read saved files only." })),
  responseIndex: Type.Optional(Type.Integer({ minimum: 0, description: "For legacy jobs without a saved turn binding only: explicit zero-based assistant turn index, paired with messageId." })),
  messageId: Type.Optional(Type.String({ minLength: 1, description: "For legacy jobs without a saved turn binding only: exact observed data-message-id of the completed assistant turn." })),
}, { additionalProperties: false });

const ORACLE_CANCEL_PARAMS = Type.Object({
  jobId: Type.String({ description: "Oracle job id." }),
}, { additionalProperties: false });

const MAX_QUEUED_JOBS_PER_ACTIVE_RUNTIME = 1;
const MAX_QUEUED_ARCHIVE_BYTES_PER_ACTIVE_RUNTIME = resolveOracleProviderArchivePlan("chatgpt").maxArchiveBytes;
type OracleCapacity = { activeJobs: number; maxActiveJobs: number; queuedJobs: number; maxQueuedJobs: number };

function maxQueuedJobsForConfig(config: OracleConfig): number {
  return config.browser.maxConcurrentJobs * MAX_QUEUED_JOBS_PER_ACTIVE_RUNTIME;
}

function getOracleCapacity(config: OracleConfig): OracleCapacity {
  let queuedJobs = 0;
  for (const jobDir of listOracleJobDirs()) {
    if (readJob(jobDir)?.status === "queued") queuedJobs++;
  }
  return {
    activeJobs: countLiveRuntimeLeases(),
    maxActiveJobs: config.browser.maxConcurrentJobs,
    queuedJobs,
    maxQueuedJobs: maxQueuedJobsForConfig(config),
  };
}
function prepareOracleProviderAliases<T>(args: unknown, toolName: string): T {
  const record = asRecord(args);
  if (!record) return args as T;
  return {
    ...record,
    provider: typeof record.provider === "string" ? normalizeOracleProvider(record.provider, "chatgpt", toolName) : record.provider,
  } as T;
}

function prepareOracleSubmitArguments(args: unknown): Static<typeof ORACLE_SUBMIT_PARAMS> {
  const record = asRecord(args);
  if (!record) return args as Static<typeof ORACLE_SUBMIT_PARAMS>;
  return {
    ...prepareOracleProviderAliases<Record<string, unknown>>(record, "oracle_submit"),
    mode: typeof record.mode === "string" ? normalizeGrokMode(record.mode, "heavy") : record.mode,
  } as Static<typeof ORACLE_SUBMIT_PARAMS>;
}

function normalizeGrokMode(value: unknown, fallback: "heavy"): "heavy" {
  if (value === undefined) return fallback;
  if (typeof value !== "string") throw new Error("oracle_submit mode must be a string");
  const normalized = value.trim().toLowerCase();
  if (normalized === "heavy" || normalized === "grok heavy" || normalized === "grok-heavy") return "heavy";
  throw new Error(`Unknown Grok oracle mode: ${value}. Only heavy is currently supported.`);
}

export interface QueuedArchivePressure {
  queuedJobs: number;
  queuedArchiveBytes: number;
}

export async function getQueuedArchivePressure(): Promise<QueuedArchivePressure> {
  const jobs = listOracleJobDirs()
    .map((dir) => readJob(dir))
    .filter((job): job is NonNullable<typeof job> => Boolean(job));

  const queuedArchiveBytes = (await Promise.all(
    jobs
      .filter((job) => hasRetainedPreSubmitArchive(job))
      .map(async (job) => {
        try {
          return (await stat(job.archivePath)).size;
        } catch {
          return 0;
        }
      }),
  )).reduce((sum, bytes) => sum + bytes, 0);

  return {
    queuedJobs: jobs.filter((job) => job.status === "queued").length,
    queuedArchiveBytes,
  };
}

export function getQueueAdmissionFailure(args: {
  queuePressure: QueuedArchivePressure;
  archiveBytes: number;
  activeJobs: number;
  maxActiveJobs: number;
  maxQueuedJobs: number;
  maxQueuedArchiveBytes: number;
}): string | undefined {
  if (args.queuePressure.queuedJobs >= args.maxQueuedJobs) {
    return (
      `Oracle is busy (${args.activeJobs}/${args.maxActiveJobs} active, ${args.queuePressure.queuedJobs}/${args.maxQueuedJobs} queued). ` +
      "Retry later instead of enqueuing more archive state."
    );
  }

  const queuedArchiveBytes = args.queuePressure.queuedArchiveBytes + args.archiveBytes;
  if (queuedArchiveBytes > args.maxQueuedArchiveBytes) {
    return (
      `Oracle queued archive storage is full (${queuedArchiveBytes} bytes > ${args.maxQueuedArchiveBytes} bytes across queued jobs and retained pre-submit archives). ` +
      "Retry later or narrow the archive inputs."
    );
  }

  return undefined;
}

type OracleConversationTarget = {
  followUpToJobId?: string;
  chatUrl?: string;
  conversationId?: string;
  provider?: "chatgpt" | "grok";
  label?: string;
};

const CHATGPT_CONVERSATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]{7,}$/;
const CHATGPT_CONVERSATION_URL_HOSTS = new Set(["chatgpt.com", "chat.openai.com"]);

function chatGptConversationOrigin(config: Pick<OracleConfig, "browser">): string {
  try {
    const parsed = new URL(config.browser.chatUrl);
    if (CHATGPT_CONVERSATION_URL_HOSTS.has(parsed.hostname.toLowerCase())) return parsed.origin;
  } catch {
    // Fall through to the canonical ChatGPT origin.
  }
  return "https://chatgpt.com";
}

export function resolveChatGptConversationReference(
  rawReference: string | undefined,
  config: Pick<OracleConfig, "browser">,
): { chatUrl: string; conversationId: string } | undefined {
  if (rawReference === undefined) return undefined;
  const reference = rawReference.trim();
  if (!reference) throw new Error("ChatGPT conversation id must be a non-empty string");

  try {
    const parsed = new URL(reference);
    const host = parsed.hostname.toLowerCase();
    const conversationId = parseConversationId(parsed.toString());
    if (parsed.protocol !== "https:" || !CHATGPT_CONVERSATION_URL_HOSTS.has(host) || !conversationId) {
      throw new Error();
    }
    return {
      chatUrl: `${parsed.origin}/c/${conversationId}`,
      conversationId,
    };
  } catch {
    if (!CHATGPT_CONVERSATION_ID_PATTERN.test(reference)) {
      throw new Error(`Invalid ChatGPT conversation id or URL: ${rawReference}`);
    }
    const origin = chatGptConversationOrigin(config);
    return {
      chatUrl: `${origin}/c/${reference}`,
      conversationId: reference,
    };
  }
}

function resolveFollowUp(previousJobId: string | undefined, cwd: string): OracleConversationTarget {
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
  const conversationId = previous.conversationId || parseConversationId(previous.chatUrl);
  return {
    followUpToJobId: previous.id,
    chatUrl: previous.chatUrl,
    conversationId,
    provider: previous.selection?.provider === "grok" ? "grok" : "chatgpt",
    label: `follow-up job ${previous.id}`,
  };
}

function resolveConversationTarget(args: {
  followUpJobId?: string;
  chatGptConversationId?: string;
  cwd: string;
  config: OracleConfig;
}): OracleConversationTarget {
  if (args.followUpJobId !== undefined && args.chatGptConversationId !== undefined) {
    throw new Error("Pass either followUpJobId or chatGptConversationId, not both");
  }
  if (args.chatGptConversationId !== undefined) {
    const target = resolveChatGptConversationReference(args.chatGptConversationId, args.config);
    if (!target) return {};
    return {
      ...target,
      provider: "chatgpt",
      label: `ChatGPT conversation ${target.conversationId}`,
    };
  }
  return resolveFollowUp(args.followUpJobId, args.cwd);
}

type OracleToolName = "oracle_auth" | "oracle_submit" | "oracle_read" | "oracle_cancel";
type OracleToolErrorSource = OracleToolName | "oracle_preflight";
type OracleQueueSnapshot = { queued: boolean; position?: number; depth?: number };
type OracleToolErrorDetails = {
  code: string;
  message: string;
  rejectedValue?: string;
  allowedValues?: string[];
  suggestedNextStep?: string;
};
// Blockers whose remedy is signing in: /oracle-auth rebuilds the seed, or opens the managed browser for sign-in.
const AUTH_NEEDED_ERROR_CODES: Record<string, true> = {
  auth_seed_profile_missing: true,
  auth_seed_profile_unreadable: true,
  auth_seed_profile_invalid_type: true,
  auth_seed_profile_unauthenticated: true,
  managed_browser_profile_missing: true,
};
type OracleToolJobDetailsOptions = {
  queue?: OracleQueueSnapshot;
  archiveBytes?: number;
  initialArchiveBytes?: number;
  autoPrunedArchivePaths?: ArchiveSizeBreakdownRow[];
  responsePreview?: string;
  responseAvailable?: boolean;
};

const ORACLE_TOOL_NAMES = new Set<OracleToolName>(["oracle_auth", "oracle_submit", "oracle_read", "oracle_cancel"]);

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function buildOracleQueueSnapshot(
  job: NonNullable<ReturnType<typeof readJob>>,
  queuePosition?: { position: number; depth: number },
): OracleQueueSnapshot {
  return {
    queued: job.status === "queued",
    position: queuePosition?.position,
    depth: queuePosition?.depth,
  };
}

function redactJobDetails(
  job: NonNullable<ReturnType<typeof readJob>>,
  options: OracleToolJobDetailsOptions = {},
) {
  const lastEvent = getLatestOracleJobLifecycleEvent(job);
  const terminalEvent = getLatestOracleTerminalLifecycleEvent(job);
  return {
    id: job.id,
    status: job.status,
    phase: job.phase,
    projectId: job.projectId,
    sessionId: job.sessionId,
    createdAt: job.createdAt,
    queuedAt: job.queuedAt,
    submittedAt: job.submittedAt,
    completedAt: job.completedAt,
    promptPath: job.promptPath,
    archivePath: job.archivePath,
    archiveSha256: job.archiveSha256,
    archiveBytes: options.archiveBytes,
    initialArchiveBytes: options.initialArchiveBytes,
    autoPrunedArchivePaths: options.autoPrunedArchivePaths ?? [],
    queue: options.queue ?? buildOracleQueueSnapshot(job),
    followUpToJobId: job.followUpToJobId,
    chatUrl: job.chatUrl,
    conversationId: job.conversationId,
    responsePath: job.responsePath,
    responseFormat: job.responseFormat,
    responseAvailable: options.responseAvailable ?? false,
    responsePreview: options.responsePreview,
    artifactsPath: `${getJobDir(job.id)}/artifacts`,
    artifactPaths: job.artifactPaths,
    artifactFailureCount: job.artifactFailureCount,
    generationStatus: job.generationStatus,
    collectionStatus: job.collectionStatus,
    collectionBinding: job.collectionBinding,
    responseCapturePath: job.responseCapturePath,
    collectionRequiredMissing: job.collectionRequiredMissing,
    collectionOptionalMissing: job.collectionOptionalMissing,
    recollectionError: job.recollectionError,
    recollectionNeeded: job.recollectionNeeded,
    promptSendState: job.promptSendState,
    observedSelection: job.observedSelection,
    observedTurn: job.observedTurn,
    artifactsManifestPath: job.artifactsManifestPath,
    workerLogPath: job.workerLogPath,
    archiveDeletedAfterUpload: job.archiveDeletedAfterUpload,
    runtimeId: job.runtimeId,
    cleanupWarnings: job.cleanupWarnings,
    cleanupAttemptCount: job.cleanupAttemptCount,
    cleanupRetryAt: job.cleanupRetryAt,
    lastCleanupAt: job.lastCleanupAt,
    terminalEvent: terminalEvent ? { ...terminalEvent } : undefined,
    lastEvent: lastEvent ? { ...lastEvent } : undefined,
    error: job.error,
    errorCode: job.errorCode,
    lifecycleEvents: job.lifecycleEvents,
  };
}

function buildOracleToolErrorDetails(toolName: OracleToolErrorSource, error: unknown, params: Record<string, unknown>): OracleToolErrorDetails {
  const message = getErrorMessage(error);

  if (toolName === "oracle_submit" && typeof params.preset === "string" && message.startsWith("Unknown oracle_submit preset:")) {
    return {
      code: "invalid_preset",
      message,
      rejectedValue: params.preset,
      allowedValues: [...ORACLE_SUBMIT_PRESET_IDS],
      suggestedNextStep: "Retry with one of the canonical preset ids, or omit preset to use the configured default.",
    };
  }

  if (message.startsWith("Oracle requires a persisted pi session")) {
    return {
      code: "persisted_session_required",
      message,
      suggestedNextStep: "Start or save a persisted pi session, then retry oracle_submit.",
    };
  }

  if (message.startsWith("Oracle auth seed profile not found: ")) {
    return {
      code: "auth_seed_profile_missing",
      message,
      rejectedValue: message.replace(/^Oracle auth seed profile not found: /, "").replace(/\. Run \/oracle-auth first\.$/, ""),
      suggestedNextStep: "Call oracle_auth or run /oracle-auth once, then retry the oracle tool call.",
    };
  }

  if (message.startsWith("Oracle auth seed profile is not readable: ")) {
    return {
      code: "auth_seed_profile_unreadable",
      message,
      rejectedValue: message.replace(/^Oracle auth seed profile is not readable: /, "").replace(/\. Fix its permissions or rerun \/oracle-auth\.$/, ""),
      suggestedNextStep: "Fix the auth seed profile permissions or call oracle_auth / rerun /oracle-auth once, then retry.",
    };
  }

  if (message.startsWith("Oracle auth seed profile is not a directory: ")) {
    return {
      code: "auth_seed_profile_invalid_type",
      message,
      rejectedValue: message.replace(/^Oracle auth seed profile is not a directory: /, "").replace(/\. Remove the invalid path or rerun \/oracle-auth\.$/, ""),
      suggestedNextStep: "Remove the invalid auth seed path or call oracle_auth / rerun /oracle-auth once to recreate it.",
    };
  }

  if (message.startsWith("Oracle auth seed profile exists but is not authenticated: ")) {
    return {
      code: "auth_seed_profile_unauthenticated",
      message,
      rejectedValue: message.replace(/^Oracle auth seed profile exists but is not authenticated: /, "").replace(/\. Run \/oracle-auth.*$/, ""),
      suggestedNextStep: "Call oracle_auth or run /oracle-auth once to create a verified auth seed, then retry the oracle tool call.",
    };
  }

  if (message.startsWith("Failed to parse oracle config ") || message.startsWith("Invalid oracle config:") || message.startsWith("Invalid oracle project config:")) {
    return {
      code: "oracle_config_invalid",
      message,
      suggestedNextStep: "Fix the oracle config and retry once the configured paths and values are valid.",
    };
  }

  if (message.startsWith("Configured oracle browser executable does not exist: ")) {
    return {
      code: "browser_executable_missing",
      message,
      rejectedValue: message.replace(/^Configured oracle browser executable does not exist: /, "").replace(/\. Fix browser\.executablePath or install Chrome there\.$/, ""),
      suggestedNextStep: "Fix browser.executablePath or install Chrome at that path, then retry.",
    };
  }

  if (message.startsWith("Configured oracle browser executable is not executable: ")) {
    return {
      code: "browser_executable_not_executable",
      message,
      rejectedValue: message.replace(/^Configured oracle browser executable is not executable: /, "").replace(/\. Fix browser\.executablePath permissions or point it at a runnable Chrome binary\.$/, ""),
      suggestedNextStep: "Fix browser.executablePath permissions or point it at a runnable Chrome binary, then retry.",
    };
  }

  if (message.startsWith("Oracle prerequisite not found on PATH: ")) {
    const rejectedValue = message.replace(/^Oracle prerequisite not found on PATH: /, "").replace(/\. Install .*$/, "");
    return {
      code: "local_dependency_missing",
      message,
      rejectedValue,
      suggestedNextStep: `Install ${rejectedValue || "the missing dependency"} and retry.`,
    };
  }

  if (/^Oracle (auth seed profile|runtime profile|runtime profiles) path is unsafe: /.test(message)) {
    return {
      code: "oracle_profile_path_unsafe",
      message,
      suggestedNextStep: "Move browser.authSeedProfileDir/browser.runtimeProfilesDir outside real browser profile directories and retry.",
    };
  }

  if (message.startsWith("Oracle runtime profiles directory is not writable: ")) {
    return {
      code: "runtime_profiles_dir_unwritable",
      message,
      rejectedValue: message.replace(/^Oracle runtime profiles directory is not writable: /, "").replace(/\. Fix its permissions or configure a writable path, then retry\.$/, ""),
      suggestedNextStep: "Fix browser.runtimeProfilesDir permissions or configure a writable directory, then retry.",
    };
  }

  if (message.startsWith("Oracle jobs directory is not writable: ")) {
    return {
      code: "jobs_dir_unwritable",
      message,
      rejectedValue: message.replace(/^Oracle jobs directory is not writable: /, "").replace(/\. Fix its permissions or configure a writable path, then retry\.$/, ""),
      suggestedNextStep: "Fix PI_ORACLE_JOBS_DIR permissions or point it at a writable directory, then retry.",
    };
  }

  if (message.startsWith("ChatGPT browser relay is unavailable: ")) {
    return {
      code: "relay_unavailable",
      message,
      rejectedValue: message.replace(/^ChatGPT browser relay is unavailable: /, "").replace(/ \(.*$/, ""),
      suggestedNextStep: "Start the Chrome that serves browser.chatGptRelayEndpoint (the dedicated account browser, or signed-in Chrome with the relay extension connected), then retry. If that endpoint is not the intended one, correct browser.chatGptRelayEndpoint in the agent-level oracle.json instead. Do not call oracle_auth: relay mode refuses cookie import.",
    };
  }

  if (message.startsWith("Managed ChatGPT browser profile not found: ")) {
    return {
      code: "managed_browser_profile_missing",
      message,
      rejectedValue: message.replace(/^Managed ChatGPT browser profile not found: /, "").replace(/\. Run \/oracle-auth.*$/, ""),
      suggestedNextStep: "Call oracle_auth or run /oracle-auth: it opens the managed ChatGPT browser for sign-in. Retry once signed in.",
    };
  }

  if (message.startsWith("Managed ChatGPT browser profile is open in a Chrome without Oracle's DevTools endpoint: ")) {
    return {
      code: "managed_browser_in_use",
      message,
      rejectedValue: message.replace(/^Managed ChatGPT browser profile is open in a Chrome without Oracle's DevTools endpoint: /, "").replace(/ \(Chrome pid.*$/, ""),
      suggestedNextStep: "Quit the Chrome window using the managed profile, then retry: the next job reopens it with the DevTools endpoint Oracle needs.",
    };
  }

  if (toolName === "oracle_submit" && message === "oracle_submit requires at least one file or directory to archive") {
    return {
      code: "archive_input_required",
      message,
      suggestedNextStep: "Pass at least one project-relative file or directory in files.",
    };
  }

  if (toolName === "oracle_submit" && message === "Archive input must be a non-empty project-relative path") {
    return {
      code: "archive_input_blank",
      message,
      suggestedNextStep: "Retry with a non-empty project-relative file or directory path. Use '.' only when you intentionally want a whole-repo archive.",
    };
  }

  if (toolName === "oracle_submit" && message === "Archive input must use '.' exactly for a whole-repo archive") {
    return {
      code: "archive_input_whole_repo_sentinel_invalid",
      message,
      suggestedNextStep: "If you want a whole-repo archive, pass '.' exactly. Otherwise pass an exact project-relative path without extra padding.",
    };
  }

  const missingArchiveInput = message.match(/^Archive input does not exist: (.*) \(resolved against project root (.*)\)$/s);
  if (toolName === "oracle_submit" && missingArchiveInput) {
    return {
      code: "archive_input_missing",
      message,
      rejectedValue: missingArchiveInput[1],
      suggestedNextStep: `Retry with an existing file or directory relative to project root ${missingArchiveInput[2]}.`,
    };
  }

  if (toolName === "oracle_submit" && message.startsWith("Archive input must be inside the project cwd: ")) {
    return {
      code: "archive_input_outside_project",
      message,
      rejectedValue: message.replace(/^Archive input must be inside the project cwd: /, ""),
      suggestedNextStep: "Retry with a path inside the current project cwd.",
    };
  }

  if (toolName === "oracle_submit" && message.startsWith("Archive input must resolve inside the project cwd without symlink escapes: ")) {
    return {
      code: "archive_input_symlink_escape",
      message,
      rejectedValue: message.replace(/^Archive input must resolve inside the project cwd without symlink escapes: /, ""),
      suggestedNextStep: "Retry with a real project-relative path that does not escape the repo through symlinks.",
    };
  }

  if ((toolName === "oracle_submit" || toolName === "oracle_preflight") && message === "Pass either followUpJobId or chatGptConversationId, not both") {
    return {
      code: "oracle_thread_target_conflict",
      message,
      suggestedNextStep: "Retry with exactly one same-thread target: followUpJobId for an oracle-created thread, or chatGptConversationId for an existing ChatGPT browser thread.",
    };
  }

  if ((toolName === "oracle_submit" || toolName === "oracle_preflight") && (message === "ChatGPT conversation id must be a non-empty string" || message.startsWith("Invalid ChatGPT conversation id or URL: "))) {
    return {
      code: "invalid_chatgpt_conversation_id",
      message,
      rejectedValue: typeof params.chatGptConversationId === "string" ? params.chatGptConversationId : undefined,
      suggestedNextStep: "Retry with a ChatGPT conversation id like 6a28ab5c-e4d4-83e8-b8be-dd39f38a26d6 or a full https://chatgpt.com/c/... URL, or omit chatGptConversationId to start a fresh thread.",
    };
  }

  if (toolName === "oracle_submit" && message.startsWith("Follow-up oracle job not found: ")) {
    return {
      code: "follow_up_job_not_found",
      message,
      rejectedValue: typeof params.followUpJobId === "string" ? params.followUpJobId : undefined,
      suggestedNextStep: "Retry with a completed oracle job id from this project that has a persisted chat URL.",
    };
  }

  if (toolName === "oracle_submit" && message.includes("belongs to a different project")) {
    return {
      code: "follow_up_job_wrong_project",
      message,
      rejectedValue: typeof params.followUpJobId === "string" ? params.followUpJobId : undefined,
      suggestedNextStep: "Retry with a follow-up job id from the current project.",
    };
  }

  if (toolName === "oracle_submit" && message.includes("is not complete")) {
    return {
      code: "follow_up_job_not_complete",
      message,
      rejectedValue: typeof params.followUpJobId === "string" ? params.followUpJobId : undefined,
      suggestedNextStep: "Wait for the earlier oracle job to finish, then retry the follow-up.",
    };
  }

  if (toolName === "oracle_submit" && message.includes("has no persisted chat URL")) {
    return {
      code: "follow_up_job_missing_chat_url",
      message,
      rejectedValue: typeof params.followUpJobId === "string" ? params.followUpJobId : undefined,
      suggestedNextStep: "Retry with an earlier completed oracle job that recorded a chat URL.",
    };
  }

  if ((toolName === "oracle_read" || toolName === "oracle_cancel") && typeof params.jobId === "string" && message.startsWith("Oracle job not found in this project:")) {
    return {
      code: "job_not_found",
      message,
      rejectedValue: params.jobId,
      suggestedNextStep: "Use /oracle-status to discover a valid job id for this project, then retry.",
    };
  }

  if (toolName === "oracle_read" && error instanceof OracleJobProjectMismatchError) {
    return {
      code: "job_wrong_project",
      message,
      rejectedValue: error.jobId,
      suggestedNextStep: `Retry oracle_read with jobId: ${JSON.stringify(error.jobId)}, projectId: ${JSON.stringify(error.projectId)}.`,
    };
  }

  if (toolName === "oracle_submit" && (message.startsWith("Oracle archive exceeds provider upload limit") || message.startsWith("Oracle archive exceeds ChatGPT upload limit"))) {
    return {
      code: "archive_too_large",
      message,
      suggestedNextStep: "This failure is retryable. Retry automatically with fewer selected files: first remove the largest obviously irrelevant/generated/history/export content, then if needed narrow to the directly relevant subtrees plus adjacent docs/tests/config, and if it still does not fit explain what was cut before asking the user.",
    };
  }

  return {
    code: `${toolName}_failed`,
    message,
    suggestedNextStep: "Inspect the error message, correct the inputs or environment, and retry.",
  };
}

/** Session footer readiness for a failed prerequisite check, derived from the same codes agents receive. */
export function classifyOracleReadinessError(error: unknown): { readiness: OracleReadinessStatus; message: string } {
  const { code, message } = buildOracleToolErrorDetails("oracle_preflight", error, {});
  if (AUTH_NEEDED_ERROR_CODES[code] === true) return { readiness: "auth_needed", message };
  if (code === "relay_unavailable" || code === "managed_browser_in_use") return { readiness: "browser_unavailable", message };
  return { readiness: "config_error", message };
}

function buildOracleToolErrorResult(
  toolName: OracleToolName,
  error: unknown,
  params: unknown,
  options?: { job?: NonNullable<ReturnType<typeof readJob>>; jobDetails?: OracleToolJobDetailsOptions },
) {
  const errorDetails = buildOracleToolErrorDetails(toolName, error, asRecord(params) ?? {});
  return {
    content: [{
      type: "text" as const,
      text: [
        errorDetails.message,
        errorDetails.suggestedNextStep ? `Suggested next step: ${errorDetails.suggestedNextStep}` : undefined,
      ].filter(Boolean).join("\n"),
    }],
    details: {
      job: options?.job ? redactJobDetails(options.job, options.jobDetails) : undefined,
      error: errorDetails,
    },
  };
}

type OraclePreflightDetails = {
  ready: boolean;
  capacity?: OracleCapacity;
  provider?: OracleProvider;
  session: {
    persisted: boolean;
    sessionFile?: string;
  };
  config: {
    ready: boolean;
  };
  auth: {
    ready: boolean;
    seedProfileDir?: string;
    relayEndpoint?: string;
    managedProfileDir?: string;
  };
  error?: OracleToolErrorDetails;
};

/** Shared-browser transports never verify login in preflight; the worker checks it on the job's own tab. */
function preflightAuthDetails(config: OracleConfig, seedReady: boolean): OraclePreflightDetails["auth"] {
  const shared = usesSharedBrowser(config);
  return {
    ready: !shared && seedReady,
    seedProfileDir: shared ? undefined : config.browser.authSeedProfileDir,
    relayEndpoint: config.browser.chatGptRelayEndpoint,
    managedProfileDir: config.browser.chatGptManagedProfileDir,
  };
}

function formatOracleProviderLabel(provider: OracleProvider | undefined): string {
  if (provider === "grok") return "Grok";
  if (provider === "chatgpt") return "ChatGPT";
  return "configured provider";
}

function formatOraclePreflightResponse(details: OraclePreflightDetails): string {
  const providerLabel = formatOracleProviderLabel(details.provider);
  const capacityLine = details.capacity ? `Capacity: ${details.capacity.activeJobs}/${details.capacity.maxActiveJobs} active, ${details.capacity.queuedJobs}/${details.capacity.maxQueuedJobs} queued (global).` : undefined;
  if (details.ready) {
    return [
      `Oracle preflight ready for ${providerLabel}.`,
      capacityLine,
      details.session.sessionFile ? `Persisted pi session (current run): ${details.session.sessionFile}` : undefined,
      details.auth.seedProfileDir ? `Auth seed profile (${providerLabel} login source): ${details.auth.seedProfileDir}` : undefined,
      details.auth.relayEndpoint
        ? `Relay transport reachable at ${details.auth.relayEndpoint}. Login is not verified by preflight; the worker checks it before uploading.`
        : details.auth.managedProfileDir
          ? `Managed ChatGPT browser profile: ${details.auth.managedProfileDir}. Jobs reuse the Chrome serving it or open one, and a Chrome that Oracle opened quits after the jobs finish. Login is not verified by preflight; the worker checks it before uploading.`
          : `Preflight validates the persisted pi session, local oracle config, and ${providerLabel} auth seed created by oracle_auth.`,
      "If you are dispatching an oracle job, continue with context gathering and submission.",
    ].filter(Boolean).join("\n");
  }

  return [
    `Oracle preflight blocked: ${details.error?.message ?? "unknown blocker"}`,
    capacityLine,
    `Preflight checks the persisted pi session, local oracle config, and ${details.auth.relayEndpoint ? "relay transport" : details.auth.managedProfileDir ? "managed browser profile" : `${providerLabel} auth seed`} before any archive work starts.`,
    details.error?.suggestedNextStep ? `Suggested next step: ${details.error.suggestedNextStep}` : undefined,
  ].filter(Boolean).join("\n");
}

async function runOraclePreflight(ctx: ExtensionContext, params: { provider?: unknown; followUpJobId?: unknown; chatGptConversationId?: unknown } = {}): Promise<OraclePreflightDetails> {
  const sessionFile = getSessionFile(ctx);
  if (!hasPersistedSessionFile(sessionFile)) {
    return {
      ready: false,
      session: { persisted: false },
      config: { ready: false },
      auth: { ready: false },
      error: buildOracleToolErrorDetails(
        "oracle_preflight",
        new Error("Oracle requires a persisted pi session to submit oracle jobs. Start or save a real session before using oracle."),
        {},
      ),
    };
  }

  let config;
  let capacity: OracleCapacity | undefined;
  let provider: OracleProvider | undefined;
  try {
    const followUpJobId = params.followUpJobId;
    const chatGptConversationId = params.chatGptConversationId;
    if (followUpJobId !== undefined && typeof followUpJobId !== "string") {
      throw new Error("oracle_preflight followUpJobId must be a string");
    }
    if (chatGptConversationId !== undefined && typeof chatGptConversationId !== "string") {
      throw new Error("oracle_preflight chatGptConversationId must be a string");
    }
    const baseConfig = loadOracleConfig(ctx.cwd, { projectConfigTrusted: isOracleProjectTrusted(ctx) });
    capacity = getOracleCapacity(baseConfig);
    const target = resolveConversationTarget({ followUpJobId, chatGptConversationId, cwd: ctx.cwd, config: baseConfig });
    provider = normalizeOracleProvider(params.provider, target.provider ?? baseConfig.defaults.provider, "oracle_preflight");
    if (target.provider && provider !== target.provider) {
      throw new Error(`${target.label ?? "Oracle conversation"} requires provider ${target.provider}; cannot check it with ${provider}.`);
    }
    config = resolveOracleConfigForProvider(baseConfig, provider);
  } catch (error) {
    return {
      ready: false,
      provider,
      session: { persisted: true, sessionFile },
      config: { ready: false },
      auth: { ready: false },
      error: buildOracleToolErrorDetails("oracle_preflight", error, asRecord(params) ?? {}),
      capacity,
    };
  }

  try {
    await assertOracleSubmitPrerequisites(config, provider);
  } catch (error) {
    const errorDetails = buildOracleToolErrorDetails("oracle_preflight", error, asRecord(params) ?? {});
    return {
      ready: false,
      provider,
      session: { persisted: true, sessionFile },
      config: { ready: true },
      auth: preflightAuthDetails(config, AUTH_NEEDED_ERROR_CODES[errorDetails.code] !== true),
      error: errorDetails,
      capacity,
    };
  }

  return {
    ready: true,
    provider,
    session: { persisted: true, sessionFile },
    config: { ready: true },
    auth: preflightAuthDetails(config, true),
    capacity,
  };
}

export function registerOracleTools(pi: ExtensionAPI, workerPath: string, authWorkerPath = workerPath): void {
  pi.on("tool_result", async (event) => {
    if (!ORACLE_TOOL_NAMES.has(event.toolName as OracleToolName)) return;
    if (event.isError) return;
    const details = asRecord(event.details);
    const errorDetails = asRecord(details?.error);
    if (typeof errorDetails?.code === "string" && typeof errorDetails?.message === "string") {
      return { isError: true };
    }
  });

  pi.registerTool({
    name: "oracle_preflight",
    label: "Oracle Preflight",
    description: "Check whether oracle is ready in this session before spending time gathering context or preparing a submission.",
    promptSnippet: "Check oracle readiness before expensive /oracle preparation.",
    promptGuidelines: [
      "Call oracle_preflight before doing expensive /oracle preparation. Pass provider='grok' when the user explicitly asks for Grok, followUpJobId for same-thread follow-ups from oracle-created jobs, or chatGptConversationId when the user explicitly provides an existing ChatGPT browser conversation id/URL. If ready is false, stop immediately and report the suggested next step instead of reading files or crafting archive inputs.",
    ],
    parameters: ORACLE_PREFLIGHT_PARAMS,
    prepareArguments: (args) => prepareOracleProviderAliases(args, "oracle_preflight"),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const details = await runOraclePreflight(ctx, params);
      return {
        content: [{ type: "text" as const, text: formatOraclePreflightResponse(details) }],
        details,
      };
    },
  });

  pi.registerTool({
    name: "oracle_auth",
    label: "Oracle Auth",
    description: "Refresh the shared oracle auth seed profile by importing ChatGPT or Grok cookies from your configured local browser profile, based on the configured default provider.",
    promptSnippet: "Refresh oracle auth before retrying a login-required oracle run.",
    promptGuidelines: [
      "Call oracle_auth when an oracle run failed because ChatGPT or Grok login is required, the worker said to rerun /oracle-auth, or stale auth appears to be blocking submission execution. Pass provider='grok' when refreshing Grok auth.",
      "For relay-backed ChatGPT, finish login or human verification in the existing Chrome session instead; oracle_auth does not import cookies in relay mode.",
      "At most once per user request, refresh auth and then retry the blocked oracle submission.",
      "If oracle_auth itself fails, stop and report the failure instead of looping.",
    ],
    parameters: ORACLE_AUTH_PARAMS,
    prepareArguments: (args) => prepareOracleProviderAliases(args, "oracle_auth"),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      try {
        const projectCwd = getProjectId(ctx.cwd);
        const baseConfig = loadOracleConfig(projectCwd, { projectConfigTrustCwd: ctx.cwd, projectConfigTrusted: isOracleProjectTrusted(ctx) });
        const provider = normalizeOracleProvider(params.provider, baseConfig.defaults.provider, "oracle_auth");
        const message = await runOracleAuthBootstrap(authWorkerPath, projectCwd, provider, { projectConfigTrustCwd: ctx.cwd, projectConfigTrusted: isOracleProjectTrusted(ctx) });
        return {
          content: [{ type: "text" as const, text: message }],
          details: {
            refreshed: true,
            provider,
            authSeedProfileDir: resolveOracleConfigForProvider(baseConfig, provider).browser.authSeedProfileDir,
          },
        };
      } catch (error) {
        return buildOracleToolErrorResult("oracle_auth", error, {});
      }
    },
  });

  pi.registerTool({
    name: "oracle_submit",
    label: "Oracle Submit",
    description:
      "Dispatch a background ChatGPT or Grok web oracle job after gathering context. Always pass a prompt and exact project-relative archive inputs. " +
      "Optional provider: set `provider` to `grok` when the user asks for Grok; Grok currently supports only Heavy. Optional ChatGPT model: set parameter `preset`, or omit it for configured defaults; canonical preset ids are listed in the README and ORACLE_SUBMIT_PRESETS registry, and matching labels are normalized at submit time. " +
      "Optional thread target: pass `chatGptConversationId` only when the user explicitly provides an existing ChatGPT browser conversation id/URL to continue; omit it for the default fresh oracle thread.",
    promptSnippet: "Dispatch a background ChatGPT or Grok web oracle job after gathering repo context.",
    promptGuidelines: [
      "Call oracle_preflight first, then gather enough context to choose archive inputs before oracle_submit.",
      "Use context-rich archives when they fit; use files='.' for broad repo-wide asks. Default exclusions already skip common bulky outputs and obvious credentials/private data.",
      "Pass chatGptConversationId only when the user explicitly provides an existing ChatGPT conversation id/URL; otherwise omit it for a fresh thread.",
      "If auth is stale, call oracle_auth at most once before retrying. If oracle_auth fails, stop and report it.",
      "If details.error.code is 'archive_too_large', retry once with a smaller archive using the reported size/pruning details; do not loop.",
      "After a successful or queued oracle_submit, stop and report only the dispatch summary. Do not keep working while the oracle job runs, and do not poll; if the user later asks for status, call oracle_read with the returned jobId.",
      "For ChatGPT, use preset only when the user requests model control; otherwise omit it. For Grok, pass provider='grok' and omit preset.",
    ],
    parameters: ORACLE_SUBMIT_PARAMS,
    prepareArguments: prepareOracleSubmitArguments,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      try {
        const projectCwd = getProjectId(ctx.cwd);
        const baseConfig = loadOracleConfig(projectCwd, { projectConfigTrustCwd: ctx.cwd, projectConfigTrusted: isOracleProjectTrusted(ctx) });
        const originSessionFile = requirePersistedSessionFile(getSessionFile(ctx), "submit oracle jobs");
        const projectId = getProjectId(projectCwd);
        const sessionId = getSessionId(originSessionFile, projectId);
        const target = resolveConversationTarget({
          followUpJobId: params.followUpJobId,
          chatGptConversationId: params.chatGptConversationId,
          cwd: projectCwd,
          config: baseConfig,
        });
        const provider = normalizeOracleProvider(params.provider, target.provider ?? baseConfig.defaults.provider, "oracle_submit");
        if (target.provider && provider !== target.provider) {
          throw new Error(`${target.label ?? "Oracle conversation"} requires provider ${target.provider}; cannot continue it with ${provider}.`);
        }
        if (provider === "grok" && typeof params.preset === "string") {
          throw new Error("oracle_submit preset is only valid for ChatGPT. For Grok, use provider='grok' and mode='heavy'.");
        }
        if (provider === "chatgpt" && typeof params.mode === "string") {
          throw new Error("oracle_submit mode is only valid for Grok. For ChatGPT, omit mode and use preset for model selection.");
        }
        const selection = provider === "grok"
          ? resolveOracleGrokMode(normalizeGrokMode(params.mode, baseConfig.defaults.grokMode))
          : resolveOracleSubmitPreset(typeof params.preset === "string" ? coerceOracleSubmitPresetId(params.preset) : baseConfig.defaults.preset);
        const config = resolveOracleConfigForProvider(baseConfig, provider);
        const targetChatUrl = target.chatUrl;
        // Validate caller-specified archive paths before surfacing unrelated local setup failures such as a missing auth seed profile.
        resolveArchiveInputs(projectCwd, params.files);
        await assertOracleSubmitPrerequisites(config, provider);
        try {
          await withGlobalReconcileLock({ processPid: process.pid, source: "oracle_submit", cwd: projectCwd }, async () => {
            await reconcileStaleOracleJobs();
            await pruneTerminalOracleJobs();
          });
        } catch (error) {
          if (!isLockTimeoutError(error, "reconcile", "global")) throw error;
        }

        const jobId = randomUUID();
        const archivePlan = resolveOracleProviderArchivePlan(selection.provider);
        const tempArchivePath = join(tmpdir(), `oracle-archive-${jobId}.${archivePlan.archiveExtension}`);
        const runtime = allocateRuntime(config);
        let job: OracleJob | undefined;
        let archive: ArchiveCreationResult | undefined;
        let queued = false;
        let queuedSubmissionDurable = false;
        let runtimeLeaseAcquired = false;
        let conversationLeaseAcquired = false;
        let workerSpawned = false;
        let spawnedWorker: Awaited<ReturnType<typeof spawnWorker>> | undefined;

        try {
          archive = await createArchive(projectCwd, params.files, tempArchivePath, archivePlan.maxArchiveBytes, archivePlan.archiveFormat);
          const currentArchive = archive;
          await withLock("admission", "global", { jobId, processPid: process.pid }, async () => {
            await promoteQueuedJobsWithinAdmissionLock({ workerPath, source: "oracle_submit" });

            const admittedAt = new Date().toISOString();
            const runtimeAttempt = await tryAcquireRuntimeLease(config, {
              jobId,
              runtimeId: runtime.runtimeId,
              runtimeSessionName: runtime.runtimeSessionName,
              runtimeProfileDir: runtime.runtimeProfileDir,
              projectId,
              sessionId,
              createdAt: admittedAt,
            });

            if (!runtimeAttempt.acquired) {
              const queuePressure = await getQueuedArchivePressure();
              const maxQueuedJobs = maxQueuedJobsForConfig(config);
              const maxQueuedArchiveBytes = config.browser.maxConcurrentJobs * MAX_QUEUED_ARCHIVE_BYTES_PER_ACTIVE_RUNTIME;
              const queueAdmissionFailure = getQueueAdmissionFailure({
                queuePressure,
                archiveBytes: currentArchive.archiveBytes,
                activeJobs: runtimeAttempt.liveLeases.length,
                maxActiveJobs: config.browser.maxConcurrentJobs,
                maxQueuedJobs,
                maxQueuedArchiveBytes,
              });
              if (queueAdmissionFailure) {
                throw new Error(queueAdmissionFailure);
              }

              queued = true;
              job = await createJob(
                jobId,
                {
                  prompt: params.prompt,
                  files: params.files,
                  selection,
                  followUpToJobId: target.followUpToJobId,
                  chatUrl: targetChatUrl,
                  requestSource: "tool",
                },
                projectCwd,
                originSessionFile,
                config,
                runtime,
                { initialState: "queued", createdAt: admittedAt },
              );
              await rename(tempArchivePath, job.archivePath);
              job = await updateJob(job.id, (current) => ({
                ...current,
                archiveSha256: currentArchive.sha256,
              }));
              queuedSubmissionDurable = true;
              return;
            }

            runtimeLeaseAcquired = true;
            if (target.conversationId) {
              const conversationAttempt = await tryAcquireConversationLease({
                jobId,
                conversationId: target.conversationId,
                projectId,
                sessionId,
                createdAt: admittedAt,
              });
              if (!conversationAttempt.acquired) {
                throw new Error(
                  `Oracle conversation ${target.conversationId} is already in use by job ${conversationAttempt.blocker?.jobId ?? "unknown"}. ` +
                    "Concurrent jobs targeting the same ChatGPT thread are not allowed.",
                );
              }
              conversationLeaseAcquired = true;
            }

            job = await createJob(
              jobId,
              {
                prompt: params.prompt,
                files: params.files,
                selection,
                followUpToJobId: target.followUpToJobId,
                chatUrl: targetChatUrl,
                requestSource: "tool",
              },
              projectCwd,
              originSessionFile,
              config,
              runtime,
              { initialState: "submitted", createdAt: admittedAt },
            );
            await rename(tempArchivePath, job.archivePath);
            spawnedWorker = await spawnWorker(workerPath, job.id);
            workerSpawned = true;
            const worker = spawnedWorker;
            job = await updateJob(job.id, (current) => ({
              ...current,
              archiveSha256: currentArchive.sha256,
              workerPid: worker.pid,
              workerNonce: worker.nonce,
              workerStartedAt: worker.startedAt,
            }));
          });
          if (!job || !archive) throw new Error(`Oracle submission ${jobId} did not persist job metadata durably`);
          if (ctx.hasUI) refreshOracleStatus(ctx);

          const queuePosition = queued ? getQueuePosition(job.id) : undefined;
          return {
            content: [
              {
                type: "text",
                text: formatOracleSubmitResponse(job, {
                  autoPrunedPrefixes: archive.autoPrunedPrefixes,
                  queued,
                  queuePosition: queuePosition?.position,
                  queueDepth: queuePosition?.depth,
                }),
              },
            ],
            details: {
              job: redactJobDetails(job, {
                queue: buildOracleQueueSnapshot(job, queuePosition),
                archiveBytes: archive.archiveBytes,
                initialArchiveBytes: archive.initialArchiveBytes,
                autoPrunedArchivePaths: archive.autoPrunedPrefixes,
              }),
            },
          };
        } catch (error) {
          const message = getErrorMessage(error);
          const latest = job ? readJob(job.id) : undefined;
          if (latest?.status === "queued" && queuedSubmissionDurable) {
            if (ctx.hasUI) refreshOracleStatus(ctx);
            const queuePosition = getQueuePosition(latest.id);
            return {
              content: [
                {
                  type: "text",
                  text: formatOracleSubmitResponse(latest, {
                    autoPrunedPrefixes: archive?.autoPrunedPrefixes ?? [],
                    queued: true,
                    queuePosition: queuePosition?.position,
                    queueDepth: queuePosition?.depth,
                  }),
                },
              ],
              details: {
                job: redactJobDetails(latest, {
                  queue: buildOracleQueueSnapshot(latest, queuePosition),
                  archiveBytes: archive?.archiveBytes,
                  initialArchiveBytes: archive?.initialArchiveBytes,
                  autoPrunedArchivePaths: archive?.autoPrunedPrefixes,
                }),
              },
            };
          }
          if (workerSpawned && latest && hasDurableWorkerHandoff(latest)) {
            if (ctx.hasUI) refreshOracleStatus(ctx);
            return {
              content: [
                {
                  type: "text",
                  text: formatOracleSubmitResponse(latest, {
                    autoPrunedPrefixes: archive?.autoPrunedPrefixes ?? [],
                    queued: false,
                  }),
                },
              ],
              details: {
                job: redactJobDetails(latest, {
                  queue: buildOracleQueueSnapshot(latest),
                  archiveBytes: archive?.archiveBytes,
                  initialArchiveBytes: archive?.initialArchiveBytes,
                  autoPrunedArchivePaths: archive?.autoPrunedPrefixes,
                }),
              },
            };
          }
          if (spawnedWorker) {
            await terminateWorkerPid(spawnedWorker.pid, spawnedWorker.startedAt).catch(() => undefined);
          }
          if (job && (!latest || !isTerminalOracleJob(latest))) {
            const failedAt = new Date().toISOString();
            await updateJob(job.id, (current) => transitionOracleJobPhase(current, "failed", {
              at: failedAt,
              source: "oracle:submit",
              message: `Submission failed before durable worker handoff: ${message}`,
              patch: {
                error: message,
              },
            })).catch(() => undefined);
          }
          const cleanupReport = await cleanupRuntimeArtifacts({
            runtimeId: runtimeLeaseAcquired ? runtime.runtimeId : undefined,
            runtimeProfileDir: runtimeLeaseAcquired ? runtime.runtimeProfileDir : undefined,
            runtimeSessionName: workerSpawned ? runtime.runtimeSessionName : undefined,
            conversationId: conversationLeaseAcquired ? target.conversationId : undefined,
            ...sharedBrowserCleanupFields(latest ?? job, config),
          }).catch(() => ({ attempted: [], warnings: [] }));
          if (job && cleanupReport.warnings.length > 0) {
            await appendCleanupWarnings(job.id, cleanupReport.warnings).catch(() => undefined);
          }
          if (ctx.hasUI) refreshOracleStatus(ctx);
          return buildOracleToolErrorResult("oracle_submit", error, params, {
            job: latest ?? job,
            jobDetails: {
              queue: latest ? buildOracleQueueSnapshot(latest, latest.status === "queued" ? getQueuePosition(latest.id) : undefined) : undefined,
              archiveBytes: archive?.archiveBytes,
              initialArchiveBytes: archive?.initialArchiveBytes,
              autoPrunedArchivePaths: archive?.autoPrunedPrefixes,
            },
          });
        } finally {
          await rm(tempArchivePath, { force: true }).catch(() => undefined);
        }
      } catch (error) {
        return buildOracleToolErrorResult("oracle_submit", error, params);
      }
    },
  });

  pi.registerTool({
    name: "oracle_read",
    label: "Oracle Read",
    description: "Read saved status and outputs, optionally naming the owning projectId for an external-project job, or explicitly recollect a completed bound result without sending a prompt.",
    promptSnippet: "Read oracle job status, queue position, artifacts, and response preview by job id.",
    promptGuidelines: ["Use oracle_read when the user asks for saved status, output, or artifacts. Use action=recollect only to retry collection of an already completed exact bound turn; it never submits or regenerates a response."],
    parameters: ORACLE_READ_PARAMS,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      try {
        const job = readJobForProject(params.jobId, params.projectId ?? getProjectId(ctx.cwd));
        if (params.action === "recollect") {
          if (job.status !== "complete") throw new Error("Recollection requires an already completed job.");
          if ((params.responseIndex === undefined) !== (params.messageId === undefined)) throw new Error("Legacy turn binding requires responseIndex and messageId together.");
          const explicit = params.responseIndex !== undefined || params.messageId !== undefined
            ? JSON.stringify({ responseIndex: params.responseIndex, messageId: params.messageId }) : undefined;
          // Collection-only worker run, awaited in-turn; its own deadlines end it in minutes, this backstop ends a wedged transport.
          await execFileAsync(resolveNodeExecutable(), [workerPath, job.id, "--recollect", ...(explicit ? [explicit] : [])], { maxBuffer: 1024 * 1024, timeout: 10 * 60 * 1000 });
        } else if (params.responseIndex !== undefined || params.messageId !== undefined) throw new Error("Turn binding parameters require action=recollect.");
        const readerSessionFile = getSessionFile(ctx);
        const latest = isTerminalOracleJob(job)
          ? await markWakeupSettled(job.id, {
            source: "oracle_read",
            sessionFile: readerSessionFile,
            cwd: ctx.cwd,
            allowBeforeFirstAttempt: getWakeupSessionKey(readerSessionFile, ctx.cwd) === `${job.projectId}::${job.sessionId}`,
          })
          : job;
        const current = latest ?? readJob(job.id) ?? job;

        let responsePreview: string | undefined;
        let responseLength: number | undefined;
        let responseAvailable = false;
        try {
          const response = await readFile(current.responsePath || "", "utf8");
          responsePreview = response.slice(0, 4000);
          responseLength = response.length;
          responseAvailable = true;
        } catch {
          responsePreview = undefined;
        }

        const queuePosition = current.status === "queued" ? getQueuePosition(current.id) : undefined;
        return {
          content: [
            {
              type: "text",
              text: formatOracleJobSummary(current, {
                queuePosition,
                artifactsPath: `${getJobDir(current.id)}/artifacts`,
                responsePreview,
                responseLength,
                responseAvailable,
                heartbeatStaleMs: ORACLE_STALE_HEARTBEAT_MS,
              }),
            },
          ],
          details: {
            job: redactJobDetails(current, {
              queue: buildOracleQueueSnapshot(current, queuePosition),
              responsePreview,
              responseAvailable,
            }),
          },
        };
      } catch (error) {
        return buildOracleToolErrorResult("oracle_read", error, params);
      }
    },
  });

  pi.registerTool({
    name: "oracle_cancel",
    label: "Oracle Cancel",
    description: "Cancel a queued or active oracle job.",
    promptSnippet: "Cancel a queued or active oracle background job by job id.",
    promptGuidelines: ["Use oracle_cancel only when the user explicitly asks to stop a queued or active oracle job."],
    parameters: ORACLE_CANCEL_PARAMS,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      try {
        const job = readJob(params.jobId);
        if (!job || job.projectId !== getProjectId(ctx.cwd)) {
          throw new Error(`Oracle job not found in this project: ${params.jobId}`);
        }
        if (!isOpenOracleJob(job)) {
          return {
            content: [{ type: "text", text: `Oracle job ${job.id} is not cancellable (${job.status}).` }],
            details: { job: redactJobDetails(job, { queue: buildOracleQueueSnapshot(job, job.status === "queued" ? getQueuePosition(job.id) : undefined) }) },
          };
        }

        const cancelled = await cancelOracleJob(params.jobId);
        if (shouldAdvanceQueueAfterCancellation(cancelled)) {
          await promoteQueuedJobs({ workerPath, source: "oracle_cancel_tool" });
        }
        if (ctx.hasUI) refreshOracleStatus(ctx);
        return {
          content: [{ type: "text", text: formatOracleCancelOutcome(cancelled) }],
          details: { job: redactJobDetails(cancelled, { queue: buildOracleQueueSnapshot(cancelled, cancelled.status === "queued" ? getQueuePosition(cancelled.id) : undefined) }) },
        };
      } catch (error) {
        return buildOracleToolErrorResult("oracle_cancel", error, params);
      }
    },
  });
}
