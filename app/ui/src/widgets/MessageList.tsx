import { useRef, type ReactNode } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useWorkspaceStore } from "@/app/store";
import { useMessages } from "@/shared/api/hooks";
import { cn } from "@/shared/ui/lib/utils";

interface MessageListProps {
  blfPath: string;
}

export default function MessageList({ blfPath }: MessageListProps) {
  const selectedGroupKey = useWorkspaceStore((s) => s.selectedGroupKey);
  const selectedMessageId = useWorkspaceStore((s) => s.selectedMessageId);
  const setSelectedMessage = useWorkspaceStore((s) => s.setSelectedMessage);
  const trimRange = useWorkspaceStore((s) => s.appliedTrimRange);
  const { data, isPending, isError, fetchNextPage, hasNextPage, isFetchingNextPage } = useMessages(
    blfPath,
    selectedGroupKey,
    trimRange?.start ?? 0,
    trimRange?.end ?? Number.MAX_SAFE_INTEGER
  );

  const rows = data ? data.pages.flatMap((p) => p.rows) : [];
  const parentRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 28,
    overscan: 10,
  });

  function onScroll() {
    const el = parentRef.current;
    if (!el || isFetchingNextPage || !hasNextPage) return;
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 200) {
      fetchNextPage();
    }
  }

  let content: ReactNode;
  if (selectedGroupKey === null) {
    content = (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        Select a message group from the left rail.
      </div>
    );
  } else if (isPending) {
    content = (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        Loading messages...
      </div>
    );
  } else if (isError) {
    content = (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        Couldn't load messages - see error notification.
      </div>
    );
  } else if (rows.length === 0) {
    content = (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        No messages in this group.
      </div>
    );
  } else {
    content = (
      <div ref={parentRef} onScroll={onScroll} className="h-full overflow-auto">
        <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
          {virtualizer.getVirtualItems().map((item) => {
            const row = rows[item.index];
            return (
              <div
                key={row.msgId}
                onClick={() => setSelectedMessage(row.msgId)}
                className={cn(
                  "absolute left-0 top-0 flex w-full items-center gap-4 border-b border-border px-3 font-mono text-xs",
                  selectedMessageId === row.msgId && "bg-accent"
                )}
                style={{ height: item.size, transform: `translateY(${item.start}px)` }}
              >
                <span className="w-24 shrink-0">{row.timestampUs}</span>
                <span className="w-16 shrink-0">{row.idOrSrc}</span>
                <span className="flex-1 truncate">{row.name ?? "-"}</span>
                <span className="w-10 shrink-0 text-right">{row.dlc ?? row.payloadLen ?? "-"}</span>
              </div>
            );
          })}
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 items-center gap-4 border-b border-border bg-background px-3 py-1 font-mono text-[10px] uppercase tracking-wide text-muted-foreground">
        <span className="w-24 shrink-0">Timestamp</span>
        <span className="w-16 shrink-0">ID/Src</span>
        <span className="flex-1 truncate">Name</span>
        <span className="w-10 shrink-0 text-right">DLC/Len</span>
      </div>
      <div className="min-h-0 flex-1">{content}</div>
    </div>
  );
}
