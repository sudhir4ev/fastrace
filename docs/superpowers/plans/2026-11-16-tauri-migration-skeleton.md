# Tauri Migration Skeleton Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Archive the current Qt/C++ repo state to `archive/qt-cpp-legacy`, stand up the greenfield directory layout from ADR 0001 (schema/, native/, crates/, app/) on `master` with carried-over C++ files relocated and buildable, empty-but-buildable Rust/Tauri scaffolding, and refreshed AI-native context docs (AGENTS.md, CONTEXT.md, GLOSSARY.md, root README).

**Architecture:** This is a skeleton-only migration, not a feature port. Each native/crates/app package gets its own build entry point and compiles/builds green with no real business logic ported yet (no BLF->DuckDB write path, no Rust query engine, no React views beyond a placeholder). Real logic ports (Prepare pipeline, Detector Query engine, UI) are separate follow-on plans that build on this skeleton.

**Tech Stack:** C++23/CMake (`native/`), Rust/Cargo workspace (`crates/`, `app/src-tauri`), Tauri 2, React + TypeScript + Vite (`app/ui`), DuckDB (schema only in this plan, no code yet).

**Spec:** `doc/adr/` (ADRs 0001-0007, `architecture.md`, `benchmarks.md`) — argues the target layout and boundaries this plan builds. Executors should read `doc/adr/0001-monorepo-layout-and-boundaries.md` and `doc/adr/architecture.md` before Task 4.

## Global Constraints

- C++ standard: C++23 per `AGENTS.md`, but carried-over files currently build as C++20 (`cpp/CMakeLists.txt` sets `CMAKE_CXX_STANDARD 20`). Bump to 23 in the new `native/CMakeLists.txt` and fix any resulting compile errors (expect none; files don't use C++20/23-only features beyond what already compiles).
- `native/` never depends on Rust; `crates/` never parses BLF or ARXML files (ADR 0001 boundary rule 2).
- `schema/` is the only shared contract between C++ and Rust (ADR 0001 boundary rule 1). No DDL duplicated elsewhere.
- Detection logic is SQL only, never C++ (ADR 0003). Do not carry `DetectionEngine`, `Detector`, `cpp/detectors/*`, or `Detection.h`'s evaluation logic forward as live code — only `ByteRange`/`Severity`-style plain structs that `ProtocolMessage.h` needs to compile are carried, as inert types.
- No destructive git operations without a plan step calling them out explicitly (archive branch is created, never force-pushed or deleted).
- Do not push `archive/qt-cpp-legacy` or any branch to `origin` as part of this plan — local branch only. Ask the user before pushing.

## Review Focus

- Deleting `cpp/`, `ui/`, `build/`, `specs/` on `master` before the `archive/qt-cpp-legacy` branch actually contains them (branch created from a stale HEAD, or created after files are already gone) — loses the old implementation permanently. Task 1 must run first and must be verified before Task 3 runs.
- Relocated C++ files silently drop a transitive include and fail to compile only when built standalone (each carried module must build as its own CMake target, not just "the old monolith still compiles").
- `.gitignore` not updated for new build artifacts (`native/build/`, `crates/target/`, `app/src-tauri/target/`, `app/ui/node_modules/`, `app/ui/dist/`) — a later `git add` accidentally commits gigabytes of build output.
- Root `CMakeLists.txt` still referencing removed `cpp`/`ui` subdirectories after Task 3 — `cmake --build build` fails with "source directory does not exist" instead of a clear migration error.
- AGENTS.md left with stale build/run commands (`./build/ui/fastrace_ui`, `clang-format` as the only formatter) after the stack changes — an agent reading it later runs commands that no longer exist.

---

## Task 1: Archive branch snapshot

**Files:** none (git branch operation only)

**Interfaces:**
- Produces: local branch `archive/qt-cpp-legacy` pointing at current `master` HEAD, for every later task to diff against if something needs recovering.

- [ ] **Step 1: Confirm working tree is clean**

Run: `git status --short`
Expected: no output (clean tree). If anything is listed, stop and ask the user before proceeding — do not branch over uncommitted work silently.

- [ ] **Step 2: Create the archive branch from current HEAD**

```bash
git branch archive/qt-cpp-legacy
```

- [ ] **Step 3: Verify the branch exists and points at the same commit as master**

Run: `git rev-parse master archive/qt-cpp-legacy`
Expected: both commands print the same commit hash.

- [ ] **Step 4: Verify the branch carries the full legacy tree**

Run: `git ls-tree -r --name-only archive/qt-cpp-legacy | grep -c '^cpp/'`
Expected: a non-zero count (matches `git ls-tree -r --name-only master | grep -c '^cpp/'` from before any later task runs).

No commit needed — this task only creates a branch pointer, it does not change `master`.

---

## Task 2: Relocate ADR docs to `docs/adr`, retire legacy `doc/` design notes

**Files:**
- Move: `doc/adr/` → `docs/adr/` (git mv, preserves history)
- Remove from `master`: `doc/design.md`, `doc/blf_batch_ingest_architecture.md`, `doc/duckdb_ingest_tracker.md`, `doc/query_store_architecture.md`, `doc/split_object_designs.md`, `doc/images/`
- Modify: `docs/adr/README.md`

**Interfaces:**
- Produces: `docs/adr/` as the canonical ADR location referenced by Task 11's AGENTS.md rewrite.

- [ ] **Step 1: Move the ADR directory with history preserved**

```bash
git mv doc/adr docs/adr
```

- [ ] **Step 2: Remove retired design docs (superseded by the ADRs, kept only on `archive/qt-cpp-legacy`)**

```bash
git rm -r doc/design.md doc/blf_batch_ingest_architecture.md doc/duckdb_ingest_tracker.md doc/query_store_architecture.md doc/split_object_designs.md doc/images
```

- [ ] **Step 3: Drop the now-empty `doc/` directory check**

Run: `ls doc 2>&1`
Expected: `ls: doc: No such file or directory` (git removes empty dirs automatically once all tracked files are gone).

- [ ] **Step 4: Update the self-reference in the moved README**

Edit `docs/adr/README.md` line 3 from:
```
Decisions for the greenfield Tauri-based fastrace monorepo. They were agreed while migrating from the current repo (Qt UI + C++ POC ingest). Copy this directory to `docs/adr/` in the new repo.
```
to:
```
Decisions for the Tauri-based fastrace monorepo. Agreed while migrating from the Qt UI + C++ POC ingest; see `archive/qt-cpp-legacy` for the pre-migration state.
```

- [ ] **Step 5: Verify**

Run: `test -d docs/adr && test ! -e doc && git status --short`
Expected: exit 0 for the `-d`/`! -e` checks; `git status --short` shows only the renames/removals/edit above, all staged (`R`/`D`/`M`).

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "docs: relocate ADRs to docs/adr, retire superseded design notes"
```

---

## Task 3: Remove legacy Qt/C++ trees and root scratch files from `master`

**Files:**
- Remove: `cpp/`, `ui/`, `build/`, `specs/`, `reference/`, `Modelfile`, `gen_array.py`, `dump_counts.patch`, `test_buildIndex.cpp`, `test_chunk.cpp`, `test_chunks.cpp`, `test_compare.cpp`, `test_counts.cpp`, `test_verify.cpp`, `SPEC_signal_visualization.md`

**Interfaces:**
- Consumes: `archive/qt-cpp-legacy` from Task 1 as the safety net — this task is only safe to run because that branch already holds every file listed here.

- [ ] **Step 1: Re-verify the archive branch has everything about to be deleted (do not skip — this is the one irreversible step in the plan)**

```bash
for p in cpp ui build specs reference Modelfile gen_array.py dump_counts.patch test_buildIndex.cpp test_chunk.cpp test_chunks.cpp test_compare.cpp test_counts.cpp test_verify.cpp SPEC_signal_visualization.md; do
  git cat-file -e archive/qt-cpp-legacy:"$p" 2>/dev/null || echo "MISSING: $p"
done
```
Expected: no `MISSING:` lines. If any print, stop — do not proceed to Step 2 until the archive branch actually contains that path.

- [ ] **Step 2: Remove the legacy trees and scratch files from the working tree**

```bash
git rm -r cpp ui build specs reference
git rm Modelfile gen_array.py dump_counts.patch test_buildIndex.cpp test_chunk.cpp test_chunks.cpp test_compare.cpp test_counts.cpp test_verify.cpp SPEC_signal_visualization.md
```
Note: `build/` may be gitignored already (CMake build output) — if `git rm -r build` errors with "did not match any files", that's fine, `rm -rf build` instead since it was never tracked.

- [ ] **Step 3: Verify master's root is clean of legacy paths**

Run: `ls`
Expected: none of `cpp`, `ui`, `build`, `specs`, `reference`, `Modelfile`, `gen_array.py`, `dump_counts.patch`, `test_*.cpp`, `SPEC_signal_visualization.md` appear. `AGENTS.md`, `CLAUDE.md`, `CONTEXT.md`, `GLOSSARY.md`, `CMakeLists.txt`, `docs/`, `.github/`, `.githooks/`, `.claude/`, `.cursor/`, `skills-lock.json`, `.gitignore` remain (untouched by this task).

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "chore: remove legacy Qt/C++ implementation, kept on archive/qt-cpp-legacy"
```

---

## Task 4: Root workspace scaffold and `schema/`

**Files:**
- Modify: `CMakeLists.txt` (repo root)
- Create: `schema/schema.sql`, `schema/rules/anomaly_detectors.sql`, `schema/rules/signal_anomaly_detectors.sql`, `schema/README.md`
- Modify: `.gitignore`

**Interfaces:**
- Produces: `schema/schema.sql` — the DDL that Task 8's `native/store` will embed at build time and Task 9's `crates/trace-store` will read `schema_version` from. Not yet rewritten to match ADR 0006's payload-free table list; carried over verbatim from the legacy repo and flagged with a TODO for the follow-on port plan.

- [ ] **Step 1: Carry the schema and rule SQL into `schema/` (content, not git history — these come from the deleted `cpp/sql/`, recovered from the archive branch)**

```bash
mkdir -p schema/rules
git show archive/qt-cpp-legacy:cpp/sql/schema.sql > schema/schema.sql
git show archive/qt-cpp-legacy:cpp/sql/anomaly_detectors.sql > schema/rules/anomaly_detectors.sql
git show archive/qt-cpp-legacy:cpp/sql/signal_anomaly_detectors.sql > schema/rules/signal_anomaly_detectors.sql
```

- [ ] **Step 2: Add a README noting the carry-over is unverified against ADR 0006/0003**

Create `schema/README.md`:
```markdown
# schema/

Shared Trace Store contract between `native/` (C++ writer) and `crates/` (Rust reader). See `docs/adr/0001-monorepo-layout-and-boundaries.md` boundary rule 1 and 5.

- `schema.sql` — DDL for `<stem>.duckdb`. Carried over from the pre-migration `cpp/sql/schema.sql` as a starting point; **not yet verified** against `docs/adr/0006-trace-store-schema-no-payloads.md`'s table list (`messages`, `protocol_pdu`, `protocol_someip`, `protocol_someip_sd`, `protocol_doip`, `arxml_pdu`, `arxml_can`, `arxml_ecu`, `arxml_signal`, `signals`, `meta`). Reconcile before `native/store` embeds it.
- `rules/` — Detector Query SQL (`docs/adr/0003-anomaly-detection-is-duckdb-sql.md`). Carried over from `cpp/sql/`; not yet verified to run against the schema above with no C++ detector involved.
- `schema_version` bumps must be reflected in both the C++ embed step (`native/store`) and the Rust open-time check (`crates/trace-store`).
```

- [ ] **Step 3: Point the root CMake workspace at `native/` instead of `cpp`/`ui`**

Replace `CMakeLists.txt`:
```cmake
cmake_minimum_required(VERSION 3.20)
project(fastrace VERSION 0.1.0 LANGUAGES CXX)

set(CMAKE_EXPORT_COMPILE_COMMANDS ON)

enable_testing()

add_subdirectory(native)
```

- [ ] **Step 4: Add ignores for the new build outputs across all packages**

Append to `.gitignore`:
```
# native/ (CMake)
native/build/

# crates/ and app/src-tauri (Cargo)
crates/target/
app/src-tauri/target/

# app/ui (Vite/npm)
app/ui/node_modules/
app/ui/dist/
```

- [ ] **Step 5: Verify**

Run: `test -f schema/schema.sql && test -f schema/rules/anomaly_detectors.sql && grep -q 'add_subdirectory(native)' CMakeLists.txt`
Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: scaffold schema/ contract and point root CMake at native/"
```

---

## Task 5: `native/blf` package (wire types, mapped I/O, parallel/sequential readers)

**Files:**
- Create: `native/CMakeLists.txt`
- Create: `native/blf/CMakeLists.txt`
- Move (content from `archive/qt-cpp-legacy`, new paths): `native/blf/include/BlfTypes.h`, `native/blf/include/MappedFile.h`, `native/blf/include/Cursor.h`, `native/blf/include/WorkQueue.h`, `native/blf/include/TraceMessage.h`, `native/blf/include/ArxmlTypes.h`, `native/blf/include/NetTypes.h`, `native/blf/include/ProtocolMessage.h`, `native/blf/include/Detection.h`, `native/blf/include/Analyzer.h`, `native/blf/include/BlfIngestReader.h`, `native/blf/src/MappedFile.cpp`, `native/blf/src/WorkQueue.cpp`, `native/blf/src/Analyzer.cpp`, `native/blf/src/BlfIngestReader.cpp`

**Interfaces:**
- Produces: static library target `fastrace_blf`, headers under `native/blf/include/`, consumed by Task 6 (`native/protocol`) and Task 7 (`native/signaldb`) for `ArxmlTypes.h`/`TraceMessage.h`/`NetTypes.h`/etc, and by Task 8 (`native/cli`).
- Note on grouping: `Analyzer.cpp` includes `ArxmlParser.h`/`SignalDecoder.h` (Task 7's package) — this is a real cross-module dependency inherited from the legacy code, not introduced here. `fastrace_blf` links against `fastrace_signaldb` (added once Task 7 exists); this task alone will not compile standalone until Task 7 lands. Both tasks must land before the Step 6 build-verify in Task 7.

- [ ] **Step 1: Pull the carried-over headers and sources from the archive branch into their new locations**

```bash
mkdir -p native/blf/include native/blf/src
for f in BlfTypes.h MappedFile.h Cursor.h WorkQueue.h TraceMessage.h ArxmlTypes.h NetTypes.h ProtocolMessage.h Detection.h Analyzer.h BlfIngestReader.h; do
  git show archive/qt-cpp-legacy:cpp/include/"$f" > native/blf/include/"$f"
done
for f in MappedFile.cpp WorkQueue.cpp Analyzer.cpp BlfIngestReader.cpp; do
  git show archive/qt-cpp-legacy:cpp/src/"$f" > native/blf/src/"$f"
done
git add native/blf
```

- [ ] **Step 2: Create `native/CMakeLists.txt` (parent of all native packages, owns the shared FetchContent deps the carried files need: spdlog for logging, libdeflate for zlib inflate, pugixml for ARXML parsing)**

```cmake
cmake_minimum_required(VERSION 3.20)
project(fastrace_native VERSION 0.1.0 LANGUAGES C CXX)

set(CMAKE_CXX_STANDARD 23)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

if(NOT CMAKE_BUILD_TYPE)
  set(CMAKE_BUILD_TYPE "RelWithDebInfo" CACHE STRING "Choose the type of build." FORCE)
endif()

include(FetchContent)

FetchContent_Declare(
  spdlog
  GIT_REPOSITORY https://github.com/gabime/spdlog.git
  GIT_TAG        v1.15.3
)
FetchContent_Declare(
  libdeflate
  GIT_REPOSITORY https://github.com/ebiggers/libdeflate.git
  GIT_TAG        v1.25
)
set(LIBDEFLATE_BUILD_GZIP OFF CACHE BOOL "" FORCE)
set(LIBDEFLATE_BUILD_TESTS OFF CACHE BOOL "" FORCE)
FetchContent_MakeAvailable(spdlog libdeflate)

FetchContent_Declare(
  pugixml
  GIT_REPOSITORY https://github.com/zeux/pugixml.git
  GIT_TAG        v1.14
)
FetchContent_MakeAvailable(pugixml)

add_subdirectory(blf)
add_subdirectory(protocol)
add_subdirectory(signaldb)
add_subdirectory(store)
add_subdirectory(cli)
```

- [ ] **Step 3: Create `native/blf/CMakeLists.txt`**

```cmake
add_library(fastrace_blf STATIC
  src/MappedFile.cpp
  src/WorkQueue.cpp
  src/Analyzer.cpp
  src/BlfIngestReader.cpp
)
target_include_directories(fastrace_blf PUBLIC
  ${CMAKE_CURRENT_SOURCE_DIR}/include
)
target_link_libraries(fastrace_blf PUBLIC libdeflate_static spdlog::spdlog fastrace_signaldb)
```

- [ ] **Step 4: Verify the file moves are complete (full build happens in Task 7, once `fastrace_signaldb` exists)**

Run: `ls native/blf/include native/blf/src`
Expected: 11 headers and 4 sources listed, matching Step 1's lists.

- [ ] **Step 5: Commit**

```bash
git commit -m "feat(native): add blf package (carried from archive/qt-cpp-legacy, unbuilt pending signaldb)"
```

---

## Task 6: `native/protocol` package (peel)

**Files:**
- Create: `native/protocol/CMakeLists.txt`
- Move (content): `native/protocol/include/ProtocolParser.h`, `native/protocol/src/ProtocolParser.cpp`

**Interfaces:**
- Consumes: `fastrace_blf`'s public headers (`ArxmlTypes.h`, `Detection.h`, `ProtocolMessage.h`, `TraceMessage.h`, `NetTypes.h`) from Task 5.
- Produces: static library target `fastrace_protocol`, consumed by Task 8 (`native/cli`).

- [ ] **Step 1: Pull the carried-over header and source**

```bash
mkdir -p native/protocol/include native/protocol/src
git show archive/qt-cpp-legacy:cpp/include/ProtocolParser.h > native/protocol/include/ProtocolParser.h
git show archive/qt-cpp-legacy:cpp/src/ProtocolParser.cpp > native/protocol/src/ProtocolParser.cpp
git add native/protocol
```

- [ ] **Step 2: Create `native/protocol/CMakeLists.txt`**

```cmake
add_library(fastrace_protocol STATIC
  src/ProtocolParser.cpp
)
target_include_directories(fastrace_protocol PUBLIC
  ${CMAKE_CURRENT_SOURCE_DIR}/include
)
target_link_libraries(fastrace_protocol PUBLIC fastrace_blf)
```

- [ ] **Step 3: Verify**

Run: `ls native/protocol/include native/protocol/src`
Expected: `ProtocolParser.h` and `ProtocolParser.cpp` listed.

- [ ] **Step 4: Commit**

```bash
git commit -m "feat(native): add protocol package (carried from archive/qt-cpp-legacy)"
```

---

## Task 7: `native/signaldb` package (ARXML + signal decode) and first green build

**Files:**
- Create: `native/signaldb/CMakeLists.txt`
- Move (content): `native/signaldb/include/ArxmlParser.h`, `native/signaldb/include/SignalDecoder.h`, `native/signaldb/src/ArxmlParser.cpp`, `native/signaldb/src/SignalDecoder.cpp`

**Interfaces:**
- Consumes: `fastrace_blf`'s `ArxmlTypes.h`/`TraceMessage.h`/`BlfTypes.h` from Task 5.
- Produces: static library target `fastrace_signaldb`, which `fastrace_blf` links against (Task 5 Step 3) and which Task 8 (`native/cli`) also links directly for the future `decode-signals` subcommand.

- [ ] **Step 1: Pull the carried-over headers and sources**

```bash
mkdir -p native/signaldb/include native/signaldb/src
git show archive/qt-cpp-legacy:cpp/include/ArxmlParser.h > native/signaldb/include/ArxmlParser.h
git show archive/qt-cpp-legacy:cpp/include/SignalDecoder.h > native/signaldb/include/SignalDecoder.h
git show archive/qt-cpp-legacy:cpp/src/ArxmlParser.cpp > native/signaldb/src/ArxmlParser.cpp
git show archive/qt-cpp-legacy:cpp/src/SignalDecoder.cpp > native/signaldb/src/SignalDecoder.cpp
git add native/signaldb
```

- [ ] **Step 2: Create `native/signaldb/CMakeLists.txt`**

```cmake
add_library(fastrace_signaldb STATIC
  src/ArxmlParser.cpp
  src/SignalDecoder.cpp
)
target_include_directories(fastrace_signaldb PUBLIC
  ${CMAKE_CURRENT_SOURCE_DIR}/include
)
target_include_directories(fastrace_signaldb PRIVATE
  ${CMAKE_SOURCE_DIR}/blf/include
)
target_link_libraries(fastrace_signaldb PUBLIC pugixml::pugixml spdlog::spdlog)
```
Note: `fastrace_signaldb` needs `ArxmlTypes.h`/`TraceMessage.h`/`BlfTypes.h` from `native/blf/include` but must not create a CMake link cycle with `fastrace_blf` (which links `fastrace_signaldb` for `Analyzer.cpp`). Use a private include path to `blf/include` here instead of `target_link_libraries(... fastrace_blf)`, since this package only needs the headers, not to link the blf library.

- [ ] **Step 3: Stub `native/store` and `native/cli` as empty-but-present directories so `native/CMakeLists.txt`'s `add_subdirectory` calls from Task 5 Step 2 don't fail before Task 8 lands**

```bash
mkdir -p native/store native/cli
echo "# placeholder until Task 8" > native/store/CMakeLists.txt
echo "# placeholder until Task 8" > native/cli/CMakeLists.txt
git add native/store native/cli
```

- [ ] **Step 4: First full build of the native workspace**

Run:
```bash
cmake -S . -B build -DCMAKE_BUILD_TYPE=RelWithDebInfo
cmake --build build
```
Expected: configure and build succeed, producing `libfastrace_blf.a`, `libfastrace_protocol.a`, `libfastrace_signaldb.a` under `build/native/`. This is the first point in the plan where the relocated code is proven to compile in its new layout.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(native): add signaldb package; native workspace builds green"
```

---

## Task 8: `native/store` and `native/cli` skeletons

**Files:**
- Modify: `native/store/CMakeLists.txt`
- Create: `native/store/README.md`
- Modify: `native/cli/CMakeLists.txt`
- Create: `native/cli/src/main.cpp`

**Interfaces:**
- Produces: executable target `fastrace_parse` accepting `prepare` and `decode-signals` subcommands (stubs only — they print a not-implemented message and exit 1). This is the CLI contract ADR 0001 calls out as "a second interface [that] must be versioned with the app" — establishing the entry point now means the follow-on port plan adds behavior, not scaffolding.

- [ ] **Step 1: Document `native/store`'s future responsibility without writing the DuckDB Appender code yet (that's the follow-on port plan, needs `schema/schema.sql` reconciled first per Task 4)**

Create `native/store/README.md`:
```markdown
# native/store

Will embed `schema/schema.sql` at build time and write the Trace Store via the DuckDB Appender (`docs/adr/0002-cpp-sidecar-writes-trace-store.md`). Empty in this skeleton — implemented in the Prepare-pipeline port plan.
```

Replace `native/store/CMakeLists.txt`:
```cmake
# Intentionally no targets yet. Will add a fastrace_store static library that
# embeds schema/schema.sql (see docs/adr/0001) and wraps the DuckDB Appender
# (see docs/adr/0002) once the Prepare pipeline is ported.
```

- [ ] **Step 2: Write the `fastrace_parse` CLI stub**

Create `native/cli/src/main.cpp`:
```cpp
#include <cstdio>
#include <cstring>

int main(int argc, char** argv) {
    if (argc < 2) {
        std::fprintf(stderr, "usage: fastrace_parse <prepare|decode-signals> [args...]\n");
        return 1;
    }
    if (std::strcmp(argv[1], "prepare") == 0) {
        std::fprintf(stderr, "fastrace_parse prepare: not implemented yet (see docs/adr/0002)\n");
        return 1;
    }
    if (std::strcmp(argv[1], "decode-signals") == 0) {
        std::fprintf(stderr, "fastrace_parse decode-signals: not implemented yet (see docs/adr/0005)\n");
        return 1;
    }
    std::fprintf(stderr, "unknown subcommand: %s\n", argv[1]);
    return 1;
}
```

- [ ] **Step 3: Replace `native/cli/CMakeLists.txt`**

```cmake
add_executable(fastrace_parse
  src/main.cpp
)
target_link_libraries(fastrace_parse PRIVATE fastrace_blf fastrace_protocol fastrace_signaldb)
```

- [ ] **Step 4: Build and smoke-test the stub binary**

Run:
```bash
cmake --build build
./build/native/cli/fastrace_parse
./build/native/cli/fastrace_parse prepare
```
Expected: first command prints the usage line and exits 1; second prints the "not implemented yet" line and exits 1. Both confirm `fastrace_parse` links against all three libraries without unresolved symbols.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(native): add store placeholder and fastrace_parse CLI stub"
```

---

## Task 9: `crates/` Cargo workspace skeleton

**Files:**
- Create: `crates/Cargo.toml`
- Create: `crates/trace-store/Cargo.toml`, `crates/trace-store/src/lib.rs`
- Create: `crates/query/Cargo.toml`, `crates/query/src/lib.rs`
- Create: `crates/sidecar/Cargo.toml`, `crates/sidecar/src/lib.rs`

**Interfaces:**
- Produces: `trace_store::open(path: &std::path::Path) -> Result<(), String>` — stub signature only, real implementation (schema_version check per ADR 0001 boundary rule 1) is a follow-on plan. `query::run(_sql: &str) -> Result<(), String>` and `sidecar::spawn(_args: &[String]) -> Result<(), String>` — same, stub signatures establishing the crate boundary from ADR 0001 (`trace-store` opens/reads, `query` runs Detector Queries, `sidecar` spawns `fastrace_parse`) so `app/src-tauri` (Task 10) has something concrete to depend on.
- Consumes: nothing from `native/` — per the Global Constraints, `crates/` never parses BLF/ARXML; it will later open the `.duckdb` file `native/cli`'s `fastrace_parse prepare` produces, but does no parsing itself.

- [ ] **Step 1: Create the workspace manifest**

Create `crates/Cargo.toml`:
```toml
[workspace]
resolver = "2"
members = ["trace-store", "query", "sidecar"]
```

- [ ] **Step 2: Create `trace-store`**

Create `crates/trace-store/Cargo.toml`:
```toml
[package]
name = "trace-store"
version = "0.1.0"
edition = "2021"

[dependencies]
```

Create `crates/trace-store/src/lib.rs`:
```rust
use std::path::Path;

/// Opens an existing Trace Store (`<stem>.duckdb`) read-only and checks
/// `meta.schema_version` against `schema/schema.sql` (docs/adr/0001, rule 1).
/// Stub: real implementation lands with the duckdb-rs integration.
pub fn open(_path: &Path) -> Result<(), String> {
    Err("trace_store::open: not implemented yet (see docs/adr/0002)".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    #[test]
    fn open_is_not_yet_implemented() {
        assert!(open(Path::new("nonexistent.duckdb")).is_err());
    }
}
```

- [ ] **Step 3: Create `query`**

Create `crates/query/Cargo.toml`:
```toml
[package]
name = "query"
version = "0.1.0"
edition = "2021"

[dependencies]
trace-store = { path = "../trace-store" }
```

Create `crates/query/src/lib.rs`:
```rust
/// Runs a Detector Query (raw SQL, docs/adr/0003) against an opened Trace
/// Store and returns rows/columns. Stub: real implementation lands with the
/// duckdb-rs query execution.
pub fn run(_sql: &str) -> Result<(), String> {
    Err("query::run: not implemented yet (see docs/adr/0003)".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn run_is_not_yet_implemented() {
        assert!(run("select 1").is_err());
    }
}
```

- [ ] **Step 4: Create `sidecar`**

Create `crates/sidecar/Cargo.toml`:
```toml
[package]
name = "sidecar"
version = "0.1.0"
edition = "2021"

[dependencies]
```

Create `crates/sidecar/src/lib.rs`:
```rust
/// Spawns the bundled `fastrace_parse` sidecar (docs/adr/0001) and parses its
/// progress/error protocol. Stub: real implementation lands with the Tauri
/// sidecar process wiring.
pub fn spawn(_args: &[String]) -> Result<(), String> {
    Err("sidecar::spawn: not implemented yet (see docs/adr/0002)".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn spawn_is_not_yet_implemented() {
        assert!(spawn(&["prepare".to_string()]).is_err());
    }
}
```

- [ ] **Step 5: Build and test the workspace**

Run: `cargo test --manifest-path crates/Cargo.toml`
Expected: 3 tests pass (one per crate), 0 failures. Requires network access to fetch nothing (no external deps yet) but does need a working Rust toolchain.

- [ ] **Step 6: Commit**

```bash
git add crates
git commit -m "feat(crates): scaffold trace-store, query, sidecar workspace"
```

---

## Task 10: `app/` Tauri shell skeleton

**Files:**
- Create: `app/src-tauri/Cargo.toml`, `app/src-tauri/tauri.conf.json`, `app/src-tauri/src/main.rs`, `app/src-tauri/build.rs`
- Create: `app/ui/package.json`, `app/ui/index.html`, `app/ui/src/main.tsx`, `app/ui/src/App.tsx`, `app/ui/vite.config.ts`, `app/ui/tsconfig.json`

**Interfaces:**
- Consumes: `trace-store`, `query`, `sidecar` crates from Task 9 (declared as path dependencies in `app/src-tauri/Cargo.toml`), per ADR 0001 ("`app/src-tauri` holds no business logic; it adapts `crates/*` to Tauri commands").
- Produces: a `prepare_trace` Tauri command stub that calls `sidecar::spawn` and returns its `Err` string to the frontend, demonstrating the adapter pattern end to end without real logic.

- [ ] **Step 1: Create the Tauri Rust shell**

Create `app/src-tauri/Cargo.toml`:
```toml
[package]
name = "fastrace-app"
version = "0.1.0"
edition = "2021"

[build-dependencies]
tauri-build = { version = "2", features = [] }

[dependencies]
tauri = { version = "2", features = [] }
serde = { version = "1", features = ["derive"] }
serde_json = "1"
trace-store = { path = "../../crates/trace-store" }
query = { path = "../../crates/query" }
sidecar = { path = "../../crates/sidecar" }
```

Create `app/src-tauri/build.rs`:
```rust
fn main() {
    tauri_build::build()
}
```

Create `app/src-tauri/src/main.rs`:
```rust
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

#[tauri::command]
fn prepare_trace(path: String) -> Result<(), String> {
    sidecar::spawn(&["prepare".to_string(), path])
}

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![prepare_trace])
        .run(tauri::generate_context!())
        .expect("error while running fastrace");
}
```

Create `app/src-tauri/tauri.conf.json`:
```json
{
  "$schema": "https://schema.tauri.app/config/2",
  "productName": "fastrace",
  "version": "0.1.0",
  "identifier": "com.fastrace.app",
  "build": {
    "frontendDist": "../ui/dist",
    "devUrl": "http://localhost:5173",
    "beforeDevCommand": "npm run dev --prefix ../ui",
    "beforeBuildCommand": "npm run build --prefix ../ui"
  },
  "app": {
    "windows": [
      {
        "title": "fastrace",
        "width": 1200,
        "height": 800
      }
    ]
  }
}
```

- [ ] **Step 2: Create the React/TypeScript frontend skeleton**

Create `app/ui/package.json`:
```json
{
  "name": "fastrace-ui",
  "private": true,
  "version": "0.1.0",
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc && vite build",
    "preview": "vite preview"
  },
  "dependencies": {
    "react": "^18.3.1",
    "react-dom": "^18.3.1",
    "@tauri-apps/api": "^2.0.0"
  },
  "devDependencies": {
    "@types/react": "^18.3.1",
    "@types/react-dom": "^18.3.1",
    "@vitejs/plugin-react": "^4.3.1",
    "typescript": "^5.5.0",
    "vite": "^5.4.0"
  }
}
```

Create `app/ui/index.html`:
```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <title>fastrace</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

Create `app/ui/src/main.tsx`:
```tsx
import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
```

Create `app/ui/src/App.tsx`:
```tsx
export default function App() {
  return <div>fastrace — skeleton shell, no Prepare pipeline yet</div>;
}
```

Create `app/ui/vite.config.ts`:
```ts
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 5173,
    strictPort: true,
  },
});
```

Create `app/ui/tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ES2020",
    "useDefineForClassFields": true,
    "lib": ["ES2020", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "skipLibCheck": true,
    "moduleResolution": "bundler",
    "resolveJsonModule": true,
    "isolatedModules": true,
    "noEmit": true,
    "jsx": "react-jsx",
    "strict": true
  },
  "include": ["src"]
}
```

- [ ] **Step 3: Verify the Rust side compiles (requires network to fetch the `tauri` crate the first time)**

Run: `cargo check --manifest-path app/src-tauri/Cargo.toml`
Expected: succeeds. If it fails only on network/registry access in a sandboxed environment, note that in the task result rather than treating it as a code defect — re-run with network access before considering this task done.

- [ ] **Step 4: Verify the frontend installs and builds (requires network for npm)**

Run:
```bash
npm install --prefix app/ui
npm run build --prefix app/ui
```
Expected: `app/ui/dist/index.html` exists afterward.

- [ ] **Step 5: Commit**

```bash
git add app
git commit -m "feat(app): scaffold Tauri shell and React/TS frontend"
```

---

## Task 11: Refresh AI-native context docs

**Files:**
- Modify: `AGENTS.md`
- Modify: `CONTEXT.md`
- Modify: `GLOSSARY.md`
- Create: `README.md` (repo root — did not exist before this plan)

**Interfaces:** none (documentation only)

- [ ] **Step 1: Rewrite `AGENTS.md` for the new stack**

Replace the `## Project Overview` through `## Important files and directories` sections of `AGENTS.md` (keep the `# CLAUDE.md` title line) with:

```markdown
## Project Overview
* **What it is:** Desktop app to analyze automotive network traces (CAN and Ethernet) via SQL-based anomaly detection over a local Trace Store. Currently a skeleton mid-migration from a Qt/C++ proof of concept — see `docs/adr/` for the target architecture and `archive/qt-cpp-legacy` for the pre-migration code.
* **Target Platforms:** Linux, Mac, and Windows (Tauri).
* **Core Goals:**
  * Fast Prepare (BLF -> Trace Store) and fast Detector Query iteration.
  * Non-blocking UI; a DuckDB write lock during Prepare is the only user-visible blackout (`docs/adr/0004-detectors-run-after-prepare.md`).
  * Detection logic lives entirely in SQL, never in C++ or Rust (`docs/adr/0003-anomaly-detection-is-duckdb-sql.md`).

## Development Commands
* **Build native (C++ sidecar):** `cmake -S . -B build && cmake --build build`
* **Run the sidecar CLI directly:** `./build/native/cli/fastrace_parse prepare <trace.blf>`
* **Build/test Rust crates:** `cargo test --manifest-path crates/Cargo.toml`
* **Run the Tauri app in dev mode:** `cargo tauri dev --manifest-path app/src-tauri/Cargo.toml` (or `npm run dev --prefix app/ui` for frontend-only iteration)
* **Format C++:** `clang-format -i [file]`
* **Format/lint Rust:** `cargo fmt --manifest-path crates/Cargo.toml`, `cargo clippy --manifest-path crates/Cargo.toml`

## Coding Rules & Preferences
* **C++ (`native/`):** C++23. `PascalCase` classes/structs, `camelCase` variables/methods, `m_` prefix for private members, `k` prefix for constants. Smart pointers and RAII for memory management. No Qt — `native/` is plain CMake/C++, no UI knowledge (`docs/adr/0001`).
* **Rust (`crates/`, `app/src-tauri`):** Plain library crates in `crates/` hold logic and know nothing about Tauri; `app/src-tauri` is a thin `#[tauri::command]` adapter layer only (`docs/adr/0001` boundary rule 6).
* **Frontend (`app/ui`):** React + TypeScript + Vite.
* **Includes:** Group headers logically (local headers, third-party, standard library).
* **Organization:** Keep code modular with strong separation of responsibility across the `native/{blf,protocol,signaldb,store,cli}` and `crates/{trace-store,query,sidecar}` boundaries defined in `docs/adr/0001-monorepo-layout-and-boundaries.md`.

## Do
* **Always:** Run `clang-format` on modified C++ files; `cargo fmt` on modified Rust files.
* **Always:** Update the relevant `CMakeLists.txt` or `Cargo.toml` when adding or removing source files.
* **Always:** Bump `schema_version` in `schema/schema.sql` when changing the Trace Store DDL, and update both the C++ embed step and the Rust open-time check in the same change (`docs/adr/0001` boundary rule 1).
* **Always:** Keep new anomaly-detection logic as SQL in `schema/rules/`, never as C++ or Rust conditionals (`docs/adr/0003`).

## Do Not Do
* **Never:** Add Tauri or UI knowledge to `native/` or `crates/trace-store`/`crates/query`/`crates/sidecar`.
* **Never:** Parse BLF or ARXML files in Rust — that is `native/`'s job exclusively (`docs/adr/0001` boundary rule 2).
* **Never:** Reintroduce a streaming/C++ detection engine — detection is SQL only (`docs/adr/0003`).
* **Avoid:** Using emoticons in source code and plaintext documentation, except where already established (like UI action icons).

## Important files and directories
* `docs/adr/`: Architecture Decision Records for the Tauri migration — read before touching package boundaries. Start with `0001-monorepo-layout-and-boundaries.md` and `architecture.md`.
* `schema/`: The only shared contract between `native/` and `crates/` — DDL (`schema.sql`) and Detector Query rule SQL (`rules/`).
* `native/`: C++23/CMake. No Tauri or Rust knowledge.
  * `native/blf/`: BLF reader (container inflate, split-object stitch), wire types, mapped I/O.
  * `native/protocol/`: Protocol peel (PDU, SOME/IP, SOME/IP-SD, DoIP).
  * `native/signaldb/`: ARXML parsing and on-demand signal decode.
  * `native/store/`: Embeds `schema/schema.sql`; will write the Trace Store via the DuckDB Appender.
  * `native/cli/`: `fastrace_parse` — the `prepare` and `decode-signals` subcommands, bundled as a Tauri sidecar.
* `crates/`: Rust workspace. No Tauri dependency, no BLF/ARXML parsing.
  * `crates/trace-store/`: Opens `<stem>.duckdb` read-only, checks `schema_version`.
  * `crates/query/`: Runs Detector Query SQL against an opened Trace Store.
  * `crates/sidecar/`: Spawns `fastrace_parse` and parses its progress/error protocol.
* `app/`: The Tauri shell.
  * `app/src-tauri/`: Thin `#[tauri::command]` adapters over `crates/*`. No business logic.
  * `app/ui/`: React + TypeScript frontend.
* `archive/qt-cpp-legacy` (git branch, not a directory): the pre-migration Qt/C++ implementation, kept for reference during the port. Not on `master`.
```

- [ ] **Step 2: Rewrite `CONTEXT.md` to match the ADRs instead of the superseded Parquet-artifact plan**

Replace the `## Language` section's `Trace Store`, `Parse`, `Ingest`, `Parse Artifact`, `Sidecar`, `Shell` entries (the ones ADR 0002 explicitly supersedes) with entries matching the accepted decision. Full replacement for `CONTEXT.md`:

```markdown
# Fastrace

Desktop analysis of automotive network traces (CAN / Ethernet), with query-based anomaly detection over a local analytical store.

Canonical decisions live in `docs/adr/`. This file is product vocabulary only; if it ever disagrees with an ADR, the ADR wins — fix this file.

## Language

**Trace**:
A source capture file (BLF). Read only by the C++ sidecar (`native/`), only during Prepare or on-demand signal decode.
_Avoid_: Log (ambiguous), recording.

**Trace Store**:
`<stem>.duckdb` beside the Trace. Holds everything Detector Queries need after Prepare. Written by the C++ sidecar via the DuckDB Appender (`docs/adr/0002`); the Rust app only opens it read-only.
_Avoid_: Rust-written DuckDB; a separate Parse Artifact file (superseded, see `docs/adr/0002`).

**Prepare**:
The one user action: the C++ sidecar (`fastrace_parse prepare`) reads the Trace (+ optional ARXML), peels protocol fields, and writes the Trace Store directly — no intermediate Parquet/Arrow handoff file. Fail-fast: a non-zero exit deletes the partial store.
_Avoid_: Separate "Parse" and "Ingest" steps or a "Parse Artifact" (both were the pre-ADR-0002 plan; the sidecar now writes DuckDB in one pass).

**Detector Query**:
User-editable SQL run against the Trace Store by `crates/query`. Results are raw returned columns/rows. All anomaly-detection logic is SQL, never C++ or Rust (`docs/adr/0003`).
_Avoid_: Detector (C++ class); a streaming detection engine.

**Signal Database**:
An AUTOSAR ARXML (or later DBC) description of the vehicle network — PDUs, signals, ECUs — used to interpret IDs/addresses. Optional Prepare input; its dictionary is materialized into `arxml_*` tables. Actual signal values are decoded on demand when the user plots a signal, not at Prepare time (`docs/adr/0005`).
_Avoid_: "the database" alone (ambiguous with Trace Store); assuming all signals are decoded at Prepare.

**Sidecar**:
`fastrace_parse`, the bundled C++ executable (`native/cli`). Runs `prepare` and `decode-signals`. Writes the Trace Store directly; does not run Detector Queries.
_Avoid_: Ingest engine as a separate Rust concept; overloading `cpp_parser` as the product name (retired with the Qt UI).

**Shell**:
The Tauri app under `app/` (Rust `src-tauri` + React/TypeScript `ui`) — sole product UI. Owns Detector Query execution via `crates/query` and spawns the sidecar via `crates/sidecar`. Qt `/ui` and the streaming `DetectionEngine`/C++ detectors are retired (`archive/qt-cpp-legacy`).
_Avoid_: fastrace_ui / Qt UI as product surface; dual anomaly paths.
```

- [ ] **Step 3: Update `GLOSSARY.md`'s product-pipeline table to match**

Replace the `## Product pipeline (see also CONTEXT.md)` table in `GLOSSARY.md` with:

```markdown
## Product pipeline (see also CONTEXT.md)

| Term | Meaning |
|------|---------|
| **Trace** | Source capture file (BLF). Read only by the C++ sidecar, only during Prepare or on-demand signal decode. |
| **Prepare** | One user action: the C++ sidecar reads the Trace (+ optional ARXML), peels protocols, and writes the Trace Store directly via the DuckDB Appender. Fail-fast. |
| **Trace Store** | Local DuckDB file for Detector Query SQL after Prepare. Beside the Trace; written by the sidecar, read by the Shell. |
| **Sidecar** | C++ CLI `fastrace_parse` (`native/cli`), subcommands `prepare` and `decode-signals`. |
| **Shell** | Tauri `app/` UI: Prepare, Detector Query, results. |
| **Detector Query** | User-authored SQL against the Trace Store, run by `crates/query`; returns raw columns/rows. |
| **Signal Database** | ARXML (later DBC) describing the vehicle network. Optional; its dictionary is materialized into the Trace Store at Prepare; signal values decode on demand when plotted. |
| **Peel** | Extract typed protocol headers/fields from a frame into columns (SOME/IP, SD, DoIP, PDU) so SQL need not re-parse payloads. |
```

- [ ] **Step 4: Create a root `README.md`** (none existed before this plan)

```markdown
# fastrace

Desktop app to analyze automotive network traces (CAN and Ethernet) via SQL-based anomaly detection over a local Trace Store. Tauri (Rust + React/TypeScript) with a C++ sidecar for trace parsing.

- Architecture decisions: `docs/adr/` — start with `0001-monorepo-layout-and-boundaries.md` and `architecture.md`.
- Agent/contributor instructions: `AGENTS.md`.
- Product vocabulary: `CONTEXT.md`, `GLOSSARY.md`.
- Pre-migration Qt/C++ implementation: `archive/qt-cpp-legacy` branch (not on `master`).

## Build

```bash
# C++ sidecar
cmake -S . -B build && cmake --build build

# Rust crates
cargo test --manifest-path crates/Cargo.toml

# Tauri app (dev)
cargo tauri dev --manifest-path app/src-tauri/Cargo.toml
```
```

- [ ] **Step 5: Verify no stale references remain**

Run: `grep -rn "fastrace_ui\|cpp_parser\|Parse Artifact\|\.parse\.parquet" AGENTS.md CONTEXT.md GLOSSARY.md README.md`
Expected: no matches (all superseded terminology removed from the docs this task owns).

- [ ] **Step 6: Commit**

```bash
git add AGENTS.md CONTEXT.md GLOSSARY.md README.md
git commit -m "docs: refresh AI-native context docs for the Tauri/Rust/C++ skeleton"
```

---

## Self-Review Notes

- **Spec coverage:** ADR 0001 layout (schema/, native/{blf,protocol,signaldb,store,cli}, crates/{trace-store,query,sidecar}, app/{src-tauri,ui}) — Tasks 4-10. ADR 0002 (sidecar writes DuckDB directly) — reflected in `native/store` README and CONTEXT.md rewrite (Task 8, Task 11), not implemented (out of skeleton scope by design). ADR 0003 (SQL-only detection) — `schema/rules/` carried in Task 4, call-outs in AGENTS.md/CONTEXT.md in Task 11, `DetectionEngine`/detectors explicitly excluded from the carry-over in Tasks 5-7. ADR 0004/0005/0006/0007 — referenced from docs but not implemented; this plan is scaffolding only, follow-on plans implement the pipelines these ADRs govern.
- **Placeholder scan:** every code/config block in this plan is complete, copy-pasteable content — no "TODO: implement" left as the entire content of a step. The *product* of several tasks is intentionally a stub function (e.g. `trace_store::open` returning `Err`), which is the explicitly agreed skeleton-only scope, not a plan-writing placeholder — each stub has a real signature, a doc comment pointing at the ADR that will replace it, and a test proving the stub's current behavior.
- **Type consistency:** `fastrace_blf` (Task 5) -> consumed by `fastrace_protocol` and `fastrace_signaldb` (Tasks 6-7) and `fastrace_parse` (Task 8) — names match across all CMakeLists. `trace-store`/`query`/`sidecar` crate names (Task 9) match the `path = "../../crates/..."` dependency names in `app/src-tauri/Cargo.toml` (Task 10).
- **Review Focus:** all five items have an owning task — archive-before-delete ordering (Tasks 1 and 3's Step 1 re-check), standalone-build verification (Task 7 Step 4's full build), `.gitignore` (Task 4 Step 4), root CMake pointing at `native/` (Task 4 Step 3), stale AGENTS.md commands (Task 11 Step 1 and Step 5's grep check).
