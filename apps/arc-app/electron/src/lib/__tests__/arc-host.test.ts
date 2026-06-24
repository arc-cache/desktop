import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, describe, expect, it, vi } from "vitest";

const codexUtilityPromptMock = vi.hoisted(() => vi.fn());

vi.mock("electron", () => ({
  app: {
    isPackaged: false,
    getPath: () => tmpdir(),
  },
}));

vi.mock("../codex-utility-prompt", () => ({
  codexUtilityPrompt: codexUtilityPromptMock,
}));

interface ArcHostTestGlobals {
  __arcHostCalls?: {
    injectionPlans: unknown[];
    memoryEvents: unknown[];
    savedTraces: Array<{ events: Array<Record<string, unknown>>; sessionId: string; workspace: string }>;
    reviews: Array<{
      events: Array<Record<string, unknown>>;
      plan: unknown;
      runnerStatus: string;
      turnId: string;
      workspace: string;
      hasReviewer: boolean;
      reviewerResult?: unknown;
    }>;
    debug: unknown[];
  };
  __arcHostPlan?: unknown;
  __arcHostReview?: unknown;
  __arcHostInvokeReviewer?: boolean;
}

type TestGlobal = typeof globalThis & ArcHostTestGlobals;

describe("arc host native engine capture", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    codexUtilityPromptMock.mockReset();
    delete testGlobal().__arcHostCalls;
    delete testGlobal().__arcHostPlan;
    delete testGlobal().__arcHostReview;
    delete testGlobal().__arcHostInvokeReviewer;
  });

  it("captures Claude streamed assistant text before review", async () => {
    const root = mkdtempSync(join(tmpdir(), "arc-host-claude-"));
    const dist = join(root, "dist");
    const workspace = join(root, "workspace");
    try {
      mkdirSync(workspace);
      writeRuntimeStubs(dist);
      testGlobal().__arcHostReview = { status: "saved", title: "Claude memory saved", text: "Saved route." };

      const arcHost = await loadArcHost(dist);
      const begin = await arcHost.beginArcTurn({
        engine: "claude",
        sessionId: "claude-session",
        cwd: workspace,
        prompt: "fix the tests",
      });

      expect(begin.injected).toBe(false);
      expect(calls().injectionPlans[0]).toMatchObject({
        prompt: "fix the tests",
        workspace,
        context: { runner: "claude" },
      });

      const notices: unknown[] = [];
      arcHost.recordClaudeSdkEvent("claude-session", {
        type: "stream_event",
        event: { type: "content_block_delta", delta: { type: "text_delta", text: "fixed " } },
      });
      arcHost.recordClaudeSdkEvent("claude-session", {
        type: "stream_event",
        event: { type: "content_block_delta", delta: { type: "text_delta", text: "the tests" } },
      });
      arcHost.recordClaudeSdkEvent("claude-session", { type: "result", subtype: "success" }, (notice) => {
        notices.push(notice);
      });

      await waitForReviews(1);
      const review = calls().reviews[0];
      const assistant = review.events.find((event) => event.type === "assistant_message");
      expect(assistant).toMatchObject({
        runner: "claude",
        source: "claude-sdk-stream",
        text: "fixed the tests",
      });
      expect(review.runnerStatus).toBe("completed");
      expect(review.hasReviewer).toBe(false);
      expect(notices).toMatchObject([
        { title: "Claude memory saved", status: "saved", text: "Saved route." },
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("captures Codex streamed assistant and command output before review", async () => {
    const root = mkdtempSync(join(tmpdir(), "arc-host-codex-"));
    const dist = join(root, "dist");
    const workspace = join(root, "workspace");
    try {
      mkdirSync(workspace);
      writeRuntimeStubs(dist);
      testGlobal().__arcHostPlan = {
        shouldInject: true,
        message: "ARC memory:\nUse the existing test command.",
        reason: "matched capsule",
        source: "local",
        capsule: { id: "capsule-1", title: "Test command" },
      };
      testGlobal().__arcHostReview = { status: "saved", title: "Codex memory saved", text: "Saved route." };

      const arcHost = await loadArcHost(dist);
      const begin = await arcHost.beginArcTurn({
        engine: "codex",
        sessionId: "codex-session",
        cwd: workspace,
        prompt: "run the tests",
      });

      expect(begin.injected).toBe(true);
      expect(begin.prompt).toContain("ARC memory:");
      expect(begin.prompt).toContain("User task:\nrun the tests");
      expect(calls().injectionPlans[0]).toMatchObject({
        prompt: "run the tests",
        workspace,
        context: { runner: "codex" },
      });

      const notices: unknown[] = [];
      arcHost.recordCodexLikeNotification("codex", "codex-session", {
        method: "item/started",
        params: { item: { type: "commandExecution", id: "cmd-1", command: "npm test" } },
      });
      arcHost.recordCodexLikeNotification("codex", "codex-session", {
        method: "item/commandExecution/outputDelta",
        params: { itemId: "cmd-1", delta: "tests passed" },
      });
      arcHost.recordCodexLikeNotification("codex", "codex-session", {
        method: "item/completed",
        params: { item: { type: "commandExecution", id: "cmd-1", command: "npm test", status: "completed", exitCode: 0 } },
      });
      arcHost.recordCodexLikeNotification("codex", "codex-session", {
        method: "item/agentMessage/delta",
        params: { itemId: "msg-1", delta: "All " },
      });
      arcHost.recordCodexLikeNotification("codex", "codex-session", {
        method: "item/agentMessage/delta",
        params: { itemId: "msg-1", delta: "green." },
      });
      arcHost.recordCodexLikeNotification("codex", "codex-session", {
        method: "item/completed",
        params: { item: { type: "agentMessage", id: "msg-1", text: "" } },
      });
      arcHost.recordCodexLikeNotification("codex", "codex-session", {
        method: "turn/completed",
        params: { turn: { id: "turn-1", status: "completed" } },
      }, (notice) => {
        notices.push(notice);
      });

      await waitForReviews(1);
      const review = calls().reviews[0];
      expect(review.hasReviewer).toBe(true);
      expect(review.events.find((event) => event.type === "tool_end")).toMatchObject({
        runner: "codex",
        toolName: "Bash",
        command: "npm test",
        text: "tests passed",
        toolStatus: "success",
      });
      expect(review.events.find((event) => event.type === "assistant_message")).toMatchObject({
        runner: "codex",
        text: "All green.",
      });
      expect(notices).toMatchObject([
        { title: "Codex memory saved", status: "saved", text: "Saved route." },
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("runs the Codex reviewer callback and accepts a JSON object", async () => {
    const root = mkdtempSync(join(tmpdir(), "arc-host-codex-reviewer-"));
    const dist = join(root, "dist");
    const workspace = join(root, "workspace");
    try {
      mkdirSync(workspace);
      writeRuntimeStubs(dist);
      testGlobal().__arcHostInvokeReviewer = true;
      codexUtilityPromptMock.mockResolvedValue(JSON.stringify({
        shouldSave: false,
        reason: "not reusable",
      }));

      const arcHost = await loadArcHost(dist);
      await arcHost.beginArcTurn({
        engine: "codex",
        sessionId: "codex-reviewer-session",
        cwd: workspace,
        prompt: "explain the entire project",
      });

      arcHost.recordCodexLikeNotification("codex", "codex-reviewer-session", {
        method: "turn/completed",
        params: { turn: { id: "turn-1", status: "completed" } },
      });

      await waitForReviews(1);
      expect(codexUtilityPromptMock).toHaveBeenCalledWith(
        "review this turn",
        workspace,
        "ARC_CODEX_REVIEW",
        expect.objectContaining({ timeoutMs: expect.any(Number) }),
      );
      expect(calls().reviews[0].reviewerResult).toMatchObject({
        shouldSave: false,
        reason: "not reusable",
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

async function loadArcHost(dist: string) {
  vi.resetModules();
  vi.stubEnv("ARC_RUNTIME_DIST_DIR", dist);
  vi.stubEnv("ARC_DESKTOP_MEMORY", "on");
  return import("../arc-host");
}

function calls(): NonNullable<TestGlobal["__arcHostCalls"]> {
  const value = testGlobal().__arcHostCalls;
  if (!value) throw new Error("arc host test calls were not initialized");
  return value;
}

async function waitForReviews(count: number): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt++) {
    if ((testGlobal().__arcHostCalls?.reviews.length ?? 0) === count) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  expect(calls().reviews).toHaveLength(count);
}

function testGlobal(): TestGlobal {
  return globalThis as TestGlobal;
}

function writeRuntimeStubs(dist: string): void {
  mkdirSync(dist, { recursive: true });
  writeFileSync(join(dist, "retrieval.js"), `
    function calls() {
      globalThis.__arcHostCalls ||= { injectionPlans: [], memoryEvents: [], savedTraces: [], reviews: [], debug: [] };
      return globalThis.__arcHostCalls;
    }
    export async function buildInjectionPlan(prompt, workspace, context) {
      calls().injectionPlans.push({ prompt, workspace, context });
      return globalThis.__arcHostPlan || { shouldInject: false, message: "", reason: "no match", source: "local" };
    }
  `);
  writeFileSync(join(dist, "store.js"), `
    function calls() {
      globalThis.__arcHostCalls ||= { injectionPlans: [], memoryEvents: [], savedTraces: [], reviews: [], debug: [] };
      return globalThis.__arcHostCalls;
    }
    export async function saveTraceEvents(events, sessionId, workspace) {
      calls().savedTraces.push({ events, sessionId, workspace });
      return sessionId;
    }
    export async function debug(action, details, workspace) {
      calls().debug.push({ action, details, workspace });
    }
  `);
  writeFileSync(join(dist, "ledger.js"), `
    function calls() {
      globalThis.__arcHostCalls ||= { injectionPlans: [], memoryEvents: [], savedTraces: [], reviews: [], debug: [] };
      return globalThis.__arcHostCalls;
    }
    export async function recordMemoryEvent(event) {
      calls().memoryEvents.push(event);
    }
  `);
  writeFileSync(join(dist, "panel.js"), `
    export async function startPanel() {
      return { url: "http://127.0.0.1:0/", close: async () => undefined };
    }
  `);
  writeFileSync(join(dist, "review-decision.js"), `
    function calls() {
      globalThis.__arcHostCalls ||= { injectionPlans: [], memoryEvents: [], savedTraces: [], reviews: [], debug: [] };
      return globalThis.__arcHostCalls;
    }
    export async function maybeReviewTurn(events, plan, runnerStatus, turnId, workspace, options) {
      const review = { events, plan, runnerStatus, turnId, workspace, hasReviewer: typeof options?.reviewer === "function" };
      calls().reviews.push(review);
      if (globalThis.__arcHostInvokeReviewer && typeof options?.reviewer === "function") {
        review.reviewerResult = await options.reviewer({ prompt: "review this turn" });
        return review.reviewerResult;
      }
      return globalThis.__arcHostReview || null;
    }
  `);
  writeFileSync(join(dist, "app-server.js"), `
    export async function runArcAppServer() {}
  `);
}
