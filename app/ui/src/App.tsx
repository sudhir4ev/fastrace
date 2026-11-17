import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { QueryClientProvider } from "@tanstack/react-query";
import { queryClient } from "./app/query-client";
import Welcome from "./Welcome";
import ProgressScreen from "./Progress";
import SummaryScreen from "./Summary";
import ErrorScreen from "./ErrorScreen";
import type { ProgressTick, TraceSummary } from "./types";

type Screen = "welcome" | "progress" | "summary" | "error";

export default function App() {
  const [screen, setScreen] = useState<Screen>("welcome");
  const [tick, setTick] = useState<ProgressTick | null>(null);
  const [totals, setTotals] = useState<(ProgressTick & { done: true }) | null>(null);
  const [summary, setSummary] = useState<TraceSummary | null>(null);
  const [errorMessage, setErrorMessage] = useState("");

  useEffect(() => {
    const unlisten = listen<ProgressTick>("prepare-progress", (event) => {
      setTick(event.payload);
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  }, []);

  async function handleStart(blfPath: string, arxmlPath: string) {
    setTick(null);
    setScreen("progress");
    try {
      // prepare_trace resolves with the run's final Done tick directly, so
      // the summary transition never races the "prepare-progress" event
      // listener (separate async IPC completions with no ordering
      // guarantee between them) - the event stream is only for the live
      // counters on the Progress screen.
      const doneTick = await invoke<ProgressTick & { done: true }>("prepare_trace", { blfPath, arxmlPath });
      const trace = await invoke<TraceSummary>("get_trace_summary", { blfPath });
      setTotals(doneTick);
      setSummary(trace);
      setScreen("summary");
    } catch (e) {
      setErrorMessage(String(e));
      setScreen("error");
    }
  }

  function reset() {
    setScreen("welcome");
    setTick(null);
    setTotals(null);
    setSummary(null);
    setErrorMessage("");
  }

  if (screen === "welcome") {
    return (
      <QueryClientProvider client={queryClient}>
        <Welcome onStart={handleStart} />
      </QueryClientProvider>
    );
  }
  if (screen === "progress") {
    return (
      <QueryClientProvider client={queryClient}>
        <ProgressScreen tick={tick} />
      </QueryClientProvider>
    );
  }
  if (screen === "error") {
    return (
      <QueryClientProvider client={queryClient}>
        <ErrorScreen message={errorMessage} onRetry={reset} />
      </QueryClientProvider>
    );
  }
  if (screen === "summary" && summary && totals) {
    return (
      <QueryClientProvider client={queryClient}>
        <SummaryScreen totals={totals} breakdown={summary} onReset={reset} />
      </QueryClientProvider>
    );
  }
  return null;
}
