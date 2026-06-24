import { spawn, type ChildProcess, type StdioOptions } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface ArcAppEnvOptions {
  workspace: string;
  panelUrl?: string;
  provider?: "" | "ollama";
  model?: string;
  rendererMode?: "built";
  baseEnv?: NodeJS.ProcessEnv;
}

export interface ArcAppLaunchOptions extends ArcAppEnvOptions {
  appDir?: string;
  stdio?: StdioOptions;
}

const REQUIRED_BUILT_OUTPUTS = [
  join("electron", "dist", "main.js"),
  join("electron", "dist", "preload.js"),
  join("dist", "index.html")
];

export function repoRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..");
}

export function arcAppDir(): string {
  return join(repoRoot(), "apps", "arc-app");
}

export function localElectronBinary(appDir = arcAppDir()): string {
  return join(appDir, "node_modules", ".bin", process.platform === "win32" ? "electron.cmd" : "electron");
}

export function buildArcAppEnv(options: ArcAppEnvOptions): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...(options.baseEnv ?? process.env) };
  const cliPath = join(dirname(fileURLToPath(import.meta.url)), "cli.js");
  const runtimeDistDir = dirname(cliPath);
  env.ARC_ACP_BINARY = process.execPath;
  env.ARC_ACP_ARGS = JSON.stringify([cliPath, "acp"]);
  env.ARC_RUNTIME_DIST_DIR = runtimeDistDir;
  env.ARC_INITIAL_PROJECT = options.workspace;

  if (options.panelUrl) env.ARC_PANEL_URL = options.panelUrl;
  else delete env.ARC_PANEL_URL;

  if (options.rendererMode) env.ARC_RENDERER_MODE = options.rendererMode;
  else delete env.ARC_RENDERER_MODE;

  delete env.AGENT_RUN_CACHE_ACP_AGENT_COMMAND;

  if (options.provider === "ollama") {
    if (!options.model) throw new Error("--provider ollama requires --model or AGENT_RUN_CACHE_START_MODEL.");
    env.ARC_APP_PROVIDER = "ollama";
    env.ARC_APP_MODEL = options.model;
    env.ARC_APP_PROVIDER_BASE_URL = env.AGENT_RUN_CACHE_OLLAMA_BASE_URL || env.ARC_APP_PROVIDER_BASE_URL || "http://localhost:11434/v1";
    env.AGENT_RUN_CACHE_COPILOT_COMMAND = `ollama launch copilot --model ${quoteCommandArg(options.model)}`;
    env.AGENT_RUN_CACHE_SIDECAR_COPILOT_COMMAND = `ollama launch copilot --model ${quoteCommandArg(options.model)}`;
  } else {
    delete env.ARC_APP_PROVIDER;
    delete env.ARC_APP_MODEL;
    delete env.ARC_APP_PROVIDER_BASE_URL;
  }

  return env;
}

export function validateArcAppDependencies(appDir = arcAppDir()): void {
  const manifest = join(appDir, "package.json");
  if (!existsSync(manifest)) {
    throw new Error(`ARC app source is missing at ${appDir}. This checkout must include apps/arc-app.`);
  }
  if (!existsSync(localElectronBinary(appDir))) {
    throw new Error("ARC app dependencies are missing. Run npm run app:install first.");
  }
}

export function validateBuiltArcApp(appDir = arcAppDir()): void {
  validateArcAppDependencies(appDir);
  const missing = REQUIRED_BUILT_OUTPUTS
    .map((relativePath) => join(appDir, relativePath))
    .filter((path) => !existsSync(path));
  if (missing.length) {
    throw new Error(`ARC app build output is missing. Run npm run app:build first. Missing: ${missing.join(", ")}`);
  }
}

export function launchBuiltArcApp(options: ArcAppLaunchOptions): ChildProcess {
  const appDir = options.appDir ?? arcAppDir();
  validateBuiltArcApp(appDir);
  return spawn(localElectronBinary(appDir), ["."], {
    cwd: appDir,
    stdio: options.stdio ?? ["ignore", "inherit", "inherit"],
    env: buildArcAppEnv({ ...options, rendererMode: "built" })
  });
}

export function launchDevArcApp(options: ArcAppLaunchOptions): ChildProcess {
  const appDir = options.appDir ?? arcAppDir();
  validateArcAppDependencies(appDir);
  return spawn(commandName("pnpm"), ["--dir", appDir, "dev"], {
    cwd: repoRoot(),
    stdio: options.stdio ?? "inherit",
    env: buildArcAppEnv(options)
  });
}

function commandName(command: string): string {
  return process.platform === "win32" ? `${command}.cmd` : command;
}

function quoteCommandArg(value: string): string {
  if (/^[A-Za-z0-9_./:@+-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, "'\\''")}'`;
}
