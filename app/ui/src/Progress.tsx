import type { ProgressTick } from "./types";

interface ProgressScreenProps {
  tick: ProgressTick | null;
}

export default function ProgressScreen({ tick }: ProgressScreenProps) {
  return (
    <div>
      <h1>Preparing trace...</h1>
      <div aria-label="loading" className="spinner" />
      <p>Containers: {tick?.containers ?? 0}</p>
      <p>Messages: {tick?.messages ?? 0}</p>
      <p>Elapsed: {tick?.elapsed_ms ?? 0} ms</p>
    </div>
  );
}
