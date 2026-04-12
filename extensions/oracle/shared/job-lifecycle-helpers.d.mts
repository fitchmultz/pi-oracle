export type OracleJobStatus = "queued" | "preparing" | "submitted" | "waiting" | "complete" | "failed" | "cancelled";

export type OracleJobPhase =
  | "queued"
  | "submitted"
  | "cloning_runtime"
  | "launching_browser"
  | "verifying_auth"
  | "configuring_model"
  | "uploading_archive"
  | "awaiting_response"
  | "extracting_response"
  | "downloading_artifacts"
  | "complete"
  | "complete_with_artifact_errors"
  | "failed"
  | "cancelled";

export interface OracleJobLifecycleEvent {
  at: string;
  source: string;
  kind: "created" | "phase" | "cleanup" | "notification" | "wakeup";
  status: OracleJobStatus;
  phase: OracleJobPhase;
  message: string;
}

export interface OracleLifecycleTrackedJobLike {
  status: OracleJobStatus;
  phase: OracleJobPhase;
  phaseAt: string;
  createdAt: string;
  queuedAt?: string;
  submittedAt?: string;
  completedAt?: string;
  heartbeatAt?: string;
  lifecycleEvents?: OracleJobLifecycleEvent[];
  cleanupPending?: boolean;
  cleanupWarnings?: string[];
  lastCleanupAt?: string;
  notifyClaimedAt?: string;
  notifyClaimedBy?: string;
  notifiedAt?: string;
  notificationEntryId?: string;
  notificationSessionKey?: string;
  notificationSessionFile?: string;
  wakeupAttemptCount?: number;
  wakeupLastRequestedAt?: string;
  wakeupSettledAt?: string;
  wakeupSettledSource?: string;
  wakeupSettledSessionFile?: string;
  wakeupSettledSessionKey?: string;
  wakeupSettledBeforeFirstAttempt?: boolean;
  wakeupObservedAt?: string;
  wakeupObservedSource?: string;
  wakeupObservedSessionFile?: string;
  wakeupObservedSessionKey?: string;
  error?: string;
  artifactFailureCount?: number;
  responsePath?: string;
  responseFormat?: "text/plain";
}

export interface OraclePhaseTransitionOptions<TJob extends OracleLifecycleTrackedJobLike> {
  at?: string;
  source?: string;
  message?: string;
  patch?: Partial<TJob>;
  clearNotificationClaim?: boolean;
}

export interface OracleWakeupSettlementOptions {
  source: string;
  at?: string;
  sessionFile?: string;
  sessionKey?: string;
  allowBeforeFirstAttempt?: boolean;
}

export interface OracleNotificationTargetOptions {
  at?: string;
  source?: string;
  notificationSessionKey: string;
  notificationSessionFile?: string;
}

export interface OracleMarkNotifiedOptions {
  at?: string;
  source?: string;
  notificationEntryId?: string;
  notificationSessionKey?: string;
  notificationSessionFile?: string;
}

export const ACTIVE_ORACLE_JOB_STATUSES: readonly OracleJobStatus[];
export const OPEN_ORACLE_JOB_STATUSES: readonly OracleJobStatus[];
export const TERMINAL_ORACLE_JOB_STATUSES: readonly OracleJobStatus[];
export const MAX_ORACLE_JOB_LIFECYCLE_EVENTS: number;

export declare function getOracleJobStatusForPhase(phase: OracleJobPhase): OracleJobStatus;
export declare function assertValidOracleJobState<TJob extends OracleLifecycleTrackedJobLike>(job: TJob): TJob;
export declare function appendOracleJobLifecycleEvent<TJob extends OracleLifecycleTrackedJobLike>(
  job: TJob,
  event: Omit<OracleJobLifecycleEvent, "status" | "phase"> & { status?: OracleJobStatus; phase?: OracleJobPhase },
): TJob;
export declare function getLatestOracleJobLifecycleEvent(job: Pick<OracleLifecycleTrackedJobLike, "lifecycleEvents">): OracleJobLifecycleEvent | undefined;
export declare function markOracleJobCreated<TJob extends OracleLifecycleTrackedJobLike>(job: TJob, options?: { at?: string; source?: string; message?: string }): TJob;
export declare function transitionOracleJobPhase<TJob extends OracleLifecycleTrackedJobLike>(
  job: TJob,
  phase: OracleJobPhase,
  options?: OraclePhaseTransitionOptions<TJob>,
): TJob;
export declare function applyOracleJobCleanupWarnings<TJob extends OracleLifecycleTrackedJobLike>(
  job: TJob,
  warnings: string[],
  options?: { at?: string; source?: string; message?: string },
): TJob;
export declare function clearOracleJobCleanupState<TJob extends OracleLifecycleTrackedJobLike>(
  job: TJob,
  options?: { at?: string; source?: string; message?: string },
): TJob;
export declare function claimOracleJobNotification<TJob extends OracleLifecycleTrackedJobLike>(job: TJob, claimedBy: string, at?: string): TJob;
export declare function recordOracleJobNotificationTarget<TJob extends OracleLifecycleTrackedJobLike>(job: TJob, options: OracleNotificationTargetOptions): TJob;
export declare function markOracleJobNotified<TJob extends OracleLifecycleTrackedJobLike>(job: TJob, options?: OracleMarkNotifiedOptions): TJob;
export declare function releaseOracleJobNotificationClaim<TJob extends OracleLifecycleTrackedJobLike>(job: TJob): TJob;
export declare function noteOracleJobWakeupRequested<TJob extends OracleLifecycleTrackedJobLike>(job: TJob, options?: { at?: string; source?: string }): TJob;
export declare function markOracleJobWakeupSettled<TJob extends OracleLifecycleTrackedJobLike>(
  job: TJob,
  options: OracleWakeupSettlementOptions,
): TJob;
