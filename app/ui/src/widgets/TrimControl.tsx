import { useEffect, useState } from "react";
import { useWorkspaceStore } from "@/app/store";
import { resolveMessagePosition, useMessageCount, useTraceTimeRange } from "@/shared/api/hooks";
import { Button } from "@/shared/ui/button";
import { Slider } from "@/shared/ui/slider";

interface TrimControlProps {
  blfPath: string;
  onApply: () => void;
}

type Strategy = "time" | "message";

export default function TrimControl({ blfPath, onApply }: TrimControlProps) {
  const timeRange = useTraceTimeRange(blfPath);
  const messageCount = useMessageCount(blfPath);
  const pending = useWorkspaceStore((s) => s.pendingTrimRange);
  const applied = useWorkspaceStore((s) => s.appliedTrimRange);
  const setPendingTrimRange = useWorkspaceStore((s) => s.setPendingTrimRange);
  const applyTrim = useWorkspaceStore((s) => s.applyTrim);
  const initTrimRangeIfUnset = useWorkspaceStore((s) => s.initTrimRangeIfUnset);

  const [strategy, setStrategy] = useState<Strategy>("time");
  const [positionRange, setPositionRange] = useState<{ startPos: number; endPos: number } | null>(null);
  const [isResolving, setIsResolving] = useState(false);

  useEffect(() => {
    if (timeRange.data) {
      initTrimRangeIfUnset(timeRange.data.minTimestampUs, timeRange.data.maxTimestampUs);
    }
  }, [timeRange.data, initTrimRangeIfUnset]);

  if (!timeRange.data || !pending) {
    return null;
  }

  const { minTimestampUs, maxTimestampUs } = timeRange.data;

  // Switching strategy always re-primes to the full range rather than
  // reverse-mapping one unit into the other - timestamp->ordinal-position
  // isn't cheap and isn't needed; the user presses Apply again either way.
  function switchStrategy(next: Strategy) {
    setStrategy(next);
    if (next === "message") {
      setPositionRange({ startPos: 1, endPos: messageCount.data ?? 1 });
    } else {
      setPendingTrimRange({ start: minTimestampUs, end: maxTimestampUs });
    }
  }

  const hasPendingChange =
    strategy === "time"
      ? !applied || applied.start !== pending.start || applied.end !== pending.end
      : true; // message mode: resolution happens fresh at every Apply, so always allow (re-)pressing it.

  async function handleApply() {
    if (strategy === "message" && positionRange) {
      setIsResolving(true);
      const [start, end] = await Promise.all([
        resolveMessagePosition(blfPath, positionRange.startPos),
        resolveMessagePosition(blfPath, positionRange.endPos),
      ]);
      setIsResolving(false);
      setPendingTrimRange({ start, end });
      applyTrim();
    } else {
      applyTrim();
    }
    onApply();
  }

  return (
    <div className="flex items-center gap-2">
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
          onClick={() => switchStrategy("message")}
        >
          Message
        </Button>
      </div>
      {strategy === "time" ? (
        <>
          <span className="font-mono text-[10px] text-muted-foreground">{pending.start.toLocaleString()}</span>
          <Slider
            min={minTimestampUs}
            max={maxTimestampUs}
            value={[pending.start, pending.end]}
            onValueChange={([start, end]) => setPendingTrimRange({ start, end })}
            className="w-56"
          />
          <span className="font-mono text-[10px] text-muted-foreground">{pending.end.toLocaleString()}</span>
        </>
      ) : (
        positionRange && (
          <>
            <span className="font-mono text-[10px] text-muted-foreground">#{positionRange.startPos}</span>
            <Slider
              min={1}
              max={messageCount.data ?? 1}
              value={[positionRange.startPos, positionRange.endPos]}
              onValueChange={([startPos, endPos]) => setPositionRange({ startPos, endPos })}
              className="w-56"
            />
            <span className="font-mono text-[10px] text-muted-foreground">#{positionRange.endPos}</span>
          </>
        )
      )}
      <Button
        size="sm"
        variant={hasPendingChange ? "default" : "secondary"}
        disabled={!hasPendingChange || isResolving}
        onClick={handleApply}
      >
        {isResolving ? "Resolving..." : "Apply"}
      </Button>
    </div>
  );
}
