# CLAUDE.md

This file provides guidance to Claude when working with code in this repository.

## Project Overview
* **What it is:** Desktop app to analyze automotive network traces (CAN and Ethernet) via SQL-based anomaly detection over a local Trace Store. Currently a skeleton mid-migration from a Qt/C++ proof of concept - see `docs/adr/` for the target architecture and `archive/qt-cpp-legacy` for the pre-migration code.
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
* **C++ (`native/`):** C++23. `PascalCase` classes/structs, `camelCase` variables/methods, `m_` prefix for private members, `k` prefix for constants. Smart pointers and RAII for memory management. No Qt - `native/` is plain CMake/C++, no UI knowledge (`docs/adr/0001`).
* **Rust (`crates/`, `app/src-tauri`):** Plain library crates in `crates/` hold logic and know nothing about Tauri; `app/src-tauri` is a thin `#[tauri::command]` adapter layer only (`docs/adr/0001` boundary rule 6).
* **Frontend (`app/ui`):** React + TypeScript + Vite.
* **Includes:** Group headers logically (local headers, third-party, standard library).
* **Organization:** Keep code modular with strong separation of responsibility across the `native/{blf,protocol,signaldb,store,cli}` and `crates/{trace-store,query,sidecar}` boundaries defined in `docs/adr/0001-monorepo-layout-and-boundaries.md`.

## Do
* **Always:** Give every module (`native/{blf,protocol,signaldb,store,cli}`, `crates/{trace-store,query,sidecar}`) its own test entry point (`ctest` target or `cargo test`), a `README.md` with the exact commands to build and run its tests, and verify it passes in isolation - a developer must be able to validate one module without building the rest of the monorepo.
* **Always:** Run `clang-format` on modified C++ files; `cargo fmt` on modified Rust files.
* **Always:** Update the relevant `CMakeLists.txt` or `Cargo.toml` when adding or removing source files.
* **Always:** Bump `schema_version` in `schema/schema.sql` when changing the Trace Store DDL, and update both the C++ embed step and the Rust open-time check in the same change (`docs/adr/0001` boundary rule 1).
* **Always:** Keep new anomaly-detection logic as SQL in `schema/rules/`, never as C++ or Rust conditionals (`docs/adr/0003`).

## Do Not Do
* **Never:** Add Tauri or UI knowledge to `native/` or `crates/trace-store`/`crates/query`/`crates/sidecar`.
* **Never:** Parse BLF or ARXML files in Rust - that is `native/`'s job exclusively (`docs/adr/0001` boundary rule 2).
* **Never:** Reintroduce a streaming/C++ detection engine - detection is SQL only (`docs/adr/0003`).
* **Avoid:** Using emoticons in source code and plaintext documentation, except where already established (like UI action icons).

## Important files and directories
* `docs/adr/`: Architecture Decision Records for the Tauri migration - read before touching package boundaries. Start with `0001-monorepo-layout-and-boundaries.md` and `architecture.md`.
* `schema/`: The only shared contract between `native/` and `crates/` - DDL (`schema.sql`) and Detector Query rule SQL (`rules/`).
* `native/`: C++23/CMake. No Tauri or Rust knowledge.
  * `native/blf/`: BLF reader (container inflate, split-object stitch), wire types, mapped I/O.
  * `native/protocol/`: Protocol peel (PDU, SOME/IP, SOME/IP-SD, DoIP).
  * `native/signaldb/`: ARXML parsing and on-demand signal decode.
  * `native/store/`: Embeds `schema/schema.sql`; will write the Trace Store via the DuckDB Appender.
  * `native/cli/`: `fastrace_parse` - the `prepare` and `decode-signals` subcommands, bundled as a Tauri sidecar.
* `crates/`: Rust workspace. No Tauri dependency, no BLF/ARXML parsing.
  * `crates/trace-store/`: Opens `<stem>.duckdb` read-only, checks `schema_version`.
  * `crates/query/`: Runs Detector Query SQL against an opened Trace Store.
  * `crates/sidecar/`: Spawns `fastrace_parse` and parses its progress/error protocol.
* `app/`: The Tauri shell.
  * `app/src-tauri/`: Thin `#[tauri::command]` adapters over `crates/*`. No business logic.
  * `app/ui/`: React + TypeScript frontend.
* `archive/qt-cpp-legacy` (git branch, not a directory): the pre-migration Qt/C++ implementation, kept for reference during the port. Not on `master`.
