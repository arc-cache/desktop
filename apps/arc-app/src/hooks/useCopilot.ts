import type { BackgroundSessionSnapshot, PermissionRequest, UIMessage } from "@/types";
import { useCodex } from "./useCodex";

interface UseCopilotOptions {
  sessionId: string | null;
  sessionModel?: string;
  initialMessages?: UIMessage[];
  initialMeta?: BackgroundSessionSnapshot | null;
  initialPermission?: PermissionRequest | null;
}

export function useCopilot(options: UseCopilotOptions) {
  return useCodex({
    ...options,
    planModeEnabled: false,
    engine: "copilot",
  });
}
