# Oracle isolated `pi` validation

This document describes the repeatable pre-commit smoke test for validating `pi-oracle` through isolated `pi` agent sessions that load the local extension source.

Use this workflow for code changes when you need end-to-end evidence beyond `npm test`.

## What this validates

- the local extension can be loaded directly by isolated `pi` sessions
- whole-repo `oracle_submit` archive creation excludes local tool state by default
- targeted archive inputs cannot escape the repo through symlinked paths
- the exercised `pi` agents can provide candid feedback about tool clarity or clunkiness

## Why this workflow is isolated

The test intentionally uses separate directories for:

- `PI_CODING_AGENT_DIR`
- `--session-dir`
- `PI_ORACLE_JOBS_DIR`

That keeps the validation run from reusing your normal `pi` agent state.

The extension is loaded from the local checkout with:

```bash
pi --no-extensions -e "$REPO/extensions/oracle/index.ts"
```

That ensures the session is exercising the in-repo code, not a globally installed package.

If you also need the in-repo `/oracle` prompt template, load it explicitly instead of installing this repository as a project-local package:

```bash
pi --no-extensions -e "$REPO/extensions/oracle/index.ts" \
  --no-prompt-templates --prompt-template "$REPO/prompts/oracle.md"
```

Do not add `https://github.com/fitchmultz/pi-oracle` to this repository's `.pi/settings.json` just to test local oracle changes. If you already keep `npm:pi-oracle` installed globally, mixing the global npm package with a project-local git package creates two distinct package identities and can trigger prompt/tool conflicts. Use the explicit CLI resource flags above instead.

`oracle_submit` now preflights a missing or unreadable auth seed profile before it creates an archive or persists a job. For archive-inspection smoke tests that intentionally run without real auth, create an empty isolated seed-profile directory under the temporary agent dir so submission can proceed far enough to write the archive while still staying isolated from your normal Chrome state.

## Preset requirement

Use either:

- `instant`
- `thinking_light`

The examples below use `instant` because it is the fastest smoke-test preset.

## Prerequisites

- `pi` installed locally
- `tmux` installed locally
- run from the repository root

## Repeatable smoke test

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

mkdir -p "$TEST1_AGENT/extensions/oracle-auth-seed-profile"

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

TMUX_CMD1="cd '$REPO' && env PI_CODING_AGENT_DIR='$TEST1_AGENT' PI_ORACLE_JOBS_DIR='$TEST1_JOBS' PATH='$PATH' pi --session-dir '$TEST1_SESSIONS' --no-extensions -e '$REPO/extensions/oracle/index.ts'"
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

TMUX_CMD2="cd '$FIXTURE' && env PI_CODING_AGENT_DIR='$TEST2_AGENT' PI_ORACLE_JOBS_DIR='$TEST2_JOBS' PATH='$PATH' pi --session-dir '$TEST2_SESSIONS' --no-extensions -e '$REPO/extensions/oracle/index.ts'"
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

## Expected results

### Test 1: whole-repo archive exclusions

Expected behavior:

- the isolated `pi` session loads the local extension successfully
- `oracle_submit` creates a job and an archive path under the isolated jobs dir
- the archive should exclude:
  - `.pi/`
  - `.oracle-context/`
  - `.cursor/`
  - `.scratchpad.md`
- the archive should still include normal repo files such as `README.md`

Notes:

- this smoke test does not require `/oracle-auth`
- the snippet creates an empty isolated auth seed profile for `TEST1_AGENT` because `oracle_submit` now rejects a missing seed profile before archiving
- with that empty seed profile, the worker still fails later due to missing real auth, which is useful because the archive remains on disk for inspection

### Test 2: symlink escape rejection

Expected behavior:

- `oracle_submit` rejects `linked-outside/secret.txt`
- the error should say the archive input must resolve inside the project cwd without symlink escapes
- no oracle job directory should be created for the rejected submit

## Testing local `/oracle` prompt changes too

The main smoke test above calls `oracle_submit` directly, so it only needs the local extension entrypoint. If you also changed `prompts/oracle.md`, start the isolated session with the local prompt template explicitly loaded:

```bash
LOCAL_ORACLE_PI_CMD="pi --session-dir '$TEST1_SESSIONS' --no-extensions -e '$REPO/extensions/oracle/index.ts' --no-prompt-templates --prompt-template '$REPO/prompts/oracle.md'"
TMUX_CMD1="cd '$REPO' && env PI_CODING_AGENT_DIR='$TEST1_AGENT' PI_ORACLE_JOBS_DIR='$TEST1_JOBS' PATH='$PATH' $LOCAL_ORACLE_PI_CMD"
```

Use the same pattern for additional sessions, swapping the session/job directories as needed. This keeps the test on the in-repo extension and in-repo prompt template without depending on `.pi/settings.json` package entries.

`/oracle` now starts by calling `oracle_preflight`. If you want the prompt flow to proceed past that early guard in an isolated test without using your normal auth state, create an empty isolated auth seed profile first (for example `mkdir -p "$TEST1_AGENT/extensions/oracle-auth-seed-profile"`) or run `/oracle-auth` in the isolated agent dir.

## Additional failure-mode smoke tests

### `/oracle-auth` should fail fast when `agent-browser` hangs

Use this when validating timeout hardening around auth/bootstrap browser commands.

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

TMUX_CMD="cd '$REPO' && env PI_CODING_AGENT_DIR='$AGENT_DIR' PI_ORACLE_JOBS_DIR='$JOBS_DIR' AGENT_BROWSER_PATH='$FAKE_BROWSER' PI_ORACLE_AUTH_AGENT_BROWSER_TIMEOUT_MS='250' PI_ORACLE_AUTH_CLOSE_TIMEOUT_MS='250' PI_ORACLE_AUTH_KILL_GRACE_MS='100' PATH='$PATH' pi --session-dir '$SESSION_DIR' --no-extensions -e '$REPO/extensions/oracle/index.ts'"

tmux new-session -d -s "$SESSION_NAME" "$TMUX_CMD"
sleep 8
tmux send-keys -t "$SESSION_NAME":0.0 '/oracle-auth' Enter
sleep 12

tmux capture-pane -p -S -220 -t "$SESSION_NAME":0.0 | tail -n 140
```

Expected behavior:

- the isolated `pi` session loads the local extension successfully
- `/oracle-auth` returns with an error instead of hanging indefinitely
- the output should mention the missing ChatGPT session-token cookies or the configured cookie source problem
- the session should remain usable after the command failure

## Switching to `thinking_light`

To run the same smoke test with `thinking_light`, change both prompts from:

```text
preset "instant"
```

to:

```text
preset "thinking_light"
```

## Cleanup

The snippet already kills the temporary `tmux` sessions on exit.

To remove the temporary files after inspection:

```bash
rm -rf "$TEST_ROOT"
```

## Minimum pre-commit evidence

Before committing code changes, keep evidence for:

- `npm test` passing
- isolated `pi` session validation using this workflow
- any agent feedback gathered during the isolated run if it exposed clunky or unclear behavior
