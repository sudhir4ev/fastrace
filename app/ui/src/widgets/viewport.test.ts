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
