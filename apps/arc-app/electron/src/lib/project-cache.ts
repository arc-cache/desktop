import fs from "fs";
import path from "path";

export const ARC_PROJECT_CACHE_DIR = ".agent-run-cache";

export interface ProjectCachePrepareResult {
  cacheDir: string;
  gitExcludePath?: string;
  gitExcludeUpdated: boolean;
  warnings: string[];
}

export interface ProjectCacheResetResult {
  cacheDir: string;
  removed: boolean;
}

export function getProjectCacheDir(projectPath: string): string {
  return path.join(projectPath, ARC_PROJECT_CACHE_DIR);
}

export function prepareProjectCache(projectPath: string): ProjectCachePrepareResult {
  assertWritableDirectory(projectPath);

  const cacheDir = getProjectCacheDir(projectPath);
  fs.mkdirSync(cacheDir, { recursive: true });

  const warnings: string[] = [];
  const gitExcludePath = findGitExcludePath(projectPath);
  let gitExcludeUpdated = false;

  if (gitExcludePath) {
    try {
      gitExcludeUpdated = ensureGitExcludesProjectCache(gitExcludePath);
    } catch (err) {
      warnings.push(`Could not update local Git exclude: ${getErrorMessage(err)}`);
    }
  }

  return {
    cacheDir,
    gitExcludePath,
    gitExcludeUpdated,
    warnings,
  };
}

export function resetProjectCache(projectPath: string): ProjectCacheResetResult {
  assertExistingDirectory(projectPath);

  const cacheDir = getProjectCacheDir(projectPath);
  if (!fs.existsSync(cacheDir)) {
    return { cacheDir, removed: false };
  }

  const stat = fs.lstatSync(cacheDir);
  if (!stat.isDirectory()) {
    throw new Error(`${ARC_PROJECT_CACHE_DIR} exists but is not a directory`);
  }

  fs.rmSync(cacheDir, { recursive: true, force: true });
  return { cacheDir, removed: true };
}

export function friendlyProjectCacheError(err: unknown, projectPath?: string): string {
  const target = projectPath ? ` "${path.basename(projectPath)}"` : "";
  const code = typeof err === "object" && err !== null && "code" in err
    ? String((err as { code?: unknown }).code)
    : "";

  if (code === "EACCES" || code === "EPERM" || code === "EROFS") {
    return `ARC cannot write local cache data in${target || " that folder"}. Choose a writable project folder.`;
  }

  if (code === "ENOENT") {
    return `ARC cannot find${target || " that folder"}. Choose an existing project folder.`;
  }

  return getErrorMessage(err);
}

export function findGitExcludePath(startPath: string): string | undefined {
  let current = path.resolve(startPath);

  while (true) {
    const gitPath = path.join(current, ".git");
    if (fs.existsSync(gitPath)) {
      return resolveGitExcludePath(gitPath);
    }

    const parent = path.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

export function ensureGitExcludesProjectCache(excludePath: string): boolean {
  const infoDir = path.dirname(excludePath);
  fs.mkdirSync(infoDir, { recursive: true });

  const existing = fs.existsSync(excludePath)
    ? fs.readFileSync(excludePath, "utf-8")
    : "";

  if (hasProjectCacheExclude(existing)) return false;

  const prefix = existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";
  fs.appendFileSync(
    excludePath,
    `${prefix}# ARC local project cache\n${ARC_PROJECT_CACHE_DIR}/\n`,
    "utf-8",
  );
  return true;
}

function resolveGitExcludePath(gitPath: string): string | undefined {
  const stat = fs.lstatSync(gitPath);
  if (stat.isDirectory()) {
    return path.join(gitPath, "info", "exclude");
  }

  if (!stat.isFile()) return undefined;

  const content = fs.readFileSync(gitPath, "utf-8").trim();
  const match = content.match(/^gitdir:\s*(.+)$/i);
  if (!match) return undefined;

  const gitDir = path.isAbsolute(match[1])
    ? match[1]
    : path.resolve(path.dirname(gitPath), match[1]);
  return path.join(gitDir, "info", "exclude");
}

function hasProjectCacheExclude(contents: string): boolean {
  return contents.split(/\r?\n/).some((line) => {
    const trimmed = line.trim();
    return trimmed === ARC_PROJECT_CACHE_DIR
      || trimmed === `${ARC_PROJECT_CACHE_DIR}/`
      || trimmed === `/${ARC_PROJECT_CACHE_DIR}`
      || trimmed === `/${ARC_PROJECT_CACHE_DIR}/`;
  });
}

function assertWritableDirectory(targetPath: string): void {
  assertExistingDirectory(targetPath);
  fs.accessSync(targetPath, fs.constants.R_OK | fs.constants.W_OK);
}

function assertExistingDirectory(targetPath: string): void {
  const stat = fs.statSync(targetPath);
  if (!stat.isDirectory()) {
    throw new Error(`${targetPath} is not a directory`);
  }
}

function getErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
