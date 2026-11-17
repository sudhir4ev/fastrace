#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::path::PathBuf;
use std::sync::Mutex;

use tauri::{Emitter, Manager};

// Resolves to a locally-built fastrace_parse for now. Real Tauri
// `externalBin` sidecar resolution is deferred to the wave that adds the
// Prepare progress UI (see crates/sidecar/README.md).
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
/// from spawn_blocking (see `prepare_trace`) skips the `release()` call -
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

/// Validates the binary path before touching the guard, so a missing-binary
/// error never leaves `PrepareGuard` stuck held (the bug this fixes: calling
/// `try_acquire()` before validation leaked the guard on every early return).
fn begin_prepare(guard: &PrepareGuard, bin: PathBuf) -> Result<PathBuf, String> {
    let bin = validate_bin_path(&bin)?;
    guard.try_acquire()?;
    Ok(bin)
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
    let bin = begin_prepare(app.state::<PrepareGuard>().inner(), fastrace_parse_bin())?;
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
        can_messages: query::count(
            &conn,
            &format!("select count(*) from messages where object_type in ({CAN_OBJECT_TYPES})"),
        )?,
        ethernet_messages: query::count(
            &conn,
            &format!("select count(*) from messages where object_type in ({ETHERNET_OBJECT_TYPES})"),
        )?,
        protocol_pdu: query::count(&conn, "select count(*) from protocol_pdu")?,
        protocol_someip: query::count(&conn, "select count(*) from protocol_someip")?,
        protocol_someip_sd: query::count(&conn, "select count(*) from protocol_someip_sd")?,
        protocol_doip: query::count(&conn, "select count(*) from protocol_doip")?,
    })
}

fn main() {
    tauri::Builder::default()
        .manage(PrepareGuard(Mutex::new(false)))
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![prepare_trace, get_trace_summary])
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
    fn begin_prepare_does_not_leak_guard_on_missing_binary() {
        let guard = PrepareGuard(Mutex::new(false));
        let missing = PathBuf::from("/nonexistent/fastrace_parse_test_xyz");
        assert!(begin_prepare(&guard, missing).is_err());
        guard.try_acquire().expect("guard must not stay held after a validation failure");
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
