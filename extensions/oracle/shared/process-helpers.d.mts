export interface OracleTrackedProcessOptions {
  termGraceMs?: number;
  killGraceMs?: number;
}

export interface OracleDetachedProcessHandle {
  pid: number | undefined;
  startedAt?: string;
}

export declare function readProcessStartedAt(pid: number | undefined): string | undefined;
export declare function isProcessAlive(pid: number | undefined): boolean;
export declare function isTrackedProcessAlive(pid: number | undefined, startedAt?: string): boolean;
export declare function waitForProcessStartedAt(pid: number | undefined, timeoutMs?: number): Promise<string | undefined>;
export declare function terminateTrackedProcess(
  pid: number | undefined,
  startedAt?: string,
  options?: OracleTrackedProcessOptions,
): Promise<boolean>;
export declare function spawnDetachedNodeProcess(scriptPath: string, args?: string[]): Promise<OracleDetachedProcessHandle>;
