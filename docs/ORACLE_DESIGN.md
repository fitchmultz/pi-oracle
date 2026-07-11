# pi-oracle design

Status: isolated-profile concurrency architecture implemented in code and validated against the current pi baseline.
Date: 2026-06-04

Companion doc:
- `docs/ORACLE_RECOVERY_DRILL.md` — safe expired-auth recovery validation drill

Compatibility target:
- `pi` 0.80.6+ is the suggested tested floor for current project-trust-aware package/runtime validation
- package metadata keeps pi runtime packages as optional wildcard peers, so this suggested floor is not enforced as a hard npm install requirement
- current extension lifecycle only; no backward-compatibility shims for removed `session_switch` / `session_fork` events

## Goal

Create a `pi` extension that lets the user or agent consult ChatGPT.com or Grok through the web product instead of the API, with:

- manual invocation via `/oracle ...`
- automatic invocation by the agent in rare high-difficulty cases
- mandatory project-context archive upload (`.tar.zst` for ChatGPT, `.tar.gz` for Grok)
- long-running execution in the background
- durable response/artifact persistence plus best-effort wake-the-agent behavior when the oracle response is ready
- oracle requires a persisted pi session identity; in-memory/no-session contexts are rejected instead of risking cross-session wake-up misdelivery
- legacy project-scoped jobs from the older no-session model remain inspectable by project, but are treated as manual/status-only instead of being rebound to a different persisted session for wake-up delivery
- persisted responses and artifacts under `/tmp`
- optional same-thread follow-up questions later

## Architecture decision

The production architecture is now:

- use `agent-browser`
- do **not** automate the user’s real Chrome in production
- maintain one authenticated **seed profile** via `/oracle-auth`
- clone that seed into a **per-job runtime profile** for each oracle run
- launch each job in its own **runtime browser session**
- persist same-thread continuity by saved `chatUrl`, not by keeping tabs or browsers alive
- allow parallel jobs only when they do not target the same provider conversation

## Rejected production path

The old real-Chrome/CDP architecture is rejected for production.

Why:

- `agent-browser tab new <url>` opens a new tab and selects it
- `agent-browser tab <index>` switches the active tab
- upstream `agent-browser` source calls `Page.bringToFront` during tab switching
- this stole focus in the user’s real environment and disrupted typing

That violates a hard requirement.

Real-Chrome automation was useful for investigation and earlier smoke tests, but it is no longer the target architecture.

## Current extension surface

The extension now follows the current `pi` session lifecycle model:

- session transitions are handled from `session_start`
- previous runtimes are expected to clean up in `session_shutdown`
- no new logic depends on removed post-transition events

### Oracle dispatch commands

- `/oracle <request>`
  - in TUI mode, intercepted by the extension before prompt-template expansion so verbose internal workflow rules stay hidden from the visible transcript
  - injects the detailed dispatch instructions as a hidden custom message
  - in print/json/rpc modes, the extension contributes the prompt templates so non-interactive prompt expansion still works
  - asks the agent to gather context and dispatch an oracle job
- `/oracle-followup <job-id> <request>`
  - follows the same hidden-instructions TUI path and print/json prompt-template fallback
  - asks the agent to continue an earlier oracle job in the same provider thread via `followUpJobId`
  - keeps same-thread continuation available to normal users without requiring raw tool-call syntax

### Commands

- `/oracle-auth [chatgpt|grok]`
  - syncs ChatGPT or Grok cookies from the configured local browser profile into the isolated oracle profile and verifies them there, based on the configured default provider or explicit command argument
- `/oracle-read [job-id]`
  - shows job status plus the saved response preview
- `/oracle-status [job-id]`
  - shows job status and lists recent job ids when the caller omits an explicit id
- `/oracle-cancel <job-id>`
  - cancels a queued or active job by id; does not guess a default target
- `/oracle-clean <job-id|all>`
  - removes temp files for terminal jobs only

### Tools

- `oracle_preflight`
  - lightweight agent-facing readiness check for persisted-session and local oracle prerequisites
  - accepts optional `provider` and `followUpJobId` so readiness checks use the same auth seed/provider that submission will use
  - intended to run before expensive `/oracle` context gathering
- `oracle_auth`
  - agent-facing auth refresh tool that mirrors `/oracle-auth` for stale-auth recovery before a retry
- `oracle_submit`
  - low-level agent-facing dispatch tool
  - creates archive and launches a detached worker
  - supports optional `followUpJobId` to continue the same provider thread by persisted URL
- `oracle_read`
  - reads job status and outputs
- `oracle_cancel`
  - cancels a queued or active job

## High-level flow

### `/oracle ...`

`/oracle <request>` should not directly drive ChatGPT or Grok.
In TUI mode, the extension intercepts it before prompt-template expansion, re-injects the compact slash request as the visible user message so prompt-history/up-arrow recall survives session reloads, injects hidden dispatch instructions before the agent starts, and shows only compact user-facing status. In print/json/rpc modes, the extension exposes the prompt template so one-shot `/oracle` still expands and runs normally.

It instructs the agent to:

1. call `oracle_preflight` immediately, passing `provider: "grok"` when the user explicitly asks for Grok
2. stop right away if preflight reports the session or local oracle setup is not ready
3. understand whether the request is explicitly narrow or genuinely broad
4. if auth is missing, stale, or the worker explicitly said to rerun `/oracle-auth`, stop and tell the user to run `/oracle-auth` rather than launching auth automatically
5. gather enough repo context to submit well and bias toward context-rich archives when they fit within the provider ceiling: 250 MiB for ChatGPT and 200 MiB for Grok
6. if the request is narrow, start from the directly relevant area but still include nearby tests, docs, config, and adjacent modules when they may improve answer quality
7. if the request is broad/repo-wide, gather broader context and usually archive `.`
8. if `oracle_submit` fails before dispatch with an `archive_too_large` / upload-limit error, treat that as retryable: use the reported size summary plus any auto-pruned paths to cut scope and retry automatically with a smaller archive
9. stop retrying after at most two total submit attempts for the same request; if it still does not fit, report what was cut and why
10. craft the oracle prompt
11. call `oracle_submit`
12. stop and wait for the completion wake-up (best-effort; durable oracle response/artifact state is already persisted outside session history)

### `/oracle-auth`

Auth bootstrap flow:

1. load oracle config
2. acquire the global auth-maintenance lock
3. read ChatGPT or Grok cookies directly from the configured local browser cookie store in read-only mode, depending on `defaults.provider`
   - configurable source profile / cookie DB path
   - optional configured Chromium Keychain source for browsers outside the default importer
   - no launch or mutation of the real browser profile
4. validate that `browser.authSeedProfileDir` is an absolute safe path and not inside the real Chrome user-data tree
5. create a staged seed-profile path next to the target seed profile
6. launch the isolated auth browser headed with:
   - dedicated auth `--session`
   - dedicated staged seed `--profile`
   - configured executable path / user agent / launch args if set
7. clear isolated browser cookies and seed the staged profile with imported provider cookies
8. open the configured provider in the isolated browser
9. verify auth with provider-specific readiness checks
10. on success, close the isolated browser so Chrome flushes profile state cleanly
11. atomically swap the staged profile into `browser.authSeedProfileDir`, keeping `*.prev` as rollback
12. write a seed-generation marker used by future runtime clones
13. if the provider presents a challenge page, leave the staged auth browser/profile open for the user to solve and reuse

This keeps production oracle jobs off the user’s real Chrome while using the user’s existing authenticated provider cookies as the bootstrap source.

The authenticated seed profile remains the source of truth for future oracle runtimes.

### `oracle_submit`

Agent-facing submissions resolve a provider first. ChatGPT submissions use **`preset`**; the canonical registry is `ORACLE_SUBMIT_PRESETS` in `extensions/oracle/lib/config.ts`. Grok submissions use **`mode: "heavy"`** today and reject ChatGPT-only presets. For ChatGPT, **`preset` is the only model-selection parameter** on `oracle_submit`; there are no `modelFamily`, `effort`, or `autoSwitchToThinking` fields. Submit-time inputs accept canonical preset ids plus matching human-readable labels/common hyphen-space variants, and the tool normalizes them back to the canonical id before persisting job state. Prompt-template guidance biases toward omitting provider/model fields and using configured defaults unless the task or user explicitly asks for one. It also biases toward context-rich archives up to the provider ceiling, narrowing only when the user explicitly asks for a tight archive, privacy/sensitivity requires it, or size pressure forces it. When local archive creation still exceeds that ceiling after default exclusions and whole-repo auto-pruning, prompt guidance now treats the failure as a retryable archive-selection miss rather than a terminal dead end: agents should cut scope automatically, retry once or twice, and only surface the cut decisions if the archive still cannot fit.

1. resolve the provider and preset/mode (submit-time or config default) into an execution snapshot
2. resolve optional thread targeting:
   - `followUpJobId` into a prior oracle job `chatUrl` and `conversationId`, or
   - `chatGptConversationId` into a user/browser-created ChatGPT `https://chatgpt.com/c/<id>` URL
   Omit both for the default fresh-thread behavior.
3. build the archive first into a temporary path
4. allocate a unique runtime:
   - `runtimeId`
   - `runtimeSessionName`
   - `runtimeProfileDir`
5. under the global admission lock, first promote any older queued jobs that can now run
6. if runtime capacity is still available:
   - acquire the runtime lease
   - acquire the conversation lease for same-thread jobs, including follow-ups and explicit existing ChatGPT conversation ids
   - create `${PI_ORACLE_JOBS_DIR:-/tmp}/oracle-<job-id>/...` job state as `submitted`
7. otherwise create `${PI_ORACLE_JOBS_DIR:-/tmp}/oracle-<job-id>/...` job state as `queued`
8. move the prepared archive into the job directory with a unique filename
9. spawn a detached worker only for submitted jobs
10. return immediately
11. stop the agent turn until the completion wake-up arrives (best-effort; durable oracle response/artifact state is already persisted outside session history)

### Worker run flow

Per job:

1. clone the authenticated seed profile into the job’s `runtimeProfileDir` under the auth lock
2. launch a fresh isolated browser with:
   - the job’s `runtimeSessionName`
   - the job’s `runtimeProfileDir`
   - headless by default
3. open either:
   - the saved `chatUrl` for follow-up jobs,
   - the normalized `chatGptConversationId` URL for explicit existing ChatGPT browser threads, or
   - the configured provider URL
4. classify page state before touching the UI
5. fail fast on:
   - login required
   - challenge/verification page
   - transient outage after one retry
6. configure ChatGPT model family/effort or Grok Heavy
7. upload archive
8. wait for upload confirmation scoped to the active composer
9. fill prompt
10. send
11. wait for a stable conversation URL and persist `chatUrl` / `conversationId`
12. wait for completion anchored to the current turn only
13. persist plain-text response
14. download any response-local artifacts directly into the job artifact directory
15. close the isolated browser session and delete the runtime profile in `finally`

## Persistence model

### Default auth persistence

Default and recommended:

- auth seed via `--profile <authSeedProfileDir>` for durable provider authentication state
- per-job runtime via unique `--session <runtimeSessionName>` + unique `--profile <runtimeProfileDir>`

Not the default:

- `--session-name`
- `state save/load` as the primary auth bootstrap path

Reason:

`--profile` is the broadest persistence primitive and preserves full browser profile state such as cookies, localStorage, IndexedDB, service workers, cache, and login sessions. The safe concurrent design is therefore:

- one persistent authenticated seed profile
- many disposable runtime profile clones derived from that seed

## Config files

Merged config locations:

- global: `~/.pi/agent/extensions/oracle.json`
- project: `.pi/extensions/oracle.json`

Project config remains restricted to safe overrides only. On Pi 0.79+, pi itself gates project-local inputs behind project trust, but `pi-oracle` keeps its historical risk-on extension behavior for this package-specific safe override file: `.pi/extensions/oracle.json` loads by default for compatibility, and is ignored when Pi reports the project is untrusted, including `--no-approve` or saved “do not trust” decisions. This preserves the existing extension experience while still honoring explicit opt-out/distrust decisions. Browser/auth settings remain global-only because they control local privileged browser state.

### Current config shape

```json
{
  "defaults": {
    "provider": "chatgpt",
    "preset": "<preset id from ORACLE_SUBMIT_PRESETS>",
    "grokMode": "heavy"
  },
  "browser": {
    "sessionPrefix": "oracle",
    "authSeedProfileDir": "<absolute path to oracle auth seed profile>",
    "runtimeProfilesDir": "<absolute path to oracle runtime profiles dir>",
    "maxConcurrentJobs": 2,
    "cloneStrategy": "copy",
    "chatUrl": "https://chatgpt.com/",
    "authUrl": "https://chatgpt.com/auth/login",
    "runMode": "headless",
    "executablePath": "<optional absolute path to Chrome/Chromium executable>",
    "userAgent": "<optional real-Chrome UA override>",
    "args": ["--disable-blink-features=AutomationControlled"]
  },
  "auth": {
    "pollMs": 1000,
    "bootstrapTimeoutMs": 600000,
    "chromeProfile": "<optional Chrome/Chromium profile name>",
    "chromeCookiePath": "<optional absolute path to Chromium Cookies DB>",
    "chromiumKeychain": {
      "account": "<macOS-only Keychain account for non-built-in Chromium browsers>",
      "services": ["<safe-storage service name>"],
      "label": "<optional human-readable label>"
    }
  },
  "worker": {
    "pollMs": 5000,
    "completionTimeoutMs": 5400000
  },
  "poller": {
    "intervalMs": 5000
  },
  "artifacts": {
    "capture": true
  },
  "cleanup": {
    "completeJobRetentionMs": 1209600000,
    "failedJobRetentionMs": 2592000000
  }
}
```

`browser.cloneStrategy` defaults to `apfs-clone` on macOS and `copy` on Linux/Windows. macOS APFS clone mode uses `cp -cR` and preflights `cp`; set `PI_ORACLE_CP_PATH` only when the default PATH lookup cannot find the intended copy executable. Linux and Windows runtime profile copies use Node's recursive copy instead of depending on POSIX `cp`.

The default `/oracle-auth` cookie importer delegates to `@steipete/sweet-cookie`'s Chrome/Chromium backend. On Linux, pi-oracle auto-detects existing Google Chrome, Chromium, Chromium Browser, or Brave profile roots under `${XDG_CONFIG_HOME:-~/.config}` and passes non-Google roots as absolute profile paths so Sweet Cookie reads the intended cookie DB. pi-oracle does not currently select Sweet Cookie's Edge or Firefox backends. Encrypted Linux Chromium cookies are handled by Sweet Cookie via `secret-tool`, `kwallet-query`/`dbus-send`, `SWEET_COOKIE_LINUX_KEYRING=gnome|kwallet|basic`, or the `SWEET_COOKIE_CHROME_SAFE_STORAGE_PASSWORD` / `SWEET_COOKIE_BRAVE_SAFE_STORAGE_PASSWORD` overrides. Prefer keyring helpers over password environment variables; if a password override is used for `/oracle-auth`, pi-oracle scrubs it before launching browser/helper subprocesses after cookie import.

`auth.chromiumKeychain` is a macOS-only opt-in alternate cookie source for Chromium-family browsers that are not handled by the default `@steipete/sweet-cookie` Chrome-compatible importer. It must be configured with `auth.chromeCookiePath`; partial config is rejected so `/oracle-auth` cannot silently fall back to a different browser profile. On Linux, valid config should leave `auth.chromiumKeychain` unset and use Sweet Cookie's Linux keyring/password options instead.

When both `auth.chromeCookiePath` and `auth.chromiumKeychain` are present on macOS, auth bootstrap:

1. reads the configured macOS Keychain safe-storage password using `account` and the ordered `services` list
2. snapshots the Chromium `Cookies` DB plus `Cookies-wal` / `Cookies-shm` sidecars, tolerating sidecars that disappear while the browser is closing
3. decrypts Chromium AES-CBC cookie values, including Chromium v24+ host-hash-prefixed values
4. dedupes duplicate cookie rows by keeping the first row after newest-expiry ordering
5. filters importable provider auth cookies and seeds the isolated oracle auth profile

Operational requirements for this macOS-only path:

- ChatGPT or Grok must already be logged in in the configured browser profile, depending on the provider being synced.
- The target browser should be fully quit before `/oracle-auth` so the cookie DB snapshot is stable.
- The configured Keychain item must be accessible to the current macOS user; allow Keychain access if prompted.
- `browser.executablePath` should point at the same Chromium-family browser so the headed auth/bootstrap browser uses the intended app.

## Cleanup maintenance model

Long-run hygiene is intentionally conservative:

- runtime profiles, runtime leases, and conversation leases are cleaned immediately as part of worker/command cleanup paths
- browser close is time-bounded so cleanup can continue even if `agent-browser close` wedges
- `/oracle-clean` performs runtime cleanup before removing the persisted job directory, but refuses terminal jobs whose worker is still live or whose wake-up was just sent inside a short post-send retention grace window; when blocked by that grace it returns a retry-after timestamp
- stale lock directories are swept before reconcile maintenance
- old auth `.staging-*` profiles are swept during `/oracle-auth` startup when the auth browser session is not still active
- terminal job directories are retained for inspection, then pruned later based on configurable retention windows

Current retention policy is configurable via `cleanup.*`:

- `cleanup.completeJobRetentionMs`
  - applies to `complete` and `cancelled` jobs based on terminal-job age; wake-up delivery remains best-effort only, with a short post-send grace so saved response/artifact paths survive the follow-up turn
- `cleanup.failedJobRetentionMs`
  - applies to `failed` jobs

Cleanup warnings are treated as diagnostics, not silent no-ops:

- worker cleanup warnings are appended to `logs/worker.log`
- command-side cleanup warnings are surfaced to the user
- cancellation/stale-job recovery persists cleanup warnings into `job.json`
- terminal cleanup recovery will terminate stale live cleanup workers before retrying teardown so blocked capacity does not wedge indefinitely

## Job layout under the configured jobs dir

Default location: `${PI_ORACLE_JOBS_DIR:-/tmp}/oracle-<job-id>/`

```text
${PI_ORACLE_JOBS_DIR:-/tmp}/oracle-<job-id>/
  job.json
  prompt.md
  context-<job-id>.tar.zst   # ChatGPT
  context-<job-id>.tar.gz    # Grok
  response.md
  artifacts.json
  artifacts/
    ...downloaded files...
  logs/
    worker.log
    ...diagnostic captures on failure...
```

### `job.json` fields

Important fields include:

- `id`
- `status`: `queued | preparing | submitted | waiting | complete | failed | cancelled`
- `phase`: `queued | submitted | cloning_runtime | launching_browser | verifying_auth | configuring_model | uploading_archive | awaiting_response | extracting_response | downloading_artifacts | complete | complete_with_artifact_errors | failed | cancelled`
- `phaseAt`
- `createdAt`
- `queuedAt`
- `submittedAt`
- `completedAt`
- `heartbeatAt`
- `cwd`
- `projectId`
- `sessionId`
- `originSessionFile`
- `requestSource`
- `selection`: resolved execution snapshot with `{ provider, preset?, mode?, modelFamily, effort?, autoSwitchToThinking }`
- `followUpToJobId`
- `chatUrl`
- `conversationId`
- `responsePath`
- `responseFormat` (`text/plain`)
- `artifactPaths`
- `artifactsManifestPath`
- `archivePath`
- `archiveSha256`
- `archiveDeletedAfterUpload`
- `notifiedAt`
- `notificationEntryId`
- `notificationSessionKey`
- `wakeupAttemptCount`
- `wakeupLastRequestedAt`
- `wakeupSettledAt`
- `wakeupSettledSource`
- `wakeupSettledSessionFile`
- `wakeupSettledSessionKey`
- `wakeupSettledBeforeFirstAttempt`
- `wakeupObservedAt`
- `wakeupObservedSource`
- `wakeupObservedSessionFile`
- `wakeupObservedSessionKey`
- `notifyClaimedAt`
- `notifyClaimedBy`
- `artifactFailureCount`
- `error`
- `cleanupWarnings`
- `lastCleanupAt`
- `workerPid`
- `workerNonce`
- `workerStartedAt`
- `runtimeId`
- `runtimeSessionName`
- `runtimeProfileDir`
- `seedGeneration`
- `config`

## Response format

Canonical oracle response format remains:

- `text/plain`

The saved file path is currently `response.md` for continuity with earlier job layouts, but the content contract is normalized plain text for agent consumption.

## ChatGPT page-state classifier

Before upload/send, the worker classifies ChatGPT as one of:

- `authenticated_and_ready`
- `login_required`
- `challenge_blocking`
- `transient_outage_error`
- `unknown`

Signals used:

- current URL
- accessibility snapshot
- body text

### Ready

Require all of:

- ChatGPT origin is correct
- not on `/auth/*`
- composer exists
- `Add files and more` exists
- model selector / selected model control exists
- no login/challenge/outage signals

### Login required

Any of:

- URL on `/auth/*`
- login/provider signals like `Log in`, `Sign up`, `Continue with Google`, etc.
- logged-out page shape where a composer may exist but required oracle controls do not
- redirect away from the expected ChatGPT origin

### Challenge blocking

Examples:

- `Just a moment`
- `Verify you are human`
- `Cloudflare`
- captcha / turnstile markers
- suspicious or unusual activity messages

### Transient outage

Examples:

- `Something went wrong`
- `A network error occurred`
- websocket error text
- `Try again later`

## Artifact strategy

The artifact path is now direct and browser-local.

Use response-local candidate detection exactly as before, but replace browser-download-manager scraping with direct `agent-browser` downloads:

- find artifact candidates only in the current assistant response region
- for each candidate ref:
  - call `agent-browser download <ref> <dest>`
  - write directly into `${PI_ORACLE_JOBS_DIR:-/tmp}/oracle-<job-id>/artifacts`
  - compute size / sha256 / detected type
  - append manifest entry

This deliberately avoids:

- `chrome://downloads`
- downloads-tab ownership logic
- browser-global download history heuristics
- focus-sensitive tab hacks

Visible labels are still not trusted as authoritative filenames. They are treated primarily as display metadata.

## Same-thread follow-ups

Same-thread continuity is persisted as data, not runtime browser state.

Approach:

- expose `/oracle-followup <job-id> <request>` as the user-facing way to continue an oracle-created provider thread later
- allow `/oracle`/`oracle_submit` to opt into a browser-created ChatGPT thread only when the user explicitly supplies `chatGptConversationId` as a raw id or `https://chatgpt.com/c/...` URL
- store `chatUrl` only after the conversation URL stabilizes
- derive and persist `conversationId` from that URL when possible
- for a follow-up job, resolve `followUpJobId` to the prior `chatUrl`
- for an explicit existing ChatGPT thread, normalize `chatGptConversationId` to `https://chatgpt.com/c/<id>` without requiring prior oracle job state
- acquire a conversation lease before launching the same-thread job
- launch a fresh isolated browser using a fresh runtime clone of the auth seed
- open that URL
- continue there if authentication and page-state checks pass

Do not keep a browser or tab alive between jobs just to preserve thread continuity.
Do not allow concurrent jobs to target the same `conversationId`.

## Poller / wake-up model

The extension still uses the same general `pi`-native background completion pattern, but notification semantics are now explicit:

- detached worker writes `${PI_ORACLE_JOBS_DIR:-/tmp}/oracle-*` state
- poller scans jobs on an interval
- completed job durability lives in oracle job state plus saved response/artifact files, not in synthetic session-history assistant messages
- when a matching job reaches `complete`, `failed`, or `cancelled`, the poller issues one best-effort wake-up to whichever matching session is currently live, then records `notifiedAt` so later scans do not duplicate the completion message
- those wake-ups direct the receiver to `/oracle-read [job-id]` as the primary completion-consumption path, while still surfacing saved response/artifact paths as secondary context; `/oracle-status` remains useful for metadata and job-id discovery, and agent callers can still use `oracle_read` when they need tool output in-turn
- wake-up content explicitly tells agents not to treat completion as an automatic `oracle_auth`, `oracle_submit`, or `oracle_cancel` retry instruction
- manual `oracle_read`, `/oracle-read`, or `/oracle-status` inspection after a wake-up persists provenance about which path/session settled the wake-up
- if no wake-up lands, the job remains available via `/oracle-read`, `/oracle-status`, `oracle_read`, and the saved `${PI_ORACLE_JOBS_DIR:-/tmp}/oracle-<job-id>/` response/artifact files
- because completion delivery is best-effort, pruning uses explicit terminal-job age policy plus `notifiedAt`/wakeup state instead of pretending a durable session notification was appended
- recently sent wake-ups keep response/artifact files retained briefly so follow-up turns do not point at deleted paths if cleanup or pruning races with delivery

## What was removed by this pivot

The isolated-profile design deletes or supersedes the old real-Chrome-specific machinery:

- CDP attach/verification to port `9222`
- `cdpVerified` / `cdpUrl` job state
- dedicated oracle tab parking/reuse in the user’s browser
- wrong-tab drift handling
- selected-tab / tab-index tracking
- temporary `chrome://downloads` tabs
- browser download-manager scraping via `downloads-manager.items_`
- copy-from-`~/Downloads` artifact recovery flow

## Current implementation status

Implemented in code for the pivot and concurrency redesign:

- config now uses `browser.*` + `auth.*`
- `/oracle-auth` now syncs real-Chrome ChatGPT cookies into the authenticated seed profile instead of opening a manual-login browser
- `oracle_submit` supports follow-ups via persisted `chatUrl`
- job state no longer stores CDP verification fields
- workers now run with per-job runtime sessions and per-job runtime profile clones
- runtime admission is controlled by runtime leases and `browser.maxConcurrentJobs`
- queued jobs are workerless and do not consume runtime or conversation leases until promotion
- follow-up jobs now acquire conversation leases
- persisted job state now records explicit lifecycle phases instead of relying only on coarse statuses
- poller notifications now use per-job notification claims rather than broad global scan serialization
- worker now uses a structured ChatGPT page-state classifier
- worker now downloads artifacts directly with `agent-browser download <ref> <dest>`
- poller scans are now best-effort/non-fatal with per-session in-flight guards
- worker heartbeats during artifact downloads, writes artifact manifests incrementally, and reopens the saved conversation before artifact capture/download
- artifact-only responses are treated as valid completion content
- the repo now includes a repeatable sanity harness: `npm run sanity:oracle`
- the repo now includes a safe expired-auth recovery drill: `docs/ORACLE_RECOVERY_DRILL.md`
- worker closes the isolated browser, removes the runtime profile, and releases leases in `finally`

Retained from the earlier MVP:

- `/oracle`, `/oracle-followup`, `/oracle-read`, `/oracle-status`, `/oracle-cancel`, `/oracle-clean`
- `oracle_auth`, `oracle_submit`, `oracle_read`, `oracle_cancel`
- detached background worker model
- `${PI_ORACLE_JOBS_DIR:-/tmp}/oracle-<job-id>/...` state layout
- shell-safe archive creation using tar streams: `zstd` compression for ChatGPT and gzip compression for Grok
- private permissions and atomic writes
- stale-worker reconciliation
- upload ordering: attach → confirm → fill → send
- current-turn response anchoring
- plain-text canonical response extraction
- wake-the-agent poller integration
- unique archive filenames per job
- worker PID identity checks using recorded process start time
- composer-scoped upload confirmation
- stable `chatUrl` capture after send
- redacted `oracle_read` details and same-project job scoping
- serialized poller scans

## Live validation status

Live-validated after the concurrency redesign:

- `/oracle-auth` happy path still works against the seed profile
- headless normal oracle runs still work using per-job runtime clones
- two concurrent runs in different projects work with isolated runtimes
- two concurrent runs in the same project but different `pi` sessions work when they target different conversations
- same-conversation concurrent follow-up rejection works and fails fast with a clear lease error
- runtime profile cleanup works on completion and cancellation
- runtime/conversation lease cleanup works on completion and cancellation
- global browser args overrides (for example `--disable-gpu`) apply to real jobs
- artifact-producing runs work with direct `download <ref> <dest>`
- multi-artifact runs complete, target the correct `pi` session, and persist both downloaded files with correct contents
- the poller no longer needs the worker to stay alive just to observe completion for artifact-producing runs
- expired/missing auth now fails as a clean auth-related error instead of generic UI/config drift
- `/oracle-auth` repairs the seed profile and a post-repair probe succeeds again
- live auth recovery also exposed and corrected a real source-profile misconfiguration during validation; the configured browser profile must actually contain the active ChatGPT session cookies

## Known remaining work

Still to verify live after this pivot:

- full ChatGPT preset release matrix evidence must be refreshed before any release; `npm run release:proof:chatgpt-presets` blocks release without one completed loaded-extension ChatGPT job for every canonical preset
- optional richer terminal semantics for partial artifact failure (`complete_with_artifact_errors`) in more live scenarios

## Production readiness criteria

This architecture is now live-validated for the core release path:

- no interaction with the user’s real Chrome during normal jobs
- no focus disruption during normal jobs
- the seed profile survives browser restarts and can be cloned into runtime profiles repeatedly
- different projects / sessions can run in parallel without co-mingled data
- same-conversation follow-ups are rejected while another job owns that conversation lease
- artifact capture works without `chrome://downloads`
- artifact-only responses and multi-artifact responses both complete correctly
- same-thread follow-ups reopen correctly from persisted `chatUrl`
- failure modes are clearly classified as auth / challenge / outage / UI drift
- expired/missing auth now fails cleanly, `/oracle-auth` repairs the seed profile, and the post-repair probe succeeds again

### Current readiness summary

Current release blockers for the validated scope:
- release is blocked until fresh loaded-extension ChatGPT preset proof passes `npm run release:proof:chatgpt-presets` for every canonical `ORACLE_SUBMIT_PRESETS` id

Remaining non-blocking hardening work:
- broaden live proof of the new lifecycle/state-machine model across more degraded paths
- broaden live proof of notification-claim semantics under more concurrent completions
- extend regression-harness coverage for browser/download failure classes
- polish partial-artifact terminal semantics (`complete_with_artifact_errors`)
- keep hardening model-selection verification against future ChatGPT UI variation

Recent proof points:
- Pi 0.80.6 local gate: `npm run verify:oracle` passed three consecutive runs on 2026-07-11; each run completed syntax/bundle checks, both typechecks, the isolated sanity harness, and `npm pack --dry-run` without an `ENOTEMPTY` cleanup failure
- Pi 0.80.6 safe loader smokes: `.artifacts/real-smoke/run-1783810473367-cn72at` passed source loading, and `.artifacts/real-smoke/run-1783810475290-hj0pfs` passed packed-install loading through the real Pi CLI; both recorded `pi --version` as 0.80.6 and executed `/oracle-status` without creating an external oracle job or requiring provider credentials
- Pi 0.80.2 local gate: `npm run verify:oracle` passed on 2026-06-24 after the JSON command output, prompt-manifest, schema, and lazy Chrome-probe audit fixes
- Pi 0.80.2 isolated extension smokes: `.artifacts/real-smoke/run-1782321054924-jnq0x3` passed source proof, and `.artifacts/real-smoke/run-1782321056224-yuq5a2` passed packed-install proof
- Pi 0.80.2 JSON command smoke: `pi --no-extensions -e ./extensions/oracle/index.ts --mode json --no-session --no-approve "/oracle-status"` emitted displayed `oracle-command-output` JSON events
- Pi 0.79.10 local gate: `npm run verify:oracle` passed on 2026-06-22 after the 0.79.10 baseline refresh and `CONFIG_DIR_NAME` cleanup
- Pi 0.79.10 isolated extension smokes: `.artifacts/real-smoke/run-1782137209549-0xe67z` passed packed-install proof, and `.artifacts/real-smoke/run-1782137217821-95a1po` passed source model-agent proof
- Pi 0.79.10 platform artifacts: `.artifacts/platform-smoke/run-1782137574391-7lay68` (macOS platform-build), `.artifacts/platform-smoke/run-1782137619352-gku7jz` (macOS real-extension), `.artifacts/platform-smoke/run-1782137587082-d7kg4p` (Ubuntu platform-build), `.artifacts/platform-smoke/run-1782137619176-lgxezy` (Ubuntu real-extension), `.artifacts/platform-smoke/run-1782137625964-66z0oc` (Windows native platform-build), `.artifacts/platform-smoke/run-1782137752969-pbmdj1` (Windows native real-extension)
- Pi 0.79.10 isolated agent feedback: `.artifacts/isolated-agent-feedback/run-1782137385` confirmed local extension loading and useful `oracle_preflight` output after the path-label polish
- Pi 0.79.1 release gate: `npm run release:check` passed on 2026-06-11 after the project-trust, prompt-history, ChatGPT selector, and send-acceptance updates, including `verify:oracle` plus Crabbox macOS, Ubuntu, and Windows native `platform-build` and `real-extension` suites
- Pi 0.79.1 platform artifacts: `.artifacts/platform-smoke/run-1781196218405-311wzs` (macOS platform-build), `.artifacts/platform-smoke/run-1781196261807-eb0391` (macOS real-extension), `.artifacts/platform-smoke/run-1781196230636-ze1hai` (Ubuntu platform-build), `.artifacts/platform-smoke/run-1781196265638-kxiwh9` (Ubuntu real-extension), `.artifacts/platform-smoke/run-1781196255488-ucuf35` (Windows native platform-build), `.artifacts/platform-smoke/run-1781196369098-4qlzjs` (Windows native real-extension)
- Pi 0.79.1 live source-extension send-acceptance smoke: new-chat job `4b98776f-d422-4bfb-8a6a-7aef73c31bf6` reached `https://chatgpt.com/c/6a2ac99d-fc5c-83e8-88d7-5e1e8f427499` and completed; same-thread follow-up job `abb4f590-96a1-4aab-b91a-c0a7cc15a162` completed on the unchanged conversation URL after send-acceptance evidence
- Pi 0.79.0 release gate: `npm run release:check` passed on 2026-06-08, including `verify:oracle` plus Crabbox macOS, Ubuntu, and Windows native `platform-build` and `real-extension` suites
- Pi 0.79.0 platform artifacts: `.artifacts/platform-smoke/run-1780938522145-50q2f2` (macOS platform-build), `.artifacts/platform-smoke/run-1780938572090-bi87g5` (macOS real-extension), `.artifacts/platform-smoke/run-1780938542847-quridb` (Ubuntu platform-build), `.artifacts/platform-smoke/run-1780938587248-c8uo4c` (Ubuntu real-extension), `.artifacts/platform-smoke/run-1780938585007-l0xapp` (Windows native platform-build), `.artifacts/platform-smoke/run-1780938820527-c1j8tt` (Windows native real-extension)
- Pi 0.79.0 isolated local-extension model-agent smoke: `.artifacts/real-smoke/run-1780935835596-pfbn5o` passed with `PI_ORACLE_REAL_TEST_MODEL_AGENT=1 npm run smoke:real:source`
- Pi 0.79.0 packed-install smoke: `.artifacts/real-smoke/run-1780935825537-pmna07` passed with `npm run smoke:real:packed`
- expired-auth drill fail path: `a2460bc1-7d89-4041-b67d-39680d310325`
- `/oracle-auth` repair evidence: the per-run `/tmp/pi-oracle-auth-*/oracle-auth.log` bundle path printed by `/oracle-auth`
- expired-auth drill post-repair success: `fa26a2a7-0057-4a21-b3e0-71c1d020facf`
- successful multi-artifact completion: `b6b3599c-6b91-4315-adfa-8a83aa5eda9b`
- repo-owned sanity harness: `npm run sanity:oracle`
- real installed-extension smoke source of truth: `scripts/oracle-real-smoke.mjs`; required release proof runs packed-install mode (`npm run smoke:real:packed`), asserts Pi 0.80.6, and executes `/oracle-status` through Pi's installed-package loader without provider credentials or an external oracle job; optional slower model-agent submission debugging remains behind `PI_ORACLE_REAL_TEST_MODEL_AGENT=1`; source mode (`npm run smoke:real:source`) is inner-loop/debug only
- macOS, Ubuntu, and Windows native package/build/runtime smoke source of truth: `docs/platform-smoke.md`; use `npm run verify:oracle` for everyday local iteration, `npm run smoke:platform:doctor` plus a focused target/suite run for platform-sensitive changes, `npm run smoke:platform:all` for doctor-first platform matrix evidence, and `npm run release:check` for the full local-plus-platform release gate
- release gate: `npm run release:check`, also used by `prepublishOnly`, combines static verification, fresh loaded-extension ChatGPT preset proof via `npm run release:proof:chatgpt-presets`, and all required Crabbox platform smokes
