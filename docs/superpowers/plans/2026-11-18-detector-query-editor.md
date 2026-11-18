# Detector Query Editor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the Analyzer panel a Detector Query editor - the user types SQL, runs it against the Trace Store, and matching rows plot as points (Matches) on a new lane in the Timeline.

**Architecture:** `crates/query` gains one new function that wraps the user's SQL in a `SELECT msg_id, timestamp_us FROM (<user sql>) LIMIT <cap+1>` subquery (reuses DuckDB's own binder error for "missing column," caps result size without a separate COUNT). A thin Tauri command exposes it. The frontend adds one mutation hook, extends the existing `useWorkspaceStore` with the query text/result/error, rewrites `AnalyzerPanel` from its stub into the editor, and adds a new `MatchLane` widget joined to `TimelinePanel`'s existing `CHART_GROUP` echarts sync.

**Tech Stack:** Rust (`duckdb` crate, read-only `Connection`), React + TypeScript, `echarts`, `zustand`, `@tanstack/react-query`.

**Spec:** This plan's spec is the conversation that produced it (grilling + domain-modeling session on 2026-11-18, captured in `CONTEXT.md`'s **Detector Query** / **Analyzer** / **Match** entries). Key decisions, verbatim from that session:

- Result row shape: exact columns `msg_id` and `timestamp_us` required, no alias inference. Missing column surfaces inline in the Analyzer (not a toast).
- Plain `<textarea>` editor, no code-editor dependency. Run button + Cmd/Ctrl+Enter.
- Single SQL statement only - reject client-side on any `;` before the (optional) trailing one, before calling the backend at all.
- Row cap: 200,000 (same order as `TIMELINE_SAMPLE_LIMIT`), via `LIMIT 200001` appended server-side (no separate `COUNT(*)`); if 200,001 rows return, report truncation with an inline note.
- Scatter rendering uses `large: true` (echarts' batching mode), same strategy `SignalChart` already uses for 200k-point lines.
- One active Detector Query at a time, replaced on every run - no save/history/multi-query UI this iteration.
- Matches render in a dedicated lane in `TimelinePanel`, pinned above the signal-chart stack, hidden until a Detector Query has run at least once (mirrors `SignalPills`' "nothing to show yet" convention) - independent of which signals are pinned.
- The lane joins the existing `CHART_GROUP` so pan/zoom stays in sync with `SignalChart` and `TimelineZoomControl`.
- Hovering a Match tooltips its `msg_id` + timestamp; clicking one calls the existing `setSelectedMessage` action (same path `MessageList` row-selection already uses).
- No results table in the Analyzer - the timeline lane is the only place Matches render this iteration.

## Global Constraints

- Backend: the Trace Store connection (`trace_store::open`) is always read-only - no new SQL-injection surface, DDL/DML already rejected at the DB layer. Do not add extra statement-type validation on top of that.
- Backend function signatures take the row cap as an explicit parameter (`limit: i64`), matching the existing `list_messages`/`list_signal_samples` convention - don't hardcode the cap inside the function, so tests can use a small cap.
- Frontend: no new dependency (no CodeMirror/Monaco). No automated frontend tests this wave, matching every prior Wave 3 task in this project - verify frontend changes with `npm run build --prefix app/ui` only. Rust changes are TDD: write the failing test first.
- Naming throughout code and UI copy uses "Detector Query" (editor, run action, result), not "analyzer query" - see `CONTEXT.md`.
- `cargo fmt --manifest-path crates/Cargo.toml` and `cargo fmt --manifest-path app/src-tauri/Cargo.toml` after each Rust change, per `AGENTS.md`.

## Review Focus

- **Empty query**: user clicks Run with an empty/whitespace-only textarea - must not reach the backend with an empty SQL string (DuckDB would error unhelpfully on `SELECT msg_id, timestamp_us FROM () ...`). Task 1's tests cover this directly in `run_detector_query`.
- **Query matching zero rows**: a syntactically valid Detector Query that matches nothing - must still flip `detectorQueryHasRun` to `true` (so the lane shows an empty-but-present strip, not stay hidden as if nothing ran) and must not be treated as an error. Covered in Task 5's success-path wiring.
- **Re-running while a previous result is displayed**: running a second Detector Query must fully replace the prior `matches`/`truncated`/`error`, not merge or leave stale points on the lane from the first run. Covered by Task 5's success/error handlers always overwriting, never merging, and Task 1's test confirms the function itself has no state across calls (it's a pure query, no accumulation).
- **Multi-statement SQL with a comment containing a semicolon**: a query like `SELECT msg_id, timestamp_us FROM messages -- a; b` must not be falsely rejected by the client-side single-statement guard, since the `;` is inside a comment, not a second statement. The guard's exact string-scan behavior is specified precisely in Task 5 and the task notes this known limitation rather than silently "fixing" it with a SQL-comment-aware parser (out of scope: writing a SQL tokenizer for a guard that's a cheap pre-check, not the source of truth - DuckDB's own parser is the real backend-side guard against anything this misses).
- **Clicking a Match while no message is currently selected vs. switching away from the Analyzer tab**: clicking a Match must select that `msg_id` via the exact same `setSelectedMessage` action `MessageList` uses, so `MessageDetails` updates regardless of which left-rail tab is active. Covered in Task 6 by reusing the existing store action directly (no new selection mechanism to diverge).

---

## File Structure

| File | Responsibility |
|---|---|
| `crates/query/src/lib.rs` | Add `DetectorMatch`, `DetectorQueryResult`, `DETECTOR_QUERY_MATCH_LIMIT`, `run_detector_query` |
| `app/src-tauri/src/main.rs` | Add `run_detector_query` Tauri command, register it |
| `app/ui/src/shared/api/trace-source.ts` | Add `DetectorMatch`, `DetectorQueryResult` types, `TraceDataSource.runDetectorQuery`, `TauriTraceDataSource` impl |
| `app/ui/src/shared/api/hooks.ts` | Add `useRunDetectorQuery` mutation hook, `DETECTOR_QUERY_MATCH_LIMIT` frontend constant |
| `app/ui/src/app/store.ts` | Add Detector Query text/result/error/hasRun state + actions |
| `app/ui/src/App.tsx` | Call the new `resetDetectorQuery` action at the three points `blfPath` changes |
| `app/ui/src/widgets/AnalyzerPanel.tsx` | Rewrite: textarea editor, Run button, Cmd/Ctrl+Enter, client-side guard, inline status/error |
| `app/ui/src/widgets/WorkspaceLayout.tsx` | Pass `blfPath` into `AnalyzerPanel` |
| `app/ui/src/widgets/MatchLane.tsx` | New: echarts scatter lane, `CHART_GROUP` member, click-to-select |
| `app/ui/src/widgets/TimelinePanel.tsx` | Render `MatchLane` above the signal-chart stack when `detectorQueryHasRun` |

---

### Task 1: `crates/query` - `run_detector_query`

**Files:**
- Modify: `crates/query/src/lib.rs`

**Interfaces:**
- Produces: `pub struct DetectorMatch { pub msg_id: i64, pub timestamp_us: i64 }` (serde `camelCase`), `pub struct DetectorQueryResult { pub matches: Vec<DetectorMatch>, pub truncated: bool }` (serde `camelCase`), `pub const DETECTOR_QUERY_MATCH_LIMIT: i64 = 200_000;`, `pub fn run_detector_query(conn: &trace_store::Connection, sql: &str, limit: i64) -> Result<DetectorQueryResult, String>`.

- [ ] **Step 1: Write the failing tests**

Add to the `#[cfg(test)] mod tests` block in `crates/query/src/lib.rs` (reuses the existing `setup()` fixture, which already has a `messages` table with 4 rows: msg_id 1-4):

```rust
#[test]
fn run_detector_query_returns_matching_rows() {
    let conn = setup();
    let result = run_detector_query(
        &conn,
        "select msg_id, timestamp_us from messages where arb_id = 100",
        10,
    )
    .unwrap();
    assert_eq!(result.matches.len(), 2);
    assert_eq!(result.matches[0].msg_id, 1);
    assert_eq!(result.matches[0].timestamp_us, 1000);
    assert!(!result.truncated);
}

#[test]
fn run_detector_query_truncates_at_limit_and_reports_it() {
    let conn = setup();
    let result = run_detector_query(&conn, "select msg_id, timestamp_us from messages", 2).unwrap();
    assert_eq!(result.matches.len(), 2, "capped to the limit, not the full 4 rows");
    assert!(result.truncated);
}

#[test]
fn run_detector_query_does_not_truncate_when_exactly_at_limit() {
    let conn = setup();
    let result = run_detector_query(&conn, "select msg_id, timestamp_us from messages", 4).unwrap();
    assert_eq!(result.matches.len(), 4);
    assert!(!result.truncated, "exactly `limit` rows is not truncation");
}

#[test]
fn run_detector_query_errors_when_msg_id_column_missing() {
    let conn = setup();
    let err = run_detector_query(&conn, "select timestamp_us from messages", 10).unwrap_err();
    assert!(
        err.to_lowercase().contains("msg_id"),
        "error should mention the missing column, got: {err}"
    );
}

#[test]
fn run_detector_query_errors_when_timestamp_us_column_missing() {
    let conn = setup();
    let err = run_detector_query(&conn, "select msg_id from messages", 10).unwrap_err();
    assert!(
        err.to_lowercase().contains("timestamp_us"),
        "error should mention the missing column, got: {err}"
    );
}

#[test]
fn run_detector_query_errors_on_empty_sql() {
    let conn = setup();
    assert!(run_detector_query(&conn, "   ", 10).is_err());
}

#[test]
fn run_detector_query_strips_one_trailing_semicolon() {
    let conn = setup();
    let result = run_detector_query(&conn, "select msg_id, timestamp_us from messages where arb_id = 100;", 10).unwrap();
    assert_eq!(result.matches.len(), 2);
}

#[test]
fn run_detector_query_surfaces_bad_sql_errors() {
    let conn = setup();
    assert!(run_detector_query(&conn, "select * from no_such_table", 10).is_err());
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test --manifest-path crates/Cargo.toml -p query run_detector_query`
Expected: FAIL with "cannot find function `run_detector_query`" (or similar compile error) - the function doesn't exist yet.

- [ ] **Step 3: Write the implementation**

Add above the `#[cfg(test)]` block in `crates/query/src/lib.rs`:

```rust
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DetectorMatch {
    pub msg_id: i64,
    pub timestamp_us: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DetectorQueryResult {
    pub matches: Vec<DetectorMatch>,
    pub truncated: bool,
}

/// Default Match cap for the Analyzer's Detector Query editor - same order of
/// magnitude as `TIMELINE_SAMPLE_LIMIT` on the frontend (both already proven
/// at this scale via `large: true` echarts rendering).
pub const DETECTOR_QUERY_MATCH_LIMIT: i64 = 200_000;

/// Runs a user-authored Detector Query and extracts just `msg_id` /
/// `timestamp_us` from its result, for plotting as Matches on the Timeline.
/// The query is run read-only (the connection itself is opened read-only) and
/// wrapped as a subquery rather than string-validated, so DuckDB's own
/// binder error - not custom validation code - is what reports a missing
/// required column.
pub fn run_detector_query(
    conn: &trace_store::Connection,
    sql: &str,
    limit: i64,
) -> Result<DetectorQueryResult, String> {
    let trimmed = sql.trim();
    let trimmed = trimmed.strip_suffix(';').unwrap_or(trimmed).trim();
    if trimmed.is_empty() {
        return Err("query is empty".to_string());
    }
    let wrapped = format!(
        "select msg_id, timestamp_us from ({trimmed}) as detector_query_result limit {}",
        limit + 1
    );
    let mut stmt = conn.prepare(&wrapped).map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |row| {
            Ok(DetectorMatch {
                msg_id: row.get(0)?,
                timestamp_us: row.get(1)?,
            })
        })
        .map_err(|e| e.to_string())?;
    let mut matches = rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())?;
    let truncated = matches.len() as i64 > limit;
    if truncated {
        matches.truncate(limit as usize);
    }
    Ok(DetectorQueryResult { matches, truncated })
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test --manifest-path crates/Cargo.toml -p query`
Expected: PASS, all tests including the new ones (full suite, not just the new filter, to confirm no regression).

- [ ] **Step 5: Format and commit**

```bash
cargo fmt --manifest-path crates/Cargo.toml
git add crates/query/src/lib.rs
git commit -m "feat(query): add run_detector_query for the Analyzer's Detector Query editor"
```

---

### Task 2: Tauri command wiring

**Files:**
- Modify: `app/src-tauri/src/main.rs`

**Interfaces:**
- Consumes: `query::run_detector_query(conn, sql, limit)`, `query::DetectorQueryResult`, `query::DETECTOR_QUERY_MATCH_LIMIT` (Task 1).
- Produces: `#[tauri::command] fn run_detector_query(blf_path: String, sql: String) -> Result<query::DetectorQueryResult, String>`, registered in `invoke_handler`.

- [ ] **Step 1: Add the command**

In `app/src-tauri/src/main.rs`, directly below the existing `list_ecus` command:

```rust
#[tauri::command]
fn run_detector_query(blf_path: String, sql: String) -> Result<query::DetectorQueryResult, String> {
    let duckdb_path = std::path::Path::new(&blf_path).with_extension("duckdb");
    let conn = trace_store::open(&duckdb_path)?;
    query::run_detector_query(&conn, &sql, query::DETECTOR_QUERY_MATCH_LIMIT)
}
```

- [ ] **Step 2: Register it**

In the `tauri::generate_handler!` list in `fn main()`, add `run_detector_query` after `list_ecus`:

```rust
            list_ecus,
            run_detector_query,
            get_file_sizes,
```

- [ ] **Step 3: Verify the build and existing suite**

Run: `cargo build --manifest-path app/src-tauri/Cargo.toml && cargo test --manifest-path app/src-tauri/Cargo.toml`
Expected: both succeed, no new tests needed here - this command is a thin wrapper over the already-tested `query::run_detector_query` (same precedent as the other five thin command wrappers in this file, none of which have their own dedicated tests).

- [ ] **Step 4: Format and commit**

```bash
cargo fmt --manifest-path app/src-tauri/Cargo.toml
git add app/src-tauri/src/main.rs
git commit -m "feat(tauri): expose run_detector_query as a command"
```

---

### Task 3: Frontend data-source layer

**Files:**
- Modify: `app/ui/src/shared/api/trace-source.ts`
- Modify: `app/ui/src/shared/api/hooks.ts`

**Interfaces:**
- Consumes: Tauri command `run_detector_query` (Task 2).
- Produces: `interface DetectorMatch { msgId: number; timestampUs: number }`, `interface DetectorQueryResult { matches: DetectorMatch[]; truncated: boolean }`, `TraceDataSource.runDetectorQuery(blfPath: string, sql: string): Promise<DetectorQueryResult>`, `useRunDetectorQuery(blfPath: string)` (a `useMutation` returning `{ mutate, isPending, ... }` where `mutate` takes `sql: string`), `DETECTOR_QUERY_MATCH_LIMIT = 200_000` (exported constant, mirrors the Rust-side value - duplicated the same way `CAN_OBJECT_TYPES` already is across the C++/Rust boundary, since there's no shared-constants mechanism across the IPC boundary).

- [ ] **Step 1: Add types and the data-source method**

In `app/ui/src/shared/api/trace-source.ts`, add near `SignalCatalogEntry`:

```typescript
export interface DetectorMatch {
  msgId: number;
  timestampUs: number;
}

export interface DetectorQueryResult {
  matches: DetectorMatch[];
  truncated: boolean;
}
```

Add to the `TraceDataSource` interface:

```typescript
  runDetectorQuery(blfPath: string, sql: string): Promise<DetectorQueryResult>;
```

Add to `TauriTraceDataSource`:

```typescript
  runDetectorQuery(blfPath: string, sql: string): Promise<DetectorQueryResult> {
    return invoke<DetectorQueryResult>("run_detector_query", { blfPath, sql });
  }
```

- [ ] **Step 2: Add the mutation hook**

In `app/ui/src/shared/api/hooks.ts`, add near `useDecodeSignals` (no `onError` toast push here - see Task 5 for why Detector Query errors render inline instead):

```typescript
// Same order of magnitude as TIMELINE_SAMPLE_LIMIT - duplicated from the
// Rust-side query::DETECTOR_QUERY_MATCH_LIMIT because there's no
// shared-constant mechanism across the Tauri IPC boundary.
export const DETECTOR_QUERY_MATCH_LIMIT = 200_000;

export function useRunDetectorQuery(blfPath: string) {
  return useMutation({
    mutationFn: (sql: string) => getTraceDataSource().runDetectorQuery(blfPath, sql),
  });
}
```

- [ ] **Step 3: Verify the build**

Run: `npm run build --prefix app/ui`
Expected: PASS, no TypeScript errors (no consumer of `useRunDetectorQuery` yet - this task only adds the layer, consumed starting Task 5).

- [ ] **Step 4: Commit**

```bash
git add app/ui/src/shared/api/trace-source.ts app/ui/src/shared/api/hooks.ts
git commit -m "feat(api): add runDetectorQuery data-source method and mutation hook"
```

---

### Task 4: Workspace store state + reset wiring

**Files:**
- Modify: `app/ui/src/app/store.ts`
- Modify: `app/ui/src/App.tsx`

**Interfaces:**
- Consumes: `DetectorMatch` type (Task 3).
- Produces: new `WorkspaceState` fields `detectorQuerySql: string`, `detectorMatches: DetectorMatch[]`, `detectorQueryTruncated: boolean`, `detectorQueryError: string | null`, `detectorQueryHasRun: boolean`; new actions `setDetectorQuerySql(sql: string): void`, `setDetectorQueryResult(matches: DetectorMatch[], truncated: boolean): void`, `setDetectorQueryError(error: string): void`, `resetDetectorQuery(): void`.

- [ ] **Step 1: Extend the store**

In `app/ui/src/app/store.ts`, add the import and extend `WorkspaceState`/the store body:

```typescript
import type { DetectorMatch } from "@/shared/api/trace-source";
```

Add to `WorkspaceState` (after `reconcileDisplayedSignals`):

```typescript
  // Detector Query editor state (Analyzer panel). One query at a time -
  // every run replaces the previous result wholesale. `detectorQueryHasRun`
  // is distinct from `detectorMatches.length === 0`: a query that matched
  // nothing still "ran" and the Match lane should show (empty), not stay
  // hidden as if nothing happened yet.
  detectorQuerySql: string;
  detectorMatches: DetectorMatch[];
  detectorQueryTruncated: boolean;
  detectorQueryError: string | null;
  detectorQueryHasRun: boolean;
  setDetectorQuerySql: (sql: string) => void;
  setDetectorQueryResult: (matches: DetectorMatch[], truncated: boolean) => void;
  setDetectorQueryError: (error: string) => void;
  resetDetectorQuery: () => void;
```

Add to the store body (after `reconcileDisplayedSignals`'s implementation, before the closing `}))`):

```typescript
  detectorQuerySql: "",
  detectorMatches: [],
  detectorQueryTruncated: false,
  detectorQueryError: null,
  detectorQueryHasRun: false,
  setDetectorQuerySql: (sql) => set({ detectorQuerySql: sql }),
  setDetectorQueryResult: (matches, truncated) =>
    set({ detectorMatches: matches, detectorQueryTruncated: truncated, detectorQueryError: null, detectorQueryHasRun: true }),
  setDetectorQueryError: (error) =>
    set({ detectorQueryError: error, detectorMatches: [], detectorQueryTruncated: false, detectorQueryHasRun: true }),
  resetDetectorQuery: () =>
    set({
      detectorQuerySql: "",
      detectorMatches: [],
      detectorQueryTruncated: false,
      detectorQueryError: null,
      detectorQueryHasRun: false,
    }),
```

- [ ] **Step 2: Wire the reset into App.tsx**

In `app/ui/src/App.tsx`, import `useWorkspaceStore` and call `resetDetectorQuery()` at the three points `blfPath` changes to a new trace - `reset()`, `handleStart()`, and `handleOpenExisting()`:

```typescript
import { useWorkspaceStore } from "./app/store";
```

In `handleStart`, right after `setBlfPath(startBlfPath);`:

```typescript
    useWorkspaceStore.getState().resetDetectorQuery();
```

In `handleOpenExisting`, right after `setBlfPath(openBlfPath);`:

```typescript
    useWorkspaceStore.getState().resetDetectorQuery();
```

In `reset()`, right after `setBlfPath("");`:

```typescript
    useWorkspaceStore.getState().resetDetectorQuery();
```

- [ ] **Step 3: Verify the build**

Run: `npm run build --prefix app/ui`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add app/ui/src/app/store.ts app/ui/src/App.tsx
git commit -m "feat(store): add Detector Query state and reset it on trace switch"
```

---

### Task 5: Rewrite `AnalyzerPanel`

**Files:**
- Modify: `app/ui/src/widgets/AnalyzerPanel.tsx`
- Modify: `app/ui/src/widgets/WorkspaceLayout.tsx`

**Interfaces:**
- Consumes: `useWorkspaceStore` fields/actions from Task 4, `useRunDetectorQuery` from Task 3, `Button` from `@/shared/ui/button` (existing shadcn primitive, same one `TopBar` uses).
- Produces: `AnalyzerPanel({ blfPath }: { blfPath: string })` (new required prop - currently takes none).

**Deliberate deviation from the brief's "reuse the global toast pattern" for query errors:** both the missing-column case (which must be inline per the brief) and every other query-execution error (bad table, syntax error) come back from the same backend call as one `Result<_, String>` - there's no reliable way to tell them apart, and a toast that auto-dismisses after 5s is worse UX than an inline message sitting right next to the textarea the user is actively editing. All Detector Query errors render inline in this task, none go to the toast stack. The client-side single-statement guard (which never reaches the backend) is inline for the same reason.

- [ ] **Step 1: Rewrite `AnalyzerPanel.tsx`**

```tsx
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
      {error && <div className="rounded border border-destructive/50 bg-destructive/10 p-2 text-xs text-destructive">{error}</div>}
      {!error && hasRun && (
        <div className="text-xs text-muted-foreground">
          {matches.length} match{matches.length === 1 ? "" : "es"}
          {truncated && ` (showing first ${DETECTOR_QUERY_MATCH_LIMIT.toLocaleString()})`}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Pass `blfPath` through from `WorkspaceLayout`**

In `app/ui/src/widgets/WorkspaceLayout.tsx`, change:

```tsx
            <PanelTag label="Analyzer">
              <AnalyzerPanel />
            </PanelTag>
```

to:

```tsx
            <PanelTag label="Analyzer">
              <AnalyzerPanel blfPath={blfPath} />
            </PanelTag>
```

- [ ] **Step 3: Verify the build**

Run: `npm run build --prefix app/ui`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add app/ui/src/widgets/AnalyzerPanel.tsx app/ui/src/widgets/WorkspaceLayout.tsx
git commit -m "feat(analyzer): replace stub with the Detector Query editor"
```

---

### Task 6: `MatchLane` widget + `TimelinePanel` wiring

**Files:**
- Create: `app/ui/src/widgets/MatchLane.tsx`
- Modify: `app/ui/src/widgets/TimelinePanel.tsx`

**Interfaces:**
- Consumes: `CHART_GROUP` (exported from `./SignalChart`), `useWorkspaceStore` fields `detectorMatches`, `detectorQueryHasRun`, action `setSelectedMessage` (Task 4 / pre-existing).
- Produces: `MatchLane()` (no props - reads everything from the store, same pattern as `SignalPills`).

- [ ] **Step 1: Write `MatchLane.tsx`**

```tsx
import { useEffect, useRef } from "react";
import * as echarts from "echarts";
import { useWorkspaceStore } from "@/app/store";
import { CHART_GROUP } from "./SignalChart";

const MATCH_COLOR = "#e34948"; // PALETTE[5] - red, distinct from signal colors, reads as "flagged"

export default function MatchLane() {
  const matches = useWorkspaceStore((s) => s.detectorMatches);
  const setSelectedMessage = useWorkspaceStore((s) => s.setSelectedMessage);
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<echarts.ECharts | null>(null);
  // The click handler below is registered once (init effect has no
  // dependency array reruns) but needs the *current* matches array on every
  // click, not the one from whenever `chart.on` was called - this ref is
  // kept current by the second effect and read inside the closure instead.
  const matchesRef = useRef(matches);
  matchesRef.current = matches;

  useEffect(() => {
    if (!containerRef.current) return;
    const chart = echarts.init(containerRef.current);
    chart.group = CHART_GROUP;
    chartRef.current = chart;
    echarts.connect(CHART_GROUP);
    chart.on("click", (params) => {
      const msgId = matchesRef.current[params.dataIndex]?.msgId;
      if (msgId !== undefined) setSelectedMessage(msgId);
    });
    const resize = () => chart.resize();
    window.addEventListener("resize", resize);
    return () => {
      window.removeEventListener("resize", resize);
      chart.dispose();
      chartRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    chart.setOption(
      {
        animation: false,
        grid: { left: 80, right: 20, top: 5, bottom: 5 },
        xAxis: {
          type: "value",
          axisLabel: { formatter: (v: number) => `${(v / 1_000_000).toFixed(1)}s` },
        },
        yAxis: { type: "value", show: false, min: -1, max: 1 },
        tooltip: {
          trigger: "item",
          formatter: (p: { data: [number, number]; dataIndex: number }) =>
            `msg_id: ${matches[p.dataIndex]?.msgId}<br/>t: ${(p.data[0] / 1_000_000).toFixed(3)}s`,
        },
        dataZoom: [{ type: "inside", zoomOnMouseWheel: false, moveOnMouseWheel: false, moveOnMouseMove: false }],
        series: [
          {
            type: "scatter",
            name: "Matches",
            data: matches.map((m) => [m.timestampUs, 0]),
            symbolSize: 8,
            itemStyle: { color: MATCH_COLOR },
            large: true,
          },
        ],
      },
      true
    );
    chart.resize();
  }, [matches]);

  return (
    <div className="h-16 shrink-0 border-b border-border">
      <div ref={containerRef} className="h-full w-full" />
    </div>
  );
}
```

- [ ] **Step 2: Wire into `TimelinePanel.tsx`**

In `app/ui/src/widgets/TimelinePanel.tsx`, add the import and read `detectorQueryHasRun`, rendering `MatchLane` above `SignalPills`:

```tsx
import MatchLane from "./MatchLane";
```

Add inside the component, alongside the existing `displayedSignalIds` line:

```tsx
  const detectorQueryHasRun = useWorkspaceStore((s) => s.detectorQueryHasRun);
```

Change the returned JSX from:

```tsx
    <div className="flex h-full min-h-0 flex-col">
      <SignalPills blfPath={blfPath} />
```

to:

```tsx
    <div className="flex h-full min-h-0 flex-col">
      {detectorQueryHasRun && <MatchLane />}
      <SignalPills blfPath={blfPath} />
```

- [ ] **Step 3: Verify the build**

Run: `npm run build --prefix app/ui`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add app/ui/src/widgets/MatchLane.tsx app/ui/src/widgets/TimelinePanel.tsx
git commit -m "feat(timeline): render Detector Query Matches in a dedicated lane"
```

---

## Final verification (run once, after Task 6)

```bash
cargo test --manifest-path crates/Cargo.toml
cargo build --manifest-path app/src-tauri/Cargo.toml
cargo test --manifest-path app/src-tauri/Cargo.toml
npm run build --prefix app/ui
```

All four must pass before requesting review.
