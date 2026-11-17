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
