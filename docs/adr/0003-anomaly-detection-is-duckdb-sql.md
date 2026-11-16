# 0003. Anomaly detection is DuckDB SQL only

- Status: Accepted
- Date: 2026-11-16

## Context

The current repo has two anomaly paths: a streaming C++ `DetectionEngine` with `*Detector` classes, and SQL ports of the same rules over the Trace Store. Keeping both doubles the work and lets results drift apart.

## Decision

All anomaly detection is expressed as SQL over the Trace Store and executed by `crates/query`.

- Rule files live in `schema/` (see 0001).
- C++ never evaluates detection logic, including simple value thresholds on decoded signals. C++ produces tables; SQL decides what is anomalous.
- The streaming `DetectionEngine` and C++ detectors are not carried into the new repo.

## Consequences

- Rules can be edited and re-run without rebuilding C++ or re-reading the BLF.
- Rules are tested against seeded stores with no parser involved (see 0007).
- Stateful checks (session gaps, rates, sequences) must be written with SQL windows and aggregates. Any state that SQL cannot reasonably express has to be computed at ingest as columns, not as detection logic.

## Revisit when

- A required rule cannot be expressed in SQL even with ingest-time helper columns.
