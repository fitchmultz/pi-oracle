# OMP Oracle compatibility

Use this page to verify whether your host, operating system, runtime, browser, and provider
transport are supported by `omp-oracle` (`0.4.11` on npm; the GitHub URL tracks `main`).

Companion docs: [Operations](OPERATIONS.md) · [Release](RELEASE.md) · [Test plan](TEST_PLAN.md)

## Reading this page

| Status | Meaning |
| --- | --- |
| **Declared** | Package metadata allows it; not exercised by this fork |
| **Validated upstream** | Exercised by upstream `pi-oracle` release gates |
| **Observed** | Exercised by this fork and recorded in the [release ledger](RELEASE.md#evidence-ledger) |
| **Required by the release gate** | The fork's release gate fails without it |

## Hosts

| Host | Status | Evidence |
| --- | --- | --- |
| `pi` 1.3.0 (baseline) | **Observed**; **required by the release gate** | The local gate (the three typechecks, the sanity harness, and the native `pi` status smoke) and the Crabbox `real-extension` lanes run against the `pi` development baseline (`devDependencies` `^1.3.0`); first recorded for `0.4.7` in the [release ledger](RELEASE.md#evidence-ledger) |
| `pi` 0.80.9 | **Validated upstream**; **Observed** through `0.4.6` | Upstream `pi-oracle` 0.7.19 and 0.7.20 release gates and the fork's release gate through `0.4.6` ran against `pi` 0.80.9; entries in the [release ledger](RELEASE.md#evidence-ledger) |
| Other `pi` versions | **Declared** | `@earendil-works/pi-ai`, `@earendil-works/pi-coding-agent`, and `typebox` are optional wildcard peers, so npm does not block other host releases |
| Oh My Pi | **Observed**; **required by the release gate** | Exercised through source-loaded isolated Oh My Pi print-mode sessions (`omp … --no-extensions -e`, see the [release runner](RELEASE.md#chatgpt-preset-proof)) for the eight-preset ChatGPT release proof, through a registry-installed package job recorded per release in the [release ledger](RELEASE.md#fork-evidence-omp-oracle) (recorded on Oh My Pi 18.2.6, 18.2.7, 18.2.11, 18.12.3, 18.12.6, 18.13.3, and 18.14.1), and with `omp install --dry-run` resolving this checkout as `omp-oracle` |
| Oh My Pi hosts without Pi's trust exports | **Observed** (unit test) | Supported by design: `scripts/oracle-host-compat.test.mjs` links the config loader against a host API without `hasTrustRequiringProjectResources` or `ProjectTrustStore`; project overrides then require an explicit host trust decision |

A persisted session is required on every host. `--no-session` runs report oracle unavailable.

## Platforms and runtime

| Requirement | Value |
| --- | --- |
| Operating systems | macOS and Ubuntu Linux (**required by the release gate**); Windows native (**declared** in `package.json` `os`, **validated upstream** at `pi-oracle` 0.7.20, and not re-qualified by the fork because the fork has no Windows validation environment) |
| Node.js | `>=22.19.0` to install and run (**declared** in `engines`); Node 24+ **required by the release gate** (`platform-smoke.config.mjs`) |
| Browser | Google Chrome, Chromium, or another Chromium-family browser |
| Local tools | `agent-browser` (0.35.0 or newer for relay mode) and `tar`; `zstd` for ChatGPT `.tar.zst` archives; `cp` on `PATH` or `PI_ORACLE_CP_PATH` for macOS APFS clone mode; Linux encrypted cookies may need `secret-tool` (GNOME) or `kwallet-query` + `dbus-send` (KDE) unless a safe-storage password override is set |
| Profile copies | macOS uses APFS clones (`cp -cR`); Linux and Windows use Node's recursive copy |

## Providers

| Provider | Selection | Archive format | Upload ceiling | Transports | Status |
| --- | --- | --- | --- | --- | --- |
| ChatGPT model presets | `preset`: `pro_standard`, `pro_extended`, `thinking_light`, `thinking_standard`, `thinking_extended`, `thinking_heavy`, `instant`, `instant_auto_switch` (`ORACLE_SUBMIT_PRESETS`; human-readable labels are normalized) | `.tar.zst` | 250 MiB | Isolated seed profile (default), [existing-Chrome relay](OPERATIONS.md#existing-chrome-relay-chatgpt-only), or [managed browser](OPERATIONS.md#managed-chatgpt-browser-dedicated-account) | **Required by the release gate** ([preset proof](RELEASE.md#chatgpt-preset-proof)) |
| ChatGPT Deep Research | `preset: "deep_research"` (composer tool; model picker untouched) | `.tar.zst` | 250 MiB | Existing-Chrome relay or managed browser only; fails on the isolated seed profile with `errorCode: deep_research_report_unreadable` | **Observed** through the Oh My Pi relay and the managed browser ([release ledger](RELEASE.md#fork-evidence-omp-oracle)) |
| Grok | `mode: "heavy"` only | `.tar.gz` | 200 MiB | Isolated seed profile | Not exercised by the fork's release gate; upstream manual upload testing is recorded below |

Upload ceilings apply after default exclusions and automatic whole-repo pruning. Grok uses
`.tar.gz` because its execution environment can lack `zstd`; manual testing against
`https://grok.com` accepted a 200 MiB upload and rejected 200 MiB + 1 byte.

The existing-Chrome relay option also accepts a
[dedicated account in persistent Chrome](OPERATIONS.md#dedicated-account-in-persistent-chrome)
over native loopback CDP with a separate user-data directory. Instant upload, response capture,
owned-tab cleanup, and cross-origin frame capture are **observed** on macOS for that manual
persistent-Chrome setup, and full Deep Research runs with native Markdown export are **observed**
through the managed browser and the Oh My Pi relay; the manual persistent-Chrome setup is the
only shared-Chrome route without a recorded Deep Research run. For response and Deep Research
collection internals, see [Architecture](ARCHITECTURE.md#collection).

## Known limits

Known limits are part of the support boundary; read them before installing.

- **ChatGPT's slider-based thinking-effort picker shares stops and saves to the account.** Both Pro presets (`pro_standard` and `pro_extended`) land on the single `Pro` stop, `thinking_light` shares `Medium` with `thinking_standard`, and `Select model` stays on `Latest` (older tier menus remain supported).
  The last stop a job sets stays selected afterwards, and the redesigned ChatGPT shell saves it to
  the account (`user_last_used_model_config`), making it the default in your other chats and browsers.
- **Experimental public beta.** Provider UI, auth, model controls, and artifact download behavior
  can drift between provider updates; release proof is re-run per release rather than continuously.
- **`pi-oracle` on npm must not stay installed alongside `omp-oracle`.** `pi-oracle` is the
  upstream package and does not carry this fork's changes; keeping both installed registers
  `/oracle` commands and `oracle_*` tools twice.
- **Windows native is declared, not fork-qualified.** The release gate requires macOS and Ubuntu
  only because the fork has no Windows validation environment; Windows native support rests on
  upstream `pi-oracle` 0.7.20 validation.
- **Fork qualification covers only what the release ledger names.** Each release records the unit
  and sanity checks, the live eight-preset ChatGPT proof through this source, and the macOS and
  Ubuntu Crabbox checks in the [release ledger](RELEASE.md#fork-evidence-omp-oracle); nothing
  beyond those entries is claimed.
- **A real ChatGPT or Grok web session is required.** You must be signed in to the provider you
  use in a local Chromium-family browser profile.
- **Relay mode is ChatGPT-only and requires a capable relay.** Relay builds without
  `Target.getTargets` cannot serve `agent-browser` (`0.35.0` or newer is required).
- **The managed browser detects an open profile through Chrome's POSIX `SingletonLock`.** On
  Windows, a profile open without Oracle's DevTools endpoint surfaces only when a launch is handed
  off to it, and the browser window takes focus when Chrome creates it for the first job tab.
- **Other tools connected to a shared Chrome can navigate a job's tab.** If another browser tool
  moves a running job's tab to a different page, the worker detects the change and reopens its own
  conversation at the cost of time; inspect conversations in another tab while jobs run.
- **Deep Research requires a shared Chrome transport and is excluded from the release preset proof.** `deep_research` runs only through the existing-Chrome relay or the managed browser (holding the job's tab for up to 90 minutes by default) and fails on the isolated seed profile with `deep_research_report_unreadable`.
  Each run consumes a Deep Research task on the account, so `release:proof:chatgpt-presets`
  excludes it (see [Architecture](ARCHITECTURE.md#collection)).
- **Wake-up is best effort.** Completion delivery into the asking session is a single idle-gated
  attempt; the saved job directory under `${PI_ORACLE_JOBS_DIR:-/tmp}/oracle-<job-id>/` is the
  durable record.
- **No demo media.** The documentation uses command-level proof and design docs; no screenshot or
  GIF is checked in.
