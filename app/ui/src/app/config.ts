// Single source of truth for every LOD/query tunable, shared with the Rust
// side (`crates/query/src/config.rs` reads the same file). Edit
// `config/config.json` at the repo root, not this file, to change a value.
import rawConfig from "../../../../config/config.json";

export interface LodConfig {
  minLodTargetPoints: number;
  maxLodTargetPoints: number;
  anomalyBinCount: number;
  detectorQueryMatchLimit: number;
  minPixelsPerPointForDots: number;
  viewportDebounceMs: number;
  defaultPixelWidthFallback: number;
  anomalyMarkOpacity: number;
  maxClientCachePoints: number;
  cacheMarginRatio: number;
  cacheDensityThresholdRatio: number;
}

interface ConfigFile {
  lod: LodConfig;
}

export const LOD_CONFIG: LodConfig = (rawConfig as ConfigFile).lod;
