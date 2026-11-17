import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
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
