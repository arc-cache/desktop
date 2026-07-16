import { randomUUID } from "crypto";
import { join } from "path";
import { pathToFileURL } from "url";
import { resolveArcRuntimeDistDir } from "./arc-runtime";
import { codexUtilityPrompt } from "./codex-utility-prompt";
import { log } from "./logger";
import { reportError } from "./error-utils";

type ArcHostEngine = "claude" | "codex" | "copilot";
type ArcEventType =
  | "session_start"
  | "user_prompt"
  | "assistant_message"
  | "tool_start"
  | "tool_end"
  | "awaiting_input"
  | "session_end"
  | "unknown";

interface InjectionPlan {
  shouldInject: boolean;
  message: string;
  reason: string;
  source?: "sidecar" | "local";
  capsule?: { id?: string; title?: string };
}

interface ArcEvent {
  id: string;
  runner: ArcHostEngine;
  sessionId: string;
  workspace: string;
  timestamp: string;
  type: ArcEventType;
  source: string;
  text?: string;
  toolName?: string;
  toolUseId?: string;
  command?: string;
  path?: string;
  toolStatus?: "success" | "failed" | "unknown";
  exitCode?: number;
  rawType?: string;
  raw?: unknown;
}

interface RuntimeModules {
  buildInjectionPlan: (prompt: string, workspace: string, context?: { recentPrompts?: string[]; runner?: ArcHostEngine }) => Promise<InjectionPlan>;
  saveTraceEvents: (events: ArcEvent[], sessionId: string, workspace: string) => Promise<string>;
  recordMemoryEvent: (event: Record<string, unknown>) => Promise<void>;
  createRunTelemetry: (input: DesktopRunTelemetryInput) => unknown;
  recordRunTelemetry: (record: unknown, workspace: string) => Promise<unknown>;
  providerUsageFromAcp: (value: unknown, scope: "turn" | "session") => ProviderUsageMeasurement | null;
  maybeReviewTurn: (
    events: ArcEvent[],
    plan: InjectionPlan,
    runnerStatus: "completed" | "failed",
    turnId: string,
    workspace: string,
    options?: SidecarReviewOptions,
  ) => Promise<unknown>;
  debug: (action: string, details?: Record<string, unknown>, workspace?: string) => Promise<void>;
}

export interface ArcReviewNotice {
  id: string;
  title: string;
  status: string;
  text: string;
}

type ArcReviewNoticeCallback = (notice: ArcReviewNotice) => void;

interface TurnState {
  engine: ArcHostEngine;
  sessionId: string;
  turnId: string;
  workspace: string;
  prompt: string;
  plan: InjectionPlan;
  startedAtMs: number;
  forwardedAtMs: number;
  firstModelActivityAtMs?: number;
  providerUsageValue?: unknown;
  events: ArcEvent[];
  toolNames: Map<string, string>;
  claudeAssistantDelta: string;
  codexAgentDeltas: Map<string, string>;
  codexToolOutputDeltas: Map<string, string>;
}

interface BeginTurnInput {
  engine: ArcHostEngine;
  sessionId: string;
  cwd: string;
  prompt: string;
}

interface ProviderUsageMeasurement {
  tokens: {
    inputTokens: number | null;
    outputTokens: number | null;
    totalTokens: number | null;
    source: "provider" | "estimate" | "unknown";
    scope: "turn" | "session";
  };
  cost: {
    amount: number | null;
    currency: string;
    source: "provider" | "estimate" | "unknown";
    scope: "turn" | "session";
  };
}

interface DesktopRunTelemetryInput {
  runner: ArcHostEngine;
  sessionId: string;
  turnId: string;
  startedAtMs: number;
  forwardedAtMs: number;
  firstModelActivityAtMs?: number;
  endedAtMs: number;
  stopReason: string;
  events: ArcEvent[];
  providerUsage?: ProviderUsageMeasurement | null;
  estimatedInputText: string;
  estimatedOutputText: string;
  plan: InjectionPlan;
}

interface SidecarReviewRequest {
  runner: ArcHostEngine;
  prompt: string;
}

interface SidecarReview {
  shouldSave?: boolean;
  reason?: string;
  capsule?: unknown;
  capsules?: unknown[];
}

interface SidecarReviewOptions {
  reviewer?: (request: SidecarReviewRequest) => Promise<SidecarReview | null>;
  telemetrySessionId?: string;
}

const activeTurns = new Map<string, TurnState>();
const recentPrompts = new Map<string, string[]>();
let runtimePromise: Promise<RuntimeModules | null> | null = null;

export async function beginArcTurn(input: BeginTurnInput): Promise<{ prompt: string; turnId?: string; injected: boolean }> {
  if (!arcHostEnabled() || !input.prompt.trim()) {
    return { prompt: input.prompt, injected: false };
  }

  const startedAtMs = Date.now();
  const key = turnKey(input.engine, input.sessionId);
  const turnId = `${input.engine}-${input.sessionId.slice(0, 8)}-${randomUUID()}`;
  const runtime = await loadRuntime();
  if (!runtime) return { prompt: input.prompt, injected: false };

  let plan: InjectionPlan;
  try {
    plan = await runtime.buildInjectionPlan(input.prompt, input.cwd, {
      recentPrompts: recentPrompts.get(key) ?? [],
      runner: input.engine,
    });
  } catch (error) {
    const message = reportError("ARC_HOST_INJECTION_ERR", error, { engine: input.engine, sessionId: input.sessionId });
    await runtime.debug("desktop_host.injection_failed", { engine: input.engine, sessionId: input.sessionId, error: message }, input.cwd).catch(() => undefined);
    plan = { shouldInject: false, message: "", reason: "injection unavailable", source: "local" };
  }

  const events: ArcEvent[] = [
    eventFor(input.engine, turnId, input.cwd, "session_start", "arc-desktop", `ARC desktop turn started for ${input.engine}.`),
    eventFor(input.engine, turnId, input.cwd, "user_prompt", "arc-desktop", input.prompt),
  ];
  activeTurns.set(key, {
    engine: input.engine,
    sessionId: input.sessionId,
    turnId,
    workspace: input.cwd,
    prompt: input.prompt,
    plan,
    startedAtMs,
    forwardedAtMs: startedAtMs,
    events,
    toolNames: new Map(),
    claudeAssistantDelta: "",
    codexAgentDeltas: new Map(),
    codexToolOutputDeltas: new Map(),
  });

  rememberPrompt(key, input.prompt);

  await runtime.recordMemoryEvent({
    type: "turn.started",
    workspace: input.cwd,
    sessionId: input.sessionId,
    turnId,
    details: {
      runner: input.engine,
      surface: "desktop-native",
      prompt: input.prompt.slice(0, 500),
    },
  }).catch(() => undefined);

  if (plan.shouldInject) {
    await runtime.recordMemoryEvent({
      type: "capsule.injected",
      workspace: input.cwd,
      sessionId: input.sessionId,
      turnId,
      capsuleId: plan.capsule?.id,
      details: {
        source: plan.source,
        reason: plan.reason,
        title: plan.capsule?.title,
      },
    }).catch(() => undefined);
  }

  const prompt = plan.shouldInject
    ? `${plan.message}\n\nUser task:\n${input.prompt}`
    : input.prompt;
  const state = activeTurns.get(key);
  if (state) state.forwardedAtMs = Date.now();
  return { prompt, turnId, injected: plan.shouldInject };
}

export function recordClaudeSdkEvent(
  sessionId: string,
  message: Record<string, unknown>,
  onReviewNotice?: ArcReviewNoticeCallback,
): void {
  const state = activeTurns.get(turnKey("claude", sessionId));
  if (!state) return;

  if (message.type === "stream_event") {
    markModelActivity(state);
    const event = recordValue(message.event);
    if (event.type === "content_block_delta") {
      const delta = recordValue(event.delta);
      if (delta.type === "text_delta" && typeof delta.text === "string") {
        state.claudeAssistantDelta += delta.text;
      }
    }
    return;
  }

  if (message.type === "assistant") {
    markModelActivity(state);
    const blocks = recordValue(message.message).content;
    if (!Array.isArray(blocks)) return;
    const assistantText: string[] = [];
    for (const block of blocks) {
      const value = recordValue(block);
      if (value.type === "text" && typeof value.text === "string") {
        assistantText.push(value.text);
      }
      if (value.type === "tool_use" && typeof value.id === "string") {
        const toolName = typeof value.name === "string" ? value.name : "tool";
        state.toolNames.set(value.id, toolName);
        state.events.push(eventFor(state.engine, state.turnId, state.workspace, "tool_start", "claude-sdk", shortJson(value.input), {
          toolName,
          toolUseId: value.id,
          command: commandFromTool(toolName, value.input),
          rawType: "assistant.tool_use",
          raw: block,
        }));
      }
    }
    const text = assistantText.join("\n").trim();
    if (text) {
      state.events.push(eventFor(state.engine, state.turnId, state.workspace, "assistant_message", "claude-sdk", text, {
        rawType: "assistant",
        raw: message,
      }));
      state.claudeAssistantDelta = "";
    }
    return;
  }

  if (message.type === "user") {
    const content = recordValue(message.message).content;
    if (!Array.isArray(content)) return;
    for (const block of content) {
      const value = recordValue(block);
      if (value.type !== "tool_result" || typeof value.tool_use_id !== "string") continue;
      const result = recordValue(message.tool_use_result);
      const text = toolResultText(value, result);
      state.events.push(eventFor(state.engine, state.turnId, state.workspace, "tool_end", "claude-sdk", text, {
        toolName: state.toolNames.get(value.tool_use_id) ?? "tool",
        toolUseId: value.tool_use_id,
        command: commandFromTool(state.toolNames.get(value.tool_use_id) ?? "tool", result),
        toolStatus: value.is_error ? "failed" : "success",
        exitCode: numericValue(result.exitCode),
        rawType: "user.tool_result",
        raw: message,
      }));
    }
    return;
  }

  if (message.type === "result") {
    state.providerUsageValue = {
      usage: message.usage,
      cost: {
        amount: numericValue(message.total_cost_usd),
        currency: "USD",
      },
    };
    const status = message.is_error ? "failed" : "completed";
    void finishArcTurn(state.engine, sessionId, status).then((notice) => {
      if (notice) onReviewNotice?.(notice);
    });
  }
}

export function recordCodexLikeNotification(
  engine: "codex" | "copilot",
  sessionId: string,
  notification: { method?: string; params?: unknown },
  onReviewNotice?: ArcReviewNoticeCallback,
): void {
  const state = activeTurns.get(turnKey(engine, sessionId));
  if (!state) return;
  const params = recordValue(notification.params);

  if (notification.method === "item/agentMessage/delta") {
    markModelActivity(state);
    const itemId = stringValue(params.itemId);
    const delta = stringValue(params.delta);
    if (itemId && delta) {
      state.codexAgentDeltas.set(itemId, `${state.codexAgentDeltas.get(itemId) ?? ""}${delta}`);
    }
    return;
  }

  if (notification.method === "item/commandExecution/outputDelta") {
    const itemId = stringValue(params.itemId);
    const delta = stringValue(params.delta);
    if (itemId && delta) {
      state.codexToolOutputDeltas.set(itemId, `${state.codexToolOutputDeltas.get(itemId) ?? ""}${delta}`);
    }
    return;
  }

  if (notification.method === "item/started") {
    const item = recordValue(params.item);
    const toolName = codexLikeToolName(item);
    if (!toolName) return;
    markModelActivity(state);
    const itemId = stringValue(item.id) || randomUUID();
    state.toolNames.set(itemId, toolName);
    state.events.push(eventFor(engine, state.turnId, state.workspace, "tool_start", `${engine}-app-server`, shortJson(item), {
      toolName,
      toolUseId: itemId,
      command: codexLikeCommand(item, toolName),
      rawType: String(item.type ?? "item"),
      raw: item,
    }));
    return;
  }

  if (notification.method === "item/completed") {
    const item = recordValue(params.item);
    if (item.type === "agentMessage") {
      markModelActivity(state);
      const itemId = stringValue(item.id);
      const text = stringValue(item.text) || (itemId ? state.codexAgentDeltas.get(itemId) ?? "" : "");
      if (text) {
        state.events.push(eventFor(engine, state.turnId, state.workspace, "assistant_message", `${engine}-app-server`, text, {
          rawType: "agentMessage",
          raw: item,
        }));
      }
      if (itemId) state.codexAgentDeltas.delete(itemId);
      return;
    }
    const itemId = stringValue(item.id) || randomUUID();
    const toolName = state.toolNames.get(itemId) ?? codexLikeToolName(item);
    if (!toolName) return;
    const outputDelta = state.codexToolOutputDeltas.get(itemId);
    state.events.push(eventFor(engine, state.turnId, state.workspace, "tool_end", `${engine}-app-server`, codexLikeResultText(item, outputDelta), {
      toolName,
      toolUseId: itemId,
      command: codexLikeCommand(item, toolName),
      toolStatus: codexLikeStatus(item),
      exitCode: numericValue(item.exitCode),
      rawType: String(item.type ?? "item"),
      raw: item,
    }));
    state.codexToolOutputDeltas.delete(itemId);
    return;
  }

  if (notification.method === "turn/completed") {
    const turn = recordValue(params.turn);
    const status = stringValue(turn.status) === "failed" || stringValue(turn.status) === "canceled"
      ? "failed"
      : "completed";
    void finishArcTurn(engine, sessionId, status).then((notice) => {
      if (notice) onReviewNotice?.(notice);
    });
  }
}

export async function finishArcTurn(engine: ArcHostEngine, sessionId: string, status: "completed" | "failed"): Promise<ArcReviewNotice | null> {
  const key = turnKey(engine, sessionId);
  const state = activeTurns.get(key);
  if (!state) return null;
  activeTurns.delete(key);

  const runtime = await loadRuntime();
  if (!runtime) return null;

  flushPendingAssistantText(state);
  state.events.push(eventFor(engine, state.turnId, state.workspace, "session_end", "arc-desktop", `ARC desktop turn ${status}.`));

  try {
    await runtime.saveTraceEvents(state.events, state.turnId, state.workspace);
    try {
      const telemetry = runtime.createRunTelemetry({
        runner: state.engine,
        sessionId: state.sessionId,
        turnId: state.turnId,
        startedAtMs: state.startedAtMs,
        forwardedAtMs: state.forwardedAtMs,
        firstModelActivityAtMs: state.firstModelActivityAtMs,
        endedAtMs: Date.now(),
        stopReason: status === "completed" ? "end_turn" : "failed",
        events: state.events,
        providerUsage: state.providerUsageValue
          ? runtime.providerUsageFromAcp(state.providerUsageValue, "turn")
          : null,
        estimatedInputText: state.plan.shouldInject
          ? `${state.plan.message}\n\nUser task:\n${state.prompt}`
          : state.prompt,
        estimatedOutputText: state.events
          .filter((event) => event.type === "assistant_message")
          .map((event) => event.text ?? "")
          .join("\n"),
        plan: state.plan,
      });
      await runtime.recordRunTelemetry(telemetry, state.workspace);
    } catch (error) {
      await runtime.debug("desktop_host.telemetry_failed", {
        engine,
        sessionId,
        turnId: state.turnId,
        error: error instanceof Error ? error.message : String(error),
      }, state.workspace).catch(() => undefined);
    }
    await runtime.recordMemoryEvent({
      type: "runner.completed",
      workspace: state.workspace,
      sessionId: sessionId,
      turnId: state.turnId,
      details: {
        runner: engine,
        surface: "desktop-native",
        status,
        eventCount: state.events.length,
      },
    });
    const review = await runtime.maybeReviewTurn(
      state.events,
      state.plan,
      status,
      state.turnId,
      state.workspace,
      {
        ...reviewOptionsForEngine(engine, state.workspace),
        telemetrySessionId: state.sessionId,
      },
    );
    return arcReviewNoticeFromDecision(review);
  } catch (error) {
    const message = reportError("ARC_HOST_FINISH_ERR", error, { engine, sessionId });
    await runtime.debug("desktop_host.finish_failed", { engine, sessionId, turnId: state.turnId, error: message }, state.workspace).catch(() => undefined);
    return null;
  }
}

function arcReviewNoticeFromDecision(value: unknown): ArcReviewNotice | null {
  const decision = recordValue(value);
  const status = stringValue(decision.status);
  if (status !== "saved") return null;
  return {
    id: `arc-memory-review-${randomUUID()}`,
    title: stringValue(decision.title) || "Memory saved",
    status,
    text: stringValue(decision.text) || "Capsule saved to memory.",
  };
}

function reviewOptionsForEngine(engine: ArcHostEngine, workspace: string): SidecarReviewOptions | undefined {
  if (engine !== "codex") return undefined;
  return {
    reviewer: async (request) => {
      const output = await codexUtilityPrompt(request.prompt, workspace, "ARC_CODEX_REVIEW", {
        timeoutMs: sidecarTimeoutMs(),
      });
      const parsed = extractJsonObject(output);
      if (!isRecord(parsed)) throw new Error("Codex reviewer did not return a JSON object.");
      return parsed as SidecarReview;
    },
  };
}

function sidecarTimeoutMs(): number {
  const value = Number(process.env.AGENT_RUN_CACHE_SIDECAR_TIMEOUT_MS ?? 120_000);
  return Number.isFinite(value) && value > 0 ? value : 120_000;
}

function extractJsonObject(text: string): unknown {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const first = trimmed.indexOf("{");
    const last = trimmed.lastIndexOf("}");
    if (first >= 0 && last > first) return JSON.parse(trimmed.slice(first, last + 1));
    throw new Error("No JSON object found in Codex reviewer output.");
  }
}

function flushPendingAssistantText(state: TurnState): void {
  if (state.claudeAssistantDelta.trim()) {
    state.events.push(eventFor(state.engine, state.turnId, state.workspace, "assistant_message", "claude-sdk-stream", state.claudeAssistantDelta.trim(), {
      rawType: "stream_event.text_delta",
    }));
    state.claudeAssistantDelta = "";
  }

  for (const [itemId, text] of state.codexAgentDeltas) {
    if (!text.trim()) continue;
    state.events.push(eventFor(state.engine, state.turnId, state.workspace, "assistant_message", `${state.engine}-app-server-delta`, text.trim(), {
      rawType: "item/agentMessage/delta",
      raw: { itemId },
    }));
  }
  state.codexAgentDeltas.clear();
}

function arcHostEnabled(): boolean {
  return process.env.ARC_DESKTOP_MEMORY !== "off";
}

async function loadRuntime(): Promise<RuntimeModules | null> {
  if (!runtimePromise) {
    runtimePromise = (async () => {
      const distDir = resolveArcRuntimeDistDir({ fromDir: __dirname });
      if (!distDir) {
        log("ARC_HOST", "runtime dist not found; ARC host disabled");
        return null;
      }
      const [retrieval, store, ledger, reviewDecision, telemetry] = await Promise.all([
        import(pathToFileURL(join(distDir, "retrieval.js")).href),
        import(pathToFileURL(join(distDir, "store.js")).href),
        import(pathToFileURL(join(distDir, "ledger.js")).href),
        import(pathToFileURL(join(distDir, "review-decision.js")).href),
        import(pathToFileURL(join(distDir, "telemetry.js")).href),
      ]);
      return {
        buildInjectionPlan: retrieval.buildInjectionPlan,
        saveTraceEvents: store.saveTraceEvents,
        debug: store.debug,
        recordMemoryEvent: ledger.recordMemoryEvent,
        createRunTelemetry: telemetry.createRunTelemetry,
        recordRunTelemetry: telemetry.recordRunTelemetry,
        providerUsageFromAcp: telemetry.providerUsageFromAcp,
        maybeReviewTurn: reviewDecision.maybeReviewTurn,
      } satisfies RuntimeModules;
    })().catch((error) => {
      reportError("ARC_HOST_RUNTIME_LOAD_ERR", error);
      return null;
    });
  }
  return runtimePromise;
}

function markModelActivity(state: TurnState): void {
  state.firstModelActivityAtMs ??= Date.now();
}

function turnKey(engine: ArcHostEngine, sessionId: string): string {
  return `${engine}:${sessionId}`;
}

function rememberPrompt(key: string, prompt: string): void {
  const values = recentPrompts.get(key) ?? [];
  values.push(prompt);
  recentPrompts.set(key, values.slice(-5));
}

function eventFor(
  runner: ArcHostEngine,
  sessionId: string,
  workspace: string,
  type: ArcEventType,
  source: string,
  text?: string,
  extra: Partial<ArcEvent> = {},
): ArcEvent {
  return {
    id: `${sessionId}-${source}-${type}-${Date.now()}-${randomUUID()}`,
    runner,
    sessionId,
    workspace,
    timestamp: new Date().toISOString(),
    type,
    source,
    ...(text ? { text } : {}),
    ...extra,
  };
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function numericValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function shortJson(value: unknown): string {
  try {
    return JSON.stringify(value).slice(0, 1000);
  } catch {
    return String(value).slice(0, 1000);
  }
}

function commandFromTool(toolName: string, input: unknown): string {
  const record = recordValue(input);
  const direct = stringValue(record.command) || stringValue(record.cmd) || stringValue(record.script);
  if (direct) return direct;
  const path = stringValue(record.path) || stringValue(record.file_path);
  if (path) return `${toolName} ${path}`;
  return Object.keys(record).length ? `${toolName} ${shortJson(record)}` : toolName;
}

function toolResultText(block: Record<string, unknown>, result: Record<string, unknown>): string {
  const content = block.content;
  if (typeof content === "string") return content.slice(0, 12000);
  if (typeof result.stdout === "string" || typeof result.stderr === "string") {
    return [result.stdout, result.stderr].filter((item): item is string => typeof item === "string" && item.length > 0).join("\n").slice(0, 12000);
  }
  if (typeof result.content === "string") return result.content.slice(0, 12000);
  return shortJson(result);
}

function codexLikeToolName(item: Record<string, unknown>): string | null {
  switch (item.type) {
    case "commandExecution":
      return "Bash";
    case "fileChange":
      return "Edit";
    case "mcpToolCall":
      return `mcp__${stringValue(item.server)}__${stringValue(item.tool)}`;
    case "webSearch":
      return "WebSearch";
    case "imageView":
      return "Read";
    default:
      return null;
  }
}

function codexLikeCommand(item: Record<string, unknown>, fallback: string): string {
  const command = item.command;
  if (Array.isArray(command)) return command.map(String).join(" ");
  if (typeof command === "string") return command;
  if (item.type === "fileChange") {
    const changes = Array.isArray(item.changes) ? item.changes : [];
    const first = recordValue(changes[0]);
    return stringValue(first.path) || fallback;
  }
  if (item.type === "mcpToolCall") return `${stringValue(item.server)}.${stringValue(item.tool)}`;
  if (item.type === "webSearch") return stringValue(item.query) || fallback;
  return fallback;
}

function codexLikeResultText(item: Record<string, unknown>, outputDelta?: string): string {
  const output = stringValue(item.aggregatedOutput);
  if (output) return output.slice(0, 12000);
  if (outputDelta) return outputDelta.slice(0, 12000);
  const result = item.result;
  if (typeof result === "string") return result.slice(0, 12000);
  if (result) return shortJson(result);
  const error = item.error;
  if (error) return shortJson(error);
  return shortJson(item);
}

function codexLikeStatus(item: Record<string, unknown>): "success" | "failed" | "unknown" {
  const status = stringValue(item.status);
  if (status === "completed" || status === "succeeded") return "success";
  if (status === "failed" || status === "declined" || status === "canceled") return "failed";
  const exitCode = numericValue(item.exitCode);
  if (exitCode === 0) return "success";
  if (typeof exitCode === "number") return "failed";
  return "unknown";
}
