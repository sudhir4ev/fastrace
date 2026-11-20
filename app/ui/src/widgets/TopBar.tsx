import type { TrimRange } from "@/app/store";
import type { ProgressTick } from "@/types";
import DecodeProgressBar from "./DecodeProgressBar";
import TrimControl from "./TrimControl";

interface TopBarProps {
  blfPath: string;
  preparing: boolean;
  tick: ProgressTick | null;
  onApplyTrim: (range: TrimRange) => void | Promise<void>;
}

function ByteProgress({ tick }: { tick: ProgressTick | null }) {
  const pct =
    tick && tick.bytes_total > 0
      ? Math.min(100, Math.round((tick.bytes_read / tick.bytes_total) * 100))
      : 0;
  return (
    <div className="flex items-center gap-2 px-4 py-2">
      <div className="h-1.5 w-32 overflow-hidden rounded-full bg-muted">
        <div className="h-full bg-primary transition-[width]" style={{ width: `${pct}%` }} />
      </div>
      <span className="font-mono text-[10px] text-muted-foreground">{pct}%</span>
    </div>
  );
}

export default function TopBar({ blfPath, preparing, tick, onApplyTrim }: TopBarProps) {
  return (
    <header className="shrink-0 border-b border-border bg-card">
      {preparing ? (
        <ByteProgress tick={tick} />
      ) : (
        <>
          <div className="px-4 py-2">
            <TrimControl blfPath={blfPath} onApply={onApplyTrim} />
          </div>
          <DecodeProgressBar blfPath={blfPath} />
        </>
      )}
    </header>
  );
}
