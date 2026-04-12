# pi-oracle Project Instructions

This file contains project-specific guidance for this repository.

## Extension testing feedback
- Pre-commit requirement for any code changes: always test with isolated `pi` agent sessions that load this local version of the extension.
- Use those isolated sessions to validate the changed behavior works as expected end-to-end, not just through local unit/sanity coverage.
- For these isolated-session validation runs, use the `instant` or `thinking_light` preset.
- During those tests, feel free to ask the agents you are exercising for suggestions and feedback about the tool.
- Ask specifically about friction points such as clunky behavior, uninformative output, workflows that feel slower with no clear gain, or anything else that seems off during real use.

## Temporary working files
- `progress.md` and `review.md` are temporary working artifacts.
- Ignore them locally or delete them once they have been consumed and are no longer needed.
- Do not leave them around as untracked repo noise after they are no longer useful.
