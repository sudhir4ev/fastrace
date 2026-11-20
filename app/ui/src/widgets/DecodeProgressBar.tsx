import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { useIsApplyingTrim } from "@/shared/api/hooks";
import type { ProgressTick } from "@/types";

interface DecodeProgressBarProps {
  blfPath: string;
}

/** 2px full-width strip under the trim control: gray when idle, fill while apply-trim runs. */
export default function DecodeProgressBar({ blfPath }: DecodeProgressBarProps) {
  const active = useIsApplyingTrim(blfPath);
  const [tick, setTick] = useState<ProgressTick | null>(null);

  useEffect(() => {
    if (!active) {
      setTick(null);
      return;
    }
    const unlisten = listen<ProgressTick>("apply-trim-progress", (event) => {
      setTick(event.payload);
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  }, [active]);

  const pct =
    active && tick && tick.bytes_total > 0
      ? Math.min(100, Math.round((tick.bytes_read / tick.bytes_total) * 100))
      : 0;

  return (
    <div className="h-[2px] w-full shrink-0 bg-border" aria-hidden={!active}>
      {active && <div className="h-full bg-primary transition-[width] duration-150" style={{ width: `${pct}%` }} />}
    </div>
  );
}
