#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const appDir = join(root, "apps", "arc-app");
const releaseDir = join(appDir, "release");

if (process.platform !== "darwin") {
  console.log(JSON.stringify({
    ok: true,
    skipped: true,
    reason: "packaged cold-launch probe currently runs only on macOS",
  }, null, 2));
  process.exit(0);
}

const appBundle = findNewestAppBundle(releaseDir);
if (!appBundle) {
  throw new Error(`No packaged ARC.app bundle found under ${relative(releaseDir)}. Run npm run app:package first.`);
}

const probeRoot = mkdtempSync(join(tmpdir(), "arc-cold-launch-"));
const workspace = mkdtempSync(join(tmpdir(), "arc-cold-workspace-"));
const userDataDir = join(probeRoot, "user-data");
const probeFile = join(probeRoot, "probe.json");
let child = null;
let stderr = "";

try {
  child = spawn("open", ["-n", "-W", appBundle, "--args", `--user-data-dir=${userDataDir}`], {
    cwd: "/",
    env: coldLaunchEnv({ probeFile, workspace }),
    stdio: ["ignore", "ignore", "pipe"],
  });
  child.stderr.on("data", (chunk) => {
    stderr += String(chunk);
  });

  await waitForProbeFile(probeFile, child);
  const probe = JSON.parse(readFileSync(probeFile, "utf8"));
  assertColdLaunchProbe(probe, { appBundle, workspace });

  console.log(JSON.stringify({
    ok: true,
    appBundle: relative(appBundle),
    workspace,
    panelUrl: probe.bootstrap?.arcPanelUrl ?? null,
  }, null, 2));
} finally {
  if (child) {
    await waitForProcessExit(child, 5000);
    if (child.exitCode === null && child.signalCode === null && !child.killed) child.kill("SIGTERM");
  }
  removeTree(probeRoot);
  removeTree(workspace);
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
      finish(new Error(`Packaged ARC app cold-launch probe timed out. stderr:\n${stderr.slice(-2000)}`));
    }, timeoutMs);
    const poll = setInterval(() => {
      if (existsSync(path)) finish();
    }, 250);
    appProcess.once("exit", (code) => {
      if (existsSync(path)) finish();
      else finish(new Error(`Packaged ARC app exited before writing probe file (exit ${code}). stderr:\n${stderr.slice(-2000)}`));
    });
    appProcess.once("error", (error) => finish(error));
  });
}

function waitForProcessExit(proc, timeoutMs) {
  if (proc.exitCode !== null || proc.signalCode !== null) return Promise.resolve();
  return new Promise((resolvePromise) => {
    const timer = setTimeout(resolvePromise, timeoutMs);
    proc.once("exit", () => {
      clearTimeout(timer);
      resolvePromise();
    });
  });
}

function removeTree(path) {
  rmSync(path, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 100,
  });
}

function assertColdLaunchProbe(probe, expected) {
  const fail = (message) => {
    throw new Error(`Packaged ARC app cold-launch probe failed: ${message}\n${JSON.stringify(probe, null, 2).slice(0, 4000)}`);
  };

  if (!probe?.ok) fail("probe did not report ok");
  if (!probe.isPackaged) fail("app did not run as packaged");
  if (!String(probe.rendererUrl ?? "").startsWith("file:")) fail("renderer did not load a built file URL");
  if (probe.env?.arcPanelUrl !== null) fail("cold launch should not receive ARC_PANEL_URL from the environment");
  if (probe.env?.arcInitialProject !== null) fail("cold launch should not receive ARC_INITIAL_PROJECT from the environment");
  if (probe.env?.arcAppProvider !== null) fail("cold launch should not receive ARC_APP_PROVIDER from the environment");
  if (probe.env?.arcAppModel !== null) fail("cold launch should not receive ARC_APP_MODEL from the environment");
  if (probe.env?.arcRuntimeDistDir !== null) fail("cold launch should resolve bundled runtime without ARC_RUNTIME_DIST_DIR");
  if (probe.env?.copilotCommand !== null) fail("cold launch should not require AGENT_RUN_CACHE_COPILOT_COMMAND");
  if (probe.env?.acpAgentCommand !== null) fail("cold launch should not require AGENT_RUN_CACHE_ACP_AGENT_COMMAND");

  const panelUrl = String(probe.bootstrap?.arcPanelUrl ?? "");
  if (!panelUrl.startsWith("http://127.0.0.1:")) fail("main process did not self-start a loopback memory panel");
  if (probe.renderer?.arcPanelUrl !== panelUrl) fail("preload did not expose the main-process panel URL");
  if (probe.renderer?.hasArcStartMemoryCopy) fail("renderer still contains stale arc start Memory guidance");
  if (!probe.panel?.ok) fail("memory panel was not reachable from the packaged app");

  let panelStatus = null;
  try {
    panelStatus = JSON.parse(String(probe.panel.body ?? "{}"));
  } catch {
    fail("memory panel status was not valid JSON");
  }
  if (panelStatus.workspace !== expected.workspace) {
    fail(`memory panel did not use inherited PWD as workspace; expected ${expected.workspace}, got ${panelStatus.workspace}`);
  }
  if (!String(panelStatus.cacheDir ?? "").endsWith("/.agent-run-cache")) {
    fail("memory panel status did not expose a workspace cache dir");
  }
}

function findNewestAppBundle(dir) {
  const apps = findAppBundles(dir)
    .map((path) => ({ path, mtimeMs: statSync(path).mtimeMs }))
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
  return apps[0]?.path ?? null;
}

function findAppBundles(dir) {
  if (!existsSync(dir)) return [];
  const result = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory() && entry.name.endsWith(".app")) {
      result.push(path);
    } else if (entry.isDirectory()) {
      result.push(...findAppBundles(path));
    }
  }
  return result;
}

function relative(path) {
  return path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path;
}
