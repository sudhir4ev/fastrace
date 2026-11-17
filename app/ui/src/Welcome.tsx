import { useEffect, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { FileCode, FolderOpen, Trash2, Waypoints } from "lucide-react";
import { usePathSize, useRecentTraces, useRemoveRecentTrace } from "@/shared/api/hooks";
import { getTraceDataSource, type PrepareMeta, type RecentTraceInfo } from "@/shared/api/trace-source";
import { Button } from "@/shared/ui/button";
import { formatBytes, truncatePathStart } from "@/shared/ui/lib/utils";
import { Separator } from "@/shared/ui/separator";

interface WelcomeProps {
  onStart: (blfPath: string, arxmlPath: string) => void;
  onOpenExisting: (blfPath: string, meta?: PrepareMeta) => void;
}

function basename(path: string) {
  return path.split(/[\\/]/).pop() ?? path;
}

function toPrepareMeta(trace: RecentTraceInfo | undefined): PrepareMeta | undefined {
  if (!trace || trace.messages === null || trace.protocolRows === null || trace.elapsedMs === null) return undefined;
  return { messages: trace.messages, protocolRows: trace.protocolRows, elapsedMs: trace.elapsedMs };
}

export default function Welcome({ onStart, onOpenExisting }: WelcomeProps) {
  const [blfPath, setBlfPath] = useState<string | null>(null);
  const [arxmlPath, setArxmlPath] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [storeExists, setStoreExists] = useState(false);
  const recentTraces = useRecentTraces();
  const removeRecentTrace = useRemoveRecentTrace();
  const blfSize = usePathSize(blfPath);
  const arxmlSize = usePathSize(arxmlPath);

  useEffect(() => {
    if (!blfPath) {
      setStoreExists(false);
      return;
    }
    let cancelled = false;
    getTraceDataSource()
      .checkExistingStore(blfPath)
      .then((exists) => {
        if (!cancelled) setStoreExists(exists);
      });
    return () => {
      cancelled = true;
    };
  }, [blfPath]);

  async function pickBlf() {
    const picked = await open({ filters: [{ name: "BLF", extensions: ["blf"] }] });
    if (typeof picked === "string") setBlfPath(picked);
  }

  async function pickArxml() {
    const picked = await open({ filters: [{ name: "ARXML", extensions: ["arxml"] }] });
    if (typeof picked === "string") setArxmlPath(picked);
  }

  function handleStart() {
    if (!blfPath || !arxmlPath || starting) return;
    setStarting(true);
    onStart(blfPath, arxmlPath);
  }

  function handleOpenExisting(path: string, meta?: PrepareMeta) {
    if (starting) return;
    setStarting(true);
    onOpenExisting(path, meta);
  }

  async function handleReIngest() {
    if (!blfPath || starting) return;
    await getTraceDataSource().deleteTraceStore(blfPath);
    setStoreExists(false);
  }

  return (
    <div className="flex h-screen items-center justify-center bg-background">
      <div className="w-[560px] space-y-8">
        <div className="flex items-center gap-3">
          <Waypoints className="h-9 w-9 text-primary" />
          <div>
            <h1 className="text-2xl font-bold leading-tight">fastrace</h1>
            <p className="text-sm text-muted-foreground">Automotive trace analysis</p>
          </div>
        </div>

        <div className="space-y-1">
          <h2 className="text-sm font-semibold text-muted-foreground">Start</h2>
          <Button variant="ghost" className="h-auto w-full justify-start gap-3 px-2 py-2" onClick={pickBlf}>
            <FolderOpen className="h-4 w-4 text-primary" />
            <span>Choose BLF...</span>
            {blfPath && (
              <span className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground" title={blfPath}>
                <span className="truncate">{truncatePathStart(blfPath)}</span>
                {blfSize.data !== undefined && <span className="shrink-0">{formatBytes(blfSize.data)}</span>}
              </span>
            )}
          </Button>

          {blfPath &&
            (storeExists ? (
              <div className="flex items-center justify-between gap-3 px-2 py-2">
                <span className="text-xs text-muted-foreground">Trace Store already ingested for this BLF.</span>
                <div className="flex shrink-0 gap-2">
                  <Button variant="outline" size="sm" disabled={starting} onClick={handleReIngest}>
                    Delete &amp; Re-ingest
                  </Button>
                  <Button
                    size="sm"
                    disabled={starting}
                    onClick={() =>
                      handleOpenExisting(blfPath, toPrepareMeta(recentTraces.data?.find((t) => t.blfPath === blfPath)))
                    }
                  >
                    Open Trace
                  </Button>
                </div>
              </div>
            ) : (
              <>
                <Button variant="ghost" className="h-auto w-full justify-start gap-3 px-2 py-2" onClick={pickArxml}>
                  <FileCode className="h-4 w-4 text-primary" />
                  <span>Choose ARXML...</span>
                  {arxmlPath && (
                    <span className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground" title={arxmlPath}>
                      <span className="truncate">{truncatePathStart(arxmlPath)}</span>
                      {arxmlSize.data !== undefined && <span className="shrink-0">({formatBytes(arxmlSize.data)})</span>}
                    </span>
                  )}
                </Button>
                <div className="px-2 pt-2">
                  <Button disabled={!blfPath || !arxmlPath || starting} onClick={handleStart}>
                    Start Processing
                  </Button>
                </div>
              </>
            ))}
        </div>

        {recentTraces.data && recentTraces.data.length > 0 && (
          <>
            <Separator />
            <div className="space-y-1">
              <h2 className="text-sm font-semibold text-muted-foreground">Recent</h2>
              {recentTraces.data.map((trace) => (
                <div key={trace.blfPath} className="group flex items-center gap-3 rounded-md px-2 py-1.5 hover:bg-accent">
                  <button
                    className="flex min-w-0 flex-1 items-center gap-3 text-left"
                    disabled={starting}
                    onClick={() => handleOpenExisting(trace.blfPath, toPrepareMeta(trace))}
                  >
                    <span className="shrink-0 text-sm font-medium text-primary">{basename(trace.blfPath)}</span>
                    <span className="truncate text-xs text-muted-foreground" title={trace.blfPath}>
                      {truncatePathStart(trace.blfPath)}
                    </span>
                  </button>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {trace.duckdbBytes !== null ? formatBytes(trace.duckdbBytes) : "-"}
                  </span>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7 shrink-0 opacity-0 group-hover:opacity-100"
                    aria-label="Remove from recent traces"
                    onClick={() => removeRecentTrace(trace.blfPath)}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
