export interface OracleDurableWorkerHandoffJobLike {
  status?: string;
  workerPid?: number;
}

export interface OracleAdmissionBlockingJobLike extends OracleDurableWorkerHandoffJobLike {
  cleanupPending?: boolean;
  workerStartedAt?: string;
}

export interface OracleRuntimeLeaseMetadataLike {
  jobId: string;
  runtimeId: string;
  runtimeSessionName: string;
  runtimeProfileDir: string;
  projectId: string;
  sessionId: string;
  createdAt: string;
}

export interface OracleConversationLeaseMetadataLike {
  jobId: string;
  conversationId: string;
  projectId: string;
  sessionId: string;
  createdAt: string;
}

export interface OracleQueuedPromotionFailureContext<TJob, TWorker> {
  job: TJob;
  latest?: TJob;
  error: unknown;
  at: string;
  spawnedWorker?: TWorker;
  runtimeLeaseAcquired: boolean;
  conversationLeaseAcquired: boolean;
}

export type OracleQueuedPromotionFailureOutcome = void | "break";

export interface OracleQueuedPromotionOptions<TJob extends { id: string; archivePath: string }, TWorker> {
  listQueuedJobs: () => TJob[];
  refreshJob: (jobId: string) => TJob | undefined;
  readLatestJob: (jobId: string) => TJob | undefined;
  isQueuedJob?: (job: TJob | undefined) => boolean;
  acquireRuntimeLease: (job: TJob, at: string) => Promise<boolean>;
  acquireConversationLease: (job: TJob, at: string) => Promise<boolean>;
  releaseRuntimeLease: (job: TJob) => Promise<void>;
  markSubmitted: (job: TJob, at: string) => Promise<void>;
  spawnWorker: (job: TJob) => Promise<TWorker>;
  persistWorker: (job: TJob, worker: TWorker) => Promise<void>;
  hasDurableWorkerHandoff?: (job: TJob | undefined) => boolean;
  isTerminalJob: (job: TJob) => boolean;
  failQueuedPromotion: (job: TJob, message: string, at: string) => Promise<void>;
  terminateSpawnedWorker: (worker: TWorker) => Promise<void>;
  cleanupAfterFailure: (context: OracleQueuedPromotionFailureContext<TJob, TWorker>) => Promise<OracleQueuedPromotionFailureOutcome>;
  onDurableHandoff?: (job: TJob, latest?: TJob) => Promise<void> | void;
}

export declare function isQueuedOracleJob(job: OracleDurableWorkerHandoffJobLike | undefined): boolean;
export declare function compareQueuedOracleJobs(
  left: { createdAt: string; queuedAt?: string; id: string },
  right: { createdAt: string; queuedAt?: string; id: string },
): number;
export declare function hasDurableWorkerHandoff(job: OracleDurableWorkerHandoffJobLike | undefined): boolean;
export declare function hasAdmissionBlockingWorker(
  job: OracleAdmissionBlockingJobLike | undefined,
  isTrackedProcessAliveFn?: (pid: number | undefined, startedAt?: string) => boolean,
): boolean;
export declare function jobBlocksAdmission(
  job: OracleAdmissionBlockingJobLike | undefined,
  isTrackedProcessAliveFn?: (pid: number | undefined, startedAt?: string) => boolean,
): boolean;
export declare function buildRuntimeLeaseMetadata(
  job: { id: string; runtimeId: string; runtimeSessionName: string; runtimeProfileDir: string; projectId: string; sessionId: string },
  createdAt: string,
): OracleRuntimeLeaseMetadataLike;
export declare function buildConversationLeaseMetadata(
  job: { id: string; conversationId?: string; projectId: string; sessionId: string },
  createdAt: string,
): OracleConversationLeaseMetadataLike | undefined;
export declare function runQueuedJobPromotionPass<TJob extends { id: string; archivePath: string }, TWorker>(
  options: OracleQueuedPromotionOptions<TJob, TWorker>,
): Promise<{ promotedJobIds: string[] }>;
