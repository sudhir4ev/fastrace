import { useEffect, useMemo, useRef } from "react";
import * as echarts from "echarts";
import { useWorkspaceStore } from "@/app/store";
import { getSignalColor } from "@/app/signalColors";
import { useSignalCatalog, useSignalSamplesList } from "@/shared/api/hooks";

const MATCH_COLOR = "#e34948"; // PALETTE[5] - red, distinct from signal colors, reads as "flagged"
const MATCH_SERIES_NAME = "Matches";

const MATCH_LANE_HEIGHT = 64;
const SIGNAL_LANE_HEIGHT = 100;
const LANE_TOP_PAD = 28; // space at the top of each lane for the name label, above the grid
const LANE_BOTTOM_PAD = 10;
const BOTTOM_AXIS_HEIGHT = 24; // room for the shared xAxis's tick labels, under the last lane

// Shared echarts "group" id - TimelineZoomControl is a second, separate
// echarts instance (rendered pinned outside this component's scroll
// region) whose dataZoom slider stays in sync with this chart's via
// echarts.connect(), the same group-based mechanism used across all member
// instances regardless of how many grids/axes each one has.
export const CHART_GROUP = "timeline-signals";

interface TimelineChartProps {
  blfPath: string;
  // Trace-wide [min, max] timestamp_us (useTraceTimeRange) - pins every
  // lane's xAxis to the same absolute domain instead of each auto-scaling to
  // its own data's extent, which is what makes a single shared dataZoom
  // slider meaningful across lanes of very different signals.
  minTs?: number;
  maxTs?: number;
}

// Spreading into Math.min/max blows V8's call-stack limit well before real
// trace sizes (signal_stats found signals with 195k+ samples in this
// project's own traces) - a manual reduce has no such ceiling.
function minMax(values: number[]): [number, number] {
  let min = Infinity;
  let max = -Infinity;
  for (const v of values) {
    if (v < min) min = v;
    if (v > max) max = v;
  }
  return [min, max];
}

// `chart.getOption()` returns `undefined` (not `{}`) before any `setOption`
// call has ever happened on this instance - guard both the no-option-yet
// case and the dataZoom-absent case here once, instead of at each call site.
function currentDataZoom(chart: echarts.ECharts): { start: number; end: number } | undefined {
  const option = chart.getOption() as { dataZoom?: Array<{ start: number; end: number }> } | undefined;
  return option?.dataZoom?.[0];
}

type Lane =
  | { kind: "match"; top: number; height: number }
  | { kind: "signal"; top: number; height: number; signalId: number; name: string; color: string };

export default function TimelineChart({ blfPath, minTs, maxTs }: TimelineChartProps) {
  const displayedSignalIds = Array.from(useWorkspaceStore((s) => s.displayedSignalIds));
  const detectorMatches = useWorkspaceStore((s) => s.detectorMatches);
  const detectorQueryHasRun = useWorkspaceStore((s) => s.detectorQueryHasRun);
  const setSelectedMessage = useWorkspaceStore((s) => s.setSelectedMessage);
  const catalog = useSignalCatalog(blfPath);
  const samples = useSignalSamplesList(blfPath, displayedSignalIds);

  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<echarts.ECharts | null>(null);
  // The click handler is registered once (init effect has no dependency
  // array reruns) but needs the *current* matches array on every click, not
  // the one from whenever `chart.on` was called - this ref is kept current
  // by the option-building effect and read inside the closure instead.
  const matchesRef = useRef(detectorMatches);
  matchesRef.current = detectorMatches;

  const lanes: Lane[] = useMemo(() => {
    let top = 0;
    const result: Lane[] = [];
    if (detectorQueryHasRun) {
      result.push({ kind: "match", top, height: MATCH_LANE_HEIGHT });
      top += MATCH_LANE_HEIGHT;
    }
    for (const signalId of displayedSignalIds) {
      const colorIndex = (catalog.data ?? []).findIndex((c) => c.signalId === signalId);
      const name = catalog.data?.find((c) => c.signalId === signalId)?.name ?? `signal ${signalId}`;
      result.push({ kind: "signal", top, height: SIGNAL_LANE_HEIGHT, signalId, name, color: getSignalColor(colorIndex) });
      top += SIGNAL_LANE_HEIGHT;
    }
    return result;
  }, [detectorQueryHasRun, displayedSignalIds.join(","), catalog.data]);

  const totalHeight = lanes.reduce((sum, l) => sum + l.height, 0) + BOTTOM_AXIS_HEIGHT;

  useEffect(() => {
    if (!containerRef.current) return;
    const chart = echarts.init(containerRef.current, undefined, { renderer: "canvas" });
    chart.group = CHART_GROUP;
    chartRef.current = chart;
    echarts.connect(CHART_GROUP);
    chart.on("click", (params) => {
      if (params.seriesName !== MATCH_SERIES_NAME) return;
      const msgId = matchesRef.current[params.dataIndex]?.msgId;
      if (msgId !== undefined) setSelectedMessage(msgId);
    });
    // Persist the zoom/pan window (percent) so it survives signal add/remove
    // option rebuilds and panel remounts - fires for drags on this chart AND
    // on TimelineZoomControl's slider (CHART_GROUP sync re-dispatches here
    // too). Written via getState(), not the `useWorkspaceStore` hook, so a
    // drag doesn't trigger a React re-render on every frame.
    chart.on("dataZoom", () => {
      const dz = currentDataZoom(chart);
      if (dz) useWorkspaceStore.getState().setTimelineZoomRange(dz);
    });
    const resize = () => chart.resize();
    window.addEventListener("resize", resize);
    return () => {
      window.removeEventListener("resize", resize);
      chart.dispose();
      chartRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const chart = chartRef.current;
    if (!chart || lanes.length === 0) return;

    // `setOption(..., true)` below is a full replace, which would otherwise
    // reset the zoom window to 0-100% on every signal add/remove - preferring
    // the chart's own current dataZoom (if it already has one from a prior
    // render) over the store keeps an in-progress zoom/pan intact across
    // that rebuild; the store value only matters on this chart's first ever
    // option (e.g. right after a panel remount).
    const { start, end } = currentDataZoom(chart) ?? useWorkspaceStore.getState().timelineZoomRange;

    const grid = lanes.map((lane) => ({
      left: 80,
      right: 20,
      top: lane.top + LANE_TOP_PAD,
      height: lane.height - LANE_TOP_PAD - LANE_BOTTOM_PAD,
    }));

    // Raw samples are [timestampUs, physValue] pairs (trace-source.ts) - a
    // `time` xAxis would misinterpret microseconds as epoch milliseconds, so
    // this uses a `value` axis with seconds-from-zero tick labels instead of
    // calendar dates. Every lane's xAxis carries the identical pinned
    // min/max; only the bottom-most one renders ticks - this is the one
    // shared timeline, split across grids only because echarts ties an axis
    // to a grid via gridIndex.
    const xAxis = lanes.map((lane, i) => ({
      type: "value" as const,
      gridIndex: i,
      min: minTs,
      max: maxTs,
      show: i === lanes.length - 1,
      axisLabel: { formatter: (v: number) => `${(v / 1_000_000).toFixed(1)}s` },
    }));

    const yAxis = lanes.map((lane, i) =>
      lane.kind === "match"
        ? { type: "value" as const, gridIndex: i, show: false, min: -1, max: 1 }
        : (() => {
            const data = samples[displayedSignalIds.indexOf(lane.signalId)]?.data ?? [];
            const values = data.map(([, v]: [number, number]) => v);
            const [min, max] = values.length ? minMax(values) : [0, 1];
            const pad = (max - min) * 0.1 || 1;
            return {
              type: "value" as const,
              gridIndex: i,
              min: min - pad,
              max: max + pad,
              splitNumber: 2, // fewer y-axis ticks now that lanes are shorter (150px)
              axisLabel: { formatter: (v: number) => v.toFixed(3) },
              splitLine: { show: false },
            };
          })()
    );

    const series = lanes.map((lane, i) =>
      lane.kind === "match"
        ? {
            type: "scatter" as const,
            name: MATCH_SERIES_NAME,
            xAxisIndex: i,
            yAxisIndex: i,
            data: detectorMatches.map((m) => [m.timestampUs, 0]),
            symbolSize: 8,
            itemStyle: { color: MATCH_COLOR },
            large: true,
            tooltip: {
              trigger: "item" as const,
              formatter: (p: { data: [number, number]; dataIndex: number }) =>
                `msg_id: ${detectorMatches[p.dataIndex]?.msgId}<br/>t: ${(p.data[0] / 1_000_000).toFixed(3)}s`,
            },
          }
        : {
            type: "line" as const,
            name: lane.name,
            xAxisIndex: i,
            yAxisIndex: i,
            data: samples[displayedSignalIds.indexOf(lane.signalId)]?.data ?? [],
            showSymbol: false,
            large: true,
            sampling: "lttb" as const,
            lineStyle: { color: lane.color, width: 2 },
            areaStyle: { color: lane.color, opacity: 0.15 },
          }
    );

    chart.setOption(
      {
        animation: false,
        grid,
        xAxis,
        yAxis,
        tooltip: { trigger: "axis" },
        // No slider here - TimelineZoomControl renders it pinned outside
        // this component's scrollable region and stays in sync via
        // CHART_GROUP, so it can't be scrolled out of view when the lanes'
        // combined height exceeds the panel. `inside` still spans every
        // grid's xAxis so ctrl+wheel/drag over any single lane zooms the
        // whole timeline, not just that lane.
        dataZoom: [
          { type: "inside", xAxisIndex: "all", start, end, zoomOnMouseWheel: "ctrl", moveOnMouseWheel: true, moveOnMouseMove: true },
        ],
        series,
      },
      true
    );
    // The container's layout isn't guaranteed final at echarts.init() time
    // (it mounts inside a scroll region, possibly before a scrollbar
    // settles) - calling resize() here, once data has actually loaded and
    // the component has painted, catches it stuck at whatever size it was
    // wrongly measured at on init.
    chart.resize();
  }, [lanes, samples, detectorMatches, minTs, maxTs, displayedSignalIds]);

  // containerRef's div must stay mounted even with zero lanes - the init
  // effect below only runs once on mount ([] deps), so swapping it out for a
  // placeholder element when empty (and back when signals get added) would
  // leave echarts never initialized.
  return (
    <div className="h-full min-h-0 overflow-y-auto bg-slate-100">
      <div className="relative" style={{ height: lanes.length === 0 ? "100%" : totalHeight }}>
        <div ref={containerRef} className="absolute inset-0" />
        {lanes.length === 0 && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-sm text-muted-foreground">
            No signals displayed - click a pill above to plot a decoded signal.
          </div>
        )}
        {lanes
          .filter((l): l is Extract<Lane, { kind: "signal" }> => l.kind === "signal")
          .map((lane) => (
            <div
              key={lane.signalId}
              className="pointer-events-none absolute whitespace-normal break-words px-2 text-xs underline font-medium font-mono capitalize tracking-wide"
              style={{ top: lane.top, left: 20, color: lane.color }}
            >
              {lane.name}
            </div>
          ))}
      </div>
    </div>
  );
}
