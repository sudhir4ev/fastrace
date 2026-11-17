import type { ReactNode } from "react";
import { useFileSizes } from "@/shared/api/hooks";
import { formatBytes } from "@/shared/ui/lib/utils";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/shared/ui/resizable";
import AnalyzerPanel from "./AnalyzerPanel";
import MessageDetails from "./MessageDetails";
import MessageList from "./MessageList";
import TimelinePanel from "./TimelinePanel";
import Toaster from "./Toaster";
import TopBar from "./TopBar";
import TraceRail from "./TraceRail";

interface WorkspaceLayoutProps {
  blfPath: string;
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
      <span>Ingestion time: {prepareTotals ? `${prepareTotals.elapsed_ms} ms` : "-"}</span>
      <span>BLF size: {fileSizes.data ? formatBytes(fileSizes.data.blfBytes) : "-"}</span>
      <span>Ingested size: {fileSizes.data ? formatBytes(fileSizes.data.duckdbBytes) : "-"}</span>
    </div>
  );
}

export default function WorkspaceLayout({ blfPath, prepareTotals, onOpenTrace }: WorkspaceLayoutProps) {
  return (
    <div className="flex h-screen flex-col">
      <TopBar traceName={blfPath.split(/[\\/]/).pop() ?? blfPath} onOpenTrace={onOpenTrace} />
      <div className="min-h-0 flex-1">
        <ResizablePanelGroup direction="horizontal">
          <ResizablePanel defaultSize={20} minSize={15}>
            <PanelTag label="Trace Rail">
              <TraceRail blfPath={blfPath} />
            </PanelTag>
          </ResizablePanel>
          <ResizableHandle withHandle />
          <ResizablePanel defaultSize={55}>
            <ResizablePanelGroup direction="vertical">
              <ResizablePanel defaultSize={40} minSize={20}>
                <PanelTag label="Timeline">
                  <TimelinePanel />
                </PanelTag>
              </ResizablePanel>
              <ResizableHandle withHandle />
              <ResizablePanel defaultSize={35} minSize={15}>
                <PanelTag label="Message List">
                  <MessageList blfPath={blfPath} />
                </PanelTag>
              </ResizablePanel>
              <ResizableHandle withHandle />
              <ResizablePanel defaultSize={25} minSize={15}>
                <PanelTag label="Message Details">
                  <MessageDetails blfPath={blfPath} />
                </PanelTag>
              </ResizablePanel>
            </ResizablePanelGroup>
          </ResizablePanel>
          <ResizableHandle withHandle />
          <ResizablePanel defaultSize={25} minSize={15}>
            <PanelTag label="Analyzer">
              <AnalyzerPanel />
            </PanelTag>
          </ResizablePanel>
        </ResizablePanelGroup>
      </div>
      <StatusBar blfPath={blfPath} prepareTotals={prepareTotals} />
      <Toaster />
    </div>
  );
}
