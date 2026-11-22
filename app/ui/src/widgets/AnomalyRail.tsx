import { useEffect, useMemo, useRef } from "react";
import * as echarts from "echarts";
import { useWorkspaceStore } from "@/app/store";
import { useApplyTrim } from "@/shared/api/hooks";

const BIN_COUNT = 500;
const ACTIVE_COLOR = "#e34948";
const INACTIVE_COLOR = "#e5e7eb";
const MARKER_COLOR = "#2563eb";

interface AnomalyRailProps {
  blfPath: string;
}

function formatUs(us: number): string {
  return `${(us / 1_000_000).toFixed(3)}s`;
}

export default function AnomalyRail({ blfPath }: AnomalyRailProps) {
  const bins = useWorkspaceStore((s) => s.anomalyBins);
  const scope = useWorkspaceStore((s) => s.anomalyScope);
  const hasRun = useWorkspaceStore((s) => s.detectorQueryHasRun);
  const applied = useWorkspaceStore((s) => s.appliedTrimRange);
  const commitTrimRange = useWorkspaceStore((s) => s.commitTrimRange);
  const applyTrim = useApplyTrim(blfPath);
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<echarts.ECharts | null>(null);
  const binsRef = useRef(bins);
  binsRef.current = bins;

  const scopeLabel = useMemo(() => {
    if (!scope) return null;
    return scope.wholeTrace
      ? "Scope: full trace"
      : `Scope: ${formatUs(scope.startUs)} – ${formatUs(scope.endUs)}`;
  }, [scope]);

  useEffect(() => {
    if (!containerRef.current) return;
    const chart = echarts.init(containerRef.current, undefined, { renderer: "canvas" });
    chartRef.current = chart;
    chart.on("click", (params) => {
      const binIndex = typeof params.dataIndex === "number" ? params.dataIndex : -1;
      // data is dense 0..499; look up active bin by index
      const active = binsRef.current.find((b) => b.bin === binIndex);
      if (!active) return;
      const range = { start: active.startUs, end: active.endUs };
      commitTrimRange(range);
      const { activeSignalIds } = useWorkspaceStore.getState();
      applyTrim.mutate({
        startUs: range.start,
        endUs: range.end,
        activeSignalIds: Array.from(activeSignalIds),
      });
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
    if (!chart || !scope) return;
    const byBin = new Map(bins.map((b) => [b.bin, b]));
    const data = Array.from({ length: BIN_COUNT }, (_, i) => {
      const b = byBin.get(i);
      return {
        value: b ? 1 : 0,
        itemStyle: { color: b ? ACTIVE_COLOR : INACTIVE_COLOR },
        bin: b,
      };
    });

    const markArea =
      applied && scope
        ? [
            [
              {
                xAxis: Math.max(
                  0,
                  Math.min(
                    BIN_COUNT - 1,
                    Math.floor(
                      ((applied.start - scope.startUs) * BIN_COUNT) /
                        (scope.endUs - scope.startUs + 1)
                    )
                  )
                ),
                itemStyle: { color: "rgba(37, 99, 235, 0.15)" },
              },
              {
                xAxis: Math.max(
                  0,
                  Math.min(
                    BIN_COUNT - 1,
                    Math.floor(
                      ((applied.end - scope.startUs) * BIN_COUNT) /
                        (scope.endUs - scope.startUs + 1)
                    )
                  )
                ),
              },
            ],
          ]
        : undefined;

    chart.setOption(
      {
        animation: false,
        grid: { left: 8, right: 8, top: 4, bottom: 4 },
        xAxis: { type: "category", show: false, data: Array.from({ length: BIN_COUNT }, (_, i) => i) },
        yAxis: { type: "value", show: false, min: 0, max: 1 },
        tooltip: {
          trigger: "item",
          formatter: (p: { dataIndex: number; data: { bin?: (typeof bins)[number] } }) => {
            const b = p.data?.bin ?? byBin.get(p.dataIndex);
            if (!b) return `bin ${p.dataIndex}<br/>(empty)`;
            return [
              `bin ${b.bin}`,
              `count: ${b.count}`,
              `first msg_id: ${b.firstMsgId}`,
              `${formatUs(b.startUs)} – ${formatUs(b.endUs)}`,
            ].join("<br/>");
          },
        },
        series: [
          {
            type: "bar",
            data,
            barWidth: "100%",
            barCategoryGap: "0%",
            markArea: markArea
              ? {
                  silent: true,
                  data: markArea,
                  itemStyle: { color: "rgba(37, 99, 235, 0.15)", borderColor: MARKER_COLOR, borderWidth: 1 },
                }
              : undefined,
          },
        ],
      },
      true
    );
    chart.resize();
  }, [bins, scope, applied]);

  if (!hasRun || !scope) return null;

  return (
    <div className="shrink-0 border-b border-border px-2 py-1">
      <div className="mb-0.5 text-[10px] text-muted-foreground">{scopeLabel}</div>
      <div ref={containerRef} className="h-8 w-full" />
    </div>
  );
}
