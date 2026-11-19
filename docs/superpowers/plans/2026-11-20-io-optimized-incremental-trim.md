# I/O-Optimized Incremental Trim Ingestion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop re-reading the whole BLF on every Trim-Apply: build a container time-index at Prepare, make all windowed reads seek to only the overlapping containers, decode signals incrementally (append only the uncovered delta, never on shrink), and fold the per-Apply stats + decode work into a single pass.

**Architecture:** A new `container_index` table (populated for free during Prepare's existing inflate loop) records each LOG_CONTAINER's byte offset and coarse `[first_ts, last_ts]`. A byte-ranged `BlfIngestReader::visitRange` inflates only the containers a `[start,end]` window overlaps. One new native subcommand `apply-trim` does, in a single `visitRange` pass, both the full-table `signal_stats` recompute (observing every signal in-window) and the decode-append of only the uncovered delta for active signals, tracked per-signal in a `signal_coverage` table. The two existing per-Apply subprocesses (`signal-stats` + `decode-signals`) collapse into this one; "Read Payloads" routes through it too.

**Tech Stack:** C++23 (`native/`, libdeflate, DuckDB Appender), Rust (`crates/query`, `crates/sidecar`, `app/src-tauri` Tauri adapter), React + TypeScript + Vite + TanStack Query (`app/ui`), DuckDB Trace Store.

**Spec:** This plan is its own spec (design settled in the 2026-11-20 grilling session). Canonical vocabulary: `CONTEXT.md` (Trim Window, Read Payloads, Signal Catalog, Active Signal). Boundary rules: `docs/adr/0001-monorepo-layout-and-boundaries.md`. Signal-decode-on-demand: `docs/adr/0005-signal-decode-on-plot.md`.

## Global Constraints

- **Schema change bumps `schema_version`** in `schema/schema.sql` AND the Rust open-time check in `crates/trace-store/src/lib.rs` (`EXPECTED_SCHEMA_VERSION`) in the same change (`docs/adr/0001` rule 1). Target version: **4**.
- **`native/` has no Tauri or Rust knowledge**; `crates/query`/`crates/sidecar`/`crates/trace-store` have no Tauri knowledge; `app/src-tauri` is a thin `#[tauri::command]` adapter only (`docs/adr/0001`).
- **Only `native/` parses BLF/ARXML** (`docs/adr/0001` rule 2). No BLF parsing in Rust.
- **`start_us`/`end_us` are Rust-generated `i64`, never user text** - safe to interpolate as SQL literals (established on `run_detector_query`), but prefer bind params where the surrounding query already uses them.
- **Trim is non-destructive to the BLF**; the Trace Store `signals`/`signal_stats`/`signal_coverage`/`container_index` are the only things mutated.
- **Coarse container-level timestamps are acceptable** - the index does not need per-message precision; a window may inflate one extra boundary container.
- **C++ `clang-format` and Rust `cargo fmt`** run on every modified file. Each module keeps its own test entry point.
- **No GUI test runner exists** for `app/ui` - frontend verification is `npx tsc --noEmit -p .` + `npm run build`, as in the prior two waves. State this limitation in the ledger wherever a step would otherwise be a manual click-through.

## Review Focus

1. **Window entirely before the first container / entirely after the last** - `apply-trim` with `[start,end]` outside the trace's span must write empty/zeroed `signal_stats` and decode nothing, not read the whole file or crash (Task 4 test `apply_trim_window_outside_trace`).
2. **Cross-container split object at the window's leading edge** - a message whose bytes straddle the boundary into the first inflated container is dropped (no `pendingTail` on a mid-file start); the test must prove `visitRange` never admits an *out-of-window* message (`minTs >= start container's first_ts`), the dropped edge message being the agreed coarse tolerance (Task 2 test `visit_range_includes_boundary_container`).
3. **Disjoint window jump** (new window does not overlap a signal's existing coverage) - must DELETE that signal's stale samples and fully re-decode the new window, not leave orphan rows that later double-count (Task 4 test `apply_trim_disjoint_window_replaces_coverage`).
4. **Coverage with an interior hole** - expand `[50,300]` over existing coverage `[100,200]` must decode both `[50,100)` and `(200,300]` and leave no gap, computing coverage as the union `[50,300]` (Task 4 test `apply_trim_two_sided_expand`).
5. **Shrink after a widen** - shrinking the window must append zero `signals` rows and still produce window-accurate `signal_stats` (fewer samples), proving decode is skipped but stats are recomputed (Task 4 test `apply_trim_shrink_no_decode`).

---

## File Structure

**New files:**
- `native/blf/test/visit_range_test.cpp` + `native/blf/test/run_visit_range.cmake` - unit coverage for the byte-ranged reader.
- `native/store/test/apply_trim_bounds_check.cpp` + `native/store/test/run_apply_trim_bounds.cmake` - integration coverage for the `apply-trim` subcommand (mirrors the existing `run_signal_stats_bounds.cmake`).
- `docs/ingestion-pipeline.html` - standalone documentation artifact.

**Modified files:**
- `schema/schema.sql` - version bump + two tables.
- `crates/trace-store/src/lib.rs` - `EXPECTED_SCHEMA_VERSION`.
- `native/blf/include/BlfIngestReader.h` + `native/blf/src/BlfIngestReader.cpp` - `ContainerHandler`, `visit` overload, `visitRange`.
- `native/cli/src/main.cpp` - build the index in `runPrepare`; new `runApplyTrim`; register subcommand; (keep `runDecodeSignals`/`runSignalStats` until Task 7 removes their callers, then delete in Task 8).
- `crates/query/src/lib.rs` - `container_byte_range(conn, start_us, end_us)` helper + `signal_coverage` read/write helpers.
- `app/src-tauri/src/main.rs` - new `apply_trim` command; deprecate/remove `decode_signals` + `recompute_signal_stats` once unused.
- `app/ui/src/shared/api/trace-source.ts` + `hooks.ts` - `applyTrim` data-source method, `useApplyTrim` mutation, `useIsApplyingTrim`.
- `app/ui/src/widgets/WorkspaceLayout.tsx` - `handleApplyTrim` uses the one mutation.
- `app/ui/src/widgets/SignalsList.tsx` - `readPayloads` routes through `useApplyTrim`.
- `CONTEXT.md` - Trim Window + Read Payloads entries note incremental/indexed behavior.

---

## Task 1: Schema v4 - container_index + signal_coverage tables

**Files:**
- Modify: `schema/schema.sql:3` (version comment) and append two tables after line 109.
- Modify: `crates/trace-store/src/lib.rs:8` (`EXPECTED_SCHEMA_VERSION`).
- Test: `crates/trace-store/src/lib.rs` (existing `#[test]` block) + `native/store/test/fixture_roundtrip_test.cpp` (embedded-schema exec).

**Interfaces:**
- Produces: table `container_index(container_ord BIGINT, byte_offset BIGINT, first_ts_us BIGINT, last_ts_us BIGINT)` and `signal_coverage(signal_id BIGINT PRIMARY KEY, start_us BIGINT, end_us BIGINT)`. Schema version string `"4"`.

- [ ] **Step 1: Write the failing test** (Rust open-time check targets v4)

In `crates/trace-store/src/lib.rs`, the existing test writes a store with `schema_version` meta and opens it. Change the helper that seeds a *matching* store to insert `"4"`, and confirm the mismatch test still seeds a different value. Add one assertion that a v4 store opens cleanly:

```rust
#[test]
fn opens_v4_store() {
    let dir = tempfile::tempdir().unwrap();
    seed_store(&dir, "4"); // helper that runs embedded-equivalent DDL + inserts schema_version
    assert!(open(dir.path()).is_ok());
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test --manifest-path crates/Cargo.toml -p trace-store opens_v4_store`
Expected: FAIL - `schema_version mismatch: store has 4, expected 3`.

- [ ] **Step 3: Bump the Rust constant**

In `crates/trace-store/src/lib.rs:8`:
```rust
const EXPECTED_SCHEMA_VERSION: &str = "4";
```

- [ ] **Step 4: Add the schema tables and bump the version comment**

In `schema/schema.sql` line 3:
```sql
-- schema_version: 4
```
Append after line 109 (`signal_stats` table):
```sql

-- Coarse per-LOG_CONTAINER time index, written during Prepare's inflate loop.
-- Lets windowed reads (apply-trim) seek to only the containers a [start,end]
-- window overlaps, instead of inflating the whole file. byte_offset is the file
-- offset of the container's "LOBJ" signature; one row per non-empty container.
CREATE TABLE container_index (
  container_ord BIGINT PRIMARY KEY,  -- 0-based inflate order
  byte_offset   BIGINT,              -- file offset of the LOBJ signature
  first_ts_us   BIGINT,              -- min message timestamp in the container
  last_ts_us    BIGINT,              -- max message timestamp in the container
  first_msg_id  BIGINT               -- global msg_id of the container's first message
);

-- Per-signal decoded coverage: the single contiguous [start,end] window a
-- signal's samples currently cover in the `signals` table. Lets apply-trim
-- decode only the uncovered delta on expand and skip decoding entirely on
-- shrink. One row per signal that has been decoded at least once.
CREATE TABLE signal_coverage (
  signal_id BIGINT PRIMARY KEY,
  start_us  BIGINT,
  end_us    BIGINT
);
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cargo test --manifest-path crates/Cargo.toml -p trace-store`
Expected: PASS (incl. `opens_v4_store` and the still-present mismatch test).
Run: `cmake --build build --target fastrace_store_roundtrip && ctest --test-dir build -R fastrace_store`
Expected: PASS - embedded schema (now with two new tables) execs cleanly.

- [ ] **Step 6: Commit**

```bash
git add schema/schema.sql crates/trace-store/src/lib.rs
git commit -m "feat(schema): add container_index + signal_coverage, bump schema_version to 4"
```

---

## Task 2: BlfIngestReader - container callback + byte-ranged visit

**Files:**
- Modify: `native/blf/include/BlfIngestReader.h:16-34`
- Modify: `native/blf/src/BlfIngestReader.cpp:430-537`
- Create: `native/blf/test/visit_range_test.cpp`, `native/blf/test/run_visit_range.cmake`
- Modify: `native/blf/CMakeLists.txt` (register the test)

**Interfaces:**
- Produces:
  - `using ContainerHandler = std::function<void(uint64_t ord, uint64_t byteOffset, int64_t firstTsUs, int64_t lastTsUs, uint64_t msgCount)>;` - `msgCount` is the number of messages the container emitted, so a caller that assigns global ids can compute the container's first id as `(idSoFar - msgCount)`.
  - `bool visit(const std::string& blfPath, MessageHandler onMessage, ContainerHandler onContainer = nullptr);` - `onContainer` fires once per non-empty container after its messages are emitted.
  - `bool visitRange(const std::string& blfPath, uint64_t startByteOffset, uint64_t endByteOffset, MessageHandler onMessage);` - mmaps, validates the file header, seeks the cursor to `startByteOffset`, walks containers until `cursor.tell() >= endByteOffset` or EOF. `startByteOffset == 0` means "from the first container"; `endByteOffset == UINT64_MAX` means "to EOF". Consumes `container_index.byte_offset` values.

- [ ] **Step 1: Write the failing test**

`native/blf/test/visit_range_test.cpp` - use an existing BLF fixture (reuse the path the current reader tests use; grep `native/blf/test` for the fixture constant, e.g. `kFixtureBlf`). First capture the full set of `(byteOffset, firstTs, lastTs)` via the new `visit` overload, then feed a mid-file `[startByteOffset,endByteOffset]` into `visitRange` and assert it emits only messages whose timestamps fall in `[firstTs_of_start_container, lastTs_of_end_container]` and strictly fewer than the full walk:

```cpp
// visit_range_includes_boundary_container
std::vector<std::tuple<uint64_t,int64_t,int64_t>> containers;
uint64_t fullCount = 0;
fastrace::BlfIngestReader full;
full.visit(kFixtureBlf,
    [&](const fastrace::TraceMessage&) { ++fullCount; },
    [&](uint64_t ord, uint64_t off, int64_t f, int64_t l) { containers.push_back({off, f, l}); });
expect(containers.size() >= 2, "fixture has >=2 containers");

const auto [startOff, startFirst, startLast] = containers[1];
const auto [endOff, endFirst, endLast] = containers.back();
uint64_t rangeCount = 0;
int64_t minTs = INT64_MAX, maxTs = INT64_MIN;
fastrace::BlfIngestReader ranged;
ranged.visitRange(kFixtureBlf, startOff, UINT64_MAX, [&](const fastrace::TraceMessage& m) {
    ++rangeCount; minTs = std::min(minTs, (int64_t)m.timestampUs); maxTs = std::max(maxTs, (int64_t)m.timestampUs);
});
expect(rangeCount > 0 && rangeCount < fullCount, "ranged walk emits a strict subset");
expect(minTs >= startFirst, "no message before the start container's first ts");
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cmake -S . -B build && cmake --build build --target fastrace_visit_range_test`
Expected: FAIL to compile - `visitRange` / `visit(…, onContainer)` not declared.

- [ ] **Step 3: Declare the new API in the header**

In `native/blf/include/BlfIngestReader.h`, after line 16:
```cpp
    using MessageHandler = std::function<void(const TraceMessage& msg)>;
    using ContainerHandler
        = std::function<void(uint64_t ord, uint64_t byteOffset, int64_t firstTsUs, int64_t lastTsUs, uint64_t msgCount)>;
```
Replace line 28 with:
```cpp
    /// mmap + walk. onContainer (optional) fires once per non-empty container.
    /// Returns false on open/header failure.
    bool visit(const std::string& blfPath, MessageHandler onMessage, ContainerHandler onContainer = nullptr);

    /// Walk only containers in the byte range [startByteOffset, endByteOffset).
    /// startByteOffset must be a LOBJ signature offset from container_index
    /// (or 0). endByteOffset may be UINT64_MAX for "to EOF". Returns false on
    /// open/header failure.
    bool visitRange(const std::string& blfPath, uint64_t startByteOffset, uint64_t endByteOffset,
        MessageHandler onMessage);
```

- [ ] **Step 4: Implement - extract the container loop, add offset + ts-range tracking**

In `native/blf/src/BlfIngestReader.cpp`, refactor `visit` (430-537) so the container-walk loop is parameterized by a start offset, an end offset, and an optional `ContainerHandler`. Concretely:

Capture the LOBJ start offset. `findNextLobj` (line 466) advances `cursor.pos` 4 bytes past the signature on success, so the container's LOBJ offset is `cursor.tell() - 4`. Record it before reading the rest of the header:
```cpp
    while (!cursor.eof() && cursor.tell() < endByteOffset) {
        if (!findNextLobj(cursor, base.signature)) {
            break;
        }
        const uint64_t lobjOffset = cursor.tell() - 4;
```
After decoding `containerMsgs`/`stitchedMsgs` and before `pendingTail = std::move(tailFrag);` (around line 530), compute the container's coarse ts range from the messages it produced and fire the callback:
```cpp
        int64_t firstTs = INT64_MAX;
        int64_t lastTs = INT64_MIN;
        const uint64_t msgCount = stitchedMsgs.size() + containerMsgs.size();
        for (const auto& m : stitchedMsgs) { firstTs = std::min(firstTs, (int64_t)m.timestampUs); lastTs = std::max(lastTs, (int64_t)m.timestampUs); }
        for (const auto& m : containerMsgs) { firstTs = std::min(firstTs, (int64_t)m.timestampUs); lastTs = std::max(lastTs, (int64_t)m.timestampUs); }
        if (onContainer && msgCount > 0) {
            onContainer(m_stats.containers - 1, lobjOffset, firstTs, lastTs, msgCount);
        }
```
(`m_stats.containers` was already incremented at line 501, so `- 1` is the 0-based ord of the container just processed. Fire `onContainer` after the `onMessage` emissions - the loop already emits `stitchedMsgs` then `containerMsgs` at lines 522-529 - so a caller counting ids in `onMessage` has already advanced past this container's messages by the time `onContainer` runs.)

Seek before the loop: after `readFileHeader` succeeds (line 450), if `startByteOffset > 0` set `cursor.pos = cursor.base + startByteOffset;` (clamp to `cursor.end`).

Make the existing public `visit` delegate:
```cpp
bool BlfIngestReader::visit(const std::string& blfPath, MessageHandler onMessage, ContainerHandler onContainer)
{ return visitImpl(blfPath, 0, UINT64_MAX, std::move(onMessage), std::move(onContainer)); }

bool BlfIngestReader::visitRange(const std::string& blfPath, uint64_t startByteOffset, uint64_t endByteOffset, MessageHandler onMessage)
{ return visitImpl(blfPath, startByteOffset, endByteOffset, std::move(onMessage), nullptr); }
```
where `visitImpl` is a private method holding the mmap/header/loop body (add its declaration to the header's `private:` section). Keep `pendingTail` stitching intact. **Leading-edge split:** when `visitRange` starts at a mid-file container, `pendingTail` is empty, so a message whose bytes straddled the previous container's boundary is dropped. That message's timestamp is `< startUs` in the normal case (it belongs to the prior container's tail, before the window) and would be filtered out anyway; at most one boundary message with `ts` exactly at the window's leading edge can be lost. This is the agreed coarse tolerance, not a correctness bug - `visitImpl` needs no stitch change, and the caller's per-message `ts` gate guarantees no *out-of-window* data is ever admitted.

- [ ] **Step 5: Run the test to verify it passes**

Run: `cmake --build build --target fastrace_visit_range_test && ctest --test-dir build -R fastrace_visit_range`
Expected: PASS.

- [ ] **Step 6: Format + commit**

```bash
/opt/homebrew/opt/llvm/bin/clang-format -i native/blf/include/BlfIngestReader.h native/blf/src/BlfIngestReader.cpp native/blf/test/visit_range_test.cpp
git add native/blf/include/BlfIngestReader.h native/blf/src/BlfIngestReader.cpp native/blf/test/visit_range_test.cpp native/blf/test/run_visit_range.cmake native/blf/CMakeLists.txt
git commit -m "feat(blf): add per-container callback and byte-ranged visitRange"
```
(If clang-format rewrites unrelated pre-existing lines, `git checkout --` the file and hand-apply only the new lines, as in prior waves.)

---

## Task 3: Prepare writes the container index

**Files:**
- Modify: `native/cli/src/main.cpp:479-559` (inside `runPrepare`)

**Interfaces:**
- Consumes: `BlfIngestReader::visit(path, onMessage, onContainer)` (Task 2).
- Produces: `container_index` rows for every non-empty container of the prepared trace.

- [ ] **Step 1: Add a container_index Appender and wire the onContainer callback**

In `runPrepare`, alongside the other Appenders (after line 484), add:
```cpp
        fastrace::Appender ciApp(db.con(), "container_index");
```
Add `!ciApp.valid()` to the validity check on line 485. Pass a second lambda to `reader.visit` (line 494) that appends one row per container. `nextMsgId` has already advanced past this container's messages by the time `onContainer` fires, so the container's first global id is `nextMsgId - msgCount`:
```cpp
        }, [&](uint64_t ord, uint64_t byteOffset, int64_t firstTsUs, int64_t lastTsUs, uint64_t msgCount) {
            if (failed) { return; }
            ciApp.i64(static_cast<int64_t>(ord));
            ciApp.i64(static_cast<int64_t>(byteOffset));
            ciApp.i64(firstTsUs);
            ciApp.i64(lastTsUs);
            ciApp.i64(static_cast<int64_t>(nextMsgId - msgCount)); // first_msg_id
            if (!ciApp.endRow()) { failed = true; }
        });
```
Add `!ciApp.close()` to the close chain (line 540).

- [ ] **Step 2: Add an integration assertion to the existing prepare ctest**

The store round-trip / prepare fixture test (`native/store/test/`) should assert the index is populated and monotonic. Add to the nearest prepare-exercising test (or `apply_trim_bounds_check.cpp` in Task 4 if simpler) a query:
```cpp
// after prepare: container_index must be non-empty and ordered
auto res = db.con().Query("SELECT count(*), min(first_ts_us) <= max(last_ts_us) FROM container_index");
expect(res->GetValue(0,0).GetValue<int64_t>() > 0, "container_index populated");
```

- [ ] **Step 3: Build + run prepare against a fixture, verify the index**

Run: `cmake --build build --target fastrace_parse && ./build/native/cli/fastrace_parse prepare <fixture.blf> <fixture.arxml>`
Then: `duckdb <fixture.duckdb> "SELECT count(*), min(byte_offset), max(last_ts_us) FROM container_index"`
Expected: count > 0; `byte_offset` strictly increasing; `last_ts_us` non-decreasing across ords (traces are chronological).

- [ ] **Step 4: Commit**

```bash
git add native/cli/src/main.cpp native/store/test/
git commit -m "feat(prepare): populate container_index during the inflate loop"
```

---

## Task 4: apply-trim subcommand - single combined, index-seeked, incremental pass

**Files:**
- Modify: `native/cli/src/main.cpp` (new `runApplyTrim`, inserted after `runSignalStats`; register in `main()`)
- Create: `native/store/test/apply_trim_bounds_check.cpp`, `native/store/test/run_apply_trim_bounds.cmake`
- Modify: `native/store/CMakeLists.txt`

**Interfaces:**
- Consumes: `BlfIngestReader::visitRange` (Task 2), `container_index` + `signal_coverage` (Task 1), `SignalStatsTracker::observe`/`slots()`, `decodeAllSignals`, `writeSignalStats`.
- Produces: CLI `fastrace_parse apply-trim <trace.blf> <start_us> <end_us> [<active_signal_id> ...]`. Emits the same JSON-lines progress/`done` protocol as the other subcommands. Rewrites `signal_stats` whole-table, scoped to `[start,end]`; appends only uncovered-delta `signals` rows for the active signals; maintains `signal_coverage`.

- [ ] **Step 1: Write the integration test (RED)**

`native/store/test/apply_trim_bounds_check.cpp` (mirror `signal_stats_bounds_check.cpp`): prepare a fixture, then drive the five Review-Focus scenarios by invoking `runApplyTrim` (or the built binary) and asserting on the DuckDB tables. Minimum assertions:
```cpp
// apply_trim_shrink_no_decode: decode [full], record signals count; apply-trim a sub-window
// with the same active signal -> signals row count for that signal is UNCHANGED (no re-append),
// but signal_stats.samples for it reflects the sub-window (fewer).
// apply_trim_two_sided_expand: decode [100,200]; apply-trim [50,300] -> signals gains rows with
// ts in [50,100) and (200,300] and none duplicated in [100,200]; signal_coverage = (50,300).
// apply_trim_disjoint_window_replaces_coverage: coverage (100,200); apply-trim [500,600] ->
// old [100,200] rows for that signal deleted, coverage = (500,600).
// apply_trim_window_outside_trace: apply-trim [maxTs+1, maxTs+2] -> 0 signals appended,
// signal_stats all-zero, no crash.
```

- [ ] **Step 2: Run to verify it fails**

Run: `cmake --build build --target fastrace_apply_trim_check 2>&1 | tail -5`
Expected: FAIL to build/link - `runApplyTrim` undefined (or the ctest fails: subcommand unknown).

- [ ] **Step 3: Implement `runApplyTrim`**

Insert after `runSignalStats` (line 433). Structure, reusing the validation block verbatim from `runSignalStats` (store exists, BLF exists, ARXML present, blf_size/blf_mtime freshness):

```cpp
int runApplyTrim(int argc, char** argv)
{
    if (argc < 5) {
        printError("usage: fastrace_parse apply-trim <trace.blf> <start_us> <end_us> [<signal_id> ...]");
        return 1;
    }
    const std::string blfPath = argv[2];
    const int64_t startUs = std::strtoll(argv[3], nullptr, 10);
    const int64_t endUs = std::strtoll(argv[4], nullptr, 10);
    std::vector<int64_t> activeIds;
    for (int i = 5; i < argc; ++i) activeIds.push_back(std::strtoll(argv[i], nullptr, 10));

    // ... identical store/BLF/freshness/ARXML validation as runSignalStats ...

    const fastrace::ArDatabase arDb = fastrace::ArxmlParser::parseFile(arxmlPath);
    fastrace::SignalStatsTracker tracker(arDb);

    // --- Resolve the byte range to inflate from container_index ---
    // startOffset = last container starting at/before startUs (contains startUs,
    // and its head carries any split from the prior container); 0 if none.
    // endOffset   = first container starting strictly after endUs; UINT64_MAX if none.
    uint64_t startOffset = 0, endOffset = UINT64_MAX;
    {
        auto r1 = db.con().Query("SELECT max(byte_offset) FROM container_index WHERE first_ts_us <= " + std::to_string(startUs));
        if (!r1->GetValue(0, 0).IsNull()) startOffset = (uint64_t)r1->GetValue(0, 0).GetValue<int64_t>();
        auto r2 = db.con().Query("SELECT min(byte_offset) FROM container_index WHERE first_ts_us > " + std::to_string(endUs));
        if (!r2->GetValue(0, 0).IsNull()) endOffset = (uint64_t)r2->GetValue(0, 0).GetValue<int64_t>();
    }

    // --- Per-active-signal coverage decisions (before the pass) ---
    // Load each active signal's existing [cov_start,cov_end] from signal_coverage.
    // disjoint (no overlap with [startUs,endUs]) -> DELETE its signals rows,
    //   treat coverage as empty so the pass appends the whole window.
    // overlapping/adjacent/absent -> keep coverage; the pass appends only ts
    //   outside [cov_start,cov_end].
    struct Cov { bool has; int64_t s; int64_t e; };
    std::unordered_map<int64_t, Cov> cov; // signalId -> existing coverage used for the delta gate
    // (populate from: SELECT signal_id,start_us,end_us FROM signal_coverage WHERE signal_id IN (...))
    // for disjoint ones: db.exec("DELETE FROM signals WHERE signal_id = <id>"); cov[id] = {false,0,0};

    // --- Whole-table stats rewrite, same as runSignalStats ---
    if (!db.exec("DELETE FROM signal_stats")) { printError("could not clear signal_stats"); return 1; }

    std::unordered_map<std::string, RequestedSignal> lookup; // key -> signal meta for active ids (as in runDecodeSignals)
    // ... build lookup from queryRequestedSignals(db.con(), activeIds, requested) ...

    fastrace::Appender sigApp(db.con(), "signals");
    bool failed = !sigApp.valid();
    uint64_t decodedCount = 0;

    uint64_t nextMsgId = 0;
    if (startOffset > 0) {
        auto rid = db.con().Query("SELECT first_msg_id FROM container_index WHERE byte_offset = " + std::to_string(startOffset));
        if (!rid->GetValue(0, 0).IsNull()) nextMsgId = (uint64_t)rid->GetValue(0, 0).GetValue<int64_t>();
    }
    fastrace::BlfIngestReader reader;
    const bool ok = reader.visitRange(blfPath, startOffset, endOffset, [&](const fastrace::TraceMessage& msgIn) {
        if (failed) return;
        fastrace::TraceMessage msg = msgIn;
        const uint64_t msgId = nextMsgId++;               // keep ids aligned with Prepare (incl. skipped msgs)
        const int64_t ts = (int64_t)msg.timestampUs;
        if (ts < startUs || ts > endUs) return;           // coarse index -> precise ts gate here
        if (fastrace::isEthernet(msg.objectType) && !msg.data.empty()) fastrace::indexEthernetPdus(msg);

        tracker.observe(msg);                               // stats for ALL signals, every in-window message

        if (!activeIds.empty()) {
            for (const auto& ds : fastrace::decodeAllSignals(arDb, msg)) {
                const std::string key = (ds.parentPduId != 0)
                    ? ("pdu:" + std::to_string(ds.parentPduId) + ":" + ds.name)
                    : ("can:" + std::to_string(ds.parentCanId) + ":" + ds.name);
                auto it = lookup.find(key);
                if (it == lookup.end()) continue;
                const auto c = cov.find(it->second.signalId);
                if (c != cov.end() && c->second.has && ts >= c->second.s && ts <= c->second.e) continue; // already covered
                const double phys = (double)ds.rawValue * it->second.factor + it->second.offset;
                sigApp.i64(it->second.signalId); sigApp.i64((int64_t)msgId);
                sigApp.i64(ts); sigApp.u64(ds.rawValue); sigApp.f64(phys);
                if (!sigApp.endRow()) { failed = true; return; }
                ++decodedCount;
            }
        }
        // periodic printProgress(...) as in runSignalStats
    });

    failed = failed || !ok;
    failed = !sigApp.close() || failed;
    if (!failed) failed = !writeSignalStats(db, tracker);

    // --- Update signal_coverage for each active signal to the union window ---
    // overlapping/absent: new = [min(cov.s,startUs), max(cov.e,endUs)]
    // disjoint (reset earlier): new = [startUs, endUs]
    // upsert via: INSERT OR REPLACE INTO signal_coverage VALUES (id, s, e)
    // (DuckDB: DELETE then INSERT, or INSERT ... ON CONFLICT DO UPDATE)

    if (failed) { printError("apply-trim failed: " + blfPath); return 1; }
    printDone(reader.stats().containers, reader.stats().messages, decodedCount, reader.stats().bytesRead, reader.stats().fileSizeBytes, /*elapsedMs*/0);
    return 0;
}
```

**msg_id alignment:** `visitRange` starts mid-file, so a local counter from 0 would not match Prepare's global ids, and `signals.msg_id` must stay aligned (it joins back to `messages` for Message-List selection - Wave 1 preserved this deliberately). Seed the counter from the index: before the pass, `nextMsgId = (SELECT first_msg_id FROM container_index WHERE byte_offset = startOffset)` (or 0 when `startOffset == 0`), then `++nextMsgId` for every message `visitRange` emits, including out-of-window ones - exactly as `runDecodeSignals` does at line 234 - and use `nextMsgId - 1` as the current message's id when appending. The `first_msg_id` column was added to `container_index` in Task 1 and populated in Task 3.

- [ ] **Step 4: Register the subcommand**

In `main()` after line 590:
```cpp
    if (std::strcmp(argv[1], "apply-trim") == 0) {
        return runApplyTrim(argc, argv);
    }
```

- [ ] **Step 5: Run the integration test (GREEN)**

Run: `cmake --build build && ctest --test-dir build -R fastrace_apply_trim --output-on-failure`
Expected: PASS all five scenarios.

- [ ] **Step 6: Format + commit**

```bash
/opt/homebrew/opt/llvm/bin/clang-format -i native/cli/src/main.cpp native/store/test/apply_trim_bounds_check.cpp
git add native/cli/src/main.cpp native/store/test/apply_trim_bounds_check.cpp native/store/test/run_apply_trim_bounds.cmake native/store/CMakeLists.txt schema/schema.sql
git commit -m "feat(cli): add apply-trim - single-pass indexed incremental stats+decode"
```
(Note: the `first_msg_id` column added to the Task 1 DDL is committed here if not already; keep schema edits with their first user.)

---

## Task 5: crates/query - container byte-range + coverage helpers

**Files:**
- Modify: `crates/query/src/lib.rs`

**Interfaces:**
- Produces (read-only helpers for anyone opening the store read-only; the *writes* happen in `native/` under the write lock):
  - `pub fn container_byte_range(conn: &Connection, start_us: i64, end_us: i64) -> Result<(i64, Option<i64>), String>` - returns `(start_offset, end_offset_or_none)`, mirroring the SQL in Task 4, so Rust-side callers/tests can assert the seek math without a BLF.
  - `pub fn signal_coverage(conn: &Connection, signal_id: i64) -> Result<Option<(i64, i64)>, String>`.

- [ ] **Step 1: Write failing tests**

Add to `crates/query/src/lib.rs` tests using the existing `setup()` fixture, seeding `container_index`:
```rust
#[test]
fn container_byte_range_picks_overlapping_containers() {
    let conn = setup();
    // cols: container_ord, byte_offset, first_ts_us, last_ts_us, first_msg_id
    conn.execute_batch(
        "INSERT INTO container_index VALUES (0,0,0,100,0),(1,500,100,200,1000),(2,1000,200,300,2000)",
    ).unwrap();
    let (s, e) = container_byte_range(&conn, 150, 250).unwrap();
    assert_eq!(s, 500);   // last container with first_ts_us <= 150 (ord 1)
    assert_eq!(e, None);  // no container has first_ts_us > 250 -> walk to EOF
}

#[test]
fn signal_coverage_absent_is_none() {
    let conn = setup();
    assert_eq!(signal_coverage(&conn, 42).unwrap(), None);
}
```
(Match the column count/order to the final `container_index` DDL incl. `first_msg_id`.)

- [ ] **Step 2: Run to verify failure**

Run: `cargo test --manifest-path crates/Cargo.toml -p query container_byte_range`
Expected: FAIL - function not found.

- [ ] **Step 3: Implement the helpers** (plain `conn.query_row` with the same WHERE clauses as Task 4).

- [ ] **Step 4: Run to verify pass**

Run: `cargo test --manifest-path crates/Cargo.toml -p query`
Expected: PASS.

- [ ] **Step 5: Format + commit**

```bash
cargo fmt --manifest-path crates/Cargo.toml
git add crates/query/src/lib.rs
git commit -m "feat(query): container_byte_range + signal_coverage read helpers"
```

---

## Task 6: Tauri apply_trim command

**Files:**
- Modify: `app/src-tauri/src/main.rs` (new command modeled on `decode_signals` 135-163; register in `generate_handler!`)

**Interfaces:**
- Consumes: `sidecar::spawn`, `PrepareGuard`, `progress_to_json`, `fold_final_done`.
- Produces: `#[tauri::command] async fn apply_trim(app, blf_path: String, start_us: i64, end_us: i64, active_signal_ids: Vec<i64>) -> Result<serde_json::Value, String>` - spawns `["apply-trim", blf_path, start_us, end_us, ...active_signal_ids]`, emits `"apply-trim-progress"`.

- [ ] **Step 1: Write failing test** (args-shape test, mirroring the existing `recompute_signal_stats_args_shape_matches_decode_signals_pattern` at main.rs:691):
```rust
#[test]
fn apply_trim_args_shape() {
    let mut args = vec!["apply-trim".to_string(), "trace.blf".to_string(), "100".to_string(), "200".to_string()];
    args.extend([7i64, 9i64].iter().map(|id| id.to_string()));
    assert_eq!(args, vec!["apply-trim", "trace.blf", "100", "200", "7", "9"]);
}
```

- [ ] **Step 2: Run to verify fail**

Run: `cargo test --manifest-path app/src-tauri/Cargo.toml apply_trim_args_shape`
Expected: FAIL (if written to call a not-yet-existing helper) or trivially pass; if trivial, instead assert via a small `build_apply_trim_args(blf, s, e, ids)` helper you add and test. Keep the helper, call it from the command.

- [ ] **Step 3: Implement the command + helper; register in `tauri::generate_handler![...]`.** Copy `decode_signals` verbatim, rename, change subcommand string to `"apply-trim"`, event to `"apply-trim-progress"`, and build args via the helper.

- [ ] **Step 4: Run to verify pass**

Run: `cargo test --manifest-path app/src-tauri/Cargo.toml`
Expected: PASS (all, incl. the new test).

- [ ] **Step 5: Format + commit**

```bash
cargo fmt --manifest-path app/src-tauri/Cargo.toml
git add app/src-tauri/src/main.rs
git commit -m "feat(tauri): add apply_trim command"
```

---

## Task 7: Frontend - single apply-trim mutation, unify Read Payloads

**Files:**
- Modify: `app/ui/src/shared/api/trace-source.ts` (interface + Tauri impl)
- Modify: `app/ui/src/shared/api/hooks.ts` (new `useApplyTrim`, `useIsApplyingTrim`)
- Modify: `app/ui/src/widgets/WorkspaceLayout.tsx:74-97`
- Modify: `app/ui/src/widgets/SignalsList.tsx:70-80` (`readPayloads`)

**Interfaces:**
- Consumes: `apply_trim` command (Task 6).
- Produces: `applyTrim(blfPath, startUs, endUs, activeSignalIds): Promise<{ elapsedMs: number }>` on `TraceDataSource`; `useApplyTrim(blfPath)` mutation (key `["apply-trim", blfPath]`, `onSuccess` invalidates `["signal-catalog", blfPath]` and the `["signal-samples", blfPath]` prefix, records a `"decode"` activity); `useIsApplyingTrim(blfPath)` via `useMutationState`.

- [ ] **Step 1: Add the data-source method** in `trace-source.ts` (interface + `TauriTraceDataSource` calling `invoke("apply_trim", { blfPath, startUs, endUs, activeSignalIds })`).

- [ ] **Step 2: Add `useApplyTrim` + `useIsApplyingTrim`** in `hooks.ts`, copying `useDecodeSignals` (145-181) but with the apply-trim key, taking `{ startUs, endUs, activeSignalIds }`, keeping the same `onSuccess` invalidations (catalog + `["signal-samples", blfPath]` prefix + activity record) and `onError` toast.

- [ ] **Step 3: Rewrite `WorkspaceLayout.handleApplyTrim`** to one call (no sequencing needed - one subprocess does both):
```tsx
  const isApplying = useIsApplyingTrim(blfPath);
  const applyTrim = useApplyTrim(blfPath);

  function handleApplyTrim() {
    const { activeSignalIds, appliedTrimRange } = useWorkspaceStore.getState();
    if (!appliedTrimRange) return;
    applyTrim.mutate({
      startUs: appliedTrimRange.start,
      endUs: appliedTrimRange.end,
      activeSignalIds: Array.from(activeSignalIds),
    });
  }
```
Update `<DecodeOverlay active={isApplying} />` (drop `isDecoding || isRecomputingStats`). Remove the now-unused `useDecodeSignals`/`useRecomputeSignalStats`/`useIsDecodingSignals`/`useIsRecomputingSignalStats` imports from this file.

- [ ] **Step 4: Rewrite `SignalsList.readPayloads`** to activate the newly-checked signals and run one apply-trim over the current window with the full active set (so the single pass decodes the uncovered delta for all of them):
```tsx
  const applyTrim = useApplyTrim(blfPath);
  function readPayloads() {
    const toAdd = (catalog.data ?? [])
      .filter((s) => pendingSignalIds.has(s.signalId) && !s.cached && !s.opaque)
      .map((s) => s.signalId);
    if (toAdd.length === 0) return;
    const active = new Set(useWorkspaceStore.getState().activeSignalIds);
    toAdd.forEach((id) => active.add(id));
    applyTrim.mutate({ startUs: trimRange.start, endUs: trimRange.end, activeSignalIds: Array.from(active) });
  }
```
Update the button's `disabled` to `applyTrim.isPending`.

- [ ] **Step 5: Type-check + build**

Run: `cd app/ui && npx tsc --noEmit -p . && npm run build`
Expected: clean (only the pre-existing >500 kB chunk warning). No GUI runner exists - ledger this as the verification substitute.

- [ ] **Step 6: Commit**

```bash
git add app/ui/src/shared/api/trace-source.ts app/ui/src/shared/api/hooks.ts app/ui/src/widgets/WorkspaceLayout.tsx app/ui/src/widgets/SignalsList.tsx
git commit -m "feat(ui): route Trim-Apply and Read Payloads through one apply_trim mutation"
```

---

## Task 8: Remove the superseded subcommands + commands + hooks

**Files:**
- Modify: `native/cli/src/main.cpp` (delete `runDecodeSignals`, `runSignalStats`, their `main()` dispatch arms)
- Modify: `app/src-tauri/src/main.rs` (delete `decode_signals`, `recompute_signal_stats` commands + handler registration + their arg-shape tests)
- Modify: `app/ui/src/shared/api/trace-source.ts`, `hooks.ts` (delete `decodeSignals`/`recomputeSignalStats` methods + `useDecodeSignals`/`useRecomputeSignalStats`/`useIsDecodingSignals`/`useIsRecomputingSignalStats`)
- Modify: `native/store/test/` + `native/store/CMakeLists.txt` (delete `signal_stats_bounds_check.cpp`, `run_signal_stats_bounds.cmake`, the `fastrace_signal_stats_bounds` ctest; `apply_trim` now covers this)

**Interfaces:** removes the two old paths entirely - no consumer remains after Task 7.

- [ ] **Step 1: grep for any remaining references**

Run: `grep -rn "decode-signals\|decode_signals\|signal-stats\|recompute_signal_stats\|useDecodeSignals\|useRecomputeSignalStats\|decodeSignals\|recomputeSignalStats" native app crates --include=*.rs --include=*.cpp --include=*.ts --include=*.tsx`
Expected after deletion: no hits outside comments/history.

- [ ] **Step 2: Delete the code** listed above.

- [ ] **Step 3: Full test sweep**

Run: `cmake --build build && ctest --test-dir build --output-on-failure`
Run: `cargo test --manifest-path crates/Cargo.toml && cargo test --manifest-path app/src-tauri/Cargo.toml`
Run: `cd app/ui && npx tsc --noEmit -p . && npm run build`
Expected: all green; no dangling references.

- [ ] **Step 4: Format + commit**

```bash
/opt/homebrew/opt/llvm/bin/clang-format -i native/cli/src/main.cpp
cargo fmt --manifest-path app/src-tauri/Cargo.toml
git add -A
git commit -m "refactor: remove decode-signals and signal-stats subcommands superseded by apply-trim"
```

---

## Task 9: CONTEXT.md - document the incremental/indexed behavior

**Files:**
- Modify: `CONTEXT.md` (Trim Window entry line 53-55; Read Payloads entry line 49-51)

- [ ] **Step 1: Amend the Trim Window entry** to add, after the existing scope sentence: that every windowed read now seeks via the `container_index` (coarse per-container timestamps built at Prepare) and inflates only overlapping containers; that signal decode is incremental and tracked in `signal_coverage` (expand decodes only the uncovered delta, shrink decodes nothing, a disjoint jump re-decodes and resets coverage); and that one `apply-trim` pass does both the window-scoped `signal_stats` recompute and the delta decode.

- [ ] **Step 2: Amend the Read Payloads entry** to note it shares the same single `apply-trim` pass and the same coverage tracking (re-checking a cached signal never re-reads it).

- [ ] **Step 3: Commit**

```bash
git add CONTEXT.md
git commit -m "docs(context): describe indexed, incremental, single-pass trim ingestion"
```

---

## Task 10: HTML ingestion-pipeline documentation artifact

**Files:**
- Create: `docs/ingestion-pipeline.html`

**Interfaces:** standalone - a single self-contained HTML file (inline CSS, no external assets), openable directly in a browser.

- [ ] **Step 1: Write `docs/ingestion-pipeline.html`** covering, with inline SVG/HTML diagrams:
  1. **BLF layout** - LOGG file header, sequence of zlib-compressed LOG_CONTAINERs, LOBJ objects inside each (base header + ext header with `uint64_t timestamp` + payload); why timestamps are unreachable without inflating the container.
  2. **Prepare** - `fastrace_parse prepare`: single `BlfIngestReader::visit` pass -> `messages`, `protocol_*`, `arxml_*`, `signal_stats` (full trace), and `container_index` (byte offset + coarse `[first_ts,last_ts]` + `first_msg_id` per container). Fail-fast deletes the partial store.
  3. **Trace Store tables** - a table listing every table (`messages`, `meta`, `protocol_pdu/someip/someip_sd/doip`, `arxml_pdu/ecu/can/signal`, `signals`, `signal_stats`, `container_index`, `signal_coverage`) with one-line purpose and key columns, and the `schema_version: 4` contract.
  4. **Trim** - `[start,end]` in `timestamp_us`; non-destructive; how `container_index` turns a window into a byte range (seek to overlapping containers only, early-stop past `end`); time vs message-ordinal entry strategies (resolved to timestamps at Apply).
  5. **Signal decode** - on-demand (`docs/adr/0005`); `signal_coverage` incremental model (expand = delta only, shrink = nothing, disjoint = reset); the single `apply-trim` pass doing stats + decode together.
  6. **I/O optimization** - the core story: inflate (zlib + page-in) is the dominant cost; the index exists so we never inflate out-of-window containers twice; one pass per Apply, not two; coarse timestamps are enough to skip. Include a before/after read-volume comparison (pre-index: full file per Apply; post-index: only overlapping containers, once).
  7. **Deferred/KIV** - `decodeAllSignals` decodes all signals per message then filters (CPU, not I/O) - noted as the next optimization after this wave; `list_ecus` not trim-scoped (schema gap).

- [ ] **Step 2: Verify it renders** - open in a browser (or `python3 -c "import webbrowser,os; webbrowser.open('file://'+os.path.abspath('docs/ingestion-pipeline.html'))"`); confirm no broken layout, diagrams visible, no external network requests.

- [ ] **Step 3: Commit**

```bash
git add docs/ingestion-pipeline.html
git commit -m "docs: add HTML ingestion-pipeline artifact"
```

---

## Suggested task order

1 (schema) → 2 (reader) → 3 (prepare index) → 4 (apply-trim) → 5 (query helpers) → 6 (tauri) → 7 (frontend unify) → 8 (remove old paths) → 9 (CONTEXT) → 10 (HTML doc).

Tasks 9 and 10 are documentation and can be done any time after 8. Task 5's helpers are optional conveniences for Rust-side testing; if the implementer finds no Rust caller needs them, fold the SQL directly into Task 4 and drop Task 5 with a ledgered ruling.
