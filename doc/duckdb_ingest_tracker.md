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

### Iteration 1b′ — Larger `--batch-rows` on MFK5 (2026-11-16)

**Goal:** Measure 500k and 1M flush sizes on top of 1b; set CLI default to winner.

**Outcome:** Both beat 100k. **1M wins** (marginal over 500k). Default `--batch-rows` → **1,000,000**.

| Config | Flushes | Wall | COPY | CSV | Rate | DB |
|--------|---------|------|------|-----|------|-----|
| 1b @ 100k | 41 | 28.9 s | 12.6 s (44%) | 7.2 s | ~142k/s | 234 MB |
| **1b′ @ 500k** | 9 | **21.5 s** | 5.3 s (25%) | 7.1 s | ~192k/s | 211 MB |
| **1b′ @ 1M** | 5 | **20.4 s** | 3.9 s (19%) | 7.2 s | ~202k/s | 210 MB |

vs 1a (37.8 s): 1M is **−46% wall**. COPY no longer dominant; **CSV write ~35%** is the new largest share → Parquet (1d) is the next leverage. Long-lived session (1c) has less headroom on MFK5 (only 5 process opens left).

Row counts unchanged (4,002,854 / 14,962,953). Artifacts: `.tmp/mfk5_1b_500k.duck.db`, `.tmp/mfk5_1b_1m.duck.db`.

### Iteration 1d — Parquet / binary staging attempt (2026-11-16) — **reverted**

**Goal:** Replace CSV staging with Parquet (or binary) to cut the ~7 s CSV write + text parse.

**Constraint:** No C++ Parquet/Arrow writer in-tree; Homebrew Arrow is a large dep (llvm/grpc/…). Kept external `duckdb` CLI only (D1).

**Attempt A — SQLite stage → duckdb `COPY TO` Parquet → `COPY FROM` Parquet**

| Phase | ms |
|-------|-----|
| SQLite stage write | 8,303 |
| duckdb Parquet load | 9,300 |
| **Wall** | **26.9 s** |

**Attempt B — SQLite stage → duckdb `ATTACH` + `INSERT SELECT`** (Parquet emit only with `--keep-stage`)

| Phase | ms |
|-------|-----|
| SQLite stage write | 8,608 |
| duckdb ATTACH/INSERT | 8,685 |
| **Wall** | **26.5 s** |

Row counts matched 1b′. Both **regress vs 1b′ @ 1M (20.4 s)**: SQLite write ≥ CSV write, and ATTACH/INSERT ≫ CSV `COPY`.

**Decision:** Revert staging to CSV (1b′ path remains). True Parquet-from-C++ needs a dedicated writer (Arrow / header-only Parquet lib) before retrying 1d. Optional Parquet emit via duckdb alone does not beat CSV on MFK5.

Artifact (forensics): `.tmp/mfk5_1d.duck.db` from attempt B.

### Iteration 1e — In-process prebuilt libduckdb + Appender (2026-11-16) — experimental

**Goal:** Perf test only. Remove the CSV handoff and the CLI process entirely by linking prebuilt `libduckdb` (v1.1.3, same as CLI; no compile) and streaming rows through the DuckDB C Appender as the BLF is read. Reopens D1 for measurement only; not a new project baseline (UI moving to Tauri; Rust pipeline under consideration).

**Change:** New experimental binary `fastrace_ingest_lib` (`cpp/src/ingest_lib_main.cpp`), built only when `-DFASTRACE_LIBDUCKDB_DIR=<dir with duckdb.h + libduckdb>` is set. Existing `fastrace_ingest` (CSV/CLI) untouched. Library fetched to `.tmp/libduckdb/` from the DuckDB v1.1.3 release (`libduckdb-osx-universal.zip`).

**Outcome:** **13.4 s** wall vs 20.4 s (1b′) — **−34% vs 1b′, −64% vs 1a**. Row counts and on-demand detection counts identical to 1a. DB 213 MB.

| Phase | ms | % wall |
|-------|-----|--------|
| open + DDL | 20 | 0.1% |
| ARXML materialize | 199 | 1.5% |
| BLF inflate+decode | 4,723 | 35.2% |
| protocol peel | 468 | 3.5% |
| appender append | 4,039 | 30.1% |
| appender final flush | 63 | 0.5% |
| ingest wall | 13,201 | 98.4% |

Remaining ~3.9 s of ingest wall not in the table is reader iteration + per-message `TraceMessage` copy (same work as the CSV path). CSV write (7.2 s) + COPY (3.9 s) in 1b′ are replaced by ~4.1 s of appender time.

Artifact: `.tmp/mfk5_lib.duck.db`.

### Iteration 1f — MFK5 merged mid-size scale check (2026-11-16)

**Goal:** Before HCP2, confirm 1b′ / 1e scale on a ~3× MFK5 input (lossless concat of drives 074+075+076).

**Input:** `.source/in/MFK5_VAP_X50_drive_074_076_merged.blf` (~900 MiB) + same E3 ARXML.

**Outcome:** Row counts identical across both paths. Wall scales ~2.9× vs single-`074` (≈ message ratio). Lib still **−34%** vs CLI.

| Path | Wall | Messages / protocol | DB | Rate |
|------|------|---------------------|-----|------|
| **1e lib Appender** | **38.8 s** | 11,576,298 / 43,297,608 | 590 MB | ~301k/s |
| **1b′ CLI @ 1M** | **59.2 s** | same | 600 MB | ~198k/s |

Artifacts: `.tmp/mfk5_merged_lib.duck.db`, `.tmp/mfk5_merged_1b1m.duck.db`.

### Iteration 1g — MFK5 074–078 benchmark, before vs after (2026-11-16)

**Goal:** HCP2 BLF no longer available. Lock a mid-size benchmark file and measure the pre-optimization baseline against current paths on the same input.

**Input (benchmark file going forward):** `.source/in/MFK5_VAP_X50_drive_074_078_merged.blf` (1.46 GiB, 19,309,675 BLF objects) — lossless LOGG-body concat of `074_076_merged` + `077` + `078`. Same E3 ARXML.

**Builds:**

- Before (1a): commit `f4881f3` (RelWithDebInfo); `--batch-rows 100000`.
- After: HEAD `fastrace_ingest` (1b′, `--batch-rows 1000000`) and `fastrace_ingest_lib` (1e).

**Outcome:** All three produce identical row counts and identical on-demand detection output.

| Path | Wall | vs 1a | Rate | DB |
|------|------|-------|------|-----|
| 1a baseline (`f4881f3`) @100k | 183.8 s | — | ~106k/s | 1,168 MB |
| 1b′ CLI @1M (HEAD) | 97.0 s | −47% | ~200k/s | 1,040 MB |
| **1e lib Appender (HEAD)** | **66.0 s** | **−64%** | ~294k/s | 1,037 MB |

Rows (all paths): messages 19,309,746; `protocol_pdu` 53,803,561; `protocol_someip` 18,069,992; `protocol_someip_sd` 313,812; `protocol_doip` 1,232.

In 1e, BLF inflate+decode (~24 s, 37%) is now the largest phase — further gains need the parallel reader (see [`adr/0002`](adr/0002-cpp-sidecar-writes-trace-store.md)).

Artifacts: `.tmp/mfk5_bench_1a.duck.db`, `.tmp/mfk5_bench_1b1m.duck.db`, `.tmp/mfk5_bench_lib.duck.db`.

Architecture decisions for the Tauri greenfield migration: [`adr/`](adr/).

---

## Backlog (perf → target 10–15 min wall)

Target: cut ~22.5 min → **10–15 min** on the same BLF. Bottleneck is **COPY + process churn**, not peel.

| Priority | Idea | Expected impact |
|----------|------|-----------------|
| P0 | ~~One duckdb invocation per batch (all `COPY`s in one SQL)~~ | **Done (1b)** — MFK5 COPY −40% |
| P0 | ~~Larger `--batch-rows` (500k–1M)~~ | **Done (1b′)** — default 1M; MFK5 wall −46% vs 1a |
| P1 | Long-lived duckdb session (stdin, per-batch chunks) | Small MFK5 upside (5 opens); try on HCP2 if process churn shows |
| P1 | Parquet staging instead of CSV | **Tried (1d) — reverted**; needs native C++ Parquet writer to beat CSV |
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
| 2026-11-16 | 1b′ | batch-rows 500k / 1M; default→1M | 1M: **20.4 s** (−46% vs 1a); CSV now largest |
| 2026-11-16 | 1d | SQLite/Parquet staging (no C++ writer) | **reverted** — 26.5–26.9 s vs 20.4 s CSV |
| 2026-11-16 | 1e | Prebuilt libduckdb + Appender (experimental binary) | **13.4 s** (−34% vs 1b′, −64% vs 1a) |
| 2026-11-16 | 1f | MFK5 074+075+076 merged (~900 MiB) scale check | lib **38.8 s** / CLI 59.2 s; ~2.9× vs 074 |
| 2026-11-16 | 1g | MFK5 074–078 merged (1.46 GiB) before vs after | 183.8 s → 97.0 s → **66.0 s**; identical rows + detections |
| _blocked_ | HCP2 | Final bench | HCP2 BLF unavailable; 1g file is the benchmark |
| _next_ | 1c? | Long-lived stdin (optional) | only if staying CLI-only |
| _next_ | 1d′ | Native C++ Parquet writer | blocked on Arrow/lib choice |
| _next_ | ADR | Tauri greenfield migration | see [`adr/`](adr/) |
