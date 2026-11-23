# query

Read-only DuckDB queries against an opened Trace Store. No Tauri knowledge, no
BLF/ARXML parsing. Owns Detector Query execution, anomaly-bin aggregation, and
signal-coverage precondition checks (`docs/adr/0003`, `docs/adr/0008`).

## Build / test

```bash
cargo test --manifest-path crates/Cargo.toml -p query
cargo fmt --manifest-path crates/Cargo.toml
cargo clippy --manifest-path crates/Cargo.toml -p query
```

## Notable APIs

| Function | Role |
|----------|------|
| `run_detector_query` | Wraps user SQL, extracts `msg_id`/`timestamp_us` Matches (capped), and returns 500 anomaly bins over the scope |
| `missing_signal_coverage` | Lists Target Signals whose `signal_coverage` does not fully cover the scope |
| `compute_anomaly_bins` | SQL aggregate of scoped Matches into `ANOMALY_BIN_COUNT` (500) bins |
| `list_signal_coverage` | Per-signal decoded extents |
| `get_trace_time_range` | Full-trace `[min, max]` timestamp for whole-trace scope resolution |

The Tauri adapter in `app/src-tauri` resolves the respect-trim flag into a scope,
calls `missing_signal_coverage`, and returns either `needsDecode` or `ran`.
