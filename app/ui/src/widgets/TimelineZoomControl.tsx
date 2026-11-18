import { useEffect, useRef } from "react";
import * as echarts from "echarts";
import { CHART_GROUP } from "./SignalChart";

// A dedicated, pinned-to-viewport echarts instance that renders nothing but
// the shared zoom slider. echarts.connect() syncs dataZoom *percentage*
// range across every instance in CHART_GROUP, so dragging this one's slider
// still zooms every SignalChart's own (independently-scaled) x-axis to the
// same relative window - this instance never needs real data for that to
// work, only membership in the group.
export default function TimelineZoomControl() {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!containerRef.current) return;
    const chart = echarts.init(containerRef.current);
    chart.group = CHART_GROUP;
    echarts.connect(CHART_GROUP);
    chart.setOption({
      animation: false,
      grid: { left: 80, right: 20, top: 0, bottom: 0, height: 0 },
      xAxis: { type: "value", show: false },
      yAxis: { type: "value", show: false },
      dataZoom: [{ type: "slider", bottom: 0, height: 50 }],
      series: [{ type: "line", data: [] }],
    });
    const resize = () => chart.resize();
    window.addEventListener("resize", resize);
    return () => {
      window.removeEventListener("resize", resize);
      chart.dispose();
    };
  }, []);

  return <div ref={containerRef} className="h-[50px] w-full shrink-0" />;
}
