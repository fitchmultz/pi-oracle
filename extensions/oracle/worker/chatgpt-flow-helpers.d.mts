export interface OracleStableValueState {
  lastValue: string;
  stableCount: number;
}

export interface OracleSendAcceptanceState {
  url?: string;
  urlKnown?: boolean;
  assistantCount?: number;
  stopStreaming?: boolean;
}

export declare function assistantSnapshotSlice(snapshot: string, composerLabel: string, responseIndex: number): string | undefined;
export declare function stripUrlQueryAndHash(url: string | undefined): string;
export declare function isConversationPathUrl(url: string): boolean;
export declare function conversationIdFromUrl(url: string | undefined): string | undefined;
export declare function providerSendAccepted(before: OracleSendAcceptanceState, after: OracleSendAcceptanceState): boolean;
export declare function resolveStableConversationUrlCandidate(url: string, previousChatUrl?: string): string | undefined;
export declare function nextStableValueState(
  state: Partial<OracleStableValueState> | undefined,
  nextValue: string,
): OracleStableValueState;
