import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import type { ProgressTick } from "@/types";

interface DecodeOverlayProps {
  active: boolean;
}

// Full-screen blurred overlay shown while an apply-trim run holds the store's
// write lock (docs/adr/0005's accepted MVP blackout, shared with Prepare per
// docs/adr/0004's amendment). Deliberately not a route swap like Progress.tsx -
// this sits on top of the existing workspace instead.
export default function DecodeOverlay({ active }: DecodeOverlayProps) {
  const [tick, setTick] = useState<ProgressTick | null>(null);

  useEffect(() => {
    if (!active) {
      setTick(null);
      return;
    }
    // apply_trim emits "apply-trim-progress" (the old "decode-progress" event
    // was retired with the decode_signals command).
    const unlisten = listen<ProgressTick>("apply-trim-progress", (event) => {
      setTick(event.payload);
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  }, [active]);

  if (!active) return null;

  return (
    <div className="fixed inset-0 z-40 flex flex-col items-center justify-center gap-2 bg-background/60 backdrop-blur-sm">
      <div className="h-8 w-8 animate-spin rounded-full border-2 border-muted-foreground border-t-transparent" />
      <p className="text-sm text-foreground">Reading payloads...</p>
      {tick && <p className="text-xs text-muted-foreground">{tick.messages.toLocaleString()} messages scanned</p>}
    </div>
  );
}
