import { Loader2 } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/shared/ui/card";
import type { ProgressTick } from "./types";

interface ProgressScreenProps {
  tick: ProgressTick | null;
}

function Row({ label, value }: { label: string; value: string | number }) {
  return (
    <tr className="border-b border-border last:border-0">
      <td className="py-2 pr-4 text-sm text-muted-foreground">{label}</td>
      <td className="py-2 text-right text-sm font-medium tabular-nums">{value}</td>
    </tr>
  );
}

export default function ProgressScreen({ tick }: ProgressScreenProps) {
  return (
    <div className="flex h-screen items-center justify-center bg-background">
      <Card className="w-[420px]">
        <CardHeader className="items-center text-center">
          <Loader2 className="h-6 w-6 animate-spin text-primary" />
          <CardTitle className="text-base">Preparing trace...</CardTitle>
        </CardHeader>
        <CardContent>
          <table className="w-full">
            <tbody>
              <Row label="Containers" value={tick?.containers ?? 0} />
              <Row label="Messages" value={tick?.messages ?? 0} />
              {tick?.done && <Row label="Protocol rows" value={tick.protocol_rows} />}
              <Row label="Elapsed" value={`${tick?.elapsed_ms ?? 0} ms`} />
            </tbody>
          </table>
        </CardContent>
      </Card>
    </div>
  );
}
