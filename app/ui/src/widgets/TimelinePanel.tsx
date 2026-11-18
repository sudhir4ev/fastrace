import { useEffect, useRef } from "react";
import * as echarts from "echarts";
import { useSignalCatalog, useSignalSamplesMany } from "@/shared/api/hooks";
import { useWorkspaceStore } from "@/app/store";
import { getSignalColor } from "@/app/signalColors";
import SignalPills from "./SignalPills";

interface TimelinePanelProps {
  blfPath: string;
}

const GRID_GAP_PERCENT = 4;

export default function TimelinePanel({ blfPath }: TimelinePanelProps) {
  const catalog = useSignalCatalog(blfPath);
  const displayedSignalIds = Array.from(useWorkspaceStore((s) => s.displayedSignalIds));
  const samples = useSignalSamplesMany(blfPath, displayedSignalIds);

  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<echarts.ECharts | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;
    chartRef.current = echarts.init(containerRef.current);
    const resize = () => chartRef.current?.resize();
    window.addEventListener("resize", resize);
    return () => {
      window.removeEventListener("resize", resize);
      chartRef.current?.dispose();
      chartRef.current = null;
    };
  }, []);

  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;

    if (displayedSignalIds.length === 0) {
      chart.clear();
      return;
    }

    const n = displayedSignalIds.length;
    const trackHeight = (100 - GRID_GAP_PERCENT * (n - 1)) / n;

    const grids = displayedSignalIds.map((_, i) => ({
      top: `${i * (trackHeight + GRID_GAP_PERCENT)}%`,
      height: `${trackHeight}%`,
      left: 60,
      right: 20,
    }));

    // Raw samples are [timestampUs, physValue] pairs (trace-source.ts) - a
    // `time` xAxis would misinterpret microseconds as epoch milliseconds, so
    // this uses a `value` axis and formats ticks as seconds-from-zero
    // instead of calendar dates.
    const xAxes = displayedSignalIds.map((_, i) => ({
      type: "value" as const,
      gridIndex: i,
      axisLabel: {
        show: i === 0,
        formatter: (v: number) => `${(v / 1_000_000).toFixed(1)}s`,
      },
      axisLine: { show: i === n - 1 },
    }));

    const yAxes = displayedSignalIds.map((_, i) => {
      const result = samples[i];
      const values = (result?.data ?? []).map(([, v]) => v);
      const min = values.length ? Math.min(...values) : 0;
      const max = values.length ? Math.max(...values) : 1;
      const pad = (max - min) * 0.1 || 1;
      return {
        type: "value" as const,
        gridIndex: i,
        min: min - pad,
        max: max + pad,
        name:
          catalog.data?.find((s) => s.signalId === displayedSignalIds[i])?.name ?? `signal ${displayedSignalIds[i]}`,
        nameLocation: "middle" as const,
        nameGap: 45,
        splitLine: { show: false },
      };
    });

    const series = displayedSignalIds.map((signalId, i) => {
      const colorIndex = (catalog.data ?? []).findIndex((c) => c.signalId === signalId);
      const color = getSignalColor(colorIndex);
      const result = samples[i];
      return {
        type: "line" as const,
        name: catalog.data?.find((s) => s.signalId === signalId)?.name ?? `signal ${signalId}`,
        xAxisIndex: i,
        yAxisIndex: i,
        data: result?.data ?? [],
        showSymbol: false,
        large: true,
        sampling: "lttb" as const,
        lineStyle: { color, width: 2 },
        areaStyle: { color, opacity: 0.15 },
      };
    });

    chart.setOption(
      {
        animation: false,
        grid: grids,
        xAxis: xAxes,
        yAxis: yAxes,
        axisPointer: { link: [{ xAxisIndex: "all" }] },
        tooltip: { trigger: "axis" },
        dataZoom: [
          { type: "inside", xAxisIndex: displayedSignalIds.map((_, i) => i) },
          { type: "slider", xAxisIndex: displayedSignalIds.map((_, i) => i), bottom: 0, height: 14 },
        ],
        series,
      },
      true
    );
  }, [displayedSignalIds, samples, catalog.data]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <SignalPills blfPath={blfPath} />
      <div className="min-h-0 flex-1">
        {displayedSignalIds.length === 0 ? (
          <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
            No signals displayed - click a pill above to plot a decoded signal.
          </div>
        ) : (
          <div ref={containerRef} className="h-full w-full" />
        )}
      </div>
    </div>
  );
}
