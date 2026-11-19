import { useEffect, useRef } from "react";
import * as echarts from "echarts";
import { useWorkspaceStore } from "@/app/store";
import { CHART_GROUP } from "./TimelineChart";

// A dedicated, pinned-to-panel echarts instance that renders nothing but the
// shared zoom slider, kept outside TimelineChart's own scrollable region so
// it can never be scrolled out of view when the lanes' combined height
// exceeds the panel. echarts.connect() syncs dataZoom *percentage* range
// across every instance in CHART_GROUP, so dragging this one's slider still
// zooms every grid in TimelineChart's own (independently-scaled) instance to
// the same relative window - this instance never needs real data for that
// to work, only membership in the group.
export default function TimelineZoomControl() {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!containerRef.current) return;
    const chart = echarts.init(containerRef.current, undefined, { renderer: "canvas" });
    chart.group = CHART_GROUP;
    echarts.connect(CHART_GROUP);
    // This component only mounts when displayedSignalIds goes from empty to
    // non-empty, so it's always a fresh mount - initialize its slider from
    // the persisted range (not the 0-100 default) so re-adding a signal
    // after removing the last one doesn't visually reset the zoom.
    const { start, end } = useWorkspaceStore.getState().timelineZoomRange;
    chart.setOption({
      animation: false,
      grid: { left: 80, right: 20, top: 0, bottom: 0, height: 0 },
      xAxis: { type: "value", show: false },
      yAxis: { type: "value", show: false },
      dataZoom: [{ type: "slider", start, end, bottom: 0, height: 50 }],
      series: [{ type: "line", data: [] }],
    });
    const resize = () => chart.resize();
    window.addEventListener("resize", resize);
    return () => {
      window.removeEventListener("resize", resize);
      chart.dispose();
    };
  }, []);

  return <div ref={containerRef} className="h-[50px] w-full shrink-0 bg-slate-50" />;
}
