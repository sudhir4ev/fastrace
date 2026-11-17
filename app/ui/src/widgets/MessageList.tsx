import { useRef } from "react";
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
  const { data, isPending, isError, fetchNextPage, hasNextPage, isFetchingNextPage } = useMessages(
    blfPath,
    selectedGroupKey
  );

  const rows = data ? data.pages.flatMap((p) => p.rows) : [];
  const parentRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 28,
    overscan: 10,
  });

  if (selectedGroupKey === null) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        Select a message group from the left rail.
      </div>
    );
  }
  if (isPending) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        Loading messages...
      </div>
    );
  }
  if (isError) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        Couldn't load messages - see error notification.
      </div>
    );
  }
  if (rows.length === 0) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        No messages in this group.
      </div>
    );
  }

  function onScroll() {
    const el = parentRef.current;
    if (!el || isFetchingNextPage || !hasNextPage) return;
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 200) {
      fetchNextPage();
    }
  }

  return (
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
