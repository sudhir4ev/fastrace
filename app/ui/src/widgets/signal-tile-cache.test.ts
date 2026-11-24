import { describe, expect, it } from "vitest";
import {
  coalesceTileIndices,
  requiredTileIndices,
  tileIndexForTimestamp,
  tileKey,
  tileRange,
  tileSpanUs,
} from "./signal-tile-cache";

describe("tileSpanUs", () => {
  it("snaps the viewport span (times the ratio) up to the next power of two", () => {
    expect(tileSpanUs(1000, 1)).toBe(1024);
  });

  it("scales with the ratio before snapping", () => {
    expect(tileSpanUs(1000, 2)).toBe(2048);
  });

  it("is stable across spans that snap to the same power of two", () => {
    expect(tileSpanUs(600, 1)).toBe(tileSpanUs(700, 1));
  });

  it("never returns a span below 1", () => {
    expect(tileSpanUs(0, 1)).toBeGreaterThanOrEqual(1);
  });
});

describe("tileIndexForTimestamp", () => {
  it("floors to the tile the timestamp falls in", () => {
    expect(tileIndexForTimestamp(0, 100)).toBe(0);
    expect(tileIndexForTimestamp(99, 100)).toBe(0);
    expect(tileIndexForTimestamp(100, 100)).toBe(1);
    expect(tileIndexForTimestamp(250, 100)).toBe(2);
  });

  it("floors negative timestamps toward negative infinity, not toward zero", () => {
    expect(tileIndexForTimestamp(-1, 100)).toBe(-1);
    expect(tileIndexForTimestamp(-150, 100)).toBe(-2);
  });
});

describe("tileRange", () => {
  it("returns the tile's [start, end) bounds", () => {
    expect(tileRange(2, 100)).toEqual({ startUs: 200, endUs: 300 });
  });
});

describe("requiredTileIndices", () => {
  it("covers the viewport's own tiles with no margin", () => {
    // viewport [150,250] at span 100 -> tiles 1 and 2
    expect(requiredTileIndices({ startUs: 150, endUs: 250 }, 100, 0)).toEqual([1, 2]);
  });

  it("adds a margin of whole tiles on each side", () => {
    expect(requiredTileIndices({ startUs: 150, endUs: 250 }, 100, 1)).toEqual([0, 1, 2, 3]);
  });

  it("handles a viewport narrower than one tile", () => {
    expect(requiredTileIndices({ startUs: 110, endUs: 120 }, 100, 0)).toEqual([1]);
  });
});

describe("coalesceTileIndices", () => {
  it("groups contiguous indices into one run", () => {
    expect(coalesceTileIndices([1, 2, 3])).toEqual([[1, 3]]);
  });

  it("keeps non-contiguous indices as separate runs", () => {
    expect(coalesceTileIndices([0, 1, 5, 6, 7, 10])).toEqual([
      [0, 1],
      [5, 7],
      [10, 10],
    ]);
  });

  it("is unaffected by input order", () => {
    expect(coalesceTileIndices([3, 1, 2])).toEqual([[1, 3]]);
  });

  it("returns an empty array for no missing tiles", () => {
    expect(coalesceTileIndices([])).toEqual([]);
  });
});

describe("tileKey", () => {
  it("is unique per signal, algorithm, span, and tile index", () => {
    expect(tileKey(1, "min_max", 100, 2)).toBe("1:min_max:100:2");
    expect(tileKey(1, "min_max", 100, 2)).not.toBe(tileKey(1, "lttb", 100, 2));
    expect(tileKey(1, "min_max", 100, 2)).not.toBe(tileKey(1, "min_max", 200, 2));
  });
});
