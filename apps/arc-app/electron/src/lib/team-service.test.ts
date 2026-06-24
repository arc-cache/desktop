import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: {
    isPackaged: false,
    getPath: () => "/tmp/arc-test",
  },
  safeStorage: {
    decryptString: () => "{}",
    encryptString: (value: string) => Buffer.from(value),
  },
  shell: {
    openExternal: vi.fn(),
  },
}));

import { isAllowedTeamCallbackOrigin, isTeamDeepLinkUrl } from "./team-service";

describe("team callback origin policy", () => {
  it("allows loopback HTTP callback origins", () => {
    expect(isAllowedTeamCallbackOrigin("http://127.0.0.1:42843")).toBe(true);
    expect(isAllowedTeamCallbackOrigin("http://localhost:42843")).toBe(true);
    expect(isAllowedTeamCallbackOrigin("http://[::1]:42843")).toBe(true);
  });

  it("rejects non-loopback or non-HTTP callback origins", () => {
    expect(isAllowedTeamCallbackOrigin("https://127.0.0.1:42843")).toBe(false);
    expect(isAllowedTeamCallbackOrigin("http://0.0.0.0:42843")).toBe(false);
    expect(isAllowedTeamCallbackOrigin("http://192.168.1.12:42843")).toBe(false);
    expect(isAllowedTeamCallbackOrigin("https://example.com/auth/callback")).toBe(false);
  });

  it("recognizes ARC team deep links", () => {
    expect(isTeamDeepLinkUrl("agent-run-cache://auth/callback?code=abc")).toBe(true);
    expect(isTeamDeepLinkUrl("agent-run-cache://team/invite?invite=abc")).toBe(true);
    expect(isTeamDeepLinkUrl("http://localhost:42843/auth/callback?code=abc")).toBe(false);
  });
});
