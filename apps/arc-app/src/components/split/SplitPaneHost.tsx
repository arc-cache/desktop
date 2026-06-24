import type { ChatSession, EngineId } from "@/types";
import type { SessionPaneState } from "@/hooks/session/useSessionPane";
import type { SessionPaneBootstrap } from "@/hooks/session/types";
import { useExtraPaneLoader } from "@/hooks/session/useExtraPaneLoader";
import { useSessionPane } from "@/hooks/session/useSessionPane";

interface SplitPaneHostRenderData {
  session: ChatSession | null;
  paneState: SessionPaneState;
}

interface SplitPaneHostProps {
  sessionId: string;
  acpPermissionBehavior: "ask" | "auto_accept" | "allow_all";
  loadBootstrap: (sessionId: string) => Promise<SessionPaneBootstrap | null>;
  children: (data: SplitPaneHostRenderData) => React.ReactNode;
}

export function SplitPaneHost({
  sessionId,
  acpPermissionBehavior,
  loadBootstrap,
  children,
}: SplitPaneHostProps) {
  const loader = useExtraPaneLoader({
    sessionId,
    loadBootstrap,
  });

  const readySession = loader.readyId ? loader.session : null;
  const activeEngine: EngineId = readySession?.engine ?? "claude";
  const paneState = useSessionPane({
    activeSessionId: loader.readyId,
    activeEngine,
    claudeSessionId: activeEngine === "claude" ? loader.readyId : null,
    acpSessionId: activeEngine === "acp" ? loader.readyId : null,
    codexSessionId: activeEngine === "codex" ? loader.readyId : null,
    copilotSessionId: activeEngine === "copilot" ? loader.readyId : null,
    copilotSessionModel: activeEngine === "copilot" ? readySession?.model : undefined,
    codexSessionModel: activeEngine === "codex" ? readySession?.model : undefined,
    codexPlanModeEnabled: activeEngine === "codex" ? !!readySession?.planMode : false,
    initialMessages: loader.initialMessages,
    initialMeta: loader.initialMeta,
    initialPermission: loader.initialPermission,
    initialConfigOptions: loader.initialConfigOptions,
    initialSlashCommands: loader.initialSlashCommands,
    initialRawAcpPermission: loader.initialRawAcpPermission,
    acpPermissionBehavior,
  });

  return <>{children({ session: readySession, paneState })}</>;
}
