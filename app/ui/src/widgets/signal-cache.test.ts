import { describe, expect, it } from "vitest";
import {
  computeCacheGaps,
  computeWantedRange,
  evictToCap,
  isDensityInsufficient,
  isRangeCovered,
  mergeCachedRange,
  pointCountInRange,
  replaceRange,
  type CachedRange,
} from "./signal-cache";

describe("computeWantedRange", () => {
  it("pads the viewport by the margin ratio on both sides", () => {
    expect(computeWantedRange({ startUs: 1000, endUs: 2000 }, 0.5)).toEqual({
      startUs: 500,
      endUs: 2500,
    });
  });
});

describe("isRangeCovered", () => {
  it("is false when there is no cache yet", () => {
    expect(isRangeCovered(null, { startUs: 0, endUs: 100 })).toBe(false);
  });

  it("is true when the cache fully contains the wanted range", () => {
    const cache: CachedRange = { startUs: 0, endUs: 1000, points: [] };
    expect(isRangeCovered(cache, { startUs: 100, endUs: 900 })).toBe(true);
  });

  it("is false when the wanted range extends past either edge", () => {
    const cache: CachedRange = { startUs: 100, endUs: 900, points: [] };
    expect(isRangeCovered(cache, { startUs: 0, endUs: 900 })).toBe(false);
    expect(isRangeCovered(cache, { startUs: 100, endUs: 1000 })).toBe(false);
  });
});

describe("computeCacheGaps", () => {
  it("returns the whole wanted range when there is no cache", () => {
    const wanted = { startUs: 0, endUs: 100 };
    expect(computeCacheGaps(null, wanted)).toEqual([wanted]);
  });

  it("returns no gaps when fully covered", () => {
    const cache: CachedRange = { startUs: 0, endUs: 1000, points: [] };
    expect(computeCacheGaps(cache, { startUs: 100, endUs: 900 })).toEqual([]);
  });

  it("returns only the missing edge sliver on a partial overlap", () => {
    const cache: CachedRange = { startUs: 500, endUs: 1000, points: [] };
    expect(computeCacheGaps(cache, { startUs: 0, endUs: 1000 })).toEqual([{ startUs: 0, endUs: 500 }]);
  });

  it("returns both edge slivers when the wanted range straddles the cache on both sides", () => {
    const cache: CachedRange = { startUs: 400, endUs: 600, points: [] };
    expect(computeCacheGaps(cache, { startUs: 0, endUs: 1000 })).toEqual([
      { startUs: 0, endUs: 400 },
      { startUs: 600, endUs: 1000 },
    ]);
  });
});

describe("pointCountInRange", () => {
  it("counts only points inside the range, inclusive", () => {
    const cache: CachedRange = {
      startUs: 0,
      endUs: 100,
      points: [
        [0, 1],
        [50, 2],
        [100, 3],
        [150, 4],
      ],
    };
    expect(pointCountInRange(cache, { startUs: 0, endUs: 100 })).toBe(3);
  });

  it("is 0 for a null cache", () => {
    expect(pointCountInRange(null, { startUs: 0, endUs: 100 })).toBe(0);
  });
});

describe("isDensityInsufficient", () => {
  it("is true when the cached count falls more than the threshold short of the budget", () => {
    const cache: CachedRange = { startUs: 0, endUs: 100, points: [[50, 1]] };
    expect(isDensityInsufficient(cache, { startUs: 0, endUs: 100 }, 10, 0.2)).toBe(true);
  });

  it("is false when the cached count is within the threshold of the budget", () => {
    const cache: CachedRange = {
      startUs: 0,
      endUs: 100,
      points: Array.from({ length: 9 }, (_, i) => [i * 10, i] as [number, number]),
    };
    expect(isDensityInsufficient(cache, { startUs: 0, endUs: 100 }, 10, 0.2)).toBe(false);
  });
});

describe("mergeCachedRange", () => {
  it("adopts the fetched range outright when there was nothing cached yet", () => {
    const fetched: CachedRange = { startUs: 0, endUs: 100, points: [[0, 1]] };
    expect(mergeCachedRange(null, fetched)).toEqual(fetched);
  });

  it("unions the extent and merges points sorted by timestamp, deduping by timestamp", () => {
    const existing: CachedRange = {
      startUs: 0,
      endUs: 100,
      points: [
        [0, 1],
        [100, 2],
      ],
    };
    const fetched: CachedRange = {
      startUs: 100,
      endUs: 200,
      points: [
        [100, 99],
        [200, 3],
      ],
    };
    expect(mergeCachedRange(existing, fetched)).toEqual({
      startUs: 0,
      endUs: 200,
      points: [
        [0, 1],
        [100, 99],
        [200, 3],
      ],
    });
  });
});

describe("replaceRange", () => {
  it("replaces only the points inside the densified range, keeping the rest", () => {
    const existing: CachedRange = {
      startUs: 0,
      endUs: 300,
      points: [
        [0, 1],
        [100, 2],
        [200, 3],
        [300, 4],
      ],
    };
    const fetched: CachedRange = {
      startUs: 100,
      endUs: 200,
      points: [
        [100, 99],
        [150, 99],
        [200, 99],
      ],
    };
    expect(replaceRange(existing, { startUs: 100, endUs: 200 }, fetched)).toEqual({
      startUs: 0,
      endUs: 300,
      points: [
        [0, 1],
        [100, 99],
        [150, 99],
        [200, 99],
        [300, 4],
      ],
    });
  });
});

describe("evictToCap", () => {
  it("leaves the cache untouched when at or under the cap", () => {
    const cache: CachedRange = { startUs: 0, endUs: 100, points: [[50, 1]] };
    expect(evictToCap(cache, { startUs: 0, endUs: 100 }, 0.5, 1)).toBe(cache);
  });

  it("evicts from the edge farthest from the viewport first", () => {
    // viewport is [600,700]; left edge (0) is 600 away, right edge (1000) is 300 away -> evict left first
    const points: [number, number][] = [
      [0, 1],
      [200, 2],
      [400, 3],
      [600, 4],
      [1000, 5],
    ];
    const cache: CachedRange = { startUs: 0, endUs: 1000, points };
    const result = evictToCap(cache, { startUs: 600, endUs: 700 }, 0.5, 4);
    expect(result.points).toHaveLength(4);
    expect(result.points[0][0]).toBe(200);
  });

  it("never trims past the viewport ± margin window", () => {
    const points: [number, number][] = [
      [0, 1],
      [100, 2],
      [200, 3],
    ];
    const cache: CachedRange = { startUs: 0, endUs: 200, points };
    // wanted window at marginRatio 0.5 for viewport [50,150] is [0,200] - nothing outside it to trim.
    const result = evictToCap(cache, { startUs: 50, endUs: 150 }, 0.5, 1);
    expect(result.points).toHaveLength(3);
  });
});
