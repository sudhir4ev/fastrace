import { useMemo } from "react";
import { useWorkspaceStore } from "@/app/store";
import { useSignalCatalog } from "@/shared/api/hooks";
import { Badge } from "@/shared/ui/badge";
import {
  Combobox,
  ComboboxChip,
  ComboboxChips,
  ComboboxChipsInput,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxItem,
  ComboboxList,
  ComboboxValue,
  useComboboxAnchor,
} from "@/shared/ui/combobox";

interface TargetSignalSelectProps {
  blfPath: string;
}

type SignalItem = {
  signalId: number;
  name: string;
  cached: boolean;
};

export default function TargetSignalSelect({ blfPath }: TargetSignalSelectProps) {
  const targets = useWorkspaceStore((s) => s.detectorTargetSignalIds);
  const setTargets = useWorkspaceStore((s) => s.setDetectorTargetSignalIds);
  const catalog = useSignalCatalog(blfPath);
  const anchor = useComboboxAnchor();

  const items: SignalItem[] = useMemo(
    () =>
      (catalog.data ?? [])
        .filter((s) => s.decodable && !s.opaque)
        .map((s) => ({
          signalId: s.signalId,
          name: s.name,
          cached: s.cached,
        })),
    [catalog.data]
  );

  const selectedItems = useMemo(() => {
    const byId = new Map(items.map((item) => [item.signalId, item]));
    return targets.flatMap((id) => {
      const item = byId.get(id);
      return item ? [item] : [];
    });
  }, [items, targets]);

  return (
    <div className="flex shrink-0 flex-col gap-1">
      <div className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
        Target signals
      </div>
      <Combobox
        multiple
        items={items}
        value={selectedItems}
        onValueChange={(next) => {
          setTargets(next.map((item) => item.signalId));
        }}
        itemToStringLabel={(item) => item.name}
        itemToStringValue={(item) => String(item.signalId)}
        isItemEqualToValue={(a, b) => a.signalId === b.signalId}
      >
        <ComboboxChips ref={anchor}>
          <ComboboxValue>
            {(values: SignalItem[]) =>
              values.map((item) => (
                <ComboboxChip key={item.signalId}>{item.name}</ComboboxChip>
              ))
            }
          </ComboboxValue>
          <ComboboxChipsInput placeholder="Search signals..." />
        </ComboboxChips>
        <ComboboxContent anchor={anchor}>
          <ComboboxEmpty>
            {catalog.isPending
              ? "Loading..."
              : catalog.isError
                ? "Couldn't load signal catalog."
                : items.length === 0
                  ? "No decodable signals in catalog."
                  : "No signals match."}
          </ComboboxEmpty>
          <ComboboxList>
            {(item: SignalItem) => (
              <ComboboxItem key={item.signalId} value={item}>
                <span className="min-w-0 flex-1 truncate" title={item.name}>
                  {item.name}
                </span>
                {item.cached && (
                  <Badge variant="secondary" className="px-1.5 py-0">
                    cached
                  </Badge>
                )}
              </ComboboxItem>
            )}
          </ComboboxList>
        </ComboboxContent>
      </Combobox>
      <p className="text-[10px] text-muted-foreground">
        Signals your SQL reads must be selected here.
      </p>
    </div>
  );
}
