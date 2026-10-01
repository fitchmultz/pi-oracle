// Purpose: Select native Linux Chromium's safe-storage key for the public Sweet Cookie parser.
// Scope: Called only after source qualification in the short-lived auth worker.
// Invariants: Restore password/backend overrides and scrub keyring helper environments.
import { execFile } from "node:child_process";
import { sweetCookieSafeStoragePasswordScrubbedEnv } from "../shared/browser-profile-helpers.mjs";

// ponytail: Native Linux Chromium key selection only. Keep Sweet Cookie 0.3's
// public parser/decryptor; remove when an upstream fix passes unchanged-path
// performance checks. This API runs only in the short-lived auth worker.
const PASSWORD_ENV = "SWEET_COOKIE_CHROME_SAFE_STORAGE_PASSWORD";
const BRAVE_PASSWORD_ENV = "SWEET_COOKIE_BRAVE_SAFE_STORAGE_PASSWORD";
const BACKEND_ENV = "SWEET_COOKIE_LINUX_KEYRING";

/** @param {string} command @param {string[]} args @returns {Promise<string | undefined>} */
function readHelper(command, args) {
  return new Promise((resolve) => {
    execFile(command, args, {
      env: sweetCookieSafeStoragePasswordScrubbedEnv(),
      encoding: "utf8", timeout: 3_000, killSignal: "SIGKILL",
    }, (error, stdout) => resolve(error ? undefined : stdout.trim()));
  });
}

function keyringBackend() {
  const configured = process.env[BACKEND_ENV]?.trim().toLowerCase();
  if (configured === "gnome" || configured === "kwallet" || configured === "basic") return configured;
  const kde = process.env.XDG_CURRENT_DESKTOP?.split(":").some((part) => part.trim().toLowerCase() === "kde")
    || Boolean(process.env.KDE_FULL_SESSION?.trim());
  return kde ? "kwallet" : "gnome";
}

async function readChromiumPassword() {
  const backend = keyringBackend();
  if (backend === "basic") return { password: "", warnings: [] };
  if (backend === "gnome") {
    const password = await readHelper("secret-tool", ["lookup", "service", "Chromium Safe Storage", "account", "Chromium"])
      || await readHelper("secret-tool", ["lookup", "application", "chromium"]);
    return { password: password || "", warnings: password ? [] : [
      "Failed to read Linux keyring via secret-tool; v11 cookies may be unavailable.",
    ] };
  }
  const version = process.env.KDE_SESSION_VERSION?.trim();
  const suffix = version === "5" || version === "6" ? version : "";
  const wallet = await readHelper("dbus-send", [
    "--session", "--print-reply=literal", `--dest=org.kde.kwalletd${suffix}`,
    `/modules/kwalletd${suffix}`, "org.kde.KWallet.networkWallet",
  ]);
  const password = await readHelper("kwallet-query", [
    "--read-password", "Chromium Safe Storage", "--folder", "Chromium Keys",
    wallet?.replaceAll('"', "").trim() || "kdewallet",
  ]);
  return {
    password: password?.toLowerCase().startsWith("failed to read") ? "" : password || "",
    warnings: password === undefined ? [
      "Failed to read Linux keyring via kwallet-query; v11 cookies may be unavailable.",
    ] : [],
  };
}

/**
 * @param {import("@steipete/sweet-cookie").GetCookiesOptions} options
 * @param {typeof import("@steipete/sweet-cookie").getCookies} readCookies
 */
export async function getCookiesFromNativeLinuxChromium(options, readCookies) {
  const override = process.env[PASSWORD_ENV]?.trim();
  const { password, warnings } = override
    ? { password: override, warnings: [] }
    : await readChromiumPassword();
  const previous = {
    [PASSWORD_ENV]: process.env[PASSWORD_ENV],
    [BRAVE_PASSWORD_ENV]: process.env[BRAVE_PASSWORD_ENV],
    [BACKEND_ENV]: process.env[BACKEND_ENV],
  };
  try {
    // Sweet Cookie 0.3 classifies Brave by substrings anywhere in the DB path.
    // Even a Chromium XDG/HOME ancestor can trigger it. Supply the selected
    // Chromium key to either branch so neither can spawn a vendor keyring helper.
    if (password) {
      process.env[PASSWORD_ENV] = password;
      process.env[BRAVE_PASSWORD_ENV] = password;
    }
    // Empty env values are ignored by Sweet Cookie. Its basic backend supplies
    // the empty key without accidentally probing Chrome's keyring instead.
    else {
      delete process.env[PASSWORD_ENV];
      delete process.env[BRAVE_PASSWORD_ENV];
      process.env[BACKEND_ENV] = "basic";
    }
    const result = await readCookies(options);
    result.warnings.unshift(...warnings);
    return result;
  } finally {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}
