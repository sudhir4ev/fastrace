import { useEffect, useMemo, useRef, useState } from "react";
import * as echarts from "echarts";
import { Plus, XIcon } from "lucide-react";
import { useWorkspaceStore } from "@/app/store";
import { LOD_CONFIG } from "@/app/config";
import { getSignalColor } from "@/app/signalColors";
import { useAnomalyBinsForViewport, useSignalCatalog } from "@/shared/api/hooks";
import { Button } from "@/shared/ui/button";
import { anomalyBinColor } from "./anomaly-bin-color";
import { createDebouncer } from "./debounce";
import { buildTimelineDiagnostics } from "./diagnostics";
import { shouldShowDots } from "./dot-visibility";
import { useSignalTileCache } from "./useSignalTileCache";
import { viewportFromZoomPercent } from "./viewport";

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
  onChartRemove?: (signalId: number) => void;
  onAddCharts?: () => void;
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

type Lane = { top: number; height: number; signalId: number; name: string; color: string };

export default function TimelineChart({
  blfPath,
  minTs,
  maxTs,
  onChartRemove,
  onAddCharts,
}: TimelineChartProps) {
  const activeSignalIds = Array.from(useWorkspaceStore((s) => s.activeSignalIds));
  const activeSignalKey = activeSignalIds.join(",");
  const catalog = useSignalCatalog(blfPath);
  const trimRange = useWorkspaceStore((s) => s.appliedTrimRange);
  const signalAlgorithms = useWorkspaceStore((s) => s.signalDownsamplingAlgorithms);

  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<echarts.ECharts | null>(null);

  const [viewport, setViewport] = useState<{ startUs: number; endUs: number; pixelWidth: number } | null>(null);
  const debouncerRef = useRef(
    createDebouncer(LOD_CONFIG.viewportDebounceMs, (startUs: number, endUs: number, pixelWidth: number) =>
      setViewport({ startUs, endUs, pixelWidth })
    )
  );

  const effectiveViewport = viewport ?? {
    startUs: trimRange?.start ?? 0,
    endUs: trimRange?.end ?? Number.MAX_SAFE_INTEGER,
    pixelWidth: LOD_CONFIG.defaultPixelWidthFallback,
  };
  // Per-signal tile cache (`docs/adr/0012`): a fixed time grid per
  // (signal, algorithm, tile size) - panning within the margin tiles is
  // free, a tile fetch only happens for the newly-entered tile(s), and a
  // zoom that crosses into a different tile size drops and refetches.
  // Trim Window changes invalidate.
  const samplesBySignal = useSignalTileCache(
    blfPath,
    activeSignalIds,
    effectiveViewport,
    signalAlgorithms,
    trimRange ? { startUs: trimRange.start, endUs: trimRange.end } : null
  );
  // Keyed off the SQL that actually ran, never the live editor draft - the
  // Anomaly Overlay is a Detector Query run's bins (CONTEXT.md), not a
  // per-keystroke recompute, and `detectorRanSql` is null until a query has
  // run at least once (the hook's own `enabled` check then stays false).
  const detectorRanSql = useWorkspaceStore((s) => s.detectorRanSql);
  const overlayBins = useAnomalyBinsForViewport(
    blfPath,
    detectorRanSql ?? "",
    effectiveViewport.startUs,
    effectiveViewport.endUs,
    effectiveViewport.pixelWidth
  );

  const lanes: Lane[] = useMemo(() => {
    let top = 0;
    const result: Lane[] = [];
    for (const signalId of activeSignalIds) {
      const colorIndex = (catalog.data ?? []).findIndex((c) => c.signalId === signalId);
      const name = catalog.data?.find((c) => c.signalId === signalId)?.name ?? `signal ${signalId}`;
      result.push({ top, height: SIGNAL_LANE_HEIGHT, signalId, name, color: getSignalColor(colorIndex) });
      top += SIGNAL_LANE_HEIGHT;
    }
    return result;
  }, [activeSignalKey, catalog.data]);

  const totalHeight = lanes.reduce((sum, l) => sum + l.height, 0) + BOTTOM_AXIS_HEIGHT;

  useEffect(() => {
    if (!containerRef.current) return;
    const chart = echarts.init(containerRef.current, undefined, { renderer: "canvas" });
    chart.group = CHART_GROUP;
    chartRef.current = chart;
    echarts.connect(CHART_GROUP);
    // Recomputes the debounced viewport (absolute [startUs,endUs] + pixel
    // width) that drives LOD-tiered sample/anomaly-overlay fetches - on
    // pan-end/zoom-change and on resize, not continuously mid-drag
    // (`docs/adr/0009`).
    const scheduleViewportUpdate = () => {
      const dz = currentDataZoom(chart) ?? useWorkspaceStore.getState().timelineZoomRange;
      const trim = useWorkspaceStore.getState().appliedTrimRange;
      if (!trim || !containerRef.current) return;
      const { startUs, endUs } = viewportFromZoomPercent(dz, trim);
      debouncerRef.current.call(startUs, endUs, containerRef.current.clientWidth);
    };

    // Persist the zoom/pan window (percent) so it survives signal add/remove
    // option rebuilds and panel remounts - fires for drags on this chart AND
    // on TimelineZoomControl's slider (CHART_GROUP sync re-dispatches here
    // too). Written via getState(), not the `useWorkspaceStore` hook, so a
    // drag doesn't trigger a React re-render on every frame.
    chart.on("dataZoom", () => {
      const dz = currentDataZoom(chart);
      if (dz) useWorkspaceStore.getState().setTimelineZoomRange(dz);
      scheduleViewportUpdate();
    });
    const resize = () => {
      chart.resize();
      scheduleViewportUpdate();
    };
    const ro = new ResizeObserver(resize);
    ro.observe(containerRef.current);
    window.addEventListener("resize", resize);
    requestAnimationFrame(resize);
    return () => {
      debouncerRef.current.cancel();
      ro.disconnect();
      window.removeEventListener("resize", resize);
      chart.dispose();
      chartRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    // Must clear the previous option when the last signal is removed - an
    // early return here left the old series painted on the canvas.
    if (lanes.length === 0) {
      chart.clear();
      return;
    }

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
    const xAxis = lanes.map((_lane, i) => ({
      type: "value" as const,
      gridIndex: i,
      min: minTs,
      max: maxTs,
      show: i === lanes.length - 1,
      axisLabel: { formatter: (v: number) => `${(v / 1_000_000).toFixed(1)}s` },
    }));

    const yAxis = lanes.map((lane, i) => {
      const data = samplesBySignal[lane.signalId] ?? [];
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
    });

    // Viewport-scoped, LOD-Tier-aware Anomaly Overlay (`docs/adr/0009`) -
    // distinct from TimelineZoomControl's fixed-500-bin heatmap, which keeps
    // reading the store's `anomalyBins` unchanged.
    const activeOverlayBins = overlayBins.data ?? [];
    const maxOverlayCount = activeOverlayBins.reduce((m, b) => Math.max(m, b.count), 0);
    const markAreaData =
      maxOverlayCount > 0
        ? activeOverlayBins.map((b) => [
            {
              xAxis: b.startUs,
              itemStyle: {
                color: anomalyBinColor(b.count / maxOverlayCount),
                opacity: LOD_CONFIG.anomalyMarkOpacity,
              },
            },
            { xAxis: b.endUs },
          ])
        : [];

    // The cache holds the viewport's tiles plus margin tiles on each side
    // (`docs/adr/0012`), so count only points inside the actual viewport
    // here - using the whole cached count would see the margin tiles' extra
    // density too and never switch out of line mode.
    const pointCounts: Record<number, number> = {};
    for (const lane of lanes) {
      const data = samplesBySignal[lane.signalId] ?? [];
      pointCounts[lane.signalId] = data.filter(
        ([ts]) => ts >= effectiveViewport.startUs && ts <= effectiveViewport.endUs
      ).length;
    }

    // Line by default; dots only reveal themselves once zoomed in enough
    // that individual points are actually spaced apart on screen - at low
    // zoom (many points packed into few pixels) a dense scatter is noise,
    // a line reads the signal's shape better.
    const series = lanes.map((lane, i) => ({
      type: "line" as const,
      name: lane.name,
      xAxisIndex: i,
      yAxisIndex: i,
      data: samplesBySignal[lane.signalId] ?? [],
      showSymbol: shouldShowDots(pointCounts[lane.signalId] ?? 0, effectiveViewport.pixelWidth),
      symbolSize: 4,
      large: true,
      itemStyle: { color: lane.color },
      lineStyle: { color: lane.color, width: 1 },
      // Vertical bands for every active anomaly bin, aligned to the shared
      // timestamp x-axis so they line up with the zoom-strip heatmap.
      markArea:
        markAreaData.length > 0
          ? { silent: true, data: markAreaData }
          : undefined,
    }));

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

    useWorkspaceStore.getState().setTimelineDiagnostics(
      buildTimelineDiagnostics({
        viewport: effectiveViewport,
        lanes,
        pointCounts,
        algorithms: signalAlgorithms,
        overlayBinCount: activeOverlayBins.length,
        overlayError: overlayBins.error ? String(overlayBins.error) : null,
      })
    );
  }, [lanes, samplesBySignal, minTs, maxTs, activeSignalKey, overlayBins.data, overlayBins.error]);

  // containerRef's div must stay mounted even with zero lanes - the init
  // effect below only runs once on mount ([] deps), so swapping it out for a
  // placeholder element when empty (and back when signals get added) would
  // leave echarts never initialized.
  return (
    <div className="flex h-full min-h-0 flex-col bg-slate-100">
      {onAddCharts && (
        <div className="flex shrink-0 items-center border-b border-border bg-background px-2 py-1.5">
          <Button type="button" size="sm" variant="outline" className="h-7 gap-1.5" onClick={onAddCharts}>
            <Plus className="size-3.5" />
            Add Signal
          </Button>
        </div>
      )}
      {overlayBins.error && (
        <div className="shrink-0 border-b border-destructive/50 bg-destructive/10 px-2 py-1 text-xs text-destructive">
          Anomaly overlay: {String(overlayBins.error)}
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="relative" style={{ height: lanes.length === 0 ? "100%" : totalHeight }}>
          {/* echarts sets inline cursor (pointer/move) on its zr root; !important wins */}
          <div ref={containerRef} className="absolute inset-0 [&_*]:!cursor-crosshair" />
          {lanes.length === 0 && (
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-sm text-muted-foreground">
              No signals displayed - click Add Signal to plot.
            </div>
          )}
          {lanes.map((lane) => (
            <div
              key={lane.signalId}
              className="absolute z-[1] flex items-start gap-1 px-2"
              style={{ top: lane.top + 4, left: 20 }}
            >
              <span
                className="whitespace-normal break-words text-xs font-medium font-mono capitalize tracking-wide underline"
                style={{ color: lane.color }}
              >
                {lane.name}
              </span>
              <select
                className="ml-1 rounded-sm border border-border bg-background text-[10px]"
                value={signalAlgorithms[lane.signalId] ?? "min_max"}
                onChange={(e) =>
                  useWorkspaceStore
                    .getState()
                    .setSignalDownsamplingAlgorithm(lane.signalId, e.target.value as "min_max" | "lttb")
                }
                aria-label={`Downsampling algorithm for ${lane.name}`}
              >
                <option value="min_max">Min/Max</option>
                <option value="lttb">LTTB</option>
              </select>
              {onChartRemove && (
                <button
                  type="button"
                  className="mt-0.5 rounded-sm text-muted-foreground opacity-70 hover:bg-background/80 hover:opacity-100"
                  aria-label={`Remove ${lane.name}`}
                  onClick={() => onChartRemove(lane.signalId)}
                >
                  <XIcon className="size-3.5" />
                </button>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
