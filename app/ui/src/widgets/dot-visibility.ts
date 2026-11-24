import { LOD_CONFIG } from "@/app/config";

// Dots are only visually distinguishable once rendered points are spaced
// far enough apart on screen - below that spacing a line is clearer than
// overlapping scatter symbols, so the chart defaults to a line and only
// reveals dots once the user has zoomed in enough to space points out.
export function shouldShowDots(
  pointCount: number,
  pixelWidth: number,
  minPixelsPerPoint: number = LOD_CONFIG.minPixelsPerPointForDots
): boolean {
  if (pointCount <= 1) return true;
  const avgSpacingPx = pixelWidth / pointCount;
  return avgSpacingPx >= minPixelsPerPoint;
}
