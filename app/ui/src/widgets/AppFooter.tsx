import { useState } from "react";
import { Bug, Database, File, type LucideIcon } from "lucide-react";
import { useWorkspaceStore } from "@/app/store";
import { useFileSizes, useIoBusy, useProject } from "@/shared/api/hooks";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/shared/ui/dialog";
import { cn, formatBytes, formatPathShort } from "@/shared/ui/lib/utils";
import ActivityLog from "./ActivityLog";

interface AppFooterProps {
  blfPath: string;
  preparing: boolean;
  prepareTotals: { messages: number; protocol_rows: number; elapsed_ms: number } | null;
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

// Shows "parentFolder/file.ext", the full path on hover, and copies the
// full path to the clipboard on click.
function FilePathCell({ path }: { path: string }) {
  return (
    <button
      type="button"
      onClick={() => void navigator.clipboard.writeText(path)}
      title={path}
      className="truncate text-left hover:underline"
    >
      {formatPathShort(path)}
    </button>
  );
}

export default function AppFooter({ blfPath, preparing, prepareTotals }: AppFooterProps) {
  const fileSizes = useFileSizes(blfPath);
  const { blfBusy, duckdbBusy } = useIoBusy(blfPath, preparing);
  const diagnosticsOpen = useWorkspaceStore((s) => s.diagnosticsOpen);
  const toggleDiagnostics = useWorkspaceStore((s) => s.toggleDiagnostics);
  const project = useProject(blfPath);
  const [traceContextOpen, setTraceContextOpen] = useState(false);
  const fileName = blfPath.split(/[\\/]/).pop() ?? blfPath;
  const arxmlPath = project.data?.traces[0]?.arxmlPath ?? null;

  return (
    <div className="flex h-[26px] shrink-0 items-center gap-4 bg-foreground px-3 text-[10px] text-background">
      <button
        type="button"
        onClick={() => setTraceContextOpen(true)}
        title={blfPath}
        className="max-w-[40%] truncate font-medium hover:underline"
      >
        {fileName}
      </button>
      <Dialog open={traceContextOpen} onOpenChange={setTraceContextOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Trace context</DialogTitle>
          </DialogHeader>
          <table className="w-full text-xs">
            <tbody>
              <tr className="border-b border-border">
                <td className="w-32 px-4 py-2 font-medium text-muted-foreground">BLF file</td>
                <td className="px-4 py-2">
                  <FilePathCell path={blfPath} />
                  {fileSizes.data && (
                    <span className="ml-2 text-muted-foreground">({formatBytes(fileSizes.data.blfBytes)})</span>
                  )}
                </td>
              </tr>
              <tr className="border-b border-border">
                <td className="px-4 py-2 font-medium text-muted-foreground">ARXML file</td>
                <td className="px-4 py-2">
                  {arxmlPath ? (
                    <FilePathCell path={arxmlPath} />
                  ) : (
                    "Unknown (Prepared before this was tracked)"
                  )}
                </td>
              </tr>
              <tr className="border-b border-border">
                <td className="px-4 py-2 font-medium text-muted-foreground">Total messages</td>
                <td className="px-4 py-2">{prepareTotals ? prepareTotals.messages : "-"}</td>
              </tr>
              <tr>
                <td className="px-4 py-2 font-medium text-muted-foreground">Ingested size</td>
                <td className="px-4 py-2">{fileSizes.data ? formatBytes(fileSizes.data.duckdbBytes) : "-"}</td>
              </tr>
            </tbody>
          </table>
        </DialogContent>
      </Dialog>
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
