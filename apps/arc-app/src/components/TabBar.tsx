/**
 * Generic tab bar used by ToolsPanel and BrowserPanel.
 * Renders a row of closeable tabs with a header icon/label and a "new tab" button.
 */

import { useCallback, useState } from "react";
import { Plus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { LucideIcon } from "lucide-react";

export interface TabBarTab {
  id: string;
  label: string;
}

interface TabBarProps<T extends TabBarTab> {
  tabs: T[];
  activeTabId: string | null;
  onSelectTab: (tabId: string) => void;
  onCloseTab: (tabId: string) => void;
  onNewTab: () => void;
  /** Icon shown before the header label. */
  headerIcon: LucideIcon;
  /** Text label shown next to the header icon. */
  headerLabel: string;
  /** Optional per-tab icon renderer. Receives the tab and whether it's active. */
  renderTabIcon?: (tab: T) => React.ReactNode;
  /** Max width for truncated tab labels (Tailwind class like "max-w-20"). Defaults to "max-w-20". */
  tabMaxWidth?: string;
  /** Override active tab text classes. */
  activeClass?: string;
  /** Override inactive tab text classes. */
  inactiveClass?: string;
  /** Optional drag-reorder handler. */
  onReorderTabs?: (fromTabId: string, toTabId: string) => void;
  /** Optional actions rendered before the new-tab button. */
  headerActions?: React.ReactNode;
}

export function TabBar<T extends TabBarTab>({
  tabs,
  activeTabId,
  onSelectTab,
  onCloseTab,
  onNewTab,
  headerIcon: HeaderIcon,
  headerLabel,
  renderTabIcon,
  tabMaxWidth = "max-w-20",
  activeClass = "bg-foreground/[0.08] text-foreground/90",
  inactiveClass = "text-foreground/40 hover:text-foreground/60 hover:bg-foreground/[0.04]",
  onReorderTabs,
  headerActions,
}: TabBarProps<T>) {
  const hasHeaderLabel = headerLabel.trim().length > 0;
  const [draggingTabId, setDraggingTabId] = useState<string | null>(null);
  const [dragOverTabId, setDragOverTabId] = useState<string | null>(null);
  const isDraggable = typeof onReorderTabs === "function" && tabs.length > 1;

  const handleDragStart = useCallback((e: React.DragEvent<HTMLButtonElement>, tabId: string) => {
    if (!onReorderTabs) return;
    e.dataTransfer.setData("text/plain", tabId);
    e.dataTransfer.effectAllowed = "move";
    setDraggingTabId(tabId);
  }, [onReorderTabs]);

  const handleDragOver = useCallback((e: React.DragEvent<HTMLButtonElement>, tabId: string) => {
    if (!onReorderTabs) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    setDragOverTabId((currentTabId) => (currentTabId === tabId ? currentTabId : tabId));
  }, [onReorderTabs]);

  const clearDragState = useCallback(() => {
    setDraggingTabId(null);
    setDragOverTabId(null);
  }, []);

  const handleDragLeave = useCallback((tabId: string) => {
    setDragOverTabId((currentTabId) => (currentTabId === tabId ? null : currentTabId));
  }, []);

  const handleDrop = useCallback((e: React.DragEvent<HTMLButtonElement>, toTabId: string) => {
    if (!onReorderTabs) return;
    e.preventDefault();
    const fromTabId = e.dataTransfer.getData("text/plain");
    clearDragState();
    if (fromTabId && fromTabId !== toTabId) {
      onReorderTabs(fromTabId, toTabId);
    }
  }, [clearDragState, onReorderTabs]);

  return (
    <div className="flex items-center gap-1 px-2 pt-2 pb-1">
      {/* Header icon + label */}
      <div className={`flex items-center ps-1.5 ${hasHeaderLabel ? "gap-1.5" : "gap-0"}`}>
        <HeaderIcon className="h-3 w-3 text-foreground/45" />
        {hasHeaderLabel && (
          <span className="text-[10px] font-semibold tracking-wider text-foreground/45 uppercase">{headerLabel}</span>
        )}
      </div>

      {/* Tabs */}
      <div className={`flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto scrollbar-none ${hasHeaderLabel ? "ms-2" : "ms-1"}`}>
        {tabs.map((tab) => {
          const isActiveTab = tab.id === activeTabId;
          const isDragTarget = dragOverTabId === tab.id && draggingTabId !== tab.id;
          const isDragging = draggingTabId === tab.id;
          return (
            <button
              key={tab.id}
              type="button"
              onClick={() => onSelectTab(tab.id)}
              draggable={isDraggable}
              onDragStart={(e) => handleDragStart(e, tab.id)}
              onDragOver={(e) => handleDragOver(e, tab.id)}
              onDragLeave={() => handleDragLeave(tab.id)}
              onDrop={(e) => handleDrop(e, tab.id)}
              onDragEnd={clearDragState}
              className={`group relative flex shrink-0 items-center gap-1.5 rounded-md px-2 py-1 text-[11px] font-medium transition-all duration-150 cursor-pointer ${
                isActiveTab ? activeClass : inactiveClass
              } ${isDragTarget ? "ring-1 ring-foreground/20" : ""} ${isDragging ? "opacity-55" : ""}`}
            >
              {renderTabIcon?.(tab)}
              <span className={`truncate ${tabMaxWidth}`}>{tab.label}</span>
              <span
                role="button"
                tabIndex={0}
                draggable={false}
                onClick={(e) => {
                  e.stopPropagation();
                  onCloseTab(tab.id);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.stopPropagation();
                    onCloseTab(tab.id);
                  }
                }}
                className="ms-0.5 rounded p-0.5 opacity-0 transition-opacity hover:bg-foreground/10 group-hover:opacity-100"
              >
                <X className="h-2.5 w-2.5" />
              </span>
              {/* Active tab bottom indicator */}
              {isActiveTab && (
                <span className="absolute inset-x-1.5 -bottom-px h-[1.5px] rounded-full bg-foreground/30" />
              )}
            </button>
          );
        })}
      </div>

      {headerActions && (
        <div className="flex shrink-0 items-center gap-0.5">
          {headerActions}
        </div>
      )}

      {/* New tab button */}
      <Button
        variant="ghost"
        size="icon"
        className="h-6 w-6 shrink-0 rounded-md text-foreground/30 transition-all duration-150 hover:bg-foreground/[0.06] hover:text-foreground/60"
        onClick={onNewTab}
      >
        <Plus className="h-3 w-3" />
      </Button>
    </div>
  );
}
