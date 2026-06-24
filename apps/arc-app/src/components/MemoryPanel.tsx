/**
 * ARC Memory panel: native view over the memory API served by the desktop
 * host (loopback HTTP, URL exposed via preload). Shows the
 * repo's capsules and the memory-event ledger; capsule status can be changed
 * (e.g. rejected) from the row detail. Data plane lives in the ARC CLI — this
 * component only renders it, so panel features ship with the CLI.
 */

import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  Check,
  ChevronDown,
  ChevronRight,
  CircleSlash,
  Database,
  RefreshCw,
  Search,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

// ── API types (mirrors arc panel server payloads) ──

interface ArcWorkflow {
  purpose: string;
  steps: string[];
  commands: string[];
  successCriteria: string[];
  failedAttempts: string[];
}

interface ArcCapsule {
  id: string;
  title: string;
  summary: string;
  kind: string;
  status: string;
  privacyLabel: string;
  confidence: number;
  outcomeStatus: string;
  reusable: boolean;
  useCount: number;
  createdAt: string;
  updatedAt: string;
  reuseWhen: string[];
  doNotReuseWhen: string[];
  evidence: string[];
  nextRunInstruction: string;
  sourceSessionIds: string[];
  workflow: ArcWorkflow;
}

interface ArcMemoryEvent {
  id: string;
  type: string;
  timestamp: string;
  sessionId?: string;
  capsuleId?: string;
  details?: Record<string, unknown>;
}

// ── Helpers ──

function apiBase(): string | null {
  const bridge = window.claude as { arcPanelUrl?: string | null } | undefined;
  const url = bridge?.arcPanelUrl ?? null;
  return url ? url.replace(/\/$/, "") : null;
}

function cleanWorkspace(workspace?: string | null): string | null {
  const trimmed = workspace?.trim();
  return trimmed ? trimmed : null;
}

function apiUrl(
  base: string,
  path: string,
  workspace: string | null,
  params: Record<string, string | number | undefined> = {},
): string {
  const url = new URL(path, `${base}/`);
  if (workspace) url.searchParams.set("workspace", workspace);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }
  return url.toString();
}

function timeAgo(iso: string): string {
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms) || ms < 0) return "";
  const minutes = Math.floor(ms / 60000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

const OUTCOME_DOT: Record<string, string> = {
  success: "bg-emerald-500/80",
  partial: "bg-yellow-500/80",
  failed: "bg-red-500/70",
  aborted: "bg-red-500/50",
  unknown: "bg-foreground/20",
};

const EVENT_COLOR: Record<string, string> = {
  "capsule.created": "text-emerald-600 dark:text-emerald-300/80",
  "capsule.updated": "text-emerald-600 dark:text-emerald-300/80",
  "capsule.finalized": "text-emerald-600 dark:text-emerald-300/80",
  "capsule.injected": "text-yellow-600 dark:text-yellow-200/80",
  "capsule.checkpointed": "text-muted-foreground/70",
  "capsule.superseded": "text-red-500/80",
  "capsule.rejected": "text-red-500/80",
  "runner.failed": "text-red-500/80",
  "review.saved": "text-emerald-600 dark:text-emerald-300/80",
  "review.no_capsule": "text-muted-foreground/70",
  "review.skipped": "text-muted-foreground/60",
  "review.failed": "text-red-500/80",
};

const STATUS_CHOICES = ["local", "shareable", "private", "rejected"] as const;

function describeEvent(event: ArcMemoryEvent): string {
  const details = event.details ?? {};
  const parts: string[] = [];
  if (typeof details.title === "string" && details.title) parts.push(details.title);
  if (typeof details.reason === "string" && details.reason) parts.push(details.reason);
  if (event.type === "capsule.checkpointed") {
    if (!parts.length && typeof details.review === "string" && details.review) parts.push(details.review);
    if (typeof details.eventCount === "number") parts.push(`${details.eventCount} events`);
  }
  if (!parts.length && typeof details.prompt === "string" && details.prompt) {
    parts.push(details.prompt.length > 80 ? `${details.prompt.slice(0, 80)}…` : details.prompt);
  }
  return parts.join(" — ");
}

function eventLabel(event: ArcMemoryEvent): string {
  const outcome = event.details?.outcome;
  if (event.type === "capsule.checkpointed" && typeof outcome === "string" && outcome) {
    return `review.${outcome}`;
  }
  return event.type;
}

function eventDisplayLabel(event: ArcMemoryEvent): string {
  const runner = eventRunner(event);
  const label = eventLabel(event);
  return runner ? `${runner} ${label}` : label;
}

function eventRunner(event: ArcMemoryEvent): string {
  if (typeof event.details?.runner === "string" && event.details.runner) return event.details.runner;
  const id = `${event.sessionId ?? ""} ${event.details?.turnId ?? ""}`;
  if (/\bcodex[-\s]/.test(id)) return "codex";
  if (/\bcopilot[-\s]/.test(id)) return "copilot";
  if (/\bclaude[-\s]/.test(id)) return "claude";
  return "";
}

// ── Detail sub-list ──

function DetailList({ label, items, mono }: { label: string; items: string[]; mono?: boolean }) {
  if (!items.length) return null;
  return (
    <div className="mt-2">
      <p className="text-[9px] font-semibold tracking-wider text-muted-foreground/60 uppercase">{label}</p>
      <ul className="mt-0.5 space-y-0.5">
        {items.map((item, index) => (
          <li
            key={index}
            className={cn(
              "text-[11px] leading-snug text-muted-foreground",
              mono && "font-mono text-[10.5px]",
            )}
          >
            {item}
          </li>
        ))}
      </ul>
    </div>
  );
}

// ── Capsule row ──

function CapsuleRow({
  capsule,
  expanded,
  onToggle,
  onSetStatus,
}: {
  capsule: ArcCapsule;
  expanded: boolean;
  onToggle: () => void;
  onSetStatus: (status: string) => void;
}) {
  const dead = capsule.status === "rejected" || capsule.status === "superseded" || !capsule.reusable;
  const Chevron = expanded ? ChevronDown : ChevronRight;
  return (
    <div className="rounded-md transition-colors hover:bg-muted/50">
      <button type="button" onClick={onToggle} className="flex w-full items-start gap-1.5 px-2 py-1.5 text-left">
        <Chevron className="mt-0.5 h-3 w-3 shrink-0 text-muted-foreground/50" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <Tooltip>
              <TooltipTrigger asChild>
                <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", OUTCOME_DOT[capsule.outcomeStatus] ?? OUTCOME_DOT.unknown)} />
              </TooltipTrigger>
              <TooltipContent side="top"><p className="text-xs">{capsule.outcomeStatus}</p></TooltipContent>
            </Tooltip>
            <span className={cn("truncate text-xs font-medium", dead && "text-muted-foreground/50 line-through")}>
              {capsule.title}
            </span>
          </div>
          <div className="mt-0.5 flex items-center gap-1.5">
            <Badge variant="outline" className="h-3.5 shrink-0 px-1 text-[9px]">{capsule.kind}</Badge>
            {capsule.status !== "local" && (
              <Badge variant="outline" className="h-3.5 shrink-0 px-1 text-[9px] text-muted-foreground">{capsule.status}</Badge>
            )}
            <span className="text-[10px] text-muted-foreground/60 tabular-nums">
              {Math.round(capsule.confidence * 100)}%
            </span>
            {capsule.useCount > 0 && (
              <span className="text-[10px] text-muted-foreground/60">used {capsule.useCount}×</span>
            )}
            <span className="ms-auto shrink-0 text-[10px] text-muted-foreground/50 tabular-nums">
              {timeAgo(capsule.updatedAt)}
            </span>
          </div>
        </div>
      </button>
      {expanded && (
        <div className="border-foreground/[0.06] mx-2 mb-1.5 border-l pb-1 pl-3.5">
          {capsule.summary && (
            <p className="text-[11px] leading-snug text-foreground/80">{capsule.summary}</p>
          )}
          <DetailList label="Reuse when" items={capsule.reuseWhen} />
          <DetailList label="Steps" items={capsule.workflow.steps} />
          <DetailList label="Commands" items={capsule.workflow.commands} mono />
          <DetailList label="Evidence" items={capsule.evidence} />
          <div className="mt-2 flex items-center gap-1.5">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="sm" className="h-5 gap-1 px-1.5 text-[10px] text-muted-foreground">
                  {capsule.status === "rejected" ? <CircleSlash className="h-2.5 w-2.5" /> : <Check className="h-2.5 w-2.5" />}
                  {capsule.status}
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start">
                {STATUS_CHOICES.map((status) => (
                  <DropdownMenuItem key={status} className="text-xs" onClick={() => onSetStatus(status)}>
                    {status === capsule.status && <Check className="h-3 w-3" />}
                    {status}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
            <span className="truncate font-mono text-[9px] text-muted-foreground/40">{capsule.id.slice(0, 8)}</span>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Panel ──

interface MemoryPanelProps {
  headerControls?: React.ReactNode;
  workspace?: string | null;
}

export const MemoryPanel = memo(function MemoryPanel({ headerControls, workspace }: MemoryPanelProps) {
  const base = useMemo(apiBase, []);
  const workspaceKey = useMemo(() => cleanWorkspace(workspace), [workspace]);
  const [capsules, setCapsules] = useState<ArcCapsule[]>([]);
  const [events, setEvents] = useState<ArcMemoryEvent[]>([]);
  const [tab, setTab] = useState<"capsules" | "activity">("capsules");
  const [filter, setFilter] = useState("");
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [unreachable, setUnreachable] = useState(false);
  const countsRef = useRef("");

  const refresh = useCallback(async (force = false) => {
    if (!base) return;
    try {
      const status = await (await fetch(apiUrl(base, "/api/status", workspaceKey))).json() as {
        workspace?: string;
        capsuleCount: number;
        eventCount: number;
      };
      setUnreachable(false);
      const key = `${workspaceKey ?? ""}:${status.workspace ?? ""}:${status.capsuleCount}:${status.eventCount}`;
      if (!force && key === countsRef.current) return;
      countsRef.current = key;
      const [capsulesBody, eventsBody] = await Promise.all([
        (await fetch(apiUrl(base, "/api/capsules", workspaceKey))).json() as Promise<{ capsules: ArcCapsule[] }>,
        (await fetch(apiUrl(base, "/api/events", workspaceKey, { limit: 300 }))).json() as Promise<{ events: ArcMemoryEvent[] }>,
      ]);
      setCapsules(capsulesBody.capsules);
      setEvents(eventsBody.events);
    } catch {
      setUnreachable(true);
    }
  }, [base, workspaceKey]);

  useEffect(() => {
    countsRef.current = "";
    setCapsules([]);
    setEvents([]);
    setExpandedId(null);
    setUnreachable(false);
  }, [workspaceKey]);

  useEffect(() => {
    void refresh(true);
    const timer = setInterval(() => void refresh(), 4000);
    return () => clearInterval(timer);
  }, [refresh]);

  const setStatus = useCallback(async (id: string, status: string) => {
    if (!base) return;
    await fetch(apiUrl(base, `/api/capsules/${encodeURIComponent(id)}`, workspaceKey), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status }),
    }).catch(() => undefined);
    void refresh(true);
  }, [base, refresh, workspaceKey]);

  const visibleCapsules = useMemo(() => {
    const terms = filter.toLowerCase().split(/\s+/).filter(Boolean);
    const sorted = [...capsules].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
    if (!terms.length) return sorted;
    return sorted.filter((capsule) => {
      const haystack = [
        capsule.title, capsule.summary, capsule.kind,
        capsule.reuseWhen.join(" "), capsule.workflow.commands.join(" "),
      ].join(" ").toLowerCase();
      return terms.every((term) => haystack.includes(term));
    });
  }, [capsules, filter]);

  // ── Memory service unavailable ──

  if (!base) {
    return (
      <div className="flex h-full flex-col">
        <div className="flex items-center justify-between px-3 pt-3 pb-2">
          <div className="flex items-center gap-2">
            <div className="flex h-5 w-5 items-center justify-center rounded-md bg-foreground/[0.04]">
              <Database className="h-3 w-3 text-yellow-600/70 dark:text-yellow-200/50" />
            </div>
            <span className="text-[11px] font-semibold tracking-wide text-muted-foreground/80 uppercase">Memory</span>
          </div>
          <div className="flex items-center gap-0.5">{headerControls}</div>
        </div>
        <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-foreground/[0.03]">
            <Database className="h-5 w-5 text-foreground/15" />
          </div>
          <p className="max-w-48 text-center text-[11px] text-muted-foreground/45">
            Memory service unavailable for this workspace
          </p>
        </div>
      </div>
    );
  }

  // ── Main render ──

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="flex items-center justify-between px-3 pt-3 pb-2">
        <div className="flex items-center gap-2">
          <div className="flex h-5 w-5 items-center justify-center rounded-md bg-foreground/[0.04]">
            <Database className="h-3 w-3 text-yellow-600/70 dark:text-yellow-200/50" />
          </div>
          <span className="text-[11px] font-semibold tracking-wide text-muted-foreground/80 uppercase">Memory</span>
          {capsules.length > 0 && (
            <Badge variant="secondary" className="h-5 rounded-full px-2 text-[10px] font-semibold tabular-nums">
              {capsules.length}
            </Badge>
          )}
        </div>
        <div className="flex items-center gap-0.5">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="h-6 w-6 text-muted-foreground/50 hover:text-muted-foreground"
                onClick={() => void refresh(true)}
              >
                <RefreshCw className="h-3 w-3" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="left"><p className="text-xs">Refresh</p></TooltipContent>
          </Tooltip>
          {headerControls}
        </div>
      </div>

      {/* Header separator */}
      <div className="mx-2">
        <div className="h-px bg-gradient-to-r from-foreground/[0.04] via-foreground/[0.08] to-foreground/[0.04]" />
      </div>

      {/* Tabs */}
      <div className="flex items-center gap-1 px-3 pt-2 pb-1.5">
        <Button
          variant={tab === "capsules" ? "secondary" : "ghost"}
          size="sm"
          className="h-5 gap-1 px-2 text-[10px]"
          onClick={() => setTab("capsules")}
        >
          <Database className="h-2.5 w-2.5" />
          Capsules
        </Button>
        <Button
          variant={tab === "activity" ? "secondary" : "ghost"}
          size="sm"
          className="h-5 gap-1 px-2 text-[10px]"
          onClick={() => setTab("activity")}
        >
          <Activity className="h-2.5 w-2.5" />
          Activity
        </Button>
      </div>

      {unreachable && (
        <div className="mx-3 mb-1 rounded bg-muted/50 px-2 py-1 text-[10px] leading-snug text-muted-foreground">
          Memory service unreachable. Refresh or reopen the app.
        </div>
      )}

      {tab === "capsules" && (
        <>
          {/* Search */}
          <div className="px-3 pb-1.5">
            <div className="flex items-center gap-1.5 rounded-md bg-foreground/[0.03] px-2 py-1">
              <Search className="h-3 w-3 shrink-0 text-muted-foreground/40" />
              <input
                value={filter}
                onChange={(event) => setFilter(event.target.value)}
                placeholder="Filter capsules"
                className="w-full bg-transparent text-[11px] text-foreground outline-none placeholder:text-muted-foreground/40"
              />
            </div>
          </div>
          <ScrollArea className="min-h-0 flex-1">
            <div className="space-y-0.5 px-2 pb-3">
              {visibleCapsules.length === 0 && (
                <div className="flex flex-col items-center gap-3 p-6 pt-10">
                  <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-foreground/[0.03]">
                    <Database className="h-5 w-5 text-foreground/15" />
                  </div>
                  <p className="max-w-52 text-center text-[11px] text-muted-foreground/45">
                    {capsules.length === 0
                      ? "No capsules yet — ARC saves reusable knowledge automatically as you work"
                      : "No capsules match the filter"}
                  </p>
                </div>
              )}
              {visibleCapsules.map((capsule) => (
                <CapsuleRow
                  key={capsule.id}
                  capsule={capsule}
                  expanded={expandedId === capsule.id}
                  onToggle={() => setExpandedId(expandedId === capsule.id ? null : capsule.id)}
                  onSetStatus={(status) => void setStatus(capsule.id, status)}
                />
              ))}
            </div>
          </ScrollArea>
        </>
      )}

      {tab === "activity" && (
        <ScrollArea className="min-h-0 flex-1">
          <div className="space-y-1 px-3 pb-3 pt-0.5">
            {events.length === 0 && (
              <div className="flex flex-col items-center gap-3 p-6 pt-10">
                <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-foreground/[0.03]">
                  <Activity className="h-5 w-5 text-foreground/15" />
                </div>
                <p className="text-center text-[11px] text-muted-foreground/45">No memory activity yet</p>
              </div>
            )}
            {events.map((event) => (
              <div key={event.id} className="rounded-md px-1.5 py-1 transition-colors hover:bg-muted/50">
                <div className="flex items-center gap-1.5">
                  <span className={cn("font-mono text-[10px]", EVENT_COLOR[eventLabel(event)] ?? EVENT_COLOR[event.type] ?? "text-muted-foreground/70")}>
                    {eventDisplayLabel(event)}
                  </span>
                  <span className="ms-auto shrink-0 text-[10px] text-muted-foreground/50 tabular-nums">
                    {timeAgo(event.timestamp)}
                  </span>
                </div>
                {describeEvent(event) && (
                  <p className="mt-0.5 text-[10.5px] leading-snug text-muted-foreground">{describeEvent(event)}</p>
                )}
              </div>
            ))}
          </div>
        </ScrollArea>
      )}
    </div>
  );
});
