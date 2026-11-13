# DuckDB ingest tracker

Living log for the **external DuckDB CLI** ingest path (`fastrace_ingest` / `fastrace_query`).  
Update this file on each meaningful iteration: decisions, schema deltas, and measured results.

Related docs:

- How-to / commands: [`poc_blf_duckdb_ingest.md`](poc_blf_duckdb_ingest.md)
- Batch / Stage architecture: [`blf_batch_ingest_architecture.md`](blf_batch_ingest_architecture.md)
- Query-store target: [`query_store_architecture.md`](query_store_architecture.md)

---

## How to update (future iterations)

1. Add a row to **Iteration log** (date, goal, outcome).
2. If a decision changed, append to **Decisions** (do not rewrite history — mark superseded).
3. Paste a new **Results** subsection with wall time breakdown + DB size + row counts.
4. Note open follow-ups under **Backlog**.

Keep numbers comparable: same BLF/ARXML when possible, or call out when the input changed.

---

## Locked decisions (current)

| ID | Topic | Choice | Notes |
|----|-------|--------|-------|
| D1 | DuckDB linkage | **External `duckdb` CLI only** | No `libduckdb` / FetchContent. Resolve via `--duckdb`, `FASTRACE_DUCKDB`, or PATH. |
| D2 | C++ ↔ DuckDB handoff | CSV under `.tmp/fastrace_stage/` → `COPY` | Simple; known bottleneck (see backlog). |
| D3 | Store model | **Option B** | `messages` + `protocol_*` + `arxml_*` + `meta`. |
| D4 | Payloads | **Not stored** | BLF remains source of truth. `messages.payload_len` only (no `payload_hex`). |
| D5 | Signals | **Not stored at ingest** | Decode on demand later (C++ / optional whitelist). Not required for current protocol/CAN anomaly SQL. |
| D6 | Anomaly SQL | **On-demand** | Do not auto-install at ingest. Manual: `.read cpp/sql/anomaly_detectors.sql` (+ optional `signal_anomaly_detectors.sql` for CAN). |
| D7 | ARXML at ingest | Optional `--arxml` → `arxml_*` only | Dictionary for unknown-PDU / unknown-CAN SQL; not full signal layout tables. |
| D8 | Peel | One-pass with BLF read | `ProtocolParser` during ingest; enables SQL anomalies without re-touching BLF. |
| D9 | Existing DB | Always overwrite `--out` | |
| D10 | Schema version | `meta.schema_version = 3` | v3 = Option B (no hex, no signals). |

### Superseded

| Was | Now | Why |
|-----|-----|-----|
| Embed DuckDB via FetchContent | D1 external CLI | Avoid ~1h DuckDB compile; treat duckdb as a tool binary. |
| Store `payload_hex` + full `signals` | D4 / D5 | 8.8 GB BLF → 43+ GB partial DB; signals ~32× message rows. |
| Auto-install anomaly views at ingest | D6 | Detections are query-time views; install when analyzing. |
| Post-pass `fastrace_enrich` | Ingest-time `--arxml` for `arxml_*` only | Enrich tool removed; signals not materialized. |

---

## Architecture notes

```text
BLF ──► BlfIngestReader ──► TraceMessage
              │
              ├─► ProtocolParser ──► protocol_* CSV ──► duckdb COPY
              ├─► messages CSV (metadata + payload_len) ──► duckdb COPY
              └─► (optional) ArxmlParser ──► arxml_* CSV ──► duckdb COPY

Anomaly (later): duckdb -c ".read cpp/sql/anomaly_detectors.sql"
Signal charts (later): BLF+ARXML decode, or future whitelisted signals table
```

| Table | Role |
|-------|------|
| `messages` | Timeline index (1 row / frame) |
| `protocol_*` | Peeled on-wire headers for SQL detectors |
| `arxml_*` | Signal-DB dictionary (known PDU/CAN/ECU) |
| `meta` | Provenance + timing keys |

**Binaries:** `fastrace_ingest`, `fastrace_query` (thin wrapper), library pieces `BlfIngestReader`, `DuckDbCli`.  
**SQL:** [`cpp/sql/schema.sql`](../sql/schema.sql), [`anomaly_detectors.sql`](../sql/anomaly_detectors.sql), [`signal_anomaly_detectors.sql`](../sql/signal_anomaly_detectors.sql) (CAN rule only; no `signals`-dependent views).

**Why Option B:** SQL anomaly rules must not re-read the BLF. Cost of keeping `protocol_*` on this trace ≈ a few GB; full signals would be tens of GB and dominate ingest wall time.

---

## Results

### Baseline input (reuse unless noted)

| Artifact | Path / id |
|----------|-----------|
| BLF | `.source/in/AU513458561_…_DataRS2ETHF__HCP2.BLF` (~8.8 GB / ~9031 MiB) |
| ARXML | `.source/in/E3_1_2_Premium_MFK_5_V12.10.04.00F_20240904_E2E_patched.arxml` |
| duckdb CLI | `.tmp/bin/duckdb` (v1.1.x portable) or system |
| Build | `build/cpp-cli/fastrace_ingest` |

### Iteration 0 — Option B storage cut (2026-11-13)

**Goal:** Drop `payload_hex` + `signals`; keep protocol/arxml for SQL detections; stop auto-installing anomaly views.

**Command:**

```bash
fastrace_ingest \
  --blf <HCP2.BLF> --arxml <E3….arxml> \
  --out .tmp/trace.duck.db --duckdb .tmp/bin/duckdb \
  --batch-rows 100000 --yes
```

**Outcome:** Success. DB **5.7 GB** (vs aborted prior path **43+ GB** with hex+signals).

| Metric | Value |
|--------|-------|
| Wall (end-to-end) | **1,349.5 s (~22.5 min)** |
| Messages | 101,100,963 |
| Protocol rows (all types) | 456,789,226 |
| `protocol_pdu` | 356,409,797 |
| `protocol_someip` | 97,745,134 |
| `protocol_someip_sd` | 2,622,992 |
| `protocol_doip` | 11,303 |
| `arxml_pdu` / `arxml_can` | 510 / 29 |
| Rate | ~75k msg/s |
| `signals` table | none |
| Anomaly views at ingest | not installed |

**Timing breakdown**

| Phase | ms | % wall |
|-------|-----|--------|
| open + DDL | 120 | ~0% |
| ARXML materialize | 359 | ~0% |
| BLF inflate+decode | 153,366 | 11.4% |
| protocol peel | 20,333 | 1.5% |
| CSV write | 199,036 | 14.7% |
| duckdb COPY | **887,474** | **65.8%** |
| ingest wall | 1,348,079 | 99.9% |

**On-demand detections** (after `.read` of both anomaly SQL files):

| detector_name | severity | message | n |
|---------------|----------|---------|---|
| PduDetector | Warning | Unknown PDU ID | 240,462,602 |
| SomeIpSdDetector | Warning | Unexpected SD flags | 197,450 |
| CanDetector | Warning | Unknown CAN ID | 124,059 |
| PduDetector | Error | Zero length PDU | 10,261 |
| DoipDetector | Error | Invalid DoIP Protocol Version | 9,549 |
| PduDetector | Warning | High frequency PDU detected | 585 |

**Prior failed path (context only):** same BLF with `payload_hex` + full `signals` → partial DB ~43 GB at ~57M messages / ~1.8B signal rows; avg ~32 signals/msg; estimated full signals ~3.2B rows / tens of GB. Not a successful complete run.

---

## Backlog (perf → target 10–15 min wall)

Target: cut ~22.5 min → **10–15 min** on the same BLF. Bottleneck is **COPY + process churn**, not peel.

| Priority | Idea | Expected impact |
|----------|------|-----------------|
| P0 | One duckdb invocation per batch (all `COPY`s in one SQL) | Cut ~4–5k process opens → large fraction of 887 s |
| P0 | Larger `--batch-rows` (500k–1M) with batched COPY | Fewer flushes |
| P1 | Long-lived duckdb session (stdin) for whole ingest | Single DB open |
| P1 | Parquet staging instead of CSV | Faster load than text parse |
| P2 | Pipeline peel ∥ COPY | Overlap CPU vs I/O |
| P2 | `SET threads=N` once per session | Help large COPY |
| Later | Optional signal whitelist (4–5 names) | Charts without full signals tax; measure separately |

### Signal storage (deferred)

- Not required for current anomaly SQL.
- Full `signals` ≈ 3.2B rows / ~30–80 GB / multi-hour ingest risk.
- Whitelist of 4–5: often modest if decode is whitelist-only; worst case ~0.5B rows if all 5 on every message.

---

## Iteration log

| Date | Iteration | Goal | Result |
|------|-----------|------|--------|
| 2026-11-13 | 0 | Option B schema + full re-ingest | 5.7 GB DB, ~22.5 min wall; COPY 66% |
| _next_ | 1 | Reduce wall to 10–15 min | _TBD_ |
