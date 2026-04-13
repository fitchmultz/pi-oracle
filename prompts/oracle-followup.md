---
description: Continue an earlier oracle job in the same ChatGPT thread
---
You are preparing an `/oracle-followup` job.

Do not answer the user's request directly yet.

Required workflow:
1. Call `oracle_preflight` immediately.
2. If `oracle_preflight` reports `ready: false`, stop immediately and report the blocking issue plus the suggested next step. Do not read files, search the codebase, or prepare archive inputs first.
3. Parse the user request as `<job-id> <follow-up request>`.
4. If the request does not include both a prior oracle job id and a follow-up request, stop and report: `Usage: /oracle-followup <job-id> <request>. Find the job id in the earlier oracle response or via /oracle-status.`
5. Treat the parsed job id as `followUpJobId` for `oracle_submit`.
6. Understand whether the follow-up request is explicitly narrow or genuinely broad.
7. Gather only the smallest repo context needed to choose archive inputs and write a strong oracle prompt.
8. If the follow-up request is explicit and narrow, prefer a minimal targeted read/search set and dispatch as soon as you have enough context. Do not broaden into repo-wide exploration unless the narrow pass proves insufficient.
9. If the follow-up request is broad, architectural, release-oriented, or otherwise repo-wide, gather broader context and usually archive `.`.
10. Choose archive inputs for the follow-up oracle job.
11. Craft a concise but complete follow-up prompt for ChatGPT web.
12. Call `oracle_submit` with the prompt, exact archive inputs, and the parsed `followUpJobId`.
13. Stop immediately after dispatching the oracle job.

Oracle model (`oracle_submit`):
- To choose a specific ChatGPT model, pass **`preset`** with one of the allowed ids from the canonical preset registry.
- Matching human-readable preset labels and common hyphen/space variants are also accepted and normalized automatically, but prefer canonical ids when readily available.
- **Or** omit **`preset`** entirely to use the configured default model (from oracle config).
- **`preset`** is the only model-selection parameter on `oracle_submit`. Do not pass `modelFamily`, `effort`, or `autoSwitchToThinking`.
- If unsure, omit **`preset`** and use the configured default. Ask the user about model choice only when they explicitly want model control or the choice would materially change the result.

Rules:
- Use `oracle_preflight` before any expensive `/oracle-followup` preparation so missing persisted-session or local auth/config blockers fail fast.
- This prompt exists so normal users can continue the same ChatGPT thread without manually constructing `followUpJobId` tool calls.
- Always include an archive. Do not submit without context files.
- By default, include the whole repository by passing `.` when the follow-up request is genuinely broad, repo-wide, or unclear after a quick narrow pass. Default archive exclusions apply automatically, including common bulky outputs and obvious credentials/private data like `.env` files, key material, credential dotfiles, local database files, and nested `secrets/` directories anywhere in the repo.
- Only limit file selection if the request is clearly scoped smaller, if the user explicitly narrows the scope, or if privacy/sensitivity requires it.
- For very targeted follow-ups like clarifying one function, one file, one stack trace, or one narrow question, start with the smallest obviously sufficient archive and expand only if that first pass proves insufficient.
- Do not keep exploring once you already have enough context to submit well.
- If the request depends on git state or pending changes (for example code review, ship readiness, or release approval), create a tracked diff bundle file inside the repo (for example under `.pi/`) containing `git status` plus `git diff` output, include that file in the archive, and tell the oracle to use it because the `.git` directory is not included in oracle exports.
- When `files=["."]` and the post-exclusion archive is still too large, submit automatically prunes the largest nested directories matching generic generated-output names like `build/`, `dist/`, `out/`, `coverage/`, and `tmp/` outside obvious source roots like `src/` and `lib/` until the archive fits or no candidate remains. Successful submissions report what was pruned.
- If a submitted oracle job later fails because upload is rejected, retry with a smaller archive in this order: (1) remove the largest obviously irrelevant/generated content, (2) if still too large, include modified files plus adjacent files plus directly relevant subtrees, (3) if still too large, explain the cut or ask the user.
- Prefer the configured default (omit **`preset`**) unless the task clearly needs a different model or the user explicitly asked for one; then choose a canonical **`preset`** id.
- If `oracle_submit` itself fails because the local archive still exceeds the upload limit after default exclusions and automatic generic generated-output-dir pruning, or for any other submit-time error, stop and report the error. Do not retry automatically.
- If `oracle_submit` returns a queued job instead of an immediately dispatched one, treat that as success and end your turn exactly the same way.
- After `oracle_submit` returns, end your turn. Do not keep working while the oracle runs.

User request:
$@
