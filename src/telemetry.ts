import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { basename, join } from "node:path";

import { appendJsonl, readJsonl } from "./json.js";
import { cacheDir, telemetryPath, telemetryPolicyPath, workspaceRoot } from "./paths.js";
import { redactSensitiveText } from "./redact.js";
import type { ArcEvent, InjectionPlan, Runner } from "./types.js";

export type MeasurementSource = "provider" | "estimate" | "unknown";
export type MeasurementScope = "turn" | "session";

export interface TokenMeasurement {
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  source: MeasurementSource;
  scope: MeasurementScope;
}

export interface CostMeasurement {
  amount: number | null;
  currency: string;
  source: MeasurementSource;
  scope: MeasurementScope;
}

export interface ProviderUsageMeasurement {
  tokens: TokenMeasurement;
  cost: CostMeasurement;
}

export interface ToolCallTelemetry {
  callId: string;
  operationFingerprint: string;
  name: string;
  startedAt: string;
  durationMs: number | null;
  status: "success" | "failed" | "unknown";
  attempt: number;
  retry: boolean;
}

export interface PolicyWarning {
  code: "cost" | "slow_tool" | "repeated_failures" | "excessive_retries" | "reviewer_hard_limit";
  message: string;
  observed: number;
  limit: number;
}

export interface RunTelemetryRecord {
  schemaVersion: 1;
  kind: "run";
  recordedAt: string;
  runner: Runner;
  sessionId: string;
  turnId: string;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  status: "success" | "failed" | "cancelled" | "unknown";
  stopReason: string;
  modelLatency: {
    firstResponseMs: number | null;
    totalMs: number;
    source: "observed";
  };
  tokens: TokenMeasurement;
  cost: CostMeasurement;
  toolCalls: ToolCallTelemetry[];
  failedToolCount: number;
  retryCount: number;
  retrieval: {
    decision: "injected" | "abstained" | "unknown";
    source: "sidecar" | "local" | "unknown";
    capsuleId?: string;
    reason: string;
    weakMatchAbstention: boolean;
    capsuleWasStale: boolean;
    staleCapsuleRejected: boolean;
  };
  warnings: PolicyWarning[];
}

export interface ReviewerCallTelemetryRecord {
  schemaVersion: 1;
  kind: "reviewer_call";
  recordedAt: string;
  runner: "arc-reviewer";
  sessionId: string;
  callId: string;
  source: string;
  durationMs: number;
  status: "success" | "failed" | "blocked";
  tokens: TokenMeasurement;
  cost: CostMeasurement;
  reason?: string;
  warnings: PolicyWarning[];
}

export type TelemetryRecord = RunTelemetryRecord | ReviewerCallTelemetryRecord;

export interface TelemetryPolicy {
  warnings: {
    costUsdPerSession: number | null;
    slowToolMs: number | null;
    repeatedFailures: number | null;
    retriesPerSession: number | null;
  };
  reviewer: {
    maxCallsPerSession: number | null;
    hardCostUsdPerSession: number | null;
    estimatedCostUsdPerCall: number | null;
  };
}

export interface RunTelemetryInput {
  runner: Runner;
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
  plan: InjectionPlan | null;
}

export interface ReviewerExecution<T> {
  allowed: boolean;
  value?: T;
  reason?: string;
}

export interface SessionMetrics {
  sessionId: string;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  status: "success" | "failed" | "cancelled" | "unknown";
  turns: number;
  toolCalls: number;
  failedTools: number;
  failedToolRate: number;
  retries: number;
  modelFirstResponseMs: number | null;
  tokens: {
    total: number | null;
    source: MeasurementSource | "mixed";
  };
  cost: {
    usd: number | null;
    source: MeasurementSource | "mixed";
  };
  reviewerCalls: number;
  warningCount: number;
}

export interface ReplayEvaluationReport {
  generatedAt: string;
  traceCount: number;
  pairedRunCount: number;
  retrievalPrecision: {
    value: number | null;
    relevant: number;
    evaluated: number;
    injected: number;
    method: string;
  };
  weakMatchAbstention: {
    value: number | null;
    abstained: number;
    weakMatchCases: number;
  };
  staleCapsuleRejection: {
    value: number | null;
    rejected: number;
    staleCases: number;
  };
  telemetryRedaction: {
    passed: boolean;
    recordsScanned: number;
    violations: number;
  };
  injectedMemoryOutcome: {
    helped: number;
    didNotHelp: number;
    inconclusive: number;
    method: string;
  };
}

export interface MetricsReport {
  generatedAt: string;
  workspace: string;
  policy: TelemetryPolicy & { path: string };
  summary: {
    sessionCount: number;
    turnCount: number;
    latencyMs: {
      session: Percentiles;
      modelFirstResponse: Percentiles;
      tool: Percentiles;
      reviewer: Percentiles;
    };
    toolCalls: number;
    failedTools: number;
    failedToolRate: number;
    retries: number;
    tokens: {
      total: number;
      provider: number;
      estimated: number;
      unknownSessions: number;
    };
    cost: {
      knownUsd: number;
      providerUsd: number;
      estimatedUsd: number;
      unknownSessions: number;
    };
    warnings: number;
  };
  sessions: SessionMetrics[];
  evaluations: ReplayEvaluationReport;
}

interface Percentiles {
  count: number;
  p50: number | null;
  p95: number | null;
  p99: number | null;
}

interface SessionAggregate {
  metrics: SessionMetrics;
  runs: RunTelemetryRecord[];
  reviewerCalls: ReviewerCallTelemetryRecord[];
  providerTokens: number;
  estimatedTokens: number;
  providerCostUsd: number;
  estimatedCostUsd: number;
}

interface ReplayTrace {
  turnId: string;
  events: ArcEvent[];
}

const DEFAULT_POLICY: TelemetryPolicy = {
  warnings: {
    costUsdPerSession: null,
    slowToolMs: 30_000,
    repeatedFailures: 2,
    retriesPerSession: 3
  },
  reviewer: {
    maxCallsPerSession: null,
    hardCostUsdPerSession: null,
    estimatedCostUsdPerCall: null
  }
};

export function createRunTelemetry(input: RunTelemetryInput): RunTelemetryRecord {
  const tokens = input.providerUsage?.tokens.source === "provider"
    ? input.providerUsage.tokens
    : estimatedTokens(input.estimatedInputText, input.estimatedOutputText);
  const cost = input.providerUsage?.cost.source === "provider"
    ? input.providerUsage.cost
    : unknownCost("turn");
  const toolCalls = toolTelemetryFromEvents(input.events, input.sessionId);
  const reason = retrievalReasonLabel(input.plan);
  const forwardedAtMs = Math.max(input.startedAtMs, input.forwardedAtMs);
  const endedAtMs = Math.max(forwardedAtMs, input.endedAtMs);
  return {
    schemaVersion: 1,
    kind: "run",
    recordedAt: new Date().toISOString(),
    runner: input.runner,
    sessionId: sanitizeLabel(input.sessionId, 200),
    turnId: sanitizeLabel(input.turnId, 240),
    startedAt: new Date(input.startedAtMs).toISOString(),
    endedAt: new Date(endedAtMs).toISOString(),
    durationMs: Math.max(0, endedAtMs - input.startedAtMs),
    status: runStatus(input.stopReason),
    stopReason: sanitizeLabel(input.stopReason || "unknown", 120),
    modelLatency: {
      firstResponseMs: input.firstModelActivityAtMs === undefined
        ? null
        : Math.max(0, input.firstModelActivityAtMs - forwardedAtMs),
      totalMs: Math.max(0, endedAtMs - forwardedAtMs),
      source: "observed"
    },
    tokens,
    cost,
    toolCalls,
    failedToolCount: toolCalls.filter((tool) => tool.status === "failed").length,
    retryCount: toolCalls.filter((tool) => tool.retry).length,
    retrieval: {
      decision: input.plan ? input.plan.shouldInject ? "injected" : "abstained" : "unknown",
      source: input.plan?.source ?? "unknown",
      capsuleId: input.plan?.capsule?.id ? sanitizeLabel(input.plan.capsule.id, 200) : undefined,
      reason,
      weakMatchAbstention: !!input.plan && !input.plan.shouldInject && weakMatchReason(reason),
      capsuleWasStale: input.plan?.capsule?.staleness?.stale === true,
      staleCapsuleRejected: !!input.plan && !input.plan.shouldInject && staleRejectionReason(reason)
    },
    warnings: []
  };
}

export function providerUsageFromAcp(value: unknown, scope: MeasurementScope): ProviderUsageMeasurement | null {
  if (!isRecord(value)) return null;
  const usage = isRecord(value.usage) ? value.usage : value;
  const inputTokens = firstNumber(usage, ["inputTokens", "input_tokens", "input", "promptTokens", "prompt_tokens"]);
  const outputTokens = firstNumber(usage, ["outputTokens", "output_tokens", "output", "completionTokens", "completion_tokens"]);
  const explicitTotal = firstNumber(usage, ["totalTokens", "total_tokens", "total", "used"]);
  const totalTokens = explicitTotal ?? (inputTokens !== null || outputTokens !== null
    ? (inputTokens ?? 0) + (outputTokens ?? 0)
    : null);
  const costValue = isRecord(usage.cost) ? usage.cost : isRecord(value.cost) ? value.cost : null;
  const amount = costValue ? firstNumber(costValue, ["amount", "value", "usd"]) : firstNumber(usage, ["costUsd", "cost_usd"]);
  const currencyValue = costValue && typeof costValue.currency === "string" ? costValue.currency : "USD";
  if (inputTokens === null && outputTokens === null && totalTokens === null && amount === null) return null;
  return {
    tokens: {
      inputTokens,
      outputTokens,
      totalTokens,
      source: totalTokens === null && inputTokens === null && outputTokens === null ? "unknown" : "provider",
      scope
    },
    cost: {
      amount,
      currency: sanitizeCurrency(currencyValue),
      source: amount === null ? "unknown" : "provider",
      scope
    }
  };
}

export async function recordRunTelemetry(
  record: RunTelemetryRecord,
  workspace = workspaceRoot()
): Promise<PolicyWarning[]> {
  const existing = await loadTelemetryRecords(workspace);
  rebaseToolAttempts(record, existing);
  const policy = await loadTelemetryPolicy(workspace);
  const before = aggregateOneSession(record.sessionId, existing);
  const after = aggregateOneSession(record.sessionId, [...existing, record]);
  record.warnings = runWarnings(record, before, after, policy);
  await appendJsonl(telemetryPath(workspace), record);
  return record.warnings;
}

export async function loadTelemetryRecords(workspace = workspaceRoot()): Promise<TelemetryRecord[]> {
  return (await readJsonl<unknown>(telemetryPath(workspace))).filter(isTelemetryRecord);
}

export async function loadTelemetryPolicy(workspace = workspaceRoot()): Promise<TelemetryPolicy> {
  let file: unknown = null;
  try {
    file = JSON.parse(await readFile(telemetryPolicyPath(workspace), "utf8"));
  } catch {
    file = null;
  }
  const root = isRecord(file) ? file : {};
  const warnings = isRecord(root.warnings) ? root.warnings : {};
  const reviewer = isRecord(root.reviewer) ? root.reviewer : {};
  return {
    warnings: {
      costUsdPerSession: configuredNumber(warnings.costUsdPerSession, "AGENT_RUN_CACHE_WARN_COST_USD", DEFAULT_POLICY.warnings.costUsdPerSession),
      slowToolMs: configuredNumber(warnings.slowToolMs, "AGENT_RUN_CACHE_WARN_SLOW_TOOL_MS", DEFAULT_POLICY.warnings.slowToolMs),
      repeatedFailures: configuredInteger(warnings.repeatedFailures, "AGENT_RUN_CACHE_WARN_REPEATED_FAILURES", DEFAULT_POLICY.warnings.repeatedFailures),
      retriesPerSession: configuredInteger(warnings.retriesPerSession, "AGENT_RUN_CACHE_WARN_RETRIES", DEFAULT_POLICY.warnings.retriesPerSession)
    },
    reviewer: {
      maxCallsPerSession: configuredInteger(reviewer.maxCallsPerSession, "AGENT_RUN_CACHE_REVIEWER_MAX_CALLS", DEFAULT_POLICY.reviewer.maxCallsPerSession),
      hardCostUsdPerSession: configuredNumber(reviewer.hardCostUsdPerSession, "AGENT_RUN_CACHE_REVIEWER_HARD_COST_USD", DEFAULT_POLICY.reviewer.hardCostUsdPerSession),
      estimatedCostUsdPerCall: configuredNumber(reviewer.estimatedCostUsdPerCall, "AGENT_RUN_CACHE_REVIEWER_ESTIMATED_COST_USD_PER_CALL", DEFAULT_POLICY.reviewer.estimatedCostUsdPerCall)
    }
  };
}

export async function executeReviewerCall<T>(
  options: {
    workspace: string;
    sessionId: string;
    source: string;
    input: string;
  },
  call: () => Promise<{ value: T; output: string }>
): Promise<ReviewerExecution<T>> {
  const policy = await loadTelemetryPolicy(options.workspace);
  const existing = await loadTelemetryRecords(options.workspace);
  const priorCalls = existing.filter((record): record is ReviewerCallTelemetryRecord =>
    record.kind === "reviewer_call" && record.sessionId === options.sessionId && record.status !== "blocked");
  const reviewerCost = priorCalls.reduce((sum, record) => sum + usdAmount(record.cost), 0);
  const hardLimit = policy.reviewer.hardCostUsdPerSession;
  const estimatedNext = policy.reviewer.estimatedCostUsdPerCall ?? 0;
  let blockReason = "";
  let observed = priorCalls.length;
  let limit = policy.reviewer.maxCallsPerSession ?? 0;
  if (policy.reviewer.maxCallsPerSession !== null && priorCalls.length >= policy.reviewer.maxCallsPerSession) {
    blockReason = `ARC reviewer hard call limit reached (${priorCalls.length}/${policy.reviewer.maxCallsPerSession}).`;
  } else if (hardLimit !== null && reviewerCost + estimatedNext >= hardLimit) {
    blockReason = `ARC reviewer hard cost limit reached (${formatUsd(reviewerCost + estimatedNext)}/${formatUsd(hardLimit)}).`;
    observed = reviewerCost + estimatedNext;
    limit = hardLimit;
  }
  if (blockReason) {
    const warning: PolicyWarning = {
      code: "reviewer_hard_limit",
      message: blockReason,
      observed,
      limit
    };
    await appendJsonl(telemetryPath(options.workspace), reviewerRecord({
      sessionId: options.sessionId,
      source: options.source,
      durationMs: 0,
      status: "blocked",
      input: "",
      output: "",
      estimatedCostUsd: null,
      reason: blockReason,
      warnings: [warning]
    }));
    return { allowed: false, reason: blockReason };
  }

  const startedAt = Date.now();
  try {
    const result = await call();
    const record = reviewerRecord({
      sessionId: options.sessionId,
      source: options.source,
      durationMs: Date.now() - startedAt,
      status: "success",
      input: options.input,
      output: result.output,
      estimatedCostUsd: policy.reviewer.estimatedCostUsdPerCall,
      warnings: []
    });
    record.warnings = reviewerWarnings(record, existing, policy);
    await appendJsonl(telemetryPath(options.workspace), record);
    return { allowed: true, value: result.value };
  } catch (error) {
    const reason = "reviewer call failed";
    const record = reviewerRecord({
      sessionId: options.sessionId,
      source: options.source,
      durationMs: Date.now() - startedAt,
      status: "failed",
      input: options.input,
      output: "",
      estimatedCostUsd: policy.reviewer.estimatedCostUsdPerCall,
      reason,
      warnings: []
    });
    record.warnings = reviewerWarnings(record, existing, policy);
    await appendJsonl(telemetryPath(options.workspace), record);
    throw error;
  }
}

export async function buildMetricsReport(workspace = workspaceRoot()): Promise<MetricsReport> {
  const records = await loadTelemetryRecords(workspace);
  const aggregates = aggregateSessions(records);
  const sessions = aggregates.map((item) => item.metrics)
    .sort((left, right) => Date.parse(right.endedAt) - Date.parse(left.endedAt));
  const runs = records.filter((record): record is RunTelemetryRecord => record.kind === "run");
  const reviewerCalls = records.filter((record): record is ReviewerCallTelemetryRecord => record.kind === "reviewer_call" && record.status !== "blocked");
  const toolCalls = runs.flatMap((run) => run.toolCalls);
  const failedTools = toolCalls.filter((tool) => tool.status === "failed").length;
  const policy = await loadTelemetryPolicy(workspace);
  const summary = {
    sessionCount: sessions.length,
    turnCount: runs.length,
    latencyMs: {
      session: percentiles(sessions.map((session) => session.durationMs)),
      modelFirstResponse: percentiles(runs.map((run) => run.modelLatency.firstResponseMs)),
      tool: percentiles(toolCalls.map((tool) => tool.durationMs)),
      reviewer: percentiles(reviewerCalls.map((call) => call.durationMs))
    },
    toolCalls: toolCalls.length,
    failedTools,
    failedToolRate: toolCalls.length ? failedTools / toolCalls.length : 0,
    retries: runs.reduce((sum, run) => sum + run.retryCount, 0),
    tokens: {
      total: aggregates.reduce((sum, item) => sum + (item.metrics.tokens.total ?? 0), 0),
      provider: aggregates.reduce((sum, item) => sum + item.providerTokens, 0),
      estimated: aggregates.reduce((sum, item) => sum + item.estimatedTokens, 0),
      unknownSessions: aggregates.filter((item) => item.metrics.tokens.total === null).length
    },
    cost: {
      knownUsd: roundMoney(aggregates.reduce((sum, item) => sum + (item.metrics.cost.usd ?? 0), 0)),
      providerUsd: roundMoney(aggregates.reduce((sum, item) => sum + item.providerCostUsd, 0)),
      estimatedUsd: roundMoney(aggregates.reduce((sum, item) => sum + item.estimatedCostUsd, 0)),
      unknownSessions: aggregates.filter((item) => item.metrics.cost.usd === null).length
    },
    warnings: records.reduce((sum, record) => sum + record.warnings.length, 0)
  };
  return {
    generatedAt: new Date().toISOString(),
    workspace,
    policy: { ...policy, path: telemetryPolicyPath(workspace) },
    summary,
    sessions,
    evaluations: await runReplayEvaluations(workspace, records)
  };
}

export async function runReplayEvaluations(
  workspace = workspaceRoot(),
  suppliedRecords?: TelemetryRecord[]
): Promise<ReplayEvaluationReport> {
  const records = suppliedRecords ?? await loadTelemetryRecords(workspace);
  const runs = records.filter((record): record is RunTelemetryRecord => record.kind === "run");
  const traces = await loadReplayTraces(workspace);
  const byTurn = new Map(traces.map((trace) => [trace.turnId, trace]));
  const paired = runs.filter((run) => byTurn.has(run.turnId));
  let helped = 0;
  let didNotHelp = 0;
  let inconclusive = 0;
  for (const run of paired.filter((item) => item.retrieval.decision === "injected")) {
    const outcome = memoryOutcome(run, byTurn.get(run.turnId)?.events ?? []);
    if (outcome === "helped") helped += 1;
    else if (outcome === "did_not_help") didNotHelp += 1;
    else inconclusive += 1;
  }
  const weakCases = paired.filter((run) => run.retrieval.weakMatchAbstention);
  const weakAbstained = weakCases.filter((run) => run.retrieval.decision === "abstained").length;
  const staleCases = paired.filter((run) => run.retrieval.capsuleWasStale || run.retrieval.staleCapsuleRejected);
  const staleRejected = staleCases.filter((run) => run.retrieval.decision === "abstained").length;
  const redactionViolations = records.filter((record) => !telemetryRecordIsRedacted(record)).length;
  const evaluatedPrecision = helped + didNotHelp;
  return {
    generatedAt: new Date().toISOString(),
    traceCount: traces.length,
    pairedRunCount: paired.length,
    retrievalPrecision: {
      value: evaluatedPrecision ? helped / evaluatedPrecision : null,
      relevant: helped,
      evaluated: evaluatedPrecision,
      injected: helped + didNotHelp + inconclusive,
      method: "Observed proxy: an injected trace is relevant when it ends successfully without failed or retried tools; ambiguous recoveries are excluded."
    },
    weakMatchAbstention: {
      value: weakCases.length ? weakAbstained / weakCases.length : null,
      abstained: weakAbstained,
      weakMatchCases: weakCases.length
    },
    staleCapsuleRejection: {
      value: staleCases.length ? staleRejected / staleCases.length : null,
      rejected: staleRejected,
      staleCases: staleCases.length
    },
    telemetryRedaction: {
      passed: redactionViolations === 0,
      recordsScanned: records.length,
      violations: redactionViolations
    },
    injectedMemoryOutcome: {
      helped,
      didNotHelp,
      inconclusive,
      method: "Deterministic trace proxy, not a causal claim: clean successful reuse counts as helped, failed runs as not helped, and recovered failures as inconclusive."
    }
  };
}

export function sanitizedMetricsAggregate(report: MetricsReport): Record<string, unknown> {
  return {
    generatedAt: report.generatedAt,
    summary: report.summary,
    evaluations: report.evaluations,
    policy: {
      warnings: report.policy.warnings,
      reviewer: report.policy.reviewer
    }
  };
}

function toolTelemetryFromEvents(events: ArcEvent[], sessionId: string): ToolCallTelemetry[] {
  const starts: { event: ArcEvent; index: number; fingerprint: string }[] = [];
  const completed = new Set<number>();
  const attempts = new Map<string, number>();
  const tools: ToolCallTelemetry[] = [];
  for (const event of events) {
    if (event.type === "tool_start") {
      starts.push({ event, index: starts.length, fingerprint: toolFingerprint(event, sessionId) });
      continue;
    }
    if (event.type !== "tool_end") continue;
    const start = starts.find((candidate) => !completed.has(candidate.index) && event.toolUseId && candidate.event.toolUseId === event.toolUseId)
      ?? starts.find((candidate) => !completed.has(candidate.index) && candidate.event.command === event.command)
      ?? starts.find((candidate) => !completed.has(candidate.index));
    const fingerprint = start?.fingerprint ?? toolFingerprint(event, sessionId);
    if (start) completed.add(start.index);
    const attempt = (attempts.get(fingerprint) ?? 0) + 1;
    attempts.set(fingerprint, attempt);
    const startedAt = start?.event.timestamp ?? event.timestamp;
    tools.push({
      callId: sha256(`${sessionId}\0${event.toolUseId ?? start?.event.toolUseId ?? tools.length}`).slice(0, 20),
      operationFingerprint: fingerprint,
      name: sanitizeToolName(event.toolName === "tool" ? start?.event.toolName : event.toolName ?? start?.event.toolName),
      startedAt,
      durationMs: durationBetween(startedAt, event.timestamp),
      status: toolStatus(event),
      attempt,
      retry: attempt > 1
    });
  }
  for (const start of starts.filter((candidate) => !completed.has(candidate.index))) {
    const attempt = (attempts.get(start.fingerprint) ?? 0) + 1;
    attempts.set(start.fingerprint, attempt);
    tools.push({
      callId: sha256(`${sessionId}\0${start.event.toolUseId ?? start.index}`).slice(0, 20),
      operationFingerprint: start.fingerprint,
      name: sanitizeToolName(start.event.toolName),
      startedAt: start.event.timestamp,
      durationMs: null,
      status: "unknown",
      attempt,
      retry: attempt > 1
    });
  }
  return tools;
}

function toolFingerprint(event: ArcEvent, sessionId: string): string {
  const shape = redactSensitiveText(`${event.toolName ?? "tool"}\0${event.command ?? ""}`)
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 1000);
  return sha256(`${sessionId}\0${shape}`).slice(0, 20);
}

function toolStatus(event: ArcEvent): ToolCallTelemetry["status"] {
  if (event.toolStatus === "success" || event.toolStatus === "failed") return event.toolStatus;
  if (typeof event.exitCode === "number") return event.exitCode === 0 ? "success" : "failed";
  return "unknown";
}

function reviewerRecord(input: {
  sessionId: string;
  source: string;
  durationMs: number;
  status: ReviewerCallTelemetryRecord["status"];
  input: string;
  output: string;
  estimatedCostUsd: number | null;
  reason?: string;
  warnings: PolicyWarning[];
}): ReviewerCallTelemetryRecord {
  return {
    schemaVersion: 1,
    kind: "reviewer_call",
    recordedAt: new Date().toISOString(),
    runner: "arc-reviewer",
    sessionId: sanitizeLabel(input.sessionId, 200),
    callId: randomUUID(),
    source: sanitizeLabel(input.source, 80),
    durationMs: Math.max(0, input.durationMs),
    status: input.status,
    tokens: input.status === "blocked" ? unknownTokens("turn") : estimatedTokens(input.input, input.output),
    cost: input.estimatedCostUsd === null
      ? unknownCost("turn")
      : { amount: input.estimatedCostUsd, currency: "USD", source: "estimate", scope: "turn" },
    reason: input.reason ? sanitizeLabel(input.reason, 500) : undefined,
    warnings: input.warnings
  };
}

function runWarnings(
  current: RunTelemetryRecord,
  before: SessionAggregate | null,
  after: SessionAggregate | null,
  policy: TelemetryPolicy
): PolicyWarning[] {
  if (!after) return [];
  const warnings: PolicyWarning[] = [];
  const slowLimit = policy.warnings.slowToolMs;
  if (slowLimit !== null) {
    const slow = current.toolCalls.filter((tool) => tool.durationMs !== null && tool.durationMs > slowLimit);
    if (slow.length) {
      const worst = Math.max(...slow.map((tool) => tool.durationMs ?? 0));
      warnings.push({
        code: "slow_tool",
        message: `${slow.length} tool call${slow.length === 1 ? "" : "s"} exceeded the ${slowLimit}ms warning budget (worst ${worst}ms).`,
        observed: worst,
        limit: slowLimit
      });
    }
  }
  const failureLimit = policy.warnings.repeatedFailures;
  if (failureLimit !== null) {
    const previous = maxRepeatedFailures(before?.runs ?? []);
    const observed = maxRepeatedFailures(after.runs);
    if (observed >= failureLimit && previous < failureLimit) {
      warnings.push({
        code: "repeated_failures",
        message: `A tool operation failed ${observed} times in this session (warning budget ${failureLimit}).`,
        observed,
        limit: failureLimit
      });
    }
  }
  const retryLimit = policy.warnings.retriesPerSession;
  if (retryLimit !== null) {
    const previous = before?.metrics.retries ?? 0;
    const observed = after.metrics.retries;
    if (observed >= retryLimit && previous < retryLimit) {
      warnings.push({
        code: "excessive_retries",
        message: `Session retries reached ${observed} (warning budget ${retryLimit}).`,
        observed,
        limit: retryLimit
      });
    }
  }
  const costLimit = policy.warnings.costUsdPerSession;
  if (costLimit !== null) {
    const previous = before?.metrics.cost.usd;
    const observed = after.metrics.cost.usd;
    if (observed !== null && observed >= costLimit && (previous === null || previous === undefined || previous < costLimit)) {
      warnings.push({
        code: "cost",
        message: `Session cost reached ${formatUsd(observed)} (warning budget ${formatUsd(costLimit)}).`,
        observed,
        limit: costLimit
      });
    }
  }
  return warnings;
}

function reviewerWarnings(
  current: ReviewerCallTelemetryRecord,
  existing: TelemetryRecord[],
  policy: TelemetryPolicy
): PolicyWarning[] {
  const costLimit = policy.warnings.costUsdPerSession;
  if (costLimit === null) return [];
  const before = aggregateOneSession(current.sessionId, existing)?.metrics.cost.usd;
  const after = aggregateOneSession(current.sessionId, [...existing, current])?.metrics.cost.usd;
  if (after === null || after === undefined || after < costLimit || (before !== null && before !== undefined && before >= costLimit)) return [];
  return [{
    code: "cost",
    message: `Session cost reached ${formatUsd(after)} (warning budget ${formatUsd(costLimit)}).`,
    observed: after,
    limit: costLimit
  }];
}

function aggregateSessions(records: TelemetryRecord[]): SessionAggregate[] {
  const ids = [...new Set(records.map((record) => record.sessionId))];
  return ids.map((id) => aggregateOneSession(id, records)).filter((item): item is SessionAggregate => !!item);
}

function aggregateOneSession(sessionId: string, records: TelemetryRecord[]): SessionAggregate | null {
  const runs = records.filter((record): record is RunTelemetryRecord => record.kind === "run" && record.sessionId === sessionId);
  const reviewerCalls = records.filter((record): record is ReviewerCallTelemetryRecord => record.kind === "reviewer_call" && record.sessionId === sessionId);
  if (!runs.length && !reviewerCalls.length) return null;
  const nonBlockedReviewerCalls = reviewerCalls.filter((call) => call.status !== "blocked");
  const startTimes = runs.map((run) => Date.parse(run.startedAt)).filter(Number.isFinite);
  const endTimes = runs.map((run) => Date.parse(run.endedAt)).filter(Number.isFinite);
  const recordedTimes = reviewerCalls.map((call) => Date.parse(call.recordedAt)).filter(Number.isFinite);
  const startedMs = startTimes.length ? Math.min(...startTimes) : Math.min(...recordedTimes);
  const endedMs = endTimes.length ? Math.max(...endTimes) : Math.max(...recordedTimes);
  const tools = runs.flatMap((run) => run.toolCalls);
  const failedTools = tools.filter((tool) => tool.status === "failed").length;
  const mainTokens = aggregateRunTokens(runs);
  const reviewerTokens = nonBlockedReviewerCalls.reduce((sum, call) => sum + (call.tokens.totalTokens ?? 0), 0);
  const tokenSources = new Set<MeasurementSource>();
  if (mainTokens.hasProvider) tokenSources.add("provider");
  if (mainTokens.hasEstimate) tokenSources.add("estimate");
  if (reviewerTokens > 0) tokenSources.add("estimate");
  const tokenTotal = mainTokens.total === null && reviewerTokens === 0 ? null : (mainTokens.total ?? 0) + reviewerTokens;
  const mainCost = aggregateRunCost(runs);
  const reviewerCost = nonBlockedReviewerCalls.reduce((sum, call) => sum + usdAmount(call.cost), 0);
  const costSources = new Set<MeasurementSource>();
  if (mainCost.hasProvider) costSources.add("provider");
  if (mainCost.hasEstimate) costSources.add("estimate");
  if (reviewerCost > 0) costSources.add("estimate");
  const costUsd = mainCost.usd === null && reviewerCost === 0 ? null : roundMoney((mainCost.usd ?? 0) + reviewerCost);
  const lastStatus = runs.at(-1)?.status ?? (nonBlockedReviewerCalls.some((call) => call.status === "failed") ? "failed" : "unknown");
  const warnings = [...runs, ...reviewerCalls].reduce((sum, record) => sum + record.warnings.length, 0);
  return {
    metrics: {
      sessionId,
      startedAt: new Date(startedMs).toISOString(),
      endedAt: new Date(endedMs).toISOString(),
      durationMs: Math.max(0, endedMs - startedMs),
      status: lastStatus,
      turns: runs.length,
      toolCalls: tools.length,
      failedTools,
      failedToolRate: tools.length ? failedTools / tools.length : 0,
      retries: runs.reduce((sum, run) => sum + run.retryCount, 0),
      modelFirstResponseMs: latestNonNull(runs.map((run) => run.modelLatency.firstResponseMs)),
      tokens: { total: tokenTotal, source: combinedSource(tokenSources) },
      cost: { usd: costUsd, source: combinedSource(costSources) },
      reviewerCalls: nonBlockedReviewerCalls.length,
      warningCount: warnings
    },
    runs,
    reviewerCalls,
    providerTokens: mainTokens.provider,
    estimatedTokens: mainTokens.estimated + reviewerTokens,
    providerCostUsd: mainCost.providerUsd,
    estimatedCostUsd: roundMoney(mainCost.estimatedUsd + reviewerCost)
  };
}

function aggregateRunTokens(runs: RunTelemetryRecord[]): {
  total: number | null;
  provider: number;
  estimated: number;
  hasProvider: boolean;
  hasEstimate: boolean;
} {
  const providerSession = runs.filter((run) => run.tokens.source === "provider" && run.tokens.scope === "session" && run.tokens.totalTokens !== null);
  const providerTurn = runs.filter((run) => run.tokens.source === "provider" && run.tokens.scope === "turn" && run.tokens.totalTokens !== null);
  if (providerSession.length) {
    const total = Math.max(...providerSession.map((run) => run.tokens.totalTokens ?? 0));
    return { total, provider: total, estimated: 0, hasProvider: true, hasEstimate: false };
  }
  if (providerTurn.length) {
    const provider = providerTurn.reduce((sum, run) => sum + (run.tokens.totalTokens ?? 0), 0);
    const estimated = runs
      .filter((run) => run.tokens.source === "estimate" && run.tokens.totalTokens !== null)
      .reduce((sum, run) => sum + (run.tokens.totalTokens ?? 0), 0);
    return {
      total: provider + estimated,
      provider,
      estimated,
      hasProvider: true,
      hasEstimate: estimated > 0
    };
  }
  const estimates = runs.filter((run) => run.tokens.source === "estimate" && run.tokens.totalTokens !== null);
  if (estimates.length) {
    const total = estimates.reduce((sum, run) => sum + (run.tokens.totalTokens ?? 0), 0);
    return { total, provider: 0, estimated: total, hasProvider: false, hasEstimate: true };
  }
  return { total: null, provider: 0, estimated: 0, hasProvider: false, hasEstimate: false };
}

function aggregateRunCost(runs: RunTelemetryRecord[]): {
  usd: number | null;
  providerUsd: number;
  estimatedUsd: number;
  hasProvider: boolean;
  hasEstimate: boolean;
} {
  const usd = runs.filter((run) => run.cost.currency === "USD" && run.cost.amount !== null);
  const providerSession = usd.filter((run) => run.cost.source === "provider" && run.cost.scope === "session");
  const providerTurn = usd.filter((run) => run.cost.source === "provider" && run.cost.scope === "turn");
  const estimates = usd.filter((run) => run.cost.source === "estimate");
  const hasProvider = providerSession.length > 0 || providerTurn.length > 0;
  const hasEstimate = estimates.length > 0;
  let providerUsd = 0;
  if (providerSession.length) providerUsd = Math.max(...providerSession.map((run) => run.cost.amount ?? 0));
  else providerUsd = providerTurn.reduce((sum, run) => sum + (run.cost.amount ?? 0), 0);
  const estimatedUsd = estimates.reduce((sum, run) => sum + (run.cost.amount ?? 0), 0);
  if (!hasProvider && !hasEstimate) {
    return { usd: null, providerUsd: 0, estimatedUsd: 0, hasProvider: false, hasEstimate: false };
  }
  return {
    usd: roundMoney(providerUsd + estimatedUsd),
    providerUsd: roundMoney(providerUsd),
    estimatedUsd: roundMoney(estimatedUsd),
    hasProvider,
    hasEstimate
  };
}

function rebaseToolAttempts(record: RunTelemetryRecord, existing: TelemetryRecord[]): void {
  const prior = new Map<string, number>();
  for (const run of existing.filter((item): item is RunTelemetryRecord => item.kind === "run" && item.sessionId === record.sessionId)) {
    for (const tool of run.toolCalls) {
      prior.set(tool.operationFingerprint, Math.max(prior.get(tool.operationFingerprint) ?? 0, tool.attempt));
    }
  }
  for (const tool of record.toolCalls) {
    const offset = prior.get(tool.operationFingerprint) ?? 0;
    tool.attempt += offset;
    tool.retry = tool.attempt > 1;
  }
  record.retryCount = record.toolCalls.filter((tool) => tool.retry).length;
}

async function loadReplayTraces(workspace: string): Promise<ReplayTrace[]> {
  const root = join(cacheDir(workspace), "traces");
  if (!existsSync(root)) return [];
  const traces: ReplayTrace[] = [];
  for (const name of await readdir(root)) {
    if (!name.endsWith(".jsonl")) continue;
    const events = await readJsonl<ArcEvent>(join(root, name));
    if (!events.length) continue;
    traces.push({
      turnId: events[0]?.sessionId ?? basename(name, ".jsonl").replace(/^arc-/, ""),
      events
    });
  }
  return traces;
}

function memoryOutcome(run: RunTelemetryRecord, events: ArcEvent[]): "helped" | "did_not_help" | "inconclusive" {
  let ended: ArcEvent | undefined;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    if (events[index].type === "session_end") {
      ended = events[index];
      break;
    }
  }
  const success = run.status === "success" || /\bend_turn\b/i.test(ended?.text ?? "");
  const failed = run.status === "failed" || run.status === "cancelled";
  if (failed) return "did_not_help";
  if (success && run.failedToolCount === 0 && run.retryCount === 0) return "helped";
  return "inconclusive";
}

function telemetryRecordIsRedacted(record: TelemetryRecord): boolean {
  const text = JSON.stringify(record);
  if (redactSensitiveText(text) !== text) return false;
  const forbiddenKeys = new Set(["command", "prompt", "output", "path", "workspace", "raw", "text"]);
  const stack: unknown[] = [record];
  while (stack.length) {
    const value = stack.pop();
    if (!value || typeof value !== "object") continue;
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (forbiddenKeys.has(key)) return false;
      stack.push(child);
    }
  }
  return true;
}

function runStatus(stopReason: string): RunTelemetryRecord["status"] {
  if (stopReason === "end_turn") return "success";
  if (/cancel/i.test(stopReason)) return "cancelled";
  if (/error|fail|empty_turn/i.test(stopReason)) return "failed";
  return "unknown";
}

function estimatedTokens(input: string, output: string): TokenMeasurement {
  const divisorValue = Number(process.env.ARC_ACP_CHARS_PER_TOKEN);
  const divisor = Number.isFinite(divisorValue) && divisorValue > 0 ? divisorValue : 4;
  const inputTokens = input ? Math.ceil(input.length / divisor) : 0;
  const outputTokens = output ? Math.ceil(output.length / divisor) : 0;
  return {
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    source: "estimate",
    scope: "turn"
  };
}

function unknownTokens(scope: MeasurementScope): TokenMeasurement {
  return { inputTokens: null, outputTokens: null, totalTokens: null, source: "unknown", scope };
}

function unknownCost(scope: MeasurementScope): CostMeasurement {
  return { amount: null, currency: "USD", source: "unknown", scope };
}

function percentiles(values: (number | null)[]): Percentiles {
  const sorted = values.filter((value): value is number => value !== null && Number.isFinite(value) && value >= 0)
    .sort((left, right) => left - right);
  return {
    count: sorted.length,
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    p99: percentile(sorted, 0.99)
  };
}

function percentile(sorted: number[], fraction: number): number | null {
  if (!sorted.length) return null;
  const index = (sorted.length - 1) * fraction;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return Math.round(sorted[lower]);
  return Math.round(sorted[lower] + (sorted[upper] - sorted[lower]) * (index - lower));
}

function maxRepeatedFailures(runs: RunTelemetryRecord[]): number {
  const failures = new Map<string, number>();
  for (const tool of runs.flatMap((run) => run.toolCalls).filter((tool) => tool.status === "failed")) {
    failures.set(tool.operationFingerprint, (failures.get(tool.operationFingerprint) ?? 0) + 1);
  }
  return Math.max(0, ...failures.values());
}

function configuredNumber(fileValue: unknown, envName: string, fallback: number | null): number | null {
  const raw = process.env[envName] ?? fileValue;
  if (raw === null || raw === undefined || raw === "") return fallback;
  if (raw === false || raw === "off" || raw === "disabled") return null;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function configuredInteger(fileValue: unknown, envName: string, fallback: number | null): number | null {
  const value = configuredNumber(fileValue, envName, fallback);
  return value === null ? null : Math.floor(value);
}

function firstNumber(record: Record<string, unknown>, keys: string[]): number | null {
  for (const key of keys) {
    const value = nonNegativeNumber(record[key]);
    if (value !== null) return value;
  }
  return null;
}

function nonNegativeNumber(value: unknown): number | null {
  const number = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN;
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function durationBetween(start: string, end: string): number | null {
  const startMs = Date.parse(start);
  const endMs = Date.parse(end);
  return Number.isFinite(startMs) && Number.isFinite(endMs) ? Math.max(0, endMs - startMs) : null;
}

function weakMatchReason(reason: string): boolean {
  return reason === "weak_match_abstention" || reason === "no_match" || reason === "retrieval_unavailable";
}

function staleRejectionReason(reason: string): boolean {
  return reason === "stale_capsule_rejected";
}

function retrievalReasonLabel(plan: InjectionPlan | null): string {
  if (!plan) return "retrieval_unavailable";
  const reason = plan.reason.toLowerCase();
  if (/stale capsule rejected/.test(reason)) return "stale_capsule_rejected";
  if (/distance gate abstained|below .*threshold/.test(reason)) return "weak_match_abstention";
  if (/small-talk/.test(reason)) return "small_talk";
  if (/do-not-reuse/.test(reason)) return "do_not_reuse_guard";
  if (/sidecar.*declin|consult sidecar declined/.test(reason)) return "sidecar_declined";
  if (/no matching capsule|no retrievable capsules/.test(reason)) return "no_match";
  if (/embeddings unavailable/.test(reason)) return "retrieval_unavailable";
  if (plan.shouldInject) return "matched";
  return "abstained";
}

function sanitizeToolName(value: string | undefined): string {
  const name = sanitizeLabel(value ?? "tool", 120);
  if (!name || /[/\\]/.test(name)) return "tool";
  return name.replace(/[^A-Za-z0-9_.:-]+/g, "_").slice(0, 80) || "tool";
}

function sanitizeLabel(value: string, limit: number): string {
  return redactSensitiveText(value).replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim().slice(0, limit);
}

function sanitizeCurrency(value: string): string {
  const currency = value.trim().toUpperCase().replace(/[^A-Z]/g, "").slice(0, 8);
  return currency || "USD";
}

function usdAmount(cost: CostMeasurement): number {
  return cost.currency === "USD" && cost.amount !== null ? cost.amount : 0;
}

function combinedSource(sources: Set<MeasurementSource>): MeasurementSource | "mixed" {
  if (!sources.size) return "unknown";
  if (sources.size === 1) return [...sources][0];
  return "mixed";
}

function latestNonNull(values: (number | null)[]): number | null {
  for (let index = values.length - 1; index >= 0; index -= 1) {
    if (values[index] !== null) return values[index];
  }
  return null;
}

function roundMoney(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function formatUsd(value: number): string {
  return `$${value.toFixed(value < 0.01 ? 4 : 2)}`;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isTelemetryRecord(value: unknown): value is TelemetryRecord {
  if (!isRecord(value) || value.schemaVersion !== 1 || typeof value.sessionId !== "string") return false;
  return value.kind === "run" || value.kind === "reviewer_call";
}
