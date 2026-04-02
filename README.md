# pi-oracle

`pi-oracle` is a `pi` extension that lets the agent use ChatGPT.com as a long-running web oracle instead of using the API.

It exists for the hard cases where you want:
- the user’s real ChatGPT account
- web-model behavior instead of API usage
- large project-context uploads
- async background execution that wakes the originating `pi` session when done

Normal oracle jobs run in an isolated browser profile, not in the user’s active Chrome window.

Status: experimental public beta, validated primarily on macOS.

## What it does

The extension adds:
- `/oracle <request>`
- `/oracle-auth`
- `/oracle-status [job-id]`
- `/oracle-cancel [job-id]`
- `/oracle-clean <job-id|all>`
- `oracle_submit`
- `oracle_read`
- `oracle_cancel`

An oracle job:
1. gathers a project archive
2. opens ChatGPT in an isolated runtime profile
3. uploads the archive and sends the prompt
4. waits in the background
5. persists the response and any artifacts under `/tmp/oracle-<job-id>/`
6. wakes the originating `pi` session on completion

## Example

```text
/oracle Invoke the Oracle to have it generate a thorough code review of the current pending changes. Include all modified files, and adjacent files, in the archive. Use the Pro Model with Extended effort.
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
- `pi` installed
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
- `browser.args`
- `browser.executablePath`
- `browser.authSeedProfileDir`
- `browser.runtimeProfilesDir`
- `auth.chromeProfile`
- `auth.chromeCookiePath`

Project config should only override safe, non-privileged settings.

Detailed design and maintainer docs:
- `docs/ORACLE_DESIGN.md`
- `docs/ORACLE_RECOVERY_DRILL.md`

## Privacy / local data

This extension is local-first, but it does read and persist local data:
- `/oracle-auth` reads ChatGPT cookies from a local Chrome profile
- job archives are uploaded to ChatGPT.com
- responses and artifacts are written under `/tmp/oracle-<job-id>/`

Review the code and design docs before using it with sensitive material.

## Validation helpers

```bash
npm run check:oracle-extension
npm run sanity:oracle
npm run pack:check
```

## Beta caveats

The highest-risk areas to monitor are:
- ChatGPT UI drift
- auth/bootstrap drift
- artifact download behavior
- local environment assumptions

## License

MIT. See `LICENSE`.
