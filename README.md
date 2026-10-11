# pi-oracle

Send a code review, migration plan, or other deep question from [Pi](https://github.com/earendil-works/pi) to ChatGPT or Grok using your web account. Oracle packages the relevant project files, runs the job in the background, and saves the answer so you can return to it later.

![Oracle workflow: a request in Pi is checked and packed, sent to ChatGPT or Grok in an isolated browser, and saved locally with a best-effort notification back to Pi.](.github/readme/oracle-workflow.png)

*Ask in Pi → prepare project context → run the web model → read the saved answer.*

## Start here

Install the extension, then start Pi in the project you want to review:

```bash
pi install npm:pi-oracle
pi
```

Start a normal persisted `pi` session; Oracle cannot submit jobs from `pi --no-session`. In Pi, sync your existing ChatGPT login and try a small request:

```text
/oracle-auth
/oracle Read README.md and package.json. Tell me in five bullets what this package does.
```

Oracle checks session and auth readiness before gathering files. You receive a job id and response path after dispatch. A finished job sends a best-effort notification to the matching Pi session; you can also retrieve it yourself:

```text
/oracle-status
/oracle-read <job-id>
```

**Experimental public beta.** Provider pages, login flows, model controls and downloads can change. Before your first run, check the [requirements](#requirements) and [privacy notes](#privacy-and-local-data). For auth problems, use the [troubleshooting guide](docs/reference.md#troubleshooting).

## Requirements

- **Pi and Node.js 22.19.0 or newer**, on macOS, Linux, or Windows native. Pi 0.80.9 is the historical suggested floor; compatibility checks target current official Pi and the maintained fork.
- **A Chromium-family browser** with an existing ChatGPT or Grok login in the profile you will import. Your account must have access to the model you choose.
- **`agent-browser` and `tar`** available locally. ChatGPT archives also need **`zstd`**; Grok archives use gzip.
- On **macOS**, the default APFS profile cloning also needs `cp` on PATH (or `PI_ORACLE_CP_PATH`). Linux and Windows profile copies use Node's recursive copy.
- On **Linux**, encrypted cookies may need `secret-tool` or `kwallet-query` + `dbus-send`. See [Linux cookie import](docs/reference.md#linux-cookie-import-notes).

You can also install directly from GitHub:

```bash
pi install https://github.com/fitchmultz/pi-oracle
```

To update the npm installation, run `pi update npm:pi-oracle`. `pi update --extensions` updates all installed packages; `pi update --all` also updates Pi. Bare `pi update` updates Pi itself. Versioned npm or Git sources remain pinned until you change the configured source.

## What to ask

Oracle is useful when you want a slower, broader second opinion: reviewing a large change, planning a migration, or investigating architecture and failure modes. For a quick local coding task, a normal Pi turn is usually enough.

```text
/oracle Review the pending changes. Include the whole repo unless a narrower archive is clearly better. Prioritize concrete fixes.
/oracle Use Grok to explain the highest-risk auth and session failure modes in this codebase.
/oracle-followup <job-id> Tighten the migration plan around rollback risk.
```

Normal `/oracle` jobs still start a fresh provider thread. Follow-ups continue the earlier job's thread. You can also explicitly ask to continue an existing ChatGPT conversation by including its id or `https://chatgpt.com/c/...` URL; see [examples and thread targeting](docs/reference.md#example-requests).

The agent includes relevant surrounding files, tests and docs, even for targeted questions. Whole-repo exports apply default exclusions and can prune generated output to fit. Upload limits are **250 MiB for ChatGPT** and **200 MiB for Grok**. Use explicit file scope when you need a smaller or more private archive.

## Commands

| Command | What it does |
| --- | --- |
| `/oracle <request>` | Prepare project context and submit a background job. |
| `/oracle-followup <job-id> <request>` | Continue a previous job in the same provider thread. |
| `/oracle-auth [chatgpt\|grok]` | Import the provider login from your configured browser profile. |
| `/oracle-read [job-id]` | Show status and a saved response preview; defaults to the latest project job. |
| `/oracle-status [job-id]` | Show status and recent job ids when no explicit id is given. |
| `/oracle-cancel <job-id>` | Cancel a queued or active job. |
| `/oracle-clean <job-id\|all>` | Remove finished-job files. A recent notification can delay cleanup; the command tells you when to retry. |

Jobs may queue when browser capacity is full. Responses, logs, metadata and downloaded artifacts live under `${PI_ORACLE_JOBS_DIR:-/tmp}/oracle-<job-id>/`; the default answer file is `response.md`. These are local files, so retain anything you need before clearing temporary storage.

## Choose a provider or model

ChatGPT is the default provider, with `pro_extended` as the default preset. To use Grok, first run `/oracle-auth grok`, then name Grok in your request. Grok currently supports Heavy only.

To change defaults or choose a browser profile, create `~/.pi/agent/extensions/oracle.json`:

```json
{
  "defaults": {
    "provider": "chatgpt",
    "preset": "thinking_light"
  },
  "auth": {
    "chromeProfile": "Default"
  }
}
```

## Available providers and presets

| Provider | Archive | Upload ceiling |
| --- | --- | --- |
| ChatGPT | `.tar.zst` | 250 MiB |
| Grok — Heavy | `.tar.gz` | 200 MiB |

Use these canonical ids for `defaults.preset`:

| ChatGPT preset id | Selection |
| --- | --- |
| `pro_standard` | Pro - Standard |
| `pro_extended` | Pro - Extended |
| `thinking_light` | Thinking - Light |
| `thinking_standard` | Thinking - Standard |
| `thinking_extended` | Thinking - Extended |
| `thinking_heavy` | Thinking - Heavy |
| `instant` | Instant |
| `instant_auto_switch` | Instant - Auto-switch to Thinking Enabled |

ChatGPT's current picker can map several presets to the same visible tier or effort. Oracle checks the visible selection before submitting; see [picker mappings](docs/reference.md#available-chatgpt-presets) for details.

Browser and auth settings belong in the agent-level config. Project-local safe overrides load by default, except with `--no-approve` or a saved untrusted-project decision. See [configuration](docs/reference.md#configuration) for trust behavior, custom browsers and cookie sources.

## Privacy and local data

`/oracle-auth` reads provider cookies from your configured browser profile into an isolated auth seed. Each normal job clones that seed into its own browser profile, keeping your active browser window separate from the job.

**Selected project files are uploaded to ChatGPT or Grok.** Default archive exclusions skip obvious credentials and bulky outputs, but they are not a guarantee that an archive contains no sensitive data. Choose the scope deliberately and review the [design](docs/ORACLE_DESIGN.md) before using private or regulated material.

Saved responses, logs, artifacts and auth profiles also contain local data worth protecting. Cookie replay does not preserve host-only or partitioned-cookie isolation metadata. Do not put browser safe-storage passwords in project config or persistent shell startup files.

## Help and further reading

- [Command, configuration and troubleshooting reference](docs/reference.md) — auth recovery, custom Chromium profiles, cleanup and agent tools.
- [Design and lifecycle](docs/ORACLE_DESIGN.md) — archive handling, queueing, persistence and notifications.
- [Development and release guide](docs/development.md) — offline checks, host qualification and publication gates.
- [Cross-platform smoke testing](docs/platform-smoke.md), [isolated Pi validation](docs/ORACLE_ISOLATED_PI_VALIDATION.md) and [auth recovery drill](docs/ORACLE_RECOVERY_DRILL.md).
- [Report a problem](https://github.com/fitchmultz/pi-oracle/issues) — include the job diagnostics, with sensitive data removed.

## License

MIT. See [LICENSE](LICENSE).
