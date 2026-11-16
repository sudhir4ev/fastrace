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

# Tauri app (dev)
cargo tauri dev --manifest-path app/src-tauri/Cargo.toml
```
