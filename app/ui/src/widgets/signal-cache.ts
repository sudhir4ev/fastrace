// Pure logic backing the per-signal frontend point cache (docs/adr/0011):
// pan is served from cache with a gap-fill at the edges, zoom only refetches
// when the cache is too sparse for the new tier, and the cache is capped and
// evicted from whichever edge is farthest from the current viewport.

export interface TimeRange {
  startUs: number;
  endUs: number;
}

export interface CachedRange extends TimeRange {
  points: [number, number][]; // sorted ascending by timestamp
}

export function computeWantedRange(viewport: TimeRange, marginRatio: number): TimeRange {
  const margin = (viewport.endUs - viewport.startUs) * marginRatio;
  return { startUs: viewport.startUs - margin, endUs: viewport.endUs + margin };
}

export function isRangeCovered(cache: CachedRange | null, wanted: TimeRange): boolean {
  if (!cache) return false;
  return cache.startUs <= wanted.startUs && cache.endUs >= wanted.endUs;
}

export function computeCacheGaps(cache: CachedRange | null, wanted: TimeRange): TimeRange[] {
  if (!cache) return [wanted];
  const gaps: TimeRange[] = [];
  if (wanted.startUs < cache.startUs) gaps.push({ startUs: wanted.startUs, endUs: cache.startUs });
  if (wanted.endUs > cache.endUs) gaps.push({ startUs: cache.endUs, endUs: wanted.endUs });
  return gaps;
}

export function pointCountInRange(cache: CachedRange | null, range: TimeRange): number {
  if (!cache) return 0;
  let count = 0;
  for (const [ts] of cache.points) {
    if (ts >= range.startUs && ts <= range.endUs) count++;
  }
  return count;
}

export function isDensityInsufficient(
  cache: CachedRange | null,
  viewport: TimeRange,
  budget: number,
  thresholdRatio: number
): boolean {
  return pointCountInRange(cache, viewport) < budget * (1 - thresholdRatio);
}

export function mergeCachedRange(existing: CachedRange | null, fetched: CachedRange): CachedRange {
  if (!existing) return fetched;
  const byTimestamp = new Map<number, [number, number]>();
  for (const p of existing.points) byTimestamp.set(p[0], p);
  for (const p of fetched.points) byTimestamp.set(p[0], p);
  const points = Array.from(byTimestamp.values()).sort((a, b) => a[0] - b[0]);
  return {
    startUs: Math.min(existing.startUs, fetched.startUs),
    endUs: Math.max(existing.endUs, fetched.endUs),
    points,
  };
}

// Densify: swaps in a denser refetch for exactly the under-dense region,
// leaving whatever was cached outside it untouched.
export function replaceRange(existing: CachedRange | null, range: TimeRange, fetched: CachedRange): CachedRange {
  const outside = (existing?.points ?? []).filter(([ts]) => ts < range.startUs || ts > range.endUs);
  const points = [...outside, ...fetched.points].sort((a, b) => a[0] - b[0]);
  return {
    startUs: Math.min(existing?.startUs ?? range.startUs, fetched.startUs),
    endUs: Math.max(existing?.endUs ?? range.endUs, fetched.endUs),
    points,
  };
}

export function evictToCap(
  cache: CachedRange,
  viewport: TimeRange,
  marginRatio: number,
  maxPoints: number
): CachedRange {
  if (cache.points.length <= maxPoints) return cache;
  const wanted = computeWantedRange(viewport, marginRatio);
  const points = cache.points.slice();
  while (points.length > maxPoints) {
    const canTrimLeft = points[0][0] < wanted.startUs;
    const canTrimRight = points[points.length - 1][0] > wanted.endUs;
    if (!canTrimLeft && !canTrimRight) break;
    const distLeft = viewport.startUs - points[0][0];
    const distRight = points[points.length - 1][0] - viewport.endUs;
    if (canTrimLeft && (distLeft >= distRight || !canTrimRight)) {
      points.shift();
    } else {
      points.pop();
    }
  }
  return {
    startUs: points.length ? points[0][0] : wanted.startUs,
    endUs: points.length ? points[points.length - 1][0] : wanted.endUs,
    points,
  };
}
