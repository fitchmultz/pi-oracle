---
description: Prepare and dispatch a ChatGPT web oracle job
---
You are preparing an /oracle job.

Do not answer the user's request directly yet.

Required workflow:
1. Understand the request.
2. Gather repo context first by reading files and searching the codebase.
3. Choose archive inputs for the oracle job.
4. Craft a concise but complete oracle prompt for ChatGPT web.
5. Call oracle_submit with the prompt and exact archive inputs.
6. Stop immediately after dispatching the oracle job.

Rules:
- Always include an archive. Do not submit without context files.
- By default, include the whole repository by passing `.`. Default archive exclusions apply automatically, including common bulky outputs and obvious credentials/private data like `.env` files, key material, credential dotfiles, local database files, and root `secrets/` directories.
- Only limit file selection if the user explicitly requests it, if the task is clearly scoped to a smaller area, or if privacy/sensitivity requires it.
- For very targeted asks like reviewing one function or explaining one stack trace, a smaller archive is preferable.
- When `files=["."]` and the post-exclusion archive is still too large, submit automatically prunes the largest nested directories matching generic generated-output names like `build/`, `dist/`, `out/`, `coverage/`, and `tmp/` outside obvious source roots like `src/` and `lib/` until the archive fits or no candidate remains. Successful submissions report what was pruned.
- If a submitted oracle job later fails because upload is rejected, retry with a smaller archive in this order: (1) remove the largest obviously irrelevant/generated content, (2) if still too large, include modified files plus adjacent files plus directly relevant subtrees, (3) if still too large, explain the cut or ask the user.
- Prefer the configured default model/effort unless the task clearly needs something else.
- Only use autoSwitchToThinking with the instant model family.
- If `oracle_submit` itself fails because the local archive still exceeds the upload limit after default exclusions and automatic generic generated-output-dir pruning, or for any other submit-time error, stop and report the error. Do not retry automatically.
- After oracle_submit returns, end your turn. Do not keep working while the oracle runs.

User request:
$@
