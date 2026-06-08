export type OraclePlatform = NodeJS.Platform;

export interface BrowserPathOptions {
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
}

export interface ExecutableSearchOptions {
  pathValue?: string;
  pathDelimiter?: string;
}

export interface KnownBrowserUserDataPathMatchDetails {
  root: string;
  source: "knownBrowserUserDataDir" | "auth.chromeCookiePath" | "auth.chromeProfile" | "extraProtectedPath";
  configuredPath?: string;
}

export const SWEET_COOKIE_SAFE_STORAGE_PASSWORD_ENV_NAMES: readonly [
  "SWEET_COOKIE_CHROME_SAFE_STORAGE_PASSWORD",
  "SWEET_COOKIE_BRAVE_SAFE_STORAGE_PASSWORD",
  "SWEET_COOKIE_EDGE_SAFE_STORAGE_PASSWORD",
];

export function expandHomePath(value: string, homeDir?: string): string;
export function normalizedAbsolutePath(value: string, options?: BrowserPathOptions): string;
export function linuxConfigHome(options?: BrowserPathOptions): string;
export function linuxChromiumCookieImportUserDataDirs(options?: BrowserPathOptions): string[];
export function linuxBrowserSafetyUserDataDirs(options?: BrowserPathOptions): string[];
export function browserUserDataDirsForPlatform(
  platform?: OraclePlatform,
  options?: BrowserPathOptions & { includeUnsupported?: boolean },
): string[];
export function defaultCloneStrategyForPlatform(platform?: OraclePlatform): "apfs-clone" | "copy";
export function chromiumKeychainSupportedOnPlatform(platform?: OraclePlatform): boolean;
export function chromeUserAgentPlatformToken(platform?: OraclePlatform): string | undefined;
export function pathInsideOrEqual(childPath: string, parentPath: string): boolean;
export function resolvePathThroughExistingAncestorsSync(pathValue: string): string | undefined;
export function protectedCookieSourcePaths(cookieSources?: { chromeProfile?: string; chromeCookiePath?: string }): string[];
export function knownBrowserUserDataPathMatch(
  pathValue: string,
  options?: BrowserPathOptions & {
    platform?: OraclePlatform;
    includeUnsupported?: boolean;
    extraProtectedPaths?: string[];
    cookieSources?: { chromeProfile?: string; chromeCookiePath?: string };
  },
): string | undefined;
export function knownBrowserUserDataPathMatchDetails(
  pathValue: string,
  options?: BrowserPathOptions & {
    platform?: OraclePlatform;
    includeUnsupported?: boolean;
    extraProtectedPaths?: string[];
    cookieSources?: { chromeProfile?: string; chromeCookiePath?: string };
  },
): KnownBrowserUserDataPathMatchDetails | undefined;
export function assertNotKnownBrowserUserDataPath(
  pathValue: string,
  label: string,
  options?: BrowserPathOptions & {
    platform?: OraclePlatform;
    includeUnsupported?: boolean;
    extraProtectedPaths?: string[];
    cookieSources?: { chromeProfile?: string; chromeCookiePath?: string };
  },
): void;
export function isExecutableFileSync(pathValue: string): boolean;
export function findExecutableOnPathSync(names: readonly string[], options?: ExecutableSearchOptions): string | undefined;
export function detectDefaultLinuxChromeExecutablePath(options?: ExecutableSearchOptions): string | undefined;
export function detectDefaultLinuxCookieProfileSource(options?: BrowserPathOptions): string | undefined;
export function detectDefaultBrowserProfileSource(platform?: OraclePlatform, options?: BrowserPathOptions): string;
export function scrubSweetCookieSafeStoragePasswordEnv(env?: NodeJS.ProcessEnv): void;
export function sweetCookieSafeStoragePasswordScrubbedEnv(env?: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
