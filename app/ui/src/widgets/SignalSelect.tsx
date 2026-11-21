import { useEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Filter, XIcon } from "lucide-react";
import { getSignalColor } from "@/app/signalColors";
import { useWorkspaceStore } from "@/app/store";
import { useApplyTrim, useSignalCatalog } from "@/shared/api/hooks";
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

interface SignalSelectProps {
  blfPath: string;
}

export default function SignalSelect({ blfPath }: SignalSelectProps) {
  const catalog = useSignalCatalog(blfPath);
  const activeSignalIds = useWorkspaceStore((s) => s.activeSignalIds);
  const pendingSignalIds = useWorkspaceStore((s) => s.pendingSignalIds);
  const setPendingSignalIds = useWorkspaceStore((s) => s.setPendingSignalIds);
  const commitActiveSignalIds = useWorkspaceStore((s) => s.commitActiveSignalIds);
  const removeActiveSignal = useWorkspaceStore((s) => s.removeActiveSignal);
  const trimRange = useWorkspaceStore((s) => s.appliedTrimRange);
  const applyTrim = useApplyTrim(blfPath);

  const [open, setOpen] = useState(false);
  const [signalFilter, setSignalFilter] = useState("");
  const [hideNonDecodable, setHideNonDecodable] = useState(true);
  const [hideConstant, setHideConstant] = useState(true);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const triggerRowRef = useRef<HTMLDivElement>(null);
  const [popupWidth, setPopupWidth] = useState<number | undefined>(undefined);

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

  const activeEntries = useMemo(() => {
    if (!catalog.data) return [];
    return catalog.data.filter((s) => activeSignalIds.has(s.signalId));
  }, [catalog.data, activeSignalIds]);

  const virtualizer = useVirtualizer({
    count: filteredSignals?.length ?? 0,
    getScrollElement: () => listRef.current,
    estimateSize: () => 32,
    overscan: 10,
  });

  useEffect(() => {
    if (open) {
      setPendingSignalIds(new Set(activeSignalIds));
      const w = triggerRowRef.current?.offsetWidth;
      if (w) setPopupWidth(Math.max(w, 640));
    }
    // Seed draft from committed when the popover opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  function handleOpenChange(next: boolean) {
    if (!next) {
      setPendingSignalIds(new Set(activeSignalIds));
      setSignalFilter("");
    }
    setOpen(next);
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
    if (toDecode.length > 0 && trimRange) {
      applyTrim.mutate(
        { startUs: trimRange.start, endUs: trimRange.end, activeSignalIds: Array.from(nextActive) },
        {
          onSuccess: () => {
            commitActiveSignalIds(nextActive);
            setOpen(false);
            setSignalFilter("");
          },
        }
      );
    } else {
      commitActiveSignalIds(nextActive);
      setOpen(false);
      setSignalFilter("");
    }
  }

  return (
    <div className="flex shrink-0 flex-col gap-0 border-b border-border">
      <Popover open={open} onOpenChange={handleOpenChange}>
        <div
          ref={triggerRowRef}
          className="flex min-h-9 w-full items-center gap-1.5 px-2.5 py-1.5 text-sm focus-within:ring-1 focus-within:ring-ring"
          onClick={() => inputRef.current?.focus()}
        >
          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
            {activeEntries.map((s) => {
              const colorIndex = (catalog.data ?? []).findIndex((c) => c.signalId === s.signalId);
              const color = getSignalColor(colorIndex);
              return (
                <span
                  key={s.signalId}
                  className="inline-flex h-6 items-center gap-1 rounded-sm px-1.5 text-xs font-medium text-white"
                  style={{ backgroundColor: color }}
                >
                  {s.name || `signal ${s.signalId}`}
                  <button
                    type="button"
                    className="rounded-sm opacity-80 hover:opacity-100"
                    aria-label={`Remove ${s.name || s.signalId}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      removeActiveSignal(s.signalId);
                    }}
                  >
                    <XIcon className="size-3" />
                  </button>
                </span>
              );
            })}
            <PopoverTrigger asChild>
              <input
                ref={inputRef}
                type="text"
                value={signalFilter}
                onChange={(e) => {
                  setSignalFilter(e.target.value);
                  if (!open) setOpen(true);
                }}
                onFocus={() => setOpen(true)}
                placeholder={activeEntries.length === 0 ? "Add signals..." : "Add signals"}
                className="min-w-16 flex-1 bg-transparent outline-none placeholder:text-muted-foreground"
              />
            </PopoverTrigger>
          </div>
          <Popover>
            <PopoverTrigger asChild>
              <Button
                type="button"
                variant={filtersActive ? "secondary" : "outline"}
                size="icon"
                className="relative h-7 w-7 shrink-0"
                onClick={(e) => e.stopPropagation()}
              >
                <Filter className="h-3.5 w-3.5" />
                {filtersActive && <span className="absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-primary" />}
              </Button>
            </PopoverTrigger>
            <PopoverContent align="end" className="w-64" onClick={(e) => e.stopPropagation()}>
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
        <PopoverContent
          align="start"
          className="flex max-w-[calc(100vw-2rem)] flex-col gap-0 p-0"
          style={{ width: popupWidth ?? 640 }}
          onOpenAutoFocus={(e) => e.preventDefault()}
        >
          <div ref={listRef} className="h-72 overflow-auto">
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
                        onChange={() => togglePending(s.signalId)}
                      />
                      <span className="min-w-0 flex-1 truncate">{s.name || `signal ${s.signalId}`}</span>
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
            )}
          </div>

          {hasPendingSignalChanges && (
            <div className="shrink-0 border-t border-border p-2">
              <Button size="sm" className="w-full" onClick={applySelection} disabled={applyTrim.isPending}>
                Apply
              </Button>
            </div>
          )}
        </PopoverContent>
      </Popover>
    </div>
  );
}
