import type { OracleJobLifecycleEvent } from "./job-lifecycle-helpers.d.mts";

export interface OracleJobSummaryLike {
  id: string;
  status: string;
  phase: string;
  createdAt: string;
  queuedAt?: string;
  submittedAt?: string;
  completedAt?: string;
  projectId: string;
  sessionId: string;
  followUpToJobId?: string;
  chatUrl?: string;
  conversationId?: string;
  responsePath?: string;
  responseFormat?: string;
  artifactFailureCount?: number;
  lastCleanupAt?: string;
  cleanupWarnings?: string[];
  error?: string;
  workerLogPath?: string;
  lifecycleEvents?: OracleJobLifecycleEvent[];
}

export interface OracleQueuePositionLike {
  position: number;
  depth: number;
}

export interface OracleJobSummaryOptions {
  queuePosition?: OracleQueuePositionLike;
  artifactsPath?: string;
  responsePreview?: string;
  responseAvailable?: boolean;
  includeLatestEvent?: boolean;
  includeWorkerLogPath?: boolean;
}

export interface OracleSubmitResponseOptions {
  autoPrunedPrefixes: Array<{ relativePath: string; bytes: number }>;
  queued: boolean;
  queuePosition?: number;
  queueDepth?: number;
}

export interface OracleStatusCounts {
  active: number;
  queued: number;
}

export declare function formatBytes(bytes: number): string;
export declare function formatOracleLifecycleEvent(event: OracleJobLifecycleEvent | undefined): string | undefined;
export declare function formatOracleJobSummary(job: OracleJobSummaryLike, options?: OracleJobSummaryOptions): string;
export declare function buildOracleWakeupNotificationContent(
  job: OracleJobSummaryLike,
  options?: { responsePath?: string; responseAvailable?: boolean; artifactsPath?: string },
): string;
export declare function formatOracleSubmitResponse(job: OracleJobSummaryLike & { promptPath: string; archivePath: string }, options: OracleSubmitResponseOptions): string;
export declare function buildOracleStatusText(counts: OracleStatusCounts): string;
