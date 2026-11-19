import type { ProgressTick } from "@/types";
import { Button } from "@/shared/ui/button";
import TrimControl from "./TrimControl";

interface TopBarProps {
  traceName: string;
  blfPath: string;
  preparing: boolean;
  tick: ProgressTick | null;
  onOpenTrace: () => void;
  onApplyTrim: () => void | Promise<void>;
}

function ByteProgress({ tick }: { tick: ProgressTick | null }) {
  const pct = tick && tick.bytes_total > 0 ? Math.min(100, Math.round((tick.bytes_read / tick.bytes_total) * 100)) : 0;
  return (
    <div className="flex items-center gap-2">
      <div className="h-1.5 w-32 overflow-hidden rounded-full bg-muted">
        <div className="h-full bg-primary transition-[width]" style={{ width: `${pct}%` }} />
      </div>
      <span className="font-mono text-[10px] text-muted-foreground">{pct}%</span>
    </div>
  );
}

export default function TopBar({ traceName, blfPath, preparing, tick, onOpenTrace, onApplyTrim }: TopBarProps) {
  return (
    <header className="flex h-[50px] shrink-0 items-center justify-between border-b border-border bg-card px-4">
      <div className="flex min-w-0 items-center gap-3">
        <span className="truncate text-sm font-semibold">{traceName}</span>
        {preparing ? <ByteProgress tick={tick} /> : <TrimControl blfPath={blfPath} onApply={onApplyTrim} />}
      </div>
      <div className="flex items-center gap-2">
        <Button variant="secondary" size="sm" onClick={onOpenTrace} disabled={preparing}>
          Open Trace
        </Button>
      </div>
    </header>
  );
}
