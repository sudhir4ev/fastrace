# Wave 2: Tauri Ingestion-Progress UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the first real `app/ui` screens — pick a BLF + ARXML, run `fastrace_parse prepare`, watch live progress, see a result summary — replacing today's one-line placeholder.

**Architecture:** `app/src-tauri` gets two commands (`prepare_trace`, `get_trace_summary`) plus a native file-dialog plugin; `crates/trace-store`/`crates/query` are un-stubbed to the minimum needed to read aggregate counts back out of the Trace Store; `app/ui` gets four small React components wired together by a state machine in `App.tsx`. Prepare's progress stream reaches the frontend via Tauri events emitted from a background thread.

**Tech Stack:** Rust (`duckdb` crate, `bundled` feature, pinned `1.1.1` — the closest published `duckdb-rs` version to the DuckDB `v1.1.3` already embedded on the C++ side), Tauri v2 (`tauri-plugin-dialog`), React + TypeScript, `@tauri-apps/api` v2 (`core`/`event` modules).

**Spec:** `docs/superpowers/specs/2026-11-17-wave2-ingestion-progress-ui-design.md`

## Global Constraints

- `duckdb` crate version is `1.1.1` with `features = ["bundled"]` — confirmed on crates.io to expose the `bundled` feature; this builds DuckDB from source at `cargo build` time (slower first build, no coordination needed with the CMake-fetched prebuilt `libduckdb` the C++ side uses).
- `schema_version` check on the Rust side is a hardcoded constant (`"1"`) in `crates/trace-store`, matching `schema/schema.sql`'s `-- schema_version: 1` comment and the C++ side's embedded `kSchemaVersion` — per `AGENTS.md`'s rule, any future schema bump must update this constant in the same change.
- No frontend test framework (Vitest, etc.) is being introduced this wave — `app/ui` has none today (`architecture.md` lists it as "no dedicated test target yet") and the design spec's own Verification section is manual for the UI. Every UI task below has a manual verification step with exact actions instead of an automated test. Rust-side logic (crates, and anything in `main.rs` factored out as a plain function) still gets real `cargo test` coverage.
- Out of scope (per spec): `arxml_signal`/`signals` schema, `decode-signals` real implementation, signal selection UI, any charting library, Tauri `externalBin` bundling.
- Tauri v2 import paths: frontend `invoke` comes from `@tauri-apps/api/core` (not `@tauri-apps/api/tauri`, which was the v1 path); `listen` comes from `@tauri-apps/api/event`.

## Review Focus

- User cancels the native file-open dialog (resolves to `null`) — "Start Processing" must stay disabled, not crash on a null path.
- `get_trace_summary` is called against a `.duckdb` whose `schema_version` doesn't match the Rust-side constant — must return a clear `Err(String)`, never panic.
- `fastrace_parse` binary is missing (`FASTRACE_PARSE_BIN` unset, no local `cmake --build build` yet) — `prepare_trace` must surface a readable error, not hang or panic.
- Rapid double-click of "Start Processing" (or a second `prepare_trace` invoke while one is already running) must not spawn a second concurrent `fastrace_parse` process.
- Prepare fails after several "Running" progress ticks already arrived — the UI must still land cleanly on the error screen, not get stuck on the progress screen.

---

## Task 1: `crates/trace-store` — real read-only open + schema_version check

**Files:**
- Modify: `crates/trace-store/Cargo.toml`
- Modify: `crates/trace-store/src/lib.rs`

**Interfaces:**
- Produces: `pub use duckdb::Connection;` (re-export, so downstream crates don't need their own `duckdb` dependency), `pub fn open(path: &std::path::Path) -> Result<Connection, String>`.

- [ ] **Step 1: Add the `duckdb` dependency**

Edit `crates/trace-store/Cargo.toml`:

```toml
[package]
name = "trace-store"
version = "0.1.0"
edition = "2021"

[dependencies]
duckdb = { version = "1.1.1", features = ["bundled"] }
```

- [ ] **Step 2: Write the failing tests**

Replace `crates/trace-store/src/lib.rs` entirely with:

```rust
use std::path::Path;

pub use duckdb::Connection;

/// Must match `schema/schema.sql`'s `-- schema_version: N` comment and the
/// C++ side's embedded `kSchemaVersion` (docs/adr/0001 rule 1). Bump both
/// together when the DDL changes.
const EXPECTED_SCHEMA_VERSION: &str = "1";

/// Opens an existing Trace Store (`<stem>.duckdb`) read-only and checks
/// `meta.schema_version` against `EXPECTED_SCHEMA_VERSION`.
pub fn open(path: &Path) -> Result<Connection, String> {
    let config = duckdb::Config::default()
        .access_mode(duckdb::AccessMode::ReadOnly)
        .map_err(|e| e.to_string())?;
    let conn = Connection::open_with_flags(path, config).map_err(|e| e.to_string())?;
    let version: String = conn
        .query_row("select value from meta where key = 'schema_version'", [], |row| row.get(0))
        .map_err(|e| format!("could not read schema_version: {e}"))?;
    if version != EXPECTED_SCHEMA_VERSION {
        return Err(format!(
            "schema_version mismatch: store has {version}, expected {EXPECTED_SCHEMA_VERSION}"
        ));
    }
    Ok(conn)
}

#[cfg(test)]
mod tests {
    use super::*;
    use duckdb::Connection as RwConnection;

    fn write_store_with_version(path: &Path, version: &str) {
        let conn = RwConnection::open(path).unwrap();
        conn.execute_batch(
            "CREATE TABLE meta (key VARCHAR, value VARCHAR);
             CREATE TABLE messages (msg_id BIGINT);",
        )
        .unwrap();
        conn.execute("INSERT INTO meta VALUES ('schema_version', ?)", [version]).unwrap();
    }

    #[test]
    fn open_succeeds_when_version_matches() {
        let dir = std::env::temp_dir().join(format!("trace_store_test_ok_{}", std::process::id()));
        write_store_with_version(&dir, "1");
        assert!(open(&dir).is_ok());
        let _ = std::fs::remove_file(&dir);
    }

    #[test]
    fn open_fails_when_version_mismatches() {
        let dir = std::env::temp_dir().join(format!("trace_store_test_bad_{}", std::process::id()));
        write_store_with_version(&dir, "999");
        let err = open(&dir).expect_err("mismatched schema_version should error");
        assert!(err.contains("schema_version mismatch"), "unexpected error: {err}");
        let _ = std::fs::remove_file(&dir);
    }

    #[test]
    fn open_fails_when_file_missing() {
        assert!(open(Path::new("/nonexistent/path/does_not_exist.duckdb")).is_err());
    }
}
```

- [ ] **Step 3: Run the tests to verify they pass**

Run: `cargo test --manifest-path crates/Cargo.toml -p trace-store`
Expected: PASS (3 tests). First run compiles `duckdb` from source via the `bundled` feature — this takes several minutes; subsequent runs are fast.

- [ ] **Step 4: Commit**

```bash
git add crates/trace-store/Cargo.toml crates/trace-store/src/lib.rs
git commit -m "feat(trace-store): real read-only open with schema_version check"
```

---

## Task 2: `crates/query` — real aggregate-count execution

**Files:**
- Modify: `crates/query/src/lib.rs`
- (No `Cargo.toml` change — it already depends on `trace-store`, and `trace-store` now re-exports `Connection`, so `query` doesn't need its own `duckdb` dependency.)

**Interfaces:**
- Consumes: `trace_store::Connection` (Task 1).
- Produces: `pub fn count(conn: &trace_store::Connection, sql: &str) -> Result<i64, String>`.

- [ ] **Step 1: Write the failing test**

Replace `crates/query/src/lib.rs` entirely with:

```rust
/// Runs a `SELECT COUNT(*) ...`-shaped query and returns the single integer
/// result. Not a general query runner - just enough to drive the Wave 2
/// summary screen's fixed set of aggregate counts.
pub fn count(conn: &trace_store::Connection, sql: &str) -> Result<i64, String> {
    conn.query_row(sql, [], |row| row.get(0)).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use trace_store::Connection;

    #[test]
    fn count_returns_row_count() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("CREATE TABLE t (x INTEGER); INSERT INTO t VALUES (1), (2), (3);").unwrap();
        assert_eq!(count(&conn, "select count(*) from t").unwrap(), 3);
    }

    #[test]
    fn count_surfaces_sql_errors() {
        let conn = Connection::open_in_memory().unwrap();
        assert!(count(&conn, "select count(*) from no_such_table").is_err());
    }
}
```

- [ ] **Step 2: Run the tests to verify they pass**

Run: `cargo test --manifest-path crates/Cargo.toml -p query`
Expected: PASS (2 tests).

- [ ] **Step 3: Commit**

```bash
git add crates/query/src/lib.rs
git commit -m "feat(query): real aggregate-count execution against an open Trace Store"
```

---

## Task 3: `app/src-tauri` — dialog plugin wiring and binary-path validation

**Files:**
- Modify: `app/src-tauri/Cargo.toml`
- Create: `app/src-tauri/capabilities/default.json`
- Modify: `app/src-tauri/src/main.rs`

**Interfaces:**
- Produces: `fn validate_bin_path(bin: &std::path::Path) -> Result<std::path::PathBuf, String>` (pure, testable), used by Task 4.

- [ ] **Step 1: Add the dialog plugin dependency**

Edit `app/src-tauri/Cargo.toml`, adding one line under `[dependencies]`:

```toml
[dependencies]
tauri = { version = "2", features = [] }
tauri-plugin-dialog = "2"
serde = { version = "1", features = ["derive"] }
serde_json = "1"
trace-store = { path = "../../crates/trace-store" }
query = { path = "../../crates/query" }
sidecar = { path = "../../crates/sidecar" }
```

- [ ] **Step 2: Create the capabilities file**

Create `app/src-tauri/capabilities/default.json`:

```json
{
  "identifier": "default",
  "description": "Default permissions for the main window",
  "windows": ["main"],
  "permissions": [
    "core:default",
    "dialog:default"
  ]
}
```

- [ ] **Step 3: Register the plugin and add the testable path-validation function**

In `app/src-tauri/src/main.rs`, add (near `fastrace_parse_bin`):

```rust
fn validate_bin_path(bin: &PathBuf) -> Result<PathBuf, String> {
    if !bin.exists() {
        return Err(format!(
            "fastrace_parse not found at {} (set FASTRACE_PARSE_BIN or run `cmake --build build` first)",
            bin.display()
        ));
    }
    Ok(bin.clone())
}
```

And register the plugin in `main()`:

```rust
fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![prepare_trace])
        .run(tauri::generate_context!())
        .expect("error while running fastrace");
}
```

(The `prepare_trace` handler list entry stays for now — Task 4 rewrites the function body and adds `get_trace_summary` to this list.)

- [ ] **Step 4: Write the failing test**

Add to the bottom of `app/src-tauri/src/main.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validate_bin_path_rejects_missing_file() {
        let err = validate_bin_path(&PathBuf::from("/nonexistent/fastrace_parse_test_xyz"))
            .expect_err("missing binary should error");
        assert!(err.contains("fastrace_parse not found"), "unexpected error: {err}");
    }
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cargo test --manifest-path app/src-tauri/Cargo.toml`
Expected: PASS. (This also exercises `cargo build`'s dependency resolution for the new `tauri-plugin-dialog` crate.)

- [ ] **Step 6: Install the matching npm package**

Run: `npm install --prefix app/ui @tauri-apps/plugin-dialog`

- [ ] **Step 7: Commit**

```bash
git add app/src-tauri/Cargo.toml app/src-tauri/Cargo.lock app/src-tauri/capabilities/default.json app/src-tauri/src/main.rs app/ui/package.json app/ui/package-lock.json
git commit -m "feat(app): wire up the native file-dialog plugin"
```

---

## Task 4: `app/src-tauri` — `prepare_trace` streams progress, guards concurrent runs

**Files:**
- Modify: `app/src-tauri/src/main.rs`

**Interfaces:**
- Consumes: `sidecar::spawn(&Path, &[String], impl FnMut(sidecar::Progress))` (existing, `crates/sidecar/src/lib.rs`), `validate_bin_path` (Task 3).
- Produces: `#[tauri::command] async fn prepare_trace(app: tauri::AppHandle, blf_path: String, arxml_path: String) -> Result<(), String>`, emitting a `"prepare-progress"` event per tick with payload shape `{ "done": bool, "containers": u64, "messages": u64, "elapsed_ms": u64, "protocol_rows"?: u64 }`.

- [ ] **Step 1: Write the failing test for the concurrency guard**

Add to `app/src-tauri/src/main.rs`'s `tests` module (from Task 3):

```rust
    #[test]
    fn prepare_guard_rejects_concurrent_acquire() {
        let guard = PrepareGuard(Mutex::new(false));
        guard.try_acquire().expect("first acquire should succeed");
        let err = guard.try_acquire().expect_err("second acquire should fail while busy");
        assert!(err.contains("already in progress"), "unexpected error: {err}");
        guard.release();
        guard.try_acquire().expect("acquire after release should succeed");
    }
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cargo test --manifest-path app/src-tauri/Cargo.toml prepare_guard_rejects_concurrent_acquire`
Expected: FAIL with "cannot find type `PrepareGuard`" / "cannot find value `Mutex`".

- [ ] **Step 3: Implement `PrepareGuard` and rewrite `prepare_trace`**

Replace the whole `app/src-tauri/src/main.rs` with:

```rust
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::path::PathBuf;
use std::sync::Mutex;

use tauri::{Emitter, Manager};

// Resolves to a locally-built fastrace_parse for now. Real Tauri
// `externalBin` sidecar resolution is deferred (see crates/sidecar/README.md).
fn fastrace_parse_bin() -> PathBuf {
    std::env::var("FASTRACE_PARSE_BIN")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("../../build/native/cli/fastrace_parse"))
}

fn validate_bin_path(bin: &PathBuf) -> Result<PathBuf, String> {
    if !bin.exists() {
        return Err(format!(
            "fastrace_parse not found at {} (set FASTRACE_PARSE_BIN or run `cmake --build build` first)",
            bin.display()
        ));
    }
    Ok(bin.clone())
}

/// Rejects a second concurrent `prepare_trace` run. Shortcut: a JoinError
/// from spawn_blocking (Task 4, Step 3) skips the `release()` call below -
/// acceptable for this wave since a panicking fastrace_parse run is already
/// an exceptional case the user has to restart the app for.
struct PrepareGuard(Mutex<bool>);

impl PrepareGuard {
    fn try_acquire(&self) -> Result<(), String> {
        let mut busy = self.0.lock().map_err(|_| "prepare guard poisoned".to_string())?;
        if *busy {
            return Err("a Prepare run is already in progress".to_string());
        }
        *busy = true;
        Ok(())
    }

    fn release(&self) {
        if let Ok(mut busy) = self.0.lock() {
            *busy = false;
        }
    }
}

fn progress_to_json(p: &sidecar::Progress) -> serde_json::Value {
    match p {
        sidecar::Progress::Running { containers, messages, elapsed_ms } => serde_json::json!({
            "done": false, "containers": containers, "messages": messages, "elapsed_ms": elapsed_ms
        }),
        sidecar::Progress::Done { containers, messages, protocol_rows, elapsed_ms } => serde_json::json!({
            "done": true, "containers": containers, "messages": messages,
            "protocol_rows": protocol_rows, "elapsed_ms": elapsed_ms
        }),
    }
}

#[tauri::command]
async fn prepare_trace(app: tauri::AppHandle, blf_path: String, arxml_path: String) -> Result<(), String> {
    app.state::<PrepareGuard>().try_acquire()?;

    let bin = validate_bin_path(&fastrace_parse_bin())?;
    let app_for_task = app.clone();
    let joined: Result<(), String> = tauri::async_runtime::spawn_blocking(move || {
        sidecar::spawn(&bin, &["prepare".to_string(), blf_path, arxml_path], move |progress| {
            let _ = app_for_task.emit("prepare-progress", progress_to_json(&progress));
        })
    })
    .await
    .map_err(|e| e.to_string())?;

    app.state::<PrepareGuard>().release();
    joined
}

fn main() {
    tauri::Builder::default()
        .manage(PrepareGuard(Mutex::new(false)))
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![prepare_trace])
        .run(tauri::generate_context!())
        .expect("error while running fastrace");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validate_bin_path_rejects_missing_file() {
        let err = validate_bin_path(&PathBuf::from("/nonexistent/fastrace_parse_test_xyz"))
            .expect_err("missing binary should error");
        assert!(err.contains("fastrace_parse not found"), "unexpected error: {err}");
    }

    #[test]
    fn prepare_guard_rejects_concurrent_acquire() {
        let guard = PrepareGuard(Mutex::new(false));
        guard.try_acquire().expect("first acquire should succeed");
        let err = guard.try_acquire().expect_err("second acquire should fail while busy");
        assert!(err.contains("already in progress"), "unexpected error: {err}");
        guard.release();
        guard.try_acquire().expect("acquire after release should succeed");
    }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cargo test --manifest-path app/src-tauri/Cargo.toml`
Expected: PASS (2 tests).

- [ ] **Step 5: Verify it still builds as part of the full app**

Run: `cargo build --manifest-path app/src-tauri/Cargo.toml`
Expected: builds cleanly (confirms `tauri::Emitter`/`Manager` trait imports and the `AppHandle` usage compile against the installed `tauri = "2"`).

- [ ] **Step 6: Commit**

```bash
git add app/src-tauri/src/main.rs
git commit -m "feat(app): stream Prepare progress as Tauri events, guard concurrent runs"
```

---

## Task 5: `app/src-tauri` — `get_trace_summary` command

**Files:**
- Modify: `app/src-tauri/src/main.rs`

**Interfaces:**
- Consumes: `trace_store::open` (Task 1), `query::count` (Task 2).
- Produces: `#[derive(serde::Serialize)] struct TraceSummary { can_messages: i64, ethernet_messages: i64, protocol_pdu: i64, protocol_someip: i64, protocol_someip_sd: i64, protocol_doip: i64 }`, `#[tauri::command] fn get_trace_summary(blf_path: String) -> Result<TraceSummary, String>`.

- [ ] **Step 1: Add the struct, command, and bus-type constants**

Insert into `app/src-tauri/src/main.rs`, above `fn main()`:

```rust
// BLFObjectType values that carry CAN vs Ethernet messages
// (native/blf/include/BlfTypes.h) - duplicated here because Rust has no
// visibility into the C++ header; keep in sync if that enum changes.
const CAN_OBJECT_TYPES: &str = "1,100,101"; // CAN_MESSAGE, CAN_FD_MESSAGE, CAN_FD_MESSAGE_64
const ETHERNET_OBJECT_TYPES: &str = "71,120,121"; // ETHERNET_FRAME, ETHERNET_FRAME_EX, ETHERNET_FRAME_FORWARDED

#[derive(serde::Serialize)]
struct TraceSummary {
    can_messages: i64,
    ethernet_messages: i64,
    protocol_pdu: i64,
    protocol_someip: i64,
    protocol_someip_sd: i64,
    protocol_doip: i64,
}

#[tauri::command]
fn get_trace_summary(blf_path: String) -> Result<TraceSummary, String> {
    let duckdb_path = std::path::Path::new(&blf_path).with_extension("duckdb");
    let conn = trace_store::open(&duckdb_path)?;
    Ok(TraceSummary {
        can_messages: query::count(&conn, &format!("select count(*) from messages where object_type in ({CAN_OBJECT_TYPES})"))?,
        ethernet_messages: query::count(&conn, &format!("select count(*) from messages where object_type in ({ETHERNET_OBJECT_TYPES})"))?,
        protocol_pdu: query::count(&conn, "select count(*) from protocol_pdu")?,
        protocol_someip: query::count(&conn, "select count(*) from protocol_someip")?,
        protocol_someip_sd: query::count(&conn, "select count(*) from protocol_someip_sd")?,
        protocol_doip: query::count(&conn, "select count(*) from protocol_doip")?,
    })
}
```

- [ ] **Step 2: Register the command**

Change the `invoke_handler` line in `fn main()`:

```rust
        .invoke_handler(tauri::generate_handler![prepare_trace, get_trace_summary])
```

- [ ] **Step 3: Verify it builds**

Run: `cargo build --manifest-path app/src-tauri/Cargo.toml`
Expected: builds cleanly.

- [ ] **Step 4: Manual verification against the Wave 1 fixture**

Requires the C++ CLI already built (`cmake --build build` from repo root) and the fixture already ingested once:

```bash
./build/native/cli/fastrace_parse prepare native/store/test/fixtures/fixture.blf native/store/test/fixtures/fixture.arxml
```

Then, from a Rust scratch test or `cargo run` snippet (delete after use), call `get_trace_summary`'s underlying logic directly against `native/store/test/fixtures/fixture.duckdb` and confirm, per `native/store/README.md`'s documented fixture counts: `protocol_pdu` = 2, `protocol_someip` = 1, `protocol_someip_sd` = 1, `protocol_doip` = 1, and `can_messages` + `ethernet_messages` = 6 total (2 CAN + 4 Ethernet). Clean up the generated `fixture.duckdb`/`.wal` afterward (`git status` should show no changes under `native/store/test/fixtures/`).

- [ ] **Step 5: Commit**

```bash
git add app/src-tauri/src/main.rs
git commit -m "feat(app): add get_trace_summary command with bus/protocol breakdown"
```

---

## Task 6: `app/ui` — shared types and the Welcome screen

**Files:**
- Create: `app/ui/src/types.ts`
- Create: `app/ui/src/Welcome.tsx`

**Interfaces:**
- Produces: `ProgressTick` type, `TraceSummary` interface (consumed by Tasks 7-9), `Welcome` component with prop `onStart: (blfPath: string, arxmlPath: string) => void`.

- [ ] **Step 1: Create the shared types file**

Create `app/ui/src/types.ts`:

```ts
export type ProgressTick =
  | { done: false; containers: number; messages: number; elapsed_ms: number }
  | { done: true; containers: number; messages: number; protocol_rows: number; elapsed_ms: number };

export interface TraceSummary {
  can_messages: number;
  ethernet_messages: number;
  protocol_pdu: number;
  protocol_someip: number;
  protocol_someip_sd: number;
  protocol_doip: number;
}
```

- [ ] **Step 2: Create the Welcome component**

Create `app/ui/src/Welcome.tsx`:

```tsx
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
```

- [ ] **Step 3: Manual verification**

This component isn't wired into `App.tsx` until Task 9, so there's nothing runnable yet. Re-read the component against the Review Focus list: cancelling either dialog (`open()` resolving to `null`) leaves `blfPath`/`arxmlPath` at `null` (the `typeof picked === "string"` guard skips the `null` case), so "Start Processing" stays disabled — confirms Review Focus item 1 by inspection. `starting` flips to `true` synchronously inside `handleStart`, so a second rapid call returns early via the `|| starting` guard - confirms Review Focus item 4 at the Welcome layer (Task 4's `PrepareGuard` backs this up on the Rust side).

- [ ] **Step 4: Commit**

```bash
git add app/ui/src/types.ts app/ui/src/Welcome.tsx
git commit -m "feat(ui): add shared types and the Welcome file-picker screen"
```

---

## Task 7: `app/ui` — Progress screen

**Files:**
- Create: `app/ui/src/Progress.tsx`

**Interfaces:**
- Consumes: `ProgressTick` (Task 6).
- Produces: `ProgressScreen` component with prop `tick: ProgressTick | null`.

- [ ] **Step 1: Create the component**

Create `app/ui/src/Progress.tsx`:

```tsx
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
```

- [ ] **Step 2: Commit**

```bash
git add app/ui/src/Progress.tsx
git commit -m "feat(ui): add the live progress screen"
```

---

## Task 8: `app/ui` — Summary screen and Error screen

**Files:**
- Create: `app/ui/src/Summary.tsx`
- Create: `app/ui/src/ErrorScreen.tsx`

**Interfaces:**
- Consumes: `ProgressTick`, `TraceSummary` (Task 6).
- Produces: `SummaryScreen` component with props `{ totals: ProgressTick & { done: true }; breakdown: TraceSummary; onReset: () => void }`; `ErrorScreen` component with props `{ message: string; onRetry: () => void }`.

- [ ] **Step 1: Create the Summary component**

Create `app/ui/src/Summary.tsx`:

```tsx
import type { ProgressTick, TraceSummary } from "./types";

interface SummaryScreenProps {
  totals: ProgressTick & { done: true };
  breakdown: TraceSummary;
  onReset: () => void;
}

export default function SummaryScreen({ totals, breakdown, onReset }: SummaryScreenProps) {
  return (
    <div>
      <nav>
        <button aria-current="true">Summary</button>
        <button disabled>Signals</button>
        <button disabled>Anomaly Detection</button>
      </nav>
      <section>
        <h2>Summary</h2>
        <p>Messages: {totals.messages}</p>
        <p>Protocol rows: {totals.protocol_rows}</p>
        <p>Elapsed: {totals.elapsed_ms} ms</p>
        <p>CAN messages: {breakdown.can_messages}</p>
        <p>Ethernet messages: {breakdown.ethernet_messages}</p>
        <p>Packed PDU rows: {breakdown.protocol_pdu}</p>
        <p>SOME/IP rows: {breakdown.protocol_someip}</p>
        <p>SOME/IP-SD rows: {breakdown.protocol_someip_sd}</p>
        <p>DoIP rows: {breakdown.protocol_doip}</p>
      </section>
      <section>
        <p>Signal catalog and plots - coming soon.</p>
        <p>Anomaly detection - coming soon.</p>
      </section>
      <button onClick={onReset}>Process another trace</button>
    </div>
  );
}
```

- [ ] **Step 2: Create the Error component**

Create `app/ui/src/ErrorScreen.tsx`:

```tsx
interface ErrorScreenProps {
  message: string;
  onRetry: () => void;
}

export default function ErrorScreen({ message, onRetry }: ErrorScreenProps) {
  return (
    <div>
      <h2>Prepare failed</h2>
      <p>{message}</p>
      <button onClick={onRetry}>Try again</button>
    </div>
  );
}
```

- [ ] **Step 3: Commit**

```bash
git add app/ui/src/Summary.tsx app/ui/src/ErrorScreen.tsx
git commit -m "feat(ui): add the summary and error screens"
```

---

## Task 9: `app/ui` — wire the state machine in `App.tsx`

**Files:**
- Modify: `app/ui/src/App.tsx`

**Interfaces:**
- Consumes: `Welcome`, `ProgressScreen`, `SummaryScreen`, `ErrorScreen` (Tasks 6-8); Tauri commands `prepare_trace`, `get_trace_summary` (Tasks 4-5); Tauri event `"prepare-progress"`.

- [ ] **Step 1: Replace `App.tsx`**

Replace `app/ui/src/App.tsx` entirely with:

```tsx
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
```

- [ ] **Step 2: Manual verification - happy path**

Build the C++ CLI first if not already built: `cmake -S . -B build && cmake --build build` from the repo root. Then:

```bash
cd app/src-tauri
FASTRACE_PARSE_BIN=../../build/native/cli/fastrace_parse cargo tauri dev
```

In the app window: click "Choose BLF...", pick `native/store/test/fixtures/fixture.blf`; click "Choose ARXML...", pick `native/store/test/fixtures/fixture.arxml`; confirm "Start Processing" is now enabled; click it. Confirm the Progress screen appears with live-updating counters, then the Summary screen appears showing `Messages: 6`, `Protocol rows: 5`, and the CAN/Ethernet + protocol-type breakdown matching `native/store/README.md`'s documented fixture counts (`protocol_pdu`=2, `protocol_someip`=1, `protocol_someip_sd`=1, `protocol_doip`=1). Confirm the "Signals" and "Anomaly Detection" buttons are disabled and their "coming soon" lines are visible. Click "Process another trace" and confirm it returns to the Welcome screen with both pickers cleared.

Delete the generated `native/store/test/fixtures/fixture.duckdb`/`.wal` afterward so `git status` stays clean.

- [ ] **Step 3: Manual verification - error path**

Covers Review Focus item 3 (missing binary) and item 5 (failure after partial progress). With the app still running, repeat the flow but set `FASTRACE_PARSE_BIN` to a path that doesn't exist before launching (`FASTRACE_PARSE_BIN=/tmp/does-not-exist cargo tauri dev`), pick the two fixture files, click Start Processing, and confirm the Error screen appears with a readable message (not a hang or a blank screen), and "Try again" returns to the Welcome screen.

Separately, to see the "failure after partial ticks" path: point the BLF picker at the real MFK5 benchmark file (or any larger local BLF) with a mismatched/corrupt ARXML path if one is available, or temporarily rename `fixture.arxml` to force a load failure partway through, and confirm the UI still reaches the Error screen cleanly rather than freezing on Progress. Revert any renamed fixture files afterward.

- [ ] **Step 4: Commit**

```bash
git add app/ui/src/App.tsx
git commit -m "feat(ui): wire welcome/progress/summary/error screens together"
```

---

## Task 10: Full end-to-end verification and cleanup

**Files:** none (verification only)

- [ ] **Step 1: Run every automated test**

```bash
cargo test --manifest-path crates/Cargo.toml
cargo test --manifest-path app/src-tauri/Cargo.toml
ctest --test-dir build --output-on-failure
```

Expected: all pass.

- [ ] **Step 2: Confirm no stray fixture artifacts**

```bash
git status --short
```

Expected: no untracked/modified files under `native/store/test/fixtures/` (any `fixture.duckdb`/`.wal` created during manual verification must be deleted).

- [ ] **Step 3: Confirm the frontend type-checks and builds**

```bash
npm run build --prefix app/ui
```

Expected: `tsc && vite build` succeeds with no type errors.

- [ ] **Step 4: Final commit if cleanup was needed**

If Step 2 found stray files, remove them and commit:

```bash
git add -A
git commit -m "chore: clean up fixture artifacts from manual verification"
```

(Skip this step entirely if `git status --short` was already clean.)
