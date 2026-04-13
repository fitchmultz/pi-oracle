# pi-oracle design

Status: isolated-profile concurrency architecture implemented in code; major live validation now passes, but a few non-blocking hardening items remain.
Date: 2026-04-03

Companion doc:
- `docs/ORACLE_RECOVERY_DRILL.md` — safe expired-auth recovery validation drill

Compatibility target:
- `pi` 0.65.0+
- current extension lifecycle only; no backward-compatibility shims for removed `session_switch` / `session_fork` events

## Goal

Create a `pi` extension that lets the user or agent consult ChatGPT.com through the web product instead of the API, with:

- manual invocation via `/oracle ...`
- automatic invocation by the agent in rare high-difficulty cases
- mandatory project-context archive upload (`.tar.zst`)
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
- allow parallel jobs only when they do not target the same ChatGPT conversation

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

### Prompt template

- `/oracle <request>`
  - implemented as a prompt template, not an extension command
  - asks the agent to gather context and dispatch an oracle job
  - intentionally uses native pi prompt/template queueing so submissions survive streaming and compaction
- `/oracle-followup <job-id> <request>`
  - implemented as a prompt template, not an extension command
  - asks the agent to continue an earlier oracle job in the same ChatGPT thread via `followUpJobId`
  - keeps same-thread continuation available to normal users without requiring raw tool-call syntax

### Commands

- `/oracle-auth`
  - syncs ChatGPT cookies from the user’s real Chrome into the isolated oracle profile and verifies them there
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
  - intended to run before expensive `/oracle` context gathering
- `oracle_submit`
  - low-level agent-facing dispatch tool
  - creates archive and launches a detached worker
  - supports optional `followUpJobId` to continue the same ChatGPT thread by persisted URL
- `oracle_read`
  - reads job status and outputs
- `oracle_cancel`
  - cancels a queued or active job

## High-level flow

### `/oracle ...`

`/oracle <request>` should not directly drive ChatGPT.
It expands through the prompt-template path so pi can apply its native queueing semantics before the agent starts work.

Instead it instructs the agent to:

1. call `oracle_preflight` immediately
2. stop right away if preflight reports the session or local oracle setup is not ready
3. understand whether the request is explicitly narrow or genuinely broad
4. gather only the smallest repo context needed to submit well
5. if the request is narrow, prefer a minimal targeted archive and dispatch as soon as enough context is in hand
6. if the request is broad/repo-wide, gather broader context and usually archive `.`
7. craft the oracle prompt
8. call `oracle_submit`
9. stop and wait for the completion wake-up (best-effort; durable oracle response/artifact state is already persisted outside session history)

### `/oracle-auth`

Auth bootstrap flow:

1. load oracle config
2. acquire the global auth-maintenance lock
3. read ChatGPT cookies directly from the user’s real Chrome cookie store in read-only mode
   - configurable source profile / cookie DB path
   - no launch or mutation of the real Chrome profile
4. validate that `browser.authSeedProfileDir` is an absolute safe path and not inside the real Chrome user-data tree
5. create a staged seed-profile path next to the target seed profile
6. launch the isolated auth browser headed with:
   - dedicated auth `--session`
   - dedicated staged seed `--profile`
   - configured executable path / user agent / launch args if set
7. clear isolated browser cookies and seed the staged profile with imported ChatGPT cookies
8. open ChatGPT in the isolated browser
9. verify auth with `/backend-api/me` plus ChatGPT UI readiness checks
10. on success, close the isolated browser so Chrome flushes profile state cleanly
11. atomically swap the staged profile into `browser.authSeedProfileDir`, keeping `*.prev` as rollback
12. write a seed-generation marker used by future runtime clones
13. if ChatGPT presents a challenge page, leave the staged auth browser/profile open for the user to solve and reuse

This keeps production oracle jobs off the user’s real Chrome while using the user’s existing authenticated ChatGPT cookies as the bootstrap source.

The authenticated seed profile remains the source of truth for future oracle runtimes.

### `oracle_submit`

Agent-facing submissions use **`preset`**; the canonical registry is `ORACLE_SUBMIT_PRESETS` in `extensions/oracle/lib/config.ts`. **`preset` is the only model-selection parameter** on `oracle_submit`. There are no `modelFamily`, `effort`, or `autoSwitchToThinking` fields. Submit-time inputs accept canonical preset ids plus matching human-readable labels/common hyphen-space variants, and the tool normalizes them back to the canonical id before persisting job state. Prompt-template guidance biases toward omitting `preset` and using the configured default unless the task clearly needs a different model or the user explicitly asked for one.

1. resolve the preset (submit-time or config default) into an execution snapshot
2. resolve optional `followUpJobId` into a prior `chatUrl` and `conversationId`
3. build the archive first into a temporary path
4. allocate a unique runtime:
   - `runtimeId`
   - `runtimeSessionName`
   - `runtimeProfileDir`
5. under the global admission lock, first promote any older queued jobs that can now run
6. if runtime capacity is still available:
   - acquire the runtime lease
   - acquire the conversation lease for follow-up jobs
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
   - the saved `chatUrl` for follow-up jobs, or
   - the configured default ChatGPT URL
4. classify page state before touching the UI
5. fail fast on:
   - login required
   - challenge/verification page
   - transient outage after one retry
6. configure model family / effort
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

- auth seed via `--profile <authSeedProfileDir>` for durable ChatGPT authentication state
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

Project config remains restricted to safe overrides only.

Browser/auth settings are global-only because they control local privileged browser state.

### Current config shape

```json
{
  "defaults": {
    "preset": "<preset id from ORACLE_SUBMIT_PRESETS>"
  },
  "browser": {
    "sessionPrefix": "oracle",
    "authSeedProfileDir": "<absolute path to oracle auth seed profile>",
    "runtimeProfilesDir": "<absolute path to oracle runtime profiles dir>",
    "maxConcurrentJobs": 2,
    "cloneStrategy": "apfs-clone",
    "chatUrl": "https://chatgpt.com/",
    "authUrl": "https://chatgpt.com/auth/login",
    "runMode": "headless",
    "executablePath": "<optional absolute path to Chrome executable>",
    "userAgent": "<optional real-Chrome UA override>",
    "args": ["--disable-blink-features=AutomationControlled"]
  },
  "auth": {
    "pollMs": 1000,
    "bootstrapTimeoutMs": 600000,
    "chromeProfile": "<optional Chrome profile name>",
    "chromeCookiePath": "<optional absolute path to Chrome Cookies DB>"
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
  context-<job-id>.tar.zst
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
- `selection`: resolved execution snapshot with `{ preset, modelFamily, effort?, autoSwitchToThinking }`
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

- expose `/oracle-followup <job-id> <request>` as the user-facing way to continue the same ChatGPT thread later
- store `chatUrl` only after the conversation URL stabilizes
- derive and persist `conversationId` from that URL when possible
- for a follow-up job, resolve `followUpJobId` to the prior `chatUrl`
- acquire a conversation lease before launching the follow-up
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
- when a matching job reaches `complete`, `failed`, or `cancelled`, the poller issues bounded best-effort wake-up reminders to whichever matching session is currently live
- those wake-ups direct the receiver to `/oracle-read [job-id]` as the primary completion-consumption path, while still surfacing saved response/artifact paths as secondary context; `/oracle-status` remains useful for metadata and job-id discovery, and agent callers can still use `oracle_read` when they need tool output in-turn
- manual `oracle_read`, `/oracle-read`, or `/oracle-status` inspection settles further reminder retries once the terminal job has been opened and persists provenance about which path/session settled the wake-up
- manual inspection before the first wake-up attempt is recorded separately as observation metadata and does not suppress the first reminder send
- if no wake-up lands, the job remains available via `/oracle-read`, `/oracle-status`, `oracle_read`, and the saved `${PI_ORACLE_JOBS_DIR:-/tmp}/oracle-<job-id>/` response/artifact files
- because completion delivery is best-effort, pruning uses explicit terminal-job age policy instead of pretending a durable session notification happened
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
- `oracle_submit`, `oracle_read`, `oracle_cancel`
- detached background worker model
- `${PI_ORACLE_JOBS_DIR:-/tmp}/oracle-<job-id>/...` state layout
- shell-safe archive creation using `tar` piped to `zstd`
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
- live auth recovery also exposed and corrected a real source-profile misconfiguration during validation; the configured Chrome profile must actually contain the active ChatGPT session cookies

## Known remaining work

Still to verify live after this pivot:

- model-selection verification against the current ChatGPT UI under additional real-world variation
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
- none currently known

Remaining non-blocking hardening work:
- broaden live proof of the new lifecycle/state-machine model across more degraded paths
- broaden live proof of notification-claim semantics under more concurrent completions
- extend regression-harness coverage for browser/download failure classes
- polish partial-artifact terminal semantics (`complete_with_artifact_errors`)
- keep hardening model-selection verification against future ChatGPT UI variation

Recent proof points:
- expired-auth drill fail path: `a2460bc1-7d89-4041-b67d-39680d310325`
- `/oracle-auth` repair evidence: the per-run `/tmp/pi-oracle-auth-*/oracle-auth.log` bundle path printed by `/oracle-auth`
- expired-auth drill post-repair success: `fa26a2a7-0057-4a21-b3e0-71c1d020facf`
- successful multi-artifact completion: `b6b3599c-6b91-4315-adfa-8a83aa5eda9b`
- repo-owned sanity harness: `npm run sanity:oracle`
