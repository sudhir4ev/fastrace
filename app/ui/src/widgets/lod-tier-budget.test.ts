import { describe, expect, it } from "vitest";
import { lodTierPointBudget } from "./lod-tier-budget";

describe("lodTierPointBudget", () => {
  it("snaps to the next power of two above 2x the pixel width", () => {
    expect(lodTierPointBudget(400)).toBe(1024); // 400*2=800 -> next pow2 1024
  });

  it("clamps a tiny width to the minimum tier", () => {
    expect(lodTierPointBudget(1)).toBe(16);
  });

  it("clamps nonpositive width to the minimum", () => {
    expect(lodTierPointBudget(0)).toBe(16);
    expect(lodTierPointBudget(-50)).toBe(16);
  });

  it("clamps a runaway width to the maximum", () => {
    expect(lodTierPointBudget(1_000_000)).toBe(50000);
  });

  it("is stable within a tier", () => {
    expect(lodTierPointBudget(260)).toBe(lodTierPointBudget(300));
  });
});
