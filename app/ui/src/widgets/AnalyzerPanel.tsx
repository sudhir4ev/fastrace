import { useRef } from "react";
import { useWorkspaceStore } from "@/app/store";
import { useRunDetectorQuery, DETECTOR_QUERY_MATCH_LIMIT } from "@/shared/api/hooks";
import { Button } from "@/shared/ui/button";

interface AnalyzerPanelProps {
  blfPath: string;
}

// A lone `;` before the very end means more than one statement - a cheap
// client-side pre-check so an obviously-invalid multi-statement query never
// even reaches the backend. Known limitation: a `;` inside a SQL comment
// (e.g. `-- a; b`) would false-positive here; left as-is since this is a
// pre-check, not the real guard - DuckDB's own parser is the source of truth
// for what's actually valid SQL.
function hasEmbeddedSemicolon(sql: string): boolean {
  const trimmed = sql.trim();
  const withoutTrailing = trimmed.endsWith(";") ? trimmed.slice(0, -1) : trimmed;
  return withoutTrailing.includes(";");
}

export default function AnalyzerPanel({ blfPath }: AnalyzerPanelProps) {
  const sql = useWorkspaceStore((s) => s.detectorQuerySql);
  const setSql = useWorkspaceStore((s) => s.setDetectorQuerySql);
  const error = useWorkspaceStore((s) => s.detectorQueryError);
  const setError = useWorkspaceStore((s) => s.setDetectorQueryError);
  const setResult = useWorkspaceStore((s) => s.setDetectorQueryResult);
  const matches = useWorkspaceStore((s) => s.detectorMatches);
  const truncated = useWorkspaceStore((s) => s.detectorQueryTruncated);
  const hasRun = useWorkspaceStore((s) => s.detectorQueryHasRun);
  const mutation = useRunDetectorQuery(blfPath);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  function run() {
    if (sql.trim() === "") return;
    if (hasEmbeddedSemicolon(sql)) {
      setError("Only a single SQL statement is supported.");
      return;
    }
    mutation.mutate(sql, {
      onSuccess: (result) => setResult(result.matches, result.truncated),
      onError: (e) => setError(String(e)),
    });
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      run();
    }
  }

  return (
    <div className="flex h-full flex-col gap-2 p-2">
      <textarea
        ref={textareaRef}
        value={sql}
        onChange={(e) => setSql(e.target.value)}
        onKeyDown={onKeyDown}
        placeholder="select msg_id, timestamp_us from messages where ..."
        className="min-h-0 flex-1 resize-none rounded border border-border bg-background p-2 font-mono text-xs"
        spellCheck={false}
      />
      <div className="flex items-center justify-between gap-2">
        <Button size="sm" onClick={run} disabled={mutation.isPending}>
          {mutation.isPending ? "Running..." : "Run"}
        </Button>
        <span className="text-xs text-muted-foreground">Cmd/Ctrl+Enter</span>
      </div>
      {error && (
        <div className="rounded border border-destructive/50 bg-destructive/10 p-2 text-xs text-destructive">
          {error}
        </div>
      )}
      {!error && hasRun && (
        <div className="text-xs text-muted-foreground">
          {matches.length} match{matches.length === 1 ? "" : "es"}
          {truncated && ` (showing first ${DETECTOR_QUERY_MATCH_LIMIT.toLocaleString()})`}
        </div>
      )}
    </div>
  );
}
