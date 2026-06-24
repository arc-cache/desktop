import path from "path";

/**
 * Run child JavaScript through Electron's Node mode when the desktop app is
 * packaged. In Electron, process.execPath points at ARC.app itself; without this
 * env var a child app-server can register as another Dock app instead of acting
 * like a plain Node process.
 */
export function electronNodeEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return childProcessEnv({ ...overrides, ELECTRON_RUN_AS_NODE: "1" });
}

export function childProcessEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...overrides };
  const key = pathKey(env);
  env[key] = augmentedPath(env[key]);
  return env;
}

export function augmentedPath(value: string | undefined): string {
  if (process.platform === "win32") return value ?? "";
  const parts = (value ?? "").split(path.delimiter).filter(Boolean);
  const seen = new Set(parts);
  for (const candidate of defaultExtraPaths()) {
    if (seen.has(candidate)) continue;
    parts.push(candidate);
    seen.add(candidate);
  }
  return parts.join(path.delimiter);
}

function pathKey(env: NodeJS.ProcessEnv): string {
  if (process.platform !== "win32") return "PATH";
  return Object.keys(env).find((key) => key.toLowerCase() === "path") ?? "Path";
}

function defaultExtraPaths(): string[] {
  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  return [
    resourcesPath,
    resourcesPath ? path.join(resourcesPath, "bin") : undefined,
    path.dirname(process.execPath),
    "/Applications/Codex.app/Contents/Resources",
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
  ].filter((candidate): candidate is string => typeof candidate === "string" && candidate.length > 0);
}
