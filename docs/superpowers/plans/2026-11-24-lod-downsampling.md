# LOD Downsampling for Signal and Anomaly Rendering Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the static-bin/flat-LIMIT signal chart rendering with viewport-driven (LOD Tier) downsampling, offering Min/Max and LTTB per signal, and make the main chart's Anomaly Overlay track the same tiering instead of a fixed 500 bins.

**Architecture:** `crates/query` gains a `DownsamplingAlgorithm` enum, a LOD Tier point-budget function, a Min/Max SQL aggregation, and a Rust LTTB pass over a capped raw-row fetch. `app/src-tauri` replaces `get_signal_samples`'s signature outright and adds `get_anomaly_bins_for_viewport` (reusing the already-parameterized `compute_anomaly_bins`). `app/ui` captures chart pixel width and the zoomed-in absolute time window, debounces both, and feeds them into the existing React Query hooks so stale in-flight requests are discarded by query-key identity rather than manual race-guarding.

**Tech Stack:** Rust (DuckDB via the `duckdb` crate, `serde`), Tauri 2 commands, React + TypeScript + Vite, `@tanstack/react-query`, `echarts`, Vitest (`environment: "node"` - no DOM, pure-function tests only, matching this repo's existing frontend test style).

**Spec:** `docs/adr/0009-lod-downsampling-for-signal-and-anomaly-rendering.md`, `CONTEXT.md` (terms: Downsampling Algorithm, LOD Tier, Anomaly Bin, Anomaly Overlay, Anomaly Heatmap).

## Global Constraints

- Detection/aggregation logic stays declarative SQL, never a Rust/C++ procedural loop over rows for anything expressible as SQL (`docs/adr/0003`) - only LTTB (inherently sequential) is Rust; Min/Max stays a SQL `GROUP BY`.
- `crates/query` has zero Tauri dependency; `app/src-tauri` is a thin `#[tauri::command]` adapter only - no new logic in `main.rs` beyond opening the store and calling `crates/query`.
- No `schema_version` bump - everything is computed on-demand, no new DuckDB tables (`docs/adr/0009` decision 1).
- `get_signal_samples`'s signature is replaced outright - no backward-compat dual path (`docs/adr/0009` decision 4).
- Run `cargo fmt --manifest-path crates/Cargo.toml` and `cargo clippy --manifest-path crates/Cargo.toml -p query` on every Rust change; run `npm run test --prefix app/ui` (`vitest run`) on every frontend change.
- Every signal defaults to Min/Max; no signal-type auto-detection (`docs/adr/0009` decision 2).

## Review Focus

- A signal with zero samples in the requested viewport (common when zoomed into a gap between messages) - Min/Max and LTTB must return an empty `Vec`, not panic or error, and the chart lane must render empty rather than crash.
- A signal with 0, 1, or 2 total samples - LTTB's bucket math divides by `(n - 2)`; must not divide-by-zero or panic when `n <= 2` or `target_points` exceeds `n`.
- `pixel_width` of `0` or negative (a chart container not yet laid out, e.g. a hidden tab) - `lod_tier_point_budget` must not divide-by-zero and must not collapse to a 0-point, empty-looking chart.
- A Detector Query whose SQL errors (bad column, syntax) when re-run for a viewport-scoped anomaly-bin recompute - `get_anomaly_bins_for_viewport` must surface the same clear error `run_detector_query` already does, not panic the pan/zoom handler.
- Rapid pan/zoom before the debounce timer fires, and the resulting race between an old viewport's in-flight request and a newer one - mitigated by including the viewport bounds and target-point budget in the React Query `queryKey`, so a late-resolving stale request updates a cache entry nobody is reading, never the current one.

---

## File Structure

- Modify: `crates/query/src/lib.rs` - add `DownsamplingAlgorithm`, `lod_tier_point_budget`, `list_signal_samples_minmax`, `lttb_downsample`, `list_signal_samples_lttb`, `list_signal_samples_for_viewport`.
- Modify: `app/src-tauri/src/main.rs` - replace `get_signal_samples`, add `get_anomaly_bins_for_viewport`, register both.
- Modify: `app/ui/src/shared/api/trace-source.ts` - new `DownsamplingAlgorithm` TS type, updated `getSignalSamples` signature, new `getAnomalyBinsForViewport`.
- Modify: `app/ui/src/shared/api/hooks.ts` - updated `useSignalSamples`/`useSignalSamplesList`, new `useAnomalyBinsForViewport`.
- Create: `app/ui/src/widgets/viewport.ts` - pure `viewportFromZoomPercent` (zoom % → absolute `[startUs, endUs]`).
- Create: `app/ui/src/widgets/viewport.test.ts`.
- Create: `app/ui/src/widgets/debounce.ts` - pure `createDebouncer`.
- Create: `app/ui/src/widgets/debounce.test.ts`.
- Modify: `app/ui/src/app/store.ts` - add `signalDownsamplingAlgorithms` map + setter.
- Modify: `app/ui/src/widgets/TimelineChart.tsx` - capture pixel width, compute viewport, wire new hooks, per-lane algorithm picker.

---

### Task 1: `DownsamplingAlgorithm` enum and `lod_tier_point_budget`

**Files:**
- Modify: `crates/query/src/lib.rs`
- Test: same file, `#[cfg(test)] mod tests` block at the bottom

**Interfaces:**
- Produces: `pub enum DownsamplingAlgorithm { MinMax, Lttb }` (serde `snake_case`: `"min_max"`, `"lttb"`), `pub const MIN_LOD_TARGET_POINTS: i64 = 16`, `pub const MAX_LOD_TARGET_POINTS: i64 = 50_000`, `pub fn lod_tier_point_budget(pixel_width: i64) -> i64`.

- [ ] **Step 1: Write the failing tests**

Add to the `#[cfg(test)] mod tests` block in `crates/query/src/lib.rs`:

```rust
#[test]
fn lod_tier_point_budget_snaps_to_power_of_two() {
    assert_eq!(lod_tier_point_budget(400), 1024); // 400*2=800 -> next pow2 1024
    assert_eq!(lod_tier_point_budget(1), 16); // clamped to the minimum tier
}

#[test]
fn lod_tier_point_budget_clamps_nonpositive_width_to_minimum() {
    assert_eq!(lod_tier_point_budget(0), MIN_LOD_TARGET_POINTS);
    assert_eq!(lod_tier_point_budget(-50), MIN_LOD_TARGET_POINTS);
}

#[test]
fn lod_tier_point_budget_clamps_runaway_width_to_maximum() {
    assert_eq!(lod_tier_point_budget(1_000_000), MAX_LOD_TARGET_POINTS);
}

#[test]
fn lod_tier_point_budget_is_stable_within_a_tier() {
    // Two widths that both map to the same power-of-two tier must produce
    // the identical budget, so repeated requests at a similar zoom reuse it.
    assert_eq!(lod_tier_point_budget(260), lod_tier_point_budget(300));
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test --manifest-path crates/Cargo.toml -p query lod_tier_point_budget`
Expected: FAIL with "cannot find function `lod_tier_point_budget`"

- [ ] **Step 3: Write the implementation**

Add above the `#[cfg(test)]` block in `crates/query/src/lib.rs`:

```rust
use serde::Deserialize;

/// The two user-selectable Downsampling Algorithms (`CONTEXT.md`, `docs/adr/0009`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DownsamplingAlgorithm {
    MinMax,
    Lttb,
}

pub const MIN_LOD_TARGET_POINTS: i64 = 16;
pub const MAX_LOD_TARGET_POINTS: i64 = 50_000;

/// Point budget for a chart viewport: ~2 points per pixel, snapped up to the
/// next power of two so repeated requests at a similar zoom reuse the same
/// LOD Tier (`docs/adr/0009`). Clamped to `[MIN_LOD_TARGET_POINTS,
/// MAX_LOD_TARGET_POINTS]` so a not-yet-laid-out container (`pixel_width <=
/// 0`) or a pathologically wide one can't produce a degenerate or runaway
/// budget.
pub fn lod_tier_point_budget(pixel_width: i64) -> i64 {
    let raw = (pixel_width.max(1) * 2) as f64;
    let tier_exp = raw.log2().ceil().max(0.0) as u32;
    let budget = 1i64 << tier_exp;
    budget.clamp(MIN_LOD_TARGET_POINTS, MAX_LOD_TARGET_POINTS)
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test --manifest-path crates/Cargo.toml -p query lod_tier_point_budget`
Expected: PASS (4 tests)

- [ ] **Step 5: Format, lint, commit**

```bash
cargo fmt --manifest-path crates/Cargo.toml
cargo clippy --manifest-path crates/Cargo.toml -p query
git add crates/query/src/lib.rs
git commit -m "feat(query): add DownsamplingAlgorithm and LOD tier point budget"
```

---

### Task 2: Min/Max decimation (SQL `GROUP BY`)

**Files:**
- Modify: `crates/query/src/lib.rs`
- Test: same file, `#[cfg(test)] mod tests` block

**Interfaces:**
- Consumes: `trace_store::Connection` (existing), the `signals` table (existing schema).
- Produces: `pub fn list_signal_samples_minmax(conn: &trace_store::Connection, signal_id: i64, start_us: i64, end_us: i64, target_points: i64) -> Result<Vec<(i64, f64)>, String>` - up to two points (min-valued, max-valued) per time bucket, chronologically ordered, deduped when a bucket has only one row.

- [ ] **Step 1: Write the failing tests**

Add to the `#[cfg(test)] mod tests` block:

```rust
#[test]
fn list_signal_samples_minmax_keeps_extremes_per_bucket() {
    let conn = setup();
    conn.execute_batch(
        "INSERT INTO arxml_signal VALUES (0, 'EngineRpm', 'can', 100, 0, 16, false, 0.25, 0.0);
         INSERT INTO signals VALUES (0, 0, 1000, 0, 50.0);
         INSERT INTO signals VALUES (0, 0, 1100, 0, 200.0);
         INSERT INTO signals VALUES (0, 0, 1200, 0, 10.0);",
    )
    .unwrap();
    // One wide bucket covering all three samples: min=10 at 1200, max=200 at 1100.
    let out = list_signal_samples_minmax(&conn, 0, 1000, 1200, 1).unwrap();
    assert_eq!(out.len(), 2, "both extremes kept, chronologically ordered");
    assert_eq!(out[0], (1100, 200.0));
    assert_eq!(out[1], (1200, 10.0));
}

#[test]
fn list_signal_samples_minmax_single_row_bucket_is_not_duplicated() {
    let conn = setup();
    conn.execute_batch(
        "INSERT INTO arxml_signal VALUES (0, 'EngineRpm', 'can', 100, 0, 16, false, 0.25, 0.0);
         INSERT INTO signals VALUES (0, 0, 1000, 0, 42.0);",
    )
    .unwrap();
    let out = list_signal_samples_minmax(&conn, 0, 1000, 1000, 500).unwrap();
    assert_eq!(out, vec![(1000, 42.0)]);
}

#[test]
fn list_signal_samples_minmax_empty_range_returns_empty() {
    let conn = setup();
    conn.execute_batch(
        "INSERT INTO arxml_signal VALUES (0, 'EngineRpm', 'can', 100, 0, 16, false, 0.25, 0.0);
         INSERT INTO signals VALUES (0, 0, 9000, 0, 42.0);",
    )
    .unwrap();
    // Signal has samples, but none inside [0, 100] - must not panic, just empty.
    let out = list_signal_samples_minmax(&conn, 0, 0, 100, 500).unwrap();
    assert!(out.is_empty());
}

#[test]
fn list_signal_samples_minmax_rejects_nonpositive_target_points() {
    let conn = setup();
    assert!(list_signal_samples_minmax(&conn, 0, 0, 1000, 0).is_err());
}

#[test]
fn list_signal_samples_minmax_respects_many_buckets() {
    let conn = setup();
    conn.execute_batch(
        "INSERT INTO arxml_signal VALUES (0, 'EngineRpm', 'can', 100, 0, 16, false, 0.25, 0.0);
         INSERT INTO signals VALUES (0, 0, 0, 0, 1.0);
         INSERT INTO signals VALUES (0, 0, 1000, 0, 2.0);
         INSERT INTO signals VALUES (0, 0, 2000, 0, 3.0);",
    )
    .unwrap();
    // 3 buckets over [0,2000] each containing exactly one sample.
    let out = list_signal_samples_minmax(&conn, 0, 0, 2000, 3).unwrap();
    assert_eq!(out, vec![(0, 1.0), (1000, 2.0), (2000, 3.0)]);
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test --manifest-path crates/Cargo.toml -p query list_signal_samples_minmax`
Expected: FAIL with "cannot find function `list_signal_samples_minmax`"

- [ ] **Step 3: Write the implementation**

Add to `crates/query/src/lib.rs`, near `list_signal_samples`:

```rust
/// Min/Max decimation: groups a signal's samples in `[start_us, end_us]`
/// into `target_points` equal-width time buckets (same bucketing shape as
/// `compute_anomaly_bins`) and keeps each bucket's min- and max-valued
/// sample, chronologically ordered. A bucket with a single row contributes
/// one point, not a duplicate. Preserves outliers/spikes - the Downsampling
/// Algorithm default for every signal (`docs/adr/0009`).
pub fn list_signal_samples_minmax(
    conn: &trace_store::Connection,
    signal_id: i64,
    start_us: i64,
    end_us: i64,
    target_points: i64,
) -> Result<Vec<(i64, f64)>, String> {
    if target_points < 1 {
        return Err("target_points must be >= 1".to_string());
    }
    let (lo, hi) = if start_us <= end_us {
        (start_us, end_us)
    } else {
        (end_us, start_us)
    };
    let sql = format!(
        "with bucketed as (
           select timestamp_us, phys_value,
                  least({target_points} - 1,
                        greatest(0, cast(floor((timestamp_us - {lo})::double * {target_points}
                                               / ({hi} - {lo} + 1)) as bigint))) as bucket
           from signals
           where signal_id = ? and timestamp_us between ? and ?
         )
         select arg_min(timestamp_us, phys_value) as min_ts, min(phys_value) as min_val,
                arg_max(timestamp_us, phys_value) as max_ts, max(phys_value) as max_val
         from bucketed
         group by bucket
         order by bucket"
    );
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(duckdb::params![signal_id, lo, hi], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, f64>(1)?,
                row.get::<_, i64>(2)?,
                row.get::<_, f64>(3)?,
            ))
        })
        .map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for r in rows {
        let (min_ts, min_val, max_ts, max_val) = r.map_err(|e| e.to_string())?;
        match min_ts.cmp(&max_ts) {
            std::cmp::Ordering::Equal => out.push((min_ts, min_val)),
            std::cmp::Ordering::Less => {
                out.push((min_ts, min_val));
                out.push((max_ts, max_val));
            }
            std::cmp::Ordering::Greater => {
                out.push((max_ts, max_val));
                out.push((min_ts, min_val));
            }
        }
    }
    Ok(out)
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test --manifest-path crates/Cargo.toml -p query list_signal_samples_minmax`
Expected: PASS (5 tests)

- [ ] **Step 5: Format, lint, commit**

```bash
cargo fmt --manifest-path crates/Cargo.toml
cargo clippy --manifest-path crates/Cargo.toml -p query
git add crates/query/src/lib.rs
git commit -m "feat(query): add Min/Max decimation downsampling"
```

---

### Task 3: LTTB pure algorithm

**Files:**
- Modify: `crates/query/src/lib.rs`
- Test: same file, `#[cfg(test)] mod tests` block

**Interfaces:**
- Produces: `pub fn lttb_downsample(points: &[(i64, f64)], target_points: usize) -> Vec<(i64, f64)>` - pure, no DB.

- [ ] **Step 1: Write the failing tests**

Add to the `#[cfg(test)] mod tests` block:

```rust
#[test]
fn lttb_downsample_keeps_first_and_last_point() {
    let points: Vec<(i64, f64)> = (0..100).map(|i| (i * 1000, (i as f64).sin())).collect();
    let out = lttb_downsample(&points, 10);
    assert_eq!(out.first(), points.first());
    assert_eq!(out.last(), points.last());
}

#[test]
fn lttb_downsample_returns_exactly_target_points_when_input_is_larger() {
    let points: Vec<(i64, f64)> = (0..1000).map(|i| (i * 1000, i as f64)).collect();
    let out = lttb_downsample(&points, 50);
    assert_eq!(out.len(), 50);
}

#[test]
fn lttb_downsample_preserves_monotonic_timestamps() {
    let points: Vec<(i64, f64)> = (0..500).map(|i| (i * 1000, (i as f64).cos())).collect();
    let out = lttb_downsample(&points, 37);
    for pair in out.windows(2) {
        assert!(pair[0].0 < pair[1].0, "timestamps must stay strictly increasing: {pair:?}");
    }
}

#[test]
fn lttb_downsample_returns_input_unchanged_when_target_exceeds_input_len() {
    let points = vec![(0, 1.0), (1000, 2.0), (2000, 3.0)];
    assert_eq!(lttb_downsample(&points, 100), points);
}

#[test]
fn lttb_downsample_empty_input_returns_empty() {
    assert_eq!(lttb_downsample(&[], 50), Vec::<(i64, f64)>::new());
}

#[test]
fn lttb_downsample_single_point_input_returns_that_point() {
    let points = vec![(42, 3.14)];
    assert_eq!(lttb_downsample(&points, 50), points);
}

#[test]
fn lttb_downsample_two_point_input_returns_both() {
    let points = vec![(0, 1.0), (1000, 2.0)];
    assert_eq!(lttb_downsample(&points, 50), points);
}

#[test]
fn lttb_downsample_target_below_three_keeps_endpoints_only() {
    let points: Vec<(i64, f64)> = (0..20).map(|i| (i * 1000, i as f64)).collect();
    let out = lttb_downsample(&points, 2);
    assert_eq!(out, vec![points[0], points[19]]);
}

#[test]
fn lttb_downsample_target_zero_returns_all_points_unchanged() {
    let points = vec![(0, 1.0), (1000, 2.0), (2000, 3.0)];
    assert_eq!(lttb_downsample(&points, 0), points);
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test --manifest-path crates/Cargo.toml -p query lttb_downsample`
Expected: FAIL with "cannot find function `lttb_downsample`"

- [ ] **Step 3: Write the implementation**

Add to `crates/query/src/lib.rs`:

```rust
/// Largest-Triangle-Three-Buckets downsampling (Sveinn Steinarsson, 2013).
/// Always keeps the first and last point. `target_points == 0` or `>= n`
/// returns the input unchanged; `target_points < 3` (with `n >= 2`) returns
/// just the first and last point, since LTTB's triangle-area selection needs
/// at least one point strictly between the two fixed endpoints.
pub fn lttb_downsample(points: &[(i64, f64)], target_points: usize) -> Vec<(i64, f64)> {
    let n = points.len();
    if target_points == 0 || target_points >= n || n <= 2 {
        return points.to_vec();
    }
    if target_points < 3 {
        return vec![points[0], points[n - 1]];
    }

    let mut sampled = Vec::with_capacity(target_points);
    sampled.push(points[0]);

    // Bucket size for the *middle* points only - first/last are fixed.
    let bucket_size = (n - 2) as f64 / (target_points - 2) as f64;
    let mut a = 0usize; // index of the last point actually selected

    for i in 0..(target_points - 2) {
        let bucket_start = ((i as f64) * bucket_size) as usize + 1;
        let bucket_end = ((((i + 1) as f64) * bucket_size) as usize + 1).min(n - 1).max(bucket_start + 1);

        let next_start = bucket_end;
        let next_end = ((((i + 2) as f64) * bucket_size) as usize + 1)
            .min(n)
            .max(next_start + 1);
        let slice = &points[next_start..next_end];
        let len = slice.len() as f64;
        let (avg_x, avg_y) = (
            slice.iter().map(|p| p.0 as f64).sum::<f64>() / len,
            slice.iter().map(|p| p.1).sum::<f64>() / len,
        );

        let (ax, ay) = (points[a].0 as f64, points[a].1);
        let mut best_area = -1.0;
        let mut best_idx = bucket_start;
        for idx in bucket_start..bucket_end {
            let (bx, by) = (points[idx].0 as f64, points[idx].1);
            let area = ((ax - avg_x) * (by - ay) - (ax - bx) * (avg_y - ay)).abs();
            if area > best_area {
                best_area = area;
                best_idx = idx;
            }
        }
        sampled.push(points[best_idx]);
        a = best_idx;
    }
    sampled.push(points[n - 1]);
    sampled
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test --manifest-path crates/Cargo.toml -p query lttb_downsample`
Expected: PASS (9 tests)

- [ ] **Step 5: Format, lint, commit**

```bash
cargo fmt --manifest-path crates/Cargo.toml
cargo clippy --manifest-path crates/Cargo.toml -p query
git add crates/query/src/lib.rs
git commit -m "feat(query): add LTTB downsampling algorithm"
```

---

### Task 4: LTTB sample fetch and the algorithm dispatcher

**Files:**
- Modify: `crates/query/src/lib.rs`
- Test: same file, `#[cfg(test)] mod tests` block

**Interfaces:**
- Consumes: `list_signal_samples` (existing, unchanged), `lttb_downsample` (Task 3), `DownsamplingAlgorithm` (Task 1), `list_signal_samples_minmax` (Task 2), `DETECTOR_QUERY_MATCH_LIMIT` (existing constant).
- Produces: `pub fn list_signal_samples_lttb(conn: &trace_store::Connection, signal_id: i64, start_us: i64, end_us: i64, target_points: i64) -> Result<Vec<(i64, f64)>, String>`, `pub fn list_signal_samples_for_viewport(conn: &trace_store::Connection, signal_id: i64, start_us: i64, end_us: i64, target_points: i64, algorithm: DownsamplingAlgorithm) -> Result<Vec<(i64, f64)>, String>` - the function the Tauri layer (Task 5) calls.

- [ ] **Step 1: Write the failing tests**

Add to the `#[cfg(test)] mod tests` block:

```rust
#[test]
fn list_signal_samples_lttb_reduces_to_target_points() {
    let conn = setup();
    conn.execute_batch("INSERT INTO arxml_signal VALUES (0, 'EngineRpm', 'can', 100, 0, 16, false, 0.25, 0.0);")
        .unwrap();
    for i in 0..200i64 {
        conn.execute(
            "INSERT INTO signals VALUES (0, 0, ?, 0, ?)",
            duckdb::params![i * 1000, i as f64],
        )
        .unwrap();
    }
    let out = list_signal_samples_lttb(&conn, 0, 0, 199_000, 20).unwrap();
    assert_eq!(out.len(), 20);
    assert_eq!(out[0], (0, 0.0));
    assert_eq!(out[19], (199_000, 199.0));
}

#[test]
fn list_signal_samples_for_viewport_dispatches_minmax() {
    let conn = setup();
    conn.execute_batch(
        "INSERT INTO arxml_signal VALUES (0, 'EngineRpm', 'can', 100, 0, 16, false, 0.25, 0.0);
         INSERT INTO signals VALUES (0, 0, 1000, 0, 50.0);
         INSERT INTO signals VALUES (0, 0, 1100, 0, 200.0);",
    )
    .unwrap();
    let out =
        list_signal_samples_for_viewport(&conn, 0, 1000, 1100, 1, DownsamplingAlgorithm::MinMax)
            .unwrap();
    assert_eq!(out.len(), 2);
}

#[test]
fn list_signal_samples_for_viewport_dispatches_lttb() {
    let conn = setup();
    conn.execute_batch("INSERT INTO arxml_signal VALUES (0, 'EngineRpm', 'can', 100, 0, 16, false, 0.25, 0.0);")
        .unwrap();
    for i in 0..50i64 {
        conn.execute(
            "INSERT INTO signals VALUES (0, 0, ?, 0, ?)",
            duckdb::params![i * 1000, i as f64],
        )
        .unwrap();
    }
    let out =
        list_signal_samples_for_viewport(&conn, 0, 0, 49_000, 10, DownsamplingAlgorithm::Lttb)
            .unwrap();
    assert_eq!(out.len(), 10);
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test --manifest-path crates/Cargo.toml -p query list_signal_samples_lttb list_signal_samples_for_viewport`
Expected: FAIL with "cannot find function"

- [ ] **Step 3: Write the implementation**

Add to `crates/query/src/lib.rs`:

```rust
/// LTTB over a capped raw-row fetch - reuses `list_signal_samples`'s
/// existing `ORDER BY timestamp_us LIMIT` as the raw source, capped at
/// `DETECTOR_QUERY_MATCH_LIMIT` for the same reason the Detector Query match
/// extract is capped there (`docs/adr/0009` decision 2).
pub fn list_signal_samples_lttb(
    conn: &trace_store::Connection,
    signal_id: i64,
    start_us: i64,
    end_us: i64,
    target_points: i64,
) -> Result<Vec<(i64, f64)>, String> {
    let raw = list_signal_samples(conn, signal_id, DETECTOR_QUERY_MATCH_LIMIT, start_us, end_us)?;
    Ok(lttb_downsample(&raw, target_points.max(0) as usize))
}

/// Dispatches to the signal's chosen Downsampling Algorithm - the one
/// function the Tauri `get_signal_samples` command calls.
pub fn list_signal_samples_for_viewport(
    conn: &trace_store::Connection,
    signal_id: i64,
    start_us: i64,
    end_us: i64,
    target_points: i64,
    algorithm: DownsamplingAlgorithm,
) -> Result<Vec<(i64, f64)>, String> {
    match algorithm {
        DownsamplingAlgorithm::MinMax => {
            list_signal_samples_minmax(conn, signal_id, start_us, end_us, target_points)
        }
        DownsamplingAlgorithm::Lttb => {
            list_signal_samples_lttb(conn, signal_id, start_us, end_us, target_points)
        }
    }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test --manifest-path crates/Cargo.toml -p query`
Expected: PASS (full crate suite, including all earlier tasks' tests)

- [ ] **Step 5: Format, lint, commit**

```bash
cargo fmt --manifest-path crates/Cargo.toml
cargo clippy --manifest-path crates/Cargo.toml -p query
git add crates/query/src/lib.rs
git commit -m "feat(query): add LTTB sample fetch and algorithm dispatcher"
```

---

### Task 5: Tauri layer - replace `get_signal_samples`, add `get_anomaly_bins_for_viewport`

**Files:**
- Modify: `app/src-tauri/src/main.rs:334-345` (current `get_signal_samples`), and the `tauri::generate_handler![...]` list (~line 882-898)
- Test: new `#[cfg(test)] mod tests` additions in `app/src-tauri/src/main.rs` (create the module if none covers these commands yet - check first: `grep -n "mod tests" app/src-tauri/src/main.rs`)

**Interfaces:**
- Consumes: `query::DownsamplingAlgorithm`, `query::lod_tier_point_budget`, `query::list_signal_samples_for_viewport`, `query::compute_anomaly_bins` (all existing/Task 1-4), `trace_store::open`.
- Produces: `get_signal_samples(blf_path, signal_id, start_us, end_us, pixel_width, algorithm) -> Result<Vec<(i64,f64)>, String>` (replaces old signature), `get_anomaly_bins_for_viewport(blf_path, sql, start_us, end_us, pixel_width) -> Result<Vec<query::AnomalyBin>, String>` (new).

- [ ] **Step 1: Write the failing tests**

First check whether `main.rs` already has a `#[cfg(test)] mod tests` block (it does, further down the file, covering `upsert_recent`/`push_query`/etc. - add to that same block). Add:

```rust
fn write_minimal_store_for_signal_tests(path: &std::path::Path) {
    let conn = duckdb::Connection::open(path).unwrap();
    conn.execute_batch(
        "CREATE TABLE meta (key VARCHAR, value VARCHAR);
         INSERT INTO meta VALUES ('schema_version', '5');
         CREATE TABLE messages (msg_id BIGINT, timestamp_us BIGINT, object_type INTEGER, arb_id INTEGER, dst_ip VARCHAR, dst_port INTEGER, dlc INTEGER, payload_len INTEGER);
         CREATE TABLE arxml_signal (signal_id BIGINT, name VARCHAR, parent_kind VARCHAR, parent_id BIGINT, start_bit INTEGER, bit_length INTEGER, big_endian BOOLEAN, factor DOUBLE, \"offset\" DOUBLE);
         CREATE TABLE signals (signal_id BIGINT, msg_id BIGINT, timestamp_us BIGINT, raw_value UBIGINT, phys_value DOUBLE);
         INSERT INTO messages VALUES (0, 1000, 1, 100, NULL, NULL, 8, 8);
         INSERT INTO messages VALUES (1, 2000, 1, 100, NULL, NULL, 8, 8);
         INSERT INTO arxml_signal VALUES (0, 'EngineRpm', 'can', 100, 0, 16, false, 0.25, 0.0);
         INSERT INTO signals VALUES (0, 0, 1000, 0, 10.0);
         INSERT INTO signals VALUES (0, 1, 2000, 0, 20.0);",
    )
    .unwrap();
}

#[test]
fn get_signal_samples_delegates_to_query_crate() {
    let dir = std::env::temp_dir().join(format!("get_signal_samples_test_{}.duckdb", std::process::id()));
    write_minimal_store_for_signal_tests(&dir);
    let blf_path = dir.with_extension("blf").to_string_lossy().to_string();
    let out = get_signal_samples(blf_path, 0, 0, 3000, 400, query::DownsamplingAlgorithm::MinMax).unwrap();
    assert_eq!(out.len(), 2);
    let _ = std::fs::remove_file(&dir);
}

#[test]
fn get_anomaly_bins_for_viewport_delegates_to_query_crate() {
    let dir = std::env::temp_dir().join(format!("get_anomaly_bins_viewport_test_{}.duckdb", std::process::id()));
    write_minimal_store_for_signal_tests(&dir);
    let blf_path = dir.with_extension("blf").to_string_lossy().to_string();
    let bins = get_anomaly_bins_for_viewport(
        blf_path,
        "select msg_id, timestamp_us from messages".to_string(),
        0,
        3000,
        400,
    )
    .unwrap();
    assert!(!bins.is_empty());
    let _ = std::fs::remove_file(&dir);
}

#[test]
fn get_anomaly_bins_for_viewport_surfaces_bad_sql_as_error() {
    let dir = std::env::temp_dir().join(format!("get_anomaly_bins_viewport_err_test_{}.duckdb", std::process::id()));
    write_minimal_store_for_signal_tests(&dir);
    let blf_path = dir.with_extension("blf").to_string_lossy().to_string();
    let err = get_anomaly_bins_for_viewport(blf_path, "select * from no_such_table".to_string(), 0, 3000, 400)
        .unwrap_err();
    assert!(!err.is_empty());
    let _ = std::fs::remove_file(&dir);
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test --manifest-path app/src-tauri/Cargo.toml get_signal_samples_delegates get_anomaly_bins_for_viewport`
Expected: FAIL to compile - `get_signal_samples` has the old 5-param signature, `get_anomaly_bins_for_viewport` doesn't exist.

- [ ] **Step 3: Write the implementation**

Replace the existing `get_signal_samples` command (`app/src-tauri/src/main.rs:334-345`):

```rust
#[tauri::command]
fn get_signal_samples(
    blf_path: String,
    signal_id: i64,
    start_us: i64,
    end_us: i64,
    pixel_width: i64,
    algorithm: query::DownsamplingAlgorithm,
) -> Result<Vec<(i64, f64)>, String> {
    let duckdb_path = std::path::Path::new(&blf_path).with_extension("duckdb");
    let conn = trace_store::open(&duckdb_path)?;
    let target_points = query::lod_tier_point_budget(pixel_width);
    query::list_signal_samples_for_viewport(&conn, signal_id, start_us, end_us, target_points, algorithm)
}

/// Recomputes Anomaly Bins over just the currently-visible viewport, at the
/// current LOD Tier - feeds the Anomaly Overlay (`CONTEXT.md`). Distinct
/// from `run_detector_query`'s fixed-500-bin Anomaly Bins, which stay scoped
/// to the whole run and feed the Anomaly Heatmap unchanged (`docs/adr/0009`).
#[tauri::command]
fn get_anomaly_bins_for_viewport(
    blf_path: String,
    sql: String,
    start_us: i64,
    end_us: i64,
    pixel_width: i64,
) -> Result<Vec<query::AnomalyBin>, String> {
    let duckdb_path = std::path::Path::new(&blf_path).with_extension("duckdb");
    let conn = trace_store::open(&duckdb_path)?;
    let bin_count = query::lod_tier_point_budget(pixel_width);
    query::compute_anomaly_bins(&conn, &sql, start_us, end_us, bin_count)
}
```

Add `get_anomaly_bins_for_viewport` to the `tauri::generate_handler![...]` list, next to `get_signal_samples`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test --manifest-path app/src-tauri/Cargo.toml`
Expected: PASS (full `fastrace-app` suite)

- [ ] **Step 5: Format, lint, commit**

```bash
cargo fmt --manifest-path crates/Cargo.toml
git add app/src-tauri/src/main.rs
git commit -m "feat(app): replace get_signal_samples and add viewport-scoped anomaly bins"
```

---

### Task 6: Frontend API layer - `trace-source.ts` and `hooks.ts`

**Files:**
- Modify: `app/ui/src/shared/api/trace-source.ts:81-88` (add `DownsamplingAlgorithm` type near `AnomalyBin`), `:174-180` (interface), `:269-277` (impl)
- Modify: `app/ui/src/shared/api/hooks.ts:131-169` (`useSignalSamples`, `useSignalSamplesList`), add `useAnomalyBinsForViewport`

**Interfaces:**
- Consumes: Tauri commands from Task 5 (`get_signal_samples`, `get_anomaly_bins_for_viewport`).
- Produces: `export type DownsamplingAlgorithm = "min_max" | "lttb";`, updated `TraceDataSource.getSignalSamples(blfPath, signalId, startUs, endUs, pixelWidth, algorithm)`, new `getAnomalyBinsForViewport(blfPath, sql, startUs, endUs, pixelWidth): Promise<AnomalyBin[]>`, new hook `useAnomalyBinsForViewport(blfPath, sql, startUs, endUs, pixelWidth)`.

No new automated test here - this task is pure Tauri-`invoke` plumbing with no branching logic of its own (consistent with the rest of `trace-source.ts`, which has no dedicated test file today); it's exercised indirectly by Task 8's manual verification pass.

- [ ] **Step 1: Add the type and update the interface**

In `app/ui/src/shared/api/trace-source.ts`, near the `AnomalyBin` interface (line 81):

```ts
export type DownsamplingAlgorithm = "min_max" | "lttb";
```

Replace the `getSignalSamples` declaration in `TraceDataSource` (lines 174-180):

```ts
  getSignalSamples(
    blfPath: string,
    signalId: number,
    startUs: number,
    endUs: number,
    pixelWidth: number,
    algorithm: DownsamplingAlgorithm
  ): Promise<[number, number][]>;
  getAnomalyBinsForViewport(
    blfPath: string,
    sql: string,
    startUs: number,
    endUs: number,
    pixelWidth: number
  ): Promise<AnomalyBin[]>;
```

- [ ] **Step 2: Update the Tauri implementation**

Replace the `getSignalSamples` method on `TauriTraceDataSource` (lines 269-277):

```ts
  getSignalSamples(
    blfPath: string,
    signalId: number,
    startUs: number,
    endUs: number,
    pixelWidth: number,
    algorithm: DownsamplingAlgorithm
  ): Promise<[number, number][]> {
    return invoke<[number, number][]>("get_signal_samples", {
      blfPath,
      signalId,
      startUs,
      endUs,
      pixelWidth,
      algorithm,
    });
  }

  getAnomalyBinsForViewport(
    blfPath: string,
    sql: string,
    startUs: number,
    endUs: number,
    pixelWidth: number
  ): Promise<AnomalyBin[]> {
    return invoke<AnomalyBin[]>("get_anomaly_bins_for_viewport", {
      blfPath,
      sql,
      startUs,
      endUs,
      pixelWidth,
    });
  }
```

- [ ] **Step 3: Update the hooks**

In `app/ui/src/shared/api/hooks.ts`, replace `useSignalSamples` and `useSignalSamplesList` (lines 131-169):

```ts
export function useSignalSamples(
  blfPath: string,
  signalId: number | null,
  startUs: number,
  endUs: number,
  pixelWidth = 400,
  algorithm: DownsamplingAlgorithm = "min_max"
) {
  return useQuery({
    queryKey: ["signal-samples", blfPath, signalId, startUs, endUs, pixelWidth, algorithm],
    queryFn: () =>
      getTraceDataSource().getSignalSamples(blfPath, signalId as number, startUs, endUs, pixelWidth, algorithm),
    enabled: signalId !== null,
  });
}

// Timeline-scale fetch: TimelineChart calls this once for every displayed
// signal, scoped to the current viewport (not the whole Trim Window) and
// downsampled server-side per the signal's chosen Downsampling Algorithm
// (`docs/adr/0009`) - the viewport bounds and pixel width are part of the
// queryKey, so a late-resolving stale request (from before a pan/zoom)
// updates a cache entry nobody reads, never clobbering the current one.
export function useSignalSamplesList(
  blfPath: string,
  signalIds: number[],
  startUs: number,
  endUs: number,
  pixelWidth: number,
  algorithms: Record<number, DownsamplingAlgorithm>
) {
  return useQueries({
    queries: signalIds.map((signalId) => {
      const algorithm = algorithms[signalId] ?? "min_max";
      return {
        queryKey: ["signal-samples", blfPath, signalId, startUs, endUs, pixelWidth, algorithm],
        queryFn: () =>
          getTraceDataSource().getSignalSamples(blfPath, signalId, startUs, endUs, pixelWidth, algorithm),
      };
    }),
  });
}

// Feeds the main chart's Anomaly Overlay - recomputed per viewport/LOD Tier,
// distinct from the fixed-500-bin Anomaly Bins the Detector Query run itself
// returns (those still feed the Anomaly Heatmap unchanged, `docs/adr/0009`).
export function useAnomalyBinsForViewport(
  blfPath: string,
  sql: string,
  startUs: number,
  endUs: number,
  pixelWidth: number
) {
  return useQuery({
    queryKey: ["anomaly-bins-viewport", blfPath, sql, startUs, endUs, pixelWidth],
    queryFn: () => getTraceDataSource().getAnomalyBinsForViewport(blfPath, sql, startUs, endUs, pixelWidth),
    enabled: sql.trim().length > 0,
  });
}
```

Add `import type { DownsamplingAlgorithm } from "./trace-source";` to `hooks.ts`'s existing import block from `./trace-source`.

- [ ] **Step 4: Typecheck**

Run: `npm run build --prefix app/ui`
Expected: PASS (TypeScript compiles; `TimelineChart.tsx`/`TimelineZoomControl.tsx` will fail to typecheck here until Tasks 7-8 update their call sites - if so, proceed to Task 7 before re-running this check)

- [ ] **Step 5: Commit**

```bash
git add app/ui/src/shared/api/trace-source.ts app/ui/src/shared/api/hooks.ts
git commit -m "feat(ui): wire viewport-scoped signal samples and anomaly bins API"
```

---

### Task 7: Pure viewport and debounce helpers

**Files:**
- Create: `app/ui/src/widgets/viewport.ts`
- Create: `app/ui/src/widgets/viewport.test.ts`
- Create: `app/ui/src/widgets/debounce.ts`
- Create: `app/ui/src/widgets/debounce.test.ts`

**Interfaces:**
- Produces: `export function viewportFromZoomPercent(zoomRange: {start:number;end:number}, trimRange: {start:number;end:number}): {startUs:number;endUs:number}`, `export function createDebouncer<Args extends unknown[]>(delayMs: number, fn: (...args: Args) => void): {call: (...args: Args) => void; cancel: () => void}`.

- [ ] **Step 1: Write the failing tests**

`app/ui/src/widgets/viewport.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { viewportFromZoomPercent } from "./viewport";

describe("viewportFromZoomPercent", () => {
  it("maps the full 0-100 zoom window to the full trim range", () => {
    expect(viewportFromZoomPercent({ start: 0, end: 100 }, { start: 1000, end: 2000 })).toEqual({
      startUs: 1000,
      endUs: 2000,
    });
  });

  it("maps a sub-window proportionally", () => {
    expect(viewportFromZoomPercent({ start: 25, end: 75 }, { start: 0, end: 100_000 })).toEqual({
      startUs: 25_000,
      endUs: 75_000,
    });
  });

  it("handles a zero-width trim range without NaN", () => {
    expect(viewportFromZoomPercent({ start: 10, end: 90 }, { start: 500, end: 500 })).toEqual({
      startUs: 500,
      endUs: 500,
    });
  });
});
```

`app/ui/src/widgets/debounce.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDebouncer } from "./debounce";

describe("createDebouncer", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("only invokes once, with the last call's args, after the delay", () => {
    const calls: number[] = [];
    const debouncer = createDebouncer(100, (n: number) => calls.push(n));
    debouncer.call(1);
    debouncer.call(2);
    debouncer.call(3);
    expect(calls).toEqual([]);
    vi.advanceTimersByTime(100);
    expect(calls).toEqual([3]);
  });

  it("cancel() prevents the pending call", () => {
    const calls: number[] = [];
    const debouncer = createDebouncer(100, (n: number) => calls.push(n));
    debouncer.call(1);
    debouncer.cancel();
    vi.advanceTimersByTime(100);
    expect(calls).toEqual([]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test --prefix app/ui -- viewport debounce`
Expected: FAIL - `./viewport` and `./debounce` modules don't exist

- [ ] **Step 3: Write the implementation**

`app/ui/src/widgets/viewport.ts`:

```ts
// Maps the shared [0,100] zoom percent window (TimelineChart/TimelineZoomControl's
// dataZoom) onto the Trim Window's absolute timestamp bounds - the viewport
// the chart's signal samples and Anomaly Overlay are actually scoped to,
// instead of the whole Trim Window (`docs/adr/0009`).
export function viewportFromZoomPercent(
  zoomRange: { start: number; end: number },
  trimRange: { start: number; end: number }
): { startUs: number; endUs: number } {
  const span = trimRange.end - trimRange.start;
  const startUs = Math.round(trimRange.start + (zoomRange.start / 100) * span);
  const endUs = Math.round(trimRange.start + (zoomRange.end / 100) * span);
  return { startUs, endUs };
}
```

`app/ui/src/widgets/debounce.ts`:

```ts
// Debounces viewport-driven refetches (pan/zoom) so LOD recompute happens
// on pan-end/zoom-change, not continuously mid-drag (`docs/adr/0009`).
export function createDebouncer<Args extends unknown[]>(
  delayMs: number,
  fn: (...args: Args) => void
): { call: (...args: Args) => void; cancel: () => void } {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return {
    call: (...args: Args) => {
      if (timer !== undefined) clearTimeout(timer);
      timer = setTimeout(() => fn(...args), delayMs);
    },
    cancel: () => {
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
    },
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run test --prefix app/ui -- viewport debounce`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add app/ui/src/widgets/viewport.ts app/ui/src/widgets/viewport.test.ts app/ui/src/widgets/debounce.ts app/ui/src/widgets/debounce.test.ts
git commit -m "feat(ui): add viewport mapping and debounce helpers"
```

---

### Task 8: Store - per-signal Downsampling Algorithm map

**Files:**
- Modify: `app/ui/src/app/store.ts`

**Interfaces:**
- Consumes: `DownsamplingAlgorithm` type (Task 6).
- Produces: `signalDownsamplingAlgorithms: Record<number, DownsamplingAlgorithm>`, `setSignalDownsamplingAlgorithm: (signalId: number, algorithm: DownsamplingAlgorithm) => void` on `WorkspaceState`.

No new test file - this is additive Zustand state with a one-line setter, in the same style as the existing untested setters in this store (`setDetectorQuerySql`, `setPendingTrimRange`, etc.); it's exercised by Task 9's manual verification.

- [ ] **Step 1: Add the import**

In `app/ui/src/app/store.ts`, add to the existing import from `trace-source`:

```ts
import type { AnomalyBin, DetectorMatch, DetectorQueryRan, DownsamplingAlgorithm } from "@/shared/api/trace-source";
```

- [ ] **Step 2: Add state and setter to `WorkspaceState`**

Add inside the `WorkspaceState` interface, near `activeSignalIds`:

```ts
  // Per-signal Downsampling Algorithm choice (CONTEXT.md) - defaults to
  // Min/Max for any signal not yet present in the map.
  signalDownsamplingAlgorithms: Record<number, DownsamplingAlgorithm>;
  setSignalDownsamplingAlgorithm: (signalId: number, algorithm: DownsamplingAlgorithm) => void;
```

Add to the store implementation (the `create<WorkspaceState>((set, get) => ({ ... }))` body, `store.ts:73`), alongside the other initial fields/setters:

```ts
  signalDownsamplingAlgorithms: {},
  setSignalDownsamplingAlgorithm: (signalId, algorithm) =>
    set((s) => ({
      signalDownsamplingAlgorithms: { ...s.signalDownsamplingAlgorithms, [signalId]: algorithm },
    })),
```

Add `signalDownsamplingAlgorithms: {}` to the `resetWorkspace` implementation's `set({...})` call (`store.ts:167-185`), so the full call reads:

```ts
  resetWorkspace: () =>
    set({
      selectedGroupKeys: [],
      selectedMessageId: null,
      workspaceTab: "signals",
      activeSignalIds: new Set(),
      pendingSignalIds: new Set(),
      detectorQuerySql: "",
      detectorTargetSignalIds: [],
      detectorRespectTrim: true,
      detectorMatches: [],
      detectorQueryTruncated: false,
      detectorQueryError: null,
      detectorQueryHasRun: false,
      anomalyBins: [],
      timelineZoomRange: { start: 0, end: 100 },
      appliedTrimRange: null,
      pendingTrimRange: null,
      signalDownsamplingAlgorithms: {},
    }),
```

- [ ] **Step 3: Typecheck**

Run: `npm run build --prefix app/ui`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add app/ui/src/app/store.ts
git commit -m "feat(ui): add per-signal Downsampling Algorithm store state"
```

---

### Task 9: `TimelineChart.tsx` - viewport wiring

**Files:**
- Modify: `app/ui/src/widgets/TimelineChart.tsx:71-76` (samples fetch), `:95-122` (init effect - pixel width capture), `:198-213` (series/markArea build)

**Interfaces:**
- Consumes: `useSignalSamplesList` (Task 6, new signature), `useAnomalyBinsForViewport` (Task 6), `viewportFromZoomPercent` (Task 7), `createDebouncer` (Task 7), `signalDownsamplingAlgorithms` (Task 8).
- Produces: the chart now fetches per-viewport, LOD-tiered samples and a viewport-scoped Anomaly Overlay; `TimelineZoomControl` is untouched and keeps reading the fixed-500-bin `anomalyBins`.

No new automated test - `TimelineChart.tsx` is an echarts-driving React component with no render test infrastructure in this repo today (`vite.config.ts`'s `environment: "node"` has no DOM; adding one is out of scope for this plan). Verified manually in Task 10.

- [ ] **Step 1: Capture pixel width and debounced viewport state**

In `TimelineChart.tsx`, add local state for the debounced viewport and pixel width, and feed the `ResizeObserver` + `dataZoom` handler into the debouncer (replacing the relevant lines inside the init effect, `:95-122`):

```tsx
  const [viewport, setViewport] = useState<{ startUs: number; endUs: number; pixelWidth: number } | null>(null);
  const debouncerRef = useRef(
    createDebouncer(200, (startUs: number, endUs: number, pixelWidth: number) =>
      setViewport({ startUs, endUs, pixelWidth })
    )
  );

  useEffect(() => {
    if (!containerRef.current) return;
    const chart = echarts.init(containerRef.current, undefined, { renderer: "canvas" });
    chart.group = CHART_GROUP;
    chartRef.current = chart;
    echarts.connect(CHART_GROUP);

    const scheduleViewportUpdate = () => {
      const dz = currentDataZoom(chart) ?? useWorkspaceStore.getState().timelineZoomRange;
      const trim = useWorkspaceStore.getState().appliedTrimRange;
      if (!trim || !containerRef.current) return;
      const { startUs, endUs } = viewportFromZoomPercent(dz, trim);
      debouncerRef.current.call(startUs, endUs, containerRef.current.clientWidth);
    };

    chart.on("dataZoom", () => {
      const dz = currentDataZoom(chart);
      if (dz) useWorkspaceStore.getState().setTimelineZoomRange(dz);
      scheduleViewportUpdate();
    });
    const resize = () => {
      chart.resize();
      scheduleViewportUpdate();
    };
    const ro = new ResizeObserver(resize);
    ro.observe(containerRef.current);
    window.addEventListener("resize", resize);
    requestAnimationFrame(resize);
    return () => {
      debouncerRef.current.cancel();
      ro.disconnect();
      window.removeEventListener("resize", resize);
      chart.dispose();
      chartRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
```

Add `useState` to the existing `import { useEffect, useMemo, useRef } from "react";` line, and add:

```tsx
import { viewportFromZoomPercent } from "./viewport";
import { createDebouncer } from "./debounce";
```

- [ ] **Step 2: Fall back to the full Trim Window until the first viewport lands**

Replace the `samples` fetch (`:71-76`):

```tsx
  const signalAlgorithms = useWorkspaceStore((s) => s.signalDownsamplingAlgorithms);
  const effectiveViewport =
    viewport ?? {
      startUs: trimRange?.start ?? 0,
      endUs: trimRange?.end ?? Number.MAX_SAFE_INTEGER,
      pixelWidth: 800,
    };
  const samples = useSignalSamplesList(
    blfPath,
    activeSignalIds,
    effectiveViewport.startUs,
    effectiveViewport.endUs,
    effectiveViewport.pixelWidth,
    signalAlgorithms
  );
  const detectorSql = useWorkspaceStore((s) => s.detectorQuerySql);
  const overlayBins = useAnomalyBinsForViewport(
    blfPath,
    detectorSql,
    effectiveViewport.startUs,
    effectiveViewport.endUs,
    effectiveViewport.pixelWidth
  );
```

Add `useAnomalyBinsForViewport` to the existing `import { useSignalCatalog, useSignalSamplesList } from "@/shared/api/hooks";` line.

- [ ] **Step 3: Use the viewport-scoped bins for the Overlay, not the fixed-500 `anomalyBins`**

Replace the `markAreaData` construction (`:181-196`) to read `overlayBins.data ?? []` instead of the store's `anomalyBins`:

```tsx
    const activeOverlayBins = overlayBins.data ?? [];
    const maxOverlayCount = activeOverlayBins.reduce((m, b) => Math.max(m, b.count), 0);
    const markAreaData =
      maxOverlayCount > 0
        ? activeOverlayBins.map((b) => [
            {
              xAxis: b.startUs,
              itemStyle: {
                color: anomalyBinColor(b.count / maxOverlayCount),
                opacity: ANOMALY_MARK_OPACITY,
              },
            },
            { xAxis: b.endUs },
          ])
        : [];
```

Update the effect's dependency array (`:241`) to include `overlayBins.data` in place of `anomalyBins`, and remove the now-unused `const anomalyBins = useWorkspaceStore((s) => s.anomalyBins);` line (`:70`) - `TimelineZoomControl` keeps its own independent read of that store value unchanged.

- [ ] **Step 4: Typecheck and run the full frontend suite**

Run: `npm run build --prefix app/ui && npm run test --prefix app/ui`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add app/ui/src/widgets/TimelineChart.tsx
git commit -m "feat(ui): wire TimelineChart to viewport-scoped LOD samples and anomaly overlay"
```

---

### Task 10: Per-signal algorithm picker

**Files:**
- Modify: `app/ui/src/widgets/TimelineChart.tsx` (lane label area, `:270-288`)

**Interfaces:**
- Consumes: `signalDownsamplingAlgorithms`, `setSignalDownsamplingAlgorithm` (Task 8).
- Produces: a per-lane dropdown the user can change at any time; takes effect on the next sample fetch (same `queryKey`-driven refetch as a viewport change).

No new automated test - UI-only, same reasoning as Task 9. Verified manually in Task 11.

- [ ] **Step 1: Add the picker to each lane's label row**

In the lane label `<div>` block (`:270-288`), add a small `<select>` next to the existing name/remove button:

```tsx
              <select
                className="ml-1 rounded-sm border border-border bg-background text-[10px]"
                value={signalAlgorithms[lane.signalId] ?? "min_max"}
                onChange={(e) =>
                  useWorkspaceStore
                    .getState()
                    .setSignalDownsamplingAlgorithm(lane.signalId, e.target.value as "min_max" | "lttb")
                }
                aria-label={`Downsampling algorithm for ${lane.name}`}
              >
                <option value="min_max">Min/Max</option>
                <option value="lttb">LTTB</option>
              </select>
```

- [ ] **Step 2: Typecheck**

Run: `npm run build --prefix app/ui`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add app/ui/src/widgets/TimelineChart.tsx
git commit -m "feat(ui): add per-signal downsampling algorithm picker"
```

---

### Task 11: End-to-end manual verification

**Files:** none (verification only)

- [ ] **Step 1: Build everything**

```bash
cargo build --manifest-path crates/Cargo.toml
cargo build --manifest-path app/src-tauri/Cargo.toml
npm run build --prefix app/ui
```

Expected: all three succeed.

- [ ] **Step 2: Run the full automated suite one more time**

```bash
cargo test --manifest-path crates/Cargo.toml
cargo test --manifest-path app/src-tauri/Cargo.toml
npm run test --prefix app/ui
```

Expected: PASS across all three.

- [ ] **Step 3: Exercise the golden path in the running app**

Run `cargo tauri dev --manifest-path app/src-tauri/Cargo.toml`, open a Trace with a signal that has many samples, display it, run a Detector Query that matches a narrow time slice, then zoom into that slice on the Timeline. Confirm: the signal line redraws at a visibly different point density as you zoom (not the same fixed-density scatter); the Anomaly Overlay's bands get narrower/more numerous as you zoom in past where 500 fixed bins would have shown one wide band; `TimelineZoomControl`'s heatmap underneath the slider stays static throughout. Switch one signal's picker to LTTB and confirm the chart redraws with a visibly smoother line for that lane specifically, independent of the other lanes.

- [ ] **Step 4: Confirm no regression in the existing Detector Query flow**

Re-run an existing Detector Query end to end (run, see Matches + the (unchanged) Anomaly Heatmap, click an active heatmap bin to set/apply the Trim Window) - confirm this still works exactly as before, since `run_detector_query`'s fixed-500-bin path was not touched.
