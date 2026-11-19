# Prepare Workspace + Global Trim Window Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the full-screen Prepare flow with an immediately-mounted Workspace (skeleton panels + a byte-based progress indicator in the header), then add a session-long, adjustable Trim Window (header slider + Apply) that scopes every message/signal/detector-query read to `[start, end]`.

**Architecture:** Three layers change together: (1) the native `fastrace_parse` sidecar gains byte-based progress on `prepare` and a time-bounded, idempotent `decode-signals`; (2) `crates/sidecar`/`crates/query`/`app/src-tauri` thread `start_us`/`end_us` through every trace-wide read (messages, groups, signal samples, detector query) and carry the new progress fields; (3) the React UI drops the separate Progress screen in favor of skeleton-filled panels, and adds a `TrimControl` that lives in the header's file-name slot, handing off from the Prepare progress indicator once Prepare's `Done` tick arrives.

**Tech Stack:** C++23/CMake (`native/`), Rust/DuckDB (`crates/`), Tauri `#[tauri::command]` (`app/src-tauri`), React/TypeScript/Vite + Zustand + TanStack Query (`app/ui`).

**Spec:** This plan's spec is the grilled design captured in this session's conversation and in `CONTEXT.md`'s **Trim Window** / **Read Payloads** entries (committed in `e5a7d88`). No separate spec file exists; the Global Constraints below restate every settled decision verbatim.

## Global Constraints

- Trim is **non-destructive**: it never mutates or deletes rows from the Trace Store outside the signal-cache re-decode in Task 3 (which is itself a controlled replace-on-reapply, not a destructive trim).
- Trim units are **timestamp_us**, matching `get_trace_time_range`'s existing domain. It is never message-index-based.
- Trim defaults to the **full trace span** on first load (no pre-narrowed default).
- Trim is **global**: it scopes Message List, Trace Rail message groups, Detector Query (Analyzer), Signal Catalog sample reads, and Timeline signal data. It does **not** scope `list_ecus` (static ARXML dictionary, no timestamp axis) or `list_signal_catalog`'s `signal_stats` (Prepare-time, full-trace stat, used only for sort/decodable flags).
- Trim is **re-visitable**: adjustable any time via the header slider + Apply, not a one-time gate.
- Only **signal data** needs re-ingestion on Apply (bounded re-decode via the existing `decode-signals` sidecar command, surfaced through the existing `DecodeOverlay`/`useIsDecodingSignals` plumbing). Message List, groups, ECU list, and Detector Query just re-run their (cheap) bound query - no new loading UI for those.
- Selections that fall outside a newly-applied window (`selectedMessageId`, a pinned chart signal) are **left as-is** - the owning panel shows its own empty state, nothing auto-clears.
- `ProgressScreen`/`Progress.tsx` is **deleted**. `Welcome → Start Processing` mounts `WorkspaceLayout` immediately with skeleton panels; `ErrorScreen` is unchanged and still full-screen on a Prepare failure.
- The Prepare progress indicator is **byte-based** (`bytes_read / bytes_total` from the mapped BLF file), not message-count-based (BLF's `numObj` header field is not a reliable 1:1 proxy for "messages").
- The header's file-name slot shows **one thing at a time**: the byte-progress indicator while Prepare is running, then the Trim Window slider + Apply once Prepare's `Done` tick arrives. They never both render.

## Review Focus

- **Re-running `decode-signals` for the same signal/window twice must not duplicate rows** - every Apply on an unchanged-but-already-applied window (or widen-then-narrow-back) must leave `signals` row counts stable, not accumulating duplicates. Covered in Task 3.
- **`run_detector_query`'s bound must not break on user SQL that already contains a `WHERE` clause, ORDER BY, or trailing comment** - the existing wrapping (`select ... from (<user sql>) as x limit N`) already handles those; the new bound must compose with it, not replace it. Covered in Task 5.
- **A Prepare failure after skeletons are already showing must still land on the full-screen `ErrorScreen`**, not leave the workspace half-rendered with skeletons forever. Covered in Task 10.
- **Narrowing the trim window to exclude the currently-selected message/signal must not crash or clear the selection** - the owning panel (`MessageDetails`, `TimelineChart`) must render its normal empty state for a selection outside `[start, end]`. Covered in Task 11.
- **The byte-progress indicator must reach 100% exactly at `Done`**, not asymptotically approach it or overshoot - `bytes_read` is only updated once per fully-inflated container, so the last container's completion must coincide with the `Done` tick's values. Covered in Task 2.

---

### Task 1: Native - BlfIngestReader byte-progress stats

**Files:**
- Modify: `native/blf/include/BlfIngestReader.h:18-23` (`Stats` struct)
- Modify: `native/blf/src/BlfIngestReader.cpp:430-534` (`visit`)
- Create: `native/blf/test/blf_ingest_reader_test.cpp`
- Modify: `native/blf/CMakeLists.txt`

**Interfaces:**
- Produces: `BlfIngestReader::Stats::bytesRead` (u64, byte offset into the mapped file after the most recently fully-inflated container), `BlfIngestReader::Stats::fileSizeBytes` (u64, set once at `visit()` start from `MappedFile::size`). Task 2 reads both via `reader.stats()`.

- [ ] **Step 1: Add the two fields to `Stats`**

In `native/blf/include/BlfIngestReader.h`, extend the struct:

```cpp
struct Stats {
    uint64_t containers = 0;
    uint64_t messages = 0;
    uint64_t splitObjects = 0;
    uint64_t bytesRead = 0;      // byte offset into the file after the last fully-inflated container
    uint64_t fileSizeBytes = 0;  // total mapped file size, set once at visit() start
    int64_t inflateDecodeUs = 0; // wall time in visit's inflate+decode loop
};
```

- [ ] **Step 2: Write the failing test**

Create `native/blf/test/blf_ingest_reader_test.cpp`:

```cpp
// Exercises BlfIngestReader's byte-progress stats (bytesRead/fileSizeBytes)
// against the committed synthetic fixture shared with native/store's tests.
#include <cstdio>
#include "BlfIngestReader.h"

#ifndef FASTRACE_FIXTURE_BLF
#error "FASTRACE_FIXTURE_BLF must be defined by CMake"
#endif

int main()
{
    int failures = 0;

    fastrace::BlfIngestReader reader;
    const bool ok = reader.visit(FASTRACE_FIXTURE_BLF, [](const fastrace::TraceMessage&) {});
    if (!ok) {
        std::fprintf(stderr, "FAIL: visit() returned false\n");
        return 1;
    }

    const auto& stats = reader.stats();
    if (stats.fileSizeBytes == 0) {
        std::fprintf(stderr, "FAIL: fileSizeBytes must be nonzero, got 0\n");
        ++failures;
    }
    if (stats.bytesRead == 0) {
        std::fprintf(stderr, "FAIL: bytesRead must be nonzero after a successful visit, got 0\n");
        ++failures;
    }
    if (stats.bytesRead > stats.fileSizeBytes) {
        std::fprintf(stderr, "FAIL: bytesRead (%llu) exceeds fileSizeBytes (%llu)\n",
            static_cast<unsigned long long>(stats.bytesRead), static_cast<unsigned long long>(stats.fileSizeBytes));
        ++failures;
    }
    // The fixture is one LOG_CONTAINER - bytesRead after the (only) container
    // must equal fileSizeBytes exactly, not just be "close".
    if (stats.bytesRead != stats.fileSizeBytes) {
        std::fprintf(stderr, "FAIL: bytesRead (%llu) != fileSizeBytes (%llu) at end of a single-container fixture\n",
            static_cast<unsigned long long>(stats.bytesRead), static_cast<unsigned long long>(stats.fileSizeBytes));
        ++failures;
    }

    if (failures > 0) {
        std::fprintf(stderr, "%d assertion(s) failed\n", failures);
        return 1;
    }
    std::printf("blf_ingest_reader_test: OK\n");
    return 0;
}
```

Append to `native/blf/CMakeLists.txt`:

```cmake
enable_testing()

add_executable(fastrace_blf_test test/blf_ingest_reader_test.cpp)
target_link_libraries(fastrace_blf_test PRIVATE fastrace_blf)
target_compile_definitions(fastrace_blf_test PRIVATE
  FASTRACE_FIXTURE_BLF="${PROJECT_SOURCE_DIR}/store/test/fixtures/fixture.blf"
)
add_test(NAME fastrace_blf_test COMMAND fastrace_blf_test)
```

- [ ] **Step 3: Run it to verify it fails**

```bash
cmake -S . -B build && cmake --build build --target fastrace_blf_test
./build/native/blf/fastrace_blf_test
```

Expected: FAIL (`fileSizeBytes`/`bytesRead` are both 0 - the fields exist but nothing sets them yet).

- [ ] **Step 4: Implement**

In `native/blf/src/BlfIngestReader.cpp`'s `visit()`:

After `Cursor cursor = mf.cursor();` (around line 444), set the total once:

```cpp
    Cursor cursor = mf.cursor();
    m_stats.fileSizeBytes = mf.size;
```

After `++m_stats.containers;` (line 500, right after a container is confirmed inflated), update the running offset:

```cpp
        ++m_stats.containers;
        m_stats.bytesRead = cursor.tell();
```

- [ ] **Step 5: Run it to verify it passes**

```bash
cmake --build build --target fastrace_blf_test
./build/native/blf/fastrace_blf_test
```

Expected: `blf_ingest_reader_test: OK`

- [ ] **Step 6: Format and commit**

```bash
clang-format -i native/blf/include/BlfIngestReader.h native/blf/src/BlfIngestReader.cpp native/blf/test/blf_ingest_reader_test.cpp
git add native/blf/include/BlfIngestReader.h native/blf/src/BlfIngestReader.cpp native/blf/test/blf_ingest_reader_test.cpp native/blf/CMakeLists.txt
git commit -m "feat(blf): track bytesRead/fileSizeBytes in BlfIngestReader::Stats"
```

---

### Task 2: Native - byte-based progress on `prepare`

**Files:**
- Modify: `native/cli/src/main.cpp:31-45` (`printProgress`/`printDone`), `:390-394` and `:427-428` (call sites in `runPrepare`)
- Modify: `native/store/test/run_fixture_prepare.cmake`

**Interfaces:**
- Consumes: `BlfIngestReader::Stats::bytesRead`/`fileSizeBytes` from Task 1.
- Produces: `prepare`'s stdout progress/done JSON now includes `"bytes_read"` and `"bytes_total"`. Task 4 (`crates/sidecar`) parses these.

- [ ] **Step 1: Update the printers**

In `native/cli/src/main.cpp`, widen both JSON printers:

```cpp
void printProgress(uint64_t containers, uint64_t messages, uint64_t bytesRead, uint64_t bytesTotal, int64_t elapsedMs)
{
    std::printf(
        "{\"containers\":%llu,\"messages\":%llu,\"bytes_read\":%llu,\"bytes_total\":%llu,\"elapsed_ms\":%lld}\n",
        static_cast<unsigned long long>(containers), static_cast<unsigned long long>(messages),
        static_cast<unsigned long long>(bytesRead), static_cast<unsigned long long>(bytesTotal),
        static_cast<long long>(elapsedMs));
    std::fflush(stdout);
}

void printDone(uint64_t containers, uint64_t messages, uint64_t protocolRows, uint64_t bytesRead,
    uint64_t bytesTotal, int64_t elapsedMs)
{
    std::printf(
        "{\"done\":true,\"containers\":%llu,\"messages\":%llu,\"protocol_rows\":%llu,"
        "\"bytes_read\":%llu,\"bytes_total\":%llu,\"elapsed_ms\":%lld}\n",
        static_cast<unsigned long long>(containers), static_cast<unsigned long long>(messages),
        static_cast<unsigned long long>(protocolRows), static_cast<unsigned long long>(bytesRead),
        static_cast<unsigned long long>(bytesTotal), static_cast<long long>(elapsedMs));
    std::fflush(stdout);
}
```

`decode-signals`' `runDecodeSignals` also calls these two printers (lines 241, 260) - it doesn't track bytes meaningfully per Task 3's design (its own `reader.stats()` is a separate `BlfIngestReader` instance scanning the same file), so pass its own `reader.stats()` values through unchanged - the frontend's decode progress UI (`DecodeOverlay`) already only reads `tick.messages`, so these new fields are simply ignored there, not misused.

- [ ] **Step 2: Update all four call sites**

`runDecodeSignals` (~line 241):
```cpp
                printProgress(reader.stats().containers, nextMsgId, reader.stats().bytesRead,
                    reader.stats().fileSizeBytes,
                    std::chrono::duration_cast<std::chrono::milliseconds>(now - wall0).count());
```
(~line 260):
```cpp
    printDone(finalContainers, finalMessages, decodedCount, finalBytesRead, finalBytesTotal, elapsedMs);
```
Capture `finalBytesRead`/`finalBytesTotal` the same way `finalContainers`/`finalMessages` are captured (from `reader.stats()` right after the visit loop, ~line 250-252).

`runPrepare` (~line 390-394 and ~428): same pattern - capture `finalBytesRead`/`finalBytesTotal` alongside `finalContainers`/`finalMessages` (~line 410-416), and pass them through both `printProgress` and the final `printDone` call.

- [ ] **Step 3: Extend the existing fixture-prepare ctest to assert the new fields appear**

In `native/store/test/run_fixture_prepare.cmake`, capture stdout and assert the new keys are present:

```cmake
execute_process(
  COMMAND "${FASTRACE_PARSE}" prepare "${_blf_name}" "${_arxml_name}"
  WORKING_DIRECTORY "${OUT_DIR}"
  RESULT_VARIABLE _rv
  OUTPUT_VARIABLE _prepare_stdout
)
if(NOT _rv EQUAL 0)
  message(FATAL_ERROR "fastrace_parse prepare exited with ${_rv}")
endif()
if(NOT _prepare_stdout MATCHES "\"bytes_total\"")
  message(FATAL_ERROR "prepare's stdout is missing \"bytes_total\": ${_prepare_stdout}")
endif()
if(NOT _prepare_stdout MATCHES "\"bytes_read\"")
  message(FATAL_ERROR "prepare's stdout is missing \"bytes_read\": ${_prepare_stdout}")
endif()
```

- [ ] **Step 4: Build and run the ctest to verify it passes**

```bash
cmake --build build --target fastrace_parse
ctest --test-dir build -R fastrace_store_fixture_prepare --output-on-failure
```

Expected: PASS. (Temporarily reverting Step 1/2's printf format strings back to the old 3-field form and re-running would confirm the test fails first, if you want the red step - not required here since the assertion is additive to an already-passing test.)

- [ ] **Step 5: Format and commit**

```bash
clang-format -i native/cli/src/main.cpp
git add native/cli/src/main.cpp native/store/test/run_fixture_prepare.cmake
git commit -m "feat(cli): report byte-based progress (bytes_read/bytes_total) during prepare"
```

---

### Task 3: Native - time-bounded, idempotent `decode-signals`

**Files:**
- Modify: `native/cli/src/main.cpp:131-262` (`runDecodeSignals`)
- Create: `native/store/test/decode_bounds_check.cpp`
- Create: `native/store/test/run_decode_signals_bounds.cmake`
- Modify: `native/store/CMakeLists.txt`

**Interfaces:**
- Consumes: `fastrace::Db::con()`/`exec()` (`native/store/include/Store.h`), existing `queryRequestedSignals`/`RequestedSignal` helpers already in `main.cpp`.
- Produces: `fastrace_parse decode-signals <trace.blf> <start_us> <end_us> <signal_id> [<signal_id> ...]` - a new required `<start_us> <end_us>` pair before the signal id list. Task 6/App.tsx always resolves a concrete trim window before calling this, so no "unbounded" mode is needed.

- [ ] **Step 1: Write the failing integration test**

Create `native/store/test/decode_bounds_check.cpp` (mirrors `fixture_prepare_check.cpp`'s style):

```cpp
// Checker for the fastrace_decode_signals_bounds ctest: asserts decode-signals
// respects its [start_us, end_us] bound and is idempotent on re-run (no
// duplicate rows for the same signal across repeated Apply calls).
#include <cstdio>
#include <string>

#include <duckdb.h>

namespace {

int gFailures = 0;

void expectSignalRowCount(duckdb_connection con, int64_t signalId, int64_t want, const char* label)
{
    const std::string sql = "select count(*) from signals where signal_id = " + std::to_string(signalId) + ";";
    duckdb_result res;
    if (duckdb_query(con, sql.c_str(), &res) != DuckDBSuccess) {
        std::fprintf(stderr, "FAIL (%s): query failed: %s\n", label, duckdb_result_error(&res));
        duckdb_destroy_result(&res);
        ++gFailures;
        return;
    }
    const int64_t got = duckdb_value_int64(&res, 0, 0);
    duckdb_destroy_result(&res);
    if (got != want) {
        std::fprintf(stderr, "FAIL (%s): signals row count for signal_id=%lld = %lld, want %lld\n", label,
            static_cast<long long>(signalId), static_cast<long long>(got), static_cast<long long>(want));
        ++gFailures;
    }
}

} // namespace

int main(int argc, char** argv)
{
    if (argc != 4) {
        std::fprintf(stderr, "usage: %s <fixture.duckdb> <signal_id> <want_count>\n", argv[0]);
        return 1;
    }
    duckdb_database db = nullptr;
    duckdb_connection con = nullptr;
    if (duckdb_open(argv[1], &db) == DuckDBError || duckdb_connect(db, &con) == DuckDBError) {
        std::fprintf(stderr, "FAIL: could not open %s\n", argv[1]);
        return 1;
    }
    expectSignalRowCount(con, std::strtoll(argv[2], nullptr, 10), std::strtoll(argv[3], nullptr, 10), argv[1]);
    duckdb_disconnect(&con);
    duckdb_close(&db);
    if (gFailures > 0) {
        return 1;
    }
    std::printf("decode_bounds_check: OK\n");
    return 0;
}
```

Create `native/store/test/run_decode_signals_bounds.cmake`:

```cmake
# Fixture's EngineRpm (signal_id 0) has exactly one decoded sample, at
# timestamp_us=1 (CAN message at timestampNs=1000 on the fixture's EngineFrame
# arb id 0x100 - see native/store/test/fixtures/generate_fixture.cpp). This
# drives decode-signals with a bound that excludes it, then one that includes
# it, then re-runs the including bound a second time to prove it doesn't
# duplicate rows.
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

# Bound excludes timestamp_us=1 -> zero rows for signal_id 0.
execute_process(COMMAND "${FASTRACE_PARSE}" decode-signals "${_blf_name}" 100 200 0
  WORKING_DIRECTORY "${OUT_DIR}" RESULT_VARIABLE _rv)
if(NOT _rv EQUAL 0)
  message(FATAL_ERROR "decode-signals (excluding bound) exited with ${_rv}")
endif()
execute_process(COMMAND "${BOUNDS_CHECK}" "${_out}" 0 0 RESULT_VARIABLE _rv)
if(NOT _rv EQUAL 0)
  message(FATAL_ERROR "decode_bounds_check failed after excluding bound")
endif()

# Bound includes timestamp_us=1 -> one row.
execute_process(COMMAND "${FASTRACE_PARSE}" decode-signals "${_blf_name}" 0 10 0
  WORKING_DIRECTORY "${OUT_DIR}" RESULT_VARIABLE _rv)
if(NOT _rv EQUAL 0)
  message(FATAL_ERROR "decode-signals (including bound) exited with ${_rv}")
endif()
execute_process(COMMAND "${BOUNDS_CHECK}" "${_out}" 0 1 RESULT_VARIABLE _rv)
if(NOT _rv EQUAL 0)
  message(FATAL_ERROR "decode_bounds_check failed after including bound")
endif()

# Re-running the same including bound must not duplicate the row.
execute_process(COMMAND "${FASTRACE_PARSE}" decode-signals "${_blf_name}" 0 10 0
  WORKING_DIRECTORY "${OUT_DIR}" RESULT_VARIABLE _rv)
if(NOT _rv EQUAL 0)
  message(FATAL_ERROR "decode-signals (re-run) exited with ${_rv}")
endif()
execute_process(COMMAND "${BOUNDS_CHECK}" "${_out}" 0 1 RESULT_VARIABLE _rv)
if(NOT _rv EQUAL 0)
  message(FATAL_ERROR "decode_bounds_check failed after re-running the same bound (duplicate rows?)")
endif()
```

Append to `native/store/CMakeLists.txt` (near the existing `fastrace_fixture_check` block):

```cmake
add_executable(fastrace_decode_bounds_check test/decode_bounds_check.cpp)
target_link_libraries(fastrace_decode_bounds_check PRIVATE duckdb::duckdb)
fastrace_copy_duckdb_runtime(fastrace_decode_bounds_check)

add_test(NAME fastrace_decode_signals_bounds
  COMMAND ${CMAKE_COMMAND}
    -DFASTRACE_PARSE=$<TARGET_FILE:fastrace_parse>
    -DBOUNDS_CHECK=$<TARGET_FILE:fastrace_decode_bounds_check>
    -DFIXTURE_BLF=${PROJECT_SOURCE_DIR}/store/test/fixtures/fixture.blf
    -DFIXTURE_ARXML=${PROJECT_SOURCE_DIR}/store/test/fixtures/fixture.arxml
    -DOUT_DIR=${CMAKE_CURRENT_BINARY_DIR}/decode_bounds
    -P ${PROJECT_SOURCE_DIR}/store/test/run_decode_signals_bounds.cmake
)
```

Note: `fastrace_parse` is defined in `native/cli/CMakeLists.txt`, a sibling directory already depended on by this exact pattern for `fastrace_store_fixture_prepare` - no new `add_subdirectory` ordering issue.

- [ ] **Step 2: Run it to verify it fails**

```bash
cmake -S . -B build && cmake --build build --target fastrace_decode_bounds_check fastrace_parse
ctest --test-dir build -R fastrace_decode_signals_bounds --output-on-failure
```

Expected: FAIL - `decode-signals` doesn't accept a `<start_us> <end_us>` pair yet, so argument parsing will be wrong (it'll try to treat `100`/`200` as signal ids) and/or the usage-error path returns nonzero.

- [ ] **Step 3: Implement**

In `native/cli/src/main.cpp`'s `runDecodeSignals` (starts line 131):

```cpp
int runDecodeSignals(int argc, char** argv)
{
    if (argc < 6) {
        printError("usage: fastrace_parse decode-signals <trace.blf> <start_us> <end_us> <signal_id> [<signal_id> ...]");
        return 1;
    }
    const std::string blfPath = argv[2];
    const int64_t startUs = std::strtoll(argv[3], nullptr, 10);
    const int64_t endUs = std::strtoll(argv[4], nullptr, 10);
    std::vector<int64_t> signalIds;
    for (int i = 5; i < argc; ++i) {
        signalIds.push_back(std::strtoll(argv[i], nullptr, 10));
    }
```

(Everything else up through building `idList`/`lookup`/`arDb` is unchanged - only the argv indices shifted.)

Right before constructing `fastrace::Appender sigApp(db.con(), "signals");`, delete any existing rows for the requested signals so a re-run with a different window replaces rather than appends:

```cpp
    std::string idList;
    for (size_t i = 0; i < signalIds.size(); ++i) {
        if (i != 0) {
            idList += ",";
        }
        idList += std::to_string(signalIds[i]);
    }
    if (!db.exec("DELETE FROM signals WHERE signal_id IN (" + idList + ")")) {
        printError("could not clear previous samples before re-decoding");
        return 1;
    }

    fastrace::Appender sigApp(db.con(), "signals");
```

(`idList` was already being built for `queryRequestedSignals`'s SQL - reuse that one variable instead of building it twice; it's declared a few lines above `queryRequestedSignals` is called.)

Inside the per-message lambda, skip any message outside the bound before decoding it (right after `const uint64_t msgId = nextMsgId++;`):

```cpp
            fastrace::TraceMessage msg = msgIn;
            const uint64_t msgId = nextMsgId++;
            if (static_cast<int64_t>(msg.timestampUs) < startUs || static_cast<int64_t>(msg.timestampUs) > endUs) {
                return;
            }
```

- [ ] **Step 4: Update the Tauri-side caller args to match (keeps the tree compiling together)**

This is wired fully in Task 6; for this task, only `native/` needs to build and its own ctest needs to pass - the Rust side still calls the old 2-field arg list until Task 6, which is fine since Task 6 runs right after this one in the same branch.

- [ ] **Step 5: Run it to verify it passes**

```bash
cmake --build build --target fastrace_parse fastrace_decode_bounds_check
ctest --test-dir build -R fastrace_decode_signals_bounds --output-on-failure
ctest --test-dir build -R fastrace_store_fixture_prepare --output-on-failure  # guard against regressing Task 2's test
```

Expected: both PASS.

- [ ] **Step 6: Format and commit**

```bash
clang-format -i native/cli/src/main.cpp native/store/test/decode_bounds_check.cpp
git add native/cli/src/main.cpp native/store/test/decode_bounds_check.cpp native/store/test/run_decode_signals_bounds.cmake native/store/CMakeLists.txt
git commit -m "feat(cli): bound decode-signals to [start_us, end_us] and make re-decode idempotent"
```

---

### Task 4: Rust `crates/sidecar` - carry byte-progress fields

**Files:**
- Modify: `crates/sidecar/src/lib.rs:9-44` (`Progress` enum + `parse`)

**Interfaces:**
- Consumes: the new `"bytes_read"`/`"bytes_total"` JSON keys from Task 2.
- Produces: `Progress::Running { bytes_read, bytes_total, .. }`, `Progress::Done { bytes_read, bytes_total, .. }`. Task 6 reads these in `progress_to_json`.

- [ ] **Step 1: Write the failing tests**

In `crates/sidecar/src/lib.rs`'s `#[cfg(test)] mod tests`, update the two existing parse tests and their fixture JSON:

```rust
    #[test]
    fn parse_running_line() {
        let p = Progress::parse(
            r#"{"containers":1,"messages":10000,"bytes_read":500,"bytes_total":2000,"elapsed_ms":42}"#,
        )
        .unwrap();
        assert_eq!(
            p,
            Progress::Running {
                containers: 1,
                messages: 10000,
                bytes_read: 500,
                bytes_total: 2000,
                elapsed_ms: 42
            }
        );
    }

    #[test]
    fn parse_done_line() {
        let p = Progress::parse(
            r#"{"done":true,"containers":1,"messages":6,"protocol_rows":5,"bytes_read":2000,"bytes_total":2000,"elapsed_ms":78}"#,
        )
        .unwrap();
        assert_eq!(
            p,
            Progress::Done {
                containers: 1,
                messages: 6,
                protocol_rows: 5,
                bytes_read: 2000,
                bytes_total: 2000,
                elapsed_ms: 78
            }
        );
    }
```

- [ ] **Step 2: Run to verify it fails**

```bash
cargo test --manifest-path crates/Cargo.toml -p sidecar
```

Expected: FAIL (compile error - `Progress::Running`/`Done` don't have `bytes_read`/`bytes_total` fields yet).

- [ ] **Step 3: Implement**

```rust
#[derive(Debug, Clone, PartialEq)]
pub enum Progress {
    Running {
        containers: u64,
        messages: u64,
        bytes_read: u64,
        bytes_total: u64,
        elapsed_ms: u64,
    },
    Done {
        containers: u64,
        messages: u64,
        protocol_rows: u64,
        bytes_read: u64,
        bytes_total: u64,
        elapsed_ms: u64,
    },
}

impl Progress {
    pub fn parse(line: &str) -> Option<Progress> {
        let v: serde_json::Value = serde_json::from_str(line).ok()?;
        if v.get("done").is_some() {
            Some(Progress::Done {
                containers: v.get("containers")?.as_u64()?,
                messages: v.get("messages")?.as_u64()?,
                protocol_rows: v.get("protocol_rows")?.as_u64()?,
                bytes_read: v.get("bytes_read")?.as_u64()?,
                bytes_total: v.get("bytes_total")?.as_u64()?,
                elapsed_ms: v.get("elapsed_ms")?.as_u64()?,
            })
        } else {
            Some(Progress::Running {
                containers: v.get("containers")?.as_u64()?,
                messages: v.get("messages")?.as_u64()?,
                bytes_read: v.get("bytes_read")?.as_u64()?,
                bytes_total: v.get("bytes_total")?.as_u64()?,
                elapsed_ms: v.get("elapsed_ms")?.as_u64()?,
            })
        }
    }
}
```

- [ ] **Step 4: Run to verify it passes**

```bash
cargo test --manifest-path crates/Cargo.toml -p sidecar
```

Expected: PASS, including `parse_rejects_non_progress_json` (unaffected).

- [ ] **Step 5: Format and commit**

```bash
cargo fmt --manifest-path crates/Cargo.toml
git add crates/sidecar/src/lib.rs
git commit -m "feat(sidecar): parse bytes_read/bytes_total from prepare's progress protocol"
```

---

### Task 5: Rust `crates/query` - thread `start_us`/`end_us` through trace-wide reads

**Files:**
- Modify: `crates/query/src/lib.rs:48-80` (`list_message_groups`), `:97-160` (`list_messages`), `:234-249` (`list_signal_samples`), `:314-349` (`run_detector_query`)

**Interfaces:**
- Produces: `list_message_groups(conn, start_us: i64, end_us: i64)`, `list_messages(conn, group_key, cursor, limit, start_us: i64, end_us: i64)`, `list_signal_samples(conn, signal_id, limit, start_us: i64, end_us: i64)`, `run_detector_query(conn, sql, limit, start_us: i64, end_us: i64)`. Task 6's Tauri commands call these with the new params.
- Leaves unchanged: `get_message_detail`, `list_ecus`, `list_signal_catalog`, `get_trace_time_range`, `count` (per Global Constraints - static/single-row/full-span-defining reads aren't trim-scoped).

- [ ] **Step 1: Write the failing tests**

Add to `crates/query/src/lib.rs`'s test module (the `setup()` fixture already has messages at `timestamp_us` 1000/2000/3000/4000 across msg_id 1-4):

```rust
    #[test]
    fn list_message_groups_respects_time_bound() {
        let conn = setup();
        let groups = list_message_groups(&conn, 1000, 2000).unwrap();
        // can:200 is at timestamp_us=3000, outside the bound - must be excluded.
        assert!(groups.iter().all(|g| g.key != "can:200"));
        let can100 = groups.iter().find(|g| g.key == "can:100").unwrap();
        assert_eq!(can100.count, 2, "both can:100 rows (1000, 2000) are inside the bound");
    }

    #[test]
    fn list_messages_respects_time_bound() {
        let conn = setup();
        let page = list_messages(&conn, "can:100", None, 10, 1000, 1000).unwrap();
        assert_eq!(page.rows.len(), 1, "only the msg_id=1 row at timestamp_us=1000 is inside [1000,1000]");
        assert_eq!(page.rows[0].msg_id, 1);
    }

    #[test]
    fn list_signal_samples_respects_time_bound() {
        let conn = setup();
        conn.execute_batch(
            "INSERT INTO arxml_signal VALUES (0, 'EngineRpm', 'can', 100, 0, 16, false, 0.25, 0.0);
             INSERT INTO signals VALUES (0, 1, 1000, 513, 128.25);
             INSERT INTO signals VALUES (0, 2, 2000, 600, 150.0);",
        )
        .unwrap();
        let samples = list_signal_samples(&conn, 0, 10, 1500, 2500).unwrap();
        assert_eq!(samples, vec![(2000, 150.0)], "only the 2000us sample is inside [1500,2500]");
    }

    #[test]
    fn run_detector_query_respects_time_bound() {
        let conn = setup();
        let result = run_detector_query(&conn, "select msg_id, timestamp_us from messages", 10, 1000, 2000).unwrap();
        assert_eq!(result.matches.len(), 2, "only timestamp_us 1000 and 2000 are inside the bound");
        assert!(result.matches.iter().all(|m| m.timestamp_us >= 1000 && m.timestamp_us <= 2000));
    }
```

- [ ] **Step 2: Run to verify it fails**

```bash
cargo test --manifest-path crates/Cargo.toml -p query
```

Expected: FAIL (compile errors - the new tests pass extra args the current function signatures don't accept).

- [ ] **Step 3: Implement**

`list_message_groups`:

```rust
pub fn list_message_groups(
    conn: &trace_store::Connection,
    start_us: i64,
    end_us: i64,
) -> Result<Vec<MessageGroup>, String> {
    let sql = format!(
        "select 'can:' || cast(arb_id as varchar) as key,
                'CAN' as bus_label,
                coalesce((select name from arxml_can where can_id = arb_id limit 1), cast(arb_id as varchar)) as label,
                count(*) as count
         from messages
         where object_type in ({CAN_OBJECT_TYPES}) and timestamp_us between ? and ?
         group by arb_id
         union all
         select 'eth:' || coalesce(dst_ip,'') || ':' || cast(coalesce(dst_port,0) as varchar) as key,
                'Ethernet' as bus_label,
                coalesce(dst_ip,'?') || ':' || cast(coalesce(dst_port,0) as varchar) as label,
                count(*) as count
         from messages
         where object_type in ({ETHERNET_OBJECT_TYPES}) and timestamp_us between ? and ?
         group by dst_ip, dst_port
         order by 2, 3"
    );
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(duckdb::params![start_us, end_us, start_us, end_us], |row| {
            Ok(MessageGroup {
                key: row.get(0)?,
                bus_label: row.get(1)?,
                label: row.get(2)?,
                count: row.get(3)?,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())
}
```

`list_messages` - add `start_us: i64, end_us: i64` params and append `and timestamp_us between ? and ?` to both branches' `where` clauses, binding `start_us, end_us` after `arb_id`/`dst_port` and before `cursor`:

```rust
pub fn list_messages(
    conn: &trace_store::Connection,
    group_key: &str,
    cursor: Option<i64>,
    limit: i64,
    start_us: i64,
    end_us: i64,
) -> Result<MessagePage, String> {
    let cursor = cursor.unwrap_or(-1);
    let fetch = limit + 1;

    let mut rows: Vec<MessageRow> = if let Some(arb_id) = group_key.strip_prefix("can:") {
        let arb_id: i64 = arb_id
            .parse()
            .map_err(|_| format!("bad group key: {group_key}"))?;
        let sql = format!(
            "select msg_id, timestamp_us, 'CAN' as bus_label, cast(arb_id as varchar) as id_or_src,
                    (select name from arxml_can where can_id = arb_id limit 1) as name, dlc, payload_len
             from messages
             where object_type in ({CAN_OBJECT_TYPES}) and arb_id = ? and timestamp_us between ? and ? and msg_id > ?
             order by msg_id
             limit ?"
        );
        let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
        let out = stmt
            .query_map(duckdb::params![arb_id, start_us, end_us, cursor, fetch], map_message_row)
            .map_err(|e| e.to_string())?;
        out.collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?
    } else if let Some(rest) = group_key.strip_prefix("eth:") {
        let (dst_ip, dst_port) = rest
            .rsplit_once(':')
            .ok_or_else(|| format!("bad group key: {group_key}"))?;
        let dst_port: i32 = dst_port
            .parse()
            .map_err(|_| format!("bad group key: {group_key}"))?;
        let sql = format!(
            "select msg_id, timestamp_us, 'Ethernet' as bus_label,
                    coalesce(dst_ip,'') || ':' || cast(coalesce(dst_port,0) as varchar) as id_or_src,
                    cast(null as varchar) as name, dlc, payload_len
             from messages
             where object_type in ({ETHERNET_OBJECT_TYPES}) and dst_ip = ? and dst_port = ?
                   and timestamp_us between ? and ? and msg_id > ?
             order by msg_id
             limit ?"
        );
        let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
        let out = stmt
            .query_map(
                duckdb::params![dst_ip, dst_port, start_us, end_us, cursor, fetch],
                map_message_row,
            )
            .map_err(|e| e.to_string())?;
        out.collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?
    } else {
        return Err(format!("bad group key: {group_key}"));
    };

    let next_cursor = if rows.len() as i64 > limit {
        rows.truncate(limit as usize);
        rows.last().map(|r| r.msg_id)
    } else {
        None
    };
    Ok(MessagePage { rows, next_cursor })
}
```

`list_signal_samples`:

```rust
pub fn list_signal_samples(
    conn: &trace_store::Connection,
    signal_id: i64,
    limit: i64,
    start_us: i64,
    end_us: i64,
) -> Result<Vec<(i64, f64)>, String> {
    let mut stmt = conn
        .prepare(
            "select timestamp_us, phys_value from signals
             where signal_id = ? and timestamp_us between ? and ?
             order by timestamp_us limit ?",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(duckdb::params![signal_id, start_us, end_us, limit], |row| {
            Ok((row.get(0)?, row.get(1)?))
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())
}
```

`run_detector_query` - add the bound as an extra wrapping layer around the existing subquery, so it composes with arbitrary user SQL (including one ending in a line comment, which the existing wrap already handles by putting the closing `)` on its own line):

```rust
pub fn run_detector_query(
    conn: &trace_store::Connection,
    sql: &str,
    limit: i64,
    start_us: i64,
    end_us: i64,
) -> Result<DetectorQueryResult, String> {
    let trimmed = sql.trim();
    let trimmed = trimmed.strip_suffix(';').unwrap_or(trimmed).trim();
    if trimmed.is_empty() {
        return Err("query is empty".to_string());
    }
    let wrapped = format!(
        "select msg_id, timestamp_us from (
           select * from ({trimmed}\n) as detector_query_user_sql
           where timestamp_us between {start_us} and {end_us}
         ) as detector_query_result limit {}",
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
    let mut matches = rows
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    let truncated = matches.len() as i64 > limit;
    if truncated {
        matches.truncate(limit as usize);
    }
    Ok(DetectorQueryResult { matches, truncated })
}
```

(`start_us`/`end_us` are interpolated as literals here, not bound params, because they're `i64` values generated by the Rust caller - never user text - same trust boundary as the existing `limit + 1` interpolation two lines below it.)

- [ ] **Step 4: Fix the now-stale call sites in existing tests**

Every existing test calling these four functions needs the two new trailing args. Use a wide bound that includes all fixture data (`0, 10_000`) wherever the test isn't specifically about bounding:

```rust
    #[test]
    fn list_message_groups_aggregates_by_bus_and_id() {
        let conn = setup();
        let groups = list_message_groups(&conn, 0, 10_000).unwrap();
        // ... unchanged assertions below
    }

    #[test]
    fn list_messages_paginates_with_keyset_cursor() {
        let conn = setup();
        let page1 = list_messages(&conn, "can:100", None, 1, 0, 10_000).unwrap();
        // ...
        let page2 = list_messages(&conn, "can:100", page1.next_cursor, 1, 0, 10_000).unwrap();
        // ...
    }

    #[test]
    fn list_messages_rejects_unrecognized_group_key() {
        let conn = setup();
        assert!(list_messages(&conn, "bogus:1", None, 10, 0, 10_000).is_err());
    }
```

Apply the same `0, 10_000` trailing-args fix to every other `run_detector_query(...)` and `list_signal_samples(...)` call in the existing test module (`run_detector_query_returns_matching_rows`, `..._truncates_at_limit...`, `..._does_not_truncate...`, `..._errors_when_msg_id_column_missing`, `..._errors_when_timestamp_us_column_missing`, `..._errors_on_empty_sql`, `..._strips_one_trailing_semicolon`, `..._handles_trailing_line_comment`, `..._surfaces_bad_sql_errors`, `list_signal_samples_orders_by_timestamp_and_respects_limit`).

- [ ] **Step 5: Run to verify it passes**

```bash
cargo test --manifest-path crates/Cargo.toml -p query
```

Expected: PASS, all tests including the 4 new ones.

- [ ] **Step 6: Format, lint, commit**

```bash
cargo fmt --manifest-path crates/Cargo.toml
cargo clippy --manifest-path crates/Cargo.toml -p query
git add crates/query/src/lib.rs
git commit -m "feat(query): thread start_us/end_us trim bound through trace-wide reads"
```

---

### Task 6: Tauri `app/src-tauri` - wire the new params/fields through commands

**Files:**
- Modify: `app/src-tauri/src/main.rs:66-99` (`progress_to_json`), `:129-153` (`decode_signals`), `:194-256` (`list_message_groups`, `list_messages`, `list_signal_catalog` - unchanged, `get_signal_samples`, `list_ecus` - unchanged, `get_trace_time_range` - unchanged, `run_detector_query`)

**Interfaces:**
- Consumes: Task 4's `bytes_read`/`bytes_total` fields, Task 5's `start_us`/`end_us` params.
- Produces: new/changed Tauri commands:
  - `list_message_groups(blf_path, start_us: i64, end_us: i64)`
  - `list_messages(blf_path, group_key, cursor, limit, start_us: i64, end_us: i64)`
  - `get_signal_samples(blf_path, signal_id, limit, start_us: i64, end_us: i64)`
  - `run_detector_query(blf_path, sql, start_us: i64, end_us: i64)`
  - `decode_signals(blf_path, signal_ids, start_us: i64, end_us: i64)`
  - `prepare_trace`'s and `decode_signals`' emitted `"prepare-progress"`/`"decode-progress"` JSON payloads now carry `bytes_read`/`bytes_total`.
  Task 7 (`trace-source.ts`) calls all of these with matching argument names (Tauri's `invoke` maps camelCase JS keys to these snake_case Rust params automatically, same as every existing command).

- [ ] **Step 1: Write the failing unit tests**

Add to `app/src-tauri/src/main.rs`'s `#[cfg(test)] mod tests`:

```rust
    #[test]
    fn progress_to_json_includes_byte_progress() {
        let p = sidecar::Progress::Done {
            containers: 1,
            messages: 6,
            protocol_rows: 5,
            bytes_read: 2000,
            bytes_total: 2000,
            elapsed_ms: 78,
        };
        let v = progress_to_json(&p);
        assert_eq!(v["bytes_read"], 2000);
        assert_eq!(v["bytes_total"], 2000);
    }
```

- [ ] **Step 2: Run to verify it fails**

```bash
cargo test --manifest-path crates/Cargo.toml -p fastrace 2>&1 | head -40
```

(If the Tauri app crate isn't part of the `crates/Cargo.toml` workspace, run from `app/src-tauri` instead: `cargo test --manifest-path app/src-tauri/Cargo.toml`.) Expected: FAIL (compile error - `sidecar::Progress::Done` doesn't take `bytes_read`/`bytes_total` until Task 4's crate is used here, and `fold_final_done_picks_the_done_tick_not_the_last_running_one`/`fold_final_done_is_null_when_no_done_tick_present` also need the two new fields added to their literals or they won't compile).

- [ ] **Step 3: Implement**

`progress_to_json`:

```rust
fn progress_to_json(p: &sidecar::Progress) -> serde_json::Value {
    match p {
        sidecar::Progress::Running {
            containers,
            messages,
            bytes_read,
            bytes_total,
            elapsed_ms,
        } => serde_json::json!({
            "done": false, "containers": containers, "messages": messages,
            "bytes_read": bytes_read, "bytes_total": bytes_total, "elapsed_ms": elapsed_ms
        }),
        sidecar::Progress::Done {
            containers,
            messages,
            protocol_rows,
            bytes_read,
            bytes_total,
            elapsed_ms,
        } => serde_json::json!({
            "done": true, "containers": containers, "messages": messages,
            "protocol_rows": protocol_rows, "bytes_read": bytes_read, "bytes_total": bytes_total,
            "elapsed_ms": elapsed_ms
        }),
    }
}
```

Update the two existing `fold_final_done` tests' literals to include `bytes_read`/`bytes_total` (any values, e.g. `bytes_read: 500_000, bytes_total: 1_000_000` for the `Running` tick and `bytes_read: 1_000_000, bytes_total: 1_000_000` for `Done`).

`decode_signals` - thread the bound through to the CLI args (which Task 3 now requires in positions 3/4):

```rust
#[tauri::command]
async fn decode_signals(
    app: tauri::AppHandle,
    blf_path: String,
    signal_ids: Vec<i64>,
    start_us: i64,
    end_us: i64,
) -> Result<serde_json::Value, String> {
    let bin = begin_prepare(app.state::<PrepareGuard>().inner(), fastrace_parse_bin())?;
    let app_for_task = app.clone();
    let joined: Result<serde_json::Value, String> =
        tauri::async_runtime::spawn_blocking(move || {
            let mut args = vec![
                "decode-signals".to_string(),
                blf_path,
                start_us.to_string(),
                end_us.to_string(),
            ];
            args.extend(signal_ids.iter().map(|id| id.to_string()));
            let mut ticks = Vec::new();
            sidecar::spawn(&bin, &args, |progress| {
                let _ = app_for_task.emit("decode-progress", progress_to_json(&progress));
                ticks.push(progress);
            })
            .map(|_| fold_final_done(&ticks))
        })
        .await
        .map_err(|e| e.to_string())?;

    app.state::<PrepareGuard>().release();
    joined
}
```

`list_message_groups`, `list_messages`, `get_signal_samples`, `run_detector_query`:

```rust
#[tauri::command]
fn list_message_groups(blf_path: String, start_us: i64, end_us: i64) -> Result<Vec<query::MessageGroup>, String> {
    let duckdb_path = std::path::Path::new(&blf_path).with_extension("duckdb");
    let conn = trace_store::open(&duckdb_path)?;
    query::list_message_groups(&conn, start_us, end_us)
}

#[tauri::command]
fn list_messages(
    blf_path: String,
    group_key: String,
    cursor: Option<i64>,
    limit: i64,
    start_us: i64,
    end_us: i64,
) -> Result<query::MessagePage, String> {
    let duckdb_path = std::path::Path::new(&blf_path).with_extension("duckdb");
    let conn = trace_store::open(&duckdb_path)?;
    query::list_messages(&conn, &group_key, cursor, limit, start_us, end_us)
}

#[tauri::command]
fn get_signal_samples(
    blf_path: String,
    signal_id: i64,
    limit: i64,
    start_us: i64,
    end_us: i64,
) -> Result<Vec<(i64, f64)>, String> {
    let duckdb_path = std::path::Path::new(&blf_path).with_extension("duckdb");
    let conn = trace_store::open(&duckdb_path)?;
    query::list_signal_samples(&conn, signal_id, limit, start_us, end_us)
}

#[tauri::command]
fn run_detector_query(blf_path: String, sql: String, start_us: i64, end_us: i64) -> Result<query::DetectorQueryResult, String> {
    let duckdb_path = std::path::Path::new(&blf_path).with_extension("duckdb");
    let conn = trace_store::open(&duckdb_path)?;
    query::run_detector_query(&conn, &sql, query::DETECTOR_QUERY_MATCH_LIMIT, start_us, end_us)
}
```

- [ ] **Step 4: Run to verify it passes**

```bash
cargo test --manifest-path crates/Cargo.toml   # sidecar + query, guards against regressions
cargo build --manifest-path app/src-tauri/Cargo.toml
cargo test --manifest-path app/src-tauri/Cargo.toml 2>/dev/null || true  # run if this crate has its own test target
```

Expected: builds clean, `progress_to_json_includes_byte_progress` and the two updated `fold_final_done` tests PASS.

- [ ] **Step 5: Format and commit**

```bash
cargo fmt --manifest-path crates/Cargo.toml
git add app/src-tauri/src/main.rs
git commit -m "feat(tauri): thread trim bound and byte-progress through commands"
```

---

### Task 7: Frontend - thread trim bound and byte-progress through `types.ts`/`trace-source.ts`/`hooks.ts`

**Files:**
- Modify: `app/ui/src/types.ts`
- Modify: `app/ui/src/shared/api/trace-source.ts`
- Modify: `app/ui/src/shared/api/hooks.ts`

**Interfaces:**
- Produces: `ProgressTick` gains `bytes_read`/`bytes_total`. `TraceDataSource.listMessageGroups/listMessages/getSignalSamples/runDetectorQuery/decodeSignals` all gain a `startUs: number, endUs: number` parameter (inserted right after the signal/path/group args they already take, before `limit`/`cursor` where those exist - exact positions below). `useMessageGroups`, `useMessages`, `useSignalSamples`, `useSignalSamplesList`, `useRunDetectorQuery`, `useDecodeSignals` all gain a `{ startUs, endUs }` argument and include it in their `queryKey`/`mutationFn` closure, so Task 11's components can pass the store's trim range straight through.

There is no test runner configured for `app/ui` (no `vitest`/`jest`, no `*.test.ts` anywhere in the tree) - this codebase's established verification for frontend changes is `tsc`/`npm run build` plus manual run-through, not unit tests. Steps below use that instead of a red/green test cycle.

- [ ] **Step 1: `types.ts` - widen `ProgressTick`**

```ts
export type ProgressTick =
  | { done: false; containers: number; messages: number; bytes_read: number; bytes_total: number; elapsed_ms: number }
  | {
      done: true;
      containers: number;
      messages: number;
      protocol_rows: number;
      bytes_read: number;
      bytes_total: number;
      elapsed_ms: number;
    };
```

- [ ] **Step 2: `trace-source.ts` - widen the interface and the Tauri implementation**

In the `TraceDataSource` interface:

```ts
  listMessageGroups(blfPath: string, startUs: number, endUs: number): Promise<MessageGroup[]>;
  listMessages(
    blfPath: string,
    groupKey: string,
    cursor: number | null,
    limit: number,
    startUs: number,
    endUs: number
  ): Promise<MessagePage>;
  listEcus(blfPath: string): Promise<EcuInfo[]>;
  listSignalCatalog(blfPath: string): Promise<SignalCatalogEntry[]>;
  getSignalSamples(
    blfPath: string,
    signalId: number,
    limit: number,
    startUs: number,
    endUs: number
  ): Promise<[number, number][]>;
  runDetectorQuery(blfPath: string, sql: string, startUs: number, endUs: number): Promise<DetectorQueryResult>;
  getTraceTimeRange(blfPath: string): Promise<TraceTimeRange>;
  decodeSignals(blfPath: string, signalIds: number[], startUs: number, endUs: number): Promise<DecodeResult>;
```

In `TauriTraceDataSource`:

```ts
  listMessageGroups(blfPath: string, startUs: number, endUs: number): Promise<MessageGroup[]> {
    return invoke<MessageGroup[]>("list_message_groups", { blfPath, startUs, endUs });
  }

  listMessages(
    blfPath: string,
    groupKey: string,
    cursor: number | null,
    limit: number,
    startUs: number,
    endUs: number
  ): Promise<MessagePage> {
    return invoke<MessagePage>("list_messages", { blfPath, groupKey, cursor, limit, startUs, endUs });
  }

  getSignalSamples(
    blfPath: string,
    signalId: number,
    limit: number,
    startUs: number,
    endUs: number
  ): Promise<[number, number][]> {
    return invoke<[number, number][]>("get_signal_samples", { blfPath, signalId, limit, startUs, endUs });
  }

  runDetectorQuery(blfPath: string, sql: string, startUs: number, endUs: number): Promise<DetectorQueryResult> {
    return invoke<DetectorQueryResult>("run_detector_query", { blfPath, sql, startUs, endUs });
  }

  async decodeSignals(blfPath: string, signalIds: number[], startUs: number, endUs: number): Promise<DecodeResult> {
    const tick = await invoke<{ elapsed_ms: number; protocol_rows: number }>("decode_signals", {
      blfPath,
      signalIds,
      startUs,
      endUs,
    });
    return { elapsedMs: tick.elapsed_ms, decodedCount: tick.protocol_rows };
  }
```

(`listEcus`, `listSignalCatalog`, `getMessageDetail`, `getTraceTimeRange`, `getTraceSummary` are unchanged.)

- [ ] **Step 3: `hooks.ts` - thread the bound through the query layer**

```ts
export function useMessageGroups(blfPath: string, startUs: number, endUs: number) {
  return useQuery({
    queryKey: ["message-groups", blfPath, startUs, endUs],
    queryFn: () => getTraceDataSource().listMessageGroups(blfPath, startUs, endUs),
  });
}
```

```ts
export function useMessages(blfPath: string, groupKey: string | null, startUs: number, endUs: number) {
  return useInfiniteQuery({
    queryKey: ["messages", blfPath, groupKey, startUs, endUs],
    queryFn: ({ pageParam }) =>
      getTraceDataSource().listMessages(blfPath, groupKey as string, pageParam, MESSAGE_PAGE_SIZE, startUs, endUs),
    initialPageParam: null as number | null,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    enabled: groupKey !== null,
  });
}
```

```ts
export function useSignalSamples(
  blfPath: string,
  signalId: number | null,
  startUs: number,
  endUs: number,
  limit = 200
) {
  return useQuery({
    queryKey: ["signal-samples", blfPath, signalId, startUs, endUs, limit],
    queryFn: () => getTraceDataSource().getSignalSamples(blfPath, signalId as number, limit, startUs, endUs),
    enabled: signalId !== null,
  });
}
```

```ts
export function useSignalSamplesList(
  blfPath: string,
  signalIds: number[],
  startUs: number,
  endUs: number,
  limit = TIMELINE_SAMPLE_LIMIT
) {
  return useQueries({
    queries: signalIds.map((signalId) => ({
      queryKey: ["signal-samples", blfPath, signalId, startUs, endUs, limit],
      queryFn: () => getTraceDataSource().getSignalSamples(blfPath, signalId, limit, startUs, endUs),
    })),
  });
}
```

```ts
export function useRunDetectorQuery(blfPath: string, startUs: number, endUs: number) {
  return useMutation({
    mutationFn: (sql: string) => getTraceDataSource().runDetectorQuery(blfPath, sql, startUs, endUs),
  });
}
```

```ts
export function useDecodeSignals(blfPath: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationKey: decodeSignalsMutationKey(blfPath),
    mutationFn: ({ signalIds, startUs, endUs }: { signalIds: number[]; startUs: number; endUs: number }) =>
      getTraceDataSource().decodeSignals(blfPath, signalIds, startUs, endUs),
    onSuccess: (result, { signalIds }) => {
      queryClient.invalidateQueries({ queryKey: SIGNAL_CATALOG_KEY(blfPath) });
      const detail = `${signalIds.length} signal${signalIds.length === 1 ? "" : "s"}`;
      getTraceDataSource()
        .recordActivity(blfPath, "decode", result.elapsedMs, detail)
        .then(() => queryClient.invalidateQueries({ queryKey: ACTIVITIES_KEY(blfPath) }));
    },
    onError: (e) => useToastStore.getState().pushError(String(e)),
  });
}
```

(`useDecodeSignals`'s mutate call now takes one object argument instead of a bare array - Task 11/12 update both call sites, `SignalsList.tsx` and the new Apply handler.)

`useMessageDetail`, `useSignalCatalog`, `useTraceSummary`, `useEcus`, `useTraceTimeRange`, and everything below `useFileSizes` are unchanged.

- [ ] **Step 4: Type-check**

```bash
npx tsc --noEmit -p app/ui
```

Expected: errors at every call site not yet updated (`TraceRail.tsx`, `MessageList.tsx`, `SignalsList.tsx`, `AnalyzerPanel.tsx`, `TimelineChart.tsx`) - these are fixed in Task 11. Confirm the errors are exactly "missing arguments" at those five files and nowhere inside `hooks.ts`/`trace-source.ts`/`types.ts` themselves.

- [ ] **Step 5: Commit**

```bash
git add app/ui/src/types.ts app/ui/src/shared/api/trace-source.ts app/ui/src/shared/api/hooks.ts
git commit -m "feat(ui): thread trim bound and byte-progress through the data-source/query layer"
```

---

### Task 8: Frontend - trim range store state + `Skeleton` primitive

**Files:**
- Modify: `app/ui/src/app/store.ts`
- Create: `app/ui/src/shared/ui/skeleton.tsx`

**Interfaces:**
- Produces: `useWorkspaceStore`'s `appliedTrimRange: { start: number; end: number } | null`, `pendingTrimRange: { start: number; end: number } | null`, `setPendingTrimRange(range)`, `applyTrim()` (commits `pendingTrimRange` → `appliedTrimRange`), `initTrimRangeIfUnset(start, end)` (sets both to the full span, only if `appliedTrimRange` is still `null` - called once Prepare's `Done` tick / `useTraceTimeRange` resolves). `Skeleton` component (`className` prop, renders a pulsing placeholder block) - consumed by Task 11's panel skeletons.

- [ ] **Step 1: Add trim state to `app/store.ts`**

```ts
export interface TrimRange {
  start: number;
  end: number;
}

export interface WorkspaceState {
  // ... existing fields ...
  appliedTrimRange: TrimRange | null;
  pendingTrimRange: TrimRange | null;
  setPendingTrimRange: (range: TrimRange) => void;
  applyTrim: () => void;
  initTrimRangeIfUnset: (start: number, end: number) => void;
  resetTrimRange: () => void;
}
```

```ts
  appliedTrimRange: null,
  pendingTrimRange: null,
  setPendingTrimRange: (range) => set({ pendingTrimRange: range }),
  applyTrim: () =>
    set((s) => (s.pendingTrimRange ? { appliedTrimRange: s.pendingTrimRange } : {})),
  // Only seeds the full-span default once per trace - re-opening the Signals
  // tab or re-fetching the time range must not stomp a user's in-progress
  // narrower trim back to full span.
  initTrimRangeIfUnset: (start, end) =>
    set((s) =>
      s.appliedTrimRange === null
        ? { appliedTrimRange: { start, end }, pendingTrimRange: { start, end } }
        : {}
    ),
  resetTrimRange: () => set({ appliedTrimRange: null, pendingTrimRange: null }),
```

`resetTrimRange` is called from `App.tsx`'s existing `reset()` (Task 10), alongside `resetDetectorQuery()`, so switching traces doesn't carry over a stale trim window.

- [ ] **Step 2: Create `shared/ui/skeleton.tsx`**

```tsx
import { cn } from "./lib/utils";

export function Skeleton({ className }: { className?: string }) {
  return <div className={cn("animate-pulse rounded-md bg-muted", className)} />;
}
```

- [ ] **Step 3: Type-check**

```bash
npx tsc --noEmit -p app/ui
```

Expected: no new errors from this task's own files (existing call-site errors from Task 7 remain, unaffected by this task).

- [ ] **Step 4: Commit**

```bash
git add app/ui/src/app/store.ts app/ui/src/shared/ui/skeleton.tsx
git commit -m "feat(ui): add trim range store state and a Skeleton placeholder primitive"
```

---

### Task 9: Frontend - `TrimControl` + `TopBar` handoff

**Files:**
- Create: `app/ui/src/widgets/TrimControl.tsx`
- Modify: `app/ui/src/widgets/TopBar.tsx`

**Interfaces:**
- Consumes: Task 8's `pendingTrimRange`/`appliedTrimRange`/`setPendingTrimRange`/`applyTrim`, `useTraceTimeRange` (existing hook), Task 7's widened `ProgressTick`.
- Produces: `TrimControl({ blfPath, onApply }: { blfPath: string; onApply: () => void })` - `onApply` is called after the store commit, so Task 12's signal-re-decode wiring can hook in without `TrimControl` itself knowing about `DecodeOverlay`. `TopBar` gains `preparing: boolean` and `tick: ProgressTick | null` props; renders the byte-% indicator when `preparing`, otherwise `TrimControl`.

- [ ] **Step 1: Write `TrimControl.tsx`**

```tsx
import { useEffect } from "react";
import { useWorkspaceStore } from "@/app/store";
import { useTraceTimeRange } from "@/shared/api/hooks";
import { Button } from "@/shared/ui/button";

interface TrimControlProps {
  blfPath: string;
  onApply: () => void;
}

export default function TrimControl({ blfPath, onApply }: TrimControlProps) {
  const timeRange = useTraceTimeRange(blfPath);
  const pending = useWorkspaceStore((s) => s.pendingTrimRange);
  const applied = useWorkspaceStore((s) => s.appliedTrimRange);
  const setPendingTrimRange = useWorkspaceStore((s) => s.setPendingTrimRange);
  const applyTrim = useWorkspaceStore((s) => s.applyTrim);
  const initTrimRangeIfUnset = useWorkspaceStore((s) => s.initTrimRangeIfUnset);

  useEffect(() => {
    if (timeRange.data) {
      initTrimRangeIfUnset(timeRange.data.minTimestampUs, timeRange.data.maxTimestampUs);
    }
  }, [timeRange.data, initTrimRangeIfUnset]);

  if (!timeRange.data || !pending) {
    return null;
  }

  const { minTimestampUs, maxTimestampUs } = timeRange.data;
  const hasPendingChange = !applied || applied.start !== pending.start || applied.end !== pending.end;

  function handleApply() {
    applyTrim();
    onApply();
  }

  return (
    <div className="flex items-center gap-2">
      <span className="font-mono text-[10px] text-muted-foreground">{pending.start.toLocaleString()}</span>
      <input
        type="range"
        min={minTimestampUs}
        max={pending.end}
        value={pending.start}
        onChange={(e) => setPendingTrimRange({ start: Number(e.target.value), end: pending.end })}
        className="w-28"
        aria-label="Trim start"
      />
      <input
        type="range"
        min={pending.start}
        max={maxTimestampUs}
        value={pending.end}
        onChange={(e) => setPendingTrimRange({ start: pending.start, end: Number(e.target.value) })}
        className="w-28"
        aria-label="Trim end"
      />
      <span className="font-mono text-[10px] text-muted-foreground">{pending.end.toLocaleString()}</span>
      <Button size="sm" variant={hasPendingChange ? "default" : "secondary"} disabled={!hasPendingChange} onClick={handleApply}>
        Apply
      </Button>
    </div>
  );
}
```

- [ ] **Step 2: Update `TopBar.tsx`**

```tsx
import type { ProgressTick } from "@/types";
import { Button } from "@/shared/ui/button";
import TrimControl from "./TrimControl";

interface TopBarProps {
  traceName: string;
  blfPath: string;
  preparing: boolean;
  tick: ProgressTick | null;
  onOpenTrace: () => void;
  onApplyTrim: () => void;
}

function ByteProgress({ tick }: { tick: ProgressTick | null }) {
  const pct = tick && tick.bytes_total > 0 ? Math.min(100, Math.round((tick.bytes_read / tick.bytes_total) * 100)) : 0;
  return (
    <div className="flex items-center gap-2">
      <div className="h-1.5 w-32 overflow-hidden rounded-full bg-muted">
        <div className="h-full bg-primary transition-[width]" style={{ width: `${pct}%` }} />
      </div>
      <span className="font-mono text-[10px] text-muted-foreground">{pct}%</span>
    </div>
  );
}

export default function TopBar({ traceName, blfPath, preparing, tick, onOpenTrace, onApplyTrim }: TopBarProps) {
  return (
    <header className="flex h-[50px] shrink-0 items-center justify-between border-b border-border bg-card px-4">
      <div className="flex min-w-0 items-center gap-3">
        <span className="truncate text-sm font-semibold">{traceName}</span>
        {preparing ? <ByteProgress tick={tick} /> : <TrimControl blfPath={blfPath} onApply={onApplyTrim} />}
      </div>
      <div className="flex items-center gap-2">
        <Button variant="secondary" size="sm" onClick={onOpenTrace} disabled={preparing}>
          Open Trace
        </Button>
      </div>
    </header>
  );
}
```

- [ ] **Step 3: Type-check**

```bash
npx tsc --noEmit -p app/ui
```

Expected: new error only where `TopBar` is instantiated (`WorkspaceLayout.tsx`, not yet updated - fixed in Task 11).

- [ ] **Step 4: Commit**

```bash
git add app/ui/src/widgets/TrimControl.tsx app/ui/src/widgets/TopBar.tsx
git commit -m "feat(ui): add TrimControl and give TopBar a progress/trim handoff slot"
```

---

### Task 10: Frontend - `App.tsx` mounts the workspace immediately, deletes `Progress.tsx`

**Files:**
- Modify: `app/ui/src/App.tsx`
- Delete: `app/ui/src/Progress.tsx`

**Interfaces:**
- Produces: `App`'s `screen` type drops `"progress"`; a new `preparing: boolean` state flag and the existing `tick` state are passed into `WorkspaceLayout` (Task 11 adds the corresponding props).

- [ ] **Step 1: Rewrite `App.tsx`**

```tsx
import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { QueryClientProvider } from "@tanstack/react-query";
import Welcome from "./Welcome";
import ErrorScreen from "./ErrorScreen";
import WorkspaceLayout from "./widgets/WorkspaceLayout";
import { queryClient } from "./app/query-client";
import { useWorkspaceStore } from "./app/store";
import { getTraceDataSource, type PrepareMeta } from "./shared/api/trace-source";
import type { ProgressTick } from "./types";

type Screen = "welcome" | "workspace" | "error";

export default function App() {
  const [screen, setScreen] = useState<Screen>("welcome");
  const [preparing, setPreparing] = useState(false);
  const [tick, setTick] = useState<ProgressTick | null>(null);
  const [prepareTotals, setPrepareTotals] = useState<{
    messages: number;
    protocol_rows: number;
    elapsed_ms: number;
  } | null>(null);
  const [blfPath, setBlfPath] = useState("");
  const [errorMessage, setErrorMessage] = useState("");

  useEffect(() => {
    const unlisten = listen<ProgressTick>("prepare-progress", (event) => {
      setTick(event.payload);
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  }, []);

  async function handleStart(startBlfPath: string, arxmlPath: string) {
    setTick(null);
    setBlfPath(startBlfPath);
    useWorkspaceStore.getState().resetDetectorQuery();
    useWorkspaceStore.getState().resetTrimRange();
    setPreparing(true);
    setScreen("workspace");
    try {
      const doneTick = await invoke<ProgressTick & { done: true }>("prepare_trace", {
        blfPath: startBlfPath,
        arxmlPath,
      });
      setPrepareTotals(doneTick);
      await getTraceDataSource().recordRecentTrace(startBlfPath, {
        messages: doneTick.messages,
        protocolRows: doneTick.protocol_rows,
        elapsedMs: doneTick.elapsed_ms,
      });
      setPreparing(false);
    } catch (e) {
      setErrorMessage(String(e));
      setScreen("error");
    }
  }

  function handleOpenExisting(openBlfPath: string, meta?: PrepareMeta) {
    getTraceDataSource().recordRecentTrace(openBlfPath);
    setBlfPath(openBlfPath);
    useWorkspaceStore.getState().resetDetectorQuery();
    useWorkspaceStore.getState().resetTrimRange();
    setPrepareTotals(
      meta ? { messages: meta.messages, protocol_rows: meta.protocolRows, elapsed_ms: meta.elapsedMs } : null
    );
    setPreparing(false);
    setScreen("workspace");
  }

  function reset() {
    setScreen("welcome");
    setPreparing(false);
    setTick(null);
    setPrepareTotals(null);
    setBlfPath("");
    useWorkspaceStore.getState().resetDetectorQuery();
    useWorkspaceStore.getState().resetTrimRange();
    setErrorMessage("");
  }

  return (
    <QueryClientProvider client={queryClient}>
      {screen === "welcome" && <Welcome onStart={handleStart} onOpenExisting={handleOpenExisting} />}
      {screen === "error" && <ErrorScreen message={errorMessage} onRetry={reset} />}
      {screen === "workspace" && blfPath && (
        <WorkspaceLayout
          blfPath={blfPath}
          preparing={preparing}
          tick={tick}
          prepareTotals={prepareTotals}
          onOpenTrace={reset}
        />
      )}
    </QueryClientProvider>
  );
}
```

This directly satisfies Review Focus item 3: a Prepare failure (the `catch` block) sets `screen` to `"error"` unconditionally, regardless of whether `preparing`/skeletons were already showing - `WorkspaceLayout` unmounts and `ErrorScreen` takes over exactly as it did before this refactor.

- [ ] **Step 2: Delete the old screen**

```bash
git rm app/ui/src/Progress.tsx
```

- [ ] **Step 3: Type-check**

```bash
npx tsc --noEmit -p app/ui
```

Expected: errors only in `WorkspaceLayout.tsx` (new props not yet accepted - Task 11 fixes this) and nothing referencing the deleted `Progress.tsx`/`ProgressScreen` anywhere (`grep -rn "ProgressScreen\|from \"./Progress\"" app/ui/src` should return nothing).

- [ ] **Step 4: Commit**

```bash
git add app/ui/src/App.tsx
git commit -m "feat(ui): mount WorkspaceLayout immediately on Start Processing, drop ProgressScreen"
```

---

### Task 11: Frontend - skeleton panels + thread trim range into every call site

**Files:**
- Modify: `app/ui/src/widgets/WorkspaceLayout.tsx`
- Modify: `app/ui/src/widgets/TraceRail.tsx`
- Modify: `app/ui/src/widgets/MessageList.tsx`
- Modify: `app/ui/src/widgets/SignalsList.tsx`
- Modify: `app/ui/src/widgets/AnalyzerPanel.tsx`
- Modify: `app/ui/src/widgets/TimelineChart.tsx`
- Modify: `app/ui/src/widgets/TimelinePanel.tsx` (prop passthrough only)

**Interfaces:**
- Consumes: Task 8's `appliedTrimRange`, Task 9's `TopBar` props, Task 7's widened hooks.
- Produces: `WorkspaceLayout({ blfPath, preparing, tick, prepareTotals, onOpenTrace })` - the `preparing` flag gates every panel's content vs. a `Skeleton` block.

- [ ] **Step 1: `WorkspaceLayout.tsx` - accept the new props, render skeletons while preparing**

```tsx
import type { ReactNode } from "react";
import { useFileSizes, useIsDecodingSignals } from "@/shared/api/hooks";
import { formatBytes } from "@/shared/ui/lib/utils";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/shared/ui/resizable";
import { Skeleton } from "@/shared/ui/skeleton";
import ActivityLog from "./ActivityLog";
import AnalyzerPanel from "./AnalyzerPanel";
import DecodeOverlay from "./DecodeOverlay";
import MessageDetails from "./MessageDetails";
import MessageList from "./MessageList";
import TimelinePanel from "./TimelinePanel";
import Toaster from "./Toaster";
import TopBar from "./TopBar";
import TraceRail from "./TraceRail";
import type { ProgressTick } from "@/types";

interface WorkspaceLayoutProps {
  blfPath: string;
  preparing: boolean;
  tick: ProgressTick | null;
  prepareTotals: { messages: number; protocol_rows: number; elapsed_ms: number } | null;
  onOpenTrace: () => void;
}

function PanelTag({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex h-full flex-col">
      <div className="shrink-0 border-b border-border bg-background px-2 py-1 text-[10px] font-mono uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      <div className="min-h-0 flex-1">{children}</div>
    </div>
  );
}

function PanelSkeleton() {
  return (
    <div className="flex h-full flex-col gap-2 p-3">
      <Skeleton className="h-4 w-2/3" />
      <Skeleton className="h-4 w-full" />
      <Skeleton className="h-4 w-5/6" />
      <Skeleton className="h-4 w-1/2" />
    </div>
  );
}
// ... StatusBar unchanged ...

export default function WorkspaceLayout({ blfPath, preparing, tick, prepareTotals, onOpenTrace }: WorkspaceLayoutProps) {
  const isDecoding = useIsDecodingSignals(blfPath);
  return (
    <div className="flex h-screen flex-col">
      <TopBar
        traceName={blfPath.split(/[\\/]/).pop() ?? blfPath}
        blfPath={blfPath}
        preparing={preparing}
        tick={tick}
        onOpenTrace={onOpenTrace}
        onApplyTrim={() => {}} // replaced with the real handler in Task 12
      />
      <div className="min-h-0 flex-1">
        <ResizablePanelGroup direction="horizontal">
          <ResizablePanel defaultSize={27} minSize={27}>
            <PanelTag label="Trace Rail">{preparing ? <PanelSkeleton /> : <TraceRail blfPath={blfPath} />}</PanelTag>
          </ResizablePanel>
          <ResizableHandle withHandle />
          <ResizablePanel defaultSize={55}>
            <ResizablePanelGroup direction="vertical">
              <ResizablePanel defaultSize={20} minSize={10}>
                <PanelTag label="Timeline">
                  {preparing ? <PanelSkeleton /> : <TimelinePanel blfPath={blfPath} />}
                </PanelTag>
              </ResizablePanel>
              <ResizableHandle withHandle />
              <ResizablePanel defaultSize={45} minSize={15}>
                <PanelTag label="Message List">
                  {preparing ? <PanelSkeleton /> : <MessageList blfPath={blfPath} />}
                </PanelTag>
              </ResizablePanel>
              <ResizableHandle withHandle />
              <ResizablePanel defaultSize={35} minSize={15}>
                <PanelTag label="Message Details">
                  {preparing ? <PanelSkeleton /> : <MessageDetails blfPath={blfPath} />}
                </PanelTag>
              </ResizablePanel>
            </ResizablePanelGroup>
          </ResizablePanel>
          <ResizableHandle withHandle />
          <ResizablePanel defaultSize={25} minSize={15}>
            <PanelTag label="Analyzer">{preparing ? <PanelSkeleton /> : <AnalyzerPanel blfPath={blfPath} />}</PanelTag>
          </ResizablePanel>
        </ResizablePanelGroup>
      </div>
      <StatusBar blfPath={blfPath} prepareTotals={prepareTotals} />
      <Toaster />
      <DecodeOverlay active={isDecoding} />
    </div>
  );
}
```

`onApplyTrim`'s real handler (calling `useDecodeSignals` for the active signal set) is written in Task 12 Step 1 - this task only wires the prop through with a no-op placeholder function.

- [ ] **Step 2: `TraceRail.tsx` - read trim range, pass to `useMessageGroups`**

```tsx
import { useWorkspaceStore, type LeftTab } from "@/app/store";
import { useEcus, useMessageGroups, useSignalCatalog, useTraceSummary } from "@/shared/api/hooks";
// ...
export default function TraceRail({ blfPath }: TraceRailProps) {
  const summary = useTraceSummary(blfPath);
  const trimRange = useWorkspaceStore((s) => s.appliedTrimRange);
  const groups = useMessageGroups(blfPath, trimRange?.start ?? 0, trimRange?.end ?? Number.MAX_SAFE_INTEGER);
  const ecus = useEcus(blfPath);
  // ... rest unchanged
```

(`trimRange` is `null` only in the brief instant before `TrimControl`'s `initTrimRangeIfUnset` effect fires post-Prepare; `TraceRail` only ever mounts once `preparing` is `false`, i.e. after that effect has had a tick to run via `useTraceTimeRange`'s already-resolved cache - the `?? 0`/`?? MAX_SAFE_INTEGER` fallback exists purely so TypeScript doesn't require a null-check render branch, not because it's expected to fire.)

- [ ] **Step 3: `MessageList.tsx` - same pattern**

```tsx
import { useWorkspaceStore } from "@/app/store";
import { useMessages } from "@/shared/api/hooks";
// ...
export default function MessageList({ blfPath }: MessageListProps) {
  const selectedGroupKey = useWorkspaceStore((s) => s.selectedGroupKey);
  const selectedMessageId = useWorkspaceStore((s) => s.selectedMessageId);
  const setSelectedMessage = useWorkspaceStore((s) => s.setSelectedMessage);
  const trimRange = useWorkspaceStore((s) => s.appliedTrimRange);
  const { data, isPending, isError, fetchNextPage, hasNextPage, isFetchingNextPage } = useMessages(
    blfPath,
    selectedGroupKey,
    trimRange?.start ?? 0,
    trimRange?.end ?? Number.MAX_SAFE_INTEGER
  );
  // ... rest unchanged - Review Focus item 4 ("selection outside new window")
  // already holds here: selectedMessageId isn't touched by trimRange at all,
  // and if the selected row scrolls out of the now-filtered `rows` array the
  // existing `rows.length === 0` / virtualizer logic already renders "No
  // messages in this group" correctly with no extra code needed.
```

- [ ] **Step 4: `SignalsList.tsx` - samples preview + Read Payloads call**

```tsx
import { useWorkspaceStore } from "@/app/store";
import { useDecodeSignals, useSignalCatalog, useSignalSamples } from "@/shared/api/hooks";
// ...
export default function SignalsList({ blfPath }: SignalsListProps) {
  const catalog = useSignalCatalog(blfPath);
  const trimRange = useWorkspaceStore((s) => s.appliedTrimRange);
  // ... existing state ...
  const decodeSignals = useDecodeSignals(blfPath);
  // ...
  const samples = useSignalSamples(
    blfPath,
    previewSignalId,
    trimRange?.start ?? 0,
    trimRange?.end ?? Number.MAX_SAFE_INTEGER
  );
  // ...
  function readPayloads() {
    const toDecode = (catalog.data ?? [])
      .filter((s) => pendingSignalIds.has(s.signalId) && !s.cached && !s.opaque)
      .map((s) => s.signalId);
    const nextActive = new Set(pendingSignalIds);
    if (toDecode.length > 0 && trimRange) {
      decodeSignals.mutate(
        { signalIds: toDecode, startUs: trimRange.start, endUs: trimRange.end },
        {
          onSuccess: () => {
            commitActiveSignalIds(nextActive);
            autoDisplayFirstIfEmpty(toDecode[0]);
          },
        }
      );
    } else {
      commitActiveSignalIds(nextActive);
    }
  }
  // ... rest unchanged
```

- [ ] **Step 5: `AnalyzerPanel.tsx` - detector query call**

```tsx
import { useWorkspaceStore } from "@/app/store";
import { useRunDetectorQuery, DETECTOR_QUERY_MATCH_LIMIT } from "@/shared/api/hooks";
// ...
export default function AnalyzerPanel({ blfPath }: AnalyzerPanelProps) {
  // ... existing store reads ...
  const trimRange = useWorkspaceStore((s) => s.appliedTrimRange);
  const mutation = useRunDetectorQuery(blfPath, trimRange?.start ?? 0, trimRange?.end ?? Number.MAX_SAFE_INTEGER);
  // ... rest unchanged
```

- [ ] **Step 6: `TimelineChart.tsx` - signal samples list**

```tsx
import { useWorkspaceStore } from "@/app/store";
import { useSignalCatalog, useSignalSamplesList } from "@/shared/api/hooks";
// ... inside the component, before the existing `const samples = useSignalSamplesList(blfPath, displayedSignalIds);` line:
  const trimRange = useWorkspaceStore((s) => s.appliedTrimRange);
  const samples = useSignalSamplesList(
    blfPath,
    displayedSignalIds,
    trimRange?.start ?? 0,
    trimRange?.end ?? Number.MAX_SAFE_INTEGER
  );
```

Review Focus item 4's chart half: if a pinned signal has zero samples in the narrowed window, `useSignalSamplesList` simply returns an empty array for that signal's query - confirm (no code change needed) that `TimelineChart`'s existing series-building logic already renders an empty series rather than throwing when a signal's sample array is `[]` (it iterates `samples` and maps each to a series regardless of length).

- [ ] **Step 7: `TimelinePanel.tsx` - no trim-specific change needed**

It only reads `useTraceTimeRange` (trace-wide, intentionally unbound per Global Constraints) to set the chart's axis domain and passes `blfPath` straight through to `TimelineChart` - no edit required here, listed for completeness since it's in the same data-flow chain.

- [ ] **Step 8: Type-check and manually verify**

```bash
npx tsc --noEmit -p app/ui
```

Expected: zero errors. Then run the app and manually verify (per this project's established FE verification method):

```bash
npm run dev --prefix app/ui &
cargo tauri dev --manifest-path app/src-tauri/Cargo.toml
```

Walk through: pick a BLF+ARXML, click Start Processing, confirm the workspace (not a full-screen spinner) appears immediately with skeleton panels and a growing `%` next to the file name; once done, confirm panels populate and the header slot now shows the trim slider at full span; narrow it and click Apply, confirm the header count/messages refresh and, if any signals are Active, `DecodeOverlay` appears briefly.

- [ ] **Step 9: Commit**

```bash
git add app/ui/src/widgets/WorkspaceLayout.tsx app/ui/src/widgets/TraceRail.tsx app/ui/src/widgets/MessageList.tsx app/ui/src/widgets/SignalsList.tsx app/ui/src/widgets/AnalyzerPanel.tsx app/ui/src/widgets/TimelineChart.tsx
git commit -m "feat(ui): skeleton-load workspace panels during prepare, scope every read to the trim range"
```

---

### Task 12: Frontend - Apply re-decodes Active signals through the existing `DecodeOverlay`

**Files:**
- Modify: `app/ui/src/app/store.ts`

**Interfaces:**
- Produces: `WorkspaceLayout`'s `handleApplyTrim()`, passed to `TopBar` as `onApplyTrim` (replacing Task 11 Step 1's no-op placeholder). Re-runs the existing `decodeSignals` mutation for every currently-`activeSignalIds` entry with the just-applied trim bound, so `useIsDecodingSignals`/`DecodeOverlay` picks it up with zero new overlay code.

- [ ] **Step 1: Implement `onApplyTrim` in `WorkspaceLayout`**

`useDecodeSignals` must be called as a hook (it registers with `useMutationState`, which is what makes `DecodeOverlay` notice it) - so the re-decode call can't live in a plain store action called imperatively from outside a component. `WorkspaceLayout` already has `blfPath` in scope and is itself a component, so it calls the hook directly and passes the resulting handler into `TopBar` as `onApplyTrim`, replacing the stub from Task 11 Step 1:

```tsx
import { useDecodeSignals, useFileSizes, useIsDecodingSignals } from "@/shared/api/hooks";
import { useWorkspaceStore } from "@/app/store";
// ...
export default function WorkspaceLayout({ blfPath, preparing, tick, prepareTotals, onOpenTrace }: WorkspaceLayoutProps) {
  const isDecoding = useIsDecodingSignals(blfPath);
  const decodeSignals = useDecodeSignals(blfPath);

  function handleApplyTrim() {
    const { activeSignalIds, appliedTrimRange } = useWorkspaceStore.getState();
    if (activeSignalIds.size === 0 || !appliedTrimRange) return;
    decodeSignals.mutate({
      signalIds: Array.from(activeSignalIds),
      startUs: appliedTrimRange.start,
      endUs: appliedTrimRange.end,
    });
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
      {/* ... rest unchanged from Task 11 ... */}
```

This task makes no changes to `app/store.ts` - the re-decode trigger lives entirely in this component-level handler.

`TrimControl`'s own `onApply` prop (Task 9) already fires *after* `applyTrim()` commits `pendingTrimRange → appliedTrimRange`, so `useWorkspaceStore.getState().appliedTrimRange` read inside `handleApplyTrim` is guaranteed to be the new window, not the stale one - no race between the store commit and this read since both happen synchronously in the same React event handler tick (`applyTrim()` runs via Zustand's synchronous `set`, then `TrimControl` calls `onApply()` immediately after).

- [ ] **Step 2: Type-check**

```bash
npx tsc --noEmit -p app/ui
```

Expected: zero errors.

- [ ] **Step 3: Manually verify the overlay wiring**

With a trace that has at least one Active (cached) signal: narrow the trim slider, click Apply, confirm `DecodeOverlay`'s blurred "Reading payloads..." overlay appears briefly and the Timeline's signal data reflects the narrowed window once it clears. With zero Active signals, confirm clicking Apply does *not* show the overlay (the `activeSignalIds.size === 0` guard) and Message List/Trace Rail/Analyzer still refresh to the new window.

- [ ] **Step 4: Commit**

```bash
git add app/ui/src/widgets/WorkspaceLayout.tsx
git commit -m "feat(ui): re-decode Active signals through the existing DecodeOverlay on Apply"
```

---
