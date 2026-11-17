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

fn validate_bin_path(bin: &PathBuf) -> Result<PathBuf, String> {
    if !bin.exists() {
        return Err(format!(
            "fastrace_parse not found at {} (set FASTRACE_PARSE_BIN or run `cmake --build build` first)",
            bin.display()
        ));
    }
    Ok(bin.clone())
}

#[tauri::command]
fn prepare_trace(path: String) -> Result<(), String> {
    sidecar::spawn(&fastrace_parse_bin(), &["prepare".to_string(), path], |_progress| {})
}

fn main() {
    tauri::Builder::default()
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
}
