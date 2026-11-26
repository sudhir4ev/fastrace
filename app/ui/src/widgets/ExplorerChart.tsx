import { useEffect, useRef } from "react";
import * as echarts from "echarts";
import { getSignalColor } from "@/app/signalColors";
import type { ExplorerChartResult } from "@/shared/api/trace-source";

interface ExplorerChartProps {
  result: ExplorerChartResult;
  vizType: "bar" | "line";
  hasSeries: boolean;
}

export default function ExplorerChart({ result, vizType, hasSeries }: ExplorerChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<echarts.ECharts | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;
    const chart = echarts.init(containerRef.current, undefined, { renderer: "canvas" });
    chartRef.current = chart;
    const resize = () => chart.resize();
    const ro = new ResizeObserver(resize);
    ro.observe(containerRef.current);
    return () => {
      ro.disconnect();
      chart.dispose();
      chartRef.current = null;
    };
  }, []);

  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;

    const seriesNames = hasSeries
      ? Array.from(new Set(result.rows.map((r) => r[1] ?? "")))
      : ["y"];
    const xCategories = Array.from(new Set(result.rows.map((r) => r[0])));

    const series = seriesNames.map((name, i) => ({
      name,
      type: vizType,
      // 2px lines / rounded bar ends per the dataviz skill's fixed mark specs -
      // not user-configurable (2026-11-26-trace-explorer-design.md, Phase 2).
      lineStyle: vizType === "line" ? { width: 2 } : undefined,
      itemStyle: { color: getSignalColor(i), borderRadius: vizType === "bar" ? [4, 4, 0, 0] : undefined },
      symbolSize: 8,
      data: xCategories.map((x) => {
        const row = result.rows.find((r) => r[0] === x && (!hasSeries || (r[1] ?? "") === name));
        return row ? row[2] : null;
      }),
    }));

    chart.setOption({
      xAxis: { type: "category", data: xCategories },
      yAxis: { type: "value" },
      legend: hasSeries && seriesNames.length >= 2 ? { data: seriesNames } : undefined,
      tooltip: { trigger: "axis", axisPointer: { type: vizType === "line" ? "cross" : "shadow" } },
      series,
    });
  }, [result, vizType, hasSeries]);

  return <div ref={containerRef} style={{ width: "100%", height: "100%" }} />;
}
