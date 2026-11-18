import { useEffect, useRef } from "react";
import * as echarts from "echarts";
import { TIMELINE_SAMPLE_LIMIT, useSignalSamples } from "@/shared/api/hooks";

interface SignalChartProps {
  blfPath: string;
  signalId: number;
  name: string;
  color: string;
  // Trace-wide [min, max] timestamp_us (useTraceTimeRange) - pins this
  // chart's xAxis to the same absolute domain every other CHART_GROUP chart
  // uses, instead of auto-scaling to just this signal's own sample extent.
  // Undefined while the range is still loading; falls back to auto-scale.
  minTs?: number;
  maxTs?: number;
}

// Shared echarts "group" id - instances in the same group have their
// dataZoom/tooltip crosshair kept in sync by echarts.connect(), which is how
// separate chart instances (including the single pinned zoom control in
// TimelineZoomControl) still pan/zoom/hover together.
export const CHART_GROUP = "timeline-signals";

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

export default function SignalChart({ blfPath, signalId, name, color, minTs, maxTs }: SignalChartProps) {
  const samples = useSignalSamples(blfPath, signalId, TIMELINE_SAMPLE_LIMIT);
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<echarts.ECharts | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;
    const chart = echarts.init(containerRef.current);
    chart.group = CHART_GROUP;
    chartRef.current = chart;
    echarts.connect(CHART_GROUP);
    const resize = () => chart.resize();
    window.addEventListener("resize", resize);
    return () => {
      window.removeEventListener("resize", resize);
      chart.dispose();
      chartRef.current = null;
    };
  }, []);

  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;

    const values = (samples.data ?? []).map(([, v]) => v);
    const [min, max] = values.length ? minMax(values) : [0, 1];
    const pad = (max - min) * 0.1 || 1;

    chart.setOption(
      {
        animation: false,
        // left has buffer room beyond what a 3-decimal label needs so a
        // signal with an unusually wide value (e.g. a large integer part)
        // doesn't shift its own grid relative to every other chart's fixed
        // left offset - that mismatch is what read as "this chart has a gap".
        grid: { left: 80, right: 20, top: 10, bottom: 10 },
        // Raw samples are [timestampUs, physValue] pairs (trace-source.ts) -
        // a `time` xAxis would misinterpret microseconds as epoch
        // milliseconds, so this uses a `value` axis with seconds-from-zero
        // tick labels instead of calendar dates.
        xAxis: {
          type: "value",
          min: minTs,
          max: maxTs,
          axisLabel: { formatter: (v: number) => `${(v / 1_000_000).toFixed(1)}s` },
        },
        yAxis: {
          type: "value",
          min: min - pad,
          max: max + pad,
          axisLabel: { formatter: (v: number) => v.toFixed(3) },
          splitLine: { show: false },
        },
        tooltip: { trigger: "axis" },
        // A dataZoom component still has to exist on this chart for
        // echarts.connect() to have something to apply the synced range to
        // when TimelineZoomControl's slider moves - removing it entirely
        // broke that sync. Disabling the wheel/drag triggers (not the
        // component) is what stops scrolling over a chart from hijacking
        // the page's vertical scroll, while the pinned slider keeps working.
        dataZoom: [{ type: "inside", zoomOnMouseWheel: false, moveOnMouseWheel: false, moveOnMouseMove: false }],
        series: [
          {
            type: "line",
            name,
            data: samples.data ?? [],
            showSymbol: false,
            large: true,
            sampling: "lttb",
            lineStyle: { color, width: 2 },
            areaStyle: { color, opacity: 0.15 },
          },
        ],
      },
      true
    );
    // The container's layout isn't guaranteed final at echarts.init() time
    // (it mounts inside a flex column, possibly before a scrollbar or a
    // sibling chart's height settles) - calling resize() here, once data has
    // actually loaded and the component has painted, catches it stuck at
    // whatever width it was wrongly measured at on init.
    chart.resize();
  }, [samples.data, name, color, minTs, maxTs]);

  return (
    <div className="flex h-full flex-col">
      <div className="shrink-0 whitespace-normal break-words px-2 pt-1 text-xs font-medium" style={{ color }}>
        {name}
      </div>
      <div ref={containerRef} className="min-h-0 w-full flex-1" />
    </div>
  );
}
