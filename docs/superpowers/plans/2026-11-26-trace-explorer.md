# Trace Explorer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user run arbitrary SQL against the open Trace Store and see paginated, sortable results, with recent/saved query recall, and (Phase 2) a simple bar/line chart built from the same query.

**Architecture:** A new `crates/query::run_explorer_table_page` re-executes the user's SQL as a wrapped subquery per page (never materializes the full result into the frontend), fronted by one new Tauri command and one new React tab (`ExplorerPanel`). History/saved queries extend `ProjectFile` with two new, Explorer-only fields (not a reuse of Analyzer's `QueryHistoryEntry`). Phase 2 adds `run_explorer_chart_query`, which re-shapes the same base SQL (`x`/`g`/`y` aliases, optional `GROUP BY`) and renders with the existing ECharts + `signalColors.ts` palette.

**Tech Stack:** Rust (`duckdb` 1.1.1, `serde`), React + TypeScript (`prism-react-editor`, `@tanstack/react-query`, `echarts` 6.1.0), Tauri IPC.

**Spec:** `docs/superpowers/specs/2026-11-26-trace-explorer-design.md`

## Global Constraints

- DuckDB connections are opened read-only (`trace_store::open`) - Explorer never writes.
- Every page/chart re-executes the user's SQL wrapped as `select ... from (<baseSql>) as explorer_base` - the base SQL is never fully fetched into the frontend.
- Single-statement guard: client-side `hasEmbeddedSemicolon` pre-check (copy of `AnalyzerPanel`'s), DuckDB's own parser is the real guard.
- `order_by` targets an actual result column, passed through as a quoted identifier (`"col"`, doubling embedded `"`), never string-concatenated into the SQL unescaped.
- New `ProjectFile` fields (`explorerQueryHistory`, `explorerSavedQueries`) are `#[serde(default)]` so existing project files without them still load.
- Phase 2 chart config aliases output as `x`/`g`/`y` regardless of the user's column names - the frontend never infers which returned column is which.
- Mark specs for the chart are fixed (2px lines, always-on hover/tooltip, `getSignalColor`/`PALETTE` from `app/ui/src/app/signalColors.ts`) - no interpolation picker, no hover toggle.

## Review Focus

- Empty/whitespace-only SQL submitted to Explorer must return a clean error ("query is empty"), not a panic or a DuckDB parse error on an empty string. (Task 1)
- A query whose page or whole result set is legitimately empty (0 matching rows) must still return correct `columns`/`totalRows: 0`, not an error - an empty result is not a failure. (Task 1)
- An `order_by` column name that doesn't exist, or contains a `"` or SQL metacharacters, must surface as a safe DuckDB binder error (quoting prevents injection) and must never execute unintended SQL against the store. (Task 1)
- Re-running the exact same SQL (whitespace-only differences) must replace the existing history entry, not grow the list unbounded - same normalize-and-dedupe behavior as Analyzer's `push_query`. (Task 6)
- Saving a query with a blank/whitespace-only name must be rejected client-side before the Tauri call, not silently saved as an empty label. (Task 11)

---

## Wave 1 (Phases 1+2 of the design doc): backend command + basic Explorer tab

### Task 1: `run_explorer_table_page` in `crates/query`

**Files:**
- Modify: `crates/query/src/lib.rs`

**Interfaces:**
- Produces: `pub struct ExplorerColumn { pub name: String, pub numeric: bool }`, `pub struct ExplorerTablePage { pub columns: Vec<ExplorerColumn>, pub rows: Vec<Vec<String>>, pub total_rows: i64 }`, `pub fn run_explorer_table_page(conn: &trace_store::Connection, sql: &str, page_size: i64, offset: i64, order_by_column: Option<&str>, order_by_desc: bool) -> Result<ExplorerTablePage, String>` - consumed by Task 2.

- [ ] **Step 1: Write the failing tests**

Add to the bottom of `crates/query/src/lib.rs`'s `#[cfg(test)] mod tests`:

```rust
    fn explorer_fixture() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE widgets (id INTEGER, label VARCHAR, price DOUBLE);
             INSERT INTO widgets VALUES
                (1, 'a', 1.5), (2, 'b', 2.5), (3, 'c', 3.5), (4, 'd', 4.5), (5, 'e', 5.5);",
        )
        .unwrap();
        conn
    }

    #[test]
    fn run_explorer_table_page_returns_requested_page_and_total() {
        let conn = explorer_fixture();
        let page = run_explorer_table_page(
            &conn,
            "select * from widgets",
            2,
            0,
            Some("id"),
            false,
        )
        .unwrap();
        assert_eq!(page.total_rows, 5);
        assert_eq!(
            page.columns,
            vec![
                ExplorerColumn { name: "id".to_string(), numeric: true },
                ExplorerColumn { name: "label".to_string(), numeric: false },
                ExplorerColumn { name: "price".to_string(), numeric: true },
            ]
        );
        assert_eq!(
            page.rows,
            vec![
                vec!["1".to_string(), "a".to_string(), "1.5".to_string()],
                vec!["2".to_string(), "b".to_string(), "2.5".to_string()],
            ]
        );
    }

    #[test]
    fn run_explorer_table_page_returns_the_second_page() {
        let conn = explorer_fixture();
        let page =
            run_explorer_table_page(&conn, "select * from widgets", 2, 2, Some("id"), false).unwrap();
        assert_eq!(page.rows[0][0], "3");
        assert_eq!(page.rows[1][0], "4");
    }

    #[test]
    fn run_explorer_table_page_sorts_descending() {
        let conn = explorer_fixture();
        let page =
            run_explorer_table_page(&conn, "select * from widgets", 1, 0, Some("id"), true).unwrap();
        assert_eq!(page.rows[0][0], "5");
    }

    #[test]
    fn run_explorer_table_page_quotes_the_order_by_identifier() {
        let conn = Connection::open_in_memory().unwrap();
        // "order" is a reserved word - only safe as a quoted identifier.
        conn.execute_batch(r#"CREATE TABLE t ("order" INTEGER); INSERT INTO t VALUES (2), (1);"#)
            .unwrap();
        let page = run_explorer_table_page(&conn, "select * from t", 10, 0, Some("order"), false).unwrap();
        assert_eq!(page.rows, vec![vec!["1".to_string()], vec!["2".to_string()]]);
    }

    #[test]
    fn run_explorer_table_page_rejects_an_order_by_column_that_would_inject_sql() {
        let conn = explorer_fixture();
        let result = run_explorer_table_page(
            &conn,
            "select * from widgets",
            10,
            0,
            Some(r#"id"; drop table widgets; --"#),
            false,
        );
        assert!(result.is_err(), "malformed identifier must be a binder error, not executed SQL");
        // The quoting must have prevented the DROP TABLE from ever running.
        assert_eq!(count_messages_placeholder(&conn), 5);
    }

    fn count_messages_placeholder(conn: &Connection) -> i64 {
        conn.query_row("select count(*) from widgets", [], |row| row.get(0)).unwrap()
    }

    #[test]
    fn run_explorer_table_page_handles_zero_matching_rows() {
        let conn = explorer_fixture();
        let page =
            run_explorer_table_page(&conn, "select * from widgets where id > 100", 10, 0, None, false)
                .unwrap();
        assert_eq!(page.total_rows, 0);
        assert!(page.rows.is_empty());
        assert_eq!(page.columns.len(), 3, "columns are still reported for an empty result");
    }

    #[test]
    fn run_explorer_table_page_renders_null_as_empty_string() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("CREATE TABLE t (label VARCHAR); INSERT INTO t VALUES (NULL);")
            .unwrap();
        let page = run_explorer_table_page(&conn, "select * from t", 10, 0, None, false).unwrap();
        assert_eq!(page.rows, vec![vec!["".to_string()]]);
    }

    #[test]
    fn run_explorer_table_page_rejects_empty_sql() {
        let conn = explorer_fixture();
        assert!(run_explorer_table_page(&conn, "   ", 10, 0, None, false).is_err());
    }

    #[test]
    fn run_explorer_table_page_rejects_nonpositive_page_size() {
        let conn = explorer_fixture();
        assert!(run_explorer_table_page(&conn, "select * from widgets", 0, 0, None, false).is_err());
    }

    #[test]
    fn run_explorer_table_page_rejects_negative_offset() {
        let conn = explorer_fixture();
        assert!(run_explorer_table_page(&conn, "select * from widgets", 10, -1, None, false).is_err());
    }

    #[test]
    fn run_explorer_table_page_surfaces_duckdb_errors_for_bad_sql() {
        let conn = explorer_fixture();
        assert!(run_explorer_table_page(&conn, "select * from no_such_table", 10, 0, None, false).is_err());
    }
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cargo test --manifest-path crates/Cargo.toml -p query run_explorer_table_page`
Expected: compile error (`run_explorer_table_page` not defined) - confirms the tests are wired to real, not-yet-written code.

- [ ] **Step 3: Implement**

Add above the `#[cfg(test)]` module in `crates/query/src/lib.rs`:

```rust
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExplorerColumn {
    pub name: String,
    pub numeric: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExplorerTablePage {
    pub columns: Vec<ExplorerColumn>,
    pub rows: Vec<Vec<String>>,
    pub total_rows: i64,
}

fn normalize_explorer_sql(sql: &str) -> Result<String, String> {
    let trimmed = sql.trim();
    let trimmed = trimmed.strip_suffix(';').unwrap_or(trimmed).trim();
    if trimmed.is_empty() {
        return Err("query is empty".to_string());
    }
    Ok(trimmed.to_string())
}

/// Quotes a DuckDB identifier so it can never be read as anything but a
/// column reference - doubling an embedded `"` is DuckDB/SQL's own escape
/// for a literal quote inside a quoted identifier.
fn quote_identifier(name: &str) -> String {
    format!("\"{}\"", name.replace('"', "\"\""))
}

fn is_numeric_type(ty: &duckdb::types::Type) -> bool {
    use duckdb::types::Type;
    matches!(
        ty,
        Type::TinyInt
            | Type::SmallInt
            | Type::Int
            | Type::BigInt
            | Type::HugeInt
            | Type::UTinyInt
            | Type::USmallInt
            | Type::UInt
            | Type::UBigInt
            | Type::Float
            | Type::Double
            | Type::Decimal
    )
}

/// Renders any DuckDB cell to a display string - the result schema is
/// different per Explorer query, so there's no fixed type to deserialize
/// each column into.
/// shortcut: Timestamp/Date32/Time64/nested types fall back to Rust's Debug
/// format (not calendar-formatted); upgrade if Explorer is used heavily
/// against timestamp/date columns and the raw form proves confusing.
fn value_ref_to_display_string(v: duckdb::types::ValueRef) -> String {
    use duckdb::types::ValueRef;
    match v {
        ValueRef::Null => String::new(),
        ValueRef::Boolean(b) => b.to_string(),
        ValueRef::TinyInt(i) => i.to_string(),
        ValueRef::SmallInt(i) => i.to_string(),
        ValueRef::Int(i) => i.to_string(),
        ValueRef::BigInt(i) => i.to_string(),
        ValueRef::HugeInt(i) => i.to_string(),
        ValueRef::UTinyInt(i) => i.to_string(),
        ValueRef::USmallInt(i) => i.to_string(),
        ValueRef::UInt(i) => i.to_string(),
        ValueRef::UBigInt(i) => i.to_string(),
        ValueRef::Float(f) => f.to_string(),
        ValueRef::Double(f) => f.to_string(),
        ValueRef::Decimal(d) => d.to_string(),
        ValueRef::Text(bytes) => String::from_utf8_lossy(bytes).into_owned(),
        ValueRef::Blob(bytes) => format!("<blob {} bytes>", bytes.len()),
        other => format!("{other:?}"),
    }
}

/// One page of arbitrary user SQL, re-executed against DuckDB per page -
/// the base SQL could return millions of rows, so results are never
/// materialized fully into the frontend (`2026-11-26-trace-explorer-design.md`).
/// `order_by_column`, when present, must name an actual output column of
/// `sql`; it is quoted as an identifier, never concatenated as raw SQL, so a
/// malformed or hostile value fails as a DuckDB binder error instead of
/// executing.
pub fn run_explorer_table_page(
    conn: &trace_store::Connection,
    sql: &str,
    page_size: i64,
    offset: i64,
    order_by_column: Option<&str>,
    order_by_desc: bool,
) -> Result<ExplorerTablePage, String> {
    let trimmed = normalize_explorer_sql(sql)?;
    if page_size < 1 {
        return Err("page_size must be >= 1".to_string());
    }
    if offset < 0 {
        return Err("offset must be >= 0".to_string());
    }

    let total_rows: i64 = conn
        .query_row(
            &format!("select count(*) from ({trimmed}\n) as explorer_base"),
            [],
            |row| row.get(0),
        )
        .map_err(|e| e.to_string())?;

    let order_clause = match order_by_column {
        Some(col) => {
            let dir = if order_by_desc { "desc" } else { "asc" };
            format!("order by {} {dir}\n", quote_identifier(col))
        }
        None => String::new(),
    };
    let page_sql = format!(
        "select * from ({trimmed}\n) as explorer_base\n{order_clause}limit {page_size} offset {offset}"
    );

    let mut stmt = conn.prepare(&page_sql).map_err(|e| e.to_string())?;
    let mut result_rows = stmt.query([]).map_err(|e| e.to_string())?;
    // Grabbed before the row loop below, while `result_rows` is only
    // shared-borrowed (no `Row` held yet) - `Statement::column_count`/
    // `column_name`/`column_type` panic if the query has never been
    // executed, which `stmt.query([])` above already satisfied.
    let stmt_ref = result_rows.as_ref().expect("statement executed above");
    let col_count = stmt_ref.column_count();
    let columns: Vec<ExplorerColumn> = (0..col_count)
        .map(|i| {
            let data_type = stmt_ref.column_type(i);
            ExplorerColumn {
                name: stmt_ref.column_name(i).cloned().unwrap_or_default(),
                numeric: is_numeric_type(&duckdb::types::Type::from(&data_type)),
            }
        })
        .collect();

    let mut rows = Vec::new();
    while let Some(row) = result_rows.next().map_err(|e| e.to_string())? {
        let mut cells = Vec::with_capacity(col_count);
        for i in 0..col_count {
            let value = row.get_ref(i).map_err(|e| e.to_string())?;
            cells.push(value_ref_to_display_string(value));
        }
        rows.push(cells);
    }

    Ok(ExplorerTablePage { columns, rows, total_rows })
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cargo test --manifest-path crates/Cargo.toml -p query run_explorer_table_page`
Expected: all new tests PASS.

- [ ] **Step 5: Commit**

```bash
git add crates/query/src/lib.rs
git commit -m "feat(query): add run_explorer_table_page for ad hoc SQL browsing"
```

---

### Task 2: `run_explorer_table_page` Tauri command

**Files:**
- Modify: `app/src-tauri/src/main.rs`

**Interfaces:**
- Consumes: `query::run_explorer_table_page`, `query::ExplorerTablePage` (Task 1).
- Produces: Tauri command `run_explorer_table_page(blf_path, sql, page_size, offset, order_by_column, order_by_desc) -> Result<query::ExplorerTablePage, String>`, registered in `invoke_handler!` - consumed by Task 3.

- [ ] **Step 1: Write the failing test**

No existing test in `app/src-tauri/src/main.rs` builds a real `.duckdb` Trace Store with a `messages` table (the closest existing fixture, `check_existing_store_true_for_valid_store`, only creates a `meta` table - enough to pass `trace_store::open`'s version check, not enough to query). Add this helper once, alongside the test, at the end of `app/src-tauri/src/main.rs`'s `#[cfg(test)] mod tests`:

```rust
    /// Builds a minimal real `.duckdb` Trace Store (right schema_version, a
    /// `messages` table) at a unique temp path, for commands that actually
    /// call `trace_store::open` and run SQL against it. `name` must be
    /// unique per test (same convention as the other fixture paths in this
    /// module, e.g. `project_test_queries_*`) so concurrently-run tests
    /// never collide on the same file. Returns the `.blf` path; the caller
    /// is responsible for removing the `.duckdb` file afterward, same as
    /// every other fixture-cleanup test in this module.
    fn fixture_trace_store(name: &str) -> String {
        let dir = std::env::temp_dir();
        let blf_path = dir.join(format!("explorer_fixture_{name}_{}.blf", std::process::id()));
        let duckdb_path = blf_path.with_extension("duckdb");
        let conn = trace_store::Connection::open(&duckdb_path).unwrap();
        conn.execute_batch(
            "CREATE TABLE meta (key VARCHAR, value VARCHAR);
             INSERT INTO meta VALUES ('schema_version', '5');
             CREATE TABLE messages (msg_id BIGINT, timestamp_us BIGINT);
             INSERT INTO messages VALUES (0, 1000), (1, 2000), (2, 3000);",
        )
        .unwrap();
        drop(conn);
        blf_path.to_string_lossy().to_string()
    }

    #[test]
    fn run_explorer_table_page_reads_from_the_open_store() {
        let blf_path = fixture_trace_store("table_page");
        let page = run_explorer_table_page(
            blf_path.clone(),
            "select msg_id, timestamp_us from messages".to_string(),
            10,
            0,
            None,
            false,
        )
        .unwrap();
        assert!(!page.columns.is_empty());
        let _ = std::fs::remove_file(std::path::Path::new(&blf_path).with_extension("duckdb"));
    }
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cargo test --manifest-path app/src-tauri/Cargo.toml run_explorer_table_page`
Expected: compile error (function not defined).

- [ ] **Step 3: Implement**

Add near the other `trace_store::open`-based commands in `app/src-tauri/src/main.rs` (next to `run_detector_query`):

```rust
#[tauri::command]
fn run_explorer_table_page(
    blf_path: String,
    sql: String,
    page_size: i64,
    offset: i64,
    order_by_column: Option<String>,
    order_by_desc: bool,
) -> Result<query::ExplorerTablePage, String> {
    let duckdb_path = std::path::Path::new(&blf_path).with_extension("duckdb");
    let conn = trace_store::open(&duckdb_path)?;
    query::run_explorer_table_page(
        &conn,
        &sql,
        page_size,
        offset,
        order_by_column.as_deref(),
        order_by_desc,
    )
}
```

Add `run_explorer_table_page,` to the `tauri::generate_handler![...]` list (next to `run_detector_query,`).

- [ ] **Step 4: Run the test to verify it passes**

Run: `cargo test --manifest-path app/src-tauri/Cargo.toml run_explorer_table_page`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/src-tauri/src/main.rs
git commit -m "feat(tauri): expose run_explorer_table_page command"
```

---

### Task 3: Frontend data source method + hook

**Files:**
- Modify: `app/ui/src/shared/api/trace-source.ts`
- Modify: `app/ui/src/shared/api/hooks.ts`

**Interfaces:**
- Consumes: Tauri command `run_explorer_table_page` (Task 2).
- Produces: `ExplorerColumn`, `ExplorerTablePage` TS types; `TraceDataSource.runExplorerTablePage(...)`; `useRunExplorerTablePage(blfPath)` hook - consumed by Task 4.

- [ ] **Step 1: Add the types and the data source method**

In `app/ui/src/shared/api/trace-source.ts`, add near the other result types (after `QueryHistoryEntry`):

```ts
export interface ExplorerColumn {
  name: string;
  numeric: boolean;
}

export interface ExplorerTablePage {
  columns: ExplorerColumn[];
  rows: string[][];
  totalRows: number;
}
```

Add to the `TraceDataSource` interface:

```ts
  runExplorerTablePage(
    blfPath: string,
    sql: string,
    pageSize: number,
    offset: number,
    orderByColumn: string | null,
    orderByDesc: boolean
  ): Promise<ExplorerTablePage>;
```

Add to `TauriTraceDataSource`:

```ts
  runExplorerTablePage(
    blfPath: string,
    sql: string,
    pageSize: number,
    offset: number,
    orderByColumn: string | null,
    orderByDesc: boolean
  ): Promise<ExplorerTablePage> {
    return invoke<ExplorerTablePage>("run_explorer_table_page", {
      blfPath,
      sql,
      pageSize,
      offset,
      orderByColumn,
      orderByDesc,
    });
  }
```

- [ ] **Step 2: Add the hook**

In `app/ui/src/shared/api/hooks.ts`, add near `useRunDetectorQuery`:

```ts
export function useRunExplorerTablePage(blfPath: string) {
  return useMutation({
    mutationKey: ["run-explorer-table-page", blfPath],
    mutationFn: ({
      sql,
      pageSize,
      offset,
      orderByColumn,
      orderByDesc,
    }: {
      sql: string;
      pageSize: number;
      offset: number;
      orderByColumn: string | null;
      orderByDesc: boolean;
    }) =>
      getTraceDataSource().runExplorerTablePage(blfPath, sql, pageSize, offset, orderByColumn, orderByDesc),
  });
}
```

- [ ] **Step 3: Type-check**

Run: `npm run build --prefix app/ui` (or the project's existing `tsc --noEmit` script if one exists - check `app/ui/package.json`'s `scripts` block first)
Expected: no new type errors.

- [ ] **Step 4: Commit**

```bash
git add app/ui/src/shared/api/trace-source.ts app/ui/src/shared/api/hooks.ts
git commit -m "feat(ui): add runExplorerTablePage data source method and hook"
```

---

### Task 4: `ExplorerPanel` + Explorer tab

**Files:**
- Create: `app/ui/src/widgets/ExplorerPanel.tsx`
- Modify: `app/ui/src/app/store.ts`
- Modify: `app/ui/src/widgets/WorkspaceLayout.tsx`

**Interfaces:**
- Consumes: `useRunExplorerTablePage` (Task 3), `ExplorerTablePage`/`ExplorerColumn` (Task 3).
- Produces: `ExplorerPanel` component (`{ blfPath: string }` props), a new `"explorer"` member of `WorkspaceTab` - consumed by Wave 2's Task 5.

**Manual check for this task (and Wave 1 as a whole):** `cargo tauri dev`, open a trace, click the new Explorer nav icon, type `select * from messages limit 50`, click Run, see the columns and rows render as a plain table.

- [ ] **Step 1: Extend `WorkspaceTab`**

In `app/ui/src/app/store.ts`, change:

```ts
export type WorkspaceTab = "signals" | "messages";
```

to:

```ts
export type WorkspaceTab = "signals" | "messages" | "explorer";
```

No other change to `store.ts` in this task - `ExplorerPanel` keeps its SQL/page/sort state as local component `useState`, not in the global store, because (unlike the Detector Query) nothing outside the Explorer tab reads it, and the tab stays mounted (not unmounted) across nav switches (see the `WorkspaceLayout` change below), so local state already survives.

- [ ] **Step 2: Write `ExplorerPanel`**

Create `app/ui/src/widgets/ExplorerPanel.tsx`:

```tsx
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
```

- [ ] **Step 3: Wire the Explorer tab into `WorkspaceLayout`**

In `app/ui/src/widgets/WorkspaceLayout.tsx`:

Add the import:

```ts
import ExplorerPanel from "./ExplorerPanel";
```

Add `Terminal` to the `lucide-react` import on line 2:

```ts
import { Activity, List, Terminal } from "lucide-react";
```

Add to `NAV_ITEMS`:

```ts
const NAV_ITEMS: { id: WorkspaceTab; label: string; icon: typeof Activity }[] = [
  { id: "signals", label: "Signals", icon: Activity },
  { id: "messages", label: "Messages", icon: List },
  { id: "explorer", label: "Explorer", icon: Terminal },
];
```

Add a third mounted-but-hidden pane next to the `signals`/`messages` ones inside `<main>`:

```tsx
          <div className={cn("absolute inset-0", workspaceTab !== "explorer" && "hidden")} aria-hidden={workspaceTab !== "explorer"}>
            <ExplorerPanel blfPath={blfPath} />
          </div>
```

- [ ] **Step 4: Manual verification**

Run: `cargo tauri dev --manifest-path app/src-tauri/Cargo.toml`
Open a trace, click the new Explorer nav icon, type `select * from messages limit 50`, click Run.
Expected: a plain table of columns/rows appears below.

- [ ] **Step 5: Commit**

```bash
git add app/ui/src/widgets/ExplorerPanel.tsx app/ui/src/app/store.ts app/ui/src/widgets/WorkspaceLayout.tsx
git commit -m "feat(ui): add Explorer tab with SQL editor and raw result table"
```

---

## Wave 2: pagination + sort

### Task 5: Page controls and click-to-sort

**Files:**
- Modify: `app/ui/src/widgets/ExplorerPanel.tsx`

**Interfaces:**
- Consumes: `useRunExplorerTablePage` (Task 3), the already-present `page_size`/`offset`/`order_by_column`/`order_by_desc` params on `run_explorer_table_page` (Task 1 - the backend has supported these since Wave 1; this task is UI-only).

**Manual check:** run a query against a table with more than 50 rows (e.g. `select * from messages`), page through with Prev/Next, confirm the row count label matches `totalRows`. Click a column header, confirm rows re-sort ascending; click again, confirm descending.

- [ ] **Step 1: Add page/sort state and re-fetch on change**

Replace the `useState` block and `run()`/render in `ExplorerPanel.tsx` with:

```tsx
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
```

- [ ] **Step 2: Render sortable headers and page controls**

Replace the `<thead>` block with:

```tsx
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
```

Add a page-size/prev/next bar directly above the results table (inside the `{page && (...)}` block, before the `<table>`):

```tsx
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
```

(`Button`'s `variant="outline"` already exists - see its use in `AnalyzerPanel.tsx`'s decode dialog.)

- [ ] **Step 3: Manual verification**

Run the app, query `select * from messages`, confirm paging and sorting both work and the row count label tracks `totalRows`.

- [ ] **Step 4: Commit**

```bash
git add app/ui/src/widgets/ExplorerPanel.tsx
git commit -m "feat(ui): add Explorer pagination and click-to-sort"
```

---

## Wave 3: query history

### Task 6: `ExplorerQueryEntry` in `crates/project-store`

**Files:**
- Modify: `crates/project-store/src/lib.rs`

**Interfaces:**
- Produces: `pub struct ExplorerQueryEntry { pub sql: String, pub ran_at: i64, pub row_count: i64 }`, `ProjectFile.explorer_query_history: Vec<ExplorerQueryEntry>`, `push_explorer_query`, `remove_explorer_query`, `clear_explorer_query_history` - consumed by Task 7.

- [ ] **Step 1: Write the failing tests**

Add to `crates/project-store/src/lib.rs`'s `#[cfg(test)] mod tests`:

```rust
    #[test]
    fn push_explorer_query_dedupes_by_normalized_sql_and_moves_to_front() {
        let project = ProjectFile::new_for_trace("/t.blf");
        let project = push_explorer_query(
            project,
            ExplorerQueryEntry { sql: "select 1".to_string(), ran_at: 1, row_count: 0 },
        );
        let project = push_explorer_query(
            project,
            ExplorerQueryEntry { sql: "select   1".to_string(), ran_at: 2, row_count: 5 },
        );
        assert_eq!(project.explorer_query_history.len(), 1);
        assert_eq!(project.explorer_query_history[0].ran_at, 2);
    }

    #[test]
    fn push_explorer_query_caps_at_max_query_history() {
        let mut project = ProjectFile::new_for_trace("/t.blf");
        for i in 0..(MAX_QUERY_HISTORY + 5) {
            project = push_explorer_query(
                project,
                ExplorerQueryEntry { sql: format!("select {i}"), ran_at: i as i64, row_count: 0 },
            );
        }
        assert_eq!(project.explorer_query_history.len(), MAX_QUERY_HISTORY);
    }

    #[test]
    fn remove_explorer_query_removes_by_normalized_sql() {
        let project = ProjectFile::new_for_trace("/t.blf");
        let project = push_explorer_query(
            project,
            ExplorerQueryEntry { sql: "select 1".to_string(), ran_at: 1, row_count: 0 },
        );
        let project = remove_explorer_query(project, "select   1");
        assert!(project.explorer_query_history.is_empty());
    }

    #[test]
    fn clear_explorer_query_history_empties_the_list() {
        let project = ProjectFile::new_for_trace("/t.blf");
        let project = push_explorer_query(
            project,
            ExplorerQueryEntry { sql: "select 1".to_string(), ran_at: 1, row_count: 0 },
        );
        assert!(clear_explorer_query_history(project).explorer_query_history.is_empty());
    }

    #[test]
    fn explorer_query_history_round_trips_through_json() {
        let path = temp_path("explorer_roundtrip");
        let mut project = ProjectFile::new_for_trace("/traces/run1.blf");
        project = push_explorer_query(
            project,
            ExplorerQueryEntry { sql: "select 1".to_string(), ran_at: 1, row_count: 3 },
        );
        write_project(&path, &project).unwrap();
        let loaded = read_project(&path, "/traces/run1.blf").unwrap();
        assert_eq!(loaded, project);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn explorer_query_history_defaults_to_empty_for_old_project_files_without_the_field() {
        let path = temp_path("explorer_old_format");
        // A project file written before explorerQueryHistory existed.
        std::fs::write(
            &path,
            r#"{"version":1,"traces":[{"path":"/t.blf","arxmlPath":null,"downsamplingAlgorithms":{}}],
               "displayedSignalIds":[],"trimWindow":null,"queryHistory":[]}"#,
        )
        .unwrap();
        let loaded = read_project(&path, "/t.blf").unwrap();
        assert!(loaded.explorer_query_history.is_empty());
        let _ = std::fs::remove_file(&path);
    }
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cargo test --manifest-path crates/Cargo.toml -p project-store explorer_query`
Expected: compile error (types/functions not defined).

- [ ] **Step 3: Implement**

Add near `QueryHistoryEntry`:

```rust
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExplorerQueryEntry {
    pub sql: String,
    pub ran_at: i64,
    pub row_count: i64,
}
```

Add a field to `ProjectFile` (after `query_history`):

```rust
    #[serde(default)]
    pub explorer_query_history: Vec<ExplorerQueryEntry>,
```

Add to `ProjectFile::new_for_trace`'s struct literal:

```rust
            explorer_query_history: Vec::new(),
```

Add alongside `push_query`/`remove_query`/`clear_query_history`:

```rust
/// Same normalize-and-dedupe/cap behavior as `push_query`, applied to the
/// Explorer's own, separate history list.
pub fn push_explorer_query(mut project: ProjectFile, entry: ExplorerQueryEntry) -> ProjectFile {
    let norm = normalize_query_sql(&entry.sql);
    project
        .explorer_query_history
        .retain(|q| normalize_query_sql(&q.sql) != norm);
    project.explorer_query_history.insert(0, entry);
    project.explorer_query_history.truncate(MAX_QUERY_HISTORY);
    project
}

pub fn remove_explorer_query(mut project: ProjectFile, sql: &str) -> ProjectFile {
    let norm = normalize_query_sql(sql);
    project
        .explorer_query_history
        .retain(|q| normalize_query_sql(&q.sql) != norm);
    project
}

pub fn clear_explorer_query_history(mut project: ProjectFile) -> ProjectFile {
    project.explorer_query_history.clear();
    project
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cargo test --manifest-path crates/Cargo.toml -p project-store explorer_query`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add crates/project-store/src/lib.rs
git commit -m "feat(project-store): add Explorer's own query history, separate from Analyzer's"
```

---

### Task 7: Explorer history Tauri commands

**Files:**
- Modify: `app/src-tauri/src/main.rs`

**Interfaces:**
- Consumes: `project_store::{ExplorerQueryEntry, push_explorer_query, remove_explorer_query, clear_explorer_query_history}` (Task 6), existing `project_path_for`/`now_ms` helpers (already in `main.rs`, used by `record_query`).
- Produces: commands `list_explorer_query_history`, `record_explorer_query`, `remove_explorer_query`, `clear_explorer_query_history`, registered in `invoke_handler!` - consumed by Task 8.

- [ ] **Step 1: Write the failing test**

These commands only read/write the project JSON file (`project_store`), never open a `.duckdb` - same as the existing `query_history_commands_persist_to_the_project_file_not_recent_traces` test, which needs no Trace Store fixture either. Add next to it in `main.rs`'s test module, following its exact same temp-path convention:

```rust
    #[test]
    fn explorer_query_history_commands_persist_independently_of_analyzer_history() {
        let dir = std::env::temp_dir();
        let blf_path = dir.join(format!("project_test_explorer_queries_{}.blf", std::process::id()));
        let blf_path = blf_path.to_string_lossy().to_string();

        record_query(blf_path.clone(), "select 1".to_string(), vec![], true, 3).unwrap();
        record_explorer_query(blf_path.clone(), "select 2".to_string(), 7).unwrap();

        let analyzer_history = list_query_history(blf_path.clone()).unwrap();
        let explorer_history = list_explorer_query_history(blf_path.clone()).unwrap();
        assert_eq!(analyzer_history.len(), 1);
        assert_eq!(explorer_history.len(), 1);
        assert_eq!(explorer_history[0].sql, "select 2");
        assert_eq!(explorer_history[0].row_count, 7);

        remove_explorer_query(blf_path.clone(), "select 2".to_string()).unwrap();
        assert!(list_explorer_query_history(blf_path.clone()).unwrap().is_empty());
        assert_eq!(list_query_history(blf_path.clone()).unwrap().len(), 1, "Analyzer history untouched");

        record_explorer_query(blf_path.clone(), "select 3".to_string(), 1).unwrap();
        clear_explorer_query_history(blf_path.clone()).unwrap();
        assert!(list_explorer_query_history(blf_path.clone()).unwrap().is_empty());

        let _ = std::fs::remove_file(project_store::project_file_path(std::path::Path::new(&blf_path)));
    }
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cargo test --manifest-path app/src-tauri/Cargo.toml explorer_query_history_commands`
Expected: compile error.

- [ ] **Step 3: Implement**

Add next to `list_query_history`/`record_query`/`remove_query`/`clear_query_history` in `main.rs`:

```rust
#[tauri::command]
fn list_explorer_query_history(blf_path: String) -> Result<Vec<project_store::ExplorerQueryEntry>, String> {
    let path = project_path_for(&blf_path);
    Ok(project_store::read_project(&path, &blf_path)?.explorer_query_history)
}

#[tauri::command]
fn record_explorer_query(blf_path: String, sql: String, row_count: i64) -> Result<(), String> {
    let path = project_path_for(&blf_path);
    let project = project_store::read_project(&path, &blf_path)?;
    let entry = project_store::ExplorerQueryEntry { sql, ran_at: now_ms(), row_count };
    project_store::write_project(&path, &project_store::push_explorer_query(project, entry))
}

#[tauri::command]
fn remove_explorer_query(blf_path: String, sql: String) -> Result<(), String> {
    let path = project_path_for(&blf_path);
    let project = project_store::read_project(&path, &blf_path)?;
    project_store::write_project(&path, &project_store::remove_explorer_query(project, &sql))
}

#[tauri::command]
fn clear_explorer_query_history(blf_path: String) -> Result<(), String> {
    let path = project_path_for(&blf_path);
    let project = project_store::read_project(&path, &blf_path)?;
    project_store::write_project(&path, &project_store::clear_explorer_query_history(project))
}
```

Add all four to `tauri::generate_handler![...]` (next to the existing `list_query_history, record_query, remove_query, clear_query_history,`):

```rust
            list_explorer_query_history,
            record_explorer_query,
            remove_explorer_query,
            clear_explorer_query_history,
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cargo test --manifest-path app/src-tauri/Cargo.toml explorer_query_history_commands`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/src-tauri/src/main.rs
git commit -m "feat(tauri): add Explorer query history commands"
```

---

### Task 8: History popover in `ExplorerPanel`

**Files:**
- Modify: `app/ui/src/shared/api/trace-source.ts`
- Modify: `app/ui/src/shared/api/hooks.ts`
- Modify: `app/ui/src/widgets/ExplorerPanel.tsx`

**Interfaces:**
- Consumes: Tauri commands from Task 7.
- Produces: `TraceDataSource.{listExplorerQueryHistory, recordExplorerQuery, removeExplorerQuery, clearExplorerQueryHistory}`; hooks `useExplorerQueryHistory`, `useRecordExplorerQuery`, `useRemoveExplorerQuery`, `useClearExplorerQueryHistory`.

**Manual check:** run 2-3 different queries in the Explorer tab, close and reopen the trace's project (quit/relaunch the app, or just reload if the dev server supports it), open the history popover, confirm all three are still listed; click one and confirm its SQL loads back into the editor.

- [ ] **Step 1: Add types and data source methods**

In `trace-source.ts`, add near `ExplorerTablePage`:

```ts
export interface ExplorerQueryEntry {
  sql: string;
  ranAt: number;
  rowCount: number;
}
```

Add to `TraceDataSource`:

```ts
  listExplorerQueryHistory(blfPath: string): Promise<ExplorerQueryEntry[]>;
  recordExplorerQuery(blfPath: string, sql: string, rowCount: number): Promise<void>;
  removeExplorerQuery(blfPath: string, sql: string): Promise<void>;
  clearExplorerQueryHistory(blfPath: string): Promise<void>;
```

Add to `TauriTraceDataSource`:

```ts
  listExplorerQueryHistory(blfPath: string): Promise<ExplorerQueryEntry[]> {
    return invoke<ExplorerQueryEntry[]>("list_explorer_query_history", { blfPath });
  }

  recordExplorerQuery(blfPath: string, sql: string, rowCount: number): Promise<void> {
    return invoke<void>("record_explorer_query", { blfPath, sql, rowCount });
  }

  removeExplorerQuery(blfPath: string, sql: string): Promise<void> {
    return invoke<void>("remove_explorer_query", { blfPath, sql });
  }

  clearExplorerQueryHistory(blfPath: string): Promise<void> {
    return invoke<void>("clear_explorer_query_history", { blfPath });
  }
```

- [ ] **Step 2: Add hooks**

In `hooks.ts`, add near `useQueryHistory`/`useRecordQuery`/`useRemoveQuery`/`useClearQueryHistory`:

```ts
const EXPLORER_QUERY_HISTORY_KEY = (blfPath: string) => ["explorer-query-history", blfPath];

export function useExplorerQueryHistory(blfPath: string) {
  return useQuery({
    queryKey: EXPLORER_QUERY_HISTORY_KEY(blfPath),
    queryFn: () => getTraceDataSource().listExplorerQueryHistory(blfPath),
  });
}

export function useRecordExplorerQuery(blfPath: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ sql, rowCount }: { sql: string; rowCount: number }) =>
      getTraceDataSource().recordExplorerQuery(blfPath, sql, rowCount),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: EXPLORER_QUERY_HISTORY_KEY(blfPath) }),
  });
}

export function useRemoveExplorerQuery(blfPath: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (sql: string) => getTraceDataSource().removeExplorerQuery(blfPath, sql),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: EXPLORER_QUERY_HISTORY_KEY(blfPath) }),
  });
}

export function useClearExplorerQueryHistory(blfPath: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => getTraceDataSource().clearExplorerQueryHistory(blfPath),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: EXPLORER_QUERY_HISTORY_KEY(blfPath) }),
  });
}
```

- [ ] **Step 3: Add the popover to `ExplorerPanel`**

In `ExplorerPanel.tsx`, add imports:

```ts
import { useState } from "react";
import { Copy, History } from "lucide-react";
import {
  useClearExplorerQueryHistory,
  useExplorerQueryHistory,
  useRecordExplorerQuery,
  useRemoveExplorerQuery,
  useRunExplorerTablePage,
} from "@/shared/api/hooks";
import type { ExplorerQueryEntry, ExplorerTablePage } from "@/shared/api/trace-source";
import { Popover, PopoverContent, PopoverTrigger } from "@/shared/ui/popover";
```

Inside the component, add:

```tsx
  const history = useExplorerQueryHistory(blfPath);
  const recordQuery = useRecordExplorerQuery(blfPath);
  const removeQuery = useRemoveExplorerQuery(blfPath);
  const clearHistory = useClearExplorerQueryHistory(blfPath);
  const [historyOpen, setHistoryOpen] = useState(false);

  function loadHistoryEntry(entry: ExplorerQueryEntry) {
    setSql(entry.sql);
    setHistoryOpen(false);
  }
```

In `fetchPage`'s `onSuccess`, after `setRanSql(sqlText)`, add:

```tsx
          recordQuery.mutate({ sql: sqlText, rowCount: result.totalRows });
```

Replace the header `<span>Explorer</span>` row with a header bar that also carries the history popover - same structure as `AnalyzerPanel.tsx`'s header (copy its popover JSX verbatim, swapping `history`/`removeQuery`/`clearHistory` for the Explorer-scoped hooks above and `loadHistoryEntry` for the Explorer version, and dropping the `respectTrim`/`targetSignalIds` fields from the rendered entry since Explorer entries don't have them):

```tsx
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
```

- [ ] **Step 4: Manual verification**

Run the app, run 2-3 queries, open the history popover, confirm they're listed newest-first, click one to reload it, remove one, clear all.

- [ ] **Step 5: Commit**

```bash
git add app/ui/src/shared/api/trace-source.ts app/ui/src/shared/api/hooks.ts app/ui/src/widgets/ExplorerPanel.tsx
git commit -m "feat(ui): add Explorer recent-queries history popover"
```

---

## Wave 4: saved queries

### Task 9: `SavedExplorerQuery` in `crates/project-store`

**Files:**
- Modify: `crates/project-store/src/lib.rs`

**Interfaces:**
- Produces: `pub struct SavedExplorerQuery { pub name: String, pub sql: String, pub saved_at: i64 }`, `ProjectFile.explorer_saved_queries: Vec<SavedExplorerQuery>`, `pub fn save_explorer_query(project: ProjectFile, entry: SavedExplorerQuery) -> ProjectFile` - consumed by Task 10.

- [ ] **Step 1: Write the failing tests**

Add to `crates/project-store/src/lib.rs`'s test module:

```rust
    #[test]
    fn save_explorer_query_appends_without_capping_or_deduping() {
        let mut project = ProjectFile::new_for_trace("/t.blf");
        project = save_explorer_query(
            project,
            SavedExplorerQuery { name: "A".to_string(), sql: "select 1".to_string(), saved_at: 1 },
        );
        project = save_explorer_query(
            project,
            SavedExplorerQuery { name: "A".to_string(), sql: "select 1".to_string(), saved_at: 2 },
        );
        assert_eq!(project.explorer_saved_queries.len(), 2, "saved queries are never deduped/evicted");
    }

    #[test]
    fn explorer_saved_queries_round_trip_through_json() {
        let path = temp_path("explorer_saved_roundtrip");
        let mut project = ProjectFile::new_for_trace("/traces/run1.blf");
        project = save_explorer_query(
            project,
            SavedExplorerQuery { name: "Idle gaps".to_string(), sql: "select 1".to_string(), saved_at: 42 },
        );
        write_project(&path, &project).unwrap();
        let loaded = read_project(&path, "/traces/run1.blf").unwrap();
        assert_eq!(loaded, project);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn explorer_saved_queries_defaults_to_empty_for_old_project_files() {
        let path = temp_path("explorer_saved_old_format");
        std::fs::write(
            &path,
            r#"{"version":1,"traces":[{"path":"/t.blf","arxmlPath":null,"downsamplingAlgorithms":{}}],
               "displayedSignalIds":[],"trimWindow":null,"queryHistory":[]}"#,
        )
        .unwrap();
        let loaded = read_project(&path, "/t.blf").unwrap();
        assert!(loaded.explorer_saved_queries.is_empty());
        let _ = std::fs::remove_file(&path);
    }
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cargo test --manifest-path crates/Cargo.toml -p project-store explorer_saved`
Expected: compile error.

- [ ] **Step 3: Implement**

Add near `ExplorerQueryEntry`:

```rust
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedExplorerQuery {
    pub name: String,
    pub sql: String,
    pub saved_at: i64,
}
```

Add a field to `ProjectFile` (after `explorer_query_history`):

```rust
    #[serde(default)]
    pub explorer_saved_queries: Vec<SavedExplorerQuery>,
```

Add to `ProjectFile::new_for_trace`'s struct literal:

```rust
            explorer_saved_queries: Vec::new(),
```

Add alongside `push_explorer_query`:

```rust
/// Appends a user-named, intentionally pinned query - never capped or
/// deduped, unlike the rolling `explorer_query_history` (an explicit Save
/// is a different act than an automatic recent-run record).
pub fn save_explorer_query(mut project: ProjectFile, entry: SavedExplorerQuery) -> ProjectFile {
    project.explorer_saved_queries.push(entry);
    project
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cargo test --manifest-path crates/Cargo.toml -p project-store explorer_saved`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add crates/project-store/src/lib.rs
git commit -m "feat(project-store): add Explorer saved queries"
```

---

### Task 10: Saved query Tauri commands

**Files:**
- Modify: `app/src-tauri/src/main.rs`

**Interfaces:**
- Consumes: `project_store::{SavedExplorerQuery, save_explorer_query}` (Task 9).
- Produces: commands `list_explorer_saved_queries`, `save_explorer_query`, registered in `invoke_handler!` - consumed by Task 11.

- [ ] **Step 1: Write the failing test**

Same as Task 7's commands, these only touch the project JSON file - no Trace Store fixture needed:

```rust
    #[test]
    fn explorer_saved_query_commands_persist_a_named_query() {
        let dir = std::env::temp_dir();
        let blf_path = dir.join(format!("project_test_explorer_saved_{}.blf", std::process::id()));
        let blf_path = blf_path.to_string_lossy().to_string();

        save_explorer_query(blf_path.clone(), "Idle gaps".to_string(), "select 1".to_string()).unwrap();
        let saved = list_explorer_saved_queries(blf_path.clone()).unwrap();
        assert_eq!(saved.len(), 1);
        assert_eq!(saved[0].name, "Idle gaps");
        assert_eq!(saved[0].sql, "select 1");

        let _ = std::fs::remove_file(project_store::project_file_path(std::path::Path::new(&blf_path)));
    }
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cargo test --manifest-path app/src-tauri/Cargo.toml explorer_saved_query_commands`
Expected: compile error.

- [ ] **Step 3: Implement**

```rust
#[tauri::command]
fn list_explorer_saved_queries(blf_path: String) -> Result<Vec<project_store::SavedExplorerQuery>, String> {
    let path = project_path_for(&blf_path);
    Ok(project_store::read_project(&path, &blf_path)?.explorer_saved_queries)
}

#[tauri::command]
fn save_explorer_query(blf_path: String, name: String, sql: String) -> Result<(), String> {
    let path = project_path_for(&blf_path);
    let project = project_store::read_project(&path, &blf_path)?;
    let entry = project_store::SavedExplorerQuery { name, sql, saved_at: now_ms() };
    project_store::write_project(&path, &project_store::save_explorer_query(project, entry))
}
```

Add both to `tauri::generate_handler![...]`:

```rust
            list_explorer_saved_queries,
            save_explorer_query,
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cargo test --manifest-path app/src-tauri/Cargo.toml explorer_saved_query_commands`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/src-tauri/src/main.rs
git commit -m "feat(tauri): add Explorer saved query commands"
```

---

### Task 11: Save button + saved list in `ExplorerPanel`

**Files:**
- Modify: `app/ui/src/shared/api/trace-source.ts`
- Modify: `app/ui/src/shared/api/hooks.ts`
- Modify: `app/ui/src/widgets/ExplorerPanel.tsx`

**Interfaces:**
- Consumes: Tauri commands from Task 10.

**Manual check:** run a query, click Save, type a name, confirm it appears in a Saved list; close/reopen the project; confirm it's still there; click it and confirm the SQL loads into the editor.

- [ ] **Step 1: Add types and data source methods**

In `trace-source.ts`:

```ts
export interface SavedExplorerQuery {
  name: string;
  sql: string;
  savedAt: number;
}
```

Add to `TraceDataSource`:

```ts
  listExplorerSavedQueries(blfPath: string): Promise<SavedExplorerQuery[]>;
  saveExplorerQuery(blfPath: string, name: string, sql: string): Promise<void>;
```

Add to `TauriTraceDataSource`:

```ts
  listExplorerSavedQueries(blfPath: string): Promise<SavedExplorerQuery[]> {
    return invoke<SavedExplorerQuery[]>("list_explorer_saved_queries", { blfPath });
  }

  saveExplorerQuery(blfPath: string, name: string, sql: string): Promise<void> {
    return invoke<void>("save_explorer_query", { blfPath, name, sql });
  }
```

- [ ] **Step 2: Add hooks**

In `hooks.ts`:

```ts
const EXPLORER_SAVED_QUERIES_KEY = (blfPath: string) => ["explorer-saved-queries", blfPath];

export function useExplorerSavedQueries(blfPath: string) {
  return useQuery({
    queryKey: EXPLORER_SAVED_QUERIES_KEY(blfPath),
    queryFn: () => getTraceDataSource().listExplorerSavedQueries(blfPath),
  });
}

export function useSaveExplorerQuery(blfPath: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ name, sql }: { name: string; sql: string }) =>
      getTraceDataSource().saveExplorerQuery(blfPath, name, sql),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: EXPLORER_SAVED_QUERIES_KEY(blfPath) }),
  });
}
```

- [ ] **Step 3: Add the Save button and saved list to `ExplorerPanel`**

Add imports:

```ts
import { useExplorerSavedQueries, useSaveExplorerQuery } from "@/shared/api/hooks";
import type { SavedExplorerQuery } from "@/shared/api/trace-source";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/shared/ui/dialog";
```

Add state and the mutation, plus a reusable name-prompt dialog:

```tsx
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
  }
```

Add the Save button next to Run:

```tsx
      <div className="flex shrink-0 items-center gap-2">
        <Button size="sm" onClick={run} disabled={mutation.isPending}>
          {mutation.isPending ? "Running..." : "Run"}
        </Button>
        <Button size="sm" variant="outline" onClick={openSaveDialog} disabled={!ranSql}>
          Save
        </Button>
      </div>
```

Add a Saved queries list (simple, always-visible panel under the editor/above the results, matching the rest of the page's plain layout):

```tsx
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
```

Add the name-prompt dialog near the end of the component's JSX:

```tsx
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
```

- [ ] **Step 4: Manual verification**

Run a query, Save it under a name, confirm it shows up as a chip; click it, confirm the SQL loads; relaunch the app and confirm it's still there.

- [ ] **Step 5: Commit**

```bash
git add app/ui/src/shared/api/trace-source.ts app/ui/src/shared/api/hooks.ts app/ui/src/widgets/ExplorerPanel.tsx
git commit -m "feat(ui): add Explorer saved queries"
```

---

## Wave 5: chart view (basic, no grouping)

### Task 12: `run_explorer_chart_query` (ungrouped path)

**Files:**
- Modify: `crates/query/src/lib.rs`

**Interfaces:**
- Produces: `pub struct ExplorerChartConfig { pub x: String, pub series_by: Option<String>, pub y: String }`, `pub struct ExplorerChartResult { pub rows: Vec<(String, Option<String>, f64)>, pub truncated: bool }`, `pub fn run_explorer_chart_query_ungrouped(conn: &trace_store::Connection, base_sql: &str, config: &ExplorerChartConfig, row_limit: i64) -> Result<ExplorerChartResult, String>` - consumed by Task 13. (Task 15 adds the grouped path as a second function behind the same Tauri command.)

- [ ] **Step 1: Write the failing tests**

```rust
    #[test]
    fn run_explorer_chart_query_ungrouped_returns_x_and_y_ordered_by_x() {
        let conn = explorer_fixture();
        let config = ExplorerChartConfig { x: "id".to_string(), series_by: None, y: "price".to_string() };
        let result =
            run_explorer_chart_query_ungrouped(&conn, "select * from widgets", &config, 100).unwrap();
        assert!(!result.truncated);
        assert_eq!(result.rows.len(), 5);
        assert_eq!(result.rows[0], ("1".to_string(), None, 1.5));
        assert_eq!(result.rows[4], ("5".to_string(), None, 5.5));
    }

    #[test]
    fn run_explorer_chart_query_ungrouped_includes_series_by_when_set() {
        let conn = explorer_fixture();
        let config =
            ExplorerChartConfig { x: "id".to_string(), series_by: Some("label".to_string()), y: "price".to_string() };
        let result =
            run_explorer_chart_query_ungrouped(&conn, "select * from widgets", &config, 100).unwrap();
        assert_eq!(result.rows[0].1, Some("a".to_string()));
    }

    #[test]
    fn run_explorer_chart_query_ungrouped_truncates_at_row_limit() {
        let conn = explorer_fixture();
        let config = ExplorerChartConfig { x: "id".to_string(), series_by: None, y: "price".to_string() };
        let result =
            run_explorer_chart_query_ungrouped(&conn, "select * from widgets", &config, 3).unwrap();
        assert!(result.truncated);
        assert_eq!(result.rows.len(), 3);
    }

    #[test]
    fn run_explorer_chart_query_ungrouped_rejects_a_y_column_that_does_not_exist() {
        let conn = explorer_fixture();
        let config = ExplorerChartConfig { x: "id".to_string(), series_by: None, y: "no_such_col".to_string() };
        assert!(run_explorer_chart_query_ungrouped(&conn, "select * from widgets", &config, 100).is_err());
    }
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cargo test --manifest-path crates/Cargo.toml -p query run_explorer_chart_query_ungrouped`
Expected: compile error.

- [ ] **Step 3: Implement**

```rust
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExplorerChartConfig {
    pub x: String,
    pub series_by: Option<String>,
    pub y: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExplorerChartResult {
    pub rows: Vec<(String, Option<String>, f64)>,
    pub truncated: bool,
}

/// Reshape/order/cap only - no `GROUP BY`. The wrapper always aliases its
/// output as `x`/`g`/`y` regardless of the user's column names, so callers
/// never have to infer which returned column is which
/// (`2026-11-26-trace-explorer-design.md`, Phase 2).
pub fn run_explorer_chart_query_ungrouped(
    conn: &trace_store::Connection,
    base_sql: &str,
    config: &ExplorerChartConfig,
    row_limit: i64,
) -> Result<ExplorerChartResult, String> {
    let trimmed = normalize_explorer_sql(base_sql)?;
    let series_select = match &config.series_by {
        Some(col) => format!("{} as g, ", quote_identifier(col)),
        None => String::new(),
    };
    let sql = format!(
        "select {} as x, {series_select}{} as y
         from ({trimmed}\n) as explorer_base
         order by x
         limit {}",
        quote_identifier(&config.x),
        quote_identifier(&config.y),
        row_limit + 1,
    );
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let has_series = config.series_by.is_some();
    let rows = stmt
        .query_map([], |row| {
            let x: String = row.get::<_, duckdb::types::Value>(0).map(value_to_display_string)?;
            let g: Option<String> = if has_series {
                Some(row.get::<_, duckdb::types::Value>(1).map(value_to_display_string)?)
            } else {
                None
            };
            let y: f64 = row.get(if has_series { 2 } else { 1 })?;
            Ok((x, g, y))
        })
        .map_err(|e| e.to_string())?;
    let mut rows = rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())?;
    let truncated = rows.len() as i64 > row_limit;
    if truncated {
        rows.truncate(row_limit as usize);
    }
    Ok(ExplorerChartResult { rows, truncated })
}

// shortcut: duckdb's `From<&Value> for ValueRef` panics on List/Struct/Map/
// Array/Union/Enum values. Chart X/Group-by columns are expected to be
// simple scalars (the picker is just "any column" from the result set);
// upgrade to a non-panicking match here if Explorer charts are ever used
// against a nested-type column and this proves to be a real problem.
fn value_to_display_string(v: duckdb::types::Value) -> String {
    value_ref_to_display_string((&v).into())
}
```

(`value_to_display_string` reuses Task 1's `value_ref_to_display_string` via `duckdb::types::ValueRef`'s `From<&Value>` conversion - no duplicate formatting logic.)

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cargo test --manifest-path crates/Cargo.toml -p query run_explorer_chart_query_ungrouped`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add crates/query/src/lib.rs
git commit -m "feat(query): add run_explorer_chart_query_ungrouped for Explorer's basic chart view"
```

---

### Task 13: `run_explorer_chart_query` Tauri command

**Files:**
- Modify: `app/src-tauri/src/main.rs`

**Interfaces:**
- Consumes: `query::{ExplorerChartConfig, ExplorerChartResult, run_explorer_chart_query_ungrouped}` (Task 12).
- Produces: Tauri command `run_explorer_chart_query(blf_path, base_sql, config, row_limit) -> Result<query::ExplorerChartResult, String>` - consumed by Task 14. (Task 16 extends this command's body with the grouped branch; the signature does not change.)

- [ ] **Step 1: Write the failing test**

Reuses the `fixture_trace_store` helper Task 2 added to this same test module:

```rust
    #[test]
    fn run_explorer_chart_query_reads_from_the_open_store() {
        let blf_path = fixture_trace_store("chart_query");
        let config = query::ExplorerChartConfig {
            x: "timestamp_us".to_string(),
            series_by: None,
            y: "timestamp_us".to_string(),
        };
        let result =
            run_explorer_chart_query(blf_path.clone(), "select * from messages".to_string(), config, 1000)
                .unwrap();
        assert!(!result.rows.is_empty());
        let _ = std::fs::remove_file(std::path::Path::new(&blf_path).with_extension("duckdb"));
    }
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cargo test --manifest-path app/src-tauri/Cargo.toml run_explorer_chart_query`
Expected: compile error.

- [ ] **Step 3: Implement**

```rust
#[tauri::command]
fn run_explorer_chart_query(
    blf_path: String,
    base_sql: String,
    config: query::ExplorerChartConfig,
    row_limit: i64,
) -> Result<query::ExplorerChartResult, String> {
    let duckdb_path = std::path::Path::new(&blf_path).with_extension("duckdb");
    let conn = trace_store::open(&duckdb_path)?;
    query::run_explorer_chart_query_ungrouped(&conn, &base_sql, &config, row_limit)
}
```

Add `run_explorer_chart_query,` to `tauri::generate_handler![...]`.

- [ ] **Step 4: Run the test to verify it passes**

Run: `cargo test --manifest-path app/src-tauri/Cargo.toml run_explorer_chart_query`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/src-tauri/src/main.rs
git commit -m "feat(tauri): expose run_explorer_chart_query command"
```

---

### Task 14: Chart view UI (Table/Chart toggle, X/Y pickers, basic bar/line)

**Files:**
- Modify: `app/ui/src/shared/api/trace-source.ts`
- Modify: `app/ui/src/shared/api/hooks.ts`
- Create: `app/ui/src/widgets/ExplorerChart.tsx`
- Modify: `app/ui/src/widgets/ExplorerPanel.tsx`

**Interfaces:**
- Consumes: Tauri command from Task 13, `getSignalColor`/`PALETTE` (`app/ui/src/app/signalColors.ts`).
- Produces: `ExplorerChart` component (`{ rows, seriesBy, vizType }` props) - consumed/extended by Task 16.

**Manual check:** run a query, switch the view toggle to Chart, pick an X and a numeric Y column, pick Bar or Line, click Apply, see a plotted chart with a hover tooltip.

- [ ] **Step 1: Add types and data source method**

In `trace-source.ts`:

```ts
export interface ExplorerChartConfig {
  x: string;
  seriesBy: string | null;
  y: string;
}

export interface ExplorerChartResult {
  rows: [string, string | null, number][];
  truncated: boolean;
}
```

Add to `TraceDataSource`:

```ts
  runExplorerChartQuery(
    blfPath: string,
    baseSql: string,
    config: ExplorerChartConfig,
    rowLimit: number
  ): Promise<ExplorerChartResult>;
```

Add to `TauriTraceDataSource`:

```ts
  runExplorerChartQuery(
    blfPath: string,
    baseSql: string,
    config: ExplorerChartConfig,
    rowLimit: number
  ): Promise<ExplorerChartResult> {
    return invoke<ExplorerChartResult>("run_explorer_chart_query", {
      blfPath,
      baseSql,
      config: { x: config.x, seriesBy: config.seriesBy, y: config.y },
      rowLimit,
    });
  }
```

- [ ] **Step 2: Add the hook**

In `hooks.ts`:

```ts
export function useRunExplorerChartQuery(blfPath: string) {
  return useMutation({
    mutationKey: ["run-explorer-chart-query", blfPath],
    mutationFn: ({
      baseSql,
      config,
      rowLimit,
    }: {
      baseSql: string;
      config: ExplorerChartConfig;
      rowLimit: number;
    }) => getTraceDataSource().runExplorerChartQuery(blfPath, baseSql, config, rowLimit),
  });
}
```

(Add `ExplorerChartConfig` to the existing `import type { ... } from "@/shared/api/trace-source"` line at the top of `hooks.ts`.)

- [ ] **Step 3: Write `ExplorerChart`**

Create `app/ui/src/widgets/ExplorerChart.tsx` - same raw-echarts-instance pattern as `TimelineChart.tsx` (`echarts.init`/`.dispose()` in a `useEffect`, no `echarts-for-react`), but standalone (no `CHART_GROUP` zoom sync - Explorer charts aren't part of the Timeline's synced group):

```tsx
import { useEffect, useRef } from "react";
import * as echarts from "echarts";
import { getSignalColor } from "@/app/signalColors";
import type { ExplorerChartResult } from "@/shared/api/trace-source";

interface ExplorerChartProps {
  result: ExplorerChartResult;
  vizType: "bar" | "line";
  hasSeries: boolean;
}

export default function ExplorerChart({ result, vizType, hasSeries }: ExplorerChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<echarts.ECharts | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;
    const chart = echarts.init(containerRef.current, undefined, { renderer: "canvas" });
    chartRef.current = chart;
    const resize = () => chart.resize();
    const ro = new ResizeObserver(resize);
    ro.observe(containerRef.current);
    return () => {
      ro.disconnect();
      chart.dispose();
      chartRef.current = null;
    };
  }, []);

  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;

    const seriesNames = hasSeries
      ? Array.from(new Set(result.rows.map((r) => r[1] ?? "")))
      : ["y"];
    const xCategories = Array.from(new Set(result.rows.map((r) => r[0])));

    const series = seriesNames.map((name, i) => ({
      name,
      type: vizType,
      // 2px lines / rounded bar ends per the dataviz skill's fixed mark specs -
      // not user-configurable (2026-11-26-trace-explorer-design.md, Phase 2).
      lineStyle: vizType === "line" ? { width: 2 } : undefined,
      itemStyle: { color: getSignalColor(i), borderRadius: vizType === "bar" ? [4, 4, 0, 0] : undefined },
      symbolSize: 8,
      data: xCategories.map((x) => {
        const row = result.rows.find((r) => r[0] === x && (!hasSeries || (r[1] ?? "") === name));
        return row ? row[2] : null;
      }),
    }));

    chart.setOption({
      xAxis: { type: "category", data: xCategories },
      yAxis: { type: "value" },
      legend: hasSeries && seriesNames.length >= 2 ? { data: seriesNames } : undefined,
      tooltip: { trigger: "axis", axisPointer: { type: vizType === "line" ? "cross" : "shadow" } },
      series,
    });
  }, [result, vizType, hasSeries]);

  return <div ref={containerRef} style={{ width: "100%", height: "100%" }} />;
}
```

- [ ] **Step 4: Wire a Table/Chart toggle and config panel into `ExplorerPanel`**

Add imports:

```ts
import { useRunExplorerChartQuery } from "@/shared/api/hooks";
import type { ExplorerChartResult } from "@/shared/api/trace-source";
import ExplorerChart from "./ExplorerChart";
```

Add state and the Apply handler:

```tsx
  const [viewMode, setViewMode] = useState<"table" | "chart">("table");
  const [chartX, setChartX] = useState<string | null>(null);
  const [chartY, setChartY] = useState<string | null>(null);
  const [vizType, setVizType] = useState<"bar" | "line">("line");
  const [chartResult, setChartResult] = useState<ExplorerChartResult | null>(null);
  const chartMutation = useRunExplorerChartQuery(blfPath);

  function applyChart() {
    if (!ranSql || !chartX || !chartY) return;
    chartMutation.mutate(
      { baseSql: ranSql, config: { x: chartX, seriesBy: null, y: chartY }, rowLimit: 5000 },
      { onSuccess: setChartResult }
    );
  }
```

Add the view toggle next to the Run/Save buttons:

```tsx
        {page && (
          <div className="flex items-center gap-1 rounded border border-border p-0.5">
            <button
              type="button"
              className={`rounded px-2 py-0.5 text-xs ${viewMode === "table" ? "bg-muted" : ""}`}
              onClick={() => setViewMode("table")}
            >
              Table
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
```

Add the chart config panel + canvas, shown instead of the results table when `viewMode === "chart"` (replace the existing `{page && (<table>...)}` block's wrapper so it only renders in table mode, and add this alongside it):

```tsx
      {page && viewMode === "chart" && (
        <div className="flex min-h-0 flex-1 flex-col gap-2">
          <div className="flex shrink-0 flex-wrap items-center gap-2 text-xs">
            <label className="flex items-center gap-1">
              Chart type
              <select
                className="rounded border border-border bg-background px-1 py-0.5"
                value={vizType}
                onChange={(e) => setVizType(e.target.value as "bar" | "line")}
              >
                <option value="bar">Bar</option>
                <option value="line">Line</option>
              </select>
            </label>
            <label className="flex items-center gap-1">
              X
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
            <label className="flex items-center gap-1">
              Y
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
            <Button size="sm" onClick={applyChart} disabled={!chartX || !chartY || chartMutation.isPending}>
              Apply
            </Button>
            {chartResult?.truncated && (
              <span className="text-muted-foreground">(showing first {chartResult.rows.length})</span>
            )}
          </div>
          <div className="min-h-0 flex-1 rounded border border-border">
            {chartResult && <ExplorerChart result={chartResult} vizType={vizType} hasSeries={false} />}
          </div>
        </div>
      )}
```

- [ ] **Step 5: Manual verification**

Run `select msg_id, timestamp_us from messages limit 500`, switch to Chart, pick X = `timestamp_us`, Y = `msg_id`, Line, Apply - confirm a line renders with a hover tooltip. Switch to Bar - confirm it re-renders as bars.

- [ ] **Step 6: Commit**

```bash
git add app/ui/src/shared/api/trace-source.ts app/ui/src/shared/api/hooks.ts app/ui/src/widgets/ExplorerChart.tsx app/ui/src/widgets/ExplorerPanel.tsx
git commit -m "feat(ui): add Explorer basic chart view (bar/line, no grouping)"
```

---

## Wave 6: chart grouping

### Task 15: Grouped path in `run_explorer_chart_query`

**Files:**
- Modify: `crates/query/src/lib.rs`
- Modify: `app/src-tauri/src/main.rs`

**Interfaces:**
- Consumes: `ExplorerChartResult` (Task 12).
- Produces: `pub struct ExplorerChartMetric { pub agg: String, pub column: Option<String> }` (`agg` one of `"count" | "sum" | "avg" | "min" | "max"`), `pub fn run_explorer_chart_query_grouped(conn, base_sql, config: &ExplorerChartConfig, metric: &ExplorerChartMetric, row_limit: i64) -> Result<ExplorerChartResult, String>`; extends the `run_explorer_chart_query` Tauri command to dispatch to this function when a metric is supplied.

- [ ] **Step 1: Write the failing tests**

```rust
    #[test]
    fn run_explorer_chart_query_grouped_counts_rows_per_x() {
        let conn = explorer_fixture();
        conn.execute("INSERT INTO widgets VALUES (6, 'a', 6.5)", []).unwrap();
        let config = ExplorerChartConfig { x: "label".to_string(), series_by: None, y: String::new() };
        let metric = ExplorerChartMetric { agg: "count".to_string(), column: None };
        let result =
            run_explorer_chart_query_grouped(&conn, "select * from widgets", &config, &metric, 100).unwrap();
        let a = result.rows.iter().find(|r| r.0 == "a").unwrap();
        assert_eq!(a.2, 2.0, "two widgets labeled 'a'");
    }

    #[test]
    fn run_explorer_chart_query_grouped_sums_a_metric_column() {
        let conn = explorer_fixture();
        let config = ExplorerChartConfig { x: "label".to_string(), series_by: None, y: String::new() };
        let metric = ExplorerChartMetric { agg: "sum".to_string(), column: Some("price".to_string()) };
        let result =
            run_explorer_chart_query_grouped(&conn, "select * from widgets", &config, &metric, 100).unwrap();
        let a = result.rows.iter().find(|r| r.0 == "a").unwrap();
        assert_eq!(a.2, 1.5);
    }

    #[test]
    fn run_explorer_chart_query_grouped_rejects_an_unknown_aggregate() {
        let conn = explorer_fixture();
        let config = ExplorerChartConfig { x: "label".to_string(), series_by: None, y: String::new() };
        let metric = ExplorerChartMetric { agg: "median".to_string(), column: Some("price".to_string()) };
        assert!(
            run_explorer_chart_query_grouped(&conn, "select * from widgets", &config, &metric, 100).is_err()
        );
    }

    #[test]
    fn run_explorer_chart_query_grouped_groups_by_series_too_when_set() {
        let conn = explorer_fixture();
        let config =
            ExplorerChartConfig { x: "id".to_string(), series_by: Some("label".to_string()), y: String::new() };
        let metric = ExplorerChartMetric { agg: "count".to_string(), column: None };
        let result =
            run_explorer_chart_query_grouped(&conn, "select * from widgets", &config, &metric, 100).unwrap();
        assert_eq!(result.rows.len(), 5, "one group per distinct (id, label) pair");
    }
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cargo test --manifest-path crates/Cargo.toml -p query run_explorer_chart_query_grouped`
Expected: compile error.

- [ ] **Step 3: Implement**

```rust
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExplorerChartMetric {
    pub agg: String,
    pub column: Option<String>,
}

/// `agg` is matched against a fixed allow-list, never interpolated as
/// arbitrary SQL - an unrecognized aggregate is a clean error, not a chance
/// to inject a function call.
fn aggregate_sql(metric: &ExplorerChartMetric) -> Result<String, String> {
    let column_expr = match &metric.column {
        Some(col) => quote_identifier(col),
        None => "*".to_string(),
    };
    match metric.agg.as_str() {
        "count" => Ok("count(*)".to_string()),
        "sum" => Ok(format!("sum({column_expr})")),
        "avg" => Ok(format!("avg({column_expr})")),
        "min" => Ok(format!("min({column_expr})")),
        "max" => Ok(format!("max({column_expr})")),
        other => Err(format!("unknown aggregate: {other}")),
    }
}

/// Only reached when the Explorer's "Group results" toggle is on - a plain
/// line/bar plot of two existing columns never takes this path
/// (`2026-11-26-trace-explorer-design.md`, Phase 2).
pub fn run_explorer_chart_query_grouped(
    conn: &trace_store::Connection,
    base_sql: &str,
    config: &ExplorerChartConfig,
    metric: &ExplorerChartMetric,
    row_limit: i64,
) -> Result<ExplorerChartResult, String> {
    let trimmed = normalize_explorer_sql(base_sql)?;
    let agg_sql = aggregate_sql(metric)?;
    let group_cols = quote_identifier(&config.x);
    let (series_select, group_by) = match &config.series_by {
        Some(col) => (format!("{} as g, ", quote_identifier(col)), format!("{group_cols}, {}", quote_identifier(col))),
        None => (String::new(), group_cols.clone()),
    };
    let sql = format!(
        "select {group_cols} as x, {series_select}{agg_sql} as y
         from ({trimmed}\n) as explorer_base
         group by {group_by}
         order by x
         limit {}",
        row_limit + 1,
    );
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let has_series = config.series_by.is_some();
    let rows = stmt
        .query_map([], |row| {
            let x: String = row.get::<_, duckdb::types::Value>(0).map(value_to_display_string)?;
            let g: Option<String> = if has_series {
                Some(row.get::<_, duckdb::types::Value>(1).map(value_to_display_string)?)
            } else {
                None
            };
            let y: f64 = row.get(if has_series { 2 } else { 1 })?;
            Ok((x, g, y))
        })
        .map_err(|e| e.to_string())?;
    let mut rows = rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())?;
    let truncated = rows.len() as i64 > row_limit;
    if truncated {
        rows.truncate(row_limit as usize);
    }
    Ok(ExplorerChartResult { rows, truncated })
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cargo test --manifest-path crates/Cargo.toml -p query run_explorer_chart_query_grouped`
Expected: PASS.

- [ ] **Step 5: Extend the Tauri command**

In `app/src-tauri/src/main.rs`, change `run_explorer_chart_query`'s signature and body to accept an optional metric and dispatch:

```rust
#[tauri::command]
fn run_explorer_chart_query(
    blf_path: String,
    base_sql: String,
    config: query::ExplorerChartConfig,
    metric: Option<query::ExplorerChartMetric>,
    row_limit: i64,
) -> Result<query::ExplorerChartResult, String> {
    let duckdb_path = std::path::Path::new(&blf_path).with_extension("duckdb");
    let conn = trace_store::open(&duckdb_path)?;
    match metric {
        Some(m) => query::run_explorer_chart_query_grouped(&conn, &base_sql, &config, &m, row_limit),
        None => query::run_explorer_chart_query_ungrouped(&conn, &base_sql, &config, row_limit),
    }
}
```

Update Task 13's test (`run_explorer_chart_query_reads_from_the_open_store`) to pass `None` for the new `metric` argument - its `run_explorer_chart_query(...)` call becomes `run_explorer_chart_query(blf_path.clone(), "select * from messages".to_string(), config, None, 1000)`.

- [ ] **Step 6: Run all `app/src-tauri` tests to verify nothing broke**

Run: `cargo test --manifest-path app/src-tauri/Cargo.toml`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add crates/query/src/lib.rs app/src-tauri/src/main.rs
git commit -m "feat(query,tauri): add Explorer chart grouping/aggregate path"
```

---

### Task 16: "Group results" UI

**Files:**
- Modify: `app/ui/src/shared/api/trace-source.ts`
- Modify: `app/ui/src/shared/api/hooks.ts`
- Modify: `app/ui/src/widgets/ExplorerPanel.tsx`

**Interfaces:**
- Consumes: the extended `run_explorer_chart_query` command (Task 15).

**Manual check:** with grouping off, chart behaves exactly as in Task 14. Toggle "Group results" on, pick a Group by column and Count (or Sum/Avg/Min/Max + an "of" column), click Apply, confirm the chart now shows one bar/point per group with the right aggregated values, and a legend appears once a Group by column that produces 2+ series is also used.

- [ ] **Step 1: Extend the chart types and data source method**

In `trace-source.ts`, extend `ExplorerChartConfig`'s companion call and add a metric type:

```ts
export interface ExplorerChartMetric {
  agg: "count" | "sum" | "avg" | "min" | "max";
  column: string | null;
}
```

Change `runExplorerChartQuery`'s signature in both `TraceDataSource` and `TauriTraceDataSource` to take an optional metric:

```ts
  runExplorerChartQuery(
    blfPath: string,
    baseSql: string,
    config: ExplorerChartConfig,
    metric: ExplorerChartMetric | null,
    rowLimit: number
  ): Promise<ExplorerChartResult>;
```

```ts
  runExplorerChartQuery(
    blfPath: string,
    baseSql: string,
    config: ExplorerChartConfig,
    metric: ExplorerChartMetric | null,
    rowLimit: number
  ): Promise<ExplorerChartResult> {
    return invoke<ExplorerChartResult>("run_explorer_chart_query", {
      blfPath,
      baseSql,
      config: { x: config.x, seriesBy: config.seriesBy, y: config.y },
      metric,
      rowLimit,
    });
  }
```

- [ ] **Step 2: Update the hook**

In `hooks.ts`, add `metric: ExplorerChartMetric | null` to `useRunExplorerChartQuery`'s mutation variables and pass it through:

```ts
export function useRunExplorerChartQuery(blfPath: string) {
  return useMutation({
    mutationKey: ["run-explorer-chart-query", blfPath],
    mutationFn: ({
      baseSql,
      config,
      metric,
      rowLimit,
    }: {
      baseSql: string;
      config: ExplorerChartConfig;
      metric: ExplorerChartMetric | null;
      rowLimit: number;
    }) => getTraceDataSource().runExplorerChartQuery(blfPath, baseSql, config, metric, rowLimit),
  });
}
```

- [ ] **Step 3: Add the grouping controls to `ExplorerPanel`**

Add state:

```tsx
  const [seriesBy, setSeriesBy] = useState<string | null>(null);
  const [grouped, setGrouped] = useState(false);
  const [aggFn, setAggFn] = useState<"count" | "sum" | "avg" | "min" | "max">("count");
  const [aggColumn, setAggColumn] = useState<string | null>(null);
```

Replace `applyChart`:

```tsx
  function applyChart() {
    if (!ranSql || !chartX) return;
    const config = { x: chartX, seriesBy, y: grouped ? "" : (chartY ?? "") };
    const metric = grouped ? { agg: aggFn, column: aggFn === "count" ? null : aggColumn } : null;
    if (!grouped && !chartY) return;
    if (grouped && aggFn !== "count" && !aggColumn) return;
    chartMutation.mutate({ baseSql: ranSql, config, metric, rowLimit: 5000 }, { onSuccess: setChartResult });
  }
```

Add the "Group by" picker, the "Group results" checkbox, and the conditional Y-vs-Aggregate controls to the chart config panel built in Task 14 (insert after the X picker, replacing the plain Y picker with this conditional block):

```tsx
            <label className="flex items-center gap-1">
              Group by (optional)
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
            <label className="flex items-center gap-1">
              <input type="checkbox" checked={grouped} onChange={(e) => setGrouped(e.target.checked)} />
              Group results
            </label>
            {!grouped ? (
              <label className="flex items-center gap-1">
                Y
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
                <label className="flex items-center gap-1">
                  Aggregate
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
                  <label className="flex items-center gap-1">
                    of
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
```

Remove the now-duplicated plain Y picker that Task 14 placed directly in the panel (it's superseded by the conditional block above).

Pass `hasSeries={seriesBy !== null}` to `<ExplorerChart ... />` instead of the hardcoded `false` from Task 14.

- [ ] **Step 4: Manual verification**

Query `select * from messages`, Group by a low-cardinality column (e.g. `object_type` if present, or any discrete column in your fixture trace), check "Group results", pick Count, Apply - confirm one bar per distinct value. Switch Aggregate to Sum of a numeric column and confirm the values change accordingly. Add a different "Group by" column too and confirm a legend with 2+ entries appears.

- [ ] **Step 5: Commit**

```bash
git add app/ui/src/shared/api/trace-source.ts app/ui/src/shared/api/hooks.ts app/ui/src/widgets/ExplorerPanel.tsx
git commit -m "feat(ui): add Explorer chart grouping (group by + aggregate)"
```

---

## Self-Review Notes

- **Spec coverage:** every numbered item in the design doc's Phase 1 (table page command, pagination, sort, history, saved queries) and Phase 2 (chart config, ungrouped/grouped SQL shapes, Apply-only fetch, fixed mark specs, color/legend rules) maps to a task above. The "Explicitly out of scope" list (view-loading picker, trim-window scoping, multi-cell notebook, ad hoc filter UI, forked BI platform) has no corresponding task, by design.
- **Type consistency:** `ExplorerColumn`/`ExplorerTablePage` (Task 1) are reused unchanged by Tasks 2-5; `ExplorerChartConfig`/`ExplorerChartResult` (Task 12) are reused unchanged by Tasks 13-16, with Task 15/16 only adding the new `ExplorerChartMetric` type and an additional `Option` parameter, never renaming an existing field.
- **Review Focus:** all five items in the header's Review Focus list have an owning task and test, listed above (Task 1 x3, Task 6, Task 11).
