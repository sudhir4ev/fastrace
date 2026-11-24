import { describe, expect, it } from "vitest";
import { MIN_PIXELS_PER_POINT_FOR_DOTS, shouldShowDots } from "./dot-visibility";

describe("shouldShowDots", () => {
  it("shows dots when points are spaced well apart on screen", () => {
    expect(shouldShowDots(10, 800)).toBe(true); // 80px/point
  });

  it("hides dots when points are packed too densely to distinguish", () => {
    expect(shouldShowDots(1000, 800)).toBe(false); // 0.8px/point
  });

  it("shows dots for 0 or 1 points regardless of pixel width", () => {
    expect(shouldShowDots(0, 100)).toBe(true);
    expect(shouldShowDots(1, 100)).toBe(true);
  });

  it("is inclusive at exactly the threshold spacing", () => {
    expect(shouldShowDots(100, 100 * MIN_PIXELS_PER_POINT_FOR_DOTS)).toBe(true);
  });

  it("honors a custom threshold", () => {
    expect(shouldShowDots(10, 800, 1000)).toBe(false);
  });
});
