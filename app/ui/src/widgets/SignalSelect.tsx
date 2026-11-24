import { useEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Filter } from "lucide-react";
import { useWorkspaceStore } from "@/app/store";
import { useApplyTrim, useSignalCatalog } from "@/shared/api/hooks";
import { Badge } from "@/shared/ui/badge";
import { Button } from "@/shared/ui/button";
import { Checkbox } from "@/shared/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/shared/ui/dialog";
import { Popover, PopoverContent, PopoverTrigger } from "@/shared/ui/popover";
import { cn } from "@/shared/ui/lib/utils";

function setsEqual(a: Set<number>, b: Set<number>): boolean {
  if (a.size !== b.size) return false;
  for (const x of a) {
    if (!b.has(x)) return false;
  }
  return true;
}

interface SignalSelectProps {
  blfPath: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export default function SignalSelect({ blfPath, open, onOpenChange }: SignalSelectProps) {
  const catalog = useSignalCatalog(blfPath);
  const activeSignalIds = useWorkspaceStore((s) => s.activeSignalIds);
  const pendingSignalIds = useWorkspaceStore((s) => s.pendingSignalIds);
  const setPendingSignalIds = useWorkspaceStore((s) => s.setPendingSignalIds);
  const commitActiveSignalIds = useWorkspaceStore((s) => s.commitActiveSignalIds);
  const trimRange = useWorkspaceStore((s) => s.appliedTrimRange);
  const applyTrim = useApplyTrim(blfPath);

  const [signalFilter, setSignalFilter] = useState("");
  const [hideNonDecodable, setHideNonDecodable] = useState(true);
  const [hideConstant, setHideConstant] = useState(true);
  const listRef = useRef<HTMLDivElement>(null);

  const nonDecodableCount = catalog.data?.filter((s) => !s.decodable).length ?? 0;
  const constantCount = catalog.data?.filter((s) => s.decodable && s.changes === 0).length ?? 0;
  const filteredSignals = useMemo(
    () =>
      catalog.data
        ?.filter((s) => !hideNonDecodable || s.decodable)
        .filter((s) => !hideConstant || s.changes > 0)
        .filter((s) => `${s.name} ${s.parentLabel}`.toLowerCase().includes(signalFilter.toLowerCase())),
    [catalog.data, hideNonDecodable, hideConstant, signalFilter]
  );

  const hasPendingSignalChanges = !setsEqual(pendingSignalIds, activeSignalIds);
  const filtersActive = !hideNonDecodable || !hideConstant;
  const rowCount = filteredSignals?.length ?? 0;

  const virtualizer = useVirtualizer({
    count: open ? rowCount : 0,
    getScrollElement: () => listRef.current,
    estimateSize: () => 36,
    overscan: 12,
  });

  // Dialog content is portaled and only gets a real height after open - force
  // the virtualizer to remeasure once layout is ready or the list stays blank.
  useEffect(() => {
    if (!open) return;
    setPendingSignalIds(new Set(activeSignalIds));
    setSignalFilter("");
    const id = requestAnimationFrame(() => {
      virtualizer.measure();
    });
    return () => cancelAnimationFrame(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (!open || rowCount === 0) return;
    virtualizer.measure();
  }, [open, rowCount, virtualizer]);

  function handleOpenChange(next: boolean) {
    if (!next) {
      setPendingSignalIds(new Set(useWorkspaceStore.getState().activeSignalIds));
      setSignalFilter("");
    }
    onOpenChange(next);
  }

  function togglePending(id: number) {
    const next = new Set(pendingSignalIds);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setPendingSignalIds(next);
  }

  function applySelection() {
    const toDecode = (catalog.data ?? [])
      .filter((s) => pendingSignalIds.has(s.signalId) && !s.cached && !s.opaque)
      .map((s) => s.signalId);
    const nextActive = new Set(pendingSignalIds);
    commitActiveSignalIds(nextActive);
    setSignalFilter("");
    onOpenChange(false);
    if (toDecode.length > 0 && trimRange) {
      applyTrim.mutate({
        startUs: trimRange.start,
        endUs: trimRange.end,
        activeSignalIds: Array.from(nextActive),
      });
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="flex h-[min(36rem,calc(100vh-4rem))] w-[min(56rem,calc(100vw-2rem))] max-w-4xl flex-col overflow-hidden p-0">
        <DialogHeader>
          <DialogTitle>Add signals</DialogTitle>
          <DialogDescription>Select signals to decode and plot on the timeline.</DialogDescription>
        </DialogHeader>

        <div className="flex shrink-0 items-center gap-2 border-b border-border px-4 py-2">
          <input
            type="text"
            value={signalFilter}
            onChange={(e) => setSignalFilter(e.target.value)}
            placeholder="Search signals..."
            autoComplete="off"
            autoFocus
            className="min-w-0 flex-1 rounded-md border border-input bg-background px-2 py-1.5 text-sm shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          />
          <Popover>
            <PopoverTrigger asChild>
              <Button
                type="button"
                variant={filtersActive ? "secondary" : "outline"}
                size="icon"
                className="relative h-8 w-8 shrink-0"
              >
                <Filter className="h-3.5 w-3.5" />
                {filtersActive && <span className="absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-primary" />}
              </Button>
            </PopoverTrigger>
            <PopoverContent align="end" className="w-64">
              <div className="flex flex-col gap-2 text-sm">
                <label className="flex items-center gap-2">
                  <Checkbox
                    checked={!hideNonDecodable}
                    onCheckedChange={(checked) => setHideNonDecodable(!checked)}
                  />
                  Show non-decodable ({nonDecodableCount})
                </label>
                <label className="flex items-center gap-2">
                  <Checkbox
                    checked={!hideConstant}
                    onCheckedChange={(checked) => setHideConstant(!checked)}
                  />
                  Show constants ({constantCount})
                </label>
              </div>
            </PopoverContent>
          </Popover>
        </div>

        <div ref={listRef} className="min-h-0 flex-1 overflow-auto">
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
            <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
              {virtualizer.getVirtualItems().map((item) => {
                const s = filteredSignals[item.index];
                const selectable = s.decodable && !s.opaque;
                const checked = pendingSignalIds.has(s.signalId);
                return (
                  <div
                    key={s.signalId}
                    role="button"
                    tabIndex={selectable ? 0 : -1}
                    aria-disabled={!selectable}
                    onClick={() => {
                      if (selectable) togglePending(s.signalId);
                    }}
                    onKeyDown={(e) => {
                      if (!selectable) return;
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        togglePending(s.signalId);
                      }
                    }}
                    className={cn(
                      "absolute left-0 top-0 flex w-full cursor-pointer items-center gap-3 px-4 text-sm hover:bg-accent/60",
                      !selectable && "cursor-not-allowed opacity-50 hover:bg-transparent"
                    )}
                    style={{ height: item.size, transform: `translateY(${item.start}px)` }}
                  >
                    <Checkbox
                      checked={checked}
                      disabled={!selectable}
                      onCheckedChange={() => {
                        if (selectable) togglePending(s.signalId);
                      }}
                      onClick={(e) => e.stopPropagation()}
                    />
                    <span
                      className="min-w-0 flex-1 truncate font-mono text-sm"
                      title={s.name || `signal ${s.signalId}`}
                    >
                      {s.name || `signal ${s.signalId}`}
                    </span>
                    <span
                      className="max-w-[40%] shrink-0 truncate text-xs text-muted-foreground"
                      title={s.parentLabel}
                    >
                      {s.parentLabel}
                    </span>
                    {s.decodable && (
                      <span className="w-14 shrink-0 text-right text-xs text-muted-foreground">
                        {s.changes} ch
                      </span>
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
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" size="sm" onClick={() => handleOpenChange(false)}>
            Cancel
          </Button>
          <Button size="sm" onClick={applySelection} disabled={!hasPendingSignalChanges || applyTrim.isPending}>
            {applyTrim.isPending ? "Applying..." : "Apply"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
