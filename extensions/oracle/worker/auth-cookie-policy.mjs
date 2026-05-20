// Purpose: Define the allowlist/drop policy for importing provider auth cookies into the isolated oracle browser profile.
// Responsibilities: Recognize required auth cookies, drop noisy/irrelevant cookies, and normalize cookie import decisions.
// Scope: Pure cookie-policy logic only; reading cookies from Chrome and writing them into the isolated profile happen elsewhere.
// Usage: Imported by auth-bootstrap and sanity tests to keep cookie import behavior deterministic and reviewable.
// Invariants/Assumptions: Security-sensitive auth cookies are allowlisted intentionally, and analytics/ambient cookies should be excluded by default.
const AUTH_COOKIE_NAME_PATTERNS = [
  /^__Secure-next-auth\.session-token(?:\.|$)/,
  /^__Secure-next-auth\.callback-url$/,
  /^_account$/,
  /^_account_is_fedramp$/,
  /^_puid$/,
  /^unified_session_manifest$/,
  /^oai-(?:client-auth-info|client-auth-session|sc|did|hlib|asli|last-model-config|chat-web-route)$/,
  /^auth-session-minimized(?:-client-checksum)?$/,
  /^(?:login_session|auth_provider|hydra_redirect|iss_context|rg_context)$/,
  /^cf_clearance$/,
  /^__(?:cf_bm|cflb)$/,
  /^_cfuvid$/,
];

const GROK_AUTH_COOKIE_NAME_PATTERNS = [
  /^sso(?:-rw)?$/,
  /^auth_token$/,
  /^ct0$/,
  /^cf_clearance$/,
  /^__(?:cf_bm|cflb)$/,
  /^_cfuvid$/,
];

const DROPPED_COOKIE_NAME_PATTERNS = [
  /^_ga(?:_|$)/,
  /^_uet/,
  /^_rdt_uuid$/,
  /^(?:marketing|analytics)_consent$/,
  /^_dd_s$/,
  /^g_state$/,
  /^country$/,
  /^oai-nav-state$/,
  /^oai-login-csrf/,
  /^__Secure-next-auth\.state$/,
  /^__Host-next-auth\.csrf-token$/,
];

const BASE_ALLOWED_COOKIE_HOSTS = new Set([
  'chatgpt.com',
  'chat.openai.com',
  'openai.com',
  'auth.openai.com',
  'sentinel.openai.com',
  'atlas.openai.com',
  'ws.chatgpt.com',
  'grok.com',
  'x.ai',
  'x.com',
]);

function normalizeSameSite(value) {
  if (value === 'Lax' || value === 'Strict' || value === 'None') return value;
  return undefined;
}

function normalizeExpiration(expires) {
  if (!expires || Number.isNaN(expires)) return undefined;
  const value = Number(expires);
  if (!Number.isFinite(value) || value <= 0) return undefined;
  if (value > 10_000_000_000_000) return Math.round(value / 1_000_000 - 11644473600);
  if (value > 10_000_000_000) return Math.round(value / 1000);
  return Math.round(value);
}

function normalizeDomain(domain, fallbackHost) {
  const raw = typeof domain === 'string' && domain.trim() ? domain.trim() : fallbackHost;
  if (!raw) return undefined;
  return raw.replace(/^\.+/, '').toLowerCase();
}

function allowedCookieHosts(chatUrl) {
  const hosts = new Set(BASE_ALLOWED_COOKIE_HOSTS);
  try {
    hosts.add(new URL(chatUrl).hostname.toLowerCase());
  } catch {
    // ignore invalid URL here; caller validation happens elsewhere
  }
  return hosts;
}

function isAllowedCookieDomain(domain, chatUrl) {
  const hosts = allowedCookieHosts(chatUrl);
  return hosts.has(domain);
}

function matchesAny(patterns, value) {
  return patterns.some((pattern) => pattern.test(value));
}

export function normalizeImportedCookie(cookie, fallbackHost) {
  if (!cookie?.name) return undefined;
  const domain = normalizeDomain(cookie.domain, fallbackHost);
  if (!domain) return undefined;
  return {
    name: cookie.name,
    value: cookie.value ?? '',
    domain,
    path: cookie.path || '/',
    expires: normalizeExpiration(cookie.expires),
    httpOnly: cookie.httpOnly ?? false,
    secure: cookie.secure ?? true,
    sameSite: normalizeSameSite(cookie.sameSite),
  };
}

export function classifyImportedCookie(cookie, chatUrl) {
  if (matchesAny(DROPPED_COOKIE_NAME_PATTERNS, cookie.name)) return 'noise';
  if (!isAllowedCookieDomain(cookie.domain, chatUrl)) return 'foreign-domain';
  if (['grok.com', 'x.ai', 'x.com'].includes(cookie.domain)) {
    return matchesAny(GROK_AUTH_COOKIE_NAME_PATTERNS, cookie.name) ? 'keep' : 'non-auth';
  }
  if (!matchesAny(AUTH_COOKIE_NAME_PATTERNS, cookie.name)) return 'non-auth';
  return 'keep';
}

export function filterImportableAuthCookies(cookies, chatUrl) {
  const fallbackHost = (() => {
    try {
      return new URL(chatUrl).hostname;
    } catch {
      return 'chatgpt.com';
    }
  })();

  const merged = new Map();
  const dropped = [];
  for (const cookie of cookies) {
    const normalized = normalizeImportedCookie(cookie, fallbackHost);
    if (!normalized) continue;
    const disposition = classifyImportedCookie(normalized, chatUrl);
    if (disposition !== 'keep') {
      dropped.push({ cookie: normalized, reason: disposition });
      continue;
    }
    const key = `${normalized.domain}:${normalized.name}`;
    if (!merged.has(key)) merged.set(key, normalized);
  }

  return { cookies: Array.from(merged.values()), dropped };
}

export function ensureAccountCookie(cookies, chatUrl) {
  const next = [...cookies];
  const hasAccountCookie = next.some((cookie) => cookie.name === '_account');
  if (hasAccountCookie) return { cookies: next, synthesized: false };

  const fedrampCookie = next.find((cookie) => cookie.name === '_account_is_fedramp');
  const isFedramp = /^(1|true|yes)$/i.test(String(fedrampCookie?.value || ''));
  const fallbackAccountValue = isFedramp ? 'fedramp' : 'personal';
  const domain = (() => {
    try {
      return new URL(chatUrl).hostname;
    } catch {
      return 'chatgpt.com';
    }
  })();

  next.push({
    name: '_account',
    value: fallbackAccountValue,
    domain,
    path: '/',
    secure: true,
    httpOnly: false,
    sameSite: 'Lax',
  });
  return { cookies: next, synthesized: true, value: fallbackAccountValue };
}
