import { ipcMain } from "electron";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { getProjectFoldersFilePath, getProjectSessionsDir } from "../lib/data-dir";
import { reportError } from "../lib/error-utils";

interface ChatFolder {
  id: string;
  projectId: string;
  name: string;
  createdAt: number;
  order: number;
  pinned?: boolean;
}

function readFolders(projectId: string): ChatFolder[] {
  const filePath = getProjectFoldersFilePath(projectId);
  if (!fs.existsSync(filePath)) return [];
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch {
    return [];
  }
}

function writeFolders(projectId: string, folders: ChatFolder[]): void {
  const filePath = getProjectFoldersFilePath(projectId);
  fs.writeFileSync(filePath, JSON.stringify(folders, null, 2), "utf-8");
}

/**
 * Clear folderId from all session files that reference a deleted folder.
 * Patches both .json and .meta.json files.
 */
async function clearFolderFromSessions(projectId: string, folderId: string): Promise<void> {
  const dir = getProjectSessionsDir(projectId);
  let files: string[];
  try {
    files = await fs.promises.readdir(dir);
  } catch {
    return; // no sessions dir
  }

  const metaFiles = files.filter((f) => f.endsWith(".meta.json"));
  for (const metaFile of metaFiles) {
    try {
      const metaPath = path.join(dir, metaFile);
      const raw = await fs.promises.readFile(metaPath, "utf-8");
      const meta = JSON.parse(raw);
      if (meta.folderId !== folderId) continue;

      // Clear from meta sidecar
      meta.folderId = undefined;
      await fs.promises.writeFile(metaPath, JSON.stringify(meta), "utf-8");

      // Clear from main session file
      const mainFile = metaFile.replace(/\.meta\.json$/, ".json");
      const mainPath = path.join(dir, mainFile);
      try {
        const mainRaw = await fs.promises.readFile(mainPath, "utf-8");
        const mainData = JSON.parse(mainRaw);
        if (mainData.folderId === folderId) {
          mainData.folderId = undefined;
          await fs.promises.writeFile(mainPath, JSON.stringify(mainData), "utf-8");
        }
      } catch {
        // main file missing or corrupted — skip
      }
    } catch {
      // skip corrupted meta files
    }
  }
}

export function register(): void {
  ipcMain.handle("folders:list", async (_event, projectId: string) => {
    try {
      return readFolders(projectId);
    } catch (err) {
      reportError("FOLDERS:LIST_ERR", err, { projectId });
      return [];
    }
  });

  ipcMain.handle("folders:create", async (_event, { projectId, name }: { projectId: string; name: string }) => {
    try {
      const folders = readFolders(projectId);
      const maxOrder = folders.reduce((max, f) => Math.max(max, f.order), -1);
      const folder: ChatFolder = {
        id: crypto.randomUUID(),
        projectId,
        name,
        createdAt: Date.now(),
        order: maxOrder + 1,
      };
      folders.push(folder);
      writeFolders(projectId, folders);
      return folder;
    } catch (err) {
      const message = reportError("FOLDERS:CREATE_ERR", err, { projectId });
      return { error: message };
    }
  });

  ipcMain.handle("folders:delete", async (_event, { projectId, folderId }: { projectId: string; folderId: string }) => {
    try {
      const folders = readFolders(projectId);
      const updated = folders.filter((f) => f.id !== folderId);
      writeFolders(projectId, updated);
      // Clear folderId from all sessions referencing this folder
      await clearFolderFromSessions(projectId, folderId);
      return { ok: true };
    } catch (err) {
      const message = reportError("FOLDERS:DELETE_ERR", err, { projectId, folderId });
      return { error: message };
    }
  });

  ipcMain.handle("folders:rename", async (_event, { projectId, folderId, name }: { projectId: string; folderId: string; name: string }) => {
    try {
      const folders = readFolders(projectId);
      const folder = folders.find((f) => f.id === folderId);
      if (folder) {
        folder.name = name;
        writeFolders(projectId, folders);
      }
      return { ok: true };
    } catch (err) {
      const message = reportError("FOLDERS:RENAME_ERR", err, { projectId, folderId });
      return { error: message };
    }
  });

  ipcMain.handle("folders:pin", async (_event, { projectId, folderId, pinned }: { projectId: string; folderId: string; pinned: boolean }) => {
    try {
      const folders = readFolders(projectId);
      const folder = folders.find((f) => f.id === folderId);
      if (folder) {
        folder.pinned = pinned || undefined;
        writeFolders(projectId, folders);
      }
      return { ok: true };
    } catch (err) {
      const message = reportError("FOLDERS:PIN_ERR", err, { projectId, folderId });
      return { error: message };
    }
  });
}
