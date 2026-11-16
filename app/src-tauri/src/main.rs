#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::path::PathBuf;

// Resolves to a locally-built fastrace_parse for now. Real Tauri
// `externalBin` sidecar resolution is deferred to the wave that adds the
// Prepare progress UI (see crates/sidecar/README.md).
fn fastrace_parse_bin() -> PathBuf {
    std::env::var("FASTRACE_PARSE_BIN")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("../../build/native/cli/fastrace_parse"))
}

#[tauri::command]
fn prepare_trace(path: String) -> Result<(), String> {
    sidecar::spawn(&fastrace_parse_bin(), &["prepare".to_string(), path], |_progress| {})
}

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![prepare_trace])
        .run(tauri::generate_context!())
        .expect("error while running fastrace");
}
