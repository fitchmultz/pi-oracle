// Purpose: Centralize oracle job lifecycle state transitions, invariants, and durable transition breadcrumbs.
// Responsibilities: Define valid phase/status relationships, apply lifecycle mutations, append bounded lifecycle events, and normalize cleanup/notification/wake-up state changes.
// Scope: Pure job-state reducers only; persistence, locking, browser work, and UI delivery stay in higher-level modules.
// Usage: Imported by extension lib code and worker code so all lifecycle transitions share the same invariants and event semantics.
// Invariants/Assumptions: Phase/status pairs must stay aligned, terminal jobs own completedAt, and cleanupPending is only legal for terminal states.

/** @typedef {import("./job-lifecycle-helpers.d.mts").OracleJobLifecycleEvent} OracleJobLifecycleEvent */
/** @typedef {import("./job-lifecycle-helpers.d.mts").OracleJobPhase} OracleJobPhase */
/** @typedef {import("./job-lifecycle-helpers.d.mts").OracleJobStatus} OracleJobStatus */
/** @typedef {import("./job-lifecycle-helpers.d.mts").OracleLifecycleTrackedJobLike} OracleLifecycleTrackedJobLike */

export const ACTIVE_ORACLE_JOB_STATUSES = Object.freeze(["preparing", "submitted", "waiting"]);
export const OPEN_ORACLE_JOB_STATUSES = Object.freeze(["queued", ...ACTIVE_ORACLE_JOB_STATUSES]);
export const TERMINAL_ORACLE_JOB_STATUSES = Object.freeze(["complete", "failed", "cancelled"]);
export const MAX_ORACLE_JOB_LIFECYCLE_EVENTS = 64;

/** @type {Record<OracleJobPhase, OracleJobStatus>} */
const PHASE_STATUS = Object.freeze({
  queued: "queued",
  submitted: "submitted",
  cloning_runtime: "waiting",
  launching_browser: "waiting",
  verifying_auth: "waiting",
  configuring_model: "waiting",
  uploading_archive: "waiting",
  awaiting_response: "waiting",
  extracting_response: "waiting",
  downloading_artifacts: "waiting",
  complete: "complete",
  complete_with_artifact_errors: "complete",
  failed: "failed",
  cancelled: "cancelled",
});

/**
 * @param {OracleJobPhase} phase
 * @returns {OracleJobStatus}
 */
export function getOracleJobStatusForPhase(phase) {
  return PHASE_STATUS[phase];
}

/**
 * @template {OracleLifecycleTrackedJobLike} TJob
 * @param {TJob} job
 * @returns {TJob}
 */
export function assertValidOracleJobState(job) {
  const expectedStatus = PHASE_STATUS[job.phase];
  if (!expectedStatus) {
    throw new Error(`Invalid oracle job state: unknown phase ${String(job.phase)}`);
  }
  if (job.status !== expectedStatus) {
    throw new Error(`Invalid oracle job state: phase ${job.phase} requires status ${expectedStatus}, got ${job.status}`);
  }
  if (job.status === "queued" && !job.queuedAt) {
    throw new Error("Invalid oracle job state: queued jobs must record queuedAt");
  }
  if (["submitted", "waiting"].includes(job.status) && !job.submittedAt) {
    throw new Error(`Invalid oracle job state: ${job.status} jobs must record submittedAt`);
  }
  if (TERMINAL_ORACLE_JOB_STATUSES.includes(job.status) && !job.completedAt) {
    throw new Error(`Invalid oracle job state: terminal job ${job.status} must record completedAt`);
  }
  if (job.completedAt && !TERMINAL_ORACLE_JOB_STATUSES.includes(job.status)) {
    throw new Error(`Invalid oracle job state: non-terminal job ${job.status} cannot record completedAt`);
  }
  if (job.cleanupPending && !TERMINAL_ORACLE_JOB_STATUSES.includes(job.status)) {
    throw new Error(`Invalid oracle job state: non-terminal job ${job.status} cannot be cleanupPending`);
  }
  return job;
}

/**
 * @param {Pick<OracleLifecycleTrackedJobLike, "phase" | "status" | "lifecycleEvents">} job
 * @param {Omit<OracleJobLifecycleEvent, "status" | "phase"> & { status?: OracleJobStatus; phase?: OracleJobPhase }} event
 * @returns {OracleJobLifecycleEvent[]}
 */
function nextLifecycleEvents(job, event) {
  const entry = {
    at: event.at,
    source: event.source,
    kind: event.kind,
    message: event.message,
    status: event.status ?? job.status,
    phase: event.phase ?? job.phase,
  };
  const events = [...(job.lifecycleEvents || []), entry];
  return events.slice(-MAX_ORACLE_JOB_LIFECYCLE_EVENTS);
}

/**
 * @template {OracleLifecycleTrackedJobLike} TJob
 * @param {TJob} job
 * @param {Omit<OracleJobLifecycleEvent, "status" | "phase"> & { status?: OracleJobStatus; phase?: OracleJobPhase }} event
 * @returns {TJob}
 */
export function appendOracleJobLifecycleEvent(job, event) {
  return assertValidOracleJobState({
    ...job,
    lifecycleEvents: nextLifecycleEvents(job, event),
  });
}

/**
 * @param {Pick<OracleLifecycleTrackedJobLike, "lifecycleEvents">} job
 * @returns {OracleJobLifecycleEvent | undefined}
 */
export function getLatestOracleJobLifecycleEvent(job) {
  const events = job.lifecycleEvents || [];
  return events.length > 0 ? events[events.length - 1] : undefined;
}

/**
 * @param {Pick<OracleLifecycleTrackedJobLike, "lifecycleEvents">} job
 * @returns {OracleJobLifecycleEvent | undefined}
 */
export function getLatestOracleTerminalLifecycleEvent(job) {
  const events = job.lifecycleEvents || [];
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.kind === "phase" && TERMINAL_ORACLE_JOB_STATUSES.includes(event.status)) return event;
  }
  return undefined;
}

/**
 * @template {OracleLifecycleTrackedJobLike} TJob
 * @param {TJob} job
 * @param {{ at?: string; source?: string; message?: string }} [options]
 * @returns {TJob}
 */
export function markOracleJobCreated(job, options = {}) {
  const at = options.at ?? job.createdAt;
  return appendOracleJobLifecycleEvent(assertValidOracleJobState(job), {
    at,
    source: options.source ?? "oracle:create",
    kind: "created",
    message: options.message ?? `Job created in ${job.status} state.`,
  });
}

/**
 * @template {OracleLifecycleTrackedJobLike} TJob
 * @param {TJob} job
 * @param {OracleJobPhase} phase
 * @param {{ at?: string; source?: string; message?: string; patch?: Partial<TJob>; clearNotificationClaim?: boolean }} [options]
 * @returns {TJob}
 */
export function transitionOracleJobPhase(job, phase, options = {}) {
  const at = options.at ?? new Date().toISOString();
  const patch = options.patch || {};
  const status = patch.status ?? getOracleJobStatusForPhase(phase);
  if (status !== getOracleJobStatusForPhase(phase)) {
    throw new Error(`Invalid oracle job transition: phase ${phase} requires status ${getOracleJobStatusForPhase(phase)}, got ${String(status)}`);
  }

  /** @type {TJob} */
  const next = {
    ...job,
    ...patch,
    status,
    phase,
    phaseAt: at,
    ...(phase === "queued" ? { queuedAt: patch.queuedAt ?? job.queuedAt ?? at } : {}),
    ...(["submitted", "waiting"].includes(status) || patch.submittedAt !== undefined || job.submittedAt !== undefined
      ? { submittedAt: patch.submittedAt ?? job.submittedAt ?? at }
      : {}),
    ...(TERMINAL_ORACLE_JOB_STATUSES.includes(status)
      ? {
        completedAt: patch.completedAt ?? job.completedAt ?? at,
        cancelRequestedAt: undefined,
        cancelReason: undefined,
      }
      : { completedAt: patch.completedAt ?? job.completedAt }),
    ...(options.clearNotificationClaim
      ? { notifyClaimedAt: undefined, notifyClaimedBy: undefined }
      : {}),
  };

  const validated = assertValidOracleJobState(next);
  const changed = job.phase !== validated.phase || job.status !== validated.status || Boolean(options.message);
  if (!changed) return validated;

  return appendOracleJobLifecycleEvent(validated, {
    at,
    source: options.source ?? "oracle:lifecycle",
    kind: "phase",
    message: options.message ?? `Transitioned to ${validated.phase} (${validated.status}).`,
  });
}

/**
 * @template {OracleLifecycleTrackedJobLike} TJob
 * @param {TJob} job
 * @param {string[]} warnings
 * @param {{ at?: string; source?: string; message?: string }} [options]
 * @returns {TJob}
 */
export function applyOracleJobCleanupWarnings(job, warnings, options = {}) {
  if (warnings.length === 0) return assertValidOracleJobState(job);
  const at = options.at ?? new Date().toISOString();
  const next = assertValidOracleJobState({
    ...job,
    cleanupPending: false,
    cleanupWarnings: Array.from(new Set([...(job.cleanupWarnings || []), ...warnings])),
    lastCleanupAt: at,
    error: [job.error, ...warnings].filter(Boolean).join("\n"),
  });
  return appendOracleJobLifecycleEvent(next, {
    at,
    source: options.source ?? "oracle:cleanup",
    kind: "cleanup",
    message: options.message ?? `Cleanup completed with ${warnings.length} warning(s).`,
  });
}

/**
 * @template {OracleLifecycleTrackedJobLike} TJob
 * @param {TJob} job
 * @param {{ at?: string; source?: string; message?: string }} [options]
 * @returns {TJob}
 */
export function clearOracleJobCleanupState(job, options = {}) {
  const at = options.at ?? new Date().toISOString();
  const next = assertValidOracleJobState({
    ...job,
    cleanupPending: false,
    cleanupWarnings: undefined,
    lastCleanupAt: at,
  });
  return appendOracleJobLifecycleEvent(next, {
    at,
    source: options.source ?? "oracle:cleanup",
    kind: "cleanup",
    message: options.message ?? "Cleanup finished without warnings.",
  });
}

/**
 * @template {OracleLifecycleTrackedJobLike} TJob
 * @param {TJob} job
 * @param {string} claimedBy
 * @param {string} [at]
 * @returns {TJob}
 */
export function claimOracleJobNotification(job, claimedBy, at = new Date().toISOString()) {
  return assertValidOracleJobState({
    ...job,
    notifyClaimedBy: claimedBy,
    notifyClaimedAt: at,
  });
}

/**
 * @template {OracleLifecycleTrackedJobLike} TJob
 * @param {TJob} job
 * @param {{ at?: string; source?: string; notificationSessionKey: string; notificationSessionFile?: string }} options
 * @returns {TJob}
 */
export function recordOracleJobNotificationTarget(job, options) {
  const at = options.at ?? new Date().toISOString();
  const next = assertValidOracleJobState({
    ...job,
    notificationSessionKey: options.notificationSessionKey,
    notificationSessionFile: options.notificationSessionFile,
  });
  return appendOracleJobLifecycleEvent(next, {
    at,
    source: options.source ?? "oracle:poller",
    kind: "notification",
    message: `Notification target recorded for ${options.notificationSessionKey}.`,
  });
}

/**
 * @template {OracleLifecycleTrackedJobLike} TJob
 * @param {TJob} job
 * @param {{ at?: string; source?: string; notificationEntryId?: string; notificationSessionKey?: string; notificationSessionFile?: string }} [options]
 * @returns {TJob}
 */
export function markOracleJobNotified(job, options = {}) {
  const at = options.at ?? new Date().toISOString();
  const next = assertValidOracleJobState({
    ...job,
    notifiedAt: at,
    notificationEntryId: options.notificationEntryId ?? job.notificationEntryId,
    notificationSessionKey: options.notificationSessionKey ?? job.notificationSessionKey,
    notificationSessionFile: options.notificationSessionFile ?? job.notificationSessionFile,
    wakeupAttemptCount: 0,
    wakeupLastRequestedAt: undefined,
    wakeupSettledAt: undefined,
    notifyClaimedAt: undefined,
    notifyClaimedBy: undefined,
  });
  return appendOracleJobLifecycleEvent(next, {
    at,
    source: options.source ?? "oracle:poller",
    kind: "notification",
    message: "Notification delivery recorded.",
  });
}

/**
 * @template {OracleLifecycleTrackedJobLike} TJob
 * @param {TJob} job
 * @returns {TJob}
 */
export function releaseOracleJobNotificationClaim(job) {
  return assertValidOracleJobState({
    ...job,
    notifyClaimedAt: undefined,
    notifyClaimedBy: undefined,
  });
}

/**
 * @template {OracleLifecycleTrackedJobLike} TJob
 * @param {TJob} job
 * @param {{ at?: string; source?: string }} [options]
 * @returns {TJob}
 */
export function noteOracleJobWakeupRequested(job, options = {}) {
  const at = options.at ?? new Date().toISOString();
  const next = assertValidOracleJobState({
    ...job,
    wakeupAttemptCount: (job.wakeupAttemptCount ?? 0) + 1,
    wakeupLastRequestedAt: at,
  });
  return appendOracleJobLifecycleEvent(next, {
    at,
    source: options.source ?? "oracle:poller",
    kind: "wakeup",
    message: `Wake-up reminder requested (attempt ${next.wakeupAttemptCount}).`,
  });
}

/**
 * @template {OracleLifecycleTrackedJobLike} TJob
 * @param {TJob} job
 * @param {{ source: string; at?: string; sessionFile?: string; sessionKey?: string; allowBeforeFirstAttempt?: boolean }} options
 * @returns {TJob}
 */
export function markOracleJobWakeupSettled(job, options) {
  const at = options.at ?? new Date().toISOString();
  const beforeFirstAttempt = !job.wakeupLastRequestedAt && (job.wakeupAttemptCount ?? 0) === 0;

  if (job.wakeupSettledAt) {
    const next = assertValidOracleJobState({
      ...job,
      wakeupSettledSource: job.wakeupSettledSource ?? options.source,
      wakeupSettledSessionFile: job.wakeupSettledSessionFile ?? options.sessionFile,
      wakeupSettledSessionKey: job.wakeupSettledSessionKey ?? options.sessionKey,
      wakeupSettledBeforeFirstAttempt: job.wakeupSettledBeforeFirstAttempt ?? beforeFirstAttempt,
    });
    return appendOracleJobLifecycleEvent(next, {
      at,
      source: options.source,
      kind: "wakeup",
      message: `Wake-up already settled via ${next.wakeupSettledSource ?? options.source}.`,
    });
  }

  if (beforeFirstAttempt && !options.allowBeforeFirstAttempt) {
    const observed = assertValidOracleJobState({
      ...job,
      wakeupObservedAt: job.wakeupObservedAt ?? at,
      wakeupObservedSource: job.wakeupObservedSource ?? options.source,
      wakeupObservedSessionFile: job.wakeupObservedSessionFile ?? options.sessionFile,
      wakeupObservedSessionKey: job.wakeupObservedSessionKey ?? options.sessionKey,
    });
    return appendOracleJobLifecycleEvent(observed, {
      at,
      source: options.source,
      kind: "wakeup",
      message: `Wake-up observed before the first reminder attempt via ${options.source}.`,
    });
  }

  const settled = assertValidOracleJobState({
    ...job,
    wakeupSettledAt: at,
    wakeupSettledSource: options.source,
    wakeupSettledSessionFile: options.sessionFile,
    wakeupSettledSessionKey: options.sessionKey,
    wakeupSettledBeforeFirstAttempt: beforeFirstAttempt,
  });
  return appendOracleJobLifecycleEvent(settled, {
    at,
    source: options.source,
    kind: "wakeup",
    message: `Wake-up settled via ${options.source}.`,
  });
}
