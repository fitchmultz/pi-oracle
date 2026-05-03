import type { ImportedAuthCookie } from "./auth-cookie-policy.mjs";

export interface ChromiumKeychainConfig {
  account: string;
  services: string[];
  label?: string;
  service?: string;
}

export interface ConfiguredChromiumSourceOptions {
  dbPath: string;
  keychain: ChromiumKeychainConfig;
  origins: string[];
  profile: string;
  timeoutMs?: number;
  includeExpired?: boolean;
}

export function getCookiesFromConfiguredChromiumSource(
  options: ConfiguredChromiumSourceOptions,
): Promise<{ cookies: ImportedAuthCookie[]; warnings: string[] }>;
