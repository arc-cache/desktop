interface ProjectSidebarArrowXOptions {
  offset: number;
  tipX: number;
  tailX: number;
  usableWidth: number;
  baseSpan: number;
  maxOffset: number;
  rightInset: number;
}

export function projectSidebarArrowX({
  offset,
  tipX,
  tailX,
  usableWidth,
  baseSpan,
  maxOffset,
  rightInset,
}: ProjectSidebarArrowXOptions): number {
  const span = Math.max(tailX - tipX, 0);
  if (offset <= baseSpan || maxOffset <= baseSpan) {
    return tipX + (offset / baseSpan) * span;
  }

  const originalMaxCurveX = tipX + (maxOffset / baseSpan) * span;
  const curveMaxX = Math.max(
    tailX,
    Math.min(usableWidth - rightInset, originalMaxCurveX),
  );
  const overshootProgress = (offset - baseSpan) / (maxOffset - baseSpan);

  return tailX + overshootProgress * (curveMaxX - tailX);
}
