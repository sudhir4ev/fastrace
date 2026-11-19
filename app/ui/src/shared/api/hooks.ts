import { useInfiniteQuery, useMutation, useMutationState, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { useToastStore } from "@/app/toast-store";
import { getTraceDataSource } from "./trace-source";

const MESSAGE_PAGE_SIZE = 200;

export function useTraceSummary(blfPath: string) {
  return useQuery({
    queryKey: ["trace-summary", blfPath],
    queryFn: () => getTraceDataSource().getTraceSummary(blfPath),
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

export function useMessages(blfPath: string, groupKey: string | null, startUs: number, endUs: number) {
  return useInfiniteQuery({
    queryKey: ["messages", blfPath, groupKey, startUs, endUs],
    queryFn: ({ pageParam }) =>
      getTraceDataSource().listMessages(blfPath, groupKey as string, pageParam, MESSAGE_PAGE_SIZE, startUs, endUs),
    initialPageParam: null as number | null,
    // React Query's infinite-query pagination only stops fetching when this
    // returns `undefined` - a `null` passed straight through (the API
    // contract's "no more pages" value) would be treated as a valid next
    // param and loop forever re-requesting the last page.
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    enabled: groupKey !== null,
  });
}

export function useMessageDetail(blfPath: string, msgId: number | null) {
  return useQuery({
    queryKey: ["message-detail", blfPath, msgId],
    queryFn: () => getTraceDataSource().getMessageDetail(blfPath, msgId as number),
    enabled: msgId !== null,
  });
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

export function useRunDetectorQuery(blfPath: string, startUs: number, endUs: number) {
  return useMutation({
    mutationFn: (sql: string) => getTraceDataSource().runDetectorQuery(blfPath, sql, startUs, endUs),
  });
}

// Shared x-axis domain for every Timeline chart (SignalChart, MatchLane) -
// without this, each chart auto-scales to its own series' extent, and
// CHART_GROUP's percentage-based zoom sync maps the same percentage to
// different absolute time windows per chart (the misalignment this fixes).
export function useTraceTimeRange(blfPath: string) {
  return useQuery({
    queryKey: ["trace-time-range", blfPath],
    queryFn: () => getTraceDataSource().getTraceTimeRange(blfPath),
  });
}

const decodeSignalsMutationKey = (blfPath: string) => ["decode-signals", blfPath];
const ACTIVITIES_KEY = (blfPath: string) => ["activities", blfPath];

export function useActivities(blfPath: string) {
  return useQuery({
    queryKey: ACTIVITIES_KEY(blfPath),
    queryFn: () => getTraceDataSource().listActivities(blfPath),
  });
}

export function useDecodeSignals(blfPath: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationKey: decodeSignalsMutationKey(blfPath),
    mutationFn: ({ signalIds, startUs, endUs }: { signalIds: number[]; startUs: number; endUs: number }) =>
      getTraceDataSource().decodeSignals(blfPath, signalIds, startUs, endUs),
    onSuccess: (result, { signalIds }) => {
      queryClient.invalidateQueries({ queryKey: SIGNAL_CATALOG_KEY(blfPath) });
      // Prefix match (no trailing signalId/startUs/endUs/limit) so every
      // cached signal-samples query for this trace refetches - required for
      // the Trim Window's widen-then-Apply path: decode-signals just
      // replaced the `signals` table rows for a wider window, but nothing
      // else would ever tell an already-fetched useSignalSamplesList query to
      // go back for the newly-decoded rows outside its old (narrower) range.
      queryClient.invalidateQueries({ queryKey: ["signal-samples", blfPath] });
      const detail = `${signalIds.length} signal${signalIds.length === 1 ? "" : "s"}`;
      getTraceDataSource()
        .recordActivity(blfPath, "decode", result.elapsedMs, detail)
        .then(() => queryClient.invalidateQueries({ queryKey: ACTIVITIES_KEY(blfPath) }));
    },
    // Mutations aren't covered by query-client.ts's global QueryCache.onError
    // toast wiring (that only observes queries) - push here directly instead
    // of adding a second global error-sink for what is, for now, the only
    // mutation in the app.
    onError: (e) => useToastStore.getState().pushError(String(e)),
  });
}

// Lets a sibling component (DecodeOverlay, mounted from WorkspaceLayout) know
// whether a decode-signals mutation triggered elsewhere (the Signals tab) is
// in flight, without lifting the mutation itself or adding store state for it.
export function useIsDecodingSignals(blfPath: string): boolean {
  const states = useMutationState({
    filters: { mutationKey: decodeSignalsMutationKey(blfPath), status: "pending" },
  });
  return states.length > 0;
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

export function useRemoveRecentTrace() {
  const queryClient = useQueryClient();
  return (blfPath: string) =>
    getTraceDataSource()
      .removeRecentTrace(blfPath)
      .then(() => queryClient.invalidateQueries({ queryKey: RECENT_TRACES_KEY }));
}
