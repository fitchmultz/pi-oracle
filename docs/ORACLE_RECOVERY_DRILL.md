# Oracle Recovery Drill

This document codifies the safe validation drill for expired / missing auth in the isolated oracle seed profile.

The goal is to prove:
1. a broken seed profile fails cleanly
2. the failure is classified as auth/login-required, not as generic UI drift
3. `/oracle-auth` repairs the seed profile
4. the next normal oracle job succeeds again

## Safety guarantees

This drill must **not** touch the user’s real Chrome profile.
It only mutates the isolated oracle seed profile configured by `browser.authSeedProfileDir`.

That directory must remain separate from the real Chrome user-data tree.

## Preconditions

- No active oracle jobs
- `pi` reloaded with the current extension code
- `/oracle-auth` happy path already known to work in the current environment

## Backup

Create a backup of the current seed profile first:

```bash
SEED="<oracle-auth-seed-profile-dir>"
BACKUP="/tmp/oracle-auth-seed-backup-$(date +%Y%m%dT%H%M%S)"
cp -cR "$SEED" "$BACKUP"
echo "$BACKUP"
```

## Expired/missing-auth simulation

Replace the seed profile with an empty isolated directory:

```bash
SEED="<oracle-auth-seed-profile-dir>"
rm -rf "$SEED"
mkdir -p "$SEED"
chmod 700 "$SEED"
```

This simulates a seed profile with no usable ChatGPT session.

## Validation steps

### 1. Reload `pi`

Reload so the extension sees the current seed directory state.

### 2. Run a tiny oracle job

Use a tiny prompt with a tiny archive.
Expected result:
- job fails quickly
- failure is clearly auth/login related
- failure is **not** misclassified as:
  - model configuration failure
  - artifact failure
  - generic timeout
  - vague UI drift

### 3. Repair with `/oracle-auth`

Run:

```text
/oracle-auth
```

Expected result:
- ChatGPT cookies are re-synced into the seed profile
- no real Chrome profile is mutated
- command reports success

### 4. Reload `pi` again

Reload after auth repair.

### 5. Run the same tiny oracle job again

Expected result:
- job succeeds normally
- response persists under `/tmp/oracle-<job-id>/response.md`
- wake-up triggers correctly

## Pass criteria

The drill passes only if all of the following are true:

- Broken seed profile fails as an auth/login-required problem
- `/oracle-auth` repairs the seed profile cleanly
- The next normal oracle run succeeds
- No active worker/session/profile cleanup regressions appear
- No interaction with the real Chrome profile is required beyond cookie sync during `/oracle-auth`

## Evidence to capture

For the failed run:
- `/tmp/oracle-<job-id>/job.json`
- `/tmp/oracle-<job-id>/logs/worker.log`
- any failure diagnostics under that job dir

For the repair:
- the per-run `/tmp/pi-oracle-auth-*/` diagnostics directory printed by `/oracle-auth`
- `oracle-auth.log`
- `oracle-auth.url.txt`
- `oracle-auth.snapshot.txt`
- `oracle-auth.body.txt`

For the successful rerun:
- `/tmp/oracle-<job-id>/job.json`
- `/tmp/oracle-<job-id>/response.md`
- `/tmp/oracle-<job-id>/logs/worker.log`

## Maintainer note

This is a maintainer/operator validation document, not end-user setup documentation.
It intentionally includes destructive steps against the isolated oracle seed profile only.

## If the drill fails

If the broken-seed run fails with anything other than a clean auth classification, fix that before treating recovery as production-ready.

If `/oracle-auth` does not restore a working seed, treat auth recovery as still blocking.
