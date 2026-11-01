# Changelog

Versions from `0.1.0` are `omp-oracle` releases; the numbering restarts for the new package
identity and does not continue upstream `pi-oracle`'s `0.7.x` line. The inherited upstream
history is kept below the divider.

## Unreleased

### Changed

- the development-only `minimatch` dependency is overridden to `^11.0.1` to fix [GHSA-g3hv-75wg-m249](https://github.com/advisories/GHSA-g3hv-75wg-m249), because `@earendil-works/pi-coding-agent` 1.4.0 pins the vulnerable `10.2.6`; the published package does not change

## 0.4.11 - 2026-10-31

### Fixed

- the missing-turn recovery introduced in 0.4.10 reloaded during every long Pro generation (2026-10-31 jobs reloaded 1–2× each; a Cloudflare challenge followed a day of resumes). Generation evidence now resets the missing-turn timer, just like a completion signature, and each job attempts at most one missing-turn reload before polling until its completion timeout and leaving recovery to recollection. The stale-stop reload is unchanged.

## 0.4.10 - 2026-10-30

### Fixed

- a ChatGPT turn that finished without the live page ever showing it timed out after the full completion window (2026-10-30, job `21363c38`: the fifth Pro turn of a long conversation completed with its document attachment, the live tab produced no completion signature for 90 minutes, and a fresh load of the same conversation showed the complete turn). The worker now reloads the conversation after five minutes without any completion signature (`nextMissingTurnState`, bounded like the stale-stop reload and never a send), records the reply's position when the completion timeout does fire, and `oracle_read` `action=recollect` recovers such a timed-out job through the user turn that carries its archive (`timedOutRecollectionBinding`; the saved index, or an explicit `responseIndex` for jobs recorded before the index was saved), marking it complete without resending anything

## 0.4.9 - 2026-10-28

### Fixed
- ChatGPT turn observation matches the screen-reader headings `ChatGPT said:` / `You said:` by prefix. ChatGPT added a hidden print-formatting span to those headings, so their text read `ChatGPT said:ChatGPT`; the exact match saw no assistant turn, and a finished Deep Research job waited in `awaiting_response` until its completion timeout ([#21](https://github.com/alphastorm/omp-oracle/pull/21)).

### Security
- the development-only `undici` dependency is overridden to `8.12.2` to fix [GHSA-xjj6-f33q-929c](https://github.com/advisories/GHSA-xjj6-f33q-929c), because `@earendil-works/pi-coding-agent` 1.3.0 pins the vulnerable `8.10.2`

## 0.4.8 - 2026-10-24

### Fixed
- every ChatGPT submission refreshes its read-only effort observation, including when model configuration is skipped because the composer already matches. A currently open Power slider records its current label, index, and offered count; an absent control (including Deep Research or a retained menu behind a collapsed opener) records `effortLabel: null` and `effortControls: "absent"` instead of keeping stale effort evidence. A failed read or unparsable mounted control records `"unavailable"` without changing selection or submission behavior. Supported compact picker labels are observed too, unreadable model labels clear old provenance, and an actual slider stop takes precedence over a generic picker caption.

## 0.4.7 - 2026-10-20

### Changed
- releases publish from GitHub Actions through npm trusted publishing: pushing the `vX.Y.Z` tag runs `.github/workflows/release.yml`, which repeats the local gate on the tagged commit, packs it, and publishes that tarball from a separate job that holds the short-lived OIDC credential and runs no repository or dependency code. No npm token is involved, the maintainer no longer approves each publish in a browser, and versions published this way carry an npm provenance attestation. The live preset proof and Crabbox lanes still pass locally before the tag is pushed. `ci.yml` no longer runs on tags, because the release workflow runs the same gate there
- the development and release-gate baseline moves from `pi` 0.80.9 to 1.3.0 (`@earendil-works/pi-ai` and `@earendil-works/pi-coding-agent` `^1.3.0`, `typebox` `^1.3.27` to match the host). The `before_agent_start` handler narrows the event with `"prompt" in event`, as upstream does, because pi 1.2 types a custom-message run (an oracle wake-up) as a union member without `prompt`, which failed the typecheck; runtime behavior is unchanged on every host. Two poller sanity fixtures build their unwritten session history from custom entries, because pi 0.99 writes the session file at the first user message instead of the first assistant reply, and the packed real smoke now requires the installed `pi` devDependency instead of a hard-coded `0.80.9`. The development audit drops from five findings (two high, all inside `pi` 0.80.9's dependency graph) to none: `esbuild` moves to `0.28.2`, and the `protobufjs` override is removed because the 1.3 graph resolves the patched `7.6.6` by itself
- `package.json` records `allowScripts` denials for the four development dependencies with install scripts (`esbuild`, `protobufjs`, `@google/genai`, `fsevents`), so npm 11 skips them as npm 12 does by default and stops warning; the local gate passes without them, because esbuild runs its platform binary through its JavaScript launcher
- Dependabot, now enabled on this fork, skips major `@types/node` and `typescript` updates and every `typebox` update: `@types/node` follows the Node 22 floor, TypeScript 7 no longer ships the compiler API the native worker test parses with (its first grouped update failed the local gate there), and `typebox` moves only with the `pi` baseline that pins it
- the sanity harness no longer leaves an empty `/tmp/oracle-runtime-<uuid>` directory behind on every run: the test for `/oracle-clean` refusing a job whose worker is still live now removes the runtime profile it creates, which the cleanup under test leaves in place by design
- the Ubuntu platform-smoke image builds on `cimg/node:24.22` instead of `24.16`, the current Node 24 release (CI runs 24.21; upstream moved its image to 24.21); rebuild it with the command in `docs/PLATFORM_SMOKE.md`

### Fixed
- `/oracle-auth` cookie import moves from `@steipete/sweet-cookie` 0.3.0 to 0.4.4, which `^0.3.0` never picked up. On Linux, keyring-encrypted (`v11`) cookies in a Chromium profile, including the Snap and Flatpak Chromium roots, are looked up under Chromium's own keyring entry instead of Chrome's; the one-run password override for those profiles is now `SWEET_COOKIE_CHROMIUM_SAFE_STORAGE_PASSWORD`, and `SWEET_COOKIE_CHROME_SAFE_STORAGE_PASSWORD` no longer applies to them. Partitioned cookies are skipped with a warning instead of being imported without their partition, and Chromium cookie expiry reads work on Node 24.0 through 24.3. This closes the gap upstream `pi-oracle` filled with its own Linux Chromium `v11` importer
- subprocess environments drop every `SWEET_COOKIE_*_SAFE_STORAGE_PASSWORD` variable by name pattern instead of a fixed list of three names, so the new Chromium override, and any later browser's, never reaches a browser, helper, or archive subprocess
- on Oh My Pi, typing `/oracle …` or `/oracle-followup …` in the interactive TUI sent the request to the model twice, each copy with its own hidden dispatch instructions (reproduced on Oh My Pi 18.12.3 with the published 0.4.6 package). Oh My Pi consumes extension-handled input only on `handled: true`, but the input handler returned only pi's `action: "handled"`, so Oh My Pi also submitted the typed text beside the reinjected command; for the same reason, a usage warning for a missing argument still let the bare command reach the model. The handler now returns both fields
- `/oracle` and `/oracle-followup` forbade calling `oracle_auth` yet told the agent to relay preflight's suggested next step, which for a missing or unauthenticated seed says to call `oracle_auth`; agents in two isolated Oh My Pi sessions flagged the conflict. Both prompts now say to tell the user to run `/oracle-auth` in that case, and identify the `Oracle preflight blocked` text that `ready: false` produces

## 0.4.6 - 2026-10-19

### Changed
- the Ubuntu platform-smoke image installs `agent-browser@0.39.1` instead of `0.29.1`, which predates the documented `0.35.0` floor for relay mode; `0.35.0` remains the minimum
- `oracle_submit` told callers not to poll but named no way to check status, which an isolated-session agent flagged on 2026-10-19 (job `72a0c013`). Dispatched and queued replies keep the no-polling instruction and now name `oracle_read` with the job id for a status check the user asks for before the completion wake-up; the tool guidelines, `/oracle` and `/oracle-followup` templates, and docs say the same

### Fixed
- with `agent-browser` 0.39, `/oracle-auth` could not be rerun after a challenge. A challenge leaves the auth browser open on purpose; the rerun closed that session and relaunched on the same session name while its daemon was still exiting, and 0.39 refuses to re-send a command that reached a dying daemon (`Invalid response: EOF … it may or may not have run, so it was not retried`), where 0.35 had re-sent it silently. The retry taken from upstream 0.7.22 matched only the earlier `Could not configure browser` message. `/oracle-auth` now closes the auth session only when the driver lists it and relaunches once the driver stops listing it, the rule job teardown already followed; both now share it
- with `agent-browser` 0.36 or newer, a page that registers WebMCP tools makes the driver append a tool announcement to the text output of `eval`, `get url`, `snapshot`, and `get text`, which the workers parse: the auth probe then reads as invalid and `/oracle-auth` times out. Neither provider's page registers tools today, but the driver enables WebMCP by default in the Chrome it launches, which includes the auth browser. Both workers now run every driver command with `AGENT_BROWSER_NO_WEBMCP=1`, which earlier drivers ignore
- a finished ChatGPT reply waited two more minutes before the job completed. After a send, ChatGPT keeps its Home composer mounted in a `display:none` workspace, and that composer's enabled `Stop` button (no layout box, absent from the accessibility tree) matched the worker's stop-control selector while the visible reply already showed Copy, Rate response, and Regenerate. Every `instant` job in five isolated runs on 2026-10-19 took about 150 s, whichever agent-browser version or browser arguments were used, and finished only through the 121 s stale-stop reload. Completion now counts only rendered stop controls; an offscreen or background-tab `Stop` still counts, and the stale-stop reload remains the fallback. A live `instant` job and its same-thread follow-up then completed 24 s after send

## 0.4.5 - 2026-10-18

### Added
- `oracle_read` accepts an optional owning `projectId`; `/oracle-status` and `/oracle-read` accept `--projectId`. An id found in another project names the owning root and requires an explicit retry instead of hiding the job or returning its response silently. Every project's jobs share the configured jobs root, so lookup needs no new index; cancel and cleanup remain current-project only.
- the existing `observedSelection` gains an observed `product` and the bound `deepResearchIframeTitle`, alongside its existing model-selector text (`modelLabel`), slider stop (`effortLabel`), and timestamp (`at`). Read/status surfaces expose these optional facts without new DOM queries or answer/auth data; legacy jobs need no migration.

### Fixed
- a slider reading logged before model configuration failed was lost because `observedSelection` was written only after configuration finished. The worker now merges each logged slider observation through its existing locked atomic job-state write path.
- a thinking-effort picker that ChatGPT closed mid-step (observed one step off Pro, landing on High, behind a composer pill that names no stop) failed the job with `Lost the ChatGPT thinking-effort slider while stepping`. The worker now reopens the picker, at most twice, and resumes stepping from the stop the slider itself reports.

## 0.4.4 - 2026-10-17

### Changed
- the README and `docs/` are rewritten reader-first, one reader and one job per page. The README leads with the promise, when to use it, a four-step first run, everyday commands, how it works, configuration, presets, a privacy summary, and a support summary; the new `docs/README.md` indexes every document by task (use it, trust it, build on it, dated records). `docs/OPERATIONS.md` gains a transport chooser, a troubleshooting-by-symptom table, the complete configuration reference (moved from `docs/ARCHITECTURE.md`), and the install-source switching guide (moved from the README); `docs/ARCHITECTURE.md` keeps the design, job layout, and collection contracts and folds its rejected and superseded history into a short design lineage; `docs/COMPATIBILITY.md` opens with a status vocabulary (declared, validated upstream, observed, required by the release gate); `docs/TEST_PLAN.md` owns the validation ladder; `docs/RELEASE.md` separates producing the preset proof from checking it and frames the carried upstream records as history; `CONTRIBUTING.md` lists the evidence each change type needs and the repository layout. Claims are corrected from the code and the ledger: default archive exclusions apply when a directory is expanded, while an explicitly named path is archived as named (`.git` is excluded by default, not "never included"); the local gate runs three typecheck projects; release proof covers the eight model presets; the auth recovery drill expects an empty seed profile to be refused at submission; the `real-extension` suite runs `/oracle-status` through the installed package by default; Deep Research with native Markdown export is recorded through the managed browser. The release ledger entries are unchanged
- test and gate repairs merged from upstream `pi-oracle`'s test audit, each replacing a check that could pass while the behavior was broken: the auth and archive timeout tests require their pid markers; the keychain fixture answers only the configured account and service; the cookie-policy test names the foreign-domain cookie it drops; queued promotion proves its config snapshot against a changed on-disk config, and the test-only `loadConfigFn` seam in `lib/queue.ts` is gone; sanity-runner isolation is proven by subprocess refusal instead of a source grep; the queue comparator, completion-signature, notification-claim, and no-session startup tests get inputs that tell right from wrong; the preset proof reads the real `ORACLE_SUBMIT_PRESETS` registry instead of parsing source; the real smoke requires the actual symlink-rejection code; platform smoke refuses an empty `--target` or `--suite` and checks the emitted command for source-extension paths; `npm pack --json` is read in both its npm 11 and npm 12 shapes; and shared sanity cleanup retries a transient `ENOTEMPTY`
- the `protobufjs` override moves to `7.6.6` (GHSA-j3f2-48v5-ccww) and the `basic-ftp` override is removed, since nothing in the dependency graph uses it; the release sanity guard no longer pins exact override versions. The remaining development-only advisories sit inside `@earendil-works/pi-coding-agent` 0.80.9's bundled dependencies and clear only with the Pi 1.x baseline; the published package's runtime graph audits clean (`npm audit --omit=dev`)

### Added
- `npm run test:docs` (`scripts/docs-links.test.mjs`), part of `npm run verify:oracle`, fails when a relative documentation link, a heading fragment, or a link into this repository from the public site does not resolve

### Fixed
- code blocks in ChatGPT's current web app lost their language and, once the page reloaded, their fences. The shell wraps a block in a container whose action bar names the language (`YAML`) beside its buttons, with no `language-*` class: a live reply was saved as a bare ```` ``` ```` fence after a stray `YAML` paragraph, and a recollected reply, whose reloaded page renders a bare block `code` without `pre`, lost every fence (the multi-line code inlined between single backticks, `codeBlocks` empty), so a reply that is one Markdown block could never be saved verbatim as `exact_code` (job `086c4b50` on 2026-10-16, a 52 KB YAML work plan whose consumer fell back to the attached file). A runnable block (Python, with a `Run` button) is a CodeMirror editor with neither `pre` nor `code`, so it was saved as a `Python` paragraph followed by its code as prose, and the editor renders only the rows near the viewport. All three renders now capture each block once, fenced in the action bar's language; an editor block takes its text from the editor's own document, and the saved `response.raw.html` holds every line. Observed live on 2026-10-17: a YAML block, a one-line and a 300-line Python block, captured identically on completion and on recollection
- a source pill linking another site became a download candidate: `GitHub +1` on a raw `.md` URL matched the file-link heuristic, so collection activated it as a download twice (in-page byte capture, then the native download listener), waited out the download deadline both times (100 s per collection), and marked the job `complete_with_artifact_errors` with `collectionStatus: partial` for a file that never existed (job `086c4b50`, at completion and again on recollection). A link to another site without a `download` attribute is now a citation whatever its path or label: ChatGPT serves a reply's files from its own origin or OpenAI's user-content host
- `oracle_read` and `/oracle-read` cut the response preview at 4,000 characters without saying so; a partial preview is now labeled with its length and the response's (`response-preview (first 4000 of 53793 characters; the response file holds the rest):`)
- the release preset proof runner and the isolated-session recipes launched `omp --standard`, which Oh My Pi 18.11 rejects (`unknown flag: --standard`); they now run `omp … -p --no-extensions -e`, which loads this checkout's extension directly
- `/oracle-auth` and job readiness treated an anonymous visitor as a signed-in account: `/backend-api/me` answers a logged-out page with HTTP 200 and a `ua-…` id, which drove account-selection clicks and reloads in `/oracle-auth`, while a job reloaded and failed 15 s later saying the backend had returned account-like fields. A `ua-` identity beside login controls is now `login_required` (from upstream `pi-oracle` 0.7.21)
- `/oracle-auth` failed when ChatGPT redirected during verification: a read interrupted by navigation (`Execution context was destroyed`, `Inspected target navigated or closed`, `Cannot find context with specified id`) rejected the whole poll while the other reads still ran, and the guidance then blamed the source cookies. Each poll now settles all four reads, discards and retries one that navigation interrupted, keeps any other failure fatal, and names a browser that navigated, closed, or never settled as such (from upstream 0.7.21)
- the `/oracle-auth` launch failed when `agent-browser` returned from closing the previous session before its daemon socket disappeared (`Could not configure browser: Failed to connect: No such file or directory`); the launch now waits for that one pre-launch failure within its existing deadline and still fails any other launch error at once (from upstream 0.7.22)
- the `/oracle` dispatch hook read `event.prompt` unconditionally, but newer `pi` hosts also start custom-message turns, such as an oracle completion wake-up, through `before_agent_start` without a prompt; those turns are now ignored (from upstream 0.7.22)

## 0.4.3 - 2026-10-06

### Fixed
- a job could save another conversation's answer as its own. Another CDP client navigated the job's tab: an agent's browser tool connected to the managed Chrome adopts the window's visible tab, which can be a running job's. The completion poll read whichever conversation the tab showed, declared completion on a finished turn there, and when the bound capture of the job's own, still-generating turn then failed, the streamed text was saved as a `text_fallback` response (three jobs on 2026-10-04, each holding another case's text; one declared completion 8 minutes before its own turn finished). Every read now checks the page's conversation in the same evaluation as the turns, the stop control, the capture, and the post-send URL (which is adopted only from a page whose user turn shows the job's archive); a page on another conversation is reopened on the job's own, recorded once per departure as a `navigation` lifecycle event, and the completion count starts over within the same deadline. A ChatGPT capture failure no longer saves any unbound text: `response.md` is not written, `collectionStatus` is `failed`, and `recollectionNeeded` (shown in `oracle_read` and the wake-up) directs recollection instead of resubmission. A binding saved without the turn's message ID, as these failures left, is now recollected through the user turn that carries the job's archive (`context-<id>.tar.zst`); recollection previously refused it unless the operator read the message ID out of the DOM by hand
- cleanup storms: Chrome refuses to close a window's last tab, and every live session's poller retried that close about every 5 s, appending the warning to the job's `error` each time (26 of 75 jobs; one job retried for 25.5 hours and held 38,669 copies, about 1 MB of `job.json`). The job's tab is now released to `about:blank` when it is the last one; a failed teardown is retried at most five times (15 s, 1 min, 5 min, 15 min) and only when due; warnings are deduplicated, capped at eight of 500 characters, and never written into `error`; recorded warnings alone no longer trigger cleanup, block pruning, or hold the queue; and displayed errors collapse repeated lines and stop at 2,000 characters
- wake-ups arrived hours late, one model turn each, for jobs already read (60 wake-ups reached one session a median 2.6 hours after emission; 58 of those jobs had already been read through `oracle_read`). The host holds a follow-up until the agent's run ends, and a queued message cannot be withdrawn. A wake-up is now sent only while the session is idle with nothing queued, jobs that finish together arrive as one message, and an `oracle_read` by the job's own session settles it before the first attempt
- Deep Research capture: the native Markdown export failed in 5 of 14 jobs because the clickable element that wraps the whole report became a download candidate whose text matched the export labels; flagged as the native export, it displaced the real `Export` button. Controls that wrap other controls or carry more than 200 characters of text are never candidates. The report is now saved from its Markdown source, the native export or else the report message the research widget holds, with diagram source intact and each citation token turned into a numbered footnote with its source, without the `utm_source=chatgpt.com` parameter ChatGPT appends (an unresolvable citation keeps a footnote saying so and is reported as `unresolved_source_links`). The page-derived fallback no longer renders the status line's animated counters as digit strips or runs of blank lines, keeps citation pills as visible `[n]` markers counted as unresolved sources, and replaces diagrams it cannot read with a placeholder counted as `diagram_source:<n>`
- Deep Research setup failed with `Deep Research menu control did not become stationary and uncovered` when another job's tab was the visible one (job `ffb106b3`, started within 0.4 s of another Deep Research job): the wait counted animation frames, which Chrome does not give a hidden tab. It now samples on timers. The tool is enabled while the job reports `configuring_model`, so such a failure no longer reads as an upload failure
- a product announcement opened as a modal over the composer (`Your Pro plan now includes connected finances`) and model configuration timed out behind it with `Could not open model configuration UI` (job `0eebc96a`). The worker dismisses a modal that hides the composer through its `Close dialog` control, never through an action such as `Get started`

### Added
- `promptSendState` (`not_sent`, `attempted`, `accepted`) in `job.json`, `oracle_read`, and failure wake-ups, so a failed job says whether resubmitting is safe
- what the composer showed is recorded as `observedSelection` (model picker label, the effort slider's stop such as `Pro (5 of 5)`, and a verified Deep Research pill), and the turn's reasoning-time label as `observedTurn` (`Worked for 15m 7s`, 907 s; for Deep Research, the report's `Research completed in 6m`); both appear in `oracle_read`
- `oracle_preflight` reports global capacity, ready or blocked (`Capacity: 1/2 active, 0/2 queued (global).`), so callers no longer discover a full queue by failed submits; `archive_input_missing` names the project root that inputs resolve against

## 0.4.2 - 2026-09-30

### Added
- brand assets at parity with the sibling OMP projects, specified in `docs/BRANDING.md`: the Lens mark for dark and light backgrounds, a favicon, and banner and social-preview sources in `assets/` with their renders, regenerated and checked by `npm run render:assets`. The site now shows the mark, takes the Answer rose accent, names `og.png` as a large social card, and ships `robots.txt`, `sitemap.xml`, and `llms.txt`; the Pages deploy stages the mark, favicon, and preview from `assets/` instead of keeping copies in `site/`. `npm run test:site`, now part of the local gate, fails when a site page references an asset the deployment would not serve, when a staged asset's source could change without redeploying, when the declared preview size disagrees with `og.png`, or when the sitemap and canonical links drift. The repository's GitHub social preview is uploaded by hand from `assets/og.png`

### Fixed
- every ChatGPT job failed at `verifying_auth` with `Timed out waiting for the ChatGPT chat UI to become ready` once an account received ChatGPT's redesigned web app (observed 2026-09-29): readiness required a composer named `Chat with ChatGPT`, and the new shell names it `Ask ChatGPT`. The later phases shared the same stale assumptions, so a readiness-only rename would have failed next: the prompt writer and Deep Research caret placement looked up `#prompt-textarea`, which the new shell does not render; send readiness and activation looked for `Send prompt` (now `Send`); generation was read from a stop-button test id and `Stop answering`-style labels (the new shell relabels one submit button `Stop`); the model picker now opens from `Select ChatGPT model`, and its open state was read from a menu node the new shell's interactive snapshot no longer lists, so the expanded opener with its `Power` and `Select model` items now decides; the tools menu lists Deep research as a button and marks the selected tool with an app mention instead of a pill; the widget frame is named `Deep research` and renders in a block beside the reply instead of inside it, so a live job failed with `deep_research_report_unreadable` while its research ran on, and a reply without its own frame now takes the widget frame of its own exchange (`data-turn-key`), never another's; a pending attachment shows as `Remove <file>`; a bare `input[type=file]` now resolves to a photo/video picker, so the archive goes to the `Attach files` input; and turns carry their message id as `data-chatgpt-selection-message-id` instead of `data-message-id`, which collection now binds to, so recollection keeps exact message identity. The control names of both shells, the composer editor selector, and the stop, attach, and Deep Research selectors now live in one vocabulary in `worker/chatgpt-ui-helpers.mjs` that readiness, auth bootstrap, the worker, and the composer and capture proofs read, so the earlier shell stays supported while the redesign rolls out. The `Work` mode composer (`Work with ChatGPT`) is a different product and is never treated as ready. `npm run proof:capture` now runs the production prompt writer against both the earlier `#prompt-textarea` editor and the new labeled textbox, binds a turn by the new message id, and binds a reply to its own exchange's widget frame
- the preset proof runner read only `browser.chatGptRelayEndpoint`, so with the operator on the managed browser it refused to run. It now follows the operator's own ChatGPT transport: an explicit `PI_ORACLE_PROOF_RELAY`, otherwise the config's relay endpoint or its `browser.chatGptManagedProfileDir`, and it still refuses when the config names neither. The runner prints the exact isolated config its sessions load before the first submit

## 0.4.1 - 2026-09-24

### Fixed
- a ChatGPT job could stop before inserting its prompt with `Could not clear ChatGPT composer draft; prompt was not inserted`. ChatGPT renders a fallback textbox before its editable composer hydrates, and the worker resolved the composer's accessibility reference before clearing, so it cleared and filled that stale fallback. The worker now waits up to 15 seconds for the visible, editable composer, clears and verifies any restored draft, and only then resolves the textbox it fills; a composer that never becomes editable still fails closed with the same error. Observed on an installed 0.3.4 Deep Research job, which failed before sending anything. `npm run proof:capture` runs the production composer writer through delayed hydration with a restored draft, a second replacement, and a noneditable composer
- `scripts/oracle-composer-proof.mjs` drove whichever browser listened on `http://127.0.0.1:9224`, the personal browser relay, unless `ORACLE_COMPOSER_CDP_URL` said otherwise: the silent default 0.3.3 removed from the preset proof runner. It now refuses to run without `ORACLE_COMPOSER_CDP_URL` and prints the endpoint before its first browser command, and the sanity harness fails on any maintained source that gives a browser endpoint a hardcoded loopback fallback

## 0.4.0 - 2026-09-24

### Added
- `browser.chatGptManagedProfileDir`: an opt-in managed ChatGPT browser on an Oracle-dedicated Chrome profile, for account separation without keeping a Chrome running. A job reuses the Chrome serving that profile or starts one (headed, loopback DevTools on an ephemeral port, the three anti-backgrounding flags), drives its own pinned tab as in relay mode, and a keeper process quits a Chrome that Oracle started once no job and no page have used it for two minutes (`PI_ORACLE_MANAGED_BROWSER_IDLE_MS`). A Chrome that Oracle found running is reused and never quit. The endpoint is trusted only while its live browser id matches the one Chrome recorded in the profile, so a stale record never binds the profile to another browser on a reused port, and the worker re-checks that id before every browser command on the job's tab, stopping with `managed_browser_changed` if a different browser has taken the port; a profile open in a Chrome without that record blocks jobs (`managed_browser_in_use`) instead of opening a second instance. `/oracle-auth` opens ChatGPT sign-in in the managed browser, and Deep Research frame capture accepts it as a shared-browser transport like the relay (Deep Research over native CDP has completed through the relay option). The option is agent-level, ChatGPT-only, and exclusive with `browser.chatGptRelayEndpoint`; the directory must stay outside both providers' seed profiles and the runtime profiles directory, and its lock and leases key on the resolved path, so symlinked spellings of it share one browser

### Fixed
- the session footer read `oracle: config error` whenever the ChatGPT relay endpoint was down, with no reason given. A refused connection escaped `assertRelayReady` as the runtime's raw fetch error (`Unable to connect. Is the computer able to access the url?` under Bun), readiness mapping labelled every failure that did not mention an auth seed a config error, the background check discarded the message, and readiness was computed once per session, so the label outlived the outage. The relay check now names the endpoint and cause (`ChatGPT browser relay is unavailable: http://127.0.0.1:9333 (connection refused).`); agents get `relay_unavailable` with a next step instead of `oracle_preflight_failed`, and relay-mode preflight no longer says it checks an auth seed. The footer shows `oracle: browser unavailable` with one warning per distinct cause, and the poller re-runs the check every interval, so the footer recovers when the browser comes back, and flags it when it goes away, without a new session. Footer readiness is derived from the same error codes agents receive, so an unsafe auth seed path now reads as a config error rather than auth needed
- the `browser.args` guard that keeps Oracle's profile and DevTools flags from being overridden matched only `--` switches, but Chromium also parses `-switch` (and `/switch` on Windows) and keeps the last duplicate; operator args come after Oracle's own, so `-user-data-dir=…` or `-remote-debugging-address=0.0.0.0` got past the guard and took effect on isolated launches. The guard now normalizes the prefix before matching

### Changed
- merge upstream `fitchmultz/pi-oracle` through `4d96ffc` with a test-only cutover: order the cancellation/completion regression through worker IPC and the existing locks, cover protected browser roots through symlinked existing and nonexistent descendants, and use native Windows browser roots in cleanup fixtures
- exercise empty-project `/oracle-status` through a real, isolated, persisted Pi session in JSON mode in `test:oracle-helpers`; the test requires one successful display-marked response, no fetch attempts, and no browser job creation, and runs on the existing Pi 0.80.9 lockfile; it does not qualify TUI rendering, print-mode output, or non-empty job summaries
- retain the fork's runtime, package identity, dependency baseline, CI/Dependabot, and release gates rather than importing upstream's shared compatibility fleet, Renovate policy, or Pi 0.86.1 dependency update

## 0.3.4 - 2026-09-21

### Changed
- the archive digest is streamed: `sha256File` read the whole archive into memory before hashing, so every `oracle_submit` allocated up to 250 MiB (the ChatGPT cap) inside the agent's own process; it now pipes the file through the hash. The reported digest is unchanged and is pinned against the bytes on disk
- one subprocess runner: `runCommand` in the shared process helpers replaces four hand-rolled spawn/timeout/kill implementations (both workers' `spawnCommand`, the extension's `cp` clone runner, and its `agent-browser close`), each with its own copy of `killProcessTree`/`killProcess` and `sleep`. The 0.3.3 spawn-options bug had to be fixed twice for exactly this reason. The shared runner is covered directly (stdin piping, safe-storage env scrubbing that keeps caller variables, exit codes, timeout termination, the `allowFailure` contract) and the existing hung-`cp` and hung-`agent-browser` timeout tests now exercise it

## 0.3.3 - 2026-09-21

### Fixed
- the release preset proof runner defaulted the relay endpoint to `http://127.0.0.1:9224`, the personal browser relay, whenever `PI_ORACLE_PROOF_RELAY` was unset; the extension itself has no relay default, so this invented one silently routed eight live ChatGPT jobs to whichever account that browser held. The endpoint now comes from `PI_ORACLE_PROOF_RELAY` or from `browser.chatGptRelayEndpoint` in the operator's agent-scope `oracle.json` (the account real jobs use), is printed with its source before the first submit, and is refused when neither is set; `--dry-run` resolves everything without submitting
- a job run from an installed package recorded the *project's* git HEAD as `extensionProvenance.gitHead` and printed `fatal: not a git repository` into the session: the reader fell back to the working directory when the extension root had no repository. `gitHead` is now recorded only when the extension root itself is a git checkout and omitted otherwise
- the worker called `collectArtifactCandidates` with a third argument the function no longer accepts and fed a `suspiciousArtifactLabels` signal that had been hardcoded empty since the structural capture rewrite; the call matches the function and the dead signal is removed from the completion-signature helpers
- `spawnCommand` in both workers forwarded its own `input`, `allowFailure`, and `timeoutMs` options into `child_process.spawn`
- `oracle_read` and `/oracle-read` now label the saved response as `response-preview:` after the job bookkeeping instead of appending it bare; the blank separator the code intended was filtered out before it ever rendered
- a ChatGPT stop control that outlives its stream no longer holds a job until the 90-minute completion timeout. Observed during the 0.3.3 preset proof: the generation request had returned 200 at t+14 s and the turn was fully rendered with both markers, yet `Stop answering` stayed mounted for 31 minutes, so the worker (correctly treating generation state as the authority) kept waiting. Once the bound turn's text has been non-empty and unchanged for two minutes under a persistent stop control, the worker reloads the conversation, which re-renders the committed turn without the stale control (or with a live one if generation really continues); empty text never ages, so long thinking phases are untouched, and Deep Research keeps its own report polling. Proved on the shipped path with a real job whose tab received an orphaned stop control: `Stop control still present after 121 s … reloading`, then completion 13 s later
- stepping the thinking-effort slider down to `Instant` from a thinking tier can close the whole picker: the Power slider unmounts mid-stepping while the composer pill already reads `Instant`. The driver read that as `Lost the ChatGPT thinking-effort slider while stepping` and failed the job (observed on the second 0.3.3 proof run, `instant` right after `thinking_heavy`). A vanished slider whose closed composer pill already shows the requested stop is now accepted as configured; a closed pill that does not match still fails

### Changed
- `npm run typecheck:worker-runtime` replaces `check:worker-runtime-names`: the 22 `checkJs` diagnostics that gate only reported are fixed (`RelayCdpClient.send` now types its result per CDP method, lease metadata is read as partial untrusted JSON, spawn options and capture fidelity states are annotated), so every diagnostic in `run-job.mjs` now fails `npm run verify:oracle` and the bespoke filter script is gone
- the hidden-tab rendering constraint is documented from measurement: Chrome's `--disable-backgrounding-occluded-windows --disable-renderer-backgrounding --disable-background-timer-throttling` keep an occluded window's active tab rendering but do nothing for a background tab or a minimized window, so the dedicated diligence Chrome launch command recommends them while reload reconciliation stays the correctness fix
- `npm run check:syntax` discovers every `.mjs` source under `extensions/`, `scripts/`, and the repository root with the standard library and parse-checks each one; it replaces five hand-maintained `node --check` chains that had already stopped listing `shared/relay-browser-helpers.mjs` and `worker/response-capture.mjs`. `check:oracle-real-smoke`, `check:oracle-release-proof`, and `check:oracle-proofs` are folded into it; `check:platform-smoke` now runs only the platform-smoke invariants
- `auth-bootstrap.mjs` joins the worker runtime typecheck, closing the same "fails only at runtime" class for the auth worker
- the oracle state directory and the `agent-browser` binary are resolved by shared helpers (`getOracleStateDir`, `resolveAgentBrowserBinary`) instead of three hand-copied constant blocks across the extension and both workers
- the `oracle_submit` preset lookup is built from each canonical id and its label only: the normalizer already collapses case, separators, and punctuation, so the 225 generated separator/case aliases (proved to add no lookup key) and the unused `ORACLE_SUBMIT_PRESET_ACCEPTED_INPUTS` export are gone, along with the unreferenced `writeSeedGeneration`, `protectedCookieSourcePaths`, and `thinkingChipVisible` exports
- documentation claims now match the release ledger: Oh My Pi is recorded as running the fork's source through the eight-preset proof since `0.3.1` (the README and compatibility table previously said no fork job had run on OMP), and the preset proof is described as the eight canonical model presets with `deep_research` excluded rather than "every canonical preset"

## 0.3.2 - 2026-09-21

### Fixed
- stop returning a silently truncated ChatGPT response, and stop hanging on a finished one. Chrome gives a hidden tab no rendering opportunities and ChatGPT appends streamed tokens from that loop, so the job-owned relay tab stops materializing the turn whenever it sits behind another tab or an occluded window; the stop control still clears, because it follows the network stream rather than the DOM, so a frozen partial turn read as a finished one and was captured as the whole response with `collectionStatus: complete`. Generation state is now the authority for "finished", and the streamed read is only a lower bound: the worker reloads the persisted conversation and re-reads the bound turn, which renders correctly even while hidden, keeping whichever read is longer and logging any characters recovered
- completion no longer requires a `Copy response` control. ChatGPT labels a freshly streamed assistant turn's action bar `Copy` and only renames it `Copy response` once the turn is re-rendered from persistence, so counting that label matched no live turn at all and every ChatGPT job waited out the full 90-minute completion timeout

### Added
- `npm run check:worker-runtime-names`: `run-job.mjs` is excluded from both typecheck projects, so a missing import there fails only at runtime, mid-job, after a provider call has already been spent. The gate runs TypeScript's `checkJs` pass over the worker runtime and rejects unresolved-identifier diagnostics

## 0.3.1 - 2026-09-21

### Fixed
- wait for an acknowledged owned-tab close to disappear from Chrome target discovery before releasing runtime ownership; native Chrome can remove the target asynchronously. The bounded wait never reissues close and still rejects a target that remains live
- bind identity-less turns by their normalized text instead of the sanitized HTML, whose class attributes churn between renders: an index-only binding now recollects the same content and still refuses changed content
- stop failing a job whose model settings were already applied: ChatGPT can leave the compact intelligence menu mounted after it closes, with the composer opener already reporting `expanded=false`. That stale node read as open configuration UI, so the worker waited out the whole settle timeout and failed with `Could not verify requested model settings after configuration`, and the same clause also blocked the composer chip from confirming the selection. The opener now owns the `aria-expanded` contract; a menu with no opener to contradict it is still treated as open

### Added
- `npm run release:proof:chatgpt-presets:run`: submits the live eight-preset proof through isolated OMP print-mode sessions and writes the proof file the release checker validates; the Oh My Pi source-loading route is documented in the test plan

## 0.3.0 - 2026-09-20

### Added
- `oracle_read({ jobId, action: "recollect" })`: repeat collection of an already completed, exactly bound turn without sending anything. The worker's separate `--recollect` entrypoint never reaches configure, upload, composer, or send; jobs completed before turn binding existed need the observed `responseIndex` and `messageId` together, and the latest turn is never inferred
- separate generation and collection evidence: `generationStatus`, `collectionStatus` (`complete | partial | failed`) with named required/optional gaps, the exact `collectionBinding`, and `response.capture.json` recording method, fidelity, source URLs, exact code payloads, sanitized bound-turn evidence, and artifact inspection; validated artifact manifests keep identical bytes once and never re-download a validated file; earlier usable bytes survive a failed recollection
- Deep Research native Markdown export collection: the sandboxed widget delegates Export → Export to Markdown to the host page, so the worker pre-arms Chrome's `Page.downloadWillBegin`/`downloadProgress` events and an object-URL registry on the pinned tab and the bound frame before activating the menu, accepts only a download that began in its own tab or the bound report frame tree, reads the bytes from the registered `Blob` (or a `data:` URL), and validates them against Chrome's declared size and the report title. The browser's download destination is never changed (the extension relay does not route `Browser.setDownloadBehavior`), so Chrome keeps its own copy in its configured download directory
- real-Chromium collection proof (`npm run proof:capture`): rich content, generic downloads, nested code, exact message binding across shifted indices, the host-delegated native export byte-identical to the file Chrome saved, idempotent recollection, recollection admission timestamps, and driver teardown serialization; a no-send browser regression exercising the actual worker composer functions against an explicitly owned tab
- `RelayCdpClient.on()` event subscriptions and per-command deadlines for long in-page waits

### Fixed
- a recollecting worker was terminated mid-collection by the extension poller of any live session: terminal-cleanup reconciliation judges a completed, cleanup-pending job's worker by the predecessor's `lastCleanupAt` before `heartbeatAt`, so recollection admission now retires that timestamp and heartbeats throughout
- `agent-browser close` returns while its session daemon is still serving; a same-name command in that window was answered by the dying daemon (orphaned tab, then `Connection refused`). Browser teardown now returns only once the driver no longer lists the session, never closes a session the driver does not list, and never sends an already-gone relay target through the driver
- pending CDP command deadlines held the worker process open (up to 90 s after a completed recollection) and are now cleared on settlement
- review remediation (focused cross-family review of the 0.3.0 candidate): a positional root spanning several message identities fails closed on first capture; Deep Research frame lookup and failure rollback use the message identity learned in the same pass; legacy recollection cannot move a saved turn index; predecessor provenance is persisted as `recollectionPriorWorker` and restored only after a warning-free teardown, with SIGTERM/SIGINT handled; an unreadable driver session inventory is a cleanup error, not evidence of absence; native download collection ignores downloads observed before activation and caps `data:` URLs at 25 MiB; download-registry hooks are restored in exactly the realms that were armed; profile cloning heartbeats through the reconciler's stale window
- recognize actual ChatGPT stop controls when accepting sends and waiting for completion
- bind collection by exact message identity across nested wrappers and shifted indices; avoid duplicating nested code blocks
- recollect completed jobs through fresh, bounded-length browser sessions rather than closed predecessor tabs
- recognize the asynchronous research Export to Markdown menu and retain literal source URLs
- select the actual composer model chip in follow-up chats instead of mistaking response actions such as Pro feedback for model configuration controls
- detect completed composer uploads using parsed UI controls rather than a raw line window that excluded attachments after multiline prompts; retain enabled-send and consecutive-poll checks
- clear large existing ChatGPT drafts with native editor commands and verify the empty state before inserting the replacement
- position the Deep Research pill after the prompt and wait for the animated composer toolbar to become stationary and uncovered before clicking

## 0.2.0 - 2026-09-20

### Added
- added the `deep_research` composer-tool preset: the worker leaves the model picker alone, enables Deep research from the composer tools menu and verifies its pill, attaches the archive, sends, and reads the finished report out of ChatGPT's research widget. The widget is a cross-origin App iframe, so the worker arms CDP frame capture (`Target.setAutoAttach`, which is not retroactive) on its pinned relay tab before sending and polls the attached frame until `Research completed in` appears; relay transport only. Failures are named: `deep_research_clarification_requested` (the model replied instead of starting), `deep_research_toggle_not_found`, and `deep_research_report_unreadable` (isolated profile, frame never attached, or timeout), each with the conversation URL where one exists
- recorded a stable `errorCode` on failed jobs (`job.json` and `oracle_read` details) for failures callers must distinguish

### Changed
- excluded composer-tool presets from the release preset proof, printing the exclusion, because each Deep Research run consumes a research task on the account

### Fixed
- cleared the ChatGPT composer before filling the prompt so a saved draft in the relay-served Chrome no longer prepends itself to the submitted prompt

## 0.1.0 - 2026-09-20

### Added
- added an optional agent-scoped ChatGPT relay endpoint that drives one pinned, job-owned tab in an existing signed-in Chrome without copying cookies
- exposed the existing oracle preflight and submit contract through the OMP programmatic bridge while preserving all agent-facing tool names and durable job fields
- added a GitHub Actions local gate, a GitHub Pages site, Dependabot, and repository security/contributing policies

### Changed
- renamed the npm package to `omp-oracle` so the install path reaches this fork; `pi-oracle` on npm remains the upstream package. Commands, tools, config keys, `PI_ORACLE_*` environment variables, the job directory format, and the `omp.pi-oracle.programmatic.v1` bridge symbol are unchanged
- moved repository, issue, and GitHub installation metadata to the alphastorm-maintained `omp-oracle` fork while retaining upstream history
- restructured the README and `docs/` to match the other `omp-*` projects: architecture, security model, compatibility, operations, test plan, platform smoke, release, and upstream pages replace the previous design, validation, drill, and platform-smoke documents
- restarted versioning at `0.1.0` for the `omp-oracle` package; this first release is based on upstream `pi-oracle` 0.7.20
- made the Crabbox release gate require the macOS and Ubuntu targets only; `windows-native` remains an available target, but the fork owns no Parallels lane, so Windows native support is declared and upstream-validated rather than fork-qualified

### Fixed
- made relay cleanup verify physical target removal and retain durable ownership when the driver omits or fails to close a live target
- drove ChatGPT's slider-based thinking-effort picker by keyboard, verifying each step from the slider's own description, so every preset configures again on the composer that replaced the tier menu (Instant, Medium, High, Extra High, Pro)
- supported current versioned Pro controls and the `Power` plus checked `Latest` transition without treating a closed model label as effort proof
- closed compact model menus by clicking the empty composer when Escape does not dismiss them on continuation pages
- kept Node worker launch, project-trust handling, and transient ChatGPT 403 classification compatible with current OMP runtimes

---

The entries below are inherited upstream `pi-oracle` releases (`fitchmultz/pi-oracle`), kept for
provenance. They were published under the `pi-oracle` npm name, not as `omp-oracle`.

## 0.7.20 - 2026-07-28

### Fixed
- accepted undifferentiated ChatGPT Pro compact menus (bare Pro / Instant 5.5) so pro presets can configure without Standard/Extended rows
- replaced `\S` tool-schema non-blank patterns with a GBNF-safe character class so llama.cpp-backed OpenAI-compatible servers can compile oracle tool schemas

### Validation
- ran the full `npm run release:check` local gate before release

## 0.7.19 - 2026-07-16

### Changed
- refreshed the local Pi/pi-ai development lock, sanity contracts, safe-loader version check, and compatibility guidance for Pi 0.80.9; Oracle does not use the removed SDK auth/session options

## 0.7.18 - 2026-07-14

### Changed
- refreshed the local Pi/pi-ai development lock, sanity contracts, safe-loader version check, and compatibility guidance for Pi 0.80.7
- updated the local Pi and pi-ai development baseline to 0.80.6
- switched provider and mode tool schemas to Pi's Google-compatible `StringEnum` helper

### Fixed
- made the sanity harness independent of the caller's browser profile layout and installed `agent-browser` sessions

## 0.7.17 - 2026-07-01

### Changed
- clarified oracle prompt/docs validation around provider upload ceilings, Node release-gate requirements, and follow-up dispatch rules
- centralized provider normalization, project-trust probing, oracle jobs-dir defaults, and timestamp parsing in narrow source-of-truth modules

### Fixed
- made sanity-runner mode and real-smoke timeout validation fail through tested behavior paths instead of brittle source-string contracts
- removed duplicate worker/auth helper logic for snapshot parsing, URL normalization, conversation ids, and login-probe normalization

### Validation
- ran the full `npm run verify:oracle` local gate before release

## 0.7.16 - 2026-06-24

### Changed
- updated the local pi development and validation baseline to `@earendil-works/*` `0.80.2`
- exposed packaged `/oracle` and `/oracle-followup` prompt templates through the package manifest so TUI slash completion can discover them
- reduced always-on `oracle_submit` prompt metadata while keeping detailed dispatch rules in the prompt templates

### Fixed
- made `/oracle-*` command output visible in JSON mode through a displayed custom message instead of UI notifications only
- deferred Chrome user-agent probing until oracle config is loaded, with a timeout on the Chrome version probe

## 0.7.15 - 2026-06-23

### Changed
- updated the local pi development and validation baseline to `@earendil-works/*` `0.80.1`
- refreshed oracle README and sanity contracts for pi `0.80.1`
- moved script-only `@earendil-works/pi-ai` type imports to `@earendil-works/pi-ai/compat`, matching the Pi 0.80 source typechecking migration guidance

### Compatibility
- reviewed the pi `0.80.0` and `0.80.1` changelogs plus current extension lifecycle, project-trust, security, and package docs; no oracle runtime behavior change was required

### Validation
- ran `npm run release:check`, including `npm run verify:oracle`, fresh live ChatGPT preset proof for every canonical preset, and Crabbox macOS, Ubuntu, and Windows native `platform-build` plus `real-extension` suites

## 0.7.14 - 2026-06-22

### Changed
- updated the local pi development and validation baseline to `@earendil-works/*` `0.79.10`
- refreshed oracle docs and sanity contracts for pi `0.79.10`, and removed the obsolete fleet-tested marker

### Fixed
- used pi's exported `CONFIG_DIR_NAME` for project config and workspace-root detection instead of hardcoding `.pi`
- clarified `oracle_preflight` path labels so isolated-session probes distinguish the current persisted session from the provider auth seed profile
- fixed ChatGPT response completion detection for the current DOM, where assistant text uses `data-message-author-role="assistant"` without legacy `.message-bubble` nodes

### Compatibility
- reviewed the pi `0.79.10` changelog, extension lifecycle docs/types, compaction event docs, project-trust docs, and package/update docs; no oracle compaction hook changes were required

### Validation
- ran `npm run verify:oracle`, `npm run smoke:real:packed`, source-mode isolated pi model-agent smoke with the `instant` preset, and `npm run smoke:platform:all`

## 0.7.13 - 2026-06-15

### Added
- added a release-blocking ChatGPT preset proof gate (`npm run release:proof:chatgpt-presets`) so publishing requires fresh loaded-extension evidence for every canonical ChatGPT preset

### Fixed
- fixed compact ChatGPT Intelligence menu handling so selected thinking tiers that close back to `Medium`, `High`, or `Extra High` composer pills are accepted only after an intentional matching menu click instead of falling through to the removed legacy effort dropdown
- fixed `instant_auto_switch` under the compact ChatGPT UI, where the legacy auto-switch control is absent after selecting the compact `Instant` tier
- made ChatGPT model-configuration opening tolerate slower compact-UI hydration before reporting UI drift
- stabilized archive creation when the compression subprocess exits before tar, so the worker terminates upstream tar immediately instead of waiting for the archive timeout
- surfaced provider rate-limit/outage modals explicitly during ChatGPT model setup, upload, send, and response waits instead of reporting generic UI drift

## 0.7.12 - 2026-06-15

### Changed
- switched Grok oracle submissions to gzip-compressed tar archives (`.tar.gz`) so Grok can extract uploaded context without `zstd`
- centralized provider archive policy for archive format, upload ceiling, and local compression prerequisites
- split oracle archive construction out of the agent-facing tool orchestration module

### Fixed
- preserved ChatGPT `.tar.zst` submissions and `zstd` preflight requirements when ChatGPT is explicitly selected while Grok is the configured default provider

### Validation
- ran the full `npm run verify:oracle` release gate
- verified isolated local `pi` submissions create extractable Grok `.tar.gz` and explicit ChatGPT `.tar.zst` archives

## 0.7.11 - 2026-06-15

### Changed
- updated the local pi development and validation baseline to `@earendil-works/*` `0.79.4`
- refreshed oracle docs and sanity-check baselines for pi `0.79.4`

### Validation
- ran the full `npm run verify:oracle` release gate under pi `0.79.4`

## 0.7.10 - 2026-06-13

### Added
- added explicit existing ChatGPT browser-thread targeting for `/oracle`, `oracle_preflight`, and `oracle_submit` through optional `chatGptConversationId`, accepting raw ChatGPT conversation ids or full `https://chatgpt.com/c/...` / `https://chat.openai.com/c/...` URLs while preserving fresh-thread defaults when omitted

### Validation
- verified existing-thread preflight and submit flows in isolated `pi` sessions, including persisted `chatUrl` / `conversationId` job metadata with a fake worker
- ran the full `npm run verify:oracle` release gate

## 0.7.9 - 2026-06-11

### Fixed
- made oracle workers launch their isolated Chrome runtime directly and attach `agent-browser` via DevTools, avoiding failures when unrelated `agent-browser` sessions or daemons are already running
- tightened worker-owned browser cleanup so runtime profiles are deleted only after the isolated Chrome process has been closed or terminated
- rejected `browser.args` overrides that would bypass oracle-managed Chrome profile or DevTools isolation

### Validation
- verified ChatGPT and Grok oracle smoke tests against the local source extension after the worker-owned browser launch fix

## 0.7.8 - 2026-06-11

### Changed
- updated the local pi development baseline to `@earendil-works/pi-coding-agent` / `@earendil-works/pi-ai` `0.79.1` and regenerated the npm lockfile
- documented `pi` `0.79.1+` as the suggested tested floor while keeping pi runtime packages as optional wildcard peers so npm peer ranges do not block users from trying newer pi releases
- updated isolated local-extension and packed package validation workflows to pass explicit `--approve` when they intentionally trust their temporary project fixtures under Pi 0.79.1 project-trust rules
- made TUI `/oracle` and `/oracle-followup` commands reappear as compact user messages for prompt-history/up-arrow recall while keeping verbose dispatch instructions hidden

### Fixed
- made project-local `.pi/extensions/oracle.json` overrides honor Pi's effective project trust decision (`ctx.isProjectTrusted()`), including `--no-approve` and saved “do not trust” decisions while preserving the historical default of loading safe project overrides for existing oracle users
- updated ChatGPT model-selection handling for the current compact selector labels, including `Extra High`, `Pro Standard`, and `Pro Extended`
- hardened ChatGPT/Grok send handling so oracle workers require provider acceptance evidence before entering `awaiting_response`, preventing unsent composer drafts from masquerading as running jobs
- dismissed ChatGPT Pro feedback dialogs during model configuration instead of mistaking their generic `Close` control for configuration UI

### Compatibility
- reviewed the pi `0.79.1` changelog, project-trust docs, extension docs, package docs, prompt-template docs, SDK/RPC exports, and matching examples; the oracle extension remains compatible with current extension lifecycle and package install/update behavior

## 0.7.7 - 2026-06-08

### Changed
- updated the local pi development baseline to `@earendil-works/pi-coding-agent` / `@earendil-works/pi-ai` `0.79.0` and regenerated the npm lockfile
- documented `pi` `0.79.0+` as the suggested tested floor while keeping pi runtime packages as optional wildcard peers so npm peer ranges do not block users from trying newer pi releases
- updated isolated local-extension and packed package validation workflows to pass explicit `--approve` when they intentionally trust their temporary project fixtures under Pi 0.79.0 project-trust rules

### Fixed
- made project-local `.pi/extensions/oracle.json` overrides honor explicit Pi project-trust opt-outs (`--no-approve` or a saved “do not trust” decision) while preserving the historical default of loading safe project overrides for existing oracle users

### Compatibility
- reviewed the pi `0.79.0` changelog, project-trust docs, extension docs, package docs, prompt-template docs, SDK/RPC exports, and matching examples; the oracle extension remains compatible with current extension lifecycle and package install/update behavior

## 0.7.6 - 2026-06-04

### Changed
- updated the local pi development baseline to `@earendil-works/pi-coding-agent` / `@earendil-works/pi-ai` `0.78.1` and regenerated the npm lockfile
- documented `pi` `0.78.1+` as the suggested tested floor while keeping pi runtime packages as optional wildcard peers so newer pi releases are not blocked by npm peer ranges
- added Ant Ling, NVIDIA NIM, and MiniMax China provider env mappings to the oracle real-smoke/platform-smoke provider metadata

### Fixed
- made startup poller and wake-up routing mode-aware with Pi 0.78.1 `ctx.mode`, so print and JSON one-shot runs do not start background pollers or publish oracle UI status
- guarded oracle startup status and warning notifications with `ctx.hasUI` for non-UI modes

### Compatibility
- reviewed the pi `0.78.1` changelog, extension docs, package docs, prompt-template docs, and matching examples; the oracle extension remains compatible with current extension lifecycle and package install/update behavior

## 0.7.5 - 2026-06-02

### Added
- added a Crabbox platform release smoke gate for macOS, Ubuntu, and Windows native with doctor-first validation, packed-install real-extension proof, stop evidence, and platform artifacts
- added canonical workflow docs and scripts for everyday local validation, focused platform-sensitive runs, and full release/publish smoke coverage

### Changed
- made the default packed real smoke deterministic by installing the packed package into a clean pi project and invoking the installed `oracle_submit` tool path without waiting on a model-agent turn
- made Windows native a supported package OS and moved reusable Windows smoke dependencies into the Parallels template/snapshot workflow

### Fixed
- hardened Windows archive/process/profile handling, including taskkill cleanup, executable resolution, tar/zstd archive behavior, path safety, and auth-bootstrap absolute-path checks
- removed production `as unknown as` casts and switched Linux/Windows runtime profile copies to Node recursive copy instead of relying on POSIX `cp`

### Validation
- verified `npm run verify:oracle`, `git diff --check`, and `npm run smoke:platform:all` across macOS, Ubuntu, and Windows native before release

## 0.7.4 - 2026-05-28

### Changed
- updated the local pi development baseline to `@earendil-works/pi-coding-agent` / `@earendil-works/pi-ai` `0.77.0` and regenerated the npm lockfile
- kept pi runtime packages as optional wildcard peers and removed the Node.js engine upper bound so future pi releases are not blocked at install time

### Compatibility
- reviewed the pi `0.77.0` changelog and package guidance; the oracle extension remains compatible with current extension lifecycle and package install/update behavior

## 0.7.3 - 2026-05-27

### Changed
- updated the local pi development baseline to `@earendil-works/pi-coding-agent` / `@earendil-works/pi-ai` `0.76.0` and regenerated the npm lockfile
- aligned `engines.node` to `>=22.19.0 <25` with the pi `0.76.0` Node.js floor and the supported Node 22–24 range

### Compatibility
- reviewed the pi `0.76.0` changelog and package guidance; the oracle extension remains compatible with current extension lifecycle and package install/update behavior

## 0.7.2 - 2026-05-23

### Changed
- updated the local pi development baseline to `@earendil-works/pi-coding-agent` / `@earendil-works/pi-ai` `0.75.5`, refreshed Node/tsx tooling, and regenerated the npm lockfile
- updated `@steipete/sweet-cookie` to `0.3.0` for the current browser-cookie extraction baseline
- refreshed the `protobufjs` override to `7.6.1` for the current patched dependency graph

### Compatibility
- reviewed the pi `0.75.5` changelog and package guidance; the oracle extension remains compatible with current extension lifecycle and package install/update behavior

## 0.7.1 - 2026-05-18

### Changed
- updated the local pi development baseline to `@earendil-works/pi-coding-agent` `0.75.3` and refreshed the npm lockfile
- raised the local Node.js tooling floor and sanity checks to `>=22.19.0`
- refreshed the `protobufjs` override to `7.5.6` for the current patched dependency graph
- removed tracked CueLoop runtime state from the repository and ignored local `.cueloop/` artifacts

### Compatibility
- reviewed current pi `0.75.3` package and extension guidance and confirmed the oracle extension remains compatible with current extension lifecycle and package install/update guidance


## 0.7.0 - 2026-05-17

### Added
- added Grok Heavy as a second oracle provider, with `provider: "grok"`, Grok-only `mode: "heavy"`, `/oracle-auth grok`, separate Grok auth seed profiles, and provider defaults in oracle config
- added provider-aware `oracle_preflight` support, including explicit Grok checks and follow-up readiness checks that use the prior job's provider
- added Grok web worker support for auth readiness, Heavy selection, archive upload, prompt submission, response extraction, and same-thread follow-ups

### Changed
- documented provider selection, Grok's 200 MiB upload ceiling, ChatGPT's 250 MiB ceiling, and same-provider-only follow-up behavior in README, design docs, and prompt templates
- updated oracle job summaries to report Grok provider/mode selections, not only ChatGPT presets

### Fixed
- preserved Cloudflare continuity cookies for current ChatGPT verification flows and removed Chromium singleton artifacts when cloning runtime profiles
- tightened Grok/X cookie import to an explicit auth-cookie allowlist and made Grok jobs fail clearly if a completed response never produces a stable conversation URL
- improved ChatGPT response extraction fallback behavior when the UI no longer exposes the old `ChatGPT said:` heading structure

### Validation
- verified Grok Heavy live submission and same-thread Grok follow-up using isolated local-extension `pi` sessions
- verified a final ChatGPT `instant` live smoke using an isolated local-extension `pi` session before release

## 0.6.17 - 2026-05-10

### Changed
- made `/oracle-auth` success and failure output easier to scan, with compact source summaries and source-specific troubleshooting for configured Chromium cookie sources
- expanded package support to Linux, using ordinary profile copies off macOS and documenting `@steipete/sweet-cookie`'s Linux keyring/password options for Chromium cookie import
- tightened README quickstart/command wording around preflight-first `/oracle` behavior, context-rich archive selection, cleanup retention, and preset defaults
- added the resolved oracle model preset snapshot to `oracle_submit` queued/dispatched output so agents can see what preset will run
- clarified `oracle_preflight` output so users can see that it validates the persisted pi session, local config, and ChatGPT auth seed created by `oracle_auth`
- made direct `scripts/oracle-sanity.ts` execution fail fast unless isolated oracle state/jobs dirs are provided, preventing accidental sanity-job leakage into live oracle pollers

### Fixed
- stopped worker/auth readiness checks from treating ChatGPT's public logged-out composer shell as an authenticated ready state, and made stale-auth failures name the visible login controls instead of reporting a misleading partial-login state
- made plain `instant` model selection robust against the current ChatGPT model menu by recognizing closed Instant chips and falling back to the top-level model menu when the configure sheet is unavailable

## 0.6.16 - 2026-05-07

### Changed
- migrated the local pi development baseline and peer metadata from deprecated `@mariozechner/*` packages to maintained `@earendil-works/*` `0.74.0`
- regenerated the npm lockfile against the current stable dependency graph and refreshed the `basic-ftp` override to the current patched major

### Compatibility
- reviewed the pi `0.74.0` changelog and confirmed the oracle extension remains compatible with current extension lifecycle and package install/update guidance

## 0.6.15 - 2026-05-03

### Fixed
- anchored the `oracle_submit.files[]` schema pattern so OpenAI-compatible parsers that require anchored JSON Schema regexes, including llama.cpp, can load the oracle tools
- made background poller queued-job promotion best-effort under normal global admission-lock contention, avoiding noisy scan failures when multiple pi sessions are live
- added configured Chromium-family cookie source support for `/oracle-auth`, including macOS Keychain decryption for browser cookie stores not handled by `@steipete/sweet-cookie`

## 0.6.14 - 2026-05-02

### Fixed
- deduped oracle completion wake-ups by marking one-time best-effort delivery in job state before the poller sends the follow-up turn, preventing repeated identical completion notifications across poller scans
- clarified completion wake-up guidance so agents treat the wake-up as a read/inspect prompt rather than an automatic auth refresh or resubmission instruction

### Changed
- `oracle_read` and `/oracle-status` summaries for active jobs now include elapsed time, phase elapsed time, and a poll/backoff hint so manual checks waste fewer turns
- `oracle_submit` preset schema and prompt guidance now list the canonical preset ids directly for tool callers

## 0.6.13 - 2026-05-01

### Changed
- updated the local pi development baseline to `@mariozechner/pi-coding-agent` `0.72.0` and refreshed the TypeBox development dependency graph
- regenerated the npm lockfile against the current stable dependency graph
- aligned pi core peer metadata with current pi package guidance

### Compatibility
- reviewed the pi `0.72.0` changelog and confirmed the oracle extension does not define provider `compat.reasoningEffortMap` metadata and remains compatible with current extension lifecycle and package install/update guidance


## 0.6.12 - 2026-05-01

### Changed
- updated the local pi development baseline to `@mariozechner/pi-coding-agent` `0.71.1` and refreshed the TypeBox development dependency
- regenerated the npm lockfile against the current stable dependency graph

### Compatibility
- reviewed the pi `0.71.1` changelog and confirmed the oracle extension remains compatible with current extension lifecycle, package install/update, and TypeBox 1.x guidance


## 0.6.11 - 2026-04-30

### Fixed
- updated ChatGPT auth/readiness detection and model preset selection for the current ChatGPT UI, including bare effort chips like `Light` and current `Model` controls
- restored generated artifact capture for ChatGPT's current `Download the file` behavior buttons by associating response-local filenames with generic download controls and following the JSON `download_url` indirection to the final file bytes
- reduced false-positive artifact reporting from response text labels that look like filenames but do not have a confirmed downloadable control

### Validation
- verified live `instant`, `thinking_light`, `instant_auto_switch`, `pro_standard`, follow-up, and isolated local-extension oracle runs against the changed ChatGPT UI
- verified byte-correct generated artifact downloads in both live and isolated local-extension runs

## 0.6.10 - 2026-04-23

### Changed
- updated the local pi development baseline to `@mariozechner/pi-coding-agent` `0.70.0`
- regenerated the npm lockfile against the current stable dependency graph

### Compatibility
- reviewed the pi `0.70.0` changelog and confirmed the oracle extension does not depend on the changed terminal progress defaults or the new `--no-builtin-tools` behavior

## 0.6.9 - 2026-04-23

### Changed
- updated the local pi development baseline to `@mariozechner/pi-ai` / `@mariozechner/pi-coding-agent` `0.69.0`
- migrated published TypeBox integration metadata and source imports from `@sinclair/typebox` to `typebox` for pi `0.69.0` compatibility
- updated the local oracle verification flow to externalize `typebox` in the extension bundle check and regenerated the npm lockfile against the current stable dependency graph

### Fixed
- stopped background poller scans from touching stale pi extension contexts after session replacement or reload
- avoided consuming wake-up retry attempts when a stopped poller exits before sending its best-effort reminder

### Compatibility
- reviewed the pi `0.69.0` changelog and confirmed the extension already uses explicit session-scoped objects in the relevant flows while now matching the required TypeBox 1.x package name


## 0.6.8 - 2026-04-21

### Changed
- updated the local pi development baseline to `@mariozechner/pi-ai` / `@mariozechner/pi-coding-agent` `0.68.0`
- regenerated the npm lockfile against the current stable dependency graph

### Compatibility
- reviewed the pi `0.68.0` changelog and confirmed the extension already uses explicit session cwd values instead of relying on removed ambient cwd fallbacks in public helpers

## 0.6.7 - 2026-04-18

### Changed
- bumped the local pi development baseline to `@mariozechner/pi-ai` / `@mariozechner/pi-coding-agent` `0.67.68` and `typescript` `6.0.3`
- refreshed the release lockfile against the current stable pi patch line

### Fixed
- pinned the transitive `basic-ftp` dependency to `5.3.0` and `protobufjs` to `7.5.5` to clear the current audit findings without introducing peer conflicts
- updated the release sanity guard to enforce the patched override versions during future publishes

## 0.6.6 - 2026-04-16

### Changed
- updated the local pi development baseline to `@mariozechner/pi-ai` / `@mariozechner/pi-coding-agent` `0.67.4`
- aligned `packageManager` metadata to `npm@10.9.8`, the latest stable npm line compatible with the declared Node runtime floor
- removed the published `@mariozechner/pi-coding-agent` peer dependency so installs rely on pi's bundled runtime instead of npm peer-resolution churn

## 0.6.5 - 2026-04-15

### Changed
- pinned `packageManager` metadata to `npm@11.12.1` and refreshed the release lockfile against the current stable pi toolchain so `verify:oracle` resolves reproducibly across machines
- kept the published oracle runtime surface unchanged while moving local development dependencies to the current stable pi/TypeScript/Node typing baseline

## 0.6.4 - 2026-04-14

### Changed
- bumped the local development and release toolchain to the latest published pi packages and current TypeScript/esbuild/Node type definitions so release verification now runs against the same pi generation shipping on this machine

### Fixed
- `oracle_submit` archive creation now handles downstream `zstd` pipe failures as normal tool errors instead of crashing the host `pi` process with an unhandled `write EPIPE` on newer Node runtimes
- sanity coverage now exercises the broken-pipe archive path so early downstream compressor exits regress to a clean rejection instead of a process-level crash

## 0.6.3 - 2026-04-13

### Fixed
- workspace-root detection now prefers nearest project markers like `.pi/` and `AGENTS.md` over unrelated ancestor git roots, so oracle submissions from nested projects no longer widen to a home-directory repo and reject valid project-relative archive inputs like `AGENTS.md`
- sanity coverage now guards the nested-project-under-ancestor-git case so archive resolution stays anchored to the intended project root

## 0.6.2 - 2026-04-13

### Changed
- `/oracle` and `/oracle-followup` now treat pre-dispatch `archive_too_large` submit failures as retryable archive-selection misses instead of immediate dead ends, so agents can automatically narrow the archive and retry before surfacing the problem to the user

### Fixed
- archive-too-large submit errors now explain the 250 MB limit in human-readable terms, state that dispatch stopped before launch, and describe an ordered retry plan for shrinking the archive
- oracle tool guidance, docs, and sanity coverage now align on only ending the turn after successful/queued `oracle_submit` results instead of accidentally stopping on a retryable oversize failure

## 0.6.1 - 2026-04-13

### Fixed
- whole-repo archive expansion now merges very large entry groups iteratively instead of using spread/flat patterns that can overflow the JavaScript call stack during `oracle_submit`
- oracle sanity coverage now guards the large-entry merge path so broad archive submissions regress to a real archive/env error instead of `Maximum call stack size exceeded`

## 0.6.0 - 2026-04-13

### Added
- `oracle_auth`, an agent-facing tool that mirrors `/oracle-auth` so oracle runs can refresh the shared ChatGPT auth seed profile before a single retry when stale auth blocks execution

### Changed
- `/oracle` and `/oracle-followup` now follow a stricter preflight-first flow, bias toward context-rich archive selection up to the 250 MB ceiling, and explicitly allow one `oracle_auth` refresh before retrying stale-auth/login-required failures
- package metadata now follows the current pi package dependency guidance by publishing `@mariozechner/pi-coding-agent` and `@sinclair/typebox` as peer dependencies while keeping local typechecking/dev resolution intact

### Fixed
- `/oracle` no-session and missing-seed flows now stop before unnecessary repo exploration, and prompt-template guidance keeps relevant surrounding archive context instead of over-optimizing for minimal slices when extra context still fits
- oracle model selection now recognizes ChatGPT family controls exposed as radios/menu items plus durable closed-chip states like `Extended thinking` and `Extended Pro`, so remembered new-chat defaults no longer derail preset configuration or ready-state detection
- authenticated ready-state detection now accepts extended closed-chip model controls during auth/bootstrap verification, preventing false login/setup failures when ChatGPT remembers a non-default preset

## 0.5.0 - 2026-04-12

### Added
- `oracle_preflight`, a lightweight readiness tool that lets `/oracle` fail fast on missing persisted-session or local auth/config blockers before archive/context work begins

### Changed
- `/oracle` now follows a stricter preflight-first flow, biases toward minimal context gathering for explicitly narrow requests, and prefers the configured default model unless a different preset is clearly needed
- `oracle_read`, `/oracle-status`, and wake-up messaging now keep the true terminal event prominent, separate wake-up bookkeeping from failure state, and stop implying that a missing `response.md` is ready
- `/oracle-auth` failure guidance now reports the effective agent config path for the active agent dir and explains when a project config was also read but could not override `auth.*`
- `/oracle-clean` now documents the short post-send retention grace window and returns a retry-after timestamp when a terminal job is still intentionally retained

### Fixed
- `oracle_submit` now rejects locally knowable auth-seed blockers before archive creation or job persistence while still preserving direct archive-input validation errors like symlink escapes
- oracle tool results now use consistent structured `details.job` / `details.error` payloads and preserve `isError` for structured failures through the tool-result hook
- `/oracle` no-session and missing-seed flows now stop before unnecessary repo exploration, and narrow prompt-template runs dispatch more quickly with smaller archives when the user scope is explicit
- repeated oracle sanity runs now quiesce background pollers before isolated-state teardown so release verification no longer emits a noisy temp-lock ENOENT race

## 0.4.0 - 2026-04-12

### Added
- repeatable isolated local-extension `pi` validation guidance for oracle release verification, including smoke workflows that load the in-repo extension source directly
- persisted oracle lifecycle-event breadcrumbs plus richer detached-job observability in `oracle_submit`, `oracle_read`, poller wake-ups, and `/oracle-status`, including worker-log paths and last-event context
- shared worker/auth validation helpers, shared concurrency primitives, shared lifecycle reducers, and shared observability formatters to keep extension and worker behavior aligned
- extracted sanity-harness support and poller suites with typed helper scaffolding and repeated-run stability coverage

### Changed
- oracle whole-repo archiving now excludes local tool state like `.pi/`, `.oracle-context/`, `.cursor/`, and `.scratchpad.md` by default while preserving explicitly requested paths
- lock/lease recovery, queue promotion, process identity handling, and lifecycle transitions now flow through shared helper modules instead of duplicated inline implementations
- worker/auth verification now leans on behaviorally tested helper modules plus dedicated `typecheck:worker-helpers` coverage instead of syntax checks and brittle source-string assertions alone
- release validation now expects isolated local-extension `pi` smoke tests and a stronger local oracle verification gate before shipping

### Fixed
- archive input resolution now rejects symlink escapes outside the repo root and preserves safer repo-boundary handling for targeted archives
- hung `tar`, `zstd`, `cp`, and auth `agent-browser` subprocesses now time out and fail clearly instead of wedging archive, runtime-clone, or auth flows indefinitely
- cleanup warnings without a live worker no longer consume runtime/conversation capacity forever, while teardown still attempts lease release and preserves warnings for later triage
- detached oracle workers and poller flows now report clearer lifecycle breadcrumbs, wake-up settlement state, and failure context during fast-fail auth/bootstrap scenarios
- sanity-runner cleanup now retries transient temp-directory removal races, and the extracted harness is less timing-fragile and less `any`-driven than the previous monolithic runner

## 0.3.4 - 2026-04-11

### Changed
- oracle archive defaults now exclude nested `secrets/` and `.secrets/` directories anywhere in the repo unless they are explicitly requested
- package metadata now reflects the current runtime floor and platform support (`node >=22`, `darwin`) and local release automation runs `verify:oracle` through `npm test` / `prepublishOnly`

### Fixed
- model verification now distinguishes `thinking`, `pro`, `instant`, and `instant_auto_switch` more conservatively instead of accepting mismatched presets on partial UI evidence
- artifact-only assistant responses can now complete without timing out on missing plain-text bodies
- `/oracle-auth` diagnostics now write into a unique private temp directory per run instead of fixed `/tmp/oracle-auth.*` paths
- sanity coverage now exercises shared ChatGPT UI helpers directly, verifies nested secret exclusion, and guards the new auth diagnostics path handling

## 0.3.3 - 2026-04-11

### Added
- `oracle_submit` now accepts canonical preset ids plus matching human-readable preset labels/common hyphen-space variants and normalizes them back to the canonical preset id at submit time
- lock sweeping now gives in-flight `.tmp-*` lock/state directories a dedicated grace window so concurrent sweep does not delete another process's atomic publish

### Changed
- oracle submit metadata/docs now point preset discovery at the canonical registry/README while keeping execute-time normalization for flexible caller input

### Fixed
- closed a concurrent stale-lock sweep race that could reclaim another process's in-flight lock publish before metadata landed
- oracle sanity coverage now verifies preset alias validation/normalization and the `.tmp-*` grace window behavior end-to-end

## 0.3.2 - 2026-04-08

### Changed
- README now lists the available oracle preset ids directly, so users can choose `defaults.preset` values without having to inspect source files

### Fixed
- closed a README usability gap where preset-based configuration was documented without actually enumerating the shipped preset ids
- oracle sanity coverage now verifies that the README lists every preset from the canonical `ORACLE_SUBMIT_PRESETS` registry

## 0.3.1 - 2026-04-08

### Changed
- rewrote the GitHub-facing README to work better as a landing page, with a sharper value prop, clearer install guidance, a real quickstart, example requests, a minimal config example, troubleshooting, and a high-level flow diagram
- README now explains when to use `pi-oracle`, when not to use it first, where outputs live, and what to do if a wake-up is missed

### Fixed
- removed the stale legacy model wording from the README example flow and aligned user-facing setup docs with the preset-based configuration model

## 0.3.0 - 2026-04-08

### Changed
- breaking: `oracle_submit` and oracle config defaults now use preset-only model selection; legacy `modelFamily` / `effort` / `autoSwitchToThinking` submit inputs and default config fields were removed in favor of canonical preset ids
- oracle jobs now persist a resolved `selection` snapshot and the worker configures ChatGPT from that persisted selection instead of re-deriving model settings from legacy job fields
- oracle model preset definitions now come from a single canonical registry in `extensions/oracle/lib/config.ts`

### Fixed
- removed duplicate hand-maintained preset-id examples from agent-facing prompt and design docs so callers are directed to the tool schema / canonical registry instead of stale inline lists
- oracle sanity coverage now validates the preset-only contract from the registered tool schema and canonical registry instead of brittle prose-only assertions
- worker model configuration now consistently uses the explicit `configureModel(job)` parameter instead of hidden coupling through the module-global current job

## 0.2.2 - 2026-04-07

### Fixed
- missed ChatGPT file artifacts now map generic download controls onto nearby filenames and download from live DOM selectors instead of relying only on filename-labeled snapshot refs
- oracle jobs no longer report a false-clean completion when response-local artifact signals are present but capture fails or remains inconclusive
- artifact label extraction now collapses paths and mixed response text down to real filenames so suspicious artifact fallback logic does not emit bogus labels

### Added
- regression coverage for artifact label extraction edge cases and ambiguous download-control artifact detection

## 0.2.1 - 2026-04-07

### Fixed
- wake-up guidance now tells receivers to use `oracle_read(jobId)` as the canonical way to consume completion results
- manual inspection before the first wake-up no longer suppresses the initial reminder attempt
- wake-up settlement now records provenance so suppressed/settled delivery can be explained in postmortems
- queued archive cleanup retries now retry queued archive deletion and keep warnings until cleanup succeeds
- queued archive byte-pressure accounting now includes retained pre-submit archives instead of only currently queued jobs

## 0.2.0 - 2026-04-06

### Added
- workerless queued oracle jobs with automatic promotion when capacity is available
- queue position/status reporting and queued-job cancellation
- durable wake-up target leasing for cross-process completion notification routing
- oracle now requires a persisted pi session identity instead of collapsing in-memory/no-session contexts onto a shared project-level wake-up target
- legacy project-scoped jobs from the older no-session model now stay manual/status-only on upgrade instead of being adopted by another persisted session for wake-up delivery
- lock and lease metadata publication is now atomic on both first publish and rewrites so concurrent wake-up-target reads cannot transiently hide live sessions
- metadata-less lock/lease state directories left behind by crashes are now reclaimed after a bounded grace instead of wedging future operations forever
- expanded oracle sanity coverage for queueing, recovery, cancellation, promotion, and notification edge cases
- a real TypeScript typecheck gate via `npm run typecheck` and `npm run verify:oracle`

### Changed
- queued jobs now promote using their persisted config snapshot
- runtime admission now stays blocked when cleanup warnings indicate teardown is incomplete
- cleanup-driven promotion only advances the queue after a clean runtime teardown
- orphaned completion wake-ups can be adopted safely when the original session is no longer live
- oracle completion notifications now avoid synthetic assistant session-history writes entirely and rely on durable job-state response/artifact persistence plus best-effort wake-ups

### Fixed
- PID-safe worker cancellation and stale-worker recovery paths
- same-job conversation lease reuse during queued follow-up retries
- cleanup-warning handling across submit, promotion, cancellation, and terminal cleanup flows
- queue advancement after cancellation now requires clean teardown
- cleanup failures no longer silently drop warning state or remove terminal job records prematurely
- stale notification claimants can no longer finalize completion delivery after ownership handoff
- best-effort wake-up retries remain bounded without creating synthetic completion messages in session history, including stale cross-session claimant races
- completed and cancelled jobs now prune on explicit terminal-job retention policy instead of depending on synthetic notification state
- stale live terminal cleanup workers are now terminated and recovered automatically so cleanup-pending jobs do not wedge capacity indefinitely
- prune/clean paths now coordinate with in-flight wake-up delivery so already-prunable jobs are skipped, claimed jobs are not deleted before their reminder send path resolves, and just-sent wake-ups keep their response/artifact files briefly retained
- `/oracle-clean` now refuses terminal jobs whose worker is still live instead of deleting around active cleanup
- live and off-session completion handling no longer risks corrupting active session history with extension-authored assistant appends
- `oracle_read` now reports artifact paths from the configured oracle jobs directory instead of hard-coding `/tmp`
- manual `oracle_read` and `/oracle-status` inspection now settles further wake-up retries so live sessions do not get repeated reminder turns after the job has already been opened
