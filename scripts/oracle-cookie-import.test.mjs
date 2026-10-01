import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createCipheriv, createHash, pbkdf2Sync } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import test from "node:test";

// Independent standard Chromium v24 SQLite/v11 fixture; the real auth worker
// reads/decrypts/filters it and replays into a fake browser, never a real one.
test("Linux auth imports native Chromium with its own key and preserves Chrome/Brave", {
  skip: process.platform !== "linux", timeout: 90_000,
}, async (t) => {
  const { DatabaseSync } = await import("node:sqlite");
  const { detectDefaultLinuxCookieProfileSource } = await import("../extensions/oracle/shared/browser-profile-helpers.mjs");
  const root = await mkdtemp(join(tmpdir(), "oracle-cookie-import-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, "home");
  const configHome = join(home, ".config");
  const bin = join(root, "bin");
  const helperLog = join(root, "helpers.jsonl");
  const browserLog = join(root, "browser.jsonl");
  await mkdir(bin, { recursive: true });
  const guard = `
    import { appendFileSync, mkdirSync } from 'node:fs';
    import { basename } from 'node:path';
    for (const [name, value] of Object.entries(process.env)) {
      if (name.startsWith('SWEET_COOKIE_') && name.endsWith('_PASSWORD') && value) {
        throw Error('safe-storage password leaked to subprocess');
      }
    }
    const args = process.argv.slice(2);
  `;
  const helper = `#!${process.execPath}
    ${guard}
    const command = basename(process.argv[1]);
    appendFileSync(process.env.HELPER_LOG, JSON.stringify({ command, args }) + '\\n');
    const mode = process.env.FIXTURE_MODE;
    if (mode === 'timeout') { process.on('SIGTERM', () => {}); setInterval(() => {}, 1000); }
    else if (mode === 'failure') { console.error('fixture-key-do-not-log'); process.exit(1); }
    else if (command === 'dbus-send') {
      if (mode === 'wallet-fallback') process.exit(1);
      console.log('"fixture-wallet"');
    } else if (command === 'kwallet-query') {
      if (mode === 'wallet-empty') console.log('failed to read password');
      else if (args.join('|') === '--read-password|Chromium Safe Storage|--folder|Chromium Keys|' + (mode === 'wallet-fallback' ? 'kdewallet' : 'fixture-wallet')) console.log('fixture-chromium-key');
      else process.exit(1);
    } else {
      if (mode === 'application' && args.includes('service')) process.exit(1);
      const browser = args.includes('Chromium') || args.includes('chromium') ? 'chromium'
        : args.includes('Brave') || args.includes('brave') ? 'brave' : 'chrome';
      console.log('fixture-' + browser + '-key');
    }
  `;
  for (const command of ["secret-tool", "kwallet-query", "dbus-send"]) {
    await writeFile(join(bin, command), helper, { mode: 0o700 });
  }
  await writeFile(join(bin, "agent-browser"), `#!${process.execPath}
    ${guard}
    appendFileSync(process.env.BROWSER_LOG, JSON.stringify(args) + '\\n');
    if (args.includes('--profile')) mkdirSync(args[args.indexOf('--profile') + 1], { recursive: true });
    if (args.includes('status')) console.log(JSON.stringify({ data: { connected: true } }));
    else if (args.includes('snapshot')) console.log('- textbox "Chat with ChatGPT" [ref=e1]\\n- button "Add files and more" [ref=e2]');
    else if (args.includes('eval')) { process.stdin.resume(); process.stdin.on('end', () => console.log(JSON.stringify({ ok: true, status: 200, bodyHasId: true, bodyHasEmail: true }))); }
    else if (args.includes('url')) console.log('https://chatgpt.com/');
  `, { mode: 0o700 });

  const cases = [
    { browser: "google-chrome", password: "fixture-chrome-key" },
    { browser: "BraveSoftware/Brave-Browser", password: "fixture-brave-key" },
    { browser: "chromium", password: "fixture-chromium-key" },
    { browser: "chromium", password: "fixture-chromium-key", auto: true },
    { browser: "chromium", password: "fixture-chromium-key", relative: true },
    { browser: "chromium", password: "fixture-chromium-key", braveAncestor: true },
    { browser: "chromium", password: "fixture-override-key", braveAncestor: true, override: true },
    { browser: "chromium", password: "fixture-chromium-key", db: true, network: true },
    { browser: "chromium-browser", password: "fixture-chromium-key", mode: "application" },
    { browser: "chromium-browser", password: "fixture-chromium-key", db: true },
    ...["6", "5", ""].map((kde) => ({ browser: "chromium", password: "fixture-chromium-key", backend: "kwallet", kde })),
    { browser: "chromium", password: "fixture-chromium-key", backend: "kwallet", mode: "wallet-fallback" },
    { browser: "chromium", password: "", backend: "kwallet", mode: "failure" },
    { browser: "chromium", password: "", backend: "kwallet", mode: "wallet-empty" },
    { browser: "chromium", password: "peanuts", backend: "basic", prefix: "v10" },
    { browser: "chromium", password: "", backend: "basic" },
    { browser: "chromium", password: "fixture-override-key", override: true },
    { browser: "chromium", password: "fixture-chromium-key", backend: "invalid", desktop: "GNOME:KDE", kde: "6" },
    { browser: "chromium", password: "", mode: "failure" },
    { browser: "chromium", password: "", mode: "timeout" },
    { browser: "google-chrome", password: "fixture-chrome-key", profileName: true },
    { browser: "chromium", password: "fixture-override-key", braveAncestor: true, override: true, relative: true },
    { browser: "chromium", password: "fixture-override-key", braveAncestor: true, override: true, tilde: true },
    { browser: "chromium", password: "fixture-override-key", override: true, db: true, dotSegment: true },
  ];
  for (const [index, c] of cases.entries()) {
    // Keep the release artifact scanner strict: fixture password values stay in
    // this file, out of captured platform-smoke stdout (case flags stay unique).
    const { password: _fixturePassword, ...label } = c;
    await t.test(JSON.stringify(label), async () => {
      const sourceHome = c.tilde ? join(root, "BraveSoftware", "home") : home;
      const sourceConfigHome = c.tilde ? join(sourceHome, ".config")
        : c.braveAncestor ? join(root, "BraveSoftware", "config")
        : c.auto ? join(root, "xdg-native") : configHome;
      const profile = join(sourceConfigHome, c.browser, "Default");
      const dbPath = join(profile, ...(c.network ? ["Network"] : []), "Cookies");
      await mkdir(join(profile, ...(c.network ? ["Network"] : [])), { recursive: true });
      if (c.dotSegment) await mkdir(join(sourceConfigHome, "BraveSoftware"), { recursive: true });
      const cookiePath = c.dotSegment ? `${sourceConfigHome}/BraveSoftware/../${c.browser}/Default/Cookies` : dbPath;
      await rm(join(profile, "Cookies"), { force: true });
      const db = new DatabaseSync(dbPath);
      try {
        db.exec(`CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
          INSERT INTO meta VALUES ('version', '24');
          CREATE TABLE cookies (name TEXT, value TEXT, host_key TEXT, path TEXT,
            expires_utc INTEGER, samesite INTEGER, encrypted_value BLOB,
            is_secure INTEGER, is_httponly INTEGER);`);
        const cipher = createCipheriv("aes-128-cbc", pbkdf2Sync(c.password, "saltysalt", 1, 16, "sha1"), Buffer.alloc(16, 32));
        const plaintext = Buffer.concat([createHash("sha256").update(".chatgpt.com").digest(), Buffer.from("fixture-session-token")]);
        const encrypted = Buffer.concat([Buffer.from(c.prefix ?? "v11"), cipher.update(plaintext), cipher.final()]);
        db.prepare("INSERT INTO cookies VALUES (?, '', '.chatgpt.com', '/', 0, 1, ?, 1, 1)")
          .run("__Secure-next-auth.session-token", encrypted);
      } finally { db.close(); }
      await writeFile(helperLog, "");
      await writeFile(browserLog, "");
      const config = {
        defaults: { provider: "chatgpt", preset: "instant" },
        browser: { authSeedProfileDir: join(root, `seed-${index}`), sessionPrefix: "fixture", chatUrl: "https://chatgpt.com/" },
        auth: { chromeProfile: c.auto ? detectDefaultLinuxCookieProfileSource({ homeDir: sourceHome, env: { XDG_CONFIG_HOME: sourceConfigHome } })
          : c.profileName ? "Default" : c.relative ? "./Default" : c.tilde ? `~/${relative(sourceHome, profile)}` : profile,
          ...(c.db ? { chromeCookiePath: cookiePath } : {}), bootstrapTimeoutMs: 1000, pollMs: 1 },
      };
      const env = { HOME: sourceHome, XDG_CONFIG_HOME: sourceConfigHome, PATH: bin, TMPDIR: root,
          AGENT_BROWSER_PATH: join(bin, "agent-browser"), PI_ORACLE_STATE_DIR: join(root, "state"),
          SWEET_COOKIE_LINUX_KEYRING: c.backend ?? "gnome", KDE_SESSION_VERSION: c.kde ?? "",
          XDG_CURRENT_DESKTOP: c.desktop ?? "",
          ...(c.override ? { SWEET_COOKIE_CHROME_SAFE_STORAGE_PASSWORD: c.password } : {}),
          FIXTURE_MODE: c.mode ?? "", HELPER_LOG: helperLog, BROWSER_LOG: browserLog };
      const output = execFileSync(process.execPath, [new URL("../extensions/oracle/worker/auth-bootstrap.mjs", import.meta.url).pathname, JSON.stringify(config)], {
        encoding: "utf8", timeout: 15_000, stdio: ["ignore", "pipe", "pipe"], env,
        ...(c.relative || c.profileName ? { cwd: join(sourceConfigHome, "chromium") } : {}),
      });
      assert.match(output, /Oracle auth synced/);
      const replay = (await readFile(browserLog, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
      assert(replay.some((args) => args.includes("__Secure-next-auth.session-token") && args.includes("fixture-session-token")), "production import must decrypt and replay the known cookie");
      const calls = (await readFile(helperLog, "utf8")).trim();
      if (c.override || c.backend === "basic") assert.equal(calls, "");
      else if (c.browser.startsWith("chromium")) {
        assert.doesNotMatch(calls, /Chrome Safe Storage|application","chrome"/);
        if (c.mode === "application") assert.match(calls, /application","chromium/);
        if (c.backend === "kwallet") {
          assert.match(calls, new RegExp(`org.kde.kwalletd${c.kde ?? ""}`));
          assert.match(calls, /Chromium Keys/);
          assert.match(calls, ["wallet-fallback", "failure"].includes(c.mode) ? /kdewallet/ : /fixture-wallet/);
        }
      }
      const diagnostics = output.match(/Diagnostics:\n([^\n]+)/)[1];
      const log = await readFile(join(diagnostics, "oracle-auth.log"), "utf8");
      assert.doesNotMatch(log + output, /fixture-(?:chromium|override)-key|fixture-key-do-not-log/);
      if (["failure", "timeout"].includes(c.mode)) assert.match(log, /Failed to read Linux keyring via (secret-tool|kwallet-query)/);
      if (index === 2 || (c.braveAncestor && !c.override)) {
        // A prior successful Chrome read must not cache the wrong key. The
        // adapter's legitimate API must restore env on success AND rejection.
        execFileSync(process.execPath, ["--input-type=module", "-e", `
          import assert from 'node:assert/strict';
          import { getCookies } from '@steipete/sweet-cookie';
          import { getCookiesFromNativeLinuxChromium } from './extensions/oracle/worker/linux-chromium-cookie-source.mjs';
          const options = {url:'https://chatgpt.com/',browsers:['chrome'],mode:'merge',chromeProfile:process.argv[1]};
          assert.equal((await getCookies({...options,chromeProfile:process.argv[2]})).cookies[0].value,'fixture-session-token');
          process.env.SWEET_COOKIE_CHROME_SAFE_STORAGE_PASSWORD = ' ';
          process.env.SWEET_COOKIE_BRAVE_SAFE_STORAGE_PASSWORD = 'fixture-unused-brave-password';
          const previous = {...process.env};
          assert.equal((await getCookiesFromNativeLinuxChromium(options, getCookies)).cookies[0].value,'fixture-session-token');
          assert.deepEqual({...process.env},previous);
          await assert.rejects(getCookiesFromNativeLinuxChromium({...options,origins:[null]}, getCookies),TypeError);
          assert.deepEqual({...process.env},previous);
          process.env.FIXTURE_MODE = 'failure';
          const failureEnv = {...process.env};
          const failedKeyring = await getCookiesFromNativeLinuxChromium(options, getCookies);
          assert.deepEqual(failedKeyring.cookies,[]);
          assert.match(failedKeyring.warnings.join('|'),/Failed to read Linux keyring via secret-tool/);
          assert.deepEqual({...process.env},failureEnv);
          await assert.rejects(getCookiesFromNativeLinuxChromium({...options,origins:[null]}, getCookies),TypeError);
          assert.deepEqual({...process.env},failureEnv);
          process.env.SWEET_COOKIE_CHROME_SAFE_STORAGE_PASSWORD = ' fixture-chromium-key ';
          const calibratedEnv = {...process.env};
          assert.equal((await getCookiesFromNativeLinuxChromium(options, getCookies)).cookies[0].value,'fixture-session-token');
          assert.deepEqual({...process.env},calibratedEnv);
          await assert.rejects(getCookiesFromNativeLinuxChromium({...options,origins:[null]}, getCookies),TypeError);
          assert.deepEqual({...process.env},calibratedEnv);
          delete process.env.SWEET_COOKIE_CHROME_SAFE_STORAGE_PASSWORD;
          process.env.SWEET_COOKIE_BRAVE_SAFE_STORAGE_PASSWORD = 'fixture-chromium-key';
          process.env.SWEET_COOKIE_LINUX_KEYRING = 'basic';
          const basicEnv = {...process.env};
          assert.deepEqual((await getCookiesFromNativeLinuxChromium(options, getCookies)).cookies,[]);
          assert.deepEqual({...process.env},basicEnv);
          await assert.rejects(getCookiesFromNativeLinuxChromium({...options,origins:[null]}, getCookies),TypeError);
          assert.deepEqual({...process.env},basicEnv);
        `, profile, join(configHome, "google-chrome", "Default")], {
          cwd: new URL("../", import.meta.url), encoding: "utf8", timeout: 10_000, env,
        });
      }
      await rm(join(profile, "Network"), { recursive: true, force: true });
    });
  }
});
