# 0004. Detectors run after Prepare completes

- Status: Accepted
- Date: 2026-11-16

## Context

A future goal is to run detectors while parsing and ingest are still going, so users see results sooner.

DuckDB allows either one process that reads and writes, or many processes that read read-only, never both. Under 0002 the sidecar holds the write lock for the whole Prepare, so the Rust app cannot open the store until Prepare finishes.

## Decision

In the MVP, Detector Queries run only after Prepare completes successfully.

The planned route to live detection is **path A1**: the query layer hands rule SQL to the sidecar, which executes it on its own connection after each batch and streams results back. Detection logic stays in SQL (0003); C++ only executes it, like a database client.

No incremental-execution constraints are imposed on rules now.

## Alternatives recorded for the future

| Path | How | Cost |
|------|-----|------|
| A1 (preferred) | Sidecar executes rule SQL per batch | Keeps 0002's performance and 0003's rule |
| A2 | Sidecar writes per-batch segment files that Rust queries, then merges | File juggling; similar to the reverted staging approach |
| D | Rust owns the DuckDB connection; C++ streams Arrow batches over a pipe | Reverses 0002 |

## Consequences

- Simple MVP lifecycle: Prepare, then query.
- When live detection is built, windowed rules (rates, gaps) need care at batch edges: a moving `msg_id` watermark, or they can double-report or miss events.

## Revisit when

- Live detection moves into scope.

## Amendment (2026-11-18)

`fastrace_parse decode-signals` (0005, "Signal ingestion, second pass") is a second
sidecar operation that holds the same write lock Prepare does, for the same reason:
one process reads and writes, or many read read-only, never both. While a decode run
is in flight, the whole app - not just the Signals tab - is blocked from querying the
store, exactly like during Prepare. This was an accepted MVP tradeoff (0005 explicitly
defers the alternative, a separate `<stem>.signals.duckdb` cache file attached
read-only, until query blackouts during decode actually become a UX problem). AGENTS.md's
"Prepare is the only user-visible blackout" line is updated accordingly.
