import type { SignalCoverageEntry } from "@/shared/api/trace-source";

export const TRIM_BINS = 500;
export const DECODED_BAND = "#93c5fd"; // light blue - bins overlapping signal_coverage
export const UNREAD_BAND = "#d1d5db"; // grey - no cached samples in bin

export function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

export function binToUs(bin: number, minUs: number, maxUs: number): number {
  if (maxUs <= minUs) return minUs;
  return Math.round(minUs + (clamp(bin, 0, TRIM_BINS) / TRIM_BINS) * (maxUs - minUs));
}

export function usToBin(us: number, minUs: number, maxUs: number): number {
  if (maxUs <= minUs) return 0;
  return clamp(Math.round(((us - minUs) / (maxUs - minUs)) * TRIM_BINS), 0, TRIM_BINS);
}

export function binToPos(bin: number, messageCount: number): number {
  if (messageCount <= 1) return 1;
  return clamp(
    Math.round(1 + (clamp(bin, 0, TRIM_BINS) / TRIM_BINS) * (messageCount - 1)),
    1,
    messageCount
  );
}

export function posToBin(pos: number, messageCount: number): number {
  if (messageCount <= 1) return 0;
  return clamp(Math.round(((pos - 1) / (messageCount - 1)) * TRIM_BINS), 0, TRIM_BINS);
}

/** Merge overlapping [start_us, end_us] coverage intervals. */
export function mergeUsSpans(spans: Array<[number, number]>): Array<[number, number]> {
  if (spans.length === 0) return [];
  const sorted = [...spans].sort((a, b) => a[0] - b[0]);
  const out: Array<[number, number]> = [sorted[0]];
  for (let i = 1; i < sorted.length; i++) {
    const [a, b] = sorted[i];
    const last = out[out.length - 1];
    if (a <= last[1] + 1) {
      last[1] = Math.max(last[1], b);
    } else {
      out.push([a, b]);
    }
  }
  return out;
}

/**
 * Paint a bin blue iff its time span overlaps any signal_coverage interval.
 * Always maps via full-trace timestamp_us → bin so cache bands stay on the
 * whole rail, not the selected trim window.
 */
export function binBandsFromCoverageUs(
  spans: Array<[number, number]>,
  minUs: number,
  maxUs: number
): Array<[number, number]> {
  if (spans.length === 0) return [];
  const occupied = new Array<boolean>(TRIM_BINS).fill(false);
  for (let i = 0; i < TRIM_BINS; i++) {
    const lo = binToUs(i, minUs, maxUs);
    const hi = binToUs(i + 1, minUs, maxUs);
    for (const [a, b] of spans) {
      if (a <= hi && b >= lo) {
        occupied[i] = true;
        break;
      }
    }
  }
  const merged: Array<[number, number]> = [];
  let runStart: number | null = null;
  for (let i = 0; i < TRIM_BINS; i++) {
    if (occupied[i]) {
      if (runStart == null) runStart = i;
    } else if (runStart != null) {
      merged.push([runStart, i]);
      runStart = null;
    }
  }
  if (runStart != null) merged.push([runStart, TRIM_BINS]);
  return merged;
}

export function coverageSpansForActive(
  rows: SignalCoverageEntry[],
  activeIds: Set<number>
): Array<[number, number]> {
  const filtered =
    activeIds.size === 0 ? rows : rows.filter((r) => activeIds.has(r.signalId));
  return mergeUsSpans(filtered.map((r) => [r.startUs, r.endUs] as [number, number]));
}

export type TrimRailMarkArea = Array<
  [{ xAxis: number; itemStyle: { color: string } }, { xAxis: number }]
>;

/** ECharts option for the trim rail: fixed band axis + separate brush axis. */
export function buildTrimRailOption(bands: Array<[number, number]>) {
  const markAreaData: TrimRailMarkArea = [
    [{ xAxis: 0, itemStyle: { color: UNREAD_BAND } }, { xAxis: TRIM_BINS }],
    ...bands.map(
      ([a, b]) =>
        [
          { xAxis: a, itemStyle: { color: DECODED_BAND } },
          { xAxis: b },
        ] as [{ xAxis: number; itemStyle: { color: string } }, { xAxis: number }]
    ),
  ];

  return {
    animation: false as const,
    grid: { left: 4, right: 4, top: 4, bottom: 4 },
    // Axis 0 = cache bands (never zoomed). Axis 1 = brush only.
    xAxis: [
      { type: "value" as const, min: 0, max: TRIM_BINS, show: false, gridIndex: 0 },
      { type: "value" as const, min: 0, max: TRIM_BINS, show: false, gridIndex: 0 },
    ],
    yAxis: { type: "value" as const, min: 0, max: 1, show: false },
    dataZoom: [
      {
        type: "slider" as const,
        xAxisIndex: 1,
        height: "80%",
        top: "10%",
        filterMode: "none" as const,
        brushSelect: false,
        showDetail: false,
        zoomLock: false,
        backgroundColor: "transparent",
        fillerColor: "rgba(15, 23, 42, 0.18)",
        borderColor: "#475569",
        handleStyle: { color: "#1e293b", borderColor: "#0f172a" },
        handleSize: "100%",
        dataBackground: {
          lineStyle: { opacity: 0 },
          areaStyle: { opacity: 0 },
        },
        selectedDataBackground: {
          lineStyle: { opacity: 0 },
          areaStyle: { opacity: 0 },
        },
      },
    ],
    series: [
      {
        type: "line" as const,
        xAxisIndex: 0,
        data: [
          [0, 0.5],
          [TRIM_BINS, 0.5],
        ],
        symbol: "none" as const,
        lineStyle: { opacity: 0 },
        silent: true,
        markArea: {
          silent: true,
          data: markAreaData,
        },
      },
      {
        type: "line" as const,
        xAxisIndex: 1,
        data: [
          [0, 0],
          [TRIM_BINS, 0],
        ],
        symbol: "none" as const,
        lineStyle: { opacity: 0 },
        silent: true,
      },
    ],
  };
}
