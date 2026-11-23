import { useEffect, useMemo, useRef } from "react";
import * as echarts from "echarts";
import { useWorkspaceStore } from "@/app/store";
import { CHART_GROUP } from "./TimelineChart";

const ZOOM_CONTROL_HEIGHT = 50;
// Must match the dataZoom slider's left/right below, so the CSS heatmap
// bars line up with the slider's own track/handles.
const TRACK_LEFT = 80;
const TRACK_RIGHT = 20;

// Amber -> red heatmap for anomaly density in the zoom overview.
const COLOR_STOPS: [number, number, number][] = [
  [254, 249, 231], // #fef9e7
  [252, 166, 82], // #fca652
  [227, 73, 72], // #e34948
];

function binColor(t: number): string {
  const clamped = Math.max(0, Math.min(1, t));
  const segment = clamped * (COLOR_STOPS.length - 1);
  const i = Math.min(COLOR_STOPS.length - 2, Math.floor(segment));
  const localT = segment - i;
  const [r0, g0, b0] = COLOR_STOPS[i];
  const [r1, g1, b1] = COLOR_STOPS[i + 1];
  const r = Math.round(r0 + (r1 - r0) * localT);
  const g = Math.round(g0 + (g1 - g0) * localT);
  const b = Math.round(b0 + (b1 - b0) * localT);
  return `rgb(${r}, ${g}, ${b})`;
}

interface TimelineZoomControlProps {
  // Same pinned trace-wide domain TimelineChart's lanes use (see its
  // minTs/maxTs prop doc) - the heatmap bars are positioned straight off
  // this fixed domain (plain CSS, not an echarts axis), so dragging the
  // slider below never rescales them - an overview strip must stay static
  // while only the slider's selection window moves over it.
  minTs?: number;
  maxTs?: number;
}

// A dedicated, pinned-to-panel echarts instance that renders nothing but the
// shared zoom slider, kept outside TimelineChart's own scrollable region so
// it can never be scrolled out of view when the lanes' combined height
// exceeds the panel. echarts.connect() syncs dataZoom *percentage* range
// across every instance in CHART_GROUP, so dragging this one's slider still
// zooms every grid in TimelineChart's own (independently-scaled) instance to
// the same relative window - this instance never needs real data for that
// to work, only membership in the group. The anomaly-density heatmap drawn
// behind it (see the sibling div below) is deliberately NOT an echarts
// series on this axis - this axis IS what the slider zooms, so any series
// series placed on it would get visibly rescaled/cropped as the user drags, instead
// of staying a static full-trace overview.
export default function TimelineZoomControl({ minTs, maxTs }: TimelineZoomControlProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const anomalyBins = useWorkspaceStore((s) => s.anomalyBins);

  useEffect(() => {
    if (!containerRef.current) return;
    const chart = echarts.init(containerRef.current, undefined, { renderer: "canvas" });
    chart.group = CHART_GROUP;
    echarts.connect(CHART_GROUP);
    // This component only mounts when activeSignalIds goes from empty to
    // non-empty, so it's always a fresh mount - initialize its slider from
    // the persisted range (not the 0-100 default) so re-adding a signal
    // after removing the last one doesn't visually reset the zoom.
    const { start, end } = useWorkspaceStore.getState().timelineZoomRange;
    chart.setOption({
      animation: false,
      grid: { left: TRACK_LEFT, right: TRACK_RIGHT, top: 0, bottom: 0, height: 0 },
      xAxis: { type: "value", show: false },
      yAxis: { type: "value", show: false },
      dataZoom: [
        {
          type: "slider",
          start,
          end,
          left: TRACK_LEFT,
          right: TRACK_RIGHT,
          bottom: 0,
          height: ZOOM_CONTROL_HEIGHT,
          // Transparent/translucent chrome so the heatmap div underneath
          // reads through the slider's own track instead of being hidden.
          backgroundColor: "transparent",
          fillerColor: "rgba(255, 255, 255, 0.25)",
        },
      ],
      series: [{ type: "line", data: [] }],
    });
    const resize = () => chart.resize();
    const ro = new ResizeObserver(resize);
    ro.observe(containerRef.current);
    window.addEventListener("resize", resize);
    requestAnimationFrame(resize);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", resize);
      chart.dispose();
    };
  }, []);

  const bars = useMemo(() => {
    if (minTs === undefined || maxTs === undefined || maxTs <= minTs) return [];
    const domain = maxTs - minTs;
    const maxCount = anomalyBins.reduce((m, b) => Math.max(m, b.count), 0);
    if (maxCount <= 0) return [];
    return anomalyBins.map((b) => ({
      bin: b.bin,
      leftPct: ((b.startUs - minTs) / domain) * 100,
      widthPct: Math.max(((b.endUs - b.startUs) / domain) * 100, 0.1),
      color: binColor(b.count / maxCount),
    }));
  }, [anomalyBins, minTs, maxTs]);

  return (
    <div className="relative h-[50px] w-full shrink-0 bg-slate-50">
      <div className="absolute inset-y-0" style={{ left: TRACK_LEFT, right: TRACK_RIGHT }}>
        {bars.map((bar) => (
          <div
            key={bar.bin}
            className="absolute inset-y-0"
            style={{ left: `${bar.leftPct}%`, width: `${bar.widthPct}%`, backgroundColor: bar.color }}
          />
        ))}
      </div>
      <div ref={containerRef} className="absolute inset-0" />
    </div>
  );
}
