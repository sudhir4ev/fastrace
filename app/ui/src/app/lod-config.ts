// Tunable thresholds for the LOD (Level of Detail) rendering pipeline
// (`docs/adr/0009`). Keep every magic number that affects when/how much
// the Timeline chart downsamples or changes rendering mode here, so tuning
// doesn't require hunting through TimelineChart.tsx.
//
// Rust-side LOD constants (MIN_LOD_TARGET_POINTS, MAX_LOD_TARGET_POINTS,
// ANOMALY_BIN_COUNT, DETECTOR_QUERY_MATCH_LIMIT - crates/query/src/lib.rs)
// are not duplicated here: they govern the backend's point budget/bin math
// and have no frontend-side equivalent to unify with.

/** Minimum average on-screen spacing (px) between rendered points before
 * dots are shown instead of just the connecting line. */
export const MIN_PIXELS_PER_POINT_FOR_DOTS = 6;

/** Debounce delay (ms) between a pan/zoom/resize event and recomputing the
 * viewport-scoped LOD fetch - avoids refetching on every drag frame. */
export const VIEWPORT_DEBOUNCE_MS = 200;

/** Fallback pixel width used for the first render, before the chart's
 * container has been measured and the debounced viewport has landed. */
export const DEFAULT_PIXEL_WIDTH_FALLBACK = 800;

/** Opacity of the Anomaly Overlay's markArea bands. */
export const ANOMALY_MARK_OPACITY = 0.28;
