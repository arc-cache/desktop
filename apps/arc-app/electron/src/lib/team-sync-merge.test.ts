import { describe, expect, it } from "vitest";
import { mergePulledCapsules } from "./team-sync-merge";

describe("team capsule pull merge", () => {
  it("adds new remote capsules", () => {
    const result = mergePulledCapsules(
      [{ id: "local", updatedAt: "2026-01-01T00:00:00.000Z" }],
      [{ id: "remote", updatedAt: "2026-01-02T00:00:00.000Z", title: "Remote" }],
    );

    expect(result.pulled).toBe(1);
    expect(result.skipped).toBe(0);
    expect(result.capsules.map((capsule) => capsule.id).sort()).toEqual(["local", "remote"]);
  });

  it("replaces local capsules when the remote copy is newer", () => {
    const result = mergePulledCapsules(
      [{ id: "cap", updatedAt: "2026-01-01T00:00:00.000Z", title: "Old" }],
      [{ id: "cap", updatedAt: "2026-01-02T00:00:00.000Z", title: "New" }],
    );

    expect(result.pulled).toBe(1);
    expect(result.skipped).toBe(0);
    expect(result.capsules).toEqual([{ id: "cap", updatedAt: "2026-01-02T00:00:00.000Z", title: "New" }]);
  });

  it("uses decrypted merge keys locally without needing server-visible merge metadata", () => {
    const result = mergePulledCapsules(
      [{ id: "local-id", kind: "workflow", mergeKey: "same-method", updatedAt: "2026-01-01T00:00:00.000Z", title: "Old" }],
      [{ id: "remote-id", kind: "workflow", mergeKey: "same-method", updatedAt: "2026-01-02T00:00:00.000Z", title: "New" }],
    );

    expect(result.pulled).toBe(1);
    expect(result.skipped).toBe(0);
    expect(result.capsules).toEqual([
      { id: "remote-id", kind: "workflow", mergeKey: "same-method", updatedAt: "2026-01-02T00:00:00.000Z", title: "New" },
    ]);
  });

  it("skips remote capsules when the local copy is newer or equal", () => {
    const result = mergePulledCapsules(
      [{ id: "cap", updatedAt: "2026-01-02T00:00:00.000Z", title: "Local" }],
      [{ id: "cap", updatedAt: "2026-01-01T00:00:00.000Z", title: "Remote" }],
    );

    expect(result.pulled).toBe(0);
    expect(result.skipped).toBe(1);
    expect(result.capsules).toEqual([{ id: "cap", updatedAt: "2026-01-02T00:00:00.000Z", title: "Local" }]);
  });

  it("skips malformed remote capsules", () => {
    const result = mergePulledCapsules([], [{ title: "Missing id" }]);

    expect(result.pulled).toBe(0);
    expect(result.skipped).toBe(1);
    expect(result.capsules).toEqual([]);
  });
});
