import { useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";

interface WelcomeProps {
  onStart: (blfPath: string, arxmlPath: string) => void;
}

export default function Welcome({ onStart }: WelcomeProps) {
  const [blfPath, setBlfPath] = useState<string | null>(null);
  const [arxmlPath, setArxmlPath] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);

  async function pickBlf() {
    const picked = await open({ filters: [{ name: "BLF", extensions: ["blf"] }] });
    if (typeof picked === "string") setBlfPath(picked);
  }

  async function pickArxml() {
    const picked = await open({ filters: [{ name: "ARXML", extensions: ["arxml"] }] });
    if (typeof picked === "string") setArxmlPath(picked);
  }

  function handleStart() {
    if (!blfPath || !arxmlPath || starting) return;
    setStarting(true);
    onStart(blfPath, arxmlPath);
  }

  return (
    <div>
      <h1>fastrace</h1>
      <div>
        <button onClick={pickBlf}>Choose BLF...</button>
        <span>{blfPath ?? "No BLF selected"}</span>
      </div>
      <div>
        <button onClick={pickArxml}>Choose ARXML...</button>
        <span>{arxmlPath ?? "No ARXML selected"}</span>
      </div>
      <button disabled={!blfPath || !arxmlPath || starting} onClick={handleStart}>
        Start Processing
      </button>
    </div>
  );
}
