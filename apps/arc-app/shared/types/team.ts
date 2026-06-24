export type ArcTeamRole = "owner" | "admin" | "member";
export type ArcTeamEntitlementStatus =
  | "inactive"
  | "trialing"
  | "active"
  | "past_due"
  | "canceled"
  | "unpaid"
  | "incomplete"
  | "incomplete_expired"
  | "paused";

export interface ArcTeamConfig {
  supabaseUrl: string;
  supabasePublishableKey: string;
  authRedirectOrigin: string;
}

export interface ArcTeamUser {
  id: string;
  email: string | null;
}

export interface ArcTeamWorkspace {
  id: string;
  name: string;
  role: ArcTeamRole;
  entitlementStatus: ArcTeamEntitlementStatus;
  maxSeats: number;
  memberCount: number;
  sharedCapsuleLimit: number;
  sharedCapsuleCount: number;
  canSync: boolean;
  keyReady: boolean;
}

export interface ArcTeamMember {
  userId: string;
  email: string | null;
  displayName: string;
  role: ArcTeamRole;
  joinedAt: string;
  removedAt: string | null;
  hasWrappedKey: boolean;
  publicKey: string | null;
}

export interface ArcTeamPendingInvite {
  id: string;
  email: string | null;
  role: Exclude<ArcTeamRole, "owner">;
  expiresAt: string;
  createdAt: string;
}

export interface ArcTeamJoinableInvite {
  id: string;
  workspaceId: string;
  workspaceName: string;
  role: Exclude<ArcTeamRole, "owner">;
  expiresAt: string;
  createdAt: string;
}

export interface ArcTeamCapsuleMeta {
  workspaceId: string;
  capsuleId: string;
  localCapsuleId?: string;
  title?: string;
  summary?: string;
  kind?: string;
  status?: string;
  privacyLabel?: string;
  localUpdatedAt?: string | null;
  localRevision?: number;
  displayError?: string;
  blobPath: string;
  ciphertextHash: string;
  encryptedSizeBytes: number;
  updatedAt: string;
  updatedBy: string;
  revision: number;
  tombstone: boolean;
}

export interface ArcLocalCapsuleSummary {
  id: string;
  title: string;
  summary: string;
  kind: string;
  status: string;
  privacyLabel: string;
  updatedAt: string | null;
  mergeKey: string;
  revision: number;
  warningCount: number;
}

export interface ArcTeamStatus {
  configured: boolean;
  signedIn: boolean;
  user: ArcTeamUser | null;
  workspaces: ArcTeamWorkspace[];
  activeWorkspaceId: string | null;
  error?: string;
}

export interface ArcTeamSecretScanFinding {
  kind: "keyword" | "high_entropy";
  label: string;
  path: string;
}

export interface ArcTeamShareResult {
  ok: boolean;
  capsuleId?: string;
  warnings: ArcTeamSecretScanFinding[];
  error?: string;
}

export interface ArcTeamPullResult {
  ok: boolean;
  pulled: number;
  skipped: number;
  error?: string;
}

export interface ArcTeamSyncResult {
  ok: boolean;
  shared: number;
  shareFailed: number;
  pulled: number;
  skipped: number;
  error?: string;
}

export interface ArcTeamDeleteResult {
  ok: boolean;
  capsuleId?: string;
  error?: string;
}

export interface ArcTeamInviteResult {
  inviteId: string;
  inviteUrl: string;
  expiresAt: string;
}

export interface ArcTeamEmailSignInResult {
  ok: boolean;
  email: string;
  redirectTo: string;
}

export type ArcTeamCallbackEvent =
  | {
      id: string;
      kind: "auth";
      status: "success" | "error";
      message: string;
      receivedAt: string;
    }
  | {
      id: string;
      kind: "invite";
      token: string;
      receivedAt: string;
    }
  | {
      id: string;
      kind: "billing";
      billing: "success" | "cancelled" | "portal_return" | string;
      workspaceId: string | null;
      receivedAt: string;
    };

export interface ArcTeamCallbackUrls {
  origin: string;
  authRedirectUrl: string;
  inviteUrlBase: string;
  billingReturnUrl: string;
}
