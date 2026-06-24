import { existsSync, statSync } from "fs";
import { dirname, join, resolve } from "path";

const REQUIRED_ARC_RUNTIME_FILES = [
  "app-server.js",
  "ledger.js",
  "panel.js",
  "retrieval.js",
  "review-decision.js",
  "store.js",
] as const;

interface RuntimePathOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  fromDir?: string;
  resourcesPath?: string;
}

interface PanelWorkspaceOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
}

export function resolveArcRuntimeDistDir(options: RuntimePathOptions = {}): string | null {
  return getArcRuntimeCandidates(options).find(hasArcRuntimeFiles) ?? null;
}

export function resolveArcAppServerPath(options: RuntimePathOptions = {}): string | null {
  const distDir = resolveArcRuntimeDistDir(options);
  return distDir ? join(distDir, "app-server.js") : null;
}

export function resolveArcPanelWorkspace(options: PanelWorkspaceOptions = {}): string {
  const env = options.env ?? process.env;
  const candidates = [
    env.ARC_INITIAL_PROJECT,
    env.PWD,
    options.cwd ?? process.cwd(),
    options.homeDir ?? env.HOME,
  ];

  for (const candidate of candidates) {
    const workspace = usableWorkspace(candidate);
    if (workspace) return workspace;
  }

  return resolve(options.homeDir ?? env.HOME ?? options.cwd ?? process.cwd());
}

export function getArcRuntimeCandidates(options: RuntimePathOptions = {}): string[] {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const fromDir = options.fromDir ?? __dirname;
  const resourcesPath = options.resourcesPath ?? electronResourcesPath();
  const explicit = env.ARC_RUNTIME_DIST_DIR?.trim();

  return uniquePaths([
    explicit || undefined,
    resourcesPath ? join(resourcesPath, "arc-runtime", "dist") : undefined,
    resolve(cwd, "dist"),
    resolve(fromDir, "../../../../dist"),
    resolve(dirname(fromDir), "../../../../dist"),
  ]);
}

function hasArcRuntimeFiles(distDir: string): boolean {
  return REQUIRED_ARC_RUNTIME_FILES.every((file) => existsSync(join(distDir, file)));
}

function usableWorkspace(value: string | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  const workspace = resolve(trimmed);
  if (workspace === dirname(workspace)) return null;
  try {
    return statSync(workspace).isDirectory() ? workspace : null;
  } catch {
    return null;
  }
}

function electronResourcesPath(): string | undefined {
  return (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
}

function uniquePaths(paths: Array<string | undefined>): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const path of paths) {
    if (!path || seen.has(path)) continue;
    seen.add(path);
    result.push(path);
  }
  return result;
}
