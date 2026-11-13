# Fastrace

Desktop analysis of automotive network traces (CAN / Ethernet), with query-based anomaly detection over a local analytical store.

## Language

**Trace**:
A source capture file (e.g. BLF) used as input to Parse. After Ingest, anomaly detection uses the Trace Store, not the Trace file.
_Avoid_: Log (ambiguous), recording; implying Detect must re-open the BLF

**Trace Store**:
The local DuckDB file beside a Trace holding everything required for anomaly detection and Detector Query iteration after Ingest — no further BLF reads for that purpose. Owned and written by the Shell (Rust).
_Avoid_: Database (alone), cache, index; C++-written DuckDB; “must keep BLF open for detect”

**Parse**:
C++ Sidecar extraction of Trace content into structured records (including protocol peel C++ already performs) for the Shell. Rust does not parse.
_Avoid_: Ingest; any Rust-side BLF/protocol decoding

**Ingest**:
Loading already-parsed records (and optional Signal Database defs) into the Trace Store (DuckDB) only — no BLF/protocol interpretation. Shell / Rust domain. After Ingest succeeds, Detector Queries must not need the BLF or ARXML files.
_Avoid_: Parse; “Rust parsing”

**Parse Artifact**:
Columnar on-disk handoff from Parse (Parquet / Arrow IPC for v1), typically `<trace_stem>.parse.parquet` beside the Trace. Kept until the user manually deletes it via the Shell (not auto-deleted on successful Ingest). Streaming handoff is a later option.
_Avoid_: Trace Store (the artifact is staging, not the analytical DB); silent auto-delete in v1

**Detection**:
A product-shaped anomaly finding (time, severity, query id, message, message index, …). Not required as the v1 SQL result schema — v1 shows raw query result columns; proper Detection rendering comes later.
_Avoid_: Assuming every SQL result is already a Detection row in v1

**Detector Query**:
A raw SQL unit the user composes/edits against the Trace Store. v1 displays the result set as returned (columns/rows), without forcing a Detection DTO.
_Avoid_: Detector (C++ class); visual rule builder; mandatory Detection-shaped SELECT in v1

**Signal Database**:
An AUTOSAR ARXML (or later DBC) description of the vehicle network — PDUs, signals, ECUs — used to interpret IDs/addresses. Optional input; when present, relevant tables are materialised into the Trace Store so Detector Queries can join without re-reading the file.
_Avoid_: “the database” alone (ambiguous with Trace Store); payload

**Pipeline Run**:
One manual execution. v1 stages: (1) Prepare Trace Store, (2) raw Detector SQL composition, (3) Run Detector Query → raw result grid. Progress/errors surface in the Shell UI/logs in v1 (DuckDB `pipeline_*` tables deferred). No click-to-message navigate in v1.
_Avoid_: Job, task, automatic background run; assuming Detection-shaped results or peek navigation in v1

**Prepare Trace Store**:
The single user action that runs Sidecar Parse (→ Parse Artifact) then Rust Ingest into the Trace Store, optionally materialising Signal Database tables when an ARXML is provided. v1 always re-runs when clicked (no fingerprint skip yet). Fail-fast: on error, no successful half-written Trace Store.
_Avoid_: Separate required “Parse” and “Ingest” clicks in v1 (advanced split later); silent reuse of stale stores in v1

**Sidecar**:
The local C++ CLI `fastrace_parse` that parses raw Trace bytes into a Parse Artifact. It does not write the Trace Store and does not run Detector Queries.
_Avoid_: Ingest engine, DuckDB owner, “backend that does everything”; overloading `cpp_parser` as the long-term product name

**Shell**:
The Tauri app under `/app` (React + TypeScript) — sole product UI; owns Ingest into DuckDB, Detector Query execution, and rendering. Qt `/ui` is removed in the same cut as streaming DetectionEngine / C++ detectors.
_Avoid_: fastrace_ui / Qt UI as product surface; dual anomaly paths
