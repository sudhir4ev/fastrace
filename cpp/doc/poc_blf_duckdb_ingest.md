# POC: BLF → DuckDB ingest (C++)

Throwaway timing / pipeline POC. **Not** the product Trace Store ownership model in [`CONTEXT.md`](../../CONTEXT.md) (product: C++ Parse Artifact → Rust Ingest). This path uses the **external `duckdb` CLI** plus CSV staging so C++ never links `libduckdb`.

**Decisions, architecture, and measured results:** [`duckdb_ingest_tracker.md`](duckdb_ingest_tracker.md) (update that file each iteration).

Also: [`blf_batch_ingest_architecture.md`](blf_batch_ingest_architecture.md), [`query_store_architecture.md`](query_store_architecture.md).

## Current model (Option B)

| Topic | Choice |
|-------|--------|
| DuckDB | External CLI (`PATH` / `--duckdb` / `FASTRACE_DUCKDB`) |
| Handoff | CSV batches → `COPY` |
| Store | `messages` (no payload bytes) + `protocol_*` + optional `arxml_*` |
| Signals / payload hex | Not stored |
| Anomaly SQL | On-demand `.read` — not installed by ingest |
| Binaries | `fastrace_ingest`, `fastrace_query` |
| Schema | [`cpp/sql/schema.sql`](../sql/schema.sql) |

## Prerequisite

DuckDB CLI available (`duckdb --version`), or pass `--duckdb /path/to/duckdb`.

## Ingest

```bash
fastrace_ingest \
  --blf trace.blf \
  --arxml vehicle.arxml \
  --out trace.duckdb \
  [--batch-rows 100000] [--duckdb /path/to/duckdb] [--yes]

# Skip protocol peel (messages + meta only):
fastrace_ingest --blf trace.blf --out trace.duckdb --messages-only [--yes]
```

## Query / anomalies

```bash
./build/cpp-cli/fastrace_query --db trace.duckdb
# or:
duckdb trace.duckdb

SELECT count(*) FROM messages;
SELECT count(*) FROM protocol_pdu;

# Install detectors when needed:
duckdb trace.duckdb -c ".read cpp/sql/anomaly_detectors.sql"
duckdb trace.duckdb -c ".read cpp/sql/signal_anomaly_detectors.sql"  # adds CAN unknown-id

SELECT detector_name, severity, message, count(*) AS n
FROM detections GROUP BY ALL ORDER BY n DESC;
```
