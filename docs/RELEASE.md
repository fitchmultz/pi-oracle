# OMP Oracle release

Run the local release gate, produce and verify the live ChatGPT preset proof, and record the evidence before publishing `omp-oracle` for Oh My Pi and `pi`.
Companion docs: [Test plan](TEST_PLAN.md) · [Platform smoke](PLATFORM_SMOKE.md) · [Compatibility](COMPATIBILITY.md) · [Upstream](UPSTREAM.md) · [Changelog](../CHANGELOG.md)

## Package identity

- npm name: `omp-oracle` (current release `0.4.11`, npm `latest`). The `pi-oracle` package on npm is the upstream project published by its maintainer; it does not carry this fork's commits.
- Version: the fork's own line, starting at `0.1.0`. It does not inherit upstream's `0.7.x` numbering; `0.1.0` was based on upstream `pi-oracle` 0.7.20, and later releases add the changes listed per version in [`CHANGELOG.md`](../CHANGELOG.md).
- The GitHub URL install tracks `main`; npm carries the released versions ([README](../README.md#build-and-run)).
- Runtime identifiers are unchanged by the rename: `/oracle*` commands, `oracle_*` tool names, `PI_ORACLE_*` environment variables, `/tmp/pi-oracle-state`, the job directory format, and the `omp.pi-oracle.programmatic.v1` bridge symbol.

For everyday validation and choosing which check to run during development, see the [Test plan](TEST_PLAN.md#which-check-to-run).

## Release gate

`npm run release:check` runs the release gate in four stages; `prepublishOnly` runs it too, so a
local `npm publish` cannot skip it:

1. `npm run verify:oracle` (`npm test` is an alias) — runs, in order: syntax and bundle checks
   (`check:oracle-extension`), platform-smoke invariants (`check:platform-smoke`), helper unit tests
   (`test:oracle-helpers`), the site coherence test (`test:site`), the documentation link check
   (`test:docs`), the three typecheck projects (`typecheck`, `typecheck:worker-helpers`,
   `typecheck:worker-runtime`), the isolated sanity harness (`sanity:oracle`, including pinned
   documentation literals), and `npm pack --dry-run` (`pack:check`).
2. `npm run proof:capture` — proves capture and recollection against synthetic pages in an
   isolated headless browser, with no account or external network. Requires Chrome or Chromium
   (auto-detected, or selected with `CHROME_BIN`).
3. `npm run release:proof:chatgpt-presets` — checks the fresh live ChatGPT preset proof for the
   eight model presets through the loaded extension.
4. `npm run smoke:platform:all` — runs `npm run smoke:platform:doctor` first, then the macOS and
   Ubuntu Crabbox lanes (`platform-build` and `real-extension`) using packed-install proof rather
   than source-tree `pi -e` loading. `windows-native` is an available target, not a
   release-required lane; see [Compatibility](COMPATIBILITY.md#platforms-and-runtime).

Hosted CI runs only the local gate (`npm run verify:oracle`): on `main`, on pull requests, and on
the release tag before publishing. The offline capture proof, live preset proof, and Crabbox
matrix run locally in the order above, followed by artifact review, before the release tag is
pushed ([Publishing](#publishing)).

### ChatGPT preset proof

Release proof covers the **eight model presets** in `ORACLE_SUBMIT_PRESETS` (`pro_standard`,
`pro_extended`, `thinking_light`, `thinking_standard`, `thinking_extended`, `thinking_heavy`,
`instant`, `instant_auto_switch`) through the loaded extension. `deep_research` is a composer-tool
preset and is excluded because each run consumes a Deep Research task on the account; the checker
prints the exclusion. Ordinary pre-commit smoke runs can use `instant` or `thinking_light`.

**Produce the proof**

Each job's prompt must make the saved response contain the exact markers `PRESET <preset> OK` and
`PACKAGE omp-oracle`. Run `npm run release:proof:chatgpt-presets:run` to submit one marker job per
preset from isolated OMP print-mode sessions (loading this checkout's extension source via
`omp … --no-extensions -e`), wait for each job to complete, write
`.artifacts/chatgpt-preset-proof/latest.json`, and run the checker:

```bash
PI_ORACLE_PROOF_MODEL=<omp model id> PI_ORACLE_PROOF_MODELS_YML=<models.yml for that model> \
  npm run release:proof:chatgpt-presets:run
```

- `PI_ORACLE_PROOF_MODEL` (required): model id the isolated session uses to call `oracle_submit` (a zero-cost local model is fine).
- `PI_ORACLE_PROOF_MODELS_YML` (required): `models.yml` copied into the isolated agent directory so `PI_ORACLE_PROOF_MODEL` resolves.
- `PI_ORACLE_PROOF_RELAY` (optional): existing-Chrome relay endpoint. Because the signed-in Chrome
  selects the ChatGPT account the eight live jobs consume, the transport has no default: when
  `PI_ORACLE_PROOF_RELAY` is unset, the runner reads your agent-level config
  (`$PI_CODING_AGENT_DIR/extensions/oracle.json`, default `~/.omp/agent/extensions/oracle.json`)
  for `browser.chatGptRelayEndpoint` or `browser.chatGptManagedProfileDir`. It prints the resolved
  transport, its source, and the isolated config before the first submit, and refuses to run if the
  config sets neither or sets both.
- `PI_ORACLE_PROOF_ROOT` (optional, default `/tmp/omp-oracle-proof`): isolated root for `agent`, `sessions`, `jobs`, and `state`. A managed-profile proof uses its own state directory, so its keeper does not see your normal leases; run it while your own jobs are idle, as with the relay.
- `PI_ORACLE_PROOF_CLI` (optional, default `omp`): OMP executable for the isolated sessions.
- `--dry-run`: resolves the model, transport, and presets, prints the plan, and exits without submitting (`npm run release:proof:chatgpt-presets:run -- --dry-run`).
- Subset reruns: pass preset ids as arguments (`npm run release:proof:chatgpt-presets:run -- instant thinking_light`) to rerun only those presets; a partial rerun keeps the remaining presets' entries from the existing proof file.

To assemble a proof manually instead of using the runner, start from the checked, intentionally non-valid template:

```bash
mkdir -p .artifacts/chatgpt-preset-proof
node scripts/oracle-chatgpt-preset-proof.mjs template > .artifacts/chatgpt-preset-proof/latest.json
npm run release:proof:chatgpt-presets
```

**Check the proof**

`npm run release:proof:chatgpt-presets` reads `.artifacts/chatgpt-preset-proof/latest.json`
(override with `PI_ORACLE_CHATGPT_PRESET_PROOF`; job lookup checks `PI_ORACLE_JOBS_DIR` and `/tmp`;
freshness window defaults to 72 hours via `PI_ORACLE_CHATGPT_PRESET_PROOF_MAX_AGE_HOURS`). It
rejects the proof if:

- the working tree has uncommitted changes, or the proof file is missing or unreadable;
- `schemaVersion` is not `1`, `provider` is not `"chatgpt"`, `extensionUnderTest` is not `"loaded-extension"`, or `packageName`, `packageVersion`, or `gitHead` does not match `package.json` and `HEAD`;
- `validatedAt` or any job's `completedAt` is not a valid ISO timestamp, is in the future, is older than the freshness window (default 72 hours), or is not newer than the current `HEAD` commit time;
- any of the eight model presets is missing, has a placeholder UUID, or lacks actual persisted
  `job.json`, `response.md`, and `logs/worker.log` files on disk with `status: "complete"`,
  `phase: "complete"`, a `.tar.zst` archive and SHA-256, a `https://chatgpt.com/c/...` conversation
  URL, matching `extensionProvenance` (`packageName`, `packageVersion`, `gitHead`, `sourcePath`),
  model configuration in the worker log, and both `PRESET <preset> OK` and `PACKAGE omp-oracle` in
  the saved response.

### Real runtime suite defaults

The real runtime suite (`scripts/oracle-real-smoke.mjs`) defaults to deterministic installed-tool execution (`--mode packed`) so platform proof stays bounded:

- Provider and model defaults are `zai/glm-5.2` for doctor/config and optional model-agent debugging; override with `PI_ORACLE_REAL_TEST_PROVIDER` and `PI_ORACLE_REAL_TEST_MODEL` (per-agent timeout `PI_ORACLE_REAL_TEST_TIMEOUT_MS`, default `180000` ms; artifact root `PI_ORACLE_REAL_TEST_ARTIFACT_ROOT`, default `.artifacts/real-smoke`; set `PI_ORACLE_REAL_TEST_KEEP_TMP=1` to keep the temporary fixture directory).
- For inner-loop source loading only, use `npm run smoke:real:source`; it is not release proof.
- Set `PI_ORACLE_REAL_TEST_MODEL_AGENT=1` only when debugging the slower model-agent path.
- Set `PI_ORACLE_REAL_TEST_NEGATIVE_SYMLINK=1` to run the optional second real-agent negative symlink check; `npm run sanity:oracle` covers archive and symlink rejection by default.

## Publishing

Pushing the tag `vX.Y.Z` publishes that commit to npm from
[`.github/workflows/release.yml`](../.github/workflows/release.yml) through npm
[trusted publishing](https://docs.npmjs.com/trusted-publishers/). The workflow authenticates with a
short-lived OIDC token, so no npm token exists and nobody approves the publish in a browser, and npm
attaches a provenance attestation naming the workflow run and the commit.

- Push the tag only after `npm run release:check` has passed on the tagged commit. The workflow
  repeats only the local gate; pushing the tag asserts that the preset proof and the Crabbox lanes
  passed.
- The `verify` job checks that the tag names the `package.json` version, runs
  `npm run verify:oracle`, and packs the tarball. The `publish` job, the only one that can obtain the
  npm credential, checks nothing out and installs nothing: it publishes that tarball. A tarball
  publish runs no lifecycle scripts, so `prepublishOnly` does not run there.
- The registry's `dist.shasum` is the one the `verify` job's `npm pack` printed. A local pack of the
  same commit on another Node release can differ even when the contents match, because the gzip
  bytes depend on the Node build: for `v0.4.6`, Node 24 and Node 26 produce different shasums from a
  byte-identical tar. Ledger entries therefore bind the registry tarball to the workflow run and its
  provenance, not to a local dry run.
- Release one version at a time: tags for different versions run concurrently.

**One-time setup.** At the first release that uses the workflow, the npm account owner links the
package to the workflow with npm 11.15 or later. An unused link expires after two days, so create it
just before pushing that release's tag:

```bash
npm login --auth-type=web
npm trust github omp-oracle --file release.yml --repo alphastorm/omp-oracle --allow-publish --yes
```

After that first trusted publish succeeds, set the package's **Publishing access** on npmjs.com to
"Require two-factor authentication and disallow tokens"; trusted publishing is unaffected.

**Fallback.** If the workflow cannot publish, an interactive `npm publish` from a clean checkout of
the tag still works: `prepublishOnly` runs `npm run release:check`, and npm asks for browser approval
of the login and of the publish.

## Evidence ledger

Fork entries appear first, newest first, and each entry records what was observed for that release.
The carried upstream records below them keep their original headings (such as "Current
implementation status" and "Current readiness summary") and describe upstream `pi-oracle` at the
time they were written, not this fork; current support claims live in
[`COMPATIBILITY.md`](COMPATIBILITY.md).

### Fork evidence (omp-oracle)

Recorded by the fork under the `omp-oracle` name, on the maintainer's macOS workstation.
Artifact run ids live under the gitignored `.artifacts/` root.

#### 0.4.11 (2026-10-31, `5f97054`)

- Scope: [#26](https://github.com/alphastorm/omp-oracle/pull/26), squash `79dfc40`, bounds the
  missing-turn reload that 0.4.10 introduced: on 2026-10-31 every operator job reloaded the
  conversation 1–2× during long Pro generations (`No completed bound turn observed for 303 s;
  reloading`), and a Cloudflare challenge followed a day of such resumes on the managed profile.
  A visible Stop/streaming control now resets the missing-turn timer like a completion signature
  does, each job attempts at most one missing-turn reload (`MISSING_TURN_RELOAD_MAX`), and
  afterwards the loop polls until the completion timeout, whose recollect path recovers the job.
  The stale-stop reload is unchanged. The release-preparation commit is exactly
  `5f97054032aa5b4011e99dfe75c5e74b1c0ff668`.
- Red before, green after, as recorded in #26: new `test:oracle-helpers` cases fail with the old
  `nextMissingTurnState` and pass with the new one; `typecheck:worker-helpers`,
  `typecheck:worker-runtime`, `sanity:oracle` and `test:docs` passed on the branch.
- Live validation of `main` at `79dfc40` from source before the prep commit (clean tree,
  `extensionProvenance.gitHead` `79dfc40`, isolated root `/tmp/omp-oracle-live-0.4.11`, driver
  `nyc-n2/q38-ninfer`): `instant` job `b7bf762a` completed in 45 s with the exact marker (slider
  `Pro (5 of 5)` → `Instant`), and the same-thread follow-up `12c2b932` completed in 43 s with
  `followUpToJobId` `b7bf762a`, the same `chatUrl` (`6ae693af…`), `collectionBinding.responseIndex`
  1, and a `response.md` that starts with a fenced `yaml` block. Neither job reloaded. The
  missing-turn reload path itself was not reproduced live: no job in this release ran long enough
  (every live job completed in 35–48 s).
- Preconditions: `main` clean and even with origin at `79dfc40`; upstream `main` had moved to
  `eecf79e` past the recorded sync `d658a98` (not synced in this release); Dependabot
  [#20](https://github.com/alphastorm/omp-oracle/pull/20), the design draft #17 and Dependabot
  alert 4 (`minimatch` < 11.0.1, development scope) were open and are not part of this release.
  The proof model `nyc-n2/q38-ninfer` answered `/v1/models` before the live validation. The
  Ubuntu smoke image `c33763ac8882` was present and its Dockerfile unchanged since 0.4.9. No
  oracle worker, non-terminal job or diligence Chrome was running; the operator's diligence
  windows had delivered on 2026-10-31.
- Proof driver: the usual local proof model became unavailable before the preset proof, so the
  runner's first invocation ended after 300 s with the driver's model request unanswered and no
  job created. The proof then drove with a hosted model through a temporary `models.yml` copy
  (`fwproof` provider, key passed in the environment; the runner's isolated agent directory
  cannot read the operator's auth store). Invocation with `gpt-oss-120b`: 5/8, the proof file not
  written. Two sessions created no job (the driver answered that `oracle_submit` was not in its
  toolset), and `pro_standard` `b9e8006b` failed in 7.5 s before any send, the first job in a
  fresh Chrome: the slider read `Instant (1 of 5)`, two ArrowRight presses left it at `High (3 of
  5)`, and the worker threw `Thinking-effort slider did not move toward Pro from High`
  (`failure.png` shows the open picker at High; artifacts in `.artifacts/ui-drift-2026-11-01/`).
  The same Instant → Pro transition succeeded 7 s later in `pro_extended` `1e81117e` and in every
  Pro job after it; the slider code is unchanged since 0.4.5. The other four jobs of that
  invocation (`b4287844`, `3a293f1f`, `09f594aa`, `13793497`) completed with both markers.
- Fresh live eight-preset proof accepted on `5f97054` in one runner invocation (316 s, managed
  browser, driver `fwproof/accounts/fireworks/models/kimi-k3`): `pro_standard` `1f0af03b` 43.0 s,
  `pro_extended` `c855c58c` 36.5 s, `thinking_light` `7129c01f` 38.8 s, `thinking_standard`
  `0a8939fb` 34.8 s, `thinking_extended` `bbfe0748` 40.4 s, `thinking_heavy` `f86f9c14` 40.3 s,
  `instant` `d514890f` 43.5 s, `instant_auto_switch` `a9922eff` 36.0 s; every job `complete`, each
  with one `slider reads` line, no picker reopen, no stale-stop reload and no missing-turn reload;
  `observedSelection.effortLabel` `null` after submission for all eight as in 0.4.10, while the
  worker logs record the stops (`Pro (5 of 5)` for both Pro presets, `Medium (2 of 5)` for both
  light/standard thinking presets, `High (3 of 5)`, `Extra High (4 of 5)`, `Instant (1 of 5)`
  twice). Deep Research is excluded from the proof by design; its code did not change.
- `npm run release:check` passed on `5f97054` (142 s): local gate, proof check, doctor,
  `pack:check` 87 files, Crabbox `platform-build` macOS 40264 ms / Ubuntu 32805 ms and
  `real-extension` macOS 3705 ms / Ubuntu 3286 ms (runs `run-1793497698552-95ry8b`,
  `run-1793497692749-cg05o7`).
- Founder authorization by Ask (version, commit and file count named), then annotated tag
  `v0.4.11` at `5f97054` pushed. Release run
  [41262757675](https://github.com/alphastorm/omp-oracle/actions/runs/41262757675): `verify`
  01:50:52–01:52:26 UTC, `publish` 01:52:28–01:52:38 UTC. `verify` pack: shasum
  `580834cf988d836b8526e9b8544a23fa9fd3665d`, 87 files; `publish` printed `Signed provenance
  statement`, transparency log index **3617499897**, and `+ omp-oracle@0.4.11`. The
  [GitHub release](https://github.com/alphastorm/omp-oracle/releases/tag/v0.4.11) uses the
  dated CHANGELOG section.
- Registry (answered after 92 s): `dist.shasum` `580834cf988d836b8526e9b8544a23fa9fd3665d`
  equals the `verify` pack, `dist.integrity`
  `sha512-5sGmM2O3u2wy6u8viXRc5QNvmaEle4yQUFyNjtReulHmHVJvOgMBXyDRC5c+1s8bp23Wr6Q3/p0vmYKCP9yGrg==`,
  `dist.fileCount` 87, `dist-tags.latest` `0.4.11`; the SLSA provenance names commit
  `5f97054032aa5b4011e99dfe75c5e74b1c0ff668`, `refs/tags/v0.4.11`,
  `.github/workflows/release.yml` and run 41262757675 attempt 1; a consumer
  `npm audit signatures` reported 1 package with a verified attestation.
- MacBook activation: `omp plugin uninstall omp-oracle`, `omp plugin install omp-oracle@0.4.11`,
  `omp plugin list` confirmed 0.4.11 on Oh My Pi 18.14.2. Plugins worktree commit `6f3ac34`
  pushed. Second workstation (Oh My Pi 18.14.2): no oracle worker or diligence Chrome was running
  (two `omp` sessions were); `bun install --frozen-lockfile --dry-run` on the pushed manifest,
  then `git pull --ff-only` and `bun install --frozen-lockfile`; the worktree ended clean and
  even at `6f3ac34`; an isolated print-mode `oracle_preflight` from the installed entry point
  reported ready (driven by that workstation's default model).
- Post-install job `0e792bbe` (`pro_standard`, `package.json`, no agent-dir overrides, driver
  `anthropic/claude-fable-5-1`): `extensionProvenance.packageVersion` 0.4.11 from the installed
  `sourcePath`; worker log `slider reads Instant (1 of 5)` then `set to Pro (5 of 5)`; response
  `OK 0.4.11`; complete in 48 s. The account's saved tier is Pro again. Two sessions predating
  the install were running on the MacBook (one of them the release session) and two on the second
  workstation; they keep the old extension code until restarted. Not exercised: Deep Research, a
  live missing-turn reload, and `/oracle-auth`.

#### 0.4.10 (2026-10-30, `b4b0d31`)

- Scope: [#25](https://github.com/alphastorm/omp-oracle/pull/25), squash `1d3c5ab`, closes a
  completion-detection gap observed live on 2026-10-30 in an operator ChatGPT Pro job
  (`21363c38`, the fifth Pro turn of a long Mana AirOS conversation, a `pro_extended` same-thread
  follow-up): the reply finished with its document attachment, yet the live tab produced no
  completion signature for the whole 90-minute window and the job failed with `Timed out
  waiting for ChatGPT response completion`; a fresh load of the same conversation (read-only
  CDP running `observeConversationExpression`) showed all five complete turns and no stop
  control. The stale-stop reload could not help because it ages only a visible stop control
  over non-empty text. The worker now reloads the conversation after five minutes without any
  completion signature (`nextMissingTurnState`; ChatGPT, non-Deep-Research, conversation URL
  only; a reload never sends), records the reply's position when the completion timeout does
  fire, and `oracle_read` `action=recollect` recovers such a timed-out job through the user
  turn that carries its archive (`timedOutRecollectionBinding`: the saved index, or an
  explicit `responseIndex` for jobs recorded before the index was saved, never moving a saved
  one), transitioning it to `complete` with lifecycle source `oracle:recollect`. The
  release-preparation commit is exactly `b4b0d31adf06a35fec3eb55e3aadb4b484670079`.
- Red before, green after, as recorded in #25: the sanity suite drives both helpers (a missing
  turn ages into a reload only after the full window and any signature resets it; a timed-out
  job binds at the saved or explicit index, an explicit index never moves a saved one, a job
  without any index, a non-timeout failure, an unaccepted prompt and a completed job are all
  refused); `typecheck:worker-helpers`, `typecheck:worker-runtime`, `test:oracle-helpers`,
  `sanity:oracle` and `test:docs` passed on the branch.
- Live validation of the exact change before the prep commit, from the installed 0.4.9 copy
  patched in place with the branch's three worker files (byte-identical to `a75a38f`, confirmed
  with `diff`; originals kept beside them until this install replaced the package): the
  recollection of `21363c38` (`responseIndex` 4, message `a8f38e22…`, turn sha `3275fb62…`)
  completed in 4 s, wrote the 22,944-byte `response.md`, and the operator's delivery driver
  consumed it on resume; the next operator job (`b6bff52d`, GreenLIB v5 `pro_extended`) completed
  on its first observation under the patched worker. The missing-turn reload path itself was
  not reproduced live (the condition occurred once, after 90 minutes, on a conversation that
  was already complete when reloaded).
- Preconditions: `main` clean and even with origin at `1d3c5ab`; upstream `main` still matched
  recorded sync `d658a98`; Dependabot [#20](https://github.com/alphastorm/omp-oracle/pull/20)
  and the design draft #17 were open and are not part of this release. The proof model
  `nyc-n2/q38-ninfer` answered `/v1/models`. The Ubuntu smoke image `c33763ac8882` (built
  2026-10-28 for 0.4.9) was present and its Dockerfile unchanged since. The operator's two
  diligence windows had halted (05:08 and 05:22 UTC); no oracle worker, non-terminal job or
  diligence Chrome was running when the proof started.
- Fresh live eight-preset proof accepted on `b4b0d31` in one runner invocation (342 s, managed
  browser, driver `nyc-n2/q38-ninfer`): `pro_standard` `37a54629`, `pro_extended` `b92848e3`,
  `thinking_light` `2f48e256`, `thinking_standard` `3b3a0468`, `thinking_extended` `22cb2ef6`,
  `thinking_heavy` `38327f6e`, `instant` `a4fdc0b1`, `instant_auto_switch` `4c22d088`; every
  job `complete` in 30–38 s, each with one `slider reads` line, no picker reopen, no stale-stop
  reload and no missing-turn reload; `observedSelection.effortLabel` `null` after submission
  for all eight as in 0.4.9, while the worker logs record the stops (`Pro (5 of 5)` for both Pro
  presets, `Medium (2 of 5)` for both light/standard thinking presets, `High (3 of 5)`, `Extra
  High (4 of 5)`, `Instant (1 of 5)` twice). Deep Research is excluded from the proof by design;
  its code did not change.
- `npm run release:check` passed on `b4b0d31` (147 s): local gate, proof check, doctor,
  `pack:check` 87 files, Crabbox `platform-build` macOS 41124 ms / Ubuntu 33066 ms and
  `real-extension` macOS 4024 ms / Ubuntu 3381 ms (runs `run-1793427284397-nwammb`,
  `run-1793427279061-rzemi2`).
- Founder authorization by Ask (version, commit and file count named), then annotated tag
  `v0.4.10` at `b4b0d31` pushed. Release run
  [41175965956](https://github.com/alphastorm/omp-oracle/actions/runs/41175965956): `verify`
  06:17:15–06:18:34 UTC, `publish` 06:18:37–06:19:09 UTC. `verify` pack: shasum
  `b02c274307a06fe9ac651cfe397d5cb44cb44b80`, 87 files; `publish` printed `Signed provenance
  statement`, transparency log index **3611292191**, and `+ omp-oracle@0.4.10`. The
  [GitHub release](https://github.com/alphastorm/omp-oracle/releases/tag/v0.4.10) uses the
  dated CHANGELOG section.
- Registry (answered after 90 s): `dist.shasum` `b02c274307a06fe9ac651cfe397d5cb44cb44b80`
  equals the `verify` pack, `dist.fileCount` 87, `dist-tags.latest` `0.4.10`; the SLSA
  provenance names commit `b4b0d31adf06a35fec3eb55e3aadb4b484670079`, `refs/tags/v0.4.10`,
  `.github/workflows/release.yml` and run 41175965956 attempt 1; a consumer
  `npm audit signatures` reported 1 package with a verified attestation.
- MacBook activation: `omp plugin uninstall omp-oracle`, `omp plugin install omp-oracle@0.4.10`,
  `omp plugin list` confirmed 0.4.10 on Oh My Pi 18.14.1; the installed worker equals `main`;
  the in-place patch files were replaced by the install. Plugins worktree commit `827a555`
  pushed. Second workstation (Oh My Pi 18.14.1): no oracle worker or diligence Chrome was
  running (the auth gateway and two interactive `omp` sessions were); `bun install --frozen-lockfile`
  --dry-run` on the pushed manifest, then `git pull --ff-only` and `bun install
  --frozen-lockfile`; the worktree ended clean and even; an isolated print-mode
  `oracle_preflight` from the installed entry point reported ready.
- Post-install job `add8c39c` (`pro_standard`, `package.json`, no agent-dir overrides):
  `extensionProvenance.packageVersion` 0.4.10 from the installed `sourcePath`; worker log
  `slider reads Instant (1 of 5)` then `set to Pro (5 of 5)`; response `OK 0.4.10`. The
  account's saved tier is Pro again. Two sessions predating the install were running on the
  MacBook (one of them the release session) and two on the second workstation; they keep the old
  extension code until restarted. Not exercised: the missing-turn reload live, `/oracle-auth`,
  Grok, the relay transport.

#### 0.4.9 (2026-10-28, `7ec22ac`)

- Scope: [#21](https://github.com/alphastorm/omp-oracle/pull/21), squash `fac0e83`, matches
  the ChatGPT screen-reader turn headings by prefix. Observed live on 2026-10-28 in an operator
  Deep Research job (`c69e9833`, Winslow Foundry Lab): ChatGPT's headings gained a hidden
  print-formatting span, so `textContent` read `ChatGPT said:ChatGPT`; the exact match saw no
  assistant turn and a report that finished in 7 minutes sat in `awaiting_response` for 80
  minutes. The installed 0.4.8 copy was patched in place with the identical bytes before the
  pull request existed; the release-preparation commit is exactly
  `7ec22ac7049938d0c5d490219c5537bb9335358c`, and it added the `### Fixed` entry #21 lacked.
  The `## Unreleased` security override of dev-only `undici` to `8.12.2` ships with it.
- Red before, green after, as recorded in #21: the new unit test drives the serialized
  observation expression with a fake document; `ChatGPT said:ChatGPT` yielded `messages: []`
  before the change (13 pass, 1 fail) and the reply afterwards (`test:oracle-helpers` 62/62,
  `typecheck:worker-helpers` clean). Shared capture changed, so `npm run proof:capture`
  (offline) covered the research-widget path and passed.
- Live validation of the exact change, from the patched installed copy (byte-identical to
  `main` at `fac0e83` and `7ec22ac`, confirmed with `diff`), before the prep commit: operator
  Deep Research jobs `c69e9833` (completed only after the patch), `7f36b533` and `8ca65be3`
  (Foundry Lab v2 research and sizing), `0ff4cabe`, `5402f795` and the same-thread follow-up
  `2978e85d` (NetBox Labs); ChatGPT Pro same-thread follow-ups `c99218ae` → `b30437e9` →
  `86b56076` (Foundry Lab v2) and `0f1b8c3c` → `d38e6951` → `2f7f8336` (NetBox Labs); every
  job completed on its first observation. No isolated instant/follow-up smoke from source was
  run in addition.
- Preconditions: `main` clean and even with origin at `fac0e83`; upstream `main` still matched
  recorded sync `d658a98`; Dependabot [#20](https://github.com/alphastorm/omp-oracle/pull/20)
  (dev-dependencies group) and the design draft #17 were open and are not part of this
  release. The proof model `nyc-n2/q38-ninfer` answered `/v1/models`. The Ubuntu smoke image
  had been pruned and was rebuilt (`c33763ac8882`, Node 24.22.1, agent-browser 0.39.1). The
  operator's pipeline (Winslow NetBox Labs delivery) finished its last ChatGPT turn at
  15:51 UTC; the proof started after its keeper Chrome had quit.
- Fresh live eight-preset proof accepted on `7ec22ac` in one runner invocation (348 s,
  managed browser, driver `nyc-n2/q38-ninfer`): `pro_standard` `c58b4a45`, `pro_extended`
  `5618235e`, `thinking_light` `55066753`, `thinking_standard` `e7778488`,
  `thinking_extended` `74cf2062`, `thinking_heavy` `e76c0332`, `instant` `5e14c435`,
  `instant_auto_switch` `f3ba5a77`; every job `complete`, each with one `slider reads` line,
  no picker reopen and no stale-stop reload; `observedSelection.effortLabel` was `null` with
  `effortControls: "absent"` after submission for all eight (the composer closes the slider),
  while the worker logs record the stops (`Pro (5 of 5)` for both Pro presets, `Extra High
  (4 of 5)` read before stepping to Instant). Deep Research is excluded from the proof by
  design; it was exercised live by the operator jobs above.
- `npm run release:check` passed on `7ec22ac` (148 s): local gate, proof check, doctor,
  `pack:check` 87 files, Crabbox `platform-build` macOS 41970 ms / Ubuntu 33949 ms and
  `real-extension` macOS 5244 ms / Ubuntu 4071 ms (runs `run-1793203344486-81sr68`,
  `run-1793203339262-jboztn`).
- Founder authorization by Ask (version, commit and file count named), then annotated tag
  `v0.4.9` at `7ec22ac` pushed. Release run
  [40722477865](https://github.com/alphastorm/omp-oracle/actions/runs/40722477865): `verify`
  16:05:20–16:06:53 UTC, `publish` 16:06:55–16:07:17 UTC. `verify` pack: shasum
  `889622d25d5ca4b22a76972c57398b0173ad7a08`, 87 files; `publish` printed `Signed provenance
  statement`, transparency log index **3542851543**, and `+ omp-oracle@0.4.9`. The
  [GitHub release](https://github.com/alphastorm/omp-oracle/releases/tag/v0.4.9) uses the
  dated CHANGELOG section.
- Registry (answered after about 5 minutes): `dist.shasum` `889622d25d5ca4b22a76972c57398b0173ad7a08`
  equals the `verify` pack, `dist.fileCount` 87, `dist-tags.latest` `0.4.9`; the SLSA
  provenance names commit `7ec22ac7049938d0c5d490219c5537bb9335358c`, `refs/tags/v0.4.9`,
  `.github/workflows/release.yml` and run 40722477865 attempt 1; a consumer
  `npm audit signatures` reported 1 package with a verified attestation.
- MacBook activation: `omp plugin uninstall omp-oracle`, `omp plugin install omp-oracle@0.4.9`,
  `omp plugin list` confirmed 0.4.9 on Oh My Pi 18.13.3; the installed capture module equals
  `main`. Plugins worktree commit `5bb4fb6` pushed. Second workstation: no oracle worker or
  diligence Chrome was running (14 `omp` processes were); `bun install --frozen-lockfile --dry-run` on
  the pushed manifest, then `git pull --ff-only` and `bun install --frozen-lockfile`; the
  worktree ended clean and even; an isolated print-mode `oracle_preflight` from the installed
  entry point reported ready.
- Post-install job `34ff0892` (`pro_standard`, `package.json`, no agent-dir overrides):
  `extensionProvenance.packageVersion` 0.4.9 from the installed `sourcePath`; worker log
  `slider reads Instant (1 of 5)` then `set to Pro (5 of 5)`; response `OK 0.4.9`. The
  account's saved tier is Pro again. Six sessions predating the install were running on the
  MacBook (including the release session) and 14 `omp` processes on the second workstation; they
  keep the old extension code until restarted. Not exercised: `/oracle-auth`, Grok, the relay
  transport.

#### 0.4.8 (2026-10-24, `136ca83`)

- Scope: [#18](https://github.com/alphastorm/omp-oracle/pull/18), squash `73653d3`, refreshes
  read-only per-submission effort provenance, including the already-configured path. Missing
  controls explicitly clear stale effort; unreadable controls report uncertainty without
  changing selection or submission. Its single batched review remediation (`1d2addb`) also
  rejects retained closed-menu readings, observes supported compact model labels, clears
  unreadable prior model/product evidence, and distinguishes malformed reads from absence.
  The release-preparation commit is exactly `136ca834943ea9e50efa29104842af9d62a11ccd`.
- Red before, green after, as recorded in #18: the original configured-path regression expected
  `Medium (2 of 5)` but retained `Pro (5 of 5)`; Deep Research lacked explicit null effort.
  Additional review regressions reproduced stale compact model labels, retained Power evidence,
  and uncleared model/product provenance before remediation; the targeted native/helper command
  passed 29/29 afterwards. Native sessions load the extension with real locking, atomic
  persistence and read/status; browser replies remain fixtures. The fixture executes production
  DOM-expression bodies but substitutes the Power-selector constant, so it is not a
  production-selector mutation test.
- Two focused review rounds completed on frozen heads `0e47aba2` and `1d2addb3`; both strong
  critics completed each round. The
  [round-one ledger](https://github.com/alphastorm/omp-oracle/pull/18#issuecomment-6391176293)
  and [admitting ledger](https://github.com/alphastorm/omp-oracle/pull/18#issuecomment-6391176478)
  retain every disposition. No confirmed P0/P1 remained. Accepted P2 provenance limitations:
  snapshot and DOM reads are not atomic across a picker-close transition; the compact fallback
  does not prove composer ownership of the last matching button; the older expanded `Medium`
  compact picker can conservatively report null/absent. These are not claims of complete
  older-shell coverage or authority for consumer adoption. Round two disclosed the lead's prior
  close-path disposition and is not claimed to be another blind assessment of that allegation.
- Preconditions: upstream `main` still matched recorded sync `d658a98`; no Dependabot PR was
  open. #17 was an explicitly implementation-excluded design-feedback draft, not a release
  change. #18 changed no dependencies; the version bump changed lockfile identity only, and
  the hosted verify job ran `npm ci`. The existing Ubuntu smoke image
  `f2fddfb8ce69` was present and reported Node 24.22.0 and agent-browser 0.39.1; no rebuild or
  global browser-driver upgrade was needed.
- Diagnostic-red driver prerequisite, before any ChatGPT job: the first isolated OMP session
  on `nyc-n2/q38-ninfer` produced no assistant/tool output, then the runner aborted it after
  300.90 s. A bounded `/v1/chat/completions` probe timed out after 40.02 s although `/v1/models`
  had answered. No new Oracle job, browser, `job.json`, worker log or failure snapshot existed
  to copy. The failed session and diagnosis are retained under
  `.artifacts/ui-drift-2026-10-24/`; the fleet-owned service was not changed. Under the lead's
  explicit authorization, the driver changed to the installed catalog's inexpensive
  `anthropic/claude-haiku-5-5` because `models.yml` had only local/fleet routes. An isolated
  no-tools prerequisite answered `OK`; only the nonsecret `auth.broker.url` setting was copied
  into the proof agent configuration.
- Fresh live eight-preset proof accepted on `136ca83` in one cloud-driven runner invocation
  (332.53 s), with each job's loaded-source provenance matching 0.4.8 and the exact prep commit:
  `pro_standard` `30f08573` 44.246 s, `pro_extended` `f434bc0e` 47.065 s,
  `thinking_light` `ad1a42de` 37.181 s, `thinking_standard` `75e0389e` 42.361 s,
  `thinking_extended` `3356a2b9` 40.300 s, `thinking_heavy` `dc6e504b` 38.041 s,
  `instant` `3c957b5e` 42.104 s, and `instant_auto_switch` `c701e67e` 38.577 s.
  These are runner per-preset elapsed times. Each saved response contained both exact markers.
  Worker logs recorded the configured stops Pro, Pro, Medium, Medium, High, Extra High, Instant,
  Instant, all out of five. At the subsequent observation the picker was closed: every
  `observedSelection.effortLabel` was null with `effortControls: "absent"` and fresh actual model
  labels `Thinking effort Pro`, Pro, Medium, Medium, High, Extra High, Instant, Instant
  (the same `Thinking effort` prefix on each). Configuration-time stops were not relabeled as
  currently offered sets. No picker reopen or stale-stop reload fired.
- `npm run release:check` passed on the prep commit as one composition (152.13 s): syntax and
  bundle, platform invariants, 61 helper/native tests, 4 site tests, 2 documentation tests,
  all three typechecks, sanity, **`pack:check` 87 files**, fresh proof check, doctor, and Crabbox:
  macOS `platform-build` 41.508 s (`run-1792898638506-312ueo`), `real-extension` 4.246 s
  (`run-1792898680020-2oy62u`); Ubuntu `platform-build` 32.976 s
  (`run-1792898651873-zl5qg0`), `real-extension` 3.613 s (`run-1792898684851-s6a5uy`).
- The founder authorized the version, tag-triggered publication and activation. Origin `main`
  was read back at the exact prep SHA before annotated tag `v0.4.8` was pushed. Release run
  [`40158127269`](https://github.com/alphastorm/omp-oracle/actions/runs/40158127269) succeeded:
  `verify` 03:25:06–03:26:50 UTC (104 s), `publish` 03:26:53–03:27:05 UTC (12 s), on
  2026-10-25 UTC / 2026-10-24 local. The workflow packed 87 files (353.5 kB) with shasum
  `3b2c027550e5682f0f20e21856772459e05bc802`, signed provenance, recorded Sigstore log index
  **3449852722**, and printed `+ omp-oracle@0.4.8`. The
  [GitHub release](https://github.com/alphastorm/omp-oracle/releases/tag/v0.4.8) uses the dated
  CHANGELOG section.
- Registry metadata became visible after 133.89 s of polling (14 attempts; observed
  2026-10-24T20:29:48-07:00): `latest` 0.4.8, 87 files, the same workflow shasum, and integrity
  `sha512-WdPdhik+kNDw+Rwl8j6wNYqhEUY/y5CDRE0ezcNXPy0bMnzh0nddXHgSeHYhsEZhNAHYbe2hB087ypzAb7klpA==`
  (matching the workflow's displayed prefix/suffix). Decoded SLSA provenance bound the exact
  prep commit, `refs/tags/v0.4.8`, `.github/workflows/release.yml`, and run 40158127269 attempt 1.
  A fresh consumer install with scripts disabled passed `npm audit signatures`: 2 verified
  registry signatures and 1 verified attestation. The temporary consumer directory and GitHub
  release-notes file were removed. Raw release, registry, provenance, signature and install
  receipts are retained under `.artifacts/release-0.4.8/`; `/tmp/omp-oracle-proof` is retained.
- MacBook activation: `omp plugin uninstall omp-oracle`, `omp plugin install omp-oracle@0.4.8`,
  and `omp plugin list` confirmed 0.4.8 on Oh My Pi 18.12.6. Plugins worktree commit
  `05f8519a71d0d4e59f0a0d0841823d6d7b585ba9` records the manifest and lockfile activation and
  was pushed from `~/.omp/plugins`. Global agent-browser stayed at 0.39.1; the separate
  plugins-manifest copy remains 0.35.0.
- **Second-workstation installation was NOT exercised**, by the lead's explicit instruction: a
  top-level OMP session started on 2026-10-24 was running there and was not stopped. Its baseline
  OMP is 18.12.6 and global agent-browser 0.39.1. A temporary copy of `origin/omp-plugins` at
  `05f8519` passed `bun install --frozen-lockfile --dry-run`, resolving omp-oracle 0.4.8; the
  temporary copy was removed. No real `bun install`, installed-entry-point preflight, or
  clean/even post-activation claim is made for that workstation. The activation handoff was a
  guarded script: refuse while an `omp` session, Oracle worker or diligence Chrome runs there;
  `git pull --ff-only`; `bun install --frozen-lockfile`; `git status --short --branch`; then an
  isolated print-mode `oracle_preflight` from the installed entry point with
  `anthropic/claude-haiku-5-5`, removing its temporary session root on success.

- Installed-package Pro proof: fresh real-agent print session, using the same authorized cloud
  driver and installed entry point, submitted `pro_standard` job
  `4fe870cf-140e-472e-8ec0-9547bda160ea`. It completed in 38.017 s (51.40 s including the parent),
  returned `OMP_ORACLE_POSTINSTALL_0_4_8_OK`, and recorded packageVersion 0.4.8 with installed
  source path `~/.omp/plugins/node_modules/omp-oracle` and no gitHead. Worker logs read
  `Instant (1 of 5); target Pro`, then `set to Pro (5 of 5)`, restoring the account's saved
  tier to **Pro**. No diligence Chrome process was present before this job; the temporary
  post-install session root was removed.
- Three top-level OMP processes on the MacBook predated the installed package.json mtime (a
  planning bridge, a gateway session and the release/lead session). Any already-loaded Oracle
  extension in those sessions requires restart to refresh. Relay and internal worker processes
  were excluded.
- Not exercised: second-workstation activation as above, live `/oracle-auth`, Deep Research, Grok,
  Windows native, a same-thread follow-up, and the configured early-return path against the
  live provider (covered by native fixtures instead). No failed live ChatGPT job was
  discarded or silently restaged; the only failed prerequisite was the diagnosed local
  model driver before any Oracle submission.
- Follow-up second-workstation activation (2026-10-25): the founder explicitly authorized
  installation with that top-level OMP session still running. `git pull --ff-only` and
  `bun install --frozen-lockfile` activated **0.4.8** on Oh My Pi **18.12.6**; the plugins
  worktree ended clean and even with `origin/omp-plugins` at `05f8519`. An isolated print-mode
  `oracle_preflight` loaded the installed entry point with `anthropic/claude-haiku-5-5` and
  reported **ready** for ChatGPT (0/2 active, 0/2 queued); login is not verified by preflight.
  No submission or authentication was exercised, no Oracle worker or diligence Chrome
  process was present afterwards, and the temporary dry-run and preflight roots were removed.
  That session predates the installed package.json mtime; its already-loaded 0.4.7 extension
  requires a session restart.
  Documentation link checks passed 2/2. On local Node 26.12.1, the first `sanity:oracle` run
  failed with `broken-pipe archive test should record a tar pid file`; exactly one unchanged,
  isolated rerun passed. The checkout included #19 (`fff95a67`), but local `node_modules`
  still resolved undici 8.10.2 (`npm ls` reported the 8.12.2 override mismatch), so this is
  not installed-undici-8.12.2 runtime validation.

#### 0.4.7 (2026-10-20, `567facf`)

- Scope: #6 (`fabd8f3`): releases publish from `.github/workflows/release.yml` through npm
  trusted publishing. #7 (`85a18ca`): the development baseline moves from `pi` 0.80.9 to 1.3.0 with
  a portable `before_agent_start` guard, two sanity fixtures, and `allowScripts` denials; the
  development audit drops from five findings to none. #8 (`719394b`): `@steipete/sweet-cookie`
  0.3.0 to 0.4.4, and safe-storage overrides are scrubbed by name pattern. #9 (`1fc7031`): typed
  `/oracle` input is consumed under Oh My Pi's `handled` contract as well as pi's `action`. #13
  (`d5799d3`): `/oracle` and `/oracle-followup` route a blocked preflight to `/oracle-auth`.
  Maintenance: #10 (`25ac097`) setup-node 7.1.0, #12 (`647af5d`) Dependabot ignores, #14
  (`800e567`) tsx 4.23.15 and `@types/node` 22.20.5, #15 (`2f52f7c`) a sanity temp-directory leak,
  #16 (`b4643de`) the Ubuntu image on `cimg/node:24.22`. Dependabot alerts, security updates, and
  version updates were enabled on the fork the same day. Upstream `pi-oracle` `main` was still
  `d658a98`.
- Red before, green after, as recorded in the pull requests: on `pi` 1.3.0 the old guard failed
  `tsc` (`TS2339` on `event.prompt`) and two poller sanity fixtures failed their in-memory-history
  precondition (#7); the scrub test extended with `SWEET_COOKIE_CHROMIUM_SAFE_STORAGE_PASSWORD`
  failed on the fixed name list (#8); for one typed `/oracle`, the published 0.4.6 package on Oh
  My Pi 18.12.3 recorded two user messages and two `oracle-dispatch-request` entries and the fixed
  branch one of each, and the extended input-handler sanity test failed before the fix (#9); a
  sanity run added one `/tmp/oracle-runtime-*` directory before #15 and none after. A Linux
  container read a fixture Chromium profile through the worker's import path: `v10` cookies
  decrypted identically on 0.3.0 and 0.4.4, a `v11` cookie decrypted on 0.3.0 only with the Chrome
  override and on 0.4.4 only with the Chromium override, and 0.4.4 skipped a partitioned cookie
  with a warning (#8).
- Live eight-preset ChatGPT proof accepted on `567facf` in one runner invocation (310 s) through
  the operator's managed browser, the checker matching every job's `extensionProvenance` to
  0.4.7 at `567facf`: `pro_standard` `4056781b` 47 s, `pro_extended` `5cb7fa45` 37 s,
  `thinking_light` `3d71a96d` 37 s, `thinking_standard` `75068acb` 37 s, `thinking_extended`
  `268edd2b` 37 s, `thinking_heavy` `2e8fc771` 37 s, `instant` `f8e0ad06` 38 s,
  `instant_auto_switch` `fc969229` 37 s. `observedSelection` recorded the stops Pro, Pro, Medium,
  Medium, High, Extra High, Instant, and Instant. No picker reopen and no stale-stop reload fired.
- `npm run release:check` passed on `567facf` as one composition (142 s): 54 helper tests
  (including the native status smoke on `pi` 1.3.0), 4 site tests, 2 documentation-link tests,
  sanity, `npm pack --dry-run` (87 files), the proof check, the doctor, and the Crabbox lanes:
  macOS `platform-build` PASS (43.1 s, `run-1792528477327-j9c7wo`) and `real-extension` PASS
  (4.5 s, `run-1792528520475-rmvbk3`); Ubuntu, on the image rebuilt from `cimg/node:24.22` (node
  24.22.0, npm 11.19.1, agent-browser 0.39.1), `platform-build` PASS (32.5 s,
  `run-1792528490614-nwavgu`) and `real-extension` PASS (3.6 s, `run-1792528523121-iqdm2x`).
- First trusted publish. After `npm login --auth-type=web`, `npm trust github omp-oracle --file
  release.yml --repo alphastorm/omp-oracle --allow-publish --yes` created trust configuration
  `0c9f897f` (permissions `publish` and `stage publish`); the founder approved both in the
  browser. Under his authorization, tag `v0.4.7` on `567facf` started release run
  [`39493324352`](https://github.com/alphastorm/omp-oracle/actions/runs/39493324352): `verify`
  (20:35:51 to 20:37:21 UTC) packed shasum `1881d0971c833330141486bfadc9945b8b347c2c` (87 files,
  349.9 kB), and `publish` (20:37:23 to 20:37:37 UTC) signed the provenance statement (Sigstore
  log index 3343187837) and printed `+ omp-oracle@0.4.7`. The registry (visible after about 170 s
  of polling; time 2026-10-20T20:40:44Z) reports the same `dist.shasum` and integrity, 87 files,
  `latest`, and no `gitHead`, which a tarball publish does not carry. The provenance attestation
  names commit `567facf`, `refs/tags/v0.4.7`, `.github/workflows/release.yml`, and run
  39493324352 attempt 1; `npm audit signatures` on a clean install reported 2 verified registry
  signatures and 1 verified attestation. A local dry-run pack of the same tree on Node 26 gave
  shasum `4d867e4d4fdbef12f33f91caf253b124db709b6f` (different gzip bytes, as documented under
  [Publishing](#publishing)). Afterwards `npm access set mfa=publish omp-oracle` (Require
  two-factor authentication and disallow tokens) exited 0 after the founder's approval; the
  setting was not read back. Tag `v0.4.7` and the
  [GitHub release](https://github.com/alphastorm/omp-oracle/releases/tag/v0.4.7) name `567facf`.
- Installed with `omp plugin uninstall omp-oracle` and `omp plugin install omp-oracle@0.4.7` on
  Oh My Pi 18.12.3 (dotfiles-private `ca4d054`, committed by the plugins worktree sync and
  pushed). Second workstation (Oh My Pi 18.12.4): the frozen-lockfile dry run passed on
  `origin/omp-plugins`, then `git pull --ff-only` and `bun install --frozen-lockfile`; the
  worktree ended clean and even with origin, and an isolated print-mode `oracle_preflight` from the
  installed entry point reported ready.
- Installed package on the operator's real configuration (a fresh print-mode session loading the
  installed entry point): `pro_standard` job `a0729ded` recorded `packageVersion 0.4.7` and the
  installed path with no `gitHead`, completed 38 s after creation, and moved the slider from
  `Instant (1 of 5)` to `Pro (5 of 5)`, returning the account's saved tier to `Pro`. The
  `omp-session-gateway` session (started 09:35) and the release session started before the
  install and keep 0.4.6's extension code until restarted.
- Not exercised: `/oracle-auth` cookie import against a real browser profile (a macOS read
  prompts for the Keychain, and the container had no Linux keyring daemon), Deep Research, Grok,
  and Windows native.

#### 0.4.6 (2026-10-19, `00059ad`)

- Scope: the workstation's `agent-browser` moved from 0.35.0 to 0.39.1 (global npm install,
  2026-10-19). #3 (`672aa13`): `/oracle-auth` relaunches only after the driver stops listing the
  previous auth session (the job-teardown rule, now shared as `closeAgentBrowserSession`), both
  workers run the driver with `AGENT_BROWSER_NO_WEBMCP=1`, and the Ubuntu smoke image installs
  0.39.1. #4 (`1e15780`): submit replies name `oracle_read` with the job id for a status check the
  user asks for. #5 (`aeb730f`): completion counts only rendered stop controls.
- Driver comparison before the upgrade, 0.35.0 against 0.39.1 on every command shape the workers
  send (isolated attach, pinned CDP tab, auth launch), each version under its own `HOME` and
  socket directory: identical exit codes, parsed snapshot entries, eval results, pinned-tab JSON
  (`tab close`, `tab_gone`, `Cannot close the last tab`), and session inventory format.
  Two differences: an auth relaunch issued right after `close` succeeded 9 of 10 times on 0.35.0
  and 0 of 10 on 0.39.1 (`Invalid response: EOF … it may or may not have run, so it was not
  retried`), and 0.39.1 appended a WebMCP announcement to `eval`, `get url`, `snapshot -i`, and
  `get text` output when a page registered tools late (4 of 4; 0 of 4 with
  `AGENT_BROWSER_NO_WEBMCP=1`). With that variable set, a 0.39.1 launch command that opens a URL
  directly lands on `about:blank`; Oracle launches on `about:blank` and then opens. Signed-out
  grok.com registered no WebMCP tools; chatgpt.com served the headless probe a Cloudflare challenge.
- Red before, green after, as recorded in the pull requests: #3's sanity test runs
  `auth-bootstrap.mjs` from a live auth session against a fake driver that models the closing
  daemon and WebMCP output. It failed on the previous worker with the launch EOF, failed with only
  the teardown wait (the probe read as text and verification timed out), and passes with both.
  With the real 0.39.1 driver and a loopback page, the previous worker exited 1 and left the
  session listed, and the fixed one exited 0 and committed the seed. #5's capture-proof replay of
  the retained hidden workspace timed out on `672aa13` and passes on the fix, where a rendered
  offscreen `Stop` still holds partial-text, empty-thinking, and Deep Research waits.
- Live from source before release, through isolated print-mode sessions on clones of the
  diligence account's managed profile. From the working tree committed afterwards as `7b91712`
  (#3): `instant` `72a0c013` and `8c88f752` on 0.39.1 and `143bd39b` on 0.35.0 completed with
  warning-free cleanup, no driver session left, and the keeper's idle quit, each only after the
  121 s stale-stop reload. Diagnosis of that wait: `8df0d1e1` (`--disable-sync`,
  `navigator.webdriver` true, 151 s) and `3b9a5df9` (the operator's browser arguments,
  `navigator.webdriver` false, 152 s). Over CDP, the only `Stop` match was a 0×0 button in
  ChatGPT's Home composer, kept mounted in a `display:none` workspace (`Workspace-IfYAxV`) after
  the send, while the visible reply showed Copy, Rate response, and Regenerate response; the page
  was visible and focused (about 120 animation frames per second), and focus emulation did not
  clear the control. On the fixed tree (committed afterwards as `aeb6a04`, merged as #5; its jobs
  record `gitHead` `672aa13`): `instant` `d99127ff` completed 23.8 s after send and its
  same-thread follow-up `614df619` 24.6 s after send (same conversation, `responseIndex` 1,
  fenced `yaml` reply). Evidence is in `.artifacts/ui-drift-2026-10-20/`. #4's session (a
  marker-only seed, so no ChatGPT message) showed the new status line in job `9eb2537e`'s submit
  reply and then failed at auth as expected.
- Live eight-preset ChatGPT proof accepted on `00059ad` in one runner invocation (307 s) through
  the operator's managed browser, every job recording `packageVersion 0.4.6` and this checkout:
  `pro_standard` `ecc593b7` 42 s, `pro_extended` `9eafcd28` 39 s, `thinking_light` `ecca97a3`
  37 s, `thinking_standard` `f22ed1ff` 36 s, `thinking_extended` `b1939dc3` 38 s,
  `thinking_heavy` `ea065f50` 38 s, `instant` `c1cfd4e7` 38 s, `instant_auto_switch` `d35b3d1b`
  37 s. All eight completed with both markers. `observedSelection` recorded the stops Pro, Pro,
  Medium, Medium, High, Extra High, Instant, and Instant, with products `pro`, `pro`, four
  `thinking`, and two `instant`. No picker reopen and no stale-stop reload fired.
- Crabbox lanes on `00059ad`, with the Ubuntu image rebuilt for agent-browser 0.39.1: macOS
  `platform-build` PASS (44.5 s) and `real-extension` PASS (5.2 s), Ubuntu `platform-build` PASS
  (35.5 s) and `real-extension` PASS (4.0 s); `npm run release:check` passed as one composition
  on the same clean tree (54 helper tests, 4 site tests, 2 documentation-link tests, sanity, and
  `npm pack --dry-run`).
- Published `omp-oracle@0.4.6` from `00059ad` under the founder's authorization (registry time
  2026-10-20T12:22:04Z), after `npm login --auth-type=web` (the stored token answered `E401`);
  both browser approvals completed within their windows. Registry `gitHead`
  `00059ad23dedc423274643e7539a6763380c936e`, shasum `ebf5b645697bedd68de357e7135e44f745e53014`,
  87 files, `latest` (visible after about four minutes of polling). Tag `v0.4.6` and the
  [GitHub release](https://github.com/alphastorm/omp-oracle/releases/tag/v0.4.6) name the same
  commit. Installed with `omp plugin uninstall omp-oracle` and
  `omp plugin install omp-oracle@0.4.6` (dotfiles-private `c961f1e`).
- Installed package on the operator's real configuration (a fresh print-mode session loading the
  installed entry point): `pro_standard` job `cca94b8e` recorded `packageVersion 0.4.6` and the
  installed path, completed 38 s after creation, and moved the slider from `Instant (1 of 5)` to
  `Pro (5 of 5)`, returning the account's saved tier to `Pro`. Sessions started before the
  install keep 0.4.5's extension code until restarted.
- Not exercised: `/oracle-auth` against a real provider (the relaunch fix is proved with the real
  0.39.1 driver against a loopback page and with the fake driver), and a live long-thinking or
  Deep Research job on the rendered-stop change (the capture-proof replay covers those waits).

#### 0.4.5 (2026-10-18, `a80242d`)

- Scope: #1 (`5080f48`). `oracle_read`, `/oracle-status`, and `/oracle-read` find another project's
  job by id and return it only with its owning `projectId`. `observedSelection` records the
  observed `product` and the bound frame's `deepResearchIframeTitle`. A slider reading logged
  before configuration failed is kept. Review fixes before merge: a research frame whose capture
  marker no longer resolves still binds by `src`, and lookup reads the id directly instead of
  scanning every job directory. #2 (`82ee037`) reopens a thinking-effort picker that ChatGPT
  closes mid-step: live `instant` job `73dd8cc5` read `Pro (5 of 5)`, and one ArrowLeft later
  the picker was closed on `High` behind a pill named only `Select ChatGPT model`. That job still
  saved `observedSelection` `Pro (5 of 5)`/`pro` on failure.
- Red before, green after, as recorded in the pull requests: the cross-project regression failed
  on `9a3eae0` because the error did not name the owner or the `projectId` retry; the frame
  assertion failed on #1's first commit `3bf85ea` with `The bound report frame is absent or
  ambiguous.` (pass 1, fail 2); the picker regression, which replays `73dd8cc5`'s closed composer,
  failed on the previous worker with `Lost the ChatGPT thinking-effort slider while stepping`
  (pass 1, fail 2). All three pass on the release tree.
- Live from source before release, through isolated print-mode sessions on the diligence
  account's managed browser. On #1's branch with its review fixes (committed afterwards as
  `249c010`): `instant` `7ac74993` completed (`High (3 of 5)` to `Instant (1 of 5)`, `product`
  `instant`). A second session in another cwd was refused with the owning root named, retried
  with that `projectId`, and read the saved answer. On the working tree committed afterwards as
  `1d85b66` (identical to `82ee037`; its jobs record `gitHead` `5080f48`, its base):
  `pro_standard` `0cd95d8b` (Instant to Pro); `instant`
  `032b6b6b` (Pro to Instant; the picker stayed open, so the reopen path is fixture-proven only);
  a same-thread `thinking_light` follow-up `08a7eb91` (`responseIndex` 1, fenced `yaml` reply);
  and `deep_research` `3e630a73` (1 min 45 s), whose widget frame attached 21 s after send. Its
  report was read from the widget, its 956-byte native Markdown export was collected
  (`complete`), and `observedSelection` recorded `deepResearchIframeTitle` `Deep research`, the
  first live observation of that title.
- Live eight-preset ChatGPT proof accepted on `a80242d` in one runner invocation (314 s) through
  the operator's managed browser, every job recording `packageVersion 0.4.5` and this checkout:
  `pro_standard` `578200a6` 48 s, `pro_extended` `b40beb5c` 37 s, `thinking_light` `27f73947`
  37 s, `thinking_standard` `d10f0b60` 37 s, `thinking_extended` `6cbdcaa7` 37 s, `thinking_heavy`
  `32cfa9c4` 39 s, `instant` `bd0fc88b` 39 s, `instant_auto_switch` `b1bca34f` 37 s. All eight
  completed with both markers. `observedSelection` recorded the stops Pro, Pro, Medium, Medium,
  High, Extra High, Instant, and Instant, with products `pro`, `pro`, four `thinking`, and two
  `instant`. No picker reopen fired, including on `pro_extended` to `thinking_light`.
- Crabbox lanes on `a80242d`: macOS `platform-build` PASS (42.6 s) and `real-extension` PASS
  (5.1 s), Ubuntu `platform-build` PASS (34.4 s) and `real-extension` PASS (4.2 s);
  `npm run release:check` passed as one composition on the same clean tree (54 helper tests,
  4 site tests, 2 documentation-link tests, sanity, and `npm pack --dry-run`).
- Published `omp-oracle@0.4.5` from `a80242d` under the founder's authorization, after
  `npm login --auth-type=web` (the stored token answered `E401`); both browser approvals completed
  within their windows. Registry `gitHead` `a80242d8266086348fa2ae280776e8507e3ff733`, shasum
  `219026e1843a82afaae4ed16e3a797f9900664db`, 87 files, `latest` (visible within about 90
  seconds). Tag `v0.4.5` and the [GitHub release](https://github.com/alphastorm/omp-oracle/releases/tag/v0.4.5)
  name the same commit. Installed with `omp plugin uninstall omp-oracle` and
  `omp plugin install omp-oracle@0.4.5` (dotfiles-private `0edd64c`).
- Installed package on the operator's real configuration (a fresh print-mode session loading the
  installed entry point): `pro_standard` job `a7ea581b` recorded `packageVersion 0.4.5` and the
  installed path, completed 37 s after creation, and moved the slider from `Instant (1 of 5)` to
  `Pro (5 of 5)`, returning the account's saved tier to `Pro`. Sessions started before the
  install keep 0.4.4's extension code until restarted.
- Not exercised: a live `/oracle-auth` run, the picker reopen path against the live page, and
  the cross-project `/oracle-status` and `/oracle-read` commands outside the native test (the live
  check used `oracle_read`).

#### 0.4.4 (2026-10-17, `f69ef0d`)

- Scope: job `086c4b50` of 2026-10-16 against 0.4.3. Code blocks in ChatGPT's current shell lost
  their language and, on a reloaded page, their fences, and a runnable block's editor rendered as
  prose; an off-site source pill was activated as a download at completion and again on
  recollection (all `d276fca`). Response previews cut at 4,000 characters now say so (`c0a2806`);
  the preset proof runner and the isolated-session recipes drop `--standard`, which Oh My Pi 18.11
  rejects (`8222ac5`). Merged from upstream `pi-oracle` 0.7.21–0.7.22 (`6111580`): an anonymous
  `ua-` visitor is `login_required`, `/oracle-auth` verification survives navigation and waits out
  a closing `agent-browser` daemon, prompt-less `before_agent_start` turns are ignored, plus the
  upstream test-audit repairs and the `protobufjs` 7.6.6 override. The README and guides were
  rewritten reader-first, with `npm run test:docs` in the local gate (`7b2e907`, `d739600`).
- Red before, green after, as recorded in the fix commits: `npm run proof:capture` against the
  live, reloaded, and editor renders and the off-site pills, plus the production capture against
  job `086c4b50`'s two saved DOMs (`d276fca`); the auth-flow helper tests for the upstream fixes
  (`6111580`). `npm run proof:capture` passed again on `6111580`, including its research-widget
  fixture. No live `/oracle-auth` run and no live Deep Research job; the Deep Research frame
  capture and export code is unchanged.
- Live from source before release, through isolated print-mode sessions on the diligence
  account's managed browser: `instant` `8607fad7` (42 s) and a same-thread follow-up `3ef23f50`
  (41 s; same conversation, `responseIndex` 1), whose one-block YAML reply was saved as a fenced
  `yaml` block. `d276fca` records an isolated `instant` job whose YAML and 1-line and 300-line
  Python blocks were captured identically on completion and on recollection.
- Live eight-preset ChatGPT proof accepted on `f69ef0d` in one runner invocation through the
  operator's managed browser, every job recording `packageVersion 0.4.4` and this checkout:
  `pro_standard` `551b6ae3` 42 s, `pro_extended` `0abc0038` 42 s, `thinking_light` `ec2ca97c`
  37 s, `thinking_standard` `eb3f11bd` 37 s, `thinking_extended` `2dc6703a` 39 s, `thinking_heavy`
  `8c8a4c5f` 37 s, `instant` `145cfa78` 37 s, `instant_auto_switch` `ce6f1e4e` 38 s; all eight
  completed with both markers, and `observedSelection` recorded the stops Pro, Pro, Medium,
  Medium, High, Extra High, Instant, and Instant.
- Crabbox lanes on `f69ef0d`: macOS `platform-build` PASS (43.0 s) and `real-extension` PASS
  (5.4 s), Ubuntu `platform-build` PASS (34.1 s) and `real-extension` PASS (4.5 s);
  `npm run release:check` passed as one composition on the same clean tree (51 helper tests,
  4 site tests, 2 documentation-link tests, sanity, and `npm pack --dry-run`).
- Published `omp-oracle@0.4.4` from `f69ef0d` under the founder's authorization, after
  `npm login --auth-type=web` (the stored token answered `E401`); both browser approvals completed
  within their windows. Registry `gitHead` `f69ef0d249dada48670de568b667d7c025f1a389`, shasum
  `5a48c2041b6026f173a15c86ac2d7fe9380103f2`, 87 files, `latest` (visible within about two
  minutes). Tag `v0.4.4` and the [GitHub release](https://github.com/alphastorm/omp-oracle/releases/tag/v0.4.4)
  name the same commit. Installed with `omp plugin uninstall omp-oracle` and
  `omp plugin install omp-oracle@0.4.4` (dotfiles-private `2e50b59`).
- Installed package on the operator's real configuration (a fresh print-mode session loading the
  installed entry point): `pro_standard` job `817c94e4` recorded `packageVersion 0.4.4` and the
  installed path, completed 55 s after its session started, and moved the slider from
  `Instant (1 of 5)` to `Pro (5 of 5)`, returning the account's saved tier to `Pro`. Sessions
  started before the install keep 0.4.3's extension code until restarted.

#### 0.4.3 (2026-10-06, `fb26f35`)

- Scope: the defect report of 2026-10-06 against 0.4.2. A job whose tab another CDP client moved
  saved that conversation's answer as its own, a failed capture saved unbound text, and
  positional bindings could not be recollected without a hand-read message ID; Deep Research
  lost its native export to the report container, its citations and diagram source, and its setup
  to a frame-driven wait; an announcement modal blocked model configuration (all `d1fbc43`).
  Refused last-tab closes were retried by every live poller indefinitely (`bd533da`); wake-ups
  queued behind busy sessions arrived hours late, one turn each (`13bac0d`); preflight now
  reports capacity and a missing archive input names the project root (`9d14e44`).
- Red before, green after: the capture proof's new scenarios ran against `daf16d5`'s worker and
  reproduced each failure there (completion declared from a finished foreign conversation and its
  text returned; a failed capture saving the foreign text; positional recollection refused; the
  report container flagged as the native export ahead of `Export`, with the status line and
  diagram layout text in the body; the frame-driven wait returning false without animation
  frames; no send state), then passed on the fix. The extension regressions (last-tab refusal,
  `error` preservation, busy-session suppression, origin-session settlement, batched delivery,
  capacity, archive root) each failed before their fix.
- Live from source before release, through isolated print-mode sessions on the diligence
  account's managed browser: `instant` `c60e5ebd` (32 s; the post-send URL adopted through the
  job's archive turn, no fallback); an anchored recollection of that job with its binding cut to
  the turn index, which regained the same message ID and hash; `thinking_light` `63373773`, whose
  tab a second CDP client moved to another conversation 20 s after send: detected 1.5 s later, one
  `navigation` event, the job's conversation reopened, and its own 40-item answer collected
  `complete`; `deep_research` `048faf05` (8 min; the tool enabled during `configuring_model`;
  native export 7,106 bytes; 18 citation tokens resolved into 22 footnotes, none unresolved;
  Mermaid source kept) and two recollections of it (`Research completed in 6m`; referral
  parameters dropped); and a same-thread follow-up `4492f190` (`responseIndex` 1, 32 s). Read-only
  against the conversation of incident job `6f367962`, the shipped capture bound turn 1 both
  positionally and through the archive anchor to the message ID the incident evidence records,
  with `Worked for 15m 7s`.
- Live eight-preset ChatGPT proof accepted on `fb26f35` in one runner invocation through the
  operator's managed browser: `pro_standard` `c12ae289` 58 s, `pro_extended` `d118eee7` 49 s,
  `thinking_light` `9ae9130f` 33 s, `thinking_standard` `a50b411b` 38 s, `thinking_extended`
  `c9e93bc2` 43 s, `thinking_heavy` `123a2f91` 39 s, `instant` `03f06fea` 39 s,
  `instant_auto_switch` `407789fa` 38 s; all eight completed with both markers, and each recorded
  the slider stop it observed in `observedSelection`.
- Crabbox lanes on `fb26f35`: macOS `platform-build` PASS (43.7 s) and `real-extension` PASS
  (5.8 s), Ubuntu `platform-build` PASS (34.6 s) and `real-extension` PASS (4.4 s), after
  rebuilding the pruned `omp-oracle-platform-smoke:node24` image; `npm run release:check` passed
  as one composition on the same clean tree.
- Published `omp-oracle@0.4.3` from `fb26f35` under the founder's authorization, after
  `npm login --auth-type=web` (the stored token answered `E401`); both browser approvals completed
  within their windows. Registry `gitHead` `fb26f3547b7cbbbb2e181dfd20eb510a021ad0e1`, shasum
  `b15916f69f41a2cbfe00d337261c3c0761fd63c9`, 86 files, `latest` (visible within about a minute).
  Tag `v0.4.3` and the [GitHub release](https://github.com/alphastorm/omp-oracle/releases/tag/v0.4.3)
  name the same commit. Installed with `omp plugin uninstall omp-oracle` and
  `omp plugin install omp-oracle@0.4.3` (dotfiles-private `716a9b9`).
- Installed package on the operator's real configuration (a fresh print-mode session loading the
  installed entry point): `pro_standard` job `44bb5bb2` recorded `packageVersion 0.4.3` and the
  installed path, completed in 42 s, and returned the account's saved tier from `Instant` to `Pro`.
  Sessions started before the install keep 0.4.2's extension code (its pollers and wake-up
  delivery) until restarted.

#### 0.4.2 (2026-09-30, `18c0538`)

- Scope: the redesigned ChatGPT web app (`e4f4b07`). An account on the redesign failed every job
  at `verifying_auth` (native job `cb21df26`: `Timed out waiting for the ChatGPT chat UI to become
  ready`); readiness was proved red against that job's retained snapshot and green after, offline.
  Two further failures surfaced live and were fixed before release: the model picker's open state
  (the redesigned interactive snapshot omits the menu node) and the Deep Research widget, which
  renders beside the reply rather than inside it (job `77be598d` failed with
  `deep_research_report_unreadable` while its research ran on; the frame binding was proved red,
  then green, against that same live conversation without sending). Also the preset proof
  runner's managed-browser transport (`24754e2`) and the brand assets (`d9720ba`).
- Live on the redesigned shell from source before release, through isolated print-mode sessions
  on the diligence account's managed browser: `instant` `2aa05254` (slider Pro to Instant, 44 s);
  a same-thread `thinking_light` follow-up `cc177f25` (Instant to Medium, `responseIndex` 1); and
  `deep_research` `5ff15fc5`, whose widget frame attached 21 s after send, whose report was read
  from the widget about 3 minutes later, and whose native Markdown export (1,104 bytes) was
  collected with `collectionStatus: complete`. The no-send composer proof passed on the live page
  for a plain prompt and with the Deep Research tool selected.
- Live eight-preset ChatGPT proof accepted on `18c0538` in one runner invocation, the first
  through the operator's managed browser: `pro_standard` `6f7519b5` 52 s, `pro_extended`
  `42cf0506` 87 s, `thinking_light` `3f9d77b9` 48 s, `thinking_standard` `4b72b86a` 43 s,
  `thinking_extended` `0550739e` 41 s, `thinking_heavy` `13a05622` 42 s, `instant` `8c67cafc`
  44 s, `instant_auto_switch` `6ab5864c` 41 s; all eight completed with both markers, and the
  slider named every stop it reached (Instant 1, Medium 2, High 3, Extra High 4, Pro 5 of 5).
- Crabbox lanes on `18c0538`: macOS `platform-build` PASS (54.9 s) and `real-extension` PASS
  (6.1 s), Ubuntu `platform-build` PASS (52.1 s) and `real-extension` PASS (4.6 s), after
  rebuilding the pruned `omp-oracle-platform-smoke:node24` image; `npm run release:check` passed
  as one composition on the same clean tree.
- Published `omp-oracle@0.4.2` from `18c0538` under the founder's authorization. npm auth had
  expired (`npm whoami` returned `E401`), so `npm login --auth-type=web` ran first; both browser
  approvals completed within their windows, and the publish took 21 s. Registry `gitHead`
  `18c0538c00563b37550b6a8ca35ee46d737f7b30`, shasum `a3f6f2228d2756ec3835b9408ce32f1d0496a1e1`,
  86 files, `latest` (visible within about 2 minutes). Tag `v0.4.2` and the
  [GitHub release](https://github.com/alphastorm/omp-oracle/releases/tag/v0.4.2) name the same
  commit. Installed with `omp plugin uninstall omp-oracle` and
  `omp plugin install omp-oracle@0.4.2` (dotfiles-private `996b160`).
- Installed package on the operator's real configuration (a fresh print-mode session loading the
  installed entry point): `pro_standard` job `86db08b4` recorded `packageVersion 0.4.2` and the
  installed path; the operator's keeper opened the diligence Chrome past the lock an exited
  keeper-run Chrome had left, and the job completed in 75 s. It also returned the account's saved
  tier to `Pro`: the redesigned shell saves the last stop a job sets to the account, and the
  proof's canonical order ends on `instant`.
- Post-release checks of the two redesigned paths the proof and smokes had not reached. Model
  files render inside the reply root: read-only on an existing thread with PDF, Markdown, and ZIP
  outputs, the worker's capture listed each `Download file` control and inline `Download` link as
  a candidate and excluded the prompt's own uploads. A `pro_standard` job through the installed
  package asking for a CSV (`d178bf26`, 117 s) collected `oracle_artifact_probe.csv` through the
  redesigned `Download file` control, byte-exact and `validated`, with `collectionStatus:
  complete`; the model answered with the file card alone, without the requested text line. The
  no-send composer proof passed on the live page with a 41,250-byte draft (written, verified,
  replaced, and cleared).

#### 0.4.1 (2026-09-24, `7c39d31`)

- Scope: the composer hydration fix found by the operator's diligence pipeline (`76d27d0`,
  verified red against the production error on the pre-fix worker and green after) and the
  composer-proof endpoint requirement with its sanity rule against hardcoded browser endpoints
  (`bb35a08`).
- Live eight-preset ChatGPT proof accepted on `7c39d31` in one runner invocation, routed to the
  diligence account with `PI_ORACLE_PROOF_RELAY=http://127.0.0.1:9333`: `pro_standard`
  `9a05069b` 60 s, `pro_extended` `9f3e82fc` 58 s, `thinking_light` `6017462d` 50 s,
  `thinking_standard` `cbbd9997` 43 s, `thinking_extended` `6fb020ef` 44 s, `thinking_heavy`
  `b0846697` 51 s, `instant` `8416b15a` 43 s, `instant_auto_switch` `325cd63c` 44 s; all eight
  completed with both markers. These are the composer fix's first live jobs.
- Crabbox lanes on `7c39d31`: macOS `platform-build` PASS (52.8 s) and `real-extension` PASS
  (6.2 s), Ubuntu `platform-build` PASS (38.1 s) and `real-extension` PASS (4.8 s);
  `npm run release:check` passed as one composition on the same clean tree.
- Published `omp-oracle@0.4.1` from `7c39d31` under the founder's authorization for the rollout.
  The first `npm publish --ignore-scripts` expired waiting for the browser approval (npm's auth
  poll returned `E404` after about five minutes; nothing was published); the second, started once
  the founder was ready, completed in 18 s. Registry `gitHead`
  `7c39d31e37a60363d6a9949fb3ad8a176de82464`, shasum `006f989f12b88d6b4d84bc51ed69dc1c44fdc015`,
  85 files, `latest` (visible about 2.5 minutes after publish). Tag `v0.4.1` and the
  [GitHub release](https://github.com/alphastorm/omp-oracle/releases/tag/v0.4.1) name the same
  commit. Installed with `omp plugin uninstall omp-oracle` and
  `omp plugin install omp-oracle@0.4.1` (a real directory).
- Managed-mode cutover of the operator's configuration: the `oracle-diligence-chrome` Hub process
  (the 9333 relay Chrome) was stopped. Its stop killed the whole process tree (exit 143) and left
  `exit_type: Crashed` plus a stale `SingletonLock` in the profile, so `exit_type` was reset to
  `Normal` before the first managed launch. The agent-scope config (dotfiles-private `c6a9bfa`)
  now sets `browser.chatGptManagedProfileDir` to the diligence profile in place of the relay
  endpoint, and the diligence pipeline's dispatcher accepts the managed transport in its
  preflight check (alpha-diligence `2269397`; isolated-seed and not-ready preflights are still
  refused).
- Managed-mode Deep Research on the operator's real configuration through that dispatcher (fresh
  OMP session, installed 0.4.1): job `b1a51038` recorded `packageVersion 0.4.1` and the installed
  path; Oracle opened the diligence Chrome (keeper-launched, DevTools on an ephemeral port),
  armed frame capture before send, read the report from the widget, collected the native Markdown
  export (1,618 bytes), and completed in 2.2 minutes with no cleanup warnings. Collection is
  `partial` only for two optional frame-artifact candidates; nothing required was missing. The
  dispatcher's `read` returned the complete job, and the keeper quit Chrome after the 120 s idle
  grace (exit 0).
- Not yet supported: the preset proof runner resolves only relay endpoints, and the operator no
  longer has one, so the next release needs managed-profile support in the runner before its
  proof.

#### 0.4.0 (2026-09-24, `09d33f3`)

- Scope: `browser.chatGptManagedProfileDir`, an opt-in managed ChatGPT browser (`4e376b0`), with
  the focused cross-family review's findings closed (`86e76fb`: a per-command browser-identity
  recheck with a sticky `managed_browser_changed` verdict, canonical profile keys, Grok-seed
  separation, and the `-switch`/`/switch` launch-flag guard bypass, which also reached isolated
  launches); relay readiness that names an unreachable endpoint and follows its recovery
  (`572e4a6`); and the managed smoke recipe in the test plan (`ab0ea57`).
- Managed-mode live proof before release, from source in isolated sessions: launch, reuse of an
  operator-opened Chrome, sign-in, and idle quit on the diligence profile (`4e376b0`);
  port-takeover tracers with a real replacement browser ending in `managed_browser_changed` in
  2.0 s (readiness loop) and 25.1 s (in-flight navigation); and a signed-in Instant job
  `99598637` on an APFS clone of the diligence profile, complete in 35 s on `86e76fb`, with the
  keeper quitting Chrome 15 s after the job.
- Live eight-preset ChatGPT proof accepted on `09d33f3`, routed to the diligence account with
  `PI_ORACLE_PROOF_RELAY=http://127.0.0.1:9333`: `pro_standard` `aa666210` 61 s, `pro_extended`
  `ae1aea20` 55 s, `thinking_light` `65b89ad7` 45 s, `thinking_standard` `eaf65ac7` 48 s,
  `thinking_extended` `4c4b98fa` (167 s from job creation), `thinking_heavy` `38ababf3` 43 s,
  `instant` `efa5a896` 43 s, `instant_auto_switch` `1602f216` 45 s; all eight completed with both
  markers. The first runner invocation was killed by the operator shell's 300-second deadline
  after four presets, with `thinking_extended` in flight; that job completed on its own, the five
  completed jobs seeded the proof file, and a partial rerun supplied the other three, so the
  checker validated every entry from disk. The proof shared the dedicated Chrome with the
  operator's diligence pipeline: pipeline Deep Research attempt `29cba501` (installed 0.3.4)
  started during it and failed before insertion on the composer hydration race fixed after this
  release (`76d27d0`).
- Crabbox lanes on `09d33f3`: macOS `platform-build` PASS (52.6 s) and `real-extension` PASS
  (7.5 s), Ubuntu `platform-build` PASS (44.9 s) and `real-extension` PASS (7.2 s). The first
  `release:check` stopped at the doctor because the Ubuntu image
  `omp-oracle-platform-smoke:node24` had been pruned; after the documented `docker build` (8 s
  from cache), `npm run release:check` passed as one composition on the same clean tree.
- Published `omp-oracle@0.4.0` from `09d33f3` by the agent under explicit founder authorization.
  The stored registry token answered 401, so `npm login --auth-type=web` and then
  `npm publish --ignore-scripts` ran as supervised PTY processes and the founder completed both
  browser approvals. Registry `gitHead` `09d33f37700ecb6a549054539e22f9542d57a7ee`, shasum
  `58bd3c8de2f06d2afe80b4e771f72b12cf1d9767`, 85 files, `latest` (visible within about a minute).
  Tag `v0.4.0` and the [GitHub release](https://github.com/alphastorm/omp-oracle/releases/tag/v0.4.0)
  name the same commit.
- Installed on Oh My Pi 18.2.11 with `omp plugin uninstall omp-oracle` and
  `omp plugin install omp-oracle@0.4.0` (`~/.omp/plugins/node_modules/omp-oracle`, a real
  directory); the operator's configuration stayed on the 9333 relay. Installed-package jobs from
  the operator's diligence pipeline then ran through it, each recording `packageVersion 0.4.0` and
  the installed path: Instant `689ce19f` complete, Deep Research `3bfccbb4` complete in 17 minutes
  with a 43,862-character report (collection `partial`: optional `native_markdown_export` and one
  frame artifact missing, nothing required), and Pro `d7ae3b35` still generating at this entry.
- Not yet run: the managed-mode cutover of the operator's configuration and a managed-mode Deep
  Research job; both wait for the diligence pipeline to be idle.

#### 0.3.4 (2026-09-21, `302eeee`)

- Scope: a second debt/perf pass on the clean `0.3.3` tree. `sha256File` read the whole archive
  into memory before hashing, so every `oracle_submit` allocated up to 250 MiB inside the
  agent's process; it now streams (`cdd15ad`, digest pinned against the bytes on disk). One
  subprocess runner, `runCommand`, replaces the four hand-rolled spawn/timeout/kill copies (both
  workers, `spawnCp`, `closeRuntimeBrowserSession`), closing the class behind the 0.3.3
  spawn-options bug that had to be fixed twice (`04f7fa8`); the runner is covered directly and
  the existing hung-`cp` and hung-`agent-browser` timeout tests exercise it. Two source-text
  pins that guarded the old copies were retired for that behavioral test.
- Measured, deliberately not changed: per-phase timing over the eight `0.3.3` proof jobs
  (median 34 s total) is 0.1 s connect, 3.3 s model configuration, 5.9 s upload confirmation,
  0.3 s send, 24 s from send to completion, 0.3 s cleanup. The upload wait is a real poll with a
  two-read stability guard, and the send-to-completion span is dominated by the fixed 15 s
  post-send settle (introduced upstream in 0.1.12 with no recorded failure it prevents) plus the
  5 s completion poll. Neither was removed: they sit in the send path, an intermittent failure
  needs far more than one proof run to rule out, and the saving only matters for trivial
  prompts (real jobs are provider-time dominated). `npm audit --omit=dev`: 0 vulnerabilities.
- Local gate green on `302eeee`; one intermediate red was the retired source pins themselves.
- Pre-commit isolated source-session smoke on the consolidated worker: relay job completed in
  50 s with both markers, warning-free cleanup, no leaked processes.
- Live eight-preset ChatGPT proof accepted on `302eeee` (relay resolved from the operator's
  config): `pro_standard` `fc38b957` 53 s, `pro_extended` `7ac20339` 58 s, `thinking_light`
  `94d26a34` 45 s, `thinking_standard` `8de84ce0` 43 s, `thinking_extended` `87485207` 42 s,
  `thinking_heavy` `f25f5e87` 42 s, `instant` `87de4a3a` 42 s, `instant_auto_switch` `a000305f`
  43 s; all eight completed with both markers and neither self-heal path fired.
- Crabbox lanes on `302eeee`: macOS `platform-build` PASS (52.3 s) and `real-extension` PASS
  (5.3 s), Ubuntu `platform-build` PASS (37.9 s) and `real-extension` PASS (4.3 s).
  `npm run release:check` then passed as one composition on the same clean tree.
- Published `omp-oracle@0.3.4` from `302eeee` by the agent under explicit founder authorization
  for this exact publish. npm's `auth-and-writes` policy still demanded a second factor: the
  first attempt through a pipe exited `EOTP` because npm only waits for the browser approval on
  a real TTY, so the publish was rerun as a supervised PTY process, the approval page opened in
  the founder's browser, and the founder approved it. `npm publish --ignore-scripts` as before,
  the composition having just passed on the unchanged tree. Registry `gitHead`
  `302eeeeb80d852f19f194bedc6263107d35f808f`, shasum
  `a269404f7515c96488e800ea23f8ad9094ee8815`, 81 files, `latest` (visible about a minute after
  npm's "being processed" notice). Tag `v0.3.4` and the
  [GitHub release](https://github.com/alphastorm/omp-oracle/releases/tag/v0.3.4) name the same
  commit.
- Installed-package job on Oh My Pi 18.2.7 after `omp plugin uninstall omp-oracle` and
  `omp plugin install omp-oracle@0.3.4`: job `0d1f1c46` through the operator's real
  configuration completed in 52 s with both markers, `extensionProvenance` recorded
  `packageVersion 0.3.4`, the installed path, and no `gitHead`, nothing on stderr.

#### 0.3.3 (2026-09-21, `a336994`)

- Scope: the four handoff fixes (proof runner relay default, installed-package provenance,
  `collectArtifactCandidates` arity plus the dead `suspiciousArtifactLabels` signal, spawn
  options leaking into `spawn()`), the worker runtime typecheck promoted to a real gate, the debt
  paydown (discovery-based syntax check, dead exports and the 225 proved-redundant preset
  aliases, shared state-dir/agent-browser resolvers, `auth-bootstrap.mjs` typechecked, docs
  reconciled with this ledger), and two defects found by this release's own proof.
- Hidden-tab rendering flags measured against a throwaway Chrome (fresh profile, no account):
  without flags every hidden state froze `requestAnimationFrame` at 0/s and throttled timers to
  1/s; with `--disable-backgrounding-occluded-windows --disable-renderer-backgrounding
  --disable-background-timer-throttling` an occluded window's active tab stayed `visible` at
  120 rAF/s, while a background tab or a minimized window stayed `hidden` at 0 rAF/s (timers
  5/s). The diligence Chrome was relaunched with the flags; reload reconciliation stays the fix.
- First proof run, on the superseded prep commit `64e0f11`: six presets completed in 43–57 s,
  then `instant` sat in `awaiting_response` for 31 minutes with a fresh heartbeat. Read-only
  CDP inspection of the job tab: `visibilityState: visible`, the assistant turn fully rendered
  with both markers, `Stop answering` still mounted, and `performance` showing the generation
  POST `/backend-api/f/conversation` returned 200 at t+14 s. A `Page.reload` cleared the control
  and the old worker completed the job. Fix `06f3629` (`nextStaleStopState`): after two minutes
  of non-empty, unchanged turn text under a persistent stop control the worker reloads the
  conversation; proved on the shipped path with tracer job `ab1b77bb`, whose tab received an
  orphaned stop control after send — `Stop control still present after 121 s with the turn
  unchanged; reloading`, complete 13 s later with both markers and warning-free cleanup.
- Second proof run, on the superseded prep commit `ef07f01`: 7/8, with `instant` (right after
  `thinking_heavy`, slider at `Extra High`) failing in 14 s with `Lost the ChatGPT
  thinking-effort slider while stepping` while the captured failure snapshot already showed the
  closed composer pill reading `Instant`. Fix `f7edc10` (`powerSliderClosedIntoSelection`)
  accepts a vanished slider whose closed pill shows the requested stop; the regression uses that
  captured snapshot. The same `Extra High → Instant` transition passed normally in the accepted
  run, so both faults are intermittent provider behavior the worker now tolerates.
- `npm run release:check` on `afcd994` failed in both packed `platform-build` lanes: the new
  provenance regression shelled out to `git rev-parse` inside the rsync'd copy, which has no
  `.git`. That copy is the installed-package case the regression exists for, so `88783b7`
  asserts "no `gitHead`" there instead; proved by running the platform sanity from a git-less
  rsync copy before committing. One transient: the doctor's Ubuntu target-tool probe failed once
  inside the composition and passed on the narrow re-run.
- Local gate green on `a336994`: 40 `.mjs` files parse-checked by discovery, 31 helper tests,
  the three typecheck projects, the sanity harness (with the new provenance, stale-stop,
  picker-closed, preview-label, and package-script contracts), and `npm pack --dry-run`.
- Live eight-preset ChatGPT proof accepted on `a336994`, with the runner resolving
  `http://127.0.0.1:9333` from the operator's agent-scope config and no `PI_ORACLE_PROOF_RELAY`
  set: `pro_standard` `49b3d1ab` 59 s, `pro_extended` `0060b8a7` 57 s, `thinking_light`
  `b6c2543a` 42 s, `thinking_standard` `86cda5cd` 42 s, `thinking_extended` `7554cba3` 42 s,
  `thinking_heavy` `98202228` 42 s, `instant` `8b62b8c8` 42 s, `instant_auto_switch` `5c63a273`
  42 s; all eight completed with both markers and neither self-heal path fired.
- Crabbox lanes on `a336994`: macOS `platform-build` PASS (47.7 s) and `real-extension` PASS
  (4.9 s), Ubuntu `platform-build` PASS (36.0 s) and `real-extension` PASS (4.2 s).
  `npm run release:check` then passed as one composition on the same clean tree.
- Published `omp-oracle@0.3.3` from `a336994`. The stored registry token answered 401, so the
  maintainer ran `npm login && npm publish --ignore-scripts` (web login, then the
  `auth-and-writes` approval); as with `0.3.1` and `0.3.2` the composition had just passed on the
  unchanged tree. Registry `gitHead` `a336994ed0f13689619e217807babd506dbca308`, shasum
  `9c64bb95ae22f1c4e50c813021e4284718dffe08`, 81 files, `latest`. Tag `v0.3.3` and the
  [GitHub release](https://github.com/alphastorm/omp-oracle/releases/tag/v0.3.3) name the same
  commit.
- Installed-package job on Oh My Pi 18.2.7, the first in this ledger: after
  `omp plugin uninstall omp-oracle` and `omp plugin install omp-oracle@0.3.3`
  (`~/.omp/plugins/node_modules/omp-oracle`, a real directory), job `14b15fbe` submitted through
  the operator's real configuration completed in 52 s with both markers, and its
  `extensionProvenance` recorded `packageVersion 0.3.3`, the installed path, and no `gitHead`,
  with nothing printed to stderr.
- Pre-commit isolated source-session smokes on the paydown: relay job `d9c98c3d` (`instant`)
  complete in 35 s with both markers, `oracle_read` in a second session returned the now-labeled
  preview, and a fixture-seed job `eeb02d36` on the isolated transport failed cleanly at the
  login wall with warning-free cleanup and no leaked processes.

#### 0.3.2 (2026-09-21, `0e064ea`)

- Two defects with one cause, both found by running real jobs rather than by the gate. ChatGPT
  now labels a freshly streamed assistant turn's action bar `Copy` and only renames it
  `Copy response` once the turn is re-rendered from persistence, so the completion loop's
  `Copy response` count matched no live turn: two independent instrumented jobs sat at
  `copyCount=0` with a stable complete `targetLen=23` for over seven minutes, bound for the
  90-minute completion timeout. Removing that gate then exposed the second defect, which had
  already shipped in `0.3.1`: a job captured a 3-byte response (`ACT`) and recorded
  `collectionStatus: complete` with no gaps, while `oracle_read({ action: "recollect" })` on the
  same binding returned the full 38 bytes.
- Root cause, reproduced deterministically against the live relay after two wrong hypotheses were
  disproved by measurement: stop-control label drift was ruled out (`chatGptStreamingVisible`
  correctly read `Stop answering` throughout a stream) and layout-dependent `innerText` was ruled
  out (the whitespace-squeezed `innerText` and `textContent` lengths were equal, so both reads
  were short). The job-owned pinned relay tab reports `visibilityState: "hidden"`, and Chrome
  gives a hidden tab no rendering opportunities, so ChatGPT stops materializing the streamed
  turn: a tracer watched a turn freeze at 90 characters and stay frozen for 21 s while the stop
  control cleared at the same time, because that control follows the network stream rather than
  the DOM. `Target.activateTarget` and `Page.setWebLifecycleState` both return success and leave
  the tab hidden, so there is no CDP self-heal. A reloaded conversation renders the committed
  turn correctly while hidden, which is why recollection always returned the whole response.
- Remediation is `5b6c220`: generation state is the authority for "finished"
  (`chatGptGenerationActive` prefers the `[data-testid="stop-button"]` reading and falls back to
  the accessibility labels when that test id drifts), the bound turn only has to exist rather
  than expose a particular label, and the streamed read became a lower bound — the worker reloads
  the persisted conversation, polls the re-read to stability, keeps whichever read is longer, and
  logs the recovered characters. Proved by injecting a frozen 30-character streamed read into the
  shipped path: `Recovered 297 character(s) ... (streamed 30, committed 327)`, with the prompt's
  end marker present in the saved response.
- The fix then fired unprompted during the release proof itself: the `instant` job `ca7ac0f1`
  logged `Recovered 11 character(s) the streamed turn had not rendered (streamed 25, committed
  36)`. Without the reconciliation that job would have saved `PRESET instant OK` without
  `PACKAGE omp-oracle`, so the preset proof would have failed on a missing marker.
- Class closure for a defect that nearly shipped inside this fix: `run-job.mjs` is excluded from
  both typecheck projects, so a missing import there fails only at runtime, mid-job, after a
  provider call has been spent — `isConversationPathUrl` was used without being imported and no
  gate saw it. `npm run check:worker-runtime-names` runs TypeScript's `checkJs` pass over the
  worker runtime and rejects unresolved-identifier diagnostics; it reports the remaining 22
  non-fatal type diagnostics without failing on them. Proved red (`Cannot find name
  'isConversationPathUrl'`) and green, and wired into `npm run verify:oracle`.
- Local gate: `npm run verify:oracle` green on the remediation and release-prep states — 31
  helper tests, both typechecks, the new worker runtime name check, the sanity harness, and
  `npm pack --dry-run`.
- Live eight-preset ChatGPT proof against `0e064ea` (`npm run release:proof:chatgpt-presets`
  accepted), routed to the diligence account with `PI_ORACLE_PROOF_RELAY=http://127.0.0.1:9333`:
  `pro_standard` `1bdd024d`, `pro_extended` `c6c277a0`, `thinking_light` `607acedb`,
  `thinking_standard` `3fe1d31c`, `thinking_extended` `aab46e23`, `thinking_heavy` `d53b11a0`,
  `instant` `ca7ac0f1`, `instant_auto_switch` `1523d759`; all eight completed with both markers.
  `thinking_light` first failed once with an unrelated transient (`Could not open model
  configuration UI` at the 45 s open timeout, on a leftover `6 Pro` composer chip, on a code path
  this release does not touch and which passed the same preset in the same order 40 minutes
  earlier); it was rerun alone and the proof file was assembled from that rerun plus the seven
  recorded outcomes. The checker independently revalidates every job directory, package identity,
  git head, and completion time on disk, so no entry is taken on trust.
- Crabbox lanes on `0e064ea`: macOS `platform-build` PASS (54.2 s) and `real-extension` PASS
  (5.1 s), Ubuntu `platform-build` PASS (40.9 s) and `real-extension` PASS (4.5 s).
  `npm run release:check` then passed as one composition on the same clean tree.
- Published `omp-oracle@0.3.2` from `0e064ea`. As with `0.3.1`, npm two-factor authentication
  (`auth-and-writes`) requires an interactive approval, and the composition had just passed on the
  unchanged tree, so the maintainer completed the publish with `npm publish --ignore-scripts` and
  `prepublishOnly` did not re-run inside that invocation. `npm publish --dry-run --ignore-scripts`
  on the same tree reported the published artifact: shasum
  `0caa74b724e98971cbaccd6dcd5c53fca2394b75`, 81 files. Tag `v0.3.2` and the
  [GitHub release](https://github.com/alphastorm/omp-oracle/releases/tag/v0.3.2) name the same
  commit.

#### 0.3.1 (2026-09-21, `5e59527`)

- Model-configuration settle boundary, found by the release gate and reproduced before it was
  fixed: the eight-preset proof against the release-prep commit `11790e9` came back red with
  `thinking_standard` and `thinking_extended` both applying their power stop and then failing
  after the full 20 s settle timeout (`Could not verify requested model settings after
  configuration for thinking`), while `thinking_light` and `thinking_heavy` settled in 0.5 s on
  the same family. The captured failure snapshots name the cause: ChatGPT left the compact
  intelligence menu mounted (`menu "Medium"`, `menu "High"`) with the composer opener already
  reporting `expanded=false` and the composer usable. `COMPACT_INTELLIGENCE_MENU_PATTERN` matches
  a bare tier label, so `snapshotHasModelConfigurationUi` stayed true for the whole deadline and
  the strongly-verified escape at the end of the settle loop is gated on that same predicate; the
  identical clause in `hasCompactIntelligenceMenuContext` separately suppressed the composer-chip
  read, so one root cause produced both symptoms. Remediation is `5e59527`: a single
  `hasOpenCompactIntelligenceMenu` helper used by both predicates, discarding a menu contradicted
  by its own collapsed opener and still treating an opener-less menu as open. Proved red then
  green as a unit test over the two real snapshots (`chatgpt-ui-helpers.test.mjs`, 12 pass/1 fail
  before and 13 pass after), then live: both presets completed with both markers.
- Local gate: `npm run verify:oracle` green on both the release-prep and remediation states —
  30 helper tests, both typechecks, the isolated sanity harness, and `npm pack --dry-run`.
- Live eight-preset ChatGPT proof against `5e59527` (`npm run release:proof:chatgpt-presets`
  accepted): `thinking_standard` `3029a182`, `thinking_extended` `c36539fc`, `pro_standard`
  `ec9c2604`, `pro_extended` `85722ae5`, `thinking_light` `d0deb147`, `thinking_heavy`
  `4112914f`, `instant` `ade29583`, `instant_auto_switch` `30e51906`; all eight completed with
  both markers. `deep_research` is excluded and the exclusion is printed. The run was routed to
  the maintainer's dedicated diligence ChatGPT account by passing
  `PI_ORACLE_PROOF_RELAY=http://127.0.0.1:9333`; the runner's `9224` default would have reached
  the personal browser relay instead. Provider latency was far higher than the 0.3.0 run
  (39 s–6.8 min per job against 42–68 s), entirely in the response phase — model configuration
  stayed under a second in every job.
- Crabbox lanes on `5e59527`: macOS `platform-build` PASS (50.2 s) and `real-extension` PASS
  (4.7 s), Ubuntu `platform-build` PASS (37.2 s) and `real-extension` PASS (4.5 s).
  `npm run release:check` then passed again as one composition inside `prepublishOnly`, on the
  same clean tree, during the first publish attempt; that attempt reached the registry and was
  refused only at npm two-factor authentication (`EOTP`, account mode `auth-and-writes`).
- Published `omp-oracle@0.3.1` from `5e59527`. Because the composition had just passed on the
  unchanged tree and an interactive one-time password would have expired during a second
  ~2.5-minute gate run, the maintainer completed the publish with `npm publish --ignore-scripts`;
  `prepublishOnly` therefore did not re-run inside the successful invocation. `npm publish
  --dry-run --ignore-scripts` on the same tree reported the artifact that was published: shasum
  `e4630e27ba8f8b755758995d8c63ad2b5f8d0e09`, 81 files, `omp-oracle-0.3.1.tgz`. Tag `v0.3.1` and
  the [GitHub release](https://github.com/alphastorm/omp-oracle/releases/tag/v0.3.1) name the
  same commit.

#### 0.3.0 (2026-09-20, `9f26e9c`)

- Native research export boundary, reproduced before it was fixed: against an owned headless
  Chromium (`node scripts/oracle-capture-proof.mjs`), a sandboxed cross-origin report frame whose
  Export → Export to Markdown menu delegates the download to the host page made the in-frame
  byte hook fail with `Native control did not expose downloadable bytes.` while Chrome itself
  wrote the export; the pre-armed collector (`Page.downloadWillBegin`/`downloadProgress` plus the
  object-URL registry) then recovered bytes identical to the file Chrome saved, bound to the tab's
  main frame. A probe on the maintainer's real Chrome 153 through the OMP relay confirmed the
  transport: `Browser.setDownloadBehavior` is not routed (`-32601`), `Page` download events are
  forwarded for both the page and the OOPIF session, and a 74-byte probe export was collected
  identical to the saved file (removed afterwards by exact path and content hash).
- One authorized collection-only tracer on a previously completed Deep Research job (private
  diligence run; identifiers withheld) recollected the report's native Markdown export: 36,995
  bytes, SHA-256 equal to the operator's earlier manual export, `blob` source from the host main
  frame, validated and stored under `artifacts/`, `collectionStatus: complete` with no gaps, tab
  closed with no cleanup warnings. The first two attempts exposed and fixed, with regressions: an
  extension poller in another session terminating the recollecting worker as a stale terminal
  cleanup worker (predecessor `lastCleanupAt` outranking the fresh heartbeat), and
  `agent-browser close` returning while its daemon still served a same-name `open` (orphan tab,
  then `Connection refused`).
- Focused cross-family review of the candidate (`review-daybreak-blue`, lead Claude; subject
  `54460e8`): nine findings, all lead-verified and dispositioned — eight mitigated with executable
  regressions and one partially mitigated/accepted (identity-less positional roots still bind by
  content hash and are refused at recollection). Remediation is `9f26e9c`.
- Local gate: `npm run verify:oracle` green on the feature, release-prep, and remediation
  states; the helper suite includes the fake-relay collector tests and the sanity harness the
  live-recollection reconcile case.
- Isolated loaded-extension smokes through `omp --standard … --no-extensions -e` with a local
  model: whole-repo archive exclusions (job `a9d41f6e`, `.pi/`, `.oracle-context/`, `.cursor/`,
  `.scratchpad.md`, `.artifacts/` excluded, README present; isolated worker failed cleanly on
  auth), symlink escape rejection (no job created), and `oracle_read({ action: "recollect" })`
  on the completed instant canary `b5dca6b9` (complete in 4 s, provenance restored). Agent
  feedback led to the `collection-binding:` summary line; the `touch`-only seed marker in the
  test plan was found to be rejected at submit time and corrected to a timestamped marker.
- Live eight-preset ChatGPT proof against `9f26e9c` (`npm run release:proof:chatgpt-presets`
  accepted): `instant` `e0d780a8`, `instant_auto_switch` `577ecd41`, `thinking_light`
  `b310013c`, `thinking_standard` `7b038f37`, `thinking_extended` `d887033e`, `thinking_heavy`
  `1a2b9d1f`, `pro_standard` `05775d87`, `pro_extended` `f7d1e39a`; all eight completed with
  both markers in 42–68 s. `deep_research` is excluded and the exclusion is printed.
- Crabbox lanes on `9f26e9c`: macOS `platform-build` PASS (52.6 s) and `real-extension` PASS,
  Ubuntu `platform-build` PASS (37.8 s) and `real-extension` PASS; `npm run release:check` passed
  as one composition, and again inside `prepublishOnly` during the publish.
- Published `omp-oracle@0.3.0` from `9f26e9c` (registry `gitHead` matches): shasum
  `25fd2d0ccd7e16256b86c5904976ac71ca51227a`, 81 files, dist-tag `latest`; tag `v0.3.0` and the
  [GitHub release](https://github.com/alphastorm/omp-oracle/releases/tag/v0.3.0) name the same
  commit. A fresh `npm pack omp-oracle@0.3.0` reproduces the shasum and carries
  `worker/response-capture.mjs` and `shared/relay-cdp-client.mjs`; the repository-only proof
  scripts are not shipped.

#### 0.2.0 (2026-09-20, `6401cfc`)

- Deep Research acceptance through the fork's build and the relay transport: job
  `00f41969-f0ab-458d-a348-0124ad75465a` enabled and verified the composer tool, armed frame
  capture, attached the widget frame, held heartbeats across the research phase, and completed
  with a 13,550-character report in 5 minutes; after the two-counter header fix, job
  `4dc1d412-8f3f-4ca6-8434-25f60100bac6` completed with a clean body in 4m20s. Earlier attempts
  recorded each designed failure with its own code: `deep_research_toggle_not_found`,
  `deep_research_clarification_requested`, `deep_research_report_unreadable`. Spike captures:
  `.artifacts/deep-research-spike-2026-09-20/`.
- CDP frame capture works through the unmodified OMP 18.2.6 relay; no relay change was needed.
  The earlier "relay cannot expose frames" reading came from arming `Target.setAutoAttach` after
  the frame already existed, and from reading the OOPIF shell instead of its same-origin child.
- Live eight-preset ChatGPT proof re-run against `6401cfc` (`npm run release:proof:chatgpt-presets`
  accepted): `instant` `2cd01096`, `instant_auto_switch` `1cb07f93`, `thinking_light` `f0724ffc`,
  `thinking_standard` `603c27cf`, `thinking_extended` `76710d74`, `thinking_heavy` `8a1a5286`,
  `pro_standard` `438e5f62`, `pro_extended` `e5ff58c9`; all eight completed with both markers.
  `deep_research` is excluded and the exclusion is printed.
- `npm run release:check` passed as one composition on `6401cfc` (local gate, preset proof, macOS
  and Ubuntu Crabbox lanes), and again inside `prepublishOnly` during the publish.
- Published `omp-oracle@0.2.0` from `6401cfc`: shasum
  `93d61ccecbcf527456a4f884cc1d6e5857ea72ca`, 78 files; tag `v0.2.0` and the
  [GitHub release](https://github.com/alphastorm/omp-oracle/releases/tag/v0.2.0) name the same
  commit. A fresh `npm install omp-oracle@0.2.0` carries the `deep_research` preset and
  `shared/relay-cdp-client.mjs`.

#### 0.1.0 (2026-09-20, `85adab1`)

- Local gate: `npm run verify:oracle` green on macOS (Node 26) and inside `cimg/node:24.16`
  (Node 24.16.0); the same gate passed on the first hosted CI run.
- Packed install through pi 0.80.9 on macOS: `npm run smoke:real:packed` installed
  `./node_modules/omp-oracle` via `pi install -l --approve`, `pi list` showed the packed path, and
  `/oracle-status` executed through the installed package (`.artifacts/real-smoke/run-1789870710142-vyc342`).
- Ubuntu Crabbox lane: `platform-build` PASS (`run-1789871615787-33if6p`, packed tarball installed
  from `node_modules/.bin/pi` inside the container, `pi list` showed `node_modules/omp-oracle`) and
  `real-extension` PASS (`run-1789871654549-uee638`) against `omp-oracle-platform-smoke:node24`.
- OMP 18.2.6: `omp install --dry-run .` resolves the checkout as `omp-oracle`.
- Live ChatGPT tracer through the fork's build and the relay transport (2026-09-20): job
  `020385c2-773f-4130-a469-30edcec17579` failed at `configuring_model` on the slider-based
  composer (`Could not find model family control for instant`); after the slider driver landed,
  job `9d4012f3-e48b-45c7-93c6-66822b3fdd29` set `Instant (1 of 5)`, uploaded, and completed with
  both response markers in 40 s. Diagnostics: `.artifacts/ui-drift-2026-09-20/`.
- Live eight-preset ChatGPT proof through the fork's build and the relay transport (2026-09-20,
  `npm run release:proof:chatgpt-presets` accepted): `pro_standard` `61006224`, `pro_extended`
  `d6b3b72a`, `thinking_light` `92c9871f`, `thinking_standard` `4afd8411`, `thinking_extended`
  `9115eb5e`, `thinking_heavy` `7332f139`, `instant` `7b941e0c`, `instant_auto_switch`
  `d3605d00`; every job completed with `PRESET <preset> OK` and `PACKAGE omp-oracle`, Pro
  presets on the single `Pro` stop. The proof is re-run against the release commit before
  publishing, because the checker binds jobs to the current HEAD.
- macOS Crabbox lane (SSH to localhost, 2026-09-20): `platform-build` PASS
  (`run-1789875191134-adr3y0`) and `real-extension` PASS (`run-1789875241370-75h0od`); the full
  `npm run release:check` then passed as one composition on `85adab1`, and again inside
  `prepublishOnly` during the publish. The Windows native lane is not release-required for the
  fork.
- Published `omp-oracle@0.1.0` on 2026-09-20 from `85adab1`: shasum
  `943f969b35348963f105b7d46dd33d08b4fc99d3`, 76 files; tag `v0.1.0` and the
  [GitHub release](https://github.com/alphastorm/omp-oracle/releases/tag/v0.1.0) point at the same
  commit, and `omp install --dry-run omp-oracle` resolves it from the registry.

### Carried upstream evidence

The entries below are carried from the upstream `pi-oracle` design document. They were recorded
against the upstream package identity and the Pi baseline named in each entry, on the upstream
maintainer's machines. What has been observed on Oh My Pi is recorded in
[Compatibility](COMPATIBILITY.md#hosts).

### Current implementation status

Implemented in code for the pivot and concurrency redesign:

- config now uses `browser.*` + `auth.*`
- `/oracle-auth` now syncs real-Chrome ChatGPT cookies into the authenticated seed profile instead of opening a manual-login browser
- `oracle_submit` supports follow-ups via persisted `chatUrl`
- job state no longer stores CDP verification fields
- workers now run with per-job runtime sessions and per-job runtime profile clones
- runtime admission is controlled by runtime leases and `browser.maxConcurrentJobs`
- queued jobs are workerless and do not consume runtime or conversation leases until promotion
- follow-up jobs now acquire conversation leases
- persisted job state now records explicit lifecycle phases instead of relying only on coarse statuses
- poller notifications now use per-job notification claims rather than broad global scan serialization
- worker now uses a structured ChatGPT page-state classifier
- worker now downloads artifacts directly with `agent-browser download <ref> <dest>`
- poller scans are now best-effort/non-fatal with per-session in-flight guards
- worker heartbeats during artifact downloads, writes artifact manifests incrementally, and reopens the saved conversation before artifact capture/download
- artifact-only responses are treated as valid completion content
- the repo now includes a repeatable sanity harness: `npm run sanity:oracle`
- the repo now includes a safe expired-auth recovery drill: [`docs/TEST_PLAN.md`](TEST_PLAN.md)
- worker closes the isolated browser, removes the runtime profile, and releases leases in `finally`

Retained from the earlier MVP:

- `/oracle`, `/oracle-followup`, `/oracle-read`, `/oracle-status`, `/oracle-cancel`, `/oracle-clean`
- `oracle_auth`, `oracle_submit`, `oracle_read`, `oracle_cancel`
- detached background worker model
- `${PI_ORACLE_JOBS_DIR:-/tmp}/oracle-<job-id>/...` state layout
- shell-safe archive creation using tar streams: `zstd` compression for ChatGPT and gzip compression for Grok
- private permissions and atomic writes
- stale-worker reconciliation
- upload ordering: attach → confirm → fill → send
- current-turn response anchoring
- plain-text canonical response extraction
- wake-the-agent poller integration
- unique archive filenames per job
- worker PID identity checks using recorded process start time
- composer-scoped upload confirmation
- stable `chatUrl` capture after send
- redacted `oracle_read` details and same-project job scoping
- serialized poller scans

### Live validation status

Live-validated after the concurrency redesign:

- `/oracle-auth` happy path still works against the seed profile
- headless normal oracle runs still work using per-job runtime clones
- two concurrent runs in different projects work with isolated runtimes
- two concurrent runs in the same project but different `pi` sessions work when they target different conversations
- same-conversation concurrent follow-up rejection works and fails fast with a clear lease error
- runtime profile cleanup works on completion and cancellation
- runtime/conversation lease cleanup works on completion and cancellation
- global browser args overrides (for example `--disable-gpu`) apply to real jobs
- artifact-producing runs work with direct `download <ref> <dest>`
- multi-artifact runs complete, target the correct `pi` session, and persist both downloaded files with correct contents
- the poller no longer needs the worker to stay alive just to observe completion for artifact-producing runs
- expired/missing auth now fails as a clean auth-related error instead of generic UI/config drift
- `/oracle-auth` repairs the seed profile and a post-repair probe succeeds again
- live auth recovery also exposed and corrected a real source-profile misconfiguration during validation; the configured browser profile must actually contain the active ChatGPT session cookies

### Known remaining work

Still to verify live after this pivot:

- full ChatGPT preset release matrix evidence must be refreshed before any release; `npm run release:proof:chatgpt-presets` blocks release without one completed loaded-extension ChatGPT job for every canonical preset
- optional richer terminal semantics for partial artifact failure (`complete_with_artifact_errors`) in more live scenarios

### Production readiness criteria

This architecture is now live-validated for the core release path:

- no interaction with the user’s real Chrome during normal jobs
- no focus disruption during normal jobs
- the seed profile survives browser restarts and can be cloned into runtime profiles repeatedly
- different projects / sessions can run in parallel without co-mingled data
- same-conversation follow-ups are rejected while another job owns that conversation lease
- artifact capture works without `chrome://downloads`
- artifact-only responses and multi-artifact responses both complete correctly
- same-thread follow-ups reopen correctly from persisted `chatUrl`
- failure modes are clearly classified as auth / challenge / outage / UI drift
- expired/missing auth now fails cleanly, `/oracle-auth` repairs the seed profile, and the post-repair probe succeeds again

#### Current readiness summary

Current release blockers for the validated scope:
- release is blocked until fresh loaded-extension ChatGPT preset proof passes `npm run release:proof:chatgpt-presets` for every canonical `ORACLE_SUBMIT_PRESETS` id

Remaining non-blocking hardening work:
- broaden live proof of the new lifecycle/state-machine model across more degraded paths
- broaden live proof of notification-claim semantics under more concurrent completions
- extend regression-harness coverage for browser/download failure classes
- polish partial-artifact terminal semantics (`complete_with_artifact_errors`)
- keep hardening model-selection verification against future ChatGPT UI variation

Recent proof points:
- Pi 0.80.7 local gate: `npm run verify:oracle` passed on 2026-07-14, including syntax/bundle checks, both typechecks, the isolated sanity harness, and `npm pack --dry-run`
- Pi 0.80.7 safe loader smokes: `.artifacts/real-smoke/run-1784068526377-67yb2l` passed source loading, and `.artifacts/real-smoke/run-1784068527234-t2a5xm` passed packed-install loading through the real Pi CLI; both executed `/oracle-status` without creating an external oracle job or requiring provider credentials
- Pi 0.80.6 local gate: `npm run verify:oracle` passed three consecutive runs on 2026-07-11; each run completed syntax/bundle checks, both typechecks, the isolated sanity harness, and `npm pack --dry-run` without an `ENOTEMPTY` cleanup failure
- Pi 0.80.6 safe loader smokes: `.artifacts/real-smoke/run-1783810473367-cn72at` passed source loading, and `.artifacts/real-smoke/run-1783810475290-hj0pfs` passed packed-install loading through the real Pi CLI; both recorded `pi --version` as 0.80.6 and executed `/oracle-status` without creating an external oracle job or requiring provider credentials
- Pi 0.80.2 local gate: `npm run verify:oracle` passed on 2026-06-24 after the JSON command output, prompt-manifest, schema, and lazy Chrome-probe audit fixes
- Pi 0.80.2 isolated extension smokes: `.artifacts/real-smoke/run-1782321054924-jnq0x3` passed source proof, and `.artifacts/real-smoke/run-1782321056224-yuq5a2` passed packed-install proof
- Pi 0.80.2 JSON command smoke: `pi --no-extensions -e ./extensions/oracle/index.ts --mode json --no-session --no-approve "/oracle-status"` emitted displayed `oracle-command-output` JSON events
- Pi 0.79.10 local gate: `npm run verify:oracle` passed on 2026-06-22 after the 0.79.10 baseline refresh and `CONFIG_DIR_NAME` cleanup
- Pi 0.79.10 isolated extension smokes: `.artifacts/real-smoke/run-1782137209549-0xe67z` passed packed-install proof, and `.artifacts/real-smoke/run-1782137217821-95a1po` passed source model-agent proof
- Pi 0.79.10 platform artifacts: `.artifacts/platform-smoke/run-1782137574391-7lay68` (macOS platform-build), `.artifacts/platform-smoke/run-1782137619352-gku7jz` (macOS real-extension), `.artifacts/platform-smoke/run-1782137587082-d7kg4p` (Ubuntu platform-build), `.artifacts/platform-smoke/run-1782137619176-lgxezy` (Ubuntu real-extension), `.artifacts/platform-smoke/run-1782137625964-66z0oc` (Windows native platform-build), `.artifacts/platform-smoke/run-1782137752969-pbmdj1` (Windows native real-extension)
- Pi 0.79.10 isolated agent feedback: `.artifacts/isolated-agent-feedback/run-1782137385` confirmed local extension loading and useful `oracle_preflight` output after the path-label polish
- Pi 0.79.1 release gate: `npm run release:check` passed on 2026-06-11 after the project-trust, prompt-history, ChatGPT selector, and send-acceptance updates, including `verify:oracle` plus Crabbox macOS, Ubuntu, and Windows native `platform-build` and `real-extension` suites
- Pi 0.79.1 platform artifacts: `.artifacts/platform-smoke/run-1781196218405-311wzs` (macOS platform-build), `.artifacts/platform-smoke/run-1781196261807-eb0391` (macOS real-extension), `.artifacts/platform-smoke/run-1781196230636-ze1hai` (Ubuntu platform-build), `.artifacts/platform-smoke/run-1781196265638-kxiwh9` (Ubuntu real-extension), `.artifacts/platform-smoke/run-1781196255488-ucuf35` (Windows native platform-build), `.artifacts/platform-smoke/run-1781196369098-4qlzjs` (Windows native real-extension)
- Pi 0.79.1 live source-extension send-acceptance smoke: new-chat job `4b98776f-d422-4bfb-8a6a-7aef73c31bf6` reached `https://chatgpt.com/c/6a2ac99d-fc5c-83e8-88d7-5e1e8f427499` and completed; same-thread follow-up job `abb4f590-96a1-4aab-b91a-c0a7cc15a162` completed on the unchanged conversation URL after send-acceptance evidence
- Pi 0.79.0 release gate: `npm run release:check` passed on 2026-06-08, including `verify:oracle` plus Crabbox macOS, Ubuntu, and Windows native `platform-build` and `real-extension` suites
- Pi 0.79.0 platform artifacts: `.artifacts/platform-smoke/run-1780938522145-50q2f2` (macOS platform-build), `.artifacts/platform-smoke/run-1780938572090-bi87g5` (macOS real-extension), `.artifacts/platform-smoke/run-1780938542847-quridb` (Ubuntu platform-build), `.artifacts/platform-smoke/run-1780938587248-c8uo4c` (Ubuntu real-extension), `.artifacts/platform-smoke/run-1780938585007-l0xapp` (Windows native platform-build), `.artifacts/platform-smoke/run-1780938820527-c1j8tt` (Windows native real-extension)
- Pi 0.79.0 isolated local-extension model-agent smoke: `.artifacts/real-smoke/run-1780935835596-pfbn5o` passed with `PI_ORACLE_REAL_TEST_MODEL_AGENT=1 npm run smoke:real:source`
- Pi 0.79.0 packed-install smoke: `.artifacts/real-smoke/run-1780935825537-pmna07` passed with `npm run smoke:real:packed`
- expired-auth drill fail path: `a2460bc1-7d89-4041-b67d-39680d310325`
- `/oracle-auth` repair evidence: the per-run `/tmp/pi-oracle-auth-*/oracle-auth.log` bundle path printed by `/oracle-auth`
- expired-auth drill post-repair success: `fa26a2a7-0057-4a21-b3e0-71c1d020facf`
- successful multi-artifact completion: `b6b3599c-6b91-4315-adfa-8a83aa5eda9b`
- repo-owned sanity harness: `npm run sanity:oracle`
- real installed-extension smoke source of truth: `scripts/oracle-real-smoke.mjs`; required release proof runs packed-install mode (`npm run smoke:real:packed`), asserts Pi 0.80.9, and executes `/oracle-status` through Pi's installed-package loader without provider credentials or an external oracle job; optional slower model-agent submission debugging remains behind `PI_ORACLE_REAL_TEST_MODEL_AGENT=1`; source mode (`npm run smoke:real:source`) is inner-loop/debug only
- macOS, Ubuntu, and Windows native package/build/runtime smoke source of truth: [`docs/PLATFORM_SMOKE.md`](PLATFORM_SMOKE.md); use `npm run verify:oracle` for everyday local iteration, `npm run smoke:platform:doctor` plus a focused target/suite run for platform-sensitive changes, `npm run smoke:platform:all` for doctor-first platform matrix evidence, and `npm run release:check` for the full local-plus-platform release gate
- release gate: `npm run release:check`, also used by `prepublishOnly`, combines static verification, fresh loaded-extension ChatGPT preset proof via `npm run release:proof:chatgpt-presets`, and all required Crabbox platform smokes
