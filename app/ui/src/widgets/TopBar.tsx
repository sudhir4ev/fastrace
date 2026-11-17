import { Button } from "@/shared/ui/button";

interface TopBarProps {
  traceName: string;
  onOpenTrace: () => void;
}

export default function TopBar({ traceName, onOpenTrace }: TopBarProps) {
  return (
    <header className="flex h-[50px] shrink-0 items-center justify-between border-b border-border bg-card px-4">
      <span className="truncate text-sm font-semibold">{traceName}</span>
      <div className="flex items-center gap-2">
        <Button variant="secondary" size="sm" onClick={onOpenTrace}>
          Open Trace
        </Button>
      </div>
    </header>
  );
}
