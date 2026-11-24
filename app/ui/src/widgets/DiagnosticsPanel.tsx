import { useWorkspaceStore } from "@/app/store";
import { ScrollArea } from "@/shared/ui/scroll-area";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/shared/ui/tabs";

function TimelineDiagnosticsView() {
  const diagnostics = useWorkspaceStore((s) => s.timelineDiagnostics);

  if (!diagnostics) {
    return <p className="p-3 text-xs text-muted-foreground">No Timeline data yet - display a signal to populate this view.</p>;
  }

  const { viewport, signals, overlayBinCount, overlayError } = diagnostics;
  const spanUs = viewport.endUs - viewport.startUs;

  return (
    <div className="flex h-full flex-col gap-2 p-3 text-xs">
      <div className="grid grid-cols-4 gap-x-4 gap-y-1 font-mono">
        <span className="text-muted-foreground">Viewport startUs</span>
        <span>{viewport.startUs}</span>
        <span className="text-muted-foreground">Viewport endUs</span>
        <span>{viewport.endUs}</span>
        <span className="text-muted-foreground">Span (us)</span>
        <span>{spanUs}</span>
        <span className="text-muted-foreground">Pixel width</span>
        <span>{viewport.pixelWidth}</span>
        <span className="text-muted-foreground">Anomaly Overlay bins</span>
        <span>{overlayBinCount}</span>
        <span className="text-muted-foreground">Overlay error</span>
        <span className={overlayError ? "text-destructive" : undefined}>{overlayError ?? "-"}</span>
      </div>
      <ScrollArea className="min-h-0 flex-1 rounded border border-border">
        <table className="w-full font-mono text-xs">
          <thead className="sticky top-0 bg-muted text-left text-muted-foreground">
            <tr>
              <th className="px-2 py-1">Signal</th>
              <th className="px-2 py-1">Algorithm</th>
              <th className="px-2 py-1">Points rendered</th>
            </tr>
          </thead>
          <tbody>
            {signals.length === 0 ? (
              <tr>
                <td className="px-2 py-1 text-muted-foreground" colSpan={3}>
                  No signals displayed.
                </td>
              </tr>
            ) : (
              signals.map((s) => (
                <tr key={s.signalId} className="border-t border-border">
                  <td className="px-2 py-1">{s.name}</td>
                  <td className="px-2 py-1">{s.algorithm}</td>
                  <td className="px-2 py-1">{s.pointCount}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </ScrollArea>
    </div>
  );
}

export default function DiagnosticsPanel() {
  const open = useWorkspaceStore((s) => s.diagnosticsOpen);
  if (!open) return null;

  return (
    <div className="flex h-56 shrink-0 flex-col border-t border-border bg-background">
      <Tabs defaultValue="timeline" className="flex h-full min-h-0 flex-col">
        <TabsList className="mx-2 mt-1 w-fit shrink-0">
          <TabsTrigger value="timeline">Timeline</TabsTrigger>
        </TabsList>
        <TabsContent value="timeline" className="mt-0 min-h-0 flex-1">
          <TimelineDiagnosticsView />
        </TabsContent>
      </Tabs>
    </div>
  );
}
