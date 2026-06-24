import { buildEvidencePacket } from "./evidence.js";
import { recordMemoryEvent } from "./ledger.js";
import { workspaceRoot } from "./paths.js";
import { refreshCapsuleDerivedData } from "./retrieval.js";
import { reviewPacket } from "./sidecar.js";
import { alreadyReviewed, debug, recordReview, saveCapsule, traceHash, withReviewLock } from "./store.js";
import type { ReviewRecord } from "./store.js";
import type { ArcEvent, ReviewIntent, SidecarReview, SidecarReviewOptions } from "./types.js";

const SIDECAR_SESSION_MARKERS = [
  "You are the Agent Run Cache sidecar",
  "You are the Agent Run Cache consulting sidecar",
  "You are the live Agent Run Cache observer sidecar"
];

export interface ReviewOutcome {
  status: "saved" | "no_capsule" | "skipped" | "failed";
  reason?: string;
  capsuleIds?: string[];
}

function outcomeFromReview(record: ReviewRecord): ReviewOutcome {
  return {
    status: record.status,
    reason: record.reason,
    capsuleIds: record.capsuleId ? record.capsuleId.split(",").filter(Boolean) : undefined
  };
}

export async function reviewEvents(
  events: ArcEvent[],
  workspace = workspaceRoot(),
  fallbackSessionId = "unknown",
  intent: ReviewIntent = "auto",
  options: SidecarReviewOptions = {}
): Promise<ReviewOutcome> {
  const sessionId = events[0]?.sessionId ?? fallbackSessionId;
  if (isArcSidecarSession(events)) {
    await debug("review.skipped", { sessionId, reason: "arc sidecar session", eventCount: events.length }, workspace);
    return { status: "skipped", reason: "arc sidecar session" };
  }
  if (!events.length || sessionId === "unknown") {
    await debug("review.skipped", { reason: "no events or session id", eventCount: events.length }, workspace);
    return { status: "skipped", reason: "no events or session id" };
  }
  const reviewed = await alreadyReviewed(sessionId, workspace);
  if (reviewed) {
    await debug("review.skipped", { sessionId, reason: "already reviewed", status: reviewed.status, eventCount: reviewed.eventCount }, workspace);
    return outcomeFromReview(reviewed);
  }
  const locked = await withReviewLock(sessionId, workspace, async () => {
    const lockedReviewed = await alreadyReviewed(sessionId, workspace);
    if (lockedReviewed) {
      await debug("review.skipped", { sessionId, reason: "already reviewed after lock", status: lockedReviewed.status }, workspace);
      return outcomeFromReview(lockedReviewed);
    }
    return reviewEventsUnlocked(events, workspace, sessionId, intent, options);
  });
  return locked ?? { status: "skipped", reason: "review locked" };
}

async function reviewEventsUnlocked(
  events: ArcEvent[],
  workspace: string,
  sessionId: string,
  intent: ReviewIntent,
  options: SidecarReviewOptions
): Promise<ReviewOutcome> {
  const packet = buildEvidencePacket(events, workspace, sessionId);
  const hash = traceHash(events);
  try {
    await debug("review.queued", { sessionId, eventCount: events.length, outcome: packet.outcome.status }, workspace);
    if (options.injectedCapsuleIds?.length) {
      await debug("review.injected_context", { sessionId, injectedCapsuleIds: options.injectedCapsuleIds }, workspace);
    }
    const review = await reviewPacket(packet, workspace, intent, options);
    const capsuleInputs = reviewCapsules(review);
    const saveableCapsules = capsuleInputs.filter((capsuleInput) => capsuleAllowedForOutcome(capsuleInput, packet.outcome.status));
    const sanitized = saveableCapsules.map((capsuleInput) => sanitizeFailedToolClaims(capsuleInput, events));
    const sanitizedCount = sanitized.filter((item) => item.removed > 0).length;
    if (sanitizedCount) {
      await debug("review.capsules_sanitized", {
        sessionId,
        sanitized: sanitizedCount,
        reason: "failed tool references removed from positive capsule fields"
      }, workspace);
    }
    const rejected = capsuleInputs.length - saveableCapsules.length;
    if (rejected) {
      await debug("review.capsules_rejected", { sessionId, rejected, outcome: packet.outcome.status }, workspace);
      await recordMemoryEvent({
        type: "capsule.rejected",
        workspace,
        sessionId,
        details: { reason: "review outcome gate", rejected, outcome: packet.outcome.status }
      });
    }
    if (saveableCapsules.length) {
      const saved: string[] = [];
      for (const { capsule: capsuleInput } of sanitized) {
        const capsule = await saveCapsule({ ...capsuleInput, sourceSessionId: sessionId, workspace, runner: packet.runner, outcomeStatus: packet.outcome.status }, workspace);
        if (capsule) {
          const enriched = await refreshCapsuleDerivedData(capsule, workspace);
          saved.push(enriched.id);
        }
      }
      if (!saved.length) {
        const reason = "review proposed no persistable capsules";
        await recordReview({ sessionId, traceHash: hash, eventCount: events.length, status: "no_capsule", reason }, workspace);
        await debug("sidecar.no_capsule", { sessionId, reason }, workspace);
        await recordMemoryEvent({
          type: "capsule.rejected",
          workspace,
          sessionId,
          details: { reason, outcome: packet.outcome.status, eventCount: events.length }
        });
        return { status: "no_capsule", reason };
      }
      await recordReview({ sessionId, traceHash: hash, eventCount: events.length, status: "saved", capsuleId: saved.join(",") }, workspace);
      await recordMemoryEvent({
        type: "capsule.finalized",
        workspace,
        sessionId,
        details: { capsuleIds: saved, eventCount: events.length, outcome: packet.outcome.status }
      });
      return { status: "saved", capsuleIds: saved };
    } else {
      const reason = review?.reason ?? "no review";
      await recordReview({ sessionId, traceHash: hash, eventCount: events.length, status: "no_capsule", reason }, workspace);
      await debug("sidecar.no_capsule", { sessionId, reason }, workspace);
      await recordMemoryEvent({
        type: "capsule.rejected",
        workspace,
        sessionId,
        details: { reason, outcome: packet.outcome.status, eventCount: events.length }
      });
      return { status: "no_capsule", reason };
    }
  } catch (error) {
    await recordReview({ sessionId, traceHash: hash, eventCount: events.length, status: "failed", reason: String(error) }, workspace);
    throw error;
  }
}

function reviewCapsules(review: SidecarReview | null): NonNullable<SidecarReview["capsules"]> {
  if (!review) return [];
  if (review.shouldSave === false) return [];
  if (Array.isArray(review.capsules) && review.capsules.length) return review.capsules;
  return review.capsule ? [review.capsule] : [];
}

function capsuleAllowedForOutcome(capsule: NonNullable<SidecarReview["capsules"]>[number], status: string): boolean {
  if (status !== "failed" && status !== "aborted") return true;
  const kind = String(capsule.kind ?? "").toLowerCase();
  if (kind.includes("fact") || kind.includes("dead_end") || kind.includes("caution")) return true;
  const failedAttempts = capsule.workflow?.failedAttempts ?? [];
  const successCriteria = capsule.workflow?.successCriteria ?? [];
  return failedAttempts.length > 0 && successCriteria.length === 0;
}

type ReviewCapsuleInput = NonNullable<SidecarReview["capsules"]>[number];

interface FailedToolReference {
  command: string;
  exitCode?: number;
  paths: string[];
  text: string;
  terms: string[];
}

interface SanitizedCapsule {
  capsule: ReviewCapsuleInput;
  removed: number;
}

function sanitizeFailedToolClaims(capsule: ReviewCapsuleInput, events: ArcEvent[]): SanitizedCapsule {
  const failed = failedToolReferences(events);
  if (!failed.length) return { capsule, removed: 0 };

  let removed = 0;
  const next: ReviewCapsuleInput = { ...capsule };

  const evidence = filterFailedReferenceList(next.evidence, failed, { keepFailureClaims: true });
  next.evidence = evidence.values;
  removed += evidence.removed;

  const validationProvenance = filterFailedReferenceList(next.validationProvenance, failed, { keepFailureClaims: true });
  next.validationProvenance = validationProvenance.values;
  removed += validationProvenance.removed;

  const provenance = filterFailedReferenceList(next.provenance, failed, { keepFailureClaims: false });
  next.provenance = provenance.values;
  removed += provenance.removed;

  const artifactSources = filterFailedReferenceList(next.artifactSources, failed, { keepFailureClaims: false });
  next.artifactSources = artifactSources.values;
  removed += artifactSources.removed;

  const workflow = next.workflow ? { ...next.workflow } : undefined;
  if (workflow) {
    const bindingSources = filterFailedReferenceList(workflow.bindingSources, failed, { keepFailureClaims: false });
    workflow.bindingSources = bindingSources.values;
    removed += bindingSources.removed;

    const commands = filterFailedReferenceList(workflow.commands, failed, { keepFailureClaims: false });
    workflow.commands = commands.values;
    removed += commands.removed;

    const validationProbe = filterFailedReferenceList(workflow.validationProbe, failed, { keepFailureClaims: false });
    workflow.validationProbe = validationProbe.values;
    removed += validationProbe.removed;

    const successCriteria = filterFailedReferenceList(workflow.successCriteria, failed, { keepFailureClaims: true });
    workflow.successCriteria = successCriteria.values;
    removed += successCriteria.removed;

    const steps = filterFailedReferenceList(workflow.steps, failed, { keepFailureClaims: true });
    workflow.steps = steps.values;
    removed += steps.removed;

    next.workflow = workflow;
  }

  if (removed > 0) {
    const boundaries = failed.map(formatFailedToolBoundary).slice(0, 6);
    next.failureBoundary = appendUniqueStrings(next.failureBoundary, boundaries);
    if (next.workflow) {
      next.workflow.failedAttempts = appendUniqueStrings(next.workflow.failedAttempts, failed.map(formatFailedToolAttempt).slice(0, 6));
    }
  }

  return { capsule: next, removed };
}

function filterFailedReferenceList(
  values: unknown,
  failed: FailedToolReference[],
  options: { keepFailureClaims: boolean }
): { values: string[]; removed: number } {
  if (!Array.isArray(values)) return { values: [], removed: 0 };
  const kept: string[] = [];
  let removed = 0;
  for (const value of values) {
    const text = String(value ?? "").trim();
    if (!text) continue;
    if (containsFailedReference(text, failed) && !(options.keepFailureClaims && describesFailure(text))) {
      removed += 1;
      continue;
    }
    kept.push(text);
  }
  return { values: kept, removed };
}

function failedToolReferences(events: ArcEvent[]): FailedToolReference[] {
  return events
    .filter((event) => event.type === "tool_end" && isFailedToolEvent(event))
    .map((event) => {
      const paths = failedEventPaths(event);
      const command = event.command?.trim() ?? "";
      const terms = uniqueStrings([
        ...paths,
        command
      ].map(normalizeClaimText).filter((term) => term.length >= 3));
      return {
        command,
        exitCode: event.exitCode,
        paths,
        text: event.text?.trim() ?? "",
        terms
      };
    })
    .filter((failed) => failed.terms.length > 0);
}

function isFailedToolEvent(event: ArcEvent): boolean {
  return event.toolStatus === "failed" || (typeof event.exitCode === "number" && event.exitCode !== 0);
}

function failedEventPaths(event: ArcEvent): string[] {
  const values: string[] = [];
  if (event.path) values.push(event.path);
  collectPathStrings(event.raw, values);
  values.push(...pathTokens(event.command ?? ""));
  values.push(...pathTokens(event.text ?? ""));
  return uniqueStrings(values.flatMap((value) => pathVariants(value, event.workspace)));
}

function collectPathStrings(value: unknown, out: string[]): void {
  if (typeof value === "string") {
    if (looksLikePathToken(value)) out.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectPathStrings(item, out);
    return;
  }
  if (value && typeof value === "object") {
    for (const item of Object.values(value as Record<string, unknown>)) collectPathStrings(item, out);
  }
}

function pathTokens(text: string): string[] {
  return text
    .split(/\s+/)
    .map((token) => token.replace(/^[`"'([{]+/, "").replace(/[`"',:;)\]}]+$/, ""))
    .filter(looksLikePathToken);
}

function looksLikePathToken(value: string): boolean {
  const text = value.trim();
  if (!text.includes("/") || text.length > 260) return false;
  if (/\s/.test(text)) return false;
  if (text.startsWith("-")) return false;
  return text.split("/").filter(Boolean).length >= 2;
}

function pathVariants(value: string, workspace: string): string[] {
  const clean = value.trim().replace(/^[`"'([{]+/, "").replace(/[`"',:;)\]}]+$/, "");
  if (!clean || clean === "." || clean === workspace) return [];
  const root = workspace.endsWith("/") ? workspace.slice(0, -1) : workspace;
  const variants = [clean];
  if (root && root !== "/" && clean.startsWith(`${root}/`)) {
    variants.push(clean.slice(root.length + 1));
  }
  return variants.filter((item) => item !== "." && item !== root && item.includes("/"));
}

function containsFailedReference(text: string, failed: FailedToolReference[]): boolean {
  const normalized = normalizeClaimText(text);
  return failed.some((item) => item.terms.some((term) => normalized.includes(term)));
}

function describesFailure(text: string): boolean {
  return /\b(fail(?:ed|ure)?|missing|not found|no such|does not exist|not present|absent|unavailable|could not|couldn't|cannot|error|exit code|nonexistent)\b/i.test(text);
}

function normalizeClaimText(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

function formatFailedToolBoundary(failed: FailedToolReference): string {
  const parts = [
    failed.command ? `Failed tool command: ${failed.command}` : "Failed tool command",
    typeof failed.exitCode === "number" ? `exit code ${failed.exitCode}` : "",
    failed.paths.length ? `paths: ${failed.paths.slice(0, 3).join(", ")}` : "",
    failed.text ? `output: ${failed.text.slice(0, 240)}` : ""
  ].filter(Boolean);
  return parts.join("; ");
}

function formatFailedToolAttempt(failed: FailedToolReference): string {
  const target = failed.paths[0] ?? failed.command;
  return target
    ? `Do not cite ${target} as successful evidence; the observed tool call failed.`
    : "Do not cite the failed tool call as successful evidence.";
}

function appendUniqueStrings(values: unknown, additions: string[]): string[] {
  const next = Array.isArray(values) ? values.map((value) => String(value ?? "").trim()).filter(Boolean) : [];
  for (const addition of additions) {
    const text = addition.trim();
    if (text && !next.includes(text)) next.push(text);
  }
  return next.slice(0, 24);
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

export function isArcSidecarSession(events: ArcEvent[]): boolean {
  const firstPrompt = events.find((event) => event.type === "user_prompt" && !!event.text?.trim());
  if (firstPrompt) return startsWithSidecarInstruction(firstPrompt.text);
  const firstInstruction = events.find((event) =>
    (event.type === "session_start" || event.type === "unknown") && !!event.text?.trim()
  );
  return startsWithSidecarInstruction(firstInstruction?.text);
}

function startsWithSidecarInstruction(text: string | undefined): boolean {
  const normalized = text?.trimStart() ?? "";
  return SIDECAR_SESSION_MARKERS.some((marker) => normalized.startsWith(marker));
}
