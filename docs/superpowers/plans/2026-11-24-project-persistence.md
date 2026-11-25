# Project Persistence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Introduce the Project file (`<stem>.fastrace-project.json`) so Displayed Signals, Trim Window, per-signal Downsampling Algorithm, and Query History all survive closing and reopening a Trace.

**Architecture:** A new, Tauri-free `crates/project-store` crate owns the file's schema and pure read/mutate/write functions. `app/src-tauri` relocates Query History's existing storage from `recent_traces.json` into the Project file (same command names/signatures - this is a backend-only move, invisible to the frontend contract) and adds new thin commands for the previously-unpersisted fields. The frontend loads the Project once when a Trace opens and autosaves it, debounced, on every relevant change.

**Tech Stack:** Rust (`serde`, `serde_json`, no DuckDB/Tauri dependency in the new crate), Tauri 2 commands, React + TypeScript, Vitest.

**Spec:** `docs/adr/0010-project-file-persists-ui-state.md`, `CONTEXT.md` (terms: Project, Query History, Displayed Signal, Trim Window, Downsampling Algorithm).

**Depends on:** `docs/superpowers/plans/2026-11-24-lod-downsampling.md` Task 8 (`WorkspaceState.signalDownsamplingAlgorithms` and its setter) must have landed before Task 4/5 here, since this plan seeds and autosaves that field. `crates/project-store` itself (Tasks 1-2) has no such dependency - it stores the algorithm choice as a plain validated string, not the other plan's Rust enum, so the two plans don't share a Rust type.

## Global Constraints

- `crates/project-store` has zero Tauri and zero DuckDB dependency - pure structs + file I/O only (`docs/adr/0010`).
- No `schema_version` bump - the Project file is a separate sidecar JSON with its own `version` field, independent of the DuckDB schema (`docs/adr/0010` decision 3).
- Query History's Tauri command names and signatures (`list_query_history`, `record_query`, `remove_query`, `clear_query_history`) do not change - only their backing storage moves. No frontend call site for these four needs editing.
- No migration from `recent_traces.json`'s old `queries` field into the Project file. Any Query History already recorded before this ships is not carried over - the first open after upgrading starts that Trace's Project file with empty Query History. Accepted, not a task.
- Autosave writes go through exactly one Tauri command, `save_project`, taking all three mutable fields (Displayed Signals, Trim Window, algorithm map) together. This does one `read_project`/`write_project` cycle per autosave tick instead of three concurrent ones, which would otherwise race and lose whichever write's read was stalest.
- Multi-trace is explicitly out of scope - `ProjectFile.traces` always has exactly one entry; `set_downsampling_algorithm` writing to `traces.first_mut()` is correct for v1 and is not a bug to "fix" here.
- Run `cargo fmt --manifest-path crates/Cargo.toml` and `cargo clippy --manifest-path crates/Cargo.toml` on every Rust change; run `npm run test --prefix app/ui` on every frontend change.

## Review Focus

- A corrupted or truncated Project file (app crashed mid-write) - `read_project` must return a clear `Err`. On the frontend, `useProject`'s query rejecting already surfaces a toast via the existing global `QueryCache` error handler (`app/ui/src/app/query-client.ts`) - no new error UI needed. The Task 4 seeding effect must still mark the Trace as seeded and proceed with default (empty) state on `project.isError`, rather than leaving the screen waiting on data that will never arrive; the next autosave tick then overwrites the broken file with valid JSON.
- The very first time a Trace is ever opened (no Project file exists yet) - `read_project` must return sensible defaults (empty lists, no Trim Window), not an error.
- Clearing the Trim Window (`resetTrimRange()` sets `appliedTrimRange` back to `null`) must persist as a clear, not a no-op - `save_project`'s `trim_window: None` means "unset it," not "leave it alone." Omitting the write when `trim` is falsy would let a cleared Trim Window resurrect itself on next open.
- Re-Preparing a Trace must delete the stale Project file, not just the stale `.duckdb` - otherwise `downsampling_algorithms` keyed by the old (positional, reassigned-on-every-Prepare) `signal_id`s would silently apply to the wrong signals in the freshly rebuilt store.
- `displayed_signal_ids` restored from a Project file may reference a `signal_id` that no longer decodes in the current Signal Catalog (e.g. the trace was re-Prepared with a different ARXML under the same path) - the frontend must skip unknown ids when restoring, not crash on a catalog lookup miss.
- A debounced autosave write landing in the narrow window right after `prepare_trace` deletes the Project file but before the sidecar finishes rebuilding the `.duckdb` could resurrect a stale file. Accepted as a known, narrow-window limitation for this plan (the user would have to be actively changing chart state at the exact moment they also re-Prepare) rather than engineering a cross-process lock for it - not a task, just documented here so it isn't "discovered" later as an unreported gap.

---

## File Structure

- Create: `crates/project-store/Cargo.toml`, `crates/project-store/src/lib.rs`, `crates/project-store/README.md`.
- Modify: `crates/Cargo.toml` - add `"project-store"` to `members`.
- Modify: `app/src-tauri/Cargo.toml` - add `project-store` path dependency.
- Modify: `app/src-tauri/src/main.rs` - remove `QueryHistoryEntry`/`queries` field from `RecentTraceEntry` and the now-redundant pure helpers; relocate the four Query History commands onto `project-store`; add `get_project` and a single combined `save_project` command; add `delete_project_file` and call it from `prepare_trace`, `remove_recent_trace`, and `delete_trace_store`.
- Modify: `app/ui/src/shared/api/trace-source.ts` - add `getProject`, `saveProject`.
- Modify: `app/ui/src/shared/api/hooks.ts` - add `useLoadProjectOnOpen`, `useProjectAutosave`.
- Modify: `app/ui/src/widgets/WorkspaceLayout.tsx` - call both new hooks once per open Trace.

---

### Task 1: `crates/project-store` crate

**Files:**
- Create: `crates/project-store/Cargo.toml`
- Create: `crates/project-store/src/lib.rs`
- Create: `crates/project-store/README.md`
- Modify: `crates/Cargo.toml`

**Interfaces:**
- Produces: `ProjectFile { version: u32, traces: Vec<TraceState>, displayed_signal_ids: Vec<i64>, trim_window: Option<TrimWindow>, query_history: Vec<QueryHistoryEntry> }`, `TraceState { path: String, downsampling_algorithms: HashMap<i64, String> }`, `TrimWindow { start_us: i64, end_us: i64 }`, `QueryHistoryEntry { sql: String, target_signal_ids: Vec<i64>, respect_trim: bool, ran_at: i64, match_count: i64 }`, `project_file_path(blf_path: &Path) -> PathBuf`, `read_project(path: &Path, default_trace_path: &str) -> Result<ProjectFile, String>`, `write_project(path: &Path, project: &ProjectFile) -> Result<(), String>`, `push_query`, `remove_query`, `clear_query_history`, `set_displayed_signals`, `set_trim_window`, `clear_trim_window`, `set_downsampling_algorithm` (all `(ProjectFile, ...) -> ProjectFile`, pure).

- [ ] **Step 1: Write the failing tests**

`crates/project-store/src/lib.rs` (full file, tests at the bottom in the same style as `crates/query`):

```rust
use std::collections::HashMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

pub const PROJECT_VERSION: u32 = 1;
pub const MAX_QUERY_HISTORY: usize = 25;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QueryHistoryEntry {
    pub sql: String,
    pub target_signal_ids: Vec<i64>,
    pub respect_trim: bool,
    pub ran_at: i64,
    pub match_count: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrimWindow {
    pub start_us: i64,
    pub end_us: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TraceState {
    pub path: String,
    #[serde(default)]
    pub downsampling_algorithms: HashMap<i64, String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectFile {
    pub version: u32,
    pub traces: Vec<TraceState>,
    #[serde(default)]
    pub displayed_signal_ids: Vec<i64>,
    #[serde(default)]
    pub trim_window: Option<TrimWindow>,
    #[serde(default)]
    pub query_history: Vec<QueryHistoryEntry>,
}

impl ProjectFile {
    pub fn new_for_trace(path: &str) -> Self {
        ProjectFile {
            version: PROJECT_VERSION,
            traces: vec![TraceState {
                path: path.to_string(),
                downsampling_algorithms: HashMap::new(),
            }],
            displayed_signal_ids: Vec::new(),
            trim_window: None,
            query_history: Vec::new(),
        }
    }
}

/// `<stem>.fastrace-project.json` beside the Trace (`docs/adr/0010`).
pub fn project_file_path(blf_path: &Path) -> PathBuf {
    blf_path.with_extension("fastrace-project.json")
}

/// Loads the Project file, or a fresh default (one trace, everything else
/// empty) if none exists yet - a brand-new Trace is not an error.
pub fn read_project(path: &Path, default_trace_path: &str) -> Result<ProjectFile, String> {
    match std::fs::read_to_string(path) {
        Ok(contents) => serde_json::from_str(&contents).map_err(|e| e.to_string()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            Ok(ProjectFile::new_for_trace(default_trace_path))
        }
        Err(e) => Err(e.to_string()),
    }
}

pub fn write_project(path: &Path, project: &ProjectFile) -> Result<(), String> {
    let json = serde_json::to_string(project).map_err(|e| e.to_string())?;
    std::fs::write(path, json).map_err(|e| e.to_string())
}

fn normalize_query_sql(sql: &str) -> String {
    sql.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Inserts at the front, deduping by whitespace-normalized SQL, capped at
/// `MAX_QUERY_HISTORY` (`CONTEXT.md`'s Query History).
pub fn push_query(mut project: ProjectFile, entry: QueryHistoryEntry) -> ProjectFile {
    let norm = normalize_query_sql(&entry.sql);
    project.query_history.retain(|q| normalize_query_sql(&q.sql) != norm);
    project.query_history.insert(0, entry);
    project.query_history.truncate(MAX_QUERY_HISTORY);
    project
}

pub fn remove_query(mut project: ProjectFile, sql: &str) -> ProjectFile {
    let norm = normalize_query_sql(sql);
    project.query_history.retain(|q| normalize_query_sql(&q.sql) != norm);
    project
}

pub fn clear_query_history(mut project: ProjectFile) -> ProjectFile {
    project.query_history.clear();
    project
}

pub fn set_displayed_signals(mut project: ProjectFile, signal_ids: Vec<i64>) -> ProjectFile {
    project.displayed_signal_ids = signal_ids;
    project
}

pub fn set_trim_window(mut project: ProjectFile, start_us: i64, end_us: i64) -> ProjectFile {
    project.trim_window = Some(TrimWindow { start_us, end_us });
    project
}

pub fn clear_trim_window(mut project: ProjectFile) -> ProjectFile {
    project.trim_window = None;
    project
}

/// Writes to the first (and, for now, only) trace - multi-trace Projects
/// are future work (`docs/adr/0010`), not a lookup bug to fix here.
pub fn set_downsampling_algorithm(
    mut project: ProjectFile,
    signal_id: i64,
    algorithm: String,
) -> ProjectFile {
    if let Some(trace) = project.traces.first_mut() {
        trace.downsampling_algorithms.insert(signal_id, algorithm);
    }
    project
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_path(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!("project_store_test_{}_{}.json", name, std::process::id()))
    }

    #[test]
    fn project_file_path_replaces_extension() {
        let p = project_file_path(Path::new("/traces/run1.blf"));
        assert_eq!(p, PathBuf::from("/traces/run1.fastrace-project.json"));
    }

    #[test]
    fn read_project_returns_default_when_file_missing() {
        let path = temp_path("missing");
        let project = read_project(&path, "/traces/run1.blf").unwrap();
        assert_eq!(project.version, PROJECT_VERSION);
        assert_eq!(project.traces.len(), 1);
        assert_eq!(project.traces[0].path, "/traces/run1.blf");
        assert!(project.displayed_signal_ids.is_empty());
        assert!(project.trim_window.is_none());
        assert!(project.query_history.is_empty());
    }

    #[test]
    fn write_then_read_round_trips() {
        let path = temp_path("roundtrip");
        let mut project = ProjectFile::new_for_trace("/traces/run1.blf");
        project.displayed_signal_ids = vec![1, 2, 3];
        project.trim_window = Some(TrimWindow { start_us: 100, end_us: 200 });
        project.traces[0]
            .downsampling_algorithms
            .insert(7, "lttb".to_string());
        write_project(&path, &project).unwrap();
        let loaded = read_project(&path, "/traces/run1.blf").unwrap();
        assert_eq!(loaded, project);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn read_project_errors_on_corrupt_json() {
        let path = temp_path("corrupt");
        std::fs::write(&path, "{ not valid json").unwrap();
        assert!(read_project(&path, "/traces/run1.blf").is_err());
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn push_query_dedupes_by_normalized_sql_and_moves_to_front() {
        let project = ProjectFile::new_for_trace("/t.blf");
        let project = push_query(
            project,
            QueryHistoryEntry {
                sql: "select 1".to_string(),
                target_signal_ids: vec![],
                respect_trim: true,
                ran_at: 1,
                match_count: 0,
            },
        );
        let project = push_query(
            project,
            QueryHistoryEntry {
                sql: "select   1".to_string(), // same query, different whitespace
                target_signal_ids: vec![],
                respect_trim: true,
                ran_at: 2,
                match_count: 5,
            },
        );
        assert_eq!(project.query_history.len(), 1, "re-running the same SQL replaces, not duplicates");
        assert_eq!(project.query_history[0].ran_at, 2);
    }

    #[test]
    fn push_query_caps_at_max_query_history() {
        let mut project = ProjectFile::new_for_trace("/t.blf");
        for i in 0..(MAX_QUERY_HISTORY + 5) {
            project = push_query(
                project,
                QueryHistoryEntry {
                    sql: format!("select {i}"),
                    target_signal_ids: vec![],
                    respect_trim: true,
                    ran_at: i as i64,
                    match_count: 0,
                },
            );
        }
        assert_eq!(project.query_history.len(), MAX_QUERY_HISTORY);
    }

    #[test]
    fn remove_query_removes_by_normalized_sql() {
        let project = ProjectFile::new_for_trace("/t.blf");
        let project = push_query(
            project,
            QueryHistoryEntry {
                sql: "select 1".to_string(),
                target_signal_ids: vec![],
                respect_trim: true,
                ran_at: 1,
                match_count: 0,
            },
        );
        let project = remove_query(project, "select   1");
        assert!(project.query_history.is_empty());
    }

    #[test]
    fn clear_query_history_empties_the_list() {
        let project = ProjectFile::new_for_trace("/t.blf");
        let project = push_query(
            project,
            QueryHistoryEntry {
                sql: "select 1".to_string(),
                target_signal_ids: vec![],
                respect_trim: true,
                ran_at: 1,
                match_count: 0,
            },
        );
        assert!(clear_query_history(project).query_history.is_empty());
    }

    #[test]
    fn set_displayed_signals_replaces_the_list() {
        let project = ProjectFile::new_for_trace("/t.blf");
        let project = set_displayed_signals(project, vec![5, 6]);
        assert_eq!(project.displayed_signal_ids, vec![5, 6]);
    }

    #[test]
    fn set_trim_window_sets_start_and_end() {
        let project = ProjectFile::new_for_trace("/t.blf");
        let project = set_trim_window(project, 10, 20);
        assert_eq!(project.trim_window, Some(TrimWindow { start_us: 10, end_us: 20 }));
    }

    #[test]
    fn clear_trim_window_unsets_it() {
        let project = ProjectFile::new_for_trace("/t.blf");
        let project = set_trim_window(project, 10, 20);
        let project = clear_trim_window(project);
        assert!(project.trim_window.is_none());
    }

    #[test]
    fn set_downsampling_algorithm_inserts_into_the_first_trace() {
        let project = ProjectFile::new_for_trace("/t.blf");
        let project = set_downsampling_algorithm(project, 42, "min_max".to_string());
        assert_eq!(
            project.traces[0].downsampling_algorithms.get(&42),
            Some(&"min_max".to_string())
        );
    }
}
```

`crates/project-store/Cargo.toml`:

```toml
[package]
name = "project-store"
version = "0.1.0"
edition = "2021"

[dependencies]
serde = { version = "1", features = ["derive"] }
serde_json = "1"
```

Add `"project-store"` to `crates/Cargo.toml`'s `members` list:

```toml
[workspace]
resolver = "2"
members = ["trace-store", "query", "sidecar", "project-store"]
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test --manifest-path crates/Cargo.toml -p project-store`
Expected: FAIL to compile (crate doesn't exist in the workspace yet) until Step 1's files are in place, then PASS straight away since Step 1 already contains the implementation alongside the tests - run this step again after Step 1 is fully saved to confirm the crate compiles and every test passes before moving on.

- [ ] **Step 3: Write the README**

`crates/project-store/README.md`:

```markdown
# project-store

Reads/writes the Project file (`<stem>.fastrace-project.json`), the persisted,
resumable per-Trace UI state (`docs/adr/0010`). No Tauri knowledge, no DuckDB.

## Build / test

\`\`\`bash
cargo test --manifest-path crates/Cargo.toml -p project-store
cargo fmt --manifest-path crates/Cargo.toml
cargo clippy --manifest-path crates/Cargo.toml -p project-store
\`\`\`

## Notable APIs

| Function | Role |
|----------|------|
| `project_file_path` | `<stem>.fastrace-project.json` beside the Trace |
| `read_project` | Loads the file, or a fresh default `ProjectFile` if none exists yet |
| `write_project` | Serializes and writes the whole file |
| `push_query` / `remove_query` / `clear_query_history` | Query History mutations (25-entry cap, SQL-dedup) |
| `set_displayed_signals` / `set_trim_window` / `clear_trim_window` / `set_downsampling_algorithm` | The other persisted fields |

`app/src-tauri` is the only caller - it loads the Project right after
`trace_store::open()` succeeds and calls these pure functions before writing
the result back. `downsampling_algorithms` stores the algorithm choice as a
plain string (`"min_max"` / `"lttb"`); this crate does not depend on
`crates/query`'s `DownsamplingAlgorithm` enum, so the two stay decoupled.
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test --manifest-path crates/Cargo.toml -p project-store`
Expected: PASS (13 tests)

- [ ] **Step 5: Format, lint, commit**

```bash
cargo fmt --manifest-path crates/Cargo.toml
cargo clippy --manifest-path crates/Cargo.toml -p project-store
git add crates/project-store crates/Cargo.toml
git commit -m "feat(project-store): add Project file schema and pure read/write helpers"
```

---

### Task 2: Wire `app/src-tauri` - relocate Query History, add the new commands, fix the re-Prepare staleness gap

**Files:**
- Modify: `app/src-tauri/Cargo.toml`
- Modify: `app/src-tauri/src/main.rs` (struct `RecentTraceEntry` ~525-539, `upsert_recent` ~560-591, `push_query`/`remove_query_entry`/`clear_queries` ~601-643, Query History commands ~769-816, `prepare_trace` ~108-134, `remove_recent_trace` ~762-767, `delete_trace_store` ~498-501, `generate_handler!` list ~882-898)

**Interfaces:**
- Consumes: `project_store::{ProjectFile, QueryHistoryEntry, project_file_path, read_project, write_project, push_query, remove_query, clear_query_history, set_displayed_signals, set_trim_window, clear_trim_window, set_downsampling_algorithm}` (Task 1).
- Produces: unchanged `list_query_history`/`record_query`/`remove_query`/`clear_query_history` command signatures (now backed by the Project file); new `get_project` and `save_project` commands; `delete_project_file` helper called from `prepare_trace`, `remove_recent_trace`, `delete_trace_store`.

- [ ] **Step 1: Write the failing tests**

Add to the existing `#[cfg(test)] mod tests` block in `app/src-tauri/src/main.rs`:

```rust
#[test]
fn get_project_returns_defaults_for_a_brand_new_trace() {
    let dir = std::env::temp_dir();
    let blf_path = dir.join(format!("project_test_fresh_{}.blf", std::process::id()));
    let blf_path = blf_path.to_string_lossy().to_string();
    let project = get_project(blf_path).unwrap();
    assert_eq!(project.displayed_signal_ids, Vec::<i64>::new());
    assert!(project.trim_window.is_none());
}

#[test]
fn save_project_round_trips_displayed_signals_trim_window_and_algorithms() {
    let dir = std::env::temp_dir();
    let blf_path = dir.join(format!("project_test_roundtrip_{}.blf", std::process::id()));
    let blf_path = blf_path.to_string_lossy().to_string();
    let mut algorithms = std::collections::HashMap::new();
    algorithms.insert(1i64, "lttb".to_string());
    save_project(
        blf_path.clone(),
        vec![1, 2],
        Some(project_store::TrimWindow { start_us: 100, end_us: 200 }),
        algorithms,
    )
    .unwrap();
    let project = get_project(blf_path.clone()).unwrap();
    assert_eq!(project.displayed_signal_ids, vec![1, 2]);
    assert_eq!(
        project.trim_window,
        Some(project_store::TrimWindow { start_us: 100, end_us: 200 })
    );
    assert_eq!(
        project.traces[0].downsampling_algorithms.get(&1),
        Some(&"lttb".to_string())
    );
    let _ = std::fs::remove_file(project_store::project_file_path(std::path::Path::new(&blf_path)));
}

#[test]
fn save_project_with_none_trim_window_clears_a_previously_set_one() {
    let dir = std::env::temp_dir();
    let blf_path = dir.join(format!("project_test_clear_trim_{}.blf", std::process::id()));
    let blf_path = blf_path.to_string_lossy().to_string();
    save_project(
        blf_path.clone(),
        vec![],
        Some(project_store::TrimWindow { start_us: 1, end_us: 2 }),
        std::collections::HashMap::new(),
    )
    .unwrap();
    save_project(blf_path.clone(), vec![], None, std::collections::HashMap::new()).unwrap();
    let project = get_project(blf_path.clone()).unwrap();
    assert!(project.trim_window.is_none());
    let _ = std::fs::remove_file(project_store::project_file_path(std::path::Path::new(&blf_path)));
}

#[test]
fn query_history_commands_persist_to_the_project_file_not_recent_traces() {
    let dir = std::env::temp_dir();
    let blf_path = dir.join(format!("project_test_queries_{}.blf", std::process::id()));
    let blf_path = blf_path.to_string_lossy().to_string();
    record_query(blf_path.clone(), "select 1".to_string(), vec![], true, 3).unwrap();
    let history = list_query_history(blf_path.clone()).unwrap();
    assert_eq!(history.len(), 1);
    assert_eq!(history[0].match_count, 3);
    remove_query(blf_path.clone(), "select 1".to_string()).unwrap();
    assert!(list_query_history(blf_path.clone()).unwrap().is_empty());
    let _ = std::fs::remove_file(project_store::project_file_path(std::path::Path::new(&blf_path)));
}

#[test]
fn delete_project_file_is_not_an_error_when_file_is_absent() {
    let dir = std::env::temp_dir();
    let blf_path = dir.join(format!("project_test_delete_missing_{}.blf", std::process::id()));
    assert!(delete_project_file(&blf_path.to_string_lossy()).is_ok());
}

#[test]
fn delete_project_file_removes_an_existing_file() {
    let dir = std::env::temp_dir();
    let blf_path = dir.join(format!("project_test_delete_existing_{}.blf", std::process::id()));
    let blf_path_str = blf_path.to_string_lossy().to_string();
    save_project(blf_path_str.clone(), vec![1], None, std::collections::HashMap::new()).unwrap();
    let path = project_store::project_file_path(&blf_path);
    assert!(path.exists());
    delete_project_file(&blf_path_str).unwrap();
    assert!(!path.exists());
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test --manifest-path app/src-tauri/Cargo.toml get_project save_project query_history_commands delete_project_file`
Expected: FAIL to compile - none of these functions exist yet with these signatures.

- [ ] **Step 3: Write the implementation**

Add `project-store = { path = "../../crates/project-store" }` to `app/src-tauri/Cargo.toml`'s `[dependencies]`.

In `app/src-tauri/src/main.rs`:

Remove the `QueryHistoryEntry` struct (lines 514-523) - it's replaced by `project_store::QueryHistoryEntry`.

Remove the `queries: Vec<QueryHistoryEntry>` field from `RecentTraceEntry` (lines 525-539), leaving:

```rust
#[derive(Clone, serde::Serialize, serde::Deserialize)]
struct RecentTraceEntry {
    blf_path: String,
    opened_at: i64,
    #[serde(default)]
    messages: Option<i64>,
    #[serde(default)]
    protocol_rows: Option<i64>,
    #[serde(default)]
    elapsed_ms: Option<i64>,
    #[serde(default)]
    activities: Vec<ActivityEntry>,
}
```

Remove the `queries: previous.map(|p| p.queries).unwrap_or_default(),` line from `upsert_recent` (inside its `RecentTraceEntry { ... }` construction), and the `queries: vec![],` lines from `push_activity`'s `None =>` branch's `RecentTraceEntry { ... }` construction (there is no `queries: vec![entry]`/`queries: vec![]` left anywhere once the field is gone - remove every such line).

Delete these four functions entirely (lines ~601-643): `push_query`, `remove_query_entry`, `clear_queries`. (`normalize_query_sql` at line 593-595 is also now redundant - `project_store` has its own private copy - delete it too, since nothing else in `main.rs` calls it.)

Replace the four Query History commands (lines 769-816) with:

```rust
fn project_path_for(blf_path: &str) -> PathBuf {
    project_store::project_file_path(std::path::Path::new(blf_path))
}

#[tauri::command]
fn get_project(blf_path: String) -> Result<project_store::ProjectFile, String> {
    let path = project_path_for(&blf_path);
    project_store::read_project(&path, &blf_path)
}

/// Single autosave entry point - one `read_project`/`write_project` cycle
/// for all three mutable fields together. The frontend's debounced autosave
/// (Task 5) calls this instead of three separate commands so concurrent
/// fire-and-forget writes can't race and clobber each other's read.
/// `trim_window: None` explicitly clears a previously-set Trim Window
/// (`resetTrimRange()` on the frontend) rather than leaving it untouched.
#[tauri::command]
fn save_project(
    blf_path: String,
    displayed_signal_ids: Vec<i64>,
    trim_window: Option<project_store::TrimWindow>,
    downsampling_algorithms: std::collections::HashMap<i64, String>,
) -> Result<(), String> {
    let path = project_path_for(&blf_path);
    let mut project = project_store::read_project(&path, &blf_path)?;
    project = project_store::set_displayed_signals(project, displayed_signal_ids);
    project = match trim_window {
        Some(tw) => project_store::set_trim_window(project, tw.start_us, tw.end_us),
        None => project_store::clear_trim_window(project),
    };
    for (signal_id, algorithm) in downsampling_algorithms {
        project = project_store::set_downsampling_algorithm(project, signal_id, algorithm);
    }
    project_store::write_project(&path, &project)
}

#[tauri::command]
fn list_query_history(blf_path: String) -> Result<Vec<project_store::QueryHistoryEntry>, String> {
    let path = project_path_for(&blf_path);
    Ok(project_store::read_project(&path, &blf_path)?.query_history)
}

#[tauri::command]
fn record_query(
    blf_path: String,
    sql: String,
    target_signal_ids: Vec<i64>,
    respect_trim: bool,
    match_count: i64,
) -> Result<(), String> {
    let path = project_path_for(&blf_path);
    let project = project_store::read_project(&path, &blf_path)?;
    let entry = project_store::QueryHistoryEntry {
        sql,
        target_signal_ids,
        respect_trim,
        ran_at: now_ms(),
        match_count,
    };
    project_store::write_project(&path, &project_store::push_query(project, entry))
}

#[tauri::command]
fn remove_query(blf_path: String, sql: String) -> Result<(), String> {
    let path = project_path_for(&blf_path);
    let project = project_store::read_project(&path, &blf_path)?;
    project_store::write_project(&path, &project_store::remove_query(project, &sql))
}

#[tauri::command]
fn clear_query_history(blf_path: String) -> Result<(), String> {
    let path = project_path_for(&blf_path);
    let project = project_store::read_project(&path, &blf_path)?;
    project_store::write_project(&path, &project_store::clear_query_history(project))
}
```

(Note these four commands drop their old unused `app: tauri::AppHandle` parameter - Tauri injects/omits that automatically on the JS side, so no frontend call site changes.)

Add the stale-file guard - a `delete_project_file` helper mirroring the existing `delete_trace_store_file` (near it, ~line 489):

```rust
/// Deletes `<stem>.fastrace-project.json` for `blf_path`, if present. Missing
/// file is not an error - same contract as `delete_trace_store_file`.
fn delete_project_file(blf_path: &str) -> Result<(), String> {
    let path = project_store::project_file_path(std::path::Path::new(blf_path));
    match std::fs::remove_file(&path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}
```

Call it in three places:

1. In `prepare_trace` (line ~108-134), right after `begin_prepare` succeeds and before the `blf_path` move into the `spawn_blocking` closure - a re-Prepare must not leave a Project file whose `downsampling_algorithms` keys point at the old, now-reassigned `signal_id`s:

```rust
    let bin = begin_prepare(app.state::<PrepareGuard>().inner(), fastrace_parse_bin())?;
    delete_project_file(&blf_path)?;
    let app_for_task = app.clone();
```

2. In `delete_trace_store` (line ~498-501):

```rust
#[tauri::command]
fn delete_trace_store(blf_path: String) -> Result<(), String> {
    delete_project_file(&blf_path)?;
    delete_trace_store_file(&blf_path)
}
```

3. In `remove_recent_trace` (line ~762-767):

```rust
#[tauri::command]
fn remove_recent_trace(app: tauri::AppHandle, blf_path: String) -> Result<(), String> {
    delete_trace_store_file(&blf_path)?;
    delete_project_file(&blf_path)?;
    let path = recent_traces_path(&app)?;
    let list = read_recent_traces(&path)?;
    write_recent_traces(&path, &remove_recent(list, &blf_path))
}
```

Add `get_project, save_project` to the `tauri::generate_handler![...]` list (the four Query History commands are already registered there - leave those four lines as-is).

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test --manifest-path app/src-tauri/Cargo.toml`
Expected: PASS (full `fastrace-app` suite)

- [ ] **Step 5: Format, lint, commit**

```bash
cargo fmt --manifest-path crates/Cargo.toml
git add app/src-tauri/Cargo.toml app/src-tauri/src/main.rs
git commit -m "feat(app): back Query History with the Project file, add Displayed Signal/Trim Window/algorithm persistence"
```

---

### Task 3: Frontend API layer

**Files:**
- Modify: `app/ui/src/shared/api/trace-source.ts`
- Modify: `app/ui/src/shared/api/hooks.ts`

**Interfaces:**
- Consumes: Tauri commands from Task 2.
- Produces: `export interface ProjectFile { version: number; traces: { path: string; downsamplingAlgorithms: Record<number, string> }[]; displayedSignalIds: number[]; trimWindow: { startUs: number; endUs: number } | null; queryHistory: QueryHistoryEntry[]; }`, `TraceDataSource.getProject(blfPath)`, `.saveProject(blfPath, signalIds, trimWindow, downsamplingAlgorithms)`.

No new test file - same reasoning as Plan 1 Task 6 (pure `invoke` plumbing, no branching logic); exercised by Task 4/5's manual verification.

- [ ] **Step 1: Add the type and interface methods**

In `app/ui/src/shared/api/trace-source.ts`, near `QueryHistoryEntry`:

```ts
export interface ProjectFile {
  version: number;
  traces: { path: string; downsamplingAlgorithms: Record<number, string> }[];
  displayedSignalIds: number[];
  trimWindow: { startUs: number; endUs: number } | null;
  queryHistory: QueryHistoryEntry[];
}
```

Add to `TraceDataSource` (near `listQueryHistory`):

```ts
  getProject(blfPath: string): Promise<ProjectFile>;
  saveProject(
    blfPath: string,
    signalIds: number[],
    trimWindow: { startUs: number; endUs: number } | null,
    downsamplingAlgorithms: Record<number, string>
  ): Promise<void>;
```

- [ ] **Step 2: Implement on `TauriTraceDataSource`**

Add near `listQueryHistory`'s implementation. A single command call so the backend does one `read_project`/`write_project` cycle per autosave tick, not three concurrent ones:

```ts
  getProject(blfPath: string): Promise<ProjectFile> {
    return invoke<ProjectFile>("get_project", { blfPath });
  }

  saveProject(
    blfPath: string,
    signalIds: number[],
    trimWindow: { startUs: number; endUs: number } | null,
    downsamplingAlgorithms: Record<number, string>
  ): Promise<void> {
    return invoke<void>("save_project", {
      blfPath,
      displayedSignalIds: signalIds,
      trimWindow,
      downsamplingAlgorithms,
    });
  }
```

- [ ] **Step 3: Add the hooks**

In `app/ui/src/shared/api/hooks.ts`, near the existing `useQueryHistory`/`useRecordQuery` hooks, add:

```ts
export function useProject(blfPath: string) {
  return useQuery({
    queryKey: ["project", blfPath],
    queryFn: () => getTraceDataSource().getProject(blfPath),
  });
}
```

(`saveProject` is called directly, not via `useMutation`, from the autosave effect in Task 5 - see that task for why.)

- [ ] **Step 4: Typecheck**

Run: `npm run build --prefix app/ui`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add app/ui/src/shared/api/trace-source.ts app/ui/src/shared/api/hooks.ts
git commit -m "feat(ui): add Project file API client and useProject hook"
```

---

### Task 4: Load the Project when a Trace opens

**Files:**
- Modify: `app/ui/src/widgets/WorkspaceLayout.tsx`

**Interfaces:**
- Consumes: `useProject` (Task 3), `useSignalCatalog` (existing, for the unknown-signal-id filter), `WorkspaceState.commitActiveSignalIds`, `.commitTrimRange`, `.setSignalDownsamplingAlgorithm` (existing/Plan 1 Task 8).

No new test file - React effect wiring in a component with no render-test infrastructure (same reasoning as Plan 1 Task 9); verified manually in Task 6.

- [ ] **Step 1: Seed the store once per opened Trace**

Inside the `WorkspaceLayout` function body, near its other hook calls:

```tsx
  const project = useProject(blfPath);
  const catalog = useSignalCatalog(blfPath);
  const seededRef = useRef<string | null>(null);

  useEffect(() => {
    if (seededRef.current === blfPath) return; // already seeded for this Trace

    if (project.isError) {
      // Fatal Project-file read error (corrupt/truncated JSON). The global
      // QueryCache error handler (app/ui/src/app/query-client.ts) already
      // toasts this in the existing bottom-right stack - nothing more to
      // show here. Reset to defaults by just not restoring anything, and
      // mark seeded so the autosave effect (Task 5) takes over and
      // overwrites the broken file with valid JSON on the next change.
      seededRef.current = blfPath;
      return;
    }

    if (!project.data || !catalog.data) return;
    seededRef.current = blfPath;

    const knownIds = new Set(catalog.data.map((c) => c.signalId));
    const restoredSignals = new Set(project.data.displayedSignalIds.filter((id) => knownIds.has(id)));
    if (restoredSignals.size > 0) {
      useWorkspaceStore.getState().commitActiveSignalIds(restoredSignals);
    }

    if (project.data.trimWindow) {
      useWorkspaceStore
        .getState()
        .commitTrimRange({ start: project.data.trimWindow.startUs, end: project.data.trimWindow.endUs });
    }

    const [trace] = project.data.traces;
    if (trace) {
      for (const [signalIdStr, algorithm] of Object.entries(trace.downsamplingAlgorithms)) {
        if (algorithm === "min_max" || algorithm === "lttb") {
          useWorkspaceStore.getState().setSignalDownsamplingAlgorithm(Number(signalIdStr), algorithm);
        }
      }
    }
  }, [project.data, project.isError, catalog.data, blfPath]);
```

Add `useEffect, useRef` to the existing React import if not already present, and `useProject` to the existing `@/shared/api/hooks` import.

- [ ] **Step 2: Typecheck**

Run: `npm run build --prefix app/ui`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add app/ui/src/widgets/WorkspaceLayout.tsx
git commit -m "feat(ui): restore Displayed Signals, Trim Window, and algorithm choice from the Project on open"
```

---

### Task 5: Autosave the Project, debounced

**Files:**
- Modify: `app/ui/src/widgets/WorkspaceLayout.tsx`

**Interfaces:**
- Consumes: `createDebouncer` (Plan 1 Task 7), `WorkspaceState.activeSignalIds`, `.appliedTrimRange`, `.signalDownsamplingAlgorithms`, `TauriTraceDataSource.saveProject` (Task 3).

No new test file - same reasoning as Task 4. Verified manually in Task 6.

- [ ] **Step 1: Add the debounced autosave effect**

Add, after the seeding effect from Task 4:

```tsx
  const activeSignalIds = useWorkspaceStore((s) => s.activeSignalIds);
  const appliedTrimRange = useWorkspaceStore((s) => s.appliedTrimRange);
  const signalDownsamplingAlgorithms = useWorkspaceStore((s) => s.signalDownsamplingAlgorithms);
  const saveDebouncerRef = useRef(
    createDebouncer(
      1000,
      (path: string, signalIds: number[], trim: TrimRange | null, algos: Record<number, "min_max" | "lttb">) => {
        // One call, one backend read-modify-write cycle - firing three
        // separate fire-and-forget commands here would race each other's
        // read and lose whichever write landed on the stalest state.
        void getTraceDataSource().saveProject(
          path,
          signalIds,
          trim ? { startUs: trim.start, endUs: trim.end } : null,
          algos
        );
      }
    )
  );

  useEffect(() => {
    if (seededRef.current !== blfPath) return; // don't autosave until the initial load has applied
    saveDebouncerRef.current.call(blfPath, Array.from(activeSignalIds), appliedTrimRange, signalDownsamplingAlgorithms);
  }, [blfPath, activeSignalIds, appliedTrimRange, signalDownsamplingAlgorithms]);

  useEffect(() => () => saveDebouncerRef.current.cancel(), []);
```

Add `createDebouncer` (from `../widgets/debounce`, Plan 1 Task 7), `getTraceDataSource`, and `type TrimRange` (from `@/app/store`) to `WorkspaceLayout.tsx`'s imports.

- [ ] **Step 2: Typecheck and run the full frontend suite**

Run: `npm run build --prefix app/ui && npm run test --prefix app/ui`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add app/ui/src/widgets/WorkspaceLayout.tsx
git commit -m "feat(ui): autosave Displayed Signals, Trim Window, and algorithm choice to the Project"
```

---

### Task 6: End-to-end manual verification

**Files:** none (verification only)

- [ ] **Step 1: Build and test everything**

```bash
cargo build --manifest-path crates/Cargo.toml
cargo build --manifest-path app/src-tauri/Cargo.toml
npm run build --prefix app/ui
cargo test --manifest-path crates/Cargo.toml
cargo test --manifest-path app/src-tauri/Cargo.toml
npm run test --prefix app/ui
```

Expected: all PASS.

- [ ] **Step 2: Verify restore-on-reopen**

Run `cargo tauri dev --manifest-path app/src-tauri/Cargo.toml`. Open a Trace, display two signals, set one to LTTB via the picker, set a Trim Window, run a Detector Query. Close the project (File > Close Project) and reopen the same Trace from Recents. Confirm: the same two signals are displayed, the LTTB choice is still set on the right one, the Trim Window is restored, and the Detector Query appears in Query History.

- [ ] **Step 3: Verify re-Prepare resets the Project**

With the same Trace open and state restored, re-run Prepare on it (e.g. via whatever UI re-triggers `prepare_trace` for an already-prepared Trace). After it completes, confirm `<stem>.fastrace-project.json` next to the `.duckdb` reflects a fresh/default state (inspect the file directly, or confirm the UI shows no displayed signals / no Trim Window on next open) - this is the re-Prepare staleness fix from Task 2 Step 3.

- [ ] **Step 4: Verify graceful handling of a corrupt Project file**

With the app closed, manually edit `<stem>.fastrace-project.json` to contain invalid JSON (e.g. `{broken`). Reopen that Trace. Confirm the app does not hang or show a blank error screen - it should still open the Trace with default state (no Displayed Signals, no Trim Window), and a toast error appears in the existing bottom-right stack (same mechanism as any other failed query) rather than the error being silently lost. Then make any change (e.g. toggle a Displayed Signal) and confirm, after the debounce, that `<stem>.fastrace-project.json` now contains valid JSON again - the autosave healed the broken file.

- [ ] **Step 5: Confirm Query History's existing UI still works unchanged**

In the Analyzer panel, run a query, confirm it appears in the history list, remove it, confirm it's gone, clear history, confirm the list empties - exactly as before, now backed by the Project file instead of `recent_traces.json`.
