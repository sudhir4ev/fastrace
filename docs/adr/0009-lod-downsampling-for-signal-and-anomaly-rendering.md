# 0009. LOD downsampling for signal and anomaly rendering

- Status: Accepted
- Date: 2026-11-24

## Context

Signal sample fetching has no server-side reduction at all: `list_signal_samples`
is a flat `ORDER BY timestamp_us LIMIT 200000`, so a range with more rows than
the limit silently truncates to the *earliest* N samples, not a representative
one. Anomaly Bin width (`docs/adr/0008`) is a fixed `ANOMALY_BIN_COUNT = 500`
regardless of zoom, which was already flagged there as a "Revisit when" item.
Neither adapts to how far the user has zoomed in, so a zoomed-in view is either
too sparse (truncated samples) or too coarse (500 bins spanning a tiny window),
and a thin anomaly can be invisible at low zoom purely because of fixed bin
width - not because it isn't there.

## Decision

1. **On-demand, not precomputed.** No multi-resolution pyramid table, no
   `schema_version` bump. Downsampling is computed per request from the raw
   `signals` rows. Revisit only if profiling a real large Trace shows this is
   too slow - the schema change cost is only worth paying once the on-demand
   path is proven insufficient.
2. **Two user-selectable algorithms per signal** (Downsampling Algorithm):
   Min/Max decimation, run as DuckDB SQL (`GROUP BY` time bucket, the same
   shape as `compute_anomaly_bins`), and LTTB, run as a Rust pass in
   `crates/query` over a capped raw-row fetch (reusing the existing 200k
   safety limit) - LTTB is inherently sequential (each picked point depends on
   the previous pick) and isn't expressible as a single SQL aggregate. Every
   signal defaults to Min/Max; no auto-selection by signal type, since the
   schema has no numeric/boolean/enum distinction to select on.
3. **LOD Tier drives both signal downsampling and the Anomaly Overlay.** Tier
   is derived from the chart's pixel width, snapped to a small set of discrete
   point-budget bands, recomputed debounced on pan-end/zoom-change (not
   continuously mid-drag). The Anomaly Heatmap (`TimelineZoomControl`) is
   intentionally exempt and keeps the fixed 500 bins, since it's a navigation
   thumbnail, never zoomed into pixel-level detail.
4. **`get_signal_samples` (and the anomaly-bin command) signatures are
   replaced outright**, gaining viewport/algorithm parameters - no
   backward-compat dual path, since there is no external consumer to break.

## Considered Options

- Precomputed multi-resolution pyramid at Prepare-time: rejected for now -
  pays a Prepare-time cost for every signal regardless of whether it's ever
  viewed, and needs a schema change. May be revisited if on-demand proves too
  slow on very large Traces.
- A single downsampling algorithm (e.g. LTTB everywhere): rejected - LTTB
  trades off outlier visibility for shape fidelity, which is wrong for a tool
  whose entire point is spotting anomalies/spikes.

## Consequences

- Algorithm execution is split across the SQL/Rust boundary (Min/Max in SQL,
  LTTB in Rust) rather than one uniform code path - intentional, not an
  inconsistency to "fix."
- Anomaly Bin count is no longer a single global constant; it depends on
  which renderer (Anomaly Overlay vs Anomaly Heatmap) is asking. See
  `docs/adr/0008` decision 3, partially superseded here.
