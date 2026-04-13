---
description: Prepare and dispatch a ChatGPT web oracle job
---
You are preparing an /oracle job.

Do not answer the user's request directly yet.

Required workflow:
1. Call `oracle_preflight` immediately.
2. If `oracle_preflight` reports `ready: false`, stop before any expensive prep. Do not read files, search the codebase, or prepare archive inputs first. If the blocker is an auth seed or stale-auth issue that `oracle_auth` can repair, call `oracle_auth` once, rerun `oracle_preflight`, and continue only if it becomes `ready: true`. Otherwise stop immediately and report the blocking issue plus the suggested next step.
3. Understand the request and decide whether it is explicitly narrow or genuinely broad.
4. Gather enough repo context to choose archive inputs and write a strong oracle prompt. Bias toward context-rich submissions when they fit within the 250 MB archive ceiling.
5. If the user scope is explicit and narrow, start from the directly relevant area but still include nearby files, tests, docs, configs, and adjacent modules when they may improve answer quality. Keep the archive tightly minimal only when the user explicitly asks for that, privacy/sensitivity requires it, or size pressure forces it.
6. If the request is broad, architectural, release-oriented, or otherwise repo-wide, gather broader context and usually archive `.`.
7. Choose archive inputs for the oracle job.
8. Craft a concise but complete oracle prompt for ChatGPT web.
9. Call `oracle_submit` with the prompt and exact archive inputs.
10. Stop immediately after dispatching the oracle job.

Oracle model (`oracle_submit`):
- To choose a specific ChatGPT model, pass **`preset`** with one of the allowed ids from the canonical preset registry.
- Matching human-readable preset labels and common hyphen/space variants are also accepted and normalized automatically, but prefer canonical ids when readily available.
- **Or** omit **`preset`** entirely to use the configured default model (from oracle config).
- **`preset`** is the only model-selection parameter on `oracle_submit`. Do not pass `modelFamily`, `effort`, or `autoSwitchToThinking`.
- If unsure, omit **`preset`** and use the configured default. Ask the user about model choice only when they explicitly want model control or the choice would materially change the result.

Rules:
- Use `oracle_preflight` before any expensive `/oracle` preparation so missing persisted-session or local auth/config blockers fail fast.
- If the immediately preceding oracle run for this request failed because ChatGPT login is required, the worker said to rerun `/oracle-auth`, or stale auth clearly blocked execution, call `oracle_auth` once and then retry the oracle submission once. Do not loop auth refreshes.
- Always include an archive. Do not submit without context files.
- By default, prefer context-rich archives up to the 250 MB ceiling because more relevant context is usually better than less. For broad or unclear requests, include the whole repository by passing `.`. Default archive exclusions apply automatically, including common bulky outputs and obvious credentials/private data like `.env` files, key material, credential dotfiles, local database files, and nested `secrets/` directories anywhere in the repo.
- Only limit file selection if the user explicitly requests a tight archive, if privacy/sensitivity requires it, or if the archive would otherwise exceed the size limit after exclusions/pruning.
- For targeted asks, still include directly related surrounding files, tests, docs, configs, and adjacent modules when they may improve answer quality. Do not default to a one-file archive just because the user mentioned one file, one function, or one stack trace.
- Do not keep exploring once you already have enough context to submit well.
- If the request depends on git state or pending changes (for example code review, ship readiness, or release approval), create a tracked diff bundle file inside the repo (for example under `.pi/`) containing `git status` plus `git diff` output, include that file in the archive, and tell the oracle to use it because the `.git` directory is not included in oracle exports.
- When `files=["."]` and the post-exclusion archive is still too large, submit automatically prunes the largest nested directories matching generic generated-output names like `build/`, `dist/`, `out/`, `coverage/`, and `tmp/` outside obvious source roots like `src/` and `lib/` until the archive fits or no candidate remains. Successful submissions report what was pruned.
- If a submitted oracle job later fails because upload is rejected, retry with a smaller archive in this order: (1) remove the largest obviously irrelevant/generated content, (2) if still too large, include modified files plus adjacent files plus directly relevant subtrees, (3) if still too large, explain the cut or ask the user.
- Prefer the configured default (omit **`preset`**) unless the task clearly needs a different model or the user explicitly asked for one; then choose a canonical **`preset`** id.
- If `oracle_submit` itself fails because the local archive still exceeds the upload limit after default exclusions and automatic generic generated-output-dir pruning, or for any other submit-time error, stop and report the error. Do not retry automatically.
- If `oracle_submit` returns a queued job instead of an immediately dispatched one, treat that as success and end your turn exactly the same way.
- After oracle_submit returns, end your turn. Do not keep working while the oracle runs.

User request:
$@
