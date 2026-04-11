export type OracleUiModelFamily = "instant" | "thinking" | "pro";
export type OracleUiEffort = "light" | "standard" | "extended" | "heavy";

export interface OracleUiSelection {
  modelFamily: OracleUiModelFamily;
  effort?: OracleUiEffort;
  autoSwitchToThinking?: boolean;
}

export declare const CHATGPT_CANONICAL_APP_ORIGINS: readonly string[];

export declare function buildAllowedChatGptOrigins(chatUrl: string, authUrl?: string): string[];
export declare function matchesModelFamilyLabel(label: string | undefined, family: OracleUiModelFamily): boolean;
export declare function requestedEffortLabel(selection: OracleUiSelection): string | undefined;
export declare function effortSelectionVisible(snapshot: string, effortLabel: string | undefined): boolean;
export declare function thinkingChipVisible(snapshot: string): boolean;
export declare function snapshotHasModelConfigurationUi(snapshot: string): boolean;
export declare function autoSwitchToThinkingSelectionVisible(snapshot: string): boolean | undefined;
export declare function snapshotCanSafelySkipModelConfiguration(snapshot: string, selection: OracleUiSelection): boolean;
export declare function snapshotStronglyMatchesRequestedModel(snapshot: string, selection: OracleUiSelection): boolean;
export declare function snapshotWeaklyMatchesRequestedModel(snapshot: string, selection: OracleUiSelection): boolean;
export declare function buildAssistantCompletionSignature(args: {
  responseText: string;
  artifactLabels?: string[];
  suspiciousArtifactLabels?: string[];
}): string | undefined;
export declare function deriveAssistantCompletionSignature(args: {
  hasStopStreaming: boolean;
  hasTargetCopyResponse: boolean;
  responseText: string;
  artifactLabels?: string[];
  suspiciousArtifactLabels?: string[];
}): string | undefined;
