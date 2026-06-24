import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join, resolve } from "path";
import { describe, expect, it } from "vitest";
import {
  getArcRuntimeCandidates,
  resolveArcPanelWorkspace,
  resolveArcAppServerPath,
  resolveArcRuntimeDistDir,
} from "../arc-runtime";

describe("arc runtime paths", () => {
  it("uses ARC_RUNTIME_DIST_DIR when it contains the runtime", () => {
    const root = mkdtempSync(join(tmpdir(), "arc-runtime-env-"));
    const dist = join(root, "dist");
    try {
      writeRuntimeFiles(dist);

      expect(resolveArcRuntimeDistDir({
        env: { ARC_RUNTIME_DIST_DIR: dist },
        cwd: join(root, "missing-cwd"),
        fromDir: join(root, "missing-from"),
      })).toBe(dist);
      expect(resolveArcAppServerPath({
        env: { ARC_RUNTIME_DIST_DIR: dist },
        cwd: join(root, "missing-cwd"),
        fromDir: join(root, "missing-from"),
      })).toBe(join(dist, "app-server.js"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("finds the bundled runtime under Electron resources", () => {
    const root = mkdtempSync(join(tmpdir(), "arc-runtime-resources-"));
    const resourcesPath = join(root, "resources");
    const dist = join(resourcesPath, "arc-runtime", "dist");
    try {
      writeRuntimeFiles(dist);

      expect(resolveArcRuntimeDistDir({
        env: {},
        cwd: join(root, "missing-cwd"),
        fromDir: join(root, "missing-from"),
        resourcesPath,
      })).toBe(dist);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("ignores partial runtime directories", () => {
    const root = mkdtempSync(join(tmpdir(), "arc-runtime-partial-"));
    const resourcesPath = join(root, "resources");
    const dist = join(resourcesPath, "arc-runtime", "dist");
    try {
      mkdirSync(dist, { recursive: true });
      writeFileSync(join(dist, "retrieval.js"), "", { flag: "w" });

      expect(resolveArcRuntimeDistDir({
        env: {},
        cwd: join(root, "missing-cwd"),
        fromDir: join(root, "missing-from"),
        resourcesPath,
      })).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps candidate order stable", () => {
    const root = mkdtempSync(join(tmpdir(), "arc-runtime-candidates-"));
    const fromDir = join(root, "apps", "arc-app", "electron", "dist");
    try {
      expect(getArcRuntimeCandidates({
        env: { ARC_RUNTIME_DIST_DIR: join(root, "explicit") },
        cwd: join(root, "workspace"),
        fromDir,
        resourcesPath: join(root, "resources"),
      })).toEqual([
        join(root, "explicit"),
        join(root, "resources", "arc-runtime", "dist"),
        join(root, "workspace", "dist"),
        resolve(fromDir, "../../../../dist"),
        resolve(dirname(fromDir), "../../../../dist"),
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("uses ARC_INITIAL_PROJECT as the packaged panel workspace", () => {
    const root = mkdtempSync(join(tmpdir(), "arc-panel-workspace-"));
    const initial = join(root, "initial");
    const pwd = join(root, "pwd");
    const home = join(root, "home");
    try {
      mkdirSync(initial);
      mkdirSync(pwd);
      mkdirSync(home);

      expect(resolveArcPanelWorkspace({
        cwd: "/",
        env: { ARC_INITIAL_PROJECT: initial, PWD: pwd },
        homeDir: home,
      })).toBe(initial);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("uses inherited PWD when packaged Electron cwd is the filesystem root", () => {
    const root = mkdtempSync(join(tmpdir(), "arc-panel-pwd-"));
    const pwd = join(root, "pwd");
    const home = join(root, "home");
    try {
      mkdirSync(pwd);
      mkdirSync(home);

      expect(resolveArcPanelWorkspace({
        cwd: "/",
        env: { PWD: pwd },
        homeDir: home,
      })).toBe(pwd);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("falls back to the user home instead of the filesystem root", () => {
    const root = mkdtempSync(join(tmpdir(), "arc-panel-home-"));
    const home = join(root, "home");
    try {
      mkdirSync(home);

      expect(resolveArcPanelWorkspace({
        cwd: "/",
        env: {},
        homeDir: home,
      })).toBe(home);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

function writeRuntimeFiles(dist: string): void {
  mkdirSync(dist, { recursive: true });
  for (const file of ["app-server.js", "ledger.js", "panel.js", "retrieval.js", "review-decision.js", "store.js"]) {
    writeFileSync(join(dist, file), "", { flag: "w" });
  }
}
