const path = require("path");
const fs = require("fs");
const os = require("os");

// --- afterPack: strip bloat from the asar archive ---
// electron-builder v26 has a bug where the `files` config (negation-only,
// positive whitelist, AND FileSet with filter) is only applied to
// nodeModuleFilePatterns (node_modules filtering), NOT to the app directory
// walker (firstOrDefaultFilePatterns). Even the built-in default exclusions
// (e.g. !**/{.git,...}) don't work — .git ends up in the asar.
//
// Workaround: afterPack runs after the asar is packed. We extract it, keep
// ONLY what the app needs at runtime (whitelist), and repack.
const KEEP_ENTRIES = new Set([
  "package.json",
  "index.html",
  "dist",         // Vite-bundled renderer output
  "electron",     // tsup-compiled main/preload (electron/dist/)
  "node_modules", // production dependencies (already filtered by electron-builder)
]);

async function afterPackHook(context) {
  const resourcesDir = ["darwin", "mas"].includes(context.electronPlatformName)
    ? path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, "Contents", "Resources")
    : path.join(context.appOutDir, "resources");

  const asarPath = path.join(resourcesDir, "app.asar");
  if (!fs.existsSync(asarPath)) return;

  // @electron/asar is a transitive dep of electron-builder, always available
  const asar = require("@electron/asar");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "arc-asar-"));

  console.log("  \u2022 afterPack: extracting asar to strip bloat...");
  asar.extractAll(asarPath, tmpDir);

  // Remove everything not in the whitelist
  const entries = fs.readdirSync(tmpDir);
  for (const entry of entries) {
    if (!KEEP_ENTRIES.has(entry)) {
      fs.rmSync(path.join(tmpDir, entry), { recursive: true, force: true });
    }
  }

  // Inside electron/, keep only dist/ (compiled JS), remove src/ and other dev files
  const electronDir = path.join(tmpDir, "electron");
  if (fs.existsSync(electronDir)) {
    for (const sub of fs.readdirSync(electronDir)) {
      if (sub !== "dist") {
        fs.rmSync(path.join(electronDir, sub), { recursive: true, force: true });
      }
    }
  }

  const sourcePackageJson = JSON.parse(
    fs.readFileSync(path.join(__dirname, "package.json"), "utf8")
  );
  const runtimePackageJson = {
    name: sourcePackageJson.name,
    version: sourcePackageJson.version,
    productName: sourcePackageJson.productName,
    description: sourcePackageJson.description,
    author: sourcePackageJson.author,
    license: sourcePackageJson.license,
    homepage: sourcePackageJson.homepage,
    main: sourcePackageJson.main,
  };
  fs.writeFileSync(
    path.join(tmpDir, "package.json"),
    `${JSON.stringify(runtimePackageJson, null, 2)}\n`
  );

  console.log("  \u2022 afterPack: repacking asar...");
  fs.rmSync(asarPath, { force: true });
  await asar.createPackage(tmpDir, asarPath);
  fs.rmSync(tmpDir, { recursive: true, force: true });

  const externalRuntimeDir = path.join(resourcesDir, "arc-runtime");
  if (fs.existsSync(path.join(externalRuntimeDir, "dist"))) {
    fs.writeFileSync(
      path.join(externalRuntimeDir, "package.json"),
      `${JSON.stringify({
        type: "module",
        dependencies: {
          "@agentclientprotocol/sdk": "^0.25.0",
          "@github/copilot-sdk": "^1.0.0",
        },
      }, null, 2)}\n`
    );
    pruneCopilotRuntime(externalRuntimeDir, context);
  }

  // Log final size for visibility
  const finalSize = fs.statSync(asarPath).size;
  const mb = (finalSize / 1024 / 1024).toFixed(1);
  console.log(`  \u2022 afterPack: asar cleaned \u2014 ${mb} MB`);
}

function pruneCopilotRuntime(externalRuntimeDir, context) {
  const platform = context.electronPlatformName === "darwin" ? "darwin"
    : context.electronPlatformName === "linux" ? "linux"
      : process.platform;
  const arch = targetArchName(context.arch);
  const platformArch = `${platform}-${arch}`;
  const githubDir = path.join(externalRuntimeDir, "node_modules", "@github");
  const copilotDir = path.join(githubDir, "copilot");
  if (!fs.existsSync(copilotDir)) return;

  pruneChildren(path.join(copilotDir, "prebuilds"), (entry) => entry === platformArch);
  pruneChildren(path.join(copilotDir, "ripgrep", "bin"), (entry) => entry === platformArch);
  pruneChildren(path.join(copilotDir, "mxc-bin"), (entry) => entry === arch);

  if (fs.existsSync(githubDir)) {
    for (const entry of fs.readdirSync(githubDir)) {
      if (entry === "copilot" || entry === "copilot-sdk" || entry === `copilot-${platformArch}`) continue;
      if (entry.startsWith("copilot-")) {
        fs.rmSync(path.join(githubDir, entry), { recursive: true, force: true });
      }
    }
  }
}

function targetArchName(arch) {
  const value = String(arch ?? process.arch).toLowerCase();
  if (value === "3" || value === "arm64") return "arm64";
  return "x64";
}

function pruneChildren(dir, keep) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir)) {
    if (!keep(entry)) {
      fs.rmSync(path.join(dir, entry), { recursive: true, force: true });
    }
  }
}

/** @type {import('electron-builder').Configuration} */
module.exports = {
  appId: "io.github.ayubmoh1.agentruncache",
  productName: "ARC",
  protocols: [
    {
      name: "ARC",
      schemes: ["agent-run-cache"],
    },
  ],

  directories: {
    output: "release/${version}",
    buildResources: "build",
  },

  // --- Files to include in the app ---
  // NOTE: Due to electron-builder v26 bug, these patterns only affect
  // nodeModuleFilePatterns (node_modules filtering). App directory exclusions
  // are handled by the afterPack hook above which strips bloat from the asar.
  files: [
    "!**/{test,tests,__tests__,__mocks__,spec,specs}/**",
    "!**/*.d.ts",
    "!**/*.d.cts",
    "!**/*.d.mts",
    "!**/*.map",
  ],

  // --- ASAR packing ---
  asar: true,
  asarUnpack: [
    "node_modules/node-pty/**",
    "node_modules/electron-liquid-glass/**",
    "node_modules/@anthropic-ai/claude-agent-sdk/cli.js",
    "node_modules/@anthropic-ai/claude-agent-sdk/*.wasm",
    "node_modules/@anthropic-ai/claude-agent-sdk/vendor/**",
    "node_modules/@anthropic-ai/claude-agent-sdk/manifest*.json",
  ],

  extraResources: [
    {
      from: "../../dist",
      to: "arc-runtime/dist",
      filter: ["**/*"],
    },
    {
      from: "../../node_modules/@agentclientprotocol",
      to: "arc-runtime/node_modules/@agentclientprotocol",
      filter: ["**/*"],
    },
    {
      from: "../../node_modules/@github",
      to: "arc-runtime/node_modules/@github",
      filter: ["**/*"],
    },
    {
      from: "../../node_modules/detect-libc",
      to: "arc-runtime/node_modules/detect-libc",
      filter: ["**/*"],
    },
    {
      from: "../../node_modules/vscode-jsonrpc",
      to: "arc-runtime/node_modules/vscode-jsonrpc",
      filter: ["**/*"],
    },
    {
      from: "../../node_modules/zod",
      to: "arc-runtime/node_modules/zod",
      filter: ["**/*"],
    },
    {
      from: "../../LICENSE",
      to: "licenses/APACHE-2.0.txt",
    },
    {
      from: "LICENSE",
      to: "licenses/ARC-APP-MIT.txt",
    },
    {
      from: "../../NOTICE",
      to: "licenses/NOTICE",
    },
  ],

  npmRebuild: true,
  nodeGypRebuild: false,
  includePdb: false,

  afterPack: afterPackHook,

  // --- macOS ---
  mac: {
    target: ["dmg", "zip"],
    category: "public.app-category.developer-tools",
    icon: "build/icon.icns",
    darkModeSupport: true,
    hardenedRuntime: true,
    gatekeeperAssess: false,
    sign: "scripts/sign-mac.js",
    entitlements: "build/entitlements.mac.plist",
    entitlementsInherit: "build/entitlements.mac.plist",
    extendInfo: {
      NSMicrophoneUsageDescription: "ARC uses the microphone for voice dictation to transcribe speech into text.",
    },
  },

  dmg: {
    icon: "build/icon.icns",
    contents: [
      { x: 130, y: 220 },
      { x: 410, y: 220, type: "link", path: "/Applications" },
    ],
    window: { width: 540, height: 380 },
  },

  // --- Linux ---
  linux: {
    target: [
      { target: "AppImage" },
      { target: "deb" },
    ],
    category: "Development",
    icon: "public/icon.png",
    files: [
      "!node_modules/electron-liquid-glass/**",
      "!node_modules/@anthropic-ai/claude-agent-sdk/vendor/ripgrep/arm64-darwin/**",
      "!node_modules/@anthropic-ai/claude-agent-sdk/vendor/ripgrep/x64-darwin/**",
      "!node_modules/@anthropic-ai/claude-agent-sdk/vendor/ripgrep/arm64-win32/**",
      "!node_modules/@anthropic-ai/claude-agent-sdk/vendor/ripgrep/x64-win32/**",
      "!node_modules/node-pty/prebuilds/darwin-*/**",
      "!node_modules/node-pty/prebuilds/win32-*/**",
    ],
  },

  deb: {
    depends: ["libnotify4", "libsecret-1-0"],
    afterInstall: "scripts/deb-after-install.sh",
  },

  // --- Auto-update ---
  publish: {
    provider: "github",
    owner: "arc-cache",
    repo: "desktop",
    releaseType: "release",
  },

  afterSign: "scripts/notarize.js",
};
