// Purpose: Read provider cookies from configured macOS Chromium stores.
// Responsibilities: Snapshot and decrypt configured macOS cookie stores.
// Scope: macOS cookie extraction only; auth policy filtering and browser seeding stay in auth-bootstrap.mjs.
// Usage: auth-bootstrap.mjs calls the configured macOS API after selecting the source.
// Invariants/Assumptions: Configured Keychain items identify the browser secret; helper environments are scrubbed.
import { spawn } from "node:child_process";
import { sweetCookieSafeStoragePasswordScrubbedEnv } from "../shared/browser-profile-helpers.mjs";
import { createDecipheriv, pbkdf2Sync } from "node:crypto";
import { copyFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

/** @typedef {import("./chromium-cookie-source.d.mts").ChromiumKeychainConfig} ChromiumKeychainConfig */
/** @typedef {import("./chromium-cookie-source.d.mts").ConfiguredChromiumSourceOptions} ConfiguredChromiumSourceOptions */
/** @typedef {import("./auth-cookie-policy.mjs").ImportedAuthCookie} ImportedAuthCookie */

const CHROMIUM_EPOCH_OFFSET_SECONDS = 11_644_473_600n;
const COOKIE_VALUE_DECODER = new TextDecoder("utf-8", { fatal: true });
const MACOS_CHROMIUM_KEY_ITERATIONS = 1003;

/**
 * @param {string} command
 * @param {string[]} args
 * @param {{timeoutMs?: number}} [options]
 * @returns {Promise<{ok: boolean, stdout: string, stderr: string, error: string}>}
 */
function spawnCapture(command, args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { env: sweetCookieSafeStoragePasswordScrubbedEnv(), stdio: ["ignore", "pipe", "pipe"], shell: process.platform === "win32" });
    let stdout = "";
    let stderr = "";
    const timeoutMs = options.timeoutMs ?? 5_000;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, timeoutMs);
    timer.unref?.();

    child.stdout.on("data", (data) => { stdout += String(data); });
    child.stderr.on("data", (data) => { stderr += String(data); });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ ok: false, stdout, stderr, error: error.message });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({
        ok: code === 0 && !timedOut,
        stdout,
        stderr,
        error: timedOut ? `Timed out after ${timeoutMs}ms` : stderr.trim(),
      });
    });
  });
}

/**
 * @param {ChromiumKeychainConfig} keychain
 * @param {number} timeoutMs
 * @returns {Promise<{ok: true, password: string, service: string} | {ok: false, error: string}>}
 */
async function readKeychainPassword(keychain, timeoutMs) {
  const services = Array.isArray(keychain.services) && keychain.services.length > 0 ? keychain.services : [keychain.service];
  for (const service of services.filter(/** @returns {service is string} */ (service) => Boolean(service))) {
    const result = await spawnCapture("security", ["find-generic-password", "-w", "-a", keychain.account, "-s", service], { timeoutMs });
    if (result.ok) {
      const password = result.stdout.trim();
      if (password) return { ok: true, password, service };
      return { ok: false, error: `macOS Keychain returned an empty ${keychain.label || service} password.` };
    }
  }
  return { ok: false, error: `Failed to read macOS Keychain (${keychain.label || keychain.account}): no configured service returned a password.` };
}

/** @param {string} dbPath */
function snapshotCookieDb(dbPath) {
  const tempDir = mkdtempSync(join(tmpdir(), "pi-oracle-chromium-cookies-"));
  const tempDbPath = join(tempDir, "Cookies");
  try {
    copyFileSync(dbPath, tempDbPath);
    copySidecar(dbPath, `${tempDbPath}-wal`, "-wal");
    copySidecar(dbPath, `${tempDbPath}-shm`, "-shm");
    return { tempDir, tempDbPath };
  } catch (error) {
    rmSync(tempDir, { recursive: true, force: true });
    throw error;
  }
}

/** @param {string} sourceDbPath @param {string} targetPath @param {string} suffix */
function copySidecar(sourceDbPath, targetPath, suffix) {
  const sidecarPath = `${sourceDbPath}${suffix}`;
  try {
    copyFileSync(sidecarPath, targetPath);
  } catch (error) {
    if (isMissingFileError(error)) return;
    throw error;
  }
}

/** @param {unknown} error */
function isMissingFileError(error) {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}

/** @param {DatabaseSync} db */
function readMetaVersion(db) {
  try {
    const row = db.prepare("SELECT value FROM meta WHERE key = 'version'").get();
    const parsed = Number.parseInt(String(row?.value ?? "0"), 10);
    return Number.isFinite(parsed) ? parsed : 0;
  } catch {
    return 0;
  }
}

/** @param {string} host */
function parentCookieDomains(host) {
  const labels = host.split(".").filter(Boolean);
  const domains = new Set([host, `.${host}`]);
  for (let index = 1; index < labels.length - 1; index += 1) {
    const parent = labels.slice(index).join(".");
    domains.add(parent);
    domains.add(`.${parent}`);
  }
  return [...domains];
}

/** @param {string} value */
function sqlStringLiteral(value) {
  return `'${value.replaceAll("'", "''")}'`;
}

/** @param {string[]} origins */
function buildHostWhereClause(origins) {
  /** @type {Set<string>} */
  const domains = new Set();
  for (const origin of origins) {
    try {
      for (const domain of parentCookieDomains(new URL(origin).hostname)) domains.add(domain);
    } catch {
      // Ignore malformed origins; validated provider config supplies the real set.
    }
  }
  if (domains.size === 0) return "0";
  return `host_key IN (${[...domains].map(sqlStringLiteral).join(", ")})`;
}

/** @param {string[]} originHosts @param {string} hostKey */
function hostMatchesAny(originHosts, hostKey) {
  const cookieDomain = hostKey.startsWith(".") ? hostKey.slice(1) : hostKey;
  return originHosts.some((host) => host === cookieDomain || host.endsWith(`.${cookieDomain}`));
}

/** @param {unknown} value */
function chromiumExpirationToUnixSeconds(value) {
  if (value === undefined || value === null || String(value) === "0") return undefined;
  try {
    const raw = BigInt(String(value));
    const seconds = raw / 1_000_000n - CHROMIUM_EPOCH_OFFSET_SECONDS;
    if (seconds <= 0n) return undefined;
    return Number(seconds);
  } catch {
    return undefined;
  }
}

/** @param {unknown} value @returns {ImportedAuthCookie["sameSite"]} */
function normalizeSameSite(value) {
  const normalized = String(value ?? "").toLowerCase();
  if (normalized === "2" || normalized === "strict") return "Strict";
  if (normalized === "1" || normalized === "lax") return "Lax";
  if (normalized === "0" || normalized === "none" || normalized === "no_restriction") return "None";
  return undefined;
}

/** @param {string} password */
function deriveMacosChromiumKey(password) {
  return pbkdf2Sync(password, "saltysalt", MACOS_CHROMIUM_KEY_ITERATIONS, 16, "sha1");
}

/** @param {Uint8Array} encryptedValue @param {Buffer} key @param {{stripHashPrefix: boolean}} options */
function decryptCookieValue(encryptedValue, key, options) {
  const buffer = Buffer.from(encryptedValue);
  if (buffer.length < 3) return null;
  const prefix = buffer.subarray(0, 3).toString("utf8");
  if (!/^v\d\d$/.test(prefix)) return decodeCookieBytes(buffer, false);

  try {
    const iv = Buffer.alloc(16, 0x20);
    const decipher = createDecipheriv("aes-128-cbc", key, iv);
    decipher.setAutoPadding(false);
    const padded = Buffer.concat([decipher.update(buffer.subarray(3)), decipher.final()]);
    const unpadded = removePkcs7Padding(padded);
    return decodeCookieBytes(unpadded, options.stripHashPrefix);
  } catch {
    return null;
  }
}

/** @param {Buffer} value */
function removePkcs7Padding(value) {
  if (!value.length) return value;
  const padding = value[value.length - 1];
  if (!padding || padding > 16) return value;
  return value.subarray(0, value.length - padding);
}

/** @param {Uint8Array} value @param {boolean} stripHashPrefix */
function decodeCookieBytes(value, stripHashPrefix) {
  const bytes = stripHashPrefix && value.length >= 32 ? value.subarray(32) : value;
  try {
    return stripLeadingControlChars(COOKIE_VALUE_DECODER.decode(bytes));
  } catch {
    return null;
  }
}

/** @param {string} value */
function stripLeadingControlChars(value) {
  let index = 0;
  while (index < value.length && value.charCodeAt(index) < 0x20) index += 1;
  return value.slice(index);
}

/**
 * @param {Record<string, unknown>[]} rows
 * @param {Pick<ConfiguredChromiumSourceOptions, "origins" | "profile" | "includeExpired"> & {stripHashPrefix: boolean}} options
 * @param {Buffer} key
 * @param {string[]} warnings
 */
function collectCookies(rows, options, key, warnings) {
  const cookies = [];
  const now = Math.floor(Date.now() / 1000);
  const hosts = options.origins.map((origin) => new URL(origin).hostname);
  let warnedEncryptedType = false;

  for (const row of rows) {
    const name = typeof row.name === "string" ? row.name : "";
    const hostKey = typeof row.host_key === "string" ? row.host_key : "";
    if (!name || !hostKey || !hostMatchesAny(hosts, hostKey)) continue;

    let value = typeof row.value === "string" && row.value.length > 0 ? row.value : null;
    if (value === null) {
      if (!(row.encrypted_value instanceof Uint8Array)) {
        if (!warnedEncryptedType && row.encrypted_value !== undefined) {
          warnings.push("Chromium cookie encrypted_value is in an unsupported type.");
          warnedEncryptedType = true;
        }
        continue;
      }
      value = decryptCookieValue(row.encrypted_value, key, { stripHashPrefix: options.stripHashPrefix });
    }
    if (value === null) continue;

    const expires = chromiumExpirationToUnixSeconds(row.expires_utc);
    if (!options.includeExpired && expires !== undefined && expires < now) continue;

    /** @type {ImportedAuthCookie & {source: {browser: string, profile: string}}} */
    const cookie = {
      name,
      value,
      domain: hostKey.startsWith(".") ? hostKey.slice(1) : hostKey,
      path: typeof row.path === "string" && row.path ? row.path : "/",
      secure: row.is_secure === 1 || row.is_secure === "1" || row.is_secure === true,
      httpOnly: row.is_httponly === 1 || row.is_httponly === "1" || row.is_httponly === true,
      source: { browser: "chromium", profile: options.profile },
    };
    if (expires !== undefined) cookie.expires = expires;
    const sameSite = normalizeSameSite(row.samesite);
    if (sameSite !== undefined) cookie.sameSite = sameSite;
    cookies.push(cookie);
  }

  return dedupeCookies(cookies);
}

/** @param {ImportedAuthCookie[]} cookies */
function dedupeCookies(cookies) {
  /** @type {Map<string, ImportedAuthCookie>} */
  const seen = new Map();
  for (const cookie of cookies) {
    const key = `${cookie.domain}\t${cookie.path}\t${cookie.name}`;
    if (!seen.has(key)) seen.set(key, cookie);
  }
  return [...seen.values()];
}

/**
 * @param {ConfiguredChromiumSourceOptions} options
 * @returns {Promise<{cookies: ImportedAuthCookie[], warnings: string[]}>}
 */
export async function getCookiesFromConfiguredChromiumSource(options) {
  const warnings = [];
  if (!options.dbPath || !existsSync(options.dbPath)) {
    return { cookies: [], warnings: [`Chromium cookies database not found: ${options.dbPath || "(missing path)"}`] };
  }

  const passwordResult = await readKeychainPassword(options.keychain, options.timeoutMs ?? 5_000);
  if (!passwordResult.ok) return { cookies: [], warnings: [passwordResult.error] };

  let snapshot;
  try {
    snapshot = snapshotCookieDb(options.dbPath);
  } catch (error) {
    return { cookies: [], warnings: [`Failed to copy Chromium cookie DB: ${error instanceof Error ? error.message : String(error)}`] };
  }

  try {
    const db = new DatabaseSync(snapshot.tempDbPath, { readOnly: true });
    try {
      const metaVersion = readMetaVersion(db);
      const where = buildHostWhereClause(options.origins);
      const sql =
        `SELECT name, value, host_key, path, CAST(expires_utc AS TEXT) AS expires_utc, samesite, encrypted_value, ` +
        `is_secure AS is_secure, is_httponly AS is_httponly FROM cookies WHERE (${where}) ORDER BY cookies.expires_utc DESC;`;
      const rows = db.prepare(sql).all();
      const key = deriveMacosChromiumKey(passwordResult.password);
      const cookies = collectCookies(rows, {
        origins: options.origins,
        profile: options.profile,
        includeExpired: options.includeExpired === true,
        stripHashPrefix: metaVersion >= 24,
      }, key, warnings);
      return { cookies, warnings };
    } finally {
      db.close();
    }
  } catch (error) {
    return { cookies: [], warnings: [`Failed to read Chromium cookies (requires a modern Chromium cookie DB): ${error instanceof Error ? error.message : String(error)}`] };
  } finally {
    rmSync(snapshot.tempDir, { recursive: true, force: true });
  }
}
