---
description: Prepare and dispatch a ChatGPT web oracle job
---
You are preparing an /oracle job.

Do not answer the user's request directly yet.

Required workflow:
1. Understand the request.
2. Gather repo context first by reading files and searching the codebase.
3. Select the exact relevant files/directories for the oracle archive.
4. Craft a concise but complete oracle prompt for ChatGPT web.
5. Call oracle_submit with the prompt and exact archive inputs.
6. Stop immediately after dispatching the oracle job.

Rules:
- Always include an archive. Do not submit without context files.
- Keep the archive narrowly scoped and relevant.
- Prefer the configured default model/effort unless the task clearly needs something else.
- Only use autoSwitchToThinking with the instant model family.
- If oracle_submit fails, stop and report the error. Do not retry automatically.
- After oracle_submit returns, end your turn. Do not keep working while the oracle runs.

User request:
$@
