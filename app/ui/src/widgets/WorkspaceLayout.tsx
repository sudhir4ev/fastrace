import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/shared/ui/resizable";
import MessageList from "./MessageList";
import Toaster from "./Toaster";
import TraceRail from "./TraceRail";

interface WorkspaceLayoutProps {
  blfPath: string;
  prepareTotals: { messages: number; protocol_rows: number; elapsed_ms: number };
  onOpenTrace: () => void;
}

export default function WorkspaceLayout({ blfPath, prepareTotals, onOpenTrace }: WorkspaceLayoutProps) {
  return (
    <div className="flex h-screen flex-col">
      <div className="flex h-[50px] shrink-0 items-center border-b border-border bg-card px-4 text-sm font-semibold">
        Top Bar
      </div>
      <div className="flex-1">
        <ResizablePanelGroup direction="horizontal">
          <ResizablePanel defaultSize={20} minSize={15}>
            <TraceRail blfPath={blfPath} />
          </ResizablePanel>
          <ResizableHandle withHandle />
          <ResizablePanel defaultSize={55}>
            <ResizablePanelGroup direction="vertical">
              <ResizablePanel defaultSize={40} minSize={20}>
                <div className="flex h-full items-center justify-center text-sm text-muted-foreground">Timeline</div>
              </ResizablePanel>
              <ResizableHandle withHandle />
              <ResizablePanel defaultSize={35} minSize={15}>
                <MessageList blfPath={blfPath} />
              </ResizablePanel>
              <ResizableHandle withHandle />
              <ResizablePanel defaultSize={25} minSize={15}>
                <div className="flex h-full items-center justify-center text-sm text-muted-foreground">Message Details</div>
              </ResizablePanel>
            </ResizablePanelGroup>
          </ResizablePanel>
          <ResizableHandle withHandle />
          <ResizablePanel defaultSize={25} minSize={15}>
            <div className="flex h-full items-center justify-center text-sm text-muted-foreground">Analyzer</div>
          </ResizablePanel>
        </ResizablePanelGroup>
      </div>
      <Toaster />
    </div>
  );
}
