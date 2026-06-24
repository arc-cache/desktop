/**
 * Manages layout animation cooldown during space switches.
 *
 * When the user switches spaces, Framer Motion layout animations must be
 * temporarily disabled to prevent jank while panels mount/unmount and
 * flex layout recalculates. This hook tracks space changes and enforces
 * a 150ms cooldown before re-enabling animations.
 */

import { useEffect, useLayoutEffect, useRef, useState } from "react";

interface UseSpaceSwitchCooldownOptions {
  activeSpaceId: string;
  isSpaceSwitching: boolean;
  isCrossSpaceSessionVisible: boolean;
}

interface UseSpaceSwitchCooldownReturn {
  spaceSwitchLayoutCooldown: boolean;
  hasSpaceChangedThisRender: boolean;
}

export function useSpaceSwitchCooldown({
  activeSpaceId,
  isSpaceSwitching,
  isCrossSpaceSessionVisible,
}: UseSpaceSwitchCooldownOptions): UseSpaceSwitchCooldownReturn {
  const previousRenderedSpaceIdRef = useRef(activeSpaceId);
  const [spaceSwitchLayoutCooldown, setSpaceSwitchLayoutCooldown] = useState(false);
  const hasSpaceChangedThisRender = previousRenderedSpaceIdRef.current !== activeSpaceId;

  useLayoutEffect(() => {
    if (!hasSpaceChangedThisRender) return;
    previousRenderedSpaceIdRef.current = activeSpaceId;
    setSpaceSwitchLayoutCooldown(true);
  }, [hasSpaceChangedThisRender, activeSpaceId]);

  useEffect(() => {
    if (!spaceSwitchLayoutCooldown || isSpaceSwitching || isCrossSpaceSessionVisible) {
      return;
    }

    // Use a 150ms timeout instead of 2 rAF frames to ensure the DOM has fully
    // settled (panels mounted/unmounted, flex layout recalculated) before
    // re-enabling Framer Motion layout animations.
    const timer = setTimeout(() => {
      setSpaceSwitchLayoutCooldown(false);
    }, 150);

    return () => clearTimeout(timer);
  }, [isCrossSpaceSessionVisible, isSpaceSwitching, spaceSwitchLayoutCooldown]);

  return { spaceSwitchLayoutCooldown, hasSpaceChangedThisRender };
}
