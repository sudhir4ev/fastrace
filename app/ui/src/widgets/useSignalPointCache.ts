import { useEffect, useRef, useState } from "react";
import { LOD_CONFIG } from "@/app/config";
import { getTraceDataSource } from "@/shared/api/trace-source";
import type { DownsamplingAlgorithm } from "@/shared/api/trace-source";
import { lodTierPointBudget } from "./lod-tier-budget";
import {
  computeCacheGaps,
  computeWantedRange,
  evictToCap,
  isDensityInsufficient,
  mergeCachedRange,
  replaceRange,
  type CachedRange,
  type TimeRange,
} from "./signal-cache";

// React-side orchestration for docs/adr/0011's frontend point cache: pan is
// served from cache with edge gap-fills, zoom only refetches when the cache
// is too sparse for the new tier, algorithm/Trim-Window changes invalidate,
// and the cache is capped/evicted per signal. The cache math itself lives in
// signal-cache.ts / lod-tier-budget.ts, which are unit-tested directly;
// this hook is the untested glue (same convention as the rest of this
// component's effects - no DOM test environment in this repo).
export function useSignalPointCache(
  blfPath: string,
  signalIds: number[],
  viewport: { startUs: number; endUs: number; pixelWidth: number },
  algorithms: Record<number, DownsamplingAlgorithm>,
  trimRange: TimeRange | null
): Record<number, [number, number][]> {
  const cacheRef = useRef<Map<string, CachedRange>>(new Map());
  const trimKeyRef = useRef<string | null>(null);
  const [pointsBySignal, setPointsBySignal] = useState<Record<number, [number, number][]>>({});

  const signalIdsKey = signalIds.join(",");
  const algorithmsKey = signalIds.map((id) => `${id}:${algorithms[id] ?? "min_max"}`).join(",");

  useEffect(() => {
    const trimKey = trimRange ? `${trimRange.startUs}:${trimRange.endUs}` : null;
    if (trimKeyRef.current !== null && trimKeyRef.current !== trimKey) {
      cacheRef.current.clear();
    }
    trimKeyRef.current = trimKey;

    let cancelled = false;
    const wanted = computeWantedRange(viewport, LOD_CONFIG.cacheMarginRatio);
    const budget = lodTierPointBudget(viewport.pixelWidth);

    // Per-signal fetches run concurrently (not one-at-a-time) and each
    // signal's result is applied to state as soon as it resolves - with N
    // displayed signals each needing up to two gap fetches, a sequential
    // await-in-a-loop could take N*2 round trips before anything painted,
    // and a cancellation partway through (the next pan/zoom landing before
    // that finished) discarded the whole batch, not just the slow signal.
    async function fetchSignal(signalId: number) {
      const algorithm: DownsamplingAlgorithm = algorithms[signalId] ?? "min_max";
      const key = `${signalId}:${algorithm}`;
      let cached = cacheRef.current.get(key) ?? null;

      const gaps = computeCacheGaps(cached, wanted);
      for (const gap of gaps) {
        const points = await getTraceDataSource().getSignalSamples(
          blfPath,
          signalId,
          gap.startUs,
          gap.endUs,
          viewport.pixelWidth,
          algorithm
        );
        if (cancelled) return;
        cached = mergeCachedRange(cached, { startUs: gap.startUs, endUs: gap.endUs, points });
      }

      if (gaps.length === 0 && isDensityInsufficient(cached, viewport, budget, LOD_CONFIG.cacheDensityThresholdRatio)) {
        const points = await getTraceDataSource().getSignalSamples(
          blfPath,
          signalId,
          viewport.startUs,
          viewport.endUs,
          viewport.pixelWidth,
          algorithm
        );
        if (cancelled) return;
        cached = replaceRange(cached, viewport, { startUs: viewport.startUs, endUs: viewport.endUs, points });
      }

      if (cached) {
        cached = evictToCap(cached, viewport, LOD_CONFIG.cacheMarginRatio, LOD_CONFIG.maxClientCachePoints);
        cacheRef.current.set(key, cached);
      }
      if (!cancelled) {
        const resolvedPoints = cached?.points ?? [];
        setPointsBySignal((prev) => ({ ...prev, [signalId]: resolvedPoints }));
      }
    }

    Promise.all(signalIds.map(fetchSignal));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [blfPath, signalIdsKey, algorithmsKey, viewport.startUs, viewport.endUs, viewport.pixelWidth, trimRange?.startUs, trimRange?.endUs]);

  return pointsBySignal;
}
