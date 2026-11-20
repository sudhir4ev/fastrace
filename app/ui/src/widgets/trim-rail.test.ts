import { describe, expect, it } from "vitest";
import {
  DECODED_BAND,
  TRIM_BINS,
  UNREAD_BAND,
  binBandsFromCoverageUs,
  binToUs,
  buildTrimRailOption,
  coverageSpansForActive,
  mergeUsSpans,
} from "./trim-rail";

describe("TRIM_BINS", () => {
  it("is 500", () => {
    expect(TRIM_BINS).toBe(500);
  });
});

describe("mergeUsSpans", () => {
  it("merges overlapping and adjacent intervals", () => {
    expect(
      mergeUsSpans([
        [100, 200],
        [150, 250],
        [251, 300],
        [500, 600],
      ])
    ).toEqual([
      [100, 300],
      [500, 600],
    ]);
  });

  it("returns empty for empty input", () => {
    expect(mergeUsSpans([])).toEqual([]);
  });
});

describe("binBandsFromCoverageUs", () => {
  // 1 bin = 1000 µs across a 500-bin rail
  const minUs = 0;
  const maxUs = 500_000;

  it("returns empty when there is no coverage", () => {
    expect(binBandsFromCoverageUs([], minUs, maxUs)).toEqual([]);
  });

  it("maps last-two-bin coverage to [[498, 500]] over the full domain", () => {
    // Interior of bins 498–499 (avoid edge rounding that touches adjacent bins).
    const lo = binToUs(498, minUs, maxUs) + 1;
    const hi = binToUs(500, minUs, maxUs) - 1;
    expect(binBandsFromCoverageUs([[lo, hi]], minUs, maxUs)).toEqual([[498, 500]]);
  });

  it("does not paint the whole rail when only the last bins are covered", () => {
    const lo = binToUs(498, minUs, maxUs) + 1;
    const hi = binToUs(500, minUs, maxUs) - 1;
    const bands = binBandsFromCoverageUs([[lo, hi]], minUs, maxUs);
    expect(bands).toHaveLength(1);
    expect(bands[0][0]).toBeGreaterThan(0);
    expect(bands[0]).not.toEqual([0, TRIM_BINS]);
  });

  it("maps a mid-rail span to only those bins", () => {
    const lo = binToUs(50, minUs, maxUs) + 1;
    const hi = binToUs(52, minUs, maxUs) - 1;
    expect(binBandsFromCoverageUs([[lo, hi]], minUs, maxUs)).toEqual([[50, 52]]);
  });
});

describe("coverageSpansForActive", () => {
  const rows = [
    { signalId: 1, startUs: 0, endUs: 10_000 },
    { signalId: 2, startUs: 490_000, endUs: 500_000 },
  ];

  it("keeps all rows when activeIds is empty", () => {
    expect(coverageSpansForActive(rows, new Set())).toEqual([
      [0, 10_000],
      [490_000, 500_000],
    ]);
  });

  it("ignores non-active signals", () => {
    expect(coverageSpansForActive(rows, new Set([2]))).toEqual([[490_000, 500_000]]);
  });
});

describe("buildTrimRailOption", () => {
  it("keeps cache bands on axis 0 and dataZoom on axis 1", () => {
    const option = buildTrimRailOption([[498, 500]]);

    expect(option.xAxis).toHaveLength(2);
    expect(option.xAxis[0]).toMatchObject({ min: 0, max: TRIM_BINS });
    expect(option.xAxis[1]).toMatchObject({ min: 0, max: TRIM_BINS });

    expect(option.dataZoom).toHaveLength(1);
    expect(option.dataZoom[0].xAxisIndex).toBe(1);

    expect(option.series[0].xAxisIndex).toBe(0);
    expect(option.series[1].xAxisIndex).toBe(1);

    const markArea = option.series[0].markArea.data;
    expect(markArea[0]).toEqual([
      { xAxis: 0, itemStyle: { color: UNREAD_BAND } },
      { xAxis: TRIM_BINS },
    ]);
    expect(markArea[1]).toEqual([
      { xAxis: 498, itemStyle: { color: DECODED_BAND } },
      { xAxis: 500 },
    ]);
    expect(markArea).toHaveLength(2);
  });
});
