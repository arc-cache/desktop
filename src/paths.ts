import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";

export function workspaceRoot(cwd = process.cwd()): string {
  const result = spawnSync("git", ["rev-parse", "--show-toplevel"], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"]
  });
  if (result.status === 0) return result.stdout.trim();
  return resolve(cwd);
}

export function cacheDir(workspace = workspaceRoot()): string {
  return process.env.AGENT_RUN_CACHE_DIR
    ? resolve(process.env.AGENT_RUN_CACHE_DIR)
    : join(workspace, ".agent-run-cache");
}

export function appCacheDir(): string {
  if (process.env.AGENT_RUN_CACHE_APP_DIR) return resolve(process.env.AGENT_RUN_CACHE_APP_DIR);
  if (process.env.AGENT_RUN_CACHE_DIR) return join(resolve(process.env.AGENT_RUN_CACHE_DIR), "app");
  return join(homedir(), ".agent-run-cache", "app");
}

export function desktopUserDataDirs(): string[] {
  if (process.env.AGENT_RUN_CACHE_DESKTOP_USER_DATA_DIR) {
    return [resolve(process.env.AGENT_RUN_CACHE_DESKTOP_USER_DATA_DIR)];
  }
  const home = homedir();
  if (process.platform === "darwin") {
    return [
      join(home, "Library", "Application Support", "ARC"),
      join(home, "Library", "Application Support", "OpenACP UI")
    ];
  }
  if (process.platform === "win32") {
    const appData = process.env.APPDATA ?? join(home, "AppData", "Roaming");
    return [join(appData, "ARC"), join(appData, "OpenACP UI")];
  }
  const config = process.env.XDG_CONFIG_HOME ?? join(home, ".config");
  return [join(config, "ARC"), join(config, "OpenACP UI")];
}

export function desktopStatePaths(): string[] {
  return desktopUserDataDirs().flatMap((dir) => [
    join(dir, "openacpui-data", "projects.json"),
    join(dir, "openacpui-data", "spaces.json"),
    join(dir, "openacpui-data", "sessions"),
    join(dir, "openacpui-data", "folders"),
    join(dir, "Local Storage"),
    join(dir, "Session Storage")
  ]);
}

// Model weights and the inference runtime are machine-wide, not per-repo: one
// download serves every workspace.
export function modelsDir(): string {
  if (process.env.AGENT_RUN_CACHE_MODELS_DIR) return resolve(process.env.AGENT_RUN_CACHE_MODELS_DIR);
  return join(homedir(), ".agent-run-cache", "models");
}

export function runtimeDir(): string {
  if (process.env.AGENT_RUN_CACHE_RUNTIME_DIR) return resolve(process.env.AGENT_RUN_CACHE_RUNTIME_DIR);
  return join(homedir(), ".agent-run-cache", "runtime");
}

export function ensureCache(workspace = workspaceRoot()): string {
  const dir = cacheDir(workspace);
  mkdirSync(join(dir, "traces"), { recursive: true });
  mkdirSync(join(dir, "debug"), { recursive: true });
  mkdirSync(join(dir, "copilot-logs"), { recursive: true });
  mkdirSync(join(dir, "locks"), { recursive: true });
  return dir;
}

export function memoryPath(workspace = workspaceRoot()): string {
  return join(ensureCache(workspace), "memory.jsonl");
}

export function memoryEventsPath(workspace = workspaceRoot()): string {
  return join(ensureCache(workspace), "memory-events.jsonl");
}

export function telemetryPath(workspace = workspaceRoot()): string {
  return join(ensureCache(workspace), "telemetry.jsonl");
}

export function telemetryPolicyPath(workspace = workspaceRoot()): string {
  return join(ensureCache(workspace), "telemetry-policy.json");
}

export function tracePath(sessionId: string, workspace = workspaceRoot()): string {
  return join(ensureCache(workspace), "traces", `arc-${safeName(sessionId)}.jsonl`);
}

export function debugPath(workspace = workspaceRoot()): string {
  return join(ensureCache(workspace), "debug", "runtime.jsonl");
}

export function observerPath(sessionId: string, workspace = workspaceRoot()): string {
  return join(ensureCache(workspace), "debug", `observer-${safeName(sessionId)}.jsonl`);
}

export function reviewedPath(workspace = workspaceRoot()): string {
  return join(ensureCache(workspace), "reviewed.jsonl");
}

export function sidecarPath(workspace = workspaceRoot()): string {
  return join(ensureCache(workspace), "debug", "sidecar.jsonl");
}

export function reviewLockPath(sessionId: string, workspace = workspaceRoot()): string {
  return join(ensureCache(workspace), "locks", `review-${safeName(sessionId)}.lock`);
}

export function memoryLockPath(workspace = workspaceRoot()): string {
  return join(ensureCache(workspace), "locks", "memory-jsonl.lock");
}

export function copilotTranscriptPath(sessionId: string): string {
  const root = process.env.AGENT_RUN_CACHE_COPILOT_STATE_DIR ?? join(homedir(), ".copilot", "session-state");
  return join(root, sessionId, "events.jsonl");
}

export function copilotLogDir(sessionId: string, workspace = workspaceRoot()): string {
  return join(ensureCache(workspace), "copilot-logs", sessionId);
}

export function workspaceKey(workspace = workspaceRoot()): string {
  const remote = gitValue(workspace, ["config", "--get", "remote.origin.url"]);
  if (remote) return `git:${hash(normalizeGitRemote(remote))}`;
  const rootName = basename(workspace) || "workspace";
  return `local:${safeName(rootName)}:${hash(resolve(workspace)).slice(0, 12)}`;
}

export function workspaceGroup(): string {
  return process.env.AGENT_RUN_CACHE_WORKSPACE_GROUP ?? "";
}

function gitValue(cwd: string, args: string[]): string {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"]
  });
  return result.status === 0 ? result.stdout.trim() : "";
}

function normalizeGitRemote(value: string): string {
  return value
    .replace(/^git@([^:]+):/, "https://$1/")
    .replace(/\.git$/, "")
    .toLowerCase();
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 24);
}

function safeName(value: string): string {
  const allowed = new Set("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_.-".split(""));
  const name = [...value].map((char) => allowed.has(char) ? char : "_").join("").slice(0, 180);
  return name || "unknown";
}
