import { describe, expect, it } from "vitest";
import { buildTimelineDiagnostics } from "./diagnostics";

describe("buildTimelineDiagnostics", () => {
  it("pairs each lane with its point count and algorithm", () => {
    const result = buildTimelineDiagnostics({
      viewport: { startUs: 1000, endUs: 2000, pixelWidth: 800 },
      lanes: [
        { signalId: 1, name: "EngineRpm" },
        { signalId: 2, name: "VehicleSpeed" },
      ],
      pointCounts: { 1: 512, 2: 128 },
      algorithms: { 2: "lttb" },
      overlayBinCount: 7,
      overlayError: null,
    });
    expect(result).toEqual({
      viewport: { startUs: 1000, endUs: 2000, pixelWidth: 800 },
      signals: [
        // 800px / 512 points = 1.56px/point - too dense, line only.
        { signalId: 1, name: "EngineRpm", algorithm: "min_max", pointCount: 512, showingDots: false },
        // 800px / 128 points = 6.25px/point - spaced out enough for dots.
        { signalId: 2, name: "VehicleSpeed", algorithm: "lttb", pointCount: 128, showingDots: true },
      ],
      overlayBinCount: 7,
      overlayError: null,
    });
  });

  it("defaults a lane's missing point count to 0 and missing algorithm to min_max", () => {
    const result = buildTimelineDiagnostics({
      viewport: { startUs: 0, endUs: 1, pixelWidth: 1 },
      lanes: [{ signalId: 9, name: "Unseen" }],
      pointCounts: {},
      algorithms: {},
      overlayBinCount: 0,
      overlayError: null,
    });
    expect(result.signals).toEqual([
      { signalId: 9, name: "Unseen", algorithm: "min_max", pointCount: 0, showingDots: true },
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
});
