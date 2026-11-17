import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import Welcome from "./Welcome";
import ProgressScreen from "./Progress";
import SummaryScreen from "./Summary";
import ErrorScreen from "./ErrorScreen";
import type { ProgressTick, TraceSummary } from "./types";

type Screen = "welcome" | "progress" | "summary" | "error";

export default function App() {
  const [screen, setScreen] = useState<Screen>("welcome");
  const [tick, setTick] = useState<ProgressTick | null>(null);
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
      await invoke("prepare_trace", { blfPath, arxmlPath });
      const trace = await invoke<TraceSummary>("get_trace_summary", { blfPath });
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
    setSummary(null);
    setErrorMessage("");
  }

  if (screen === "welcome") {
    return <Welcome onStart={handleStart} />;
  }
  if (screen === "progress") {
    return <ProgressScreen tick={tick} />;
  }
  if (screen === "error") {
    return <ErrorScreen message={errorMessage} onRetry={reset} />;
  }
  if (screen === "summary" && summary && tick?.done) {
    return <SummaryScreen totals={tick} breakdown={summary} onReset={reset} />;
  }
  return null;
}
