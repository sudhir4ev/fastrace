import { useEffect, useMemo, useRef, useState } from "react";
import * as echarts from "echarts";
import { useToastStore } from "@/app/toast-store";
import { useWorkspaceStore, type TrimRange } from "@/app/store";
import {
  resolveMessageRange,
  useIsApplyingTrim,
  useMessageCount,
  useMessageCountInRange,
  useSignalCoverage,
  useTraceTimeRange,
} from "@/shared/api/hooks";
import { Button } from "@/shared/ui/button";
import {
  TRIM_BINS,
  binBandsFromCoverageUs,
  binToPos,
  binToUs,
  buildTrimRailOption,
  clamp,
  coverageSpansForActive,
  posToBin,
  usToBin,
} from "./trim-rail";

interface TrimControlProps {
  blfPath: string;
  onApply: (range: TrimRange) => void;
}

type Strategy = "time" | "message";

const COUNT_THROTTLE_MS = 120;

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

export default function TrimControl({ blfPath, onApply }: TrimControlProps) {
  // apply-trim holds an exclusive DuckDB write lock in fastrace_parse - pause
  // TrimControl store reads for that window so they don't fail and sticky-error
  // the rail (read-only open conflicts with the sidecar lock).
  const storeReadable = !useIsApplyingTrim(blfPath);
  const timeRange = useTraceTimeRange(blfPath, storeReadable);
  const messageCount = useMessageCount(blfPath, storeReadable);
  const coverage = useSignalCoverage(blfPath, storeReadable);
  const activeSignalIds = useWorkspaceStore((s) => s.activeSignalIds);
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
  // True while we push brushStart/brushEnd into the chart so the resulting
  // datazoom event does not write the same values back into React state.
  const syncingBrushFromPropsRef = useRef(false);
  const brushStartRef = useRef(0);
  const brushEndRef = useRef(TRIM_BINS);

  useEffect(() => {
    if (timeRange.data) {
      initTrimRangeIfUnset(timeRange.data.minTimestampUs, timeRange.data.maxTimestampUs);
    }
  }, [timeRange.data, initTrimRangeIfUnset]);

  useEffect(() => {
    if (!pending || !storeReadable) return;
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
  }, [pending, positionRange, strategy, blfPath, storeReadable]);

  const countQuery = useMessageCountInRange(
    blfPath,
    strategy === "time" ? (throttledTimeRange?.start ?? null) : null,
    strategy === "time" ? (throttledTimeRange?.end ?? null) : null,
    strategy === "time" && storeReadable
  );

  const countReady = messageCount.data != null && messageCount.data >= 1;
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
  brushStartRef.current = brushStart;
  brushEndRef.current = brushEnd;

  const bands = useMemo(() => {
    const spans = coverageSpansForActive(coverage.data ?? [], activeSignalIds);
    return binBandsFromCoverageUs(spans, minUs, maxUs);
  }, [coverage.data, activeSignalIds, minUs, maxUs]);

  const railReady = Boolean(timeRange.data && pending);

  function applyBrushToChart(chart: echarts.ECharts, start: number, end: number) {
    syncingBrushFromPropsRef.current = true;
    chart.dispatchAction({
      type: "dataZoom",
      dataZoomIndex: 0,
      startValue: start,
      endValue: end,
    });
    // datazoom is sync for dispatchAction; clear on next frame in case echarts
    // also queues a follow-up event.
    requestAnimationFrame(() => {
      syncingBrushFromPropsRef.current = false;
    });
  }

  useEffect(() => {
    if (!railReady || !railRef.current) return;
    const el = railRef.current;
    const chart = echarts.init(el, undefined, { renderer: "canvas" });
    chartRef.current = chart;
    const onZoom = () => {
      if (syncingBrushFromPropsRef.current) return;
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
      const { minUs: lo, maxUs: hi, messageCount: n } = domainRef.current;
      if (strategyRef.current === "time") {
        const start = binToUs(a, lo, hi);
        const end = binToUs(b, lo, hi);
        const cur = useWorkspaceStore.getState().pendingTrimRange;
        if (cur && cur.start === start && cur.end === end) return;
        setPendingTrimRange({ start, end });
      } else {
        const startPos = binToPos(a, n);
        const endPos = binToPos(b, n);
        setPositionRange((prev) =>
          prev && prev.startPos === startPos && prev.endPos === endPos
            ? prev
            : { startPos, endPos }
        );
      }
    };
    chart.on("datazoom", onZoom);
    // Paint immediately - the setOption effect may not re-run after StrictMode
    // remount or when railReady flips while bands/timeRange deps are unchanged.
    chart.setOption(buildTrimRailOption(bands));
    applyBrushToChart(chart, brushStartRef.current, brushEndRef.current);
    const resize = () => chart.resize();
    const ro = new ResizeObserver(resize);
    ro.observe(el);
    window.addEventListener("resize", resize);
    requestAnimationFrame(resize);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", resize);
      chart.off("datazoom", onZoom);
      chart.dispose();
      chartRef.current = null;
    };
    // bands intentionally omitted - coverage updates go through the setOption effect;
    // init only needs a first paint for remount / railReady transitions.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [railReady, setPendingTrimRange]);

  useEffect(() => {
    const chart = chartRef.current;
    if (!chart || !timeRange.data) return;
    chart.setOption(buildTrimRailOption(bands));
    // Full option rebuild drops slider extent - re-apply the React brush.
    applyBrushToChart(chart, brushStartRef.current, brushEndRef.current);
    chart.resize();
  }, [bands, timeRange.data]);

  useEffect(() => {
    const chart = chartRef.current;
    if (!chart || !timeRange.data) return;
    applyBrushToChart(chart, brushStart, brushEnd);
  }, [brushStart, brushEnd, timeRange.data]);

  // Only treat as fatal when we have nothing to show. A failed refetch (e.g.
  // DuckDB lock during decode) must keep the last good rail, not replace it.
  if (timeRange.isError && !timeRange.data) {
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
        <p className="text-center font-mono text-[11px] text-muted-foreground">
          {storeReadable ? "Loading trim…" : "Decoding…"}
        </p>
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
      <div className="flex shrink-0 gap-0.5 rounded-md border border-border p-0.5">
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
      <div className="flex shrink-0 flex-col items-start gap-0.5 font-mono text-[10px] leading-tight text-muted-foreground w-[300px]">
        <span>
          {formatUtcHmsMmm(readoutTs.start)} → {formatUtcHmsMmm(readoutTs.end)}
        </span>
        <span className="text-foreground/80">
          <span className="whitespace-nowrap inline-block">{messageCountLabel == null ? "…" : `${messageCountLabel.toLocaleString()} msgs`}</span>
          <span className="whitespace-nowrap inline-block">
          {strategy === "message" && positionRange
            ? ` · #${positionRange.startPos.toLocaleString()}–#${positionRange.endPos.toLocaleString()}`
            : null}
          </span>
        </span>
      </div>
      <div ref={railRef} className="h-9 min-w-0 flex-1" />
      <div className="flex shrink-0 items-center gap-1.5">
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
