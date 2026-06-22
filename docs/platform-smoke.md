# pi-oracle Crabbox platform smoke

`pi-oracle` uses Crabbox for the local release-blocking platform gate. The gate runs on macOS, Ubuntu Linux, and native Windows and is meant to catch broken package installs, platform assumptions, and real `pi` tool-call failures before push or publish.

## Source of truth

- Config: [`../platform-smoke.config.mjs`](../platform-smoke.config.mjs)
- CLI: [`../scripts/platform-smoke.mjs`](../scripts/platform-smoke.mjs)
- Target runner: [`../scripts/platform-smoke/targets.mjs`](../scripts/platform-smoke/targets.mjs)
- Windows build script: [`../scripts/platform-smoke/platform-build-windows.ps1`](../scripts/platform-smoke/platform-build-windows.ps1)
- Real runtime smoke: [`../scripts/oracle-real-smoke.mjs`](../scripts/oracle-real-smoke.mjs)
- Artifact root: `.artifacts/platform-smoke/` (gitignored)

Required targets: `macos`, `ubuntu`, `windows-native`.
Required suites: `platform-build`, `real-extension`.
Crabbox baseline: `0.26.0` or newer.

## Required local setup

Install Crabbox with Homebrew and keep it on `PATH`:

```bash
brew install openclaw/tap/crabbox
crabbox --version
crabbox providers
```

`PLATFORM_SMOKE_CRABBOX` is the reusable binary override. `PI_ORACLE_SMOKE_CRABBOX` is a project-specific alias and wins when both are set.

Target setup:

- macOS: Remote Login enabled; noninteractive `ssh $USER@localhost` works; `node`, `npm`, `git`, `tar`, `rsync`, `zstd`, and `agent-browser` are on the SSH PATH.
- Ubuntu: Docker is running and the configured image (`PI_ORACLE_SMOKE_UBUNTU_IMAGE`, default `pi-oracle-platform-smoke:node24`) has `node`, `npm`, `git`, `tar`, `rsync`, `zstd`, and `agent-browser` on PATH. Build the local image when needed with `docker build -t pi-oracle-platform-smoke:node24 -f scripts/platform-smoke/Dockerfile.ubuntu .`.
- Windows native: Parallels has stopped source VM `pi-extension-windows-template` and the configured power-off snapshot (`crabbox-ready` by default for this repo). The template must have OpenSSH, PowerShell, Git, Node/npm, `tar`, `zstd`, and `agent-browser` on PATH. Do not bake API keys, browser sessions, project checkouts, `.pi` state, artifacts, or secrets into the template.

Real runtime suite auth:

- Default deterministic installed-tool smoke does not require provider API keys.
- Provider/model defaults remain `zai/glm-5.2` for optional model-agent debugging.
- Set `PI_ORACLE_REAL_TEST_MODEL_AGENT=1` to run the slower model-agent path; then the provider auth env is required (`ZAI_API_KEY` by default, reported only as present/redacted).
- Override with `PI_ORACLE_REAL_TEST_PROVIDER` and `PI_ORACLE_REAL_TEST_MODEL`; auth variable names live in `platform-smoke.config.mjs`.

## Canonical validation workflows

Use the narrowest workflow that proves the change. Do not run the full platform matrix for ordinary edits when the local gate and cheap invariants prove the change.

| Situation | Canonical command(s) | What it proves |
| --- | --- | --- |
| Everyday local iteration | `npm run verify:oracle` | Syntax, bundle, platform-smoke invariants, type checks, oracle sanity, and package dry-run pass locally. |
| Platform-sensitive change | `npm run smoke:platform:doctor`, then `node scripts/platform-smoke.mjs run --target <target> --suite <suite>` | Target setup is ready and the affected platform/suite works without paying for unrelated targets. |
| Platform matrix proof | `npm run smoke:platform:all` | Doctor-first packed-install proof passes on every required target and suite. |
| ChatGPT preset release proof | `npm run release:proof:chatgpt-presets` | Fresh loaded-extension proof exists for every canonical ChatGPT preset. |
| Publish/release gate | `npm run release:check` | Local verification (`verify:oracle`) passes, fresh ChatGPT preset proof exists, then the doctor-first platform matrix passes. |

Platform-sensitive changes include archive behavior, process cleanup, runtime/browser profile handling, package metadata, Crabbox harness code, or anything that may differ across macOS/Linux/Windows.

## Commands

Doctor is mandatory before the full platform matrix. The canonical all-target platform command enforces that:

```bash
npm run smoke:platform:all
```

Focused commands:

```bash
npm run smoke:platform:doctor
npm run smoke:platform:macos
npm run smoke:platform:ubuntu
npm run smoke:platform:windows-native
node scripts/platform-smoke.mjs run --target windows-native --suite real-extension
```

Full release gate:

```bash
npm run release:check
```

`release:check` runs `verify:oracle`, then `release:proof:chatgpt-presets`, then `smoke:platform:all`, matching the release order: cheap harness checks, fresh live ChatGPT preset proof, doctor, full matrix, then artifact review. `prepublishOnly` runs `npm run release:check`.

## What `platform-build` proves

On each required target, `platform-build`:

1. checks Node major version against `nodeValidationMajor`;
2. runs `npm ci`;
3. requires target tools (`zstd`, `agent-browser`) to already be available from target setup;
4. runs `npm run verify:oracle:platform`, the platform-focused gate for syntax, platform-smoke invariants, real-smoke script syntax, platform-sensitive oracle sanity coverage, and package dry-run;
5. runs `npm pack`;
6. creates a fresh target-local pi project;
7. runs `npm install --no-save <packed tarball>`;
8. runs `pi install -l ./node_modules/pi-oracle --approve` so Pi 0.79+ project-trust gating intentionally trusts the temporary fixture;
9. runs `pi list --approve`;
10. asserts the installed package came from `node_modules/pi-oracle` and did not use `pi -e` / source-extension shortcuts.

## What `real-extension` proves

`real-extension` is required release proof. It runs `npm run smoke:real:packed` on each target, which:

1. packs this checkout with `npm pack`;
2. installs the tarball into a clean pi project;
3. runs `pi install -l ./node_modules/pi-oracle --approve`;
4. asserts `pi list --approve` shows the packed install path;
5. executes `oracle_submit` from the installed package path, not source `pi -e`;
6. asserts whole-project archive creation and default exclusions.

The default runtime suite executes the installed tool directly so platform proof is deterministic and bounded instead of waiting on a model turn. Set `PI_ORACLE_REAL_TEST_MODEL_AGENT=1` only when you specifically need to debug the slower model-agent path. Symlink escape rejection and other negative archive cases are covered by `npm run sanity:oracle`; the optional second-agent negative check is available with `PI_ORACLE_REAL_TEST_NEGATIVE_SYMLINK=1` when debugging that path.

For inner-loop/debug only, use:

```bash
npm run smoke:real:source
```

That source-mode smoke loads `extensions/oracle/index.ts` with `pi --approve --no-extensions -e`; it is useful while developing but is not release proof.

## Artifacts

Each suite writes reviewable evidence under:

```text
.artifacts/platform-smoke/<run-id>/<target>/<suite>/
  summary.json
  target.json
  suite.json
  command.txt
  exit-code.txt
  crabbox.stdout.txt
  crabbox.stderr.txt
  crabbox.timing.json
  crabbox.stop.stdout.txt
  crabbox.stop.stderr.txt
  crabbox.stop.exit-code.txt
  assertions.json
  artifact-manifest.json
  failures.md            # only on failure
```

`platform-build` also writes packed install extracts (`packed-tarball.txt`, `packed-node-install.*`, `pi-install.*`, `pi-list.*`). Passing suites require `summary.ok === true`, `assertions.ok === true`, and `artifact-manifest.missing.length === 0`.

Artifacts are local evidence only. Do not commit or share them without redaction. Secret scans fail on bearer/API-key/cookie-like values.

## Windows template maintenance

When Windows lacks a reusable tool such as `zstd` or `agent-browser`, update the shared `pi-extension-windows-template` infrastructure rather than adding a per-run installer:

1. revert/switch `pi-extension-windows-template` to the current canonical `crabbox-ready` snapshot;
2. boot the template;
3. install/update the reusable tool globally without secrets;
4. verify from a fresh SSH session: `node --version`, `npm --version`, `git --version`, `tar --version`, `zstd --version`, `agent-browser --version`, and `agent-browser install`;
5. remove downloads, caches, checkouts, `.pi`, `.artifacts`, `.debug`, browser auth/session state, and secrets;
6. shut down cleanly;
7. create/promote the configured power-off `crabbox-ready` snapshot;
8. run `npm run smoke:platform:doctor` and `npm run smoke:platform:windows-native` against the promoted snapshot;
9. clean stale clones/leases.
