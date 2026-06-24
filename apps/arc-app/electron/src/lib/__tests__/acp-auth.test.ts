import { describe, expect, it } from "vitest";
import {
  buildAuthRequiredError,
  extractAuthRequired,
  getAuthGuidance,
  normalizeAcpAuthMethods,
} from "../acp-auth";

describe("acp auth helpers", () => {
  it("normalizes advertised auth methods", () => {
    const methods = normalizeAcpAuthMethods([
      { id: "cursor_login", name: "Cursor Login" },
      {
        id: "api_key",
        name: "API Key",
        type: "env_var",
        vars: [{ name: "CURSOR_API_KEY", secret: true }],
      },
      {
        id: "terminal_login",
        name: "Terminal Login",
        type: "terminal",
        args: ["login"],
      },
    ]);

    expect(methods).toEqual([
      { id: "cursor_login", name: "Cursor Login", description: null },
      {
        id: "api_key",
        name: "API Key",
        description: null,
        type: "env_var",
        vars: [{ name: "CURSOR_API_KEY", label: null, optional: false, secret: true }],
        link: null,
      },
      {
        id: "terminal_login",
        name: "Terminal Login",
        description: null,
        type: "terminal",
        args: ["login"],
        env: {},
      },
    ]);
  });

  it("extracts auth-required errors and preserves fallback methods", () => {
    const fallback = [{ id: "cursor_login", name: "Cursor Login", description: null }];

    expect(extractAuthRequired({
      code: -32000,
      message: "Authentication required",
      data: {
        authMethods: [{ id: "oauth", name: "OAuth" }],
      },
    })).toEqual([{ id: "oauth", name: "OAuth", description: null }]);

    expect(extractAuthRequired({
      code: -32000,
      message: "Authentication required",
    }, fallback)).toEqual(fallback);

    expect(extractAuthRequired(new Error("boom"))).toBeNull();
  });

  it("adds cursor-specific guidance when relevant", () => {
    const methods = [{ id: "cursor_login", name: "Cursor Login", description: null }];
    expect(getAuthGuidance("Cursor", methods)).toContain("cursor-agent login");
    expect(buildAuthRequiredError("Cursor", methods)).toContain("Authentication required.");
    expect(getAuthGuidance("Other Agent", [])).toBeNull();
  });
});
