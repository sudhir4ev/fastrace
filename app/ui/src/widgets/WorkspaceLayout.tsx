import type { ReactNode } from "react";
import { useFileSizes, useIsDecodingSignals } from "@/shared/api/hooks";
import { formatBytes } from "@/shared/ui/lib/utils";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/shared/ui/resizable";
import { Skeleton } from "@/shared/ui/skeleton";
import ActivityLog from "./ActivityLog";
import AnalyzerPanel from "./AnalyzerPanel";
import DecodeOverlay from "./DecodeOverlay";
import MessageDetails from "./MessageDetails";
import MessageList from "./MessageList";
import TimelinePanel from "./TimelinePanel";
import Toaster from "./Toaster";
import TopBar from "./TopBar";
import TraceRail from "./TraceRail";
import type { ProgressTick } from "@/types";

interface WorkspaceLayoutProps {
  blfPath: string;
  preparing: boolean;
  tick: ProgressTick | null;
  prepareTotals: { messages: number; protocol_rows: number; elapsed_ms: number } | null;
  onOpenTrace: () => void;
}

function PanelTag({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex h-full flex-col">
      <div className="shrink-0 border-b border-border bg-background px-2 py-1 text-[10px] font-mono uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      <div className="min-h-0 flex-1">{children}</div>
    </div>
  );
}

function PanelSkeleton() {
  return (
    <div className="flex h-full flex-col gap-2 p-3">
      <Skeleton className="h-4 w-2/3" />
      <Skeleton className="h-4 w-full" />
      <Skeleton className="h-4 w-5/6" />
      <Skeleton className="h-4 w-1/2" />
    </div>
  );
}

function StatusBar({
  blfPath,
  prepareTotals,
}: {
  blfPath: string;
  prepareTotals: { messages: number; protocol_rows: number; elapsed_ms: number } | null;
}) {
  const fileSizes = useFileSizes(blfPath);
  return (
    <div className="flex h-[26px] shrink-0 items-center gap-4 bg-foreground px-3 text-[10px] text-background">
      <span>Total messages: {prepareTotals ? prepareTotals.messages : "-"}</span>
      <span>BLF size: {fileSizes.data ? formatBytes(fileSizes.data.blfBytes) : "-"}</span>
      <span>Ingested size: {fileSizes.data ? formatBytes(fileSizes.data.duckdbBytes) : "-"}</span>
      <span className="ml-auto">
        <ActivityLog blfPath={blfPath} />
      </span>
    </div>
  );
}

export default function WorkspaceLayout({ blfPath, preparing, tick, prepareTotals, onOpenTrace }: WorkspaceLayoutProps) {
  const isDecoding = useIsDecodingSignals(blfPath);
  return (
    <div className="flex h-screen flex-col">
      <TopBar
        traceName={blfPath.split(/[\\/]/).pop() ?? blfPath}
        blfPath={blfPath}
        preparing={preparing}
        tick={tick}
        onOpenTrace={onOpenTrace}
        onApplyTrim={() => {}} // replaced with the real handler in Task 12
      />
      <div className="min-h-0 flex-1">
        <ResizablePanelGroup direction="horizontal">
          {/* minSize is % of panel group width; 27% ~= 320px at the default 1200px window width (tauri.conf.json) */}
          <ResizablePanel defaultSize={27} minSize={27}>
            <PanelTag label="Trace Rail">{preparing ? <PanelSkeleton /> : <TraceRail blfPath={blfPath} />}</PanelTag>
          </ResizablePanel>
          <ResizableHandle withHandle />
          <ResizablePanel defaultSize={55}>
            <ResizablePanelGroup direction="vertical">
              <ResizablePanel defaultSize={20} minSize={10}>
                <PanelTag label="Timeline">
                  {preparing ? <PanelSkeleton /> : <TimelinePanel blfPath={blfPath} />}
                </PanelTag>
              </ResizablePanel>
              <ResizableHandle withHandle />
              <ResizablePanel defaultSize={45} minSize={15}>
                <PanelTag label="Message List">
                  {preparing ? <PanelSkeleton /> : <MessageList blfPath={blfPath} />}
                </PanelTag>
              </ResizablePanel>
              <ResizableHandle withHandle />
              <ResizablePanel defaultSize={35} minSize={15}>
                <PanelTag label="Message Details">
                  {preparing ? <PanelSkeleton /> : <MessageDetails blfPath={blfPath} />}
                </PanelTag>
              </ResizablePanel>
            </ResizablePanelGroup>
          </ResizablePanel>
          <ResizableHandle withHandle />
          <ResizablePanel defaultSize={25} minSize={15}>
            <PanelTag label="Analyzer">{preparing ? <PanelSkeleton /> : <AnalyzerPanel blfPath={blfPath} />}</PanelTag>
          </ResizablePanel>
        </ResizablePanelGroup>
      </div>
      <StatusBar blfPath={blfPath} prepareTotals={prepareTotals} />
      <Toaster />
      <DecodeOverlay active={isDecoding} />
    </div>
  );
}
