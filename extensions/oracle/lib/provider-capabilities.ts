// Purpose: Centralize provider-specific archive capabilities for oracle submissions.
// Responsibilities: Map each supported provider to archive format, file extension, upload ceiling, and local compression dependencies.
// Scope: Static provider capability data only; config loading, archive writing, and runtime preflight live in sibling modules.
// Usage: Imported by config, jobs, tools, runtime, and archive code so provider policy stays in one canonical place.
// Invariants/Assumptions: Provider ids are defined by config.ts, while this module must not import config values to avoid runtime/config cycles.
import type { OracleProvider } from "./config.js";

export type OracleArchiveFormat = "tar.zst" | "tar.gz";

export interface OracleProviderArchivePlan {
  provider: OracleProvider;
  archiveFormat: OracleArchiveFormat;
  archiveExtension: OracleArchiveFormat;
  maxArchiveBytes: number;
  requiresZstd: boolean;
}

const ORACLE_PROVIDER_ARCHIVE_PLANS: Record<OracleProvider, OracleProviderArchivePlan> = {
  chatgpt: {
    provider: "chatgpt",
    archiveFormat: "tar.zst",
    archiveExtension: "tar.zst",
    maxArchiveBytes: 250 * 1024 * 1024,
    requiresZstd: true,
  },
  grok: {
    provider: "grok",
    archiveFormat: "tar.gz",
    archiveExtension: "tar.gz",
    maxArchiveBytes: 200 * 1024 * 1024,
    requiresZstd: false,
  },
};

export function resolveOracleProviderArchivePlan(provider: OracleProvider): OracleProviderArchivePlan {
  return ORACLE_PROVIDER_ARCHIVE_PLANS[provider];
}

export function resolveOracleArchiveFormat(provider: OracleProvider): OracleArchiveFormat {
  return resolveOracleProviderArchivePlan(provider).archiveFormat;
}
