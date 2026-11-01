# Contributing

`omp-oracle` is developed in public. Issues and pull requests are welcome when behavior claims come
with verification evidence from the local gate and an isolated session.

## Before you start

- Check open issues and pull requests to keep each change scoped to one problem.
- Read [Architecture](docs/ARCHITECTURE.md) for component ownership and invariants, and
  [Upstream](docs/UPSTREAM.md) for what belongs to this Oh My Pi ("OMP") fork versus upstream
  [`fitchmultz/pi-oracle`](https://github.com/fitchmultz/pi-oracle). Fixes that are not
  OMP-specific may belong upstream.
- Install dependencies on Node 24+ and run the local gate before and after your change:

```bash
npm ci
npm run verify:oracle
```

## What a change needs

Run the validation that matches the surface you changed, and record the evidence in your pull
request. For the full validation ladder, see [Test plan](docs/TEST_PLAN.md#which-check-to-run).

| Change type | Required validation |
| --- | --- |
| Docs-only | `npm run verify:oracle`, which runs the documentation link check (`npm run test:docs`) and the sanity harness's pinned documentation literals (`scripts/oracle-sanity.ts`). |
| Runtime or extension code | `npm run verify:oracle` plus an isolated local-extension session using the `instant` or `thinking_light` preset per [Isolated `pi` session smoke](docs/TEST_PLAN.md#isolated-pi-session-smoke), asking the exercised agent for friction feedback. |
| Platform-sensitive (archive packing, process cleanup, runtime or browser profile handling, package metadata, Crabbox harness) | `npm run smoke:platform:doctor` and a focused Crabbox run (`node scripts/platform-smoke.mjs run --target <target> --suite <suite>`); see [Platform smoke](docs/PLATFORM_SMOKE.md). |
| Model-selection or ChatGPT UI | Live loaded-extension proof across the eight canonical model presets (`npm run release:proof:chatgpt-presets:run` and `npm run release:proof:chatgpt-presets`); see [Release](docs/RELEASE.md#chatgpt-preset-proof). |
| Brand artwork (`assets/*.html`) | `npm run render:assets` and `npm run render:assets -- --check`; see [Branding](docs/BRANDING.md). |

`npm run verify:oracle` (`npm test` is an alias) runs syntax and bundle checks
(`check:oracle-extension`), platform-smoke invariants (`check:platform-smoke`), helper unit tests
(`test:oracle-helpers`), the site coherence test (`test:site`), the documentation link check
(`test:docs`), the three typecheck projects (`typecheck`, `typecheck:worker-helpers`,
`typecheck:worker-runtime`), the sanity harness (`sanity:oracle`), and `npm pack --dry-run`.

## Documentation changes

- Pinned literals in `scripts/oracle-sanity.ts` (`README.md`, `docs/ARCHITECTURE.md`,
  `docs/OPERATIONS.md`, and `docs/TEST_PLAN.md`) must stay verbatim. If you change a command,
  tool, limit, or preset, update `README.md` and the relevant `docs/` page in the same change.
- Headings and explicit HTML anchors that other documentation pages or the public site link must
  keep their text. `npm run test:docs` (`scripts/docs-links.test.mjs`) verifies that every
  relative link, heading fragment, and repository URL resolves.
- The dated entries in the [Release](docs/RELEASE.md#evidence-ledger) evidence ledger are
  historical records and are never edited after publication.
- Add an entry under `Unreleased` in [Changelog](CHANGELOG.md) for every change.

## Repository layout

| Path | Purpose |
| --- | --- |
| [`extensions/oracle/index.ts`](extensions/oracle/index.ts) | Extension entrypoint and OMP programmatic bridge |
| `extensions/oracle/lib/` | Commands, tools, config, jobs, queueing, runtime, poller |
| `extensions/oracle/worker/` | Detached provider web worker, auth bootstrap, relay driver, UI helpers |
| `extensions/oracle/shared/` | Shared process, state, job, and observability helpers |
| [`prompts/oracle.md`](prompts/oracle.md) | Hidden `/oracle` command-dispatch workflow |
| [`prompts/oracle-followup.md`](prompts/oracle-followup.md) | Hidden `/oracle-followup` command-dispatch workflow |
| `scripts/oracle-sanity*` | Local sanity harness, including documentation contracts |
| `scripts/platform-smoke*` | Crabbox macOS, Ubuntu, and Windows release smoke gate |
| `site/` | Public website source; the Pages deploy stages its mark, favicon, and social preview from `assets/` |
| `assets/` | Brand mark, favicon, and the banner and social-preview sources with their renders ([Branding](docs/BRANDING.md)) |
| `docs/` | [Documentation](docs/README.md) index, [Architecture](docs/ARCHITECTURE.md), [Security model](docs/SECURITY.md), [Compatibility](docs/COMPATIBILITY.md), [Operations](docs/OPERATIONS.md), [Test plan](docs/TEST_PLAN.md), [Platform smoke](docs/PLATFORM_SMOKE.md), [Release](docs/RELEASE.md), [Upstream](docs/UPSTREAM.md), [Branding](docs/BRANDING.md) |

## Naming and identifiers

- The npm package is `omp-oracle` (display name **OMP Oracle**). `pi-oracle` on npm is the
  upstream package; never present it as an install path for this fork.
- Runtime identifiers keep their upstream names (`/oracle*` commands, `oracle_*` tools,
  `PI_ORACLE_*` environment variables, `/tmp/pi-oracle-state`, `/tmp/pi-oracle-auth-*`, and the
  `omp.pi-oracle.programmatic.v1` bridge symbol); do not rename them.
- Refer to the maintainer organization as `alphastorm`, matching the GitHub handle.

## Commits

Write commit messages in [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/)
format: `type(scope): description`, lowercase imperative.

## Releases

A release passes `npm run release:check` locally: the local gate, the offline capture proof,
the fresh ChatGPT preset proof, then the Crabbox matrix. The capture proof requires Chrome or
Chromium (auto-detected, or selected with `CHROME_BIN`); it uses only an isolated browser and
synthetic pages, never an account. Pushing the `vX.Y.Z` tag then publishes it to npm from GitHub
Actions through trusted publishing. See [Release](docs/RELEASE.md) for the release gate, preset
proof, [publishing](docs/RELEASE.md#publishing), and evidence ledger.

## Security

Report vulnerabilities privately per [Security policy](SECURITY.md).
