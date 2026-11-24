//! Tunable thresholds for the query/LOD pipeline (`docs/adr/0009`), read
//! from `config/config.json` at the repo root - the single source of truth
//! shared with the frontend (`app/ui/src/app/config.ts` reads the same
//! file). Embedded into the binary at compile time via `include_str!`, not
//! read from disk at runtime, so there's no path-resolution problem inside
//! a packaged Tauri app: edit the JSON file and rebuild.

use serde::Deserialize;
use std::sync::LazyLock;

const CONFIG_JSON: &str = include_str!("../../../config/config.json");

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ConfigFile {
    lod: LodConfig,
}

/// The LOD section of `config/config.json`. Some fields (the dot-visibility
/// threshold, debounce, etc.) are frontend-only and unused here, but are
/// still present in the shared file and simply ignored on deserialize.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LodConfig {
    /// Minimum LOD Tier point budget (see `lod_tier_point_budget`) - guards
    /// a not-yet-laid-out container (`pixel_width <= 0`) from collapsing to
    /// a degenerate, empty-looking chart.
    pub min_lod_target_points: i64,
    /// Maximum LOD Tier point budget - guards a pathologically wide
    /// container from requesting a runaway number of points.
    pub max_lod_target_points: i64,
    /// Fixed anomaly-bin segmentation over a Detector Query's run scope -
    /// feeds the Anomaly Heatmap (`TimelineZoomControl`), which stays fixed
    /// regardless of LOD Tier.
    pub anomaly_bin_count: i64,
    /// Safety cap on rows read for a single Detector Query match extract,
    /// and reused as the raw-row cap for LTTB's capped fetch
    /// (`list_signal_samples_lttb`).
    pub detector_query_match_limit: i64,
}

pub static LOD: LazyLock<LodConfig> = LazyLock::new(|| {
    let parsed: ConfigFile =
        serde_json::from_str(CONFIG_JSON).expect("config/config.json must parse");
    parsed.lod
});
