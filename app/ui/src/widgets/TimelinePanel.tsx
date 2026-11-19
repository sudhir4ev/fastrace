import { useWorkspaceStore } from "@/app/store";
import SignalPills from "./SignalPills";
import TimelineChart from "./TimelineChart";
import TimelineZoomControl from "./TimelineZoomControl";

interface TimelinePanelProps {
  blfPath: string;
}

export default function TimelinePanel({ blfPath }: TimelinePanelProps) {
  const hasDisplayedSignals = useWorkspaceStore((s) => s.displayedSignalIds.size > 0);
  const appliedTrimRange = useWorkspaceStore((s) => s.appliedTrimRange);
  const minTs = appliedTrimRange?.start;
  const maxTs = appliedTrimRange?.end;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <SignalPills blfPath={blfPath} />
      <div className="min-h-0 flex-1">
        <TimelineChart blfPath={blfPath} minTs={minTs} maxTs={maxTs} />
      </div>
      {hasDisplayedSignals && <TimelineZoomControl />}
    </div>
  );
}
