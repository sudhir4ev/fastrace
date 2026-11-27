import { useState } from "react";
import { Copy, History } from "lucide-react";
import { Editor } from "prism-react-editor";
import "prism-react-editor/prism/languages/sql";
import "prism-react-editor/languages/sql";
import "prism-react-editor/layout.css";
import "prism-react-editor/themes/github-light.css";
import {
  useClearExplorerQueryHistory,
  useExplorerQueryHistory,
  useExplorerSavedQueries,
  useRecordExplorerQuery,
  useRemoveExplorerQuery,
  useRunExplorerChartQuery,
  useRunExplorerTablePage,
  useSaveExplorerQuery,
} from "@/shared/api/hooks";
import type {
  ExplorerChartResult,
  ExplorerQueryEntry,
  ExplorerTablePage,
  SavedExplorerQuery,
} from "@/shared/api/trace-source";
import { Button } from "@/shared/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/shared/ui/dialog";
import { Popover, PopoverContent, PopoverTrigger } from "@/shared/ui/popover";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/shared/ui/resizable";
import ExplorerChart from "./ExplorerChart";

interface ExplorerPanelProps {
  blfPath: string;
}

// Copy of AnalyzerPanel's pre-check (app/ui/src/widgets/AnalyzerPanel.tsx) -
// a cheap client-side guard; DuckDB's own parser is the real one.
function hasEmbeddedSemicolon(sql: string): boolean {
  const trimmed = sql.trim();
  const withoutTrailing = trimmed.endsWith(";") ? trimmed.slice(0, -1) : trimmed;
  return withoutTrailing.includes(";");
}

export default function ExplorerPanel({ blfPath }: ExplorerPanelProps) {
  const [sql, setSql] = useState("");
  // Editor is uncontrolled (same library/pattern as AnalyzerPanel.tsx): binding
  // `value` straight to the live typed state creates a feedback loop where the
  // editor resets its cursor to the start on every keystroke, reversing
  // whatever gets typed. `editorSeed`/`editorEpoch` only change on an explicit
  // load (history/saved-query), never while typing.
  const [editorSeed, setEditorSeed] = useState("");
  const [editorEpoch, setEditorEpoch] = useState(0);
  const [ranSql, setRanSql] = useState<string | null>(null);
  const [page, setPage] = useState<ExplorerTablePage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pageSize, setPageSize] = useState(50);
  const [pageIndex, setPageIndex] = useState(0);
  const [sortColumn, setSortColumn] = useState<string | null>(null);
  const [sortDesc, setSortDesc] = useState(false);
  const mutation = useRunExplorerTablePage(blfPath);
  const history = useExplorerQueryHistory(blfPath);
  const recordQuery = useRecordExplorerQuery(blfPath);
  const removeQuery = useRemoveExplorerQuery(blfPath);
  const clearHistory = useClearExplorerQueryHistory(blfPath);
  const [historyOpen, setHistoryOpen] = useState(false);

  function loadHistoryEntry(entry: ExplorerQueryEntry) {
    setSql(entry.sql);
    setEditorSeed(entry.sql);
    setEditorEpoch((e) => e + 1);
    setHistoryOpen(false);
  }

  const savedQueries = useExplorerSavedQueries(blfPath);
  const saveQuery = useSaveExplorerQuery(blfPath);
  const [saveDialogOpen, setSaveDialogOpen] = useState(false);
  const [saveName, setSaveName] = useState("");

  function openSaveDialog() {
    if (!ranSql) return;
    setSaveName("");
    setSaveDialogOpen(true);
  }

  function confirmSave() {
    const name = saveName.trim();
    if (name === "" || !ranSql) return; // blank names are rejected before the Tauri call
    saveQuery.mutate({ name, sql: ranSql });
    setSaveDialogOpen(false);
  }

  function loadSavedQuery(entry: SavedExplorerQuery) {
    setSql(entry.sql);
    setEditorSeed(entry.sql);
    setEditorEpoch((e) => e + 1);
  }

  const [viewMode, setViewMode] = useState<"table" | "chart">("table");
  const [chartX, setChartX] = useState<string | null>(null);
  const [chartY, setChartY] = useState<string | null>(null);
  const [vizType, setVizType] = useState<"bar" | "line">("line");
  const [chartResult, setChartResult] = useState<ExplorerChartResult | null>(null);
  const [seriesBy, setSeriesBy] = useState<string | null>(null);
  const [grouped, setGrouped] = useState(false);
  const [aggFn, setAggFn] = useState<"count" | "sum" | "avg" | "min" | "max">("count");
  const [aggColumn, setAggColumn] = useState<string | null>(null);
  const chartMutation = useRunExplorerChartQuery(blfPath);

  function applyChart() {
    if (!ranSql || !chartX) return;
    const config = { x: chartX, seriesBy, y: grouped ? "" : (chartY ?? "") };
    const metric = grouped ? { agg: aggFn, column: aggFn === "count" ? null : aggColumn } : null;
    if (!grouped && !chartY) return;
    if (grouped && aggFn !== "count" && !aggColumn) return;
    chartMutation.mutate({ baseSql: ranSql, config, metric, rowLimit: 5000 }, { onSuccess: setChartResult });
  }

  function fetchPage(sqlText: string, index: number, size: number, col: string | null, desc: boolean) {
    mutation.mutate(
      { sql: sqlText, pageSize: size, offset: index * size, orderByColumn: col, orderByDesc: desc },
      {
        onSuccess: (result) => {
          setError(null);
          setPage(result);
          setRanSql(sqlText);
          recordQuery.mutate({ sql: sqlText, rowCount: result.totalRows });
        },
        onError: (e) => {
          setError(String(e));
          setPage(null);
        },
      }
    );
  }

  function run() {
    const sqlText = sql.trim();
    if (sqlText === "") return;
    if (hasEmbeddedSemicolon(sqlText)) {
      setError("Only a single SQL statement is supported.");
      return;
    }
    setPageIndex(0);
    setSortColumn(null);
    setSortDesc(false);
    fetchPage(sqlText, 0, pageSize, null, false);
  }

  function goToPage(index: number) {
    if (!ranSql) return;
    setPageIndex(index);
    fetchPage(ranSql, index, pageSize, sortColumn, sortDesc);
  }

  function sortBy(column: string) {
    if (!ranSql) return;
    const nextDesc = sortColumn === column ? !sortDesc : false;
    setSortColumn(column);
    setSortDesc(nextDesc);
    setPageIndex(0);
    fetchPage(ranSql, 0, pageSize, column, nextDesc);
  }

  const totalPages = page ? Math.max(1, Math.ceil(page.totalRows / pageSize)) : 1;

  return (
    <div className="flex h-full flex-col gap-2 p-2">
      <div className="flex shrink-0 items-center justify-between gap-2">
        <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
          Explorer
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
                <div className="px-1 text-xs text-muted-foreground">No recent queries for this trace.</div>
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
      <ResizablePanelGroup direction="vertical" className="min-h-0 flex-1">
        <ResizablePanel defaultSize={35} minSize={15}>
          <div className="h-full overflow-hidden rounded border border-border [&_.prism-code-editor]:h-full [&_.prism-code-editor]:rounded [&_.prism-code-editor]:text-xs [&_.prism-code-editor]:[font-family:var(--font-mono)]">
            <Editor
              key={editorEpoch}
              language="sql"
              value={editorSeed}
              onUpdate={setSql}
              lineNumbers
              wordWrap
              style={{ height: "100%" }}
              textareaProps={{ placeholder: "select * from messages limit 50", spellCheck: false }}
            />
          </div>
        </ResizablePanel>
        <ResizableHandle withHandle />
        <ResizablePanel defaultSize={65} minSize={20}>
          <div className="flex h-full flex-col gap-2">
            <div className="flex shrink-0 items-center gap-2">
              <Button size="sm" onClick={run} disabled={mutation.isPending}>
                {mutation.isPending ? "Running..." : "Run"}
              </Button>
              <Button size="sm" variant="outline" onClick={openSaveDialog} disabled={!ranSql}>
                Save
              </Button>
              {page && (
                <div className="ml-auto flex items-center gap-1 rounded border border-border p-0.5">
                  <button
                    type="button"
                    className={`rounded px-2 py-0.5 text-xs ${viewMode === "table" ? "bg-muted" : ""}`}
                    onClick={() => setViewMode("table")}
                  >
                    Raw
                  </button>
                  <button
                    type="button"
                    className={`rounded px-2 py-0.5 text-xs ${viewMode === "chart" ? "bg-muted" : ""}`}
                    onClick={() => setViewMode("chart")}
                  >
                    Chart
                  </button>
                </div>
              )}
            </div>
            {(savedQueries.data?.length ?? 0) > 0 && (
              <div className="flex shrink-0 flex-wrap gap-1 text-xs">
                {savedQueries.data?.map((entry) => (
                  <button
                    key={`${entry.savedAt}-${entry.name}`}
                    type="button"
                    className="rounded border border-border/60 px-2 py-1 hover:bg-accent"
                    title={entry.sql}
                    onClick={() => loadSavedQuery(entry)}
                  >
                    {entry.name}
                  </button>
                ))}
              </div>
            )}
            {error && (
              <div className="shrink-0 rounded border border-destructive/50 bg-destructive/10 p-2 text-xs text-destructive">
                {error}
              </div>
            )}
            {page && viewMode === "table" && (
              <div className="min-h-0 flex-1 overflow-auto rounded border border-border">
                <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border px-2 py-1 text-xs text-muted-foreground">
                  <span>
                    {page.totalRows.toLocaleString()} row{page.totalRows === 1 ? "" : "s"} · page {pageIndex + 1} of{" "}
                    {totalPages}
                  </span>
                  <div className="flex items-center gap-2">
                    <select
                      className="rounded border border-border bg-background px-1 py-0.5"
                      value={pageSize}
                      onChange={(e) => {
                        const size = Number(e.target.value);
                        setPageSize(size);
                        setPageIndex(0);
                        if (ranSql) fetchPage(ranSql, 0, size, sortColumn, sortDesc);
                      }}
                    >
                      {[25, 50, 100, 250].map((size) => (
                        <option key={size} value={size}>
                          {size}/page
                        </option>
                      ))}
                    </select>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={pageIndex === 0}
                      onClick={() => goToPage(pageIndex - 1)}
                    >
                      Prev
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={pageIndex + 1 >= totalPages}
                      onClick={() => goToPage(pageIndex + 1)}
                    >
                      Next
                    </Button>
                  </div>
                </div>
                <table className="w-full text-left text-xs">
                  <thead className="sticky top-0 bg-muted">
                    <tr>
                      {page.columns.map((c) => (
                        <th
                          key={c.name}
                          className="cursor-pointer select-none whitespace-nowrap px-2 py-1 font-medium hover:bg-accent"
                          onClick={() => sortBy(c.name)}
                        >
                          {c.name}
                          {sortColumn === c.name && (sortDesc ? " ▼" : " ▲")}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {page.rows.map((row, i) => (
                      <tr key={i} className="border-t border-border/60">
                        {row.map((cell, j) => (
                          <td key={j} className="whitespace-nowrap px-2 py-1 font-mono">
                            {cell}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {page && viewMode === "chart" && (
              <ResizablePanelGroup direction="horizontal" className="min-h-0 flex-1">
                <ResizablePanel defaultSize={25} minSize={15} maxSize={40}>
                  <div className="flex h-full flex-col gap-4 overflow-y-auto rounded border border-border p-3 text-xs">
                    <div className="flex flex-col gap-1">
                      <span className="font-medium uppercase tracking-wide text-muted-foreground">Chart type</span>
                      <div className="flex gap-1">
                        <Button
                          size="sm"
                          variant={vizType === "bar" ? "default" : "outline"}
                          className="flex-1"
                          onClick={() => setVizType("bar")}
                        >
                          Bar
                        </Button>
                        <Button
                          size="sm"
                          variant={vizType === "line" ? "default" : "outline"}
                          className="flex-1"
                          onClick={() => setVizType("line")}
                        >
                          Line
                        </Button>
                      </div>
                    </div>

                    <div className="flex flex-col gap-3">
                      <span className="font-medium uppercase tracking-wide text-muted-foreground">Mapping</span>
                      <label className="flex flex-col gap-1">
                        <span>X</span>
                        <select
                          className="rounded border border-border bg-background px-1 py-0.5"
                          value={chartX ?? ""}
                          onChange={(e) => setChartX(e.target.value || null)}
                        >
                          <option value="" disabled>
                            Choose a column
                          </option>
                          {page.columns.map((c) => (
                            <option key={c.name} value={c.name}>
                              {c.name}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label className="flex flex-col gap-1">
                        <span>Group by (optional)</span>
                        <select
                          className="rounded border border-border bg-background px-1 py-0.5"
                          value={seriesBy ?? ""}
                          onChange={(e) => setSeriesBy(e.target.value || null)}
                        >
                          <option value="">None</option>
                          {page.columns.map((c) => (
                            <option key={c.name} value={c.name}>
                              {c.name}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label className="flex items-center gap-2">
                        <input type="checkbox" checked={grouped} onChange={(e) => setGrouped(e.target.checked)} />
                        Group results
                      </label>
                      {!grouped ? (
                        <label className="flex flex-col gap-1">
                          <span>Y</span>
                          <select
                            className="rounded border border-border bg-background px-1 py-0.5"
                            value={chartY ?? ""}
                            onChange={(e) => setChartY(e.target.value || null)}
                          >
                            <option value="" disabled>
                              Choose a numeric column
                            </option>
                            {page.columns.filter((c) => c.numeric).map((c) => (
                              <option key={c.name} value={c.name}>
                                {c.name}
                              </option>
                            ))}
                          </select>
                        </label>
                      ) : (
                        <>
                          <label className="flex flex-col gap-1">
                            <span>Aggregate</span>
                            <select
                              className="rounded border border-border bg-background px-1 py-0.5"
                              value={aggFn}
                              onChange={(e) => setAggFn(e.target.value as typeof aggFn)}
                            >
                              <option value="count">Count</option>
                              <option value="sum">Sum</option>
                              <option value="avg">Avg</option>
                              <option value="min">Min</option>
                              <option value="max">Max</option>
                            </select>
                          </label>
                          {aggFn !== "count" && (
                            <label className="flex flex-col gap-1">
                              <span>of</span>
                              <select
                                className="rounded border border-border bg-background px-1 py-0.5"
                                value={aggColumn ?? ""}
                                onChange={(e) => setAggColumn(e.target.value || null)}
                              >
                                <option value="" disabled>
                                  Choose a numeric column
                                </option>
                                {page.columns.filter((c) => c.numeric).map((c) => (
                                  <option key={c.name} value={c.name}>
                                    {c.name}
                                  </option>
                                ))}
                              </select>
                            </label>
                          )}
                        </>
                      )}
                    </div>

                    <div className="mt-auto flex flex-col gap-1">
                      {chartResult?.truncated && (
                        <span className="text-muted-foreground">(showing first {chartResult.rows.length})</span>
                      )}
                      <Button
                        size="sm"
                        onClick={applyChart}
                        disabled={
                          !chartX ||
                          (!grouped && !chartY) ||
                          (grouped && aggFn !== "count" && !aggColumn) ||
                          chartMutation.isPending
                        }
                      >
                        Apply
                      </Button>
                    </div>
                  </div>
                </ResizablePanel>
                <ResizableHandle withHandle />
                <ResizablePanel defaultSize={75} minSize={40}>
                  <div className="h-full rounded border border-border">
                    {chartResult && (
                      <ExplorerChart result={chartResult} vizType={vizType} hasSeries={seriesBy !== null} />
                    )}
                  </div>
                </ResizablePanel>
              </ResizablePanelGroup>
            )}
          </div>
        </ResizablePanel>
      </ResizablePanelGroup>

      <Dialog open={saveDialogOpen} onOpenChange={setSaveDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Save query</DialogTitle>
          </DialogHeader>
          <div className="px-4 pb-2">
            <input
              autoFocus
              className="w-full rounded border border-border bg-background px-2 py-1 text-sm"
              placeholder="Name this query"
              value={saveName}
              onChange={(e) => setSaveName(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && confirmSave()}
            />
          </div>
          <DialogFooter className="gap-2 p-4 pt-0">
            <Button variant="outline" onClick={() => setSaveDialogOpen(false)}>
              Cancel
            </Button>
            <Button onClick={confirmSave} disabled={saveName.trim() === ""}>
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
