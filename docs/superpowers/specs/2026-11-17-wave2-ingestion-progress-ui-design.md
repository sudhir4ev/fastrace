# Wave 2: Tauri ingestion-progress UI

## Context

Wave 1 (branch `wave1-ingest-pipeline`) ported the whole BLF -> DuckDB pipeline into
`native/store`/`native/cli`, with `crates/sidecar::spawn` able to run `fastrace_parse
prepare` and parse its stdout progress protocol. `app/ui` is still the Tauri scaffold
placeholder. Wave 2 builds the first real screens: pick a BLF + ARXML, run Prepare, watch
it live, see a result summary.

`crates/trace-store` and `crates/query` are currently stubs (no DuckDB access from Rust -
a deliberate Wave 1 scope cut). This wave un-stubs them, scoped to exactly what the summary
screen needs: open the just-written Trace Store read-only and run a handful of aggregate
queries. No signal catalog, no `decode-signals`, no charting library - those stay
"coming soon" placeholders behind disabled tabs.

## Screens and flow

```
Welcome  --Start Processing-->  Progress  --done-->  Summary (3 tabs)
   ^                                |                    |
   |                                v                    |
   +------------------- error (retry) <-------------------+
   ^                                                      |
   +---------------- "process another trace" -------------+
```

### Welcome screen

- Two independent pickers: "Choose BLF..." and "Choose ARXML...", each opening Tauri's
  native file-open dialog with an extension filter (`.blf` / `.arxml`). Order doesn't
  matter. Each button shows the chosen filename once set.
- "Start Processing" is disabled until both paths are set. No extra validation (extension
  filters in the dialog are enough) - matches AGENTS.md's YAGNI stance, nothing checks
  file existence/content client-side beyond what the OS dialog already guarantees.

### Progress screen

- Tauri command `prepare_trace(blf_path, arxml_path) -> Result<(), String>` runs
  `sidecar::spawn` on a background thread (`tauri::async_runtime::spawn_blocking`, since
  `spawn` blocks the calling thread until the child process exits) and forwards each
  `Progress` tick to the frontend via `window.emit("prepare-progress", tick)`.
- Frontend subscribes via `@tauri-apps/api/event`'s `listen("prepare-progress", ...)`.
- UI: an indeterminate activity indicator (no total message count is known until `done`,
  so no percentage) plus live numeric counters updated on each tick: containers, messages,
  elapsed time.
- On the final `{"done":true,...}` tick, transition to the Summary screen.
- On failure (nonzero exit / `{"error":...}` on stderr, surfaced as `Err(String)` from the
  command): show an inline error screen with the raw message and a "Try again" button that
  resets to the Welcome screen. No separate crash state.
- No client-side warning about overwriting an existing `<stem>.duckdb` - `fastrace_parse`
  already deletes stale output on start (Wave 1 fail-fast cleanup); this wave doesn't add a
  second confirmation on top of it.

### Summary screen

- New Tauri command `get_trace_summary(blf_path: String) -> Result<TraceSummary, String>`,
  called by the frontend once it receives `done`. It derives the `.duckdb` path from the
  BLF path (same `replace_extension(".duckdb")` rule as `fastrace_parse`), opens it
  read-only via `crates/trace-store`, and runs the aggregate queries below via
  `crates/query`.
- `crates/trace-store` un-stub: a function that opens `<stem>.duckdb` read-only and checks
  `schema_version` against the embedded expected value (mirrors the C++ side's embedded
  `kSchemaVersion`), returning a connection handle or an error if the version mismatches.
- `crates/query` un-stub: a function that takes a connection + SQL string and returns rows
  (shaped however is simplest for serializing into `TraceSummary` - no generic query
  builder, just enough to run the fixed queries below).
- `TraceSummary` fields, sourced as follows:
  - `messages`, `protocol_rows`, `elapsed_ms` - carried over directly from the `done` event
    (no need to re-derive via SQL).
  - Bus-type breakdown - `SELECT object_type, COUNT(*) FROM messages GROUP BY object_type`,
    bucketed client-side (or in the Rust command) into CAN vs Ethernet using the existing
    `BLFObjectType` enum values already known to `native/blf`/`crates/sidecar` boundary
    (CAN_MESSAGE/CAN_FD_MESSAGE -> CAN; ETHERNET_FRAME/_EX/_FORWARDED -> Ethernet).
  - Protocol-type breakdown - one `SELECT COUNT(*)` per `protocol_pdu`, `protocol_someip`,
    `protocol_someip_sd`, `protocol_doip`.
- Layout: three tabs.
  - **Summary** (live): the stats above.
  - **Signals** (disabled, "coming soon"): one combined placeholder covering both the
    future signal catalog and signal plots - no catalog query, no charting library this
    wave.
  - **Anomaly Detection** (disabled, "coming soon"): static placeholder, one line of
    descriptive text.
- "Process another trace" button resets the whole flow back to the Welcome screen.

## Explicitly out of scope this wave

- `arxml_signal` / `signals` schema (ADR 0005) and any schema_version bump.
- `decode-signals` real implementation (stays a CLI stub).
- Signal selection UI, signal catalog, any plotting/charting library.
- Tauri `externalBin` sidecar bundling/packaging - `fastrace_parse_bin()` keeps resolving
  via `FASTRACE_PARSE_BIN` env var / relative dev-build path, dev-mode only.

## Files touched (expected)

- `app/src-tauri/src/main.rs` - `prepare_trace` reworked to run on a background thread and
  emit progress events; new `get_trace_summary` command.
- `app/src-tauri/Cargo.toml` - add `duckdb` dependency (bundled feature, pinned 1.1.3) for
  `crates/trace-store`'s use, if not already present at the crate level.
- `crates/trace-store/Cargo.toml`, `crates/trace-store/src/lib.rs` - real read-only open +
  `schema_version` check.
- `crates/query/Cargo.toml`, `crates/query/src/lib.rs` - real SQL execution against an open
  connection.
- `app/ui/src/` - Welcome, Progress, Summary (3-tab) screens/components; event listener
  wiring; `@tauri-apps/api` dialog + event usage.
- `app/ui/package.json` - add Tauri dialog plugin dependency if not already present.

## Verification

- Manual: `cargo tauri dev`, pick the committed Wave 1 fixture (`native/store/test/fixtures/
  fixture.blf` + `fixture.arxml`), click Start Processing, watch live counters update, land
  on the Summary tab with correct counts (cross-checked against the known fixture row
  counts documented in `native/store/README.md`), confirm Signals/Anomaly Detection tabs
  render disabled.
- Manual: point at a nonexistent/garbage path (if reachable past the dialog) or a BLF that
  fails to parse, confirm the error screen shows and "Try again" returns to Welcome.
- `cargo test --manifest-path crates/Cargo.toml` passes with `trace-store`/`query`'s new
  real tests (open a fixture `.duckdb`, check `schema_version`, run one known-count query).
