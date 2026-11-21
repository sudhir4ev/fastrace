import { useWorkspaceStore, type WorkspaceTab } from "@/app/store";
import { useApplyTrim, useFileSizes } from "@/shared/api/hooks";
import { formatBytes } from "@/shared/ui/lib/utils";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/shared/ui/resizable";
import { Skeleton } from "@/shared/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/shared/ui/tabs";
import ActivityLog from "./ActivityLog";
import AnalyzerPanel from "./AnalyzerPanel";
import MessageDetails from "./MessageDetails";
import MessageGroupSelect from "./MessageGroupSelect";
import MessageList from "./MessageList";
import TimelinePanel from "./TimelinePanel";
import Toaster from "./Toaster";
import TopBar from "./TopBar";
import type { ProgressTick } from "@/types";

interface WorkspaceLayoutProps {
  blfPath: string;
  preparing: boolean;
  tick: ProgressTick | null;
  prepareTotals: { messages: number; protocol_rows: number; elapsed_ms: number } | null;
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
  const fileName = blfPath.split(/[\\/]/).pop() ?? blfPath;
  return (
    <div className="flex h-[26px] shrink-0 items-center gap-4 bg-foreground px-3 text-[10px] text-background">
      <span className="max-w-[40%] truncate font-medium" title={blfPath}>
        {fileName}
      </span>
      <span>Total messages: {prepareTotals ? prepareTotals.messages : "-"}</span>
      <span>BLF size: {fileSizes.data ? formatBytes(fileSizes.data.blfBytes) : "-"}</span>
      <span>Ingested size: {fileSizes.data ? formatBytes(fileSizes.data.duckdbBytes) : "-"}</span>
      <span className="ml-auto">
        <ActivityLog blfPath={blfPath} />
      </span>
    </div>
  );
}

function SignalsTab({ blfPath, preparing }: { blfPath: string; preparing: boolean }) {
  return (
    <ResizablePanelGroup direction="vertical">
      <ResizablePanel defaultSize={60} minSize={25}>
        {preparing ? <PanelSkeleton /> : <TimelinePanel blfPath={blfPath} />}
      </ResizablePanel>
      <ResizableHandle withHandle />
      <ResizablePanel defaultSize={40} minSize={15}>
        {preparing ? <PanelSkeleton /> : <AnalyzerPanel blfPath={blfPath} />}
      </ResizablePanel>
    </ResizablePanelGroup>
  );
}

function MessagesTab({ blfPath, preparing }: { blfPath: string; preparing: boolean }) {
  const selectedMessageId = useWorkspaceStore((s) => s.selectedMessageId);

  if (preparing) {
    return <PanelSkeleton />;
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <MessageGroupSelect blfPath={blfPath} />
      {selectedMessageId === null ? (
        <div className="min-h-0 flex-1">
          <MessageList blfPath={blfPath} />
        </div>
      ) : (
        <div className="min-h-0 flex-1">
          <ResizablePanelGroup direction="vertical">
            <ResizablePanel defaultSize={55} minSize={25}>
              <MessageList blfPath={blfPath} />
            </ResizablePanel>
            <ResizableHandle withHandle />
            <ResizablePanel defaultSize={45} minSize={15}>
              <MessageDetails blfPath={blfPath} />
            </ResizablePanel>
          </ResizablePanelGroup>
        </div>
      )}
    </div>
  );
}

export default function WorkspaceLayout({ blfPath, preparing, tick, prepareTotals }: WorkspaceLayoutProps) {
  const applyTrim = useApplyTrim(blfPath);
  const workspaceTab = useWorkspaceStore((s) => s.workspaceTab);
  const setWorkspaceTab = useWorkspaceStore((s) => s.setWorkspaceTab);

  function handleApplyTrim(range: { start: number; end: number }) {
    const { activeSignalIds } = useWorkspaceStore.getState();
    // Use the range Apply just committed - do not re-read the store (message
    // mode resolves timestamps async; the explicit arg is the source of truth).
    // Incremental decode of active signals' uncovered delta (no-op when already
    // covered / empty). signal_stats stay Prepare-time.
    applyTrim.mutate({
      startUs: range.start,
      endUs: range.end,
      activeSignalIds: Array.from(activeSignalIds),
    });
  }

  return (
    <div className="flex h-screen flex-col">
      <TopBar blfPath={blfPath} preparing={preparing} tick={tick} onApplyTrim={handleApplyTrim} />
      <Tabs
        value={workspaceTab}
        onValueChange={(v) => setWorkspaceTab(v as WorkspaceTab)}
        className="flex min-h-0 flex-1 flex-col"
      >
        <div className="shrink-0 border-b border-border px-3 py-1.5">
          <TabsList>
            <TabsTrigger value="signals">Signals</TabsTrigger>
            <TabsTrigger value="messages">Messages</TabsTrigger>
          </TabsList>
        </div>
        {/* No `display`-setting utility on TabsContent: Radix uses `hidden`,
            and a `flex` class on TabsContent itself defeats the hide. */}
        <TabsContent
          value="signals"
          className="mt-0 min-h-0 flex-1 data-[state=active]:flex data-[state=active]:flex-col"
        >
          <div className="min-h-0 flex-1">
            <SignalsTab blfPath={blfPath} preparing={preparing} />
          </div>
        </TabsContent>
        <TabsContent
          value="messages"
          className="mt-0 min-h-0 flex-1 data-[state=active]:flex data-[state=active]:flex-col"
        >
          <div className="min-h-0 flex-1">
            <MessagesTab blfPath={blfPath} preparing={preparing} />
          </div>
        </TabsContent>
      </Tabs>
      <StatusBar blfPath={blfPath} prepareTotals={prepareTotals} />
      <Toaster />
    </div>
  );
}
