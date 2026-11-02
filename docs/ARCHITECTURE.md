# OMP Oracle architecture

How Oh My Pi ("OMP") and `pi` turn an `/oracle` request into a ChatGPT or Grok web job through `omp-oracle`: the host-side
extension, the detached browser worker, the isolated auth seed profile and opt-in shared-Chrome transports, and the persisted
job directory that outlives the agent turn.

Companion docs: [Documentation](README.md) · [Operations](OPERATIONS.md) · [Security model](SECURITY.md) ·
[Compatibility](COMPATIBILITY.md) · [Test plan](TEST_PLAN.md) · [Platform smoke](PLATFORM_SMOKE.md) ·
[Release](RELEASE.md) · [Upstream](UPSTREAM.md)

Compatibility and verification targets:

- Hosts: Oh My Pi and `pi`; `pi` 1.3.0 is the tested baseline for project-trust-aware package and runtime validation
  ([Compatibility](COMPATIBILITY.md) records host observations).
- Package metadata keeps the `pi` runtime packages as optional wildcard peers so npm does not block other host versions.
- Session lifecycle uses `session_start` and `session_shutdown` only, with no shims for removed `session_switch` or
  `session_fork` events.
- Validation: [Test plan](TEST_PLAN.md#which-check-to-run) for local and isolated-session checks,
  [`docs/PLATFORM_SMOKE.md`](PLATFORM_SMOKE.md) for the Crabbox macOS and Ubuntu lanes (`npm run smoke:platform:all`), and
  [Release](RELEASE.md#release-gate) for the release gate and evidence ledger.

## Goal

Give the user and the coding agent a way to consult ChatGPT or Grok through the web app on the operator's existing
subscription instead of an API key, with:

- manual invocation via `/oracle <request>` and `/oracle-followup <job-id> <request>`, plus direct tool invocation
  (`oracle_submit`) for high-difficulty tasks
- mandatory project-context archive upload (`.tar.zst` for ChatGPT up to 250 MiB, `.tar.gz` for Grok up to 200 MiB)
- long-running execution in a detached background worker so the host turn returns right away
- job state, response text, capture metadata, and validated artifacts persisted on disk under
  `${PI_ORACLE_JOBS_DIR:-/tmp}/oracle-<job-id>/`, plus one best-effort wake-up when a job reaches a terminal state
- a required persisted host session identity (`--no-session` and in-memory sessions are refused so wake-ups cannot cross
  sessions; legacy project-scoped jobs without a session identity remain inspectable by project as manual status-only records
  and are never rebound to another session)
- optional same-thread follow-ups by saved conversation URL without keeping a browser or tab open between jobs

## Architecture decision

- **Default transport: isolated auth seed profile.** `/oracle-auth` maintains one authenticated seed profile
  (`browser.authSeedProfileDir`). Each job clones that seed into a disposable runtime profile (`runtimeProfileDir`) and
  launches its own `agent-browser` session (`runtimeSessionName`).
- **Opt-in ChatGPT transports: existing-Chrome relay and managed browser.** When `browser.chatGptRelayEndpoint` or
  `browser.chatGptManagedProfileDir` is set in agent-level config, the worker attaches over Chrome DevTools Protocol (CDP),
  opens one job-owned tab, and pins every command to that tab's target id without activating tabs or stealing window focus.
- **Rejected approach: unpinned automation of the user's real Chrome.** Tab-switching commands that call `Page.bringToFront`
  or scrape global browser state are excluded; see [Design lineage](#design-lineage).
- **Data-backed thread continuity.** Same-thread follow-ups reopen the saved `chatUrl` under a per-conversation lease instead
  of parking browsers or tabs between runs.
- **Bounded concurrency.** Up to `browser.maxConcurrentJobs` jobs run in parallel across distinct conversations; additional
  submissions wait on disk as `queued` jobs without spawning a worker process until promoted.

## Current extension surface

The extension binds to the host session lifecycle in `extensions/oracle/index.ts`: `session_start` initializes the session
poller, status footer, and command interceptors; `session_shutdown` stops the poller and releases session-held timers.

### Oracle dispatch commands

- `/oracle <request>` — In TUI mode, intercepted on `input` before prompt-template expansion, re-injected as the compact
  visible user message (preserving prompt-history recall across reloads), and paired on `before_agent_start` with a hidden
  custom message (`display: false`) containing the dispatch instructions. In `print`, `json`, and `rpc` modes,
  prompt-template expansion runs the same workflow from `prompts/oracle.md`.
- `/oracle-followup <job-id> <request>` — Uses the same TUI hidden-instruction path and non-TUI prompt-template fallback
  (`prompts/oracle-followup.md`), routing the parsed job id to `oracle_submit` as `followUpJobId`.

### Commands

- `/oracle-auth [chatgpt|grok]` — imports ChatGPT or Grok cookies from the configured local browser profile into a staged
  isolated seed profile (or opens the sign-in tab on the managed browser) and verifies provider readiness.
- `/oracle-read [job-id]` — displays job status and the saved response preview.
- `/oracle-status [job-id]` — displays job metadata and lists recent job ids when the caller omits an explicit id.
- `/oracle-cancel <job-id>` — cancels a `queued` or active job by explicit id.
- `/oracle-clean <job-id|all>` — runs runtime teardown if needed and removes job directories for terminal jobs outside the
  post-wake-up retention grace window.
- `/oracle-run <preflight|submit|read> <request.json> <result.json> [<marker.json>]` — executes the registered
  `oracle_preflight`, `oracle_submit` or `oracle_read` tool host-side from a JSON request (same `prepareArguments` and
  parameter schema as a model-issued call) and writes the exact tool result; no model turn runs. The optional marker is
  created with `O_EXCL` immediately before the tool executes, so a driver can tell "never dispatched" (no marker) from
  "may have been sent" (marker, no result). Existing result or marker files are never overwritten.

### Tools

All registered tool schemas avoid `\S` in regular expressions (`^.*[^ \t\r\n].*$`) so hosts using `llama.cpp` GBNF grammar
conversion accept them. The extension also exposes a host-internal programmatic bridge under
`Symbol.for("omp.pi-oracle.programmatic.v1")`.

- `oracle_preflight` — checks persisted-session readiness, transport/seed prerequisites, and global capacity
  (`Capacity: 1/2 active, 0/2 queued (global).`) from live runtime leases and queued jobs without acquiring locks or sweeping
  state. Accepts optional `provider`, `followUpJobId`, and `chatGptConversationId`.
- `oracle_auth` — agent-facing auth refresh mirror of `/oracle-auth` for stale-auth recovery before a single retry.
- `oracle_submit` — builds the context archive, acquires runtime and conversation leases (or queues the job), writes job
  state, and spawns the detached worker. Accepts optional `followUpJobId` or `chatGptConversationId`.
- `oracle_read` — reads job status, send state, collection fidelity, and response text; `action: "recollect"` re-runs bound
  collection on a completed job without sending a prompt.
- `oracle_cancel` — cancels a queued or active job by id.

Read/status lookup uses an explicit `projectId` if supplied, otherwise the current project.
`oracle_read` accepts that optional field; `/oracle-status` and `/oracle-read` accept
`[job-id] [--projectId <project-root>]` (double-quote roots containing spaces).
Every project's jobs live under the same configured jobs root, so `readJobForProject` finds an
external-cwd submission directly by id, with no index file. A different owning project produces an
error naming that root and the explicit retry, never its saved response. No-id status listing
stays scoped to the selected project, and cancel, cleanup, follow-up, and wake-up session
ownership are unchanged.

## High-level flow

### `/oracle ...`

`/oracle <request>` delegates context gathering and submission to the host agent rather than driving the browser directly. The
dispatch prompt instructs the agent to:

1. call `oracle_preflight` immediately, passing `provider: "grok"` when the user explicitly asks for Grok
2. stop and report the exact blocker if preflight reports the session, transport, or auth seed is not ready (never call
   `oracle_auth` automatically during `/oracle` prep)
3. classify whether the request is narrow or broad, and
   bias toward context-rich archives when they fit within the provider ceiling: 250 MiB for ChatGPT and 200 MiB for Grok
4. for narrow requests, include the target files plus nearby tests, docs, configs, and adjacent modules that improve answer
   quality; for broad or repo-wide requests, pass `.` (when `.git` history matters, write a diff bundle file first because
   `.git` is excluded by default)
5. if `oracle_submit` fails before dispatch with `archive_too_large`, treat that as a retryable archive-selection miss: use
   the reported size summary and any auto-pruned paths to narrow scope and retry automatically, up to two total submit
   attempts
6. craft the prompt, call `oracle_submit`, and end the turn with a terse dispatch summary so the session returns to idle for
   the completion wake-up

Dispatched and queued submit responses forbid polling and name `oracle_read` with the job's `jobId` for a later
user-requested status check before the one-time completion wake-up in the submitting session.

### `/oracle-auth`

On the default isolated-seed transport, `/oracle-auth` runs under the global auth-maintenance lock:

1. load config and validate that `browser.authSeedProfileDir` is an absolute path outside the user's real Chrome user-data
   tree
2. read ChatGPT or Grok cookies from the configured local browser cookie store in read-only mode without launching or mutating
   the source browser
3. sweep stale `.staging-*` directories when no auth browser session is active, then create a fresh staged seed profile next
   to `browser.authSeedProfileDir`
4. close an auth browser that an earlier run left open, only when the driver lists its session, and wait until the driver
   stops listing it; then launch a headed isolated browser with a dedicated auth `--session` and the staged `--profile`,
   clear its cookies, and import the provider cookies
5. open the provider URL and poll the page-state classifier until `authenticated_and_ready`
6. on success, close the browser so Chrome flushes state, atomically swap the staged directory into
   `browser.authSeedProfileDir` (keeping `*.prev` for rollback), and write a non-empty `.oracle-seed-generation` marker
7. on a human-verification challenge, leave the headed staged browser open so the operator can solve it and rerun
   `/oracle-auth`

Each run writes a private diagnostics bundle — `/tmp/pi-oracle-auth-*/oracle-auth.log` plus URL, accessibility-snapshot, and
body captures — and prints that path.

### `oracle_submit`

Agent-facing submissions resolve a provider first. ChatGPT submissions use **`preset`**; the canonical registry is `ORACLE_SUBMIT_PRESETS` in `extensions/oracle/lib/config.ts`. Grok submissions use **`mode: "heavy"`** and reject ChatGPT-only
presets. For ChatGPT, **`preset` is the only model-selection parameter** on `oracle_submit`; there are no `modelFamily`,
`effort`, or `autoSwitchToThinking` fields. Submit-time inputs accept canonical preset ids plus
matching human-readable labels/common hyphen-space variants, and the tool normalizes them to the canonical id before
persisting job state. Prompt-template guidance biases toward omitting provider/model fields and using configured defaults
unless the task or user explicitly asks for one. When local archive packing still exceeds the upload ceiling after default
exclusions and whole-repo auto-pruning, prompt guidance treats `archive_too_large` as a retryable archive-selection miss
rather than a terminal failure.

Submission executes in strict archive-before-admission order:

1. validate session persistence, transport readiness, and (on the isolated-seed transport) that `browser.authSeedProfileDir`
   exists and carries a non-empty `.oracle-seed-generation` marker
2. resolve the provider and preset or mode into a `selection` snapshot
3. resolve optional thread targeting: `followUpJobId` into a prior oracle job `chatUrl` and `conversationId`, or
   `chatGptConversationId` into a user/browser-created ChatGPT `https://chatgpt.com/c/<id>` URL. Omit both for the default fresh-thread behavior.
4. resolve project-relative `files` inside the project root (rejecting missing paths with `archive_input_missing` and
   rejecting symlink escapes), apply default exclusions when expanding `.` or directories while archiving explicitly named
   files or directories as named, auto-prune oversized generic generated-output directories outside source roots (`src/`,
   `lib/`) on whole-repo `.` archives, and write the archive to a temporary file
5. allocate a unique runtime (`runtimeId`, `runtimeSessionName`, `runtimeProfileDir`)
6. under the global admission lock, promote any older `queued` jobs whose runtime and conversation leases are free
7. if capacity remains and any target `conversationId` lease is free, acquire the runtime lease (and conversation lease if
   applicable), create `${PI_ORACLE_JOBS_DIR:-/tmp}/oracle-<job-id>/` as `submitted`, move the archive in, and spawn a
   detached worker
8. otherwise create the job directory as `queued`, move the archive in, and return without spawning a worker

### Worker run flow

For each `submitted` job (`extensions/oracle/worker/run-job.mjs`):

1. **Prepare transport.** On the isolated transport, clone `browser.authSeedProfileDir` into `runtimeProfileDir` under the
   auth lock and launch an isolated browser (`runtimeSessionName`, headless by default). On the relay or managed browser,
   attach over CDP, verify the endpoint's browser identity if managed, create one new tab, record `relayTargetId`, and pin
   every command to that tab.
2. **Open target URL.** Navigate to the saved `chatUrl` (follow-up), the normalized `chatGptConversationId` URL, or the
   provider base URL.
3. **Classify page state.** Fail fast on `login_required`, `challenge_blocking`, or `transient_outage_error` (after one reload
   retry).
4. **Configure model or tool.** Dismiss any modal product announcement over the composer through its `Close dialog` control.
   For ChatGPT model presets, select the model family and step the thinking-effort slider, reopening the picker if ChatGPT
   closes it mid-step; for Grok, select Heavy. For a composer-tool preset
   (Deep Research), skip the model picker, fill the prompt while still in `configuring_model`, open `Add files and more`
   (polling on timers until the control is stationary and uncovered because hidden tabs receive no animation frames), enable
   the tool, and verify its composer pill. Record what the composer shows in `observedSelection`.
5. **Upload and send.** Upload the archive, wait for composer-scoped upload confirmation, fill the prompt if not already
   filled, and click send. `promptSendState` advances from `not_sent` to `attempted` right before the click and to `accepted`
   once the composer clears, recording whether a retry could duplicate a sent prompt.
6. **Bind conversation URL.** Wait for a stable conversation URL and adopt `chatUrl` and `conversationId` only when the same
   page evaluation shows this job's archive (`context-<id>.tar.zst` or `.tar.gz`) in a user turn (falling back to an
   unverified stable URL with a log warning only after 60 s).
7. **Await completion.** Each poll reads the page's conversation URL, assistant turns, and stop control in a single
   evaluation. If another client navigated the tab to a different conversation, the poll contributes nothing, logs one
   `navigation` lifecycle event, reopens the job's own conversation, and restarts the stability count within the deadline. For
   Deep Research, CDP frame capture (`Target.setAutoAttach`) is armed on the pinned tab before send; once the research widget
   frame attaches, the worker polls `frames[0].document.body.innerText` until `Research completed in` appears. If the
   assistant replies instead of starting research, the tool is missing, or the widget never yields a report, the job fails
   with a machine-readable `errorCode`.
8. **Bind and collect.** Record `generationStatus: "completed"`, bind the exact assistant turn (`collectionBinding`), and run
   [Collection](#collection) to write `response.md`, `response.capture.json`, raw evidence files, `observedTurn`, and
   validated `artifacts/`.
9. **Teardown.** In `finally`, close the isolated browser and delete `runtimeProfileDir` (or close the pinned tab on shared
   Chrome), release runtime and conversation leases, and promote the next eligible `queued` job.

Both workers (`run-job.mjs` and `auth-bootstrap.mjs`) run every `agent-browser` command with `AGENT_BROWSER_NO_WEBMCP=1`.
From 0.36 the driver otherwise enables WebMCP in the Chrome it launches and appends page-provided tool announcements to the
text output of `eval`, `get url`, `snapshot`, and `get text`, which the workers parse; Oracle uses no page tools.

## Existing-Chrome relay transport

Setting `browser.chatGptRelayEndpoint` (for example `http://127.0.0.1:9224`) in agent-level config routes ChatGPT jobs through
an already signed-in Chrome over a CDP relay — or directly over native Chrome CDP on a dedicated persistent user-data
directory — without copying cookies. On native CDP, account isolation comes from Chrome's separate profile storage rather than
an account switcher, and the worker neither owns that browser process nor checks a configured email identity. Grok remains on
the isolated seed profile, and the submit/read/follow-up APIs and durable job files are identical across transports. Setup
recipes live in [Operations → Existing-Chrome relay](OPERATIONS.md#existing-chrome-relay-chatgpt-only) and
[Operations → Dedicated account in persistent Chrome](OPERATIONS.md#dedicated-account-in-persistent-chrome).

Design invariants:

- **Target discovery and pinned tabs.** The endpoint must support CDP `Target.getTargets`, target creation, attachment, and
  closure (`agent-browser` 0.35.0 or newer). Each job creates a fresh tab, persists `relayTargetId` in `job.json`, and pins
  every command to that target. Cleanup verifies ownership, closes the pinned tab, confirms removal, and disconnects. When
  Chrome refuses to close a window's last tab (`Cannot close the last tab`), cleanup navigates that tab to `about:blank`
  instead, which the managed-browser keeper counts as idle. Relay mode never deletes a profile directory.
- **Hidden-tab stream reconciliation.** Because the worker never activates its tab, Chrome marks the tab `hidden` whenever it
  sits behind another tab or in a minimized or occluded window: `requestAnimationFrame` stops and timers throttle to 1 Hz.
  ChatGPT renders streamed tokens from the animation loop, so DOM text can freeze mid-stream while the network-driven stop
  control clears. The worker treats streamed DOM text as a lower bound and reloads the persisted conversation before binding
  and capturing. Chrome launch flags
  (`--disable-backgrounding-occluded-windows --disable-renderer-backgrounding --disable-background-timer-throttling`) keep an
  occluded window's active tab `visible`, but background tabs and minimized windows still throttle, so reload reconciliation
  is always required.
- **Stale stop-control recovery.** The stop control can outlive a finished generation stream. Once the bound turn's text is
  non-empty and unchanged for two minutes under a persistent stop control, `nextStaleStopState` reloads the conversation and
  re-reads generation state. Empty text never ages (preserving long thinking phases), and Deep Research is exempt because it
  reads completion from the widget frame.
- **Cross-client navigation guard.** Another CDP client attached to the same Chrome can navigate the job's tab. Every poll,
  URL adoption, and capture reads the page's conversation identity in the same evaluation as the DOM state and reopens the
  job's conversation if the tab moved elsewhere.
- **Follow-ups and auth.** Follow-ups open a new pinned tab on the saved `chatUrl`; a missing or mismatched target fails
  closed. Preflight checks relay reachability only; the worker checks login before upload, and `oracle_auth` refuses cookie
  import in relay mode.

## Managed browser transport

Setting `browser.chatGptManagedProfileDir` (agent-level, ChatGPT only, mutually exclusive with `browser.chatGptRelayEndpoint`)
points Oracle at a dedicated Chrome user-data directory. Jobs use the relay transport's pinned-tab execution path above; the
difference is that Oracle manages the Chrome process and verifies its identity. Setup lives in
[Operations → Managed ChatGPT browser](OPERATIONS.md#managed-chatgpt-browser-dedicated-account).

- **Attach (`managedBrowser`).** Under the canonicalized profile lock (resolved through existing ancestors so symlinked paths
  share locks and leases), the worker writes a usage lease and inspects the profile. A running Chrome with a verified endpoint
  is reused; a free profile launches Chrome under the keeper; a profile held by a Chrome without a verifiable DevTools
  endpoint fails fast with `managed_browser_in_use` (detected via POSIX `SingletonLock` `<host>-<pid>` cross-checked against
  process start time). The job persists `managedBrowser` (`endpoint`, `browserId`, `profileDir`, `pid`) so worker teardown,
  `/oracle-cancel`, and stale-job recovery act on the same browser, and a tab whose browser has exited counts as closed.
- **Endpoint and browser-identity proof.** Chrome writes `DevToolsActivePort` only when started with
  `--remote-debugging-port=0` and leaves the file behind on exit. The worker trusts an endpoint only while its live
  `/json/version` matches the expected `browserId`, re-checking before creating the pinned tab, before navigating it, and
  before every subsequent command. If a different browser answers on that port, the verdict is sticky and the job fails with
  `managed_browser_changed` rather than letting a reconnecting `agent-browser` daemon open a tab in the replacement browser (a
  command already in flight across a port reuse can at most leave one blank tab before the next check halts the worker).
  `oracle_auth` checks the browser id before trusting its sign-in verdict.
- **Keeper (`extensions/oracle/worker/managed-browser.mjs`).** Spawns Chrome as a child process, reports the endpoint via a
  one-line handshake, and sends `SIGTERM` once no live lease holder and no non-blank page remain for the two-minute idle grace
  (`PI_ORACLE_MANAGED_BROWSER_IDLE_MS`, re-checked under the profile lock). It never signals a Chrome it did not spawn.
  `SIGTERM` or `SIGINT` to the keeper quits its child Chrome; if the keeper crashes or is killed with `SIGKILL`, Chrome stays
  up and later jobs reuse it without auto-quitting.
- **Sign-in and readiness.** `/oracle-auth` attaches like a job and opens `browser.authUrl` in a tab whose presence keeps an
  Oracle-started Chrome open until the user closes it. `oracle_preflight` and the session poller check the profile path,
  browser executable, and lock holder without launching Chrome, so a closed managed browser reports ready. On macOS, Chrome
  activates itself once when creating its first window; the worker never activates tabs thereafter.

## Persistence model

The default transport separates long-lived authentication state from per-job execution state:

- **Auth seed profile (`browser.authSeedProfileDir`).** Passed via `--profile` during `/oracle-auth` to persist cookies,
  `localStorage`, `IndexedDB`, service workers, and session state. Updates are staged in a sibling directory, verified live,
  and swapped in atomically with `*.prev` retained as rollback and `.oracle-seed-generation` written as the readiness marker.
- **Per-job runtime profile (`runtimeProfileDir`).** Cloned from the verified seed under the auth lock for each job and paired
  with a unique `--session <runtimeSessionName>`, then deleted in `finally`. `--session-name` and `state save/load` are not
  used as the primary auth persistence path because they do not isolate full browser storage across concurrent workers.
- **Seed readiness invariant.** On the isolated-seed transport, both `oracle_preflight` and `oracle_submit` reject a missing
  seed directory or one without a non-empty `.oracle-seed-generation` marker before creating any archive or job directory.

## Config files

Oracle merges two JSON files (project overrides agent where allowed):

1. Agent-level: `~/.omp/agent/extensions/oracle.json` (Oh My Pi) or `~/.pi/agent/extensions/oracle.json` (`pi`)
2. Project-level: `.omp/extensions/oracle.json` (Oh My Pi) or `.pi/extensions/oracle.json` (`pi`)

Scope and trust invariants:

- **Privileged keys are agent-level only.** `browser` and `auth` are ignored or rejected in project config because they
  control local browser executables, profile paths, CDP endpoints, and credential sources. Project config may set only
  `defaults`, `worker`, `poller`, `artifacts`, and `cleanup`.
- **Project trust.** Project config loads by default for compatibility, and is skipped whenever the host reports the project
  is untrusted (including `--no-approve` or a saved untrusted decision in `ProjectTrustStore`).
- **Preset validation.** `defaults.preset` and submit-time `preset` resolve against `ORACLE_SUBMIT_PRESETS`
  (`extensions/oracle/lib/config.ts`).
- **Profile clone strategy.** `browser.cloneStrategy` defaults to `apfs-clone` on macOS and `copy` on Linux and Windows. macOS
  `apfs-clone` runs `cp -cR` (overridable via `PI_ORACLE_CP_PATH`); Linux and Windows use Node's recursive copy.
- **Cookie import backends.** Default `/oracle-auth` cookie import uses `@steipete/sweet-cookie`'s Chrome/Chromium backend
  (Edge and Firefox backends are not selected). On Linux, the importer auto-detects Google Chrome, Chromium, Chromium Browser,
  and Brave roots under `${XDG_CONFIG_HOME:-~/.config}` and decrypts cookies via `secret-tool`, `kwallet-query`/`dbus-send`,
  `SWEET_COOKIE_LINUX_KEYRING=gnome|kwallet|basic`, or the safe-storage password override for the profile's browser
  (`SWEET_COOKIE_CHROME_SAFE_STORAGE_PASSWORD`, `SWEET_COOKIE_CHROMIUM_SAFE_STORAGE_PASSWORD`, or
  `SWEET_COOKIE_BRAVE_SAFE_STORAGE_PASSWORD`). Every `SWEET_COOKIE_*_SAFE_STORAGE_PASSWORD` variable is scrubbed from the
  environment before browser, helper, or archive subprocesses spawn.
- **macOS alternate Keychain importer.** `auth.chromiumKeychain` (`account`, `services`, optional `label`) is a macOS-only
  opt-in source for Chromium-family browsers outside the default importer and must be paired with `auth.chromeCookiePath`
  (partial config is rejected so `/oracle-auth` never falls back silently to another profile; Linux configs leave
  `auth.chromiumKeychain` unset). When both are set on macOS, bootstrap reads the Keychain password, snapshots `Cookies` plus
  `Cookies-wal`/`Cookies-shm` sidecars, decrypts AES-CBC v24+ host-hash-prefixed values, deduplicates by newest expiry, and
  imports provider auth cookies.

For the complete JSON schema, every key, default value, and operational bound, see
[Operations → Configuration reference](OPERATIONS.md#configuration-reference).

## Cleanup maintenance model

Runtime and disk cleanup in `extensions/oracle/lib/jobs.ts` is bounded and non-destructive to job outcomes:

- **Immediate runtime teardown.** Worker `finally` blocks, `/oracle-cancel`, and `/oracle-clean` release runtime and
  conversation leases, close the isolated browser or pinned tab (under a timeout so a wedged `agent-browser close` cannot hang
  teardown), and remove `runtimeProfileDir`. Stale lock directories are swept before reconcile maintenance.
- **Bounded reconciliation retries.** If teardown leaves resources behind, `cleanupPending` is set. Each failed retry
  increments `cleanupAttemptCount` and schedules `cleanupRetryAt` with backoff (`15 s`, `1 min`, `5 min`, `15 min`). After
  five attempts, `cleanupPending` clears so background polls stop retrying and only an explicit `/oracle-clean` tries again.
  Reconciliation runs only for a due pending job (and once for legacy jobs recorded before attempts were counted), and
  terminates stale live cleanup workers before retrying so capacity cannot wedge.
- **Capped diagnostics, preserved errors.** Cleanup warnings go to `logs/worker.log`, surface to command callers, and persist
  in `job.json` (`cleanupWarnings`, deduplicated and capped at eight entries of 500 characters). Warnings never overwrite
  `error` and never block retention pruning or queue promotion.
- **Retention and post-wake-up grace.** Automatic pruning removes terminal job directories after
  `cleanup.completeJobRetentionMs` (14 days for `complete` and `cancelled`) or `cleanup.failedJobRetentionMs` (30 days for
  `failed`). `/oracle-clean` refuses terminal jobs whose worker is still live or whose wake-up was just delivered inside the
  post-send retention grace window; when blocked by that grace it returns a retry-after timestamp so follow-up turns never
  read deleted paths.

## Job layout under the configured jobs dir

Default location: `${PI_ORACLE_JOBS_DIR:-/tmp}/oracle-<job-id>/`

```text
${PI_ORACLE_JOBS_DIR:-/tmp}/oracle-<job-id>/
  job.json
  prompt.md
  context-<job-id>.tar.zst   # ChatGPT (deleted once the upload is confirmed)
  context-<job-id>.tar.gz    # Grok (deleted once the upload is confirmed)
  response.md                # saved response (native Markdown export, exact code block, or derived Markdown)
  response.capture.json      # turn binding, capture method, fidelity, citations, code blocks, gaps, artifact summary
  response.raw.txt           # bound-turn innerText evidence
  response.raw.html          # bound-turn sanitized DOM (active content, transient attributes, signed URLs stripped)
  response.block-<n>.txt     # exact text of each code block in the bound turn
  artifacts.json             # discovered, downloaded, validated, and failed artifact records
  artifacts/
    <sha256>-<file name>     # validated downloads only
  logs/
    worker.log
    ...diagnostic captures on failure...
```

### `job.json` fields

Fields in `OracleJob` (`extensions/oracle/lib/jobs.ts`), grouped by responsibility:

- **Identity and lifecycle:** `id`, `status` (`queued | preparing | submitted | waiting | complete | failed | cancelled`),
  `phase`
  (`queued | submitted | cloning_runtime | launching_browser | verifying_auth | configuring_model | uploading_archive | awaiting_response | extracting_response | downloading_artifacts | complete | complete_with_artifact_errors | failed | cancelled`),
  `phaseAt`, `createdAt`, `queuedAt`, `submittedAt`, `completedAt`, `heartbeatAt`, `cancelRequestedAt`, `cancelReason`,
  `lifecycleEvents`
- **Origin, selection, and config:** `cwd`, `projectId`, `sessionId`, `originSessionFile`, `requestSource` (`command | tool`),
  `selection` (`{ provider, preset?, mode?, modelFamily, effort?, autoSwitchToThinking }`), `extensionProvenance`, `config`
- **Thread and prompt state:** `followUpToJobId`, `chatUrl`, `conversationId`, `promptPath`, `reasoningPath`,
  `promptSendState` (`not_sent | attempted | accepted`), `observedSelection`
  (`{ at, product?, modelLabel?, effortLabel?, effortControls?, deepResearchVerified?, deepResearchIframeTitle? }`), `observedTurn`
  (`{ at, durationLabel?, durationSeconds? }`, for example `Worked for 15m 7s` or `Research completed in 6m`)
- **Generation and collection:** `responsePath`, `responseFormat` (`text/plain`), `generationStatus` (`completed`),
  `collectionStatus` (`complete | partial | failed`), `collectionRequiredMissing`, `collectionOptionalMissing`,
  `collectionBinding` (`{ conversationId, responseIndex, messageId?, turnSha256?, frameId? }`), `responseCapturePath`,
  `recollectionNeeded`, `recollectionError`, `recollectionPriorWorker`
- **Archive and artifacts:** `archivePath`, `archiveSha256`, `archiveDeletedAfterUpload`, `artifactPaths`,
  `artifactsManifestPath`, `artifactFailureCount`
- **Wake-up and notification provenance:** `notifiedAt`, `notificationEntryId`, `notificationSessionKey`,
  `notificationSessionFile`, `wakeupAttemptCount`, `wakeupLastRequestedAt`, `wakeupSettledAt`, `wakeupSettledSource`,
  `wakeupSettledSessionFile`, `wakeupSettledSessionKey`, `wakeupSettledBeforeFirstAttempt`, `wakeupObservedAt`,
  `wakeupObservedSource`, `wakeupObservedSessionFile`, `wakeupObservedSessionKey`, `notifyClaimedAt`, `notifyClaimedBy`
- **Worker, runtime, and transport:** `workerPid`, `workerNonce`, `workerStartedAt`, `logsDir`, `workerLogPath`, `runtimeId`,
  `runtimeSessionName`, `runtimeProfileDir`, `seedGeneration`, `relayTargetId`, `managedBrowser`
- **Errors and cleanup:** `error`, `errorCode`, `cleanupPending`, `cleanupAttemptCount`, `cleanupRetryAt`, `cleanupWarnings`,
  `lastCleanupAt`

Legacy jobs written before collection binding or session-file provenance existed remain readable: missing `collectionStatus`
is treated as unknown rather than failed, and jobs without `sessionId` stay inspectable by `projectId` without wake-up
rebinding.

`observedSelection` is optional, including on legacy jobs. It remains the single UI-provenance
object: `modelLabel` is the already-read model-selector text, `effortLabel` the observed slider
stop (`<Label> (<index> of <count>)`), and `at` the latest observation time. Each ChatGPT submission
re-reads the currently open Power control without opening its menu or changing the selection, even when
model configuration already matches. An absent/unmounted control, including Deep Research, clears
stale effort evidence with `effortLabel: null` and `effortControls: "absent"`. A retained menu
contradicted by its collapsed opener is absent too; a failed read or unparsable mounted control
uses `"unavailable"` instead and does not block submission. Neither case infers the offered count,
and a configuration-time stop is not retained as the submission's currently offered set after the
picker closes. The current model-selector DOM text, or an existing supported compact opener's
snapshot label, supplies `modelLabel`; an unreadable label clears old model/product provenance.
`product` prefers a readable slider stop over a generic picker caption and classifies those actual controls as Pro,
Thinking, or Instant, or a verified research pill/frame as Deep Research; unknown labels
remain unclassified rather than copying the requested preset. Slider observations are merged
immediately, so failure before model configuration finishes no longer loses a logged reading.
The bound research iframe's `Deep research` title comes from the existing `DOM.describeNode`
reply. All merges go through the worker's per-job lock and atomic write, preserving other fields.
No page/response text, cookie, or secret is added to this metadata.

## Response format

`responseFormat` in `job.json` is `"text/plain"`. The file path is `response.md` for continuity across job layouts; its
contents are normalized UTF-8 plain text/Markdown (from native Markdown export, an exact single `markdown` code block, or
derived DOM Markdown) for agent and user consumption.

## ChatGPT page-state classifier

Before configuring the composer or uploading, the worker classifies the page using the current URL, accessibility snapshot,
and body text into one of five states: `authenticated_and_ready`, `login_required`, `challenge_blocking`,
`transient_outage_error`, or `unknown`. Shared control names and DOM selectors across ChatGPT shell revisions live in
`extensions/oracle/worker/chatgpt-ui-helpers.mjs`.

- **Ready (`authenticated_and_ready`):** requires the expected ChatGPT origin outside `/auth/*`, an enabled composer textbox
  (`Ask ChatGPT` in the current shell or `Chat with ChatGPT` in the earlier shell; `Work with ChatGPT` is a separate surface
  and never counts as ready), the `Add files and more` control, and no login, challenge, or outage signals. The model picker
  is verified later during model configuration and is not touched by Deep Research jobs.
- **Login required (`login_required`):** matches a URL under `/auth/*`, sign-in actions (`Log in`, `Sign up`,
  `Continue with Google`), a logged-out shell without upload controls, or a redirect off the ChatGPT origin.
- **Challenge blocking (`challenge_blocking`):** matches human-verification markers such as `Just a moment`,
  `Verify you are human`, `Cloudflare`, CAPTCHA/Turnstile prompts, or unusual-activity blocks.
- **Transient outage (`transient_outage_error`):** matches provider error banners such as `Something went wrong`,
  `A network error occurred`, websocket error text, or `Try again later`.

## Collection

Generation and collection are tracked independently. `generationStatus: "completed"` records that the assistant finished
generating; `collectionStatus` records what the worker captured (`complete` when saved with no required gaps, `partial` when
saved with named gaps in `collectionRequiredMissing` or `collectionOptionalMissing`, or `failed` when no usable response bytes
were captured).

Required gaps indicate degraded answer fidelity (`response`, `rich_response_fidelity`, `unresolved_source_links`,
`bound_response_capture`, `redacted_transport_links`, `native_export_source_links`, `diagram_source:<count>`); optional gaps
indicate a missing secondary file (`native_markdown_export`, `research_widget_state`, `artifact:<candidate>`,
`artifact_inspection:<state>`).

### Exact binding

Collection binds to the single assistant turn produced for the job: `conversationId`, `responseIndex` (observed at
completion), the turn's `data-message-id` (or `data-chatgpt-selection-message-id`, resolved through heading wrappers), and
`turnSha256` over normalized text (class attributes churn between renders, so sanitized HTML is not hashed). Every capture
evaluation verifies the page's conversation URL in the same browser call as the DOM read; if the tab moved to another
conversation, the worker reopens the job's conversation and retries boundedly. Message identity takes precedence over a stale
positional index, a positional root spanning multiple message identities is refused even on first capture, and missing or
ambiguous identity fails closed: for ChatGPT, streamed intermediate text is never written as a fallback `response.md`,
`collectionStatus` becomes `failed`, and `recollectionNeeded: true` tells callers to recollect rather than resubmit.

### Capture

`extensions/oracle/worker/response-capture.mjs` contains closure-free browser functions evaluated in the owned page or bound
report frame (and tested directly by the synthetic Chromium harness). From the bound root it extracts raw text, sanitized
HTML, derived Markdown, code blocks, stable source URLs (signed transport URLs are dropped; literal URLs in text and code are
inventoried), structural artifact candidates, child frames, and the reasoning-time label (`Worked for ...` in the exchange's
activity header or `Research completed in ...`). A code block is a `pre` or the current shell's `CodeBlock-…` container (a
live reply nests a `pre` in it, a reloaded conversation renders a bare block `code`, and a runnable block such as Python
holds a CodeMirror editor); its language comes from a `language-*` class or, failing that, the container's action-bar label
(`YAML` becomes a `yaml` fence), the label never becomes prose, and nested wrappers are not double-counted. The editor
renders only the rows near the viewport, so an editor block's text is the editor's own document, written back into the
sanitized HTML as rows. A turn consisting of a single `markdown` code block is saved verbatim (`exact_code`); otherwise
derived Markdown is written (`derived_markdown`). Exact payload files and the surrounding derived response are distinct
fidelity claims.

Deep Research renders its report inside a cross-origin, sandboxed ChatGPT App iframe (`internal://deep-research` inside the
reply in the earlier shell, or `Deep research` in a sibling block of the reply's `data-turn-key` exchange in the current
shell) whose same-origin child frame (`frames[0]`) holds the report while the top document keeps only a placeholder and the
conversation API carries no report text. Because reading that frame requires CDP `Target.setAutoAttach` armed on the pinned
tab before send (Chrome only surfaces frames created after arming), Deep Research requires a shared-Chrome transport (the
existing-Chrome relay or the managed browser) and fails on the isolated seed profile; see
[Operations → Troubleshooting](OPERATIONS.md#troubleshooting) for the named Deep Research failure codes.

When saving a Deep Research report, the worker prefers its Markdown source (`native_markdown`): first the validated native
export file (`native_report_download`), then the Apps SDK widget state (`frames[0].openai.widgetState.report_message`,
recorded as `report_widget_state`). Both preserve Mermaid diagram fences and citation tokens
(`U+E200 cite U+E202 <ref> ... U+E201`), which the collector converts into numbered Markdown footnotes backed by
`content_references` (unresolved tokens keep a numbered footnote and add `unresolved_source_links`; fenced code is never
rewritten). Only if neither Markdown source is available does collection convert the rendered iframe DOM: its status line and
counters are dropped, each citation pill stays a visible `[n]` and counts as an unresolved source, and each diagram rendered
without source becomes a placeholder counted in `diagram_source:<count>`. `response.capture.json` records the token, source,
and unresolved counts under `citations`.

### Artifacts

Artifact candidates are discovered only inside the bound turn or bound report frame from elements with `download` attributes,
file-like `href`s, or export labels (container elements that wrap other controls or exceed 200 characters of text are excluded
so the research widget wrapper never masks its own `Export` button). A link to another site without a `download` attribute is
a citation, never a candidate, whatever its path or label: ChatGPT serves a reply's files from its own origin or OpenAI's
user-content host. Visible labels are display metadata, never authoritative filenames. Each candidate is tracked in
`artifacts.json` (`discovered`, `downloaded`, `validated`, `failed`), verified against its declared size and format (PDF,
ZIP, PNG, UTF-8 text), and stored once under `artifacts/<sha256>-<name>`.

Standard turn artifacts are captured in-realm by activating the control under temporary `fetch`, `window.open`, and anchor
hooks, falling back to `agent-browser download <ref> <dest>`. For Deep Research native Markdown export, the sandboxed iframe's
**Export → Export to Markdown** menu delegates the download to the host page, where frame hooks cannot see the bytes. Before
clicking export, the worker calls `Page.enable` on both the pinned tab session and the bound frame session, registers a
`URL.createObjectURL` `Blob` map in each realm, and listens for `Page.downloadWillBegin` and `Page.downloadProgress`. It
accepts only a download initiated by the main frame or bound report frame tree, reads the bytes from the registered `Blob` (or
`data:` URL), and validates them against Chrome's `totalBytes` and the report title. A download from a transport URL the hooks
did not read is reported as an optional gap rather than refetched. Because `chrome.debugger` extension relays do not route
`Browser.setDownloadBehavior`, the worker never sends it, never alters the user's download directory, and never scans
`~/Downloads` or `chrome://downloads`.

### Recollection

`oracle_read({ jobId, action: "recollect" })` invokes the worker's `--recollect` entrypoint on a completed job without
touching the composer or sending a prompt. Recollection opens a fresh `oracle-<uuid>` driver session (kept short for macOS's
103-byte Unix socket limit), arms CDP frame capture before navigating, reacquires the bound turn, and re-runs collection and
native export capture.

- A positional-only binding (when initial capture failed before learning `messageId`) resolves through the user turn that
  displays `context-<id>.tar.zst`, verifies the first reply sits at `responseIndex`, and refuses an archive shown in zero or
  multiple user turns. Jobs completed before binding existed require `responseIndex` and `messageId` together; an explicit
  pair may add identity to a positional binding but never move it or replace a saved exact binding.
- A root without `data-message-id` (attribute drift) is recollected only if its `turnSha256` still matches.
- Earlier usable bytes always survive: if recollection fails, `recollectionError` is recorded, `bound_response_capture` is
  marked missing, any `messageId` learned before the failure stays persisted, and existing `response.md` and validated
  artifacts stay intact.
- During recollection, admission clears `lastCleanupAt`, heartbeats continuously, and saves predecessor worker provenance in
  `recollectionPriorWorker` so background pollers do not kill the live recollection worker as a stale cleanup process; a
  warning-free teardown restores the predecessor identity, while a teardown with warnings keeps the fresh identity so
  reconciliation retries against the current resources. `SIGTERM`/`SIGINT` run the same cleanup and finalization.
- Browser teardown waits until the driver inventory stops listing the session before returning (a session not listed is
  never closed, an unreadable inventory is a cleanup error, and a relay target absent from the inventory never reaches the
  driver).

## Same-thread follow-ups

Same-thread continuity is persisted as job metadata (`chatUrl` and `conversationId`), never by keeping a browser or tab open
between jobs:

- `/oracle-followup <job-id> <request>` resolves `followUpJobId` to the prior job's saved `chatUrl` and `conversationId`.
- `oracle_submit` also accepts an explicit `chatGptConversationId` (raw UUID or `https://chatgpt.com/c/<id>` URL) to continue
  a browser-created ChatGPT thread without prior job state.
- Admission acquires a per-`conversationId` lease before launching the worker (or queues the job if another job holds that
  conversation), then opens the target URL in a fresh runtime clone or fresh pinned tab.

## Poller / wake-up model

Each live persisted host session runs a background poller (`poller.intervalMs`, default 5000 ms):

- **Footer readiness.** Every poll re-evaluates submit prerequisites for the session footer (`oracle: ready`, `auth needed`,
  `browser unavailable`, `config error`) using the same error codes agents see, emitting at most one warning per distinct
  blocker and clearing automatically when resolved.
- **Durable record on disk.** Completed job durability lives in `${PI_ORACLE_JOBS_DIR:-/tmp}/oracle-<job-id>/` (`job.json`,
  `response.md`, `artifacts/`), which outlives the agent turn subject to `cleanup.*` retention, `/oracle-clean`, and the
  lifetime of the jobs directory (default `/tmp`).
- **One best-effort, idle-gated wake-up.** When a session's job reaches `complete`, `failed`, or `cancelled`, the poller
  delivers at most one wake-up message and records `notifiedAt`. Delivery happens only while the host session is idle with no
  pending messages (`isIdle()` and `hasPendingMessages()`, checked before claiming and before sending; hosts without these
  probes keep immediate delivery); a busy session defers delivery to a later poll. Multiple jobs finishing together are
  batched into a single wake-up message, and any job the origin session already read through `oracle_read` is marked settled
  (`wakeupSettledBeforeFirstAttempt`) so no redundant wake-up is sent. Manual `oracle_read`, `/oracle-read`, or
  `/oracle-status` inspection after a wake-up records settlement provenance on the job.
- **Consumption and retry guard.** Wake-up text directs users to `/oracle-read [job-id]` (and agents to `oracle_read`),
  surfaces saved file paths, and explicitly instructs agents not to treat a failed or cancelled wake-up as an automatic
  `oracle_auth`, `oracle_submit`, or `oracle_cancel` retry trigger.

## Design lineage

Earlier iterations automated the user's running Chrome without target pinning. That approach was rejected because
`agent-browser tab new <url>` and `agent-browser tab <index>` switch the active tab and invoke CDP `Page.bringToFront`,
stealing window focus and interrupting typing.

Replacing unpinned real-Chrome automation removed fixed port `9222` attachment, `cdpVerified`/`cdpUrl` job fields, parked
reusable tabs, selected-tab index tracking, temporary `chrome://downloads` tabs, `downloads-manager.items_` scraping, and
`~/Downloads` file-copy recovery. Every current transport preserves the no-focus-steal and no-global-scrape invariants: the
default transport runs an isolated browser per job cloned from the auth seed profile, while the opt-in relay and
managed-browser transports pin every CDP command to a single job-owned tab and capture artifacts in-realm or through
frame-scoped CDP download events.
