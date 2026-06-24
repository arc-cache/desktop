import { randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

import { CopilotClient, RuntimeConnection } from "@github/copilot-sdk";
import type {
  CopilotSession,
  GetAuthStatusResponse,
  PermissionRequest,
  PermissionRequestResult,
  ProviderConfig,
  ResumeSessionConfig,
  SessionEvent
} from "@github/copilot-sdk";

import { copilotCommand } from "./copilot-command.js";
import { maybeReviewTurn, type ReviewDecision } from "./review-decision.js";
export { maybeReviewTurn, reviewDecisionFromOutcome, shouldOfferReview } from "./review-decision.js";
import { recordMemoryEvent } from "./ledger.js";
import { ensureLocalEmbeddings, stopLocalEmbeddings } from "./local-embeddings.js";
import { localObserverStatus } from "./local-observer.js";
import { appCacheDir, cacheDir, workspaceRoot } from "./paths.js";
import { buildInjectionPlan } from "./retrieval.js";
import { debug, loadCapsules, saveTraceEvents } from "./store.js";
import type { ArcEvent, InjectionPlan } from "./types.js";

type JsonRecord = Record<string, unknown>;

interface JsonRpcMessage {
  id?: string | number | null;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: unknown;
}

interface ThreadTurn {
  id: string;
  items: JsonRecord[];
}

interface ThreadRecord {
  id: string;
  cwd: string;
  preview: string;
  created_at: string;
  updated_at: string;
  turns: ThreadTurn[];
}

interface ProjectRecord {
  id: string;
  name: string;
  path: string;
  branch: string;
  commit: string;
  updated_at: string;
  threadCount: number;
}

interface RunnerState {
  client: CopilotClient;
  session: CopilotSession;
  toolNames: Map<string, string>;
  runtimeKey: string;
  awaitingInput: { question: string } | null;
}

export type PermissionMode = "read-only" | "on-request" | "full-access";

interface RuntimeSelection {
  provider: "" | "ollama";
  providerBaseUrl: string;
  model: string;
}

interface PendingServerResponse {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface ArcAccountReadResponse extends JsonRecord {
  account: JsonRecord | null;
  requiresOpenaiAuth: boolean;
  authMode: "copilot" | "ollama";
  copilotAuthStatus?: GetAuthStatusResponse;
  authGuidance?: string;
  authError?: string;
  quotaExceeded?: boolean;
  quotaMessage?: string;
}

const workspace = workspaceRoot(process.cwd());
const serverSessionId = process.env.ARC_APP_SESSION_ID ?? randomUUID();
const model = process.env.ARC_APP_MODEL ?? process.env.AGENT_RUN_CACHE_START_MODEL ?? "";
const provider = process.env.ARC_APP_PROVIDER ?? "";
const providerBaseUrl = process.env.ARC_APP_PROVIDER_BASE_URL ?? "http://localhost:11434/v1";
const reviewMode = process.env.ARC_APP_REVIEW ?? "auto";
const memoryMode = process.env.ARC_APP_MEMORY ?? "on";
const timeoutMs = Number(process.env.AGENT_RUN_CACHE_START_TIMEOUT_MS ?? 10 * 60 * 1000);
const runnerName = parseRunner(process.env.ARC_APP_RUNNER ?? process.env.AGENT_RUN_CACHE_START_RUNNER ?? "copilot");
const fakeRunner = process.env.ARC_APP_FAKE === "1" || process.env.AGENT_RUN_CACHE_START_FAKE === "1";

const threads = new Map<string, ThreadRecord>();
const runners = new Map<string, RunnerState>();
const activeTurns = new Map<string, { turnId: string; canceled: boolean }>();
const threadPermissionModes = new Map<string, PermissionMode>();
const pendingServerResponses = new Map<string, PendingServerResponse>();
let turnCounter = 0;
let serverRequestCounter = 0;

loadPersistedThreads();

export function runArcAppServer(): void {
  if (memoryEnabled()) {
    void debug("local_observer.status", { ...localObserverStatus() }, workspace);
    void ensureLocalEmbeddings(workspace).then((info) => {
      void debug("local_embeddings.status", { state: info.state, detail: info.detail }, workspace);
    });
  }
  const rl = createInterface({ input: process.stdin });
  rl.on("line", (line) => {
    void handleLine(line).catch((error) => {
      writeProtocolError(null, error);
    });
  });
  rl.on("close", () => {
    void closeRunners().finally(() => {
      if (memoryEnabled()) stopLocalEmbeddings();
      process.exit(0);
    });
  });
}

async function handleLine(line: string): Promise<void> {
  const trimmed = line.trim();
  if (!trimmed) return;
  let message: JsonRpcMessage;
  try {
    message = JSON.parse(trimmed) as JsonRpcMessage;
  } catch (error) {
    writeProtocolError(null, error);
    return;
  }
  const id = message.id ?? null;
  const method = typeof message.method === "string" ? message.method : "";
  if (!method && id !== null && ("result" in message || "error" in message)) {
    settleServerResponse(id, message);
    return;
  }
  const params = isRecord(message.params) ? message.params : {};
  try {
    switch (method) {
      case "initialize":
        writeResponse(id, {
          serverInfo: { name: "arc", title: "ARC", version: "1.0.0" },
          capabilities: { experimentalApi: true },
          localModel: localObserverStatus()
        });
        return;
      case "initialized":
        return;
      case "thread/start":
        writeResponse(id, { thread: createThread(stringParam(params, "cwd") || workspace) });
        return;
      case "thread/resume":
      case "thread/read":
        writeResponse(id, { thread: ensureThread(stringParam(params, "threadId")) });
        return;
      case "thread/list":
        writeResponse(id, { data: listThreadSummaries(stringParam(params, "cwd") || workspace), nextCursor: null });
        return;
      case "project/read":
        writeResponse(id, { project: recordProjectSnapshot(readProjectSnapshot(stringParam(params, "cwd") || workspace)) });
        return;
      case "project/open":
        writeResponse(id, { project: recordProjectSnapshot(readProjectSnapshot(stringParam(params, "cwd") || workspace)) });
        return;
      case "project/list":
        writeResponse(id, { data: listProjectSummaries(stringParam(params, "cwd") || workspace), nextCursor: null });
        return;
      case "thread/archive":
        archiveThread(stringParam(params, "threadId"));
        writeResponse(id, { ok: true });
        return;
      case "thread/fork":
        writeResponse(id, { thread: forkThread(stringParam(params, "threadId")) });
        return;
      case "thread/name/set":
        writeResponse(id, { thread: renameThread(stringParam(params, "threadId"), stringParam(params, "name")) });
        return;
      case "thread/access-mode/set":
        writeResponse(id, setThreadAccessMode(stringParam(params, "threadId"), stringParam(params, "accessMode")));
        return;
      case "turn/start":
        await startTurn(id, params);
        return;
      case "turn/interrupt":
        await interruptTurn(stringParam(params, "threadId"), stringParam(params, "turnId"));
        writeResponse(id, { ok: true });
        return;
      case "turn/steer":
        writeError(id, "ARC does not support steering a running turn yet.");
        return;
      case "model/list":
        writeResponse(id, { data: modelList() });
        return;
      case "localModel/read":
        writeResponse(id, { localModel: localObserverStatus() });
        return;
      case "memory/read": {
        const capsules = await loadCapsules(stringParam(params, "cwd") || workspace);
        writeResponse(id, { count: capsules.length });
        return;
      }
      case "account/read":
        writeResponse(id, await readAccount(params));
        return;
      case "account/rateLimits/read":
        writeResponse(id, { rateLimits: null });
        return;
      case "experimentalFeature/list":
      case "collaborationMode/list":
      case "mcpServerStatus/list":
      case "skills/list":
      case "app/list":
        writeResponse(id, { data: [], nextCursor: null });
        return;
      default:
        writeResponse(id, {});
    }
  } catch (error) {
    writeProtocolError(id, error);
  }
}

async function startTurn(id: string | number | null, params: JsonRecord): Promise<void> {
  const threadId = stringParam(params, "threadId");
  const thread = ensureThread(threadId);
  const permissionMode = resolveTurnPermissionMode(params);
  const runtime = runtimeSelectionFromParams(params);
  threadPermissionModes.set(thread.id, permissionMode);
  const turnId = process.env.AGENT_RUN_CACHE_DESKTOP_SMOKE === "1"
    ? `${serverSessionId}-turn-${++turnCounter}`
    : `turn-${randomUUID()}`;
  const prompt = promptFromInput(params.input);
  const turn: ThreadTurn = { id: turnId, items: [] };
  thread.turns.push(turn);
  touchThread(thread, prompt);

  writeResponse(id, { turn: { id: turnId, threadId, status: "running", accessMode: permissionMode } });
  emit("turn/started", {
    threadId,
    turn: { id: turnId, threadId, status: "running", accessMode: permissionMode }
  });

  const userItem = {
    id: `user-${randomUUID()}`,
    type: "userMessage",
    content: [{ type: "text", text: prompt }]
  };
  turn.items.push(userItem);
  persistThreads();
  emit("item/completed", { threadId, item: userItem });

  activeTurns.set(threadId, { turnId, canceled: false });
  void runTurn(thread, turn, prompt, runtime).catch(async (error) => {
    const message = error instanceof Error ? error.message : String(error);
    finalizeOpenTurnItems(threadId, turn, `Turn failed before this tool returned.\n\n${message}`);
    // The reason a turn died must be visible in the chat itself; an error-only
    // protocol notification leaves the user staring at a silent "failed" turn.
    addTurnItem(threadId, turn, {
      id: `arc-runner-error-${randomUUID()}`,
      type: "agentMessage",
      text: runnerFailureText(message)
    });
    emit("error", {
      threadId,
      turnId,
      error: { message },
      willRetry: false
    });
    emit("turn/completed", {
      threadId,
      turn: { id: turnId, threadId, status: "failed" }
    });
    if (memoryEnabled()) {
      await recordMemoryEvent({
        type: "runner.failed",
        workspace: thread.cwd || workspace,
        sessionId: serverSessionId,
        turnId,
        details: { runner: runnerName, error: message.slice(0, 500) }
      }).catch(() => undefined);
    }
    activeTurns.delete(threadId);
  });
}

function runnerFailureText(message: string): string {
  const lines = [`ARC could not complete this turn: ${message}`];
  if (runnerName === "copilot") {
    if (/enoent|not found|no such file|spawn .*copilot/i.test(message)) {
      lines.push("The GitHub Copilot CLI looks missing. Install it with `npm install -g @github/copilot`, then run `copilot` once and `/login`.");
    } else if (isCopilotQuotaError(message)) {
      lines.push("Copilot is signed in, but this account or model is out of quota. Try another Copilot account/model or retry after the quota resets.");
    } else if (isCopilotAuthError(message)) {
      lines.push(copilotLoginGuidance());
    }
  }
  return lines.join("\n\n");
}

function isCopilotQuotaError(message: string): boolean {
  return /quota|quota_exceeded|402|used all .*copilot.*requests|copilot free chat requests|chat requests for the month|upgrade your plan for access to premium models/i.test(message);
}

export function isCopilotAuthError(message: string): boolean {
  return /auth|login|unauthorized|forbidden|401|403|token|sign.?in/i.test(message);
}

export function copilotLoginGuidance(): string {
  return "Copilot looks signed out on this machine. Run `copilot` in a terminal and `/login`, then retry. On Linux, run that inside the Linux user account that launches ARC; Mac, VS Code, or GitHub CLI auth may not be the same auth store.";
}

async function readAccount(params: JsonRecord): Promise<ArcAccountReadResponse> {
  const runtime = runtimeSelectionFromParams(params);
  if (runtime.provider === "ollama") {
    return {
      account: { type: "apiKey", label: "Ollama" },
      requiresOpenaiAuth: false,
      authMode: "ollama"
    };
  }
  if (fakeRunner) {
    return {
      account: { type: "apiKey", label: "Fake Copilot" },
      requiresOpenaiAuth: false,
      authMode: "copilot",
      copilotAuthStatus: {
        isAuthenticated: true,
        authType: "env",
        host: "github.com",
        login: "fake-copilot"
      }
    };
  }
  try {
    const status = await readCopilotAuthStatus(stringParam(params, "cwd") || workspace);
    return accountFromCopilotAuthStatus(status);
  } catch (error) {
    const message = errorMessage(error);
    if (isCopilotQuotaError(message)) {
      return {
        account: { type: "apiKey", label: "GitHub Copilot" },
        requiresOpenaiAuth: false,
        authMode: "copilot",
        authError: message,
        quotaExceeded: true,
        quotaMessage: message,
        copilotAuthStatus: {
          isAuthenticated: true,
          statusMessage: message
        }
      };
    }
    return {
      account: null,
      requiresOpenaiAuth: true,
      authMode: "copilot",
      authError: message,
      copilotAuthStatus: {
        isAuthenticated: false,
        statusMessage: message
      },
      authGuidance: `${message}\n\n${copilotLoginGuidance()}`
    };
  }
}

export function accountFromCopilotAuthStatus(status: GetAuthStatusResponse): ArcAccountReadResponse {
  const login = status.login?.trim();
  const host = status.host?.trim();
  const label = login || host || "GitHub Copilot";
  const quotaMessage = status.statusMessage && isCopilotQuotaError(status.statusMessage)
    ? status.statusMessage
    : undefined;
  const quotaExceeded = !!quotaMessage;
  const isAuthenticated = status.isAuthenticated || quotaExceeded;
  return {
    account: isAuthenticated
      ? { type: "apiKey", label, login, host, authType: status.authType }
      : null,
    requiresOpenaiAuth: !isAuthenticated,
    authMode: "copilot",
    copilotAuthStatus: status,
    ...(quotaExceeded ? { quotaExceeded, quotaMessage, authError: quotaMessage } : {}),
    ...(!isAuthenticated ? { authGuidance: status.statusMessage ? `${status.statusMessage}\n\n${copilotLoginGuidance()}` : copilotLoginGuidance() } : {})
  };
}

async function readCopilotAuthStatus(turnWorkspace: string): Promise<GetAuthStatusResponse> {
  const client = new CopilotClient(clientOptions(turnWorkspace));
  try {
    await withTimeout(client.start(), 10_000, "Timed out starting the Copilot runtime.");
    return await withTimeout(client.getAuthStatus(), 10_000, "Timed out checking Copilot auth status.");
  } finally {
    const stopErrors = await client.stop().catch((error) => [error]);
    if (Array.isArray(stopErrors) && stopErrors.length) {
      void debug("app_server.copilot_auth_status_stop_failed", { errors: stopErrors.map(String) }, workspace);
    }
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

async function runTurn(
  thread: ThreadRecord,
  turn: ThreadTurn,
  prompt: string,
  runtime: RuntimeSelection
): Promise<void> {
  const turnId = turn.id;
  const threadId = thread.id;
  const turnWorkspace = thread.cwd || workspace;
  const plan = memoryEnabled()
    ? await safeInjectionPlan(prompt, turnWorkspace)
    : noInjectionPlan("desktop host owns ARC memory");
  const finalPrompt = plan.shouldInject ? `${plan.message}\n\nUser task:\n${prompt}` : prompt;
  const events: ArcEvent[] = [
    syntheticEvent("session_start", turnId, "arc-app-server", `ARC app turn started for ${threadId}.`, runnerName, turnWorkspace),
    syntheticEvent("user_prompt", turnId, "arc-app-server", prompt, runnerName, turnWorkspace)
  ];

  if (memoryEnabled()) {
    await recordMemoryEvent({
      type: "turn.started",
      workspace: turnWorkspace,
      sessionId: serverSessionId,
      turnId,
      details: {
        prompt: prompt.slice(0, 500),
        runner: runnerName,
        provider: runtime.provider || "copilot",
        model: runtime.model,
        surface: "native-app"
      }
    });
  }
  if (plan.shouldInject) {
    await recordMemoryEvent({
      type: "capsule.injected",
      workspace: turnWorkspace,
      sessionId: serverSessionId,
      turnId,
      capsuleId: plan.capsule?.id,
      details: {
        source: plan.source,
        reason: plan.reason,
        title: plan.capsule?.title
      }
    });
  }
  // The chat only carries a memory item when something was actually injected;
  // a "no matching capsule" card on every turn is noise. The decision is still
  // recorded in the debug log by retrieval.
  if (plan.shouldInject) addTurnItem(threadId, turn, memoryContextItem(plan));

  if (memoryEnabled()) {
    await recordMemoryEvent({
      type: "runner.started",
      workspace: turnWorkspace,
      sessionId: serverSessionId,
      turnId,
      details: { runner: runnerName, provider: runtime.provider || "copilot", model: runtime.model }
    });
  }

  if (fakeRunner) {
    await runFakeAppTurn(thread, turn, prompt, events, plan, turnWorkspace);
    return;
  }

  if (runnerName === "opencode") {
    await runOpenCodeAppTurn(thread, turn, prompt, finalPrompt, events, plan, runtime, turnWorkspace);
    return;
  }

  let assistantItemId = `assistant-${randomUUID()}`;
  let assistantText = "";
  let assistantCompleted = false;
  let runnerStatus: "completed" | "failed" = "completed";
  const runner = await runnerForThread(thread, runtime, turnWorkspace, turnId);
  resetAwaitingInput(runner);
  const unsubscribe = runner.session.on((event) => {
    const arcEvent = normalizeArcEvent(event, turnId, runner.toolNames, turnWorkspace);
    if (arcEvent) events.push(arcEvent);
    if (event.type === "assistant.message_delta" && event.data.deltaContent) {
      assistantText += event.data.deltaContent;
      emit("item/agentMessage/delta", {
        threadId,
        itemId: assistantItemId,
        delta: event.data.deltaContent
      });
      return;
    }
    if (event.type === "assistant.message" && event.data.content) {
      assistantText = event.data.content;
      assistantCompleted = true;
      const item = { id: assistantItemId, type: "agentMessage", text: assistantText };
      turn.items.push(item);
      emit("item/completed", { threadId, item });
      touchThread(thread, prompt, assistantText);
      return;
    }
    if (event.type === "tool.execution_start") {
      runner.toolNames.set(event.data.toolCallId, event.data.toolName);
      const item = {
        id: event.data.toolCallId,
        type: "commandExecution",
        command: [commandFromTool(event.data.toolName, event.data.arguments)],
        status: "inProgress",
        cwd: turnWorkspace
      };
      turn.items.push(item);
      emit("item/started", { threadId, item });
      return;
    }
    if (event.type === "tool.execution_complete") {
      const toolName = runner.toolNames.get(event.data.toolCallId) ?? "tool";
      const text = toolResultText(event);
      const item = {
        id: event.data.toolCallId,
        type: "commandExecution",
        command: [commandFromTool(toolName, undefined)],
        status: event.data.success ? "completed" : "failed",
        aggregatedOutput: text,
        cwd: turnWorkspace
      };
      replaceTurnItem(turn, item);
      emit("item/completed", { threadId, item });
    }
  });

  try {
    await runner.session.sendAndWait({ prompt: finalPrompt, mode: "enqueue" }, timeoutMs);
  } catch (error) {
    runnerStatus = "failed";
    throw error;
  } finally {
    unsubscribe();
  }

  if (!assistantCompleted && assistantText) {
    const item = { id: assistantItemId, type: "agentMessage", text: assistantText };
    turn.items.push(item);
    emit("item/completed", { threadId, item });
    touchThread(thread, prompt, assistantText);
  }
  events.push(syntheticEvent("assistant_message", turnId, "arc-app-server", assistantText, runnerName, turnWorkspace));
  if (runner.awaitingInput) {
    events.push(
      syntheticEvent("awaiting_input", turnId, "arc-app-server", runner.awaitingInput.question, runnerName, turnWorkspace)
    );
  }
  await completeTurn(thread, turn, events, plan, runnerStatus, turnWorkspace);
}

async function runFakeAppTurn(
  thread: ThreadRecord,
  turn: ThreadTurn,
  prompt: string,
  events: ArcEvent[],
  plan: InjectionPlan,
  turnWorkspace: string
): Promise<void> {
  const text = process.env.AGENT_RUN_CACHE_START_FAKE_RESPONSE ?? "Fake ARC desktop answer.";
  const item = { id: `assistant-${randomUUID()}`, type: "agentMessage", text };
  turn.items.push(item);
  emit("item/agentMessage/delta", { threadId: thread.id, itemId: item.id, delta: text });
  emit("item/completed", { threadId: thread.id, item });
  touchThread(thread, prompt, text);
  events.push(syntheticEvent("assistant_message", turn.id, "arc-app-fake", text, runnerName, turnWorkspace));
  await completeTurn(thread, turn, events, plan, "completed", turnWorkspace);
}

async function runOpenCodeAppTurn(
  thread: ThreadRecord,
  turn: ThreadTurn,
  prompt: string,
  finalPrompt: string,
  events: ArcEvent[],
  plan: InjectionPlan,
  runtime: RuntimeSelection,
  turnWorkspace: string
): Promise<void> {
  const args = ["run"];
  const opencodeModel = effectiveModel(runtime.model);
  if (opencodeModel) args.push("--model", opencodeModel);
  args.push(finalPrompt);
  const toolId = `opencode-${randomUUID()}`;
  const command = `opencode ${args.slice(0, -1).join(" ")} <prompt>`;
  const startedItem = {
    id: toolId,
    type: "commandExecution",
    command: [command],
    status: "inProgress",
    cwd: turnWorkspace
  };
  turn.items.push(startedItem);
  emit("item/started", { threadId: thread.id, item: startedItem });
  const startedEvent = syntheticEvent("tool_start", turn.id, "opencode-run", command, "opencode", turnWorkspace);
  startedEvent.toolName = "opencode";
  startedEvent.toolUseId = toolId;
  startedEvent.command = command;
  events.push(startedEvent);

  let output = "";
  let exitCode = 0;
  let runnerStatus: "completed" | "failed" = "completed";
  try {
    const result = await runProcessCapture(opencodeBin(), args, turnWorkspace, timeoutMs, (chunk) => {
      output += chunk;
      emit("item/agentMessage/delta", { threadId: thread.id, itemId: `assistant-${toolId}`, delta: chunk });
    });
    exitCode = result.exitCode;
    if (exitCode !== 0) runnerStatus = "failed";
    if (!output) output = result.output;
  } catch (error) {
    runnerStatus = "failed";
    output = error instanceof Error ? error.message : String(error);
    exitCode = 1;
  }

  const completedItem = {
    id: toolId,
    type: "commandExecution",
    command: [command],
    status: runnerStatus === "completed" ? "completed" : "failed",
    aggregatedOutput: output,
    cwd: turnWorkspace
  };
  replaceTurnItem(turn, completedItem);
  emit("item/completed", { threadId: thread.id, item: completedItem });
  const completedEvent = syntheticEvent("tool_end", turn.id, "opencode-run", output, "opencode", turnWorkspace);
  completedEvent.toolName = "opencode";
  completedEvent.toolUseId = toolId;
  completedEvent.command = command;
  completedEvent.toolStatus = runnerStatus === "completed" ? "success" : "failed";
  completedEvent.exitCode = exitCode;
  events.push(completedEvent);

  const assistantText = output.trim();
  if (assistantText) {
    const assistantItem = { id: `assistant-${toolId}`, type: "agentMessage", text: assistantText };
    turn.items.push(assistantItem);
    emit("item/completed", { threadId: thread.id, item: assistantItem });
    touchThread(thread, prompt, assistantText);
    events.push(syntheticEvent("assistant_message", turn.id, "opencode-run", assistantText, "opencode", turnWorkspace));
  }
  await completeTurn(thread, turn, events, plan, runnerStatus, turnWorkspace);
}

async function completeTurn(
  thread: ThreadRecord,
  turn: ThreadTurn,
  events: ArcEvent[],
  plan: InjectionPlan,
  runnerStatus: "completed" | "failed",
  turnWorkspace: string
): Promise<void> {
  const threadId = thread.id;
  const turnId = turn.id;
  events.push(syntheticEvent("session_end", turnId, "arc-app-server", `ARC app turn ${runnerStatus}.`, runnerName, turnWorkspace));
  if (memoryEnabled()) {
    await saveTraceEvents(events, turnId, turnWorkspace);
    await recordMemoryEvent({
      type: "runner.completed",
      workspace: turnWorkspace,
      sessionId: serverSessionId,
      turnId,
      details: { runner: runnerName, status: runnerStatus, eventCount: events.length }
    });
    const review = await maybeReviewTurn(events, plan, runnerStatus, turnId, turnWorkspace, { reviewMode, sessionId: serverSessionId });
    if (review) addTurnItem(threadId, turn, memoryReviewItem(review));
  }
  persistThreads();
  emit("turn/completed", {
    threadId,
    turn: { id: turnId, threadId, status: runnerStatus }
  });
  activeTurns.delete(threadId);
}

function resetAwaitingInput(runner: RunnerState): void {
  runner.awaitingInput = null;
}

async function runnerForThread(
  thread: ThreadRecord,
  runtime: RuntimeSelection,
  turnWorkspace: string,
  currentTurnId = ""
): Promise<RunnerState> {
  const threadId = thread.id;
  const key = runtimeKey(runtime, turnWorkspace);
  const existing = runners.get(threadId);
  if (existing?.runtimeKey === key) return existing;
  if (existing) {
    await existing.session.disconnect().catch(() => undefined);
    await existing.client.stop().catch(() => undefined);
    runners.delete(threadId);
  }
  const client = new CopilotClient(clientOptions(turnWorkspace));
  await client.start();
  const sdkSessionId = `arc-${threadId}`;
  const config = sessionConfig(threadId, runtime, turnWorkspace);
  const shouldResume = shouldResumeCopilotSdkSession(thread, currentTurnId);
  let session: CopilotSession;
  if (shouldResume) {
    try {
      session = await client.resumeSession(sdkSessionId, config);
      await debug("app_server.copilot_session_resumed", { threadId, sessionId: sdkSessionId }, turnWorkspace);
    } catch (error) {
      await debug("app_server.copilot_session_resume_failed", { threadId, sessionId: sdkSessionId, error: String(error) }, turnWorkspace);
      session = await client.createSession({ ...config, sessionId: sdkSessionId });
    }
  } else {
    session = await client.createSession({ ...config, sessionId: sdkSessionId });
    await debug("app_server.copilot_session_created", { threadId, sessionId: sdkSessionId }, turnWorkspace);
  }
  const state: RunnerState = { client, session, toolNames: new Map(), runtimeKey: key, awaitingInput: null };
  runners.set(threadId, state);
  return state;
}

export function shouldResumeCopilotSdkSession(
  thread: { turns?: Array<{ id?: string; items?: JsonRecord[] }> },
  currentTurnId = ""
): boolean {
  return (thread.turns ?? []).some((turn) => {
    if (currentTurnId && turn.id === currentTurnId) return false;
    return (turn.items ?? []).some((item) => {
      const type = stringValue(item.type);
      return type === "agentMessage"
        || type === "commandExecution"
        || type === "mcpToolCall"
        || type === "fileChange";
    });
  });
}

function clientOptions(turnWorkspace = workspace): ConstructorParameters<typeof CopilotClient>[0] {
  const connection = sdkRuntimeConnection();
  const disableLoggedInUser = process.env.ARC_COPILOT_DISABLE_LOGGED_IN_USER === "1";
  return {
    ...(connection ? { connection } : {}),
    ...(disableLoggedInUser ? { useLoggedInUser: false } : {}),
    workingDirectory: turnWorkspace,
    logLevel: "all",
    env: {
      ...process.env,
      AGENT_RUN_CACHE_IN_SIDECAR: "1",
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

function sessionConfig(threadId: string, runtime: RuntimeSelection, turnWorkspace = workspace): ResumeSessionConfig {
  return {
    clientName: "arc",
    workingDirectory: turnWorkspace,
    model: effectiveModel(runtime.model),
    provider: providerConfig(runtime),
    streaming: true,
    enableConfigDiscovery: true,
    onPermissionRequest: async (request) => approvePermission(threadId, request),
    onUserInputRequest: async (request) => {
      // The agent used the ask_user tool to ask a clarifying question. Record it so
      // the turn-completion path can tell that the turn ended awaiting user input and
      // suppress the memory-review prompt until the conversation actually resumes.
      const state = runners.get(threadId);
      if (state) state.awaitingInput = { question: stringValue(request?.question) };
      return {
        answer: "",
        wasFreeform: true
      };
    }
  };
}

// "copilot" is the placeholder id modelList() advertises when no explicit
// model is configured. It means "let the Copilot backend pick its default" —
// passing it to the SDK as a literal model id fails session creation with
// "copilot not available".
function effectiveModel(modelId: string): string | undefined {
  return modelId && modelId !== "copilot" ? modelId : undefined;
}

function providerConfig(runtime: RuntimeSelection): ProviderConfig | undefined {
  if (runtime.provider !== "ollama") return undefined;
  return {
    type: "openai",
    baseUrl: runtime.providerBaseUrl,
    modelId: runtime.model,
    wireModel: runtime.model
  };
}

async function approvePermission(threadId: string, request: PermissionRequest): Promise<PermissionRequestResult> {
  const mode = threadPermissionModes.get(threadId) ?? "full-access";
  const automatic = automaticPermissionResultForMode(mode, recordOnly(request));
  if (automatic) return automatic;
  const turnWorkspace = threads.get(threadId)?.cwd || workspace;

  try {
    const result = await sendServerRequest(
      "item/permissions/requestApproval",
      permissionRequestParams(threadId, mode, request)
    );
    return permissionResultFromUiDecision(result);
  } catch (error) {
    await debug("app_server.permission_request_failed", { error: String(error), mode }, turnWorkspace);
    return { kind: "user-not-available" };
  }
}

function sdkRuntimeConnection(): ReturnType<typeof RuntimeConnection.forStdio> | undefined {
  const explicit = !!process.env.AGENT_RUN_CACHE_COPILOT_COMMAND || !!process.env.AGENT_RUN_CACHE_COPILOT_BIN;
  const launcher = copilotCommand([]);
  if (!launcher.command) return undefined;
  const resolved = resolveExecutable(launcher.command);
  if (!resolved) {
    if (explicit) throw new Error(`Configured Copilot runtime was not found: ${launcher.command}`);
    return undefined;
  }
  return RuntimeConnection.forStdio({ path: resolved, args: launcher.args });
}

function resolveExecutable(command: string): string | null {
  if (command.includes("/")) return command;
  const result = spawnSync("which", [command], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  return result.status === 0 ? result.stdout.trim() : null;
}

function opencodeBin(): string {
  return process.env.AGENT_RUN_CACHE_OPENCODE_BIN ?? "opencode";
}

async function runProcessCapture(
  command: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
  onStdout: (chunk: string) => void
): Promise<{ exitCode: number; output: string }> {
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
    if (!settled) child.kill("SIGTERM");
  }, timeoutMs);
  child.stdout.on("data", (chunk) => {
    const text = Buffer.from(chunk).toString("utf8");
    output += text;
    onStdout(text);
  });
  child.stderr.on("data", (chunk) => {
    errorOutput += Buffer.from(chunk).toString("utf8");
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
      resolve({ exitCode: code ?? (signal ? 124 : 0), output: output || errorOutput });
    });
  });
}

async function interruptTurn(threadId: string, turnId: string): Promise<void> {
  const active = activeTurns.get(threadId);
  if (active && (!turnId || active.turnId === turnId)) {
    active.canceled = true;
    await runners.get(threadId)?.session.abort();
    const thread = threads.get(threadId);
    const turn = thread?.turns.find((entry) => entry.id === active.turnId);
    if (turn) finalizeOpenTurnItems(threadId, turn, "Turn was interrupted before this tool returned.");
    emit("turn/completed", {
      threadId,
      turn: { id: active.turnId, threadId, status: "canceled" }
    });
    activeTurns.delete(threadId);
  }
}

async function closeRunners(): Promise<void> {
  rejectPendingServerResponses("ARC app-server stopped before the request was answered.");
  for (const runner of runners.values()) {
    await runner.session.disconnect().catch(() => undefined);
    await runner.client.stop().catch(() => undefined);
  }
}

function createThread(cwd: string): ThreadRecord {
  const id = `thread-${randomUUID()}`;
  const now = new Date().toISOString();
  const root = workspaceRoot(cwd || workspace);
  const thread: ThreadRecord = {
    id,
    cwd: root,
    preview: "New chat",
    created_at: now,
    updated_at: now,
    turns: []
  };
  threads.set(id, thread);
  persistThreads();
  emit("thread/started", { thread });
  return thread;
}

function ensureThread(threadId: string): ThreadRecord {
  const existing = threads.get(threadId);
  if (existing) return existing;
  const now = new Date().toISOString();
  const id = threadId || `thread-${randomUUID()}`;
  const thread: ThreadRecord = {
    id,
    cwd: workspace,
    preview: "New chat",
    created_at: now,
    updated_at: now,
    turns: []
  };
  threads.set(id, thread);
  persistThreads();
  return thread;
}

function forkThread(threadId: string): ThreadRecord {
  const source = ensureThread(threadId);
  const fork = createThread(source.cwd);
  fork.preview = source.preview;
  fork.turns = source.turns.map((turn) => ({
    id: `turn-${randomUUID()}`,
    items: turn.items.map((item) => ({ ...item }))
  }));
  persistThreads();
  return fork;
}

function renameThread(threadId: string, name: string): ThreadRecord {
  const thread = ensureThread(threadId);
  thread.preview = name || thread.preview;
  thread.updated_at = new Date().toISOString();
  persistThreads();
  emit("thread/name/updated", { threadId, threadName: thread.preview });
  return thread;
}

function setThreadAccessMode(threadId: string, value: string): JsonRecord {
  const thread = ensureThread(threadId);
  const accessMode = permissionModeFromString(value) ?? "on-request";
  threadPermissionModes.set(thread.id, accessMode);
  emit("thread/access-mode/updated", { threadId: thread.id, accessMode });
  return { threadId: thread.id, accessMode };
}

function archiveThread(threadId: string): void {
  threads.delete(threadId);
  persistThreads();
  emit("thread/archived", { threadId });
}

function listThreadSummaries(cwd = workspace): JsonRecord[] {
  const root = canonicalPath(workspaceRoot(cwd || workspace));
  return [...threads.values()]
    .filter((thread) => canonicalPath(thread.cwd) === root)
    .sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at))
    .map((thread) => ({
      id: thread.id,
      cwd: thread.cwd,
      preview: thread.preview,
      created_at: thread.created_at,
      updated_at: thread.updated_at,
      source: { type: "arc" }
    }));
}

function readProjectSnapshot(cwd: string): JsonRecord {
  const root = canonicalPath(workspaceRoot(cwd || workspace));
  const branch = gitOutput(root, ["branch", "--show-current"]).trim()
    || gitOutput(root, ["rev-parse", "--abbrev-ref", "HEAD"]).trim()
    || "local";
  const commit = gitOutput(root, ["rev-parse", "--short=12", "HEAD"]).trim() || "local";
  return {
    id: `local:${root}`,
    name: basename(root),
    path: root,
    branch,
    commit,
    changes: gitChanges(root)
  };
}

function recordProjectSnapshot(snapshot: JsonRecord): JsonRecord {
  const record = normalizeProjectRecord({
    ...snapshot,
    updated_at: new Date().toISOString(),
    threadCount: threadCountForProject(stringValue(snapshot.path))
  });
  if (!record) return snapshot;
  const projects = loadPersistedProjects().filter((project) => project.id !== record.id && project.path !== record.path);
  persistProjects([record, ...projects].slice(0, 50));
  return { ...snapshot, ...record };
}

function listProjectSummaries(cwd = workspace): JsonRecord[] {
  const current = recordProjectSnapshot(readProjectSnapshot(cwd));
  const currentRecord = normalizeProjectRecord(current);
  const projects = loadPersistedProjects();
  const merged = currentRecord
    ? [currentRecord, ...projects.filter((project) => project.id !== currentRecord.id && project.path !== currentRecord.path)]
    : projects;
  return merged
    .sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at))
    .slice(0, 50)
    .map((project) => ({ ...project, threadCount: threadCountForProject(project.path) || project.threadCount }));
}

function threadCountForProject(path: string): number {
  if (!path) return 0;
  const target = canonicalPath(path);
  return [...threads.values()].filter((thread) => canonicalPath(thread.cwd) === target).length;
}

function canonicalPath(path: string): string {
  try {
    return realpathSync.native(path);
  } catch {
    return resolve(path);
  }
}

function appProjectsPath(): string {
  return join(appCacheDir(), "projects.json");
}

function loadPersistedProjects(): ProjectRecord[] {
  try {
    const raw = JSON.parse(readFileSync(appProjectsPath(), "utf8")) as unknown;
    if (!Array.isArray(raw)) return [];
    return raw
      .map(normalizeProjectRecord)
      .filter((project): project is ProjectRecord => Boolean(project));
  } catch {
    return [];
  }
}

function persistProjects(projects: ProjectRecord[]): void {
  try {
    mkdirSync(appCacheDir(), { recursive: true });
    writeFileSync(appProjectsPath(), JSON.stringify(projects, null, 2), "utf8");
  } catch (error) {
    void debug("app_server.project_persist_failed", { error: String(error) }, workspace);
  }
}

function normalizeProjectRecord(value: unknown): ProjectRecord | null {
  if (!isRecord(value)) return null;
  const path = stringValue(value.path);
  if (!path) return null;
  return {
    id: stringValue(value.id) || `local:${path}`,
    name: stringValue(value.name) || basename(path),
    path,
    branch: stringValue(value.branch) || "local",
    commit: stringValue(value.commit) || "local",
    updated_at: stringValue(value.updated_at) || new Date().toISOString(),
    threadCount: numericStat(String(value.threadCount ?? 0))
  };
}

function gitChanges(root: string): JsonRecord[] {
  const changes = new Map<string, JsonRecord>();
  const diff = gitOutput(root, ["diff", "--numstat", "HEAD", "--"])
    || gitOutput(root, ["diff", "--numstat", "--"]);
  for (const line of diff.split(/\r?\n/)) {
    const [added, removed, path] = line.split("\t");
    if (!path) continue;
    const normalized = normalizedStatusPath(path);
    if (isArcRuntimePath(normalized)) continue;
    changes.set(normalized, {
      path: normalized,
      added: numericStat(added),
      removed: numericStat(removed)
    });
  }

  const status = gitOutput(root, ["status", "--porcelain=v1", "--untracked-files=all"]);
  for (const line of status.split(/\r?\n/)) {
    if (line.length < 4) continue;
    const path = normalizedStatusPath(line.slice(3).trim());
    if (isArcRuntimePath(path)) continue;
    if (!path || changes.has(path)) continue;
    changes.set(path, { path, added: 0, removed: 0 });
  }
  return [...changes.values()].slice(0, 200);
}

function gitOutput(cwd: string, args: string[]): string {
  const result = spawnSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"]
  });
  return result.status === 0 ? result.stdout : "";
}

function normalizedStatusPath(path: string): string {
  const renamed = path.split(" -> ").pop() ?? path;
  return renamed.replace(/^"|"$/g, "");
}

function isArcRuntimePath(path: string): boolean {
  return path === ".agent-run-cache" || path.startsWith(".agent-run-cache/");
}

function numericStat(value: string): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function touchThread(thread: ThreadRecord, prompt: string, assistantText = ""): void {
  const preview = firstLine(prompt) || firstLine(assistantText) || thread.preview;
  thread.preview = preview.slice(0, 120);
  thread.updated_at = new Date().toISOString();
}

function appThreadsPath(): string {
  return join(appCacheDir(), "threads.json");
}

function legacyAppThreadsPath(): string {
  return join(cacheDir(workspace), "app-threads.json");
}

function loadPersistedThreads(): void {
  loadThreadFile(appThreadsPath());
  loadThreadFile(legacyAppThreadsPath());
}

function loadThreadFile(path: string): void {
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (!Array.isArray(raw)) return;
    for (const value of raw) {
      const thread = normalizeThreadRecord(value);
      if (thread && !threads.has(thread.id)) threads.set(thread.id, thread);
    }
  } catch {
    return;
  }
}

function persistThreads(): void {
  try {
    const serialized = JSON.stringify([...threads.values()], null, 2);
    mkdirSync(appCacheDir(), { recursive: true });
    writeFileSync(appThreadsPath(), serialized, "utf8");
    mkdirSync(cacheDir(workspace), { recursive: true });
    writeFileSync(legacyAppThreadsPath(), serialized, "utf8");
  } catch (error) {
    void debug("app_server.thread_persist_failed", { error: String(error) }, workspace);
  }
}

function normalizeThreadRecord(value: unknown): ThreadRecord | null {
  if (!isRecord(value)) return null;
  const id = stringValue(value.id);
  if (!id) return null;
  return {
    id,
    cwd: stringValue(value.cwd) || workspace,
    preview: stringValue(value.preview) || "New chat",
    created_at: stringValue(value.created_at) || new Date().toISOString(),
    updated_at: stringValue(value.updated_at) || new Date().toISOString(),
    turns: arrayValue(value.turns)
      .map(normalizeThreadTurn)
      .filter((turn): turn is ThreadTurn => Boolean(turn))
  };
}

function normalizeThreadTurn(value: unknown): ThreadTurn | null {
  if (!isRecord(value)) return null;
  const id = stringValue(value.id);
  if (!id) return null;
  return {
    id,
    items: arrayValue(value.items).map(recordOnly)
  };
}

function recordOnly(value: unknown): JsonRecord {
  return isRecord(value) ? value : {};
}

function promptFromInput(input: unknown): string {
  if (!Array.isArray(input)) return "";
  return input
    .map((item) => {
      if (!isRecord(item)) return "";
      if (item.type === "text") return String(item.text ?? "");
      if (item.type === "mention") return `$${String(item.name ?? "")}`;
      return "";
    })
    .filter(Boolean)
    .join(" ")
    .trim();
}

function replaceTurnItem(turn: ThreadTurn, next: JsonRecord): void {
  const id = String(next.id ?? "");
  const index = turn.items.findIndex((item) => String(item.id ?? "") === id);
  if (index >= 0) turn.items[index] = next;
  else turn.items.push(next);
}

function finalizeOpenTurnItems(threadId: string, turn: ThreadTurn, message: string): void {
  let changed = false;
  for (const item of turn.items) {
    if (item.status !== "inProgress") continue;
    item.status = "failed";
    if (item.type === "commandExecution") {
      const previous = stringValue(item.aggregatedOutput);
      item.aggregatedOutput = previous ? `${previous}\n${message}` : message;
    } else if (item.type === "mcpToolCall") {
      item.error = { message };
    }
    changed = true;
    emit("item/completed", { threadId, item });
  }
  if (changed) persistThreads();
}

function addTurnItem(threadId: string, turn: ThreadTurn, item: JsonRecord): void {
  turn.items.push(item);
  persistThreads();
  emit("item/completed", { threadId, item });
}

function emit(method: string, params: JsonRecord): void {
  writeJson({ method, params });
}

function sendServerRequest(method: string, params: JsonRecord): Promise<unknown> {
  const requestId = `arc-request-${++serverRequestCounter}`;
  const key = responseKey(requestId);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingServerResponses.delete(key);
      reject(new Error(`Timed out waiting for ${method}.`));
    }, timeoutMs);
    timer.unref?.();
    pendingServerResponses.set(key, { resolve, reject, timer });
    writeJson({ id: requestId, method, params });
  });
}

function settleServerResponse(id: string | number, message: JsonRpcMessage): void {
  const key = responseKey(id);
  const pending = pendingServerResponses.get(key);
  if (!pending) return;
  clearTimeout(pending.timer);
  pendingServerResponses.delete(key);
  if (message.error !== undefined) {
    pending.reject(new Error(errorMessage(message.error)));
    return;
  }
  pending.resolve(message.result);
}

function rejectPendingServerResponses(message: string): void {
  for (const [key, pending] of pendingServerResponses) {
    clearTimeout(pending.timer);
    pending.reject(new Error(message));
    pendingServerResponses.delete(key);
  }
}

function responseKey(id: string | number): string {
  return String(id);
}

function writeResponse(id: string | number | null, result: unknown): void {
  writeJson({ id, result });
}

function writeError(id: string | number | null, message: string): void {
  writeJson({ id, error: { message } });
}

function writeProtocolError(id: string | number | null, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  writeError(id, message);
  void debug("app_server.error", { message }, workspace);
}

function errorMessage(error: unknown): string {
  if (isRecord(error)) {
    const message = stringValue(error.message);
    if (message) return message;
  }
  return error instanceof Error ? error.message : String(error);
}

function writeJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

export function resolveTurnPermissionMode(params: Record<string, unknown> = {}): PermissionMode {
  const approvalPolicy = stringValue(params.approvalPolicy).toLowerCase();
  const sandboxPolicy = recordOnly(params.sandboxPolicy);
  const sandboxType = (stringValue(sandboxPolicy.type) || stringValue(params.sandbox)).toLowerCase();
  if (approvalPolicy === "never" || sandboxType === "dangerfullaccess" || sandboxType === "danger-full-access") return "full-access";
  if (sandboxType === "readonly" || sandboxType === "read-only") return "read-only";
  if (approvalPolicy === "on-request") return "on-request";
  return "full-access";
}

function permissionModeFromString(value: string): PermissionMode | null {
  if (value === "read-only" || value === "on-request" || value === "full-access") return value;
  return null;
}

function runtimeSelectionFromParams(params: Record<string, unknown> = {}): RuntimeSelection {
  const runtime = recordOnly(params.runtime);
  const selectedProvider = stringValue(runtime.provider).toLowerCase();
  const nextProvider: RuntimeSelection["provider"] = selectedProvider === "ollama"
    ? "ollama"
    : selectedProvider === "copilot"
      ? ""
      : provider === "ollama"
        ? "ollama"
        : "";
  return {
    provider: nextProvider,
    providerBaseUrl: stringValue(runtime.providerBaseUrl) || providerBaseUrl,
    model: stringValue(runtime.model) || model
  };
}

function runtimeKey(runtime: RuntimeSelection, turnWorkspace = workspace): string {
  return `${canonicalPath(turnWorkspace)}:${runtime.provider || "copilot"}:${runtime.providerBaseUrl}:${runtime.model}`;
}

export function automaticPermissionResultForMode(
  mode: PermissionMode,
  request: Record<string, unknown> = {}
): PermissionRequestResult | null {
  if (mode === "full-access") return { kind: "approve-once" };
  if (mode === "read-only") {
    if (stringValue(request.kind).toLowerCase() === "read") return { kind: "approve-once" };
    return { kind: "reject", feedback: "Denied by ARC read-only access mode." };
  }
  return null;
}

export function permissionResultFromUiDecision(result: unknown): PermissionRequestResult {
  const decision = stringValue(recordOnly(result).decision).toLowerCase();
  if (decision === "accept") return { kind: "approve-once" };
  return { kind: "reject", feedback: "Denied by ARC user." };
}

function permissionRequestParams(
  threadId: string,
  accessMode: PermissionMode,
  request: PermissionRequest
): JsonRecord {
  const source = recordOnly(request);
  const params: JsonRecord = {
    threadId,
    accessMode,
    kind: stringValue(source.kind) || "permission"
  };
  copyStringField(source, params, "toolCallId");
  copyStringField(source, params, "toolName");
  copyStringField(source, params, "fileName");
  copyStringField(source, params, "domain");
  copyStringField(source, params, "url");
  const command = stringValue(source.fullCommandText) || stringValue(source.command);
  if (command) {
    params.command = command;
    params.fullCommandText = command;
  }
  return params;
}

function copyStringField(source: JsonRecord, target: JsonRecord, key: string): void {
  const value = stringValue(source[key]);
  if (value) target[key] = value;
}

export function modelList(): JsonRecord[] {
  const selected = model || "copilot";
  const names = provider === "ollama" ? ollamaModelNames(selected) : [selected];
  return names.map((name, index) => ({
    id: name,
    model: name,
    displayName: name,
    description: provider === "ollama" ? "Ollama via Copilot SDK" : "Copilot default model",
    supportedReasoningEfforts: [],
    defaultReasoningEffort: null,
    isDefault: index === 0
  }));
}

function ollamaModelNames(selected: string): string[] {
  const names: string[] = [];
  if (selected) names.push(selected);
  const result = spawnSync("ollama", ["list"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"]
  });
  if (result.status !== 0) return names.length ? names : ["ollama"];
  for (const line of result.stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || /^NAME\s+ID\s+SIZE\s+MODIFIED/i.test(trimmed)) continue;
    const name = trimmed.split(/\s+/)[0];
    if (name && !names.includes(name)) names.push(name);
  }
  return names.length ? names : ["ollama"];
}

function memoryEnabled(): boolean {
  return memoryMode !== "off";
}

function noInjectionPlan(reason: string): InjectionPlan {
  return {
    shouldInject: false,
    message: "",
    reason,
    source: "local"
  };
}

async function safeInjectionPlan(prompt: string, turnWorkspace = workspace): Promise<InjectionPlan> {
  try {
    return await buildInjectionPlan(prompt, turnWorkspace, { runner: runnerName });
  } catch (error) {
    await debug("app_server.injection_failed", { error: String(error) }, turnWorkspace);
    return {
      shouldInject: false,
      message: "",
      reason: "injection unavailable; see ARC debug logs",
      source: "local"
    };
  }
}

function memoryContextItem(plan: InjectionPlan): JsonRecord {
  const title = plan.capsule?.title ?? plan.capsule?.id ?? "capsule";
  const summary = plan.capsule?.summary ?? "";
  return {
    id: `arc-memory-context-${randomUUID()}`,
    type: "arcMemory",
    title: `Memory injected: ${title}`,
    status: "injected",
    text: [plan.reason, summary].filter(Boolean).join("\n\n"),
    capsuleId: plan.capsule?.id
  };
}

function memoryReviewItem(decision: ReviewDecision, id?: string): JsonRecord {
  return {
    id: id || `arc-memory-review-${randomUUID()}`,
    type: "arcMemory",
    title: decision.title,
    status: decision.status,
    text: decision.text
  };
}

function normalizeArcEvent(
  event: SessionEvent,
  turnId: string,
  toolNames: Map<string, string>,
  turnWorkspace = workspace
): ArcEvent | null {
  const base = {
    id: event.id,
    runner: "copilot" as const,
    sessionId: turnId,
    workspace: turnWorkspace,
    timestamp: event.timestamp,
    source: "copilot-sdk",
    rawType: event.type,
    raw: event
  };
  if (event.type === "assistant.message") {
    return { ...base, type: "assistant_message", text: event.data.content };
  }
  if (event.type === "tool.execution_start") {
    toolNames.set(event.data.toolCallId, event.data.toolName);
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
    return {
      ...base,
      type: "tool_end",
      toolName: toolNames.get(event.data.toolCallId) ?? "tool",
      toolUseId: event.data.toolCallId,
      command: commandFromTool(toolNames.get(event.data.toolCallId) ?? "tool", undefined),
      text,
      toolStatus: event.data.success ? "success" : "failed",
      exitCode: terminalExitCode(event) ?? exitCodeFromText(text) ?? undefined
    };
  }
  if (event.type === "session.error") {
    return { ...base, type: "unknown", text: event.data.message };
  }
  return null;
}

function commandFromTool(toolName: string, args: unknown): string {
  if (!args || typeof args !== "object" || Array.isArray(args)) return toolName;
  const record = args as JsonRecord;
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

function syntheticEvent(
  type: ArcEvent["type"],
  sessionId: string,
  source: string,
  text: string,
  runner: "copilot" | "opencode" = "copilot",
  turnWorkspace = workspace
): ArcEvent {
  return {
    id: `${sessionId}-${source}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    runner,
    sessionId,
    workspace: turnWorkspace,
    timestamp: new Date().toISOString(),
    type,
    source,
    text
  };
}

function parseRunner(value: string): "copilot" | "opencode" {
  if (value === "copilot" || value === "opencode") return value;
  return "copilot";
}

function firstLine(value: string): string {
  return value.split(/\r?\n/, 1)[0]?.trim() ?? "";
}

function stringParam(params: JsonRecord, key: string): string {
  return String(params[key] ?? params[snakeCase(key)] ?? "").trim();
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function snakeCase(value: string): string {
  return value.replace(/[A-Z]/g, (char) => `_${char.toLowerCase()}`);
}

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function shortJson(value: unknown): string {
  try {
    return JSON.stringify(value).slice(0, 500);
  } catch {
    return String(value).slice(0, 500);
  }
}

if (isMainModule()) {
  runArcAppServer();
}

function isMainModule(): boolean {
  const entry = process.argv[1];
  return Boolean(entry && resolve(entry) === fileURLToPath(import.meta.url));
}
