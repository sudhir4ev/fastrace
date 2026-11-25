import { useEffect, useRef, useState } from "react";
import { Activity, Bug, Database, File, List, type LucideIcon } from "lucide-react";
import { useWorkspaceStore, type TrimRange, type WorkspaceTab } from "@/app/store";
import { useApplyTrim, useFileSizes, useIoBusy, useProject, useSignalCatalog } from "@/shared/api/hooks";
import { getTraceDataSource } from "@/shared/api/trace-source";
import { Button } from "@/shared/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/shared/ui/dialog";
import { cn, formatBytes } from "@/shared/ui/lib/utils";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/shared/ui/resizable";
import { Skeleton } from "@/shared/ui/skeleton";
import ActivityLog from "./ActivityLog";
import AnalyzerPanel from "./AnalyzerPanel";
import { createDebouncer } from "./debounce";
import DiagnosticsPanel from "./DiagnosticsPanel";
import MessageDetails from "./MessageDetails";
import MessageGroupSelect from "./MessageGroupSelect";
import MessageList from "./MessageList";
import TimelinePanel from "./TimelinePanel";
import Toaster from "./Toaster";
import TopBar from "./TopBar";
import type { ProgressTick } from "@/types";

const NAV_ITEMS: { id: WorkspaceTab; label: string; icon: typeof Activity }[] = [
  { id: "signals", label: "Signals", icon: Activity },
  { id: "messages", label: "Messages", icon: List },
];

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

function StatusIoLed({
  label,
  Icon,
  active,
  title,
}: {
  label: string;
  Icon: LucideIcon;
  active: boolean;
  title: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center",
        active ? "text-emerald-300 status-led-active" : "text-background/35"
      )}
      title={title}
      aria-label={`${label}: ${active ? "busy" : "idle"}`}
      role="status"
    >
      <Icon className="h-3 w-3" aria-hidden />
    </span>
  );
}

function StatusBar({
  blfPath,
  preparing,
  prepareTotals,
}: {
  blfPath: string;
  preparing: boolean;
  prepareTotals: { messages: number; protocol_rows: number; elapsed_ms: number } | null;
}) {
  const fileSizes = useFileSizes(blfPath);
  const { blfBusy, duckdbBusy } = useIoBusy(blfPath, preparing);
  const diagnosticsOpen = useWorkspaceStore((s) => s.diagnosticsOpen);
  const toggleDiagnostics = useWorkspaceStore((s) => s.toggleDiagnostics);
  const project = useProject(blfPath);
  const [filesDialogOpen, setFilesDialogOpen] = useState(false);
  const fileName = blfPath.split(/[\\/]/).pop() ?? blfPath;
  const arxmlPath = project.data?.traces[0]?.arxmlPath ?? null;
  return (
    <div className="flex h-[26px] shrink-0 items-center gap-4 bg-foreground px-3 text-[10px] text-background">
      <button
        type="button"
        onClick={() => setFilesDialogOpen(true)}
        title={blfPath}
        className="max-w-[40%] truncate font-medium hover:underline"
      >
        {fileName}
      </button>
      <Dialog open={filesDialogOpen} onOpenChange={setFilesDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Project files</DialogTitle>
          </DialogHeader>
          <div className="flex flex-col gap-3 px-4 pb-4 text-xs">
            <div className="flex flex-col gap-1">
              <span className="font-medium text-muted-foreground">Trace file</span>
              <span className="break-all">{blfPath}</span>
            </div>
            <div className="flex flex-col gap-1">
              <span className="font-medium text-muted-foreground">ARXML file</span>
              <span className="break-all">{arxmlPath ?? "Unknown (Prepared before this was tracked)"}</span>
            </div>
          </div>
        </DialogContent>
      </Dialog>
      <span>Total messages: {prepareTotals ? prepareTotals.messages : "-"}</span>
      <span>BLF size: {fileSizes.data ? formatBytes(fileSizes.data.blfBytes) : "-"}</span>
      <span>Ingested size: {fileSizes.data ? formatBytes(fileSizes.data.duckdbBytes) : "-"}</span>
      <span className="ml-auto flex items-center gap-3">
        <span className="flex items-center gap-2" aria-label="I/O status">
          <StatusIoLed
            label="BLF"
            Icon={File}
            active={blfBusy}
            title={blfBusy ? "BLF read in progress" : "BLF idle"}
          />
          <StatusIoLed
            label="DuckDB"
            Icon={Database}
            active={duckdbBusy}
            title={duckdbBusy ? "DuckDB busy" : "DuckDB idle"}
          />
        </span>
        <ActivityLog blfPath={blfPath} />
        <button
          type="button"
          onClick={toggleDiagnostics}
          aria-pressed={diagnosticsOpen}
          aria-label="Toggle LOD diagnostics panel"
          title="LOD diagnostics"
          className={cn(
            "inline-flex items-center rounded-sm p-0.5 hover:bg-background/20",
            diagnosticsOpen ? "text-emerald-300" : "text-background/60"
          )}
        >
          <Bug className="h-3 w-3" aria-hidden />
        </button>
      </span>
    </div>
  );
}

function SignalsTab({ blfPath, preparing }: { blfPath: string; preparing: boolean }) {
  return (
    <div className="h-full min-h-0">
      <ResizablePanelGroup direction="vertical" className="h-full">
        <ResizablePanel defaultSize={60} minSize={25}>
          {preparing ? <PanelSkeleton /> : <TimelinePanel blfPath={blfPath} />}
        </ResizablePanel>
        <ResizableHandle withHandle />
        <ResizablePanel defaultSize={40} minSize={15}>
          {preparing ? <PanelSkeleton /> : <AnalyzerPanel blfPath={blfPath} />}
        </ResizablePanel>
      </ResizablePanelGroup>
    </div>
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

  const project = useProject(blfPath);
  const catalog = useSignalCatalog(blfPath);
  const seededRef = useRef<string | null>(null);

  useEffect(() => {
    if (seededRef.current === blfPath) return; // already seeded for this Trace

    if (project.isError) {
      // Fatal Project-file read error (corrupt/truncated JSON). The global
      // QueryCache error handler (app/ui/src/app/query-client.ts) already
      // toasts this in the existing bottom-right stack - nothing more to
      // show here. Reset to defaults by just not restoring anything, and
      // mark seeded so the autosave effect (Task 5) takes over and
      // overwrites the broken file with valid JSON on the next change.
      seededRef.current = blfPath;
      return;
    }

    if (!project.data || !catalog.data) return;
    seededRef.current = blfPath;

    const knownIds = new Set(catalog.data.map((c) => c.signalId));
    const restoredSignals = new Set(project.data.displayedSignalIds.filter((id) => knownIds.has(id)));
    if (restoredSignals.size > 0) {
      useWorkspaceStore.getState().commitActiveSignalIds(restoredSignals);
    }

    if (project.data.trimWindow) {
      useWorkspaceStore
        .getState()
        .commitTrimRange({ start: project.data.trimWindow.startUs, end: project.data.trimWindow.endUs });
    }

    const [trace] = project.data.traces;
    if (trace) {
      for (const [signalIdStr, algorithm] of Object.entries(trace.downsamplingAlgorithms)) {
        if (algorithm === "min_max" || algorithm === "lttb") {
          useWorkspaceStore.getState().setSignalDownsamplingAlgorithm(Number(signalIdStr), algorithm);
        }
      }
    }
  }, [project.data, project.isError, catalog.data, blfPath]);

  const activeSignalIds = useWorkspaceStore((s) => s.activeSignalIds);
  const appliedTrimRange = useWorkspaceStore((s) => s.appliedTrimRange);
  const signalDownsamplingAlgorithms = useWorkspaceStore((s) => s.signalDownsamplingAlgorithms);
  const saveDebouncerRef = useRef(
    createDebouncer(
      1000,
      (path: string, signalIds: number[], trim: TrimRange | null, algos: Record<number, "min_max" | "lttb">) => {
        // One call, one backend read-modify-write cycle - firing three
        // separate fire-and-forget commands here would race each other's
        // read and lose whichever write landed on the stalest state.
        void getTraceDataSource().saveProject(
          path,
          signalIds,
          trim ? { startUs: trim.start, endUs: trim.end } : null,
          algos
        );
      }
    )
  );

  useEffect(() => {
    if (seededRef.current !== blfPath) return; // don't autosave until the initial load has applied
    saveDebouncerRef.current.call(blfPath, Array.from(activeSignalIds), appliedTrimRange, signalDownsamplingAlgorithms);
  }, [blfPath, activeSignalIds, appliedTrimRange, signalDownsamplingAlgorithms]);

  // flush (not cancel): ADR 0010 requires autosave flushed on project-close.
  // Unmount happens when closeProject() in App.tsx leaves the workspace -
  // covers in-app Close Project, not OS-level app-quit (accepted gap).
  useEffect(() => () => saveDebouncerRef.current.flush(), []);

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
      <div className="flex min-h-0 flex-1 overflow-hidden">
        <nav
          className="flex w-11 shrink-0 flex-col items-center gap-1 border-r border-border py-2"
          aria-label="Workspace"
        >
          {NAV_ITEMS.map(({ id, label, icon: Icon }) => {
            const active = workspaceTab === id;
            return (
              <Button
                key={id}
                type="button"
                variant="ghost"
                size="icon"
                title={label}
                aria-label={label}
                aria-current={active ? "page" : undefined}
                onClick={() => setWorkspaceTab(id)}
                className={cn(
                  "h-9 w-9 text-muted-foreground",
                  active && "bg-muted text-foreground"
                )}
              >
                <Icon className="h-4 w-4" />
              </Button>
            );
          })}
        </nav>
        {/* Keep both views mounted (hidden when inactive) so timeline chart
            state survives nav switches; ResizeObserver handles re-show. */}
        <main className="relative min-h-0 min-w-0 flex-1 overflow-hidden">
          <div className={cn("absolute inset-0", workspaceTab !== "signals" && "hidden")} aria-hidden={workspaceTab !== "signals"}>
            <SignalsTab blfPath={blfPath} preparing={preparing} />
          </div>
          <div className={cn("absolute inset-0", workspaceTab !== "messages" && "hidden")} aria-hidden={workspaceTab !== "messages"}>
            <MessagesTab blfPath={blfPath} preparing={preparing} />
          </div>
        </main>
      </div>
      <DiagnosticsPanel />
      <StatusBar blfPath={blfPath} preparing={preparing} prepareTotals={prepareTotals} />
      <Toaster />
    </div>
  );
}
