import { memo, useCallback, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import {
  AlertTriangle,
  Check,
  DownloadCloud,
  Github,
  KeyRound,
  Link,
  Loader2,
  Mail,
  MoreHorizontal,
  Plus,
  RefreshCw,
  Search,
  Share2,
  ShieldCheck,
  UploadCloud,
  Users,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import type {
  ArcLocalCapsuleSummary,
  ArcTeamCapsuleMeta,
  ArcTeamCallbackEvent,
  ArcTeamJoinableInvite,
  ArcTeamMember,
  ArcTeamPendingInvite,
  ArcTeamRole,
  ArcTeamSecretScanFinding,
  ArcTeamStatus,
  ArcTeamWorkspace,
} from "@shared/types/team";

interface SharingPanelProps {
  headerControls?: ReactNode;
  workspace?: string | null;
}

type PanelMode = "capsules" | "people";
type BusyAction = "refresh" | "sign-in" | "workspace" | "share" | "pull" | "sync" | "delete" | "invite" | "keys" | "access" | "member" | "auto" | null;

type CapsuleSyncState = "local-only" | "remote-only" | "shared" | "newer-local" | "newer-remote";
type CapsuleAction = "share" | "pull" | "update";

interface CapsuleSyncRow {
  key: string;
  local: ArcLocalCapsuleSummary | null;
  remote: ArcTeamCapsuleMeta | null;
  state: CapsuleSyncState;
  action: CapsuleAction;
  title: string;
  summary: string;
  updatedAt: string | null;
}

interface IpcError {
  error: string;
}

export const SharingPanel = memo(function SharingPanel({ headerControls, workspace }: SharingPanelProps) {
  const workspacePath = cleanWorkspace(workspace);
  const [status, setStatus] = useState<ArcTeamStatus | null>(null);
  const [localCapsules, setLocalCapsules] = useState<ArcLocalCapsuleSummary[]>([]);
  const [teamCapsules, setTeamCapsules] = useState<ArcTeamCapsuleMeta[]>([]);
  const [members, setMembers] = useState<ArcTeamMember[]>([]);
  const [pendingInvites, setPendingInvites] = useState<ArcTeamPendingInvite[]>([]);
  const [autoShare, setAutoShare] = useState(false);
  const [mode, setMode] = useState<PanelMode>("capsules");
  const [filter, setFilter] = useState("");
  const [busy, setBusy] = useState<BusyAction>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [workspaceName, setWorkspaceName] = useState("");
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<Exclude<ArcTeamRole, "owner">>("member");
  const [inviteOpen, setInviteOpen] = useState(false);
  const [inviteUrl, setInviteUrl] = useState<string | null>(null);
  const [inviteToken, setInviteToken] = useState("");
  const [joinableInvites, setJoinableInvites] = useState<ArcTeamJoinableInvite[]>([]);
  const [pendingWarnings, setPendingWarnings] = useState<Record<string, ArcTeamSecretScanFinding[]>>({});

  const activeWorkspace = useMemo(() => {
    if (!status?.activeWorkspaceId) return null;
    return status.workspaces.find((item) => item.id === status.activeWorkspaceId) ?? null;
  }, [status]);

  const canManage = activeWorkspace?.role === "owner" || activeWorkspace?.role === "admin";
  const canShare = !!activeWorkspace?.canSync && !!activeWorkspace.keyReady && !!workspacePath;
  const canInitializeAccess = !!activeWorkspace && canManage && !activeWorkspace.keyReady && activeWorkspace.sharedCapsuleCount === 0;
  const quotaFull = !!activeWorkspace && activeWorkspace.sharedCapsuleCount >= activeWorkspace.sharedCapsuleLimit;

  const refresh = useCallback(async (showSpinner = false) => {
    if (showSpinner) setBusy("refresh");
    setError(null);
    try {
      const nextStatus = await window.claude.team.status();
      if (!isTeamStatus(nextStatus)) {
        setError(nextStatus.error);
        setStatus(null);
        return;
      }
      setStatus(nextStatus);

      const activeId = nextStatus.activeWorkspaceId;
      const localPromise = workspacePath
        ? window.claude.team.listLocalCapsules(workspacePath)
        : Promise.resolve<ArcLocalCapsuleSummary[] | IpcError>([]);
      const teamPromise = activeId
        ? window.claude.team.listCapsules(activeId)
        : Promise.resolve<ArcTeamCapsuleMeta[] | IpcError>([]);
      const memberPromise = activeId
        ? window.claude.team.listMembers(activeId)
        : Promise.resolve<ArcTeamMember[] | IpcError>([]);
      const invitePromise = activeId
        ? window.claude.team.listPendingInvites(activeId)
        : Promise.resolve<ArcTeamPendingInvite[] | IpcError>([]);
      const joinableInvitePromise = nextStatus.signedIn
        ? window.claude.team.listJoinableInvites()
        : Promise.resolve<ArcTeamJoinableInvite[] | IpcError>([]);
      const autoSharePromise = activeId && workspacePath
        ? window.claude.team.getProjectAutoShare({ workspaceId: activeId, localWorkspacePath: workspacePath })
        : Promise.resolve<{ enabled?: boolean; error?: string }>({ enabled: false });

      const [localResult, teamResult, memberResult, inviteResult, joinableInviteResult, autoShareResult] = await Promise.all([
        localPromise,
        teamPromise,
        memberPromise,
        invitePromise,
        joinableInvitePromise,
        autoSharePromise,
      ]);
      if (Array.isArray(localResult)) setLocalCapsules(localResult);
      else setError(localResult.error);
      if (Array.isArray(teamResult)) setTeamCapsules(teamResult);
      else if (nextStatus.signedIn) setError(teamResult.error);
      if (Array.isArray(memberResult)) setMembers(memberResult);
      else if (nextStatus.signedIn) setError(memberResult.error);
      if (Array.isArray(inviteResult)) setPendingInvites(inviteResult);
      else if (nextStatus.signedIn && inviteResult.error !== "Forbidden") setError(inviteResult.error);
      if (Array.isArray(joinableInviteResult)) setJoinableInvites(joinableInviteResult);
      else setJoinableInvites([]);
      if (!autoShareResult.error) setAutoShare(autoShareResult.enabled === true);
    } finally {
      if (showSpinner) setBusy(null);
    }
  }, [workspacePath]);

  useEffect(() => {
    void refresh(true);
  }, [refresh]);

  useEffect(() => {
    let cancelled = false;

    const consumeCallbackEvent = async () => {
      const result = await window.claude.team.consumeCallbackEvent();
      if (cancelled || !result) return;
      if (isIpcError(result)) {
        setError(result.error);
        return;
      }

      handleCallbackEvent(result);
    };

    const handleCallbackEvent = (event: ArcTeamCallbackEvent) => {
      setError(null);
      if (event.kind === "invite") {
        setInviteToken(event.token);
        setMessage("Invite link ready");
        return;
      }
      if (event.kind === "auth") {
        setMessage(event.message);
        void refresh();
        window.setTimeout(() => void refresh(), 1200);
        return;
      }

      setMessage(billingReturnMessage(event.billing));
      void refresh();
      window.setTimeout(() => void refresh(), 2500);
    };

    void consumeCallbackEvent();
    const timer = window.setInterval(() => void consumeCallbackEvent(), 1500);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [refresh]);

  useEffect(() => {
    if (!message) return;
    const timer = window.setTimeout(() => setMessage(null), 3500);
    return () => window.clearTimeout(timer);
  }, [message]);

  const capsuleRows = useMemo(
    () => buildCapsuleRows(localCapsules, teamCapsules),
    [localCapsules, teamCapsules],
  );

  const visibleCapsuleRows = useMemo(() => {
    const terms = filter.toLowerCase().split(/\s+/).filter(Boolean);
    if (!terms.length) return capsuleRows;
    return capsuleRows.filter((row) => {
      const haystack = [
        row.title,
        row.summary,
        row.state,
        row.local?.kind,
        row.local?.status,
        row.local?.privacyLabel,
        row.local?.mergeKey,
        row.remote?.kind,
        row.remote?.status,
        row.remote?.privacyLabel,
      ].join(" ").toLowerCase();
      return terms.every((term) => haystack.includes(term));
    });
  }, [capsuleRows, filter]);

  const signInWithGitHub = useCallback(async () => {
    setBusy("sign-in");
    setError(null);
    setMessage(null);
    try {
      const result = await window.claude.team.signInWithGitHub();
      if (!isTeamStatus(result)) {
        setError(result.error);
        return;
      }
      setStatus(result);
      setError(result.error ?? null);
      setMessage(result.signedIn && !result.error ? "Signed in" : null);
      await refresh();
    } finally {
      setBusy(null);
    }
  }, [refresh]);

  const signOut = useCallback(async () => {
    setBusy("sign-in");
    setError(null);
    setMessage(null);
    try {
      const result = await window.claude.team.signOut();
      if (!isTeamStatus(result)) {
        setError(result.error);
        return;
      }
      setStatus(result);
      setTeamCapsules([]);
      setMembers([]);
      setPendingInvites([]);
      setAutoShare(false);
    } finally {
      setBusy(null);
    }
  }, []);

  const createWorkspace = useCallback(async () => {
    if (!workspaceName.trim()) return;
    setBusy("workspace");
    setError(null);
    setMessage(null);
    try {
      const result = await window.claude.team.createWorkspace(workspaceName);
      if (!isTeamStatus(result)) {
        setError(result.error);
        return;
      }
      setWorkspaceName("");
      setStatus(result);
      await refresh();
    } finally {
      setBusy(null);
    }
  }, [refresh, workspaceName]);

  const selectWorkspace = useCallback(async (workspaceId: string) => {
    setBusy("refresh");
    setError(null);
    try {
      const result = await window.claude.team.setActiveWorkspace(workspaceId || null);
      if (!isTeamStatus(result)) setError(result.error);
      else setStatus(result);
      await refresh();
    } finally {
      setBusy(null);
    }
  }, [refresh]);

  const shareOne = useCallback(async (capsuleId: string, allowWarnings = false) => {
    if (!activeWorkspace || !workspacePath) return;
    setBusy("share");
    setError(null);
    setMessage(null);
    try {
      const result = await window.claude.team.shareCapsule({
        workspaceId: activeWorkspace.id,
        localWorkspacePath: workspacePath,
        capsuleId,
        allowWarnings,
      });
      if (!("ok" in result)) {
        setError(result.error);
        return;
      }
      if (!result.ok && result.warnings.length > 0) {
        setPendingWarnings((current) => ({ ...current, [capsuleId]: result.warnings }));
        setMessage("Secret scan warning");
        return;
      }
      if (!result.ok) {
        setError(result.error ?? "Share failed");
        return;
      }
      setPendingWarnings((current) => {
        const next = { ...current };
        delete next[capsuleId];
        return next;
      });
      setMessage("Capsule shared");
      await refresh();
    } finally {
      setBusy(null);
    }
  }, [activeWorkspace, refresh, workspacePath]);

  const pullCapsules = useCallback(async () => {
    if (!activeWorkspace || !workspacePath) return;
    setBusy("pull");
    setError(null);
    setMessage(null);
    try {
      const result = await window.claude.team.pullCapsules({
        workspaceId: activeWorkspace.id,
        localWorkspacePath: workspacePath,
      });
      if (!("ok" in result)) {
        setError(result.error);
        return;
      }
      if (!result.ok) {
        setError(result.error ?? "Pull failed");
        return;
      }
      setMessage(`${result.pulled} pulled, ${result.skipped} skipped`);
      await refresh();
    } finally {
      setBusy(null);
    }
  }, [activeWorkspace, refresh, workspacePath]);

  const syncWorkspace = useCallback(async () => {
    if (!activeWorkspace || !workspacePath) return;
    setBusy("sync");
    setError(null);
    setMessage(null);
    try {
      const result = await window.claude.team.syncWorkspace({
        workspaceId: activeWorkspace.id,
        localWorkspacePath: workspacePath,
      });
      if (!("ok" in result)) {
        setError(result.error);
        return;
      }
      if (!result.ok) {
        setError(result.error ?? "Sync finished with errors");
        return;
      }
      setMessage(`${result.shared} shared, ${result.pulled} pulled`);
      await refresh();
    } finally {
      setBusy(null);
    }
  }, [activeWorkspace, refresh, workspacePath]);

  useEffect(() => {
    if (!autoShare || !activeWorkspace?.canSync || !activeWorkspace.keyReady || !workspacePath) return;
    const timer = setInterval(() => {
      if (!document.hidden && !busy) void syncWorkspace();
    }, 60_000);
    return () => clearInterval(timer);
  }, [activeWorkspace, autoShare, busy, syncWorkspace, workspacePath]);

  const toggleAutoShare = useCallback(async () => {
    if (!activeWorkspace || !workspacePath) return;
    setBusy("auto");
    setError(null);
    try {
      const result = await window.claude.team.setProjectAutoShare({
        workspaceId: activeWorkspace.id,
        localWorkspacePath: workspacePath,
        enabled: !autoShare,
      });
      if (result.error) {
        setError(result.error);
        return;
      }
      setAutoShare(result.enabled === true);
    } finally {
      setBusy(null);
    }
  }, [activeWorkspace, autoShare, workspacePath]);

  const runCapsuleAction = useCallback((row: CapsuleSyncRow) => {
    if (row.action === "pull") {
      void pullCapsules();
      return;
    }
    if (row.local) void shareOne(row.local.id);
  }, [pullCapsules, shareOne]);

  const createInvite = useCallback(async () => {
    if (!activeWorkspace) return;
    const email = inviteEmail.trim().toLowerCase();
    if (!email) return;
    setBusy("invite");
    setError(null);
    setMessage(null);
    try {
      const result = await window.claude.team.createInvite({
        workspaceId: activeWorkspace.id,
        email: inviteEmail,
        role: inviteRole,
      });
      if (isIpcError(result)) {
        setError(result.error);
        return;
      }
      setInviteUrl(result.inviteUrl);
      setInviteEmail("");
      setInviteOpen(false);
      setMessage(`Invite link copied for ${email}`);
      await window.claude.writeClipboardText(result.inviteUrl);
      await refresh();
    } finally {
      setBusy(null);
    }
  }, [activeWorkspace, inviteEmail, inviteRole, refresh]);

  const acceptInvite = useCallback(async () => {
    if (!inviteToken.trim()) return;
    setBusy("invite");
    setError(null);
    setMessage(null);
    try {
      const result = await window.claude.team.acceptInvite(inviteToken.trim());
      if (!isTeamStatus(result)) {
        setError(result.error);
        return;
      }
      setInviteToken("");
      setStatus(result);
      setMessage("Invite accepted");
      await refresh();
    } finally {
      setBusy(null);
    }
  }, [inviteToken, refresh]);

  const acceptJoinableInvite = useCallback(async (inviteId: string) => {
    setBusy("invite");
    setError(null);
    setMessage(null);
    try {
      const result = await window.claude.team.acceptInviteById(inviteId);
      if (!isTeamStatus(result)) {
        setError(result.error);
        return;
      }
      setStatus(result);
      setMessage("Workspace joined");
      await refresh();
    } finally {
      setBusy(null);
    }
  }, [refresh]);

  const wrapKeys = useCallback(async () => {
    if (!activeWorkspace) return;
    setBusy("keys");
    setError(null);
    setMessage(null);
    try {
      const result = await window.claude.team.wrapPendingKeys(activeWorkspace.id);
      if (result.error) {
        setError(result.error);
        return;
      }
      setMessage(`${result.wrapped ?? 0} keys wrapped`);
      await refresh();
    } finally {
      setBusy(null);
    }
  }, [activeWorkspace, refresh]);

  const initializeAccess = useCallback(async () => {
    if (!activeWorkspace) return;
    setBusy("access");
    setError(null);
    setMessage(null);
    try {
      const result = await window.claude.team.initializeWorkspaceAccess(activeWorkspace.id);
      if (!isTeamStatus(result)) {
        setError(result.error);
        return;
      }
      setStatus(result);
      setMessage("Workspace access ready");
      await refresh();
    } finally {
      setBusy(null);
    }
  }, [activeWorkspace, refresh]);

  const changeMemberRole = useCallback(async (userId: string, role: Exclude<ArcTeamRole, "owner">) => {
    if (!activeWorkspace) return;
    setBusy("member");
    setError(null);
    setMessage(null);
    try {
      const result = await window.claude.team.setMemberRole({ workspaceId: activeWorkspace.id, userId, role });
      if (!isTeamStatus(result)) {
        setError(result.error);
        return;
      }
      setStatus(result);
      setMessage("Member role updated");
      await refresh();
    } finally {
      setBusy(null);
    }
  }, [activeWorkspace, refresh]);

  const transferOwnership = useCallback(async (userId: string) => {
    if (!activeWorkspace) return;
    setBusy("member");
    setError(null);
    setMessage(null);
    try {
      const result = await window.claude.team.transferOwnership({ workspaceId: activeWorkspace.id, userId });
      if (!isTeamStatus(result)) {
        setError(result.error);
        return;
      }
      setStatus(result);
      setMessage("Ownership transferred");
      await refresh();
    } finally {
      setBusy(null);
    }
  }, [activeWorkspace, refresh]);

  const removeMember = useCallback(async (userId: string) => {
    if (!activeWorkspace) return;
    setBusy("member");
    setError(null);
    setMessage(null);
    try {
      const result = await window.claude.team.removeMember({ workspaceId: activeWorkspace.id, userId });
      if (!isTeamStatus(result)) {
        setError(result.error);
        return;
      }
      setStatus(result);
      setMessage("Member removed; future uploads use a rotated key");
      await refresh();
    } finally {
      setBusy(null);
    }
  }, [activeWorkspace, refresh]);

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between px-3 pt-3 pb-2">
        <div className="min-w-0 flex items-center gap-2">
          <div className="flex h-5 w-5 shrink-0 items-center justify-center rounded-md bg-foreground/[0.04]">
            <Share2 className="h-3 w-3 text-cyan-600/70 dark:text-cyan-200/50" />
          </div>
          <span className="shrink-0 text-[11px] font-semibold tracking-wide text-muted-foreground/80 uppercase">Sharing</span>
        </div>
        <div className="flex items-center gap-0.5">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="h-6 w-6 text-muted-foreground/50 hover:text-muted-foreground"
                onClick={() => void refresh(true)}
                disabled={busy === "refresh"}
              >
                {busy === "refresh" ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
              </Button>
            </TooltipTrigger>
            <TooltipContent side="left"><p className="text-xs">Refresh</p></TooltipContent>
          </Tooltip>
          {headerControls}
        </div>
      </div>

      <div className="mx-2">
        <div className="h-px bg-gradient-to-r from-foreground/[0.04] via-foreground/[0.08] to-foreground/[0.04]" />
      </div>

      {!workspacePath && (
        <EmptyState icon={Share2} text="Open a project workspace first" />
      )}

      {workspacePath && !status?.configured && (
        <TeamUnavailableView capsules={localCapsules} />
      )}

      {workspacePath && status?.configured && !status.signedIn && (
        <ScrollArea className="min-h-0 flex-1">
          <div className="space-y-3 p-3">
            <StatusLine error={error ?? status.error ?? null} message={message} />
            {inviteToken && (
              <InviteJoinNotice
                signedIn={false}
                busy={busy}
                onJoin={() => void acceptInvite()}
              />
            )}
            <SignInPanel busy={busy} onSignIn={() => void signInWithGitHub()} />
	          </div>
	        </ScrollArea>
	      )}

      {workspacePath && status?.signedIn && status.workspaces.length === 0 && (
        <ScrollArea className="min-h-0 flex-1">
          <div className="space-y-3 p-3">
            <StatusLine error={error ?? status.error ?? null} message={message} />
            {inviteToken && (
              <InviteJoinNotice
                signedIn
                busy={busy}
                onJoin={() => void acceptInvite()}
              />
            )}
            <WorkspaceSetup
              workspaceName={workspaceName}
              inviteToken={inviteToken}
              joinableInvites={joinableInvites}
              busy={busy}
              onWorkspaceNameChange={setWorkspaceName}
              onCreateWorkspace={() => void createWorkspace()}
              onAcceptInvite={() => void acceptInvite()}
              onAcceptJoinableInvite={(inviteId) => void acceptJoinableInvite(inviteId)}
            />
          </div>
        </ScrollArea>
      )}

      {workspacePath && status?.signedIn && status.workspaces.length > 0 && (
        <>
          <WorkspaceStrip
            status={status}
            activeWorkspace={activeWorkspace}
            autoShare={autoShare}
            canSync={canShare}
            busy={busy}
            onSelectWorkspace={(workspaceId) => void selectWorkspace(workspaceId)}
            onSignOut={() => void signOut()}
            onSync={() => void syncWorkspace()}
            onToggleAutoShare={() => void toggleAutoShare()}
          />
          <StatusLine error={error ?? status.error ?? null} message={message} className="mx-3 mt-2" />
          {activeWorkspace && !activeWorkspace.keyReady && (
            <KeyRecoveryNotice
              canInitialize={canInitializeAccess}
              busy={busy === "access"}
              className="mx-3 mt-2"
              onInitialize={() => void initializeAccess()}
            />
          )}
          {inviteToken && (
            <div className="mx-3 mt-2">
              <InviteJoinNotice
                signedIn
                busy={busy}
                onJoin={() => void acceptInvite()}
              />
            </div>
          )}
          {joinableInvites.length > 0 && (
            <div className="mx-3 mt-2">
              <JoinableInvitesNotice
                invites={joinableInvites}
                busy={busy}
                onJoin={(inviteId) => void acceptJoinableInvite(inviteId)}
              />
            </div>
          )}
          {activeWorkspace?.keyReady && quotaFull && (
            <QuotaNotice workspace={activeWorkspace} className="mx-3 mt-2" />
          )}
          <div className="flex items-center gap-1 px-3 pt-2 pb-1.5">
            <ModeButton
              active={mode === "capsules"}
              icon={Share2}
              label="Capsules"
              count={capsuleRows.length}
              onClick={() => setMode("capsules")}
            />
            <ModeButton
              active={mode === "people"}
              icon={Users}
              label="People"
              count={members.length}
              onClick={() => setMode("people")}
            />
          </div>

          {mode === "capsules" && (
            <CapsulesView
              rows={visibleCapsuleRows}
              filter={filter}
              pendingWarnings={pendingWarnings}
              canShare={canShare}
              canShareNewCapsule={!quotaFull}
              canPull={!!workspacePath && !!activeWorkspace?.keyReady}
              busy={busy}
              onFilterChange={setFilter}
              onAction={runCapsuleAction}
              onShareAnyway={(capsuleId) => void shareOne(capsuleId, true)}
            />
          )}

          {mode === "people" && (
            <PeopleView
              members={members}
              pendingInvites={pendingInvites}
              activeWorkspace={activeWorkspace}
              currentUserId={status.user?.id ?? null}
              canManage={canManage}
              inviteEmail={inviteEmail}
              inviteRole={inviteRole}
              inviteOpen={inviteOpen}
              inviteUrl={inviteUrl}
              busy={busy}
              onInviteOpenChange={setInviteOpen}
              onInviteEmailChange={setInviteEmail}
              onInviteRoleChange={setInviteRole}
              onInvite={() => void createInvite()}
              onCopyInvite={() => inviteUrl && void window.claude.writeClipboardText(inviteUrl)}
              onWrapKeys={() => void wrapKeys()}
              onSetRole={(userId, role) => void changeMemberRole(userId, role)}
              onTransferOwnership={(userId) => void transferOwnership(userId)}
              onRemoveMember={(userId) => void removeMember(userId)}
            />
          )}
        </>
      )}
    </div>
  );
});

function buildCapsuleRows(
  localCapsules: ArcLocalCapsuleSummary[],
  teamCapsules: ArcTeamCapsuleMeta[],
): CapsuleSyncRow[] {
  const localById = new Map(localCapsules.map((capsule) => [capsule.id, capsule]));
  const remoteByLocalId = new Map<string, ArcTeamCapsuleMeta>();
  for (const remote of teamCapsules) {
    if (remote.localCapsuleId) remoteByLocalId.set(remote.localCapsuleId, remote);
  }

  const rows: CapsuleSyncRow[] = [];
  const usedRemoteIds = new Set<string>();
  for (const local of localCapsules) {
    const remote = remoteByLocalId.get(local.id) ?? null;
    if (remote) usedRemoteIds.add(remote.capsuleId);
    rows.push(capsuleRowFromPair(local, remote));
  }

  for (const remote of teamCapsules) {
    if (usedRemoteIds.has(remote.capsuleId)) continue;
    const local = remote.localCapsuleId ? localById.get(remote.localCapsuleId) ?? null : null;
    if (local) continue;
    rows.push(capsuleRowFromPair(null, remote));
  }

  return rows.sort((left, right) => timestamp(right.updatedAt) - timestamp(left.updatedAt));
}

function capsuleRowFromPair(
  local: ArcLocalCapsuleSummary | null,
  remote: ArcTeamCapsuleMeta | null,
): CapsuleSyncRow {
  const state = capsuleSyncState(local, remote);
  const action: CapsuleAction = state === "remote-only" || state === "newer-remote" ? "pull" : state === "local-only" ? "share" : "update";
  return {
    key: local?.id ?? remote?.capsuleId ?? "capsule",
    local,
    remote,
    state,
    action,
    title: local?.title ?? remote?.title ?? "Encrypted capsule",
    summary: local?.summary ?? remote?.summary ?? "",
    updatedAt: newestDate(local?.updatedAt ?? null, remote?.localUpdatedAt ?? remote?.updatedAt ?? null),
  };
}

function capsuleSyncState(local: ArcLocalCapsuleSummary | null, remote: ArcTeamCapsuleMeta | null): CapsuleSyncState {
  if (local && !remote) return "local-only";
  if (!local && remote) return "remote-only";
  if (!local || !remote) return "shared";
  if (!local.updatedAt || !remote.localUpdatedAt) return "shared";
  const localTime = timestamp(local.updatedAt);
  const remoteTime = timestamp(remote.localUpdatedAt);
  if (localTime > remoteTime + 1000) return "newer-local";
  if (remoteTime > localTime + 1000) return "newer-remote";
  return "shared";
}

function WorkspaceStrip({
  status,
  activeWorkspace,
  autoShare,
  canSync,
  busy,
  onSelectWorkspace,
  onSignOut,
  onSync,
  onToggleAutoShare,
}: {
  status: ArcTeamStatus;
  activeWorkspace: ArcTeamWorkspace | null;
  autoShare: boolean;
  canSync: boolean;
  busy: BusyAction;
  onSelectWorkspace: (workspaceId: string) => void;
  onSignOut: () => void;
  onSync: () => void;
  onToggleAutoShare: () => void;
}) {
  if (!activeWorkspace) return null;
  const state = workspaceState(activeWorkspace);
  return (
    <div className="px-3 pt-2">
      <div className="flex h-9 items-center gap-2 rounded-md border border-border/50 bg-foreground/[0.02] px-2">
        <div className="min-w-0 flex-1">
          <p className="truncate text-[11px] font-medium text-foreground">{activeWorkspace.name}</p>
          <p className="truncate text-[9.5px] text-muted-foreground/55">{state}</p>
        </div>
        {activeWorkspace.sharedCapsuleCount >= activeWorkspace.sharedCapsuleLimit && (
          <Badge variant="outline" className="h-5 rounded-full px-1.5 text-[9px] text-amber-600 dark:text-amber-300">
            quota
          </Badge>
        )}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon-xs" className="h-7 w-7 text-muted-foreground/60">
              <MoreHorizontal className="h-3.5 w-3.5" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-56">
            <DropdownMenuLabel className="text-[11px]">{activeWorkspace.name}</DropdownMenuLabel>
            <DropdownMenuItem disabled className="text-[10px]">
              {entitlementLabel(activeWorkspace.entitlementStatus)} · {activeWorkspace.sharedCapsuleCount}/{activeWorkspace.sharedCapsuleLimit} capsules
            </DropdownMenuItem>
            <DropdownMenuItem disabled className="text-[10px]">
              {activeWorkspace.memberCount}/{activeWorkspace.maxSeats || 0} seats · {activeWorkspace.role}
            </DropdownMenuItem>
            <DropdownMenuItem disabled className="text-[10px]">
              {activeWorkspace.keyReady ? "Access ready" : "Access pending"}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={onSync} disabled={!canSync || busy === "sync"}>
              {busy === "sync" ? "Syncing..." : "Sync now"}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={onToggleAutoShare} disabled={!canSync || busy === "auto"}>
              {autoShare ? "Disable auto sync" : "Enable auto sync"}
            </DropdownMenuItem>
            {status.workspaces.length > 1 && (
              <>
                <DropdownMenuSeparator />
                {status.workspaces.map((workspace) => (
                  <DropdownMenuItem
                    key={workspace.id}
                    onClick={() => onSelectWorkspace(workspace.id)}
                    disabled={workspace.id === activeWorkspace.id || busy === "refresh"}
                  >
                    {workspace.name}
                  </DropdownMenuItem>
                ))}
              </>
            )}
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={onSignOut} disabled={busy === "sign-in"}>
              Sign out
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
}

function workspaceState(workspace: ArcTeamWorkspace): string {
  if (!workspace.canSync) return "Sharing unavailable";
  if (!workspace.keyReady) return "Needs access";
  if (workspace.sharedCapsuleCount >= workspace.sharedCapsuleLimit) return "Quota full";
  return "Ready";
}

function QuotaNotice({ workspace, className }: { workspace: ArcTeamWorkspace; className?: string }) {
  return (
    <div className={cn("rounded-md border border-amber-500/25 bg-amber-500/10 px-2 py-1.5", className)}>
      <div className="flex items-center gap-2">
        <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-amber-700/70 dark:text-amber-200/70" />
        <p className="min-w-0 text-[10.5px] leading-snug text-muted-foreground/75">
          Free workspace limit reached: {workspace.sharedCapsuleCount}/{workspace.sharedCapsuleLimit} capsules.
        </p>
      </div>
    </div>
  );
}

function ModeButton({
  active,
  icon: Icon,
  label,
  count,
  onClick,
}: {
  active: boolean;
  icon: typeof Share2;
  label: string;
  count: number;
  onClick: () => void;
}) {
  return (
    <Button
      variant={active ? "secondary" : "ghost"}
      size="sm"
      className="h-7 flex-1 justify-center gap-1.5 px-2 text-[11px]"
      onClick={onClick}
    >
      <Icon className="h-3.5 w-3.5" />
      <span>{label}</span>
      <span className="text-[10px] text-muted-foreground/70">{count}</span>
    </Button>
  );
}

function CapsulesView({
  rows,
  filter,
  pendingWarnings,
  canShare,
  canShareNewCapsule,
  canPull,
  busy,
  onFilterChange,
  onAction,
  onShareAnyway,
}: {
  rows: CapsuleSyncRow[];
  filter: string;
  pendingWarnings: Record<string, ArcTeamSecretScanFinding[]>;
  canShare: boolean;
  canShareNewCapsule: boolean;
  canPull: boolean;
  busy: BusyAction;
  onFilterChange: (value: string) => void;
  onAction: (row: CapsuleSyncRow) => void;
  onShareAnyway: (capsuleId: string) => void;
}) {
  return (
    <>
      <div className="px-3 pb-1.5">
        <div className="flex min-w-0 items-center gap-1.5 rounded-md bg-foreground/[0.03] px-2 py-1">
          <Search className="h-3 w-3 shrink-0 text-muted-foreground/40" />
          <input
            value={filter}
            onChange={(event) => onFilterChange(event.target.value)}
            placeholder="Filter capsules"
            className="w-full bg-transparent text-[11px] text-foreground outline-none placeholder:text-muted-foreground/40"
          />
        </div>
      </div>
      <ScrollArea className="min-h-0 flex-1">
        <div className="space-y-1 px-2 pb-3">
          {rows.length === 0 && <EmptyState icon={Share2} text="No capsules" />}
          {rows.map((row) => (
            <CapsuleRowView
              key={row.key}
              row={row}
              warnings={row.local ? pendingWarnings[row.local.id] ?? [] : []}
              canShare={canShare}
              canShareNewCapsule={canShareNewCapsule}
              canPull={canPull}
              busy={busy}
              onAction={() => onAction(row)}
              onShareAnyway={() => row.local && onShareAnyway(row.local.id)}
            />
          ))}
        </div>
      </ScrollArea>
    </>
  );
}

function CapsuleRowView({
  row,
  warnings,
  canShare,
  canShareNewCapsule,
  canPull,
  busy,
  onAction,
  onShareAnyway,
}: {
  row: CapsuleSyncRow;
  warnings: ArcTeamSecretScanFinding[];
  canShare: boolean;
  canShareNewCapsule: boolean;
  canPull: boolean;
  busy: BusyAction;
  onAction: () => void;
  onShareAnyway: () => void;
}) {
  const actionDisabled = capsuleActionDisabled(row, canShare, canShareNewCapsule, canPull, busy);
  const actionLabel = warnings.length ? "Share anyway" : capsuleActionLabel(row.action);
  return (
    <div className="rounded-md border border-transparent px-2 py-2 transition-colors hover:border-border/50 hover:bg-muted/40">
      <div className="flex min-w-0 items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-1.5">
            <p className="truncate text-[11px] font-medium text-foreground">{row.title}</p>
            <Badge variant={row.state === "shared" ? "secondary" : "outline"} className="h-4 rounded-full px-1.5 text-[9px]">
              {capsuleStateLabel(row.state)}
            </Badge>
          </div>
          {row.summary && (
            <p className="mt-0.5 line-clamp-2 text-[10.5px] leading-snug text-muted-foreground/72">{row.summary}</p>
          )}
          <div className="mt-1 flex min-w-0 items-center gap-1.5 text-[9.5px] text-muted-foreground/50">
            <span className="truncate">{row.local?.kind ?? row.remote?.kind ?? "capsule"}</span>
            <span>{timeAgo(row.updatedAt)}</span>
            {row.remote?.displayError && <span className="truncate">preview unavailable</span>}
          </div>
          {warnings.length > 0 && (
            <div className="mt-1.5 rounded bg-amber-500/10 px-2 py-1">
              <p className="text-[10px] text-amber-700 dark:text-amber-200">
                {warnings.map((warning) => warning.label).join(", ")}
              </p>
            </div>
          )}
        </div>
        <Button
          size="xs"
          variant={row.action === "pull" ? "secondary" : warnings.length ? "outline" : "default"}
          className="h-7 shrink-0"
          onClick={warnings.length ? onShareAnyway : onAction}
          disabled={actionDisabled}
        >
          {busy === "share" || busy === "pull"
            ? <Loader2 className="h-3 w-3 animate-spin" />
            : row.action === "pull" ? <DownloadCloud className="h-3 w-3" /> : <UploadCloud className="h-3 w-3" />}
          {actionLabel}
        </Button>
      </div>
    </div>
  );
}

function capsuleActionDisabled(
  row: CapsuleSyncRow,
  canShare: boolean,
  canShareNewCapsule: boolean,
  canPull: boolean,
  busy: BusyAction,
): boolean {
  if (row.action === "pull") return !canPull || busy === "pull";
  if (!row.local || !canShare || busy === "share") return true;
  if (row.state === "local-only" && !canShareNewCapsule) return true;
  return !isLocalCapsuleShareEligible(row.local);
}

function capsuleActionLabel(action: CapsuleAction): string {
  if (action === "pull") return "Pull";
  if (action === "share") return "Share";
  return "Update";
}

function capsuleStateLabel(state: CapsuleSyncState): string {
  if (state === "local-only") return "local only";
  if (state === "remote-only") return "remote only";
  if (state === "newer-local") return "newer local";
  if (state === "newer-remote") return "newer remote";
  return "shared";
}

function PeopleView({
  members,
  pendingInvites,
  activeWorkspace,
  currentUserId,
  canManage,
  inviteEmail,
  inviteRole,
  inviteOpen,
  inviteUrl,
  busy,
  onInviteOpenChange,
  onInviteEmailChange,
  onInviteRoleChange,
  onInvite,
  onCopyInvite,
  onWrapKeys,
  onSetRole,
  onTransferOwnership,
  onRemoveMember,
}: {
  members: ArcTeamMember[];
  pendingInvites: ArcTeamPendingInvite[];
  activeWorkspace: ArcTeamWorkspace | null;
  currentUserId: string | null;
  canManage: boolean;
  inviteEmail: string;
  inviteRole: Exclude<ArcTeamRole, "owner">;
  inviteOpen: boolean;
  inviteUrl: string | null;
  busy: BusyAction;
  onInviteOpenChange: (open: boolean) => void;
  onInviteEmailChange: (value: string) => void;
  onInviteRoleChange: (value: Exclude<ArcTeamRole, "owner">) => void;
  onInvite: () => void;
  onCopyInvite: () => void;
  onWrapKeys: () => void;
  onSetRole: (userId: string, role: Exclude<ArcTeamRole, "owner">) => void;
  onTransferOwnership: (userId: string) => void;
  onRemoveMember: (userId: string) => void;
}) {
  const isOwner = activeWorkspace?.role === "owner";
  const pendingKeyMembers = members.filter((member) => !member.hasWrappedKey);
  const seatLimit = activeWorkspace?.maxSeats ?? 0;
  const occupiedSeats = members.length + pendingInvites.length;
  const seatsFull = seatLimit > 0 && occupiedSeats >= seatLimit;
  return (
    <ScrollArea className="min-h-0 flex-1">
      <div className="space-y-2 px-3 pb-3">
        <div className="flex items-center justify-between gap-2">
          <span className="text-[10px] text-muted-foreground/60">
            {seatLimit > 0 ? `${occupiedSeats}/${seatLimit} people` : `${members.length} people`}
          </span>
          {canManage && (
            <InvitePopover
              open={inviteOpen}
              inviteEmail={inviteEmail}
              inviteRole={inviteRole}
              inviteUrl={inviteUrl}
              busy={busy}
              disabled={seatsFull}
              onOpenChange={onInviteOpenChange}
              onInviteEmailChange={onInviteEmailChange}
              onInviteRoleChange={onInviteRoleChange}
              onInvite={onInvite}
              onCopyInvite={onCopyInvite}
            />
          )}
        </div>
        {seatsFull && (
          <div className="rounded-md border border-amber-500/25 bg-amber-500/10 px-2 py-1.5">
            <p className="text-[10.5px] leading-snug text-muted-foreground/75">
              Free workspace seat limit reached.
            </p>
          </div>
        )}
        {canManage && pendingKeyMembers.length > 0 && (
          <div className="rounded-md border border-amber-500/25 bg-amber-500/10 p-2">
            <div className="flex items-center gap-2">
              <KeyRound className="h-3.5 w-3.5 shrink-0 text-amber-700/70 dark:text-amber-200/70" />
              <p className="min-w-0 flex-1 text-[10.5px] leading-snug text-muted-foreground/75">
                {pendingKeyMembers.length} waiting for access
              </p>
              <Button size="xs" className="h-7 shrink-0" onClick={onWrapKeys} disabled={busy === "keys"}>
                {busy === "keys" ? <Loader2 className="h-3 w-3 animate-spin" /> : <KeyRound className="h-3 w-3" />}
                Grant
              </Button>
            </div>
          </div>
        )}
        {pendingInvites.length > 0 && (
          <div className="rounded-md border border-border/50 bg-foreground/[0.02] px-2 py-1.5">
            <p className="mb-1 text-[10px] text-muted-foreground/60">Pending invite links</p>
            <div className="space-y-1">
              {pendingInvites.map((invite) => (
                <div key={invite.id} className="flex min-w-0 items-center gap-1.5 text-[10px] text-muted-foreground/70">
                  <span className="min-w-0 flex-1 truncate">{invite.email ?? "Invite"}</span>
                  <Badge variant="outline" className="h-4 rounded px-1.5 text-[9px]">{invite.role}</Badge>
                </div>
              ))}
            </div>
          </div>
        )}
        <div className="space-y-1">
          {members.map((member) => (
            <div key={member.userId} className="rounded-md px-2 py-2 transition-colors hover:bg-muted/40">
              <div className="flex items-center gap-1.5">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[11px] font-medium text-foreground/85">
                    {member.userId === currentUserId && !member.email ? "You" : member.displayName}
                  </p>
                  <p className="truncate text-[9.5px] text-muted-foreground/50">
                    {member.email ? (member.userId === currentUserId ? "You" : shortId(member.userId)) : member.role}
                  </p>
                </div>
                <Badge variant="outline" className="h-4 rounded px-1.5 text-[9px]">{member.role}</Badge>
                {!member.hasWrappedKey && (
                  <Badge variant="outline" className="h-4 rounded px-1.5 text-[9px]">waiting</Badge>
                )}
                {canManage && member.userId !== currentUserId && member.role !== "owner" && (
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="ghost" size="icon-xs" className="h-6 w-6 text-muted-foreground/55">
                        <MoreHorizontal className="h-3 w-3" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="w-44">
                      {isOwner && member.role !== "admin" && (
                        <DropdownMenuItem onClick={() => onSetRole(member.userId, "admin")} disabled={busy === "member"}>
                          Make admin
                        </DropdownMenuItem>
                      )}
                      {isOwner && member.role === "admin" && (
                        <DropdownMenuItem onClick={() => onSetRole(member.userId, "member")} disabled={busy === "member"}>
                          Make member
                        </DropdownMenuItem>
                      )}
                      {isOwner && (
                        <DropdownMenuItem onClick={() => onTransferOwnership(member.userId)} disabled={busy === "member"}>
                          Transfer ownership
                        </DropdownMenuItem>
                      )}
                      {(isOwner || member.role === "member") && (
                        <>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem
                            className="text-destructive focus:text-destructive"
                            onClick={() => onRemoveMember(member.userId)}
                            disabled={busy === "member"}
                          >
                            Remove
                          </DropdownMenuItem>
                        </>
                      )}
                    </DropdownMenuContent>
                  </DropdownMenu>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>
    </ScrollArea>
  );
}

function InvitePopover({
  open,
  inviteEmail,
  inviteRole,
  inviteUrl,
  busy,
  disabled,
  onOpenChange,
  onInviteEmailChange,
  onInviteRoleChange,
  onInvite,
  onCopyInvite,
}: {
  open: boolean;
  inviteEmail: string;
  inviteRole: Exclude<ArcTeamRole, "owner">;
  inviteUrl: string | null;
  busy: BusyAction;
  disabled: boolean;
  onOpenChange: (open: boolean) => void;
  onInviteEmailChange: (value: string) => void;
  onInviteRoleChange: (value: Exclude<ArcTeamRole, "owner">) => void;
  onInvite: () => void;
  onCopyInvite: () => void;
}) {
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        <Button size="xs" className="h-7" disabled={disabled}>
          <Plus className="h-3 w-3" />
          Invite link
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" side="bottom" className="w-64 p-2">
        <div className="space-y-2">
          <p className="text-[10px] leading-snug text-muted-foreground/65">
            Creates a link and copies it. No email is sent.
          </p>
          <Input
            value={inviteEmail}
            onChange={(event) => onInviteEmailChange(event.target.value)}
            placeholder="person@company.com"
            className="h-8 text-[12px]"
          />
          <div className="flex gap-1.5">
            <select
              value={inviteRole}
              onChange={(event) => onInviteRoleChange(event.target.value === "admin" ? "admin" : "member")}
              className="h-8 min-w-0 flex-1 rounded-md border border-border/50 bg-background/50 px-2 text-[11px] outline-none"
            >
              <option value="member">Member</option>
              <option value="admin">Admin</option>
            </select>
            <Button size="sm" className="h-8" onClick={onInvite} disabled={busy === "invite" || !inviteEmail.trim()}>
              {busy === "invite" ? <Loader2 className="h-3 w-3 animate-spin" /> : <Link className="h-3 w-3" />}
              Create link
            </Button>
          </div>
          {inviteUrl && (
            <button
              type="button"
              onClick={onCopyInvite}
              className="w-full rounded bg-muted/40 px-2 py-1 text-left text-[10px] text-muted-foreground/70 hover:text-foreground"
            >
              Invite link copied · Copy again
            </button>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

function WorkspaceSetup({
  workspaceName,
  inviteToken,
  joinableInvites,
  busy,
  onWorkspaceNameChange,
  onCreateWorkspace,
  onAcceptInvite,
  onAcceptJoinableInvite,
}: {
  workspaceName: string;
  inviteToken: string;
  joinableInvites: ArcTeamJoinableInvite[];
  busy: BusyAction;
  onWorkspaceNameChange: (value: string) => void;
  onCreateWorkspace: () => void;
  onAcceptInvite: () => void;
  onAcceptJoinableInvite: (inviteId: string) => void;
}) {
  return (
    <div className="space-y-2">
      <div className="rounded-md border border-border/50 bg-foreground/[0.02] p-2">
        <p className="mb-2 text-[11px] font-medium text-foreground">Workspace</p>
        <div className="flex gap-1.5">
          <Input
            value={workspaceName}
            onChange={(event) => onWorkspaceNameChange(event.target.value)}
            placeholder="Workspace name"
            className="h-7 text-[11px]"
          />
          <Button size="xs" className="h-7" onClick={onCreateWorkspace} disabled={busy === "workspace"}>
            {busy === "workspace" ? <Loader2 className="h-3 w-3 animate-spin" /> : <Users className="h-3 w-3" />}
            Create
          </Button>
        </div>
      </div>
      {joinableInvites.length > 0 && (
        <JoinableInvitesNotice invites={joinableInvites} busy={busy} onJoin={onAcceptJoinableInvite} />
      )}
      {inviteToken && (
        <InviteJoinNotice signedIn busy={busy} onJoin={onAcceptInvite} />
      )}
    </div>
  );
}

function SignInPanel({ busy, onSignIn }: { busy: BusyAction; onSignIn: () => void }) {
  return (
    <div className="rounded-md border border-border/50 bg-foreground/[0.02] p-3">
      <div className="mb-3 flex items-center gap-2">
        <Github className="h-4 w-4 text-cyan-600/70 dark:text-cyan-200/60" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-[11px] font-medium text-foreground">ARC workspace account</p>
          <p className="truncate text-[10px] text-muted-foreground/60">Sign in, then create or join a workspace.</p>
        </div>
      </div>
      <Button
        size="sm"
        className="h-8 w-full"
        onClick={onSignIn}
        disabled={busy === "sign-in"}
      >
        {busy === "sign-in" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Github className="h-3.5 w-3.5" />}
        Continue with GitHub
      </Button>
    </div>
  );
}

function JoinableInvitesNotice({
  invites,
  busy,
  onJoin,
}: {
  invites: ArcTeamJoinableInvite[];
  busy: BusyAction;
  onJoin: (inviteId: string) => void;
}) {
  return (
    <div className="rounded-md border border-cyan-500/20 bg-cyan-500/10 p-2">
      <div className="mb-1.5 flex items-center gap-2">
        <Mail className="h-4 w-4 shrink-0 text-cyan-700/70 dark:text-cyan-200/70" />
        <p className="min-w-0 flex-1 truncate text-[11px] font-medium text-foreground">
          {invites.length === 1 ? "Workspace invite" : "Workspace invites"}
        </p>
      </div>
      <div className="space-y-1">
        {invites.map((invite) => (
          <div key={invite.id} className="flex min-w-0 items-center gap-1.5">
            <div className="min-w-0 flex-1">
              <p className="truncate text-[10.5px] font-medium text-foreground/85">{invite.workspaceName}</p>
              <p className="text-[10px] text-muted-foreground/60">{invite.role}</p>
            </div>
            <Button size="xs" className="h-7 shrink-0" onClick={() => onJoin(invite.id)} disabled={busy === "invite"}>
              {busy === "invite" ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />}
              Join
            </Button>
          </div>
        ))}
      </div>
    </div>
  );
}

function InviteJoinNotice({
  signedIn,
  busy,
  onJoin,
}: {
  signedIn: boolean;
  busy: BusyAction;
  onJoin: () => void;
}) {
  return (
    <div className="rounded-md border border-cyan-500/20 bg-cyan-500/10 p-2">
      <div className="flex min-w-0 items-center gap-2">
        <Link className="h-4 w-4 shrink-0 text-cyan-700/70 dark:text-cyan-200/70" />
        <div className="min-w-0 flex-1">
          <p className="text-[11px] font-medium text-foreground">Invite link ready</p>
          <p className="truncate text-[10px] text-muted-foreground/60">
            {signedIn ? "Join this workspace from ARC." : "Sign in with GitHub to join this workspace."}
          </p>
        </div>
        {signedIn && (
          <Button size="xs" className="h-7" onClick={onJoin} disabled={busy === "invite"}>
            {busy === "invite" ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />}
            Join
          </Button>
        )}
      </div>
    </div>
  );
}

function KeyRecoveryNotice({
  canInitialize,
  busy,
  className,
  onInitialize,
}: {
  canInitialize: boolean;
  busy: boolean;
  className?: string;
  onInitialize: () => void;
}) {
  return (
    <div className={cn("rounded-md border border-border/60 bg-foreground/[0.025] p-2.5", className)}>
      <div className="flex items-start gap-2">
        <KeyRound className="mt-0.5 h-4 w-4 shrink-0 text-cyan-600/70 dark:text-cyan-200/60" />
        <div className="min-w-0 flex-1">
          <p className="text-[11px] font-medium text-foreground">
            {canInitialize ? "Set up workspace access" : "Access pending"}
          </p>
          <p className="mt-0.5 text-[10.5px] leading-snug text-muted-foreground/68">
            {canInitialize
              ? "This empty workspace needs an encryption key on this device before capsules can be shared."
              : "This device does not have the workspace key yet. Ask an owner or admin with access to grant this device access."}
          </p>
          {canInitialize && (
            <Button size="xs" className="mt-2 h-7" onClick={onInitialize} disabled={busy}>
              {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <KeyRound className="h-3 w-3" />}
              Set up access
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

function TeamUnavailableView({ capsules }: { capsules: ArcLocalCapsuleSummary[] }) {
  return (
    <ScrollArea className="min-h-0 flex-1">
      <div className="space-y-3 p-3">
        <div className="rounded-md border border-border/50 bg-foreground/[0.02] p-2">
          <div className="flex items-start gap-2">
            <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-cyan-600/70 dark:text-cyan-200/60" />
            <div className="min-w-0">
              <p className="text-[11px] font-medium text-foreground">Team sharing is off</p>
              <p className="mt-1 text-[10.5px] leading-snug text-muted-foreground/65">
                This build is missing the private team config, so workspaces and invites cannot load.
              </p>
            </div>
          </div>
        </div>
        <LocalCapsulesPreview capsules={capsules} />
      </div>
    </ScrollArea>
  );
}

function LocalCapsulesPreview({ capsules }: { capsules: ArcLocalCapsuleSummary[] }) {
  return (
    <div className="space-y-1 px-2">
      <div className="flex items-center justify-between px-1">
        <span className="text-[10px] text-muted-foreground/60">Local capsules</span>
        <Badge variant="outline" className="h-5 rounded-full px-2 text-[10px]">
          {capsules.length}
        </Badge>
      </div>
      {capsules.length === 0 && <EmptyState icon={Share2} text="No local capsules" />}
      {capsules.map((capsule) => (
        <div key={capsule.id} className="rounded-md px-2 py-2">
          <p className="truncate text-[11px] font-medium text-foreground">{capsule.title}</p>
          {capsule.summary && (
            <p className="mt-0.5 line-clamp-2 text-[10.5px] leading-snug text-muted-foreground/70">{capsule.summary}</p>
          )}
        </div>
      ))}
    </div>
  );
}

function StatusLine({ error, message, className }: { error?: string | null; message?: string | null; className?: string }) {
  if (!error && !message) return null;
  return (
    <div className={cn(
      "rounded px-2 py-1 text-[10px] leading-snug",
      error ? "bg-destructive/10 text-destructive" : "bg-emerald-500/10 text-emerald-700 dark:text-emerald-200",
      className,
    )}>
      {error ?? message}
    </div>
  );
}

function EmptyState({ icon: Icon, text }: { icon: typeof Share2; text: string }) {
  return (
    <div className="flex min-h-36 flex-1 flex-col items-center justify-center gap-3 p-6">
      <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-foreground/[0.03]">
        <Icon className="h-5 w-5 text-foreground/15" />
      </div>
      <p className="max-w-52 text-center text-[11px] text-muted-foreground/45">{text}</p>
    </div>
  );
}

function isIpcError(value: unknown): value is IpcError {
  return !!value && typeof value === "object" && "error" in value && typeof (value as IpcError).error === "string";
}

function isTeamStatus(value: ArcTeamStatus | IpcError): value is ArcTeamStatus {
  return !!value && typeof value === "object" && "configured" in value;
}

function cleanWorkspace(value?: string | null): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function billingReturnMessage(status: string): string {
  if (status === "success") return "Billing complete. Refreshing workspace.";
  if (status === "cancelled") return "Billing cancelled";
  return "Billing portal closed. Refreshing workspace.";
}

function entitlementLabel(status: string): string {
  if (status === "active") return "Free";
  if (status === "trialing") return "Trial";
  if (status === "past_due") return "Past due";
  if (status === "canceled") return "Canceled";
  if (status === "unpaid") return "Unpaid";
  return "Inactive";
}

function isLocalCapsuleShareEligible(capsule: ArcLocalCapsuleSummary): boolean {
  if (capsule.status !== "shareable" && capsule.status !== "shared") return false;
  return capsule.privacyLabel !== "private" && capsule.privacyLabel !== "redacted";
}

function newestDate(left: string | null, right: string | null): string | null {
  if (!left) return right;
  if (!right) return left;
  return timestamp(left) >= timestamp(right) ? left : right;
}

function timestamp(value: string | null): number {
  if (!value) return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function shortId(value: string): string {
  return value.length > 12 ? `${value.slice(0, 8)}...${value.slice(-4)}` : value;
}

function timeAgo(value: string | null): string {
  if (!value) return "never";
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return "unknown";
  const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  if (seconds < 60) return "now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}
