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
  const [page, setPage] = useState<ExplorerTablePage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const mutation = useRunExplorerTablePage(blfPath);

  function run() {
    const sqlText = sql.trim();
    if (sqlText === "") return;
    if (hasEmbeddedSemicolon(sqlText)) {
      setError("Only a single SQL statement is supported.");
      return;
    }
    mutation.mutate(
      { sql: sqlText, pageSize: 50, offset: 0, orderByColumn: null, orderByDesc: false },
      {
        onSuccess: (result) => {
          setError(null);
          setPage(result);
        },
        onError: (e) => {
          setError(String(e));
          setPage(null);
        },
      }
    );
  }

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
          <table className="w-full text-left text-xs">
            <thead className="sticky top-0 bg-muted">
              <tr>
                {page.columns.map((c) => (
                  <th key={c.name} className="whitespace-nowrap px-2 py-1 font-medium">
                    {c.name}
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
