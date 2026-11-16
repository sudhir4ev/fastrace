# fastrace

Desktop app to analyze automotive network traces (CAN and Ethernet) via SQL-based anomaly detection over a local Trace Store. Tauri (Rust + React/TypeScript) with a C++ sidecar for trace parsing.

- Architecture decisions: `docs/adr/` - start with `0001-monorepo-layout-and-boundaries.md` and `architecture.md`.
- Agent/contributor instructions: `AGENTS.md`.
- Product vocabulary: `CONTEXT.md`, `GLOSSARY.md`.
- Pre-migration Qt/C++ implementation: `archive/qt-cpp-legacy` branch (not on `master`).

## Build

```bash
# C++ sidecar
cmake -S . -B build && cmake --build build

# Rust crates
cargo test --manifest-path crates/Cargo.toml
```

## Run the Tauri app (dev)

```bash
# one-time: install the Tauri CLI
cargo install tauri-cli --version "^2" --locked

# one-time: install frontend dependencies (node_modules is gitignored)
npm install --prefix app/ui

# then (cargo tauri dev has no --manifest-path flag; it resolves
# tauri.conf.json from the current directory)
cd app/src-tauri
cargo tauri dev
```

This builds the Rust shell and automatically starts the `app/ui` Vite dev server
(`beforeDevCommand` in `app/src-tauri/tauri.conf.json`), then opens the app window.
First run compiles everything and takes a few minutes. The UI is currently just a
placeholder - no real Prepare pipeline or Detector Query UI yet (see `docs/adr/`).
