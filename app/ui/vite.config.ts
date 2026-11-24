import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  server: {
    port: 5173,
    strictPort: true,
    // `config/config.json` (the shared LOD config, also read by
    // crates/query) lives above this package's root - allow the dev
    // server to serve it during `cargo tauri dev`.
    fs: {
      allow: [fileURLToPath(new URL("../../", import.meta.url))],
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
