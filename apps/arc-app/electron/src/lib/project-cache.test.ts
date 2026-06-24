import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ARC_PROJECT_CACHE_DIR,
  ensureGitExcludesProjectCache,
  findGitExcludePath,
  getProjectCacheDir,
  prepareProjectCache,
  resetProjectCache,
} from "./project-cache";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "arc-project-cache-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("project cache", () => {
  it("creates the local ARC cache directory in the selected project", () => {
    const result = prepareProjectCache(tmpDir);

    expect(result.cacheDir).toBe(path.join(tmpDir, ARC_PROJECT_CACHE_DIR));
    expect(fs.statSync(result.cacheDir).isDirectory()).toBe(true);
  });

  it("adds .agent-run-cache to the repo-local Git exclude", () => {
    const gitInfoDir = path.join(tmpDir, ".git", "info");
    fs.mkdirSync(gitInfoDir, { recursive: true });
    const excludePath = path.join(gitInfoDir, "exclude");
    fs.writeFileSync(excludePath, "# existing\n", "utf-8");

    const result = prepareProjectCache(tmpDir);

    expect(result.gitExcludePath).toBe(excludePath);
    expect(result.gitExcludeUpdated).toBe(true);
    expect(fs.readFileSync(excludePath, "utf-8")).toContain(".agent-run-cache/");
  });

  it("does not duplicate an existing local Git exclude", () => {
    const excludePath = path.join(tmpDir, ".git", "info", "exclude");
    fs.mkdirSync(path.dirname(excludePath), { recursive: true });
    fs.writeFileSync(excludePath, ".agent-run-cache/\n", "utf-8");

    const result = prepareProjectCache(tmpDir);

    expect(result.gitExcludeUpdated).toBe(false);
    expect(fs.readFileSync(excludePath, "utf-8").match(/\.agent-run-cache\//g)).toHaveLength(1);
  });

  it("resolves worktree-style .git files", () => {
    const realGitDir = path.join(tmpDir, "actual-git-dir");
    const worktreeDir = path.join(tmpDir, "worktree");
    fs.mkdirSync(realGitDir, { recursive: true });
    fs.mkdirSync(worktreeDir, { recursive: true });
    fs.writeFileSync(path.join(worktreeDir, ".git"), "gitdir: ../actual-git-dir\n", "utf-8");

    expect(findGitExcludePath(worktreeDir)).toBe(path.join(realGitDir, "info", "exclude"));
  });

  it("can update a direct exclude path", () => {
    const excludePath = path.join(tmpDir, ".git", "info", "exclude");

    expect(ensureGitExcludesProjectCache(excludePath)).toBe(true);
    expect(ensureGitExcludesProjectCache(excludePath)).toBe(false);
    expect(fs.readFileSync(excludePath, "utf-8").match(/\.agent-run-cache\//g)).toHaveLength(1);
  });

  it("resets only the ARC project cache directory", () => {
    const cacheDir = getProjectCacheDir(tmpDir);
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(path.join(cacheDir, "memory.jsonl"), "", "utf-8");
    fs.writeFileSync(path.join(tmpDir, "README.md"), "# kept\n", "utf-8");

    const result = resetProjectCache(tmpDir);

    expect(result.removed).toBe(true);
    expect(fs.existsSync(cacheDir)).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, "README.md"))).toBe(true);
  });
});
