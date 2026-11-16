# 0001. Monorepo layout and boundaries

- Status: Accepted
- Date: 2026-11-16

## Context

The new product is a Tauri desktop app (Rust core + React/TypeScript UI) that analyzes automotive traces (BLF) with a C++ parser. We want packages organized by purpose, with strict boundaries so each part can be built and tested on its own.

A Tauri app is a web UI plus a Rust core (`src-tauri`). The usual structure is a Cargo workspace: plain library crates hold the logic and know nothing about Tauri, and the Tauri crate is a thin layer of `#[tauri::command]` adapters. Native executables are bundled as sidecars (`externalBin`).

## Decision

```
fastrace/
  docs/adr/          ADRs
  schema/            Trace Store contract: DDL, schema_version, detector SQL
  native/            C++ (CMake); no Tauri/Rust knowledge
    blf/             BLF reader (container inflate, split-object stitch)
    protocol/        protocol peel (PDU, SOME/IP, SOME/IP-SD, DoIP)
    signaldb/        ARXML parse + signal decode
    store/           DuckDB writer (Appender); embeds schema/
    cli/             fastrace_parse: `prepare`, `decode-signals`
  crates/            Rust workspace; no Tauri dependency
    trace-store/     open .duckdb, check schema_version, read-only access
    query/           run Detector Queries -> rows/columns
    sidecar/         spawn fastrace_parse, parse progress/errors
  app/               Tauri shell
    src-tauri/       thin #[tauri::command] adapters over crates/*
    ui/              React + TypeScript
```

Boundary rules:

1. `schema/` is the only shared contract between C++ and Rust. C++ embeds the DDL at build time. Rust refuses a store whose `meta.schema_version` does not match and asks the user to re-run Prepare.
2. `native/` never depends on Rust. `crates/` never parses BLF or ARXML files. They meet only through the `.duckdb` file and the CLI's progress/error protocol.
3. Ingest is not a Rust module. It is `native/store` plus `fastrace_parse prepare` (see 0002).
4. Query evaluation is its own crate (`crates/query`), tested without any C++ build (see 0007).
5. Detector SQL lives in `schema/`, next to the DDL, because rules break when the schema changes.
6. `app/src-tauri` holds no business logic; it adapts `crates/*` to Tauri commands and events.

## Consequences

- Each package has its own build and test entry point (CMake for `native/`, `cargo test` for `crates/`, the frontend toolchain for `app/ui`).
- Schema changes touch `schema/` and require a `schema_version` bump. Both sides pick up the change from one place.
- The sidecar's CLI contract (arguments, progress lines, exit codes) is a second interface and must be versioned with the app.

## Revisit when

- A boundary forces logic duplication between C++ and Rust (e.g. both need to parse ARXML).
- 0002 is reversed and Rust takes ownership of DuckDB writes.
