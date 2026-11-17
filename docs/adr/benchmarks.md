# Benchmarks

Evidence behind the ADRs. Full iteration history is in `duckdb_ingest_tracker.md` (carried over from the pre-migration repo's `doc/duckdb_ingest_tracker.md`).

Machine: macOS, Apple Silicon. Builds: RelWithDebInfo. DuckDB 1.1.3 (CLI and libduckdb).

## Benchmark input

`MFK5_VAP_X50_drive_074_078_merged.blf`: 1.46 GiB, 19,309,675 BLF objects, 56,166 containers. Lossless merge of MFK5 drives 074-078. Signal Database: E3_1_2 Premium MFK5 ARXML. OEM data, local only.

The 8.8 GB HCP2 trace used earlier is no longer available.

## Prepare: before vs after

| Path | Wall | vs baseline | DB size |
|------|------|-------------|---------|
| Baseline: CSV staging, DuckDB CLI `COPY`, 100k-row batches | 183.8 s | - | 1,168 MB |
| CSV staging, one CLI invoke per batch, 1M-row batches | 97.0 s | -47% | 1,040 MB |
| In-process libduckdb Appender | 66.0 s | -64% | 1,037 MB |

All three produced identical row counts and identical detection output. Rows: messages 19,309,746; `protocol_pdu` 53,803,561; `protocol_someip` 18,069,992; `protocol_someip_sd` 313,812; `protocol_doip` 1,232.

Appender path breakdown: inflate + decode 24.3 s (37%), append 20.3 s (31%), peel 2.3 s (4%).

## Reverted: Parquet staging without a native writer

Staging through SQLite, then Parquet or `ATTACH`, ran 26.5-26.9 s on a single 300 MB drive vs 20.4 s for CSV staging. Reverted. A real C++ Parquet writer was never tried.

## Parallel reader

The existing `Analyzer` pipeline (10 threads) inflated and decoded all 56,166 containers of the benchmark file in 1.0 s (file in OS cache), vs 24.3 s in the single-threaded ingest reader. This is the basis for the on-demand decode estimates in ADR 0005 and the ingest follow-up in ADR 0002.

## Signal dictionary coverage (benchmark file)

| Measure | Value |
|---------|-------|
| ARXML signals defined | 7,193 |
| Signals whose carrier message occurs | 2,971 (41.3%) |
| CAN signals present | 572 / 572 |
| Ethernet signals present | 2,399 / 6,621 |
| Present signals that are padding, CRC, counter or status | about 21% |

## Earlier full-trace reference (HCP2, 8.8 GB)

CSV staging path: 101.1M messages, 456.8M protocol rows, 5.7 GB store, about 22.5 min wall, with `COPY` taking 66%.
