# OMP Oracle platform smoke gate

`omp-oracle` uses Crabbox (`0.26.0` or newer) for the local release-blocking platform gate across macOS and Ubuntu Linux, catching broken package installs, platform assumptions, and real `pi` tool-call failures before push or publish. For when to run platform smoke versus the local gate or isolated-session checks, see [Test plan](TEST_PLAN.md#which-check-to-run).

Companion docs: [Test plan](TEST_PLAN.md) · [Release](RELEASE.md)

## Source of truth and targets

- Config: [`../platform-smoke.config.mjs`](../platform-smoke.config.mjs) (`nodeValidationMajor`: `24`; `requiredCrabbox.minVersion`: `0.26.0`)
- CLI: [`../scripts/platform-smoke.mjs`](../scripts/platform-smoke.mjs)
- Target runner: [`../scripts/platform-smoke/targets.mjs`](../scripts/platform-smoke/targets.mjs)
- Windows build script: [`../scripts/platform-smoke/platform-build-windows.ps1`](../scripts/platform-smoke/platform-build-windows.ps1)
- Real runtime smoke: [`../scripts/oracle-real-smoke.mjs`](../scripts/oracle-real-smoke.mjs)
- Artifact root: `.artifacts/platform-smoke/` (gitignored)

**Targets (`requiredTargets` in `platform-smoke.config.mjs` is the single authority):**

- **Required for release:** `macos`, `ubuntu`.
- **Optional:** `windows-native` remains available for maintainers with the Parallels template, but the fork owns no Windows lane; Windows native support is upstream-validated at `pi-oracle` 0.7.20 only.

**Required suites on each target:** `platform-build`, `real-extension`.

## Required local setup

Install Crabbox with Homebrew and keep it on `PATH`:

```bash
brew install openclaw/tap/crabbox
crabbox --version
crabbox providers
```

`PLATFORM_SMOKE_CRABBOX` is the reusable binary override; `PI_ORACLE_SMOKE_CRABBOX` is the project-specific alias and wins when both are set.

### Target prerequisites

- **macOS (`macos`):** Remote Login enabled; noninteractive `ssh $USER@localhost` works; `node` (24+), `npm`, `git`, `tar`, `rsync`, `zstd`, and `agent-browser` on the SSH `PATH`. Override host, user, or work root with `PLATFORM_SMOKE_MAC_HOST`, `PLATFORM_SMOKE_MAC_USER`, `PLATFORM_SMOKE_MAC_WORK_ROOT` (or `PI_ORACLE_SMOKE_MAC_*`).
- **Ubuntu (`ubuntu`):** Docker is running and the configured image (`PI_ORACLE_SMOKE_UBUNTU_IMAGE` or `PLATFORM_SMOKE_UBUNTU_IMAGE`, default `omp-oracle-platform-smoke:node24`) has `node` (24+), `npm`, `git`, `tar`, `rsync`, `zstd`, and `agent-browser` on `PATH`. Build the local image when needed:
  ```bash
  docker build -t omp-oracle-platform-smoke:node24 -f scripts/platform-smoke/Dockerfile.ubuntu .
  ```
- **Windows native (`windows-native`, optional):** Parallels has stopped source VM `pi-extension-windows-template` (`PLATFORM_SMOKE_WINDOWS_VM` / `PI_ORACLE_SMOKE_WINDOWS_VM`) and the configured power-off snapshot (`crabbox-ready` by default; `PLATFORM_SMOKE_WINDOWS_SNAPSHOT` / `PI_ORACLE_SMOKE_WINDOWS_SNAPSHOT`). The template must have OpenSSH, PowerShell, Git, Node/npm, `tar`, `zstd`, and `agent-browser` on `PATH`. Never bake API keys, browser sessions, project checkouts, `.pi` state, artifacts, or secrets into the template.

### Real runtime suite auth and switches

- The default deterministic installed-tool smoke requires no provider API keys.
- Provider and model defaults remain `zai/glm-5.2` for doctor/config and optional model-agent debugging; override with `PI_ORACLE_REAL_TEST_PROVIDER` and `PI_ORACLE_REAL_TEST_MODEL` (provider auth variable names live in `platform-smoke.config.mjs`).
- Set `PI_ORACLE_REAL_TEST_MODEL_AGENT=1` only when debugging the slower model-agent path; the provider auth environment variable is then required (`ZAI_API_KEY` by default, reported only as present/redacted).
- Symlink escape rejection and negative archive cases are covered by `npm run sanity:oracle`; set `PI_ORACLE_REAL_TEST_NEGATIVE_SYMLINK=1` to enable the optional second-agent negative symlink check.

## Commands

Choose when to run platform smoke from [Test plan](TEST_PLAN.md#which-check-to-run). Doctor is mandatory before the full matrix and is enforced automatically by `smoke:platform:all`:

```bash
# Doctor-first required matrix (macos + ubuntu, both suites)
npm run smoke:platform:all

# Preflight target setup and focused target/suite runs
npm run smoke:platform:doctor
npm run smoke:platform:macos
npm run smoke:platform:ubuntu
npm run smoke:platform:windows-native
node scripts/platform-smoke.mjs run --target <target> --suite <suite>
node scripts/platform-smoke.mjs run --target windows-native --suite real-extension

# Cheap local invariant and platform-subset checks (no VM/container launch)
npm run check:platform-smoke
npm run sanity:oracle:platform
npm run verify:oracle:platform
```

`npm run release:check` (used by `prepublishOnly`) runs `npm run verify:oracle`, `npm run proof:capture`, `npm run release:proof:chatgpt-presets`, and `npm run smoke:platform:all`, in that order; see [Release](RELEASE.md#release-gate).

## What `platform-build` proves

On each target, `platform-build`:

1. checks the Node major version against `nodeValidationMajor` (`24`);
2. runs `npm ci`;
3. verifies that target tools (`zstd`, `agent-browser`) are on `PATH`;
4. runs `npm run verify:oracle:platform` (syntax, platform-smoke invariants, real-smoke script syntax, platform-sensitive oracle sanity coverage, and `npm pack --dry-run`);
5. runs `npm pack`;
6. creates a fresh target-local `pi` project;
7. runs `npm install --no-save <packed tarball>`;
8. runs `pi install -l ./node_modules/omp-oracle --approve` so `pi` 0.79+ project-trust gating trusts the temporary fixture;
9. runs `pi list --approve`;
10. asserts that the installed package came from `node_modules/omp-oracle` without `pi -e` source-extension shortcuts.

## What `real-extension` proves

`real-extension` is required release proof. It runs `npm run smoke:real:packed` on each target, which:

1. packs this checkout with `npm pack`;
2. installs the tarball into a clean `pi` project;
3. runs `pi install -l ./node_modules/omp-oracle --approve`;
4. asserts `pi list --approve` shows the packed install path;
5. executes `/oracle-status` through the installed package's loader, not source `pi -e`, and asserts the
   oracle command output;
6. asserts that no oracle job was created and that the packed run's command never names the source entry
   point `extensions/oracle/index.ts`.

The default suite needs no provider credentials and submits nothing. With
`PI_ORACLE_REAL_TEST_MODEL_AGENT=1`, a model turn calls `oracle_submit` from the installed package instead,
and the suite asserts whole-project archive creation and default exclusions.

For inner-loop debugging without packing, run `npm run smoke:real:source`, which loads `extensions/oracle/index.ts` via `pi --approve --no-extensions -e`; it is not release proof.

## Artifacts and secret scan

Each suite writes reviewable evidence under `.artifacts/platform-smoke/<run-id>/<target>/<suite>/`:

```text
summary.json              target.json               suite.json
command.txt               exit-code.txt             assertions.json
crabbox.stdout.txt        crabbox.stderr.txt        crabbox.timing.json
crabbox.stop.stdout.txt   crabbox.stop.stderr.txt   crabbox.stop.exit-code.txt
artifact-manifest.json    failures.md               # failures.md only on failure
```

`platform-build` also writes packed-install extracts (`packed-tarball.txt`, `packed-node-install.*`, `pi-install.*`, `pi-list.*`). Passing suites require `summary.ok === true`, `assertions.ok === true`, and `artifact-manifest.missing.length === 0`.

Artifacts are local evidence only; do not commit or share them without redaction. Built-in secret scans fail the suite if output contains bearer, API-key, or cookie-like values.

## Windows template maintenance

When the optional Windows target lacks a reusable tool such as `zstd` or `agent-browser`, update the shared `pi-extension-windows-template` VM rather than adding a per-run installer:

1. revert or switch `pi-extension-windows-template` to the current canonical `crabbox-ready` snapshot;
2. boot the template;
3. install or update the reusable tool globally without secrets;
4. verify from a fresh SSH session: `node --version`, `npm --version`, `git --version`, `tar --version`, `zstd --version`, `agent-browser --version`, and `agent-browser install`;
5. remove downloads, caches, checkouts, `.pi`, `.artifacts`, `.debug`, browser auth/session state, and secrets;
6. shut down cleanly;
7. create or promote the configured power-off `crabbox-ready` snapshot;
8. run `npm run smoke:platform:doctor` and `npm run smoke:platform:windows-native` against the promoted snapshot;
9. clean stale clones and leases.
