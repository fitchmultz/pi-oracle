// Purpose: Centralize platform-specific browser profile paths, executable discovery, and profile-safety checks for oracle auth/runtime code.
// Responsibilities: Resolve Chromium-family user-data roots, choose platform defaults, find executable files safely, and block oracle profile paths that point into real browser data.
// Scope: Local filesystem/path policy only; cookie import, browser automation, and config loading stay in higher-level modules.
// Usage: Imported by config.ts, runtime.ts, auth-bootstrap.mjs, run-job.mjs, and sanity tests.
// Invariants/Assumptions: Real browser profile roots must never be used as oracle seed/runtime profile destinations, even through symlinked ancestors.

import { accessSync, constants as fsConstants, existsSync, realpathSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, delimiter, dirname, isAbsolute, join, normalize, resolve } from "node:path";

/** @typedef {import("./browser-profile-helpers.d.mts").OraclePlatform} OraclePlatform */
/** @typedef {import("./browser-profile-helpers.d.mts").BrowserPathOptions} BrowserPathOptions */
/** @typedef {import("./browser-profile-helpers.d.mts").ExecutableSearchOptions} ExecutableSearchOptions */

export const SWEET_COOKIE_SAFE_STORAGE_PASSWORD_ENV_NAMES = Object.freeze([
  "SWEET_COOKIE_CHROME_SAFE_STORAGE_PASSWORD",
  "SWEET_COOKIE_BRAVE_SAFE_STORAGE_PASSWORD",
  "SWEET_COOKIE_EDGE_SAFE_STORAGE_PASSWORD",
]);

const LINUX_COOKIE_IMPORT_USER_DATA_RELATIVE_DIRS = Object.freeze([
  ["google-chrome"],
  ["chromium"],
  ["chromium-browser"],
  ["BraveSoftware", "Brave-Browser"],
]);

const LINUX_SAFETY_EXTRA_USER_DATA_RELATIVE_DIRS = Object.freeze([
  ["google-chrome-beta"],
  ["google-chrome-unstable"],
  ["microsoft-edge"],
  ["microsoft-edge-beta"],
  ["microsoft-edge-dev"],
  ["vivaldi"],
  ["opera"],
]);

const MAC_CHROMIUM_USER_DATA_RELATIVE_DIRS = Object.freeze([
  ["Library", "Application Support", "Google", "Chrome"],
  ["Library", "Application Support", "Chromium"],
  ["Library", "Application Support", "BraveSoftware", "Brave-Browser"],
  ["Library", "Application Support", "Microsoft Edge"],
  ["Library", "Application Support", "Arc", "User Data"],
  ["Library", "Application Support", "Vivaldi"],
  ["Library", "Application Support", "com.operasoftware.Opera"],
  ["Library", "Application Support", "Google", "Chrome for Testing"],
]);

const LINUX_CHROME_EXECUTABLE_NAMES = Object.freeze(["google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "brave-browser", "brave"]);

/**
 * @param {string} value
 * @param {string} [homeDir]
 * @returns {string}
 */
export function expandHomePath(value, homeDir = homedir()) {
  if (value === "~") return homeDir;
  if (value.startsWith("~/")) return join(homeDir, value.slice(2));
  return value;
}

/**
 * @param {string} value
 * @param {BrowserPathOptions} [options]
 * @returns {string}
 */
export function normalizedAbsolutePath(value, options = {}) {
  const expanded = expandHomePath(value, options.homeDir ?? homedir());
  return normalize(isAbsolute(expanded) ? expanded : resolve(expanded));
}

/**
 * @param {BrowserPathOptions} [options]
 * @returns {string}
 */
export function linuxConfigHome(options = {}) {
  const env = options.env ?? process.env;
  const configured = env.XDG_CONFIG_HOME?.trim();
  return configured ? normalizedAbsolutePath(configured, options) : join(options.homeDir ?? homedir(), ".config");
}

/**
 * @param {BrowserPathOptions} [options]
 * @returns {string[]}
 */
export function linuxChromiumCookieImportUserDataDirs(options = {}) {
  const configHome = linuxConfigHome(options);
  return LINUX_COOKIE_IMPORT_USER_DATA_RELATIVE_DIRS.map((segments) => join(configHome, ...segments));
}

/**
 * @param {BrowserPathOptions} [options]
 * @returns {string[]}
 */
export function linuxBrowserSafetyUserDataDirs(options = {}) {
  const configHome = linuxConfigHome(options);
  return [
    ...LINUX_COOKIE_IMPORT_USER_DATA_RELATIVE_DIRS,
    ...LINUX_SAFETY_EXTRA_USER_DATA_RELATIVE_DIRS,
  ].map((segments) => join(configHome, ...segments));
}

/**
 * @param {OraclePlatform} [platform]
 * @param {BrowserPathOptions & { includeUnsupported?: boolean }} [options]
 * @returns {string[]}
 */
export function browserUserDataDirsForPlatform(platform = process.platform, options = {}) {
  const homeDir = options.homeDir ?? homedir();
  if (platform === "darwin") return MAC_CHROMIUM_USER_DATA_RELATIVE_DIRS.map((segments) => join(homeDir, ...segments));
  if (platform === "linux") return options.includeUnsupported === false ? linuxChromiumCookieImportUserDataDirs({ ...options, homeDir }) : linuxBrowserSafetyUserDataDirs({ ...options, homeDir });
  return [];
}

/**
 * @param {OraclePlatform} [platform]
 * @returns {"apfs-clone" | "copy"}
 */
export function defaultCloneStrategyForPlatform(platform = process.platform) {
  return platform === "darwin" ? "apfs-clone" : "copy";
}

/**
 * @param {OraclePlatform} [platform]
 * @returns {boolean}
 */
export function chromiumKeychainSupportedOnPlatform(platform = process.platform) {
  return platform === "darwin";
}

/**
 * @param {OraclePlatform} [platform]
 * @returns {string | undefined}
 */
export function chromeUserAgentPlatformToken(platform = process.platform) {
  if (platform === "darwin") return "Macintosh; Intel Mac OS X 10_15_7";
  if (platform === "linux") return "X11; Linux x86_64";
  return undefined;
}

/**
 * @param {string} childPath
 * @param {string} parentPath
 * @returns {boolean}
 */
export function pathInsideOrEqual(childPath, parentPath) {
  const child = normalize(childPath);
  const parent = normalize(parentPath);
  return child === parent || child.startsWith(parent.endsWith("/") ? parent : `${parent}/`);
}

/**
 * Resolve a path as far as its existing ancestors allow. If the final path does
 * not exist yet, any non-existing suffix is appended to the nearest existing
 * ancestor's realpath so symlinked ancestors are still accounted for.
 *
 * @param {string} pathValue
 * @returns {string | undefined}
 */
export function resolvePathThroughExistingAncestorsSync(pathValue) {
  const absolute = normalizedAbsolutePath(pathValue);
  const suffix = [];
  let current = absolute;
  while (true) {
    if (existsSync(current)) {
      try {
        return normalize(join(realpathSync(current), ...suffix.reverse()));
      } catch {
        return undefined;
      }
    }
    const parent = dirname(current);
    if (parent === current) return undefined;
    suffix.push(basename(current));
    current = parent;
  }
}

/**
 * @param {string} pathValue
 * @returns {boolean}
 */
function looksLikeFilesystemPath(pathValue) {
  return pathValue.startsWith("/") || pathValue.startsWith("~/") || pathValue === "~" || pathValue.startsWith(".");
}

/**
 * @param {string} pathValue
 * @returns {boolean}
 */
function isCookiesDbPath(pathValue) {
  return basename(pathValue) === "Cookies";
}

/**
 * @param {string} cookiePath
 * @returns {string[]}
 */
function protectedPathsForCookieDb(cookiePath) {
  const normalized = normalizedAbsolutePath(cookiePath);
  const cookieParent = dirname(normalized);
  const profileDir = basename(cookieParent) === "Network" ? dirname(cookieParent) : cookieParent;
  return [profileDir, dirname(profileDir)];
}

/**
 * @param {{ chromeProfile?: string; chromeCookiePath?: string } | undefined} cookieSources
 * @returns {string[]}
 */
export function protectedCookieSourcePaths(cookieSources) {
  if (!cookieSources) return [];
  const roots = [];
  const cookiePath = typeof cookieSources.chromeCookiePath === "string" && cookieSources.chromeCookiePath.trim()
    ? cookieSources.chromeCookiePath.trim()
    : undefined;
  if (cookiePath) roots.push(...protectedPathsForCookieDb(cookiePath));

  const profile = typeof cookieSources.chromeProfile === "string" && cookieSources.chromeProfile.trim()
    ? cookieSources.chromeProfile.trim()
    : undefined;
  if (profile && looksLikeFilesystemPath(profile)) {
    const normalizedProfile = normalizedAbsolutePath(profile);
    if (isCookiesDbPath(normalizedProfile)) roots.push(...protectedPathsForCookieDb(normalizedProfile));
    else roots.push(normalizedProfile, dirname(normalizedProfile));
  }

  return [...new Set(roots.map((root) => normalize(root)))];
}

/**
 * @param {string} pathValue
 * @param {BrowserPathOptions & { platform?: OraclePlatform; includeUnsupported?: boolean; extraProtectedPaths?: string[]; cookieSources?: { chromeProfile?: string; chromeCookiePath?: string } }} [options]
 * @returns {string | undefined}
 */
export function knownBrowserUserDataPathMatch(pathValue, options = {}) {
  const platform = options.platform ?? process.platform;
  const normalizedPath = normalizedAbsolutePath(pathValue, options);
  const resolvedPath = resolvePathThroughExistingAncestorsSync(normalizedPath);
  const roots = [
    ...browserUserDataDirsForPlatform(platform, { ...options, includeUnsupported: options.includeUnsupported ?? true }),
    ...protectedCookieSourcePaths(options.cookieSources),
    ...((options.extraProtectedPaths ?? [])),
  ];
  for (const root of roots) {
    const normalizedRoot = normalizedAbsolutePath(root, options);
    if (pathInsideOrEqual(normalizedPath, normalizedRoot)) return normalizedRoot;
    const resolvedRoot = resolvePathThroughExistingAncestorsSync(normalizedRoot) ?? normalizedRoot;
    if (resolvedPath && pathInsideOrEqual(resolvedPath, resolvedRoot)) return resolvedRoot;
  }
  return undefined;
}

/**
 * @param {string} pathValue
 * @param {string} label
 * @param {BrowserPathOptions & { platform?: OraclePlatform; includeUnsupported?: boolean; extraProtectedPaths?: string[]; cookieSources?: { chromeProfile?: string; chromeCookiePath?: string } }} [options]
 * @returns {void}
 */
export function assertNotKnownBrowserUserDataPath(pathValue, label, options = {}) {
  const match = knownBrowserUserDataPathMatch(pathValue, options);
  if (match) {
    throw new Error(`${label} must not point into a real browser user-data directory (${match}): ${pathValue}`);
  }
}

/**
 * @param {string} pathValue
 * @returns {boolean}
 */
export function isExecutableFileSync(pathValue) {
  try {
    const stats = statSync(pathValue);
    if (!stats.isFile()) return false;
    accessSync(pathValue, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * @param {readonly string[]} names
 * @param {ExecutableSearchOptions} [options]
 * @returns {string | undefined}
 */
export function findExecutableOnPathSync(names, options = {}) {
  const pathValue = options.pathValue ?? process.env.PATH ?? "";
  for (const name of names) {
    for (const dir of pathValue.split(delimiter).filter(Boolean)) {
      const candidate = join(dir, name);
      if (isExecutableFileSync(candidate)) return candidate;
    }
  }
  return undefined;
}

/**
 * @param {ExecutableSearchOptions} [options]
 * @returns {string | undefined}
 */
export function detectDefaultLinuxChromeExecutablePath(options = {}) {
  return findExecutableOnPathSync(LINUX_CHROME_EXECUTABLE_NAMES, options);
}

/**
 * @param {string} userDataDir
 * @returns {string | undefined}
 */
function readLastUsedProfileName(userDataDir) {
  const localStatePath = join(userDataDir, "Local State");
  if (!existsSync(localStatePath)) return undefined;
  try {
    const localState = JSON.parse(readFileSync(localStatePath, "utf8"));
    const lastUsed = localState?.profile?.last_used;
    if (typeof lastUsed !== "string") return undefined;
    const trimmed = lastUsed.trim();
    if (!trimmed || trimmed === "." || trimmed === ".." || trimmed.includes("/") || trimmed.includes("\\")) return undefined;
    return trimmed;
  } catch {
    return undefined;
  }
}

/**
 * Return an absolute Linux Chrome/Chromium-family profile directory for the
 * default cookie importer. Sweet Cookie's Linux `chrome` backend only resolves
 * non-path profile names under google-chrome, so non-Google roots must be
 * passed as absolute paths.
 *
 * @param {BrowserPathOptions} [options]
 * @returns {string | undefined}
 */
export function detectDefaultLinuxCookieProfileSource(options = {}) {
  for (const userDataDir of linuxChromiumCookieImportUserDataDirs(options)) {
    const lastUsed = readLastUsedProfileName(userDataDir);
    if (lastUsed) {
      const profilePath = join(userDataDir, lastUsed);
      if (pathInsideOrEqual(profilePath, userDataDir) && existsSync(profilePath)) return profilePath;
    }
    const defaultProfile = join(userDataDir, "Default");
    if (existsSync(defaultProfile)) return defaultProfile;
  }
  return undefined;
}

/**
 * @param {OraclePlatform} [platform]
 * @param {BrowserPathOptions} [options]
 * @returns {string}
 */
export function detectDefaultBrowserProfileSource(platform = process.platform, options = {}) {
  if (platform === "linux") return detectDefaultLinuxCookieProfileSource(options) ?? "Default";
  if (platform === "darwin") {
    const userDataDir = browserUserDataDirsForPlatform("darwin", options)[0];
    return readLastUsedProfileName(userDataDir) ?? "Default";
  }
  return "Default";
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {void}
 */
export function scrubSweetCookieSafeStoragePasswordEnv(env = process.env) {
  for (const name of SWEET_COOKIE_SAFE_STORAGE_PASSWORD_ENV_NAMES) {
    delete env[name];
  }
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {NodeJS.ProcessEnv}
 */
export function sweetCookieSafeStoragePasswordScrubbedEnv(env = process.env) {
  const childEnv = { ...env };
  scrubSweetCookieSafeStoragePasswordEnv(childEnv);
  return childEnv;
}
