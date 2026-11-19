# Trim Window Wave 2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the Timeline chart's axis/zoom to actually track the applied Trim Window, add a time-vs-message-ordinal strategy toggle to the trim slider (rendered as one dual-handle Radix slider instead of two independent `<input type="range">`s), and widen trim-scoping to `get_trace_summary`, `get_message_detail`, and (via a new native `signal-stats` recompute) `list_signal_catalog`.

**Architecture:** The message-ordinal strategy never reaches the query layer - `TrimControl` resolves ordinal positions to `timestamp_us` via one new tiny query only at Apply time, then feeds the existing `appliedTrimRange` (`{start, end}` in `timestamp_us`) exactly as before. Widening scope to `get_trace_summary`/`get_message_detail` is pure SQL-bound-widening, identical in shape to Wave 1's `list_message_groups`. `list_signal_catalog`'s `signal_stats` numbers need a genuinely new native capability (a bounded recompute, reusing `SignalStatsTracker`/`writeSignalStats` verbatim) since they're a Prepare-time whole-trace aggregate with no per-window variant today.

**Tech Stack:** C++23/CMake (`native/`), Rust/DuckDB (`crates/`), Tauri `#[tauri::command]` (`app/src-tauri`), React/TypeScript/Vite + Zustand + TanStack Query + Radix UI (`app/ui`).

**Spec:** `/Users/sudhir/.claude/plans/replicated-crunching-pancake.md` (the approved plan from this session's plan-mode exchange - read it in full; this document breaks it into TDD tasks). Builds on Wave 1's plan, `docs/superpowers/plans/2026-11-19-prepare-workspace-trim.md`, and `CONTEXT.md`'s existing Trim Window/Read Payloads entries.

## Global Constraints

- `appliedTrimRange` stays exactly `{start: number, end: number}` in `timestamp_us` - the message-ordinal strategy is a `TrimControl`-local UI concern, resolved to timestamps only at Apply time via `resolveMessagePosition`. No other file gains a "strategy" concept.
- `get_trace_time_range` and the new `count_messages` stay **unbound** (full-trace, by design) - they define the slider's own outer bounds, not something to be scoped by itself.
- `list_ecus` is **explicitly out of scope** this wave (`arxml_ecu` has no column linking it to any CAN id/PDU/message - no SQL path exists). Left as the static, full-trace ARXML dictionary it already is.
- The new `signal-stats` native subcommand's `DELETE FROM signal_stats` is a full-table delete (every signal's aggregate changes on any rewindow), not the per-signal delete `decode-signals` uses - do not reuse `decode-signals`'s idList-scoped DELETE pattern here.
- `WorkspaceLayout`'s Apply flow must **sequence** (not parallelize) the stats recompute and the signal re-decode - both hold the native `PrepareGuard` write lock, so running them concurrently makes the second spuriously fail with "a Prepare run is already in progress."
- No FE test runner exists in this repo (confirmed in Wave 1) - frontend tasks verify via `npx tsc --noEmit -p app/ui` + `npm run build`, not a red/green unit test cycle. Rust and native C++ changes still follow strict TDD.

## Review Focus

- **`resolve_message_position` off-by-one at the trace's first and last message** - position `1` must resolve to the earliest `timestamp_us`, position `count_messages()` to the latest; an off-by-one here would silently narrow the message-mode trim by one message at either edge. Covered in Task 1.
- **Switching trim strategy mid-session must not silently apply a stale window** - re-priming to the full range on every strategy switch (not reverse-mapping) must actually require a fresh Apply before `appliedTrimRange` changes; a reasonable person toggling "Time ↔ Message" and clicking around should never have their data silently re-scoped without pressing Apply. Covered in Task 8's manual-verification note (no FE test runner to automate this).
- **`get_trace_summary`'s four joined protocol counts must match the equivalent unjoined full-trace count when the trim window is the full span** - a join-based rewrite of a previously-unconditional count is exactly the kind of change that can silently double-count or drop rows (e.g. a bad join cardinality) without an explicit regression test. Covered in Task 2.
- **`signal-stats`'s full-table `DELETE FROM signal_stats` must leave exactly one row per `arxml_signal` after a successful recompute** - since every signal's row is deleted and rewritten (not per-requested-signal like `decode-signals`), a partial failure mid-write could leave fewer rows than `arxml_signal` has entries. Covered in Task 3's integration test.
- **A Prepare failure or missing-store error during `recompute_signal_stats`/`count_messages`/`resolve_message_position` must surface through the existing toast/error UI, not silently no-op** - these are new Tauri commands added to an app that already has an established error-surfacing convention (`onError: (e) => useToastStore.getState().pushError(String(e))` on mutations, `isError` branches on queries); a new command that forgets this would be a silent failure mode. Covered in Task 5.

---

### Task 1: Rust `crates/query` - `count_messages`, `resolve_message_position`, bound `get_message_detail`

**Files:**
- Modify: `crates/query/src/lib.rs`

**Interfaces:**
- Produces: `count_messages(conn: &trace_store::Connection) -> Result<i64, String>`, `resolve_message_position(conn: &trace_store::Connection, position: i64) -> Result<i64, String>`, `get_message_detail(conn, msg_id: i64, start_us: i64, end_us: i64) -> Result<MessageRow, String>` (widened signature). Task 2's Tauri commands call all three.

- [ ] **Step 1: Write the failing tests**

Add to `crates/query/src/lib.rs`'s test module (the `setup()` fixture has messages at `timestamp_us` 1000/2000/3000/4000 across msg_id 1-4):

```rust
    #[test]
    fn count_messages_returns_total_row_count() {
        let conn = setup();
        assert_eq!(count_messages(&conn).unwrap(), 4);
    }

    #[test]
    fn resolve_message_position_maps_first_and_last_position() {
        let conn = setup();
        assert_eq!(resolve_message_position(&conn, 1).unwrap(), 1000, "position 1 is the earliest message");
        assert_eq!(resolve_message_position(&conn, 4).unwrap(), 4000, "position 4 is the latest message");
    }

    #[test]
    fn resolve_message_position_errors_when_out_of_range() {
        let conn = setup();
        assert!(resolve_message_position(&conn, 5).is_err());
    }

    #[test]
    fn resolve_message_position_rejects_position_below_one() {
        let conn = setup();
        assert!(resolve_message_position(&conn, 0).is_err());
    }

    #[test]
    fn get_message_detail_errors_when_outside_trim_bound() {
        let conn = setup();
        // msg_id 1 is at timestamp_us 1000 - a bound of [2000, 4000] excludes it.
        assert!(get_message_detail(&conn, 1, 2000, 4000).is_err());
    }
```

- [ ] **Step 2: Run to verify it fails**

```bash
cargo test --manifest-path crates/Cargo.toml -p query
```

Expected: FAIL (compile errors - `count_messages`/`resolve_message_position` don't exist yet, `get_message_detail` takes 2 args not 4, and the existing `get_message_detail_returns_row_by_id`/`get_message_detail_errors_when_missing` tests will also fail to compile until Step 3's signature change is matched in Step 4).

- [ ] **Step 3: Implement**

Add near the top of the file, after `count`:

```rust
/// Total row count of `messages` - backs the message-ordinal trim slider's
/// max bound. Not trim-bound itself (it must report the trace's full count
/// regardless of the currently applied window, same as get_trace_time_range).
pub fn count_messages(conn: &trace_store::Connection) -> Result<i64, String> {
    conn.query_row("select count(*) from messages", [], |row| row.get(0))
        .map_err(|e| e.to_string())
}

/// Resolves a 1-based ordinal position (1..=count_messages) to that message's
/// timestamp_us, by msg_id order (msg_id assignment order matches time order -
/// Prepare assigns ids sequentially while iterating the BLF in time order).
/// position 1 maps to the earliest message's timestamp.
pub fn resolve_message_position(conn: &trace_store::Connection, position: i64) -> Result<i64, String> {
    if position < 1 {
        return Err(format!("message position must be >= 1, got {position}"));
    }
    conn.query_row(
        "select timestamp_us from messages order by msg_id limit 1 offset ?",
        duckdb::params![position - 1],
        |row| row.get(0),
    )
    .map_err(|e| format!("position {position} not found: {e}"))
}
```

Widen `get_message_detail`:

```rust
pub fn get_message_detail(
    conn: &trace_store::Connection,
    msg_id: i64,
    start_us: i64,
    end_us: i64,
) -> Result<MessageRow, String> {
    let sql = format!(
        "select msg_id, timestamp_us,
                case when object_type in ({CAN_OBJECT_TYPES}) then 'CAN' else 'Ethernet' end as bus_label,
                case when object_type in ({CAN_OBJECT_TYPES}) then cast(arb_id as varchar)
                     else coalesce(dst_ip,'') || ':' || cast(coalesce(dst_port,0) as varchar) end as id_or_src,
                cast(null as varchar) as name,
                dlc, payload_len
         from messages where msg_id = ? and timestamp_us between ? and ?"
    );
    conn.query_row(&sql, duckdb::params![msg_id, start_us, end_us], map_message_row)
        .map_err(|e| format!("message {msg_id} not found: {e}"))
}
```

- [ ] **Step 4: Fix the now-stale existing `get_message_detail` call sites in tests**

```rust
    #[test]
    fn get_message_detail_returns_row_by_id() {
        let conn = setup();
        let detail = get_message_detail(&conn, 1, 0, 10_000).unwrap();
        assert_eq!(detail.bus_label, "CAN");
        assert_eq!(detail.id_or_src, "100");
    }

    #[test]
    fn get_message_detail_errors_when_missing() {
        let conn = setup();
        assert!(get_message_detail(&conn, 999, 0, 10_000).is_err());
    }
```

- [ ] **Step 5: Run to verify it passes**

```bash
cargo test --manifest-path crates/Cargo.toml -p query
```

Expected: PASS, all tests including the 5 new ones.

- [ ] **Step 6: Format, lint, commit**

```bash
cargo fmt --manifest-path crates/Cargo.toml
cargo clippy --manifest-path crates/Cargo.toml -p query
git add crates/query/src/lib.rs
git commit -m "feat(query): add count_messages/resolve_message_position, bound get_message_detail"
```

---

### Task 2: Tauri `app/src-tauri` - bound `get_trace_summary`/`get_message_detail`, add `count_messages`/`resolve_message_position` commands

**Files:**
- Modify: `app/src-tauri/src/main.rs`

**Interfaces:**
- Consumes: Task 1's `count_messages`, `resolve_message_position`, widened `get_message_detail`.
- Produces: `get_trace_summary(blf_path, start_us: i64, end_us: i64)`, `get_message_detail(blf_path, msg_id, start_us: i64, end_us: i64)`, `count_messages(blf_path)`, `resolve_message_position(blf_path, position: i64)`. Task 5's frontend calls all four.

- [ ] **Step 1: Write the failing unit test**

There's no existing direct unit test of `get_trace_summary`'s SQL shape in `main.rs` (it's exercised only via the fixture-level `fastrace_store_fixture_prepare` ctest indirectly through the UI, not a Rust unit test) - add one exercising the bounded join logic directly against an in-memory store, mirroring the style of `crates/query`'s own `setup()`-based tests but living here since `get_trace_summary`'s SQL-building is local to this file:

```rust
    #[test]
    fn get_trace_summary_bounds_protocol_counts_via_join() {
        let conn = trace_store::Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE messages (msg_id BIGINT, timestamp_us BIGINT, object_type INTEGER, arb_id INTEGER, dst_ip VARCHAR, dst_port INTEGER);
             CREATE TABLE protocol_pdu (msg_id BIGINT, pdu_id BIGINT, length BIGINT);
             CREATE TABLE protocol_someip (msg_id BIGINT);
             CREATE TABLE protocol_someip_sd (msg_id BIGINT);
             CREATE TABLE protocol_doip (msg_id BIGINT);
             INSERT INTO messages VALUES (1, 1000, 1, 100, NULL, NULL);
             INSERT INTO messages VALUES (2, 2000, 1, 100, NULL, NULL);
             INSERT INTO protocol_pdu VALUES (1, 1, 4), (2, 1, 4);",
        )
        .unwrap();
        let bounded = query::count(
            &conn,
            "select count(*) from protocol_pdu p join messages m on m.msg_id = p.msg_id where m.timestamp_us between 1000 and 1000",
        )
        .unwrap();
        assert_eq!(bounded, 1, "only msg_id=1's protocol_pdu row is inside [1000,1000]");
        let unbounded = query::count(
            &conn,
            "select count(*) from protocol_pdu p join messages m on m.msg_id = p.msg_id where m.timestamp_us between 0 and 10000",
        )
        .unwrap();
        assert_eq!(unbounded, 2, "both rows are inside the full span - the join doesn't drop/double-count rows");
    }
```

- [ ] **Step 2: Run to verify it fails**

```bash
cargo test --manifest-path app/src-tauri/Cargo.toml get_trace_summary_bounds_protocol_counts_via_join
```

Expected: this specific test should actually PASS immediately since it only exercises `query::count` with literal SQL (no production code change needed for it to pass) - it's a pinning test for the join shape `get_trace_summary` will use, written first so Step 3's SQL is proven correct before it's wired into the command. Confirm it passes in isolation, then proceed to Step 3 to wire the equivalent SQL into `get_trace_summary` itself (the "RED" for the production code is the broader compile failure below).

- [ ] **Step 3: Implement**

```rust
#[tauri::command]
fn get_trace_summary(blf_path: String, start_us: i64, end_us: i64) -> Result<TraceSummary, String> {
    let duckdb_path = std::path::Path::new(&blf_path).with_extension("duckdb");
    let conn = trace_store::open(&duckdb_path)?;
    Ok(TraceSummary {
        can_messages: query::count(
            &conn,
            &format!(
                "select count(*) from messages where object_type in ({CAN_OBJECT_TYPES}) and timestamp_us between {start_us} and {end_us}"
            ),
        )?,
        ethernet_messages: query::count(
            &conn,
            &format!(
                "select count(*) from messages where object_type in ({ETHERNET_OBJECT_TYPES}) and timestamp_us between {start_us} and {end_us}"
            ),
        )?,
        protocol_pdu: query::count(
            &conn,
            &format!(
                "select count(*) from protocol_pdu p join messages m on m.msg_id = p.msg_id where m.timestamp_us between {start_us} and {end_us}"
            ),
        )?,
        protocol_someip: query::count(
            &conn,
            &format!(
                "select count(*) from protocol_someip p join messages m on m.msg_id = p.msg_id where m.timestamp_us between {start_us} and {end_us}"
            ),
        )?,
        protocol_someip_sd: query::count(
            &conn,
            &format!(
                "select count(*) from protocol_someip_sd p join messages m on m.msg_id = p.msg_id where m.timestamp_us between {start_us} and {end_us}"
            ),
        )?,
        protocol_doip: query::count(
            &conn,
            &format!(
                "select count(*) from protocol_doip p join messages m on m.msg_id = p.msg_id where m.timestamp_us between {start_us} and {end_us}"
            ),
        )?,
    })
}

#[tauri::command]
fn get_message_detail(blf_path: String, msg_id: i64, start_us: i64, end_us: i64) -> Result<query::MessageRow, String> {
    let duckdb_path = std::path::Path::new(&blf_path).with_extension("duckdb");
    let conn = trace_store::open(&duckdb_path)?;
    query::get_message_detail(&conn, msg_id, start_us, end_us)
}

#[tauri::command]
fn count_messages(blf_path: String) -> Result<i64, String> {
    let duckdb_path = std::path::Path::new(&blf_path).with_extension("duckdb");
    let conn = trace_store::open(&duckdb_path)?;
    query::count_messages(&conn)
}

#[tauri::command]
fn resolve_message_position(blf_path: String, position: i64) -> Result<i64, String> {
    let duckdb_path = std::path::Path::new(&blf_path).with_extension("duckdb");
    let conn = trace_store::open(&duckdb_path)?;
    query::resolve_message_position(&conn, position)
}
```

Register `count_messages` and `resolve_message_position` in `tauri::generate_handler![...]` (alongside the existing `get_trace_summary`/`get_message_detail` entries, which keep their names).

- [ ] **Step 4: Run to verify it passes**

```bash
cargo test --manifest-path app/src-tauri/Cargo.toml
```

Expected: PASS, including the new `get_trace_summary_bounds_protocol_counts_via_join` test and every pre-existing test.

- [ ] **Step 5: Format and commit**

```bash
cargo fmt --manifest-path crates/Cargo.toml
git add app/src-tauri/src/main.rs
git commit -m "feat(tauri): bound get_trace_summary/get_message_detail, add count_messages/resolve_message_position"
```

---

### Task 3: Native - `signal-stats` recompute subcommand

**Files:**
- Modify: `native/cli/src/main.cpp`
- Create: `native/store/test/run_signal_stats_bounds.cmake`
- Modify: `native/store/CMakeLists.txt`

**Interfaces:**
- Consumes: `fastrace::SignalStatsTracker`, `fastrace::ArxmlParser::parseFile`, `fastrace::BlfIngestReader`, the existing `writeSignalStats(Db&, const SignalStatsTracker&)` helper (all unchanged), `queryMetaString` (existing helper).
- Produces: `fastrace_parse signal-stats <trace.blf> <start_us> <end_us>`. Task 4's Tauri command spawns it.

- [ ] **Step 1: Write the failing integration test**

The fixture (`native/store/test/fixtures/fixture.blf`/`.arxml`) has one scaled signal, EngineRpm (signal_id 0), parented to CAN id 0x100, which fires once at `timestamp_us=1` (per Wave 1's `decode_bounds_check.cpp` comment). `signal_stats` after a full-trace Prepare has exactly 1 row (`arxml_signal` has exactly 1 row) with `samples=1`. Create `native/store/test/run_signal_stats_bounds.cmake`:

```cmake
# Verifies the new `signal-stats` subcommand: narrowing the window to exclude
# the fixture's one CAN message (timestamp_us=1) must drop EngineRpm's
# recomputed `samples` to 0; widening back to include it must restore 1; and
# signal_stats must always have exactly one row per arxml_signal (the
# full-table DELETE-then-rewrite must never leave a partial row set).
file(MAKE_DIRECTORY "${OUT_DIR}")
file(COPY "${FIXTURE_BLF}" "${FIXTURE_ARXML}" DESTINATION "${OUT_DIR}")
get_filename_component(_blf_name "${FIXTURE_BLF}" NAME)
get_filename_component(_arxml_name "${FIXTURE_ARXML}" NAME)
set(_out "${OUT_DIR}/fixture.duckdb")
file(REMOVE "${_out}" "${_out}.wal")

execute_process(COMMAND "${FASTRACE_PARSE}" prepare "${_blf_name}" "${_arxml_name}"
  WORKING_DIRECTORY "${OUT_DIR}" RESULT_VARIABLE _rv)
if(NOT _rv EQUAL 0)
  message(FATAL_ERROR "prepare exited with ${_rv}")
endif()

# Bound excludes timestamp_us=1 -> EngineRpm's samples recompute to 0.
execute_process(COMMAND "${FASTRACE_PARSE}" signal-stats "${_blf_name}" 100 200
  WORKING_DIRECTORY "${OUT_DIR}" RESULT_VARIABLE _rv)
if(NOT _rv EQUAL 0)
  message(FATAL_ERROR "signal-stats (excluding bound) exited with ${_rv}")
endif()
execute_process(COMMAND "${STATS_CHECK}" "${_out}" 0 0 1 RESULT_VARIABLE _rv)
if(NOT _rv EQUAL 0)
  message(FATAL_ERROR "signal_stats_bounds_check failed after excluding bound")
endif()

# Bound includes timestamp_us=1 -> EngineRpm's samples recompute to 1.
execute_process(COMMAND "${FASTRACE_PARSE}" signal-stats "${_blf_name}" 0 10
  WORKING_DIRECTORY "${OUT_DIR}" RESULT_VARIABLE _rv)
if(NOT _rv EQUAL 0)
  message(FATAL_ERROR "signal-stats (including bound) exited with ${_rv}")
endif()
execute_process(COMMAND "${STATS_CHECK}" "${_out}" 0 1 1 RESULT_VARIABLE _rv)
if(NOT _rv EQUAL 0)
  message(FATAL_ERROR "signal_stats_bounds_check failed after including bound")
endif()
```

Create `native/store/test/signal_stats_bounds_check.cpp` (mirrors `decode_bounds_check.cpp`'s style; checks both the recomputed `samples` value for one signal AND the total row count, pinning the "exactly one row per arxml_signal" invariant):

```cpp
// Checker for the fastrace_signal_stats_bounds ctest.
#include <cstdio>
#include <cstdlib>
#include <string>

#include <duckdb.h>

namespace {
int gFailures = 0;

int64_t queryInt(duckdb_connection con, const std::string& sql, const char* label)
{
    duckdb_result res;
    if (duckdb_query(con, sql.c_str(), &res) != DuckDBSuccess) {
        std::fprintf(stderr, "FAIL (%s): query failed: %s\n", label, duckdb_result_error(&res));
        duckdb_destroy_result(&res);
        ++gFailures;
        return -1;
    }
    const int64_t v = duckdb_value_int64(&res, 0, 0);
    duckdb_destroy_result(&res);
    return v;
}
} // namespace

int main(int argc, char** argv)
{
    if (argc != 5) {
        std::fprintf(stderr, "usage: %s <fixture.duckdb> <signal_id> <want_samples> <want_total_rows>\n", argv[0]);
        return 1;
    }
    duckdb_database db = nullptr;
    duckdb_connection con = nullptr;
    if (duckdb_open(argv[1], &db) == DuckDBError || duckdb_connect(db, &con) == DuckDBError) {
        std::fprintf(stderr, "FAIL: could not open %s\n", argv[1]);
        return 1;
    }
    const int64_t signalId = std::strtoll(argv[2], nullptr, 10);
    const int64_t wantSamples = std::strtoll(argv[3], nullptr, 10);
    const int64_t wantTotalRows = std::strtoll(argv[4], nullptr, 10);

    const int64_t gotSamples
        = queryInt(con, "select samples from signal_stats where signal_id = " + std::to_string(signalId) + ";", "samples");
    if (gotSamples != wantSamples) {
        std::fprintf(stderr, "FAIL: samples = %lld, want %lld\n", static_cast<long long>(gotSamples),
            static_cast<long long>(wantSamples));
        ++gFailures;
    }
    const int64_t gotTotalRows = queryInt(con, "select count(*) from signal_stats;", "total_rows");
    if (gotTotalRows != wantTotalRows) {
        std::fprintf(stderr, "FAIL: signal_stats row count = %lld, want %lld (one row per arxml_signal)\n",
            static_cast<long long>(gotTotalRows), static_cast<long long>(wantTotalRows));
        ++gFailures;
    }

    duckdb_disconnect(&con);
    duckdb_close(&db);
    if (gFailures > 0) {
        return 1;
    }
    std::printf("signal_stats_bounds_check: OK\n");
    return 0;
}
```

Append to `native/store/CMakeLists.txt` (near the `fastrace_decode_bounds_check` block added in Wave 1):

```cmake
add_executable(fastrace_signal_stats_check test/signal_stats_bounds_check.cpp)
target_link_libraries(fastrace_signal_stats_check PRIVATE duckdb::duckdb)
fastrace_copy_duckdb_runtime(fastrace_signal_stats_check)

add_test(NAME fastrace_signal_stats_bounds
  COMMAND ${CMAKE_COMMAND}
    -DFASTRACE_PARSE=$<TARGET_FILE:fastrace_parse>
    -DSTATS_CHECK=$<TARGET_FILE:fastrace_signal_stats_check>
    -DFIXTURE_BLF=${PROJECT_SOURCE_DIR}/store/test/fixtures/fixture.blf
    -DFIXTURE_ARXML=${PROJECT_SOURCE_DIR}/store/test/fixtures/fixture.arxml
    -DOUT_DIR=${CMAKE_CURRENT_BINARY_DIR}/signal_stats_bounds
    -P ${PROJECT_SOURCE_DIR}/store/test/run_signal_stats_bounds.cmake
)
```

- [ ] **Step 2: Run to verify it fails**

```bash
cmake -S . -B build && cmake --build build --target fastrace_signal_stats_check fastrace_parse
ctest --test-dir build -R fastrace_signal_stats_bounds --output-on-failure
```

Expected: FAIL - the `signal-stats` subcommand doesn't exist yet (`main()` falls through to "unknown subcommand", nonzero exit).

- [ ] **Step 3: Implement**

Insert into `native/cli/src/main.cpp` right after `writeSignalStats`'s closing brace (line ~323), before `runPrepare` (line ~325):

```cpp
// Recomputes signal_stats for every arxml_signal, bounded to [start_us, end_us]
// (docs: Trim Window). Unlike decode-signals' per-requested-signal DELETE,
// this clears the WHOLE table - every signal's aggregate changes on any
// rewindow, not just a requested subset - then rewrites it via the same
// writeSignalStats() helper Prepare uses, giving idempotent full-rewrite
// semantics on repeated Apply calls.
int runSignalStats(int argc, char** argv)
{
    if (argc < 5) {
        printError("usage: fastrace_parse signal-stats <trace.blf> <start_us> <end_us>");
        return 1;
    }
    const std::string blfPath = argv[2];
    const int64_t startUs = std::strtoll(argv[3], nullptr, 10);
    const int64_t endUs = std::strtoll(argv[4], nullptr, 10);

    const std::filesystem::path outPath = std::filesystem::path(blfPath).replace_extension(".duckdb");
    if (!std::filesystem::exists(outPath)) {
        printError("store not found, run prepare first: " + outPath.string());
        return 1;
    }
    if (!std::filesystem::exists(blfPath)) {
        printError("BLF not found: " + blfPath);
        return 1;
    }

    const auto wall0 = Clock::now();

    fastrace::Db db;
    if (!db.open(outPath.string())) {
        printError("could not open store: " + outPath.string());
        return 1;
    }

    std::string arxmlPath;
    if (!queryMetaString(db.con(), "source_arxml", arxmlPath) || arxmlPath.empty()) {
        printError("store has no ARXML loaded; re-run prepare with an ARXML file");
        return 1;
    }
    std::string blfSizeMeta;
    std::string blfMtimeMeta;
    if (!queryMetaString(db.con(), "blf_size", blfSizeMeta) || !queryMetaString(db.con(), "blf_mtime", blfMtimeMeta)) {
        printError("store is missing blf_size/blf_mtime meta; re-run prepare");
        return 1;
    }
    std::error_code statEc;
    const uint64_t curSize = std::filesystem::file_size(blfPath, statEc);
    const int64_t curMtime
        = static_cast<int64_t>(std::filesystem::last_write_time(blfPath, statEc).time_since_epoch().count());
    if (std::to_string(curSize) != blfSizeMeta || std::to_string(curMtime) != blfMtimeMeta) {
        printError("BLF changed since prepare; re-run prepare: " + blfPath);
        return 1;
    }

    const fastrace::ArDatabase arDb = fastrace::ArxmlParser::parseFile(arxmlPath);
    fastrace::SignalStatsTracker tracker(arDb);

    if (!db.exec("DELETE FROM signal_stats")) {
        printError("could not clear previous signal_stats before recompute");
        return 1;
    }

    uint64_t finalContainers = 0;
    uint64_t finalMessages = 0;
    uint64_t finalBytesRead = 0;
    uint64_t finalBytesTotal = 0;
    bool failed = false;

    fastrace::BlfIngestReader reader;
    auto lastProgress = Clock::now();
    uint64_t nextMsgId = 0;
    constexpr uint64_t kProgressEveryMessages = 10000;
    constexpr auto kProgressEveryMs = std::chrono::milliseconds(250);
    const bool ok = reader.visit(blfPath, [&](const fastrace::TraceMessage& msgIn) {
        if (failed) {
            return;
        }
        fastrace::TraceMessage msg = msgIn;
        ++nextMsgId;
        if (static_cast<int64_t>(msg.timestampUs) < startUs || static_cast<int64_t>(msg.timestampUs) > endUs) {
            return;
        }
        tracker.observe(msg);

        const auto now = Clock::now();
        if (nextMsgId % kProgressEveryMessages == 0 || now - lastProgress >= kProgressEveryMs) {
            printProgress(reader.stats().containers, nextMsgId, reader.stats().bytesRead, reader.stats().fileSizeBytes,
                std::chrono::duration_cast<std::chrono::milliseconds>(now - wall0).count());
            lastProgress = now;
        }
    });

    failed = failed || !ok || !writeSignalStats(db, tracker);
    if (!failed) {
        finalContainers = reader.stats().containers;
        finalMessages = reader.stats().messages;
        finalBytesRead = reader.stats().bytesRead;
        finalBytesTotal = reader.stats().fileSizeBytes;
    }

    const int64_t elapsedMs = std::chrono::duration_cast<std::chrono::milliseconds>(Clock::now() - wall0).count();
    if (failed) {
        printError("signal-stats failed: " + blfPath);
        return 1;
    }
    printDone(finalContainers, finalMessages, static_cast<uint64_t>(tracker.slots().size()), finalBytesRead,
        finalBytesTotal, elapsedMs);
    return 0;
}
```

Register in `main()`:

```cpp
    if (std::strcmp(argv[1], "signal-stats") == 0) {
        return runSignalStats(argc, argv);
    }
```

- [ ] **Step 4: Run to verify it passes**

```bash
cmake --build build --target fastrace_parse fastrace_signal_stats_check
ctest --test-dir build -R fastrace_signal_stats_bounds --output-on-failure
ctest --test-dir build -R "fastrace_decode_signals_bounds|fastrace_store_fixture_prepare" --output-on-failure  # guard against regressions
```

Expected: all PASS.

- [ ] **Step 5: Format, full suite, commit**

```bash
clang-format -i native/cli/src/main.cpp native/store/test/signal_stats_bounds_check.cpp  # verify the diff stays scoped to your own edits (Wave 1 found clang-format can reformat unrelated pre-existing lines - revert and hand-apply only your own lines if so)
ctest --test-dir build --output-on-failure  # whole native suite
git add native/cli/src/main.cpp native/store/test/signal_stats_bounds_check.cpp native/store/test/run_signal_stats_bounds.cmake native/store/CMakeLists.txt
git commit -m "feat(cli): add signal-stats subcommand to recompute signal_stats bounded by [start_us, end_us]"
```

---

### Task 4: Tauri `recompute_signal_stats` command

**Files:**
- Modify: `app/src-tauri/src/main.rs`

**Interfaces:**
- Consumes: Task 3's `signal-stats` subcommand, existing `PrepareGuard`/`progress_to_json`/`fold_final_done`/`sidecar::spawn`.
- Produces: `recompute_signal_stats(blf_path, start_us: i64, end_us: i64)`, emitting `"signal-stats-progress"` events. Task 5's frontend calls it.

- [ ] **Step 1: Write the failing unit test**

```rust
    #[test]
    fn recompute_signal_stats_args_shape_matches_decode_signals_pattern() {
        // Pinning test: recompute_signal_stats's arg-building must mirror
        // decode_signals' (subcommand name, blf_path, then start_us/end_us as
        // strings) so a future refactor of one doesn't silently diverge from
        // the other. Exercises the same arg-vec construction decode_signals
        // already uses, applied to the new subcommand name.
        let blf_path = "trace.blf".to_string();
        let start_us: i64 = 100;
        let end_us: i64 = 200;
        let args = vec!["signal-stats".to_string(), blf_path, start_us.to_string(), end_us.to_string()];
        assert_eq!(args, vec!["signal-stats", "trace.blf", "100", "200"]);
    }
```

- [ ] **Step 2: Run to verify it fails**

```bash
cargo test --manifest-path app/src-tauri/Cargo.toml recompute_signal_stats_args_shape_matches_decode_signals_pattern
```

Expected: PASS immediately (it's a pure data-shape pinning test, no production code needed yet) - confirms the exact arg vector shape before wiring it into the real command in Step 3, same rationale as Task 2 Step 2.

- [ ] **Step 3: Implement**

```rust
#[tauri::command]
async fn recompute_signal_stats(
    app: tauri::AppHandle,
    blf_path: String,
    start_us: i64,
    end_us: i64,
) -> Result<serde_json::Value, String> {
    let bin = begin_prepare(app.state::<PrepareGuard>().inner(), fastrace_parse_bin())?;
    let app_for_task = app.clone();
    let joined: Result<serde_json::Value, String> =
        tauri::async_runtime::spawn_blocking(move || {
            let mut ticks = Vec::new();
            sidecar::spawn(
                &bin,
                &["signal-stats".to_string(), blf_path, start_us.to_string(), end_us.to_string()],
                |progress| {
                    let _ = app_for_task.emit("signal-stats-progress", progress_to_json(&progress));
                    ticks.push(progress);
                },
            )
            .map(|_| fold_final_done(&ticks))
        })
        .await
        .map_err(|e| e.to_string())?;

    app.state::<PrepareGuard>().release();
    joined
}
```

Register `recompute_signal_stats` in `tauri::generate_handler![...]`.

- [ ] **Step 4: Run to verify it passes**

```bash
cargo test --manifest-path app/src-tauri/Cargo.toml
cargo build --manifest-path app/src-tauri/Cargo.toml
```

Expected: builds clean, all tests PASS.

- [ ] **Step 5: Format and commit**

```bash
cargo fmt --manifest-path crates/Cargo.toml
git add app/src-tauri/src/main.rs
git commit -m "feat(tauri): add recompute_signal_stats command"
```

---

### Task 5: Frontend - thread the new commands/widened signatures through `trace-source.ts`/`hooks.ts`

**Files:**
- Modify: `app/ui/src/shared/api/trace-source.ts`
- Modify: `app/ui/src/shared/api/hooks.ts`
- Modify: `app/ui/src/widgets/TraceRail.tsx` (`useTraceSummary` call site only)
- Modify: `app/ui/src/widgets/MessageDetails.tsx` (`useMessageDetail` call site only)

**Interfaces:**
- Consumes: Task 2/4's new/widened Tauri commands.
- Produces: `getTraceSummary(blfPath, startUs, endUs)`, `getMessageDetail(blfPath, msgId, startUs, endUs)`, `countMessages(blfPath)`, `resolveMessagePosition(blfPath, position)` (plain async fn, not a hook), `recomputeSignalStats(blfPath, startUs, endUs)` on `TraceDataSource`; `useTraceSummary(blfPath, startUs, endUs)`, `useMessageDetail(blfPath, msgId, startUs, endUs)`, `useMessageCount(blfPath)`, `useRecomputeSignalStats(blfPath)`, `useIsRecomputingSignalStats(blfPath)` in `hooks.ts`. Task 8/9 consume `useMessageCount`/`resolveMessagePosition`/`useRecomputeSignalStats`/`useIsRecomputingSignalStats`.

No FE test runner exists (confirmed in Wave 1) - verify via `npx tsc --noEmit -p app/ui` instead of red/green.

- [ ] **Step 1: `trace-source.ts` - widen the interface and `TauriTraceDataSource`**

```ts
  getTraceSummary(blfPath: string, startUs: number, endUs: number): Promise<TraceSummary>;
  getMessageDetail(blfPath: string, msgId: number, startUs: number, endUs: number): Promise<MessageDetail>;
  countMessages(blfPath: string): Promise<number>;
  resolveMessagePosition(blfPath: string, position: number): Promise<number>;
  recomputeSignalStats(blfPath: string, startUs: number, endUs: number): Promise<{ elapsedMs: number }>;
```

```ts
  getTraceSummary(blfPath: string, startUs: number, endUs: number): Promise<TraceSummary> {
    return invoke<TraceSummary>("get_trace_summary", { blfPath, startUs, endUs });
  }

  getMessageDetail(blfPath: string, msgId: number, startUs: number, endUs: number): Promise<MessageDetail> {
    return invoke<MessageDetail>("get_message_detail", { blfPath, msgId, startUs, endUs });
  }

  countMessages(blfPath: string): Promise<number> {
    return invoke<number>("count_messages", { blfPath });
  }

  resolveMessagePosition(blfPath: string, position: number): Promise<number> {
    return invoke<number>("resolve_message_position", { blfPath, position });
  }

  async recomputeSignalStats(blfPath: string, startUs: number, endUs: number): Promise<{ elapsedMs: number }> {
    const tick = await invoke<{ elapsed_ms: number }>("recompute_signal_stats", { blfPath, startUs, endUs });
    return { elapsedMs: tick.elapsed_ms };
  }
```

(`listEcus`, `listSignalCatalog`, `getTraceTimeRange`, and every other existing method are unchanged.)

- [ ] **Step 2: `hooks.ts` - widen/add hooks**

```ts
export function useTraceSummary(blfPath: string, startUs: number, endUs: number) {
  return useQuery({
    queryKey: ["trace-summary", blfPath, startUs, endUs],
    queryFn: () => getTraceDataSource().getTraceSummary(blfPath, startUs, endUs),
  });
}
```

```ts
export function useMessageDetail(blfPath: string, msgId: number | null, startUs: number, endUs: number) {
  return useQuery({
    queryKey: ["message-detail", blfPath, msgId, startUs, endUs],
    queryFn: () => getTraceDataSource().getMessageDetail(blfPath, msgId as number, startUs, endUs),
    enabled: msgId !== null,
  });
}
```

```ts
export function useMessageCount(blfPath: string) {
  return useQuery({
    queryKey: ["message-count", blfPath],
    queryFn: () => getTraceDataSource().countMessages(blfPath),
  });
}

// Plain async function, not a hook - called imperatively (twice) from
// TrimControl's Apply handler in message-ordinal mode, not rendered.
export function resolveMessagePosition(blfPath: string, position: number): Promise<number> {
  return getTraceDataSource().resolveMessagePosition(blfPath, position);
}
```

```ts
const recomputeSignalStatsMutationKey = (blfPath: string) => ["recompute-signal-stats", blfPath];

export function useRecomputeSignalStats(blfPath: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationKey: recomputeSignalStatsMutationKey(blfPath),
    mutationFn: ({ startUs, endUs }: { startUs: number; endUs: number }) =>
      getTraceDataSource().recomputeSignalStats(blfPath, startUs, endUs),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: SIGNAL_CATALOG_KEY(blfPath) });
    },
    onError: (e) => useToastStore.getState().pushError(String(e)),
  });
}

export function useIsRecomputingSignalStats(blfPath: string): boolean {
  const states = useMutationState({
    filters: { mutationKey: recomputeSignalStatsMutationKey(blfPath), status: "pending" },
  });
  return states.length > 0;
}
```

- [ ] **Step 3: Update the two existing call sites**

`TraceRail.tsx` (already reads `trimRange` from the store per Wave 1 - just add the args):

```tsx
  const summary = useTraceSummary(blfPath, trimRange?.start ?? 0, trimRange?.end ?? Number.MAX_SAFE_INTEGER);
```

(Move this line below the existing `const trimRange = useWorkspaceStore((s) => s.appliedTrimRange);` line if it isn't already - check the current file; `trimRange` is already declared one line below `summary` today, so either reorder or reference `useWorkspaceStore((s) => s.appliedTrimRange)` inline for `summary` too.)

`MessageDetails.tsx`:

```tsx
export default function MessageDetails({ blfPath }: MessageDetailsProps) {
  const selectedMessageId = useWorkspaceStore((s) => s.selectedMessageId);
  const trimRange = useWorkspaceStore((s) => s.appliedTrimRange);
  const { data, isPending, isError } = useMessageDetail(
    blfPath,
    selectedMessageId,
    trimRange?.start ?? 0,
    trimRange?.end ?? Number.MAX_SAFE_INTEGER
  );
  // ... rest unchanged - the existing `isError` branch ("Couldn't load message
  // details - see error notification") already renders for a selected message
  // that now falls outside the trim window, no new UI code needed.
```

- [ ] **Step 4: Type-check**

```bash
cd app/ui && npx tsc --noEmit -p .
```

Expected: zero errors (every call site updated in this task).

- [ ] **Step 5: Commit**

```bash
git add app/ui/src/shared/api/trace-source.ts app/ui/src/shared/api/hooks.ts app/ui/src/widgets/TraceRail.tsx app/ui/src/widgets/MessageDetails.tsx
git commit -m "feat(ui): thread widened trace-summary/message-detail bounds and new message-count/recompute-stats hooks"
```

---

### Task 6: Frontend - Timeline axis fix

**Files:**
- Modify: `app/ui/src/widgets/TimelinePanel.tsx`

**Interfaces:**
- Consumes: `useWorkspaceStore`'s `appliedTrimRange` (existing).
- Produces: `TimelineChart` now receives `minTs`/`maxTs` sourced from the trim window, not the full-trace range.

- [ ] **Step 1: Implement**

```tsx
import { useWorkspaceStore } from "@/app/store";
import SignalPills from "./SignalPills";
import TimelineChart from "./TimelineChart";
import TimelineZoomControl from "./TimelineZoomControl";

interface TimelinePanelProps {
  blfPath: string;
}

export default function TimelinePanel({ blfPath }: TimelinePanelProps) {
  const hasDisplayedSignals = useWorkspaceStore((s) => s.displayedSignalIds.size > 0);
  const appliedTrimRange = useWorkspaceStore((s) => s.appliedTrimRange);
  const minTs = appliedTrimRange?.start;
  const maxTs = appliedTrimRange?.end;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <SignalPills blfPath={blfPath} />
      <div className="min-h-0 flex-1">
        <TimelineChart blfPath={blfPath} minTs={minTs} maxTs={maxTs} />
      </div>
      {hasDisplayedSignals && <TimelineZoomControl />}
    </div>
  );
}
```

(Drops the `useTraceTimeRange` import/call entirely from this file. `TimelineChart.tsx`/`TimelineZoomControl.tsx` need no changes - they already just consume whatever `minTs`/`maxTs` props they're given, and `TimelineZoomControl`'s percentage-based `echarts.connect()` sync automatically operates over whatever axis domain `TimelineChart` currently has.)

- [ ] **Step 2: Type-check**

```bash
cd app/ui && npx tsc --noEmit -p .
```

Expected: zero errors.

- [ ] **Step 3: Commit**

```bash
git add app/ui/src/widgets/TimelinePanel.tsx
git commit -m "fix(ui): source Timeline axis/zoom domain from the applied trim window, not the full trace"
```

---

### Task 7: Frontend - `Slider` primitive (dual-handle)

**Files:**
- Modify: `app/ui/package.json` (new dependency)
- Create: `app/ui/src/shared/ui/slider.tsx`

**Interfaces:**
- Produces: `Slider` component wrapping Radix's `@radix-ui/react-slider`, accepting `min`, `max`, `step`, `value: number[]`, `onValueChange: (value: number[]) => void`, `className`. Task 8 (`TrimControl.tsx`) consumes it with a 2-element `value` array for the dual-handle case.

- [ ] **Step 1: Install the dependency**

```bash
cd app/ui && npm install @radix-ui/react-slider
```

- [ ] **Step 2: Create the primitive**

Mirror the existing `shared/ui/*.tsx` wrap style (see `separator.tsx`/`scroll-area.tsx` for the pattern of a thin Radix wrap plus `cn()`-merged classes):

```tsx
import * as SliderPrimitive from "@radix-ui/react-slider";
import { cn } from "./lib/utils";

interface SliderProps {
  min: number;
  max: number;
  step?: number;
  value: number[];
  onValueChange: (value: number[]) => void;
  className?: string;
}

export function Slider({ min, max, step = 1, value, onValueChange, className }: SliderProps) {
  return (
    <SliderPrimitive.Root
      min={min}
      max={max}
      step={step}
      value={value}
      onValueChange={onValueChange}
      className={cn("relative flex h-5 w-full touch-none select-none items-center", className)}
    >
      <SliderPrimitive.Track className="relative h-1.5 w-full grow overflow-hidden rounded-full bg-muted">
        <SliderPrimitive.Range className="absolute h-full bg-primary" />
      </SliderPrimitive.Track>
      {value.map((_, i) => (
        <SliderPrimitive.Thumb
          key={i}
          className="block h-4 w-4 rounded-full border-2 border-primary bg-background shadow transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50"
        />
      ))}
    </SliderPrimitive.Root>
  );
}
```

(One `Thumb` per `value` entry - Radix's own pattern for multi-handle sliders; rendering exactly 2 thumbs here since `TrimControl` always passes a 2-element array.)

- [ ] **Step 3: Type-check**

```bash
cd app/ui && npx tsc --noEmit -p .
```

Expected: zero errors (new unused file causes no errors; nothing imports it yet).

- [ ] **Step 4: Commit**

```bash
git add app/ui/package.json app/ui/package-lock.json app/ui/src/shared/ui/slider.tsx
git commit -m "feat(ui): add dual-handle Slider primitive (@radix-ui/react-slider)"
```

---

### Task 8: Frontend - `TrimControl.tsx` strategy toggle + dual-handle slider

**Files:**
- Modify: `app/ui/src/widgets/TrimControl.tsx`
- Modify: `app/ui/src/widgets/TopBar.tsx` (`onApplyTrim` prop type only)

**Interfaces:**
- Consumes: Task 5's `useMessageCount`/`resolveMessagePosition`, Task 7's `Slider`.
- Produces: `TrimControl` renders one `Slider` per strategy (time or message-ordinal) instead of two independent `<input type="range">`s; `handleApply` resolves ordinal positions to timestamps before committing in message mode.

- [ ] **Step 1: Implement**

```tsx
import { useEffect, useState } from "react";
import { useWorkspaceStore } from "@/app/store";
import { resolveMessagePosition, useMessageCount, useTraceTimeRange } from "@/shared/api/hooks";
import { Button } from "@/shared/ui/button";
import { Slider } from "@/shared/ui/slider";

interface TrimControlProps {
  blfPath: string;
  onApply: () => void;
}

type Strategy = "time" | "message";

export default function TrimControl({ blfPath, onApply }: TrimControlProps) {
  const timeRange = useTraceTimeRange(blfPath);
  const messageCount = useMessageCount(blfPath);
  const pending = useWorkspaceStore((s) => s.pendingTrimRange);
  const applied = useWorkspaceStore((s) => s.appliedTrimRange);
  const setPendingTrimRange = useWorkspaceStore((s) => s.setPendingTrimRange);
  const applyTrim = useWorkspaceStore((s) => s.applyTrim);
  const initTrimRangeIfUnset = useWorkspaceStore((s) => s.initTrimRangeIfUnset);

  const [strategy, setStrategy] = useState<Strategy>("time");
  const [positionRange, setPositionRange] = useState<{ startPos: number; endPos: number } | null>(null);
  const [isResolving, setIsResolving] = useState(false);

  useEffect(() => {
    if (timeRange.data) {
      initTrimRangeIfUnset(timeRange.data.minTimestampUs, timeRange.data.maxTimestampUs);
    }
  }, [timeRange.data, initTrimRangeIfUnset]);

  if (!timeRange.data || !pending) {
    return null;
  }

  const { minTimestampUs, maxTimestampUs } = timeRange.data;

  // Switching strategy always re-primes to the full range rather than
  // reverse-mapping one unit into the other - timestamp->ordinal-position
  // isn't cheap and isn't needed; the user presses Apply again either way.
  function switchStrategy(next: Strategy) {
    setStrategy(next);
    if (next === "message") {
      setPositionRange({ startPos: 1, endPos: messageCount.data ?? 1 });
    } else {
      setPendingTrimRange({ start: minTimestampUs, end: maxTimestampUs });
    }
  }

  const hasPendingChange =
    strategy === "time"
      ? !applied || applied.start !== pending.start || applied.end !== pending.end
      : true; // message mode: resolution happens fresh at every Apply, so always allow (re-)pressing it.

  async function handleApply() {
    if (strategy === "message" && positionRange) {
      setIsResolving(true);
      const [start, end] = await Promise.all([
        resolveMessagePosition(blfPath, positionRange.startPos),
        resolveMessagePosition(blfPath, positionRange.endPos),
      ]);
      setIsResolving(false);
      setPendingTrimRange({ start, end });
      applyTrim();
    } else {
      applyTrim();
    }
    onApply();
  }

  return (
    <div className="flex items-center gap-2">
      <div className="flex gap-0.5 rounded-md border border-border p-0.5">
        <Button
          size="sm"
          variant={strategy === "time" ? "secondary" : "ghost"}
          className="h-6 px-2 text-[10px]"
          onClick={() => switchStrategy("time")}
        >
          Time
        </Button>
        <Button
          size="sm"
          variant={strategy === "message" ? "secondary" : "ghost"}
          className="h-6 px-2 text-[10px]"
          onClick={() => switchStrategy("message")}
        >
          Message
        </Button>
      </div>
      {strategy === "time" ? (
        <>
          <span className="font-mono text-[10px] text-muted-foreground">{pending.start.toLocaleString()}</span>
          <Slider
            min={minTimestampUs}
            max={maxTimestampUs}
            value={[pending.start, pending.end]}
            onValueChange={([start, end]) => setPendingTrimRange({ start, end })}
            className="w-56"
          />
          <span className="font-mono text-[10px] text-muted-foreground">{pending.end.toLocaleString()}</span>
        </>
      ) : (
        positionRange && (
          <>
            <span className="font-mono text-[10px] text-muted-foreground">#{positionRange.startPos}</span>
            <Slider
              min={1}
              max={messageCount.data ?? 1}
              value={[positionRange.startPos, positionRange.endPos]}
              onValueChange={([startPos, endPos]) => setPositionRange({ startPos, endPos })}
              className="w-56"
            />
            <span className="font-mono text-[10px] text-muted-foreground">#{positionRange.endPos}</span>
          </>
        )
      )}
      <Button
        size="sm"
        variant={hasPendingChange ? "default" : "secondary"}
        disabled={!hasPendingChange || isResolving}
        onClick={handleApply}
      >
        {isResolving ? "Resolving..." : "Apply"}
      </Button>
    </div>
  );
}
```

- [ ] **Step 2: Widen `TopBar.tsx`'s prop type**

```tsx
interface TopBarProps {
  traceName: string;
  blfPath: string;
  preparing: boolean;
  tick: ProgressTick | null;
  onOpenTrace: () => void;
  onApplyTrim: () => void | Promise<void>;
}
```

(No call-site changes needed - `TopBar` just forwards `onApplyTrim` to `TrimControl`'s `onApply` prop, and nothing awaits the result.)

- [ ] **Step 3: Type-check**

```bash
cd app/ui && npx tsc --noEmit -p .
```

Expected: zero errors.

- [ ] **Step 4: Manually verify (per this project's established FE verification method - no test runner exists)**

```bash
npm run build --prefix app/ui
```

Walk through mentally / via a GUI run if available: toggling "Time"/"Message" resets the slider to the full range each time; dragging the message-mode slider shows ordinal numbers; clicking Apply in message mode briefly shows "Resolving..." then commits a timestamp-based `appliedTrimRange` identical in effect to picking the same window by time.

- [ ] **Step 5: Commit**

```bash
git add app/ui/src/widgets/TrimControl.tsx app/ui/src/widgets/TopBar.tsx
git commit -m "feat(ui): add time/message strategy toggle and a dual-handle Slider to TrimControl"
```

---

### Task 9: Frontend - sequenced Apply flow (`WorkspaceLayout.tsx`) + widened `DecodeOverlay`

**Files:**
- Modify: `app/ui/src/widgets/WorkspaceLayout.tsx`

**Interfaces:**
- Consumes: Task 5's `useRecomputeSignalStats`/`useIsRecomputingSignalStats`.
- Produces: `handleApplyTrim` becomes `async`, unconditionally recomputes `signal_stats` on every Apply (sequenced before any conditional signal re-decode, since both hold the same native write lock), and `DecodeOverlay`'s `active` prop widens to cover both phases.

- [ ] **Step 1: Implement**

```tsx
import { useDecodeSignals, useFileSizes, useIsDecodingSignals, useIsRecomputingSignalStats, useRecomputeSignalStats } from "@/shared/api/hooks";
// ... (rest of imports unchanged)

export default function WorkspaceLayout({ blfPath, preparing, tick, prepareTotals, onOpenTrace }: WorkspaceLayoutProps) {
  const isDecoding = useIsDecodingSignals(blfPath);
  const isRecomputingStats = useIsRecomputingSignalStats(blfPath);
  const decodeSignals = useDecodeSignals(blfPath);
  const recomputeStats = useRecomputeSignalStats(blfPath);

  async function handleApplyTrim() {
    const { activeSignalIds, appliedTrimRange } = useWorkspaceStore.getState();
    if (!appliedTrimRange) return;
    // Unconditional: the Signal Catalog's signal_stats must reflect the
    // current window regardless of what's currently Active/displayed.
    await recomputeStats.mutateAsync({ startUs: appliedTrimRange.start, endUs: appliedTrimRange.end });
    // Sequenced, not parallel: both this and the stats recompute hold the
    // native PrepareGuard write lock - running them concurrently would make
    // whichever started second spuriously fail with "a Prepare run is
    // already in progress."
    if (activeSignalIds.size > 0) {
      decodeSignals.mutate({
        signalIds: Array.from(activeSignalIds),
        startUs: appliedTrimRange.start,
        endUs: appliedTrimRange.end,
      });
    }
  }

  return (
    <div className="flex h-screen flex-col">
      <TopBar
        traceName={blfPath.split(/[\\/]/).pop() ?? blfPath}
        blfPath={blfPath}
        preparing={preparing}
        tick={tick}
        onOpenTrace={onOpenTrace}
        onApplyTrim={handleApplyTrim}
      />
      {/* ... rest unchanged ... */}
      <DecodeOverlay active={isDecoding || isRecomputingStats} />
    </div>
  );
}
```

- [ ] **Step 2: Type-check**

```bash
cd app/ui && npx tsc --noEmit -p .
```

Expected: zero errors.

- [ ] **Step 3: Full frontend build + manual verification**

```bash
npm run build --prefix app/ui
```

If a GUI run is available: with at least one Active signal, click Apply and confirm `DecodeOverlay` stays continuously visible across both the stats-recompute and re-decode phases (no flicker-to-hidden gap between them); with zero Active signals, confirm the overlay still appears briefly for the stats recompute alone, then clears, with no re-decode call made.

- [ ] **Step 4: Commit**

```bash
git add app/ui/src/widgets/WorkspaceLayout.tsx
git commit -m "feat(ui): sequence stats-recompute and signal re-decode on Apply, widen DecodeOverlay"
```

---

### Task 10: `CONTEXT.md` update

**Files:**
- Modify: `CONTEXT.md`

**Interfaces:** None - documentation only.

- [ ] **Step 1: Amend the Trim Window entry**

```markdown
**Trim Window**:
The `[start, end]` timestamp bound the user sets via the header slider (next to the trace file name), scoping every query against the open Trace - Message List, Detector Query, Signal Catalog's `signal_stats` (recomputed on every Apply), Timeline axis + zoom, Message Details, trace summary counts - to that range for the rest of the session. Adjustable at any time via the slider + Apply button; defaults to the full Trace span on open. Non-destructive: never mutates the Trace Store file, only what queries return. Two entry strategies, selected via a toggle on the slider: **time-based** (drag start/end timestamp handles directly) and **message-based** (pick start/end by ordinal position among the trace's messages, e.g. "message 30 to message 50" - resolved to timestamps only at Apply time). Internally the window is always `[start, end]` in `timestamp_us` regardless of which strategy set it - switching strategy always re-primes to the full range and requires a fresh Apply; there is no reverse-mapping between the two units.
_Avoid_: confusing with the Timeline's client-side pan/zoom (`timelineZoomRange`) - that only changes what's visible in the chart viewport, not what's queried (the chart's axis domain itself, however, does track the Trim Window); "trim" as deleting rows from the Trace Store (it doesn't); treating the message-based strategy as a different kind of trim window - it's just an alternate way to set the same timestamp bound. **Known gap:** the ECU list (Trace Rail's ECUs tab) is not trim-scoped - `arxml_ecu` has no schema link to any frame/PDU/timestamp, so it always shows the full ARXML dictionary.
```

- [ ] **Step 2: Commit**

```bash
git add CONTEXT.md
git commit -m "docs(context): document the Trim Window's time/message strategies and widened scope"
```

---
