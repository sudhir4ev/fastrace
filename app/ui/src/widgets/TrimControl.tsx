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
const TRIM_BINS = 200;
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

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

function binToUs(bin: number, minUs: number, maxUs: number): number {
  if (maxUs <= minUs) return minUs;
  return Math.round(minUs + (clamp(bin, 0, TRIM_BINS) / TRIM_BINS) * (maxUs - minUs));
}

function usToBin(us: number, minUs: number, maxUs: number): number {
  if (maxUs <= minUs) return 0;
  return clamp(Math.round(((us - minUs) / (maxUs - minUs)) * TRIM_BINS), 0, TRIM_BINS);
}

function binToPos(bin: number, messageCount: number): number {
  if (messageCount <= 1) return 1;
  return clamp(
    Math.round(1 + (clamp(bin, 0, TRIM_BINS) / TRIM_BINS) * (messageCount - 1)),
    1,
    messageCount
  );
}

function posToBin(pos: number, messageCount: number): number {
  if (messageCount <= 1) return 0;
  return clamp(Math.round(((pos - 1) / (messageCount - 1)) * TRIM_BINS), 0, TRIM_BINS);
}

/** Domain spans (time us or message ordinals) for decoded containers. */
function decodedDomainSpans(
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

/** OR domain spans onto TRIM_BINS bins, then merge adjacent occupied bins. */
function binBandsFromSpans(
  spans: Array<[number, number]>,
  strategy: Strategy,
  minUs: number,
  maxUs: number,
  messageCount: number
): Array<[number, number]> {
  if (spans.length === 0) return [];
  const occupied = new Array<boolean>(TRIM_BINS).fill(false);
  for (let i = 0; i < TRIM_BINS; i++) {
    const lo =
      strategy === "time"
        ? binToUs(i, minUs, maxUs)
        : binToPos(i, messageCount);
    const hi =
      strategy === "time"
        ? binToUs(i + 1, minUs, maxUs)
        : binToPos(i + 1, messageCount);
    for (const [a, b] of spans) {
      if (a <= hi && b >= lo) {
        occupied[i] = true;
        break;
      }
    }
  }
  const merged: Array<[number, number]> = [];
  let runStart: number | null = null;
  for (let i = 0; i < TRIM_BINS; i++) {
    if (occupied[i]) {
      if (runStart == null) runStart = i;
    } else if (runStart != null) {
      merged.push([runStart, i]);
      runStart = null;
    }
  }
  if (runStart != null) merged.push([runStart, TRIM_BINS]);
  return merged;
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
  const domainRef = useRef({ minUs: 0, maxUs: 1, messageCount: 1 });
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
  const minUs = timeRange.data?.minTimestampUs ?? 0;
  const maxUs = timeRange.data?.maxTimestampUs ?? 1;
  const nMsgs = messageCount.data ?? 1;
  domainRef.current = { minUs, maxUs, messageCount: nMsgs };

  const brushStart =
    strategy === "time"
      ? usToBin(pending?.start ?? minUs, minUs, maxUs)
      : posToBin(positionRange?.startPos ?? 1, nMsgs);
  const brushEnd =
    strategy === "time"
      ? usToBin(pending?.end ?? maxUs, minUs, maxUs)
      : posToBin(positionRange?.endPos ?? nMsgs, nMsgs);

  const bands = useMemo(() => {
    const spans = decodedDomainSpans(containerRows, strategy, nMsgs);
    return binBandsFromSpans(spans, strategy, minUs, maxUs, nMsgs);
  }, [containerRows, strategy, nMsgs, minUs, maxUs]);

  const railReady = Boolean(timeRange.data && pending);

  useEffect(() => {
    if (!railReady || !railRef.current) return;
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
      a = clamp(a, 0, TRIM_BINS);
      b = clamp(b, 0, TRIM_BINS);
      brushFromChartRef.current = true;
      const { minUs: lo, maxUs: hi, messageCount: n } = domainRef.current;
      if (strategyRef.current === "time") {
        setPendingTrimRange({ start: binToUs(a, lo, hi), end: binToUs(b, lo, hi) });
      } else {
        setPositionRange({ startPos: binToPos(a, n), endPos: binToPos(b, n) });
      }
    };
    chart.on("datazoom", onZoom);
    const resize = () => chart.resize();
    window.addEventListener("resize", resize);
    requestAnimationFrame(() => chart.resize());
    return () => {
      window.removeEventListener("resize", resize);
      chart.off("datazoom", onZoom);
      chart.dispose();
      chartRef.current = null;
    };
  }, [railReady, setPendingTrimRange]);

  useEffect(() => {
    const chart = chartRef.current;
    if (!chart || !timeRange.data) return;

    const markAreaData = bands.map(([a, b]) => [{ xAxis: a }, { xAxis: b }]);

    chart.setOption({
      animation: false,
      grid: { left: 4, right: 4, top: 2, bottom: 22, height: 10 },
      xAxis: {
        type: "value",
        min: 0,
        max: TRIM_BINS,
        show: false,
      },
      yAxis: { type: "value", min: 0, max: 1, show: false },
      dataZoom: [
        {
          type: "slider",
          xAxisIndex: 0,
          height: 18,
          bottom: 0,
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
            [0, 0.5],
            [TRIM_BINS, 0.5],
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
    chart.resize();
  }, [bands, timeRange.data]);

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

  if (timeRange.isError) {
    return (
      <div className="w-full">
        <p className="text-center text-[11px] text-destructive">
          Trim unavailable: {String(timeRange.error)}
        </p>
      </div>
    );
  }

  if (!timeRange.data || !pending) {
    return (
      <div className="w-full">
        <p className="text-center font-mono text-[11px] text-muted-foreground">Loading trim…</p>
      </div>
    );
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

  const isFullApplied =
    applied != null &&
    applied.start === minUs &&
    applied.end === maxUs &&
    (strategy === "time" ||
      (positionRange != null && positionRange.startPos === 1 && positionRange.endPos === nMsgs));

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

  async function handleReset() {
    const full = { start: minUs, end: maxUs };
    if (strategy === "message") {
      if (!countReady) return;
      setIsResolving(true);
      try {
        setPositionRange({ startPos: 1, endPos: nMsgs });
        const [start, end] = await resolveMessageRange(blfPath, 1, nMsgs);
        const range = { start, end };
        setMsgTsReadout(range);
        commitTrimRange(range);
        onApply(range);
      } catch (e) {
        useToastStore.getState().pushError(String(e));
      } finally {
        setIsResolving(false);
      }
      return;
    }
    setPendingTrimRange(full);
    setThrottledTimeRange(full);
    commitTrimRange(full);
    onApply(full);
  }

  return (
    <div className="flex w-full min-w-0 items-center gap-3">
      <div className="flex shrink-0 flex-col items-start gap-0.5 font-mono text-[10px] leading-tight text-muted-foreground">
        <span>
          {formatUtcHmsMmm(readoutTs.start)} → {formatUtcHmsMmm(readoutTs.end)}
        </span>
        <span className="text-foreground/80">
          {messageCountLabel == null ? "…" : `${messageCountLabel.toLocaleString()} msgs`}
          {strategy === "message" && positionRange
            ? ` · #${positionRange.startPos.toLocaleString()}–#${positionRange.endPos.toLocaleString()}`
            : null}
        </span>
      </div>
      <div ref={railRef} className="h-9 min-w-0 flex-1" />
      <div className="flex shrink-0 items-center gap-1.5">
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
        <Button
          size="sm"
          variant="secondary"
          disabled={isFullApplied || isResolving || (strategy === "message" && !countReady)}
          onClick={handleReset}
        >
          Reset
        </Button>
      </div>
    </div>
  );
}
