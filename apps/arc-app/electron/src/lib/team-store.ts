import { safeStorage } from "electron";
import fs from "fs";
import path from "path";
import type { webcrypto } from "crypto";
import { getDataDir } from "./data-dir";

type JsonWebKey = webcrypto.JsonWebKey;

export interface StoredTeamSession {
  access_token: string;
  refresh_token: string;
  expires_at?: number;
  token_type?: string;
}

export interface StoredMemberKeyPair {
  publicKeyJwk: JsonWebKey;
  privateKeyJwk: JsonWebKey;
}

export interface StoredWorkspaceKey {
  keyringVersion: number;
  rawKeyBase64: string;
}

export type StoredWorkspaceKeyring = Record<string, StoredWorkspaceKey>;

export interface StoredSharedCapsuleRef {
  remoteCapsuleId: string;
  revision: number;
  updatedAt: string;
  ciphertextHash: string;
  plaintextHash?: string;
}

interface TeamStorePayload {
  authStorage: Record<string, string>;
  session: StoredTeamSession | null;
  memberKeyPair: StoredMemberKeyPair | null;
  workspaceKeys: Record<string, StoredWorkspaceKeyring>;
  sharedCapsules: Record<string, Record<string, StoredSharedCapsuleRef>>;
  autoShareProjects: Record<string, boolean>;
  activeWorkspaceId: string | null;
}

const EMPTY_PAYLOAD: TeamStorePayload = {
  authStorage: {},
  session: null,
  memberKeyPair: null,
  workspaceKeys: {},
  sharedCapsules: {},
  autoShareProjects: {},
  activeWorkspaceId: null,
};

let cached: TeamStorePayload | null = null;

function storePath(): string {
  return path.join(getDataDir(), "team-state.v1.enc");
}

function clonePayload(payload: TeamStorePayload): TeamStorePayload {
  return {
    authStorage: { ...payload.authStorage },
    session: payload.session ? { ...payload.session } : null,
    memberKeyPair: payload.memberKeyPair
      ? {
          publicKeyJwk: { ...payload.memberKeyPair.publicKeyJwk },
          privateKeyJwk: { ...payload.memberKeyPair.privateKeyJwk },
        }
      : null,
    workspaceKeys: Object.fromEntries(
      Object.entries(payload.workspaceKeys).map(([workspaceId, key]) => [
        workspaceId,
        cloneKeyring(key),
      ]),
    ),
    sharedCapsules: Object.fromEntries(
      Object.entries(payload.sharedCapsules).map(([workspaceId, capsules]) => [
        workspaceId,
        Object.fromEntries(
          Object.entries(capsules).map(([localCapsuleId, ref]) => [
            localCapsuleId,
            { ...ref },
          ]),
        ),
      ]),
    ),
    autoShareProjects: { ...payload.autoShareProjects },
    activeWorkspaceId: payload.activeWorkspaceId,
  };
}

function loadPayload(): TeamStorePayload {
  if (cached) return cached;
  try {
    const encrypted = fs.readFileSync(storePath());
    const raw = safeStorage.decryptString(encrypted);
    const parsed = JSON.parse(raw) as Partial<TeamStorePayload>;
    cached = {
      ...EMPTY_PAYLOAD,
      ...parsed,
      authStorage: parsed.authStorage ?? {},
      workspaceKeys: normalizeWorkspaceKeys(parsed.workspaceKeys),
      sharedCapsules: parsed.sharedCapsules ?? {},
      autoShareProjects: parsed.autoShareProjects ?? {},
      session: parsed.session ?? null,
      memberKeyPair: parsed.memberKeyPair ?? null,
      activeWorkspaceId: parsed.activeWorkspaceId ?? null,
    };
  } catch {
    cached = clonePayload(EMPTY_PAYLOAD);
  }
  return cached;
}

function savePayload(payload: TeamStorePayload): void {
  cached = clonePayload(payload);
  fs.mkdirSync(path.dirname(storePath()), { recursive: true });
  const encrypted = safeStorage.encryptString(JSON.stringify(cached));
  fs.writeFileSync(storePath(), encrypted);
}

export function getTeamState(): TeamStorePayload {
  return clonePayload(loadPayload());
}

export function setTeamState(patch: Partial<TeamStorePayload>): TeamStorePayload {
  const next = {
    ...loadPayload(),
    ...patch,
    authStorage: patch.authStorage ?? loadPayload().authStorage,
    workspaceKeys: normalizeWorkspaceKeys(patch.workspaceKeys ?? loadPayload().workspaceKeys),
    sharedCapsules: patch.sharedCapsules ?? loadPayload().sharedCapsules,
    autoShareProjects: patch.autoShareProjects ?? loadPayload().autoShareProjects,
  };
  savePayload(next);
  return clonePayload(next);
}

export function clearTeamState(): void {
  savePayload(clonePayload(EMPTY_PAYLOAD));
}

export const teamAuthStorage = {
  getItem(key: string): string | null {
    return loadPayload().authStorage[key] ?? null;
  },
  setItem(key: string, value: string): void {
    const current = loadPayload();
    savePayload({
      ...current,
      authStorage: {
        ...current.authStorage,
        [key]: value,
      },
    });
  },
  removeItem(key: string): void {
    const current = loadPayload();
    const nextStorage = { ...current.authStorage };
    delete nextStorage[key];
    savePayload({
      ...current,
      authStorage: nextStorage,
    });
  },
};

function cloneKeyring(keyring: StoredWorkspaceKeyring): StoredWorkspaceKeyring {
  return Object.fromEntries(
    Object.entries(keyring).map(([version, key]) => [version, { ...key }]),
  );
}

function normalizeWorkspaceKeys(value: unknown): Record<string, StoredWorkspaceKeyring> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const output: Record<string, StoredWorkspaceKeyring> = {};
  for (const [workspaceId, raw] of Object.entries(value as Record<string, unknown>)) {
    const keyring = normalizeWorkspaceKeyring(raw);
    if (Object.keys(keyring).length) output[workspaceId] = keyring;
  }
  return output;
}

function normalizeWorkspaceKeyring(value: unknown): StoredWorkspaceKeyring {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const record = value as Record<string, unknown>;
  if (typeof record.rawKeyBase64 === "string" && typeof record.keyringVersion === "number") {
    const key = record as unknown as StoredWorkspaceKey;
    return { [String(key.keyringVersion)]: { ...key } };
  }

  const keyring: StoredWorkspaceKeyring = {};
  for (const [version, rawKey] of Object.entries(record)) {
    if (!rawKey || typeof rawKey !== "object" || Array.isArray(rawKey)) continue;
    const key = rawKey as Partial<StoredWorkspaceKey>;
    if (typeof key.rawKeyBase64 !== "string" || typeof key.keyringVersion !== "number") continue;
    keyring[version] = {
      keyringVersion: key.keyringVersion,
      rawKeyBase64: key.rawKeyBase64,
    };
  }
  return keyring;
}
