# Development and release reference

The [README](../README.md) is the user entry point. Architecture and lifecycle details live in [ORACLE_DESIGN.md](ORACLE_DESIGN.md).

## Host qualification

Required offline qualification targets are the latest stable official Pi and latest maintained fork `main`, resolving version/commit once per workflow run and retaining exact SDK/CLI evidence. Locked development dependencies are reproducible snapshots, not validation targets; the platform-smoke harness covers macOS, Linux, and Windows native with Chromium-family browsers. Pi `0.80.9+` is the suggested tested floor for project-trust-aware package/runtime validation, but pi-bundled runtime packages remain optional wildcard peers so npm peer ranges do not block users from trying newer pi releases.

Package install/use requires Node.js 22.19.0 or newer; platform smoke/release validation expects Node 24+ per `platform-smoke.config.mjs`.

Production hardening should keep focusing on UI drift detection, auth recovery, artifact capture, platform compatibility, and environment diagnostics.

## Automatic npm releases (maintainers)

Follow the [shared release procedure](https://github.com/fitchmultz/.github#automatic-npm-releases): merge a reviewed PR into `main` with an intentional `package.json` version bump and a matching versioned `CHANGELOG.md` section. Automation never bumps versions, overwrites releases, or republishes an existing version. Once configured and enabled, it runs existing offline compatibility checks, qualifies one candidate tarball, then waits for `fitchmultz` approval in the `npm` environment.

Approve only after checking the exact source commit, version, downloaded candidate tarball and summary against [the existing `release:check` requirements](#verification) and [packed platform proof](platform-smoke.md). Fresh all-preset ChatGPT proof must match that commit/version, satisfy the proof checker's timing and saved-response requirements, and accompany the required doctor-first macOS/Ubuntu/native-Windows evidence. Old-commit proof is not sufficient. Approval attests genuine satisfaction of these gates; it does not create proof or waive `release:check`. Authenticated and paid checks remain outside CI. Automated publication disables npm hooks to publish the checked bytes; manual `npm publish` still runs its existing `prepublishOnly` gate.

Failed/unpublished candidates can retry daily at 12:17 UTC or via manual dispatch of `npm release` on `main`, without another bump. Set repository variable `NPM_RELEASE_ENABLED` to anything other than `true` to stop new release plans; cancel pending runs separately when needed. Workflow validation is not evidence of a completed real OIDC publication.

## Verification

For credential-free latest-host qualification, use the shared qualifier with `--host official --target latest` and separately with the packed latest maintained fork revision. It selects a consistent host graph before running `npm run check:compat` with an empty HOME/agent profile. A plain `npm ci --ignore-scripts` uses only the locked development snapshot, not latest qualification. It runs the existing syntax, type, isolated sanity, and pack checks plus native Pi `/oracle-status` dispatch, asserting that no browser job is created. Sanity uses fixture browser/keychain commands and private job/state directories; it needs local archive utilities (`tar` and `zstd`), not browser credentials. This is source/host proof, not authenticated ChatGPT/Grok or packed cross-platform release proof. The older suggested floor is historical support guidance, not requalified by a current-host run.

Useful local checks:

```bash
npm run check:oracle-extension
npm run check:platform-smoke
npm run typecheck
npm run typecheck:worker-helpers
npm run sanity:oracle
npm run pack:check
npm test
npm run verify:oracle
```

`npm test` runs `npm run verify:oracle`, so it is not a separate gate from the final line above.

Known development dependency warning: the official Pi 1.0.0 npm package's `npm-shrinkwrap.json` still pins `brace-expansion` `5.0.9`, which has brace-expansion denial-of-service advisories. npm 11 preserves that vendor-pinned subtree even with a root override; dropping the shrinkwrap to obtain a clean audit is not a fix. The warning predates the Pi 1.0 baseline upgrade and needs an upstream host dependency fix. Dependencies embedded in a prebuilt Pi CLI bundle likewise require a fixed host distribution.

`npm publish` is guarded by `prepublishOnly`, which runs `npm run release:check`. That release gate now blocks unless fresh live ChatGPT preset proof exists for every canonical preset, then requires doctor-first macOS, Ubuntu, and Windows native Crabbox evidence. The required Crabbox runtime suite uses packed-install proof, not source-tree `pi -e` loading.

Use the narrowest validation workflow that proves the change:

| Situation | Command(s) |
| --- | --- |
| Everyday local iteration | `npm run verify:oracle` |
| Platform-focused syntax/invariant sanity | `npm run check:platform-smoke`, `npm run sanity:oracle:platform` |
| Platform-sensitive runtime changes | `npm run smoke:platform:doctor`, then a focused `node scripts/platform-smoke.mjs run --target <target> --suite <suite>` |
| Platform matrix proof | `npm run smoke:platform:all` |
| ChatGPT preset release proof | `npm run release:proof:chatgpt-presets` |
| Publish/release gate | `npm run release:check` |

For macOS, Ubuntu, and Windows native package/build plus packed runtime validation, use [`docs/platform-smoke.md`](platform-smoke.md). The full release gate is:

```bash
npm run release:check
```

Before a release, run live jobs through the loaded extension for every ChatGPT preset in `ORACLE_SUBMIT_PRESETS`. Each prompt must make the saved response contain exact markers `PRESET <preset> OK` and `PACKAGE pi-oracle`. After every job has completed, save the job ids/job directories in `.artifacts/chatgpt-preset-proof/latest.json`; `validatedAt` must be later than the completed jobs. Start from the checked, intentionally non-valid template:

```bash
mkdir -p .artifacts/chatgpt-preset-proof
node scripts/oracle-chatgpt-preset-proof.mjs template > .artifacts/chatgpt-preset-proof/latest.json
npm run release:proof:chatgpt-presets
```

The proof checker is intentionally part of `release:check`; it fails if the proof is missing, stale, tied to a different package version/git head, references jobs that completed before the current commit, or lacks actual persisted ChatGPT `.tar.zst` job state and response text for any canonical preset.

The real runtime suite defaults to deterministic installed-tool execution so platform proof stays bounded. Provider/model defaults remain `zai/glm-5.2` for doctor/config and for optional model-agent debugging; override with `PI_ORACLE_REAL_TEST_PROVIDER` and `PI_ORACLE_REAL_TEST_MODEL` when needed. For inner-loop source loading only, use `npm run smoke:real:source`; it is not release proof. Set `PI_ORACLE_REAL_TEST_MODEL_AGENT=1` only when debugging the slower model-agent path. The optional second real-agent negative symlink check is opt-in via `PI_ORACLE_REAL_TEST_NEGATIVE_SYMLINK=1`; `npm run sanity:oracle` covers archive/symlink rejection by default without adding another model-agent turn to the platform release gate.

For manual end-to-end local-extension smoke testing, use [`docs/ORACLE_ISOLATED_PI_VALIDATION.md`](ORACLE_ISOLATED_PI_VALIDATION.md). Ordinary pre-commit smoke runs can still use `instant` or `thinking_light`, but release proof must cover every canonical ChatGPT preset through the loaded extension.

## Implementation entry points

| Problem | Capability | Proof in this repo |
| --- | --- | --- |
| Hard tasks need more context than a quick turn should gather. | `/oracle` prompts the agent to preflight, choose a context-rich archive, and submit it to the selected provider web app. | [`prompts/oracle.md`](../prompts/oracle.md), `oracle_submit`, archive tests in `scripts/oracle-sanity-*` |
| Browser automation should not steal focus or mutate your active profile. | Jobs clone an authenticated seed profile into per-job isolated runtime profiles. | [`docs/ORACLE_DESIGN.md`](ORACLE_DESIGN.md), [`extensions/oracle/lib/runtime.ts`](../extensions/oracle/lib/runtime.ts) |
| Long jobs need durability. | Job state, responses, logs, and artifacts persist under `${PI_ORACLE_JOBS_DIR:-/tmp}/oracle-<job-id>/`. | [`extensions/oracle/lib/jobs.ts`](../extensions/oracle/lib/jobs.ts), `/oracle-read`, `/oracle-status` |
| Provider auth can expire or drift. | `/oracle-auth [chatgpt|grok]` refreshes the isolated auth seed from a configured local Chromium profile, with recovery guidance. | [`extensions/oracle/lib/auth.ts`](../extensions/oracle/lib/auth.ts), [`docs/ORACLE_RECOVERY_DRILL.md`](ORACLE_RECOVERY_DRILL.md) |
| Agents need a simple API, not UI-driving instructions. | The package exposes agent-facing tools: `oracle_preflight`, `oracle_submit`, `oracle_read`, `oracle_auth`, and `oracle_cancel`. | [`extensions/oracle/lib/tools.ts`](../extensions/oracle/lib/tools.ts) |

## Project map

| Path | Purpose |
| --- | --- |
| [`extensions/oracle/index.ts`](../extensions/oracle/index.ts) | Extension entrypoint |
| `extensions/oracle/lib/` | Commands, tools, config, jobs, queueing, runtime, poller |
| `extensions/oracle/worker/` | Detached provider web worker and UI/auth helpers |
| `extensions/oracle/shared/` | Shared process, state, job, and observability helpers |
| [`prompts/oracle.md`](../prompts/oracle.md) | Hidden `/oracle` command-dispatch workflow |
| [`prompts/oracle-followup.md`](../prompts/oracle-followup.md) | Hidden `/oracle-followup` command-dispatch workflow |
| `scripts/oracle-sanity-*` | Local sanity and archive-safety checks |
| `scripts/platform-smoke*` | Crabbox macOS, Ubuntu, and Windows release smoke gate |
| [`docs/ORACLE_DESIGN.md`](ORACLE_DESIGN.md) | Architecture, lifecycle, queueing, persistence, recovery behavior |
| [`docs/ORACLE_ISOLATED_PI_VALIDATION.md`](ORACLE_ISOLATED_PI_VALIDATION.md) | Repeatable isolated `pi` validation workflow |
| [`docs/ORACLE_RECOVERY_DRILL.md`](ORACLE_RECOVERY_DRILL.md) | Safe expired-auth recovery drill |
