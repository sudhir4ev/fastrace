import { useEffect, useRef } from "react";
import * as echarts from "echarts";
import { TIMELINE_SAMPLE_LIMIT, useSignalSamples } from "@/shared/api/hooks";

interface SignalChartProps {
  blfPath: string;
  signalId: number;
  name: string;
  color: string;
  // Only one chart in the stack should show the visible slider control -
  // echarts.connect() still syncs the zoom *range* across every chart in the
  // group even when the others' sliders are hidden, so one control is enough.
  showZoomSlider: boolean;
}

// Shared echarts "group" id - instances in the same group have their
// dataZoom/tooltip crosshair kept in sync by echarts.connect(), which is how
// separate chart instances still pan/zoom/hover together.
const CHART_GROUP = "timeline-signals";

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

export default function SignalChart({ blfPath, signalId, name, color, showZoomSlider }: SignalChartProps) {
  const samples = useSignalSamples(blfPath, signalId, TIMELINE_SAMPLE_LIMIT);
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<echarts.ECharts | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;
    const chart = echarts.init(containerRef.current);
    chart.group = CHART_GROUP;
    chartRef.current = chart;
    echarts.connect(CHART_GROUP);
    // A window resize listener alone misses width changes from dragging a
    // ResizablePanel divider - that resizes this chart's own container
    // without ever firing a window resize event, which is how charts ended
    // up at different widths from each other.
    const observer = new ResizeObserver(() => chart.resize());
    observer.observe(containerRef.current);
    return () => {
      observer.disconnect();
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
        grid: { left: 60, right: 20, top: 10, bottom: showZoomSlider ? 64 : 10 },
        // Raw samples are [timestampUs, physValue] pairs (trace-source.ts) -
        // a `time` xAxis would misinterpret microseconds as epoch
        // milliseconds, so this uses a `value` axis with seconds-from-zero
        // tick labels instead of calendar dates.
        xAxis: {
          type: "value",
          axisLabel: { formatter: (v: number) => `${(v / 1_000_000).toFixed(1)}s` },
        },
        yAxis: {
          type: "value",
          min: min - pad,
          max: max + pad,
          name,
          nameLocation: "middle",
          nameGap: 45,
          splitLine: { show: false },
        },
        tooltip: { trigger: "axis" },
        dataZoom: [
          { type: "inside" },
          { type: "slider", show: showZoomSlider, bottom: 0, height: 50 },
        ],
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
  }, [samples.data, name, color, showZoomSlider]);

  return <div ref={containerRef} className="h-full w-full" />;
}
