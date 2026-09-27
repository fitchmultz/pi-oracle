export interface OracleAuthLoginProbe {
  ok: boolean;
  status: number;
  pageUrl?: string;
  domLoginCta?: boolean;
  onAuthPage?: boolean;
  error?: string;
  bodyKeys?: string[];
  bodyHasId?: boolean;
  bodyHasEmail?: boolean;
  bodyIsAnonymous?: boolean;
  name?: string;
  responsePreview?: string;
}

export type OracleAuthPageState =
  | "challenge_blocking"
  | "login_required"
  | "transient_outage_error"
  | "auth_transitioning"
  | "authenticated_and_ready"
  | "unknown";

export interface OracleAuthPageClassification {
  state: OracleAuthPageState;
  message: string;
}

export declare function normalizeLoginProbeResult(result: unknown): OracleAuthLoginProbe;
export declare function isAuthNavigationError(error: unknown): boolean;
export declare function buildAccountChooserCandidateLabels(name?: string): string[];
export declare function classifyChatAuthPage(args: {
  url: string;
  snapshot: string;
  body: string;
  probe?: OracleAuthLoginProbe;
  allowedOrigins: readonly string[];
  cookieSourceLabel: string;
  runtimeProfileDir: string;
  logPath: string;
  composerLabel?: string;
  addFilesLabel?: string;
}): OracleAuthPageClassification;
