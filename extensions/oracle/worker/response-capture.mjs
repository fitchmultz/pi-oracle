// Browser-side capture deliberately has no closure dependencies: the worker evaluates this
// same function in the owned page or bound report frame; synthetic proofs use it unchanged.
import { createHash } from "node:crypto";

// The user turns on the page that show `fileName` (this job's own archive) as an attachment: a leaf
// element whose whole text is the name, or a control named for it, outside every assistant reply,
// so a reply that merely mentions the name never counts. Closure-free like captureScopedResponse.
export function archiveTurns(fileName) {
  const assistantSelector = '[data-message-author-role="assistant"], [data-testid="assistant-message"]';
  const replies = [...document.querySelectorAll(assistantSelector),
    ...[...document.querySelectorAll('h1,h2,h3,h4,h5,h6,[role="heading"]')].filter((node) => /^ChatGPT said:/.test(node.textContent?.trim() || '') || node.getAttribute('data-conversation-role') === 'assistant').map((node) => node.nextElementSibling)]
    .filter(Boolean);
  const named = [...document.querySelectorAll('body *')].filter((node) => ((!node.firstElementChild && (node.textContent || '').trim() === fileName)
    || node.getAttribute('aria-label') === fileName || node.getAttribute('title') === fileName) && !replies.some((reply) => reply.contains(node)));
  return [...new Set(named.map((node) => node.closest('[data-message-author-role="user"]') || node.closest('[data-turn-key]')).filter(Boolean))];
}

export function captureScopedResponse({ responseIndex = 0, messageId, report = false, conversationId, anchorFileName } = {}, archiveTurnsOf = undefined) {
  const doc = document;
  // The conversation is read in the same evaluation as the turn, so a navigation can never pair one
  // conversation's location with another conversation's turn. A report frame is a cross-origin
  // document; its caller guards the host page instead.
  if (!report && conversationId !== undefined) {
    const observed = location.pathname.match(/\/(?:c|chat)\/([A-Za-z0-9-]+)$/i)?.[1];
    if (observed !== conversationId) {
      throw new Error(`Bound conversation mismatch: the page shows ${observed ? `conversation ${observed}` : location.pathname}, not ${conversationId}.`);
    }
  }
  const assistantSelector = '[data-message-author-role="assistant"], [data-testid="assistant-message"]';
  const nodes = [...doc.querySelectorAll(assistantSelector)].filter((node) => !node.parentElement?.closest(assistantSelector));
  const headings = [...doc.querySelectorAll('h1,h2,h3,h4,h5,h6,[role="heading"]')]
    .filter((node) => /^ChatGPT said:/.test(node.textContent?.trim() || "") || node.getAttribute('data-conversation-role') === 'assistant');
  const headingRoots = headings.map((heading) => heading.nextElementSibling);
  const responseRoots = headingRoots.some((node) => (node?.textContent || '').trim()) ? headingRoots : nodes;
  // The earlier shell marks a message with data-message-id; the redesigned one marks the turn root
  // after its "ChatGPT said:" heading with data-chatgpt-selection-message-id.
  const idAttributes = ["data-message-id", "data-chatgpt-selection-message-id"];
  const rootIds = (node) => new Set(idAttributes.flatMap((name) => [node.getAttribute(name), node.closest(`[${name}]`)?.getAttribute(name),
    ...[...node.querySelectorAll(`[${name}]`)].map((child) => child.getAttribute(name))]).filter(Boolean));
  const rootId = (node) => {
    if (!node) return undefined;
    const ids = rootIds(node);
    return ids.size === 1 ? [...ids][0] : undefined;
  };
  // A turn saved without its message ID is found again through the user turn that carries this
  // job's own archive: that exchange is the job's, and its first reply must sit at the saved index.
  const anchoredRoot = () => {
    if (typeof archiveTurnsOf !== 'function') throw new Error('Anchored capture needs the archive-turn locator.');
    const turns = archiveTurnsOf(anchorFileName);
    if (turns.length !== 1) {
      throw new Error(turns.length ? 'The job archive appears in several user turns; refusing anchored recollection.'
        : 'No user turn on this page carries the job archive; anchored recollection is impossible.');
    }
    const turn = turns[0];
    const follows = (first, second) => Boolean(first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING);
    const nextUser = [...doc.querySelectorAll('[data-message-author-role="user"]'),
      ...[...doc.querySelectorAll('h1,h2,h3,h4,h5,h6,[role="heading"]')].filter((node) => /^You said:/.test(node.textContent?.trim() || ''))]
      .filter((marker) => !turn.contains(marker) && follows(turn, marker))
      .reduce((earliest, marker) => (!earliest || follows(marker, earliest) ? marker : earliest), undefined);
    const reply = responseRoots.find((candidate) => candidate && (turn.contains(candidate) || follows(turn, candidate)) && (!nextUser || follows(candidate, nextUser)));
    if (!reply) throw new Error('The reply to the job archive turn is not rendered.');
    const index = responseRoots.indexOf(reply);
    if (index !== responseIndex) throw new Error(`The reply to the job archive turn is assistant turn ${index}, not the saved turn ${responseIndex}; refusing anchored recollection.`);
    return reply;
  };
  const matches = messageId && !report ? responseRoots.filter((node) => rootId(node) === messageId) : [];
  if (messageId && !report && matches.length !== 1) throw new Error("Bound response message ID is absent or ambiguous.");
  const root = report ? doc.querySelector('[data-report-id], [data-testid="research-report"], main, article') || doc.body
    : messageId ? matches[0] : anchorFileName ? anchoredRoot() : responseRoots[responseIndex];
  if (!root) throw new Error("Bound response root is absent; whole-conversation capture is forbidden.");
  // A positional root that spans several message identities is not one turn: refuse it rather
  // than bind a content hash to an unknown mixture. A root with no identity at all (UI drift)
  // still binds positionally by content hash, which recollection then refuses unless it matches.
  if (!report && rootIds(root).size > 1) throw new Error("Bound response root spans several message IDs; refusing an ambiguous turn.");
  const actualId = rootId(root);
  if (messageId && actualId !== messageId) throw new Error("Bound response message ID does not match.");
  // The turn's reasoning-time label ("Worked for 15m 7s", "Thought for 40s") sits in its exchange's
  // activity header, a span outside the reply root (observed 2026-10-06); reply text never counts.
  // The earlier shell, without exchanges, showed it as a control inside the turn.
  const exchange = report ? undefined : root.closest('[data-turn-key]');
  const durationPattern = /^(?:Worked|Thought|Reasoned) for (?:(?:\d+\s*(?:h|m|s|hours?|minutes?|seconds?)\s*)+|a few seconds|a second)$/i;
  const durationLabel = report ? undefined : [...(exchange ? exchange.querySelectorAll('span,div,button,[role="button"]') : root.querySelectorAll('button,[role="button"]'))]
    .filter((node) => !exchange || (!root.contains(node) && !node.contains(root) && !node.closest('[data-message-author-role="user"]')))
    .map((node) => (node.textContent || '').replace(/\s+/g, ' ').trim())
    .find((text) => durationPattern.test(text));
  const safeUrl = (value) => {
    try {
      const url = new URL(value, doc.baseURI);
      if (!/^https?:$/.test(url.protocol)) return undefined;
      if ([...url.searchParams.keys()].some((key) => /^(?:x-amz-.+|x-goog-.+|sig|signature|token|access_token|auth|key-pair-id|policy|expires|se|sp|sv)$/i.test(key))) return undefined;
      return url.href;
    } catch { return undefined; }
  };
  // ChatGPT marks a reply's file with a `download` attribute or serves it from its own origin
  // (sandbox:, blob:, /files/, estuary/content) or OpenAI's user-content host. Any other link to
  // another site is a citation whatever its path or label says: activating one opens a third-party
  // tab and then waits out the download deadline (a `GitHub +1` source pill on a raw `.md` URL,
  // observed 2026-10-16).
  const citationLink = (node) => {
    if (node.tagName !== 'A' || node.hasAttribute('download')) return false;
    try {
      const url = new URL(node.getAttribute('href') || '', doc.baseURI);
      return /^https?:$/.test(url.protocol) && url.origin !== new URL(doc.baseURI).origin && !/(?:^|\.)oaiusercontent\.com$/i.test(url.hostname);
    } catch { return false; }
  };
  const sources = [...root.querySelectorAll('a[href]')].map((node, index) => {
    const href = node.getAttribute('href') || '';
    const url = safeUrl(href);
    const artifact = !citationLink(node) && (node.hasAttribute('download') || /sandbox:|\/files\/|estuary\/content|blob:/.test(href));
    return { id: `source-${index + 1}`, kind: artifact ? 'artifact' : 'citation', label: node.textContent || node.getAttribute('aria-label') || '', ...(url ? { url } : { unresolved: true }) };
  });
  // A runnable block (Python, with a Run button) is a CodeMirror editor: `.cm-content` holds one
  // `.cm-line` row per line, rendered only near the viewport. Its full text is the editor's own
  // document, which the page exposes as `cmTile.view` (observed 2026-10-17); the static clone gets
  // that document back as rows, so the derived Markdown and the saved HTML hold every line.
  const editorText = (content) => {
    try {
      const text = content.cmTile?.view?.state?.doc?.toString();
      if (typeof text === 'string') return text;
    } catch {}
    return [...content.querySelectorAll('.cm-line')].map((line) => line.textContent || '').join('\n');
  };
  const clone = root.cloneNode(true);
  const liveEditors = [...root.querySelectorAll('.cm-content')];
  clone.querySelectorAll('.cm-content').forEach((editor, index) => editor.replaceChildren(...editorText(liveEditors[index]).split('\n')
    .map((line) => Object.assign(doc.createElement('div'), { className: 'cm-line', textContent: line }))));
  clone.querySelectorAll('script,style,form,input,textarea').forEach((node) => node.remove());
  for (const node of [clone, ...clone.querySelectorAll('*')]) {
    for (const attribute of [...node.attributes]) {
      if (attribute.name === 'href') {
        const url = safeUrl(attribute.value);
        if (url) node.setAttribute('href', url); else node.removeAttribute('href');
      } else if (!['class','role','aria-label','colspan','rowspan','data-message-id','data-message-author-role','data-report-id'].includes(attribute.name)) {
        node.removeAttribute(attribute.name);
      }
    }
  }
  // A code block is a `pre` (the earlier shell names its language in a `language-*` class) or the
  // redesigned shell's `CodeBlock-…` container, whose action bar names it ("YAML") beside the copy
  // and wrap buttons. A live reply nests a `pre` in that container, a reloaded conversation renders
  // a bare block `code` (both observed 2026-10-16), and a runnable block holds an editor. The
  // outermost block wins, so neither a presentation `pre` nor a container's own `pre` is counted
  // twice.
  const CODE = 'code, .cm-content';
  const isCodeContainer = (node) => node.tagName !== 'PRE' && /(?:^|\s)CodeBlock-/.test(node.getAttribute('class') || '') && Boolean(node.querySelector(CODE));
  const isBlock = (node) => node.tagName === 'PRE' || isCodeContainer(node);
  // A rendered diagram is an SVG inside the code frame: its text is layout, never the diagram source.
  const isDiagram = (block) => Boolean(block.querySelector('svg')) && !block.querySelector(CODE);
  const blockCode = (block) => block.querySelector('pre code') || block.querySelector(CODE) || block;
  const blockText = (code) => code.matches('.cm-content') ? editorText(code) : code.textContent || '';
  const blockLanguage = (block, code) => {
    const declared = (code.className || '').match(/language-([\w-]+)/)?.[1];
    if (declared) return declared;
    const label = [...block.querySelectorAll('div,span')].find((leaf) => !leaf.firstElementChild && !leaf.contains(code) && !code.contains(leaf)
      && !leaf.closest('button,[role="button"]') && (leaf.textContent || '').trim())?.textContent?.trim() || '';
    return /^[A-Za-z][\w+#-]{0,31}$/.test(label) ? label.toLowerCase() : '';
  };
  const insideBlock = (node) => {
    for (let up = node.parentElement; up && root.contains(up); up = up.parentElement) if (isBlock(up)) return true;
    return false;
  };
  const codeBlocks = [...root.querySelectorAll('pre, [class*="CodeBlock-"]')].filter((node) => isBlock(node) && !insideBlock(node) && !isDiagram(node)).map((block, index) => {
    const code = blockCode(block);
    return { index, language: blockLanguage(block, code), text: blockText(code) };
  });
  const sourceUrls = new Set(sources.flatMap((source) => source.url ? [source.url] : []));
  const addLiteralSources = (text) => {
    for (const match of text.matchAll(/https?:\/\/[^\s<>)\]]+/g)) {
      const url = safeUrl(match[0]);
      if (!url || sourceUrls.has(url)) continue;
      sourceUrls.add(url);
      sources.push({ id: `source-${sources.length + 1}`, kind: 'citation', label: match[0], url });
    }
  };
  for (const block of codeBlocks) addLiteralSources(block.text);
  addLiteralSources(root.innerText || root.textContent || '');
  const citationPills = [];
  let diagramsWithoutSource = 0;
  const render = (node) => {
    if (node.nodeType === 3) return node.textContent || '';
    if (node.nodeType !== 1) return '';
    const tag = node.tagName.toLowerCase();
    if (['script','style','button','svg','iframe','form'].includes(tag)) return '';
    // An animated counter (the research widget's citation and search odometers) is an image whose
    // accessible name is the number; its digit strips are presentation.
    if (node.getAttribute('role') === 'img' && node.hasAttribute('aria-label')) return node.getAttribute('aria-label') || '';
    if (report) {
      // The research widget's status line ("Research completed in …") is chrome, not report body.
      if (/^Research completed in\b/i.test((node.textContent || '').trim()) && !node.querySelector('h1,h2,h3,h4,h5,h6,p,li,table,pre,blockquote')) return '';
      // A citation pill shows only its source number; the link lives in the widget's state, so the
      // number stays a visible marker and the caller reports it as unresolved.
      if (tag === 'sup' && node.getAttribute('role') === 'button') {
        const label = (node.textContent || '').trim();
        if (label) citationPills.push(label);
        return label ? `[${label}]` : '';
      }
    }
    if (isBlock(node)) {
      if (isDiagram(node)) {
        diagramsWithoutSource += 1;
        return '\n\n_[Diagram not captured: the page shows it as an image without its source.]_\n\n';
      }
      const code = blockCode(node);
      const text = blockText(code);
      const fence = '`'.repeat(Math.max(3, ...[...text.matchAll(/`+/g)].map((m) => m[0].length + 1)));
      return `\n\n${fence}${blockLanguage(node, code)}\n${text}${text.endsWith('\n') ? '' : '\n'}${fence}\n\n`;
    }
    const body = [...node.childNodes].map(render).join('');
    if (/^h[1-6]$/.test(tag)) return `\n\n${'#'.repeat(Number(tag[1]))} ${body.trim()}\n\n`;
    if (tag === 'a') { const url = safeUrl(node.getAttribute('href')); return url ? `[${body}](${url})` : body; }
    if (tag === 'strong' || tag === 'b') return `**${body}**`;
    if (tag === 'em' || tag === 'i') return `*${body}*`;
    if (tag === 'code') return '`' + body + '`';
    if (tag === 'br') return '\n';
    if (tag === 'li') return `\n${node.parentElement?.tagName === 'OL' ? `${[...node.parentElement.children].indexOf(node) + 1}.` : '-'} ${body.trim()}`;
    if (tag === 'table') {
      const rows = [...node.querySelectorAll('tr')].map((row) => [...row.children].map((cell) => render(cell).trim().replace(/\|/g, '\\|').replace(/\n/g, '<br>')));
      if (!rows.length) return '';
      return '\n\n' + rows.map((row, index) => '| ' + row.join(' | ') + ' |' + (index === 0 ? '\n| ' + row.map(() => '---').join(' | ') + ' |' : '')).join('\n') + '\n\n';
    }
    if (tag === 'blockquote') return '\n\n' + body.trim().split('\n').map((line) => '> ' + line).join('\n') + '\n\n';
    return ['p','div','section','article','ul','ol'].includes(tag) ? `\n\n${body}\n\n` : body;
  };
  // Nested layout blocks each add paragraph breaks; prose keeps at most one blank line between
  // blocks while fenced code keeps its exact lines.
  const collapseBlankRuns = (text) => {
    const lines = [];
    let fence;
    for (const line of text.split('\n')) {
      const marker = line.match(/^(`{3,}|~{3,})/)?.[1];
      if (fence) {
        lines.push(line);
        if (marker && marker[0] === fence[0] && marker.length >= fence.length && line.trim() === marker) fence = undefined;
      } else if (marker) {
        fence = marker;
        lines.push(line);
      } else if (line.trim()) lines.push(line);
      else if (lines.length && lines[lines.length - 1] !== '') lines.push('');
    }
    return lines.join('\n').trim();
  };
  const controls = [...root.querySelectorAll('a,button,[role="button"],[role="menuitem"]')];
  const candidateFileName = (node) => {
    const context = node.closest('[role="group"],li,p,figure,[data-testid*="file"]')?.textContent || '';
    return node.getAttribute('download') || context.match(/[A-Za-z0-9._-]+\.(?:md|txt|csv|tsv|json|pdf|docx|xlsx|pptx|zip|png|jpe?g)\b/i)?.[0] || undefined;
  };
  const candidateStableLabel = (node) => candidateFileName(node) || (node.getAttribute('aria-label') || node.getAttribute('title') || node.textContent || '').trim() || 'Download';
  const candidates = controls.flatMap((node, index) => {
    // A control that wraps other controls, or whose text runs past a label's length, is a
    // container, never a download: the research report wraps its whole document in one clickable
    // element, whose text is the report itself.
    if (node.querySelector('a,button,[role="button"],[role="menuitem"]')) return [];
    const label = (node.getAttribute('aria-label') || node.getAttribute('title') || node.textContent || '').trim();
    if (label.length > 200) return [];
    const href = node.getAttribute('href') || '';
    if (citationLink(node)) return [];
    const namedFile = node.tagName === 'A' && /\.(?:md|txt|csv|tsv|json|pdf|docx|xlsx|pptx|zip|png|jpe?g)(?:$|[?#])/i.test(href)
      && /\.(?:md|txt|csv|tsv|json|pdf|docx|xlsx|pptx|zip|png|jpe?g)\b/i.test(label);
    const structural = node.hasAttribute('download') || /(?:download|export)/i.test(label) || /sandbox:|\/files\/|estuary\/content|blob:/.test(href)
      || namedFile
      || (report && /^(?:Markdown|Word|PDF)(?:\s*\(.*\))?$/i.test(label));
    if (!structural) return [];
    const fileName = candidateFileName(node);
    const stableLabel = candidateStableLabel(node);
    const occurrence = controls.slice(0, index).filter((prior) => candidateStableLabel(prior) === stableLabel).length;
    let hash = 2166136261;
    for (const char of `${stableLabel}|${occurrence}`) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619) >>> 0;
    const marker = `oracle-capture-${responseIndex}-${index}`;
    node.setAttribute('data-oracle-capture', marker);
    return [{ candidateId: `candidate-${hash.toString(16)}`, label: stableLabel, selector: `[data-oracle-capture="${marker}"]`, fileName, nativeMarkdown: report && /markdown|\.md\b/i.test(label) }];
  });
  // The earlier shell renders a tool widget (the Deep research iframe) inside the reply's root; the
  // redesigned one renders it in a sibling block of the same exchange (`data-turn-key`, one per
  // prompt), so a root without its own frame takes the frames of that exchange only.
  const frameScope = root.querySelector('iframe') ? root : root.closest('[data-turn-key]') || root;
  const frames = [...frameScope.querySelectorAll('iframe')].map((node, index) => {
    const marker = `oracle-frame-${responseIndex}-${index}`;
    node.setAttribute('data-oracle-capture', marker);
    return { selector: `[data-oracle-capture="${marker}"]`, src: node.src };
  });
  const markdown = collapseBlankRuns(render(clone));
  return { messageId: actualId, title: root.querySelector('h1,h2')?.textContent?.trim(), rawText: root.innerText || root.textContent || '', rawHtml: clone.outerHTML,
    markdown, codeBlocks, sources, candidates, frames, durationLabel, citationPills, diagramsWithoutSource };
}

export function captureExpression(options = {}, frameDocument = false) {
  const call = `(${captureScopedResponse.toString()})(${JSON.stringify(options)}, ${archiveTurns.toString()})`;
  return frameDocument ? `(() => { const document = frames[0]?.document || globalThis.document; return ${call}; })()` : call;
}

// One evaluation reads the page's conversation and its assistant turns (the enumeration
// captureScopedResponse binds), so a navigation can never pair one conversation's location with
// another conversation's turns: a page on another conversation reports only where it is.
// `archiveFileName` also reports how many user turns show this job's archive.
export function observeConversationTurns({ conversationId, stopSelector, archiveFileName } = {}, archiveTurnsOf = undefined) {
  const href = String(location.href);
  const observed = location.pathname.match(/\/(?:c|chat)\/([A-Za-z0-9-]+)$/i)?.[1];
  if (conversationId !== undefined && observed !== conversationId) return { href, conversationId: observed, onConversation: false, messages: [] };
  const renderText = (node) => {
    if (!node) return '';
    const clone = node.cloneNode(true);
    const host = document.createElement('div');
    host.style.position = 'fixed';
    host.style.left = '-99999px';
    host.style.top = '0';
    host.style.whiteSpace = 'pre-wrap';
    host.style.pointerEvents = 'none';
    host.appendChild(clone);
    document.body.appendChild(host);
    let text = (host.innerText || host.textContent || '').trim();
    host.remove();
    const ending = '\nChatGPT can make mistakes. Check important info.';
    if (text.includes(ending)) text = text.split(ending)[0].trim();
    return text.split('\n').map((line) => line.trimEnd()).filter((line) => !/^Thought for\b/i.test(line.trim())).join('\n').trim();
  };
  const assistantSelector = '[data-message-author-role="assistant"], [data-testid="assistant-message"]';
  const headingMessages = [...document.querySelectorAll('h1,h2,h3,h4,h5,h6,[role="heading"]')]
    .filter((node) => /^ChatGPT said:/.test((node.textContent || '').trim()) || node.getAttribute('data-conversation-role') === 'assistant')
    .map((heading) => ({ text: renderText(heading.nextElementSibling) }));
  const nodeMessages = [...document.querySelectorAll(assistantSelector)]
    .filter((node) => !node.parentElement?.closest(assistantSelector))
    .map((node) => ({ text: renderText(node) }));
  return {
    href,
    conversationId: observed,
    onConversation: true,
    // Home can remain mounted in a display:none workspace after send, retaining its old Stop.
    // Only rendered controls describe the conversation. Layout boxes still exist offscreen and
    // in background tabs: this must not depend on viewport intersection, focus, or tab visibility.
    stopPresent: stopSelector ? [...document.querySelectorAll(stopSelector)].some((node) => node.getClientRects().length > 0) : undefined,
    archiveTurnCount: archiveFileName && typeof archiveTurnsOf === 'function' ? archiveTurnsOf(archiveFileName).length : undefined,
    messages: headingMessages.some((message) => message.text) ? headingMessages : nodeMessages,
  };
}

export function observeConversationExpression(options = {}) {
  return `(${observeConversationTurns.toString()})(${JSON.stringify(options)}, ${archiveTurns.toString()})`;
}

// The research widget is an Apps SDK frame: the host hands it the finished report message as its
// widget state. That message is the report's Markdown source plus the citation references the
// widget renders as pills, read without any request of our own. Evaluated in the report frame.
export function readResearchReportState() {
  let sdk;
  try { sdk = frames[0]?.openai; } catch { /* cross-origin child */ }
  const message = (sdk || window.openai)?.widgetState?.report_message;
  const parts = Array.isArray(message?.content?.parts) ? message.content.parts.filter((part) => typeof part === 'string') : [];
  if (!parts.length) return undefined;
  const linksOf = (item) => [item, ...(Array.isArray(item?.supporting_websites) ? item.supporting_websites : [])]
    .filter((entry) => typeof entry?.url === 'string')
    .map((entry) => ({ title: typeof entry.title === 'string' ? entry.title : '', url: entry.url }));
  const references = (Array.isArray(message.metadata?.content_references) ? message.metadata.content_references : [])
    .filter((reference) => typeof reference?.matched_text === 'string' && reference.matched_text)
    .map((reference) => ({
      matchedText: reference.matched_text,
      type: String(reference.type || ''),
      sources: (Array.isArray(reference.items) ? reference.items : []).flatMap(linksOf),
      safeUrls: (Array.isArray(reference.safe_urls) ? reference.safe_urls : []).filter((url) => typeof url === 'string'),
    }));
  return { messageId: typeof message.id === 'string' ? message.id : undefined, complete: message.metadata?.is_complete === true, markdown: parts.join('\n\n'), references };
}

// ChatGPT appends utm_source=chatgpt.com to every outbound source link; a footnote names the source
// itself, so that one parameter is dropped and every other part of the URL is kept.
function withoutChatGptReferral(url) {
  try {
    const parsed = new URL(url);
    if (parsed.searchParams.get('utm_source') !== 'chatgpt.com') return url;
    parsed.searchParams.delete('utm_source');
    return parsed.toString();
  } catch { return url; }
}

// Research Markdown marks each citation with a private-use token: U+E200, a kind ("cite"), one or
// more references each after U+E202, then U+E201. Each token becomes Markdown footnote references,
// one number per distinct source in order of first citation, defined at the end. A token without a
// matching reference keeps a numbered footnote that says so and is returned as unresolved, never
// dropped. Fenced code is left exactly as written.
export function resolveResearchCitations(markdown, references = []) {
  const byToken = new Map(references.map((reference) => [reference.matchedText, reference]));
  const numbers = new Map();
  const footnotes = [];
  const unresolved = [];
  let tokens = 0;
  const footnoteFor = (key, definition) => {
    if (!numbers.has(key)) {
      numbers.set(key, footnotes.length + 1);
      footnotes.push(definition);
    }
    return `[^${numbers.get(key)}]`;
  };
  const resolveToken = (token, inner) => {
    tokens += 1;
    const [kind = '', ...refs] = inner.split('\ue202');
    const reference = byToken.get(token);
    const links = [];
    for (const link of [...(reference?.sources || []), ...(reference?.sources?.length ? [] : (reference?.safeUrls || []).map((url) => ({ title: '', url })))]) {
      const url = withoutChatGptReferral(link.url);
      if (/^https?:\/\//i.test(url) && !links.some((known) => known.url === url)) links.push({ ...link, url });
    }
    if (!links.length) {
      const label = [kind, ...refs].filter(Boolean).join(' ');
      unresolved.push(label);
      return footnoteFor(`unresolved:${label}`, { unresolved: label });
    }
    return links.map((link) => footnoteFor(link.url, link)).join('');
  };
  let fence;
  const lines = String(markdown).split('\n').map((line) => {
    const marker = line.match(/^\s*(`{3,}|~{3,})/)?.[1];
    if (fence) {
      if (marker && marker[0] === fence[0] && marker.length >= fence.length && line.trim() === marker) fence = undefined;
      return line;
    }
    if (marker) {
      fence = marker;
      return line;
    }
    return line.replace(/\ue200([^\ue200\ue201]*)\ue201/g, resolveToken);
  });
  const escapeTitle = (title) => title.replace(/\s+/g, ' ').trim().replace(/[[\]]/g, '\\$&');
  const definitions = footnotes.map((note, index) => `[^${index + 1}]: ${note.unresolved !== undefined
    ? `Unresolved citation (${note.unresolved}): the report did not expose its source.`
    : note.title ? `[${escapeTitle(note.title)}](${note.url})` : `<${note.url}>`}`);
  const sources = footnotes.map((note, index) => note.unresolved !== undefined
    ? { id: `citation-${index + 1}`, kind: 'citation', label: note.unresolved, unresolved: true }
    : { id: `citation-${index + 1}`, kind: 'citation', label: note.title || note.url, url: note.url });
  return {
    markdown: definitions.length ? `${lines.join('\n').trimEnd()}\n\n${definitions.join('\n')}\n` : lines.join('\n'),
    sources,
    tokens,
    unresolved,
  };
}

// The Deep Research response: the validated native export, else the Markdown of the widget state,
// with citation tokens resolved against the widget's references. The page-derived Markdown is the
// last resort; then every rendered citation pill and every diagram without source is a declared gap.
export function composeResearchResponse({ capture, nativeMarkdown, reportState }) {
  const source = typeof nativeMarkdown === 'string' ? { text: nativeMarkdown, method: 'native_report_download' }
    : reportState?.markdown ? { text: reportState.markdown, method: 'report_widget_state' } : undefined;
  if (!source) {
    const pills = [...new Set(capture.citationPills || [])];
    return {
      markdown: capture.markdown, method: 'scoped_dom', fidelity: 'derived_markdown',
      sources: [...capture.sources, ...pills.map((label) => ({ id: `citation-pill-${label}`, kind: 'citation', label: `citation ${label}`, unresolved: true }))],
      requiredMissing: capture.diagramsWithoutSource ? [`diagram_source:${capture.diagramsWithoutSource}`] : [],
    };
  }
  const resolved = resolveResearchCitations(source.text, reportState?.references || []);
  const cited = new Set(resolved.sources.flatMap((item) => item.url ? [item.url] : []));
  const sources = [...resolved.sources, ...capture.sources.filter((item) => item.kind === 'artifact' || (item.url && !cited.has(withoutChatGptReferral(item.url))))];
  return {
    markdown: resolved.markdown, method: source.method, fidelity: 'native_markdown', sources,
    requiredMissing: sources.some((item) => item.kind !== 'artifact' && item.url && !resolved.markdown.includes(item.url)) ? ['native_export_source_links'] : [],
    citations: { tokens: resolved.tokens, sources: resolved.sources.filter((item) => item.url).length, unresolved: resolved.unresolved },
  };
}

// Listen before activation. Read only bytes exposed by the UI's actual download, never
// synthesize private API requests. Hooks are restored even when an export fails.
export async function captureDownload(selector) {
  const element = document.querySelector(selector);
  if (!element) throw new Error('Bound download control disappeared.');
  const nativeFetch = window.fetch;
  const originalFetch = nativeFetch.bind(window);
  const originalOpen = window.open;
  const originalClick = HTMLAnchorElement.prototype.click;
  let captured;
  let failure;
  const pending = [];
  const followed = new Set();
  const capture = async (response, fileName = '') => {
    if (!response.ok) throw new Error('Download request did not succeed.');
    const contentType = response.headers.get('content-type') || '';
    if (/json|html/i.test(contentType)) return;
    const length = response.headers.get('content-length');
    if (length && Number(length) > 25 * 1024 * 1024) throw new Error('Download exceeds capture limit.');
    const buffer = await response.clone().arrayBuffer();
    if (buffer.byteLength > 25 * 1024 * 1024) throw new Error('Download exceeds capture limit.');
    const bytes = new Uint8Array(buffer);
    let binary = '';
    for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    captured = { bytesBase64: btoa(binary), contentType, fileName, ...(length && !response.headers.get('content-encoding') ? { expectedSize: Number(length) } : {}) };
  };
  const follow = (url, fileName) => {
    if (!url || followed.has(url)) return;
    followed.add(url);
    pending.push(originalFetch(url, { signal: AbortSignal.timeout(5000) }).then((response) => capture(response, fileName)).catch(() => { failure = 'Download bytes could not be read.'; }));
  };
  const listener = (event) => {
    const anchor = event.target?.closest?.('a[href]');
    if (anchor && (anchor.hasAttribute('download') || /^(?:blob:|data:)/.test(anchor.href))) follow(anchor.href, anchor.download);
  };
  try {
    document.addEventListener('click', listener, true);
    HTMLAnchorElement.prototype.click = function () { follow(this.href, this.download); return originalClick.call(this); };
    window.open = (url) => { follow(url, ''); return null; };
    window.fetch = async (...args) => {
      const response = await originalFetch(...args);
      if (/attachment/i.test(response.headers.get('content-disposition') || '') || /(?:markdown|octet-stream|application\/pdf)/i.test(response.headers.get('content-type') || '')) {
        pending.push(capture(response).catch(() => { failure = 'Download bytes could not be read.'; }));
      }
      return response;
    };
    if (element.tagName === 'A') follow(element.href, element.download);
    element.click();
    for (let poll = 0; poll < 30 && !captured; poll += 1) await new Promise((resolve) => setTimeout(resolve, 100));
    await Promise.race([Promise.all(pending), new Promise((resolve) => setTimeout(resolve, 5000))]);
    if (!captured) throw new Error(failure || 'Native control did not expose downloadable bytes.');
    return captured;
  } finally {
    document.removeEventListener('click', listener, true);
    window.fetch = nativeFetch;
    window.open = originalOpen;
    HTMLAnchorElement.prototype.click = originalClick;
  }
}

// A report's Export control opens an asynchronous menu; the actual option is "Export to Markdown".
// Activation only: the bytes are observed by the pre-armed native download collector, because the
// sandboxed report frame delegates the download to a realm this document cannot see.
export async function activateDownloadControl(selector, report = false) {
  const element = document.querySelector(selector);
  if (!element) throw new Error('Bound download control disappeared.');
  element.click();
  if (!report) return { activated: true };
  for (let poll = 0; poll < 50; poll += 1) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    const options = [...document.querySelectorAll('[role=menuitem],button,a')].filter((node) => node.getClientRects().length && /^(?:Export to )?Markdown(?:\s*\(.*\))?$/i.test((node.textContent || '').trim()));
    if (options.length === 1 && options[0] !== element) {
      options[0].click();
      return { activated: true, menuOption: (options[0].textContent || '').trim() };
    }
  }
  throw new Error('The report export menu did not offer a Markdown option.');
}

// Chrome reports a download's object URL but, through the extension relay, never its saved path.
// Remember every Blob the UI turns into an object URL while armed, so the exact bytes Chrome saved
// stay readable after the app revokes the URL. Covers this window and its same-origin child.
export function armDownloadRegistry() {
  const targets = [window];
  try { if (frames[0]?.document) targets.push(frames[0]); } catch { /* cross-origin child: its own session arms it */ }
  const map = window.__oracleDownloadRegistry?.map || new Map();
  // The top realm remembers every realm it armed; frame order at disarm time is irrelevant.
  const armedRealms = window.__oracleDownloadRegistry?.armed || [];
  for (const target of targets) {
    if (target.__oracleDownloadRegistry) continue;
    const original = target.URL.createObjectURL;
    target.URL.createObjectURL = function (object) {
      const url = original.call(target.URL, object);
      if (object && typeof object.arrayBuffer === 'function') map.set(url, object);
      return url;
    };
    target.__oracleDownloadRegistry = { map, armed: armedRealms, restore: () => { target.URL.createObjectURL = original; delete target.__oracleDownloadRegistry; } };
    armedRealms.push(target);
  }
  return armedRealms.length;
}

export function disarmDownloadRegistry() {
  const armedRealms = window.__oracleDownloadRegistry?.armed || [];
  let restored = 0;
  for (const target of [...armedRealms]) {
    try { target.__oracleDownloadRegistry?.restore(); restored += 1; } catch { /* realm already gone */ }
  }
  armedRealms.length = 0;
  return restored;
}

export async function readRegisteredDownload(url) {
  const blob = window.__oracleDownloadRegistry?.map.get(url);
  if (!blob) throw new Error('The downloaded object URL was not created while the registry was armed.');
  if (blob.size > 25 * 1024 * 1024) throw new Error('Download exceeds capture limit.');
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

const CAPTURE_LIMIT_BYTES = 25 * 1024 * 1024;

export function decodeDataUrl(url) {
  const match = /^data:([^,]*?)(;base64)?,([\s\S]*)$/.exec(url);
  if (!match) throw new Error('Malformed data URL download.');
  // Base64 inflates by 4/3 and percent-encoding by up to 3x; bound the encoded length before decoding.
  if (match[3].length > CAPTURE_LIMIT_BYTES * 3) throw new Error('Download exceeds capture limit.');
  const bytes = match[2] ? Buffer.from(match[3], 'base64') : Buffer.from(decodeURIComponent(match[3]), 'utf8');
  if (bytes.length > CAPTURE_LIMIT_BYTES) throw new Error('Download exceeds capture limit.');
  return bytes;
}

function frameTreeIds(node) {
  return [node.frame.id, ...(node.childFrames || []).flatMap(frameTreeIds)];
}

async function evaluateOrThrow(cdp, sessionId, expression, timeoutMs) {
  const result = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionId, timeoutMs);
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description?.split('\n')[0] || result.exceptionDetails.text || 'Evaluation failed.');
  return result.result?.value;
}

// Pre-armed native download collection over CDP. Page.downloadWillBegin/downloadProgress fire on
// the session that owns the originating frame with no download-behavior change, so the user's
// download destination is never touched. Accepted origins are exact: the tab's main frame (the
// host performs sandboxed exports) or the bound report frame tree. Bytes come only from the UI's
// own blob or data URL; a transport URL is reported as a precise gap instead of being refetched.
export async function collectNativeDownload({ cdp, pageSessionId, frameSessionId, activate, timeoutMs = 30_000, onWait }) {
  const sessions = frameSessionId ? [pageSessionId, frameSessionId] : [pageSessionId];
  const events = [];
  const unsubscribe = [cdp.on('Page.downloadWillBegin', (event) => events.push(event)), cdp.on('Page.downloadProgress', (event) => events.push(event))];
  const armedRealms = [];
  try {
    const accepted = new Set();
    for (const sessionId of sessions) {
      await cdp.send('Page.enable', {}, sessionId);
      const { frameTree } = await cdp.send('Page.getFrameTree', {}, sessionId);
      for (const id of sessionId === pageSessionId && frameSessionId ? [frameTree.frame.id] : frameTreeIds(frameTree)) accepted.add(id);
      await evaluateOrThrow(cdp, sessionId, `(${armDownloadRegistry.toString()})()`);
      armedRealms.push(sessionId);
    }
    // Only downloads that begin at or after activation are candidates; anything observed while
    // arming (Page.enable, frame discovery, registry hooks) is not caused by the export control.
    const activationBoundary = events.length;
    const activation = await activate();
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const deadline = Date.now() + timeoutMs;
    let begin;
    while (!begin && Date.now() < deadline) {
      begin = events.slice(activationBoundary).find((event) => event.method === 'Page.downloadWillBegin' && sessions.includes(event.sessionId || '') && accepted.has(event.params.frameId));
      if (!begin) { await sleep(100); onWait?.(); }
    }
    if (!begin) {
      const foreign = events.slice(activationBoundary).find((event) => event.method === 'Page.downloadWillBegin');
      throw new Error(foreign ? 'A download started outside the bound frame tree; refusing to collect it.' : 'The native export did not start a browser download.');
    }
    let final;
    while (!final && Date.now() < deadline) {
      final = events.find((event) => event.method === 'Page.downloadProgress' && event.params.guid === begin.params.guid && event.params.state !== 'inProgress');
      if (!final) { await sleep(100); onWait?.(); }
    }
    if (!final) throw new Error('The browser download did not finish before the collection deadline.');
    if (final.params.state !== 'completed') throw new Error('The browser download was canceled or interrupted.');
    const url = String(begin.params.url || '');
    let bytes;
    let source;
    if (url.startsWith('data:')) { bytes = decodeDataUrl(url); source = 'data'; }
    else if (url.startsWith('blob:')) {
      bytes = Buffer.from(String(await evaluateOrThrow(cdp, begin.sessionId, `(${readRegisteredDownload.toString()})(${JSON.stringify(url)})`, timeoutMs)), 'base64');
      source = 'blob';
    } else throw new Error('The browser download came from a transport URL the capture hooks do not read; the relay reports no saved path.');
    const totalBytes = Number(final.params.totalBytes) || 0;
    return {
      bytesBase64: bytes.toString('base64'), fileName: String(begin.params.suggestedFilename || ''), contentType: '',
      ...(totalBytes > 0 ? { expectedSize: totalBytes } : {}),
      native: { guid: begin.params.guid, frameId: begin.params.frameId, source, totalBytes, activation },
    };
  } finally {
    for (const listener of unsubscribe) listener();
    for (const sessionId of armedRealms) await cdp.evaluate(sessionId, `(${disarmDownloadRegistry.toString()})()`);
  }
}

// Identity for a turn that carries no data-message-id. ChatGPT re-renders the same turn with
// different class attributes, so a hash of the sanitized HTML changes between visits and an
// index-only binding could never be recollected; the turn's normalized text does not change.
export function turnContentSha256(rawText) {
  return createHash('sha256').update(String(rawText || '').replace(/\s+/g, ' ').trim()).digest('hex');
}

// Seconds in a reasoning-time label such as "Worked for 15m 7s" or "Thought for 40 seconds";
// undefined when the label carries no duration.
export function durationLabelSeconds(label) {
  const scale = { h: 3600, m: 60, s: 1 };
  let seconds;
  for (const [, amount, unit] of String(label || '').matchAll(/(\d+)\s*(h(?:ours?|rs?)?|m(?:in(?:ute)?s?)?|s(?:ec(?:ond)?s?)?)\b/gi)) {
    seconds = (seconds ?? 0) + Number(amount) * scale[unit[0].toLowerCase()];
  }
  return seconds;
}

export function redactTransportSecrets(text) {
  return String(text).replace(/https?:\/\/[^\s<>"')]+/g, (value) => {
    if (/(?:[?&]|&amp;)(?:x-amz-[^=&#]+|x-goog-[^=&#]+|sig|signature|token|access_token|auth|key-pair-id|policy|expires|se|sp|sv)=/i.test(value)) return '[transport-url-redacted]';
    try {
      const url = new URL(value);
      return [...url.searchParams.keys()].some((key) => /^(?:x-amz-.+|x-goog-.+|sig|signature|token|access_token|auth|key-pair-id|policy|expires|se|sp|sv)$/i.test(key)) ? '[transport-url-redacted]' : value;
    } catch { return value; }
  });
}

export function validateArtifactBytes(bytes, { fileName = '', contentType = '', expectedSize } = {}) {
  if (!bytes.length) throw new Error('Download is empty.');
  if (expectedSize !== undefined && bytes.length !== expectedSize) throw new Error('Download size does not match the declared size.');
  const text = bytes.subarray(0, 8192).toString('utf8').trimStart();
  if (/^(?:<!doctype\s+html|<html|<head|<body)/i.test(text) || /text\/html/i.test(contentType)) throw new Error('Download is HTML, not a document.');
  const ext = fileName.toLowerCase().split('.').at(-1);
  if (/^[\[{]/.test(text) || /application\/json/i.test(contentType)) {
    try {
      const payload = JSON.parse(bytes.toString('utf8'));
      if (ext !== 'json' || (!Array.isArray(payload) && payload && ['download_url','downloadUrl','error','redirect'].some((key) => key in payload))) throw new Error('Download is JSON metadata, not a document.');
    }
    catch (error) { if (!(error instanceof SyntaxError)) throw error; }
  }
  let detectedType = 'text/plain';
  if (bytes.subarray(0, 5).toString() === '%PDF-') {
    if (!bytes.subarray(-2048).toString().includes('%%EOF')) throw new Error('PDF download is incomplete.');
    detectedType = 'application/pdf';
  } else if (bytes[0] === 0x50 && bytes[1] === 0x4b) {
    const eocd = bytes.lastIndexOf(Buffer.from([0x50,0x4b,0x05,0x06]));
    if (eocd < Math.max(0, bytes.length - 65557) || eocd + 22 > bytes.length || bytes.readUInt16LE(eocd + 20) !== bytes.length - eocd - 22) throw new Error('ZIP document is incomplete.');
    const requiredMember = { docx: 'word/document.xml', xlsx: 'xl/workbook.xml', pptx: 'ppt/presentation.xml' }[ext];
    if (requiredMember && (!bytes.includes(Buffer.from(requiredMember)) || !bytes.includes(Buffer.from('[Content_Types].xml')))) throw new Error('ZIP does not contain the expected Office document.');
    detectedType = 'application/zip';
  } else if (bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) {
    if (!bytes.subarray(-12).includes(Buffer.from('IEND'))) throw new Error('PNG download is incomplete.');
    detectedType = 'image/png';
  } else {
    try { new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
    catch { throw new Error('Unrecognized binary document; validation is unconfirmed.'); }
    if (bytes.includes(0)) throw new Error('Unrecognized binary document; validation is unconfirmed.');
  }
  if ((ext === 'pdf' && detectedType !== 'application/pdf') || (['docx','xlsx','pptx','zip'].includes(ext) && detectedType !== 'application/zip')
    || (ext === 'png' && detectedType !== 'image/png') || (['md','txt','csv'].includes(ext) && detectedType !== 'text/plain')) throw new Error('Downloaded bytes do not match the expected format.');
  return { size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), detectedType };
}

export function collectionOutcome({ hasResponse, fidelity, inspection, artifacts = [], requiredMissing = [], optionalMissing = [] }) {
  const required = [...requiredMissing];
  const optional = [...optionalMissing];
  if (!hasResponse) required.push('response');
  if (fidelity === 'text_only') required.push('rich_response_fidelity');
  if (inspection !== 'inspected') optional.push(`artifact_inspection:${inspection}`);
  for (const item of artifacts) {
    if (item.state === undefined && !item.candidateId) continue; // legacy manifest: absence is unknown, not a newly failed inspection
    if (item.state !== 'validated') (item.required ? required : optional).push(`artifact:${item.candidateId || item.displayName || 'unknown'}`);
  }
  return { collectionStatus: !hasResponse ? 'failed' : required.length || optional.length ? 'partial' : 'complete',
    collectionRequiredMissing: [...new Set(required)], collectionOptionalMissing: [...new Set(optional)] };
}
