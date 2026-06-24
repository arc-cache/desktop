import { execSync } from "child_process";
import { app, BrowserWindow, clipboard, globalShortcut, ipcMain, Menu, nativeTheme, session, systemPreferences, webContents } from "electron";
import { writeFileSync } from "fs";
import path from "path";
import http from "http";
import { pathToFileURL } from "url";
import contextMenu from "electron-context-menu";
import { getBootstrapMinWindowWidth } from "../../src/lib/layout/constants";

// Packaged .app bundles launched from Finder get a minimal PATH (/usr/bin:/bin).
// Inherit the user's shell PATH so child processes (SDK's `node`, git, etc.) resolve.
if (process.platform !== "win32") {
  try {
    const shell = process.env.SHELL || "/bin/zsh";
    const shellPath = execSync(`${shell} -ilc 'echo -n "$PATH"'`, {
      encoding: "utf8",
      timeout: 5000,
    });
    if (shellPath) process.env.PATH = shellPath;
  } catch {
    // Fall through — keep whatever PATH we already have
  }
}
import { log } from "./lib/logger";
import { reportError } from "./lib/error-utils";
import { migrateFromOpenAcpUi } from "./lib/migration";
import { glassEnabled, applyGlass, setGlassTint } from "./lib/glass";
import { getAppSettings } from "./lib/app-settings";
import { initAutoUpdater, getIsInstallingUpdate } from "./lib/updater";
import { initPreReleaseCheck } from "./lib/prerelease-check";
import { terminals } from "./ipc/terminal";
import { listAgents } from "./lib/agent-registry";
import { openExternalUrl } from "./lib/external-url";
import { resolveArcPanelWorkspace, resolveArcRuntimeDistDir } from "./lib/arc-runtime";
import { handleTeamDeepLink, isTeamDeepLinkUrl } from "./lib/team-service";

// IPC module registrations
import * as spacesIpc from "./ipc/spaces";
import * as projectsIpc from "./ipc/projects";
import * as sessionsIpc from "./ipc/sessions";
import * as foldersIpc from "./ipc/folders";
import * as ccImportIpc from "./ipc/cc-import";
import * as filesIpc from "./ipc/files";
import * as claudeSessionsIpc from "./ipc/claude-sessions";
import * as titleGenIpc from "./ipc/title-gen";
import * as terminalIpc from "./ipc/terminal";
import * as gitIpc from "./ipc/git";
import * as agentRegistryIpc from "./ipc/agent-registry";
import * as acpSessionsIpc from "./ipc/acp-sessions";
import * as codexSessionsIpc from "./ipc/codex-sessions";
import * as copilotSessionsIpc from "./ipc/copilot-sessions";
import * as mcpIpc from "./ipc/mcp";
import * as settingsIpc from "./ipc/settings";
import * as jiraIpc from "./ipc/jira";
import * as teamIpc from "./ipc/team";

// --- Performance: Chromium/V8 flags (must be set before app.whenReady()) ---
app.commandLine.appendSwitch("enable-gpu-rasterization"); // force GPU raster for all content
app.commandLine.appendSwitch("enable-zero-copy"); // avoid CPU→GPU memory copies for tiles
app.commandLine.appendSwitch("ignore-gpu-blocklist"); // use GPU even on blocklisted hardware
app.commandLine.appendSwitch("enable-features", "CanvasOopRasterization"); // off-main-thread canvas

const devToolsEnabled = !app.isPackaged;

// --- Liquid Glass command-line switches ---
if (glassEnabled && devToolsEnabled) {
  if (!app.commandLine.hasSwitch("remote-debugging-port")) {
    app.commandLine.appendSwitch("remote-debugging-port", "9222");
  }
  if (!app.commandLine.hasSwitch("remote-allow-origins")) {
    app.commandLine.appendSwitch("remote-allow-origins", "*");
  }
}

let mainWindow: BrowserWindow | null = null;
let managedPanel: { close(): Promise<void> } | null = null;
let arcPanelUrl: string | null = process.env.ARC_PANEL_URL ?? null;
const teamDeepLinkProtocol = "agent-run-cache";

const singleInstanceLock = app.requestSingleInstanceLock();
if (!singleInstanceLock) {
  app.quit();
}

if (process.defaultApp && process.argv.length >= 2) {
  app.setAsDefaultProtocolClient(teamDeepLinkProtocol, process.execPath, [path.resolve(process.argv[1])]);
} else {
  app.setAsDefaultProtocolClient(teamDeepLinkProtocol);
}

import type { ThemeOption, MacBackgroundEffect as SharedMacBackgroundEffect } from "@shared/types/settings";

/** In main process, "off" is never applied — it resolves to vibrancy or liquid-glass before use. */
type MacBackgroundEffect = Exclude<SharedMacBackgroundEffect, "off">;

let pendingMacBackgroundEffect: MacBackgroundEffect = "liquid-glass";

function normalizeThemeSource(value: unknown): ThemeOption {
  return value === "light" || value === "dark" || value === "system"
    ? value
    : "system";
}

function normalizeMacBackgroundEffect(value: unknown): MacBackgroundEffect {
  return value === "vibrancy" ? "vibrancy" : "liquid-glass";
}

function getMacBackgroundEffectSupport(): { liquidGlass: boolean; vibrancy: boolean } {
  return {
    liquidGlass: glassEnabled,
    vibrancy: process.platform === "darwin",
  };
}

function resolveMacBackgroundEffect(effect: MacBackgroundEffect): MacBackgroundEffect {
  const support = getMacBackgroundEffectSupport();
  if (effect === "liquid-glass" && !support.liquidGlass) {
    return "vibrancy";
  }
  return effect;
}

function applyMacBackgroundEffect(effect: MacBackgroundEffect): void {
  if (process.platform !== "darwin" || !mainWindow || mainWindow.isDestroyed()) return;

  const resolved = resolveMacBackgroundEffect(effect);
  pendingMacBackgroundEffect = resolved;

  if (resolved === "vibrancy") {
    mainWindow.setVibrancy("under-window", { animationDuration: 120 });
    return;
  }

  mainWindow.setVibrancy(null);
  if (!glassEnabled || mainWindow.webContents.isLoadingMainFrame()) return;

  const glassId = applyGlass(mainWindow.getNativeWindowHandle());
  if (glassId === -1) {
    log("GLASS", "addView returned -1 — native addon failed, glass will not be visible");
  } else {
    log("GLASS", `Liquid glass applied, viewId=${glassId}`);
  }
}

function getMainWindow(): BrowserWindow | null {
  return mainWindow;
}

function focusMainWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  if (!mainWindow.isVisible()) mainWindow.show();
  mainWindow.focus();
}

async function ensureArcPanelUrl(): Promise<string | null> {
  if (arcPanelUrl) return arcPanelUrl;
  if (process.env.ARC_PANEL_URL) {
    arcPanelUrl = process.env.ARC_PANEL_URL;
    return arcPanelUrl;
  }

  const distDir = resolveArcRuntimeDistDir({ fromDir: __dirname });
  if (!distDir) {
    log("ARC_PANEL", "Unable to start memory panel: bundled ARC runtime not found");
    return null;
  }

  try {
    const panelModule = await import(pathToFileURL(path.join(distDir, "panel.js")).href) as {
      startPanel?: (options?: { workspace?: string }) => Promise<{ url: string; close(): Promise<void> }>;
    };
    if (typeof panelModule.startPanel !== "function") {
      log("ARC_PANEL", `Unable to start memory panel: startPanel missing in ${distDir}`);
      return;
    }
    const workspace = resolveArcPanelWorkspace({
      cwd: process.cwd(),
      env: process.env,
      homeDir: app.getPath("home"),
    });
    managedPanel = await panelModule.startPanel({ workspace });
    arcPanelUrl = managedPanel.url;
    log("ARC_PANEL", `Started bundled memory panel at ${arcPanelUrl} for ${workspace}`);
    return arcPanelUrl;
  } catch (err) {
    reportError("ARC_PANEL", err, { context: "start-bundled-panel" });
    return null;
  }
}

function rendererBootstrapArguments(): string[] {
  const args: string[] = [];
  addRendererBootstrapArgument(args, "arc-panel-url", arcPanelUrl);
  addRendererBootstrapArgument(args, "arc-initial-project", process.env.ARC_INITIAL_PROJECT ?? null);
  return args;
}

function addRendererBootstrapArgument(args: string[], name: string, value: string | null): void {
  if (!value) return;
  args.push(`--${name}=${encodeURIComponent(value)}`);
}

async function closeManagedPanel(): Promise<void> {
  const panel = managedPanel;
  managedPanel = null;
  if (!panel) return;
  try {
    await panel.close();
  } catch (err) {
    reportError("ARC_PANEL", err, { context: "shutdown" });
  }
}

function isMainRendererPermissionRequest(webContents: Electron.WebContents | null): boolean {
  return !!webContents && webContents.id === mainWindow?.webContents.id;
}

function installContentSecurityPolicy(): void {
  if (!app.isPackaged) return;

  const csp = [
    "default-src 'self'",
    "script-src 'self' 'wasm-unsafe-eval'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: file: https:",
    "font-src 'self' data:",
    [
      "connect-src 'self'",
      "http://127.0.0.1:*",
      "http://localhost:*",
      "ws://127.0.0.1:*",
      "ws://localhost:*",
      "https://cdn.agentclientprotocol.com",
      "https://huggingface.co",
      "https://*.huggingface.co",
      "https://*.hf.co",
      "https://*.xethub.hf.co",
      "https://cdn-lfs.huggingface.co",
      "https://*.supabase.co",
    ].join(" "),
    "media-src 'self' data: blob:",
    "worker-src 'self' blob:",
    "frame-src http: https: file:",
    "child-src http: https: file:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'none'",
  ].join("; ");

  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    let protocol = "";
    try {
      protocol = new URL(details.url).protocol;
    } catch {
      // Leave malformed or custom URLs alone.
    }
    if (protocol !== "file:") {
      callback({ responseHeaders: details.responseHeaders ?? {} });
      return;
    }

    callback({
      responseHeaders: {
        ...(details.responseHeaders ?? {}),
        "Content-Security-Policy": [csp],
      },
    });
  });
}

function createWindow(): void {
  const initialMacBackgroundEffect: MacBackgroundEffect = resolveMacBackgroundEffect(pendingMacBackgroundEffect);
  if (process.platform === "darwin") {
    pendingMacBackgroundEffect = initialMacBackgroundEffect;
  }

  const windowOptions: Electron.BrowserWindowConstructorOptions = {
    show: false,
    width: 1200,
    height: 800,
    // Matches the renderer's stricter island-layout minimum before first IPC sync,
    // including the extra Windows frame buffer.
    minWidth: getBootstrapMinWindowWidth(process.platform),
    minHeight: 600,
    // Packaged builds get the icon from the .app bundle / electron-builder config
    ...(!app.isPackaged && { icon: path.join(__dirname, "../../build/icon.png") }),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true,
      additionalArguments: rendererBootstrapArguments(),
      devTools: devToolsEnabled && !glassEnabled,
      v8CacheOptions: "bypassHeatCheckAndEagerCompile", // cache compiled JS on first run — eliminates cold-start jank
    },
  };

  if (process.platform === "darwin") {
    windowOptions.titleBarStyle = "hidden";
    windowOptions.transparent = true;
    windowOptions.backgroundColor = "#00000000";
    windowOptions.trafficLightPosition = { x: 19, y: 19 };
  } else if (process.platform === "win32") {
    // Windows: native Electron backgroundMaterial handles DWM mica/acrylic.
    // WebContents is automatically transparent (no transparent: true needed),
    // and the native title bar stays intact.
    windowOptions.autoHideMenuBar = true;
    windowOptions.backgroundMaterial = "mica";
  } else {
    // macOS without glass / Linux
    windowOptions.titleBarStyle = "hiddenInset";
    windowOptions.trafficLightPosition = { x: 19, y: 19 };
    windowOptions.backgroundColor = "#141414";
  }

  mainWindow = new BrowserWindow(windowOptions);
  if (process.platform === "darwin") applyMacBackgroundEffect(initialMacBackgroundEffect);

  mainWindow.once("ready-to-show", () => {
    if (process.env.ARC_PACKAGED_PROBE_FILE) return;
    mainWindow?.show();
  });

  if (process.platform === "darwin") {
    mainWindow.on("focus", () => {
      applyMacBackgroundEffect(pendingMacBackgroundEffect);
    });
  }

  contextMenu({
    window: mainWindow,
    showSearchWithGoogle: false,
    showLookUpSelection: false,
    showInspectElement: false,
  });

  const useBuiltRenderer = app.isPackaged || process.env.ARC_RENDERER_MODE === "built";
  if (useBuiltRenderer) {
    mainWindow.loadFile(path.join(__dirname, "../../dist/index.html"));
  } else {
    mainWindow.loadURL("http://localhost:5173");
  }

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void openExternalUrl(url);
    return { action: "deny" };
  });
  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (url === mainWindow?.webContents.getURL()) return;
    event.preventDefault();
    void openExternalUrl(url);
  });

  if (process.platform === "darwin") {
    mainWindow.webContents.once("did-finish-load", () => {
      applyMacBackgroundEffect(pendingMacBackgroundEffect);
    });
  }

  mainWindow.webContents.once("did-finish-load", () => {
    void writePackagedProbe(mainWindow);
  });
}

async function writePackagedProbe(window: BrowserWindow | null): Promise<void> {
  const probeFile = process.env.ARC_PACKAGED_PROBE_FILE;
  if (!probeFile || !window || window.isDestroyed()) return;
  try {
    const renderer = await window.webContents.executeJavaScript(`
      (() => {
        const bridge = window.claude || {};
        const bodyText = document.body?.innerText || "";
        return {
          location: window.location.href,
          title: document.title,
          arcInitialProjectPath: bridge.arcInitialProjectPath ?? null,
          arcPanelUrl: bridge.arcPanelUrl ?? null,
          hasArcStartMemoryCopy: bodyText.includes("Launch the app with arc start") || bodyText.includes("is arc start still running"),
          hasMemoryText: bodyText.includes("Memory"),
          hasCopilotText: bodyText.includes("Copilot")
        };
      })()
    `, true);
    const agents = listAgents();
    const panel = await probePanel(arcPanelUrl ?? process.env.ARC_PANEL_URL);
    writeFileSync(probeFile, JSON.stringify({
      ok: true,
      isPackaged: app.isPackaged,
      rendererMode: process.env.ARC_RENDERER_MODE ?? null,
      rendererUrl: window.webContents.getURL(),
      bootstrap: {
        arcPanelUrl,
      },
      env: {
        arcAcpBinary: process.env.ARC_ACP_BINARY ?? null,
        arcAcpArgs: process.env.ARC_ACP_ARGS ?? null,
        arcInitialProject: process.env.ARC_INITIAL_PROJECT ?? null,
        arcPanelUrl: process.env.ARC_PANEL_URL ?? null,
        arcAppProvider: process.env.ARC_APP_PROVIDER ?? null,
        arcAppProviderBaseUrl: process.env.ARC_APP_PROVIDER_BASE_URL ?? null,
        arcAppModel: process.env.ARC_APP_MODEL ?? null,
        acpAgentCommand: process.env.AGENT_RUN_CACHE_ACP_AGENT_COMMAND ?? null,
        copilotCommand: process.env.AGENT_RUN_CACHE_COPILOT_COMMAND ?? null,
        arcRuntimeDistDir: process.env.ARC_RUNTIME_DIST_DIR ?? null
      },
      agents: {
        hasCopilot: agents.some((agent) => agent.id === "copilot"),
        copilot: agents.find((agent) => agent.id === "copilot") ?? null,
        hasArcCopilot: agents.some((agent) => agent.id === "arc-copilot")
      },
      renderer,
      panel
    }, null, 2));
    app.exit(0);
  } catch (err) {
    try {
      writeFileSync(probeFile, JSON.stringify({
        ok: false,
        error: err instanceof Error ? err.message : String(err)
      }, null, 2));
    } catch {
      /* ignore probe write failures */
    }
    app.exit(1);
  }
}

function probePanel(panelUrl: string | undefined): Promise<Record<string, unknown>> {
  if (!panelUrl) return Promise.resolve({ ok: false, error: "ARC_PANEL_URL missing" });
  return new Promise((resolve) => {
    const request = http.get(new URL("/api/status", panelUrl), (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => {
        body += chunk;
      });
      response.on("end", () => {
        resolve({
          ok: !!response.statusCode && response.statusCode >= 200 && response.statusCode < 300,
          statusCode: response.statusCode,
          body: body.slice(0, 1000)
        });
      });
    });
    request.setTimeout(5000, () => {
      request.destroy(new Error("panel probe timed out"));
    });
    request.on("error", (error) => {
      resolve({ ok: false, error: error.message });
    });
  });
}

// Renderer uses this to decide whether the transparency toggle is available.
ipcMain.handle("app:getGlassSupported", () => {
  return process.platform === "darwin" || process.platform === "win32";
});

ipcMain.handle("app:get-mac-background-effect-support", () => {
  return getMacBackgroundEffectSupport();
});

ipcMain.on("app:set-theme-source", (_event, themeSource: unknown) => {
  nativeTheme.themeSource = normalizeThemeSource(themeSource);
});

ipcMain.on("app:set-mac-background-effect", (_event, effect: unknown) => {
  const normalized = normalizeMacBackgroundEffect(effect);
  pendingMacBackgroundEffect = normalized;
  applyMacBackgroundEffect(normalized);
});

ipcMain.handle("app:relaunch", () => {
  try {
    app.relaunch();
    app.quit();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: reportError("APP_RELAUNCH", err) };
  }
});

ipcMain.handle("clipboard:write-text", (_event, text: string) => {
  try {
    clipboard.writeText(text);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: reportError("CLIPBOARD_WRITE", err) };
  }
});

ipcMain.handle("browser:set-color-scheme", async (_event, payload: { targetWebContentsId: number; colorScheme: "light" | "dark" }) => {
  try {
    const targetId = payload?.targetWebContentsId;
    const colorScheme = payload?.colorScheme;

    if (!Number.isInteger(targetId)) {
      return { ok: false, error: "Invalid target webContents id" };
    }
    if (colorScheme !== "light" && colorScheme !== "dark") {
      return { ok: false, error: "Invalid browser color scheme" };
    }

    const target = webContents.fromId(targetId);
    if (!target || target.isDestroyed()) {
      return { ok: false, error: "Browser target is unavailable" };
    }

    if (!target.debugger.isAttached()) {
      target.debugger.attach("1.3");
    }

    await target.debugger.sendCommand("Emulation.setEmulatedMedia", {
      features: [{ name: "prefers-color-scheme", value: colorScheme }],
    });

    return { ok: true };
  } catch (err) {
    return { ok: false, error: reportError("BROWSER_COLOR_SCHEME", err) };
  }
});

// Dynamic minimum window width — renderer calculates based on which panels are open.
// Also expands the window if it's currently smaller than the new minimum (e.g. Tasks
// panel appeared while at min size), so content never overflows off-screen.
ipcMain.on("app:set-min-width", (_event, minWidth: number) => {
  if (mainWindow && Number.isFinite(minWidth) && minWidth >= 600) {
    const clamped = Math.min(Math.round(minWidth), 4000);
    const [, minH] = mainWindow.getMinimumSize();
    mainWindow.setMinimumSize(clamped, minH);
    // Grow the window if it's currently smaller than the new minimum
    const [currentW, currentH] = mainWindow.getSize();
    if (currentW < clamped) {
      mainWindow.setSize(clamped, currentH);
    }
  }
});

// Native glass tint — re-creates glass view with updated tintColor.
// The C++ addon auto-cleans previous views in a single dispatch_sync block.
const GLASS_TINT_RE = /^#[0-9a-fA-F]{8}$/;
ipcMain.on("glass:set-tint-color", (_event, tintColor: string | null) => {
  if (!glassEnabled) return;
  if (tintColor !== null && (typeof tintColor !== "string" || !GLASS_TINT_RE.test(tintColor))) {
    log("GLASS", `Ignoring invalid tintColor: ${String(tintColor)}`);
    return;
  }
  const viewId = setGlassTint(tintColor);
  if (viewId >= 0) {
    log("GLASS", `setTintColor=${tintColor}, viewId=${viewId}`);
  }
});

// Glass appearance — force light/dark/system on the native layer so the
// glass effect follows the app's theme setting, not just the OS preference.
ipcMain.on("glass:set-theme", (_event, theme: string) => {
  if (theme === "light" || theme === "dark" || theme === "system") {
    nativeTheme.themeSource = theme;
  }
});

// --- Register all IPC modules ---
spacesIpc.register();
projectsIpc.register(getMainWindow);
sessionsIpc.register();
foldersIpc.register();
ccImportIpc.register();
filesIpc.register(getMainWindow);
claudeSessionsIpc.register(getMainWindow);
titleGenIpc.register();
terminalIpc.register(getMainWindow);
gitIpc.register();
agentRegistryIpc.register();
acpSessionsIpc.register(getMainWindow);
codexSessionsIpc.register(getMainWindow);
copilotSessionsIpc.register(getMainWindow);
mcpIpc.register();
settingsIpc.register(getMainWindow);
jiraIpc.register();
teamIpc.register();

// --- DevTools in separate window via remote debugging ---
let devToolsWindow: BrowserWindow | null = null;

function openDevToolsWindow(): void {
  if (!devToolsEnabled) return;
  if (!glassEnabled) {
    mainWindow?.webContents.openDevTools({ mode: "detach" });
    return;
  }

  if (devToolsWindow && !devToolsWindow.isDestroyed()) {
    devToolsWindow.focus();
    return;
  }

  http.get("http://127.0.0.1:9222/json", (res) => {
    let body = "";
    res.on("data", (chunk: Buffer) => { body += chunk; });
    res.on("end", () => {
      try {
        const targets = JSON.parse(body) as Array<{ type: string; webSocketDebuggerUrl?: string }>;
        const page = targets.find((t) => t.type === "page");
        if (!page) {
          log("DEVTOOLS", "No debuggable page target found");
          return;
        }

        const wsUrl = page.webSocketDebuggerUrl;
        if (!wsUrl) {
          log("DEVTOOLS", "No webSocketDebuggerUrl in target");
          return;
        }

        const wsParam = encodeURIComponent(wsUrl.replace("ws://", ""));
        const fullUrl = `devtools://devtools/bundled/inspector.html?ws=${wsParam}`;

        devToolsWindow = new BrowserWindow({
          width: 1000,
          height: 700,
          title: "ARC DevTools",
          webPreferences: {
            contextIsolation: true,
            nodeIntegration: false,
          },
        });

        devToolsWindow.loadURL(fullUrl);
        devToolsWindow.on("closed", () => {
          devToolsWindow = null;
        });

        log("DEVTOOLS", `Opened DevTools window: ${fullUrl}`);
      } catch (err) {
        reportError("DEVTOOLS_ERR", err, { context: "parse-targets" });
      }
    });
  }).on("error", (err) => {
    reportError("DEVTOOLS_ERR", err, { context: "remote-debugging" });
  });
}

// --- App lifecycle ---
// --- Speech dictation IPC ---
ipcMain.handle("speech:start-native-dictation", () => {
  if (process.platform === "darwin") {
    // Sends the macOS Cocoa selector to start native dictation in the focused text field
    Menu.sendActionToFirstResponder("startDictation:");
    return { ok: true };
  }
  return { ok: false, reason: "not-supported" };
});

ipcMain.handle("speech:get-platform", () => process.platform);

ipcMain.handle("speech:request-mic-permission", async () => {
  if (process.platform === "darwin") {
    const status = systemPreferences.getMediaAccessStatus("microphone");
    if (status === "granted") return { granted: true };
    const granted = await systemPreferences.askForMediaAccess("microphone");
    return { granted };
  }
  // Windows/Linux don't require Electron-level mic permission — getUserMedia handles it
  return { granted: true };
});

if (singleInstanceLock) {
  app.on("second-instance", (_event, commandLine) => {
    handleTeamDeepLinks(commandLine);
    focusMainWindow();
  });

  app.on("open-url", (event, url) => {
    event.preventDefault();
    handleTeamDeepLinks([url]);
    focusMainWindow();
  });
}

function handleTeamDeepLinks(values: string[]): boolean {
  let handled = false;
  for (const value of values) {
    if (!isTeamDeepLinkUrl(value)) continue;
    handled = true;
    try {
      handleTeamDeepLink(value);
    } catch (err) {
      reportError("TEAM_DEEP_LINK", err, { url: value });
    }
  }
  return handled;
}

app.whenReady().then(async () => {
  // Migrate data from old "OpenACP UI" app directory before anything reads it
  migrateFromOpenAcpUi();
  if (process.platform === "darwin") {
    pendingMacBackgroundEffect = resolveMacBackgroundEffect(
      normalizeMacBackgroundEffect(getAppSettings().macBackgroundEffect),
    );
  }

  installContentSecurityPolicy();
  await ensureArcPanelUrl();
  createWindow();
  handleTeamDeepLinks(process.argv);
  initAutoUpdater(getMainWindow);
  initPreReleaseCheck(getMainWindow);

  // Allow microphone access for Whisper voice dictation (getUserMedia in renderer)
  session.defaultSession.setPermissionRequestHandler(
    (webContents, permission, callback) => {
      // Only grant privileged permissions to the app's main renderer, not webviews.
      if (isMainRendererPermissionRequest(webContents) && (permission === "media" || permission === "notifications")) {
        callback(true);
        return;
      }
      callback(false);
    },
  );
  session.defaultSession.setPermissionCheckHandler(
    (webContents, permission) => {
      if (isMainRendererPermissionRequest(webContents) && (permission === "media" || permission === "notifications")) {
        return true;
      }
      return false;
    },
  );

  // Set dock icon in dev mode — packaged builds get it from the .app bundle
  if (!app.isPackaged && process.platform === "darwin" && app.dock) {
    app.dock.setIcon(path.join(__dirname, "../../build/icon.png"));
  }

  if (devToolsEnabled) {
    const shortcuts = ["CommandOrControl+Alt+I", "F12", "CommandOrControl+Shift+J"];
    for (const shortcut of shortcuts) {
      const ok = globalShortcut.register(shortcut, () => {
        log("DEVTOOLS", `Shortcut ${shortcut} triggered`);
        openDevToolsWindow();
      });
      log("DEVTOOLS", `Register ${shortcut}: ${ok ? "OK" : "FAILED"}`);
    }
  }
});

app.on("will-quit", (event) => {
  globalShortcut.unregisterAll();

  // When an update is being installed, let the updater control the quit lifecycle.
  if (getIsInstallingUpdate()) {
    void closeManagedPanel();
    return;
  }

  event.preventDefault();

  closeManagedPanel()
    .catch((err) => {
      reportError("ARC_PANEL", err, { context: "shutdown" });
    })
    .finally(() => {
      app.exit(0);
    });
});

app.on("window-all-closed", () => {
  claudeSessionsIpc.stopAll();
  acpSessionsIpc.stopAll();
  codexSessionsIpc.stopAll();
  copilotSessionsIpc.stopAll();

  for (const [terminalId, term] of terminals) {
    log("CLEANUP", `Killing terminal ${terminalId.slice(0, 8)}`);
    term.pty.kill();
  }
  terminals.clear();

  // When quitAndInstall() is running, Squirrel.Mac needs to control the quit lifecycle.
  // Calling app.quit() here would kill the process before the update is applied on macOS.
  if (!getIsInstallingUpdate()) {
    app.quit();
  }
});
