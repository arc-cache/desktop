import { defineConfig } from "tsup";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const configDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(configDir, "../..");

for (const envPath of [
  path.join(repoRoot, ".env"),
  path.join(repoRoot, ".env.local"),
  path.join(repoRoot, ".env.signing.local"),
  path.join(repoRoot, ".env.private.local"),
  path.join(configDir, ".env"),
  path.join(configDir, ".env.local"),
  path.join(configDir, ".env.signing.local"),
  path.join(configDir, ".env.private.local"),
]) {
  if (!fs.existsSync(envPath)) continue;
  const lines = fs.readFileSync(envPath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!match) continue;
    const [, key, rawValue] = match;
    if (process.env[key] !== undefined) continue;
    process.env[key] = rawValue.trim().replace(/^(['"])(.*)\1$/, "$2");
  }
}

export default defineConfig({
  entry: {
    main: "electron/src/main.ts",
    preload: "electron/src/preload.ts",
  },
  define: {
    "process.env.ARC_TEAM_SUPABASE_URL": JSON.stringify(process.env.ARC_TEAM_SUPABASE_URL ?? ""),
    "process.env.ARC_TEAM_SUPABASE_PUBLISHABLE_KEY": JSON.stringify(process.env.ARC_TEAM_SUPABASE_PUBLISHABLE_KEY ?? ""),
    "process.env.ARC_TEAM_AUTH_REDIRECT_ORIGIN": JSON.stringify(process.env.ARC_TEAM_AUTH_REDIRECT_ORIGIN ?? ""),
  },
  outDir: "electron/dist",
  format: ["cjs"],
  target: "es2020",
  platform: "node",
  splitting: false,
  clean: true,
  external: [
    "electron",
    "node-pty",
    "electron-liquid-glass",
    "@anthropic-ai/claude-agent-sdk",
    "electron-updater",
  ],
  noExternal: [],
  treeshake: true,
});
