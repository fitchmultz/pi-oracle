// Purpose: Keep the documentation navigable as written and free of workstation identifiers.
// Responsibilities: Every relative link and image path in the Markdown documentation resolves to a file or
//   directory, every heading fragment resolves to a heading or explicit HTML id in its target, every link
//   into this repository on github.com, from the documentation or the public site, names a path that exists on
//   `main` and a fragment that resolves there, and no published page names a maintainer host, a real home
//   directory, or a process id (the release ledger records evidence, not where it was produced).
// Scope: Static checks of README.md, CONTRIBUTING.md, SECURITY.md, CHANGELOG.md, docs/*.md, site/index.html, and
//   site/llms.txt against the working tree; no network.
// Usage: npm run test:docs (part of npm run verify:oracle).
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const MARKDOWN = [
  "README.md",
  "CONTRIBUTING.md",
  "SECURITY.md",
  "CHANGELOG.md",
  ...readdirSync(join(ROOT, "docs")).filter((name) => name.endsWith(".md")).sort().map((name) => `docs/${name}`),
];
const SITE = ["site/index.html", "site/llms.txt"];
// The repository's own pages on github.com: the README view, or a path on `main`.
const REPOSITORY_URL = /^https:\/\/github\.com\/alphastorm\/omp-oracle(?:\/(blob|tree)\/main\/([^?#]+?))?\/?(?:[?#]|$)/u;

const toPosix = (path) => path.split(sep).join("/");
const read = (path) => readFileSync(path, "utf8");
const kind = (path) => (existsSync(path) ? (statSync(path).isDirectory() ? "directory" : "file") : undefined);

/** Lines outside fenced code blocks, numbered from 1. */
function proseLines(markdown) {
  const lines = [];
  let fence;
  for (const [index, text] of markdown.split(/\r?\n/u).entries()) {
    const [, marker, rest = ""] = text.match(/^\s{0,3}(`{3,}|~{3,})(.*)$/u) ?? [];
    if (fence) {
      if (marker && marker[0] === fence[0] && marker.length >= fence.length && rest.trim() === "") fence = undefined;
      continue;
    }
    if (marker && !(marker[0] === "`" && rest.includes("`"))) {
      fence = marker;
      continue;
    }
    lines.push({ number: index + 1, text });
  }
  return lines;
}

/** The anchor GitHub derives from a heading (github-slugger: drop punctuation, keep `_` and `-`). */
function slug(heading) {
  return heading
    .replace(/!?\[([^\]]*)\]\([^)]*\)/gu, "$1")
    .replace(/<[^>]+>/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, "")
    .replace(/ /gu, "-");
}

function anchorsOf(markdown) {
  const anchors = new Set();
  const seen = new Map();
  for (const { text } of proseLines(markdown)) {
    const heading = text.match(/^\s{0,3}#{1,6}\s+(.+?)(?:\s+#+)?\s*$/u)?.[1];
    if (heading) {
      const base = slug(heading);
      const count = seen.get(base) ?? 0;
      anchors.add(count === 0 ? base : `${base}-${count}`);
      seen.set(base, count + 1);
    }
    for (const [, id] of text.matchAll(/\b(?:id|name)=["']([^"']+)["']/gu)) anchors.add(id);
  }
  return anchors;
}

function linksOf(markdown) {
  const links = [];
  for (const { number, text } of proseLines(markdown)) {
    // A code span is literal text, never a link.
    const line = text.replace(/`[^`]*`/gu, (span) => " ".repeat(span.length));
    const definition = line.match(/^\s{0,3}\[[^\]]+\]:\s*<?([^\s>]+)>?/u)?.[1];
    if (definition) {
      links.push({ line: number, target: definition });
      continue;
    }
    for (const [, target] of line.matchAll(/\]\(\s*<?([^)\s>]+)>?(?:\s+["'][^"']*["'])?\s*\)/gu)) links.push({ line: number, target });
    for (const [, target] of line.matchAll(/\b(?:href|src)="([^"]+)"/gu)) links.push({ line: number, target });
    for (const [, candidates] of line.matchAll(/\bsrcset="([^"]+)"/gu)) {
      for (const candidate of candidates.split(",")) links.push({ line: number, target: candidate.trim().split(/\s+/u)[0] });
    }
  }
  return links;
}

const anchorCache = new Map();
function hasAnchor(markdownPath, fragment) {
  if (!anchorCache.has(markdownPath)) anchorCache.set(markdownPath, anchorsOf(read(markdownPath)));
  return anchorCache.get(markdownPath).has(fragment);
}

/** Why `fragment` does not resolve in `targetPath`, or undefined when it does (or cannot be checked). */
function fragmentProblem(targetPath, fragment) {
  if (fragment === undefined || !targetPath.endsWith(".md") || kind(targetPath) !== "file") return undefined;
  if (fragment === "") return "empty fragment";
  return hasAnchor(targetPath, decodeURIComponent(fragment)) ? undefined : `no heading or id #${fragment}`;
}

/** Why a link into this repository on github.com does not resolve, or undefined when it does. */
function repositoryUrlProblem(url) {
  const match = url.match(REPOSITORY_URL);
  if (!match) return undefined;
  const [, view, path] = match;
  const fragment = url.includes("#") ? url.slice(url.indexOf("#") + 1) : undefined;
  if (!view) {
    if (fragment === undefined || fragment === "readme") return undefined;
    return fragmentProblem(join(ROOT, "README.md"), fragment);
  }
  const target = join(ROOT, decodeURIComponent(path));
  const expected = view === "tree" ? "directory" : "file";
  if (kind(target) !== expected) return `no ${expected} ${path} on main`;
  return fragmentProblem(target, fragment);
}

test("every relative link and heading fragment in the documentation resolves", () => {
  const broken = [];
  for (const file of MARKDOWN) {
    const source = join(ROOT, file);
    for (const { line, target } of linksOf(read(source))) {
      if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/iu.test(target)) continue;
      const hash = target.indexOf("#");
      const path = decodeURIComponent((hash >= 0 ? target.slice(0, hash) : target).replace(/\?.*$/u, ""));
      const fragment = hash >= 0 ? target.slice(hash + 1) : undefined;
      const resolved = path === "" ? source : resolve(dirname(source), path);
      const inside = !toPosix(relative(ROOT, resolved)).startsWith("../");
      const problem = !inside || !kind(resolved) ? "no such file in the repository" : fragmentProblem(resolved, fragment);
      if (problem) broken.push(`${file}:${line} → ${target} (${problem})`);
    }
  }
  assert.deepEqual(broken, []);
});

test("every link into this repository on github.com resolves on main", () => {
  const broken = [];
  for (const file of [...MARKDOWN, ...SITE]) {
    for (const [index, text] of read(join(ROOT, file)).split(/\r?\n/u).entries()) {
      for (const [url] of text.matchAll(/https:\/\/github\.com\/alphastorm\/omp-oracle[^\s"'<>)`]*/gu)) {
        const problem = repositoryUrlProblem(url);
        if (problem) broken.push(`${file}:${index + 1} → ${url} (${problem})`);
      }
    }
  }
  assert.deepEqual(broken, []);
});

// Host names of the maintainer's machines, home directories other than the `you` placeholder, and
// process ids with their numbers: evidence travels as job ids, commits, run ids and versions instead.
const WORKSTATION_IDENTIFIER = /\b(?:sf-studio|sf-pc|sf-old|nyc-pc)\b|(?:\/Users\/|\/home\/|C:\\Users\\)(?!you\b)[A-Za-z0-9_-]+|\b(?:PID|pid)s?\s+\*{0,2}\d+/gu;

test("the documentation names no maintainer host, home directory or process id", () => {
  const found = [];
  for (const file of [...MARKDOWN, ...SITE]) {
    for (const [index, text] of read(join(ROOT, file)).split(/\r?\n/u).entries()) {
      for (const [match] of text.matchAll(WORKSTATION_IDENTIFIER)) found.push(`${file}:${index + 1} → ${match}`);
    }
  }
  assert.deepEqual(found, []);
});
