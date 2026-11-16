# 0007. Verification and fixtures

- Status: Accepted (MVP; revisit with an orchestrator)
- Date: 2026-11-16

## Context

The current repo has no ingest test spec. "Correct" has meant: ingest exits 0 and row counts match the previous run on the same file. Real traces and ARXML are OEM data and cannot be committed.

## Decision

One test layer per boundary:

| Layer | Test | Fixture |
|-------|------|---------|
| `native/` | Prepare a fixture BLF; assert exact row counts per table plus a hash of key columns | Synthetic BLF + ARXML |
| `native/` | `decode-signals`: known values for 1-2 signals at given timestamps | Same synthetic files |
| `crates/query` | Each detector rule against a seeded store (DDL from `schema/` + SQL `INSERT` seeds); assert expected detections | SQL seeds only, no C++ build |
| End-to-end | Prepare, run all rules, compare a detections hash | Synthetic BLF |
| Performance | Manual benchmark, results logged in [`benchmarks.md`](benchmarks.md); not in CI | Local MFK5 074-078 merged file (1.46 GiB) |

Fixtures:

- **Synthetic BLF and ARXML**, committed, produced by a small generator: a few CAN and Ethernet frames, one PDU of each peeled protocol type, and signals with known values. Expectations are known by construction.
- **Seeded stores, not committed `.duckdb` files**, for query tests. Binary database files break on DuckDB version bumps.

Completeness check inside Prepare (not only in tests): Prepare fails if `messages` rows differ from messages the reader decoded, or if any batch append fails. This makes the fail-fast rule concrete.

## Consequences

- CI is fully deterministic and needs no OEM data.
- Synthetic fixtures will not reproduce real-world quirks unless the generator is taught them, for example objects split across containers. Add such cases as they are found.

## Deferred

- An ingestion orchestrator with its own checks when a partition is materialized (e.g. Prefect) would replace the in-Prepare completeness check.
- A realistic, non-synthetic regression fixture.

## Revisit when

- An orchestrator is adopted.
- A real-trace bug escapes because the synthetic fixture did not cover it.
