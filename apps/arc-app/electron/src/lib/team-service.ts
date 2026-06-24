import { createClient, type Session, type SupabaseClient, type User } from "@supabase/supabase-js";
import { randomUUID } from "crypto";
import { shell } from "electron";
import fs from "fs";
import http from "http";
import path from "path";
import { reportError } from "./error-utils";
import { log } from "./logger";
import {
  decryptWithWorkspaceKey,
  encryptWithWorkspaceKey,
  generateMemberKeyPair,
  generateWorkspaceKey,
  unwrapWorkspaceKey,
  wrapWorkspaceKeyForMember,
  type CapsuleEnvelope,
  type JsonWebKey,
} from "./team-crypto";
import { mergePulledCapsules } from "./team-sync-merge";
import {
  clearTeamState,
  getTeamState,
  setTeamState,
  teamAuthStorage,
  type StoredMemberKeyPair,
  type StoredSharedCapsuleRef,
  type StoredWorkspaceKey,
} from "./team-store";
import type {
  ArcLocalCapsuleSummary,
  ArcTeamCapsuleMeta,
  ArcTeamCallbackEvent,
  ArcTeamCallbackUrls,
  ArcTeamConfig,
  ArcTeamDeleteResult,
  ArcTeamEmailSignInResult,
  ArcTeamInviteResult,
  ArcTeamJoinableInvite,
  ArcTeamMember,
  ArcTeamPendingInvite,
  ArcTeamPullResult,
  ArcTeamRole,
  ArcTeamSecretScanFinding,
  ArcTeamShareResult,
  ArcTeamStatus,
  ArcTeamSyncResult,
  ArcTeamWorkspace,
} from "@shared/types/team";

type JsonRecord = Record<string, unknown>;

interface WorkspaceMemberRow {
  workspace_id: string;
  user_id: string;
  role: ArcTeamRole;
  joined_at: string;
  removed_at: string | null;
}

interface WorkspaceRow {
  id: string;
  name: string;
}

interface InviteRow {
  id: string;
  email: string | null;
  role: Exclude<ArcTeamRole, "owner">;
  expires_at: string;
  created_at: string;
  accepted_by?: string | null;
  accepted_at: string | null;
  revoked_at: string | null;
}

interface MemberKeyRow {
  workspace_id: string;
  user_id: string;
  member_public_key: string | null;
  wrapped_workspace_key: string | null;
  keyring_version: number;
}

interface CapsuleMetaRow {
  workspace_id: string;
  capsule_id: string;
  blob_path: string;
  ciphertext_hash: string;
  encrypted_size_bytes: number;
  updated_at: string;
  updated_by: string;
  revision: number;
  tombstone: boolean;
}

let cachedClient: SupabaseClient | null = null;
let cachedClientKey = "";
let sessionApplied = false;
let pendingEmailSignIn: { cancel: () => void } | null = null;
let callbackServer: http.Server | null = null;
let callbackServerOrigin = "";
let pendingCallbackEvent: ArcTeamCallbackEvent | null = null;

const LOOPBACK_CALLBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

interface AuthCallbackWaiter {
  resolve: (code: string) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

const authCallbackWaiters = new Map<string, AuthCallbackWaiter>();
const TEAM_DEEP_LINK_PROTOCOL = "agent-run-cache:";
const TEAM_AUTH_REDIRECT_URL = "agent-run-cache://auth/callback";
export const FREE_TEAM_SEAT_LIMIT = 5;
export const FREE_TEAM_SHARED_CAPSULE_LIMIT = 5;

export function getTeamConfig(): ArcTeamConfig | null {
  const config = getTeamSettingsConfig();
  if (!config.supabaseUrl || !config.supabasePublishableKey) return null;
  return config;
}

export function getTeamCallbackUrls(): ArcTeamCallbackUrls {
  const origin = callbackOrigin(requireConfig().authRedirectOrigin);
  return {
    origin,
    authRedirectUrl: TEAM_AUTH_REDIRECT_URL,
    inviteUrlBase: new URL("/team/invite", origin).toString(),
    billingReturnUrl: new URL("/team/billing", origin).toString(),
  };
}

export function consumeTeamCallbackEvent(): ArcTeamCallbackEvent | null {
  const event = pendingCallbackEvent;
  pendingCallbackEvent = null;
  return event;
}

export function isTeamDeepLinkUrl(value: string): boolean {
  try {
    return new URL(value).protocol === TEAM_DEEP_LINK_PROTOCOL;
  } catch {
    return false;
  }
}

export function handleTeamDeepLink(value: string): boolean {
  if (!isTeamDeepLinkUrl(value)) return false;
  handleTeamCallbackUrl(new URL(value));
  return true;
}

function getTeamSettingsConfig(): ArcTeamConfig {
  const supabaseUrl = (process.env.ARC_TEAM_SUPABASE_URL || "").trim();
  const supabasePublishableKey = (process.env.ARC_TEAM_SUPABASE_PUBLISHABLE_KEY || "").trim();
  const authRedirectOrigin = (process.env.ARC_TEAM_AUTH_REDIRECT_ORIGIN || "http://localhost:42843").trim();
  return { supabaseUrl, supabasePublishableKey, authRedirectOrigin };
}

function requireConfig(): ArcTeamConfig {
  const config = getTeamConfig();
  if (!config) throw new Error("ARC Teams is not configured");
  return config;
}

function getClient(): SupabaseClient {
  const config = requireConfig();
  const key = `${config.supabaseUrl}\n${config.supabasePublishableKey}`;
  if (cachedClient && cachedClientKey === key) return cachedClient;
  cachedClient = createClient(config.supabaseUrl, config.supabasePublishableKey, {
    auth: {
      flowType: "pkce",
      autoRefreshToken: true,
      persistSession: true,
      detectSessionInUrl: false,
      storage: teamAuthStorage,
    },
  });
  cachedClientKey = key;
  sessionApplied = false;
  return cachedClient;
}

async function getClientWithSession(): Promise<SupabaseClient> {
  const client = getClient();
  const state = getTeamState();
  if (!sessionApplied && state.session) {
    const { data, error } = await client.auth.setSession({
      access_token: state.session.access_token,
      refresh_token: state.session.refresh_token,
    });
    if (!error) saveSession(data.session);
    sessionApplied = true;
  }
  return client;
}

function saveSession(session: Session | null): void {
  const current = getTeamState();
  setTeamState({
    ...current,
    session: session
      ? {
          access_token: session.access_token,
          refresh_token: session.refresh_token,
          expires_at: session.expires_at,
          token_type: session.token_type,
        }
      : null,
  });
}

async function requireUser(client: SupabaseClient): Promise<User> {
  const { data: sessionData, error: sessionError } = await client.auth.getSession();
  if (sessionError) throw sessionError;
  saveSession(sessionData.session);
  const { data, error } = await client.auth.getUser();
  if (error || !data.user) throw new Error("Not signed in");
  return data.user;
}

export async function signInWithGitHub(): Promise<ArcTeamStatus> {
  const client = getClient();
  const redirectTo = getTeamCallbackUrls().authRedirectUrl;
  const callback = await waitForOAuthCallback(redirectTo);
  const { data, error } = await client.auth.signInWithOAuth({
    provider: "github",
    options: {
      redirectTo,
      skipBrowserRedirect: true,
      scopes: "read:user user:email",
    },
  });

  if (error) {
    callback.cancel();
    throw error;
  }
  if (!data.url) {
    callback.cancel();
    throw new Error("Supabase did not return an OAuth URL");
  }

  await shell.openExternal(data.url);
  const code = await callback.code;
  const exchanged = await client.auth.exchangeCodeForSession(code);
  if (exchanged.error) throw exchanged.error;
  saveSession(exchanged.data.session);
  await ensureMemberKeyPair();
  return getStatus();
}

export async function sendEmailSignIn(email: string): Promise<ArcTeamEmailSignInResult> {
  const client = getClient();
  const normalizedEmail = normalizeEmail(email);
  const redirectTo = getTeamCallbackUrls().authRedirectUrl;
  await startPendingEmailCallback(client, redirectTo);

  const { error } = await client.auth.signInWithOtp({
    email: normalizedEmail,
    options: {
      emailRedirectTo: redirectTo,
      shouldCreateUser: true,
    },
  });
  if (error) {
    pendingEmailSignIn?.cancel();
    pendingEmailSignIn = null;
    throw error;
  }

  return { ok: true, email: normalizedEmail, redirectTo };
}

export async function verifyEmailOtp(email: string, token: string): Promise<ArcTeamStatus> {
  const client = getClient();
  const normalizedEmail = normalizeEmail(email);
  const normalizedToken = token.trim().replace(/\s+/g, "");
  if (!normalizedToken) throw new Error("Email code is required");

  const { data, error } = await client.auth.verifyOtp({
    email: normalizedEmail,
    token: normalizedToken,
    type: "email",
  });
  if (error) throw error;
  saveSession(data.session);
  await ensureMemberKeyPair();
  return getStatus();
}

export async function signOutTeam(): Promise<ArcTeamStatus> {
  pendingEmailSignIn?.cancel();
  pendingEmailSignIn = null;
  const client = getClient();
  await client.auth.signOut().catch(() => undefined);
  const current = getTeamState();
  setTeamState({ ...current, session: null, authStorage: {}, activeWorkspaceId: null });
  sessionApplied = false;
  return getStatus();
}

export async function getStatus(): Promise<ArcTeamStatus> {
  const config = getTeamConfig();
  if (!config) {
    return {
      configured: false,
      signedIn: false,
      user: null,
      workspaces: [],
      activeWorkspaceId: getTeamState().activeWorkspaceId,
    };
  }

  try {
    void ensureTeamCallbackServer().catch((error) => {
      log("TEAM_CALLBACK_SERVER", { error: error instanceof Error ? error.message : String(error) });
    });
    const client = await getClientWithSession();
    const { data: sessionData } = await client.auth.getSession();
    saveSession(sessionData.session);
    if (!sessionData.session) {
      return { configured: true, signedIn: false, user: null, workspaces: [], activeWorkspaceId: null };
    }

    const user = await requireUser(client);
    let workspaces: ArcTeamWorkspace[] = [];
    let activeWorkspaceId: string | null = null;
    let workspaceError: string | undefined;
    try {
      workspaces = await listWorkspaces(client, user.id);
      activeWorkspaceId = chooseActiveWorkspace(workspaces);
    } catch (error) {
      workspaceError = reportError("TEAM_WORKSPACE_STATUS", error);
      activeWorkspaceId = getTeamState().activeWorkspaceId;
    }
    return {
      configured: true,
      signedIn: true,
      user: { id: user.id, email: user.email ?? null },
      workspaces,
      activeWorkspaceId,
      error: workspaceError,
    };
  } catch (error) {
    return {
      configured: true,
      signedIn: false,
      user: null,
      workspaces: [],
      activeWorkspaceId: getTeamState().activeWorkspaceId,
      error: reportError("TEAM_STATUS", error),
    };
  }
}

export async function createWorkspace(name: string): Promise<ArcTeamStatus> {
  const client = await getClientWithSession();
  const user = await requireUser(client);
  const workspaceName = name.trim();
  if (!workspaceName) throw new Error("Workspace name is required");

  const { data: workspaceId, error } = await client.rpc("arc_create_workspace", {
    workspace_name: workspaceName,
  });
  if (error) throw error;
  if (typeof workspaceId !== "string") throw new Error("Workspace creation did not return an id");

  const keyPair = await ensureMemberKeyPair();
  const workspaceKey = await generateWorkspaceKey();
  const wrapped = await wrapWorkspaceKeyForMember(workspaceKey.rawKeyBase64, keyPair.publicKeyJwk);

  const { error: keyError } = await client.from("member_keys").upsert(
    {
      workspace_id: workspaceId,
      user_id: user.id,
      keyring_version: workspaceKey.keyringVersion,
      member_public_key: JSON.stringify(keyPair.publicKeyJwk),
      wrapped_workspace_key: wrapped,
      wrap_algorithm: "rsa-oaep-sha256",
      wrapped_by: user.id,
      wrapped_at: new Date().toISOString(),
    },
    { onConflict: "workspace_id,user_id,keyring_version" },
  );
  if (keyError) throw keyError;

  const state = getTeamState();
  rememberWorkspaceKey(workspaceId, workspaceKey, { ...state, activeWorkspaceId: workspaceId });

  return getStatus();
}

export function setActiveWorkspace(workspaceId: string | null): void {
  const state = getTeamState();
  setTeamState({ ...state, activeWorkspaceId: workspaceId });
}

export function listLocalCapsules(localWorkspacePath: string): ArcLocalCapsuleSummary[] {
  return readLocalCapsules(localWorkspacePath)
    .map((capsule) => summarizeLocalCapsule(capsule))
    .sort((left, right) => {
      const leftTime = left.updatedAt ? Date.parse(left.updatedAt) : 0;
      const rightTime = right.updatedAt ? Date.parse(right.updatedAt) : 0;
      return rightTime - leftTime;
    });
}

export async function createInvite(workspaceId: string, email?: string, role: ArcTeamRole = "member"): Promise<ArcTeamInviteResult> {
  if (role === "owner") throw new Error("Invites cannot grant owner role");
  const client = await getClientWithSession();
  await requireUser(client);
  await assertInviteSeatAvailable(client, workspaceId);
  const { data, error } = await client.functions.invoke("create-invite", {
    body: { workspaceId, email: email?.trim() || null, role },
  });
  if (error) throw error;
  const body = objectData(data);
  return {
    inviteId: stringData(body.inviteId, "inviteId"),
    inviteUrl: stringData(body.inviteUrl, "inviteUrl"),
    expiresAt: stringData(body.expiresAt, "expiresAt"),
  };
}

export async function acceptInvite(token: string): Promise<ArcTeamStatus> {
  return acceptInvitePayload({ token });
}

export async function acceptInviteById(inviteId: string): Promise<ArcTeamStatus> {
  return acceptInvitePayload({ inviteId });
}

async function acceptInvitePayload(body: { token?: string; inviteId?: string }): Promise<ArcTeamStatus> {
  const client = await getClientWithSession();
  await requireUser(client);
  const keyPair = await ensureMemberKeyPair();
  const { error } = await client.functions.invoke("accept-invite", {
    body: {
      ...body,
      memberPublicKey: JSON.stringify(keyPair.publicKeyJwk),
    },
  });
  if (error) throw error;
  return getStatus();
}

export async function listJoinableInvites(): Promise<ArcTeamJoinableInvite[]> {
  const client = await getClientWithSession();
  await requireUser(client);
  const { data, error } = await client.functions.invoke("list-my-invites");
  if (error) throw error;
  const body = objectData(data);
  const invites = Array.isArray(body.invites) ? body.invites : [];
  return invites.map((invite) => {
    const record = objectData(invite);
    return {
      id: stringData(record.id, "id"),
      workspaceId: stringData(record.workspaceId, "workspaceId"),
      workspaceName: stringData(record.workspaceName, "workspaceName"),
      role: normalizeInviteRole(record.role),
      expiresAt: stringData(record.expiresAt, "expiresAt"),
      createdAt: stringData(record.createdAt, "createdAt"),
    };
  });
}

export async function listPendingInvites(workspaceId: string): Promise<ArcTeamPendingInvite[]> {
  const client = await getClientWithSession();
  await requireUser(client);
  const { data, error } = await client
    .from("invites")
    .select("id,email,role,expires_at,created_at,accepted_at,revoked_at")
    .eq("workspace_id", workspaceId)
    .is("accepted_at", null)
    .is("revoked_at", null)
    .gt("expires_at", new Date().toISOString())
    .order("created_at", { ascending: false });
  if (error) throw error;
  return ((data as InviteRow[] | null) ?? []).map((invite) => ({
    id: invite.id,
    email: invite.email,
    role: invite.role,
    expiresAt: invite.expires_at,
    createdAt: invite.created_at,
  }));
}

export async function listMembers(workspaceId: string): Promise<ArcTeamMember[]> {
  const client = await getClientWithSession();
  const user = await requireUser(client);
  const [{ data: members, error: membersError }, { data: keys, error: keysError }] = await Promise.all([
    client
      .from("workspace_members")
      .select("workspace_id,user_id,role,joined_at,removed_at")
      .eq("workspace_id", workspaceId)
      .is("removed_at", null),
    client
      .from("member_keys")
      .select("workspace_id,user_id,member_public_key,wrapped_workspace_key,keyring_version")
      .eq("workspace_id", workspaceId),
  ]);
  if (membersError) throw membersError;
  if (keysError) throw keysError;
  const acceptedInviteEmailByUser = await listAcceptedInviteEmailsByUser(client, workspaceId);

  const keysByUser = new Map<string, MemberKeyRow>();
  for (const key of (keys as MemberKeyRow[] | null) ?? []) {
    const existing = keysByUser.get(key.user_id);
    if (!existing || existing.keyring_version < key.keyring_version) keysByUser.set(key.user_id, key);
  }
  return (members as WorkspaceMemberRow[] | null ?? []).map((member) => {
    const key = keysByUser.get(member.user_id);
    const email = member.user_id === user.id
      ? (user.email ?? acceptedInviteEmailByUser.get(member.user_id) ?? null)
      : (acceptedInviteEmailByUser.get(member.user_id) ?? null);
    return {
      userId: member.user_id,
      email,
      displayName: email ?? (member.user_id === user.id ? "You" : shortId(member.user_id)),
      role: member.role,
      joinedAt: member.joined_at,
      removedAt: member.removed_at,
      hasWrappedKey: !!key?.wrapped_workspace_key,
      publicKey: key?.member_public_key ?? null,
    };
  });
}

async function listAcceptedInviteEmailsByUser(client: SupabaseClient, workspaceId: string): Promise<Map<string, string>> {
  const { data, error } = await client
    .from("invites")
    .select("email,accepted_by")
    .eq("workspace_id", workspaceId)
    .not("accepted_by", "is", null);
  if (error) {
    log("TEAM_MEMBER_INVITE_EMAILS", { workspaceId, error: error.message });
    return new Map();
  }

  const emails = new Map<string, string>();
  for (const invite of (data as Array<Pick<InviteRow, "email" | "accepted_by">> | null) ?? []) {
    if (!invite.accepted_by || !invite.email || emails.has(invite.accepted_by)) continue;
    emails.set(invite.accepted_by, invite.email);
  }
  return emails;
}

export async function setMemberRole(
  workspaceId: string,
  userId: string,
  role: Exclude<ArcTeamRole, "owner">,
): Promise<ArcTeamStatus> {
  const client = await getClientWithSession();
  await requireUser(client);
  const { error } = await client.rpc("arc_set_workspace_member_role", {
    target_workspace_id: workspaceId,
    target_user_id: userId,
    next_role: role,
  });
  if (error) throw error;
  return getStatus();
}

export async function transferWorkspaceOwnership(workspaceId: string, newOwnerUserId: string): Promise<ArcTeamStatus> {
  const client = await getClientWithSession();
  await requireUser(client);
  const { error } = await client.rpc("arc_transfer_workspace_ownership", {
    target_workspace_id: workspaceId,
    new_owner_user_id: newOwnerUserId,
  });
  if (error) throw error;
  return getStatus();
}

export async function removeWorkspaceMember(workspaceId: string, userId: string): Promise<ArcTeamStatus> {
  const client = await getClientWithSession();
  await requireUser(client);
  const { error } = await client.rpc("arc_remove_workspace_member", {
    target_workspace_id: workspaceId,
    target_user_id: userId,
  });
  if (error) throw error;
  await rotateWorkspaceKeyForFutureCapsules(client, workspaceId);
  return getStatus();
}

export async function wrapPendingMemberKeys(workspaceId: string): Promise<number> {
  const client = await getClientWithSession();
  const user = await requireUser(client);
  const { data, error } = await client
    .from("member_keys")
    .select("workspace_id,user_id,member_public_key,wrapped_workspace_key,keyring_version")
    .eq("workspace_id", workspaceId)
    .is("wrapped_workspace_key", null);
  if (error) throw error;

  let wrappedCount = 0;
  for (const row of (data as MemberKeyRow[] | null) ?? []) {
    if (!row.member_public_key) continue;
    const workspaceKey = await requireWorkspaceKey(client, workspaceId, row.keyring_version);
    const publicKey = JSON.parse(row.member_public_key) as JsonWebKey;
    const wrapped = await wrapWorkspaceKeyForMember(workspaceKey.rawKeyBase64, publicKey);
    const { error: updateError } = await client
      .from("member_keys")
      .update({
        wrapped_workspace_key: wrapped,
        wrap_algorithm: "rsa-oaep-sha256",
        wrapped_by: user.id,
        wrapped_at: new Date().toISOString(),
      })
      .eq("workspace_id", workspaceId)
      .eq("user_id", row.user_id)
      .eq("keyring_version", row.keyring_version);
    if (updateError) throw updateError;
    wrappedCount += 1;
  }
  return wrappedCount;
}

export async function refreshWorkspaceKey(workspaceId: string): Promise<boolean> {
  const client = await getClientWithSession();
  const user = await requireUser(client);
  if (latestWorkspaceKey(workspaceId)) return true;
  const keyPair = getTeamState().memberKeyPair;
  if (!keyPair) return false;

  const { data, error } = await client
    .from("member_keys")
    .select("workspace_id,user_id,member_public_key,wrapped_workspace_key,keyring_version")
    .eq("workspace_id", workspaceId)
    .eq("user_id", user.id)
    .not("wrapped_workspace_key", "is", null)
    .order("keyring_version", { ascending: true });
  if (error) throw error;
  const rows = (data as MemberKeyRow[] | null) ?? [];
  if (!rows.length) return false;

  let refreshed = false;
  for (const row of rows) {
    if (!row.wrapped_workspace_key) continue;
    const rawKeyBase64 = await unwrapWorkspaceKey(row.wrapped_workspace_key, keyPair.privateKeyJwk);
    rememberWorkspaceKey(workspaceId, {
      keyringVersion: row.keyring_version,
      rawKeyBase64,
    });
    refreshed = true;
  }
  return refreshed;
}

export async function initializeWorkspaceAccess(workspaceId: string): Promise<ArcTeamStatus> {
  const client = await getClientWithSession();
  const user = await requireUser(client);
  const [{ data: membership, error: membershipError }, { count, error: countError }, { data: workspace, error: workspaceError }] =
    await Promise.all([
      client
        .from("workspace_members")
        .select("role")
        .eq("workspace_id", workspaceId)
        .eq("user_id", user.id)
        .is("removed_at", null)
        .single(),
      client
        .from("capsules_meta")
        .select("capsule_id", { count: "exact", head: true })
        .eq("workspace_id", workspaceId)
        .eq("tombstone", false),
      client
        .from("workspaces")
        .select("keyring_version")
        .eq("id", workspaceId)
        .single(),
    ]);
  if (membershipError) throw membershipError;
  if (countError) throw countError;
  if (workspaceError) throw workspaceError;

  const role = (membership as { role?: ArcTeamRole } | null)?.role;
  if (role !== "owner" && role !== "admin") {
    throw new Error("Only workspace owners and admins can set up access");
  }
  if ((count ?? 0) > 0) {
    throw new Error("This workspace already has shared capsules. Ask an owner/admin device with access to grant this device access.");
  }

  const keyringVersion = typeof (workspace as { keyring_version?: unknown } | null)?.keyring_version === "number"
    ? (workspace as { keyring_version: number }).keyring_version
    : 1;
  const keyPair = await ensureMemberKeyPair();
  const workspaceKey = await generateWorkspaceKey(keyringVersion);
  const wrapped = await wrapWorkspaceKeyForMember(workspaceKey.rawKeyBase64, keyPair.publicKeyJwk);

  const { error: keyError } = await client.from("member_keys").upsert(
    {
      workspace_id: workspaceId,
      user_id: user.id,
      keyring_version: workspaceKey.keyringVersion,
      member_public_key: JSON.stringify(keyPair.publicKeyJwk),
      wrapped_workspace_key: wrapped,
      wrap_algorithm: "rsa-oaep-sha256",
      wrapped_by: user.id,
      wrapped_at: new Date().toISOString(),
    },
    { onConflict: "workspace_id,user_id,keyring_version" },
  );
  if (keyError) throw keyError;

  rememberWorkspaceKey(workspaceId, workspaceKey);
  await wrapPendingMemberKeys(workspaceId).catch(() => undefined);
  return getStatus();
}

export async function shareCapsule(params: {
  workspaceId: string;
  localWorkspacePath: string;
  capsuleId: string;
  allowWarnings?: boolean;
}): Promise<ArcTeamShareResult> {
  try {
    const client = await getClientWithSession();
    const user = await requireUser(client);
    const workspace = await requireWorkspaceCanSync(client, user.id, params.workspaceId);
    const capsule = readLocalCapsules(params.localWorkspacePath).find((item) => item.id === params.capsuleId);
    if (!capsule) throw new Error("Capsule not found locally");
    if (!isCapsuleEligibleForSharing(capsule)) {
      throw new Error("Only capsules marked shareable can be uploaded");
    }
    const capsuleId = stringValue(capsule.id, params.capsuleId);
    const existingRef = getTeamState().sharedCapsules[params.workspaceId]?.[capsuleId];
    if (!existingRef && workspace.sharedCapsuleCount >= workspace.sharedCapsuleLimit) {
      throw new Error(`Free workspaces can share up to ${workspace.sharedCapsuleLimit} capsules`);
    }

    const warnings = scanForSecrets(capsule);
    if (warnings.length && !params.allowWarnings) {
      return { ok: false, capsuleId: params.capsuleId, warnings, error: "Secret scan warning" };
    }

    const workspaceKey = await requireWorkspaceKey(client, params.workspaceId);
    const plaintext = JSON.stringify({
      version: 1,
      capsule,
    });
    const plaintextHash = await sha256Hex(plaintext);
    if (existingRef?.plaintextHash === plaintextHash) {
      return { ok: true, capsuleId, warnings: [] };
    }
    const remoteCapsuleId = existingRef?.remoteCapsuleId ?? randomUUID();
    const revision = (existingRef?.revision ?? 0) + 1;
    const envelope = await encryptWithWorkspaceKey(plaintext, workspaceKey);
    const envelopeJson = JSON.stringify(envelope);
    const blobPath = `${params.workspaceId}/${remoteCapsuleId}/r${revision}.json`;
    const ciphertextHash = await sha256Hex(envelopeJson);

    const upload = await client.storage
      .from("arc-capsules")
      .upload(blobPath, new Blob([envelopeJson], { type: "application/json" }), {
        upsert: true,
        contentType: "application/json",
      });
    if (upload.error) throw upload.error;

    const upsert = await client.from("capsules_meta").upsert(
      {
        workspace_id: params.workspaceId,
        capsule_id: remoteCapsuleId,
        blob_path: blobPath,
        ciphertext_hash: ciphertextHash,
        encrypted_size_bytes: Buffer.byteLength(envelopeJson),
        encryption_algorithm: "aes-256-gcm",
        keyring_version: workspaceKey.keyringVersion,
        revision,
        tombstone: false,
        updated_by: user.id,
      },
      { onConflict: "workspace_id,capsule_id" },
    );
    if (upsert.error) throw upsert.error;

    rememberSharedCapsuleRef(params.workspaceId, capsuleId, {
      remoteCapsuleId,
      revision,
      updatedAt: new Date().toISOString(),
      ciphertextHash,
      plaintextHash,
    });

    return { ok: true, capsuleId, warnings };
  } catch (error) {
    return {
      ok: false,
      warnings: [],
      error: reportError("TEAM_SHARE_CAPSULE", error),
    };
  }
}

export async function shareMarkedCapsules(workspaceId: string, localWorkspacePath: string): Promise<ArcTeamShareResult[]> {
  const capsules = readLocalCapsules(localWorkspacePath)
    .filter(isCapsuleEligibleForSharing);
  const results: ArcTeamShareResult[] = [];
  for (const capsule of capsules) {
    results.push(await shareCapsule({ workspaceId, localWorkspacePath, capsuleId: stringValue(capsule.id, "") }));
  }
  return results;
}

export async function listTeamCapsules(workspaceId: string): Promise<ArcTeamCapsuleMeta[]> {
  const client = await getClientWithSession();
  await requireUser(client);
  const { data, error } = await client
    .from("capsules_meta")
    .select("workspace_id,capsule_id,blob_path,ciphertext_hash,encrypted_size_bytes,updated_at,updated_by,revision,tombstone")
    .eq("workspace_id", workspaceId)
    .eq("tombstone", false)
    .order("updated_at", { ascending: false });
  if (error) throw error;
  const localByRemote = localCapsuleIdsByRemoteId(workspaceId);
  return Promise.all(
    ((data as CapsuleMetaRow[] | null) ?? []).map((row) =>
      teamCapsuleMetaWithDisplay(client, row, localByRemote.get(row.capsule_id)),
    ),
  );
}

async function teamCapsuleMetaWithDisplay(
  client: SupabaseClient,
  row: CapsuleMetaRow,
  knownLocalCapsuleId?: string,
): Promise<ArcTeamCapsuleMeta> {
  const base: ArcTeamCapsuleMeta = {
    workspaceId: row.workspace_id,
    capsuleId: row.capsule_id,
    localCapsuleId: knownLocalCapsuleId,
    blobPath: row.blob_path,
    ciphertextHash: row.ciphertext_hash,
    encryptedSizeBytes: row.encrypted_size_bytes,
    updatedAt: row.updated_at,
    updatedBy: row.updated_by,
    revision: row.revision,
    tombstone: row.tombstone,
  };

  try {
    const preview = await readTeamCapsulePreview(client, row);
    if (!preview) return base;
    return {
      ...base,
      localCapsuleId: preview.id || knownLocalCapsuleId,
      title: preview.title,
      summary: preview.summary,
      kind: preview.kind,
      status: preview.status,
      privacyLabel: preview.privacyLabel,
      localUpdatedAt: preview.updatedAt,
      localRevision: preview.revision,
    };
  } catch (error) {
    return {
      ...base,
      displayError: error instanceof Error ? error.message : String(error),
    };
  }
}

async function readTeamCapsulePreview(
  client: SupabaseClient,
  row: CapsuleMetaRow,
): Promise<ArcLocalCapsuleSummary | null> {
  const download = await client.storage.from("arc-capsules").download(row.blob_path);
  if (download.error) throw download.error;
  const envelopeJson = await download.data.text();
  const actualHash = await sha256Hex(envelopeJson);
  if (actualHash !== row.ciphertext_hash) throw new Error("Encrypted capsule checksum mismatch");
  const envelope = JSON.parse(envelopeJson) as CapsuleEnvelope;
  const workspaceKey = await requireWorkspaceKey(client, row.workspace_id, envelope.keyringVersion);
  const plaintext = await decryptWithWorkspaceKey(envelope, workspaceKey);
  const parsed = JSON.parse(plaintext) as { capsule?: JsonRecord };
  if (!parsed.capsule) return null;
  return summarizeLocalCapsule(parsed.capsule);
}

export async function pullTeamCapsules(workspaceId: string, localWorkspacePath: string): Promise<ArcTeamPullResult> {
  try {
    const client = await getClientWithSession();
    await requireUser(client);
    const metas = await listTeamCapsules(workspaceId);
    const local = readLocalCapsules(localWorkspacePath);
    const remoteCapsules: JsonRecord[] = [];
    let skipped = 0;

    for (const meta of metas) {
      const download = await client.storage.from("arc-capsules").download(meta.blobPath);
      if (download.error) throw download.error;
      const envelopeJson = await download.data.text();
      const actualHash = await sha256Hex(envelopeJson);
      if (actualHash !== meta.ciphertextHash) {
        skipped += 1;
        continue;
      }
      const envelope = JSON.parse(envelopeJson) as CapsuleEnvelope;
      const workspaceKey = await requireWorkspaceKey(client, workspaceId, envelope.keyringVersion);
      const plaintext = await decryptWithWorkspaceKey(envelope, workspaceKey);
      const parsed = JSON.parse(plaintext) as { capsule?: JsonRecord };
      const capsule = parsed.capsule;
      if (!capsule) {
        skipped += 1;
        continue;
      }
      remoteCapsules.push(capsule);
      const localCapsuleId = stringValue(capsule.id, "");
      if (localCapsuleId) {
        rememberSharedCapsuleRef(workspaceId, localCapsuleId, {
          remoteCapsuleId: meta.capsuleId,
          revision: meta.revision,
          updatedAt: meta.updatedAt,
          ciphertextHash: meta.ciphertextHash,
          plaintextHash: await sha256Hex(plaintext),
        });
      }
    }

    const merged = mergePulledCapsules(local, remoteCapsules);
    if (merged.pulled > 0) writeLocalCapsules(localWorkspacePath, merged.capsules);
    return { ok: true, pulled: merged.pulled, skipped: skipped + merged.skipped };
  } catch (error) {
    return { ok: false, pulled: 0, skipped: 0, error: reportError("TEAM_PULL_CAPSULES", error) };
  }
}

export async function deleteTeamCapsule(workspaceId: string, capsuleId: string): Promise<ArcTeamDeleteResult> {
  try {
    const client = await getClientWithSession();
    const user = await requireUser(client);
    await requireWorkspaceCanSync(client, user.id, workspaceId);
    const { data, error } = await client
      .from("capsules_meta")
      .select("workspace_id,capsule_id,revision")
      .eq("workspace_id", workspaceId)
      .eq("capsule_id", capsuleId)
      .maybeSingle();
    if (error) throw error;
    const row = data as Pick<CapsuleMetaRow, "workspace_id" | "capsule_id" | "revision"> | null;
    if (!row) throw new Error("Shared capsule not found");

    const { error: updateError } = await client
      .from("capsules_meta")
      .update({
        tombstone: true,
        revision: row.revision + 1,
        updated_by: user.id,
      })
      .eq("workspace_id", workspaceId)
      .eq("capsule_id", capsuleId);
    if (updateError) throw updateError;
    forgetSharedCapsuleRefByRemoteId(workspaceId, capsuleId);
    return { ok: true, capsuleId };
  } catch (error) {
    return { ok: false, capsuleId, error: reportError("TEAM_DELETE_CAPSULE", error) };
  }
}

export async function syncTeamWorkspace(workspaceId: string, localWorkspacePath: string): Promise<ArcTeamSyncResult> {
  const shared = await shareMarkedCapsules(workspaceId, localWorkspacePath);
  const shareFailed = shared.filter((result) => !result.ok).length;
  const pull = await pullTeamCapsules(workspaceId, localWorkspacePath);
  return {
    ok: pull.ok && shareFailed === 0,
    shared: shared.length - shareFailed,
    shareFailed,
    pulled: pull.pulled,
    skipped: pull.skipped,
    error: pull.error,
  };
}

export function getProjectAutoShare(workspaceId: string, localWorkspacePath: string): boolean {
  return getTeamState().autoShareProjects[autoShareKey(workspaceId, localWorkspacePath)] === true;
}

export function setProjectAutoShare(workspaceId: string, localWorkspacePath: string, enabled: boolean): boolean {
  const state = getTeamState();
  const key = autoShareKey(workspaceId, localWorkspacePath);
  const next = { ...state.autoShareProjects };
  if (enabled) next[key] = true;
  else delete next[key];
  setTeamState({ ...state, autoShareProjects: next });
  return enabled;
}

async function listWorkspaces(client: SupabaseClient, userId: string): Promise<ArcTeamWorkspace[]> {
  const { data: memberships, error: membershipError } = await client
    .from("workspace_members")
    .select("workspace_id,user_id,role,joined_at,removed_at")
    .eq("user_id", userId)
    .is("removed_at", null);
  if (membershipError) throw membershipError;

  const memberRows = (memberships as WorkspaceMemberRow[] | null) ?? [];
  const ids = memberRows.map((row) => row.workspace_id);
  if (!ids.length) return [];

  const [
    { data: workspaces, error: workspaceError },
    { data: allMembers, error: allMembersError },
    { data: memberKeys, error: memberKeysError },
    { data: capsuleRows, error: capsuleCountError },
  ] = await Promise.all([
    client.from("workspaces").select("id,name").in("id", ids),
    client.from("workspace_members").select("workspace_id,user_id,role,joined_at,removed_at").in("workspace_id", ids).is("removed_at", null),
    client.from("member_keys").select("workspace_id,user_id,member_public_key,wrapped_workspace_key,keyring_version").in("workspace_id", ids).eq("user_id", userId),
    client.from("capsules_meta").select("workspace_id,capsule_id,tombstone").in("workspace_id", ids).eq("tombstone", false),
  ]);
  if (workspaceError) throw workspaceError;
  if (allMembersError) throw allMembersError;
  if (memberKeysError) throw memberKeysError;
  if (capsuleCountError) throw capsuleCountError;

  const workspaceById = new Map(((workspaces as WorkspaceRow[] | null) ?? []).map((workspace) => [workspace.id, workspace]));
  const memberCountById = new Map<string, number>();
  for (const member of (allMembers as WorkspaceMemberRow[] | null) ?? []) {
    memberCountById.set(member.workspace_id, (memberCountById.get(member.workspace_id) ?? 0) + 1);
  }
  const capsuleCountById = new Map<string, number>();
  for (const capsule of (capsuleRows as Array<{ workspace_id: string }> | null) ?? []) {
    capsuleCountById.set(capsule.workspace_id, (capsuleCountById.get(capsule.workspace_id) ?? 0) + 1);
  }
  const keyRows = (memberKeys as MemberKeyRow[] | null) ?? [];

  await refreshDecryptableWorkspaceKeys(keyRows);
  const localKeys = getTeamState().workspaceKeys;

  return memberRows
    .map<ArcTeamWorkspace | null>((membership) => {
      const workspace = workspaceById.get(membership.workspace_id);
      if (!workspace) return null;
      const memberCount = memberCountById.get(membership.workspace_id) ?? 0;
      const sharedCapsuleCount = capsuleCountById.get(membership.workspace_id) ?? 0;
      const item: ArcTeamWorkspace = {
        id: workspace.id,
        name: workspace.name,
        role: membership.role,
        entitlementStatus: "active",
        maxSeats: FREE_TEAM_SEAT_LIMIT,
        memberCount,
        sharedCapsuleLimit: FREE_TEAM_SHARED_CAPSULE_LIMIT,
        sharedCapsuleCount,
        canSync: memberCount <= FREE_TEAM_SEAT_LIMIT,
        keyReady: Object.keys(localKeys[workspace.id] ?? {}).length > 0,
      };
      return item;
    })
    .filter((workspace): workspace is ArcTeamWorkspace => !!workspace);
}

async function assertInviteSeatAvailable(client: SupabaseClient, workspaceId: string): Promise<void> {
  const now = new Date().toISOString();
  const [
    { count: memberCount, error: memberError },
    { count: inviteCount, error: inviteError },
  ] = await Promise.all([
    client
      .from("workspace_members")
      .select("user_id", { count: "exact", head: true })
      .eq("workspace_id", workspaceId)
      .is("removed_at", null),
    client
      .from("invites")
      .select("id", { count: "exact", head: true })
      .eq("workspace_id", workspaceId)
      .is("accepted_at", null)
      .is("revoked_at", null)
      .gt("expires_at", now),
  ]);
  if (memberError) throw memberError;
  if (inviteError) throw inviteError;
  if ((memberCount ?? 0) + (inviteCount ?? 0) >= FREE_TEAM_SEAT_LIMIT) {
    throw new Error(`Free workspaces can have up to ${FREE_TEAM_SEAT_LIMIT} people`);
  }
}

async function refreshDecryptableWorkspaceKeys(rows: MemberKeyRow[]): Promise<void> {
  const state = getTeamState();
  if (!state.memberKeyPair) return;
  const nextWorkspaceKeys = { ...state.workspaceKeys };
  let changed = false;

  for (const row of rows) {
    const workspaceId = row.workspace_id;
    if (nextWorkspaceKeys[workspaceId]?.[String(row.keyring_version)] || !row.wrapped_workspace_key) continue;
    try {
      nextWorkspaceKeys[workspaceId] = {
        ...(nextWorkspaceKeys[workspaceId] ?? {}),
        [String(row.keyring_version)]: {
          keyringVersion: row.keyring_version,
          rawKeyBase64: await unwrapWorkspaceKey(row.wrapped_workspace_key, state.memberKeyPair.privateKeyJwk),
        },
      };
      changed = true;
    } catch (error) {
      log("TEAM_KEY_REFRESH", { workspaceId, error: error instanceof Error ? error.message : String(error) });
    }
  }

  if (changed) setTeamState({ ...state, workspaceKeys: nextWorkspaceKeys });
}

function chooseActiveWorkspace(workspaces: ArcTeamWorkspace[]): string | null {
  const state = getTeamState();
  if (state.activeWorkspaceId && workspaces.some((workspace) => workspace.id === state.activeWorkspaceId)) {
    return state.activeWorkspaceId;
  }
  const next = workspaces[0]?.id ?? null;
  if (next !== state.activeWorkspaceId) setTeamState({ ...state, activeWorkspaceId: next });
  return next;
}

async function requireWorkspaceCanSync(client: SupabaseClient, userId: string, workspaceId: string): Promise<ArcTeamWorkspace> {
  const workspace = (await listWorkspaces(client, userId)).find((item) => item.id === workspaceId);
  if (!workspace) throw new Error("Workspace is not available to this user");
  if (!workspace.canSync) {
    throw new Error("Workspace sharing plan must be active and within the seat limit before uploading capsules");
  }
  return workspace;
}

async function ensureMemberKeyPair(): Promise<StoredMemberKeyPair> {
  const state = getTeamState();
  if (state.memberKeyPair) return state.memberKeyPair;

  const memberKeyPair = await generateMemberKeyPair();
  setTeamState({ ...state, memberKeyPair });
  return memberKeyPair;
}

async function requireWorkspaceKey(
  client: SupabaseClient,
  workspaceId: string,
  keyringVersion?: number,
): Promise<StoredWorkspaceKey> {
  const existing = keyringVersion
    ? workspaceKeyForVersion(workspaceId, keyringVersion)
    : latestWorkspaceKey(workspaceId);
  if (existing) return existing;
  const refreshed = await refreshWorkspaceKey(workspaceId);
  if (refreshed) {
    const next = keyringVersion
      ? workspaceKeyForVersion(workspaceId, keyringVersion)
      : latestWorkspaceKey(workspaceId);
    if (next) return next;
  }
  await wrapPendingMemberKeys(workspaceId).catch(() => undefined);
  const user = await requireUser(client);
  throw new Error(`Workspace key is not available for ${user.email ?? user.id}`);
}

async function rotateWorkspaceKeyForFutureCapsules(client: SupabaseClient, workspaceId: string): Promise<void> {
  const user = await requireUser(client);
  const current = await requireWorkspaceKey(client, workspaceId);
  const nextVersion = current.keyringVersion + 1;
  const nextKey = await generateWorkspaceKey(nextVersion);

  const { data: members, error } = await client
    .from("member_keys")
    .select("workspace_id,user_id,member_public_key,wrapped_workspace_key,keyring_version")
    .eq("workspace_id", workspaceId)
    .not("member_public_key", "is", null)
    .order("user_id", { ascending: true });
  if (error) throw error;

  const latestPublicKeyByUser = new Map<string, MemberKeyRow>();
  for (const row of (members as MemberKeyRow[] | null) ?? []) {
    const existing = latestPublicKeyByUser.get(row.user_id);
    if (!existing || existing.keyring_version < row.keyring_version) latestPublicKeyByUser.set(row.user_id, row);
  }

  for (const row of latestPublicKeyByUser.values()) {
    if (!row.member_public_key) continue;
    const publicKey = JSON.parse(row.member_public_key) as JsonWebKey;
    const wrapped = await wrapWorkspaceKeyForMember(nextKey.rawKeyBase64, publicKey);
    const { error: keyError } = await client.from("member_keys").upsert(
      {
        workspace_id: workspaceId,
        user_id: row.user_id,
        keyring_version: nextVersion,
        member_public_key: row.member_public_key,
        wrapped_workspace_key: wrapped,
        wrap_algorithm: "rsa-oaep-sha256",
        wrapped_by: user.id,
        wrapped_at: new Date().toISOString(),
      },
      { onConflict: "workspace_id,user_id,keyring_version" },
    );
    if (keyError) throw keyError;
  }

  const { error: workspaceError } = await client
    .from("workspaces")
    .update({ keyring_version: nextVersion })
    .eq("id", workspaceId);
  if (workspaceError) throw workspaceError;
  rememberWorkspaceKey(workspaceId, nextKey);
}

function latestWorkspaceKey(workspaceId: string): StoredWorkspaceKey | null {
  const keyring = getTeamState().workspaceKeys[workspaceId] ?? {};
  const keys = Object.values(keyring).sort((left, right) => right.keyringVersion - left.keyringVersion);
  return keys[0] ?? null;
}

function workspaceKeyForVersion(workspaceId: string, keyringVersion: number): StoredWorkspaceKey | null {
  return getTeamState().workspaceKeys[workspaceId]?.[String(keyringVersion)] ?? null;
}

function rememberWorkspaceKey(
  workspaceId: string,
  workspaceKey: StoredWorkspaceKey,
  baseState = getTeamState(),
): void {
  const keyring = baseState.workspaceKeys[workspaceId] ?? {};
  setTeamState({
    ...baseState,
    workspaceKeys: {
      ...baseState.workspaceKeys,
      [workspaceId]: {
        ...keyring,
        [String(workspaceKey.keyringVersion)]: workspaceKey,
      },
    },
  });
}

function readLocalCapsules(workspacePath: string): JsonRecord[] {
  const file = memoryFile(workspacePath);
  try {
    const raw = fs.readFileSync(file, "utf8");
    return raw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line) as JsonRecord)
      .filter((value) => typeof value.id === "string");
  } catch {
    return [];
  }
}

function summarizeLocalCapsule(capsule: JsonRecord): ArcLocalCapsuleSummary {
  const id = stringValue(capsule.id, "unknown");
  return {
    id,
    title: stringValue(capsule.title, id),
    summary: stringValue(capsule.summary, ""),
    kind: stringValue(capsule.kind, "capsule"),
    status: stringValue(capsule.status, "unknown"),
    privacyLabel: stringValue(capsule.privacyLabel, "team"),
    updatedAt: typeof capsule.updatedAt === "string" ? capsule.updatedAt : null,
    mergeKey: stringValue(capsule.mergeKey, id),
    revision: numberValue(capsule.revision, 1),
    warningCount: scanForSecrets(capsule).length,
  };
}

function isCapsuleEligibleForSharing(capsule: JsonRecord): boolean {
  const status = stringValue(capsule.status, "");
  const privacyLabel = stringValue(capsule.privacyLabel, "");
  if (status !== "shareable" && status !== "shared") return false;
  return privacyLabel !== "private" && privacyLabel !== "redacted";
}

function localCapsuleIdsByRemoteId(workspaceId: string): Map<string, string> {
  const refs = getTeamState().sharedCapsules[workspaceId] ?? {};
  return new Map(
    Object.entries(refs).map(([localCapsuleId, ref]) => [ref.remoteCapsuleId, localCapsuleId]),
  );
}

function rememberSharedCapsuleRef(
  workspaceId: string,
  localCapsuleId: string,
  ref: StoredSharedCapsuleRef,
): void {
  const state = getTeamState();
  const workspaceRefs = state.sharedCapsules[workspaceId] ?? {};
  setTeamState({
    ...state,
    sharedCapsules: {
      ...state.sharedCapsules,
      [workspaceId]: {
        ...workspaceRefs,
        [localCapsuleId]: ref,
      },
    },
  });
}

function forgetSharedCapsuleRefByRemoteId(workspaceId: string, remoteCapsuleId: string): void {
  const state = getTeamState();
  const workspaceRefs = { ...(state.sharedCapsules[workspaceId] ?? {}) };
  for (const [localCapsuleId, ref] of Object.entries(workspaceRefs)) {
    if (ref.remoteCapsuleId === remoteCapsuleId) delete workspaceRefs[localCapsuleId];
  }
  setTeamState({
    ...state,
    sharedCapsules: {
      ...state.sharedCapsules,
      [workspaceId]: workspaceRefs,
    },
  });
}

function autoShareKey(workspaceId: string, localWorkspacePath: string): string {
  return `${workspaceId}\n${path.resolve(localWorkspacePath)}`;
}

function writeLocalCapsules(workspacePath: string, capsules: JsonRecord[]): void {
  const file = memoryFile(workspacePath);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const lines = capsules.map((capsule) => JSON.stringify(capsule));
  fs.writeFileSync(file, `${lines.join("\n")}${lines.length ? "\n" : ""}`, "utf8");
}

function memoryFile(workspacePath: string): string {
  return path.join(workspacePath, ".agent-run-cache", "memory.jsonl");
}

function scanForSecrets(capsule: JsonRecord): ArcTeamSecretScanFinding[] {
  const text = JSON.stringify(capsule);
  const findings: ArcTeamSecretScanFinding[] = [];
  const patterns: Array<[string, RegExp]> = [
    ["GitHub token", /(ghp_[A-Za-z0-9_]{30,}|github_pat_[A-Za-z0-9_]{40,})/],
    ["OpenAI-style API key", /\bsk-[A-Za-z0-9_-]{32,}\b/],
    ["AWS access key", /\bAKIA[0-9A-Z]{16}\b/],
    ["Slack token", /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/],
    ["Private key", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
    ["Supabase service role", /SUPABASE_(SERVICE_ROLE|SECRET)_KEY/i],
    ["JWT", /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/],
  ];

  for (const [label, pattern] of patterns) {
    if (pattern.test(text)) findings.push({ kind: "keyword", label, path: "capsule" });
  }

  const chunks = text.match(/[A-Za-z0-9+/=_-]{40,}/g) ?? [];
  if (chunks.some((chunk) => shannonEntropy(chunk) >= 4.6)) {
    findings.push({ kind: "high_entropy", label: "High entropy string", path: "capsule" });
  }
  return findings;
}

function shannonEntropy(value: string): number {
  const counts = new Map<string, number>();
  for (const char of value) counts.set(char, (counts.get(char) ?? 0) + 1);
  let entropy = 0;
  for (const count of counts.values()) {
    const p = count / value.length;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

async function ensureTeamCallbackServer(): Promise<void> {
  const origin = callbackOrigin(requireConfig().authRedirectOrigin);
  if (callbackServer && callbackServerOrigin === origin) return;

  if (callbackServer) {
    callbackServer.close();
    callbackServer = null;
    callbackServerOrigin = "";
  }

  const callbackUrl = new URL(origin);
  if (callbackUrl.protocol !== "http:") {
    throw new Error("ARC team callbacks must use an http:// localhost origin");
  }

  const nextServer = http.createServer(handleTeamCallbackRequest);
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      nextServer.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      nextServer.off("error", onError);
      resolve();
    };

    nextServer.once("error", onError);
    nextServer.once("listening", onListening);
    nextServer.listen(callbackPort(callbackUrl), callbackUrl.hostname);
  });

  nextServer.on("error", (error) => {
    log("TEAM_CALLBACK_SERVER", { error: error instanceof Error ? error.message : String(error) });
  });
  callbackServer = nextServer;
  callbackServerOrigin = origin;
}

function handleTeamCallbackRequest(request: http.IncomingMessage, response: http.ServerResponse): void {
  const requestUrl = new URL(request.url ?? "/", callbackServerOrigin || "http://127.0.0.1:42843");
  handleTeamCallbackUrl(requestUrl, response);
}

function handleTeamCallbackUrl(requestUrl: URL, response?: http.ServerResponse): void {
  const route = callbackRoute(requestUrl);
  if (route === "/auth/callback") {
    handleAuthCallback(requestUrl, response);
    return;
  }

  if (route === "/team/invite") {
    const token = requestUrl.searchParams.get("invite") ?? requestUrl.searchParams.get("token");
    if (!token) {
      writeCallbackHtml(response, 400, "Invite link is missing its token.");
      return;
    }

    pendingCallbackEvent = {
      id: randomUUID(),
      kind: "invite",
      token,
      receivedAt: new Date().toISOString(),
    };
    writeCallbackHtml(response, 200, "Invite received", "Return to ARC to join this workspace.");
    return;
  }

  if (route === "/team/billing") {
    pendingCallbackEvent = {
      id: randomUUID(),
      kind: "billing",
      billing: requestUrl.searchParams.get("billing") ?? "portal_return",
      workspaceId: requestUrl.searchParams.get("workspace_id"),
      receivedAt: new Date().toISOString(),
    };
    writeCallbackHtml(response, 200, "Billing returned", "Return to ARC to continue.");
    return;
  }

  if (!response) return;
  response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
  response.end("Not found");
}

function handleAuthCallback(requestUrl: URL, response?: http.ServerResponse): void {
  const route = callbackRoute(requestUrl);
  const waiter = authCallbackWaiters.get(route);
  if (!waiter) {
    pendingCallbackEvent = {
      id: randomUUID(),
      kind: "auth",
      status: "error",
      message: "ARC was not waiting for this sign-in.",
      receivedAt: new Date().toISOString(),
    };
    writeCallbackHtml(response, 400, "Sign-in was not expected", "Return to ARC and start sign-in again.");
    return;
  }

  authCallbackWaiters.delete(route);
  clearTimeout(waiter.timer);
  const error = requestUrl.searchParams.get("error") ?? requestUrl.searchParams.get("error_description");
  const authCode = requestUrl.searchParams.get("code");
  pendingCallbackEvent = {
    id: randomUUID(),
    kind: "auth",
    status: error ? "error" : "success",
    message: error ? "Sign-in failed." : "Sign-in complete.",
    receivedAt: new Date().toISOString(),
  };
  writeCallbackHtml(
    response,
    error ? 400 : 200,
    error ? "Sign-in failed" : "Sign-in complete",
    error ? "Return to ARC and try again." : "You can return to ARC now.",
  );
  if (error) waiter.reject(new Error(error));
  else if (authCode) waiter.resolve(authCode);
  else waiter.reject(new Error("OAuth callback did not include a code"));
}

function writeCallbackHtml(response: http.ServerResponse | undefined, status: number, title: string, detail = ""): void {
  if (!response) return;
  response.writeHead(status, { "content-type": "text/html; charset=utf-8" });
  const ok = status >= 200 && status < 300;
  response.end(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>ARC</title>
  <style>
    :root { color-scheme: dark light; }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      display: grid;
      place-items: center;
      background: #0c0f12;
      color: #f5f7fa;
      font: 14px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    main {
      width: min(420px, calc(100vw - 32px));
      border: 1px solid rgba(255,255,255,.12);
      border-radius: 12px;
      padding: 22px;
      background: rgba(255,255,255,.055);
      box-shadow: 0 24px 70px rgba(0,0,0,.36);
    }
    .mark {
      display: inline-flex;
      width: 34px;
      height: 34px;
      align-items: center;
      justify-content: center;
      border-radius: 9px;
      background: ${ok ? "#0f766e" : "#92400e"};
      font-weight: 700;
      margin-bottom: 14px;
    }
    h1 { margin: 0; font-size: 18px; line-height: 1.2; letter-spacing: 0; }
    p { margin: 8px 0 0; color: rgba(245,247,250,.68); }
  </style>
  <script>
    window.setTimeout(() => { window.close(); }, 900);
  </script>
</head>
<body>
  <main>
    <div class="mark">${ok ? "OK" : "!"}</div>
    <h1>${escapeHtml(title)}</h1>
    ${detail ? `<p>${escapeHtml(detail)}</p>` : ""}
  </main>
</body>
</html>`);
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function callbackOrigin(origin: string): string {
  const url = new URL(origin);
  if (!isAllowedTeamCallbackOrigin(url)) {
    throw new Error("ARC team callbacks must use an http://localhost or http://127.0.0.1 origin");
  }
  return url.origin;
}

function callbackRoute(url: URL): string {
  if (url.protocol === TEAM_DEEP_LINK_PROTOCOL) {
    const path = `/${url.hostname}${url.pathname}`.replace(/\/{2,}/g, "/");
    return path === "/" ? "/" : path.replace(/\/$/, "");
  }
  return url.pathname.replace(/\/$/, "") || "/";
}

export function isAllowedTeamCallbackOrigin(origin: URL | string): boolean {
  const url = typeof origin === "string" ? new URL(origin) : origin;
  return url.protocol === "http:" && LOOPBACK_CALLBACK_HOSTS.has(url.hostname);
}

function callbackPort(url: URL): number {
  if (url.port) return Number(url.port);
  return url.protocol === "https:" ? 443 : 80;
}

async function waitForOAuthCallback(redirectTo: string): Promise<{ code: Promise<string>; cancel: () => void }> {
  let settled = false;
  const redirectUrl = new URL(redirectTo);
  if (redirectUrl.protocol === "http:") {
    await ensureTeamCallbackServer();
  }
  const route = callbackRoute(redirectUrl);

  const code = new Promise<string>((resolve, reject) => {
    const existing = authCallbackWaiters.get(route);
    if (existing) {
      clearTimeout(existing.timer);
      authCallbackWaiters.delete(route);
    }

    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("Timed out waiting for ARC sign-in"));
    }, 5 * 60 * 1000);

    authCallbackWaiters.set(route, {
      resolve: (authCode) => {
        settled = true;
        cleanup();
        resolve(authCode);
      },
      reject: (error) => {
        settled = true;
        cleanup();
        reject(error);
      },
      timer,
    });
  });

  function cleanup(): void {
    const waiter = authCallbackWaiters.get(route);
    if (waiter) {
      clearTimeout(waiter.timer);
      authCallbackWaiters.delete(route);
    }
  }

  return {
    code,
    cancel: () => {
      if (!settled) cleanup();
    },
  };
}

async function startPendingEmailCallback(client: SupabaseClient, redirectTo: string): Promise<void> {
  pendingEmailSignIn?.cancel();
  const callback = await waitForOAuthCallback(redirectTo);
  pendingEmailSignIn = { cancel: callback.cancel };
  void callback.code
    .then(async (code) => {
      const exchanged = await client.auth.exchangeCodeForSession(code);
      if (exchanged.error) throw exchanged.error;
      saveSession(exchanged.data.session);
      await ensureMemberKeyPair();
    })
    .catch((error) => {
      log("TEAM_EMAIL_SIGN_IN", { error: error instanceof Error ? error.message : String(error) });
    })
    .finally(() => {
      if (pendingEmailSignIn?.cancel === callback.cancel) pendingEmailSignIn = null;
    });
}

function objectData(value: unknown): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Unexpected response from team service");
  return value as JsonRecord;
}

function stringData(value: unknown, field: string): string {
  if (typeof value !== "string" || !value) throw new Error(`Team service response missing ${field}`);
  return value;
}

function stringValue(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value : fallback;
}

function numberValue(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function shortId(value: string): string {
  return value.length > 12 ? `${value.slice(0, 8)}...${value.slice(-4)}` : value;
}

function normalizeEmail(email: string): string {
  const normalized = email.trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(normalized)) throw new Error("A valid email is required");
  return normalized;
}

function normalizeInviteRole(value: unknown): Exclude<ArcTeamRole, "owner"> {
  return value === "admin" ? "admin" : "member";
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function forgetTeamState(): ArcTeamStatus {
  clearTeamState();
  cachedClient = null;
  cachedClientKey = "";
  sessionApplied = false;
  return {
    configured: !!getTeamConfig(),
    signedIn: false,
    user: null,
    workspaces: [],
    activeWorkspaceId: null,
  };
}
