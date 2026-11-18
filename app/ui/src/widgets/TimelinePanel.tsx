import { useSignalCatalog } from "@/shared/api/hooks";
import { useWorkspaceStore } from "@/app/store";
import { getSignalColor } from "@/app/signalColors";
import SignalChart from "./SignalChart";
import SignalPills from "./SignalPills";

interface TimelinePanelProps {
  blfPath: string;
}

export default function TimelinePanel({ blfPath }: TimelinePanelProps) {
  const catalog = useSignalCatalog(blfPath);
  const displayedSignalIds = Array.from(useWorkspaceStore((s) => s.displayedSignalIds));

  return (
    <div className="flex h-full min-h-0 flex-col">
      <SignalPills blfPath={blfPath} />
      <div className="min-h-0 flex-1 overflow-y-auto">
        {displayedSignalIds.length === 0 ? (
          <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
            No signals displayed - click a pill above to plot a decoded signal.
          </div>
        ) : (
          displayedSignalIds.map((signalId, i) => {
            const colorIndex = (catalog.data ?? []).findIndex((c) => c.signalId === signalId);
            const name = catalog.data?.find((s) => s.signalId === signalId)?.name ?? `signal ${signalId}`;
            return (
              <div key={signalId} className="h-48 shrink-0 border-b border-border">
                <SignalChart
                  blfPath={blfPath}
                  signalId={signalId}
                  name={name}
                  color={getSignalColor(colorIndex)}
                  showZoomSlider={i === displayedSignalIds.length - 1}
                />
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
