import type { ChatSession, SessionInfo } from "@/types";

function normalize(value: string | null | undefined): string {
  return (value ?? "").trim();
}

function prettifyClaudeModel(model: string): string {
  const lower = model.toLowerCase();
  if (lower === "default") return "Claude";
  if (lower === "opus") return "Claude Opus";
  if (lower === "sonnet") return "Claude Sonnet";
  if (lower === "haiku") return "Claude Haiku";
  return model;
}

export function getSessionNotificationActor(
  session: Pick<ChatSession, "engine" | "model"> | null | undefined,
  sessionInfo?: Pick<SessionInfo, "model" | "agentName"> | null,
): string {
  const model = normalize(sessionInfo?.model) || normalize(session?.model);
  const engine = session?.engine ?? "claude";

  if (engine === "acp") {
    return model || normalize(sessionInfo?.agentName) || "Agent";
  }

  if (engine === "codex") {
    return model || "Codex";
  }

  if (engine === "copilot") {
    return model || "Copilot";
  }

  if (!model) {
    return "Claude";
  }

  return prettifyClaudeModel(model);
}
