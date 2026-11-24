import { describe, expect, it } from "vitest";
import { LOD_CONFIG } from "@/app/config";
import { buildTimelineDiagnostics } from "./diagnostics";
import { tileSpanUs } from "./signal-tile-cache";

describe("buildTimelineDiagnostics", () => {
  it("pairs each lane with its point count, algorithm, and effective downsampling rate", () => {
    const result = buildTimelineDiagnostics({
      viewport: { startUs: 1000, endUs: 2000, pixelWidth: 800 },
      lanes: [
        { signalId: 1, name: "EngineRpm" },
        { signalId: 2, name: "VehicleSpeed" },
      ],
      pointCounts: { 1: 512, 2: 100 },
      algorithms: { 2: "lttb" },
      overlayBinCount: 7,
      overlayError: null,
    });
    expect(result).toEqual({
      viewport: { startUs: 1000, endUs: 2000, pixelWidth: 800, tileSpanUs: tileSpanUs(1000, LOD_CONFIG.tileSpanRatio) },
      signals: [
        // 800px / 512 points = 1.56px/point - too dense, line only.
        // 1000us viewport / 512 points = ~1.95us represented per point.
        {
          signalId: 1,
          name: "EngineRpm",
          algorithm: "min_max",
          pointCount: 512,
          showingDots: false,
          avgSampleIntervalUs: 1000 / 512,
        },
        // 800px / 100 points = 8px/point - spaced out enough for dots.
        // 1000us viewport / 100 points = 10us represented per point.
        {
          signalId: 2,
          name: "VehicleSpeed",
          algorithm: "lttb",
          pointCount: 100,
          showingDots: true,
          avgSampleIntervalUs: 10,
        },
      ],
      overlayBinCount: 7,
      overlayError: null,
    });
  });

  it("defaults a lane's missing point count to 0, missing algorithm to min_max, and a null sample interval", () => {
    const result = buildTimelineDiagnostics({
      viewport: { startUs: 0, endUs: 1, pixelWidth: 1 },
      lanes: [{ signalId: 9, name: "Unseen" }],
      pointCounts: {},
      algorithms: {},
      overlayBinCount: 0,
      overlayError: null,
    });
    expect(result.signals).toEqual([
      {
        signalId: 9,
        name: "Unseen",
        algorithm: "min_max",
        pointCount: 0,
        showingDots: true,
        avgSampleIntervalUs: null,
      },
    ]);
  });

  it("passes the overlay error through unchanged", () => {
    const result = buildTimelineDiagnostics({
      viewport: { startUs: 0, endUs: 1, pixelWidth: 1 },
      lanes: [],
      pointCounts: {},
      algorithms: {},
      overlayBinCount: 0,
      overlayError: "bad sql",
    });
    expect(result.overlayError).toBe("bad sql");
  });

  it("widens the reported tile span as the viewport widens, confirming stronger downsampling on zoom out", () => {
    const narrow = buildTimelineDiagnostics({
      viewport: { startUs: 0, endUs: 1_000, pixelWidth: 800 },
      lanes: [],
      pointCounts: {},
      algorithms: {},
      overlayBinCount: 0,
      overlayError: null,
    });
    const wide = buildTimelineDiagnostics({
      viewport: { startUs: 0, endUs: 1_000_000, pixelWidth: 800 },
      lanes: [],
      pointCounts: {},
      algorithms: {},
      overlayBinCount: 0,
      overlayError: null,
    });
    expect(wide.viewport.tileSpanUs).toBeGreaterThan(narrow.viewport.tileSpanUs);
  });
});
