import { useWorkspaceStore } from "@/app/store";
import { useMessageDetail } from "@/shared/api/hooks";
import { Card, CardContent, CardHeader, CardTitle } from "@/shared/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/shared/ui/tabs";

interface MessageDetailsProps {
  blfPath: string;
}

export default function MessageDetails({ blfPath }: MessageDetailsProps) {
  const selectedMessageId = useWorkspaceStore((s) => s.selectedMessageId);
  const { data, isPending, isError } = useMessageDetail(blfPath, selectedMessageId);

  if (selectedMessageId === null) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        Select a message to see its details.
      </div>
    );
  }
  if (isPending) {
    return <div className="flex h-full items-center justify-center text-sm text-muted-foreground">Loading...</div>;
  }
  if (isError || !data) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        Couldn't load message details - see error notification.
      </div>
    );
  }

  return (
    <Card className="h-full rounded-none border-0 shadow-none">
      <CardHeader>
        <CardTitle>Message {data.msgId}</CardTitle>
      </CardHeader>
      <CardContent>
        <Tabs defaultValue="details">
          <TabsList>
            <TabsTrigger value="details">Details</TabsTrigger>
            <TabsTrigger value="raw" disabled>
              Raw
            </TabsTrigger>
            <TabsTrigger value="signals" disabled>
              Signal Decoding
            </TabsTrigger>
          </TabsList>
          <TabsContent value="details" className="space-y-1 text-sm">
            <p>Bus: {data.busLabel}</p>
            <p>ID/Source: {data.idOrSrc}</p>
            <p>Timestamp (us): {data.timestampUs}</p>
            <p>DLC: {data.dlc ?? "-"}</p>
            <p>Payload length: {data.payloadLen ?? "-"}</p>
          </TabsContent>
        </Tabs>
      </CardContent>
    </Card>
  );
}
