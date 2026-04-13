# pi-oracle

`pi-oracle` is a `pi` package that lets the agent hand off difficult, long-running tasks to ChatGPT.com through the web app instead of the API.

Use it when you want:
- your real ChatGPT account
- web-model behavior instead of API usage
- large repo/context uploads
- async background execution
- durable saved responses/artifacts plus best-effort wake-ups back into `pi`

Normal oracle jobs run in an isolated browser profile, not your active Chrome window.

> Status: experimental public beta. Validated primarily on macOS with Google Chrome and `pi` 0.65.0+.

## When to use it

Use `pi-oracle` for:
- big code reviews of a repo or pending changes
- architectural or migration analysis that benefits from a large uploaded archive
- long-running prompts that may take minutes to finish
- follow-up questions in the same ChatGPT thread later

Do not reach for it first for:
- normal short coding tasks that `pi` can handle directly
- workflows that must never upload project archives to ChatGPT.com
- environments outside the current supported setup

## Install

npm:

```bash
pi install npm:pi-oracle
```

GitHub:

```bash
pi install https://github.com/fitchmultz/pi-oracle
```

## Quickstart

1. Start a normal persisted `pi` session. Do not use `pi --no-session` for oracle.
2. Make sure ChatGPT already works in your local Chrome profile.
3. Make sure these are installed: Google Chrome, `agent-browser`, `tar`, and `zstd`.
4. Optional: create `~/.pi/agent/extensions/oracle.json` if you want non-default settings.
5. Run `/oracle-auth`.
6. Run `/oracle Review the current pending changes. Include the whole repo unless a narrower archive is clearly better.`
7. Wait for a best-effort wake-up, or check `/oracle-status`.

The `/oracle` prompt now runs an early oracle preflight before it gathers repo context, so missing persisted-session or local auth/config blockers fail before the agent spends time reading files.

For explicitly narrow requests, `/oracle` should gather only minimal context and prefer a minimal archive instead of broad repo exploration. It should also omit `preset` and use the configured default model unless the task clearly needs a different one.

If you miss the wake-up, the result is still saved durably in the oracle job directory and can be read later.

## Example requests

```text
/oracle Review the current pending changes. Include the whole repo unless a narrower archive is clearly better. Give me a prioritized code review with concrete fixes.
```

```text
/oracle Read the codebase and explain the highest-risk auth/session failure modes, including what to test before shipping.
```

```text
/oracle Explain the README guidance for /oracle-clean retention grace. Only archive README.md unless another file is clearly necessary.
```

```text
/oracle-followup <job-id> Tighten the migration plan around rollback risk, and only archive the files needed to answer that follow-up.
```

After a job finishes, use `/oracle-followup <job-id> <request>` to continue the same ChatGPT thread without hand-writing the low-level `followUpJobId` tool parameter.

## High-level flow

```mermaid
flowchart LR
    A["/oracle request"] --> B["Agent preflights, then gathers only the needed repo context"]
    B --> C["oracle_submit builds archive"]
    C --> D["Detached worker starts isolated ChatGPT runtime"]
    D --> E["Archive + prompt sent to ChatGPT.com"]
    E --> F["Response/artifacts saved under oracle job dir"]
    F --> G["Best-effort wake-up to matching pi session"]
```

If concurrency is full, the job is queued and starts automatically later.

## What the package adds

User-facing commands:
- `/oracle <request>` — prompt template that tells the agent to gather context and dispatch an oracle job
- `/oracle-followup <job-id> <request>` — prompt template that continues an earlier oracle job in the same ChatGPT thread
- `/oracle-auth` — sync ChatGPT cookies from your real Chrome profile into the isolated oracle auth profile
- `/oracle-read [job-id]` — inspect job status plus the saved response preview
- `/oracle-status [job-id]` — inspect job status and list recent job ids when no explicit id is given
- `/oracle-cancel <job-id>` — cancel a queued or active job by id
- `/oracle-clean <job-id|all>` — remove temp files for terminal jobs; recently woken terminal jobs may stay retained briefly and return a retry-after hint

Agent-facing tools:
- `oracle_preflight`
- `oracle_submit`
- `oracle_read`
- `oracle_cancel`

## Minimal config

Most users can start with the packaged defaults and only set the Chrome profile if needed.

`~/.pi/agent/extensions/oracle.json`

```json
{
  "defaults": {
    "preset": "<preset id from ORACLE_SUBMIT_PRESETS>"
  },
  "auth": {
    "chromeProfile": "Default"
  }
}
```

Notes:
- `defaults.preset` is the default ChatGPT model preset for oracle jobs.
- The canonical preset ids live in `extensions/oracle/lib/config.ts`.
- If the packaged default is fine, you can omit `defaults.preset` entirely.
- You usually do not need to set browser paths unless auto-detection fails.

## Available presets

| Preset id | Description |
| --- | --- |
| `pro_standard` | Pro - Standard |
| `pro_extended` | Pro - Extended |
| `thinking_light` | Thinking - Light |
| `thinking_standard` | Thinking - Standard |
| `thinking_extended` | Thinking - Extended |
| `thinking_heavy` | Thinking - Heavy |
| `instant` | Instant |
| `instant_auto_switch` | Instant - Auto-switch to Thinking Enabled |

`oracle_submit` accepts either the canonical preset id or the matching human-readable preset label; common space/hyphen variants are normalized automatically at submit time. Keep `defaults.preset` in config on the canonical preset id.

Other useful settings:
- `browser.runMode`
- `browser.args`
- `browser.authSeedProfileDir`
- `browser.runtimeProfilesDir`
- `cleanup.completeJobRetentionMs`
- `cleanup.failedJobRetentionMs`

Project config should only override safe, non-privileged settings.

## What happens to outputs

- Jobs persist their response and any artifacts under `${PI_ORACLE_JOBS_DIR:-/tmp}/oracle-<job-id>/` by default.
- Jobs can queue automatically if runtime capacity is full.
- Completion delivery into `pi` is best-effort wake-up based.
- If you miss the wake-up, use `/oracle-read [job-id]` to inspect the saved response preview.
- `/oracle-status [job-id]` still shows saved job metadata and lists recent job ids when you omit the id.
- Agent callers can use `oracle_read({ jobId })`.
- `/oracle-clean` can still refuse a terminal job briefly after a wake-up send so saved response/artifact paths survive the follow-up turn; when that guard applies, it returns the next eligible cleanup time.

## Requirements

- macOS
- Node.js 22 or newer
- Google Chrome installed
- ChatGPT already signed into a local Chrome profile
- `pi` 0.65.0 or newer
- `agent-browser` available on the machine
- `tar` and `zstd` available

## Troubleshooting

### `/oracle-auth` fails or says login is required

- Make sure ChatGPT works in the same local Chrome profile you configured.
- Re-run `/oracle-auth`.
- If ChatGPT is half-logged-in or challenge flow state looks weird, finish the login/challenge in the headed auth browser and retry.

### You hit a challenge / verification page

- Solve it in the auth/bootstrap browser if prompted.
- Then re-run `/oracle-auth` before submitting jobs again.

### You see "Oracle requires a persisted pi session"

- Do not run oracle from `pi --no-session`.
- Start a normal persisted `pi` session, then use `/oracle` again.

### A job finished but no wake-up arrived

- Use `/oracle-read [job-id]` to inspect the saved response preview.
- Use `/oracle-status [job-id]` when you want status metadata or need help finding a job id.
- Agent callers can use `oracle_read({ jobId })` if they need tool output in the current turn.
- Results are still saved on disk even if the reminder turn does not land.

### `/oracle-clean` refuses a terminal job right after completion

- This can happen during the short post-send retention grace window after a wake-up was sent.
- The command now returns a `Retry after ...` timestamp when that guard is active.
- Wait until that time, then rerun `/oracle-clean [job-id|all]`.

### `agent-browser`, `tar`, or `zstd` is missing

- Install the missing local dependency and rerun the command.

### Auto-detection picked the wrong Chrome profile

- Set `auth.chromeProfile` in `~/.pi/agent/extensions/oracle.json`.
- Re-run `/oracle-auth`.

### You want more details about a failed run

- Inspect the job directory under `${PI_ORACLE_JOBS_DIR:-/tmp}/oracle-<job-id>/`.
- The worker log and captured diagnostics are stored there.

## Detailed docs

- `docs/ORACLE_DESIGN.md` — architecture, lifecycle, queueing, persistence, presets, and recovery behavior
- `docs/ORACLE_RECOVERY_DRILL.md` — safe expired-auth recovery validation drill
- `docs/ORACLE_ISOLATED_PI_VALIDATION.md` — repeatable isolated `pi` session smoke test for local-extension validation

## Privacy / local data

This extension is local-first, but it does read and persist local data:
- `/oracle-auth` reads ChatGPT cookies from a local Chrome profile
- job archives are uploaded to ChatGPT.com
- responses and artifacts are written under the configured oracle jobs dir

Review the code and design docs before using it with sensitive material.

## Validation helpers

```bash
npm run check:oracle-extension
npm run typecheck
npm run typecheck:worker-helpers
npm run sanity:oracle
npm run pack:check
# conventional local gate
npm test
# or all at once
npm run verify:oracle
```

`npm publish` is also guarded locally via `prepublishOnly` and will run `npm run verify:oracle` before publishing.

## Beta caveats

The highest-risk areas to monitor are:
- ChatGPT UI drift
- auth/bootstrap drift
- artifact download behavior
- local environment assumptions

## License

MIT. See `LICENSE`.
