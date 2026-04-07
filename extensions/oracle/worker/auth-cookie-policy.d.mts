export interface ImportedAuthCookie {
  name: string;
  value?: string;
  domain?: string;
  path?: string;
  expires?: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: "Lax" | "Strict" | "None";
}

export interface NormalizedAuthCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires?: number;
  httpOnly: boolean;
  secure: boolean;
  sameSite?: "Lax" | "Strict" | "None";
}

export function filterImportableAuthCookies(
  cookies: ImportedAuthCookie[],
  chatUrl: string,
): { cookies: NormalizedAuthCookie[]; dropped: Array<{ cookie: NormalizedAuthCookie; reason: string }> };

export function ensureAccountCookie(
  cookies: NormalizedAuthCookie[],
  chatUrl: string,
): { cookies: NormalizedAuthCookie[]; synthesized: boolean; value?: string };
