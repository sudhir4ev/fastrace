import { QueryCache, QueryClient } from "@tanstack/react-query";
import { useToastStore } from "./toast-store";

export const queryClient = new QueryClient({
  // Single, global catch for every failed query (including each page of
  // an infinite query) - this is the one place that turns a rejected
  // TraceDataSource call into user-visible feedback, so individual
  // widgets don't each need their own error-banner rendering.
  queryCache: new QueryCache({
    onError: (error) => {
      useToastStore.getState().pushError(String(error));
    },
  }),
  defaultOptions: {
    queries: {
      retry: 1,
      staleTime: 30_000,
    },
  },
});
