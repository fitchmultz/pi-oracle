---
description: Continue an earlier oracle job in the same provider thread
argument-hint: <job-id> <request>
---
You are preparing an `/oracle-followup` job.

Do not answer the user's request directly yet.

Required workflow:
1. Parse the user request as `<job-id> <follow-up request>`.
2. If the request does not include both a prior oracle job id and a follow-up request, stop and report: `Usage: /oracle-followup <job-id> <request>. Find the job id in the earlier oracle response or via /oracle-status.`
3. Same-thread follow-ups cannot switch providers. If the user asks to move a ChatGPT thread to Grok or a Grok thread to ChatGPT, stop and tell them to start a new `/oracle` job instead.
4. Call `oracle_preflight` immediately with the parsed `followUpJobId` so readiness checks use the prior job's provider.
5. If `oracle_preflight` reports `ready: false`, stop before any expensive prep. Do not read files, search the codebase, prepare archive inputs, or call `oracle_auth` automatically. Report the blocking issue plus the suggested next step.
6. Treat the parsed job id as `followUpJobId` for `oracle_submit`.
7. Understand whether the follow-up request is explicitly narrow or genuinely broad.
8. Gather enough repo context to choose archive inputs and write a strong oracle prompt. Bias toward context-rich submissions when they fit within the provider archive ceiling: 250 MB for ChatGPT, 200 MiB for Grok.
9. If the follow-up request is explicit and narrow, start from the directly relevant area but still include nearby files, tests, docs, configs, and adjacent modules when they may improve answer quality. Keep the archive tightly minimal only when the user explicitly asks for that, privacy/sensitivity requires it, or size pressure forces it.
10. If the follow-up request is broad, architectural, release-oriented, or otherwise repo-wide, gather broader context and usually archive `.`.
11. Choose archive inputs for the follow-up oracle job.
12. Craft a concise but complete follow-up prompt for the selected web provider.
13. Call `oracle_submit` with the prompt, exact archive inputs, and the parsed `followUpJobId`.
14. Stop immediately after dispatching the oracle job.

Oracle provider/model (`oracle_submit`):
- Follow-ups normally continue on the prior job's provider. If the user explicitly says to use Grok, pass **`provider: "grok"`**. Grok currently supports only **`mode: "heavy"`**.
- To choose a specific ChatGPT model, pass **`preset`** with one of the allowed ids from the canonical preset registry.
- Matching human-readable preset labels and common hyphen/space variants are also accepted and normalized automatically, but prefer canonical ids when readily available.
- **Or** omit **`preset`** entirely to use the configured default model (from oracle config).
- For ChatGPT, **`preset`** is the only model-selection parameter. Do not pass `modelFamily`, `effort`, or `autoSwitchToThinking`.
- If unsure, omit **`preset`** and use the configured default. Ask the user about model choice only when they explicitly want model control or the choice would materially change the result.

Rules:
- Use `oracle_preflight` before any expensive `/oracle-followup` preparation so missing persisted-session or local auth/config blockers fail fast.
- If the immediately preceding oracle run for this follow-up failed because ChatGPT/Grok login is required, the worker said to rerun `/oracle-auth`, or stale auth clearly blocked execution, stop and tell the user to run `/oracle-auth` (or `/oracle-auth grok` for Grok). Do not call `oracle_auth` automatically from `/oracle-followup`.
- This prompt exists so normal users can continue the same provider thread without manually constructing `followUpJobId` tool calls.
- Always include an archive. Do not submit without context files.
- By default, prefer context-rich archives up to the provider ceiling because more relevant context is usually better than less. The ceiling is 250 MB for ChatGPT and 200 MiB for Grok. For broad or unclear follow-up requests, include the whole repository by passing `.`. Default archive exclusions apply automatically, including common bulky outputs and obvious credentials/private data like `.env` files, key material, credential dotfiles, local database files, and nested `secrets/` directories anywhere in the repo.
- Only limit file selection if the user explicitly requests a tight archive, if privacy/sensitivity requires it, or if the archive would otherwise exceed the size limit after exclusions/pruning.
- For targeted follow-ups, still include directly related surrounding files, tests, docs, configs, and adjacent modules when they may improve answer quality. Do not default to a one-file archive just because the user mentioned one file, one function, or one stack trace.
- Do not keep exploring once you already have enough context to submit well.
- If the request depends on git state or pending changes (for example code review, ship readiness, or release approval), create a tracked diff bundle file inside the repo (for example under `.pi/`) containing `git status` plus `git diff` output, include that file in the archive, and tell the oracle to use it because the `.git` directory is not included in oracle exports.
- When `files=["."]` and the post-exclusion archive is still too large, submit automatically prunes the largest nested directories matching generic generated-output names like `build/`, `dist/`, `out/`, `coverage/`, and `tmp/` outside obvious source roots like `src/` and `lib/` until the archive fits or no candidate remains. Successful submissions report what was pruned.
- If a submitted oracle job later fails because upload is rejected, retry with a smaller archive in this order: (1) remove the largest obviously irrelevant/generated content, (2) if still too large, include modified files plus adjacent files plus directly relevant subtrees, (3) if still too large, explain the cut or ask the user.
- If `oracle_submit` fails before dispatch with `details.error.code === "archive_too_large"` or an upload-limit message, that failure is retryable. Use the reported top-level size summary and any auto-pruned paths to choose a smaller archive and retry automatically.
- For archive-too-large retries, cut scope in this order: (1) if you used `.`, remove the largest obviously irrelevant/generated/history/export/report content while preserving relevant source/docs/config/tests, (2) if it still does not fit, archive only the directly relevant subtrees plus adjacent docs/tests/config, (3) if it still does not fit after at most two total `oracle_submit` attempts, report what you cut and why.
- Prefer the configured default (omit **`preset`**) unless the task clearly needs a different model or the user explicitly asked for one; then choose a canonical **`preset`** id.
- For any other `oracle_submit` submit-time error, stop and report the error. Do not retry automatically.
- If `oracle_submit` returns a queued job instead of an immediately dispatched one, treat that as success and end your turn exactly the same way.
- After a successful or queued `oracle_submit`, end your turn. Do not keep working while the oracle runs. If `oracle_submit` failed with a retryable archive-too-large error, shrink the archive and retry first.

User request:
$@
