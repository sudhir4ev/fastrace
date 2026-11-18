import { useEffect, useRef } from "react";
import * as echarts from "echarts";
import { useWorkspaceStore } from "@/app/store";
import { CHART_GROUP } from "./SignalChart";

const MATCH_COLOR = "#e34948"; // PALETTE[5] - red, distinct from signal colors, reads as "flagged"

export default function MatchLane() {
  const matches = useWorkspaceStore((s) => s.detectorMatches);
  const setSelectedMessage = useWorkspaceStore((s) => s.setSelectedMessage);
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<echarts.ECharts | null>(null);
  // The click handler below is registered once (init effect has no
  // dependency array reruns) but needs the *current* matches array on every
  // click, not the one from whenever `chart.on` was called - this ref is
  // kept current by the second effect and read inside the closure instead.
  const matchesRef = useRef(matches);
  matchesRef.current = matches;

  useEffect(() => {
    if (!containerRef.current) return;
    const chart = echarts.init(containerRef.current);
    chart.group = CHART_GROUP;
    chartRef.current = chart;
    echarts.connect(CHART_GROUP);
    chart.on("click", (params) => {
      const msgId = matchesRef.current[params.dataIndex]?.msgId;
      if (msgId !== undefined) setSelectedMessage(msgId);
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
    if (!chart) return;
    chart.setOption(
      {
        animation: false,
        grid: { left: 80, right: 20, top: 5, bottom: 5 },
        xAxis: {
          type: "value",
          axisLabel: { formatter: (v: number) => `${(v / 1_000_000).toFixed(1)}s` },
        },
        yAxis: { type: "value", show: false, min: -1, max: 1 },
        tooltip: {
          trigger: "item",
          formatter: (p: { data: [number, number]; dataIndex: number }) =>
            `msg_id: ${matches[p.dataIndex]?.msgId}<br/>t: ${(p.data[0] / 1_000_000).toFixed(3)}s`,
        },
        dataZoom: [{ type: "inside", zoomOnMouseWheel: false, moveOnMouseWheel: false, moveOnMouseMove: false }],
        series: [
          {
            type: "scatter",
            name: "Matches",
            data: matches.map((m) => [m.timestampUs, 0]),
            symbolSize: 8,
            itemStyle: { color: MATCH_COLOR },
            large: true,
          },
        ],
      },
      true
    );
    chart.resize();
  }, [matches]);

  return (
    <div className="h-16 shrink-0 border-b border-border">
      <div ref={containerRef} className="h-full w-full" />
    </div>
  );
}
