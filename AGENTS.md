# pi-oracle Project Instructions

This file contains project-specific guidance for this repository.

## Single-operator ownership
- Treat this repository as single-operator: no human or external agent is working here except the current pi agent.
- Assume every lingering change, background process, temp file, queue entry, job directory, or other artifact was created by a prior version of you or by one of your delegated runs.
- You own reconciliation and cleanup for that state. Do not attribute unexplained repo state to another person.

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

## Varlock exception
- Current env/config owner: pi-oracle extension maintainers.
- Reason: pi-oracle is a pi extension package, not an application runtime, and its tests intentionally exercise `PI_CODING_AGENT_DIR`, `PI_ORACLE_JOBS_DIR`, `PI_ORACLE_STATE_DIR`, `AGENT_BROWSER_PATH`, and timeout env overrides used by the pi harness.
- Validation mechanism: extension config is parsed through `extensions/oracle/lib/config.ts`; worker behavior is covered by the oracle sanity suite and isolated pi smoke tests.
- Secret-leak protection: auth code reads browser cookies only through explicit local config and diagnostics paths; tests use temporary fixture values, not committed secrets.
- Exact migration trigger: add a Varlock schema if this package grows into a deployed service, reads app secrets, or exposes environment configuration outside local pi extension/test execution.
- Verification command: `npm run check:oracle-extension && npm run typecheck && npm run typecheck:worker-helpers && npm run sanity:oracle`.
