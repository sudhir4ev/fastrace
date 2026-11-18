import { useActivities } from "@/shared/api/hooks";
import { Popover, PopoverContent, PopoverTrigger } from "@/shared/ui/popover";
import { formatDuration } from "@/shared/ui/lib/utils";
import type { ActivityEntry } from "@/shared/api/trace-source";

interface ActivityLogProps {
  blfPath: string;
}

const KIND_LABELS: Record<string, string> = {
  prepare: "Ingestion",
  decode: "Read payloads",
};

function activityLabel(a: ActivityEntry): string {
  const kind = KIND_LABELS[a.kind] ?? a.kind;
  return a.detail ? `${kind} (${a.detail})` : kind;
}

export default function ActivityLog({ blfPath }: ActivityLogProps) {
  const activities = useActivities(blfPath);
  const sorted = [...(activities.data ?? [])].sort((a, b) => b.at - a.at);
  const last = sorted[0];

  return (
    <Popover>
      <PopoverTrigger
        disabled={!last}
        className="flex items-center gap-1.5 text-[10px] text-background/80 hover:text-background disabled:pointer-events-none disabled:opacity-50"
      >
        {last ? (
          <span>
            {activityLabel(last)} · {formatDuration(last.elapsedMs)}
          </span>
        ) : (
          <span>No activity yet</span>
        )}
      </PopoverTrigger>
      <PopoverContent side="top" align="end">
        <p className="mb-2 text-xs font-medium text-foreground">Session activity</p>
        {sorted.length === 0 && <p className="text-xs text-muted-foreground">Nothing recorded yet.</p>}
        <ul className="flex max-h-64 flex-col gap-1.5 overflow-y-auto text-xs">
          {sorted.map((a, i) => (
            <li key={`${a.at}-${i}`} className="flex items-center justify-between gap-3">
              <span className="truncate text-foreground">{activityLabel(a)}</span>
              <span className="shrink-0 text-muted-foreground">{formatDuration(a.elapsedMs)}</span>
            </li>
          ))}
        </ul>
      </PopoverContent>
    </Popover>
  );
}
