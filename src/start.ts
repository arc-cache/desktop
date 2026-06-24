import { randomUUID } from "node:crypto";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createInterface, type Interface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { CopilotClient, RuntimeConnection } from "@github/copilot-sdk";
import type {
  CopilotSession,
  PermissionRequest,
  PermissionRequestResult,
  ProviderConfig,
  SessionConfig,
  SessionEvent
} from "@github/copilot-sdk";

import { launchBuiltArcApp, launchDevArcApp } from "./app-shell.js";
import { writeDebugBundle } from "./bundle.js";
import { copilotCommand } from "./copilot-command.js";
import { reviewEvents } from "./review.js";
import { ensureLocalEmbeddings, stopLocalEmbeddings } from "./local-embeddings.js";
import { localObserverStatus } from "./local-observer.js";
import { recordMemoryEvent, loadMemoryEvents } from "./ledger.js";
import { startPanel } from "./panel.js";
import { buildInjectionPlan } from "./retrieval.js";
import { debug, loadCapsules, saveCapsule, saveTraceEvents } from "./store.js";
import type { ArcEvent, InjectionPlan } from "./types.js";

type ReviewMode = "auto" | "off";
type StartSurface = "app" | "headless";

interface StartOptions {
  runner: "copilot" | "opencode";
  surface: StartSurface;
  once: string;
  sessionId: string;
  resumeSessionId: string;
  model: string;
  review: ReviewMode;
  timeoutMs: number;
  stream: boolean;
  askPermission: boolean;
  provider: "" | "ollama";
  providerBaseUrl: string;
  fake: boolean;
  host: string;
  port: number;
}

interface TurnContext {
  turnId: string;
  workspace: string;
  runner: StartOptions["runner"];
}

interface TurnCallbacks {
  onAssistantDelta(text: string): void;
  onStatus(text: string): void;
  onEvent?(event: ArcEvent): void;
}

interface Questioner {
  question(prompt: string): Promise<string>;
}

interface TurnOutput {
  selectedContext(plan: InjectionPlan): void;
  assistantDelta(text: string): void;
  status(text: string): void;
  event(event: ArcEvent): void;
  runnerError(message: string): void;
  reviewSkipped(reason: string): void;
  reviewCompleted(): void;
  newline(): void;
}

interface ArcRunner {
  readonly sessionId: string;
  start(): Promise<void>;
  sendTurn(prompt: string, context: TurnContext, callbacks: TurnCallbacks): Promise<ArcEvent[]>;
  abort(): Promise<void>;
  close(): Promise<void>;
}

interface LastTurn {
  turnId: string;
  prompt: string;
  events: ArcEvent[];
  status: "completed" | "failed";
}

export async function runStart(args: string[], workspace: string): Promise<number> {
  if (args.includes("--help") || args.includes("-h")) {
    printStartUsage();
    return 0;
  }
  const options = parseStartArgs(args);
  const useHeadless = options.surface === "headless" || !!options.once || (!stdin.isTTY && options.surface !== "app");
  if (!useHeadless && options.surface === "app") {
    if (options.fake || process.env.AGENT_RUN_CACHE_DESKTOP_SMOKE === "1") {
      return await withStartSidecarProvider(options, workspace, false, async () => runDesktopSmokeStart(options, workspace));
    }
    return await runArcAppStart(options, workspace);
  }
  return await withStartSidecarProvider(options, workspace, useHeadless, async () => {
    return await runHeadlessStart(options, workspace);
  });
}

export async function runAppDev(args: string[], workspace: string): Promise<number> {
  const options = parseStartArgs(args);
  return await runArcAppStart(options, workspace, "dev");
}

async function runArcAppStart(options: StartOptions, workspace: string, mode: "built" | "dev" = "built"): Promise<number> {
  // The memory panel rides along with the app: the app's Memory tool renders
  // this URL, so the panel UI ships with the CLI instead of the app build.
  const panel = await startPanel({ workspace }).catch((error) => {
    stdout.write(`ARC: memory panel unavailable: ${String(error)}\n`);
    return null;
  });
  if (panel) stdout.write(`ARC: memory panel at ${panel.url}\n`);
  stdout.write(mode === "dev" ? "ARC: launching desktop app dev server...\n" : "ARC: launching built checkout desktop app...\n");
  const launch = mode === "dev" ? launchDevArcApp : launchBuiltArcApp;
  let child: ChildProcess;
  try {
    child = launch({
      workspace,
      panelUrl: panel?.url,
      provider: options.provider,
      model: options.model
    });
  } catch (error) {
    await panel?.close().catch(() => undefined);
    throw error;
  }
  const stop = (): void => {
    child.kill("SIGTERM");
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  return await new Promise<number>((resolvePromise) => {
    const finish = (code: number): void => {
      process.removeListener("SIGINT", stop);
      process.removeListener("SIGTERM", stop);
      void panel?.close().catch(() => undefined);
      resolvePromise(code);
    };
    child.on("exit", (code) => finish(code ?? 0));
    child.on("error", (error) => {
      stdout.write(`ARC: failed to launch desktop app: ${String(error)}\n`);
      finish(1);
    });
  });
}

async function withStartSidecarProvider<T>(
  options: StartOptions,
  workspace: string,
  ownLocalEmbeddings: boolean,
  fn: () => Promise<T>
): Promise<T> {
  const previousCommand = process.env.AGENT_RUN_CACHE_SIDECAR_COPILOT_COMMAND;
  if (options.runner === "copilot" && options.provider === "ollama" && !previousCommand) {
    process.env.AGENT_RUN_CACHE_SIDECAR_COPILOT_COMMAND = `ollama launch copilot --model ${quoteCommandArg(options.model)}`;
  }
  try {
    await debug("local_observer.status", { ...localObserverStatus() }, workspace);
    // In app mode the spawned app-server owns the embedder; starting one here
    // too would load the weights twice.
    if (ownLocalEmbeddings) {
      void ensureLocalEmbeddings(workspace).then((info) => {
        void debug("local_embeddings.status", { state: info.state, detail: info.detail }, workspace);
      });
    }
    return await fn();
  } finally {
    if (ownLocalEmbeddings) stopLocalEmbeddings();
    if (previousCommand === undefined) delete process.env.AGENT_RUN_CACHE_SIDECAR_COPILOT_COMMAND;
    else process.env.AGENT_RUN_CACHE_SIDECAR_COPILOT_COMMAND = previousCommand;
  }
}

function quoteCommandArg(value: string): string {
  if (/^[A-Za-z0-9_./:@+-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, "'\\''")}'`;
}

async function runHeadlessStart(options: StartOptions, workspace: string): Promise<number> {
  const rl = createInterface({ input: stdin, output: stdout });
  const runner = createStartRunner(options, workspace, rl);
  let lastTurn: LastTurn | null = null;

  try {
    await runner.start();
    printStartHeader(options, runner.sessionId, workspace);
    if (options.once) {
      lastTurn = await runTurn(options.once, runner, options, workspace, terminalTurnOutput(), 1);
      return lastTurn.status === "completed" ? 0 : 1;
    }

    printCommandHelp();
    for (let turn = 1; ; turn += 1) {
      const line = (await rl.question("arc> ")).trim();
      if (!line) {
        turn -= 1;
        continue;
      }
      const commandResult = await handleAppCommand(line, { workspace, rl, lastTurn, runner });
      if (commandResult === "quit") break;
      if (commandResult === "handled") {
        turn -= 1;
        continue;
      }
      lastTurn = await runTurn(line, runner, options, workspace, terminalTurnOutput(), turn);
    }
    return 0;
  } finally {
    rl.close();
    await runner.close().catch((error) => debug("start.runner_close_failed", { error: String(error) }, workspace));
  }
}

async function runDesktopSmokeStart(options: StartOptions, workspace: string): Promise<number> {
  const env = appServerSmokeEnv(options, workspace);
  const child = spawn(process.execPath, [arcAppServerScript()], {
    cwd: workspace,
    env,
    stdio: ["pipe", "pipe", "pipe"]
  });
  const client = new SmokeAppServerClient(child);
  const prompt = process.env.AGENT_RUN_CACHE_DESKTOP_SMOKE_PROMPT ?? "hi";
  try {
    await client.request("initialize", {});
    await client.notify("initialized", {});
    const firstThread = await client.request("thread/start", { cwd: workspace });
    const firstThreadId = nestedString(firstThread, ["thread", "id"]);
    if (!firstThreadId) throw new Error("desktop smoke did not receive a thread id");
    await client.request("turn/start", {
      threadId: firstThreadId,
      input: [{ type: "text", text: prompt }]
    });
    await client.waitForEvent("turn/completed", (params) => nestedString(params, ["turn", "threadId"]) === firstThreadId);

    let threadFlow: JsonObject = {};
    if (process.env.AGENT_RUN_CACHE_DESKTOP_SMOKE_THREADS === "1") {
      const freshThread = await client.request("thread/start", { cwd: workspace });
      const freshThreadId = nestedString(freshThread, ["thread", "id"]);
      const restored = await client.request("thread/read", { threadId: firstThreadId });
      const list = await client.request("thread/list", { cwd: workspace });
      threadFlow = {
        threadCount: arrayValue(list.data).length,
        freshThreadId,
        restoredThreadId: nestedString(restored, ["thread", "id"]),
        restoredMessages: countMessageItems(restored.thread)
      };
    }

    const threadResult = await client.request("thread/read", { threadId: firstThreadId });
    const thread = recordValue(threadResult.thread);
    const payload = {
      runner: options.runner,
      threadId: firstThreadId,
      threads: arrayValue((await client.request("thread/list", { cwd: workspace })).data).length,
      messages: countMessageItems(thread),
      timeline: client.eventCount,
      toolStats: toolStats(thread),
      threadFlow,
      text: assistantText(thread)
    };
    stdout.write(`ARC_DESKTOP_READY ${JSON.stringify(payload)}\n`);
    return 0;
  } catch (error) {
    stdout.write(`ARC_DESKTOP_FAILED ${error instanceof Error ? error.message : String(error)}\n`);
    const stderr = client.stderrText.trim();
    if (stderr) stdout.write(`${stderr}\n`);
    return 1;
  } finally {
    await client.close();
  }
}

type JsonObject = Record<string, unknown>;

class SmokeAppServerClient {
  private nextId = 1;
  private readonly pending = new Map<number, { resolve(value: JsonObject): void; reject(error: Error): void }>();
  private readonly waiters: Array<{ method: string; predicate(params: JsonObject): boolean; resolve(params: JsonObject): void; reject(error: Error): void; timer: NodeJS.Timeout }> = [];
  private buffer = "";
  stderrText = "";
  eventCount = 0;

  constructor(private readonly child: ReturnType<typeof spawn>) {
    child.stdout?.on("data", (chunk) => this.acceptStdout(Buffer.from(chunk).toString("utf8")));
    child.stderr?.on("data", (chunk) => {
      this.stderrText += Buffer.from(chunk).toString("utf8");
    });
    child.on("exit", () => {
      const error = new Error("ARC desktop smoke app-server exited early");
      for (const pending of this.pending.values()) pending.reject(error);
      this.pending.clear();
      for (const waiter of this.waiters.splice(0)) {
        clearTimeout(waiter.timer);
        waiter.reject(error);
      }
    });
  }

  async request(method: string, params: JsonObject): Promise<JsonObject> {
    const id = this.nextId++;
    const promise = new Promise<JsonObject>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`desktop smoke timed out waiting for ${method}`));
      }, Number(process.env.AGENT_RUN_CACHE_DESKTOP_SMOKE_TIMEOUT_MS ?? 30000));
      this.pending.set(id, {
        resolve(value) {
          clearTimeout(timer);
          resolve(value);
        },
        reject(error) {
          clearTimeout(timer);
          reject(error);
        }
      });
    });
    this.write({ id, method, params });
    return await promise;
  }

  async notify(method: string, params: JsonObject): Promise<void> {
    this.write({ method, params });
  }

  async waitForEvent(method: string, predicate: (params: JsonObject) => boolean): Promise<JsonObject> {
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const index = this.waiters.findIndex((waiter) => waiter.resolve === resolve);
        if (index >= 0) this.waiters.splice(index, 1);
        reject(new Error(`desktop smoke timed out waiting for event ${method}`));
      }, Number(process.env.AGENT_RUN_CACHE_DESKTOP_SMOKE_TIMEOUT_MS ?? 30000));
      this.waiters.push({ method, predicate, resolve, reject, timer });
    });
  }

  async close(): Promise<void> {
    if (!this.child.killed) this.child.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 1000);
      this.child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  private acceptStdout(chunk: string): void {
    this.buffer += chunk;
    for (;;) {
      const newline = this.buffer.indexOf("\n");
      if (newline < 0) break;
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (line) this.acceptLine(line);
    }
  }

  private acceptLine(line: string): void {
    let message: JsonObject;
    try {
      message = JSON.parse(line) as JsonObject;
    } catch {
      this.stderrText += `${line}\n`;
      return;
    }
    if (typeof message.id === "number") {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(stringifyProtocolError(message.error)));
      else pending.resolve(recordValue(message.result));
      return;
    }
    const method = String(message.method ?? "");
    const params = recordValue(message.params);
    this.eventCount += 1;
    for (const waiter of [...this.waiters]) {
      if (waiter.method === method && waiter.predicate(params)) {
        clearTimeout(waiter.timer);
        this.waiters.splice(this.waiters.indexOf(waiter), 1);
        waiter.resolve(params);
      }
    }
  }

  private write(message: JsonObject): void {
    this.child.stdin?.write(`${JSON.stringify(message)}\n`);
  }
}

function stringifyProtocolError(error: unknown): string {
  if (typeof error === "string") return error;
  if (error && typeof error === "object" && "message" in error) return String((error as { message?: unknown }).message);
  return String(error);
}

function recordValue(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function nestedString(value: unknown, path: string[]): string {
  let current: unknown = value;
  for (const key of path) current = recordValue(current)[key];
  return typeof current === "string" ? current : "";
}

function threadItems(thread: unknown): JsonObject[] {
  return arrayValue(recordValue(thread).turns)
    .flatMap((turn) => arrayValue(recordValue(turn).items))
    .map(recordValue);
}

function countMessageItems(thread: unknown): number {
  return threadItems(thread).filter((item) => item.type === "userMessage" || item.type === "agentMessage").length;
}

function assistantText(thread: unknown): string {
  return threadItems(thread)
    .filter((item) => item.type === "agentMessage")
    .map((item) => String(item.text ?? ""))
    .join("\n");
}

function toolStats(thread: unknown): { total: number; done: number; running: number } {
  const tools = threadItems(thread).filter((item) => item.type === "commandExecution");
  return {
    total: tools.length,
    done: tools.filter((item) => item.status === "completed" || item.status === "failed").length,
    running: tools.filter((item) => item.status === "inProgress").length
  };
}

function createStartRunner(options: StartOptions, workspace: string, questioner: Questioner): ArcRunner {
  if (options.fake) return new FakeRunner(options.sessionId, workspace);
  if (options.runner === "opencode") return new OpencodeRunRunner(options, workspace);
  return new CopilotSdkRunner(options, workspace, questioner);
}

async function runTurn(prompt: string, runner: ArcRunner, options: StartOptions, workspace: string, output: TurnOutput, turnNumber: number): Promise<LastTurn> {
  const turnId = `${runner.sessionId}-turn-${turnNumber}`;
  const plan = await safeInjectionPlan(prompt, workspace, options.runner);
  output.selectedContext(plan);
  await recordMemoryEvent({
    type: "turn.started",
    workspace,
    sessionId: runner.sessionId,
    turnId,
    details: { prompt: prompt.slice(0, 500), runner: options.runner }
  });
  if (plan.shouldInject) {
    await recordMemoryEvent({
      type: "capsule.injected",
      workspace,
      sessionId: runner.sessionId,
      turnId,
      capsuleId: plan.capsule?.id,
      details: {
        source: plan.source,
        reason: plan.reason,
        title: plan.capsule?.title,
        injected: true,
        used: "unknown",
        helped: "unknown"
      }
    });
  }

  const events: ArcEvent[] = [
    syntheticEvent("session_start", turnId, workspace, "arc-start", `ARC app turn ${turnNumber} started for ${options.runner} session ${runner.sessionId}.`, options.runner),
    syntheticEvent("user_prompt", turnId, workspace, "arc-start", prompt, options.runner)
  ];
  const finalPrompt = plan.shouldInject ? `${plan.message}\n\nUser task:\n${prompt}` : prompt;

  await recordMemoryEvent({ type: "runner.started", workspace, sessionId: runner.sessionId, turnId, details: { runner: options.runner } });
  let runnerStatus: "completed" | "failed" = "completed";
  try {
    const runnerEvents = await runner.sendTurn(finalPrompt, { turnId, workspace, runner: options.runner }, {
      onAssistantDelta(text) {
        output.assistantDelta(text);
      },
      onStatus(text) {
        output.status(text);
      },
      onEvent(event) {
        output.event(event);
      }
    });
    events.push(...runnerEvents);
  } catch (error) {
    runnerStatus = "failed";
    const message = error instanceof Error ? error.message : String(error);
    output.runnerError(message);
    events.push(syntheticEvent("assistant_message", turnId, workspace, "arc-start-error", `ARC runner error: ${message}`, options.runner));
  }
  events.push(syntheticEvent("session_end", turnId, workspace, "arc-start", `ARC app turn ${turnNumber} ${runnerStatus}.`, options.runner));
  await recordMemoryEvent({ type: "runner.completed", workspace, sessionId: runner.sessionId, turnId, details: { runner: options.runner, status: runnerStatus, eventCount: events.length } });
  await saveTraceEvents(events, turnId, workspace);
  await maybeReviewTurn(events, options, workspace, output, turnId, plan, runnerStatus);
  output.newline();
  return { turnId, prompt, events, status: runnerStatus };
}

async function maybeReviewTurn(events: ArcEvent[], options: StartOptions, workspace: string, output: TurnOutput, turnId: string, plan: InjectionPlan, runnerStatus: "completed" | "failed"): Promise<void> {
  if (options.review === "off") {
    await recordMemoryEvent({ type: "capsule.rejected", workspace, sessionId: turnId, turnId, details: { reason: "review disabled" } });
    return;
  }
  const reviewDecision = shouldOfferReview(events, plan, runnerStatus);
  if (!reviewDecision.reviewable) {
    await recordMemoryEvent({ type: "capsule.rejected", workspace, sessionId: turnId, turnId, details: { reason: reviewDecision.reason } });
    output.reviewSkipped(reviewDecision.reason);
    return;
  }
  // Memory is automatic: the local observer gates inside reviewEvents and the
  // strong reviewer decides what to capsule. Use /review for an explicit
  // user-requested review that bypasses the gate.
  const outcome = await reviewEvents(events, workspace, turnId);
  await recordMemoryEvent({
    type: "capsule.checkpointed",
    workspace,
    sessionId: turnId,
    turnId,
    details: { eventCount: events.length, review: "turn-idle", outcome: outcome.status, reason: outcome.reason, capsuleIds: outcome.capsuleIds }
  });
  output.reviewCompleted();
}

async function handleAppCommand(line: string, context: { workspace: string; rl: Interface; lastTurn: LastTurn | null; runner: ArcRunner }): Promise<"handled" | "quit" | "prompt"> {
  if (!line.startsWith("/")) return "prompt";
  const [command, ...rest] = line.slice(1).split(/\s+/);
  const arg = rest.join(" ").trim();
  if (command === "quit" || command === "exit") return "quit";
  if (command === "help") {
    printCommandHelp();
    return "handled";
  }
  if (command === "capsules") {
    await printCapsules(context.workspace);
    return "handled";
  }
  if (command === "ledger") {
    await printLedger(context.workspace);
    return "handled";
  }
  if (command === "bundle") {
    const bundle = await writeDebugBundle(arg || undefined, context.workspace);
    stdout.write(`ARC: wrote debug bundle to ${bundle.path}\n`);
    return "handled";
  }
  if (command === "review") {
    if (!context.lastTurn) stdout.write("ARC: no completed turn to review.\n");
    else await reviewEvents(context.lastTurn.events, context.workspace, context.lastTurn.turnId, "user-requested");
    return "handled";
  }
  if (command === "reject") {
    await recordMemoryEvent({
      type: "capsule.rejected",
      workspace: context.workspace,
      sessionId: context.runner.sessionId,
      turnId: context.lastTurn?.turnId,
      details: { reason: arg || "user rejected turn memory" }
    });
    stdout.write("ARC: recorded rejection.\n");
    return "handled";
  }
  if (command === "save") {
    await manualSave(arg, context);
    return "handled";
  }
  stdout.write(`ARC: unknown command /${command}. Type /help.\n`);
  return "handled";
}

async function manualSave(arg: string, context: { workspace: string; lastTurn: LastTurn | null; runner: ArcRunner }, silent = false): Promise<string | null> {
  if (!context.lastTurn) {
    if (!silent) stdout.write("ARC: no completed turn to save.\n");
    return null;
  }
  const [rawTitle, rawSummary] = arg.split("|", 2);
  const title = (rawTitle || "Manual ARC checkpoint").trim();
  const summary = (rawSummary || context.lastTurn.events.filter((event) => event.type === "assistant_message").map((event) => event.text ?? "").join(" ").slice(0, 800) || title).trim();
  const capsule = await saveCapsule({
    runner: context.lastTurn.events.find((event) => event.runner)?.runner ?? "copilot",
    workspace: context.workspace,
    sourceSessionId: context.lastTurn.turnId,
    reusable: true,
    confidence: 0.65,
    kind: "manual_checkpoint",
    mergeKey: `manual-${slug(title)}`,
    title,
    summary,
    reuseWhen: [title, context.lastTurn.prompt].filter(Boolean),
    doNotReuseWhen: [],
    evidence: [`Manual save from ARC app turn ${context.lastTurn.turnId}.`],
    provenance: [],
    nextRunInstruction: summary,
    outcomeStatus: "unknown",
    workflow: {
      purpose: summary,
      parameters: [],
      bindingSources: [],
      steps: [summary],
      commands: context.lastTurn.events.map((event) => event.command ?? "").filter(Boolean).slice(0, 8),
      successCriteria: ["Future run verifies current repo state before reuse."],
      failedAttempts: [],
      validationProbe: []
    }
  }, context.workspace);
  if (!silent) stdout.write(`ARC: saved manual capsule ${capsule?.id ?? "none"}.\n`);
  return capsule?.id ?? null;
}

function terminalTurnOutput(): TurnOutput {
  return {
    selectedContext: printSelectedContext,
    assistantDelta(text) {
      stdout.write(text);
    },
    status(text) {
      stdout.write(`\n${text}\n`);
    },
    event() {},
    runnerError(message) {
      stdout.write(`\nARC runner error: ${message}\n`);
    },
    reviewSkipped(reason) {
      stdout.write(`ARC: memory review skipped (${reason}).\n`);
    },
    reviewCompleted() {
      stdout.write("ARC: review completed.\n");
    },
    newline() {
      stdout.write("\n");
    }
  };
}

class FakeRunner implements ArcRunner {
  readonly sessionId: string;

  constructor(sessionId: string, private readonly workspace: string) {
    this.sessionId = sessionId;
  }

  async start(): Promise<void> {
    await debug("start.fake_runner.started", { sessionId: this.sessionId }, this.workspace);
  }

  async sendTurn(_prompt: string, context: TurnContext, callbacks: TurnCallbacks): Promise<ArcEvent[]> {
    const text = process.env.AGENT_RUN_CACHE_START_FAKE_RESPONSE ?? "Fake ARC start answer.";
    callbacks.onAssistantDelta(`${text}\n`);
    const event = syntheticEvent("assistant_message", context.turnId, context.workspace, "arc-start-fake", text, context.runner);
    callbacks.onEvent?.(event);
    return [event];
  }

  async abort(): Promise<void> {
    await debug("start.fake_runner.abort", { sessionId: this.sessionId }, this.workspace);
  }

  async close(): Promise<void> {
    await debug("start.fake_runner.closed", { sessionId: this.sessionId }, this.workspace);
  }
}

class OpencodeRunRunner implements ArcRunner {
  readonly sessionId: string;

  constructor(private readonly options: StartOptions, private readonly workspace: string) {
    this.sessionId = options.sessionId;
  }

  async start(): Promise<void> {
    await debug("start.runner.started", { runner: "opencode-run", sessionId: this.sessionId, command: opencodeBin() }, this.workspace);
  }

  async sendTurn(prompt: string, context: TurnContext, callbacks: TurnCallbacks): Promise<ArcEvent[]> {
    const args = ["run"];
    if (this.options.model) args.push("--model", this.options.model);
    args.push(prompt);
    const started = syntheticEvent("tool_start", context.turnId, context.workspace, "opencode-run", `opencode ${args.slice(0, -1).join(" ")} <prompt>`, "opencode");
    started.toolName = "opencode";
    started.toolUseId = "opencode-run";
    started.command = `opencode ${args.slice(0, -1).join(" ")} <prompt>`;
    callbacks.onEvent?.(started);
    const result = await runProcessCapture(opencodeBin(), args, this.workspace, this.options.timeoutMs, (chunk) => callbacks.onAssistantDelta(chunk));
    const completed = syntheticEvent("tool_end", context.turnId, context.workspace, "opencode-run", result.output, "opencode");
    completed.toolName = "opencode";
    completed.toolUseId = started.toolUseId;
    completed.command = started.command;
    completed.toolStatus = result.exitCode === 0 ? "success" : "failed";
    completed.exitCode = result.exitCode;
    const assistant = syntheticEvent("assistant_message", context.turnId, context.workspace, "opencode-run", result.output.trim(), "opencode");
    callbacks.onEvent?.(completed);
    callbacks.onEvent?.(assistant);
    if (result.exitCode !== 0) throw new Error(`OpenCode exited ${result.exitCode}`);
    return [started, completed, assistant];
  }

  async abort(): Promise<void> {
    await debug("start.opencode.abort_unavailable", { sessionId: this.sessionId }, this.workspace);
  }

  async close(): Promise<void> {
    await debug("start.runner.closed", { runner: "opencode-run", sessionId: this.sessionId }, this.workspace);
  }
}

class CopilotSdkRunner implements ArcRunner {
  readonly sessionId: string;
  private client: CopilotClient | null = null;
  private session: CopilotSession | null = null;
  private readonly toolNames = new Map<string, string>();

  constructor(private readonly options: StartOptions, private readonly workspace: string, private readonly questioner: Questioner) {
    this.sessionId = options.resumeSessionId || options.sessionId;
  }

  async start(): Promise<void> {
    const clientOptions = this.clientOptions();
    this.client = new CopilotClient(clientOptions);
    await debug("start.runner.started", { runner: "copilot-sdk", sessionId: this.sessionId, command: runtimeLabel() }, this.workspace);
    await this.client.start();
    const config = this.sessionConfig();
    this.session = this.options.resumeSessionId
      ? await this.client.resumeSession(this.options.resumeSessionId, config)
      : await this.client.createSession({ ...config, sessionId: this.options.sessionId });
  }

  async sendTurn(prompt: string, context: TurnContext, callbacks: TurnCallbacks): Promise<ArcEvent[]> {
    if (!this.session) throw new Error("Copilot SDK session is not started.");
    const events: ArcEvent[] = [];
    let sawDelta = false;
    const unsubscribe = this.session.on((event) => {
      const arcEvent = this.normalizeEvent(event, context);
      if (arcEvent) {
        events.push(arcEvent);
        callbacks.onEvent?.(arcEvent);
      }
      if (event.type === "assistant.message_delta" && event.data.deltaContent) {
        sawDelta = true;
        callbacks.onAssistantDelta(event.data.deltaContent);
      }
      if (event.type === "assistant.message" && event.data.content && !sawDelta) {
        callbacks.onAssistantDelta(`${event.data.content}\n`);
      }
      if (event.type === "tool.execution_start") {
        callbacks.onStatus(`tool ${event.data.toolName}${event.data.arguments ? ` ${shortJson(event.data.arguments)}` : ""}`);
      }
      if (event.type === "permission.requested") {
        callbacks.onStatus(`permission ${permissionSummary(event.data.permissionRequest)}`);
      }
    });
    try {
      await this.session.sendAndWait({ prompt, mode: "enqueue" }, this.options.timeoutMs);
      return events;
    } finally {
      unsubscribe();
    }
  }

  async abort(): Promise<void> {
    await this.session?.abort();
  }

  async close(): Promise<void> {
    await this.session?.disconnect().catch((error) => debug("start.session_disconnect_failed", { error: String(error) }, this.workspace));
    const errors = await this.client?.stop();
    if (errors?.length) await debug("start.client_stop_errors", { errors: errors.map(String) }, this.workspace);
  }

  private clientOptions(): ConstructorParameters<typeof CopilotClient>[0] {
    const connection = sdkRuntimeConnection();
    const disableLoggedInUser = process.env.ARC_COPILOT_DISABLE_LOGGED_IN_USER === "1";
    return {
      ...(connection ? { connection } : {}),
      ...(disableLoggedInUser ? { useLoggedInUser: false } : {}),
      workingDirectory: this.workspace,
      logLevel: "all",
      env: {
        ...process.env,
        COPILOT_OTEL_EXPORTER_TYPE: process.env.COPILOT_OTEL_EXPORTER_TYPE ?? "file",
        OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT:
          process.env.OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT ?? "false"
      },
      telemetry: {
        exporterType: process.env.COPILOT_OTEL_EXPORTER_TYPE ?? "file",
        filePath: process.env.COPILOT_OTEL_FILE_EXPORTER_PATH,
        captureContent: process.env.OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT === "true"
      }
    };
  }

  private sessionConfig(): SessionConfig {
    return {
      clientName: "arc",
      workingDirectory: this.workspace,
      model: this.options.model || undefined,
      provider: providerConfig(this.options),
      streaming: this.options.stream,
      enableConfigDiscovery: true,
      onPermissionRequest: async (request) => this.handlePermission(request),
      onUserInputRequest: async (request) => {
        const answer = await this.questioner.question(`Copilot asks: ${request.question}`);
        return { answer, wasFreeform: true };
      }
    };
  }

  private async handlePermission(request: PermissionRequest): Promise<PermissionRequestResult> {
    if (!this.options.askPermission) return { kind: "approve-once" };
    const answer = (await this.questioner.question(`Allow ${permissionSummary(request)}? [y/N] `)).trim().toLowerCase();
    return answer === "y" || answer === "yes"
      ? { kind: "approve-once" }
      : { kind: "reject", feedback: "Denied by ARC user." };
  }

  private normalizeEvent(event: SessionEvent, context: TurnContext): ArcEvent | null {
    const base = {
      id: event.id,
      runner: "copilot" as const,
      sessionId: context.turnId,
      workspace: context.workspace,
      timestamp: event.timestamp,
      source: "copilot-sdk",
      rawType: event.type,
      raw: event
    };
    if (event.type === "assistant.message") {
      return { ...base, type: "assistant_message", text: event.data.content };
    }
    if (event.type === "tool.execution_start") {
      this.toolNames.set(event.data.toolCallId, event.data.toolName);
      return {
        ...base,
        type: "tool_start",
        toolName: event.data.toolName,
        toolUseId: event.data.toolCallId,
        command: commandFromTool(event.data.toolName, event.data.arguments),
        text: shortJson(event.data.arguments)
      };
    }
    if (event.type === "tool.execution_complete") {
      const text = toolResultText(event);
      const exitCode = exitCodeFromText(text) ?? terminalExitCode(event);
      const toolStatus = event.data.success ? "success" : "failed";
      return {
        ...base,
        type: "tool_end",
        toolName: this.toolNames.get(event.data.toolCallId) ?? "tool",
        toolUseId: event.data.toolCallId,
        command: commandFromTool(this.toolNames.get(event.data.toolCallId) ?? "tool", undefined),
        text,
        toolStatus,
        exitCode: exitCode ?? undefined
      };
    }
    if (event.type === "session.error" || event.type === "permission.requested" || event.type === "user_input.requested") {
      return { ...base, type: "unknown", text: eventText(event) };
    }
    return null;
  }
}

function parseStartArgs(args: string[]): StartOptions {
  const options: StartOptions = {
    runner: parseRunner(process.env.AGENT_RUN_CACHE_START_RUNNER ?? "copilot"),
    surface: parseSurface(process.env.AGENT_RUN_CACHE_START_SURFACE ?? "app"),
    once: "",
    sessionId: process.env.AGENT_RUN_CACHE_START_SESSION_ID ?? randomUUID(),
    resumeSessionId: "",
    model: process.env.AGENT_RUN_CACHE_START_MODEL ?? "",
    review: "auto",
    timeoutMs: Number(process.env.AGENT_RUN_CACHE_START_TIMEOUT_MS ?? 10 * 60 * 1000),
    stream: true,
    askPermission: false,
    provider: "",
    providerBaseUrl: process.env.AGENT_RUN_CACHE_OLLAMA_BASE_URL ?? "http://localhost:11434/v1",
    fake: process.env.AGENT_RUN_CACHE_START_FAKE === "1",
    host: process.env.AGENT_RUN_CACHE_APP_HOST ?? "127.0.0.1",
    port: Number(process.env.AGENT_RUN_CACHE_APP_PORT ?? 0)
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--runner") {
      options.runner = parseRunner(args[++index] ?? "");
      continue;
    }
    if (arg === "--headless" || arg === "--debug-loop") {
      options.surface = "headless";
      continue;
    }
    if (arg === "--app") {
      options.surface = "app";
      continue;
    }
    if (arg === "--once") {
      options.once = args[++index] ?? "";
      continue;
    }
    if (arg === "--session-id") {
      options.sessionId = args[++index] ?? "";
      continue;
    }
    if (arg === "--resume") {
      options.resumeSessionId = args[++index] ?? "";
      continue;
    }
    if (arg === "--model") {
      options.model = args[++index] ?? "";
      continue;
    }
    if (arg === "--review") {
      options.review = parseReviewMode(args[++index] ?? "");
      continue;
    }
    if (arg === "--timeout-ms") {
      options.timeoutMs = Number(args[++index] ?? options.timeoutMs);
      continue;
    }
    if (arg === "--no-stream") {
      options.stream = false;
      continue;
    }
    if (arg === "--ask-permission") {
      options.askPermission = true;
      continue;
    }
    if (arg === "--auto-approve") {
      options.askPermission = false;
      continue;
    }
    if (arg === "--provider") {
      const provider = args[++index] ?? "";
      if (provider !== "ollama") throw new Error("arc start currently supports only --provider ollama.");
      options.provider = provider;
      continue;
    }
    if (arg === "--provider-base-url") {
      options.providerBaseUrl = args[++index] ?? options.providerBaseUrl;
      continue;
    }
    if (arg === "--app-host") {
      options.host = args[++index] ?? options.host;
      continue;
    }
    if (arg === "--app-port") {
      options.port = Number(args[++index] ?? options.port);
      continue;
    }
    if (arg === "--fake") {
      options.fake = true;
      continue;
    }
    throw new Error(`Unknown arc start option: ${arg}`);
  }
  if (!options.sessionId) throw new Error("--session-id cannot be empty.");
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) throw new Error("--timeout-ms must be a positive number.");
  if (!Number.isFinite(options.port) || options.port < 0) throw new Error("--app-port must be zero or a positive number.");
  if (options.runner === "opencode" && options.provider) throw new Error("--provider is only for --runner copilot. For OpenCode, pass --model in OpenCode's provider/model format.");
  if (options.provider === "ollama" && !options.model) throw new Error("--provider ollama requires --model or AGENT_RUN_CACHE_START_MODEL.");
  return options;
}

function parseRunner(value: string): StartOptions["runner"] {
  if (value === "copilot" || value === "opencode") return value;
  throw new Error("--runner must be opencode or copilot.");
}

function parseSurface(value: string): StartSurface {
  if (value === "app" || value === "headless") return value;
  throw new Error("ARC start surface must be app or headless.");
}

function parseReviewMode(value: string): ReviewMode {
  // "prompt" is accepted as a legacy alias: review is automatic now and the
  // per-turn ask is gone.
  if (value === "auto" || value === "prompt") return "auto";
  if (value === "off") return "off";
  throw new Error("--review must be auto or off.");
}

async function safeInjectionPlan(prompt: string, workspace: string, runner: StartOptions["runner"]): Promise<InjectionPlan> {
  try {
    return await buildInjectionPlan(prompt, workspace, { runner });
  } catch (error) {
    await debug("start.injection_failed", { error: String(error) }, workspace);
    return { shouldInject: false, message: "", reason: "injection unavailable; see ARC debug logs", source: "local" };
  }
}

function sdkRuntimeConnection(): ReturnType<typeof RuntimeConnection.forStdio> | undefined {
  const explicit = !!process.env.AGENT_RUN_CACHE_COPILOT_COMMAND || !!process.env.AGENT_RUN_CACHE_COPILOT_BIN;
  const launcher = copilotCommand([]);
  const resolved = resolveExecutable(launcher.command);
  if (!resolved) {
    if (explicit) throw new Error(`Configured Copilot runtime was not found: ${launcher.command}`);
    return undefined;
  }
  return RuntimeConnection.forStdio({ path: resolved, args: launcher.args });
}

function runtimeLabel(): string {
  const launcher = copilotCommand([]);
  return launcher.label;
}

function resolveExecutable(command: string): string | null {
  if (command.includes("/")) return command;
  const result = spawnSync("which", [command], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  return result.status === 0 ? result.stdout.trim() : null;
}

function appServerSmokeEnv(options: StartOptions, workspace: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    ARC_APP_SERVER_BIN: process.execPath,
    ARC_APP_SERVER_SCRIPT: arcAppServerScript(),
    ARC_APP_SESSION_ID: options.sessionId,
    ARC_APP_WORKSPACE: workspace,
    ARC_APP_RUNNER: options.runner,
    ARC_APP_PROVIDER: options.provider || "default",
    ARC_APP_PROVIDER_BASE_URL: options.providerBaseUrl,
    ARC_APP_MODEL: options.model,
    ARC_APP_REVIEW: options.review,
    ARC_APP_FAKE: options.fake ? "1" : "0",
    AGENT_RUN_CACHE_START_FAKE: options.fake ? "1" : process.env.AGENT_RUN_CACHE_START_FAKE
  };
}

function arcAppServerScript(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "app-server.js");
}

function providerConfig(options: StartOptions): ProviderConfig | undefined {
  if (options.provider !== "ollama") return undefined;
  return {
    type: "openai",
    baseUrl: options.providerBaseUrl,
    modelId: options.model,
    wireModel: options.model
  };
}

function opencodeBin(): string {
  return process.env.AGENT_RUN_CACHE_OPENCODE_BIN ?? "opencode";
}

async function runProcessCapture(command: string, args: string[], cwd: string, timeoutMs: number, onStdout: (chunk: string) => void): Promise<{ exitCode: number; output: string }> {
  const child = spawn(command, args, {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      OPENCODE_CLIENT: process.env.OPENCODE_CLIENT ?? "arc"
    }
  });
  let settled = false;
  let output = "";
  let errorOutput = "";
  const timer = setTimeout(() => {
    if (settled) return;
    child.kill("SIGTERM");
  }, timeoutMs);
  child.stdout.on("data", (chunk) => {
    const text = Buffer.from(chunk).toString("utf8");
    output += text;
    onStdout(text);
  });
  child.stderr.on("data", (chunk) => {
    const text = Buffer.from(chunk).toString("utf8");
    errorOutput += text;
  });
  return await new Promise((resolve, reject) => {
    child.on("error", (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      settled = true;
      if (error.code === "ENOENT") {
        reject(new Error(`OpenCode runner not found: ${command}. Install OpenCode or set AGENT_RUN_CACHE_OPENCODE_BIN.`));
        return;
      }
      reject(error);
    });
    child.on("exit", (code, signal) => {
      clearTimeout(timer);
      settled = true;
      const exitCode = code ?? (signal ? 124 : 0);
      resolve({ exitCode, output: output || errorOutput });
    });
  });
}

function syntheticEvent(type: ArcEvent["type"], sessionId: string, workspace: string, source: string, text: string, runner: StartOptions["runner"] = "copilot"): ArcEvent {
  return {
    id: `${sessionId}-${source}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    runner,
    sessionId,
    workspace,
    timestamp: new Date().toISOString(),
    type,
    source,
    text
  };
}

function shouldOfferReview(events: ArcEvent[], plan: InjectionPlan, runnerStatus: "completed" | "failed"): { reviewable: boolean; reason: string } {
  if (runnerStatus !== "completed") return { reviewable: false, reason: "runner did not complete" };
  if (events.some((event) => (event.type === "tool_start" || event.type === "tool_end") && event.source !== "opencode-run")) return { reviewable: true, reason: "tool activity observed" };
  if (plan.shouldInject) return { reviewable: true, reason: "capsule context was injected" };
  const prompt = events.find((event) => event.type === "user_prompt")?.text ?? "";
  const assistant = events.filter((event) => event.type === "assistant_message").map((event) => event.text ?? "").join("\n");
  if (isSmallTalk(prompt)) return { reviewable: false, reason: "small-talk turn" };
  const text = `${prompt}\n${assistant}`;
  if (hasReusableWorkSignal(text)) return { reviewable: true, reason: "reusable-work signal observed" };
  if (prompt.length > 120 || assistant.length > 1500) return { reviewable: true, reason: "substantial turn" };
  return { reviewable: false, reason: "no reusable-work signal" };
}

function isSmallTalk(prompt: string): boolean {
  const normalized = prompt.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  if (!normalized) return true;
  const smallTalk = new Set(["hi", "hello", "hey", "yo", "sup", "thanks", "thank you", "ok", "okay", "cool", "nice", "lol", "haha"]);
  return smallTalk.has(normalized);
}

function hasReusableWorkSignal(value: string): boolean {
  const text = value.toLowerCase();
  return /\b(test|build|fix|debug|implement|refactor|file|folder|repo|command|script|deploy|api|ssh|docker|gitlab|github|error|failing|trace|cache|capsule|workflow|config|install|run)\b/.test(text);
}

function printStartHeader(options: StartOptions, sessionId: string, workspace: string): void {
  stdout.write(`ARC Headless Mode  runner=${options.runner} session=${sessionId}\n`);
  stdout.write(`workspace: ${workspace}\n`);
  stdout.write(`review: ${options.review}${options.fake ? " fake-runner" : ""}\n\n`);
}

function printCommandHelp(): void {
  stdout.write("Commands: /capsules, /ledger, /review, /save title | summary, /reject [reason], /bundle [dir], /quit\n\n");
}

function printSelectedContext(plan: InjectionPlan): void {
  if (plan.shouldInject) {
    stdout.write(`\nARC context: ${plan.capsule?.title ?? plan.capsule?.id ?? "capsule"} (${plan.reason})\n\n`);
  } else {
    stdout.write(`\nARC context: none (${plan.reason})\n\n`);
  }
}

async function printCapsules(workspace: string): Promise<void> {
  const capsules = await loadCapsules(workspace);
  if (!capsules.length) {
    stdout.write("ARC: no capsules saved.\n");
    return;
  }
  for (const capsule of capsules.slice(-20)) {
    stdout.write(`${capsule.reusable ? "active" : "retired"} ${capsule.id.slice(0, 8)} ${capsule.confidence.toFixed(2)} ${capsule.title}\n`);
  }
}

async function printLedger(workspace: string): Promise<void> {
  const events = await loadMemoryEvents(workspace);
  if (!events.length) {
    stdout.write("ARC: no ledger events.\n");
    return;
  }
  for (const event of events.slice(-20)) {
    stdout.write(`${event.timestamp.slice(11, 19)} ${event.type}${event.capsuleId ? ` ${event.capsuleId.slice(0, 8)}` : ""}${event.details ? ` ${shortJson(event.details)}` : ""}\n`);
  }
}

function commandFromTool(toolName: string, args: unknown): string {
  if (!args || typeof args !== "object" || Array.isArray(args)) return toolName;
  const record = args as Record<string, unknown>;
  const direct = stringValue(record.command) || stringValue(record.cmd) || stringValue(record.script);
  if (direct) return direct;
  const path = stringValue(record.path) || stringValue(record.file_path);
  if (path) return `${toolName} ${path}`;
  return `${toolName} ${shortJson(record)}`;
}

function toolResultText(event: Extract<SessionEvent, { type: "tool.execution_complete" }>): string {
  const result = event.data.result;
  if (result?.detailedContent) return result.detailedContent.slice(0, 12000);
  if (result?.content) return result.content.slice(0, 12000);
  if (event.data.error?.message) return event.data.error.message.slice(0, 12000);
  return shortJson(event.data).slice(0, 12000);
}

function terminalExitCode(event: Extract<SessionEvent, { type: "tool.execution_complete" }>): number | null {
  for (const content of event.data.result?.contents ?? []) {
    if (content.type === "terminal" && typeof content.exitCode === "number") return content.exitCode;
  }
  return null;
}

function exitCodeFromText(text: string): number | null {
  const match = text.match(/\bexit\s+code:?\s+(-?\d+)\b/i) ?? text.match(/\bexited\s+with\s+(-?\d+)\b/i);
  return match ? Number(match[1]) : null;
}

function eventText(event: SessionEvent): string {
  if (event.type === "session.error") return event.data.message;
  return shortJson(event);
}

function permissionSummary(request: PermissionRequest): string {
  const record = request as unknown as Record<string, unknown>;
  if (request.kind === "shell") return `shell ${request.fullCommandText}`;
  if (typeof record.toolName === "string") return `${request.kind} ${record.toolName}`;
  if (typeof record.fileName === "string") return `${request.kind} ${record.fileName}`;
  return request.kind;
}

function shortJson(value: unknown): string {
  try {
    return JSON.stringify(value).slice(0, 500);
  } catch {
    return String(value).slice(0, 500);
  }
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "checkpoint";
}

function printStartUsage(): void {
  stdout.write(`Usage:
  arc start
  arc start --provider ollama --model gemma4:31b-cloud

Starts the locally built ARC desktop workbench from apps/arc-app. Run npm run app:install if dependencies are missing and npm run app:build if built outputs are missing.

Options:
  --runner copilot|opencode Default: copilot.
  --model <model>           OpenCode model in provider/model format, or Copilot model when using --runner copilot.
  --review auto|off         Review turn memory automatically (default) or disable review.
  --ask-permission          Ask before Copilot tool permissions. Only applies to --runner copilot.
  --provider ollama         Copilot SDK custom provider mode. Only applies to --runner copilot.
  --provider-base-url <url> Default: http://localhost:11434/v1.
`);
}
