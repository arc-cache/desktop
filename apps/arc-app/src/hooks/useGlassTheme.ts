/**
 * Glass theme and chat fade computations.
 *
 * Extracts all visual surface/gradient calculations from AppLayout:
 * - Glass state detection (isGlassActive, isLightGlass, isNativeGlass)
 * - Chat surface colors and titlebar gradients
 * - Top/bottom fade backgrounds
 * - Chat fade strength
 */

import { useMemo } from "react";
import { isMac } from "@/lib/utils";

export interface GlassThemeInput {
  isGlassSupported: boolean;
  transparency: boolean;
  resolvedTheme: string;
  liveMacBackgroundEffect: string;
  isIsland: boolean;
  spaceOpacity: number;
}

export interface GlassThemeResult {
  isGlassActive: boolean;
  isLightGlass: boolean;
  isNativeGlass: boolean;
  chatFadeStrength: number;
  chatSurfaceColor: string;
  titlebarSurfaceColor: string;
  topFadeBackground: string;
  bottomFadeBackground: string;
}

export function useGlassTheme(input: GlassThemeInput): GlassThemeResult {
  return useMemo(() => {
    const isGlassActive = input.isGlassSupported && input.transparency;
    const isLightGlass = isGlassActive && input.resolvedTheme !== "dark";
    const isNativeGlass = isGlassActive && isMac && input.liveMacBackgroundEffect === "liquid-glass";
    const isIsland = input.isIsland;
    const spaceOpacity = input.spaceOpacity;

    const chatFadeStrength = Math.max(0.2, Math.min(1, spaceOpacity));

    const chatSurfaceColor = isLightGlass
      ? "color-mix(in oklab, white 97%, var(--background) 3%)"
      : "var(--background)";

    const titlebarOpacity = isLightGlass
      ? Math.round(69 + 14 * spaceOpacity)
      : Math.round(23 + 35 * spaceOpacity);
    const topFadeShadowOpacity = isLightGlass
      ? Math.round(13 + 15 * spaceOpacity)
      : Math.round(21 + 26 * spaceOpacity);

    const titlebarSurfaceColor =
      `linear-gradient(to bottom, color-mix(in oklab, ${chatSurfaceColor} ${titlebarOpacity}%, transparent) 0%, color-mix(in oklab, ${chatSurfaceColor} ${Math.max(titlebarOpacity - 3, 23)}%, transparent) 34%, color-mix(in oklab, ${chatSurfaceColor} ${Math.max(titlebarOpacity - 14, 11)}%, transparent) 68%, transparent 100%)`;

    const topFadeBackground = isIsland
      ? `linear-gradient(to bottom, color-mix(in oklab, ${chatSurfaceColor} 100%, black 4.5%) 0%, color-mix(in oklab, ${chatSurfaceColor} 97.5%, black 1.75%) 18%, color-mix(in oklab, ${chatSurfaceColor} 93.5%, transparent) 48%, transparent 100%), radial-gradient(138% 88% at 50% 0%, color-mix(in srgb, black ${topFadeShadowOpacity}%, transparent) 0%, transparent 70%)`
      : `linear-gradient(to bottom, ${chatSurfaceColor} 0%, ${chatSurfaceColor} 34%, color-mix(in oklab, ${chatSurfaceColor} 90.5%, transparent) 60%, transparent 100%), radial-gradient(142% 92% at 50% 0%, color-mix(in srgb, black ${topFadeShadowOpacity}%, transparent) 0%, transparent 72%)`;

    const bottomFadeBackground = `linear-gradient(to top, ${chatSurfaceColor}, transparent)`;

    return {
      isGlassActive,
      isLightGlass,
      isNativeGlass,
      chatFadeStrength,
      chatSurfaceColor,
      titlebarSurfaceColor,
      topFadeBackground,
      bottomFadeBackground,
    };
  }, [
    input.isGlassSupported,
    input.transparency,
    input.resolvedTheme,
    input.liveMacBackgroundEffect,
    input.isIsland,
    input.spaceOpacity,
  ]);
}
