import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/shared/ui/resizable";
import MessageDetails from "./MessageDetails";
import MessageList from "./MessageList";
import Toaster from "./Toaster";
import TopBar from "./TopBar";
import TraceRail from "./TraceRail";

interface WorkspaceLayoutProps {
  blfPath: string;
  prepareTotals: { messages: number; protocol_rows: number; elapsed_ms: number };
  onOpenTrace: () => void;
}

export default function WorkspaceLayout({ blfPath, prepareTotals, onOpenTrace }: WorkspaceLayoutProps) {
  return (
    <div className="flex h-screen flex-col">
      <TopBar traceName={blfPath.split(/[\\/]/).pop() ?? blfPath} onOpenTrace={onOpenTrace} />
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
                <MessageDetails blfPath={blfPath} />
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
