import type { DownsamplingAlgorithm } from "@/shared/api/trace-source";

export interface TimelineSignalDiagnostics {
  signalId: number;
  name: string;
  algorithm: DownsamplingAlgorithm;
  pointCount: number;
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
    signals: args.lanes.map((lane) => ({
      signalId: lane.signalId,
      name: lane.name,
      algorithm: args.algorithms[lane.signalId] ?? "min_max",
      pointCount: args.pointCounts[lane.signalId] ?? 0,
    })),
    overlayBinCount: args.overlayBinCount,
    overlayError: args.overlayError,
  };
}
