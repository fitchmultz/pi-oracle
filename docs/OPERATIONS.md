# OMP Oracle operations

Configure `omp-oracle` in Oh My Pi (OMP) and `pi`, choose and set up an auth transport, manage cookie
sources and job outputs, switch install sources, and recover from failures.
Companion docs: [Documentation](README.md) · [Compatibility](COMPATIBILITY.md) · [Security model](SECURITY.md) · [Architecture](ARCHITECTURE.md)

## Config files

| Scope | Oh My Pi | `pi` | May set |
| --- | --- | --- | --- |
| Agent (global) | `~/.omp/agent/extensions/oracle.json` | `~/.pi/agent/extensions/oracle.json` | Every key, including `browser.*` and `auth.*` |
| Project | `.omp/extensions/oracle.json` | `.pi/extensions/oracle.json` | `defaults`, `worker`, `poller`, `artifacts`, `cleanup` only |

The paths combine the host's agent directory or project config directory name with `extensions/oracle.json`.
A project file that sets any other top-level key is rejected; browser paths, cookie sources, keychain items,
the relay endpoint, and the managed browser profile come only from the agent-level file because they control
local browser state.

Pi 0.79+ gates project-local inputs behind project trust. `omp-oracle` loads this safe override file by
default for compatibility and ignores it when you opt out with `--no-approve` (`-na`) or save a "do not
trust" decision for the project (`--approve` or `-a` explicitly trusts it). On OMP hosts without Pi's
project-trust exports, project overrides require an explicit host trust decision or approval flag;
config-only callers default to agent configuration.

Most installations need no config file. To see the active paths, run `/oracle-auth` (in isolated-seed mode),
which prints the effective agent config path and whether a project override file was loaded or skipped
(`Effective oracle auth config: ...`), or call `oracle_preflight` to verify session, config, and transport
readiness. For every key, default, bound, and a complete JSON example, see the
[configuration reference](#configuration-reference).

## Choose an auth transport

| Transport | Providers | What it touches on your machine | When to choose it | Setup |
| --- | --- | --- | --- | --- |
| Isolated seed profile (default) | ChatGPT, Grok | Reads local browser cookies read-only into `<agent dir>/extensions/oracle-auth-seed-profile` (`-grok` for Grok); clones and deletes a runtime profile per job | Default for ChatGPT (except `deep_research`) and required for Grok; leaves your running browser untouched | [Isolated seed profile](#isolated-seed-profile-default) |
| Existing-Chrome relay | ChatGPT only | Attaches to a loopback CDP relay (`browser.chatGptRelayEndpoint`) and drives one job-owned pinned tab in your signed-in Chrome; copies no cookies | You already run a signed-in Chrome with a CDP relay or need `deep_research` on your existing browser | [Existing-Chrome relay](#existing-chrome-relay-chatgpt-only) |
| Managed browser | ChatGPT only | Opens or reuses a dedicated Chrome user-data directory (`browser.chatGptManagedProfileDir`) on a loopback ephemeral port, drives one job-owned pinned tab, and quits an Oracle-started Chrome when idle | You want work/personal account isolation or `deep_research` without keeping a second Chrome running by hand | [Managed ChatGPT browser](#managed-chatgpt-browser-dedicated-account) |

To keep a dedicated Chrome process running yourself on a fixed loopback CDP port instead of letting Oracle
launch and quit it, use the [dedicated account in persistent Chrome](#dedicated-account-in-persistent-chrome)
setup recipe for `browser.chatGptRelayEndpoint`.

## Auth transports

### Isolated seed profile (default)

1. **Prerequisites.** Sign in to ChatGPT or Grok in your local Chrome, Chromium, or Chromium-family browser
   profile (`auth.chromeProfile`, auto-detected by default).
2. **Config.** No transport key is required. Set `defaults.provider` (`"chatgpt"` or `"grok"`) or
   `auth.chromeProfile` in agent-level `oracle.json` only when overriding defaults.
3. **Command.** Run `/oracle-auth` once per provider, and rerun it whenever a job reports login is required:
   ```text
   /oracle-auth
   /oracle-auth grok
   ```
   `/oracle-auth` imports cookies in read-only mode into `browser.authSeedProfileDir` (default
   `<agent dir>/extensions/oracle-auth-seed-profile`, or `<authSeedProfileDir>-grok` for Grok) and writes a
   `.oracle-seed-generation` marker. Agent callers can run `oracle_auth({})` once before retrying a
   stale-auth submission.
4. **Confirm it works.** Each `/oracle-auth` run writes diagnostics to a private `0700` directory at
   `/tmp/pi-oracle-auth-*/` (`oracle-auth.log`, `oracle-auth.url.txt`, `oracle-auth.snapshot.txt`,
   `oracle-auth.body.txt`, and `oracle-auth.png` when captured) and prints the path. Each job clones the seed
   into `browser.runtimeProfilesDir` (default sibling `oracle-runtime-profiles`), runs headless by default
   (`browser.runMode`), and deletes the clone on exit. Up to `browser.maxConcurrentJobs` (default `2`) run
   concurrently; the rest queue.
5. **Limits.** Deep Research (`deep_research`) is not supported on the isolated seed profile because its
   cross-origin report widget frame requires a shared Chrome transport; runs on the isolated seed fail with
   `deep_research_report_unreadable`.

### Existing-Chrome relay (ChatGPT only)

1. **Prerequisites.** A signed-in Chrome session and a loopback CDP relay that exposes target discovery
   (`Target.getTargets`), creation, attachment, and closure, plus `agent-browser` `0.35.0` or newer with
   pinned-tab support. Older OMP relay builds without `Target.getTargets` cannot serve `agent-browser`.
2. **Config.** Set `browser.chatGptRelayEndpoint` in agent-level `oracle.json`:
   ```json
   { "browser": { "chatGptRelayEndpoint": "http://127.0.0.1:9224" } }
   ```
3. **Command.** Do not run `/oracle-auth`; finish login or human verification directly in Chrome.
   `/oracle-auth` and `oracle_auth` refuse cookie import in relay mode.
4. **Confirm it works.** Run `oracle_preflight` or check the session footer to confirm the relay endpoint is
   reachable. Each job creates a fresh tab, pins every browser command to it, and closes it on cleanup after
   verifying ownership (or releases the window's last tab to `about:blank`). Follow-ups open a new owned tab
   on the existing conversation URL; a missing or mismatched target fails closed. Relay mode never deletes a
   profile directory.
5. **Limits.** Agent-level config only, mutually exclusive with `browser.chatGptManagedProfileDir`, and
   ChatGPT only (Grok keeps the isolated seed profile). Preflight checks transport reachability, not ChatGPT
   login; the worker verifies login before uploading. Oracle does not verify an expected account email.

### Managed ChatGPT browser (dedicated account)

1. **Prerequisites.** For work/personal account separation, use a separate Chrome **user-data directory**,
   not ChatGPT's account picker in a shared profile: tabs and windows in one profile share auth state. The
   directory must be separate from your personal browser profile root, both providers' seed profiles, and
   `browser.runtimeProfilesDir`.
2. **Config.** Point `browser.chatGptManagedProfileDir` at that directory in agent-level `oracle.json`:
   ```json
   { "browser": { "chatGptManagedProfileDir": "~/Library/Application Support/omp-oracle/work-chrome" } }
   ```
3. **Command.** Run `/oracle-auth` (or `oracle_auth({})`) to open ChatGPT sign-in in the managed browser and
   sign in to the intended account:
   ```text
   /oracle-auth
   ```
   The login persists in the profile, and the browser stays open while the sign-in tab is open.
4. **Confirm it works.** The session footer reads `oracle: auth needed` until the profile directory exists.
   Once created, a ChatGPT job reuses the Chrome already serving that profile or launches one with
   `browser.executablePath` (headed, DevTools on a loopback ephemeral port with `--remote-debugging-port=0`,
   and the three `--disable-*` anti-backgrounding flags below). Each job owns one pinned tab and closes it on
   cleanup. Completed Deep Research (`deep_research`) runs with native Markdown export through the managed
   browser are recorded in the [release ledger](RELEASE.md#evidence-ledger).
5. **Limits.**
   - **Idle keeper.** A keeper process owns each Chrome that Oracle starts and quits it about 2 minutes
     (`120000` ms) after the last job ends with no non-blank page left open in it
     (`PI_ORACLE_MANAGED_BROWSER_IDLE_MS` overrides the grace). A Chrome you opened yourself is reused and
     never quit by Oracle.
   - **Opening Chrome yourself.** Oracle reuses a running Chrome only when it can prove the endpoint belongs
     to this profile via the `DevToolsActivePort` record Chrome writes when started with
     `--remote-debugging-port=0`. A Chrome holding the profile without that record blocks jobs with
     `oracle: browser unavailable` (`managed_browser_in_use`) until you quit it; Oracle never opens a second
     instance into an active profile.
   - **`managed_browser_changed`.** If the managed Chrome exits mid-job and a different browser answers on
     its DevTools port, the worker detects the browser-id change before the next browser command and stops
     rather than sending anything there. Resubmit the job to reopen the profile on a fresh port.
   - **Window focus and login check.** A job pays Chrome's start-up cost when the browser is closed, and the
     window takes focus when the first job tab opens; keep it un-minimized while jobs run. Readiness means
     the profile and Chrome are present, not that ChatGPT is signed in: the worker checks login before
     uploading and reports `ChatGPT login is required. Run /oracle-auth.` Oracle does not verify an expected
     account email.
   - **Exclusivity.** Agent-level only, mutually exclusive with `browser.chatGptRelayEndpoint`, and ChatGPT
     only (Grok keeps the isolated seed profile).

### Dedicated account in persistent Chrome

1. **Prerequisites.** A dedicated Chrome user-data directory outside your personal Chrome profile root. This
   is the manual setup recipe for `browser.chatGptRelayEndpoint` over native Chrome CDP: you keep a dedicated
   Chrome running on a fixed loopback port and Oracle attaches to it as a relay without an OMP relay
   extension or cookie import.
2. **Command.** Launch a separate Chrome process with persistent storage, a fixed loopback-only port (unlike
   the managed browser's `--remote-debugging-port=0`), and the three anti-backgrounding flags (macOS
   example):
   ```bash
   "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
     --user-data-dir="$HOME/Library/Application Support/omp-oracle/work-chrome" \
     --remote-debugging-address=127.0.0.1 --remote-debugging-port=9333 \
     --disable-backgrounding-occluded-windows --disable-renderer-backgrounding --disable-background-timer-throttling \
     --no-first-run --no-default-browser-check --new-window https://chatgpt.com/
   ```
   Sign in to ChatGPT only as the intended account in that window; Chrome sync is unnecessary.
3. **Config.** Point `browser.chatGptRelayEndpoint` at that loopback port in agent-level `oracle.json`:
   ```json
   { "browser": { "chatGptRelayEndpoint": "http://127.0.0.1:9333" } }
   ```
4. **Confirm it works.** Run `oracle_preflight` or check the session footer. While the browser is down, the
   session footer reads `oracle: browser unavailable`, one warning names the endpoint and cause, and the
   footer returns to ready on its own once the endpoint answers again.
5. **Limits.**
   - **Anti-backgrounding flags.** `--disable-backgrounding-occluded-windows`,
     `--disable-renderer-backgrounding`, and `--disable-background-timer-throttling` keep the job tab
     rendering while this window sits behind other windows (Chrome otherwise stops painting an occluded
     window's tab, which freezes ChatGPT's streamed turn until the worker reloads it). They do not cover a
     minimized window or a tab behind another tab, so leave this window un-minimized and let jobs own its
     tabs; the worker's reload reconciliation covers the rest.
   - **External process lifecycle.** Keep this Chrome running while jobs run, and relaunch it with the same
     command after quitting or rebooting. Oracle does not start or quit this external browser and never falls
     back to personal Chrome when its endpoint is down.
   - **Account isolation and identity.** This is a persistent, account-isolated browser with per-job owned
     tabs, not a disposable per-job seed clone. Do not point `--user-data-dir` at your personal Chrome
     directory or connect this profile to a personal relay extension. Oracle checks login readiness, not an
     expected account email; keep only the intended account signed in and keep the CDP port on loopback.
     Existing conversation links stay with their original account; changing endpoints does not transfer
     history or make old-account follow-ups accessible.
   - **Deep Research coverage.** Native CDP has been exercised with Instant upload, response collection,
     cleanup, and cross-origin frame capture. Deep Research with native Markdown export is recorded through
     the managed browser in the [release ledger](RELEASE.md#evidence-ledger); this manual persistent-Chrome
     setup has no recorded Deep Research run, and the default isolated seed profile does not support Deep
     Research frame capture.

## Cookie sources

### Linux

`/oracle-auth` delegates default cookie reads to `@steipete/sweet-cookie`'s Linux Chrome/Chromium backend.
The default importer auto-detects existing Google Chrome, Chromium, Chromium Browser, or Brave profile roots
under `${XDG_CONFIG_HOME:-~/.config}` and passes non-Google roots as absolute profile paths so the intended
cookie database is read. Set `auth.chromeProfile` to another profile name, a profile directory, or a
`Cookies` database path when needed, and leave `auth.chromiumKeychain` unset on Linux.

Sweet Cookie's Linux encrypted-cookie handling is controlled through environment variables and keyring
helpers:

- `SWEET_COOKIE_LINUX_KEYRING=gnome|kwallet|basic` selects GNOME/libsecret, KDE KWallet, or no keyring
  probing.
- GNOME probing shells out to `secret-tool`; KDE probing shells out to `kwallet-query` and `dbus-send`.
- A safe-storage password override bypasses keyring probing when you already know the browser's password.
  Sweet Cookie reads the one named for the profile's browser: `SWEET_COOKIE_CHROMIUM_SAFE_STORAGE_PASSWORD`
  for a profile under a Chromium root (`~/.config/chromium`, or the Snap or Flatpak Chromium root),
  `SWEET_COOKIE_BRAVE_SAFE_STORAGE_PASSWORD` for Brave, and `SWEET_COOKIE_CHROME_SAFE_STORAGE_PASSWORD`
  for Google Chrome and any other path. Before `omp-oracle` moved to Sweet Cookie 0.4, Chromium profiles used
  Chrome's keyring entry and override.

Do not put safe-storage passwords in project config or persistent shell startup files. Prefer keyring
helpers; when you pass an environment override for one `/oracle-auth` run, Oracle scrubs
`SWEET_COOKIE_*_SAFE_STORAGE_PASSWORD` from the environment before launching browser or helper subprocesses.

### Custom Chromium cookie sources (macOS)

Most Chrome/Chromium-compatible browsers work through Sweet Cookie's default Chrome backend when
`auth.chromeProfile` points at the right profile or cookie database. Sweet Cookie's Edge and Firefox
backends are not selected. The `auth.chromiumKeychain` option is macOS-only and supports Chromium-family
browsers outside Sweet Cookie's built-in Chrome, Brave, Arc, and Chromium targets.

Before running `/oracle-auth` with `auth.chromiumKeychain`:

1. Log into ChatGPT or Grok in the target browser profile, matching `defaults.provider`.
2. Fully quit the browser so its `Cookies` SQLite database and `Cookies-wal` / `Cookies-shm` sidecars are
   stable.
3. Find the profile's `Cookies` SQLite database path.
4. Find the browser's macOS Keychain safe-storage item `account` and `services` name(s).
5. Set `browser.executablePath`, `auth.chromeCookiePath`, and `auth.chromiumKeychain` together in agent-level
   `oracle.json`:

```json
{
  "browser": { "executablePath": "/Applications/Helium.app/Contents/MacOS/Helium" },
  "auth": {
    "chromeProfile": "Default",
    "chromeCookiePath": "/Users/you/Library/Application Support/net.imput.helium/Default/Cookies",
    "chromiumKeychain": { "account": "Helium", "services": ["Helium Storage Key"], "label": "Helium Storage Key" }
  }
}
```

On macOS, `auth.chromiumKeychain` requires `auth.chromeCookiePath`; partial config is rejected so
`/oracle-auth` cannot silently fall back to another browser source. When both are set, `/oracle-auth` uses
the built-in generic Chromium cookie reader and prompts for macOS Keychain access if needed. On Linux,
`auth.chromiumKeychain` is rejected.

## Job outputs and retention

- **Job directory contents.** Each job writes `job.json`, `prompt.md`, the context archive
  (`context-<job-id>.tar.zst` or `context-<job-id>.tar.gz`, deleted once the upload is confirmed), `response.md`,
  `response.capture.json`, `artifacts.json`, `artifacts/`, and `logs/worker.log` under
  `${PI_ORACLE_JOBS_DIR:-/tmp}/oracle-<job-id>/` with private permissions (`0700` directories, `0600` files).
  Results outlive the agent turn, subject to age-based retention, `/oracle-clean`, and the lifetime of the
  jobs directory (default `/tmp`). Full layout:
  [Architecture → Job layout](ARCHITECTURE.md#job-layout-under-the-configured-jobs-dir).
- **Capacity and queueing.** Up to `browser.maxConcurrentJobs` (default `2`) run at once; extra jobs queue
  automatically. `oracle_preflight` reports global capacity (`Capacity: 1/2 active, 0/2 queued (global).`)
  before building an archive.
- **Wake-ups and reading (`oracle_read`, `/oracle-read`, `/oracle-status`).** Completion delivery into the
  host session is one best-effort wake-up per finished job, sent only while the session is idle with nothing
  queued. Agents must not poll; if the user asks for status before the wake-up, call `oracle_read({ jobId })`
  with the submitted job's id. Jobs that finish together arrive as one batched message, and an `oracle_read`
  (or `/oracle-read` / `/oracle-status`) by the job's own session settles the wake-up first. The job directory is the durable
  record: run `/oracle-status [job-id]` to inspect a job or list recent job ids, `/oracle-read [job-id]` to
  read the saved response preview, or `oracle_read({ jobId })` from an agent turn.
- **Continuing and cancelling.** Run `/oracle-followup <job-id> <request>` (or pass `followUpJobId` to
  `oracle_submit`) to continue a job in the same provider thread, or pass `chatGptConversationId` to continue
  an existing browser ChatGPT URL/id. Run `/oracle-cancel <job-id>` (or `oracle_cancel({ jobId })`) to stop a
  queued or active job.
- **Cleaning and retention.** `/oracle-clean <job-id|all>` runs runtime cleanup and deletes terminal job
  directories. It refuses non-terminal jobs, jobs whose worker is still live, and jobs inside the short
  post-send retention grace window right after a wake-up was sent, returning a `Retry after ...` timestamp.
  A teardown that leaves a cleanup warning is retried automatically at most five times (`15 s`, `1 min`,
  `5 min`, `15 min` apart); `/oracle-clean` retries on request. Terminal job directories are pruned by age:
  `cleanup.completeJobRetentionMs` (default `1209600000` ms, 14 days, for `complete` and `cancelled` jobs)
  and `cleanup.failedJobRetentionMs` (default `2592000000` ms, 30 days, for `failed` jobs).
- **`generationStatus`, `collectionStatus`, `promptSendState`, and recollection.** `generationStatus` tracks
  provider generation while `collectionStatus` (`complete`, `partial`, or `failed`) tracks local turn
  capture. `response.capture.json` records the turn binding (`conversationId`, `responseIndex`, `messageId`,
  content hash), fidelity, source URLs, code blocks, and artifact inspection. Missing optional items
  (`native_markdown_export`, `artifact:<id>`) leave `response.md` intact; required gaps
  (`bound_response_capture`, `rich_response_fidelity`) mean the saved answer is degraded;
  `recollection-needed` means the bound turn could not be captured and no `response.md` was saved rather than
  substituting text from another page. `promptSendState` in `job.json` (`prompt-send-state` in `oracle_read`)
  is `not_sent`, `attempted`, or `accepted`, showing whether resubmitting is safe. To retry capture of a
  completed turn without sending a prompt, run `oracle_read({ jobId, action: "recollect" })`.

## Driving oracle from a program

A driver that submits and reads oracle jobs from its own code (a diligence pipeline, a batch script) must not
ask a model to type the tool call: a model that retypes a path once leaves a dispatch marker and no result, and
the driver cannot tell whether the prompt was sent. `/oracle-run` executes the registered tool host-side instead:

```sh
omp --cwd /abs/project -p --mode json --session-dir /abs/session "/oracle-run submit /abs/submit.request.json /abs/submit.result.json /abs/submit.marker.json"
```

- The request file holds the tool's parameters (`oracle_submit`: `prompt`, `files`, optional `preset`, `provider`,
  `followUpJobId`, `chatGptConversationId`; `oracle_read`: `jobId`, optional `projectId`, `action`;
  `oracle_preflight`: optional `provider`, `followUpJobId`, `chatGptConversationId`). It goes through the tool's
  `prepareArguments` and an explicit request-shape check (the schema's keys and required fields), and a
  refused shape dispatches nothing.
- The result file receives the exact tool result (`content`, `details`, `isError`) atomically; the command prints one
  JSON line (`{"operation","ok","jobId","status","ready","error"}`) to stdout in print mode or as an
  `oracle-command-output` message in JSON mode. A nonzero job outcome is in the result, not in the exit status.
- `marker.json` (submit and read only) is created with `O_EXCL` immediately before the tool runs. No marker after the
  command returns means nothing was dispatched and the request may be repeated; a marker without a result means the
  prompt may have been sent, so inspect the job directory before any retry.
- All three paths must be absolute. An existing result or marker file is never overwritten; the driver chooses a
  fresh path per attempt.
- Submissions need a persisted session (`--session-dir`); the job's wake-up targets that session, so a print-mode
  driver reads completion from the job directory (`oracle_read` or the job's `job.json`), never from a wake-up.

## Troubleshooting

| Symptom | First thing to do | Section |
| --- | --- | --- |
| `/oracle-auth` fails or says login is required | Confirm the provider is signed in inside the configured browser profile, then rerun `/oracle-auth` | [Auth fails or login required](#oracle-auth-fails-or-says-login-is-required) |
| Custom Chromium auth syncs cookies but session is rejected | Quit the source browser completely and verify `auth.chromeCookiePath` and Keychain/keyring settings | [Cookies synced but session rejected](#custom-chromium-auth-says-cookies-synced-but-the-session-is-rejected) |
| Challenge or human verification page blocks a run | Solve the challenge in the bootstrap or relay browser, then rerun `/oracle-auth` | [Challenge or verification page](#you-hit-a-challenge-or-verification-page) |
| `Oracle requires a persisted pi session` | Restart `omp` or `pi` without `--no-session` | [Persisted session required](#you-see-oracle-requires-a-persisted-pi-session) |
| Job finished on disk but no wake-up arrived | Run `/oracle-status` and `/oracle-read <job-id>` | [No wake-up arrived](#a-job-finished-but-no-wake-up-arrived) |
| `/oracle-clean` refuses a completed job | Wait until the `Retry after ...` timestamp, then rerun `/oracle-clean` | [`/oracle-clean` retention grace](#oracle-clean-refuses-a-terminal-job-right-after-completion) |
| `agent-browser`, `tar`, `zstd`, or `cp` is missing | Install the missing binary or set `AGENT_BROWSER_PATH` / `PI_ORACLE_CP_PATH` | [Missing local dependency](#a-local-dependency-like-agent-browser-tar-or-zstd-is-missing) |
| `/oracle-auth` reads the wrong browser profile | Set `auth.chromeProfile` or `auth.chromeCookiePath` in agent-level `oracle.json` | [Wrong browser profile](#auto-detection-picked-the-wrong-browser-profile) |
| Deep Research fails with `deep_research_*` | Check `errorCode`, `chatUrl`, and `prompt-send-state` before retrying | [Deep Research failure codes](#a-deep-research-job-ended-with-deep_research_report_unreadable) |
| Completed job reports `collection-status: partial` or `failed` | Run `oracle_read({ jobId, action: "recollect" })`; do not resubmit | [Partial or failed collection](#a-completed-job-reads-collection-status-partial-or-failed) |
| Unsure whether a failed job already sent its prompt | Check `prompt-send-state` in `oracle_read({ jobId })` | [May the prompt have been sent?](#a-failed-job-may-the-prompt-have-been-sent) |
| Another browser tool navigated the job tab | Check `/oracle-status` first and avoid attaching another tool to the active Chrome | [Managed Chrome driven while jobs run](#do-not-drive-the-managed-chrome-while-jobs-run) |
| Prompt has draft text in front of it in relay mode | Clear the saved draft in Chrome's ChatGPT composer | [Unrelated draft prefix in relay mode](#the-prompt-arrived-with-unrelated-text-in-front-of-it-relay-mode) |
| Need full worker or auth logs for a failed run | Inspect `${PI_ORACLE_JOBS_DIR:-/tmp}/oracle-<job-id>/logs/worker.log` or `/tmp/pi-oracle-auth-*/oracle-auth.log` | [Inspect failure logs](#you-want-more-details-about-a-failed-run) |

### `/oracle-auth` fails or says login is required

- Confirm the selected provider is signed in inside the browser profile named by `auth.chromeProfile`.
- For custom Chromium cookie sources, verify `auth.chromeCookiePath` points at that profile's `Cookies`
  SQLite database. On macOS, verify `auth.chromiumKeychain.services` names the browser's safe-storage
  Keychain service. On Linux, leave `auth.chromiumKeychain` unset and configure `SWEET_COOKIE_LINUX_KEYRING` or
  the safe-storage password override for the profile's browser ([Linux](#linux)).
- If the provider is half-logged-in or waiting on a challenge, finish sign-in in the headed auth browser (or
  in Chrome for relay and managed modes), then rerun `/oracle-auth` (or call `oracle_auth({})` once from an
  agent turn).

### Custom Chromium auth says cookies synced but the session is rejected

1. Open the configured browser profile and confirm the provider loads without signing in again.
2. Quit the browser completely so its `Cookies` database and WAL sidecars are flushed.
3. Verify `auth.chromeCookiePath` in agent-level `oracle.json` points at that profile's `Cookies` file.
4. On macOS, verify `auth.chromiumKeychain.services` matches the Keychain item for that browser; on Linux,
   verify the keyring helper (`secret-tool` or `kwallet-query`) or safe-storage password variable is set.
5. Rerun `/oracle-auth`.

### You hit a challenge or verification page

Complete the challenge in the headed bootstrap browser (or in the relay/managed Chrome window), then rerun `/oracle-auth` before submitting the job again.

### You see "Oracle requires a persisted pi session"

Exit the `--no-session` run (`omp --no-session` or `pi --no-session`), start a normal persisted session, and run `/oracle` again.

### A job finished but no wake-up arrived

Run `/oracle-status` to list recent job ids for the project, then run `/oracle-read <job-id>` (or call `oracle_read({ jobId })`) to read the saved response from disk.

If a helper submitted from another cwd, first read its id normally. The error names the owning
`projectId`; explicitly pass that exact root to `oracle_read({ jobId, projectId: "/owning/root" })`,
or `/oracle-status <job-id> --projectId "/owning/root"` (also supported by `/oracle-read`).
Without an id, `/oracle-status --projectId "/owning/root"` lists that project's recent jobs.
Lookup covers the configured `${PI_ORACLE_JOBS_DIR:-/tmp}` only: use the same jobs root as
the submitting helper. It does not return the other project's answer silently or change cancel,
cleanup, or wake-up ownership.

For UI provenance, inspect `observedSelection` in `job.json` or the read/status output:
`observed-product`, `observed-model`, `deep-research-verified`, and `deep-research-iframe-title`.
The existing `modelLabel`, `effortLabel`, and `at` record the selector text, slider stop, and
latest observation time. `product` and `deepResearchIframeTitle` add explicit product and frame
evidence. Deep Research deliberately has no ordinary model label: a verified composer tool,
not the requested underlying model family, selects that product. Missing fields mean not
observed, not a failed job; legacy jobs remain readable. No CDP inspection is needed to read
these saved facts, and the metadata contains no answer text or auth data.

### `/oracle-clean` refuses a terminal job right after completion

`/oracle-clean` blocks removal during the short post-send retention grace window after a wake-up was sent and returns a `Retry after ...` timestamp. Wait until the `Retry after ...` timestamp passes, then rerun `/oracle-clean <job-id|all>`.

### A local dependency like `agent-browser`, `tar`, or `zstd` is missing

Install the missing binary on `PATH` (or set `AGENT_BROWSER_PATH` for `agent-browser` and `PI_ORACLE_CP_PATH` for macOS APFS `cp`), then rerun the command. `zstd` is required only for ChatGPT `.tar.zst` archives; Grok uses `.tar.gz`.

### Auto-detection picked the wrong browser profile

Set `auth.chromeProfile` (and `auth.chromeCookiePath`, plus `auth.chromiumKeychain` on macOS for custom Chromium browsers) in agent-level `oracle.json`, then rerun `/oracle-auth`.

### A Deep Research job ended with `deep_research_report_unreadable`

- **`deep_research_report_unreadable`:** The worker could not read the report from the research widget
  because the job ran on the isolated seed profile instead of a shared Chrome transport
  (`browser.chatGptRelayEndpoint` or `browser.chatGptManagedProfileDir`), the widget frame did not attach
  within 60 s of sending, or research exceeded `worker.completionTimeoutMs` (90 minutes by default). Do not
  resubmit when the prompt was already sent: check `prompt-send-state` in `oracle_read({ jobId })`, open the
  `chatUrl` recorded in `job.json` / `error` to inspect the conversation in Chrome, and run
  `oracle_read({ jobId, action: "recollect" })` if the report finished there; if the job ran on the isolated
  seed profile, configure a shared Chrome transport in agent-level `oracle.json` first.
- **`deep_research_clarification_requested`:** The model replied with a question instead of starting research
  (the reply is quoted in `error`). Restate the request with explicit assumptions and include "do not ask
  clarifying questions", then submit a new job.
- **`deep_research_toggle_not_found`:** The composer tools menu had no Deep research entry or the composer
  pill did not appear. Confirm the ChatGPT account has Deep Research available and the page is a standard
  chat, then rerun `/oracle`.

### A completed job reads `collection-status: partial` or `failed`

Generation finished, so do not resubmit the prompt. Required gaps (`bound_response_capture`,
`rich_response_fidelity`) mean the saved answer is degraded; optional gaps (`native_markdown_export`,
`artifact:<id>`) mean a secondary file is missing while `response.md` is intact;
`recollection-needed` means the turn could not be captured and no response was saved.

Run `oracle_read({ jobId, action: "recollect" })` to open a fresh disposable browser session, reacquire the
bound turn (by `messageId`, content hash, or the user turn carrying `context-<id>.tar.zst`; pre-binding jobs
require both `responseIndex` and `messageId`), and repeat collection only. For Deep Research, recollection
re-triggers **Export → Export to Markdown** (Chrome keeps its own copy in its download directory; the
validated bytes land under `artifacts/<sha256>-<file name>`) and falls back to the widget's Markdown with
citation footnotes if the export cannot be collected.

### A failed job: may the prompt have been sent?

Inspect `prompt-send-state` in `oracle_read({ jobId })` (or `promptSendState` in `job.json`): resubmit immediately when it is `not_sent`; open `chatUrl` in Chrome to check the thread first when it is `attempted`; and use `oracle_read({ jobId, action: "recollect" })` or `/oracle-followup` when it is `accepted`.

### Do not drive the managed Chrome while jobs run

Connecting another browser automation tool (for example an agent's browser tool attached to the same CDP endpoint) to the managed or relay Chrome adopts its visible tab and can navigate a running job's tab away from its conversation, forcing the worker to reopen the conversation and reattach any Deep Research frame. Run `/oracle-status` to confirm no job is active before attaching another browser tool, or inspect conversations in a separate browser.

### The prompt arrived with unrelated text in front of it (relay mode)

ChatGPT restores saved composer drafts in a signed-in Chrome session. The worker clears the composer before filling; if a draft prefix still appears, delete the draft in Chrome's ChatGPT composer and check `prompt-send-state` before retrying.

### You want more details about a failed run

Read `${PI_ORACLE_JOBS_DIR:-/tmp}/oracle-<job-id>/logs/worker.log` and `job.json` for job failures, or `/tmp/pi-oracle-auth-*/oracle-auth.log` (printed by `/oracle-auth`) for auth bootstrap failures.

## Configuration reference

Defaults and validation live in `DEFAULT_CONFIG` and `validateOracleConfig` in
[`extensions/oracle/lib/config.ts`](../extensions/oracle/lib/config.ts). Project config files may set only
`defaults`, `worker`, `poller`, `artifacts`, and `cleanup`; `browser` and `auth` are agent-level only.

```json
{
  "defaults": { "provider": "chatgpt", "preset": "pro_extended", "grokMode": "heavy" },
  "browser": {
    "sessionPrefix": "oracle",
    "authSeedProfileDir": "~/.omp/agent/extensions/oracle-auth-seed-profile",
    "runtimeProfilesDir": "~/.omp/agent/extensions/oracle-runtime-profiles",
    "maxConcurrentJobs": 2,
    "cloneStrategy": "apfs-clone",
    "chatUrl": "https://chatgpt.com/",
    "authUrl": "https://chatgpt.com/auth/login",
    "runMode": "headless",
    "executablePath": "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "args": ["--disable-blink-features=AutomationControlled"]
  },
  "auth": { "pollMs": 1000, "bootstrapTimeoutMs": 600000, "chromeProfile": "Default" },
  "worker": { "pollMs": 5000, "completionTimeoutMs": 5400000 },
  "poller": { "intervalMs": 5000 },
  "artifacts": { "capture": true },
  "cleanup": { "completeJobRetentionMs": 1209600000, "failedJobRetentionMs": 2592000000 }
}
```

### `defaults` (agent or project)

| Key | Default | Bounds / allowed values | Meaning |
| --- | --- | --- | --- |
| `defaults.provider` | `"chatgpt"` | `"chatgpt"` \| `"grok"` | Default provider when `oracle_submit`, `oracle_preflight`, or `/oracle-auth` omits `provider` |
| `defaults.preset` | `"pro_extended"` | Canonical id in `ORACLE_SUBMIT_PRESETS`: `"pro_standard"`, `"pro_extended"`, `"thinking_light"`, `"thinking_standard"`, `"thinking_extended"`, `"thinking_heavy"`, `"instant"`, `"instant_auto_switch"`, `"deep_research"` | Default ChatGPT preset when `oracle_submit` omits `preset` |
| `defaults.grokMode` | `"heavy"` | `"heavy"` | Grok execution mode when the provider is `"grok"` |

### `browser` (agent-level only)

| Key | Default | Bounds / allowed values | Meaning |
| --- | --- | --- | --- |
| `browser.sessionPrefix` | `"oracle"` | Non-empty string (legacy alias: `browser.sessionName`) | Prefix for `agent-browser` session names (`<sessionPrefix>-auth` and `<sessionPrefix>-<jobId>`) |
| `browser.authSeedProfileDir` | `<agent dir>/extensions/oracle-auth-seed-profile` (`-grok` appended for Grok) | Safe absolute path (`~` expanded); not `/`, `$HOME`, a real browser user-data path, or overlapping `runtimeProfilesDir` / `chatGptManagedProfileDir` (legacy alias: `browser.profileDir`) | Isolated seed profile directory populated by `/oracle-auth` |
| `browser.runtimeProfilesDir` | `<agent dir>/extensions/oracle-runtime-profiles` (or `<authSeedProfileDir>/../oracle-runtime-profiles`) | Safe absolute path (`~` expanded); separate from `authSeedProfileDir`, real browser user-data paths, and `chatGptManagedProfileDir` | Parent directory for per-job cloned runtime profiles |
| `browser.maxConcurrentJobs` | `2` | Integer `1`–`32` | Maximum active jobs at once; additional jobs queue up to the same limit |
| `browser.cloneStrategy` | `"apfs-clone"` on macOS, `"copy"` on Linux and Windows | `"apfs-clone"` \| `"copy"` | How isolated-seed jobs clone the seed profile (`cp -cR` on macOS vs Node recursive copy) |
| `browser.chatUrl` | `"https://chatgpt.com/"` (`"https://grok.com/"` for Grok) | `https:` URL on `https://chatgpt.com` or `https://chat.openai.com` | Entry URL opened for fresh ChatGPT conversations |
| `browser.authUrl` | `"https://chatgpt.com/auth/login"` (`"https://grok.com/"` for Grok) | `https:` URL on `https://chatgpt.com` or `https://chat.openai.com` | Entry URL opened by `/oracle-auth` when interactive sign-in is needed |
| `browser.runMode` | `"headless"` | `"headless"` \| `"headed"` | Launch mode for isolated-seed runtime browsers (managed browser always launches headed) |
| `browser.chatGptRelayEndpoint` | `undefined` (unset) | Optional loopback `http://` origin on `127.0.0.1`, `localhost`, or `[::1]` with no credentials, path, query, or hash; mutually exclusive with `chatGptManagedProfileDir` | Opt-in ChatGPT CDP relay or native Chrome CDP endpoint |
| `browser.chatGptManagedProfileDir` | `undefined` (unset) | Optional safe absolute path (`~` expanded); separate from real browser roots, both seed profiles, and `runtimeProfilesDir`; mutually exclusive with `chatGptRelayEndpoint` | Opt-in Oracle-managed Chrome user-data directory for ChatGPT |
| `browser.executablePath` | Auto-detected (`/Applications/Google Chrome.app/Contents/MacOS/Google Chrome` on macOS; `PATH` discovery on Linux; `undefined` on Windows) | Optional absolute path (`~` expanded) | Chrome or Chromium binary used for isolated, managed, and auth browsers |
| `browser.userAgent` | Auto-detected from `<executablePath> --version` on macOS/Windows (`undefined` on Linux or when unset) | Optional non-empty string | User-Agent override passed to isolated browser sessions |
| `browser.args` | `["--disable-blink-features=AutomationControlled"]` | Array of non-empty strings | Extra Chromium flags passed to isolated runtime browsers |

### `auth` (agent-level only)

| Key | Default | Bounds / allowed values | Meaning |
| --- | --- | --- | --- |
| `auth.pollMs` | `1000` (1 s) | Integer `>= 100` | Poll interval in milliseconds while `/oracle-auth` waits for sign-in |
| `auth.bootstrapTimeoutMs` | `600000` (10 minutes) | Integer `>= 1000` | Timeout in milliseconds for `/oracle-auth` interactive sign-in or challenge completion |
| `auth.chromeProfile` | Auto-detected (`"Default"` or detected Linux profile path) | Non-empty string | Local browser profile name, profile directory, or `Cookies` DB path for cookie import |
| `auth.chromeCookiePath` | `undefined` (unset) | Optional absolute path (`~` expanded); required when `auth.chromiumKeychain` is set | Explicit path to a Chromium `Cookies` SQLite database |
| `auth.chromiumKeychain` | `undefined` (unset) | Optional `{ account: string, services: string[], label?: string }` (`services` non-empty); macOS only; requires `auth.chromeCookiePath` | macOS Keychain safe-storage item descriptor for custom Chromium browsers |

### `worker` (agent or project)

| Key | Default | Bounds / allowed values | Meaning |
| --- | --- | --- | --- |
| `worker.pollMs` | `5000` (5 s) | Integer `>= 100` | Worker poll interval in milliseconds while waiting for provider generation |
| `worker.completionTimeoutMs` | `5400000` (90 minutes) | Integer `>= 1000` | Maximum milliseconds a worker waits for generation or Deep Research before timing out |

### `poller` (agent or project)

| Key | Default | Bounds / allowed values | Meaning |
| --- | --- | --- | --- |
| `poller.intervalMs` | `5000` (5 s) | Integer `>= 100` | Host-session background poller interval in milliseconds for status and wake-ups |

### `artifacts` (agent or project)

| Key | Default | Bounds / allowed values | Meaning |
| --- | --- | --- | --- |
| `artifacts.capture` | `true` | Boolean (`true` \| `false`) | Whether the worker downloads response-local artifacts into `artifacts/` |

### `cleanup` (agent or project)

| Key | Default | Bounds / allowed values | Meaning |
| --- | --- | --- | --- |
| `cleanup.completeJobRetentionMs` | `1209600000` (14 days) | Integer `>= 0` | Retention window in milliseconds for terminal `complete` and `cancelled` job directories |
| `cleanup.failedJobRetentionMs` | `2592000000` (30 days) | Integer `>= 0` | Retention window in milliseconds for terminal `failed` job directories |

## Environment variables

| Variable | Default | Effect |
| --- | --- | --- |
| `PI_ORACLE_JOBS_DIR` | `/tmp` | Job directory root (`${PI_ORACLE_JOBS_DIR:-/tmp}/oracle-<job-id>/`) |
| `PI_ORACLE_STATE_DIR` | `/tmp/pi-oracle-state` | Lock, queue, runtime-lease, conversation-lease, and managed-browser state root |
| `PI_ORACLE_CP_PATH` | `cp` on `PATH` | `cp` binary used on macOS when `browser.cloneStrategy` is `"apfs-clone"` |
| `PI_ORACLE_NODE_PATH` | `process.execPath` (when `node`) or `node` | Node executable used to spawn detached workers |
| `PI_ORACLE_MANAGED_BROWSER_IDLE_MS` | `120000` (2 minutes) | Positive integer milliseconds before the managed-browser keeper quits an Oracle-started Chrome with no jobs or pages |
| `AGENT_BROWSER_PATH` | `/opt/homebrew/bin/agent-browser`, `/usr/local/bin/agent-browser`, or `PATH` | `agent-browser` executable path override |
| `SWEET_COOKIE_LINUX_KEYRING` | Unset | `@steipete/sweet-cookie` Linux keyring selection (`gnome`, `kwallet`, or `basic`) |
| `SWEET_COOKIE_CHROME_SAFE_STORAGE_PASSWORD`, `SWEET_COOKIE_CHROMIUM_SAFE_STORAGE_PASSWORD`, `SWEET_COOKIE_BRAVE_SAFE_STORAGE_PASSWORD`, `SWEET_COOKIE_EDGE_SAFE_STORAGE_PASSWORD` | Unset | One-run safe-storage password overrides; every `SWEET_COOKIE_*_SAFE_STORAGE_PASSWORD` variable is scrubbed from subprocess environments before browser or helper commands run |
| `XDG_CONFIG_HOME` | `~/.config` | Linux config root searched when auto-detecting Chrome, Chromium, and Brave profiles |
| `PI_CODING_AGENT_DIR` | Host agent directory (`~/.omp/agent` or `~/.pi/agent`) | Agent directory fallback used by the auth worker when host `configLoad` metadata is absent |
| `PI_ORACLE_AUTH_AGENT_BROWSER_TIMEOUT_MS`, `PI_ORACLE_AUTH_CLOSE_TIMEOUT_MS`, `PI_ORACLE_AUTH_KILL_GRACE_MS`, `PI_ORACLE_AUTH_COOKIE_READ_TIMEOUT_MS` | `30000`, `10000`, `2000`, `30000` | Positive integer millisecond timeouts for `/oracle-auth` browser commands, close, kill grace, and cookie reads |

The runtime names keep upstream's `PI_ORACLE_` prefix so existing configurations continue working. Validation
and release scripts also read `PI_ORACLE_PROOF_*`, `PI_ORACLE_CHATGPT_PRESET_PROOF*`,
`PI_ORACLE_REAL_TEST_*`, `PI_ORACLE_SMOKE_*`, and `PLATFORM_SMOKE_*`; see [Test plan](TEST_PLAN.md),
[Platform smoke](PLATFORM_SMOKE.md), and [Release](RELEASE.md).

## Switch install source

If upstream `pi-oracle` is installed, remove it first so `/oracle` and the `oracle_*` tools register once:

```bash
omp plugin uninstall pi-oracle
pi remove npm:pi-oracle
```

- **Published npm release (`0.4.12`):**
  ```bash
  omp install omp-oracle
  pi install npm:omp-oracle
  ```
- **Track `main` from GitHub:**
  ```bash
  omp install https://github.com/alphastorm/omp-oracle
  pi install https://github.com/alphastorm/omp-oracle
  ```
  Update a Git install by rerunning `omp install --force https://github.com/alphastorm/omp-oracle` on Oh My
  Pi or `pi update --extensions` on `pi`.
- **Link a local checkout:**
  ```bash
  git clone https://github.com/alphastorm/omp-oracle
  omp install ./omp-oracle
  pi install -l ./omp-oracle
  ```
  Switching back from a linked checkout to a registry release on Oh My Pi requires uninstalling first:
  `omp plugin install omp-oracle@<v>` reports success but leaves the checkout symlink in place and keeps
  reporting the checkout's version. Run `omp plugin uninstall omp-oracle` before running
  `omp install omp-oracle`. For isolated development sessions that load the checkout without modifying your
  normal agent state, use [Test plan → Isolated `pi` session smoke](TEST_PLAN.md#isolated-pi-session-smoke).
