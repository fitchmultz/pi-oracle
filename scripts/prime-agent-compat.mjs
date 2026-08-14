// Purpose: Guard the Oracle extension's supported pi/Prime Agent host boundary.
// Responsibilities: Reject direct legacy-only host API access, verify Prime config/archive conventions, and preserve package resources.
// Scope: Static compatibility invariants only; behavioral browser and lifecycle coverage remains in the existing sanity and smoke suites.
// Usage: Run with `npm run check:prime-agent` from the repository root.
// Invariants/Assumptions: Host differences belong in extensions/oracle/lib/host.ts and the package continues using the inherited `pi` resource manifest.
import { readdir, readFile } from "node:fs/promises";
import { dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const extensionRoot = join(root, "extensions", "oracle");
const hostPath = join(extensionRoot, "lib", "host.ts");
const archivePath = join(extensionRoot, "lib", "archive.ts");
const configPath = join(extensionRoot, "lib", "config.ts");
const runtimePath = join(extensionRoot, "lib", "runtime.ts");
const packagePath = join(root, "package.json");
const primeGuidePath = join(root, "docs", "PRIME_AGENT.md");

async function listTypeScriptFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await listTypeScriptFiles(path));
    else if (entry.isFile() && extname(entry.name) === ".ts") files.push(path);
  }
  return files;
}

function assertIncludes(source, expected, label) {
  if (!source.includes(expected)) throw new Error(`Prime Agent compatibility check failed: ${label}`);
}

function assertExcludes(source, pattern, label) {
  if (pattern.test(source)) throw new Error(`Prime Agent compatibility check failed: ${label}`);
}

const typeScriptFiles = await listTypeScriptFiles(extensionRoot);
for (const path of typeScriptFiles) {
  if (path === hostPath) continue;
  const source = await readFile(path, "utf8");
  const label = relative(root, path);
  assertExcludes(source, /\bctx\.mode\b/, `${label} reaches into legacy ctx.mode instead of lib/host.ts`);
  assertExcludes(source, /\bevent\.streamingBehavior\b/, `${label} reaches into legacy input delivery instead of lib/host.ts`);
  assertExcludes(
    source,
    /import\s*\{[^}]*\b(?:CONFIG_DIR_NAME|ProjectTrustStore|hasTrustRequiringProjectResources)\b[^}]*\}\s*from\s*["']@earendil-works\/pi-coding-agent["']/s,
    `${label} imports legacy-only coding-agent exports instead of lib/host.ts`,
  );
}

const hostSource = await readFile(hostPath, "utf8");
assertIncludes(hostSource, "CodingAgentHost.getAgentDir()", "host adapter must use the shared public getAgentDir export");
assertIncludes(hostSource, "PRIME_AGENT_CODING_AGENT_DIR", "host adapter must recognize Prime Agent's custom agent directory");
assertIncludes(hostSource, "join(\".prime\", \"agent\")", "host adapter must preserve Prime Agent's project config convention");
assertIncludes(hostSource, "getOracleInputDelivery", "host adapter must normalize input delivery");

const configSource = await readFile(configPath, "utf8");
assertIncludes(configSource, "getOracleProjectConfigDirName(agentDir)", "project config must resolve through the host adapter");

const runtimeSource = await readFile(runtimePath, "utf8");
assertIncludes(runtimeSource, "getOracleHostDisplayName()", "persisted-session diagnostics must name the active host");

const archiveSource = await readFile(archivePath, "utf8");
assertIncludes(archiveSource, '  ".prime",', "whole-project archives must exclude Prime Agent state");

const primeGuide = await readFile(primeGuidePath, "utf8");
assertIncludes(primeGuide, "prime-agent package install", "Prime Agent installation must be documented");
assertIncludes(primeGuide, ".prime/agent/extensions/oracle.json", "Prime Agent project config must be documented");

const packageJson = JSON.parse(await readFile(packagePath, "utf8"));
if (!packageJson.pi?.extensions?.includes("./extensions/oracle/index.ts")) {
  throw new Error("Prime Agent compatibility check failed: package must expose the Oracle extension through the inherited pi manifest");
}
if (!packageJson.pi?.prompts?.includes("./prompts")) {
  throw new Error("Prime Agent compatibility check failed: package must expose Oracle prompts through the inherited pi manifest");
}

console.log("Prime Agent compatibility invariants passed");
