# Oracle reference

Start with the [README](../README.md) for installation and your first job. This page covers command details, browser configuration, provider controls, and troubleshooting.

## What a successful run looks like

```text
You: /oracle Review the pending changes. Include the whole repo unless a narrower archive is clearly better.

pi-oracle:
  1. preflights local session/auth readiness
  2. builds a context-rich provider archive (`.tar.zst` for ChatGPT, `.tar.gz` for Grok)
  3. starts an isolated provider web runtime in the background
  4. uploads the archive and prompt to the selected provider
  5. saves the response/artifacts under /tmp/oracle-<job-id>/
  6. sends a best-effort wake-up back to the matching pi session

Later: /oracle-read <job-id>
```

What you are seeing: the local `pi` agent keeps control of context selection and safety checks, while the selected web provider handles the expensive second-opinion work asynchronously. If the wake-up is missed, the result still lives on disk and can be read by job id.

## Dispatch details

Expected result:

- The `/oracle` prompt now runs an early oracle preflight before expensive repo reading or archive creation.
- The agent chooses a context-rich relevant archive up to the selected provider's upload ceiling, not the smallest possible one-file slice when nearby context helps.
- `oracle_submit` creates or queues a job.
- If local packing is too large, the prompt treats that as a retryable archive-selection failure and narrows automatically before surfacing the problem.
- The job uploads a repo archive to the selected provider, capped at 250 MiB for ChatGPT or 200 MiB for Grok after default exclusions/pruning.
- The response is saved under `/tmp/oracle-<job-id>/response.md` by default.
- The matching `pi` session gets one best-effort wake-up when the job finishes.

If the wake-up does not arrive, run:

```text
/oracle-status
/oracle-read <job-id>
```

## Example requests

```text
/oracle Review the current pending changes. Include the whole repo unless a narrower archive is clearly better. Give me a prioritized code review with concrete fixes.
```

```text
/oracle Read the codebase and explain the highest-risk auth/session failure modes, including what to test before shipping.
```

```text
/oracle Explain the Oracle reference guidance for /oracle-clean retention grace. Archive README.md plus any nearby docs or implementation files that help answer accurately.
```

```text
/oracle-followup <job-id> Tighten the migration plan around rollback risk, and include the most relevant surrounding files/docs as long as the archive stays comfortably within the 250 MiB limit.
```

```text
/oracle Continue existing ChatGPT conversation 6a28ab5c-e4d4-83e8-b8be-dd39f38a26d6. Review the current auth code and include enough surrounding context to propose concrete fixes.
```

## How it works

```mermaid
flowchart LR
    A["/oracle request"] --> B["Agent preflights, then gathers a context-rich relevant repo slice"]
    B --> C["Agent chooses context-rich archive inputs"]
    C --> D["oracle_submit builds provider-specific archive"]
    D --> E["Detached worker clones isolated auth seed profile"]
    E --> F["Selected provider receives archive + prompt"]
    F --> G["Response/artifacts saved under oracle job dir"]
    G --> H["Best-effort wake-up to matching pi session"]
```

Key design choices:

- **Extension-managed dispatch owns context gathering.** In the TUI, `/oracle` and `/oracle-followup` are intercepted before prompt-template expansion, re-added as compact user messages for prompt-history/up-arrow recall, and paired with detailed dispatch instructions as hidden context. The visible transcript stays compact while the agent still preflights, gathers context, chooses archive inputs, and stops after dispatch.
- **Tools own execution.** `oracle_submit` builds the archive, admits or queues the job, starts the worker, and returns immediately.
- **Auth uses a seed profile.** `/oracle-auth` imports cookies into an isolated seed profile; each job clones that seed into its own temporary runtime profile.
- **Follow-ups preserve provider thread state.** `/oracle-followup <job-id> ...` resolves the prior job's saved provider URL and submits the next prompt with `followUpJobId`.
- **Existing ChatGPT browser threads are opt-in.** Normal `/oracle` jobs still start a fresh provider thread. When the user explicitly provides a ChatGPT conversation id or `https://chatgpt.com/c/...` URL, the agent passes `chatGptConversationId` so `oracle_submit` opens that existing thread in the isolated runtime.
- **Wake-up is best effort, storage is durable.** A missed wake-up does not lose the result.

## Commands and tools

User-facing commands:

- `/oracle <request>` — prepare context and dispatch a ChatGPT or Grok web oracle job. If the request explicitly includes an existing ChatGPT conversation id/URL, the agent can continue that browser-created thread; otherwise `/oracle` starts a fresh thread as before.
- `/oracle-followup <job-id> <request>` — continue an earlier oracle job in the same provider thread
- `/oracle-auth [chatgpt|grok]` — sync provider cookies into the isolated oracle auth seed profile
- `/oracle-read [job-id]` — inspect job status and saved response preview
- `/oracle-status [job-id]` — inspect a job or list recent job ids when no explicit id is given
- `/oracle-cancel <job-id>` — cancel a queued or active job
- `/oracle-clean <job-id|all>` — remove temp files for terminal jobs; recently woken terminal jobs may stay retained briefly, and a blocked cleanup returns the next eligible cleanup time

Agent-facing tools:

- `oracle_preflight`
- `oracle_auth`
- `oracle_submit` (`chatGptConversationId` is optional and only for explicitly continuing an existing ChatGPT browser conversation id/URL; omit it for the default fresh thread)
- `oracle_read`
- `oracle_cancel`

## Configuration

Most users can start with defaults. Set an agent-level config only when you need a non-default provider, mode, preset, or browser profile.

Pi 0.79+ gates project-local inputs behind project trust. `pi-oracle` preserves its historical risk-on extension behavior for existing users: project-local `.pi/extensions/oracle.json` safe overrides still load by default for compatibility. They are ignored when you explicitly opt out of project-local inputs with `--no-approve` or save a “do not trust” decision for the project. Privileged browser/auth settings still come only from the agent-level config.

`~/.pi/agent/extensions/oracle.json`

```json
{
  "defaults": {
    "provider": "chatgpt",
    "preset": "pro_extended",
    "grokMode": "heavy"
  },
  "auth": {
    "chromeProfile": "Default"
  }
}
```

Notes:

- `defaults.provider` is the default web provider: `chatgpt` or `grok`.
- `defaults.preset` is the default ChatGPT model preset for oracle jobs.
- `defaults.grokMode` is the default Grok mode. Only `heavy` is supported today.
- The canonical preset ids and provider modes live in [`extensions/oracle/lib/config.ts`](../extensions/oracle/lib/config.ts).
- If the packaged default is fine, omit `defaults`.
- When an agent is unsure which oracle preset fits, it should omit `preset` and use the configured default model instead of asking by default. If the prompt says to use Grok, it should pass `provider: "grok"` to `oracle_submit`.
- You usually do not need browser paths unless auto-detection fails.

### Linux cookie import notes

`/oracle-auth` uses `@steipete/sweet-cookie`'s public Chrome backend to parse and decrypt Linux cookies. The packaged default auto-detects existing Google Chrome, Chromium, Chromium Browser, or Brave profile roots under `${XDG_CONFIG_HOME:-~/.config}` and passes non-Google roots as absolute profile paths. For native `chromium` and `chromium-browser` profiles or `Cookies` DBs under those roots, Oracle selects **Chromium Safe Storage** rather than Chrome's key, including GNOME application lookup fallback and KDE KWallet. The Linux key-selection module loads only when needed and reuses the worker's existing public cookie getter; ordinary calibrated Chrome-password paths bypass it. Set `auth.chromeProfile` to another profile name, a profile directory, or a `Cookies` DB path when needed, and leave `auth.chromiumKeychain` unset on Linux. Profile names alone still select Google Chrome; relocated, Snap, and Flatpak Chromium sources are outside this automatic key-selection boundary.

Linux encrypted-cookie handling is controlled outside pi-oracle:

- `SWEET_COOKIE_LINUX_KEYRING=gnome|kwallet|basic` selects GNOME/libsecret, KDE KWallet, or no keyring probing.
- GNOME probing shells out to `secret-tool`; KDE probing shells out to `kwallet-query` and `dbus-send`.
- `SWEET_COOKIE_CHROME_SAFE_STORAGE_PASSWORD` (also for a selected Chromium source) and `SWEET_COOKIE_BRAVE_SAFE_STORAGE_PASSWORD` bypass keyring probing when you already know the browser safe-storage password.

Do not put safe-storage passwords in project config or persistent shell startup files. Prefer keyring helpers when possible. Oracle's native Chromium adapter scrubs password overrides from keyring subprocesses, uses the obtained password only around the public cookie read in the short-lived auth worker, and restores its prior environment in `finally`. Browser/helper subprocesses launched by Oracle receive a scrubbed environment; this guarantee does not cover upstream fallback helpers for unqualified sources. The parent Pi environment and persistent config are not changed.

### Custom Chromium cookie sources

Chrome-compatible browsers can use Sweet Cookie's default Chrome backend when `auth.chromeProfile` points at the right profile or cookie DB and the matching safe-storage key is available. On Linux, automatic Chromium-specific key selection is limited to the native roots described above; for relocated Chromium profiles use the matching Chrome or Brave password override for that auth run. Outside the confirmed native roots, Sweet Cookie 0.3 still selects Brave when the resolved cookie DB path contains `bravesoftware`, `brave-browser`, or `brave browser` (case-insensitive), even in an ancestor directory; such paths may require the Brave override. pi-oracle does not currently select Sweet Cookie's Edge or Firefox backends. The `auth.chromiumKeychain` alternate path is macOS-only and is intended for a Chromium-family browser that is not one of Sweet Cookie's built-in Chrome/Brave/Arc/Chromium targets or otherwise cannot import cookies without dependency patching.

Before running `/oracle-auth` with this macOS path:

1. Log into ChatGPT or Grok in the target browser profile, depending on `defaults.provider`.
2. Fully quit the browser so its `Cookies` database is stable.
3. Find the profile `Cookies` SQLite DB path.
4. Find the browser's macOS Keychain safe-storage item account and service name.
5. Configure all of `browser.executablePath`, `auth.chromeCookiePath`, and `auth.chromiumKeychain` in `~/.pi/agent/extensions/oracle.json`.

Example macOS Helium config:

```json
{
  "browser": {
    "executablePath": "/Applications/Helium.app/Contents/MacOS/Helium"
  },
  "auth": {
    "chromeProfile": "Default",
    "chromeCookiePath": "/Users/you/Library/Application Support/net.imput.helium/Default/Cookies",
    "chromiumKeychain": {
      "account": "Helium",
      "services": ["Helium Storage Key"],
      "label": "Helium Storage Key"
    }
  }
}
```

`auth.chromeCookiePath` remains the cookie database path for backward compatibility. On macOS, `auth.chromiumKeychain` must be paired with `auth.chromeCookiePath`; partial config is rejected so oracle does not silently fall back to a different browser source. When both are present on macOS, `/oracle-auth` uses pi-oracle's repo-owned generic Chromium cookie reader instead of patching `@steipete/sweet-cookie` internals. On Linux, `auth.chromiumKeychain` is rejected; use Sweet Cookie's Linux keyring/password environment options instead.

If macOS prompts for Keychain access during `/oracle-auth`, allow access for the configured browser safe-storage item. If auth still fails after cookies are synced, the cookie DB may be stale, from the wrong profile, or for an account that is logged out; reopen the configured browser profile, confirm ChatGPT works there, quit the browser, and rerun `/oracle-auth`. On Linux, inspect `/oracle-auth` diagnostics for Sweet Cookie warnings about `secret-tool`, `kwallet-query`, or safe-storage password overrides.

## Available providers and presets

| Provider | Mode / preset | Archive format | Upload ceiling |
| --- | --- | --- | --- |
| ChatGPT | Presets below | `.tar.zst` | 250 MiB |
| Grok | `heavy` only | `.tar.gz` | 200 MiB |

Grok uploads now use `.tar.gz` archives. Grok may accept `.tar.zst` uploads, but its execution environment can lack `zstd` tooling to extract them; gzip-compressed tar keeps extraction on standard tools. Manual testing against `https://grok.com` found a 200 MiB upload is accepted and a 200 MiB + 1 byte upload is rejected, so pi-oracle caps Grok archives at 200 MiB.

## Available ChatGPT presets

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

For ChatGPT, `oracle_submit` accepts canonical preset ids or a matching human-readable preset label. Keep config values on canonical ids. For Grok, use `provider: "grok"`; only Heavy is supported today.

ChatGPT's compact picker and current **Power** slider expose fewer choices than the legacy settings dialog: both Instant presets use Instant when no auto-switch toggle exists; Thinking Light/Standard use Medium, Extended uses High, and Heavy uses Extra High. Both Pro presets use the single Pro tier when separate effort choices are unavailable. Oracle verifies the visible selection rather than assuming the saved preference.

## Outputs and cleanup

- Jobs persist response text, metadata, logs, and artifacts under `${PI_ORACLE_JOBS_DIR:-/tmp}/oracle-<job-id>/` by default.
- Jobs can queue automatically when runtime capacity is full.
- Completion delivery into `pi` is one-time best-effort wake-up based.
- `/oracle-read [job-id]` and `oracle_read({ jobId })` inspect saved output later.
- `/oracle-clean` removes terminal job temp files, but can briefly refuse cleanup after a wake-up so the follow-up turn can still read the saved paths.

## Privacy and local data

This extension is local-first, but it handles sensitive local and project data:

- `/oracle-auth` reads provider cookies from the configured local browser profile. Use `/oracle-auth grok` for Grok when ChatGPT remains the default provider.
- `oracle_submit` uploads selected project archives to the selected provider web app.
- Responses, logs, and artifacts are written to the configured oracle jobs directory.

Review the code and design docs before using it with private or regulated material.

## Current limits

- Experimental public beta, validated on macOS, Linux, and Windows native with Chromium-family browsers.
- Provider UI, auth, model controls, and artifact download behavior can drift.
- Archive uploads are capped at 250 MiB for ChatGPT and 200 MiB for Grok after default exclusions and automatic whole-repo pruning.
- A real ChatGPT or Grok web session is required for the provider you use.
- Cookie replay still uses domain-based browser commands; this fix does not preserve host-only or partitioned-cookie isolation metadata.

## Troubleshooting

### `/oracle-auth` fails or says login is required

- Make sure the selected provider works in the same local browser profile you configured.
- For custom Chromium cookie sources, confirm `auth.chromeCookiePath` points at that profile's `Cookies` DB. On macOS, also confirm `auth.chromiumKeychain.services` names the browser's safe-storage Keychain service. On Linux, leave `auth.chromiumKeychain` unset and use Sweet Cookie's `SWEET_COOKIE_LINUX_KEYRING`, `SWEET_COOKIE_CHROME_SAFE_STORAGE_PASSWORD`, or `SWEET_COOKIE_BRAVE_SAFE_STORAGE_PASSWORD` options for encrypted Chrome/Chromium/Brave cookies.
- Re-run `/oracle-auth`.
- Agent callers can use `oracle_auth({})` once before retrying a stale-auth oracle submission.
- If ChatGPT reports an anonymous visitor session, sign in in the configured **source browser profile**, quit that browser fully, and rerun `/oracle-auth`. This command imports an existing login; the isolated verification window is not a manual-login setup flow.
- Navigation interruptions during verification are retried until the auth deadline. A closed browser or verification timeout does not by itself mean the source cookies are invalid; leave the isolated window open and inspect the printed diagnostics if retries fail.
- If the provider presents a challenge and Oracle explicitly leaves the headed auth browser open, complete the challenge there and retry.

### Custom Chromium auth says cookies synced but the session is rejected

This usually means the cookie import worked but the source cookies are not the active provider session you expected.

1. Open the configured browser profile.
2. Confirm the selected provider works there without logging in again.
3. Quit the browser fully so its `Cookies` DB is stable.
4. Confirm `auth.chromeCookiePath` points at that exact profile's `Cookies` DB.
5. On macOS, confirm `auth.chromiumKeychain.services` names the browser's safe-storage Keychain service for that DB. On Linux, confirm the relevant Sweet Cookie keyring helper or Chrome/Brave safe-storage password override is available.
6. Re-run `/oracle-auth`.

### You hit a challenge or verification page

- Solve it in the auth/bootstrap browser if prompted.
- Re-run `/oracle-auth` before submitting jobs again.

### You see "Oracle requires a persisted pi session"

- Do not run oracle from `pi --no-session`.
- Start a normal persisted `pi` session, then use `/oracle` again.

### A job finished but no wake-up arrived

- Use `/oracle-read [job-id]` to inspect the saved response preview.
- Use `/oracle-status` if you need help finding a recent job id.
- Agent callers can use `oracle_read({ jobId })`.
- Results are still saved on disk even if the reminder turn does not land.

### `/oracle-clean` refuses a terminal job right after completion

- This can happen during the short post-send retention grace window after a wake-up was sent.
- The command returns a `Retry after ...` timestamp when that guard is active.
- Wait until that time, then rerun `/oracle-clean <job-id|all>`.

### A local dependency like `agent-browser`, `tar`, or `zstd` is missing

Install the missing local dependency and rerun the command. `zstd` is only needed for ChatGPT `.tar.zst` archive submissions; Grok submissions use `.tar.gz`. On macOS APFS clone mode, `cp` must also be available on PATH or configured with `PI_ORACLE_CP_PATH`; Linux and Windows profile copies use Node's recursive copy.

### Auto-detection picked the wrong browser profile

- Set `auth.chromeProfile` in `~/.pi/agent/extensions/oracle.json`.
- For custom Chromium cookie sources, set `auth.chromeCookiePath` to the exact profile `Cookies` DB. Pair it with `auth.chromiumKeychain` only on macOS; on Linux, rely on Sweet Cookie's keyring/password environment options.
- Re-run `/oracle-auth`.

### You want more details about a failed run

Inspect the job directory under `${PI_ORACLE_JOBS_DIR:-/tmp}/oracle-<job-id>/`. The worker log and captured diagnostics are stored there.
