# Fastrace

Desktop analysis of automotive network traces (CAN / Ethernet), with query-based anomaly detection over a local analytical store.

Canonical decisions live in `docs/adr/`. This file is product vocabulary only; if it ever disagrees with an ADR, the ADR wins - fix this file.

## Language

**Trace**:
A source capture file (BLF). Read only by the C++ sidecar (`native/`), only during Prepare or on-demand signal decode.
_Avoid_: Log (ambiguous), recording.

**Trace Store**:
`<stem>.duckdb` beside the Trace. Holds everything Detector Queries need after Prepare. Written by the C++ sidecar via the DuckDB Appender (`docs/adr/0002`); the Rust app only opens it read-only.
_Avoid_: Rust-written DuckDB; a separate Parse Artifact file (superseded, see `docs/adr/0002`).

**Prepare**:
The one user action: the C++ sidecar (`fastrace_parse prepare`) reads the Trace (+ optional ARXML), peels protocol fields, and writes the Trace Store directly - no intermediate Parquet/Arrow handoff file. Fail-fast: a non-zero exit deletes the partial store.
_Avoid_: Separate "Parse" and "Ingest" steps or a "Parse Artifact" (both were the pre-ADR-0002 plan; the sidecar now writes DuckDB in one pass).

**Detector Query**:
User-editable SQL run against the Trace Store by `crates/query`. Results are raw returned columns/rows. All anomaly-detection logic is SQL, never C++ or Rust (`docs/adr/0003`).
_Avoid_: Detector (C++ class); a streaming detection engine.

**Signal Database**:
An AUTOSAR ARXML (or later DBC) description of the vehicle network - PDUs, signals, ECUs - used to interpret IDs/addresses. Optional Prepare input; its dictionary is materialized into `arxml_*` tables. Actual signal values are decoded on demand when the user plots a signal, not at Prepare time (`docs/adr/0005`).
_Avoid_: "the database" alone (ambiguous with Trace Store); assuming all signals are decoded at Prepare.

**Sidecar**:
`fastrace_parse`, the bundled C++ executable (`native/cli`). Runs `prepare` and `decode-signals`. Writes the Trace Store directly; does not run Detector Queries.
_Avoid_: Ingest engine as a separate Rust concept; overloading `cpp_parser` as the product name (retired with the Qt UI).

**Shell**:
The Tauri app under `app/` (Rust `src-tauri` + React/TypeScript `ui`) - sole product UI. Owns Detector Query execution via `crates/query` and spawns the sidecar via `crates/sidecar`. Qt `/ui` and the streaming `DetectionEngine`/C++ detectors are retired (`archive/qt-cpp-legacy`).
_Avoid_: fastrace_ui / Qt UI as product surface; dual anomaly paths.
