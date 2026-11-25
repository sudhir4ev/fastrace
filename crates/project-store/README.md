# project-store

Reads/writes the Project file (`<stem>.fastrace-project.json`), the persisted,
resumable per-Trace UI state (`docs/adr/0010`). No Tauri knowledge, no DuckDB.

## Build / test

```bash
cargo test --manifest-path crates/Cargo.toml -p project-store
cargo fmt --manifest-path crates/Cargo.toml
cargo clippy --manifest-path crates/Cargo.toml -p project-store
```

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
