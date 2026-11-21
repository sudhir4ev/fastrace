import { useWorkspaceStore } from "@/app/store";
import SignalSelect from "./SignalSelect";
import TimelineChart from "./TimelineChart";
import TimelineZoomControl from "./TimelineZoomControl";

interface TimelinePanelProps {
  blfPath: string;
}

export default function TimelinePanel({ blfPath }: TimelinePanelProps) {
  const hasActiveSignals = useWorkspaceStore((s) => s.activeSignalIds.size > 0);
  const appliedTrimRange = useWorkspaceStore((s) => s.appliedTrimRange);
  const minTs = appliedTrimRange?.start;
  const maxTs = appliedTrimRange?.end;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <SignalSelect blfPath={blfPath} />
      <div className="min-h-0 flex-1">
        <TimelineChart blfPath={blfPath} minTs={minTs} maxTs={maxTs} />
      </div>
      {hasActiveSignals && <TimelineZoomControl />}
    </div>
  );
}
