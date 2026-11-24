import { LOD_CONFIG } from "@/app/config";

// Mirrors crates/query/src/lib.rs's lod_tier_point_budget exactly, so the
// cache's zoom-density check (docs/adr/0011) compares against the same
// point budget the backend would have used for this pixel width.
export function lodTierPointBudget(pixelWidth: number): number {
  const raw = Math.max(pixelWidth, 1) * 2;
  const tierExp = Math.max(Math.ceil(Math.log2(raw)), 0);
  const budget = 2 ** tierExp;
  return Math.min(Math.max(budget, LOD_CONFIG.minLodTargetPoints), LOD_CONFIG.maxLodTargetPoints);
}
