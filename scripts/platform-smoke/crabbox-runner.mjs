/**
 * Thin Crabbox CLI wrapper for pi-oracle's local platform smoke targets.
 */

import { spawn } from "node:child_process";

const CRABBOX_BIN = process.env.PI_ORACLE_SMOKE_CRABBOX || process.env.PLATFORM_SMOKE_CRABBOX || "crabbox";

function env(name) {
  return process.env[name] ?? "";
}

export function execCrabbox(args, opts = {}) {
  return new Promise((resolve) => {
    const child = spawn(CRABBOX_BIN, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, CRABBOX_SYNC_GIT_SEED: "false", ...opts.env },
      ...opts.spawnOpts,
    });
    const stdoutChunks = [];
    const stderrChunks = [];
    let timeout;
    let killTimeout;
    if (opts.timeout && opts.timeout > 0) {
      timeout = setTimeout(() => {
        stderrChunks.push(Buffer.from(`\n[platform-smoke] crabbox command timed out after ${opts.timeout}ms\n`));
        try { child.kill("SIGTERM"); } catch {}
        killTimeout = setTimeout(() => {
          try { child.kill("SIGKILL"); } catch {}
        }, 10_000);
      }, opts.timeout);
    }
    child.stdout.on("data", (chunk) => stdoutChunks.push(chunk));
    child.stderr.on("data", (chunk) => stderrChunks.push(chunk));
    child.on("error", (error) => {
      if (timeout) clearTimeout(timeout);
      if (killTimeout) clearTimeout(killTimeout);
      resolve({
        stdout: Buffer.concat(stdoutChunks).toString(),
        stderr: `${Buffer.concat(stderrChunks).toString()}\n${error.message}`.trim(),
        code: 1,
        signal: null,
      });
    });
    child.on("close", (code, signal) => {
      if (timeout) clearTimeout(timeout);
      if (killTimeout) clearTimeout(killTimeout);
      resolve({
        stdout: Buffer.concat(stdoutChunks).toString(),
        stderr: Buffer.concat(stderrChunks).toString(),
        code: code ?? (signal ? 1 : 0),
        signal,
      });
    });
  });
}

export function buildTargetBaseArgs(targetName, config = {}) {
  switch (targetName) {
    case "macos": {
      const host = env("PI_ORACLE_SMOKE_MAC_HOST") || env("PLATFORM_SMOKE_MAC_HOST") || "localhost";
      const user = env("PI_ORACLE_SMOKE_MAC_USER") || env("PLATFORM_SMOKE_MAC_USER") || env("USER");
      const workRoot = env("PI_ORACLE_SMOKE_MAC_WORK_ROOT") || env("PLATFORM_SMOKE_MAC_WORK_ROOT") || `/Users/${env("USER")}/crabbox/${config.packageName ?? "pi-oracle"}`;
      return [
        "--provider", "ssh",
        "--target", "macos",
        "--static-host", host,
        "--static-user", user,
        "--static-port", "22",
        "--static-work-root", workRoot,
      ];
    }
    case "ubuntu": {
      const image = env("PI_ORACLE_SMOKE_UBUNTU_IMAGE") || env("PLATFORM_SMOKE_UBUNTU_IMAGE") || config.ubuntuContainerImage || "pi-oracle-platform-smoke:node24";
      return [
        "--provider", "local-container",
        "--target", "linux",
        "--local-container-image", image,
      ];
    }
    case "windows-native": {
      const vm = env("PI_ORACLE_SMOKE_WINDOWS_VM") || env("PLATFORM_SMOKE_WINDOWS_VM") || config.windowsParallels?.sourceVm || "pi-extension-windows-template";
      const snapshot = env("PI_ORACLE_SMOKE_WINDOWS_SNAPSHOT") || env("PLATFORM_SMOKE_WINDOWS_SNAPSHOT") || config.windowsParallels?.snapshot || "crabbox-ready";
      const user = env("PI_ORACLE_SMOKE_WINDOWS_USER") || env("PLATFORM_SMOKE_WINDOWS_USER") || env("USER");
      const workRoot = env("PI_ORACLE_SMOKE_WINDOWS_NATIVE_WORK_ROOT") || env("PLATFORM_SMOKE_WINDOWS_WORK_ROOT") || `C:\\crabbox\\${config.packageName ?? "pi-oracle"}`;
      return [
        "--provider", "parallels",
        "--target", "windows",
        "--windows-mode", "normal",
        "--parallels-source", vm,
        "--parallels-source-snapshot", snapshot,
        "--parallels-user", user,
        "--parallels-work-root", workRoot,
      ];
    }
    default:
      throw new Error(`unknown target: ${targetName}`);
  }
}

function parseLeaseId(output) {
  return output.match(/\bleased\s+(\S+)/)?.[1]
    ?? output.match(/\blease=(\S+)/)?.[1]
    ?? null;
}

export async function warmupLease(config, targetName, slug) {
  const args = ["warmup", ...buildTargetBaseArgs(targetName, config), "--slug", slug, "--keep"];
  if (targetName === "macos") args.push("--reclaim");
  console.log(`  [crabbox] ${args.join(" ")}`);
  const result = await execCrabbox(args, { timeout: 300_000 });
  return {
    ok: result.code === 0,
    ...result,
    leaseId: parseLeaseId(result.stdout) ?? parseLeaseId(result.stderr) ?? slug,
  };
}

export async function runOnLease(config, targetName, leaseId, command, opts = {}) {
  const args = ["run", ...buildTargetBaseArgs(targetName, config), "--id", leaseId];
  if (targetName === "macos") args.push("--reclaim");
  for (const name of opts.allowEnvNames ?? []) args.push("--allow-env", name);
  if (opts.sync === false) args.push("--no-sync");
  else args.push("--fresh-sync");
  if (opts.shell) args.push("--shell", command);
  else args.push("--", ...(Array.isArray(command) ? command : command.split(" ")));
  console.log(`  [crabbox] run ${targetName} ${opts.sync === false ? "--no-sync" : "--fresh-sync"} ...`);
  return execCrabbox(args, { timeout: opts.timeout ?? 900_000, env: opts.env });
}

export async function stopLease(config, targetName, leaseId) {
  const args = ["stop", ...buildTargetBaseArgs(targetName, config), "--id", leaseId];
  console.log(`  [crabbox] ${args.join(" ")}`);
  return execCrabbox(args, { timeout: 60_000 });
}
