import type { DownsamplingAlgorithm } from "@/shared/api/trace-source";
import { shouldShowDots } from "./dot-visibility";

export interface TimelineSignalDiagnostics {
  signalId: number;
  name: string;
  algorithm: DownsamplingAlgorithm;
  pointCount: number;
  showingDots: boolean;
}

export interface TimelineDiagnostics {
  viewport: { startUs: number; endUs: number; pixelWidth: number };
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
  return {
    viewport: args.viewport,
    signals: args.lanes.map((lane) => {
      const pointCount = args.pointCounts[lane.signalId] ?? 0;
      return {
        signalId: lane.signalId,
        name: lane.name,
        algorithm: args.algorithms[lane.signalId] ?? "min_max",
        pointCount,
        showingDots: shouldShowDots(pointCount, args.viewport.pixelWidth),
      };
    }),
    overlayBinCount: args.overlayBinCount,
    overlayError: args.overlayError,
  };
}
