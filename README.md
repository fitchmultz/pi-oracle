# pi-oracle

`pi-oracle` is a `pi` extension that lets the agent use ChatGPT.com as a long-running web oracle instead of using the API.

It exists for the hard cases where you want:
- the user’s real ChatGPT account
- web-model behavior instead of API usage
- large project-context uploads
- async background execution with durable job-state/response artifacts plus best-effort wake-ups for the originating `pi` session
- oracle requires a persisted `pi` session identity; in-memory/no-session contexts are rejected instead of risking wrong-session wake-ups
- legacy project-scoped jobs created before that change remain readable via project status/read commands, but skip best-effort wake-up routing after upgrade

Normal oracle jobs run in an isolated browser profile, not in the user’s active Chrome window.

Status: experimental public beta, validated primarily on macOS.

Compatibility target: current lifecycle/event model in `pi` 0.65.0+.
This package intentionally uses the current `session_start`-based session lifecycle and does not ship backward-compatibility shims for removed extension events.

## What it does

The extension adds:
- `/oracle <request>`
  - implemented as a prompt template so it keeps native pi queueing behavior during streaming and compaction
- `/oracle-auth`
- `/oracle-status [job-id]`
- `/oracle-cancel [job-id]`
- `/oracle-clean <job-id|all>`
- `oracle_submit`
- `oracle_read`
- `oracle_cancel`

An oracle job:
1. gathers a project archive
2. if runtime capacity is full, persists as `queued` and starts automatically later
3. otherwise opens ChatGPT in an isolated runtime profile
4. uploads the archive and sends the prompt
5. waits in the background
6. persists the response and any artifacts under the oracle job directory (`${PI_ORACLE_JOBS_DIR:-/tmp}/oracle-<job-id>/` by default)
   - old terminal jobs are later pruned according to cleanup retention settings
   - when directory inputs are expanded, project archives automatically skip common bulky generated caches and top-level build outputs such as `node_modules/`, `target/`, virtualenv caches, coverage outputs, and `dist/`/`build/`/`out/`, unless you explicitly pass those directories
   - whole-repo archive defaults also skip obvious credentials/private data such as `.env` files, key material, credential dotfiles, local database files, and root `secrets/` directories unless you explicitly pass them
   - if a whole-repo archive is still too large after default exclusions, submit automatically prunes the largest nested directories with generic generated-output names like `build/`, `dist/`, `out/`, `coverage/`, and `tmp/` outside obvious source roots like `src/` and `lib/`, and successful submissions report what was pruned
7. persists the response/artifacts durably in oracle job state and issues best-effort wake-ups to whichever matching `pi` session is currently live

## Example

```text
/oracle Invoke the Oracle to have it generate a thorough code review of the current pending changes. By default include the whole repo archive unless the request clearly needs a narrower scope. Use the Pro Model with Extended effort.
```

## Why this exists

The goal is to get strong ChatGPT web-model answers without:
- paying API costs for every long review
- blocking the agent for 10–90 minutes
- stealing focus from the user’s active browser session

## Current scope

Currently validated for:
- macOS
- local Google Chrome
- local ChatGPT web login in Chrome
- isolated auth seed profile + per-job runtime profile clones
- concurrent jobs across different projects/sessions
- workerless queued jobs when the global concurrency limit is full
- same-conversation exclusion for follow-ups
- plain-text responses
- artifact capture, including multi-artifact runs

Not promised yet:
- cross-platform support
- immunity to future ChatGPT UI changes
- fully polished partial-artifact terminal semantics

## Requirements

- macOS
- Google Chrome installed
- ChatGPT already signed into a local Chrome profile
- `pi` 0.65.0 or newer installed
- `agent-browser` available on the machine
- `tar` and `zstd` available

## Install

npm:

```bash
pi install npm:pi-oracle
```

GitHub:

```bash
pi install https://github.com/fitchmultz/pi-oracle
```

## First-time setup

1. Make sure ChatGPT already works in your local Chrome profile.
2. Configure the oracle if needed via `~/.pi/agent/extensions/oracle.json`.
3. Run `/oracle-auth`.
4. Run a tiny `/oracle` smoke test.

## Configuration

Config files:
- global: `~/.pi/agent/extensions/oracle.json`
- project: `.pi/extensions/oracle.json`

Common settings:
- `defaults.preset`
- `browser.args`
- `browser.executablePath`
- `browser.authSeedProfileDir`
- `browser.runtimeProfilesDir`
- `auth.chromeProfile`
- `auth.chromeCookiePath`
- `cleanup.completeJobRetentionMs`
- `cleanup.failedJobRetentionMs`

Project config should only override safe, non-privileged settings.

Cleanup behavior:
- terminal job directories under the configured oracle jobs dir (`${PI_ORACLE_JOBS_DIR:-/tmp}/oracle-<job-id>/` by default) are retained for inspection, then pruned conservatively
- completed/cancelled jobs are pruned after `cleanup.completeJobRetentionMs` based on terminal-job age, but recent wake-up sends keep response/artifact files retained briefly so follow-up turns do not point at deleted paths
- failed jobs are pruned after `cleanup.failedJobRetentionMs`
- `/oracle-cancel` can cancel queued or active jobs
- `/oracle-clean` refuses non-terminal jobs, including queued ones, refuses terminal jobs whose worker is still live, also refuses recently woken jobs during a short post-send retention grace window, performs runtime cleanup before removing terminal job directories, and reports cleanup warnings if any residual cleanup step fails

Detailed design and maintainer docs:
- `docs/ORACLE_DESIGN.md`
- `docs/ORACLE_RECOVERY_DRILL.md`

Completion notification semantics:
- oracle responses and artifacts are always persisted durably in oracle job state under the configured oracle jobs dir (`${PI_ORACLE_JOBS_DIR:-/tmp}/oracle-<job-id>/` by default)
- completion delivery into pi sessions is best-effort wake-up based; the extension no longer appends synthetic assistant completion messages into session history
- wake-up content tells the receiving assistant to call `oracle_read(jobId)` as the canonical completion-consumption path, with saved file paths included as secondary context
- manual `oracle_read` or `/oracle-status` inspection settles further reminder retries once the terminal job has been opened, and now persists settlement provenance for postmortems
- manual inspection before the first wake-up attempt is recorded as observation only and does not suppress the first reminder send
- if a wake-up does not land, the job remains available via its saved response/artifacts and status commands

## Privacy / local data

This extension is local-first, but it does read and persist local data:
- `/oracle-auth` reads ChatGPT cookies from a local Chrome profile
- job archives are uploaded to ChatGPT.com
- responses and artifacts are written under the configured oracle jobs dir (`${PI_ORACLE_JOBS_DIR:-/tmp}/oracle-<job-id>/` by default)

Review the code and design docs before using it with sensitive material.

## Validation helpers

```bash
npm run check:oracle-extension
npm run typecheck
npm run sanity:oracle
npm run pack:check
# or all at once
npm run verify:oracle
```

## Beta caveats

The highest-risk areas to monitor are:
- ChatGPT UI drift
- auth/bootstrap drift
- artifact download behavior
- local environment assumptions

## License

MIT. See `LICENSE`.
