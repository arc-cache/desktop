import { memo, type ReactNode } from "react";
import { LockKeyhole, UsersRound } from "lucide-react";
import { Badge } from "@/components/ui/badge";

interface SharingComingSoonPanelProps {
  headerControls?: ReactNode;
}

export const SharingComingSoonPanel = memo(function SharingComingSoonPanel({
  headerControls,
}: SharingComingSoonPanelProps) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center justify-between px-3 pt-3 pb-2">
        <div className="flex min-w-0 items-center gap-2">
          <div className="flex h-5 w-5 items-center justify-center rounded-md bg-foreground/[0.04]">
            <UsersRound className="h-3 w-3 text-cyan-600/70 dark:text-cyan-200/55" />
          </div>
          <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground/80">
            Sharing
          </span>
          <Badge variant="secondary" className="h-5 rounded-full px-2 text-[10px] font-semibold">
            Local only
          </Badge>
        </div>
        <div className="flex items-center gap-0.5">{headerControls}</div>
      </div>

      <div className="flex flex-1 flex-col items-center justify-center gap-4 px-6 py-8">
        <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-foreground/[0.04]">
          <LockKeyhole className="h-6 w-6 text-foreground/20" />
        </div>
        <div className="max-w-64 space-y-2 text-center">
          <p className="text-sm font-medium text-foreground/80">Sharing is unavailable</p>
          <p className="text-xs leading-5 text-muted-foreground/60">
            This build keeps ARC memory local to this machine. Team sharing and hosted sync are not included yet.
          </p>
        </div>
      </div>
    </div>
  );
});
