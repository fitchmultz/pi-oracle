/**
 * Artifact helpers for the pi-oracle Crabbox platform smoke gate.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { relative, resolve } from "node:path";

export function createSuiteDir(artifactRoot, runId, targetName, suiteName) {
  const dir = resolve(process.cwd(), artifactRoot, runId, targetName, suiteName);
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function writeCommand(dir, command) {
  writeFileSync(resolve(dir, "command.txt"), `${command}\n`);
}

export function writeExitCode(dir, code, signal) {
  writeFileSync(resolve(dir, "exit-code.txt"), `code=${code}\nsignal=${signal ?? "none"}\n`);
}

export function writeSummary(dir, data) {
  writeFileSync(resolve(dir, "summary.json"), JSON.stringify({ ...data, writtenAt: new Date().toISOString() }, null, 2));
}

export function writeManifest(dir, expectedFiles) {
  const present = [];
  function walk(current) {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const fullPath = resolve(current, entry.name);
      if (entry.isDirectory()) walk(fullPath);
      else if (entry.isFile()) present.push(relative(dir, fullPath));
    }
  }
  if (existsSync(dir)) walk(dir);
  if (!present.includes("artifact-manifest.json")) present.push("artifact-manifest.json");
  const expected = [...new Set([...(expectedFiles ?? []), "artifact-manifest.json"])];
  const manifest = {
    expected,
    present,
    missing: expected.filter((file) => !present.includes(file)),
    writtenAt: new Date().toISOString(),
  };
  writeFileSync(resolve(dir, "artifact-manifest.json"), JSON.stringify(manifest, null, 2));
  return manifest;
}

export function scanForSecrets(text) {
  const violations = [];
  for (const [pattern, label] of [
    [/bearer\s+[A-Za-z0-9\-._~+/]{20,}=*/gi, "bearer token"],
    [/Authorization:\s*Bearer\s+[A-Za-z0-9\-._~+/]{20,}=*/gi, "authorization header"],
    [/connect\.sid=[A-Za-z0-9%]+/gi, "session cookie"],
    [/"(?:apiKey|accessToken|refreshToken|session|cookie|password)"\s*:\s*"[^"\s]{12,}"/gi, "auth/token JSON field"],
    [/SWEET_COOKIE_(?:CHROME|BRAVE|EDGE)_SAFE_STORAGE_PASSWORD=[^\s]+/gi, "Sweet Cookie safe-storage password"],
    [/[A-Z0-9_]*(?:API_KEY|TOKEN|SECRET|PASSWORD)=[A-Za-z0-9_./+~=-]{16,}/g, "secret environment assignment"],
    [/\bsk-[A-Za-z0-9_-]{20,}\b/g, "OpenAI-style API key"],
    [/\bAIza[0-9A-Za-z_-]{20,}\b/g, "Google-style API key"],
  ]) {
    if (pattern.test(text)) violations.push(`potential ${label}`);
  }
  return violations;
}

export function scanArtifacts(dir) {
  const findings = [];
  function walk(current) {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const fullPath = resolve(current, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
        continue;
      }
      if (!entry.isFile()) continue;
      const ext = entry.name.split(".").pop()?.toLowerCase() ?? "";
      if (!["txt", "json", "jsonl", "md", "log", "ansi", "html", "yml", "yaml", "js", "mjs", "ts"].includes(ext)) continue;
      try {
        const content = readFileSync(fullPath, "utf8");
        for (const violation of scanForSecrets(content)) findings.push({ file: relative(dir, fullPath), violation });
      } catch {
        // Ignore unreadable/binary artifacts.
      }
    }
  }
  if (existsSync(dir)) walk(dir);
  return findings;
}
