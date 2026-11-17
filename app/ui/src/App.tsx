import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { QueryClientProvider } from "@tanstack/react-query";
import Welcome from "./Welcome";
import ProgressScreen from "./Progress";
import ErrorScreen from "./ErrorScreen";
import WorkspaceLayout from "./widgets/WorkspaceLayout";
import { queryClient } from "./app/query-client";
import { getTraceDataSource, type PrepareMeta } from "./shared/api/trace-source";
import type { ProgressTick } from "./types";

type Screen = "welcome" | "progress" | "summary" | "error";

export default function App() {
  const [screen, setScreen] = useState<Screen>("welcome");
  const [tick, setTick] = useState<ProgressTick | null>(null);
  const [prepareTotals, setPrepareTotals] = useState<{
    messages: number;
    protocol_rows: number;
    elapsed_ms: number;
  } | null>(null);
  const [blfPath, setBlfPath] = useState("");
  const [errorMessage, setErrorMessage] = useState("");

  useEffect(() => {
    const unlisten = listen<ProgressTick>("prepare-progress", (event) => {
      setTick(event.payload);
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  }, []);

  async function handleStart(startBlfPath: string, arxmlPath: string) {
    setTick(null);
    setBlfPath(startBlfPath);
    setScreen("progress");
    try {
      // prepare_trace resolves with the run's final Done tick directly, so
      // the summary transition never races the "prepare-progress" event
      // listener - the event stream is only for the live counters on the
      // Progress screen. The workspace's own data (trace summary, message
      // groups, ECUs) is now fetched independently by TraceRail via React
      // Query, so App.tsx no longer calls get_trace_summary itself.
      const doneTick = await invoke<ProgressTick & { done: true }>("prepare_trace", {
        blfPath: startBlfPath,
        arxmlPath,
      });
      setPrepareTotals(doneTick);
      // Awaited before the screen switch so the "prepare" activity entry it
      // writes is already there once WorkspaceLayout's ActivityLog mounts
      // and fires its first (30s-stale-time-cached) query - otherwise that
      // first fetch can race the write and show "No activity yet" for a
      // while.
      await getTraceDataSource().recordRecentTrace(startBlfPath, {
        messages: doneTick.messages,
        protocolRows: doneTick.protocol_rows,
        elapsedMs: doneTick.elapsed_ms,
      });
      setScreen("summary");
    } catch (e) {
      setErrorMessage(String(e));
      setScreen("error");
    }
  }

  function handleOpenExisting(openBlfPath: string, meta?: PrepareMeta) {
    getTraceDataSource().recordRecentTrace(openBlfPath);
    setBlfPath(openBlfPath);
    setPrepareTotals(
      meta ? { messages: meta.messages, protocol_rows: meta.protocolRows, elapsed_ms: meta.elapsedMs } : null
    );
    setScreen("summary");
  }

  function reset() {
    setScreen("welcome");
    setTick(null);
    setPrepareTotals(null);
    setBlfPath("");
    setErrorMessage("");
  }

  return (
    <QueryClientProvider client={queryClient}>
      {screen === "welcome" && <Welcome onStart={handleStart} onOpenExisting={handleOpenExisting} />}
      {screen === "progress" && <ProgressScreen tick={tick} />}
      {screen === "error" && <ErrorScreen message={errorMessage} onRetry={reset} />}
      {screen === "summary" && blfPath && (
        <WorkspaceLayout blfPath={blfPath} prepareTotals={prepareTotals} onOpenTrace={reset} />
      )}
    </QueryClientProvider>
  );
}
