import { webcrypto as nodeWebCrypto, type webcrypto } from "crypto";
import type { StoredMemberKeyPair, StoredWorkspaceKey } from "./team-store";

export type JsonWebKey = webcrypto.JsonWebKey;
type KeyUsage = webcrypto.KeyUsage;
type CryptoKey = webcrypto.CryptoKey;

export interface CapsuleEnvelope {
  version: 1;
  algorithm: "aes-256-gcm";
  keyringVersion: number;
  iv: string;
  ciphertext: string;
}

const cryptoProvider: webcrypto.Crypto = globalThis.crypto ?? nodeWebCrypto;

export async function generateMemberKeyPair(): Promise<StoredMemberKeyPair> {
  const pair = await cryptoProvider.subtle.generateKey(
    {
      name: "RSA-OAEP",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["encrypt", "decrypt"],
  );

  return {
    publicKeyJwk: await cryptoProvider.subtle.exportKey("jwk", pair.publicKey),
    privateKeyJwk: await cryptoProvider.subtle.exportKey("jwk", pair.privateKey),
  };
}

export async function generateWorkspaceKey(keyringVersion = 1): Promise<StoredWorkspaceKey> {
  const key = await cryptoProvider.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]);
  const raw = new Uint8Array(await cryptoProvider.subtle.exportKey("raw", key));
  return {
    keyringVersion,
    rawKeyBase64: base64Encode(raw),
  };
}

export async function wrapWorkspaceKeyForMember(rawKeyBase64: string, publicKeyJwk: JsonWebKey): Promise<string> {
  const publicKey = await cryptoProvider.subtle.importKey(
    "jwk",
    publicKeyJwk,
    { name: "RSA-OAEP", hash: "SHA-256" },
    false,
    ["encrypt"],
  );
  const wrapped = await cryptoProvider.subtle.encrypt(
    { name: "RSA-OAEP" },
    publicKey,
    base64Decode(rawKeyBase64),
  );
  return base64Encode(new Uint8Array(wrapped));
}

export async function unwrapWorkspaceKey(wrappedBase64: string, privateKeyJwk: JsonWebKey): Promise<string> {
  const privateKey = await cryptoProvider.subtle.importKey(
    "jwk",
    privateKeyJwk,
    { name: "RSA-OAEP", hash: "SHA-256" },
    false,
    ["decrypt"],
  );
  const raw = await cryptoProvider.subtle.decrypt(
    { name: "RSA-OAEP" },
    privateKey,
    base64Decode(wrappedBase64),
  );
  return base64Encode(new Uint8Array(raw));
}

export async function encryptWithWorkspaceKey(plaintext: string, workspaceKey: StoredWorkspaceKey): Promise<CapsuleEnvelope> {
  const key = await importAesKey(workspaceKey.rawKeyBase64, ["encrypt"]);
  const iv = cryptoProvider.getRandomValues(new Uint8Array(12));
  const ciphertext = await cryptoProvider.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    new TextEncoder().encode(plaintext),
  );
  return {
    version: 1,
    algorithm: "aes-256-gcm",
    keyringVersion: workspaceKey.keyringVersion,
    iv: base64Encode(iv),
    ciphertext: base64Encode(new Uint8Array(ciphertext)),
  };
}

export async function decryptWithWorkspaceKey(envelope: CapsuleEnvelope, workspaceKey: StoredWorkspaceKey): Promise<string> {
  if (envelope.algorithm !== "aes-256-gcm") throw new Error(`Unsupported capsule encryption: ${envelope.algorithm}`);
  const key = await importAesKey(workspaceKey.rawKeyBase64, ["decrypt"]);
  const plaintext = await cryptoProvider.subtle.decrypt(
    { name: "AES-GCM", iv: base64Decode(envelope.iv) },
    key,
    base64Decode(envelope.ciphertext),
  );
  return new TextDecoder().decode(plaintext);
}

async function importAesKey(rawKeyBase64: string, usages: KeyUsage[]): Promise<CryptoKey> {
  return cryptoProvider.subtle.importKey("raw", base64Decode(rawKeyBase64), { name: "AES-GCM" }, false, usages);
}

function base64Encode(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

function base64Decode(value: string): ArrayBuffer {
  const buffer = Buffer.from(value, "base64");
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer;
}
