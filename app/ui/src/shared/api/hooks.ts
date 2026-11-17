import { useInfiniteQuery, useMutation, useMutationState, useQuery, useQueryClient } from "@tanstack/react-query";
import { useToastStore } from "@/app/toast-store";
import { getTraceDataSource } from "./trace-source";

const MESSAGE_PAGE_SIZE = 200;

export function useTraceSummary(blfPath: string) {
  return useQuery({
    queryKey: ["trace-summary", blfPath],
    queryFn: () => getTraceDataSource().getTraceSummary(blfPath),
  });
}

export function useMessageGroups(blfPath: string) {
  return useQuery({
    queryKey: ["message-groups", blfPath],
    queryFn: () => getTraceDataSource().listMessageGroups(blfPath),
  });
}

export function useEcus(blfPath: string) {
  return useQuery({
    queryKey: ["ecus", blfPath],
    queryFn: () => getTraceDataSource().listEcus(blfPath),
  });
}

export function useMessages(blfPath: string, groupKey: string | null) {
  return useInfiniteQuery({
    queryKey: ["messages", blfPath, groupKey],
    queryFn: ({ pageParam }) =>
      getTraceDataSource().listMessages(blfPath, groupKey as string, pageParam, MESSAGE_PAGE_SIZE),
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

export function useSignalSamples(blfPath: string, signalId: number | null, limit = 200) {
  return useQuery({
    queryKey: ["signal-samples", blfPath, signalId, limit],
    queryFn: () => getTraceDataSource().getSignalSamples(blfPath, signalId as number, limit),
    enabled: signalId !== null,
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
    mutationFn: (signalIds: number[]) => getTraceDataSource().decodeSignals(blfPath, signalIds),
    onSuccess: (result, signalIds) => {
      queryClient.invalidateQueries({ queryKey: SIGNAL_CATALOG_KEY(blfPath) });
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
