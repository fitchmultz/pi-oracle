export type OracleRunOperation = "preflight" | "submit" | "read";
export type OracleRunInvocation = {
  operation: OracleRunOperation;
  requestPath: string;
  resultPath: string;
  markerPath?: string;
};
export type OracleRunSummary = {
  operation: OracleRunOperation;
  ok: boolean;
  jobId?: string;
  status?: string;
  ready?: boolean;
  error?: string;
};
export declare const ORACLE_RUN_OPERATIONS: readonly OracleRunOperation[];
export declare const ORACLE_RUN_USAGE: string;
export declare function parseOracleRunArgs(args: string): OracleRunInvocation;
export declare function summarizeOracleRunResult(operation: OracleRunOperation, result: unknown): OracleRunSummary;
