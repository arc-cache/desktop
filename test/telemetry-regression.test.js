import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { writeDebugBundle } from "../dist/bundle.js";
import { telemetryPolicyPath } from "../dist/paths.js";
import { buildInjectionPlan } from "../dist/retrieval.js";
import { saveCapsule, saveTraceEvents, updateCapsuleDerivedData } from "../dist/store.js";
import {
  buildMetricsReport,
  createRunTelemetry,
  executeReviewerCall,
  loadTelemetryRecords,
  providerUsageFromAcp,
  recordRunTelemetry,
  runReplayEvaluations
} from "../dist/telemetry.js";

function withCache(fn) {
  return async () => {
    const root = await mkdtemp(join(tmpdir(), "arc-telemetry-test-"));
    const previous = new Map();
    for (const name of [
      "AGENT_RUN_CACHE_DIR",
      "AGENT_RUN_CACHE_MODEL_SIDECAR",
      "AGENT_RUN_CACHE_LOCAL_OBSERVER",
      "AGENT_RUN_CACHE_LOCAL_EMBEDDINGS",
      "AGENT_RUN_CACHE_EMBEDDING_ENDPOINT",
      "AGENT_RUN_CACHE_REVIEWER_MAX_CALLS",
      "AGENT_RUN_CACHE_REVIEWER_HARD_COST_USD",
      "AGENT_RUN_CACHE_REVIEWER_ESTIMATED_COST_USD_PER_CALL"
    ]) previous.set(name, process.env[name]);
    process.env.AGENT_RUN_CACHE_DIR = join(root, ".agent-run-cache");
    process.env.AGENT_RUN_CACHE_MODEL_SIDECAR = "off";
    process.env.AGENT_RUN_CACHE_LOCAL_OBSERVER = "off";
    process.env.AGENT_RUN_CACHE_LOCAL_EMBEDDINGS = "off";
    delete process.env.AGENT_RUN_CACHE_EMBEDDING_ENDPOINT;
    try {
      await fn(root);
    } finally {
      for (const [name, value] of previous) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
      await rm(root, { recursive: true, force: true });
    }
  };
}

function event(turnId, timestamp, type, extra = {}) {
  return {
    id: `${turnId}-${type}-${timestamp}`,
    runner: "copilot",
    sessionId: turnId,
    workspace: "/Users/private/project",
    timestamp,
    type,
    source: "test",
    ...extra
  };
}

function trace(turnId, { failed = false } = {}) {
  const events = [
    event(turnId, "2026-01-01T00:00:00.000Z", "session_start"),
    event(turnId, "2026-01-01T00:00:00.010Z", "user_prompt", { text: "private prompt" })
  ];
  if (failed) {
    events.push(
      event(turnId, "2026-01-01T00:00:00.020Z", "tool_start", { toolName: "terminal", toolUseId: "tool-1", command: "SECRET_TOKEN=private run" }),
      event(turnId, "2026-01-01T00:00:00.120Z", "tool_end", { toolName: "terminal", toolUseId: "tool-1", command: "SECRET_TOKEN=private run", toolStatus: "failed", exitCode: 1 })
    );
  }
  events.push(event(turnId, "2026-01-01T00:00:00.200Z", "session_end", { text: "ARC ACP turn end_turn." }));
  return events;
}

function runRecord({
  sessionId = "session-1",
  turnId = "turn-1",
  events = trace(turnId),
  plan = { shouldInject: true, message: "memory", reason: "matched capsule", source: "local", capsule: { id: "capsule-1" } },
  providerUsage = null
} = {}) {
  return createRunTelemetry({
    runner: "copilot",
    sessionId,
    turnId,
    startedAtMs: Date.parse("2026-01-01T00:00:00.000Z"),
    forwardedAtMs: Date.parse("2026-01-01T00:00:00.010Z"),
    firstModelActivityAtMs: Date.parse("2026-01-01T00:00:00.030Z"),
    endedAtMs: Date.parse("2026-01-01T00:00:00.200Z"),
    stopReason: "end_turn",
    events,
    providerUsage,
    estimatedInputText: "private prompt",
    estimatedOutputText: "done",
    plan
  });
}

test("ACP telemetry prefers provider usage, pairs retries, and stores no commands", () => {
  const usage = providerUsageFromAcp({
    inputTokens: 120,
    outputTokens: 30,
    cost: { amount: 0.025, currency: "usd" }
  }, "turn");
  assert.ok(usage);
  const events = [
    event("turn-provider", "2026-01-01T00:00:00.000Z", "tool_start", { toolName: "terminal", toolUseId: "one", command: "SERVICE_TOKEN=secret-value deploy /Users/alice/private" }),
    event("turn-provider", "2026-01-01T00:00:00.100Z", "tool_end", { toolName: "terminal", toolUseId: "one", command: "SERVICE_TOKEN=secret-value deploy /Users/alice/private", toolStatus: "failed" }),
    event("turn-provider", "2026-01-01T00:00:00.120Z", "tool_start", { toolName: "terminal", toolUseId: "two", command: "SERVICE_TOKEN=secret-value deploy /Users/alice/private" }),
    event("turn-provider", "2026-01-01T00:00:00.180Z", "tool_end", { toolName: "terminal", toolUseId: "two", command: "SERVICE_TOKEN=secret-value deploy /Users/alice/private", toolStatus: "success" })
  ];
  const record = runRecord({ turnId: "turn-provider", events, providerUsage: usage });

  assert.equal(record.tokens.source, "provider");
  assert.equal(record.tokens.totalTokens, 150);
  assert.equal(record.cost.source, "provider");
  assert.equal(record.cost.amount, 0.025);
  assert.equal(record.toolCalls[0].durationMs, 100);
  assert.equal(record.toolCalls[1].retry, true);
  assert.equal(record.retryCount, 1);
  assert.equal(record.failedToolCount, 1);
  const stored = JSON.stringify(record);
  assert.equal(stored.includes("secret-value"), false);
  assert.equal(stored.includes("/Users/alice/private"), false);
  assert.equal(stored.includes("SERVICE_TOKEN"), false);
  assert.equal(Object.hasOwn(record.toolCalls[0], "command"), false);
});

test("metrics aggregate policy warnings, usage provenance, cost, and replay checks", withCache(async (workspace) => {
  await writeFile(telemetryPolicyPath(workspace), JSON.stringify({
    warnings: {
      costUsdPerSession: 0.01,
      slowToolMs: 50,
      repeatedFailures: 1,
      retriesPerSession: 1
    }
  }), "utf8");
  const usage = providerUsageFromAcp({ totalTokens: 500, cost: { amount: 0.02, currency: "USD" } }, "turn");
  const failedTrace = trace("turn-failed-tool", { failed: true });
  const failedRecord = runRecord({ turnId: "turn-failed-tool", events: failedTrace, providerUsage: usage });
  const warnings = await recordRunTelemetry(failedRecord, workspace);
  assert.deepEqual(new Set(warnings.map((warning) => warning.code)), new Set(["cost", "slow_tool", "repeated_failures"]));
  await saveTraceEvents(failedTrace, "turn-failed-tool", workspace);

  const retryTrace = trace("turn-retry", { failed: true });
  const retryRecord = runRecord({ turnId: "turn-retry", events: retryTrace });
  const retryWarnings = await recordRunTelemetry(retryRecord, workspace);
  assert.equal(retryRecord.retryCount, 1);
  assert.equal(retryRecord.toolCalls[0].attempt, 2);
  assert.equal(retryWarnings.some((warning) => warning.code === "excessive_retries"), true);
  await saveTraceEvents(retryTrace, "turn-retry", workspace);

  const weakTrace = trace("turn-weak");
  const weakRecord = runRecord({
    sessionId: "session-weak",
    turnId: "turn-weak",
    events: weakTrace,
    plan: { shouldInject: false, message: "", reason: "embedding distance gate abstained below 0.58", source: "local" }
  });
  await recordRunTelemetry(weakRecord, workspace);
  await saveTraceEvents(weakTrace, "turn-weak", workspace);

  const staleTrace = trace("turn-stale");
  const staleRecord = runRecord({
    sessionId: "session-stale",
    turnId: "turn-stale",
    events: staleTrace,
    plan: { shouldInject: false, message: "", reason: "stale capsule rejected: config changed", source: "local", capsule: { id: "capsule-stale" } }
  });
  await recordRunTelemetry(staleRecord, workspace);
  await saveTraceEvents(staleTrace, "turn-stale", workspace);

  const report = await buildMetricsReport(workspace);
  assert.equal(report.summary.sessionCount, 3);
  assert.equal(report.summary.failedToolRate, 1);
  assert.equal(report.summary.tokens.provider, 500);
  assert.ok(report.summary.tokens.estimated > 0);
  assert.equal(report.summary.cost.providerUsd, 0.02);
  assert.equal(report.summary.cost.unknownSessions, 2);
  assert.equal(report.sessions.find((session) => session.sessionId === "session-1")?.cost.source, "provider");
  assert.equal(report.evaluations.weakMatchAbstention.value, 1);
  assert.equal(report.evaluations.staleCapsuleRejection.value, 1);
  assert.equal(report.evaluations.telemetryRedaction.passed, true);

  const replay = await runReplayEvaluations(workspace);
  assert.equal(replay.pairedRunCount, 4);
  assert.equal(replay.injectedMemoryOutcome.inconclusive, 2);
}));

test("reviewer calls stop at the configured hard limit and label estimated cost", withCache(async (workspace) => {
  await writeFile(telemetryPolicyPath(workspace), JSON.stringify({
    reviewer: {
      maxCallsPerSession: 1,
      hardCostUsdPerSession: 0.2,
      estimatedCostUsdPerCall: 0.05
    }
  }), "utf8");
  let calls = 0;
  const first = await executeReviewerCall({
    workspace,
    sessionId: "review-session",
    source: "copilot",
    input: "review this trace"
  }, async () => {
    calls += 1;
    return { value: { shouldSave: false }, output: "{\"shouldSave\":false}" };
  });
  const second = await executeReviewerCall({
    workspace,
    sessionId: "review-session",
    source: "copilot",
    input: "review this trace again"
  }, async () => {
    calls += 1;
    return { value: { shouldSave: false }, output: "{}" };
  });

  assert.equal(first.allowed, true);
  assert.equal(second.allowed, false);
  assert.match(second.reason, /hard call limit/);
  assert.equal(calls, 1);
  const records = await loadTelemetryRecords(workspace);
  assert.equal(records[0].cost.source, "estimate");
  assert.equal(records[0].cost.amount, 0.05);
  assert.equal(records[1].kind, "reviewer_call");
  assert.equal(records[1].status, "blocked");
}));

test("retrieval rejects a capsule whose binding source changed", withCache(async (workspace) => {
  const binding = join(workspace, "binding.txt");
  await writeFile(binding, "current value\n", "utf8");
  const capsule = await saveCapsule({
    runner: "copilot",
    workspace,
    sourceSessionId: "seed",
    reusable: true,
    confidence: 0.95,
    title: "Run binding workflow",
    summary: "Use the binding workflow for releases.",
    reuseWhen: ["binding workflow release"],
    doNotReuseWhen: [],
    evidence: ["verified"],
    provenance: [],
    nextRunInstruction: "Inspect binding.txt.",
    workflow: {
      purpose: "Run binding workflow release",
      parameters: [],
      bindingSources: ["binding.txt"],
      steps: ["Inspect binding.txt."],
      commands: [],
      successCriteria: ["Current binding used."],
      failedAttempts: [],
      validationProbe: ["test -f binding.txt"]
    }
  }, workspace);
  assert.ok(capsule);
  await updateCapsuleDerivedData(capsule.id, {
    bindingSnapshots: [{ source: "binding.txt", exists: true, hash: "old-hash", capturedAt: "2025-01-01T00:00:00.000Z" }]
  }, workspace);

  const plan = await buildInjectionPlan("run the binding workflow release", workspace, { runner: "copilot" });
  assert.equal(plan.shouldInject, false);
  assert.equal(plan.capsule?.id, capsule.id);
  assert.match(plan.reason, /stale capsule rejected/);
}));

test("debug bundles contain aggregate telemetry but no raw telemetry file", withCache(async (workspace) => {
  await recordRunTelemetry(runRecord(), workspace);
  const out = join(workspace, "bundle");
  await writeDebugBundle(out, workspace);
  const aggregate = JSON.parse(await readFile(join(out, "metrics.aggregate.redacted.json"), "utf8"));
  const manifest = JSON.parse(await readFile(join(out, "manifest.json"), "utf8"));

  assert.equal(typeof aggregate.summary.sessionCount, "number");
  assert.equal(manifest.files.includes("metrics.aggregate.redacted.json"), true);
  assert.equal(manifest.files.some((name) => String(name).includes("telemetry.jsonl")), false);
  await assert.rejects(readFile(join(out, "telemetry.redacted.jsonl"), "utf8"));
}));
