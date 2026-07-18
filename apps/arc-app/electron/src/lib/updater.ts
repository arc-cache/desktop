import { app, ipcMain, BrowserWindow, powerMonitor } from "electron";
import { autoUpdater } from "electron-updater";
import type { UpdateInfo, ProgressInfo } from "electron-updater";
import { log } from "./logger";
import { reportError } from "./error-utils";
import { getAppSetting } from "./app-settings";
import { onSettingsChanged } from "../ipc/settings";
import { openExternalUrl } from "./external-url";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- accessing internal MacUpdater state for diagnostics
type MacUpdaterInternal = { squirrelDownloadedUpdate?: boolean };

// Track the latest downloaded update version for manual download fallback.
let lastDownloadedVersion: string | null = null;

// Flag to prevent window-all-closed from calling app.quit() while quitAndInstall() is
// managing the quit lifecycle (Squirrel.Mac needs control of the process on macOS).
let installingUpdate = false;
let updateCheckInFlight = false;
let lastUpdateCheckAt = 0;
let updateFeedUnavailableLogged = false;

export const STARTUP_UPDATE_CHECK_DELAY_MS = 5_000;
export const PERIODIC_UPDATE_CHECK_INTERVAL_MS = 4 * 60 * 60 * 1_000;
export const ACTIVE_UPDATE_CHECK_MIN_INTERVAL_MS = 30 * 60 * 1_000;

export function getIsInstallingUpdate(): boolean {
  return installingUpdate;
}

function isCurrentVersionPreRelease(): boolean {
  return app.getVersion().includes("-");
}

function syncUpdateChannelPreferences(allowPrereleaseUpdates: boolean): void {
  autoUpdater.allowPrerelease = allowPrereleaseUpdates;
  autoUpdater.allowDowngrade = !allowPrereleaseUpdates && isCurrentVersionPreRelease();
}

/** @internal Exported for testing. */
export function getErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function manualDownloadUrl(): string {
  return lastDownloadedVersion
    ? `https://github.com/arc-cache/desktop/releases/tag/v${lastDownloadedVersion}`
    : "https://github.com/arc-cache/desktop/releases/latest";
}

function openManualDownloadPage(getMainWindow: () => BrowserWindow | null, message: string): void {
  void openExternalUrl(manualDownloadUrl());
  getMainWindow()?.webContents.send("updater:install-error", { message });
}

function isUpdateFeedUnavailable(err: unknown): boolean {
  const message = getErrorMessage(err);
  return /\b404\b/.test(message) && /releases\.atom|latest(?:-mac)?\.yml|app-update\.yml/i.test(message);
}

/** @internal Exported for testing. */
export async function checkForUpdates(reason: string): Promise<void> {
  if (updateCheckInFlight) {
    log("UPDATER_DEBUG", `Skipping "${reason}" check; update check already in progress`);
    return;
  }

  updateCheckInFlight = true;
  lastUpdateCheckAt = Date.now();

  try {
    log("UPDATER_DEBUG", `Running update check (${reason})`);
    await autoUpdater.checkForUpdates();
  } catch (err) {
    if (isUpdateFeedUnavailable(err)) {
      if (!updateFeedUnavailableLogged || reason === "manual") {
        updateFeedUnavailableLogged = true;
        log("UPDATER_WARN", `Update feed unavailable (${reason}); skipping automatic update error reporting`);
      }
      return;
    }
    reportError("UPDATER_ERR", err, { reason });
  } finally {
    updateCheckInFlight = false;
  }
}

/** @internal Exported for testing. */
export function maybeCheckForUpdates(reason: string, minIntervalMs: number): void {
  const elapsedMs = Date.now() - lastUpdateCheckAt;
  if (elapsedMs < minIntervalMs) return;
  void checkForUpdates(reason);
}

export function initAutoUpdater(
  getMainWindow: () => BrowserWindow | null,
): void {
  if (!app.isPackaged) return;

  autoUpdater.logger = {
    info: (msg: unknown) => log("UPDATER", String(msg)),
    warn: (msg: unknown) => log("UPDATER_WARN", String(msg)),
    error: (msg: unknown) => log("UPDATER_ERR", String(msg)),
    debug: (msg: unknown) => log("UPDATER_DEBUG", String(msg)),
  };

  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;
  // Read persisted preference (defaults to false)
  syncUpdateChannelPreferences(getAppSetting("allowPrereleaseUpdates"));

  // React to setting changes at runtime (e.g. user toggles in Settings UI)
  onSettingsChanged((settings) => {
    syncUpdateChannelPreferences(settings.allowPrereleaseUpdates);
    log(
      "UPDATER",
      `allowPrerelease changed to ${settings.allowPrereleaseUpdates}; allowDowngrade=${autoUpdater.allowDowngrade}`,
    );

    if (!settings.allowPrereleaseUpdates && isCurrentVersionPreRelease()) {
      void checkForUpdates("switch-to-stable");
    }
  });

  autoUpdater.on("update-available", (info: UpdateInfo) => {
    log("UPDATER", `Update available: ${info.version}`);
    const win = getMainWindow();
    win?.webContents.send("updater:update-available", {
      version: info.version,
      releaseNotes: info.releaseNotes,
    });
  });

  autoUpdater.on("update-not-available", () => {
    log("UPDATER", "No update available");
  });

  autoUpdater.on("download-progress", (progress: ProgressInfo) => {
    const win = getMainWindow();
    win?.webContents.send("updater:download-progress", {
      percent: progress.percent,
      bytesPerSecond: progress.bytesPerSecond,
      total: progress.total,
      transferred: progress.transferred,
    });
  });

  autoUpdater.on("update-downloaded", (info: UpdateInfo) => {
    log("UPDATER", `Update downloaded: ${info.version}`);
    lastDownloadedVersion = info.version;
    const win = getMainWindow();
    win?.webContents.send("updater:update-downloaded", {
      version: info.version,
    });
  });

  autoUpdater.on("error", (err: Error) => {
    if (isUpdateFeedUnavailable(err)) {
      if (!updateFeedUnavailableLogged) {
        updateFeedUnavailableLogged = true;
        log("UPDATER_WARN", "Update feed unavailable; automatic update checks will stay quiet until the next check window");
      }
      return;
    }
    reportError("UPDATER_ERR", err);
  });

  // IPC handlers for renderer
  ipcMain.handle("updater:download", () => autoUpdater.downloadUpdate());
  ipcMain.handle("updater:install", async () => {
    if (process.platform === "darwin") {
      // squirrelDownloadedUpdate is a macOS-only property on MacUpdater — doesn't exist on
      // NsisUpdater (Windows) or AppImageUpdater (Linux), so only check it on macOS.
      const squirrelReady = (autoUpdater as unknown as MacUpdaterInternal).squirrelDownloadedUpdate;
      log("UPDATER", `Install requested (macOS, squirrelReady=${squirrelReady})`);

      if (!squirrelReady) {
        log("UPDATER", "Squirrel.Mac unavailable; opening manual download page");
        openManualDownloadPage(
          getMainWindow,
          "Automatic install requires a signed update. The download page has been opened; please install manually.",
        );
        return;
      }
    } else {
      log("UPDATER", `Install requested (${process.platform})`);

      // On Windows/Linux, there's no squirrelDownloadedUpdate flag — just verify the
      // update-downloaded event has fired (tracked by lastDownloadedVersion).
      if (!lastDownloadedVersion) {
        log("UPDATER_ERR", "Cannot install: no update has been downloaded yet");
        const win = getMainWindow();
        win?.webContents.send("updater:install-error", {
          message: "Update failed to download. Try downloading the latest version manually.",
        });
        return;
      }
    }

    installingUpdate = true;
    // Force-close all windows so the updater has clean control of the quit lifecycle.
    for (const win of BrowserWindow.getAllWindows()) {
      win.destroy(); // destroy() skips beforeunload/close events — immediate teardown
    }
    // Defer to next tick so window destruction propagates before the installer takes over
    setImmediate(() => {
      log("UPDATER", "Calling quitAndInstall()");
      autoUpdater.quitAndInstall();
    });
  });
  ipcMain.handle("updater:check", () => checkForUpdates("manual"));
  ipcMain.handle("updater:current-version", () => app.getVersion());

  // Check 5s after startup, then every 4 hours
  setTimeout(() => {
    void checkForUpdates("startup");
  }, STARTUP_UPDATE_CHECK_DELAY_MS);

  setInterval(
    () => {
      void checkForUpdates("periodic");
    },
    PERIODIC_UPDATE_CHECK_INTERVAL_MS,
  );

  powerMonitor.on("resume", () => {
    maybeCheckForUpdates("resume", ACTIVE_UPDATE_CHECK_MIN_INTERVAL_MS);
  });

  app.on("browser-window-focus", () => {
    maybeCheckForUpdates("focus", ACTIVE_UPDATE_CHECK_MIN_INTERVAL_MS);
  });
}

/**
 * @internal Exported for testing — resets module-level state between test runs.
 * Not needed in production since the module is loaded once per process.
 */
export function __resetForTesting(): void {
  lastDownloadedVersion = null;
  installingUpdate = false;
  updateCheckInFlight = false;
  lastUpdateCheckAt = 0;
  updateFeedUnavailableLogged = false;
}
