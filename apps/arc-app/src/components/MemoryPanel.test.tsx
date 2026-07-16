import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { MetricsView } from "./MemoryPanel";

vi.mock("@/components/ui/scroll-area", () => ({
  ScrollArea: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

describe("ARC desktop metrics view", () => {
  it("renders latency, reliability, usage, cost, sessions, and replay results", () => {
    const html = renderToStaticMarkup(<MetricsView metrics={{
      summary: {
        sessionCount: 1,
        turnCount: 2,
        latencyMs: {
          session: { count: 1, p50: 4200, p95: 4200, p99: 4200 },
          modelFirstResponse: { count: 2, p50: 650, p95: 900, p99: 900 },
          tool: { count: 3, p50: 120, p95: 800, p99: 800 },
          reviewer: { count: 1, p50: 500, p95: 500, p99: 500 },
        },
        toolCalls: 3,
        failedTools: 1,
        failedToolRate: 1 / 3,
        retries: 1,
        tokens: { total: 1200, provider: 0, estimated: 1200, unknownSessions: 0 },
        cost: { knownUsd: 0, providerUsd: 0, estimatedUsd: 0, unknownSessions: 1 },
        warnings: 1,
      },
      sessions: [{
        sessionId: "copilot-session-123",
        endedAt: new Date().toISOString(),
        durationMs: 4200,
        status: "success",
        turns: 2,
        toolCalls: 3,
        failedTools: 1,
        failedToolRate: 1 / 3,
        retries: 1,
        modelFirstResponseMs: 650,
        tokens: { total: 1200, source: "estimate" },
        cost: { usd: null, source: "unknown" },
        warningCount: 1,
      }],
      evaluations: {
        retrievalPrecision: { value: 1, relevant: 1, evaluated: 1 },
        weakMatchAbstention: { value: 1, abstained: 1, weakMatchCases: 1 },
        staleCapsuleRejection: { value: 1, rejected: 1, staleCases: 1 },
        telemetryRedaction: { passed: true, recordsScanned: 2, violations: 0 },
        injectedMemoryOutcome: { helped: 1, didNotHelp: 0, inconclusive: 0 },
      },
    }} />);

    expect(html).toContain("Model response");
    expect(html).toContain("Tool latency");
    expect(html).toContain("Failed tools");
    expect(html).toContain("Token usage");
    expect(html).toContain("Known cost");
    expect(html).toContain("copilot-ses");
    expect(html).toContain("estimate");
    expect(html).toContain("unknown");
    expect(html).toContain("Recorded-trace replay");
    expect(html).toContain("Telemetry redaction");
  });
});
