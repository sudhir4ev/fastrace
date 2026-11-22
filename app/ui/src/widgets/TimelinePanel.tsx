import { useState } from "react";
import { useWorkspaceStore } from "@/app/store";
import AnomalyRail from "./AnomalyRail";
import SignalSelect from "./SignalSelect";
import TimelineChart from "./TimelineChart";
import TimelineZoomControl from "./TimelineZoomControl";

interface TimelinePanelProps {
  blfPath: string;
}

export default function TimelinePanel({ blfPath }: TimelinePanelProps) {
  const hasActiveSignals = useWorkspaceStore((s) => s.activeSignalIds.size > 0);
  const removeActiveSignal = useWorkspaceStore((s) => s.removeActiveSignal);
  const appliedTrimRange = useWorkspaceStore((s) => s.appliedTrimRange);
  const minTs = appliedTrimRange?.start;
  const maxTs = appliedTrimRange?.end;
  const [pickerOpen, setPickerOpen] = useState(false);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <AnomalyRail blfPath={blfPath} />
      <div className="min-h-0 flex-1">
        <TimelineChart
          blfPath={blfPath}
          minTs={minTs}
          maxTs={maxTs}
          onChartRemove={removeActiveSignal}
          onAddCharts={() => setPickerOpen(true)}
        />
      </div>
      {hasActiveSignals && <TimelineZoomControl />}
      <SignalSelect blfPath={blfPath} open={pickerOpen} onOpenChange={setPickerOpen} />
    </div>
  );
}
