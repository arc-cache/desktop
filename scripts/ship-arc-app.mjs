import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const appDir = join(root, "apps", "arc-app");
const releaseDir = join(appDir, "release");
const bundledZip = join(root, "ARC-app.zip");
const bundledSha = join(root, "ARC-app.zip.sha256");

rmSync(releaseDir, { recursive: true, force: true });
run("npm", ["run", "app:package"]);

const packagedZip = newestZip(releaseDir) ?? zipPackagedApp();
copyFileSync(packagedZip, bundledZip);

const sha256 = fileSha256(bundledZip);
writeFileSync(bundledSha, `${sha256}  ARC-app.zip\n`);

run("npm", ["run", "build"]);
await verifyPackagedZip();

console.log(`Shipped ${relative(packagedZip)} -> ARC-app.zip`);
console.log(`Wrote ARC-app.zip.sha256: ${sha256}`);
console.log("Packaged ARC app probe passed");

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: root,
    stdio: "inherit",
    shell: false,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed with exit ${result.status}`);
  }
}

function newestZip(dir) {
  const zips = listZips(dir)
    .map((path) => ({ path, mtimeMs: statSync(path).mtimeMs }))
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
  return zips[0]?.path ?? null;
}

function listZips(dir) {
  if (!existsSync(dir)) return [];
  const entries = readdirSync(dir, { withFileTypes: true });
  const paths = [];
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      paths.push(...listZips(path));
    } else if (entry.isFile() && entry.name.endsWith(".zip")) {
      paths.push(path);
    }
  }
  return paths;
}

function fileSha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function zipPackagedApp() {
  const appBundle = findAppBundle(releaseDir);
  if (!appBundle) {
    throw new Error(`No packaged .app bundle found under ${releaseDir}`);
  }
  const appPackage = JSON.parse(readFileSync(join(appDir, "package.json"), "utf8"));
  const productName = String(appPackage.productName ?? "ARC");
  const version = String(appPackage.version ?? "2.0.1");
  const zipPath = join(releaseDir, version, `${productName}-${version}-${process.arch}-mac.zip`);
  rmSync(zipPath, { force: true });
  run("ditto", ["-ck", "--keepParent", appBundle, zipPath]);
  return zipPath;
}

function findAppBundle(dir) {
  if (!existsSync(dir)) return null;
  const entries = readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory() && entry.name.endsWith(".app")) return path;
    if (entry.isDirectory()) {
      const found = findAppBundle(path);
      if (found) return found;
    }
  }
  return null;
}

async function verifyPackagedZip() {
  if (process.platform !== "darwin") {
    console.log("Skipping packaged .app launch probe on non-macOS host");
    return;
  }

  const extractDir = mkdtempSync(join(tmpdir(), "arc-app-ship-"));
  const workspace = mkdtempSync(join(tmpdir(), "arc-app-workspace-"));
  const probeFile = join(extractDir, "packaged-probe.json");
  let child = null;
  let stderr = "";
  try {
    run("ditto", ["-xk", bundledZip, extractDir]);
    const appBundle = findAppBundle(extractDir);
    if (!appBundle) throw new Error("Packaged app probe could not find a .app bundle after extracting ARC-app.zip");

    child = spawn("open", ["-n", "-W", appBundle, "--args", `--user-data-dir=${join(extractDir, "user-data")}`], {
      cwd: "/",
      env: coldLaunchEnv({ probeFile, workspace }),
      stdio: ["ignore", "ignore", "pipe"],
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    await waitForProbeFile(probeFile, child);
    const probe = JSON.parse(readFileSync(probeFile, "utf8"));
    assertProbe(probe, { workspace });
  } finally {
    if (child && !child.killed) child.kill("SIGTERM");
    rmSync(extractDir, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
  }

  function waitForProbeFile(path, appProcess, timeoutMs = 45000) {
    return new Promise((resolvePromise, rejectPromise) => {
      let done = false;
      const finish = (error) => {
        if (done) return;
        done = true;
        clearInterval(poll);
        clearTimeout(deadline);
        if (error) rejectPromise(error);
        else resolvePromise();
      };
      const deadline = setTimeout(() => {
        finish(new Error(`Packaged ARC app probe timed out. stderr:\n${stderr.slice(-2000)}`));
      }, timeoutMs);
      const poll = setInterval(() => {
        if (existsSync(path)) {
          finish();
        }
      }, 250);
      appProcess.once("exit", (code) => {
        if (existsSync(path)) finish();
        else finish(new Error(`Packaged ARC app exited before writing probe file (exit ${code}). stderr:\n${stderr.slice(-2000)}`));
      });
      appProcess.once("error", (error) => finish(error));
    });
  }
}

function coldLaunchEnv({ probeFile, workspace }) {
  const env = { ...process.env };
  for (const key of [
    "ARC_ACP_ARGS",
    "ARC_ACP_BINARY",
    "ARC_APP_BASE_URL",
    "ARC_APP_MODEL",
    "ARC_APP_PROVIDER",
    "ARC_APP_PROVIDER_BASE_URL",
    "ARC_INITIAL_PROJECT",
    "ARC_PANEL_URL",
    "ARC_RENDERER_MODE",
    "ARC_RUNTIME_DIST_DIR",
    "AGENT_RUN_CACHE_ACP_AGENT_COMMAND",
    "AGENT_RUN_CACHE_COPILOT_COMMAND",
    "AGENT_RUN_CACHE_OLLAMA_BASE_URL",
    "AGENT_RUN_CACHE_SIDECAR_COPILOT_COMMAND",
    "AGENT_RUN_CACHE_START_MODEL",
    "AGENT_RUN_CACHE_START_RUNNER",
    "AGENT_RUN_CACHE_START_SURFACE",
  ]) {
    delete env[key];
  }
  env.ARC_PACKAGED_PROBE_FILE = probeFile;
  env.PWD = workspace;
  return env;
}

function assertProbe(probe, expected) {
  const fail = (message) => {
    throw new Error(`Packaged ARC app probe failed: ${message}\n${JSON.stringify(probe, null, 2).slice(0, 4000)}`);
  };
  if (!probe?.ok) fail("probe did not report ok");
  if (!probe.isPackaged) fail("app did not run as packaged");
  if (!String(probe.rendererUrl ?? "").startsWith("file:")) fail("renderer did not load a built file URL");
  if (probe.env?.arcInitialProject !== null) fail("cold launch should not receive ARC_INITIAL_PROJECT");
  if (probe.env?.arcPanelUrl !== null) fail("cold launch should not receive ARC_PANEL_URL");
  if (probe.env?.arcAppProvider !== null) fail("cold launch should not receive ARC_APP_PROVIDER");
  if (probe.env?.arcAppModel !== null) fail("cold launch should not receive ARC_APP_MODEL");
  if (probe.env?.arcRuntimeDistDir !== null) fail("cold launch should resolve bundled runtime without ARC_RUNTIME_DIST_DIR");
  if (probe.env?.copilotCommand !== null) fail("cold launch should not require AGENT_RUN_CACHE_COPILOT_COMMAND");
  if (probe.env?.acpAgentCommand !== null) fail("cold launch should not require AGENT_RUN_CACHE_ACP_AGENT_COMMAND");
  if (!probe.agents?.hasCopilot) fail("built-in native Copilot agent was not registered");
  if (probe.agents?.copilot?.engine !== "copilot") fail("Copilot agent is not native");
  if (probe.agents?.hasArcCopilot) fail("retired ARC (Copilot) ACP agent is still registered");
  const panelUrl = String(probe.bootstrap?.arcPanelUrl ?? "");
  if (!panelUrl.startsWith("http://127.0.0.1:")) fail("main process did not self-start a loopback memory panel");
  if (probe.renderer?.arcPanelUrl !== panelUrl) fail("preload did not expose the main-process panel URL");
  if (probe.renderer?.hasArcStartMemoryCopy) fail("renderer still contains stale arc start Memory guidance");
  if (!probe.panel?.ok) fail("memory panel was not reachable from the packaged app");
  const panelStatus = JSON.parse(String(probe.panel.body ?? "{}"));
  if (panelStatus.workspace !== expected.workspace) {
    fail(`memory panel did not use inherited PWD as workspace; expected ${expected.workspace}, got ${panelStatus.workspace}`);
  }
}

function relative(path) {
  return path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path;
}
