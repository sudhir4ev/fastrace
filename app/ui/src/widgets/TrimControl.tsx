import { useEffect, useMemo, useRef, useState } from "react";
import * as echarts from "echarts";
import { useToastStore } from "@/app/toast-store";
import { useWorkspaceStore, type TrimRange } from "@/app/store";
import {
  resolveMessageRange,
  useContainerIndex,
  useMessageCount,
  useMessageCountInRange,
  useTraceTimeRange,
} from "@/shared/api/hooks";
import type { ContainerIndexEntry } from "@/shared/api/trace-source";
import { Button } from "@/shared/ui/button";

interface TrimControlProps {
  blfPath: string;
  onApply: (range: TrimRange) => void;
}

type Strategy = "time" | "message";

const COUNT_THROTTLE_MS = 120;
const BAND_COLOR = "rgba(37, 99, 235, 0.22)";

/** Absolute wall-clock time-of-day from timestamp_us, UTC (W1). */
function formatUtcHmsMmm(us: number): string {
  const msTotal = Math.floor(us / 1000);
  const d = new Date(msTotal);
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  const ss = String(d.getUTCSeconds()).padStart(2, "0");
  const mmm = String(d.getUTCMilliseconds()).padStart(3, "0");
  return `${hh}:${mm}:${ss}.${mmm}`;
}

function bandSpans(
  containers: ContainerIndexEntry[],
  strategy: Strategy,
  messageCount: number
): Array<[number, number]> {
  if (containers.length === 0) return [];
  if (strategy === "time") {
    return containers.filter((c) => c.decoded).map((c) => [c.firstTsUs, c.lastTsUs]);
  }
  const byOrd = [...containers].sort((a, b) => a.containerOrd - b.containerOrd);
  return byOrd
    .filter((c) => c.decoded)
    .map((c) => {
      const idx = byOrd.findIndex((x) => x.containerOrd === c.containerOrd);
      const startPos = c.firstMsgId + 1;
      const endPos = idx + 1 < byOrd.length ? byOrd[idx + 1].firstMsgId : messageCount;
      return [startPos, Math.max(startPos, endPos)] as [number, number];
    });
}

export default function TrimControl({ blfPath, onApply }: TrimControlProps) {
  const timeRange = useTraceTimeRange(blfPath);
  const messageCount = useMessageCount(blfPath);
  const containers = useContainerIndex(blfPath);
  const pending = useWorkspaceStore((s) => s.pendingTrimRange);
  const applied = useWorkspaceStore((s) => s.appliedTrimRange);
  const setPendingTrimRange = useWorkspaceStore((s) => s.setPendingTrimRange);
  const commitTrimRange = useWorkspaceStore((s) => s.commitTrimRange);
  const initTrimRangeIfUnset = useWorkspaceStore((s) => s.initTrimRangeIfUnset);

  const [strategy, setStrategy] = useState<Strategy>("time");
  const [positionRange, setPositionRange] = useState<{ startPos: number; endPos: number } | null>(
    null
  );
  const [isResolving, setIsResolving] = useState(false);
  const [msgTsReadout, setMsgTsReadout] = useState<TrimRange | null>(null);
  const [throttledTimeRange, setThrottledTimeRange] = useState<TrimRange | null>(null);

  const chartRef = useRef<echarts.ECharts | null>(null);
  const railRef = useRef<HTMLDivElement>(null);
  const strategyRef = useRef(strategy);
  strategyRef.current = strategy;
  // Skip pushing startValue/endValue when the change came from the chart itself.
  const brushFromChartRef = useRef(false);

  useEffect(() => {
    if (timeRange.data) {
      initTrimRangeIfUnset(timeRange.data.minTimestampUs, timeRange.data.maxTimestampUs);
    }
  }, [timeRange.data, initTrimRangeIfUnset]);

  useEffect(() => {
    if (!pending) return;
    if (strategy === "time") {
      const t = window.setTimeout(() => setThrottledTimeRange(pending), COUNT_THROTTLE_MS);
      return () => window.clearTimeout(t);
    }
    if (!positionRange) return;
    const t = window.setTimeout(() => {
      resolveMessageRange(blfPath, positionRange.startPos, positionRange.endPos)
        .then(([start, end]) => setMsgTsReadout({ start, end }))
        .catch(() => {
          /* keep last good readout */
        });
    }, COUNT_THROTTLE_MS);
    return () => window.clearTimeout(t);
  }, [pending, positionRange, strategy, blfPath]);

  const countQuery = useMessageCountInRange(
    blfPath,
    strategy === "time" ? (throttledTimeRange?.start ?? null) : null,
    strategy === "time" ? (throttledTimeRange?.end ?? null) : null,
    strategy === "time"
  );

  const countReady = messageCount.data != null && messageCount.data >= 1;
  const containerRows = containers.data ?? [];

  const axisMin = strategy === "time" ? (timeRange.data?.minTimestampUs ?? 0) : 1;
  const axisMax =
    strategy === "time" ? (timeRange.data?.maxTimestampUs ?? 1) : (messageCount.data ?? 1);

  const brushStart =
    strategy === "time" ? (pending?.start ?? axisMin) : (positionRange?.startPos ?? 1);
  const brushEnd =
    strategy === "time" ? (pending?.end ?? axisMax) : (positionRange?.endPos ?? axisMax);

  const bands = useMemo(
    () => bandSpans(containerRows, strategy, messageCount.data ?? 0),
    [containerRows, strategy, messageCount.data]
  );

  useEffect(() => {
    if (!railRef.current) return;
    const chart = echarts.init(railRef.current, undefined, { renderer: "canvas" });
    chartRef.current = chart;
    const onZoom = () => {
      const option = chart.getOption() as {
        dataZoom?: Array<{ startValue?: number; endValue?: number }>;
      };
      const dz = option.dataZoom?.[0];
      if (dz?.startValue == null || dz?.endValue == null) return;
      let a = Math.round(Number(dz.startValue));
      let b = Math.round(Number(dz.endValue));
      if (a > b) [a, b] = [b, a];
      brushFromChartRef.current = true;
      if (strategyRef.current === "time") {
        setPendingTrimRange({ start: a, end: b });
      } else {
        setPositionRange({ startPos: Math.max(1, a), endPos: Math.max(1, b) });
      }
    };
    chart.on("datazoom", onZoom);
    const resize = () => chart.resize();
    window.addEventListener("resize", resize);
    return () => {
      window.removeEventListener("resize", resize);
      chart.off("datazoom", onZoom);
      chart.dispose();
      chartRef.current = null;
    };
  }, [setPendingTrimRange]);

  // Domain + decoded bands. Do not push startValue/endValue here - that fights
  // the in-progress dataZoom drag (pending updates on every move).
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart || !timeRange.data) return;

    const markAreaData = bands.map(([a, b]) => [{ xAxis: a }, { xAxis: b }]);

    chart.setOption({
      animation: false,
      grid: { left: 8, right: 8, top: 2, bottom: 26, height: 12 },
      xAxis: {
        type: "value",
        min: axisMin,
        max: axisMax,
        show: false,
      },
      yAxis: { type: "value", min: 0, max: 1, show: false },
      dataZoom: [
        {
          type: "slider",
          xAxisIndex: 0,
          height: 20,
          bottom: 2,
          filterMode: "none",
          brushSelect: false,
          showDetail: false,
          fillerColor: "rgba(37, 99, 235, 0.35)",
          borderColor: "rgba(37, 99, 235, 0.5)",
          handleSize: "110%",
        },
      ],
      series: [
        {
          type: "line",
          data: [
            [axisMin, 0.5],
            [axisMax, 0.5],
          ],
          symbol: "none",
          lineStyle: { opacity: 0 },
          silent: true,
          markArea: {
            silent: true,
            itemStyle: { color: BAND_COLOR },
            data: markAreaData,
          },
        },
      ],
    });
  }, [axisMin, axisMax, bands, timeRange.data]);

  // Push brush from React → chart only when we didn't just read it from the chart.
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart || !timeRange.data) return;
    if (brushFromChartRef.current) {
      brushFromChartRef.current = false;
      return;
    }
    chart.setOption({
      dataZoom: [{ startValue: brushStart, endValue: brushEnd }],
    });
  }, [brushStart, brushEnd, timeRange.data]);

  if (!timeRange.data || !pending) {
    return null;
  }
  const pendingRange: TrimRange = pending;

  function switchStrategy(next: Strategy) {
    if (next === "message") {
      if (!countReady) return;
      setStrategy("message");
      setPositionRange({ startPos: 1, endPos: messageCount.data! });
      setMsgTsReadout({
        start: timeRange.data!.minTimestampUs,
        end: timeRange.data!.maxTimestampUs,
      });
      return;
    }
    setStrategy("time");
    setPendingTrimRange({
      start: timeRange.data!.minTimestampUs,
      end: timeRange.data!.maxTimestampUs,
    });
    setThrottledTimeRange({
      start: timeRange.data!.minTimestampUs,
      end: timeRange.data!.maxTimestampUs,
    });
  }

  const hasPendingChange =
    strategy === "time"
      ? !applied || applied.start !== pendingRange.start || applied.end !== pendingRange.end
      : true;

  const readoutTs =
    strategy === "time"
      ? pendingRange
      : (msgTsReadout ?? {
          start: timeRange.data.minTimestampUs,
          end: timeRange.data.maxTimestampUs,
        });

  const messageCountLabel =
    strategy === "message" && positionRange
      ? Math.max(0, positionRange.endPos - positionRange.startPos + 1)
      : countQuery.data;

  async function handleApply() {
    if (strategy === "message" && positionRange) {
      setIsResolving(true);
      try {
        const [start, end] = await resolveMessageRange(
          blfPath,
          positionRange.startPos,
          positionRange.endPos
        );
        const range = { start, end };
        commitTrimRange(range);
        onApply(range);
      } catch (e) {
        useToastStore.getState().pushError(String(e));
      } finally {
        setIsResolving(false);
      }
      return;
    }
    commitTrimRange(pendingRange);
    onApply(pendingRange);
  }

  return (
    <div className="mx-auto w-[80%] min-w-[min(100%,640px)] max-w-[1200px]">
      <div className="mb-1 flex items-center justify-center gap-3 font-mono text-[11px] text-muted-foreground">
        <span>{formatUtcHmsMmm(readoutTs.start)}</span>
        <span aria-hidden>→</span>
        <span>{formatUtcHmsMmm(readoutTs.end)}</span>
        <span className="text-foreground/80">
          {messageCountLabel == null ? "…" : `${messageCountLabel.toLocaleString()} msgs`}
        </span>
        {strategy === "message" && positionRange && (
          <span className="text-[10px]">
            #{positionRange.startPos.toLocaleString()}–#{positionRange.endPos.toLocaleString()}
          </span>
        )}
      </div>
      <div ref={railRef} className="h-10 w-full" />
      <div className="mt-1 flex items-center justify-center gap-2">
        <div className="flex gap-0.5 rounded-md border border-border p-0.5">
          <Button
            size="sm"
            variant={strategy === "time" ? "secondary" : "ghost"}
            className="h-6 px-2 text-[10px]"
            onClick={() => switchStrategy("time")}
          >
            Time
          </Button>
          <Button
            size="sm"
            variant={strategy === "message" ? "secondary" : "ghost"}
            className="h-6 px-2 text-[10px]"
            disabled={!countReady}
            onClick={() => switchStrategy("message")}
          >
            Message
          </Button>
        </div>
        <Button
          size="sm"
          variant={hasPendingChange ? "default" : "secondary"}
          disabled={!hasPendingChange || isResolving || (strategy === "message" && !positionRange)}
          onClick={handleApply}
        >
          {isResolving ? "Resolving..." : "Apply"}
        </Button>
      </div>
    </div>
  );
}
