# Upstream

**OMP Oracle** (`omp-oracle`) is the Oh My Pi ("OMP") fork of
[`fitchmultz/pi-oracle`](https://github.com/fitchmultz/pi-oracle), the `pi` extension that sends
long-running work to ChatGPT or Grok through the web app. This page records what the fork
preserves, what it changes, and how it tracks upstream.

Companion docs: [Documentation](README.md) · [Architecture](ARCHITECTURE.md) ·
[Compatibility](COMPATIBILITY.md) · [Release](RELEASE.md) · [Changelog](../CHANGELOG.md)

## What is preserved

- **Git history.** The fork branched from upstream `main` at the `upstream-compat-20260918` merge
  and retains every upstream commit.
- **User and agent contracts.** `/oracle`, `/oracle-followup`, `/oracle-auth`, `/oracle-read`,
  `/oracle-status`, `/oracle-cancel`, and `/oracle-clean`; `oracle_preflight`, `oracle_auth`,
  `oracle_submit`, `oracle_read`, and `oracle_cancel`; and the `/oracle` and `/oracle-followup`
  prompt templates.
- **Runtime and state identifiers.** The job layout under
  `${PI_ORACLE_JOBS_DIR:-/tmp}/oracle-<job-id>/`, the `PI_ORACLE_*` environment variables,
  `/tmp/pi-oracle-state`, `/tmp/pi-oracle-auth-*`, and the `omp.pi-oracle.programmatic.v1` bridge
  symbol, so existing configurations, saved jobs, and host integrations keep working.
- **Validation harness.** `npm run verify:oracle`, the sanity harness, the Crabbox platform smoke
  lanes, and the ChatGPT preset proof.
- **License and authorship.** MIT license; Mitch Fultz is credited as a contributor in
  `package.json` and `README.md`.

## What the fork changes

- **Package identity.** Published on npm as `omp-oracle` from `alphastorm/omp-oracle`. Upstream's
  `pi-oracle` package does not carry fork commits and must be uninstalled before installing
  `omp-oracle`.
- **Opt-in shared-Chrome transports for ChatGPT.** Alongside the default isolated seed profile,
  the fork adds the [existing-Chrome relay](ARCHITECTURE.md#existing-chrome-relay-transport)
  (`browser.chatGptRelayEndpoint`) and the
  [managed browser](ARCHITECTURE.md#managed-browser-transport)
  (`browser.chatGptManagedProfileDir`), plus CDP frame capture and download-event native Markdown
  export for Deep Research. Upstream replaced unpinned real-Chrome automation with isolated
  seed-profile clones because tab-switching commands called `Page.bringToFront` and stole focus in
  the user's browser; the fork keeps the isolated seed profile as the default and adds the opt-in
  relay and managed-browser transports by pinning every command to a single job-owned tab without
  activating tabs or scraping `chrome://downloads` (see
  [Design lineage](ARCHITECTURE.md#design-lineage)).
- **Oh My Pi host compatibility.** Node worker launch, project-trust handling on hosts without
  Pi's trust exports, transient ChatGPT 403 classification, and the
  `omp.pi-oracle.programmatic.v1` programmatic bridge.
- **ChatGPT UI and collection hardening.** Shared UI control vocabulary across ChatGPT shell
  revisions (`chatgpt-ui-helpers.mjs`), composer-tool configuration, bound-turn capture
  (`response-capture.mjs`), and non-sending recollection (`oracle_read` with
  `action: "recollect"`).
- **agent-browser 0.39 driver contract.** `/oracle-auth` relaunches only after the driver stops
  listing the previous auth session, the rule job teardown follows, instead of upstream's retry on
  one pre-launch error message, which does not match the error 0.39 reports for that race; and both
  workers run the driver with `AGENT_BROWSER_NO_WEBMCP=1` so page WebMCP announcements never reach
  the text output they parse.
- **Documentation.** Organized by reader role across `README.md` and `docs/`.

Per-release changes are recorded in [Changelog](../CHANGELOG.md).

## Tracking upstream

- **Merge, never rebase.** Shared upstream history stays intact through explicit merge commits,
  never rebases; later changes are selectively ported where the fork's runtime and release gates
  diverge. The latest recorded sync is upstream `eecf79e` (2026-10-31, `pi-oracle` 0.7.23).
  - `5c31b3d` ([#68](https://github.com/fitchmultz/pi-oracle/pull/68)): ported case-insensitive
    bare-effort opener recognition, including removable chips, through `BARE_EFFORT_PATTERN`,
    and assistant headings marked `data-conversation-role="assistant"` through shared turn
    observation, capture, and archive-turn exclusion, each with red-before regression tests.
    Already covered: the shared `matchesModelConfigurationOpener` and its declaration, generic
    `Model` / `Model selector` and `Select ChatGPT model` buttons, compact Intelligence openers,
    model and effort chips, `Send` / `Send prompt` throughout upload/send readiness and DOM
    activation, and `Stop` throughout send acceptance and completion. The fork's bound-turn
    existence and rendered-generation checks already complete replies without `Copy response`,
    so upstream's `data-talvt-turn-state="complete"` fallback adds no missing completion path.
    The broader family-prefix opener is not adopted: the fork deliberately rejects `Pro feedback`
    and similar response actions while accepting numbered composer chips. The five-stop slider
    with picker reopen, stale-stop reload, one-per-job missing-turn reload, and timed-out
    recollection are unchanged; upstream's release metadata, documentation layout, and unpinned
    Ubuntu tool installs do not replace the fork's versions, docs, or pinned tooling.
  - `ab82bd9` ([#69](https://github.com/fitchmultz/pi-oracle/pull/69)): reviewed, not adopted;
    retained-candidate transfer/checksums and native Windows SSH qualification serve upstream's
    release pipeline, while the fork's Crabbox macOS/Ubuntu lanes and
    `.github/workflows/release.yml` trusted publishing cover its release gate.
  - `9141302` ([#70](https://github.com/fitchmultz/pi-oracle/pull/70)): reviewed, not adopted;
    target-specific preflight, custom macOS SSH ports, and native-host shell portability support
    split qualification rather than the fork's doctor-first macOS/Ubuntu release gate and
    `.github/workflows/release.yml` trusted publishing. The `invariants.mjs` / `doctor.mjs`
    changes add no missing fix for the fork's required lanes: provider and Windows-template
    checks are already conditional, both required targets run together, and preflight runs on a
    POSIX host rather than native Windows.
  - `eecf79e` ([#71](https://github.com/fitchmultz/pi-oracle/pull/71)): reviewed, not adopted;
    the hosted-platform qualification workflow and `ci-release-hosted.sh` /
    `ci-release-windows.ps1` duplicate the fork-owned Crabbox macOS/Ubuntu release proof and
    `.github/workflows/release.yml` trusted publishing with a different automation contract.

  The preceding sync, upstream `d658a98` (2026-10-17, `pi-oracle` 0.7.22), ported the runtime
  fixes the fork shares: anonymous `ua-*` visitor sessions classified as signed out,
  `/oracle-auth` reads retried across CDP navigation with failure guidance that separates browser
  verification from rejected cookies, the `/oracle-auth` launch retry for a closing
  `agent-browser` daemon, and a `before_agent_start` guard for prompt-less custom-message turns on
  newer `pi` hosts; and the test-audit repairs (false-green assertions replaced by behavioral proof,
  the `loadConfigFn` test seam removed, npm 12 `npm pack --json` parsing, `ENOTEMPTY` cleanup
  retries). Not adopted: the native Linux Chromium v11 cookie importer (Linux Chromium users keep
  the documented safe-storage password override), the Pi 1.x development baseline and its
  shrinkwrapped dependency graph, the README and docs reorganization, npm auto-publish CI, the
  Ubuntu image bump, and the shared compatibility fleet; upstream's composer-label, Power-slider,
  and jobs-directory fixes were already covered by the fork. Re-checked on 2026-10-20, with upstream
  `main` still at `d658a98`: the fork has since moved to its own Pi 1.3 development baseline
  (`^1.3.0`, without upstream's pinned 1.0.0 and shrinkwrap; its `before_agent_start` guard now
  matches upstream's `"prompt" in event` form), has its own trusted-publishing release workflow in
  place of upstream's auto-publish CI, and reads Linux Chromium `v11` cookies through
  `@steipete/sweet-cookie` 0.4.4, which closes the gap upstream's native importer filled. The
  earlier sync, upstream
  `4d96ffc` (2026-09-22), imported cancellation-race and protected-profile test improvements plus
  a native Pi status smoke while keeping runtime code, package identity, CI, and release gates
  fork-owned.
- **Release tags and version numbering.** Upstream's `v0.1.0`–`v0.7.20` tags remain in
  `fitchmultz/pi-oracle`. The fork's `v*` tags and npm versions restarted at `0.1.0` (based on
  upstream `0.7.20`), and [Changelog](../CHANGELOG.md) records the upstream base above the
  preserved upstream history divider.
- **Post-merge verification.** Every upstream merge must pass `npm run verify:oracle`; merges that
  touch archive packing, process cleanup, runtime or browser profile handling, package metadata,
  or the Crabbox harness also require the platform runs in
  [`docs/PLATFORM_SMOKE.md`](PLATFORM_SMOKE.md).
- **Upstream contributions.** Fixes that are not specific to Oh My Pi are candidates for upstream
  pull requests; the relay transport, managed browser, and OMP programmatic bridge remain
  fork-owned unless upstream requests them.

Community project; not affiliated with or endorsed by the Oh My Pi maintainers, the `pi-oracle`
maintainer, OpenAI, or xAI.
