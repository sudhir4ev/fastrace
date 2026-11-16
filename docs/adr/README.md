# Architecture Decision Records

Decisions for the Tauri-based fastrace monorepo. Agreed while migrating from the Qt UI + C++ POC ingest; see `archive/qt-cpp-legacy` for the pre-migration state.

Background that the ADRs rely on:

- [`architecture.md`](architecture.md): BLF layout, ingest pipeline, Trace Store tables, data flow.
- [`benchmarks.md`](benchmarks.md): measured evidence behind the decisions.

| ADR | Title | Status |
|-----|-------|--------|
| [0001](0001-monorepo-layout-and-boundaries.md) | Monorepo layout and boundaries | Accepted |
| [0002](0002-cpp-sidecar-writes-trace-store.md) | C++ sidecar writes the Trace Store | Accepted |
| [0003](0003-anomaly-detection-is-duckdb-sql.md) | Anomaly detection is DuckDB SQL only | Accepted |
| [0004](0004-detectors-run-after-prepare.md) | Detectors run after Prepare completes | Accepted |
| [0005](0005-signal-decode-on-plot.md) | Signal decode on plot | Accepted |
| [0006](0006-trace-store-schema-no-payloads.md) | Trace Store schema without payloads | Accepted |
| [0007](0007-verification-and-fixtures.md) | Verification and fixtures | Accepted |

Each ADR lists context, decision, consequences, and the conditions that should trigger a revisit.

## Deferred / keep in view

These are deliberately out of the MVP. Each is referenced from the ADR it relates to.

| Item | Related ADR |
|------|-------------|
| Live detection during Prepare via sidecar-executed rule SQL (path A1) | 0004 |
| Separate signal cache file (`<stem>.signals.duckdb`) so queries are not blocked during decode | 0005 |
| Change-only storage for decoded signals | 0005 |
| Container index (file offset per container) for targeted decode of rare signals | 0005 |
| Switch ingest reader to the parallel `Analyzer` pipeline | 0002 |
| Ingestion orchestrator with materialization checks (e.g. Prefect) | 0007 |
| Realistic (non-synthetic) regression fixture | 0007 |
