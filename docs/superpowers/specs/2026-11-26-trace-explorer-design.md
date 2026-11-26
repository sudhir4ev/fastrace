# Trace Explorer - Design

- Status: Design agreed - ready for `writing-plans`.
- Date: 2026-11-26
- Phasing: **Phase 1** = paginated table only (MVP section below). **Phase
  2** = chart view (fast-follow, separate plan against this same spec,
  once Phase 1 is proven against a real trace).

## Goal

A free-form SQL exploration surface over the Trace Store: run arbitrary
SQL, see paginated results, and (future pass) build simple charts from
the result set. Motivated by needing a way to inspect intermediate
analyzer views (e.g. a future TCP analyzer's `tcp_segments`,
`tcp_stream_segments`) during development, but the capability itself is
general-purpose, not tied to any one analyzer - see
`2026-11-26-tcp-analyzer-design.md`, which depends on this existing
first.

## Relationship to the existing Analyzer tab

Separate, new tab. `AnalyzerPanel`/`run_detector_query` are untouched:
that path is purpose-built for anomaly-detector SQL that must return
`msg_id`/`timestamp_us` (it feeds the Timeline's Anomaly Overlay and
enforces signal-decode preconditions). Explorer has none of that
contract - it runs whatever SQL the user writes, against any
table/view already present in the open DuckDB connection, and renders
whatever columns come back.

## Explicitly out of scope

- **No view-loading mechanism.** Querying an analyzer's intermediate
  view (e.g. `tcp_segments`) requires that analyzer's SQL module to have
  already been run in this session (or the user pastes its `CREATE VIEW`
  statements into the Explorer box themselves). No "load this analyzer's
  schema" picker.
- **No trim-window scoping.** Queries run exactly as written; scoping is
  entirely the user's own `WHERE` clause. Unlike Analyzer, most Explorer
  queries won't even have a `timestamp_us` column to scope on.
- **No multi-cell notebook.** One SQL editor, one results pane - same
  shape as `AnalyzerPanel`, just without its contract. Query history
  (already built for Analyzer) gives a way back to a previous query
  without needing multiple live cells.
- **No ad hoc filter-builder UI.** "Unscoped, write your own WHERE"
  already covers this.
- **No forked/vendored BI platform.** Considered and rejected forking
  Apache Superset to get its chart builder: it's a full Flask/SQLAlchemy
  platform, not an extractable component, and its chart plugins assume
  Superset's own query-data contract and theme engine. ECharts (`^6.1.0`)
  is already a frontend dependency, used by the existing
  `TimelineChart.tsx` - the actual hard part (a capable charting engine)
  is already present; only a thin picker UI + query-shaping layer is
  needed on top of it.

## Phase 1: paginated table results (no chart rendering yet)

Results are **not** fetched once and materialized fully into the
frontend - the base SQL could return millions of rows
(`select * from messages`). Each page re-executes a wrapped query
against DuckDB.

```rust
pub struct ExplorerColumn {
    pub name: String,
    pub numeric: bool,   // from DuckDB's column type; gates Y-axis eligibility once charts exist
}
pub struct ExplorerTablePage {
    pub columns: Vec<ExplorerColumn>,
    pub rows: Vec<Vec<String>>,   // every cell rendered to a display string - result schema is
                                    // different per query, so there is no fixed type to deserialize into
    pub total_rows: i64,
}
```

New Tauri command, same `trace_store::open` read-only pattern as every
other query command:

```
run_explorer_table_page(blf_path, sql, page_size, offset, order_by?) -> ExplorerTablePage
```

Two queries per page load, both wrapping the user's SQL as a subquery -
same "subquery it, let DuckDB's binder report errors" idiom already used
by `detector_scoped_sql`:

```sql
-- the page itself
select * from (<baseSql>) as explorer_base
order by <orderBy.column> <orderBy.direction>   -- omitted if no sort column picked
limit <pageSize> offset <pageOffset>

-- total row count - run once when the SQL changes, not on every page flip
select count(*) as total from (<baseSql>) as explorer_base
```

Single-statement guard reused from `AnalyzerPanel`'s
`hasEmbeddedSemicolon` client-side pre-check (DuckDB's own parser remains
the real guard).

`shortcut: OFFSET pagination needs a deterministic ORDER BY to guarantee
stable pages; the trace store never mutates after Prepare so this holds
in practice without one, but DuckDB does not contractually guarantee row
order across repeated scans without an explicit sort. Upgrade by
defaulting orderBy to the first integer/id-looking column when one
exists, if this ever causes a visible issue.`

### Frontend

New "Explorer" workspace tab: SQL editor (same `prism-react-editor` setup
as `AnalyzerPanel`, no signal autocomplete since there's no fixed target
schema) + Run + a paginated results table (page-size control, prev/next,
optional click-column-header-to-sort wired to `order_by`). No viz-type
selector in this pass - a selector earns its UI only once there is a
second option.

### Query history and saved queries

Explorer's recent-queries is a **new, separate concept from Analyzer's** -
not a reuse of its `query_history`. Analyzer's persisted
`QueryHistoryEntry` (`crates/project-store/src/lib.rs:11`) carries
`target_signal_ids`/`respect_trim`/`match_count`, all Detector-Query-
specific fields that don't apply to arbitrary Explorer SQL. Two new
`ProjectFile` fields, same persistence mechanism (ADR 0010, same
`<stem>.fastrace-project.json`), new shapes:

```rust
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExplorerQueryEntry {
    pub sql: String,
    pub ran_at: i64,
    pub row_count: i64,   // total_rows from the last page fetch
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedExplorerQuery {
    pub name: String,      // user-given label, since this is an intentional pin, not an anonymous recent entry
    pub sql: String,
    pub saved_at: i64,
}
```

```rust
// ProjectFile additions
#[serde(default)]
pub explorer_query_history: Vec<ExplorerQueryEntry>,   // rolling, capped at MAX_QUERY_HISTORY, same truncation
                                                         // behavior as push_query/MAX_QUERY_HISTORY today
#[serde(default)]
pub explorer_saved_queries: Vec<SavedExplorerQuery>,    // uncapped, never auto-evicted - this is what the
                                                         // mock's "Save" button writes to
```

- History icon (top-right of the Explorer header, matches Analyzer's
  existing history popover) lists `explorer_query_history`, auto-recorded
  on every successful run, same rolling/capped behavior Analyzer already
  has.
- "Save" button next to Run writes the *current* SQL to
  `explorer_saved_queries` with a user-supplied name (small inline
  prompt/dialog for the name) - independent of the rolling history, never
  evicted by newer runs.

## Phase 2: chart view

Not a separate tab - a second **view mode** for the same query result.
Once a query has run successfully, `[ View: Table | Chart ]` tabs appear
above the results area; switching modes doesn't touch the Table's
pagination state, it's an independent fetch against the same `baseSql`.

```ts
interface ChartConfig {
  vizType: "bar" | "line";          // segmented control inside the Chart view
  baseSql: string;                   // the Explorer SQL exactly as written
  x: string;
  seriesBy?: string;                 // splits into multiple series; independent of aggregate
  aggregate: boolean;                 // the "Group results" toggle, default off
  y?: string;                         // plain column - used when aggregate = false
  metric?: { agg: "count" | "sum" | "avg" | "min" | "max"; column?: string }; // used when aggregate = true
  rowLimit: number;                   // silent safety cap from config/config.json, not user-facing
}
```

Config panel layout:

```
[ Chart type: (Bar) (Line) ]
[ X: <column> ]   [ Group by (optional): <column | None> ]
[ Group results ]
   unchecked -> [ Y: <numeric column> ]
   checked   -> [ Aggregate: Count | Sum | Avg | Min | Max ]  [ of: <numeric column> ]
                (the "of" picker hides when Aggregate = Count - count(*) needs no column)
[ chart canvas ]
```

X/"Group by" pickers accept any column; Y/"of" are restricted to numeric
columns, using the same `ExplorerColumn.numeric` metadata already
returned by the table-page result.

**No grouping** (default) - reshape/order/cap only, no `GROUP BY`:

```sql
select <x> as x, <seriesBy as g,> <y> as y
from (<baseSql>) as explorer_base
order by x
limit <rowLimit>
```

**With grouping** - only when the toggle is on:

```sql
select <x> as x, <seriesBy as g,> <agg>(<metric.column or *>) as y
from (<baseSql>) as explorer_base
group by <x><, seriesBy>
order by x
limit <rowLimit>
```

A plain "plot `idle_us` over `timestamp_us`" line chart never touches
`GROUP BY` - only explicit grouping (e.g. "count sessions per `src_ip`")
takes the aggregated path.

The wrapper always aliases its output as `x`, `g` (if `seriesBy` is set),
`y` - regardless of the user's actual column names - so the frontend
never has to infer which returned column is which:

```rust
pub fn run_explorer_chart_query(conn, base_sql: &str, config: &ChartConfig) -> Result<ExplorerChartResult, String>
pub struct ExplorerChartResult { pub rows: Vec<(String, Option<String>, f64)>, pub truncated: bool } // (x, g, y)
```

Fetch behavior: changing any picker does **not** auto-refetch. An
explicit "Apply" button commits the current picker state and triggers
one fetch - lets someone change chart type/X/Y/group-by freely while
deciding, without a query firing on every click. No separate
"in sync"/"out of sync" status text - the Apply button alone is the
affordance. If `rowLimit` truncates the result, show the same
"(showing first N)" note Analyzer already displays for its match cap.

Mark specs and hover are **fixed, not user-configurable** - always-on
hover/tooltip and linear 2px lines per the dataviz skill's default marks
(`marks-and-anatomy.md`, `interaction.md`). No interpolation picker, no
"show hover markers" toggle - hover is baseline interactivity, not a
style preference a chart should ship without.

Rendering:

- **Color**: reuse `getSignalColor`/`PALETTE` from
  `app/ui/src/app/signalColors.ts` as-is - already the dataviz-skill-
  validated palette, already used for Timeline signal series. No new
  palette.
- **One axis, always** - grouped series share a single Y scale.
- **Legend**: shown only when `seriesBy` produces \>=2 series.
- **Marks**: 2px line width; 4px rounded bar ends anchored to baseline;
  >=8px hover markers (`marks-and-anatomy.md`).
- **Hover**: crosshair+tooltip for line (`axisPointer: 'cross'`),
  per-bar tooltip for bar (`axisPointer: 'shadow'`) (`interaction.md`).
- **Rendering**: raw `echarts.init()`/`dispose()` + `containerRef`
  pattern already used in `TimelineChart.tsx`, not the
  `echarts-for-react` wrapper. No new dependency.

## Superset feature survey - explicit accept/reject

| Superset concept | In scope? | Why |
|---|---|---|
| Metrics (aggregate functions) | Designed, Phase 2 | Shape is specified above |
| Group-by / dimensions | Designed, Phase 2 | Same |
| Row limit | Yes (Phase 1 table cap + Phase 2 chart cap) | Safety necessity, same pattern as the existing Detector Query match-cap |
| Pagination (page size/offset) | Yes (Phase 1) | Core of this pass |
| Order by | Yes, optional (Phase 1) | Needed for stable paging when a natural key exists |
| Time range / time grain (resample to hour/day buckets) | No | Timestamps are plain int64 microseconds, no calendar semantics yet; `date_trunc` in raw SQL already covers bucketing inline |
| Ad hoc filter UI (point-and-click WHERE builder) | No | Explorer is "unscoped, write your own WHERE" by design |
| Post-processing (pivot, rolling avg, resample) | No | DuckDB window functions already express these in SQL directly |
| Multiple queries per chart (comparison/annotation layers) | No | Dropped (mark-area overlay was considered and dropped) |
| Saved charts / dashboards | No | Consistent with the ephemeral/no-persistence stance taken for the TCP analyzer's findings |

## Testing

Same per-module convention as the rest of the repo (AGENTS.md "Always"
rule):

- `crates/query`: unit tests over a seeded DuckDB connection (same style
  as the existing `run_detector_query_*` tests) covering
  `run_explorer_table_page` - page/offset correctness, `total_rows`
  correctness, the single-statement guard, and DuckDB binder errors
  surfacing correctly for bad SQL (e.g. a typo'd column name).
- No dedicated frontend test target exists yet (matches the rest of
  `app/ui`) - verify the Explorer tab manually against a fixture trace
  once implemented.
