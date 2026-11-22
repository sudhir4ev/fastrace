# 0008. Detector Query preconditions and anomaly bins

- Status: Accepted
- Date: 2026-11-21

## Context

Detector Queries may read decoded signal samples. Those samples exist only after
an on-demand decode (`docs/adr/0005`) and only over the extents recorded in
`signal_coverage`. Running a query whose Target Signals are not covered for the
chosen scope produces empty or misleading results, and decoding the whole Trace
on an 8+ GiB BLF is a multi-second write-lock blackout (`docs/adr/0004`).

Separately, plotting every Match as a scatter point (up to 200k) is the wrong
overview for navigating anomalies across a long Trace. The UI needs a fixed-width
summary so the user can trim onto each anomaly.

## Decision

1. **Backend-enforced decode preconditions.** `run_detector_query` takes
   `target_signal_ids` and a run scope (Trim Window when "respect trim" is on,
   else the full Trace time range from `get_trace_time_range`). Before executing
   the user SQL it calls `missing_signal_coverage`. If any target lacks full
   coverage, the command returns `needsDecode` (missing signals, scope,
   `blfBytes`, `wholeTrace`) and does not run. The UI shows one confirm dialog;
   on confirm it runs `apply-trim` for Active ∪ targets over the scope, then
   re-runs. Whole-trace decode on a BLF larger than 5 GiB adds a size warning in
   that same dialog. Empty targets skip the precondition (protocol-only SQL).

2. **Target Signals are explicit.** The Analyzer multi-select declares which
   signals the query needs. Inferring signal names or ids from the SQL text is
   deferred. A one-line hint states that signals the SQL reads must be selected.

3. **Anomaly bins are computed in SQL.** Over the run scope, DuckDB groups Match
   timestamps into 500 equal-width bins:
   `floor((timestamp_us - start) * 500 / (end - start + 1))`, clamped to
   `[0, 499]`. Only active bins are returned, each with
   `{bin, count, firstMsgId, firstTimestampUs, startUs, endUs}`. Bin bounds are
   computed in Rust so the UI never re-derives them. Detection logic stays SQL
   (`docs/adr/0003`); Rust only orchestrates.

4. **Anomaly Rail is separate from TrimControl.** The rail sits at the top of
   the Timeline panel, keeps the last run's bins until the next Run, and clicking
   an active bin sets and applies the Trim Window to that bin's range.

## Consequences

- A Query that needs undecoded signals cannot silently return empty Matches.
- Whole-trace iteration costs a decode blackout; the 5 GiB warning makes that
  explicit without a second dialog.
- Match scatter (capped at 200k) remains for detail inside the Trim Window; the
  rail is the overview navigation surface.
- The user SQL may execute twice per run (Matches extract + bin aggregate)
  because the Trace Store connection is read-only and cannot host a TEMP table.

## Revisit when

- SQL signal-reference inference becomes reliable enough to replace the picker.
- Query blackouts during decode force a separate signal-cache file (`docs/adr/0005`).
- Bin count or Match cap needs to scale with Trace length.
