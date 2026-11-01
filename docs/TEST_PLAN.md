# OMP Oracle test plan

Run the narrowest validation check that proves your change in Oh My Pi ("OMP") or `pi`, starting with the local gate and adding live or cross-platform runs only when the changed surface requires them.
Companion docs: [Architecture](ARCHITECTURE.md) · [Operations](OPERATIONS.md) · [Platform smoke](PLATFORM_SMOKE.md) · [Release](RELEASE.md)

## Which check to run

| Situation | Command or procedure | What it proves |
| --- | --- | --- |
| Everyday local iteration (local gate) | `npm run verify:oracle` (`npm test` is an alias) | Runs, in order: syntax and bundle checks (`npm run check:oracle-extension`), platform-smoke invariants (`npm run check:platform-smoke`), helper unit tests (`npm run test:oracle-helpers`), the site coherence test (`npm run test:site`: every asset a site page references is deployed, asset changes redeploy, `og:image` dimensions match `og.png`, and sitemap, `robots.txt`, and canonical links agree), the documentation link check (`npm run test:docs`: every relative Markdown link, heading fragment, and link into this repository from the documentation or site resolves), the three typecheck projects (`npm run typecheck`, `npm run typecheck:worker-helpers`, `npm run typecheck:worker-runtime`), the isolated sanity harness (`npm run sanity:oracle`: config, locks, queueing, worker, tool schemas, and pinned documentation literals), and `npm pack --dry-run` (`npm run pack:check`). Hosted CI runs only this local gate: on `main`, on pull requests, and on the release tag before publishing ([Release → Publishing](RELEASE.md#publishing)). |
| Native Pi status and read smoke | `node --test scripts/oracle-native.test.mjs` | The locally installed `pi` loads this package in an isolated persisted JSON-mode session with separate HOME, agent, jobs, and state directories, and any fetch fails the test. Empty-project `/oracle-status` produces one successful display-marked response without a browser job. Two fixture projects prove that `oracle_read`, `/oracle-status`, and `/oracle-read` refuse another project's job with an error naming its owning root, return it only with that explicit `projectId` (quoted roots may contain spaces), and leave cancellation current-project only. Production worker declarations run against fixture browser replies with real per-job locks and atomic writes: a slider reading survives a configuration failure, a picker that closes one step off Pro is reopened and stepping resumes to the target, later observations merge, and the bound research frame binds by frame id or, once its capture marker is gone, by `src`. Included in `npm run test:oracle-helpers`; requires no provider credentials or dependency-baseline upgrade. Does not qualify TUI rendering, print-mode output, or live ChatGPT DOM and model selection. |
| Collection proof | `npm run proof:capture` | Against an owned headless Chromium and a loopback fixture server, with no account or network: delayed composer hydration and restored-draft replacement for both the `#prompt-textarea` editor and the `Ask ChatGPT` textbox, exact code payload capture, message-identity binding across shifted indices, nested code blocks, the current shell's code blocks in live and reloaded renders and runnable editor blocks (fenced in the action bar's language, the label never prose, an editor block read whole from its document rather than its rendered rows), source pills and other links to other sites kept out of download candidates, generic artifact download, the sandboxed report frame's host-delegated native Markdown export through pre-armed download events (bytes identical to the file Chrome saved), the report container excluded from download candidates, report chrome, citation pills, and diagrams rendered as declared gaps, widget-state Markdown and references resolved into footnotes, a completion wait whose tab another client moved to a finished foreign conversation (no completion until the job's own turn finishes, one `navigation` event), a failed capture that writes no response and marks `recollectionNeeded`, anchored recollection through the archive turn and its refusals, a control wait without animation frames, prompt send states (`not_sent`, `attempted`, `accepted`), idempotent recollection that preserves earlier bytes, recollection admission timestamps, and driver teardown serialization. |
| Platform-focused syntax and invariant sanity | `npm run check:platform-smoke`, `npm run sanity:oracle:platform`, or `npm run verify:oracle:platform` | Crabbox harness invariants, real-smoke script syntax, platform-sensitive sanity assertions, and `npm pack --dry-run` pass before launching containers or VMs. |
| Runtime or extension code change | [Isolated `pi` session smoke](#isolated-pi-session-smoke) | The local extension loads in an isolated `pi` or `omp` print-mode session; whole-repo archives exclude local tool state by default; symlink escapes are rejected; exercised agents give candid friction feedback. `npm run smoke:real:source` only checks inner-loop source loading and is not a substitute. |
| Managed-browser change | [Managed browser mode](#managed-browser-mode) | `browser.chatGptManagedProfileDir` launch, attach, per-command browser-identity checks, and the idle keeper quit succeed in an isolated state directory. |
| Auth seed or bootstrap change | [Auth recovery drill](#auth-recovery-drill) and [Auth timeout check](#oracle-auth-timeout-when-agent-browser-hangs) | An unauthenticated or missing seed directory is refused at submission before creating an archive or job, `/oracle-auth` repairs the seed and fails fast when `agent-browser` hangs, and the next job completes. |
| Platform-sensitive change | `npm run smoke:platform:doctor`, then `node scripts/platform-smoke.mjs run --target <target> --suite <suite>` ([Platform smoke](PLATFORM_SMOKE.md)) | Target setup is ready and the affected target (`macos`, `ubuntu`, or optional `windows-native`) and suite (`platform-build` or `real-extension`) pass when changes touch archive packing, process cleanup, runtime or browser profile handling, package metadata, or the Crabbox harness. |
| Platform matrix proof | `npm run smoke:platform:all` ([Platform smoke](PLATFORM_SMOKE.md)) | Doctor-first packed-install `platform-build` and `real-extension` (`npm run smoke:real:packed`) suites pass on the required `macos` and `ubuntu` Crabbox lanes on Node 24+. |
| ChatGPT preset proof (check vs produce) | `npm run release:proof:chatgpt-presets` (check) or `npm run release:proof:chatgpt-presets:run` (produce) ([Release](RELEASE.md#chatgpt-preset-proof)) | Required before release and for any change touching ChatGPT model selection or UI. The runner submits live loaded-extension jobs for the eight canonical model presets (`deep_research` is excluded because each run consumes a Deep Research task) and writes `.artifacts/chatgpt-preset-proof/latest.json`; the checker verifies that file against persisted `job.json`, worker log, and response files. |
| Publish / release gate | `npm run release:check` ([Release](RELEASE.md#release-gate)) | Runs `npm run verify:oracle`, `npm run proof:capture`, `npm run release:proof:chatgpt-presets`, and `npm run smoke:platform:all`, in that order. The offline capture proof requires Chrome or Chromium (auto-detected, or selected with `CHROME_BIN`). Passes before the release tag is pushed, which publishes through trusted publishing ([Release → Publishing](RELEASE.md#publishing)); `prepublishOnly` also enforces it for a local `npm publish`. |
| Brand artwork (`assets/*.html`) | `npm run render:assets`, then `npm run render:assets -- --check` ([Branding](BRANDING.md)) | Re-renders `assets/banner.png` and `assets/og.png` from `assets/*.html` and verifies dimensions and same-machine byte equality. |

## Isolated `pi` session smoke

Use this repeatable pre-commit workflow for code changes when you need end-to-end evidence beyond `npm test`. It validates that:

- isolated `pi` or `omp` print-mode sessions load the local extension source directly;
- whole-repo `oracle_submit` archive creation excludes local tool state by default;
- targeted archive inputs cannot escape the repository through symlinked paths;
- the exercised agents return candid feedback about tool clarity or clunkiness.

### Why this workflow is isolated

Each run uses separate directories for `PI_CODING_AGENT_DIR`, `--session-dir`, and `PI_ORACLE_JOBS_DIR` so validation never reuses or mutates your normal agent state.

To load the in-repo extension in `pi` rather than a globally installed package, pass `--approve --no-extensions -e`:

```bash
pi --approve --no-extensions -e "$REPO/extensions/oracle/index.ts"
```

`--approve` is intentional for this isolated workflow on `pi` 0.79+: the test fixture is this trusted checkout, and scripted validation must not block on the project-trust prompt.

On Oh My Pi, run print mode with `--no-extensions -e` to validate the in-repo extension non-interactively:

```bash
env PI_CODING_AGENT_DIR="$TEST1_AGENT" PI_ORACLE_JOBS_DIR="$TEST1_JOBS" PI_TELEMETRY=0 \
  omp --cwd "$REPO" -p --auto-approve --session-dir "$TEST1_SESSIONS" \
  --model <model id> --thinking low --no-extensions -e "$REPO/extensions/oracle/index.ts" "$PROMPT1" < /dev/null
```

Three details matter: print mode waits forever on an open piped stdin (`readPipedInput`), so close stdin with `< /dev/null`; `oracle_submit` refuses `--no-session`, so keep a persisted `--session-dir`; and the isolated `PI_CODING_AGENT_DIR` carries no model configuration, so copy a `models.yml` for the chosen model into it (a zero-cost local model works). `npm run release:proof:chatgpt-presets:run` automates this route for the release preset proof.

The local extension intercepts TUI `/oracle` and `/oracle-followup` before prompt-template expansion, re-injects the compact slash request as the visible user message for prompt-history and up-arrow recall, and reads the in-repo prompt files as hidden dispatch instructions, so do not pass `--prompt-template` for normal local-extension validation. In print, JSON, and RPC modes, the extension contributes the prompt templates itself.

Do not add this repository's GitHub URL to `.pi/settings.json` to test local changes. If you keep upstream `npm:pi-oracle` or a published `omp-oracle` installed globally, mixing that package with a project-local git package creates two distinct package identities and can trigger prompt or tool conflicts. Use the explicit `-e` CLI flag instead.

`oracle_submit` preflights missing, unreadable, or unverified auth seed profiles before it creates an archive or persists a job. For archive-inspection smoke tests that intentionally run without real auth, use `oracle_preflight` for the blocker path or create a test seed only in a purpose-built fixture with a non-empty timestamped `.oracle-seed-generation` marker.

### Preset choice

For pre-commit isolated smoke tests, use `instant` or `thinking_light`. The examples below use `instant` because it is the fastest smoke-test preset; to switch to `thinking_light`, replace `preset "instant"` with `preset "thinking_light"` in both prompts.

For any release, and for any change that touches ChatGPT model selection or UI, run live loaded-extension jobs for all eight canonical model presets in `ORACLE_SUBMIT_PRESETS` (`pro_standard`, `pro_extended`, `thinking_light`, `thinking_standard`, `thinking_extended`, `thinking_heavy`, `instant`, `instant_auto_switch`; `deep_research` is excluded because each run consumes a Deep Research task). Each prompt must make the saved response contain the exact markers `PRESET <preset> OK` and `PACKAGE omp-oracle`. Save the completed job ids and job directories in `.artifacts/chatgpt-preset-proof/latest.json` only after every job completes, with `validatedAt` later than those completed jobs, and verify the proof against the persisted `job.json`, worker log, and response files ([Release](RELEASE.md#chatgpt-preset-proof)):

```bash
npm run release:proof:chatgpt-presets
```

### Repeatable smoke test

Prerequisites: `pi` and `tmux` installed locally; run from the repository root.

The script below runs two isolated `pi` sessions in `tmux` to validate whole-repo archive default exclusions (`TEST1`) and symlink-escape rejection (`TEST2`), and asks each agent for candid feedback:

```bash
set -euo pipefail

REPO="$PWD"
TEST_ROOT="/tmp/pi-oracle-isolated-tests-$$"

TEST1_AGENT="$TEST_ROOT/agent1"
TEST1_SESSIONS="$TEST_ROOT/sessions1"
TEST1_JOBS="$TEST_ROOT/jobs1"
TEST2_AGENT="$TEST_ROOT/agent2"
TEST2_SESSIONS="$TEST_ROOT/sessions2"
TEST2_JOBS="$TEST_ROOT/jobs2"

FIXTURE="$TEST_ROOT/symlink-fixture"
OUTSIDE="$TEST_ROOT/outside"

SESSION1="pi-oracle-test1"
SESSION2="pi-oracle-test2"

mkdir -p \
  "$TEST1_AGENT" "$TEST1_SESSIONS" "$TEST1_JOBS" \
  "$TEST2_AGENT" "$TEST2_SESSIONS" "$TEST2_JOBS" \
  "$FIXTURE" "$OUTSIDE"

mkdir -p \
  "$TEST1_AGENT/extensions/oracle-auth-seed-profile" \
  "$TEST2_AGENT/extensions/oracle-auth-seed-profile"
date -u +%FT%TZ > "$TEST1_AGENT/extensions/oracle-auth-seed-profile/.oracle-seed-generation"
date -u +%FT%TZ > "$TEST2_AGENT/extensions/oracle-auth-seed-profile/.oracle-seed-generation"

echo 'secret' > "$OUTSIDE/secret.txt"
ln -s "$OUTSIDE" "$FIXTURE/linked-outside"

PROMPT1='Call oracle_submit directly with prompt "Sanity test for archive exclusions. Reply with OK." files ["."] and preset "instant". Do not use bash. After the tool returns, summarize the outcome in 3 bullets including the job id/status, and give one sentence of candid feedback on whether the oracle tool behavior feels clear or clunky.'
PROMPT2='Call oracle_submit directly with prompt "Sanity test for symlink escape rejection." files ["linked-outside/secret.txt"] and preset "instant". Do not use bash. After the tool returns, summarize the outcome in 3 bullets and give one sentence of candid feedback on whether the oracle tool behavior feels clear or clunky.'

cleanup() {
  tmux kill-session -t "$SESSION1" 2>/dev/null || true
  tmux kill-session -t "$SESSION2" 2>/dev/null || true
}
trap cleanup EXIT
cleanup

TMUX_CMD1="cd '$REPO' && env PI_CODING_AGENT_DIR='$TEST1_AGENT' PI_ORACLE_JOBS_DIR='$TEST1_JOBS' PATH='$PATH' pi --approve --session-dir '$TEST1_SESSIONS' --no-extensions -e '$REPO/extensions/oracle/index.ts'"
tmux new-session -d -s "$SESSION1" "$TMUX_CMD1"
sleep 8
tmux send-keys -t "$SESSION1":0.0 "$PROMPT1" Enter
sleep 35

echo '--- pane:test1'
tmux capture-pane -p -S -220 -t "$SESSION1":0.0 | tail -n 160

JOB_DIR1="$(find "$TEST1_JOBS" -maxdepth 1 -type d -name 'oracle-*' | sort | tail -n 1 || true)"
echo "--- latest job dir:test1 ${JOB_DIR1:-<none>}"

if [ -n "${JOB_DIR1:-}" ] && [ -f "$JOB_DIR1/job.json" ]; then
  ARCHIVE1="$(python3 - <<'PY' "$JOB_DIR1/job.json"
import json,sys
with open(sys.argv[1]) as f:
    print(json.load(f)['archivePath'])
PY
)"
  echo "--- archive:test1 $ARCHIVE1"
  tar --zstd -tf "$ARCHIVE1" | head -n 80
  LIST="$(mktemp)"
  tar --zstd -tf "$ARCHIVE1" > "$LIST"
  for path in .pi/settings.json .oracle-context .cursor .scratchpad.md README.md; do
    if grep -E -q "^${path}$|^${path}/" "$LIST"; then
      echo "FOUND $path"
    else
      echo "MISSING $path"
    fi
  done
  rm -f "$LIST"
fi

TMUX_CMD2="cd '$FIXTURE' && env PI_CODING_AGENT_DIR='$TEST2_AGENT' PI_ORACLE_JOBS_DIR='$TEST2_JOBS' PATH='$PATH' pi --approve --session-dir '$TEST2_SESSIONS' --no-extensions -e '$REPO/extensions/oracle/index.ts'"
tmux new-session -d -s "$SESSION2" "$TMUX_CMD2"
sleep 8
tmux send-keys -t "$SESSION2":0.0 "$PROMPT2" Enter
sleep 25

echo '--- pane:test2'
tmux capture-pane -p -S -220 -t "$SESSION2":0.0 | tail -n 160

echo '--- jobs created:test2'
find "$TEST2_JOBS" -maxdepth 1 -type d -name 'oracle-*' | sort || true

echo "TEST_ROOT=$TEST_ROOT"
```

### Expected observations

**Test 1 (whole-repo archive default exclusions):**

- Expected: the isolated `pi` session loads the local extension and `oracle_submit` creates a job and archive path under `$TEST1_JOBS`.
- Expected: the submit response forbids polling, describes the one-time completion wake-up in the submitting session, and names `oracle_read` with that job's `jobId` for user-requested status checks. `sanity:oracle` covers both dispatched and queued responses.
- Expected: expanding `.` excludes `.pi/`, `.oracle-context/`, `.cursor/`, and `.scratchpad.md` (`MISSING`), and includes normal repository files such as `README.md` (`FOUND`).
- Why the fixture writes `.oracle-seed-generation`: this smoke test does not require `/oracle-auth`, but `oracle_submit` rejects missing or unverified seed profiles before archiving; an empty marker (`touch`) counts as unverified and is rejected at submit time. With a timestamped marker-only seed profile, the worker fails later due to missing real auth, leaving the archive on disk for inspection.

**Test 2 (symlink escape rejection):**

- Expected: `oracle_submit` rejects `linked-outside/secret.txt` with an error stating that the archive input must resolve inside the project cwd without symlink escapes.
- Expected: no `oracle-*` job directory is created under `$TEST2_JOBS` for the rejected submission.
- Why the fixture writes `.oracle-seed-generation`: `TEST2_AGENT` needs the same timestamped marker-only seed profile so submission reaches archive input validation.

### Testing local `/oracle` command-prompt changes

The repeatable script above calls `oracle_submit` directly. If you changed `prompts/oracle.md` or `prompts/oracle-followup.md`, start the isolated session with the same local extension entrypoint so the extension reads the in-repo prompt file as hidden command-dispatch instructions without depending on `.pi/settings.json` package entries:

```bash
LOCAL_ORACLE_PI_CMD="pi --approve --session-dir '$TEST1_SESSIONS' --no-extensions -e '$REPO/extensions/oracle/index.ts'"
TMUX_CMD1="cd '$REPO' && env PI_CODING_AGENT_DIR='$TEST1_AGENT' PI_ORACLE_JOBS_DIR='$TEST1_JOBS' PATH='$PATH' $LOCAL_ORACLE_PI_CMD"
```

`/oracle` starts by calling `oracle_preflight`. To proceed past that early guard in an isolated test without touching your normal auth state, run `/oracle-auth` inside the isolated agent directory or create a purpose-built seed fixture with a non-empty `.oracle-seed-generation` marker.

### Cleanup and minimum pre-commit evidence

The script kills the temporary `tmux` sessions on exit. After inspecting the output, remove the temporary directory:

```bash
rm -rf "$TEST_ROOT"
```

Before committing code changes, keep evidence for:

- `npm run verify:oracle` (`npm test`) passing;
- isolated `pi` session validation using this workflow;
- any agent feedback gathered during the isolated run if it exposed clunky or unclear behavior.

## Focused failure-mode and managed-browser checks

### `/oracle-auth` timeout when `agent-browser` hangs

Use this check when modifying timeout or process-cleanup handling around auth and bootstrap browser commands. The script below configures a missing cookie file and a fake `agent-browser` binary that sleeps forever, then verifies that `/oracle-auth` aborts within the configured timeout instead of hanging the session:

```bash
set -euo pipefail

REPO="$PWD"
TEST_ROOT="/tmp/pi-oracle-auth-timeout-$$"
AGENT_DIR="$TEST_ROOT/agent"
SESSION_DIR="$TEST_ROOT/sessions"
JOBS_DIR="$TEST_ROOT/jobs"
FAKE_BROWSER="$TEST_ROOT/agent-browser"
SESSION_NAME="pi-oracle-auth-timeout"

mkdir -p "$AGENT_DIR/extensions" "$SESSION_DIR" "$JOBS_DIR"

cat > "$AGENT_DIR/extensions/oracle.json" <<JSON
{
  "auth": {
    "chromeCookiePath": "$TEST_ROOT/missing-cookies.sqlite"
  }
}
JSON

cat > "$FAKE_BROWSER" <<'SH'
#!/bin/sh
trap 'exit 0' TERM INT
while :; do sleep 1; done
SH
chmod +x "$FAKE_BROWSER"

cleanup() {
  tmux kill-session -t "$SESSION_NAME" 2>/dev/null || true
}
trap 'cleanup; rm -rf "$TEST_ROOT"' EXIT
cleanup

TMUX_CMD="cd '$REPO' && env PI_CODING_AGENT_DIR='$AGENT_DIR' PI_ORACLE_JOBS_DIR='$JOBS_DIR' AGENT_BROWSER_PATH='$FAKE_BROWSER' PI_ORACLE_AUTH_AGENT_BROWSER_TIMEOUT_MS='250' PI_ORACLE_AUTH_CLOSE_TIMEOUT_MS='250' PI_ORACLE_AUTH_KILL_GRACE_MS='100' PATH='$PATH' pi --approve --session-dir '$SESSION_DIR' --no-extensions -e '$REPO/extensions/oracle/index.ts'"

tmux new-session -d -s "$SESSION_NAME" "$TMUX_CMD"
sleep 8
tmux send-keys -t "$SESSION_NAME":0.0 '/oracle-auth' Enter
sleep 12

tmux capture-pane -p -S -220 -t "$SESSION_NAME":0.0 | tail -n 140
```

Expected observations:

- the isolated `pi` session loads the local extension;
- `/oracle-auth` returns an error instead of hanging indefinitely;
- the output mentions the missing ChatGPT session-token cookies or the configured cookie source problem;
- the session remains usable after the command failure.

### Managed browser mode

Changes that touch `browser.chatGptManagedProfileDir` (launch, attach, keeper, sign-in, or readiness) require a run in managed-browser mode through the Oh My Pi print-mode route. The command below gives the session an isolated state directory (holding the keeper log and profile lock) and a 15-second idle grace (`PI_ORACLE_MANAGED_BROWSER_IDLE_MS=15000`) to validate launch, attach, per-command browser-identity checks, and the idle keeper quit without spending a ChatGPT response:

```bash
set -euo pipefail

REPO="$PWD"
TEST_ROOT="/tmp/pi-oracle-managed-tests-$$"
AGENT="$TEST_ROOT/agent"
PROFILE="$TEST_ROOT/managed-profile"

mkdir -p "$AGENT/extensions" "$TEST_ROOT/sessions" "$TEST_ROOT/jobs" "$TEST_ROOT/state" "$PROFILE"
cp "<models.yml for the chosen model>" "$AGENT/models.yml"
printf '{"browser":{"chatGptManagedProfileDir":"%s","args":["--disable-sync"]}}\n' "$PROFILE" > "$AGENT/extensions/oracle.json"

PROMPT='Call oracle_preflight once for ChatGPT, then oracle_submit exactly once with prompt "Reply with exactly: MANAGED OK", files ["README.md"], preset "instant". Do not use bash. Report both results and one sentence of candid feedback on anything unclear or clunky.'
env PI_CODING_AGENT_DIR="$AGENT" PI_ORACLE_JOBS_DIR="$TEST_ROOT/jobs" PI_ORACLE_STATE_DIR="$TEST_ROOT/state" \
  PI_ORACLE_MANAGED_BROWSER_IDLE_MS=15000 PI_TELEMETRY=0 \
  omp --cwd "$REPO" -p --auto-approve --session-dir "$TEST_ROOT/sessions" \
  --model <model id> --thinking low --no-extensions -e "$REPO/extensions/oracle/index.ts" "$PROMPT" < /dev/null
```

Expected observations for the unsigned profile: the empty profile is not signed in, so the job is expected to fail at `verifying_auth` and ask you to rerun `/oracle-auth`. Running `oracle_auth` the same way opens a ChatGPT sign-in tab and reports that a person must sign in; close that tab afterwards, or the keeper keeps Chrome open for it.

For a signed-in run, never point the test session at a profile whose Chrome is serving live jobs, such as the Chrome behind your relay endpoint. Clone that profile into `$PROFILE`, remove its singleton lock files, and mark it cleanly exited before running the session:

```bash
SIGNED_IN_PROFILE="<signed-in Chrome user-data directory>"
rm -rf "$PROFILE"
cp -c -R "$SIGNED_IN_PROFILE" "$PROFILE"
# The live holder's singleton files would hand the launch to the running Chrome.
rm -f "$PROFILE"/Singleton{Lock,Socket,Cookie} "$PROFILE/DevToolsActivePort"
# A managed launch starts from a cleanly quit profile.
node -e 'const fs = require("fs"), f = process.argv[1], p = JSON.parse(fs.readFileSync(f, "utf8")); p.profile = { ...p.profile, exit_type: "Normal", exited_cleanly: true }; fs.writeFileSync(f, JSON.stringify(p));' "$PROFILE/Default/Preferences"
```

The clone's cookies remain encrypted with this Mac's Chrome Safe Storage key, so it signs in only with the same Chrome on the same machine, and `--disable-sync` in the config keeps it from syncing as the live profile's Chrome client. Delete `$TEST_ROOT` afterwards because the clone holds session cookies.

Expected observations for the signed-in profile:

- the worker log shows `Opened the managed ChatGPT browser at http://127.0.0.1:<port>` (`Reusing …` when a Chrome started with `--remote-debugging-port=0` already serves the profile), and `job.json` records that endpoint under `managedBrowser`;
- the signed-in job completes with `MANAGED OK` and no cleanup warnings;
- `$TEST_ROOT/state/managed-browser.log` shows `started Chrome`, then, about 15 seconds after the last job and page close, `quit Chrome … with no job and no page` and `exited (exit code 0)`;
- `agent-browser session list` does not list the job's `runtimeSessionName` after teardown.

## Auth recovery drill

Use this maintainer drill to validate missing or unauthenticated seed detection and `/oracle-auth` recovery on the isolated seed profile transport. The drill proves four things:

1. an empty or unauthenticated seed profile is refused cleanly at submission before creating an archive or job;
2. the blocker is reported as an auth seed readiness failure, not as generic UI drift;
3. `/oracle-auth` repairs the seed profile without touching the real Chrome profile;
4. the next oracle job completes normally.

### Safety guarantees and preconditions

- **Safety:** This drill mutates only the isolated oracle seed profile configured by `browser.authSeedProfileDir`. Never point `SEED` at your real Chrome user-data directory.
- **Preconditions:** No active oracle jobs; `pi` reloaded with the current extension code; `/oracle-auth` already known to work in the current environment.

### 1. Back up the current seed profile

Copy the current isolated seed profile before mutating it so you can restore it if needed:

```bash
SEED="<oracle-auth-seed-profile-dir>"
BACKUP="/tmp/oracle-auth-seed-backup-$(date +%Y%m%dT%H%M%S)"
cp -cR "$SEED" "$BACKUP"
echo "$BACKUP"
```

### 2. Simulate an unauthenticated seed profile

Replace the seed directory with an empty isolated directory (no `.oracle-seed-generation` marker):

```bash
SEED="<oracle-auth-seed-profile-dir>"
rm -rf "$SEED"
mkdir -p "$SEED"
chmod 700 "$SEED"
```

### 3. Verify submission refusal

1. Reload `pi` so the extension reads the current seed directory state.
2. Run `oracle_preflight` or attempt a tiny oracle submission.

Expected observations:

- `oracle_submit` refuses the submission before creating an archive or persisting a job directory with:
  `Oracle auth seed profile exists but is not authenticated: <dir>. Run /oracle-auth to create a verified auth seed before submitting oracle jobs.`
  (If `<dir>` was removed and not recreated, expected refusal is: `Oracle auth seed profile not found: <dir>. Run /oracle-auth first.`)
- `oracle_preflight` reports the same auth seed blocker.
- The refusal is not misclassified as a model configuration failure, artifact failure, generic timeout, or UI drift.

### 4. Repair with `/oracle-auth` and rerun

1. Run `/oracle-auth`:

   ```text
   /oracle-auth
   ```

   Expected: provider cookies are synced into the isolated seed profile, `.oracle-seed-generation` is written, no real Chrome profile is mutated, and the command reports success.
2. Reload `pi` after auth repair.
3. Submit the same tiny oracle job again.
   Expected: the job completes, persists its response under `/tmp/oracle-<job-id>/response.md`, and triggers the session wake-up.

### Pass criteria and evidence to capture

The drill passes only when all of the following hold:

- the unauthenticated seed directory is refused at preflight and submission with the exact auth seed message above;
- `/oracle-auth` repairs the seed profile cleanly without mutating the real Chrome profile;
- the subsequent oracle job completes with no worker, session, or profile cleanup regressions.

Capture as evidence:

- **For the refusal step:** the exact `oracle_preflight` or `oracle_submit` refusal text (no `/tmp/oracle-<job-id>/` directory is created because submission is refused before archiving or job creation).
- **For the repair step:** the per-run `/tmp/pi-oracle-auth-*/` diagnostics directory printed by `/oracle-auth` (`oracle-auth.log`, `oracle-auth.url.txt`, `oracle-auth.snapshot.txt`, `oracle-auth.body.txt`).
- **For the completed rerun:** `/tmp/oracle-<job-id>/job.json`, `/tmp/oracle-<job-id>/response.md`, and `/tmp/oracle-<job-id>/logs/worker.log`.

### Maintainer note and failure handling

This is a maintainer validation procedure, not end-user setup documentation; it intentionally replaces the isolated oracle seed profile.

- If the unauthenticated seed step is not refused cleanly as an auth seed blocker, fix seed readiness before treating recovery as ready.
- If `/oracle-auth` does not restore a working seed, restore `"$BACKUP"` into `"$SEED"` and treat auth recovery as blocking.
