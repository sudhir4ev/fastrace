import { useEffect } from "react";
import { useSignalCatalog } from "@/shared/api/hooks";
import { useWorkspaceStore } from "@/app/store";
import { getSignalColor } from "@/app/signalColors";
import { cn } from "@/shared/ui/lib/utils";

interface SignalPillsProps {
  blfPath: string;
}

export default function SignalPills({ blfPath }: SignalPillsProps) {
  const catalog = useSignalCatalog(blfPath);
  const displayedSignalIds = useWorkspaceStore((s) => s.displayedSignalIds);
  const toggleDisplayedSignal = useWorkspaceStore((s) => s.toggleDisplayedSignal);
  const reconcileDisplayedSignals = useWorkspaceStore((s) => s.reconcileDisplayedSignals);

  const cachedEntries = catalog.data?.filter((s) => s.cached) ?? [];

  // Pills are a live view of the catalog's cached signals, never a frozen
  // snapshot - if a refetch stops reporting a signal as cached, both its
  // pill (this filter) and any chart for it (store reconciliation) drop out.
  useEffect(() => {
    if (catalog.data) {
      reconcileDisplayedSignals(new Set(cachedEntries.map((s) => s.signalId)));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [catalog.data]);

  if (cachedEntries.length === 0) return null;

  return (
    <div className="flex shrink-0 flex-wrap gap-1.5 border-b border-border p-2">
      {cachedEntries.map((s) => {
        const colorIndex = (catalog.data ?? []).findIndex((c) => c.signalId === s.signalId);
        const color = getSignalColor(colorIndex);
        const displayed = displayedSignalIds.has(s.signalId);
        return (
          <button
            key={s.signalId}
            onClick={() => toggleDisplayedSignal(s.signalId)}
            className={cn(
              "inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium transition-colors"
            )}
            style={
              displayed
                ? { backgroundColor: color, borderColor: color, color: "#fff" }
                : { backgroundColor: "transparent", borderColor: color, color }
            }
          >
            {s.name || `signal ${s.signalId}`}
          </button>
        );
      })}
    </div>
  );
}
