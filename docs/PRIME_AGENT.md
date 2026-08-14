# Prime Agent integration

`pi-oracle` can run as a native Prime Agent package. The Prime port keeps the existing Oracle tools, slash-command workflow, detached browser workers, durable job state, provider-thread follow-ups, and best-effort completion wake-ups while adapting host-specific configuration and session behavior to Prime Agent.

## Install the development branch

```sh
prime-agent package install git:github.com/sammyjoyce/pi-oracle@feat/prime-agent
```

For a one-off trial without changing package settings:

```sh
prime-agent -e git:github.com/sammyjoyce/pi-oracle@feat/prime-agent
```

Prime Agent keeps package configuration under `~/.prime/agent`. The global Oracle configuration file is therefore:

```text
~/.prime/agent/extensions/oracle.json
```

A repository may also provide safe, non-auth overrides at:

```text
.prime/agent/extensions/oracle.json
```

Browser paths, cookie sources, and other privileged auth settings continue to come only from the global configuration file.

## Use

The user-facing commands and agent-facing tools are unchanged:

- `/oracle <request>` and `oracle_submit`
- `/oracle-followup <job-id> <request>`
- `/oracle-auth [chatgpt|grok]` and `oracle_auth`
- `/oracle-read [job-id]` and `oracle_read`
- `/oracle-status [job-id]`
- `/oracle-cancel <job-id>` and `oracle_cancel`
- `/oracle-clean <job-id|all>`
- `oracle_preflight`

Prime Agent's daemon-backed sessions can detach and reattach while an Oracle job runs. Completion remains durable on disk and the extension also sends one hidden, triggered follow-up message to the matching persisted session when the answer becomes available.

## Runtime overrides

Oracle keeps its existing `PI_ORACLE_*` environment names under both hosts. These names are part of the extension's worker protocol rather than the coding-agent host API, so retaining them avoids splitting the extension process and detached workers across different state roots.

| Purpose | Environment variable | Default |
| --- | --- | --- |
| Job directories | `PI_ORACLE_JOBS_DIR` | `/tmp` |
| Shared locks and leases | `PI_ORACLE_STATE_DIR` | `/tmp/pi-oracle-state` |
| macOS clone command | `PI_ORACLE_CP_PATH` | `cp` |

Provider-specific test and diagnostic variables also retain their existing `PI_ORACLE_*` names.

## Trust and archives

Prime Agent treats loaded packages and repository resources as trusted code. Oracle still separates configuration by sensitivity: project configuration can change only the safe override keys, while browser/auth configuration is global-only. Project archives exclude both `.pi` and `.prime` directories by default so local agent configuration is not uploaded accidentally.

Review the main README and `docs/ORACLE_DESIGN.md` before using Oracle with private or regulated source code. Selected archives are uploaded to the configured ChatGPT or Grok web account.
