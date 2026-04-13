// Purpose: Provide shared oracle job observability formatting for UI messages, tool responses, and wake-up notifications.
// Responsibilities: Format job summaries, lifecycle breadcrumbs, submit responses, wake-up notification content, and session status text consistently across channels.
// Scope: Presentation helpers only; lifecycle mutation, persistence, and browser execution remain in lifecycle/job modules.
// Usage: Imported by commands, tools, poller, and extension startup/status code to keep detached-oracle messaging consistent.
// Invariants/Assumptions: Job summaries read from durable job state, and lifecycle event trails are bounded and already normalized by shared lifecycle helpers.

import { getLatestOracleJobLifecycleEvent, getLatestOracleTerminalLifecycleEvent } from "./job-lifecycle-helpers.mjs";

/** @typedef {import("./job-observability-helpers.d.mts").OracleJobSummaryLike} OracleJobSummaryLike */
/** @typedef {import("./job-observability-helpers.d.mts").OracleJobSummaryOptions} OracleJobSummaryOptions */
/** @typedef {import("./job-observability-helpers.d.mts").OracleStatusCounts} OracleStatusCounts */
/** @typedef {import("./job-observability-helpers.d.mts").OracleSubmitResponseOptions} OracleSubmitResponseOptions */
/** @typedef {import("./job-lifecycle-helpers.d.mts").OracleJobLifecycleEvent} OracleJobLifecycleEvent */

/**
 * @param {number} bytes
 * @returns {string}
 */
export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value >= 10 || unitIndex === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[unitIndex]}`;
}

/**
 * @param {OracleJobLifecycleEvent | undefined} event
 * @returns {string | undefined}
 */
export function formatOracleLifecycleEvent(event) {
  if (!event) return undefined;
  return `${event.at} [${event.source}] ${event.message}`;
}

/**
 * @param {Array<{ relativePath: string; bytes: number }>} autoPrunedPrefixes
 * @returns {string | undefined}
 */
function formatAutoPrunedArchiveMessage(autoPrunedPrefixes) {
  if (autoPrunedPrefixes.length === 0) return undefined;
  return `Archive auto-pruned generic generated-output-name dirs to fit size limit: ${autoPrunedPrefixes.map((entry) => `${entry.relativePath}/ (${formatBytes(entry.bytes)})`).join(", ")}`;
}

/**
 * @param {OracleJobSummaryLike} job
 * @param {OracleJobSummaryOptions} [options]
 * @returns {string}
 */
export function formatOracleJobSummary(job, options = {}) {
  const latestEventRaw = options.includeLatestEvent === false ? undefined : getLatestOracleJobLifecycleEvent(job);
  const terminalEventRaw = getLatestOracleTerminalLifecycleEvent(job);
  const latestEvent = formatOracleLifecycleEvent(latestEventRaw);
  const terminalEvent = formatOracleLifecycleEvent(terminalEventRaw);
  const sameEvent = Boolean(
    latestEventRaw && terminalEventRaw &&
    latestEventRaw.at === terminalEventRaw.at &&
    latestEventRaw.source === terminalEventRaw.source &&
    latestEventRaw.kind === terminalEventRaw.kind &&
    latestEventRaw.message === terminalEventRaw.message,
  );
  const responseLine = options.responseAvailable === true
    ? job.responsePath ? `response: ${job.responsePath}` : undefined
    : job.responsePath ? "response: unavailable yet" : undefined;
  const responseFormatLine = options.responseAvailable === true && job.responseFormat ? `response-format: ${job.responseFormat}` : undefined;
  const latestEventLabel = latestEventRaw?.kind === "wakeup" ? "wakeup-event" : "last-event";
  return [
    `job: ${job.id}`,
    `status: ${job.status}`,
    `phase: ${job.phase}`,
    `created: ${job.createdAt}`,
    job.queuedAt ? `queued: ${job.queuedAt}` : undefined,
    job.submittedAt ? `submitted: ${job.submittedAt}` : undefined,
    options.queuePosition ? `queue-position: ${options.queuePosition.position} of ${options.queuePosition.depth} global` : undefined,
    `project: ${job.projectId}`,
    `session: ${job.sessionId}`,
    job.completedAt ? `completed: ${job.completedAt}` : undefined,
    job.followUpToJobId ? `follow-up-to: ${job.followUpToJobId}` : undefined,
    job.chatUrl ? `chat: ${job.chatUrl}` : undefined,
    job.conversationId ? `conversation: ${job.conversationId}` : undefined,
    responseLine,
    responseFormatLine,
    options.artifactsPath ? `artifacts: ${options.artifactsPath}` : undefined,
    typeof job.artifactFailureCount === "number" ? `artifact-failures: ${job.artifactFailureCount}` : undefined,
    options.includeWorkerLogPath === false ? undefined : job.workerLogPath ? `worker-log: ${job.workerLogPath}` : undefined,
    job.lastCleanupAt ? `last-cleanup: ${job.lastCleanupAt}` : undefined,
    job.cleanupWarnings?.length ? `cleanup-warnings: ${job.cleanupWarnings.join(" | ")}` : undefined,
    terminalEvent ? `terminal-event: ${terminalEvent}` : undefined,
    latestEvent && !sameEvent ? `${latestEventLabel}: ${latestEvent}` : undefined,
    job.error ? `error: ${job.error}` : undefined,
    options.responsePreview ? "" : undefined,
    options.responsePreview,
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * @param {OracleJobSummaryLike} job
 * @param {{ responsePath?: string; responseAvailable?: boolean; artifactsPath?: string }} [options]
 * @returns {string}
 */
export function buildOracleWakeupNotificationContent(job, options = {}) {
  const responseLine = options.responseAvailable === false
    ? "Response file: unavailable yet"
    : `Response file: ${options.responsePath ?? job.responsePath ?? `response unavailable for ${job.id}`}`;
  const artifactsPath = options.artifactsPath ?? `artifacts unavailable for ${job.id}`;
  return [
    `Oracle job ${job.id} is ${job.status}.`,
    `Use /oracle-read ${job.id} to inspect the saved response preview. /oracle-status ${job.id} still shows saved job metadata. Agent callers can use oracle_read({ jobId: "${job.id}" }) if they need tool output in the current turn.`,
    responseLine,
    `Artifacts: ${artifactsPath}`,
    formatOracleLifecycleEvent(getLatestOracleJobLifecycleEvent(job)) ? `Last event: ${formatOracleLifecycleEvent(getLatestOracleJobLifecycleEvent(job))}` : undefined,
    job.error ? `Error: ${job.error}` : "After opening the saved result, continue from the oracle output.",
  ].filter(Boolean).join("\n");
}

/**
 * @param {OracleJobSummaryLike & { promptPath: string; archivePath: string }} job
 * @param {OracleSubmitResponseOptions} options
 * @returns {string}
 */
export function formatOracleSubmitResponse(job, options) {
  return [
    `${options.queued ? "Oracle job queued" : "Oracle job dispatched"}: ${job.id}`,
    options.queued && options.queuePosition && options.queueDepth ? `Queue position: ${options.queuePosition} of ${options.queueDepth}` : undefined,
    job.followUpToJobId ? `Follow-up to: ${job.followUpToJobId}` : undefined,
    `Prompt: ${job.promptPath}`,
    `Archive: ${job.archivePath}`,
    formatAutoPrunedArchiveMessage(options.autoPrunedPrefixes),
    `Response will be written to: ${job.responsePath}`,
    formatOracleLifecycleEvent(getLatestOracleJobLifecycleEvent(job)) ? `Last event: ${formatOracleLifecycleEvent(getLatestOracleJobLifecycleEvent(job))}` : undefined,
    options.queued ? "The job will start automatically when capacity is available." : undefined,
    "Stop now and wait for the oracle completion wake-up.",
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * @param {OracleStatusCounts} counts
 * @returns {string}
 */
export function buildOracleStatusText(counts) {
  if (counts.active > 0 && counts.queued > 0) {
    return `oracle: running (${counts.active}), queued (${counts.queued})`;
  }
  if (counts.active > 0) {
    const suffix = counts.active > 1 ? ` (${counts.active})` : "";
    return `oracle: running${suffix}`;
  }
  if (counts.queued > 0) {
    const suffix = counts.queued > 1 ? ` (${counts.queued})` : "";
    return `oracle: queued${suffix}`;
  }
  return "oracle: ready";
}
