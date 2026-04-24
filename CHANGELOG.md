# Changelog

## Unreleased

## 0.6.10 - 2026-04-23

### Changed
- updated the local pi development baseline to `@mariozechner/pi-coding-agent` `0.70.0`
- regenerated the npm lockfile against the current stable dependency graph

### Compatibility
- reviewed the pi `0.70.0` changelog and confirmed the oracle extension does not depend on the changed terminal progress defaults or the new `--no-builtin-tools` behavior

## 0.6.9 - 2026-04-23

### Changed
- updated the local pi development baseline to `@mariozechner/pi-ai` / `@mariozechner/pi-coding-agent` `0.69.0`
- migrated published TypeBox integration metadata and source imports from `@sinclair/typebox` to `typebox` for pi `0.69.0` compatibility
- updated the local oracle verification flow to externalize `typebox` in the extension bundle check and regenerated the npm lockfile against the current stable dependency graph

### Fixed
- stopped background poller scans from touching stale pi extension contexts after session replacement or reload
- avoided consuming wake-up retry attempts when a stopped poller exits before sending its best-effort reminder

### Compatibility
- reviewed the pi `0.69.0` changelog and confirmed the extension already uses explicit session-scoped objects in the relevant flows while now matching the required TypeBox 1.x package name


## 0.6.8 - 2026-04-21

### Changed
- updated the local pi development baseline to `@mariozechner/pi-ai` / `@mariozechner/pi-coding-agent` `0.68.0`
- regenerated the npm lockfile against the current stable dependency graph

### Compatibility
- reviewed the pi `0.68.0` changelog and confirmed the extension already uses explicit session cwd values instead of relying on removed ambient cwd fallbacks in public helpers

## 0.6.7 - 2026-04-18

### Changed
- bumped the local pi development baseline to `@mariozechner/pi-ai` / `@mariozechner/pi-coding-agent` `0.67.68` and `typescript` `6.0.3`
- refreshed the release lockfile against the current stable pi patch line

### Fixed
- pinned the transitive `basic-ftp` dependency to `5.3.0` and `protobufjs` to `7.5.5` to clear the current audit findings without introducing peer conflicts
- updated the release sanity guard to enforce the patched override versions during future publishes

## 0.6.6 - 2026-04-16

### Changed
- updated the local pi development baseline to `@mariozechner/pi-ai` / `@mariozechner/pi-coding-agent` `0.67.4`
- aligned `packageManager` metadata to `npm@10.9.8`, the latest stable npm line compatible with the declared Node runtime floor
- removed the published `@mariozechner/pi-coding-agent` peer dependency so installs rely on pi's bundled runtime instead of npm peer-resolution churn

## 0.6.5 - 2026-04-15

### Changed
- pinned `packageManager` metadata to `npm@11.12.1` and refreshed the release lockfile against the current stable pi toolchain so `verify:oracle` resolves reproducibly across machines
- kept the published oracle runtime surface unchanged while moving local development dependencies to the current stable pi/TypeScript/Node typing baseline

## 0.6.4 - 2026-04-14

### Changed
- bumped the local development and release toolchain to the latest published pi packages and current TypeScript/esbuild/Node type definitions so release verification now runs against the same pi generation shipping on this machine

### Fixed
- `oracle_submit` archive creation now handles downstream `zstd` pipe failures as normal tool errors instead of crashing the host `pi` process with an unhandled `write EPIPE` on newer Node runtimes
- sanity coverage now exercises the broken-pipe archive path so early downstream compressor exits regress to a clean rejection instead of a process-level crash

## 0.6.3 - 2026-04-13

### Fixed
- workspace-root detection now prefers nearest project markers like `.pi/` and `AGENTS.md` over unrelated ancestor git roots, so oracle submissions from nested projects no longer widen to a home-directory repo and reject valid project-relative archive inputs like `AGENTS.md`
- sanity coverage now guards the nested-project-under-ancestor-git case so archive resolution stays anchored to the intended project root

## 0.6.2 - 2026-04-13

### Changed
- `/oracle` and `/oracle-followup` now treat pre-dispatch `archive_too_large` submit failures as retryable archive-selection misses instead of immediate dead ends, so agents can automatically narrow the archive and retry before surfacing the problem to the user

### Fixed
- archive-too-large submit errors now explain the 250 MB limit in human-readable terms, state that dispatch stopped before launch, and describe an ordered retry plan for shrinking the archive
- oracle tool guidance, docs, and sanity coverage now align on only ending the turn after successful/queued `oracle_submit` results instead of accidentally stopping on a retryable oversize failure

## 0.6.1 - 2026-04-13

### Fixed
- whole-repo archive expansion now merges very large entry groups iteratively instead of using spread/flat patterns that can overflow the JavaScript call stack during `oracle_submit`
- oracle sanity coverage now guards the large-entry merge path so broad archive submissions regress to a real archive/env error instead of `Maximum call stack size exceeded`

## 0.6.0 - 2026-04-13

### Added
- `oracle_auth`, an agent-facing tool that mirrors `/oracle-auth` so oracle runs can refresh the shared ChatGPT auth seed profile before a single retry when stale auth blocks execution

### Changed
- `/oracle` and `/oracle-followup` now follow a stricter preflight-first flow, bias toward context-rich archive selection up to the 250 MB ceiling, and explicitly allow one `oracle_auth` refresh before retrying stale-auth/login-required failures
- package metadata now follows the current pi package dependency guidance by publishing `@mariozechner/pi-coding-agent` and `@sinclair/typebox` as peer dependencies while keeping local typechecking/dev resolution intact

### Fixed
- `/oracle` no-session and missing-seed flows now stop before unnecessary repo exploration, and prompt-template guidance keeps relevant surrounding archive context instead of over-optimizing for minimal slices when extra context still fits
- oracle model selection now recognizes ChatGPT family controls exposed as radios/menu items plus durable closed-chip states like `Extended thinking` and `Extended Pro`, so remembered new-chat defaults no longer derail preset configuration or ready-state detection
- authenticated ready-state detection now accepts extended closed-chip model controls during auth/bootstrap verification, preventing false login/setup failures when ChatGPT remembers a non-default preset

## 0.5.0 - 2026-04-12

### Added
- `oracle_preflight`, a lightweight readiness tool that lets `/oracle` fail fast on missing persisted-session or local auth/config blockers before archive/context work begins

### Changed
- `/oracle` now follows a stricter preflight-first flow, biases toward minimal context gathering for explicitly narrow requests, and prefers the configured default model unless a different preset is clearly needed
- `oracle_read`, `/oracle-status`, and wake-up messaging now keep the true terminal event prominent, separate wake-up bookkeeping from failure state, and stop implying that a missing `response.md` is ready
- `/oracle-auth` failure guidance now reports the effective agent config path for the active agent dir and explains when a project config was also read but could not override `auth.*`
- `/oracle-clean` now documents the short post-send retention grace window and returns a retry-after timestamp when a terminal job is still intentionally retained

### Fixed
- `oracle_submit` now rejects locally knowable auth-seed blockers before archive creation or job persistence while still preserving direct archive-input validation errors like symlink escapes
- oracle tool results now use consistent structured `details.job` / `details.error` payloads and preserve `isError` for structured failures through the tool-result hook
- `/oracle` no-session and missing-seed flows now stop before unnecessary repo exploration, and narrow prompt-template runs dispatch more quickly with smaller archives when the user scope is explicit
- repeated oracle sanity runs now quiesce background pollers before isolated-state teardown so release verification no longer emits a noisy temp-lock ENOENT race

## 0.4.0 - 2026-04-12

### Added
- repeatable isolated local-extension `pi` validation guidance for oracle release verification, including smoke workflows that load the in-repo extension source directly
- persisted oracle lifecycle-event breadcrumbs plus richer detached-job observability in `oracle_submit`, `oracle_read`, poller wake-ups, and `/oracle-status`, including worker-log paths and last-event context
- shared worker/auth validation helpers, shared concurrency primitives, shared lifecycle reducers, and shared observability formatters to keep extension and worker behavior aligned
- extracted sanity-harness support and poller suites with typed helper scaffolding and repeated-run stability coverage

### Changed
- oracle whole-repo archiving now excludes local tool state like `.pi/`, `.oracle-context/`, `.cursor/`, and `.scratchpad.md` by default while preserving explicitly requested paths
- lock/lease recovery, queue promotion, process identity handling, and lifecycle transitions now flow through shared helper modules instead of duplicated inline implementations
- worker/auth verification now leans on behaviorally tested helper modules plus dedicated `typecheck:worker-helpers` coverage instead of syntax checks and brittle source-string assertions alone
- release validation now expects isolated local-extension `pi` smoke tests and a stronger local oracle verification gate before shipping

### Fixed
- archive input resolution now rejects symlink escapes outside the repo root and preserves safer repo-boundary handling for targeted archives
- hung `tar`, `zstd`, `cp`, and auth `agent-browser` subprocesses now time out and fail clearly instead of wedging archive, runtime-clone, or auth flows indefinitely
- cleanup warnings without a live worker no longer consume runtime/conversation capacity forever, while teardown still attempts lease release and preserves warnings for later triage
- detached oracle workers and poller flows now report clearer lifecycle breadcrumbs, wake-up settlement state, and failure context during fast-fail auth/bootstrap scenarios
- sanity-runner cleanup now retries transient temp-directory removal races, and the extracted harness is less timing-fragile and less `any`-driven than the previous monolithic runner

## 0.3.4 - 2026-04-11

### Changed
- oracle archive defaults now exclude nested `secrets/` and `.secrets/` directories anywhere in the repo unless they are explicitly requested
- package metadata now reflects the current runtime floor and platform support (`node >=22`, `darwin`) and local release automation runs `verify:oracle` through `npm test` / `prepublishOnly`

### Fixed
- model verification now distinguishes `thinking`, `pro`, `instant`, and `instant_auto_switch` more conservatively instead of accepting mismatched presets on partial UI evidence
- artifact-only assistant responses can now complete without timing out on missing plain-text bodies
- `/oracle-auth` diagnostics now write into a unique private temp directory per run instead of fixed `/tmp/oracle-auth.*` paths
- sanity coverage now exercises shared ChatGPT UI helpers directly, verifies nested secret exclusion, and guards the new auth diagnostics path handling

## 0.3.3 - 2026-04-11

### Added
- `oracle_submit` now accepts canonical preset ids plus matching human-readable preset labels/common hyphen-space variants and normalizes them back to the canonical preset id at submit time
- lock sweeping now gives in-flight `.tmp-*` lock/state directories a dedicated grace window so concurrent sweep does not delete another process's atomic publish

### Changed
- oracle submit metadata/docs now point preset discovery at the canonical registry/README while keeping execute-time normalization for flexible caller input

### Fixed
- closed a concurrent stale-lock sweep race that could reclaim another process's in-flight lock publish before metadata landed
- oracle sanity coverage now verifies preset alias validation/normalization and the `.tmp-*` grace window behavior end-to-end

## 0.3.2 - 2026-04-08

### Changed
- README now lists the available oracle preset ids directly, so users can choose `defaults.preset` values without having to inspect source files

### Fixed
- closed a README usability gap where preset-based configuration was documented without actually enumerating the shipped preset ids
- oracle sanity coverage now verifies that the README lists every preset from the canonical `ORACLE_SUBMIT_PRESETS` registry

## 0.3.1 - 2026-04-08

### Changed
- rewrote the GitHub-facing README to work better as a landing page, with a sharper value prop, clearer install guidance, a real quickstart, example requests, a minimal config example, troubleshooting, and a high-level flow diagram
- README now explains when to use `pi-oracle`, when not to use it first, where outputs live, and what to do if a wake-up is missed

### Fixed
- removed the stale legacy model wording from the README example flow and aligned user-facing setup docs with the preset-based configuration model

## 0.3.0 - 2026-04-08

### Changed
- breaking: `oracle_submit` and oracle config defaults now use preset-only model selection; legacy `modelFamily` / `effort` / `autoSwitchToThinking` submit inputs and default config fields were removed in favor of canonical preset ids
- oracle jobs now persist a resolved `selection` snapshot and the worker configures ChatGPT from that persisted selection instead of re-deriving model settings from legacy job fields
- oracle model preset definitions now come from a single canonical registry in `extensions/oracle/lib/config.ts`

### Fixed
- removed duplicate hand-maintained preset-id examples from agent-facing prompt and design docs so callers are directed to the tool schema / canonical registry instead of stale inline lists
- oracle sanity coverage now validates the preset-only contract from the registered tool schema and canonical registry instead of brittle prose-only assertions
- worker model configuration now consistently uses the explicit `configureModel(job)` parameter instead of hidden coupling through the module-global current job

## 0.2.2 - 2026-04-07

### Fixed
- missed ChatGPT file artifacts now map generic download controls onto nearby filenames and download from live DOM selectors instead of relying only on filename-labeled snapshot refs
- oracle jobs no longer report a false-clean completion when response-local artifact signals are present but capture fails or remains inconclusive
- artifact label extraction now collapses paths and mixed response text down to real filenames so suspicious artifact fallback logic does not emit bogus labels

### Added
- regression coverage for artifact label extraction edge cases and ambiguous download-control artifact detection

## 0.2.1 - 2026-04-07

### Fixed
- wake-up guidance now tells receivers to use `oracle_read(jobId)` as the canonical way to consume completion results
- manual inspection before the first wake-up no longer suppresses the initial reminder attempt
- wake-up settlement now records provenance so suppressed/settled delivery can be explained in postmortems
- queued archive cleanup retries now retry queued archive deletion and keep warnings until cleanup succeeds
- queued archive byte-pressure accounting now includes retained pre-submit archives instead of only currently queued jobs

## 0.2.0 - 2026-04-06

### Added
- workerless queued oracle jobs with automatic promotion when capacity is available
- queue position/status reporting and queued-job cancellation
- durable wake-up target leasing for cross-process completion notification routing
- oracle now requires a persisted pi session identity instead of collapsing in-memory/no-session contexts onto a shared project-level wake-up target
- legacy project-scoped jobs from the older no-session model now stay manual/status-only on upgrade instead of being adopted by another persisted session for wake-up delivery
- lock and lease metadata publication is now atomic on both first publish and rewrites so concurrent wake-up-target reads cannot transiently hide live sessions
- metadata-less lock/lease state directories left behind by crashes are now reclaimed after a bounded grace instead of wedging future operations forever
- expanded oracle sanity coverage for queueing, recovery, cancellation, promotion, and notification edge cases
- a real TypeScript typecheck gate via `npm run typecheck` and `npm run verify:oracle`

### Changed
- queued jobs now promote using their persisted config snapshot
- runtime admission now stays blocked when cleanup warnings indicate teardown is incomplete
- cleanup-driven promotion only advances the queue after a clean runtime teardown
- orphaned completion wake-ups can be adopted safely when the original session is no longer live
- oracle completion notifications now avoid synthetic assistant session-history writes entirely and rely on durable job-state response/artifact persistence plus best-effort wake-ups

### Fixed
- PID-safe worker cancellation and stale-worker recovery paths
- same-job conversation lease reuse during queued follow-up retries
- cleanup-warning handling across submit, promotion, cancellation, and terminal cleanup flows
- queue advancement after cancellation now requires clean teardown
- cleanup failures no longer silently drop warning state or remove terminal job records prematurely
- stale notification claimants can no longer finalize completion delivery after ownership handoff
- best-effort wake-up retries remain bounded without creating synthetic completion messages in session history, including stale cross-session claimant races
- completed and cancelled jobs now prune on explicit terminal-job retention policy instead of depending on synthetic notification state
- stale live terminal cleanup workers are now terminated and recovered automatically so cleanup-pending jobs do not wedge capacity indefinitely
- prune/clean paths now coordinate with in-flight wake-up delivery so already-prunable jobs are skipped, claimed jobs are not deleted before their reminder send path resolves, and just-sent wake-ups keep their response/artifact files briefly retained
- `/oracle-clean` now refuses terminal jobs whose worker is still live instead of deleting around active cleanup
- live and off-session completion handling no longer risks corrupting active session history with extension-authored assistant appends
- `oracle_read` now reports artifact paths from the configured oracle jobs directory instead of hard-coding `/tmp`
- manual `oracle_read` and `/oracle-status` inspection now settles further wake-up retries so live sessions do not get repeated reminder turns after the job has already been opened
