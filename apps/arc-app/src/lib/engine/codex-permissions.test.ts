import { describe, expect, it } from "vitest";
import type { CodexServerRequest } from "@/types";
import { SUPPORTED_SERVER_REQUESTS } from "../../../shared/lib/codex-helpers";
import { permissionRequestFromCodexServerRequest } from "./codex-permissions";

describe("Codex permission request mapping", () => {
  it("supports ARC Copilot generic permission approvals", () => {
    expect(SUPPORTED_SERVER_REQUESTS.has("item/permissions/requestApproval")).toBe(true);
  });

  it("maps generic command approvals to the Bash prompt", () => {
    const request = permissionRequestFromCodexServerRequest({
      _sessionId: "session-1",
      rpcId: 42,
      method: "item/permissions/requestApproval",
      threadId: "thread-1",
      accessMode: "on-request",
      kind: "execute",
      toolCallId: "tool-1",
      toolName: "bash",
      fullCommandText: "rg targets.json .",
    } satisfies CodexServerRequest, "copilot_request_user_input");

    expect(request).toMatchObject({
      requestId: "42",
      toolName: "Bash",
      toolUseId: "tool-1",
      codexRpcId: 42,
      toolInput: {
        command: "rg targets.json .",
        toolName: "bash",
        accessMode: "on-request",
      },
    });
  });
});
