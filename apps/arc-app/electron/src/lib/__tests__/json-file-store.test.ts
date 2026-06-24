import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockApp, mockSafeStorage, userDataDir } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fs = require("node:fs") as typeof import("node:fs");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const os = require("node:os") as typeof import("node:os");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const path = require("node:path") as typeof import("node:path");

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "arc-json-file-store-"));
  return {
    userDataDir: dir,
    mockApp: {
      isPackaged: true,
      getPath: vi.fn((name: string) => {
        if (name === "userData") return dir;
        return path.join(dir, name);
      }),
    },
    mockSafeStorage: {
      isEncryptionAvailable: vi.fn(() => true),
      encryptString: vi.fn((value: string) => Buffer.from(`encrypted:${value}`, "utf8")),
      decryptString: vi.fn((value: Buffer) => value.toString("utf8").replace(/^encrypted:/, "")),
    },
  };
});

vi.mock("electron", () => ({
  app: mockApp,
  safeStorage: mockSafeStorage,
}));

vi.mock("../logger", () => ({
  log: vi.fn(),
}));

vi.mock("../error-utils", () => ({
  reportError: vi.fn((_label: string, err: unknown) => err instanceof Error ? err.message : String(err)),
}));

import { JsonFileStore } from "../json-file-store";

type StoredValue = { value: string };

function resetUserData(): void {
  fs.rmSync(userDataDir, { recursive: true, force: true });
  fs.mkdirSync(userDataDir, { recursive: true });
}

describe("JsonFileStore", () => {
  beforeEach(() => {
    resetUserData();
    vi.clearAllMocks();
  });

  it("does not touch safeStorage when an encrypted value is missing", () => {
    const store = new JsonFileStore<StoredValue>({
      subDir: "mcp",
      encrypt: true,
      label: "TEST_STORE",
    });

    expect(store.load("project-id")).toBeNull();
    expect(mockSafeStorage.isEncryptionAvailable).not.toHaveBeenCalled();
    expect(mockSafeStorage.decryptString).not.toHaveBeenCalled();
  });

  it("encrypts saved values when safeStorage is available", () => {
    const store = new JsonFileStore<StoredValue>({
      subDir: "mcp",
      encrypt: true,
      label: "TEST_STORE",
    });

    store.save("project-id", { value: "secret" });

    const filePath = path.join(userDataDir, "openacpui-data", "mcp", "project-id.json");
    expect(fs.readFileSync(filePath, "utf8")).toContain("encrypted:");
    expect(mockSafeStorage.isEncryptionAvailable).toHaveBeenCalledTimes(1);
    expect(mockSafeStorage.encryptString).toHaveBeenCalledWith(JSON.stringify({ value: "secret" }, null, 2));
  });

  it("decrypts existing encrypted values", () => {
    const store = new JsonFileStore<StoredValue>({
      subDir: "mcp",
      encrypt: true,
      label: "TEST_STORE",
    });

    const fileDir = path.join(userDataDir, "openacpui-data", "mcp");
    fs.mkdirSync(fileDir, { recursive: true });
    fs.writeFileSync(
      path.join(fileDir, "project-id.json"),
      Buffer.from(`encrypted:${JSON.stringify({ value: "secret" })}`),
    );

    expect(store.load("project-id")).toEqual({ value: "secret" });
    expect(mockSafeStorage.isEncryptionAvailable).toHaveBeenCalledTimes(1);
    expect(mockSafeStorage.decryptString).toHaveBeenCalledTimes(1);
  });
});
