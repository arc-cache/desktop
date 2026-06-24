import { describe, expect, it } from "vitest";
import type { ACPPermissionEvent } from "@/types";
import {
  optionIdForAcpPermissionBehavior,
  permissionRequestFromAcp,
  pickAutoResponseOption,
} from "./acp-adapter";

function permissionEvent(options: ACPPermissionEvent["options"]): ACPPermissionEvent {
  return {
    _sessionId: "renderer-session",
    requestId: "request-1",
    sessionId: "agent-session",
    toolCall: {
      toolCallId: "tool-1",
      title: "Run command",
      kind: "execute",
      rawInput: { command: "npm test" },
    },
    options,
  };
}

describe("ACP permission option mapping", () => {
  it("preserves provider-native permission options on app requests", () => {
    const request = permissionRequestFromAcp(permissionEvent([
      { optionId: "allow-once", name: "Allow this time", kind: "allow_once" },
      { optionId: "allow-always", name: "Always allow", kind: "allow_always" },
      { optionId: "reject-once", name: "Deny", kind: "reject_once" },
    ]));

    expect(request.providerOptions).toEqual([
      { id: "allow-once", label: "Allow this time", kind: "allow_once" },
      { id: "allow-always", label: "Always allow", kind: "allow_always" },
      { id: "reject-once", label: "Deny", kind: "reject_once" },
    ]);
  });

  it("does not fake allow-all when the agent only exposes allow-once", () => {
    const options = [
      { optionId: "allow-once", kind: "allow_once" },
      { optionId: "reject-once", kind: "reject_once" },
    ];

    expect(pickAutoResponseOption(options, "auto_accept")).toBe("allow-once");
    expect(pickAutoResponseOption(options, "allow_all")).toBeNull();
  });

  it("submits only exact provider option ids that exist on the current request", () => {
    const options = permissionEvent([
      { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
      { optionId: "allow-always", name: "Always allow", kind: "allow_always" },
      { optionId: "reject-once", name: "Deny", kind: "reject_once" },
    ]).options;

    expect(optionIdForAcpPermissionBehavior(options, "allow", "allow-always")).toBe("allow-always");
    expect(optionIdForAcpPermissionBehavior(options, "allow", "missing")).toBeNull();
    expect(optionIdForAcpPermissionBehavior(options, "allow")).toBe("allow-once");
    expect(optionIdForAcpPermissionBehavior(options, "allowForSession")).toBe("allow-always");
    expect(optionIdForAcpPermissionBehavior(options, "deny")).toBe("reject-once");
  });
});
