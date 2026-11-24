//! Tunable thresholds for the query/LOD pipeline (`docs/adr/0009`). Kept in
//! one place so tuning doesn't require hunting through `lib.rs`.
//!
//! The frontend has its own config module for rendering-only thresholds
//! (`app/ui/src/app/config.ts` - dot visibility, debounce, etc.). The two
//! are deliberately not unified: this module governs the LOD Tier
//! point-budget math and other server-side caps, which have no frontend
//! equivalent to merge with.

/// Minimum LOD Tier point budget (see `lod_tier_point_budget`) - guards a
/// not-yet-laid-out container (`pixel_width <= 0`) from collapsing to a
/// degenerate, empty-looking chart.
pub const MIN_LOD_TARGET_POINTS: i64 = 16;

/// Maximum LOD Tier point budget - guards a pathologically wide container
/// from requesting a runaway number of points.
pub const MAX_LOD_TARGET_POINTS: i64 = 50_000;

/// Fixed anomaly-bin segmentation over a Detector Query's run scope - feeds
/// the Anomaly Heatmap (`TimelineZoomControl`), which stays fixed regardless
/// of LOD Tier (`docs/adr/0009`).
pub const ANOMALY_BIN_COUNT: i64 = 500;

/// Safety cap on rows read for a single Detector Query match extract, and
/// reused as the raw-row cap for LTTB's capped fetch
/// (`list_signal_samples_lttb`).
pub const DETECTOR_QUERY_MATCH_LIMIT: i64 = 200_000;
