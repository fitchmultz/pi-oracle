// Purpose: Isolate pi/Prime Agent host API differences behind one stable oracle-facing adapter.
// Responsibilities: Resolve host config paths, bridge legacy project-trust APIs, and normalize mode/input behavior.
// Scope: Coding-agent host compatibility only; oracle job, browser, and persistence behavior stays in sibling modules.
// Usage: Imported by config, commands, runtime, and the extension entrypoint instead of reaching into host-specific APIs.
// Invariants/Assumptions: Both hosts export getAgentDir and the shared extension contracts; legacy-only exports are optional.
import { join, normalize, sep } from "node:path";
import * as CodingAgentHost from "@earendil-works/pi-coding-agent";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

type LegacyHostMode = "tui" | "rpc" | "print" | "json";
type LegacyModeContext = ExtensionContext & { mode?: LegacyHostMode };

type ProjectTrustStoreLike = {
  get(cwd: string): boolean | null;
};

type OptionalCodingAgentExports = {
  CONFIG_DIR_NAME?: string;
  hasTrustRequiringProjectResources?: (cwd: string) => boolean;
  ProjectTrustStore?: new (agentDir: string) => ProjectTrustStoreLike;
};

const optionalHost = CodingAgentHost as typeof CodingAgentHost & OptionalCodingAgentExports;
const PRIME_CONFIG_DIR = join(".prime", "agent");
const PI_CONFIG_DIR = ".pi";
const LEGACY_HOST_MODES = new Set<LegacyHostMode>(["tui", "rpc", "print", "json"]);

function hasPathSuffix(path: string, suffix: string): boolean {
  const normalizedPath = normalize(path);
  const normalizedSuffix = normalize(suffix);
  return normalizedPath === normalizedSuffix || normalizedPath.endsWith(`${sep}${normalizedSuffix}`);
}

function getLegacyHostMode(ctx: ExtensionContext): LegacyHostMode | undefined {
  const mode = (ctx as LegacyModeContext).mode;
  return mode && LEGACY_HOST_MODES.has(mode) ? mode : undefined;
}

function getLegacyStreamingBehavior(event: unknown): "steer" | "followUp" | undefined {
  if (!event || typeof event !== "object" || !("streamingBehavior" in event)) return undefined;
  const streamingBehavior = (event as { streamingBehavior?: unknown }).streamingBehavior;
  return streamingBehavior === "steer" || streamingBehavior === "followUp" ? streamingBehavior : undefined;
}

export function getOracleAgentDir(): string {
  return CodingAgentHost.getAgentDir();
}

export function getOracleProjectConfigDirName(agentDir = getOracleAgentDir()): string {
  const exportedConfigDir = optionalHost.CONFIG_DIR_NAME?.trim();
  if (exportedConfigDir) return exportedConfigDir;

  if (process.env.PRIME_AGENT_CODING_AGENT_DIR?.trim() || hasPathSuffix(agentDir, PRIME_CONFIG_DIR)) {
    return PRIME_CONFIG_DIR;
  }
  if (process.env.PI_CODING_AGENT_DIR?.trim() || hasPathSuffix(agentDir, join(PI_CONFIG_DIR, "agent"))) {
    return PI_CONFIG_DIR;
  }

  // Prime Agent is the supported host that intentionally omits CONFIG_DIR_NAME
  // from its public package root. Preserve its project-resource convention when
  // a custom agent directory obscures the default ~/.prime/agent suffix.
  return PRIME_CONFIG_DIR;
}

export function getOracleHostDisplayName(agentDir = getOracleAgentDir()): "pi" | "Prime Agent" {
  return getOracleProjectConfigDirName(agentDir) === PRIME_CONFIG_DIR ? "Prime Agent" : "pi";
}

export function shouldRunOraclePoller(ctx: ExtensionContext): boolean {
  const mode = getLegacyHostMode(ctx);
  return mode !== "print" && mode !== "json";
}

export function shouldExposeOraclePromptPaths(ctx: ExtensionContext): boolean {
  const mode = getLegacyHostMode(ctx);
  // Prime Agent loads prompts from the package manifest. Legacy pi needs this
  // explicit path only for non-TUI invocation modes.
  return mode !== undefined && mode !== "tui";
}

export function isOracleInteractiveContext(ctx: ExtensionContext): boolean {
  const mode = getLegacyHostMode(ctx);
  return mode === undefined ? ctx.hasUI : mode === "tui";
}

export function isOraclePrintContext(ctx: ExtensionContext): boolean {
  return getLegacyHostMode(ctx) === "print";
}

export function getOracleInputDelivery(
  event: unknown,
  ctx: ExtensionContext,
): { deliverAs: "steer" | "followUp" } | undefined {
  const streamingBehavior = getLegacyStreamingBehavior(event);
  if (streamingBehavior) return { deliverAs: streamingBehavior };
  if (getLegacyHostMode(ctx) !== undefined) return undefined;
  return ctx.isIdle() ? undefined : { deliverAs: "followUp" };
}

export function resolveOracleSavedProjectTrust(args: {
  cwd: string;
  trustCwd: string;
  agentDir: string;
  projectConfigExists: boolean;
}): boolean {
  const hasTrustRequiringProjectResources = optionalHost.hasTrustRequiringProjectResources;
  const ProjectTrustStore = optionalHost.ProjectTrustStore;

  // Prime Agent treats explicitly loaded repository resources as trusted input
  // and does not expose pi's saved project-trust store through its extension API.
  if (!hasTrustRequiringProjectResources || !ProjectTrustStore) return true;
  if (!args.projectConfigExists && !hasTrustRequiringProjectResources(args.trustCwd)) return true;

  try {
    const trustStore = new ProjectTrustStore(args.agentDir);
    const trustDecision = trustStore.get(args.trustCwd);
    const rootDecision = args.trustCwd !== args.cwd ? trustStore.get(args.cwd) : null;
    if (trustDecision !== null) return trustDecision;
    if (rootDecision !== null) return rootDecision;
  } catch {
    return false;
  }
  return true;
}
