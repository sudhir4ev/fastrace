import { useState } from "react";
import { Editor } from "prism-react-editor";
import "prism-react-editor/prism/languages/sql";
import "prism-react-editor/languages/sql";
import "prism-react-editor/layout.css";
import "prism-react-editor/themes/github-light.css";
import { useRunExplorerTablePage } from "@/shared/api/hooks";
import type { ExplorerTablePage } from "@/shared/api/trace-source";
import { Button } from "@/shared/ui/button";

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
  const [ranSql, setRanSql] = useState<string | null>(null);
  const [page, setPage] = useState<ExplorerTablePage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pageSize, setPageSize] = useState(50);
  const [pageIndex, setPageIndex] = useState(0);
  const [sortColumn, setSortColumn] = useState<string | null>(null);
  const [sortDesc, setSortDesc] = useState(false);
  const mutation = useRunExplorerTablePage(blfPath);

  function fetchPage(sqlText: string, index: number, size: number, col: string | null, desc: boolean) {
    mutation.mutate(
      { sql: sqlText, pageSize: size, offset: index * size, orderByColumn: col, orderByDesc: desc },
      {
        onSuccess: (result) => {
          setError(null);
          setPage(result);
          setRanSql(sqlText);
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
      <span className="shrink-0 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
        Explorer
      </span>
      <div className="min-h-0 flex-1 overflow-hidden rounded border border-border [&_.prism-code-editor]:h-full [&_.prism-code-editor]:rounded [&_.prism-code-editor]:text-xs [&_.prism-code-editor]:[font-family:var(--font-mono)]">
        <Editor
          language="sql"
          value={sql}
          onUpdate={setSql}
          lineNumbers
          wordWrap
          style={{ height: "100%" }}
          textareaProps={{ placeholder: "select * from messages limit 50", spellCheck: false }}
        />
      </div>
      <div className="shrink-0">
        <Button size="sm" onClick={run} disabled={mutation.isPending}>
          {mutation.isPending ? "Running..." : "Run"}
        </Button>
      </div>
      {error && (
        <div className="shrink-0 rounded border border-destructive/50 bg-destructive/10 p-2 text-xs text-destructive">
          {error}
        </div>
      )}
      {page && (
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
              <Button size="sm" variant="outline" disabled={pageIndex === 0} onClick={() => goToPage(pageIndex - 1)}>
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
    </div>
  );
}
