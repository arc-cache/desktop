import { memo } from "react";
import { motion } from "motion/react";

interface PanelDockPreviewProps {
  orientation: "vertical" | "horizontal";
  label?: string;
  className?: string;
}

export const PanelDockPreview = memo(function PanelDockPreview({
  orientation,
  label,
  className = "",
}: PanelDockPreviewProps) {
  const content = label ? (
    <span className="max-w-[180px] truncate text-[11px] font-medium text-primary/50">
      {label}
    </span>
  ) : null;

  return (
    <motion.div
      layout
      transition={{ type: "spring", stiffness: 380, damping: 34, mass: 0.65 }}
      className={`flex shrink-0 items-center justify-center rounded-[var(--island-radius)] border-2 border-dashed border-primary/30 bg-primary/[0.03] ${className}`}
    >
      {orientation === "vertical" ? (
        <div className="flex min-h-11 w-full items-center justify-center px-3 py-2">
          {content}
        </div>
      ) : (
        <div className="flex min-w-[160px] items-center justify-center px-4 py-3">
          {content}
        </div>
      )}
    </motion.div>
  );
});
