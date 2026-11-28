import { useEffect, useState } from "react";
import {
  useDefaultAnalyzerConfig,
  useListAnalyzers,
  useListFindings,
  useListSegments,
  useListSessions,
} from "@/shared/api/hooks";
import type { Finding, Segment, Session } from "@/shared/api/trace-source";
import { Badge } from "@/shared/ui/badge";
import { Button } from "@/shared/ui/button";
import { cn, formatIpPort } from "@/shared/ui/lib/utils";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/shared/ui/resizable";

function formatUs(us: number): string {
  return `${(us / 1_000_000).toFixed(3)}s`;
}

// stream_index alone is NOT a unique session key - it's only unique within
// one (src_node, dst_node) pair, so every lookup/comparison here keys on the
// full triple.
interface SessionKey {
  srcNode: string;
  dstNode: string;
  streamIndex: number;
}

function sameSession(a: SessionKey, b: { srcNode: string; dstNode: string; streamIndex: number }): boolean {
  return a.srcNode === b.srcNode && a.dstNode === b.dstNode && a.streamIndex === b.streamIndex;
}

function countBySeverity(findings: Finding[], session: SessionKey, severity: string): number {
  return findings.filter((f) => sameSession(session, f) && f.severity === severity).length;
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

  const [selectedSession, setSelectedSession] = useState<SessionKey | null>(null);
  const [severityFilter, setSeverityFilter] = useState<"all" | "Error" | "Warning">("all");
  const [evidenceTab, setEvidenceTab] = useState<"violations" | "packets">("violations");
  const [highlightedMsgIds, setHighlightedMsgIds] = useState<[number, number] | null>(null);

  useEffect(() => {
    setSelectedSession(null);
    setHighlightedMsgIds(null);
  }, [activeAnalyzer]);

  useEffect(() => {
    setHighlightedMsgIds(null);
  }, [selectedSession]);

  // Rules with no actual closing packet (RST/FIN) to point to - the
  // violation IS the absence of one, so the UI must say that instead of
  // pretending `lastMsgId` is the offending packet.
  const NO_CLOSING_PACKET_RULES = new Set(["NEVER_CLOSED", "HANDSHAKE_NO_SYNACK", "SILENCE_TIMEOUT"]);

  const defaultConfig = useDefaultAnalyzerConfig(activeAnalyzer);
  const [configDraft, setConfigDraft] = useState("");
  const [appliedConfig, setAppliedConfig] = useState("");

  useEffect(() => {
    if (defaultConfig.data !== undefined) {
      setConfigDraft(defaultConfig.data);
      setAppliedConfig(defaultConfig.data);
    }
  }, [defaultConfig.data, activeAnalyzer]);

  let configDraftError: string | null = null;
  try {
    if (configDraft.trim().length > 0) JSON.parse(configDraft);
  } catch (e) {
    configDraftError = e instanceof Error ? e.message : "invalid JSON";
  }

  const sessions = useListSessions(blfPath, activeAnalyzer, appliedConfig);
  const findings = useListFindings(blfPath, activeAnalyzer, appliedConfig);
  const segments = useListSegments(
    blfPath,
    activeAnalyzer,
    appliedConfig,
    selectedSession?.srcNode ?? null,
    selectedSession?.dstNode ?? null,
    selectedSession?.streamIndex ?? null
  );

  useEffect(() => {
    if (highlightedMsgIds === null || evidenceTab !== "packets") return;
    document.getElementById(`segment-${highlightedMsgIds[1]}`)?.scrollIntoView({ block: "center" });
  }, [highlightedMsgIds, evidenceTab, segments.data]);

  if (analyzers.isLoading) {
    return <div className="p-3 text-sm text-muted-foreground">Loading analyzers...</div>;
  }
  if (!activeAnalyzer) {
    return <div className="p-3 text-sm text-muted-foreground">No analyzers available.</div>;
  }

  const sessionRows: Session[] = sessions.data ?? [];
  const findingRows: Finding[] = findings.data ?? [];
  const segmentRows: Segment[] = segments.data ?? [];

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
      <div className="flex items-center gap-2">
        <textarea
          className="h-16 flex-1 rounded-md border border-input bg-background px-2 py-1 font-mono text-xs"
          value={configDraft}
          onChange={(e) => setConfigDraft(e.target.value)}
        />
        <Button size="sm" disabled={configDraftError !== null} onClick={() => setAppliedConfig(configDraft)}>
          Apply
        </Button>
      </div>
      {configDraftError !== null && <div className="text-xs text-destructive">{configDraftError}</div>}
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
                        key={`${s.srcNode}|${s.dstNode}|${s.streamIndex}`}
                        onClick={() => setSelectedSession(s)}
                        className={cn(
                          "cursor-pointer border-t border-border/60 hover:bg-accent",
                          selectedSession !== null && sameSession(selectedSession, s) && "bg-accent"
                        )}
                      >
                        <td className="whitespace-nowrap px-2 py-1 font-mono">{formatIpPort(s.srcNode)}</td>
                        <td className="whitespace-nowrap px-2 py-1 font-mono">{formatIpPort(s.dstNode)}</td>
                        <td className="whitespace-nowrap px-2 py-1 font-mono">{s.packetCount}</td>
                        <td className="whitespace-nowrap px-2 py-1 font-mono">{formatUs(s.endUs - s.startUs)}</td>
                        <td className="whitespace-nowrap px-2 py-1 font-mono">
                          {countBySeverity(findingRows, s, "Error")}
                        </td>
                        <td className="whitespace-nowrap px-2 py-1 font-mono">
                          {countBySeverity(findingRows, s, "Warning")}
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
            {selectedSession === null ? (
              <div className="p-3 text-sm text-muted-foreground">Select a session to see its violations.</div>
            ) : (
              <div className="flex h-full min-h-0 flex-col gap-2 p-2">
                <div className="flex items-center gap-1">
                  <Button
                    size="sm"
                    variant={evidenceTab === "violations" ? "secondary" : "outline"}
                    onClick={() => setEvidenceTab("violations")}
                  >
                    Violations
                  </Button>
                  <Button
                    size="sm"
                    variant={evidenceTab === "packets" ? "secondary" : "outline"}
                    onClick={() => setEvidenceTab("packets")}
                  >
                    Packets
                  </Button>
                  {evidenceTab === "violations" && (
                    <div className="ml-2 flex items-center gap-1">
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
                  )}
                </div>
                {evidenceTab === "violations" ? (
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
                          .filter((f) => sameSession(selectedSession, f))
                          .filter((f) => severityFilter === "all" || f.severity === severityFilter)
                          .map((f, i) => (
                            <tr
                              key={i}
                              className="cursor-pointer border-t border-border/60 hover:bg-accent"
                              title={
                                NO_CLOSING_PACKET_RULES.has(f.rule)
                                  ? "No RST/FIN packet caused this - the violation is that one never arrived."
                                  : "Jump to the packet that caused this."
                              }
                              onClick={() => {
                                setEvidenceTab("packets");
                                setHighlightedMsgIds([f.firstMsgId, f.lastMsgId]);
                              }}
                            >
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
                ) : segments.isLoading ? (
                  <div className="p-3 text-sm text-muted-foreground">Loading packets...</div>
                ) : (
                  <div className="flex min-h-0 flex-1 flex-col gap-1">
                    {highlightedMsgIds !== null && (
                      <div className="text-xs text-muted-foreground">
                        {NO_CLOSING_PACKET_RULES.has(
                          findingRows.find((f) => sameSession(selectedSession, f) && f.lastMsgId === highlightedMsgIds[1])
                            ?.rule ?? ""
                        )
                          ? "No single packet caused this - highlighted is the last packet seen on this stream; no RST/FIN ever followed it."
                          : "Highlighted: the packets bounding this violation (last one is typically the RST)."}
                      </div>
                    )}
                    <div className="min-h-0 flex-1 overflow-auto">
                      <table className="w-full text-left text-xs">
                        <thead className="sticky top-0 bg-muted">
                          <tr>
                            <th className="whitespace-nowrap px-2 py-1 font-medium">Time</th>
                            <th className="whitespace-nowrap px-2 py-1 font-medium">Source</th>
                            <th className="whitespace-nowrap px-2 py-1 font-medium">Destination</th>
                            <th className="whitespace-nowrap px-2 py-1 font-medium">Info</th>
                            <th className="whitespace-nowrap px-2 py-1 font-medium">Len</th>
                            <th className="whitespace-nowrap px-2 py-1 font-medium">Idle</th>
                          </tr>
                        </thead>
                        <tbody>
                          {segmentRows.map((s) => (
                            <tr
                              key={s.msgId}
                              id={`segment-${s.msgId}`}
                              className={cn(
                                "border-t border-border/60",
                                highlightedMsgIds !== null &&
                                  (s.msgId === highlightedMsgIds[0] || s.msgId === highlightedMsgIds[1]) &&
                                  "bg-accent"
                              )}
                            >
                              <td className="whitespace-nowrap px-2 py-1 font-mono">{formatUs(s.timestampUs)}</td>
                              <td className="whitespace-nowrap px-2 py-1 font-mono">{formatIpPort(s.srcNode)}</td>
                              <td className="whitespace-nowrap px-2 py-1 font-mono">{formatIpPort(s.dstNode)}</td>
                              <td className="whitespace-nowrap px-2 py-1 font-mono">{s.info}</td>
                              <td className="whitespace-nowrap px-2 py-1 font-mono">{s.segmentLen}</td>
                              <td className="whitespace-nowrap px-2 py-1 font-mono">{formatUs(s.idleUs)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}
              </div>
            )}
          </ResizablePanel>
        </ResizablePanelGroup>
      </div>
    </div>
  );
}
