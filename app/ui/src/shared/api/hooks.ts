import {
  useInfiniteQuery,
  useIsFetching,
  useMutation,
  useMutationState,
  useQueries,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useToastStore } from "@/app/toast-store";
import { getTraceDataSource } from "./trace-source";

/** Query roots that read local JSON / filesystem, not the Trace Store. */
const NON_STORE_QUERY_ROOTS = new Set([
  "file-sizes",
  "path-size",
  "recent-traces",
  "query-history",
  "activities",
]);

const MESSAGE_PAGE_SIZE = 200;

export function useTraceSummary(blfPath: string, startUs: number, endUs: number) {
  return useQuery({
    queryKey: ["trace-summary", blfPath, startUs, endUs],
    queryFn: () => getTraceDataSource().getTraceSummary(blfPath, startUs, endUs),
  });
}

export function useMessageGroups(blfPath: string, startUs: number, endUs: number) {
  return useQuery({
    queryKey: ["message-groups", blfPath, startUs, endUs],
    queryFn: () => getTraceDataSource().listMessageGroups(blfPath, startUs, endUs),
  });
}

export function useEcus(blfPath: string) {
  return useQuery({
    queryKey: ["ecus", blfPath],
    queryFn: () => getTraceDataSource().listEcus(blfPath),
  });
}

export function useMessages(blfPath: string, groupKeys: string[], startUs: number, endUs: number) {
  const sortedKeys = [...groupKeys].sort();
  return useInfiniteQuery({
    queryKey: ["messages", blfPath, sortedKeys, startUs, endUs],
    queryFn: ({ pageParam }) =>
      getTraceDataSource().listMessages(blfPath, groupKeys, pageParam, MESSAGE_PAGE_SIZE, startUs, endUs),
    initialPageParam: null as number | null,
    // React Query's infinite-query pagination only stops fetching when this
    // returns `undefined` - a `null` passed straight through (the API
    // contract's "no more pages" value) would be treated as a valid next
    // param and loop forever re-requesting the last page.
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    enabled: groupKeys.length > 0,
  });
}

export function useMessageDetail(blfPath: string, msgId: number | null, startUs: number, endUs: number) {
  return useQuery({
    queryKey: ["message-detail", blfPath, msgId, startUs, endUs],
    queryFn: () => getTraceDataSource().getMessageDetail(blfPath, msgId as number, startUs, endUs),
    enabled: msgId !== null,
  });
}

export function useMessageCount(blfPath: string, enabled = true) {
  return useQuery({
    queryKey: ["message-count", blfPath],
    queryFn: () => getTraceDataSource().countMessages(blfPath),
    enabled,
  });
}

export const CONTAINER_INDEX_KEY = (blfPath: string) => ["container-index", blfPath];
export const SIGNAL_COVERAGE_KEY = (blfPath: string) => ["signal-coverage", blfPath];
export const TRACE_TIME_RANGE_KEY = (blfPath: string) => ["trace-time-range", blfPath];

export function useContainerIndex(blfPath: string) {
  return useQuery({
    queryKey: CONTAINER_INDEX_KEY(blfPath),
    queryFn: () => getTraceDataSource().listContainerIndex(blfPath),
  });
}

export function useSignalCoverage(blfPath: string, enabled = true) {
  return useQuery({
    queryKey: SIGNAL_COVERAGE_KEY(blfPath),
    queryFn: () => getTraceDataSource().listSignalCoverage(blfPath),
    enabled,
  });
}

export function useMessageCountInRange(
  blfPath: string,
  startUs: number | null,
  endUs: number | null,
  enabled: boolean
) {
  return useQuery({
    queryKey: ["message-count-in-range", blfPath, startUs, endUs],
    queryFn: () => getTraceDataSource().countMessagesInRange(blfPath, startUs as number, endUs as number),
    enabled: enabled && startUs != null && endUs != null,
  });
}

// Plain async helpers for TrimControl's message-ordinal Apply (not hooks).
export function resolveMessagePosition(blfPath: string, position: number): Promise<number> {
  return getTraceDataSource().resolveMessagePosition(blfPath, position);
}

export function resolveMessageRange(
  blfPath: string,
  startPos: number,
  endPos: number
): Promise<[number, number]> {
  return getTraceDataSource().resolveMessageRange(blfPath, startPos, endPos);
}

const SIGNAL_CATALOG_KEY = (blfPath: string) => ["signal-catalog", blfPath];

export function useSignalCatalog(blfPath: string) {
  return useQuery({
    queryKey: SIGNAL_CATALOG_KEY(blfPath),
    queryFn: () => getTraceDataSource().listSignalCatalog(blfPath),
  });
}

export function useSignalSamples(
  blfPath: string,
  signalId: number | null,
  startUs: number,
  endUs: number,
  limit = 200
) {
  return useQuery({
    queryKey: ["signal-samples", blfPath, signalId, startUs, endUs, limit],
    queryFn: () => getTraceDataSource().getSignalSamples(blfPath, signalId as number, limit, startUs, endUs),
    enabled: signalId !== null,
  });
}

// Timeline-scale fetch: TimelineChart calls this once for every displayed
// signal with TIMELINE_SAMPLE_LIMIT - 200k rows comfortably covers a full
// drive per docs/adr/0005's real-trace signal_stats numbers, with no
// server-side windowing - ECharts' own `large`/`sampling: 'lttb'` handles
// render-time density.
export const TIMELINE_SAMPLE_LIMIT = 200_000;

// useQueries (not a loop of useSignalSamples) because the signal count
// changes as the user adds/removes pills - a variable number of hook calls
// would break the rules of hooks, but useQueries itself is a single hook
// call that internally manages a variable-length query array.
export function useSignalSamplesList(
  blfPath: string,
  signalIds: number[],
  startUs: number,
  endUs: number,
  limit = TIMELINE_SAMPLE_LIMIT
) {
  return useQueries({
    queries: signalIds.map((signalId) => ({
      queryKey: ["signal-samples", blfPath, signalId, startUs, endUs, limit],
      queryFn: () => getTraceDataSource().getSignalSamples(blfPath, signalId, limit, startUs, endUs),
    })),
  });
}

// Same order of magnitude as TIMELINE_SAMPLE_LIMIT - duplicated from the
// Rust-side query::DETECTOR_QUERY_MATCH_LIMIT because there's no
// shared-constant mechanism across the Tauri IPC boundary.
export const DETECTOR_QUERY_MATCH_LIMIT = 200_000;

const detectorQueryMutationKey = (blfPath: string) => ["run-detector-query", blfPath];

export function useRunDetectorQuery(blfPath: string) {
  return useMutation({
    mutationKey: detectorQueryMutationKey(blfPath),
    mutationFn: ({
      sql,
      respectTrim,
      startUs,
      endUs,
      targetSignalIds,
    }: {
      sql: string;
      respectTrim: boolean;
      startUs: number;
      endUs: number;
      targetSignalIds: number[];
    }) =>
      getTraceDataSource().runDetectorQuery(
        blfPath,
        sql,
        respectTrim,
        startUs,
        endUs,
        targetSignalIds
      ),
  });
}

// Shared x-axis domain for every Timeline chart (SignalChart, MatchLane) -
// without this, each chart auto-scales to its own series' extent, and
// CHART_GROUP's percentage-based zoom sync maps the same percentage to
// different absolute time windows per chart (the misalignment this fixes).
export function useTraceTimeRange(blfPath: string, enabled = true) {
  return useQuery({
    queryKey: TRACE_TIME_RANGE_KEY(blfPath),
    queryFn: () => getTraceDataSource().getTraceTimeRange(blfPath),
    enabled,
  });
}

const ACTIVITIES_KEY = (blfPath: string) => ["activities", blfPath];

export function useActivities(blfPath: string) {
  return useQuery({
    queryKey: ACTIVITIES_KEY(blfPath),
    queryFn: () => getTraceDataSource().listActivities(blfPath),
  });
}

const applyTrimMutationKey = (blfPath: string) => ["apply-trim", blfPath];

// Indexed incremental decode of the active signals' uncovered delta
// (docs/ingestion-pipeline.html). signal_stats stay Prepare-time / full-trace.
export function useApplyTrim(blfPath: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationKey: applyTrimMutationKey(blfPath),
    mutationFn: ({
      startUs,
      endUs,
      activeSignalIds,
    }: {
      startUs: number;
      endUs: number;
      activeSignalIds: number[];
    }) => getTraceDataSource().applyTrim(blfPath, startUs, endUs, activeSignalIds),
    onSuccess: (result, { activeSignalIds }) => {
      // Cache flags / samples may have changed for newly decoded signals.
      queryClient.invalidateQueries({ queryKey: SIGNAL_CATALOG_KEY(blfPath) });
      queryClient.invalidateQueries({ queryKey: ["signal-samples", blfPath] });
      // apply-trim extends signal_coverage and may flip container_index.decoded.
      queryClient.invalidateQueries({ queryKey: CONTAINER_INDEX_KEY(blfPath) });
      queryClient.invalidateQueries({ queryKey: SIGNAL_COVERAGE_KEY(blfPath) });
      // TrimControl may have paused / failed reads while the sidecar held the
      // DuckDB write lock - refresh those once the store is readable again.
      queryClient.invalidateQueries({ queryKey: TRACE_TIME_RANGE_KEY(blfPath) });
      queryClient.invalidateQueries({ queryKey: ["message-count", blfPath] });
      queryClient.invalidateQueries({ queryKey: ["message-count-in-range", blfPath] });
      const detail = `${activeSignalIds.length} signal${activeSignalIds.length === 1 ? "" : "s"}`;
      getTraceDataSource()
        .recordActivity(blfPath, "decode", result.elapsedMs, detail)
        .then(() => queryClient.invalidateQueries({ queryKey: ACTIVITIES_KEY(blfPath) }));
    },
    onError: (e) => useToastStore.getState().pushError(String(e)),
  });
}

export function useIsApplyingTrim(blfPath: string): boolean {
  const states = useMutationState({
    filters: { mutationKey: applyTrimMutationKey(blfPath), status: "pending" },
  });
  return states.length > 0;
}

/** Footer I/O LEDs: BLF sidecar reads vs Trace Store / DuckDB activity. */
export function useIoBusy(
  blfPath: string,
  preparing: boolean
): { blfBusy: boolean; duckdbBusy: boolean } {
  const applyingTrim = useIsApplyingTrim(blfPath);
  const detectorPending =
    useMutationState({
      filters: { mutationKey: detectorQueryMutationKey(blfPath), status: "pending" },
    }).length > 0;
  const storeFetching = useIsFetching({
    predicate: (query) => {
      const key = query.queryKey;
      if (!Array.isArray(key) || key.length < 2) return false;
      const root = key[0];
      if (typeof root !== "string" || NON_STORE_QUERY_ROOTS.has(root)) return false;
      return key[1] === blfPath;
    },
  });

  const sidecarBusy = preparing || applyingTrim;
  return {
    blfBusy: sidecarBusy,
    duckdbBusy: sidecarBusy || detectorPending || storeFetching > 0,
  };
}

export function useFileSizes(blfPath: string) {
  return useQuery({
    queryKey: ["file-sizes", blfPath],
    queryFn: () => getTraceDataSource().getFileSizes(blfPath),
  });
}

export function usePathSize(path: string | null) {
  return useQuery({
    queryKey: ["path-size", path],
    queryFn: () => getTraceDataSource().getPathSize(path as string),
    enabled: path !== null,
  });
}

const RECENT_TRACES_KEY = ["recent-traces"];

export function useRecentTraces() {
  return useQuery({
    queryKey: RECENT_TRACES_KEY,
    queryFn: () => getTraceDataSource().listRecentTraces(),
  });
}

const QUERY_HISTORY_KEY = (blfPath: string) => ["query-history", blfPath];

export function useQueryHistory(blfPath: string) {
  return useQuery({
    queryKey: QUERY_HISTORY_KEY(blfPath),
    queryFn: () => getTraceDataSource().listQueryHistory(blfPath),
  });
}

export function useRecordQuery(blfPath: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      sql,
      targetSignalIds,
      respectTrim,
      matchCount,
    }: {
      sql: string;
      targetSignalIds: number[];
      respectTrim: boolean;
      matchCount: number;
    }) => getTraceDataSource().recordQuery(blfPath, sql, targetSignalIds, respectTrim, matchCount),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: QUERY_HISTORY_KEY(blfPath) }),
  });
}

export function useRemoveQuery(blfPath: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (sql: string) => getTraceDataSource().removeQuery(blfPath, sql),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: QUERY_HISTORY_KEY(blfPath) }),
  });
}

export function useClearQueryHistory(blfPath: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => getTraceDataSource().clearQueryHistory(blfPath),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: QUERY_HISTORY_KEY(blfPath) }),
  });
}

export function useRemoveRecentTrace() {
  const queryClient = useQueryClient();
  return (blfPath: string) =>
    getTraceDataSource()
      .removeRecentTrace(blfPath)
      .then(() => queryClient.invalidateQueries({ queryKey: RECENT_TRACES_KEY }));
}
