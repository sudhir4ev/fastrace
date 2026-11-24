import { useEffect, useRef, useState } from "react";
import { LOD_CONFIG } from "@/app/config";
import { getTraceDataSource } from "@/shared/api/trace-source";
import type { DownsamplingAlgorithm } from "@/shared/api/trace-source";
import {
  coalesceTileIndices,
  requiredTileIndices,
  tileKey,
  tileRange,
  tileSpanUs,
  type TimeRange,
} from "./signal-tile-cache";

// React-side orchestration for docs/adr/0012's frontend tile cache: a
// fixed time grid per (signal, algorithm, tile size), where a tile is
// cached whole or not at all. The grid/key math lives in
// signal-tile-cache.ts, which is unit-tested directly; this hook is the
// untested glue (same convention as the rest of this component's effects
// - no DOM test environment in this repo).
export function useSignalTileCache(
  blfPath: string,
  signalIds: number[],
  viewport: { startUs: number; endUs: number; pixelWidth: number },
  algorithms: Record<number, DownsamplingAlgorithm>,
  trimRange: TimeRange | null
): Record<number, [number, number][]> {
  // tileKey -> that tile's points. A tile is either fully present or
  // absent - never partially filled, never merged with another tile.
  const cacheRef = useRef<Map<string, [number, number][]>>(new Map());
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
    const span = tileSpanUs(viewport.endUs - viewport.startUs, LOD_CONFIG.tileSpanRatio);
    const required = requiredTileIndices(viewport, span, LOD_CONFIG.tileMarginTileCount);

    async function fetchSignal(signalId: number) {
      const algorithm: DownsamplingAlgorithm = algorithms[signalId] ?? "min_max";
      const prefix = `${signalId}:${algorithm}:`;

      // Eviction is a set-membership filter, not a trim: drop every tile
      // for this signal that isn't in the current required set, whether
      // because it's outside the margin window or because a zoom crossed
      // into a different tile size (its key carries the old span).
      for (const key of Array.from(cacheRef.current.keys())) {
        if (!key.startsWith(prefix)) continue;
        const [, , keySpanStr, keyIdxStr] = key.split(":");
        const keySpan = Number(keySpanStr);
        const keyIdx = Number(keyIdxStr);
        if (keySpan !== span || !required.includes(keyIdx)) {
          cacheRef.current.delete(key);
        }
      }

      const missing = required.filter((idx) => !cacheRef.current.has(tileKey(signalId, algorithm, span, idx)));
      const runs = coalesceTileIndices(missing);
      for (const [startIdx, endIdx] of runs) {
        const fetchRange = { startUs: tileRange(startIdx, span).startUs, endUs: tileRange(endIdx, span).endUs };
        const points = await getTraceDataSource().getSignalSamples(
          blfPath,
          signalId,
          fetchRange.startUs,
          fetchRange.endUs,
          viewport.pixelWidth,
          algorithm
        );
        if (cancelled) return;
        for (let idx = startIdx; idx <= endIdx; idx++) {
          const bounds = tileRange(idx, span);
          const tilePoints = points.filter(([ts]) => ts >= bounds.startUs && ts <= bounds.endUs);
          cacheRef.current.set(tileKey(signalId, algorithm, span, idx), tilePoints);
        }
      }

      if (cancelled) return;
      const merged: [number, number][] = [];
      for (const idx of required) {
        const tile = cacheRef.current.get(tileKey(signalId, algorithm, span, idx));
        if (tile) merged.push(...tile);
      }
      setPointsBySignal((prev) => ({ ...prev, [signalId]: merged }));
    }

    Promise.all(signalIds.map(fetchSignal));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [blfPath, signalIdsKey, algorithmsKey, viewport.startUs, viewport.endUs, viewport.pixelWidth, trimRange?.startUs, trimRange?.endUs]);

  return pointsBySignal;
}
