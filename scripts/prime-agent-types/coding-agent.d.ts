// Purpose: Model the Prime Agent host surface that Oracle's compatibility adapter is allowed to depend on.
// Responsibilities: Expose Prime's public getAgentDir and mode-free ExtensionContext/InputEvent shapes to a dedicated compile gate.
// Scope: Typechecking fixture only; this file is never loaded by Oracle at runtime.
// Usage: Resolved through tsconfig.prime-agent.json in place of the installed legacy pi coding-agent declarations.
// Invariants/Assumptions: Legacy-only mode, streamingBehavior, CONFIG_DIR_NAME, and project-trust exports stay intentionally absent.
export interface ExtensionUIContext {
  notify(message: string, level?: "info" | "warning" | "error" | "success"): void;
}

export interface ExtensionContext {
  ui: ExtensionUIContext;
  hasUI: boolean;
  cwd: string;
  isIdle(): boolean;
}

export interface ExtensionCommandContext extends ExtensionContext {
  waitForIdle(): Promise<void>;
}

export interface InputEvent {
  type: "input";
  text: string;
  source: "interactive" | "rpc" | "extension";
}

export function getAgentDir(): string;
