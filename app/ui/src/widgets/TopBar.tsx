import type { TrimRange } from "@/app/store";
import type { ProgressTick } from "@/types";
import { Button } from "@/shared/ui/button";
import TrimControl from "./TrimControl";

interface TopBarProps {
  traceName: string;
  blfPath: string;
  preparing: boolean;
  tick: ProgressTick | null;
  onOpenTrace: () => void;
  onApplyTrim: (range: TrimRange) => void | Promise<void>;
}

function ByteProgress({ tick }: { tick: ProgressTick | null }) {
  const pct =
    tick && tick.bytes_total > 0
      ? Math.min(100, Math.round((tick.bytes_read / tick.bytes_total) * 100))
      : 0;
  return (
    <div className="flex items-center gap-2">
      <div className="h-1.5 w-32 overflow-hidden rounded-full bg-muted">
        <div className="h-full bg-primary transition-[width]" style={{ width: `${pct}%` }} />
      </div>
      <span className="font-mono text-[10px] text-muted-foreground">{pct}%</span>
    </div>
  );
}

export default function TopBar({
  traceName,
  blfPath,
  preparing,
  tick,
  onOpenTrace,
  onApplyTrim,
}: TopBarProps) {
  return (
    <header className="shrink-0 border-b border-border bg-card">
      <div className="flex h-[50px] items-center justify-between px-4">
        <div className="flex min-w-0 items-center gap-3">
          <span className="truncate text-sm font-semibold">{traceName}</span>
          {preparing && <ByteProgress tick={tick} />}
        </div>
        <div className="flex items-center gap-2">
          <Button variant="secondary" size="sm" onClick={onOpenTrace} disabled={preparing}>
            Open Trace
          </Button>
        </div>
      </div>
      {!preparing && (
        <div className="border-t border-border px-4 py-2">
          <TrimControl blfPath={blfPath} onApply={onApplyTrim} />
        </div>
      )}
    </header>
  );
}
