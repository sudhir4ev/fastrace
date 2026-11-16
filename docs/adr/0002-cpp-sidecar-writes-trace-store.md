# 0002. C++ sidecar writes the Trace Store

- Status: Accepted (revisit if implementation finds blockers)
- Date: 2026-11-16
- Supersedes: the earlier plan in `CONTEXT.md` ("Rust owns Ingest; no C++-written DuckDB"; C++ writes a Parquet Parse Artifact)

## Context

Prepare turns a BLF (+ optional ARXML) into a Trace Store (`<stem>.duckdb`). Four ways to split the work were considered:

| Option | How |
|--------|-----|
| A | C++ sidecar parses, peels, and writes DuckDB directly via the Appender. Rust only reads. |
| B | C++ writes Parquet; Rust loads it into DuckDB. |
| C | C++ linked into Rust via FFI; Rust appends to DuckDB. |
| D | C++ streams Arrow IPC over a pipe; Rust appends. |

Measurements on the 1.46 GiB MFK5 benchmark (see [`benchmarks.md`](benchmarks.md)):

- CSV staging + DuckDB CLI `COPY`: 97.0 s.
- In-process libduckdb Appender (option A's write path): 66.0 s, identical rows and detections.
- Parquet staging without a native C++ Parquet writer was slower than CSV and was reverted.

## Decision

Option A. `fastrace_parse prepare` reads the BLF, peels protocols, materializes the ARXML dictionary, and writes the Trace Store through the DuckDB Appender in one pass. The Rust app opens the finished file for queries.

Ingest is therefore a library in `native/` (`native/store`), not a Rust crate.

## Consequences

- The boundary between C++ and Rust is a file plus a schema version: easy to test with golden fixtures.
- C++ (libduckdb) and Rust (duckdb-rs) must pin the same DuckDB version, or the storage format can mismatch. The pin belongs in one place and is checked at build or open time.
- A crash in parsing kills the sidecar, not the app. Prepare is fail-fast: a non-zero exit means the partial store is deleted.
- DuckDB allows one writer process at a time, so Rust cannot read the store while the sidecar writes. See 0004 and 0005.

## Known follow-up

Ingest still uses the single-threaded `BlfIngestReader`, which spends about 24 s inflating and decoding the benchmark file. The parallel `Analyzer` pipeline does the same work in about 1.0 s. Moving ingest to the parallel reader is the next performance step.

## Revisit when

- The DuckDB version pin between C++ and Rust becomes hard to maintain.
- Live detection during Prepare is required and path A1 (0004) is not workable; option D is the fallback.
- Bundling libduckdb with the sidecar fails on one of the target platforms (Linux, macOS, Windows).
