import { useWorkspaceStore, type LeftTab } from "@/app/store";
import { useEcus, useMessageGroups, useTraceSummary } from "@/shared/api/hooks";
import { Badge } from "@/shared/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/shared/ui/card";
import { cn } from "@/shared/ui/lib/utils";
import { ScrollArea } from "@/shared/ui/scroll-area";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/shared/ui/tabs";

interface TraceRailProps {
  blfPath: string;
}

export default function TraceRail({ blfPath }: TraceRailProps) {
  const summary = useTraceSummary(blfPath);
  const groups = useMessageGroups(blfPath);
  const ecus = useEcus(blfPath);
  const leftTab = useWorkspaceStore((s) => s.leftTab);
  const setLeftTab = useWorkspaceStore((s) => s.setLeftTab);
  const selectedGroupKey = useWorkspaceStore((s) => s.selectedGroupKey);
  const setSelectedGroup = useWorkspaceStore((s) => s.setSelectedGroup);

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
          <TabsTrigger value="signals" disabled>
            Signals
          </TabsTrigger>
          <TabsTrigger value="messages">Messages</TabsTrigger>
          <TabsTrigger value="ecus">ECUs</TabsTrigger>
        </TabsList>

        <TabsContent value="signals">
          <p className="p-3 text-sm text-muted-foreground">Signal catalog - coming soon.</p>
        </TabsContent>

        <TabsContent value="messages" className="min-h-0 flex-1">
          <ScrollArea className="h-full">
            {groups.isPending && <p className="p-3 text-sm text-muted-foreground">Loading...</p>}
            {groups.isError && <p className="p-3 text-sm text-muted-foreground">Couldn't load message groups.</p>}
            {groups.data?.length === 0 && (
              <p className="p-3 text-sm text-muted-foreground">No messages in this trace.</p>
            )}
            {groups.data?.map((g) => (
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
