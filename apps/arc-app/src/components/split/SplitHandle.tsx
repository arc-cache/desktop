/**
 * SplitHandle — vertical draggable divider between two split view panes.
 *
 * Uses the same visual pattern as the existing resize handles in the app
 * (subtle pill indicator, hover/active states). Supports double-click to
 * reset to 50/50 split.
 */

import { memo } from "react";

interface SplitHandleProps {
  /** Whether island layout mode is active (affects gap sizing). */
  isIsland: boolean;
  /** Whether any resize is in progress (for visual feedback). */
  isResizing: boolean;
  /** Called when drag starts — returns a handler for mouse move. */
  onResizeStart: (e: React.MouseEvent) => void;
  /** Called on double-click to reset split to 50/50. */
  onDoubleClick: () => void;
}

export const SplitHandle = memo(function SplitHandle({
  isIsland,
  isResizing,
  onResizeStart,
  onDoubleClick,
}: SplitHandleProps) {
  return (
    <div
      className="resize-col group flex w-2 shrink-0 cursor-col-resize items-center justify-center"
      style={isIsland ? { width: "var(--island-panel-gap)" } : undefined}
      onMouseDown={onResizeStart}
      onDoubleClick={onDoubleClick}
    >
      <div
        className={`h-10 w-0.5 rounded-full transition-colors duration-150 ${
          isResizing
            ? "bg-foreground/40"
            : "bg-transparent group-hover:bg-foreground/25"
        }`}
      />
    </div>
  );
});
