import { useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Filter } from "lucide-react";
import { useWorkspaceStore } from "@/app/store";
import { useDecodeSignals, useSignalCatalog, useSignalSamples } from "@/shared/api/hooks";
import { Badge } from "@/shared/ui/badge";
import { Button } from "@/shared/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/shared/ui/popover";
import { cn } from "@/shared/ui/lib/utils";

function setsEqual(a: Set<number>, b: Set<number>): boolean {
  if (a.size !== b.size) return false;
  for (const x of a) {
    if (!b.has(x)) return false;
  }
  return true;
}

interface SignalsListProps {
  blfPath: string;
}

export default function SignalsList({ blfPath }: SignalsListProps) {
  const catalog = useSignalCatalog(blfPath);
  const activeSignalIds = useWorkspaceStore((s) => s.activeSignalIds);
  const pendingSignalIds = useWorkspaceStore((s) => s.pendingSignalIds);
  const setPendingSignalIds = useWorkspaceStore((s) => s.setPendingSignalIds);
  const commitActiveSignalIds = useWorkspaceStore((s) => s.commitActiveSignalIds);
  const autoDisplayFirstIfEmpty = useWorkspaceStore((s) => s.autoDisplayFirstIfEmpty);
  const trimRange = useWorkspaceStore((s) => s.appliedTrimRange);
  const decodeSignals = useDecodeSignals(blfPath);
  const [signalFilter, setSignalFilter] = useState("");
  const [hideNonDecodable, setHideNonDecodable] = useState(true);
  const [hideConstant, setHideConstant] = useState(true);
  const [previewSignalId, setPreviewSignalId] = useState<number | null>(null);
  const samples = useSignalSamples(
    blfPath,
    previewSignalId,
    trimRange?.start ?? 0,
    trimRange?.end ?? Number.MAX_SAFE_INTEGER
  );

  const nonDecodableCount = catalog.data?.filter((s) => !s.decodable).length ?? 0;
  const constantCount = catalog.data?.filter((s) => s.decodable && s.changes === 0).length ?? 0;
  const filteredSignals = catalog.data
    ?.filter((s) => !hideNonDecodable || s.decodable)
    .filter((s) => !hideConstant || s.changes > 0)
    .filter((s) => `${s.name} ${s.parentLabel}`.toLowerCase().includes(signalFilter.toLowerCase()));
  const hasPendingSignalChanges = !setsEqual(pendingSignalIds, activeSignalIds);
  const filtersActive = !hideNonDecodable || !hideConstant;

  const parentRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: filteredSignals?.length ?? 0,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 32,
    overscan: 10,
  });

  function toggleSignal(id: number) {
    const next = new Set(pendingSignalIds);
    if (next.has(id)) {
      next.delete(id);
    } else {
      next.add(id);
    }
    setPendingSignalIds(next);
  }

  function readPayloads() {
    const toDecode = (catalog.data ?? [])
      .filter((s) => pendingSignalIds.has(s.signalId) && !s.cached && !s.opaque)
      .map((s) => s.signalId);
    const nextActive = new Set(pendingSignalIds);
    if (toDecode.length > 0 && trimRange) {
      decodeSignals.mutate(
        { signalIds: toDecode, startUs: trimRange.start, endUs: trimRange.end },
        {
          onSuccess: () => {
            commitActiveSignalIds(nextActive);
            autoDisplayFirstIfEmpty(toDecode[0]);
          },
        }
      );
    } else {
      commitActiveSignalIds(nextActive);
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {catalog.data && catalog.data.length > 0 && (
        <div className="flex shrink-0 flex-wrap items-center gap-2 p-2">
          <input
            type="text"
            value={signalFilter}
            onChange={(e) => setSignalFilter(e.target.value)}
            placeholder="Filter signals..."
            className="min-w-0 flex-1 rounded-md border border-input bg-background px-2 py-1 text-sm shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          />
          <Popover>
            <PopoverTrigger asChild>
              <Button variant={filtersActive ? "secondary" : "outline"} size="icon" className="relative shrink-0">
                <Filter className="h-4 w-4" />
                {filtersActive && <span className="absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-primary" />}
              </Button>
            </PopoverTrigger>
            <PopoverContent align="end" className="w-64">
              <div className="flex flex-col gap-2 text-sm">
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={!hideNonDecodable}
                    onChange={(e) => setHideNonDecodable(!e.target.checked)}
                  />
                  Show non-decodable ({nonDecodableCount})
                </label>
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={!hideConstant}
                    onChange={(e) => setHideConstant(!e.target.checked)}
                  />
                  Show constants ({constantCount})
                </label>
              </div>
            </PopoverContent>
          </Popover>
        </div>
      )}
      <div className="min-h-0 flex-1">
        {catalog.isPending && <p className="p-3 text-sm text-muted-foreground">Loading...</p>}
        {catalog.isError && <p className="p-3 text-sm text-muted-foreground">Couldn't load signal catalog.</p>}
        {catalog.data?.length === 0 && (
          <p className="p-3 text-sm text-muted-foreground">No signals in this trace's ARXML.</p>
        )}
        {catalog.data && catalog.data.length > 0 && filteredSignals?.length === 0 && (
          <p className="p-3 text-sm text-muted-foreground">
            {signalFilter
              ? `No signals match "${signalFilter}".`
              : "No matching signals - try showing constant or non-decodable ones."}
          </p>
        )}
        {filteredSignals && filteredSignals.length > 0 && (
          <div ref={parentRef} className="h-full overflow-auto">
            <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
              {virtualizer.getVirtualItems().map((item) => {
                const s = filteredSignals[item.index];
                const selectable = s.decodable && !s.opaque;
                return (
                  <div
                    key={s.signalId}
                    className={cn(
                      "absolute left-0 top-0 flex w-full items-center gap-2 px-3 text-sm",
                      !selectable && "opacity-50"
                    )}
                    style={{ height: item.size, transform: `translateY(${item.start}px)` }}
                  >
                    <input
                      type="checkbox"
                      checked={pendingSignalIds.has(s.signalId)}
                      disabled={!selectable}
                      onChange={() => toggleSignal(s.signalId)}
                    />
                    <button
                      className={cn("min-w-0 flex-1 truncate text-left", s.cached && "hover:underline")}
                      disabled={!s.cached}
                      onClick={() => setPreviewSignalId(s.signalId)}
                    >
                      {s.name || `signal ${s.signalId}`}
                    </button>
                    <span className="shrink-0 text-xs text-muted-foreground">{s.parentLabel}</span>
                    {s.decodable && (
                      <span className="shrink-0 text-xs text-muted-foreground">{s.changes} ch</span>
                    )}
                    {s.opaque && (
                      <Badge variant="outline" className="px-1.5 py-0">
                        opaque
                      </Badge>
                    )}
                    {s.cached && (
                      <Badge variant="secondary" className="px-1.5 py-0">
                        cached
                      </Badge>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>

      {previewSignalId !== null && (
        <div className="shrink-0 border-t border-border p-2">
          <div className="mb-1 flex items-center justify-between text-xs text-muted-foreground">
            <span>Preview: {catalog.data?.find((s) => s.signalId === previewSignalId)?.name}</span>
            <button onClick={() => setPreviewSignalId(null)} aria-label="Close preview">
              &times;
            </button>
          </div>
          {samples.isPending && <p className="text-xs text-muted-foreground">Loading...</p>}
          {samples.isError && <p className="text-xs text-muted-foreground">Couldn't load samples.</p>}
          {samples.data && samples.data.length === 0 && (
            <p className="text-xs text-muted-foreground">No decoded samples yet.</p>
          )}
          {samples.data && samples.data.length > 0 && (
            <table className="w-full text-xs">
              <thead>
                <tr className="text-muted-foreground">
                  <th className="text-left font-normal">Timestamp (us)</th>
                  <th className="text-left font-normal">Value</th>
                </tr>
              </thead>
              <tbody>
                {samples.data.map(([ts, value]) => (
                  <tr key={ts}>
                    <td>{ts}</td>
                    <td>{value}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {hasPendingSignalChanges && (
        <div className="shrink-0 border-t border-border p-2">
          <Button size="sm" className="w-full" onClick={readPayloads} disabled={decodeSignals.isPending}>
            Read Payloads
          </Button>
        </div>
      )}
    </div>
  );
}
