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
User-editable SQL run against the Trace Store by `crates/query`. Results are raw returned columns/rows. All anomaly-detection logic is SQL, never C++ or Rust (`docs/adr/0003`). Authored and run from the Analyzer. Must return `msg_id` and `timestamp_us` columns (exact names, no aliasing inferred) so its rows can plot as Matches. Currently ephemeral - one Detector Query at a time, not persisted past a trace switch; saving/naming a Detector Query to re-run later is a later phase, not yet built.
_Avoid_: Detector (C++ class); a streaming detection engine; "analyzer query" (same thing, non-canonical name).

**Analyzer**:
The workbench (right-rail panel) where a Detector Query is edited and run. A testbench for tailoring anomaly-detector SQL per anomaly, not a general-purpose SQL console.
_Avoid_: "Analyzer script" (earlier placeholder wording, superseded now that it's a Detector Query testbench, not a scripting surface).

**Match**:
One Detector Query result row, plotted as a point on the Timeline. Exists only after a Detector Query has been run; clicking one selects its `msg_id`, same as selecting a row in the Message List.
_Avoid_: "result" alone (ambiguous with the whole result set vs one row); "detection" (that's the C++-era streaming-engine term retired by `docs/adr/0003`).

**Signal Database**:
An AUTOSAR ARXML (or later DBC) description of the vehicle network - PDUs, signals, ECUs - used to interpret IDs/addresses. Optional Prepare input; its dictionary is materialized into `arxml_*` tables. Actual signal values are decoded on demand when the user plots a signal, not at Prepare time (`docs/adr/0005`).
_Avoid_: "the database" alone (ambiguous with Trace Store); assuming all signals are decoded at Prepare.

**Sidecar**:
`fastrace_parse`, the bundled C++ executable (`native/cli`). Runs `prepare` and `decode-signals`. Writes the Trace Store directly; does not run Detector Queries.
_Avoid_: Ingest engine as a separate Rust concept; overloading `cpp_parser` as the product name (retired with the Qt UI).

**Shell**:
The Tauri app under `app/` (Rust `src-tauri` + React/TypeScript `ui`) - sole product UI. Owns Detector Query execution via `crates/query` and spawns the sidecar via `crates/sidecar`. Qt `/ui` and the streaming `DetectionEngine`/C++ detectors are retired (`archive/qt-cpp-legacy`).
_Avoid_: fastrace_ui / Qt UI as product surface; dual anomaly paths.

**Signal Catalog**:
The per-Trace list of every signal the Signal Database declares, each annotated with whether it's decodable, whether it's already decoded (cached), and its `signal_stats` (samples/nonzero/changes) so the user can tell a genuinely varying signal from a constant or an unobserved one.
_Avoid_: "signal list" alone (ambiguous with the decoded-samples list for one signal).

**Read Payloads**:
The user action (Signals tab) that decodes the checked, not-yet-cached signals from the Signal Catalog and writes their samples into the Trace Store. Formerly called "Apply changes"; the product-facing wording is "read"/"reading", not "decode" (that word stays internal - mutation/hook/component names are unaffected). Scoped to the current Trim Window - narrowing or widening the window re-decodes affected signals' samples for the new range.
_Avoid_: "Apply changes" in anything user-facing (retired); "decode" in UI copy.

**Trim Window**:
The `[start, end]` timestamp bound the user sets via the header slider (next to the trace file name), scoping every query against the open Trace - Message List, Detector Query, Signal Catalog samples, Timeline - to that range for the rest of the session. Adjustable at any time via the slider + Apply button; defaults to the full Trace span on open. Non-destructive: never mutates the Trace Store file, only what queries return.
_Avoid_: confusing with the Timeline's client-side pan/zoom (`timelineZoomRange`) - that only changes what's visible in the chart viewport, not what's queried; "trim" as deleting rows from the Trace Store (it doesn't).

**Active Signal**:
A Signal Catalog entry that is cached - its samples already exist in the Trace Store because Read Payloads has run for it. Every Active Signal shows as a pill above the Timeline, one-to-one with the catalog's cached signals (not a frozen snapshot - if a signal stops being cached, its pill disappears).
_Avoid_: confusing with Displayed Signal (below) - being Active only means "available to plot", not "currently plotted".

**Displayed Signal**:
An Active Signal whose pill has been clicked on, so its track currently renders in the Timeline. A strict subset of the Active Signals; toggled per pill, independent of decoding.
_Avoid_: assuming every Active Signal is shown - only the first Active Signal auto-displays, and only when nothing else is displayed yet.
