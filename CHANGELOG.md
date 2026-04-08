# Changelog

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
