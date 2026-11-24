import { LOD_CONFIG } from "@/app/config";
import type { DownsamplingAlgorithm } from "@/shared/api/trace-source";
import { shouldShowDots } from "./dot-visibility";
import { tileSpanUs } from "./signal-tile-cache";

export interface TimelineSignalDiagnostics {
  signalId: number;
  name: string;
  algorithm: DownsamplingAlgorithm;
  pointCount: number;
  showingDots: boolean;
  // Microseconds of real trace time each rendered point represents, on
  // average (viewport span / point count) - the direct answer to "is the
  // LOD tier actually getting coarser as I zoom out?" This grows as the
  // viewport widens even though pointCount itself stays roughly constant
  // (docs/adr/0012 pegs the point budget to pixel width, not zoom span) -
  // that growth IS the stronger downsampling. Null when there's nothing
  // rendered yet to measure.
  avgSampleIntervalUs: number | null;
}

export interface TimelineDiagnostics {
  viewport: { startUs: number; endUs: number; pixelWidth: number; tileSpanUs: number };
  signals: TimelineSignalDiagnostics[];
  overlayBinCount: number;
  overlayError: string | null;
}

// Pure so the LOD Diagnostics panel's data shape is unit-testable without
// echarts/DOM - TimelineChart just calls this with values it already has.
export function buildTimelineDiagnostics(args: {
  viewport: { startUs: number; endUs: number; pixelWidth: number };
  lanes: { signalId: number; name: string }[];
  pointCounts: Record<number, number>;
  algorithms: Record<number, DownsamplingAlgorithm>;
  overlayBinCount: number;
  overlayError: string | null;
}): TimelineDiagnostics {
  const viewportSpanUs = args.viewport.endUs - args.viewport.startUs;
  return {
    viewport: { ...args.viewport, tileSpanUs: tileSpanUs(viewportSpanUs, LOD_CONFIG.tileSpanRatio) },
    signals: args.lanes.map((lane) => {
      const pointCount = args.pointCounts[lane.signalId] ?? 0;
      return {
        signalId: lane.signalId,
        name: lane.name,
        algorithm: args.algorithms[lane.signalId] ?? "min_max",
        pointCount,
        showingDots: shouldShowDots(pointCount, args.viewport.pixelWidth),
        avgSampleIntervalUs: pointCount > 0 ? viewportSpanUs / pointCount : null,
      };
    }),
    overlayBinCount: args.overlayBinCount,
    overlayError: args.overlayError,
  };
}
