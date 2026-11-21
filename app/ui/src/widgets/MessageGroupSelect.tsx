import { useMemo } from "react";
import { useWorkspaceStore } from "@/app/store";
import { useMessageGroups } from "@/shared/api/hooks";
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
import { Badge } from "@/shared/ui/badge";

interface MessageGroupSelectProps {
  blfPath: string;
}

type GroupItem = {
  key: string;
  label: string;
  count: number;
};

export default function MessageGroupSelect({ blfPath }: MessageGroupSelectProps) {
  const trimRange = useWorkspaceStore((s) => s.appliedTrimRange);
  const selectedGroupKeys = useWorkspaceStore((s) => s.selectedGroupKeys);
  const setSelectedGroupKeys = useWorkspaceStore((s) => s.setSelectedGroupKeys);
  const groups = useMessageGroups(blfPath, trimRange?.start ?? 0, trimRange?.end ?? Number.MAX_SAFE_INTEGER);
  const anchor = useComboboxAnchor();

  const items: GroupItem[] = useMemo(
    () =>
      (groups.data ?? []).map((g) => ({
        key: g.key,
        label: `${g.busLabel} - ${g.label}`,
        count: g.count,
      })),
    [groups.data]
  );

  const selectedItems = useMemo(
    () => items.filter((item) => selectedGroupKeys.includes(item.key)),
    [items, selectedGroupKeys]
  );

  return (
    <div className="shrink-0 border-b border-border p-2">
      <Combobox
        multiple
        items={items}
        value={selectedItems}
        onValueChange={(next) => {
          setSelectedGroupKeys(next.map((item) => item.key));
        }}
        itemToStringLabel={(item) => item.label}
        itemToStringValue={(item) => item.key}
        isItemEqualToValue={(a, b) => a.key === b.key}
      >
        <ComboboxChips ref={anchor}>
          <ComboboxValue>
            {(values: GroupItem[]) =>
              values.map((item) => (
                <ComboboxChip key={item.key}>{item.label}</ComboboxChip>
              ))
            }
          </ComboboxValue>
          <ComboboxChipsInput placeholder="Filter message groups..." />
        </ComboboxChips>
        <ComboboxContent anchor={anchor}>
          <ComboboxEmpty>
            {groups.isPending
              ? "Loading..."
              : groups.isError
                ? "Couldn't load message groups."
                : items.length === 0
                  ? "No messages in this trace."
                  : "No groups match."}
          </ComboboxEmpty>
          <ComboboxList>
            {(item: GroupItem) => (
              <ComboboxItem key={item.key} value={item}>
                <span className="min-w-0 flex-1 truncate">{item.label}</span>
                <Badge variant="secondary" className="px-1.5 py-0">
                  {item.count}
                </Badge>
              </ComboboxItem>
            )}
          </ComboboxList>
        </ComboboxContent>
      </Combobox>
    </div>
  );
}
