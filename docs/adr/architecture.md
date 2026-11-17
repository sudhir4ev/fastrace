# Architecture notes

Background for the ADRs. Describes what the system processes and how data moves through it.

## Product vocabulary

| Term | Meaning |
|------|---------|
| Trace | Source capture file (BLF). Read only by the C++ sidecar. |
| Signal Database | ARXML describing PDUs, CAN messages, signals, ECUs. Optional input to Prepare. |
| Prepare | One user action: sidecar parses the Trace (+ ARXML) and writes the Trace Store. Fail-fast. |
| Trace Store | `<stem>.duckdb` beside the Trace. Holds everything Detector Queries need. |
| Detector Query | User-editable SQL run against the Trace Store. Results shown as returned columns/rows. |
| Peel | Extracting protocol header fields into columns so SQL never parses bytes. |
| Sidecar | `fastrace_parse`, the bundled C++ executable. |

## BLF file structure

A BLF is a sequential stream of sized records, not a random-access table:

```
[ LOGG file header ] [ LOBJ ] [ LOBJ ] ... [ LOBJ ]
```

- The `LOGG` header holds sizes, object count, and measurement start/end times. After `headerSize` bytes the first object starts.
- Each `LOBJ` starts with a base header: signature, header size/version, `objectSize` (stride to the next object), `objectType`.
- Most traffic lives in `LOG_CONTAINER` (type 10) objects. Their payload is zlib-compressed. After inflate it is a second sequential stream of inner LOBJs: CAN, CAN FD, Ethernet frames, and others.
- There is no seek to "message N" without inflating earlier containers.
- An inner LOBJ can be split across two containers (tail at the end of container i, head at the start of i+1). The reader must stitch fragments before decoding. About 32k splits occur across 56k containers in the MFK5 benchmark.
- Top-level objects are padded: the next `LOBJ` signature can sit up to 3 bytes after `objectSize`, so readers scan for it.
- Two BLFs can be merged losslessly by keeping one `LOGG` header (with summed counts and sizes and the last end time) and concatenating each file's object stream unchanged.

## Prepare pipeline

```
BLF --> inflate container --> decode + stitch inner LOBJs --> TraceMessage
                                                   |
                                                   +--> messages rows
                                                   +--> protocol peel --> protocol_* rows
ARXML --> dictionary --> arxml_* rows
all rows --> DuckDB Appender --> <stem>.duckdb   (meta written last)
```

Rules that keep this correct and fast:

- Read unit is one container; write batching is independent of it.
- Headers and protocol fields come from the same inflate; never two passes for metadata and bytes.
- Peel runs in `msg_id` order so stateful TCP reassembly (DoIP) stays correct.
- Ethernet PDU IDs come from inside the UDP payload (`[id:4][len:4][bytes]...`), so peeling reads payload bytes even though they are not stored.

## Signal decode pass

```
user plots signal --> Rust closes store --> fastrace_parse decode-signals (BLF + ARXML)
    --> rows into signals --> Rust reopens store --> SQL for the plot
```

Signal presence before decoding comes from joining `arxml_signal` to message and PDU IDs in the store: a signal is decodable if its carrier message occurs. See ADR 0005.

## Component boundaries

Each module's own `README.md` documents the exact command to test it in isolation
(the "Always" rule in `AGENTS.md`'s `## Do` section) - this table is the index,
not the detail:

| Module | Responsibility | Depends on | Must never depend on | Test entry point |
|--------|---------------|-----------|----------------------|-------------------|
| `native/blf` | BLF container inflate, split-object stitch, `TraceMessage` decode | libdeflate, spdlog | Rust, Tauri, DuckDB | (no dedicated test target yet) |
| `native/protocol` | Protocol peel: PDU/SOME-IP/SOME-IP-SD/DoIP | `native/blf` | Rust, Tauri, DuckDB | (no dedicated test target yet) |
| `native/signaldb` | ARXML parse, on-demand signal decode | pugixml, spdlog | Rust, Tauri, DuckDB | (no dedicated test target yet) |
| `native/store` | DuckDB schema embed, Appender writer, ARXML/protocol row mapping | `native/blf`, `native/protocol`, `native/signaldb`, prebuilt libduckdb | Rust, Tauri | `ctest --test-dir build -R 'fastrace_store\|fastrace_fixture'` (`native/store/README.md`) |
| `native/cli` | `fastrace_parse prepare`/`decode-signals` entrypoint, progress protocol | all of the above | Rust, Tauri | `ctest --test-dir build -R fastrace_store_fixture_prepare` |
| `crates/trace-store` | Opens `.duckdb` read-only, checks `schema_version` (stub until the Rust-side DuckDB wave) | - | BLF/ARXML parsing, Tauri | `cargo test -p trace-store` |
| `crates/query` | Runs Detector Query SQL (stub until that wave) | `trace-store` | BLF/ARXML parsing, Tauri | `cargo test -p query` |
| `crates/sidecar` | Spawns `fastrace_parse`, parses its progress/error protocol | `serde_json` only | BLF/ARXML parsing, DuckDB, Tauri | `cargo test --manifest-path crates/sidecar/Cargo.toml` (`crates/sidecar/README.md`) |
| `app/src-tauri` | Thin `#[tauri::command]` adapters over `crates/*` | `crates/*`, `tauri` | business logic, BLF/ARXML/DuckDB directly | `cargo build --manifest-path app/src-tauri/Cargo.toml` (manual `cargo tauri dev`; no automated test yet) |
| `app/ui` | React/TS frontend | `app/src-tauri` (IPC) | - | (no dedicated test target yet) |

```
app/ui (React) <--> app/src-tauri (commands) <--> crates/{trace-store, query, sidecar}
                                                          |
                                         spawns           v  reads (after write finishes)
                                 native/cli fastrace_parse ---writes---> <stem>.duckdb
                                                                          ^
                                                          schema/ (DDL, version, rules) shared by both
```

## Carried over from the current repo

Useful as reference when porting: `cpp/include/BlfTypes.h` (wire structs), `Analyzer` (parallel inflate pipeline), `BlfIngestReader` (sequential ingest reader), `ProtocolParser` (peel), `ArxmlParser` and `SignalDecoder`, `cpp/sql/schema.sql` and detector SQL. Not carried over: Qt UI, `DetectionEngine`, C++ detectors, CSV staging.
