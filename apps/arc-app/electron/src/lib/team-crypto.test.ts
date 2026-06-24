import { describe, expect, it } from "vitest";
import {
  decryptWithWorkspaceKey,
  encryptWithWorkspaceKey,
  generateMemberKeyPair,
  generateWorkspaceKey,
  unwrapWorkspaceKey,
  wrapWorkspaceKeyForMember,
  type CapsuleEnvelope,
} from "./team-crypto";

describe("team crypto", () => {
  it("wraps and unwraps a workspace key for a member", async () => {
    const member = await generateMemberKeyPair();
    const workspaceKey = await generateWorkspaceKey();

    const wrapped = await wrapWorkspaceKeyForMember(workspaceKey.rawKeyBase64, member.publicKeyJwk);
    const unwrapped = await unwrapWorkspaceKey(wrapped, member.privateKeyJwk);

    expect(unwrapped).toBe(workspaceKey.rawKeyBase64);
  });

  it("encrypts and decrypts a capsule envelope", async () => {
    const workspaceKey = await generateWorkspaceKey();
    const plaintext = JSON.stringify({
      capsule: {
        id: "cap_123",
        title: "Use the verified route",
        summary: "Only store the successful method.",
      },
    });

    const envelope = await encryptWithWorkspaceKey(plaintext, workspaceKey);
    const decrypted = await decryptWithWorkspaceKey(envelope, workspaceKey);

    expect(envelope.algorithm).toBe("aes-256-gcm");
    expect(envelope.keyringVersion).toBe(workspaceKey.keyringVersion);
    expect(Buffer.from(envelope.iv, "base64")).toHaveLength(12);
    expect(decrypted).toBe(plaintext);
  });

  it("does not expose capsule plaintext in the envelope JSON", async () => {
    const workspaceKey = await generateWorkspaceKey();
    const plaintext = JSON.stringify({
      capsule: {
        title: "Sensitive repo migration route",
        summary: "Run the private billing migration first.",
      },
    });

    const envelope = await encryptWithWorkspaceKey(plaintext, workspaceKey);
    const envelopeJson = JSON.stringify(envelope);

    expect(envelopeJson).not.toContain("Sensitive repo migration route");
    expect(envelopeJson).not.toContain("private billing migration");
  });

  it("uses a fresh IV for repeated encryption", async () => {
    const workspaceKey = await generateWorkspaceKey();
    const first = await encryptWithWorkspaceKey("same plaintext", workspaceKey);
    const second = await encryptWithWorkspaceKey("same plaintext", workspaceKey);

    expect(first.iv).not.toBe(second.iv);
    expect(first.ciphertext).not.toBe(second.ciphertext);
  });

  it("rejects tampered ciphertext", async () => {
    const workspaceKey = await generateWorkspaceKey();
    const envelope = await encryptWithWorkspaceKey("plaintext", workspaceKey);

    await expect(decryptWithWorkspaceKey(tamperCiphertext(envelope), workspaceKey)).rejects.toThrow();
  });

  it("rejects the wrong workspace key", async () => {
    const workspaceKey = await generateWorkspaceKey();
    const wrongWorkspaceKey = await generateWorkspaceKey();
    const envelope = await encryptWithWorkspaceKey("plaintext", workspaceKey);

    await expect(decryptWithWorkspaceKey(envelope, wrongWorkspaceKey)).rejects.toThrow();
  });
});

function tamperCiphertext(envelope: CapsuleEnvelope): CapsuleEnvelope {
  const bytes = Buffer.from(envelope.ciphertext, "base64");
  bytes[0] = (bytes[0] ?? 0) ^ 1;
  return {
    ...envelope,
    ciphertext: bytes.toString("base64"),
  };
}
