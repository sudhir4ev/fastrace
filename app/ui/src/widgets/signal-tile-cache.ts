// Pure logic backing the per-signal frontend tile cache (docs/adr/0012): a
// fixed time grid per (signal, algorithm, tile size), where a tile is
// cached whole or not at all. Coverage is "is this tile index present?",
// never a range comparison or a point-density heuristic.

import type { DownsamplingAlgorithm } from "@/shared/api/trace-source";

export interface TimeRange {
  startUs: number;
  endUs: number;
}

// Snaps the viewport span (scaled by the ratio) up to the next power of
// two, the same stability property lod_tier_point_budget has
// (docs/adr/0009) - small pan/zoom jitter doesn't re-grid every settle,
// only crossing a power-of-two boundary does.
export function tileSpanUs(viewportSpanUs: number, tileSpanRatio: number): number {
  const raw = Math.max(viewportSpanUs, 1) * tileSpanRatio;
  const exp = Math.ceil(Math.log2(Math.max(raw, 1)));
  return 2 ** exp;
}

export function tileIndexForTimestamp(timestampUs: number, spanUs: number): number {
  return Math.floor(timestampUs / spanUs);
}

export function tileRange(index: number, spanUs: number): TimeRange {
  return { startUs: index * spanUs, endUs: (index + 1) * spanUs };
}

function tileIndicesForRange(range: TimeRange, spanUs: number): number[] {
  const startIdx = tileIndexForTimestamp(range.startUs, spanUs);
  const endIdx = tileIndexForTimestamp(range.endUs, spanUs);
  const indices: number[] = [];
  for (let i = startIdx; i <= endIdx; i++) indices.push(i);
  return indices;
}

// The viewport's own tiles plus a margin of whole tiles on each side -
// panning within the margin costs nothing; panning past it needs only the
// newly-entered tile(s).
export function requiredTileIndices(viewport: TimeRange, spanUs: number, marginTileCount: number): number[] {
  const visible = tileIndicesForRange(viewport, spanUs);
  const minIdx = visible[0] - marginTileCount;
  const maxIdx = visible[visible.length - 1] + marginTileCount;
  const result: number[] = [];
  for (let i = minIdx; i <= maxIdx; i++) result.push(i);
  return result;
}

// Groups missing tile indices into contiguous runs so they can be fetched
// as one backend call each, instead of one call per tile.
export function coalesceTileIndices(indices: number[]): [number, number][] {
  if (indices.length === 0) return [];
  const sorted = [...indices].sort((a, b) => a - b);
  const runs: [number, number][] = [];
  let runStart = sorted[0];
  let prev = sorted[0];
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i] === prev + 1) {
      prev = sorted[i];
      continue;
    }
    runs.push([runStart, prev]);
    runStart = sorted[i];
    prev = sorted[i];
  }
  runs.push([runStart, prev]);
  return runs;
}

export function tileKey(
  signalId: number,
  algorithm: DownsamplingAlgorithm,
  spanUs: number,
  tileIndex: number
): string {
  return `${signalId}:${algorithm}:${spanUs}:${tileIndex}`;
}
