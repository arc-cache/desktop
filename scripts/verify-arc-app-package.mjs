#!/usr/bin/env node
import { createRequire } from "node:module";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const appDir = join(root, "apps", "arc-app");
const releaseDir = join(appDir, "release");
const requireFromRoot = createRequire(import.meta.url);
const builderConfig = requireFromRoot(join(appDir, "electron-builder.config.js"));
const asar = requireFromRoot(join(appDir, "node_modules", ".pnpm", "node_modules", "@electron", "asar"));

const requiredAsarEntries = [
  "/package.json",
  "/dist/index.html",
  "/electron/dist/main.js",
  "/electron/dist/preload.js",
];
const forbiddenAsarText = [
  "Launch the app with arc start",
  "is arc start still running",
];

const requiredRuntimeFiles = [
  "app-server.js",
  "cli.js",
  "ledger.js",
  "panel.js",
  "retrieval.js",
  "review-decision.js",
  "store.js",
];
const requiredRuntimePackages = [
  "@agentclientprotocol/sdk",
  "@github/copilot",
  "@github/copilot-sdk",
  "detect-libc",
  "vscode-jsonrpc",
  "zod",
];
const requiredLicenseFiles = [
  "licenses/APACHE-2.0.txt",
  "licenses/ARC-APP-MIT.txt",
  "licenses/NOTICE",
];
const requiredIconFiles = [
  "build/icon.svg",
  "build/icon.png",
  "build/icon.icns",
  "public/icon.png",
];

await main();

async function main() {
  verifyConfigInputs();

  const asarPaths = findFiles(releaseDir, "app.asar");
  if (!asarPaths.length) {
    fail(`No app.asar found under ${relative(releaseDir)}. Run npm run app:package first.`);
  }

  for (const asarPath of asarPaths) {
    verifyAsar(asarPath);
    verifyBundledRuntime(dirname(asarPath));
    verifyBundledLicenses(dirname(asarPath));
    await verifyBundledRuntimeImports(dirname(asarPath));
  }

  console.log(JSON.stringify({
    ok: true,
    checkedAsars: asarPaths.map(relative),
  }, null, 2));
}

function verifyConfigInputs() {
  for (const file of requiredIconFiles) {
    const path = join(appDir, file);
    if (!existsSync(path)) {
      fail(`App icon asset is missing: ${relative(path)}. Run npm run app:icons.`);
    }
  }

  verifyConfiguredIcon("mac.icon", builderConfig.mac?.icon);
  verifyConfiguredIcon("dmg.icon", builderConfig.dmg?.icon);
  verifyConfiguredIcon("linux.icon", builderConfig.linux?.icon);

  const extraResources = Array.isArray(builderConfig.extraResources) ? builderConfig.extraResources : [];
  const runtimeResource = extraResources.find((entry) => entry?.to === "arc-runtime/dist");
  if (!runtimeResource) {
    fail("electron-builder config must copy ../../dist to arc-runtime/dist via extraResources");
  }
  const licenseResources = new Map(extraResources.map((entry) => [entry?.to, entry?.from]));
  const expectedLicenseResources = new Map([
    ["licenses/APACHE-2.0.txt", "../../LICENSE"],
    ["licenses/ARC-APP-MIT.txt", "LICENSE"],
    ["licenses/NOTICE", "../../NOTICE"],
  ]);
  for (const [to, from] of expectedLicenseResources) {
    if (licenseResources.get(to) !== from) {
      fail(`electron-builder config must copy ${from} to ${to} via extraResources`);
    }
  }

  const runtimeSource = resolve(appDir, runtimeResource.from);
  for (const file of requiredRuntimeFiles) {
    const path = join(runtimeSource, file);
    if (!existsSync(path)) {
      fail(`ARC runtime source is missing ${relative(path)}. Run npm run build before packaging.`);
    }
  }

  const debAfterInstall = builderConfig.deb?.afterInstall ? resolve(appDir, builderConfig.deb.afterInstall) : "";
  if (!debAfterInstall || !existsSync(debAfterInstall)) {
    fail(`Debian afterInstall script is invalid: ${builderConfig.deb?.afterInstall ?? "<missing>"}`);
  }
  if ((statSync(debAfterInstall).mode & 0o111) === 0) {
    fail(`Debian afterInstall script is not executable: ${relative(debAfterInstall)}`);
  }

  const macSignHook = builderConfig.mac?.sign ? resolve(appDir, builderConfig.mac.sign) : "";
  if (!macSignHook || !existsSync(macSignHook)) {
    fail(`macOS signing hook is invalid: ${builderConfig.mac?.sign ?? "<missing>"}`);
  }
}

function verifyConfiguredIcon(label, iconPath) {
  const resolved = iconPath ? resolve(appDir, iconPath) : "";
  if (!resolved || !existsSync(resolved)) {
    fail(`${label} path is invalid: ${iconPath ?? "<missing>"}`);
  }
}

function verifyAsar(asarPath) {
  const entries = new Set(asar.listPackage(asarPath));
  for (const entry of requiredAsarEntries) {
    if (!entries.has(entry)) {
      fail(`${relative(asarPath)} is missing ${entry}`);
    }
  }

  const packageJson = JSON.parse(asar.extractFile(asarPath, "package.json").toString("utf8"));
  if (packageJson.main !== "electron/dist/main.js") {
    fail(`${relative(asarPath)} package.json has unexpected main: ${String(packageJson.main)}`);
  }

  for (const entry of entries) {
    if (!isSearchableAsarEntry(entry)) continue;
    const text = asar.extractFile(asarPath, entry.slice(1)).toString("utf8");
    for (const forbidden of forbiddenAsarText) {
      if (text.includes(forbidden)) {
        fail(`${relative(asarPath)} contains stale Memory guidance "${forbidden}" in ${entry}`);
      }
    }
  }
}

function isSearchableAsarEntry(entry) {
  return entry.startsWith("/dist/")
    && (entry.endsWith(".html") || entry.endsWith(".js") || entry.endsWith(".css"));
}

function verifyBundledRuntime(resourcesDir) {
  const runtimeRoot = join(resourcesDir, "arc-runtime");
  const runtimePackageJson = join(runtimeRoot, "package.json");
  if (!existsSync(runtimePackageJson)) {
    fail(`${relative(resourcesDir)} is missing arc-runtime/package.json`);
  }
  const packageJson = JSON.parse(readFileSync(runtimePackageJson, "utf8"));
  if (packageJson.type !== "module") {
    fail(`${relative(runtimePackageJson)} must declare {"type":"module"}`);
  }
  const dependencies = packageJson.dependencies && typeof packageJson.dependencies === "object"
    ? packageJson.dependencies
    : {};
  for (const packageName of ["@agentclientprotocol/sdk", "@github/copilot-sdk"]) {
    if (!(packageName in dependencies)) {
      fail(`${relative(runtimePackageJson)} must declare runtime dependency ${packageName}`);
    }
  }

  const runtimeDir = join(runtimeRoot, "dist");
  for (const file of requiredRuntimeFiles) {
    const path = join(runtimeDir, file);
    if (!existsSync(path)) {
      fail(`${relative(resourcesDir)} is missing bundled ARC runtime file arc-runtime/dist/${file}`);
    }
  }

  for (const packageName of requiredRuntimePackages) {
    const packageJsonPath = join(runtimeRoot, "node_modules", ...packageName.split("/"), "package.json");
    if (!existsSync(packageJsonPath)) {
      fail(`${relative(resourcesDir)} is missing bundled ARC runtime dependency ${packageName}`);
    }
  }

  const githubDir = join(runtimeRoot, "node_modules", "@github");
  const platformPackage = readdirSync(githubDir).find((entry) => /^copilot-(darwin|linux|win32)/.test(entry));
  if (!platformPackage) {
    fail(`${relative(resourcesDir)} is missing a bundled @github/copilot platform package`);
  }
}

async function verifyBundledRuntimeImports(resourcesDir) {
  const runtimeDir = join(resourcesDir, "arc-runtime", "dist");
  const token = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  for (const file of ["review-decision.js", "app-server.js"]) {
    const url = `${pathToFileURL(join(runtimeDir, file)).href}?verify=${token}`;
    try {
      await import(url);
    } catch (error) {
      fail(`${relative(join(runtimeDir, file))} is not importable in the packaged runtime: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

function verifyBundledLicenses(resourcesDir) {
  for (const file of requiredLicenseFiles) {
    const path = join(resourcesDir, file);
    if (!existsSync(path)) {
      fail(`${relative(resourcesDir)} is missing bundled notice ${file}`);
    }
    if (readFileSync(path, "utf8").trim().length === 0) {
      fail(`${relative(resourcesDir)} has empty bundled notice ${file}`);
    }
  }
}

function findFiles(dir, filename) {
  if (!existsSync(dir)) return [];
  const result = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      result.push(...findFiles(path, filename));
    } else if (entry.isFile() && entry.name === filename) {
      result.push(path);
    }
  }
  return result;
}

function fail(message) {
  throw new Error(`ARC app package verification failed: ${message}`);
}

function relative(path) {
  return path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path;
}
