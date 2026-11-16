#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

#[tauri::command]
fn prepare_trace(path: String) -> Result<(), String> {
    sidecar::spawn(&["prepare".to_string(), path])
}

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![prepare_trace])
        .run(tauri::generate_context!())
        .expect("error while running fastrace");
}
