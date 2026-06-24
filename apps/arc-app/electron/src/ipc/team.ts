import { ipcMain } from "electron";
import { reportError } from "../lib/error-utils";
import {
  acceptInvite,
  consumeTeamCallbackEvent,
  createInvite,
  createWorkspace,
  deleteTeamCapsule,
  forgetTeamState,
  getTeamCallbackUrls,
  getProjectAutoShare,
  getStatus,
  initializeWorkspaceAccess,
  listJoinableInvites,
  listLocalCapsules,
  listMembers,
  listPendingInvites,
  listTeamCapsules,
  pullTeamCapsules,
  removeWorkspaceMember,
  sendEmailSignIn,
  setActiveWorkspace,
  setMemberRole,
  setProjectAutoShare,
  shareCapsule,
  shareMarkedCapsules,
  signInWithGitHub,
  signOutTeam,
  syncTeamWorkspace,
  transferWorkspaceOwnership,
  acceptInviteById,
  verifyEmailOtp,
  wrapPendingMemberKeys,
} from "../lib/team-service";
import type { ArcTeamRole } from "@shared/types/team";

type JsonRecord = Record<string, unknown>;

export function register(): void {
  ipcMain.handle("team:status", () => safe("TEAM_STATUS_IPC", () => getStatus()));
  ipcMain.handle("team:send-email-sign-in", (_event, email: string) =>
    safe("TEAM_SEND_EMAIL_SIGN_IN_IPC", () => sendEmailSignIn(requireString(email, "Email"))),
  );
  ipcMain.handle("team:verify-email-otp", (_event, params: unknown) =>
    safe("TEAM_VERIFY_EMAIL_OTP_IPC", () => {
      const body = objectData(params);
      return verifyEmailOtp(requireString(body.email, "Email"), requireString(body.token, "Email code"));
    }),
  );
  ipcMain.handle("team:sign-in-github", () => safe("TEAM_SIGN_IN_IPC", () => signInWithGitHub()));
  ipcMain.handle("team:sign-out", () => safe("TEAM_SIGN_OUT_IPC", () => signOutTeam()));
  ipcMain.handle("team:forget-state", () => safe("TEAM_FORGET_IPC", () => forgetTeamState()));
  ipcMain.handle("team:callback-urls", () => safe("TEAM_CALLBACK_URLS_IPC", () => getTeamCallbackUrls()));
  ipcMain.handle("team:consume-callback-event", () =>
    safe("TEAM_CONSUME_CALLBACK_EVENT_IPC", () => consumeTeamCallbackEvent()),
  );

  ipcMain.handle("team:create-workspace", (_event, name: string) =>
    safe("TEAM_CREATE_WORKSPACE_IPC", () => createWorkspace(requireString(name, "Workspace name"))),
  );
  ipcMain.handle("team:set-active-workspace", (_event, workspaceId: string | null) =>
    safe("TEAM_SET_ACTIVE_WORKSPACE_IPC", async () => {
      setActiveWorkspace(workspaceId);
      return getStatus();
    }),
  );

  ipcMain.handle("team:list-local-capsules", (_event, localWorkspacePath: string) =>
    safe("TEAM_LIST_LOCAL_CAPSULES_IPC", () => listLocalCapsules(requireString(localWorkspacePath, "Workspace path"))),
  );
  ipcMain.handle("team:list-capsules", (_event, workspaceId: string) =>
    safe("TEAM_LIST_CAPSULES_IPC", () => listTeamCapsules(requireString(workspaceId, "Workspace id"))),
  );
  ipcMain.handle("team:share-capsule", (_event, params: unknown) =>
    safe("TEAM_SHARE_CAPSULE_IPC", () => {
      const body = objectData(params);
      return shareCapsule({
        workspaceId: requireString(body.workspaceId, "Workspace id"),
        localWorkspacePath: requireString(body.localWorkspacePath, "Workspace path"),
        capsuleId: requireString(body.capsuleId, "Capsule id"),
        allowWarnings: body.allowWarnings === true,
      });
    }),
  );
  ipcMain.handle("team:share-marked-capsules", (_event, params: unknown) =>
    safe("TEAM_SHARE_MARKED_CAPSULES_IPC", () => {
      const body = objectData(params);
      return shareMarkedCapsules(
        requireString(body.workspaceId, "Workspace id"),
        requireString(body.localWorkspacePath, "Workspace path"),
      );
    }),
  );
  ipcMain.handle("team:pull-capsules", (_event, params: unknown) =>
    safe("TEAM_PULL_CAPSULES_IPC", () => {
      const body = objectData(params);
      return pullTeamCapsules(
        requireString(body.workspaceId, "Workspace id"),
        requireString(body.localWorkspacePath, "Workspace path"),
      );
    }),
  );
  ipcMain.handle("team:sync-workspace", (_event, params: unknown) =>
    safe("TEAM_SYNC_WORKSPACE_IPC", () => {
      const body = objectData(params);
      return syncTeamWorkspace(
        requireString(body.workspaceId, "Workspace id"),
        requireString(body.localWorkspacePath, "Workspace path"),
      );
    }),
  );
  ipcMain.handle("team:delete-capsule", (_event, params: unknown) =>
    safe("TEAM_DELETE_CAPSULE_IPC", () => {
      const body = objectData(params);
      return deleteTeamCapsule(
        requireString(body.workspaceId, "Workspace id"),
        requireString(body.capsuleId, "Capsule id"),
      );
    }),
  );
  ipcMain.handle("team:get-project-auto-share", (_event, params: unknown) =>
    safe("TEAM_GET_AUTO_SHARE_IPC", () => {
      const body = objectData(params);
      return {
        enabled: getProjectAutoShare(
          requireString(body.workspaceId, "Workspace id"),
          requireString(body.localWorkspacePath, "Workspace path"),
        ),
      };
    }),
  );
  ipcMain.handle("team:set-project-auto-share", (_event, params: unknown) =>
    safe("TEAM_SET_AUTO_SHARE_IPC", () => {
      const body = objectData(params);
      return {
        enabled: setProjectAutoShare(
          requireString(body.workspaceId, "Workspace id"),
          requireString(body.localWorkspacePath, "Workspace path"),
          body.enabled === true,
        ),
      };
    }),
  );

  ipcMain.handle("team:list-members", (_event, workspaceId: string) =>
    safe("TEAM_LIST_MEMBERS_IPC", () => listMembers(requireString(workspaceId, "Workspace id"))),
  );
  ipcMain.handle("team:list-pending-invites", (_event, workspaceId: string) =>
    safe("TEAM_LIST_INVITES_IPC", () => listPendingInvites(requireString(workspaceId, "Workspace id"))),
  );
  ipcMain.handle("team:list-joinable-invites", () =>
    safe("TEAM_LIST_JOINABLE_INVITES_IPC", () => listJoinableInvites()),
  );
  ipcMain.handle("team:wrap-pending-keys", (_event, workspaceId: string) =>
    safe("TEAM_WRAP_KEYS_IPC", async () => ({
      ok: true,
      wrapped: await wrapPendingMemberKeys(requireString(workspaceId, "Workspace id")),
    })),
  );
  ipcMain.handle("team:initialize-workspace-access", (_event, workspaceId: string) =>
    safe("TEAM_INIT_WORKSPACE_ACCESS_IPC", () => initializeWorkspaceAccess(requireString(workspaceId, "Workspace id"))),
  );
  ipcMain.handle("team:set-member-role", (_event, params: unknown) =>
    safe("TEAM_SET_MEMBER_ROLE_IPC", () => {
      const body = objectData(params);
      return setMemberRole(
        requireString(body.workspaceId, "Workspace id"),
        requireString(body.userId, "User id"),
        normalizeNonOwnerRole(body.role),
      );
    }),
  );
  ipcMain.handle("team:transfer-ownership", (_event, params: unknown) =>
    safe("TEAM_TRANSFER_OWNER_IPC", () => {
      const body = objectData(params);
      return transferWorkspaceOwnership(
        requireString(body.workspaceId, "Workspace id"),
        requireString(body.userId, "User id"),
      );
    }),
  );
  ipcMain.handle("team:remove-member", (_event, params: unknown) =>
    safe("TEAM_REMOVE_MEMBER_IPC", () => {
      const body = objectData(params);
      return removeWorkspaceMember(
        requireString(body.workspaceId, "Workspace id"),
        requireString(body.userId, "User id"),
      );
    }),
  );
  ipcMain.handle("team:create-invite", (_event, params: unknown) =>
    safe("TEAM_CREATE_INVITE_IPC", () => {
      const body = objectData(params);
      return createInvite(
        requireString(body.workspaceId, "Workspace id"),
        typeof body.email === "string" ? body.email : undefined,
        normalizeRole(body.role),
      );
    }),
  );
  ipcMain.handle("team:accept-invite", (_event, token: string) =>
    safe("TEAM_ACCEPT_INVITE_IPC", () => acceptInvite(requireString(token, "Invite token"))),
  );
  ipcMain.handle("team:accept-invite-by-id", (_event, inviteId: string) =>
    safe("TEAM_ACCEPT_INVITE_BY_ID_IPC", () => acceptInviteById(requireString(inviteId, "Invite id"))),
  );

}

async function safe<T>(label: string, fn: () => T | Promise<T>): Promise<T | { error: string }> {
  try {
    return await fn();
  } catch (error) {
    return { error: reportError(label, error) };
  }
}

function objectData(value: unknown): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Expected an object payload");
  }
  return value as JsonRecord;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} is required`);
  return value.trim();
}

function normalizeRole(value: unknown): ArcTeamRole {
  return value === "admin" || value === "member" ? value : "member";
}

function normalizeNonOwnerRole(value: unknown): Exclude<ArcTeamRole, "owner"> {
  return value === "admin" ? "admin" : "member";
}
