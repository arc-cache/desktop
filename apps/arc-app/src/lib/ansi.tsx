import { type ReactNode } from "react";

// ── ANSI SGR color map ──

const ANSI_FG: Record<number, string> = {
  30: "#6e6e6e", // black (brightened for dark bg)
  31: "#f87171", // red
  32: "#4ade80", // green
  33: "#facc15", // yellow
  34: "#60a5fa", // blue
  35: "#c084fc", // magenta
  36: "#22d3ee", // cyan
  37: "#d4d4d4", // white
  90: "#737373", // bright black (gray)
  91: "#fca5a5", // bright red
  92: "#86efac", // bright green
  93: "#fde68a", // bright yellow
  94: "#93c5fd", // bright blue
  95: "#d8b4fe", // bright magenta
  96: "#67e8f9", // bright cyan
  97: "#f5f5f5", // bright white
};

const ANSI_BG: Record<number, string> = {
  40: "#6e6e6e",
  41: "#f87171",
  42: "#4ade80",
  43: "#facc15",
  44: "#60a5fa",
  45: "#c084fc",
  46: "#22d3ee",
  47: "#d4d4d4",
  100: "#737373",
  101: "#fca5a5",
  102: "#86efac",
  103: "#fde68a",
  104: "#93c5fd",
  105: "#d8b4fe",
  106: "#67e8f9",
  107: "#f5f5f5",
};

interface AnsiStyle {
  color?: string;
  backgroundColor?: string;
  fontWeight?: string;
  fontStyle?: string;
  textDecoration?: string;
  opacity?: number;
}

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[([0-9;]*)m/g;

// Non-SGR escape sequences to strip (cursor movement, OSC, etc.)
// eslint-disable-next-line no-control-regex
const ANSI_OTHER_RE = /\x1b\[[0-9;]*[A-LN-Za-z]|\x1b\][^\x07]*(?:\x07|\x1b\\)|\x1b[()][A-Z0-9]|\x1b[A-Z@-_]/g;

function parseParams(raw: string): number[] {
  if (!raw) return [0];
  return raw.split(";").map((s) => parseInt(s, 10) || 0);
}

function applyParams(style: AnsiStyle, params: number[]): AnsiStyle {
  const next = { ...style };
  for (let i = 0; i < params.length; i++) {
    const p = params[i];
    if (p === 0) {
      // Reset
      return {};
    } else if (p === 1) {
      next.fontWeight = "bold";
    } else if (p === 2) {
      next.opacity = 0.6;
    } else if (p === 3) {
      next.fontStyle = "italic";
    } else if (p === 4) {
      next.textDecoration = "underline";
    } else if (p === 7) {
      // Reverse video — swap fg/bg
      const fg = next.color;
      const bg = next.backgroundColor;
      next.color = bg;
      next.backgroundColor = fg;
    } else if (p === 22) {
      delete next.fontWeight;
      delete next.opacity;
    } else if (p === 23) {
      delete next.fontStyle;
    } else if (p === 24) {
      delete next.textDecoration;
    } else if (p === 27) {
      // Reverse off — not tracked, just clear swap
    } else if (p === 39) {
      delete next.color;
    } else if (p === 49) {
      delete next.backgroundColor;
    } else if (ANSI_FG[p]) {
      next.color = ANSI_FG[p];
    } else if (ANSI_BG[p]) {
      next.backgroundColor = ANSI_BG[p];
    } else if (p === 38 && params[i + 1] === 5) {
      // 256-color foreground: ESC[38;5;{n}m — use as-is if in 0-15 range, skip otherwise
      const idx = params[i + 2];
      const mapped = ANSI_FG[30 + (idx % 8)] ?? ANSI_FG[90 + (idx % 8)];
      if (mapped) next.color = mapped;
      i += 2;
    } else if (p === 48 && params[i + 1] === 5) {
      const idx = params[i + 2];
      const mapped = ANSI_BG[40 + (idx % 8)] ?? ANSI_BG[100 + (idx % 8)];
      if (mapped) next.backgroundColor = mapped;
      i += 2;
    }
  }
  return next;
}

function hasStyle(style: AnsiStyle): boolean {
  return !!(style.color || style.backgroundColor || style.fontWeight || style.fontStyle || style.textDecoration || style.opacity);
}

/**
 * Parse ANSI escape sequences in text and return React elements with inline styles.
 * Non-color escapes (cursor, OSC) are stripped.
 */
export function renderAnsi(text: string): ReactNode {
  // Fast path: no escape sequences at all
  if (!text.includes("\x1b")) return text;

  // Strip non-SGR sequences first
  const cleaned = text.replace(ANSI_OTHER_RE, "");

  const parts: ReactNode[] = [];
  let style: AnsiStyle = {};
  let lastIndex = 0;
  let key = 0;

  ANSI_RE.lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = ANSI_RE.exec(cleaned)) !== null) {
    // Text before this escape
    if (match.index > lastIndex) {
      const chunk = cleaned.slice(lastIndex, match.index);
      if (hasStyle(style)) {
        parts.push(<span key={key++} style={style}>{chunk}</span>);
      } else {
        parts.push(chunk);
      }
    }
    // Apply the SGR params
    style = applyParams(style, parseParams(match[1]));
    lastIndex = match.index + match[0].length;
  }

  // Remaining text after last escape
  if (lastIndex < cleaned.length) {
    const chunk = cleaned.slice(lastIndex);
    if (hasStyle(style)) {
      parts.push(<span key={key++} style={style}>{chunk}</span>);
    } else {
      parts.push(chunk);
    }
  }

  return parts.length === 1 ? parts[0] : <>{parts}</>;
}
