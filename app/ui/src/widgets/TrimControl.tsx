import { useEffect, useMemo, useRef, useState } from "react";
import * as echarts from "echarts";
import { useToastStore } from "@/app/toast-store";
import { useWorkspaceStore, type TrimRange } from "@/app/store";
import {
  resolveMessageRange,
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
  const timeRange = useTraceTimeRange(blfPath);
  const messageCount = useMessageCount(blfPath);
  const coverage = useSignalCoverage(blfPath);
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
    const spans = coverageSpansForActive(coverage.data ?? [], activeSignalIds);
    return binBandsFromCoverageUs(spans, minUs, maxUs);
  }, [coverage.data, activeSignalIds, minUs, maxUs]);

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
    chart.setOption(buildTrimRailOption(bands));
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
