import { useEffect } from "react";
import { useWorkspaceStore } from "@/app/store";
import { useTraceTimeRange } from "@/shared/api/hooks";
import { Button } from "@/shared/ui/button";

interface TrimControlProps {
  blfPath: string;
  onApply: () => void;
}

export default function TrimControl({ blfPath, onApply }: TrimControlProps) {
  const timeRange = useTraceTimeRange(blfPath);
  const pending = useWorkspaceStore((s) => s.pendingTrimRange);
  const applied = useWorkspaceStore((s) => s.appliedTrimRange);
  const setPendingTrimRange = useWorkspaceStore((s) => s.setPendingTrimRange);
  const applyTrim = useWorkspaceStore((s) => s.applyTrim);
  const initTrimRangeIfUnset = useWorkspaceStore((s) => s.initTrimRangeIfUnset);

  useEffect(() => {
    if (timeRange.data) {
      initTrimRangeIfUnset(timeRange.data.minTimestampUs, timeRange.data.maxTimestampUs);
    }
  }, [timeRange.data, initTrimRangeIfUnset]);

  if (!timeRange.data || !pending) {
    return null;
  }

  const { minTimestampUs, maxTimestampUs } = timeRange.data;
  const hasPendingChange = !applied || applied.start !== pending.start || applied.end !== pending.end;

  function handleApply() {
    applyTrim();
    onApply();
  }

  return (
    <div className="flex items-center gap-2">
      <span className="font-mono text-[10px] text-muted-foreground">{pending.start.toLocaleString()}</span>
      <input
        type="range"
        min={minTimestampUs}
        max={pending.end}
        value={pending.start}
        onChange={(e) => setPendingTrimRange({ start: Number(e.target.value), end: pending.end })}
        className="w-28"
        aria-label="Trim start"
      />
      <input
        type="range"
        min={pending.start}
        max={maxTimestampUs}
        value={pending.end}
        onChange={(e) => setPendingTrimRange({ start: pending.start, end: Number(e.target.value) })}
        className="w-28"
        aria-label="Trim end"
      />
      <span className="font-mono text-[10px] text-muted-foreground">{pending.end.toLocaleString()}</span>
      <Button size="sm" variant={hasPendingChange ? "default" : "secondary"} disabled={!hasPendingChange} onClick={handleApply}>
        Apply
      </Button>
    </div>
  );
}
