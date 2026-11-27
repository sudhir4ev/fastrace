import { useEffect, useState } from "react";
import { useListAnalyzers, useListFindings, useListSessions } from "@/shared/api/hooks";
import type { Finding, Session } from "@/shared/api/trace-source";
import { Badge } from "@/shared/ui/badge";
import { Button } from "@/shared/ui/button";
import { cn } from "@/shared/ui/lib/utils";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/shared/ui/resizable";

function formatUs(us: number): string {
  return `${(us / 1_000_000).toFixed(3)}s`;
}

function countBySeverity(findings: Finding[], streamIndex: number, severity: string): number {
  return findings.filter((f) => f.streamIndex === streamIndex && f.severity === severity).length;
}

function severityVariant(severity: string): "destructive" | "warning" | "secondary" {
  if (severity === "Error") return "destructive";
  if (severity === "Warning") return "warning";
  return "secondary";
}

interface ProtocolAnalyzerPanelProps {
  blfPath: string;
}

export default function ProtocolAnalyzerPanel({ blfPath }: ProtocolAnalyzerPanelProps) {
  const analyzers = useListAnalyzers();
  const [analyzerName, setAnalyzerName] = useState<string | null>(null);
  const activeAnalyzer = analyzerName ?? analyzers.data?.[0] ?? null;

  const [selectedStreamIndex, setSelectedStreamIndex] = useState<number | null>(null);
  const [severityFilter, setSeverityFilter] = useState<"all" | "Error" | "Warning">("all");

  useEffect(() => {
    setSelectedStreamIndex(null);
  }, [activeAnalyzer]);

  const sessions = useListSessions(blfPath, activeAnalyzer);
  const findings = useListFindings(blfPath, activeAnalyzer);

  if (analyzers.isLoading) {
    return <div className="p-3 text-sm text-muted-foreground">Loading analyzers...</div>;
  }
  if (!activeAnalyzer) {
    return <div className="p-3 text-sm text-muted-foreground">No analyzers available.</div>;
  }

  const sessionRows: Session[] = sessions.data ?? [];
  const findingRows: Finding[] = findings.data ?? [];

  return (
    <div className="flex h-full min-h-0 flex-col gap-2 p-3">
      <div className="flex items-center gap-2">
        <label htmlFor="analyzer-picker" className="text-sm font-medium">
          Analyzer
        </label>
        <select
          id="analyzer-picker"
          className="rounded-md border border-input bg-background px-2 py-1 text-sm"
          value={activeAnalyzer}
          onChange={(e) => setAnalyzerName(e.target.value)}
        >
          {(analyzers.data ?? []).map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </select>
        <Badge variant="secondary">{activeAnalyzer}</Badge>
      </div>
      <div className="min-h-0 flex-1">
        <ResizablePanelGroup direction="vertical">
          <ResizablePanel defaultSize={60} minSize={25}>
            {sessions.isLoading ? (
              <div className="p-3 text-sm text-muted-foreground">Loading sessions...</div>
            ) : sessionRows.length === 0 ? (
              <div className="p-3 text-sm text-muted-foreground">No sessions found.</div>
            ) : (
              <div className="h-full overflow-auto">
                <table className="w-full text-left text-xs">
                  <thead className="sticky top-0 bg-muted">
                    <tr>
                      <th className="whitespace-nowrap px-2 py-1 font-medium">Source</th>
                      <th className="whitespace-nowrap px-2 py-1 font-medium">Destination</th>
                      <th className="whitespace-nowrap px-2 py-1 font-medium">Packets</th>
                      <th className="whitespace-nowrap px-2 py-1 font-medium">Duration</th>
                      <th className="whitespace-nowrap px-2 py-1 font-medium">Errors</th>
                      <th className="whitespace-nowrap px-2 py-1 font-medium">Warnings</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sessionRows.map((s) => (
                      <tr
                        key={s.streamIndex}
                        onClick={() => setSelectedStreamIndex(s.streamIndex)}
                        className={cn(
                          "cursor-pointer border-t border-border/60 hover:bg-accent",
                          selectedStreamIndex === s.streamIndex && "bg-accent"
                        )}
                      >
                        <td className="whitespace-nowrap px-2 py-1 font-mono">{s.srcNode}</td>
                        <td className="whitespace-nowrap px-2 py-1 font-mono">{s.dstNode}</td>
                        <td className="whitespace-nowrap px-2 py-1 font-mono">{s.packetCount}</td>
                        <td className="whitespace-nowrap px-2 py-1 font-mono">{formatUs(s.endUs - s.startUs)}</td>
                        <td className="whitespace-nowrap px-2 py-1 font-mono">
                          {countBySeverity(findingRows, s.streamIndex, "Error")}
                        </td>
                        <td className="whitespace-nowrap px-2 py-1 font-mono">
                          {countBySeverity(findingRows, s.streamIndex, "Warning")}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </ResizablePanel>
          <ResizableHandle withHandle />
          <ResizablePanel defaultSize={40} minSize={15}>
            {selectedStreamIndex === null ? (
              <div className="p-3 text-sm text-muted-foreground">Select a session to see its violations.</div>
            ) : (
              <div className="flex h-full min-h-0 flex-col gap-2 p-2">
                <div className="flex items-center gap-1">
                  {(["all", "Error", "Warning"] as const).map((sev) => (
                    <Button
                      key={sev}
                      size="sm"
                      variant={severityFilter === sev ? "secondary" : "outline"}
                      onClick={() => setSeverityFilter(sev)}
                    >
                      {sev === "all" ? "All" : sev}
                    </Button>
                  ))}
                </div>
                <div className="min-h-0 flex-1 overflow-auto">
                  <table className="w-full text-left text-xs">
                    <thead className="sticky top-0 bg-muted">
                      <tr>
                        <th className="whitespace-nowrap px-2 py-1 font-medium">Severity</th>
                        <th className="whitespace-nowrap px-2 py-1 font-medium">Rule</th>
                        <th className="whitespace-nowrap px-2 py-1 font-medium">Summary</th>
                      </tr>
                    </thead>
                    <tbody>
                      {findingRows
                        .filter((f) => f.streamIndex === selectedStreamIndex)
                        .filter((f) => severityFilter === "all" || f.severity === severityFilter)
                        .map((f, i) => (
                          <tr key={i} className="border-t border-border/60">
                            <td className="whitespace-nowrap px-2 py-1">
                              <Badge variant={severityVariant(f.severity)}>{f.severity}</Badge>
                            </td>
                            <td className="whitespace-nowrap px-2 py-1 font-mono">{f.rule}</td>
                            <td className="px-2 py-1">{f.summary}</td>
                          </tr>
                        ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </ResizablePanel>
        </ResizablePanelGroup>
      </div>
    </div>
  );
}
