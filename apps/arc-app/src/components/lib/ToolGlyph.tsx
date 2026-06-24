import type { LucideIcon } from "lucide-react";

interface ToolGlyphProps {
  Icon: LucideIcon;
  className?: string;
}

/**
 * Lucide icons use a 24x24 viewBox. Rendering them directly at 13px causes
 * uneven subpixel rasterization, which makes some glyphs look vertically off
 * even when the SVG box is technically centered. A fixed 16px slot with a
 * 12px glyph keeps row alignment stable, matches a 16px line box, and gives
 * the icon a pixel-friendly size.
 */
export function ToolGlyph({ Icon, className }: ToolGlyphProps) {
  return (
    <span className="inline-grid h-4 w-4 shrink-0 place-items-center leading-none">
      <Icon size={12} className={`block ${className ?? ""}`} />
    </span>
  );
}
