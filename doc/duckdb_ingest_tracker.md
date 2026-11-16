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

### Iteration 1a — MFK5 Option B baseline (2026-11-14)

**Goal:** Pre-opt baseline on ~300 MB iter trace. No code changes.

**Input:** `MFK5_VAP_X50_drive_074.blf` (300 MiB) + same E3 ARXML; `--batch-rows 100000`; out `.tmp/mfk5_baseline.duck.db`.

**Outcome:** Success. DB **233 MB**. Wall **~37.8 s**. COPY dominant (~56%).

| Metric | Value |
|--------|-------|
| Wall (end-to-end) | **37,771.6 ms (~37.8 s)** |
| Messages / protocol rows | 4,002,854 / 14,962,953 |
| Flushes | 41 |
| Rate | ~108k msg/s |

**Timing breakdown**

| Phase | ms | % wall |
|-------|-----|--------|
| open + DDL | 135 | 0.4% |
| ARXML materialize | 371 | 1.0% |
| BLF inflate+decode | 4,822 | 12.8% |
| protocol peel | 609 | 1.6% |
| CSV write | 7,339 | 19.4% |
| duckdb COPY | **21,088** | **55.8%** |
| ingest wall | 36,940 | 97.8% |

### Iteration 1b — Batched multi-COPY per duckdb invoke (2026-11-16)

**Goal:** One `duckdb` process per batch (all table `COPY`s in one SQL script); same `--batch-rows 100000`.

**Change:** `ingest_main.cpp` — batch flush + arxml materialize call `cli.run` once with concatenated COPY SQL.

**Input:** same MFK5 + ARXML (paths under `/Volumes/data/wk/downloads/logs/`); out `.tmp/mfk5_1b.duck.db`.

**Outcome:** Success. Row counts match 1a. Wall **~28.9 s** (−23% vs 1a). COPY **12.6 s** (−40% vs 1a).

| Metric | 1a | 1b | Δ |
|--------|----|----|---|
| Wall | 37.8 s | **28.9 s** | −23% |
| duckdb COPY | 21.1 s (56%) | **12.6 s (44%)** | −40% |
| CSV write | 7.3 s | 7.2 s | ~flat |
| Rate | ~108k msg/s | ~142k msg/s | |
| DB size | 233 MB | 234 MB | |
| Messages / protocol | 4,002,854 / 14,962,953 | same | OK |

**Timing breakdown (1b)**

| Phase | ms | % wall |
|-------|-----|--------|
| open + DDL | 111 | 0.4% |
| ARXML materialize | 285 | 1.0% |
| BLF inflate+decode | 4,712 | 16.3% |
| protocol peel | 634 | 2.2% |
| CSV write | 7,196 | 24.9% |
| duckdb COPY | **12,613** | **43.6%** |
| ingest wall | 28,191 | 97.5% |

---

## Backlog (perf → target 10–15 min wall)

Target: cut ~22.5 min → **10–15 min** on the same BLF. Bottleneck is **COPY + process churn**, not peel.

| Priority | Idea | Expected impact |
|----------|------|-----------------|
| P0 | ~~One duckdb invocation per batch (all `COPY`s in one SQL)~~ | **Done (1b)** — MFK5 COPY −40% |
| P0 | Larger `--batch-rows` (500k–1M) with batched COPY | Fewer flushes — **next (1b′)** |
| P1 | Long-lived duckdb session (stdin, per-batch chunks) | Single DB open — only if 1b′ still leaves churn |
| P1 | Parquet staging instead of CSV | Faster load than text parse |
| P2 | Pipeline peel ∥ COPY | Out of this phase |
| P2 | `SET threads=N` once per session | Out of this phase |
| Later | Optional signal whitelist (4–5 names) | Charts without full signals tax; measure separately |

### Signal storage (deferred)

- Not required for current anomaly SQL.
- Full `signals` ≈ 3.2B rows / ~30–80 GB / multi-hour ingest risk.
- Whitelist of 4–5: often modest if decode is whitelist-only; worst case ~0.5B rows if all 5 on every message.

---

## Iteration log

| Date | Iteration | Goal | Result |
|------|-----------|------|--------|
| 2026-11-13 | 0 | Option B schema + full re-ingest (HCP2) | 5.7 GB DB, ~22.5 min wall; COPY 66% |
| 2026-11-14 | 1a | MFK5 Option B baseline (no opts) | 233 MB, ~37.8 s; COPY 56% |
| 2026-11-16 | 1b | Batched multi-COPY @ 100k (MFK5) | 234 MB, ~28.9 s (−23%); COPY −40% |
| _next_ | 1b′ | MFK5 batch-rows 500k / 1M; set default | _TBD_ |
| _next_ | 1c? | Long-lived stdin session (if needed) | _TBD_ |
| _next_ | 1d | Parquet-only staging | _TBD_ |
| _next_ | HCP2 | Final bench (when called) | _TBD_ |
