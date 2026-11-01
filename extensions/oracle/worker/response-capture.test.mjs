import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { archiveTurns, captureExpression, collectNativeDownload, collectionOutcome, composeResearchResponse, durationLabelSeconds, observeConversationExpression, redactTransportSecrets, resolveResearchCitations, validateArtifactBytes } from './response-capture.mjs';
import { formatOracleJobSummary } from '../shared/job-observability-helpers.mjs';
import { chatGptGenerationActive, chatGptStreamingVisible, providerSendAccepted } from './chatgpt-flow-helpers.mjs';

test('accepted continuation recognizes stop controls but not quoted prose', () => {
  const before = { url: 'https://chatgpt.com/c/existing', assistantCount: 3, stopStreaming: false };
  for (const [composer, label] of [['Chat with ChatGPT', 'Stop answering'], ['Chat with ChatGPT', 'Stop streaming'], ['Chat with ChatGPT', 'Stop generating'], ['Ask ChatGPT', 'Stop']]) {
    const snapshot = '- textbox "' + composer + '" [ref=e1]\n- button "' + label + '" [ref=e2]';
    assert(providerSendAccepted(before, { ...before, stopStreaming: chatGptStreamingVisible(snapshot) }));
  }
  assert.equal(chatGptStreamingVisible('- textbox "Stop answering" [ref=e1]\n- button "Send prompt" [ref=e2]\nStop streaming'), false);
  assert.equal(chatGptStreamingVisible('- button "Stop answering" [ref=e1] [disabled]'), false);
  // The redesigned composer relabels one submit button; its Send state is idle.
  assert.equal(chatGptStreamingVisible('- textbox "Ask ChatGPT" [ref=e1]\n- button "Send" [ref=e2]'), false);
});

// Observed live on 2026-09-21: ChatGPT labels a freshly streamed assistant turn's action bar
// "Copy" and only renames it "Copy response" after re-rendering the turn from persistence. The
// completion loop had gated on counting "Copy response", so a live turn never completed (jobs
// hung to the 90-minute timeout) and a mid-rehydration read completed with truncated text.
test('generation state, not the assistant action label, decides that a turn finished', () => {
  const streaming = [
    '- textbox "Chat with ChatGPT" [ref=e1]',
    '- button "Stop answering" [ref=e2]',
    '- button "Copy" [ref=e3]',
  ].join('\n');
  const finishedLiveTurn = [
    '- textbox "Chat with ChatGPT" [ref=e1]',
    '- button "Send prompt" [ref=e2]',
    '- button "Copy" [ref=e3]',
  ].join('\n');

  assert.equal(chatGptGenerationActive({ snapshot: streaming }), true);
  // A finished turn whose only affordance is "Copy" must read as finished; requiring the
  // "Copy response" label here is what hung every ChatGPT job.
  assert.equal(chatGptGenerationActive({ snapshot: finishedLiveTurn }), false);

  // The DOM stop control outranks the labels, so a renamed stop button cannot look finished.
  assert.equal(chatGptGenerationActive({ snapshot: finishedLiveTurn, domStopButton: true }), true);
  // An unreadable probe falls back to the labels rather than failing open.
  assert.equal(chatGptGenerationActive({ snapshot: streaming, domStopButton: undefined }), true);
  assert.equal(chatGptGenerationActive({ snapshot: finishedLiveTurn, domStopButton: false }), false);
});

test('read summaries expose generation and collection independently while legacy records stay readable', () => {
  const base = { id: 'synthetic', status: 'complete', phase: 'complete', createdAt: '2026-01-01T00:00:00Z', projectId: 'p', sessionId: 's' };
  assert(!formatOracleJobSummary(base).includes('collection-status:'));
  const summary = formatOracleJobSummary({ ...base, generationStatus: 'completed', collectionStatus: 'partial', responseCapturePath: '/tmp/response.capture.json',
    collectionBinding: { conversationId: 'c', responseIndex: 1, messageId: 'm-exact' },
    collectionRequiredMissing: ['source-links'], collectionOptionalMissing: ['artifact:optional'] });
  assert.match(summary, /generation-status: completed/);
  assert.match(summary, /collection-status: partial/);
  assert.match(summary, /collection-binding: turn 1 message m-exact/);
  assert.match(summary, /collection-required-missing: source-links/);
  assert.match(summary, /collection-optional-missing: artifact:optional/);
});

test('actual recollection CLI refuses unbound legacy jobs before any browser or submit operation', () => {
  const root = mkdtempSync(join(tmpdir(), 'oracle-legacy-collection-'));
  try {
    const jobs = join(root, 'jobs');
    const directory = join(jobs, 'oracle-legacy');
    mkdirSync(directory, { recursive: true });
    const saved = JSON.stringify({ id: 'legacy', status: 'complete', conversationId: 'synthetic', chatUrl: 'https://chatgpt.com/c/synthetic' });
    writeFileSync(join(directory, 'job.json'), saved);
    assert.throws(() => execFileSync(process.execPath, [fileURLToPath(new URL('./run-job.mjs', import.meta.url)), 'legacy', '--recollect'], {
      env: { ...process.env, PI_ORACLE_JOBS_DIR: jobs, PI_ORACLE_STATE_DIR: join(root, 'state'), AGENT_BROWSER_PATH: '/nonexistent-no-browser-permitted' },
      stdio: 'pipe', encoding: 'utf8', timeout: 10000,
    }), (error) => error.status === 1 && /Legacy recollection requires an explicit responseIndex and messageId/.test(error.stderr));
    assert.equal(readFileSync(join(directory, 'job.json'), 'utf8'), saved);
    assert.deepEqual(readdirSync(directory), ['job.json']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('download payloads must be real complete bytes matching their document format', () => {
  for (const [bytes, fileName] of [
    [Buffer.alloc(0), 'result.txt'],
    [Buffer.from('<!doctype html><html>Sign in</html>'), 'report.pdf'],
    [Buffer.from(JSON.stringify({ download_url: 'https://example.invalid/?signature=secret' })), 'report.md'],
    [Buffer.from('%PDF-1.7\ntruncated'), 'report.pdf'],
    [Buffer.from('Not a PDF'), 'report.pdf'],
    [Buffer.from([0x50,0x4b,3,4,0,0]), 'report.docx'],
  ]) assert.throws(() => validateArtifactBytes(bytes, { fileName }));
  assert.throws(() => validateArtifactBytes(Buffer.from('partial'), { fileName: 'result.txt', expectedSize: 100 }));
  const bytes = Buffer.from('# Report\n\n[Source](https://example.invalid/a?case=synthetic#proof)\n');
  const good = validateArtifactBytes(bytes, { fileName: 'report.md', expectedSize: bytes.length });
  assert.equal(good.detectedType, 'text/plain');
  assert.equal(good.size, bytes.length);
  assert.match(good.sha256, /^[a-f0-9]{64}$/);
});

test('successful empty inspection is not failed or unperformed inspection', () => {
  const base = { hasResponse: true, fidelity: 'exact_code', artifacts: [] };
  assert.deepEqual(collectionOutcome({ ...base, inspection: 'inspected' }), {
    collectionStatus: 'complete', collectionRequiredMissing: [], collectionOptionalMissing: [],
  });
  const failed = collectionOutcome({ ...base, inspection: 'failed' });
  assert.equal(failed.collectionStatus, 'partial');
  assert.deepEqual(failed.collectionRequiredMissing, []);
  assert.deepEqual(failed.collectionOptionalMissing, ['artifact_inspection:failed']);
  assert.equal(collectionOutcome({ ...base, inspection: 'not_performed' }).collectionStatus, 'partial');
  assert.equal(collectionOutcome({ ...base, inspection: 'inspected', artifacts: [{ displayName: 'old.txt' }] }).collectionStatus, 'complete');
});

test('required missing content differs from optional files and zero generation is not success', () => {
  const result = collectionOutcome({ hasResponse: true, fidelity: 'derived_markdown', inspection: 'inspected', artifacts: [
    { candidateId: 'optional', state: 'failed', required: false },
    { candidateId: 'required', state: 'failed', required: true },
    { candidateId: 'good', state: 'validated', required: true },
  ] });
  assert.equal(result.collectionStatus, 'partial');
  assert.deepEqual(result.collectionRequiredMissing, ['artifact:required']);
  assert.deepEqual(result.collectionOptionalMissing, ['artifact:optional']);
  assert.equal(collectionOutcome({ hasResponse: false, fidelity: 'text_only', inspection: 'failed' }).collectionStatus, 'failed');
});

test('stable source query and fragment survive while signed transport URLs do not', () => {
  const stable = 'https://example.invalid/source?case=synthetic&v=1#evidence';
  assert.equal(redactTransportSecrets(stable), stable);
  const redacted = redactTransportSecrets('Failed https://example.invalid/download?X-Amz-Signature=SECRET&X-Amz-Credential=PRIVATE and ' + stable);
  assert(!redacted.includes('SECRET'));
  assert(!redacted.includes('PRIVATE'));
  assert(redacted.includes(stable));
  assert.equal(redactTransportSecrets('https://example.invalid/download?a=1&amp;X-Amz-Signature=HTML_SECRET'), '[transport-url-redacted]');
});

// Fake relay: page session P owns main frame MAIN; frame session F owns the report frame tree.
function fakeRelay(downloads) {
  const listeners = new Map();
  const emit = (method, sessionId, params) => { for (const listener of listeners.get(method) || []) listener({ method, sessionId, params }); };
  const cdp = {
    calls: [],
    on(method, listener) { const set = listeners.get(method) || new Set(); set.add(listener); listeners.set(method, set); return () => set.delete(listener); },
    async evaluate(sessionId, expression) { cdp.calls.push([sessionId, expression.slice(0, 40)]); return undefined; },
    async send(method, params, sessionId) {
      cdp.calls.push([sessionId, method]);
      if (method === 'Page.getFrameTree') return sessionId === 'P'
        ? { frameTree: { frame: { id: 'MAIN' }, childFrames: [{ frame: { id: 'ADS' } }, { frame: { id: 'REPORT' } }] } }
        : { frameTree: { frame: { id: 'REPORT' }, childFrames: [{ frame: { id: 'REPORT_DOC' } }] } };
      if (method === 'Runtime.evaluate') return { result: { value: 1 } };
      return {};
    },
  };
  return { cdp, activate: async () => { for (const [sessionId, begin, done] of downloads) { emit('Page.downloadWillBegin', sessionId, begin); if (done) emit('Page.downloadProgress', sessionId, done); } return { activated: true }; } };
}

test('native download collection binds to the tab main frame or bound report tree and reads only UI-exposed bytes', async () => {
  const report = '# Report\n\n[Source](https://example.invalid/a?case=synthetic#proof)\n';
  const data = 'data:text/markdown;charset=utf-8,' + encodeURIComponent(report);
  const ok = fakeRelay([['F', { frameId: 'REPORT_DOC', guid: 'g1', url: data, suggestedFilename: 'report.md' }, { guid: 'g1', totalBytes: Buffer.byteLength(report), receivedBytes: Buffer.byteLength(report), state: 'completed' }]]);
  const collected = await collectNativeDownload({ cdp: ok.cdp, pageSessionId: 'P', frameSessionId: 'F', activate: ok.activate, timeoutMs: 2_000 });
  assert.equal(Buffer.from(collected.bytesBase64, 'base64').toString(), report);
  assert.deepEqual([collected.fileName, collected.expectedSize, collected.native.source, collected.native.frameId], ['report.md', Buffer.byteLength(report), 'data', 'REPORT_DOC']);
  assert.deepEqual(ok.cdp.calls.filter(([, name]) => name === 'Page.enable').map(([session]) => session), ['P', 'F'], 'events are armed on both sessions before activation');
  assert.equal(ok.cdp.calls.filter(([, name]) => name.startsWith('(function disarm')).length, 2, 'registries are restored');

  const foreign = fakeRelay([['P', { frameId: 'ADS', guid: 'g2', url: data, suggestedFilename: 'x.md' }, { guid: 'g2', totalBytes: 1, receivedBytes: 1, state: 'completed' }]]);
  await assert.rejects(collectNativeDownload({ cdp: foreign.cdp, pageSessionId: 'P', frameSessionId: 'F', activate: foreign.activate, timeoutMs: 500 }), /outside the bound frame tree/);

  const canceled = fakeRelay([['P', { frameId: 'MAIN', guid: 'g3', url: data, suggestedFilename: 'x.md' }, { guid: 'g3', totalBytes: 0, receivedBytes: 0, state: 'canceled' }]]);
  await assert.rejects(collectNativeDownload({ cdp: canceled.cdp, pageSessionId: 'P', frameSessionId: 'F', activate: canceled.activate, timeoutMs: 500 }), /canceled/);

  const transport = fakeRelay([['P', { frameId: 'MAIN', guid: 'g4', url: 'https://files.example.invalid/export?X-Amz-Signature=SECRET', suggestedFilename: 'x.md' }, { guid: 'g4', totalBytes: 5, receivedBytes: 5, state: 'completed' }]]);
  await assert.rejects(collectNativeDownload({ cdp: transport.cdp, pageSessionId: 'P', frameSessionId: 'F', activate: transport.activate, timeoutMs: 500 }), /transport URL/);
  assert(!transport.cdp.calls.some(([, name]) => name.startsWith('(async function readRegistered')), 'no fetch or registry read for transport URLs');

  const silent = fakeRelay([]);
  await assert.rejects(collectNativeDownload({ cdp: silent.cdp, pageSessionId: 'P', frameSessionId: 'F', activate: silent.activate, timeoutMs: 300 }), /did not start a browser download/);
});

test('native download collection ignores downloads observed before activation and caps data URLs', async () => {
  const report = '# Report\n';
  const data = (text) => 'data:text/markdown;charset=utf-8,' + encodeURIComponent(text);
  const listeners = new Map();
  const emit = (method, sessionId, params) => { for (const listener of listeners.get(method) || []) listener({ method, sessionId, params }); };
  const cdp = {
    on(method, listener) { const set = listeners.get(method) || new Set(); set.add(listener); listeners.set(method, set); return () => set.delete(listener); },
    async evaluate() { return undefined; },
    async send(method, params, sessionId) {
      if (method === 'Page.enable' && sessionId === 'P') {
        // A download that begins while arming is not caused by the export control.
        emit('Page.downloadWillBegin', 'P', { frameId: 'MAIN', guid: 'early', url: data('# Early\n'), suggestedFilename: 'early.md' });
        emit('Page.downloadProgress', 'P', { guid: 'early', totalBytes: 8, receivedBytes: 8, state: 'completed' });
      }
      if (method === 'Page.getFrameTree') return sessionId === 'P' ? { frameTree: { frame: { id: 'MAIN' } } } : { frameTree: { frame: { id: 'REPORT' } } };
      if (method === 'Runtime.evaluate') return { result: { value: 1 } };
      return {};
    },
  };
  const activate = async () => {
    emit('Page.downloadWillBegin', 'P', { frameId: 'MAIN', guid: 'export', url: data(report), suggestedFilename: 'report.md' });
    emit('Page.downloadProgress', 'P', { guid: 'export', totalBytes: Buffer.byteLength(report), receivedBytes: Buffer.byteLength(report), state: 'completed' });
    return { activated: true };
  };
  const collected = await collectNativeDownload({ cdp, pageSessionId: 'P', frameSessionId: 'F', activate, timeoutMs: 2_000 });
  assert.equal(collected.native.guid, 'export');
  assert.equal(Buffer.from(collected.bytesBase64, 'base64').toString(), report);

  const oversized = 'data:text/markdown;base64,' + Buffer.alloc(25 * 1024 * 1024 + 1).toString('base64');
  const bigActivate = async () => {
    emit('Page.downloadWillBegin', 'P', { frameId: 'MAIN', guid: 'big', url: oversized, suggestedFilename: 'big.md' });
    emit('Page.downloadProgress', 'P', { guid: 'big', totalBytes: 25 * 1024 * 1024 + 1, receivedBytes: 25 * 1024 * 1024 + 1, state: 'completed' });
    return { activated: true };
  };
  await assert.rejects(collectNativeDownload({ cdp, pageSessionId: 'P', frameSessionId: 'F', activate: bigActivate, timeoutMs: 2_000 }), /exceeds capture limit/);
});

// Token and reference shapes observed in a finished report's widget state on 2026-10-06: the
// Markdown carries U+E200 cite (U+E202 ref)+ U+E201 tokens, and each content reference repeats the
// token in matched_text with the sources the widget renders as a numbered pill.
const cite = (...refs) => `\ue200cite\ue202${refs.join('\ue202')}\ue201`;
const reportReferences = [
  { matchedText: cite('turn0view0'), type: 'grouped_webpages', sources: [{ title: 'Alpha [annual] report', url: 'https://alpha.example/report' }], safeUrls: [] },
  { matchedText: cite('turn0view0', 'turn1search2'), type: 'grouped_webpages', sources: [{ title: 'Alpha [annual] report', url: 'https://alpha.example/report?utm_source=chatgpt.com' }, { title: 'Beta', url: 'https://beta.example/b?page=2&utm_source=chatgpt.com' }], safeUrls: [] },
  { matchedText: cite('turn2view1'), type: 'grouped_webpages', sources: [], safeUrls: ['https://gamma.example/g'] },
];

test('research citation tokens become numbered footnotes; an unknown token stays a visible gap', () => {
  const fence = '```mermaid\ngraph TD\n  A --> B\n```';
  const markdown = `# Findings\n\nFirst claim.${cite('turn0view0')}\n\nSecond claim.${cite('turn0view0', 'turn1search2')}\n\n${fence}\n\nThird claim.${cite('turn2view1')} Fourth.${cite('turn9view9')}`;
  const resolved = resolveResearchCitations(markdown, reportReferences);
  assert.equal(resolved.tokens, 4);
  assert.match(resolved.markdown, /First claim\.\[\^1\]\n/);
  assert.match(resolved.markdown, /Second claim\.\[\^1\]\[\^2\]\n/, 'a repeated source keeps its first number, with or without ChatGPT\'s referral parameter');
  assert.match(resolved.markdown, /Third claim\.\[\^3\] Fourth\.\[\^4\]/);
  assert(resolved.markdown.includes(`\n${fence}\n`), 'diagram source survives exactly');
  assert(resolved.markdown.includes('[^1]: [Alpha \\[annual\\] report](https://alpha.example/report)'));
  assert(resolved.markdown.includes('[^2]: [Beta](https://beta.example/b?page=2)'), 'only the referral parameter is dropped');
  assert(resolved.markdown.includes('[^3]: <https://gamma.example/g>'), 'a reference without titled sources falls back to its safe URLs');
  assert(resolved.markdown.includes('[^4]: Unresolved citation (cite turn9view9): the report did not expose its source.'));
  assert.deepEqual(resolved.unresolved, ['cite turn9view9']);
  assert.equal(/[\ue200-\ue202]/.test(resolved.markdown), false, 'no private-use token survives');
  // Code is never rewritten, even when it contains token characters.
  const literal = `\`\`\`text\n${cite('turn0view0')}\n\`\`\``;
  assert.equal(resolveResearchCitations(literal, reportReferences).markdown, literal);
});

test('a research response prefers the native export, then the widget state, and declares DOM-only gaps', () => {
  const capture = { markdown: 'Rendered claim [1].\n\n_[Diagram not captured: the page shows it as an image without its source.]_', citationPills: ['1', '1'], diagramsWithoutSource: 1,
    sources: [{ id: 'source-1', kind: 'citation', label: 'Alpha', url: 'https://alpha.example/report' }] };
  const reportState = { complete: true, markdown: `Widget claim.${cite('turn0view0')}`, references: reportReferences };
  const native = composeResearchResponse({ capture, reportState, nativeMarkdown: `# Native\n\nNative claim.${cite('turn0view0')}` });
  assert.equal(native.method, 'native_report_download');
  assert.match(native.markdown, /Native claim\.\[\^1\]/);
  assert.deepEqual(native.requiredMissing, []);
  assert.deepEqual(native.citations, { tokens: 1, sources: 1, unresolved: [] });
  const widget = composeResearchResponse({ capture, reportState });
  assert.equal(widget.method, 'report_widget_state');
  assert.equal(widget.fidelity, 'native_markdown');
  assert.match(widget.markdown, /Widget claim\.\[\^1\]/);
  const dom = composeResearchResponse({ capture });
  assert.equal(dom.method, 'scoped_dom');
  assert.deepEqual(dom.requiredMissing, ['diagram_source:1']);
  assert.deepEqual(dom.sources.filter((source) => source.unresolved).map((source) => source.label), ['citation 1'], 'each rendered pill is one unresolved source');
});

test('reasoning-time labels convert to seconds only when they carry a duration', () => {
  assert.equal(durationLabelSeconds('Worked for 15m 7s'), 907);
  assert.equal(durationLabelSeconds('Thought for 40 seconds'), 40);
  assert.equal(durationLabelSeconds('Worked for 1h 2m'), 3720);
  assert.equal(durationLabelSeconds('Thought for a few seconds'), undefined);
});

// Observed live on 2026-10-28: ChatGPT's screen-reader turn headings gained a hidden print span, so
// their textContent reads "ChatGPT said:ChatGPT" / "You said:You". The observation matched the
// heading text exactly, saw no assistant turn, and a finished Deep Research job waited 80 minutes
// for a turn it could not see. Headings are matched by prefix now.
test('turn headings match by prefix so the hidden print-formatting suffix is ignored', () => {
  const reply = { cloneNode: () => ({ innerText: 'Launched.' }), innerText: 'Launched.' };
  const heading = (text) => ({ textContent: text, getAttribute: () => null, nextElementSibling: reply });
  const location = { href: 'https://chatgpt.com/c/abc123', pathname: '/c/abc123' };
  const observe = (headings) => new Function('document', 'location',
    'return ' + observeConversationExpression({ conversationId: 'abc123', stopSelector: '[data-testid="stop-button"]' }))(headingDocument(headings), location);
  for (const text of ['ChatGPT said:', 'ChatGPT said:ChatGPT', ' ChatGPT said:ChatGPT ']) {
    assert.deepEqual(observe([heading('You said:You'), heading(text)]).messages, [{ text: 'Launched.' }], text);
  }
  assert.deepEqual(observe([heading('You said:You'), heading('Latest response')]).messages, []);
});

function headingDocument(headings, named = []) {
  return {
    querySelectorAll: (selector) => selector.startsWith('h1') ? headings : selector === 'body *' ? named : [],
    createElement: () => {
      const host = { style: {}, child: undefined, appendChild(node) { host.child = node; }, remove() {} };
      Object.defineProperty(host, 'innerText', { get: () => host.child?.innerText || '' });
      return host;
    },
    body: { appendChild() {} },
  };
}

function plainReply(text) {
  return {
    nodeType: 1, tagName: 'DIV', attributes: [], childNodes: [{ nodeType: 3, textContent: text }],
    textContent: text, innerText: text, outerHTML: `<div>${text}</div>`,
    getAttribute: () => null, querySelector: () => null, querySelectorAll: () => [], closest: () => null,
    cloneNode: () => plainReply(text),
  };
}

test('assistant conversation-role headings are observed without the English heading label', () => {
  const reply = plainReply('Role-marked reply.');
  const heading = (role) => ({ textContent: 'Assistant', getAttribute: (name) => name === 'data-conversation-role' ? role : null, nextElementSibling: reply });
  const location = { href: 'https://chatgpt.com/c/abc123', pathname: '/c/abc123' };
  const document = headingDocument([heading('user'), heading('assistant')]);
  const result = new Function('document', 'location', 'return ' + observeConversationExpression({ conversationId: 'abc123' }))(document, location);
  assert.deepEqual(result.messages, [{ text: 'Role-marked reply.' }]);
});

test('assistant conversation-role headings bind capture without legacy message nodes', () => {
  const reply = plainReply('Bound role-marked reply.');
  const heading = { textContent: 'Assistant', getAttribute: (name) => name === 'data-conversation-role' ? 'assistant' : null, nextElementSibling: reply };
  const result = new Function('document', 'return ' + captureExpression({ responseIndex: 0 }))(headingDocument([heading]));
  assert.equal(result.rawText, 'Bound role-marked reply.');
  assert.equal(result.markdown, 'Bound role-marked reply.');
});

test('assistant conversation-role headings exclude archive mentions from user-turn binding', () => {
  const fileName = 'oracle-job.tar.zst';
  const userTurn = { id: 'user' };
  const assistantTurn = { id: 'assistant' };
  const attachment = (turn) => ({ textContent: fileName, getAttribute: () => null, closest: () => turn });
  const upload = attachment(userTurn);
  const mention = attachment(assistantTurn);
  const reply = plainReply(fileName);
  reply.contains = (node) => node === mention;
  const heading = { textContent: 'Assistant', getAttribute: (name) => name === 'data-conversation-role' ? 'assistant' : null, nextElementSibling: reply };
  const result = new Function('document', 'fileName', `return (${archiveTurns.toString()})(fileName);`)(headingDocument([heading], [upload, mention]), fileName);
  assert.deepEqual(result, [userTurn]);
});
