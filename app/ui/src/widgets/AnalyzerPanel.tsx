import { useEffect, useMemo, useState } from "react";
import { Copy, History } from "lucide-react";
import { Editor } from "prism-react-editor";
import { usePrismEditor } from "prism-react-editor/extensions";
import { fuzzyFilter, useAutoComplete } from "prism-react-editor/autocomplete";
import { useCursorPosition } from "prism-react-editor/cursor";
import "prism-react-editor/prism/languages/sql";
import "prism-react-editor/languages/sql";
import "prism-react-editor/layout.css";
import "prism-react-editor/themes/github-light.css";
import "prism-react-editor/autocomplete.css";
import "prism-react-editor/autocomplete-icons.css";
import { useWorkspaceStore } from "@/app/store";
import {
  DETECTOR_QUERY_MATCH_LIMIT,
  useApplyTrim,
  useClearQueryHistory,
  useQueryHistory,
  useRecordQuery,
  useRemoveQuery,
  useRunDetectorQuery,
  useSignalCatalog,
} from "@/shared/api/hooks";
import type { NeedsDecodeInfo, QueryHistoryEntry } from "@/shared/api/trace-source";
import { WHOLE_TRACE_DECODE_WARN_BYTES } from "@/shared/api/trace-source";
import { Button } from "@/shared/ui/button";
import { Checkbox } from "@/shared/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/shared/ui/dialog";
import { Popover, PopoverContent, PopoverTrigger } from "@/shared/ui/popover";
import TargetSignalSelect from "./TargetSignalSelect";
import {
  registerSignalSqlCompletions,
  setSignalCompletionNames,
} from "./signal-sql-completions";

registerSignalSqlCompletions();

/** Cursor + explicit-only signal autocomplete (Ctrl+Space / Mod+I). */
function SignalSqlAutoComplete({ names }: { names: readonly string[] }) {
  const [editor] = usePrismEditor();
  useCursorPosition(editor);
  useAutoComplete(editor, { filter: fuzzyFilter, explicitOnly: true });
  useEffect(() => {
    setSignalCompletionNames(names);
  }, [names]);
  return null;
}

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

function formatUs(us: number): string {
  return `${(us / 1_000_000).toFixed(3)}s`;
}

function formatBytes(n: number): string {
  if (n >= 1024 * 1024 * 1024) return `${(n / (1024 * 1024 * 1024)).toFixed(1)} GiB`;
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(0)} MiB`;
  return `${n} B`;
}

export default function AnalyzerPanel({ blfPath }: AnalyzerPanelProps) {
  const sql = useWorkspaceStore((s) => s.detectorQuerySql);
  const setSql = useWorkspaceStore((s) => s.setDetectorQuerySql);
  const targets = useWorkspaceStore((s) => s.detectorTargetSignalIds);
  const setTargets = useWorkspaceStore((s) => s.setDetectorTargetSignalIds);
  const respectTrim = useWorkspaceStore((s) => s.detectorRespectTrim);
  const setRespectTrim = useWorkspaceStore((s) => s.setDetectorRespectTrim);
  const error = useWorkspaceStore((s) => s.detectorQueryError);
  const setError = useWorkspaceStore((s) => s.setDetectorQueryError);
  const setResult = useWorkspaceStore((s) => s.setDetectorQueryResult);
  const matches = useWorkspaceStore((s) => s.detectorMatches);
  const truncated = useWorkspaceStore((s) => s.detectorQueryTruncated);
  const hasRun = useWorkspaceStore((s) => s.detectorQueryHasRun);
  const trimRange = useWorkspaceStore((s) => s.appliedTrimRange);
  const activeSignalIds = useWorkspaceStore((s) => s.activeSignalIds);
  const commitActiveSignalIds = useWorkspaceStore((s) => s.commitActiveSignalIds);

  const catalog = useSignalCatalog(blfPath);
  const mutation = useRunDetectorQuery(blfPath);
  const applyTrim = useApplyTrim(blfPath);
  const history = useQueryHistory(blfPath);
  const recordQuery = useRecordQuery(blfPath);
  const removeQuery = useRemoveQuery(blfPath);
  const clearHistory = useClearQueryHistory(blfPath);
  const [needsDecode, setNeedsDecode] = useState<NeedsDecodeInfo | null>(null);
  const [confirmPending, setConfirmPending] = useState(false);
  const [restoreNote, setRestoreNote] = useState<string | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  // Editor is uncontrolled; seed + epoch remount it on history restore / file switch.
  const [editorSeed, setEditorSeed] = useState(sql);
  const [editorEpoch, setEditorEpoch] = useState(0);
  const [seedPath, setSeedPath] = useState(blfPath);
  if (seedPath !== blfPath) {
    setSeedPath(blfPath);
    setEditorSeed(useWorkspaceStore.getState().detectorQuerySql);
    setEditorEpoch(0);
  }

  function runArgs(sqlText: string) {
    return {
      sql: sqlText,
      respectTrim,
      startUs: trimRange?.start ?? 0,
      endUs: trimRange?.end ?? Number.MAX_SAFE_INTEGER,
      targetSignalIds: targets,
    };
  }

  function handleResponse(
    response: Awaited<ReturnType<typeof mutation.mutateAsync>>,
    opts: { sqlText: string; afterDecode?: boolean }
  ) {
    if (response.needsDecode) {
      if (opts.afterDecode) {
        setError(
          "Decode completed but signal coverage is still insufficient for this scope. Widen the trim or re-decode."
        );
        return;
      }
      setNeedsDecode(response.needsDecode);
      return;
    }
    if (response.ran) {
      setNeedsDecode(null);
      setResult(response.ran, opts.sqlText);
      recordQuery.mutate({
        sql: opts.sqlText,
        targetSignalIds: response.ran.targetSignalIds,
        respectTrim: !response.ran.wholeTrace,
        matchCount: response.ran.matches.length,
      });
    }
  }

  function run() {
    const sqlText = useWorkspaceStore.getState().detectorQuerySql;
    if (sqlText.trim() === "") return;
    if (hasEmbeddedSemicolon(sqlText)) {
      setError("Only a single SQL statement is supported.");
      return;
    }
    mutation.mutate(runArgs(sqlText), {
      onSuccess: (response) => handleResponse(response, { sqlText }),
      onError: (e) => setError(String(e)),
    });
  }

  async function confirmDecodeAndRerun() {
    if (!needsDecode) return;
    const sqlText = useWorkspaceStore.getState().detectorQuerySql;
    setConfirmPending(true);
    try {
      const nextActive = new Set(activeSignalIds);
      for (const m of needsDecode.missing) nextActive.add(m.signalId);
      for (const id of targets) nextActive.add(id);
      commitActiveSignalIds(nextActive);
      await applyTrim.mutateAsync({
        startUs: needsDecode.scopeStartUs,
        endUs: needsDecode.scopeEndUs,
        activeSignalIds: Array.from(nextActive),
      });
      const response = await mutation.mutateAsync(runArgs(sqlText));
      handleResponse(response, { sqlText, afterDecode: true });
    } catch (e) {
      setError(String(e));
      setNeedsDecode(null);
    } finally {
      setConfirmPending(false);
    }
  }

  function onEditorKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      run();
    }
  }

  function loadHistoryEntry(entry: QueryHistoryEntry) {
    setSql(entry.sql);
    setEditorSeed(entry.sql);
    setEditorEpoch((e) => e + 1);
    setRespectTrim(entry.respectTrim);
    const catalogIds = new Set((catalog.data ?? []).map((c) => c.signalId));
    const kept: number[] = [];
    const skipped: number[] = [];
    for (const id of entry.targetSignalIds) {
      if (catalogIds.has(id)) kept.push(id);
      else skipped.push(id);
    }
    setTargets(kept);
    setRestoreNote(
      skipped.length > 0
        ? `Skipped ${skipped.length} target signal${skipped.length === 1 ? "" : "s"} missing from catalog.`
        : null
    );
    setHistoryOpen(false);
  }

  const busy = mutation.isPending || confirmPending || applyTrim.isPending;
  const showSizeWarning =
    needsDecode?.wholeTrace === true && (needsDecode?.blfBytes ?? 0) > WHOLE_TRACE_DECODE_WARN_BYTES;
  const signalNames = useMemo(
    () => (catalog.data ?? []).map((s) => s.name),
    [catalog.data]
  );

  return (
    <div className="flex h-full flex-col gap-2 p-2">
      <div className="flex shrink-0 items-center justify-between gap-2">
        <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
          Analyzer
        </span>
        <Popover open={historyOpen} onOpenChange={setHistoryOpen}>
          <PopoverTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-7 w-7 text-muted-foreground"
              aria-label="Recent queries"
              title="Recent queries"
            >
              <History className="h-3.5 w-3.5" />
            </Button>
          </PopoverTrigger>
          <PopoverContent align="end" className="w-[40rem] max-w-[min(40rem,calc(100vw-2rem))] p-2">
            <div className="mb-1 flex items-center justify-between px-1">
              <div className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                Recent queries
              </div>
              {(history.data?.length ?? 0) > 0 && (
                <button
                  type="button"
                  className="text-[10px] text-muted-foreground underline"
                  onClick={() => clearHistory.mutate()}
                >
                  Clear all
                </button>
              )}
            </div>
            <div className="flex max-h-64 flex-col gap-2 overflow-y-auto">
              {(history.data?.length ?? 0) === 0 && (
                <div className="px-1 text-xs text-muted-foreground">
                  No recent queries for this trace.
                </div>
              )}
              {history.data?.map((entry) => (
                <div
                  key={`${entry.ranAt}-${entry.sql}`}
                  className="flex items-start gap-2 rounded border border-border/60 px-3 py-2.5 hover:bg-accent"
                >
                  <button
                    type="button"
                    className="min-w-0 flex-1 whitespace-pre-wrap break-all text-left font-mono text-[10px] hover:underline"
                    onClick={() => loadHistoryEntry(entry)}
                  >
                    {entry.sql.trim()}
                  </button>
                  <div className="flex shrink-0 items-center gap-0.5">
                    <button
                      type="button"
                      className="rounded p-1 text-muted-foreground hover:bg-background hover:text-foreground"
                      aria-label="Copy query"
                      title="Copy query"
                      onClick={() => void navigator.clipboard.writeText(entry.sql)}
                    >
                      <Copy className="h-3 w-3" />
                    </button>
                    <button
                      type="button"
                      className="rounded px-1.5 py-0.5 text-[10px] text-muted-foreground hover:bg-background hover:text-destructive"
                      aria-label="Remove query from history"
                      onClick={() => removeQuery.mutate(entry.sql)}
                    >
                      ×
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </PopoverContent>
        </Popover>
      </div>

      <label className="flex shrink-0 items-center gap-2 text-xs">
        <Checkbox
          checked={respectTrim}
          onCheckedChange={(checked) => setRespectTrim(checked === true)}
        />
        Respect trim window
      </label>

      <TargetSignalSelect blfPath={blfPath} />

      <div className="min-h-0 flex-1 overflow-hidden rounded border border-border [&_.prism-code-editor]:h-full [&_.prism-code-editor]:rounded [&_.prism-code-editor]:text-xs [&_.prism-code-editor]:[font-family:var(--font-mono)]">
        <Editor
          key={`${blfPath}:${editorEpoch}`}
          language="sql"
          value={editorSeed}
          onUpdate={setSql}
          lineNumbers
          wordWrap
          style={{ height: "100%" }}
          textareaProps={{
            placeholder: "select msg_id, timestamp_us from messages where ...",
            spellCheck: false,
            onKeyDown: onEditorKeyDown,
          }}
        >
          <SignalSqlAutoComplete names={signalNames} />
        </Editor>
      </div>
      <div className="flex items-center justify-between gap-2">
        <Button size="sm" onClick={run} disabled={busy}>
          {busy ? "Running..." : "Run"}
        </Button>
        <span className="text-xs text-muted-foreground">
          Ctrl+Space signals · Cmd/Ctrl+Enter
        </span>
      </div>
      {restoreNote && <div className="text-xs text-muted-foreground">{restoreNote}</div>}
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

      <Dialog
        open={needsDecode !== null}
        onOpenChange={(open) => !open && !confirmPending && setNeedsDecode(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Decode required</DialogTitle>
            <DialogDescription>
              These target signals are not decoded for the run scope. Confirm to decode, then re-run
              the query.
            </DialogDescription>
          </DialogHeader>
          {needsDecode && (
            <div className="flex flex-col gap-2 px-4 pb-2 text-sm">
              <div>
                Scope:{" "}
                {needsDecode.wholeTrace
                  ? `whole trace (${formatUs(needsDecode.scopeStartUs)} – ${formatUs(needsDecode.scopeEndUs)})`
                  : `trim window (${formatUs(needsDecode.scopeStartUs)} – ${formatUs(needsDecode.scopeEndUs)})`}
              </div>
              <ul className="list-inside list-disc">
                {needsDecode.missing.map((m) => (
                  <li key={m.signalId}>{m.name}</li>
                ))}
              </ul>
              {showSizeWarning && (
                <div className="rounded border border-amber-500/50 bg-amber-500/10 p-2 text-xs text-amber-900 dark:text-amber-200">
                  Trace file is {formatBytes(needsDecode.blfBytes)} (&gt; 5 GiB). Decoding the whole
                  trace may take a while and will block queries while it runs.
                </div>
              )}
            </div>
          )}
          <DialogFooter className="gap-2 p-4 pt-0">
            <Button variant="outline" onClick={() => setNeedsDecode(null)} disabled={confirmPending}>
              Cancel
            </Button>
            <Button onClick={confirmDecodeAndRerun} disabled={confirmPending}>
              {confirmPending ? "Decoding..." : "Decode and run"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
