import { useState } from "react";
import { useWorkspaceStore, type LeftTab } from "@/app/store";
import { useEcus, useMessageGroups, useSignalCatalog, useTraceSummary } from "@/shared/api/hooks";
import { Badge } from "@/shared/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/shared/ui/card";
import { cn } from "@/shared/ui/lib/utils";
import { ScrollArea } from "@/shared/ui/scroll-area";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/shared/ui/tabs";
import SignalsList from "./SignalsList";

interface TraceRailProps {
  blfPath: string;
}

export default function TraceRail({ blfPath }: TraceRailProps) {
  const summary = useTraceSummary(blfPath);
  const groups = useMessageGroups(blfPath);
  const ecus = useEcus(blfPath);
  // Shares the query cache with SignalsList's own useSignalCatalog call (same
  // queryKey) - cheap, just needed here for the tab trigger's count badge.
  const catalog = useSignalCatalog(blfPath);
  const leftTab = useWorkspaceStore((s) => s.leftTab);
  const setLeftTab = useWorkspaceStore((s) => s.setLeftTab);
  const selectedGroupKey = useWorkspaceStore((s) => s.selectedGroupKey);
  const setSelectedGroup = useWorkspaceStore((s) => s.setSelectedGroup);
  const [messageFilter, setMessageFilter] = useState("");

  const filteredGroups = groups.data?.filter((g) =>
    `${g.busLabel} ${g.label}`.toLowerCase().includes(messageFilter.toLowerCase())
  );

  return (
    <div className="flex h-full flex-col gap-3 p-3">
      <Card>
        <CardHeader>
          <CardTitle>Trace Info</CardTitle>
        </CardHeader>
        <CardContent className="space-y-1 text-sm text-muted-foreground">
          {summary.isPending && <p>Loading summary...</p>}
          {summary.isError && <p>Couldn't load trace summary - see error notification.</p>}
          {summary.data && (
            <>
              <p>CAN messages: {summary.data.can_messages}</p>
              <p>Ethernet messages: {summary.data.ethernet_messages}</p>
            </>
          )}
        </CardContent>
      </Card>

      <Tabs value={leftTab} onValueChange={(v) => setLeftTab(v as LeftTab)} className="flex min-h-0 flex-1 flex-col">
        <TabsList className="w-full">
          <TabsTrigger value="signals" className="gap-1.5">
            Signals
            {catalog.data && (
              <Badge variant="secondary" className="px-1.5 py-0">
                {catalog.data.length}
              </Badge>
            )}
          </TabsTrigger>
          <TabsTrigger value="messages" className="gap-1.5">
            Messages
            {groups.data && (
              <Badge variant="secondary" className="px-1.5 py-0">
                {groups.data.length}
              </Badge>
            )}
          </TabsTrigger>
          <TabsTrigger value="ecus">ECUs</TabsTrigger>
        </TabsList>

        {/* No `display`-setting utility (e.g. `flex`) directly on TabsContent:
            Radix hides inactive panels via the native `hidden` attribute,
            which Tailwind's base-layer `[hidden]{display:none}` only wins
            over utility-layer classes if nothing on the same element sets
            `display` - a `flex` class on TabsContent itself defeats the hide
            and both panels render stacked. `flex-1`/`min-h-0` don't set
            `display`, so they're safe here; `flex` lives on the inner
            wrapper div instead. */}
        <TabsContent value="signals" className="min-h-0 flex-1">
          <div className="flex h-full flex-col">
            <SignalsList blfPath={blfPath} />
          </div>
        </TabsContent>

        <TabsContent value="messages" className="min-h-0 flex-1">
          <div className="flex h-full flex-col">
            {groups.data && groups.data.length > 0 && (
              <div className="shrink-0 p-2">
                <input
                  type="text"
                  value={messageFilter}
                  onChange={(e) => setMessageFilter(e.target.value)}
                  placeholder="Filter messages..."
                  className="w-full rounded-md border border-input bg-background px-2 py-1 text-sm shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                />
              </div>
            )}
            <ScrollArea className="h-full">
              {groups.isPending && <p className="p-3 text-sm text-muted-foreground">Loading...</p>}
              {groups.isError && <p className="p-3 text-sm text-muted-foreground">Couldn't load message groups.</p>}
              {groups.data?.length === 0 && (
                <p className="p-3 text-sm text-muted-foreground">No messages in this trace.</p>
              )}
              {groups.data && groups.data.length > 0 && filteredGroups?.length === 0 && (
                <p className="p-3 text-sm text-muted-foreground">No messages match "{messageFilter}".</p>
              )}
              {filteredGroups?.map((g) => (
                <button
                  key={g.key}
                  onClick={() => setSelectedGroup(g.key)}
                  className={cn(
                    "flex w-full items-center justify-between px-3 py-2 text-left text-sm hover:bg-accent",
                    selectedGroupKey === g.key && "bg-accent"
                  )}
                >
                  <span>
                    {g.busLabel} - {g.label}
                  </span>
                  <Badge variant="secondary">{g.count}</Badge>
                </button>
              ))}
            </ScrollArea>
          </div>
        </TabsContent>

        <TabsContent value="ecus" className="min-h-0 flex-1">
          <ScrollArea className="h-full">
            {ecus.isPending && <p className="p-3 text-sm text-muted-foreground">Loading...</p>}
            {ecus.isError && <p className="p-3 text-sm text-muted-foreground">Couldn't load ECUs.</p>}
            {ecus.data?.length === 0 && (
              <p className="p-3 text-sm text-muted-foreground">No ECUs in this trace's ARXML.</p>
            )}
            {ecus.data?.map((e) => (
              <div key={e.name} className="px-3 py-2 text-sm">
                {e.name}
              </div>
            ))}
          </ScrollArea>
        </TabsContent>
      </Tabs>
    </div>
  );
}
