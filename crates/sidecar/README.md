# sidecar

Spawns `fastrace_parse` and parses its stdout progress / stderr error protocol
(docs/adr/0002). No Tauri dependency, no DuckDB access - just a child process.

## Test this crate alone

```
cargo test --manifest-path crates/sidecar/Cargo.toml
```

Two integration tests in `tests/sidecar_test.rs`:

- `spawn_parses_fake_progress` - spawns a tiny canned-output Rust binary
  (`tests/fixtures/fake_progress.rs`) and asserts the JSON lines parse
  correctly. Needs no C++ build at all.
- `spawn_runs_real_fastrace_parse_against_fixture` - points `spawn()` at a real,
  locally-built `fastrace_parse` and runs it against the committed
  `native/store/test/fixtures/fixture.blf`. Looks for the binary via the
  `FASTRACE_PARSE_BIN` env var, falling back to `../../build/native/cli/fastrace_parse`
  relative to this crate. Skips (with a message, not a failure) if neither is
  found, so `cargo test` alone - without having run `cmake --build build` first -
  doesn't spuriously fail.

## Known gap

`app/src-tauri`'s real sidecar binary path resolution (Tauri `externalBin`) is
not wired up here - that's the Tauri app's job, deferred to the wave that adds
the Prepare progress UI.
