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
        let mut busy = self
            .0
            .lock()
            .map_err(|_| "prepare guard poisoned".to_string())?;
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
        sidecar::Progress::Running {
            containers,
            messages,
            elapsed_ms,
        } => serde_json::json!({
            "done": false, "containers": containers, "messages": messages, "elapsed_ms": elapsed_ms
        }),
        sidecar::Progress::Done {
            containers,
            messages,
            protocol_rows,
            elapsed_ms,
        } => serde_json::json!({
            "done": true, "containers": containers, "messages": messages,
            "protocol_rows": protocol_rows, "elapsed_ms": elapsed_ms
        }),
    }
}

/// Picks the final `Done` tick out of every tick a Prepare run emitted, so
/// `prepare_trace` can return it directly instead of making the frontend
/// race the `"prepare-progress"` event listener for the authoritative
/// totals (event delivery and command-resolution are separate async IPC
/// completions with no ordering guarantee between them).
fn fold_final_done(ticks: &[sidecar::Progress]) -> serde_json::Value {
    ticks
        .iter()
        .rev()
        .find(|p| matches!(p, sidecar::Progress::Done { .. }))
        .map(progress_to_json)
        .unwrap_or(serde_json::Value::Null)
}

#[tauri::command]
async fn prepare_trace(
    app: tauri::AppHandle,
    blf_path: String,
    arxml_path: String,
) -> Result<serde_json::Value, String> {
    let bin = begin_prepare(app.state::<PrepareGuard>().inner(), fastrace_parse_bin())?;
    let app_for_task = app.clone();
    let joined: Result<serde_json::Value, String> =
        tauri::async_runtime::spawn_blocking(move || {
            let mut ticks = Vec::new();
            sidecar::spawn(
                &bin,
                &["prepare".to_string(), blf_path, arxml_path],
                |progress| {
                    let _ = app_for_task.emit("prepare-progress", progress_to_json(&progress));
                    ticks.push(progress);
                },
            )
            .map(|_| fold_final_done(&ticks))
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
            &format!(
                "select count(*) from messages where object_type in ({ETHERNET_OBJECT_TYPES})"
            ),
        )?,
        protocol_pdu: query::count(&conn, "select count(*) from protocol_pdu")?,
        protocol_someip: query::count(&conn, "select count(*) from protocol_someip")?,
        protocol_someip_sd: query::count(&conn, "select count(*) from protocol_someip_sd")?,
        protocol_doip: query::count(&conn, "select count(*) from protocol_doip")?,
    })
}

#[tauri::command]
fn list_message_groups(blf_path: String) -> Result<Vec<query::MessageGroup>, String> {
    let duckdb_path = std::path::Path::new(&blf_path).with_extension("duckdb");
    let conn = trace_store::open(&duckdb_path)?;
    query::list_message_groups(&conn)
}

#[tauri::command]
fn list_messages(
    blf_path: String,
    group_key: String,
    cursor: Option<i64>,
    limit: i64,
) -> Result<query::MessagePage, String> {
    let duckdb_path = std::path::Path::new(&blf_path).with_extension("duckdb");
    let conn = trace_store::open(&duckdb_path)?;
    query::list_messages(&conn, &group_key, cursor, limit)
}

#[tauri::command]
fn get_message_detail(blf_path: String, msg_id: i64) -> Result<query::MessageRow, String> {
    let duckdb_path = std::path::Path::new(&blf_path).with_extension("duckdb");
    let conn = trace_store::open(&duckdb_path)?;
    query::get_message_detail(&conn, msg_id)
}

#[tauri::command]
fn list_ecus(blf_path: String) -> Result<Vec<String>, String> {
    let duckdb_path = std::path::Path::new(&blf_path).with_extension("duckdb");
    let conn = trace_store::open(&duckdb_path)?;
    query::list_ecus(&conn)
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct FileSizes {
    blf_bytes: u64,
    duckdb_bytes: u64,
}

fn file_size(path: &std::path::Path) -> Result<u64, String> {
    std::fs::metadata(path)
        .map(|m| m.len())
        .map_err(|e| format!("could not read size of {}: {e}", path.display()))
}

#[tauri::command]
fn get_file_sizes(blf_path: String) -> Result<FileSizes, String> {
    let blf_bytes = file_size(std::path::Path::new(&blf_path))?;
    let duckdb_bytes = file_size(&std::path::Path::new(&blf_path).with_extension("duckdb"))?;
    Ok(FileSizes {
        blf_bytes,
        duckdb_bytes,
    })
}

#[tauri::command]
fn check_existing_store(blf_path: String) -> bool {
    let duckdb_path = std::path::Path::new(&blf_path).with_extension("duckdb");
    trace_store::open(&duckdb_path).is_ok()
}

/// Deletes `<stem>.duckdb` for `blf_path`, if present. Missing file is not an
/// error - the caller's intent ("no ingested data for this trace") already holds.
fn delete_trace_store_file(blf_path: &str) -> Result<(), String> {
    let duckdb_path = std::path::Path::new(blf_path).with_extension("duckdb");
    match std::fs::remove_file(&duckdb_path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
fn delete_trace_store(blf_path: String) -> Result<(), String> {
    delete_trace_store_file(&blf_path)
}

#[derive(Clone, serde::Serialize, serde::Deserialize)]
struct RecentTraceEntry {
    blf_path: String,
    opened_at: i64,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct RecentTraceInfo {
    blf_path: String,
    opened_at: i64,
    duckdb_bytes: Option<u64>,
}

const MAX_RECENT_TRACES: usize = 5;

/// Moves `blf_path` to the front, deduping by path, capped at
/// `MAX_RECENT_TRACES`. Pure so it's unit-testable without a Tauri app handle.
fn upsert_recent(
    mut list: Vec<RecentTraceEntry>,
    blf_path: &str,
    now: i64,
) -> Vec<RecentTraceEntry> {
    list.retain(|e| e.blf_path != blf_path);
    list.insert(
        0,
        RecentTraceEntry {
            blf_path: blf_path.to_string(),
            opened_at: now,
        },
    );
    list.truncate(MAX_RECENT_TRACES);
    list
}

fn remove_recent(list: Vec<RecentTraceEntry>, blf_path: &str) -> Vec<RecentTraceEntry> {
    list.into_iter()
        .filter(|e| e.blf_path != blf_path)
        .collect()
}

fn recent_traces_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("recent_traces.json"))
}

fn read_recent_traces(path: &std::path::Path) -> Result<Vec<RecentTraceEntry>, String> {
    match std::fs::read_to_string(path) {
        Ok(contents) => serde_json::from_str(&contents).map_err(|e| e.to_string()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
        Err(e) => Err(e.to_string()),
    }
}

fn write_recent_traces(path: &std::path::Path, list: &[RecentTraceEntry]) -> Result<(), String> {
    let json = serde_json::to_string(list).map_err(|e| e.to_string())?;
    std::fs::write(path, json).map_err(|e| e.to_string())
}

#[tauri::command]
fn record_recent_trace(app: tauri::AppHandle, blf_path: String) -> Result<(), String> {
    let path = recent_traces_path(&app)?;
    let list = read_recent_traces(&path)?;
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    write_recent_traces(&path, &upsert_recent(list, &blf_path, now))
}

#[tauri::command]
fn remove_recent_trace(app: tauri::AppHandle, blf_path: String) -> Result<(), String> {
    delete_trace_store_file(&blf_path)?;
    let path = recent_traces_path(&app)?;
    let list = read_recent_traces(&path)?;
    write_recent_traces(&path, &remove_recent(list, &blf_path))
}

#[tauri::command]
fn list_recent_traces(app: tauri::AppHandle) -> Result<Vec<RecentTraceInfo>, String> {
    let path = recent_traces_path(&app)?;
    let list = read_recent_traces(&path)?;
    Ok(list
        .into_iter()
        .map(|e| {
            let duckdb_path = std::path::Path::new(&e.blf_path).with_extension("duckdb");
            RecentTraceInfo {
                blf_path: e.blf_path,
                opened_at: e.opened_at,
                duckdb_bytes: file_size(&duckdb_path).ok(),
            }
        })
        .collect())
}

fn main() {
    tauri::Builder::default()
        .manage(PrepareGuard(Mutex::new(false)))
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            prepare_trace,
            get_trace_summary,
            list_message_groups,
            list_messages,
            get_message_detail,
            list_ecus,
            get_file_sizes,
            check_existing_store,
            delete_trace_store,
            record_recent_trace,
            remove_recent_trace,
            list_recent_traces
        ])
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
        assert!(
            err.contains("fastrace_parse not found"),
            "unexpected error: {err}"
        );
    }

    #[test]
    fn fold_final_done_picks_the_done_tick_not_the_last_running_one() {
        let ticks = vec![
            sidecar::Progress::Running {
                containers: 1,
                messages: 10000,
                elapsed_ms: 50,
            },
            sidecar::Progress::Done {
                containers: 1,
                messages: 20000,
                protocol_rows: 15,
                elapsed_ms: 120,
            },
        ];
        let v = fold_final_done(&ticks);
        assert_eq!(v["done"], true);
        assert_eq!(v["messages"], 20000);
        assert_eq!(v["protocol_rows"], 15);
    }

    #[test]
    fn fold_final_done_is_null_when_no_done_tick_present() {
        let ticks = vec![sidecar::Progress::Running {
            containers: 1,
            messages: 10000,
            elapsed_ms: 50,
        }];
        assert!(fold_final_done(&ticks).is_null());
    }

    #[test]
    fn begin_prepare_does_not_leak_guard_on_missing_binary() {
        let guard = PrepareGuard(Mutex::new(false));
        let missing = PathBuf::from("/nonexistent/fastrace_parse_test_xyz");
        assert!(begin_prepare(&guard, missing).is_err());
        guard
            .try_acquire()
            .expect("guard must not stay held after a validation failure");
    }

    #[test]
    fn file_size_errors_on_missing_file() {
        let err = file_size(&PathBuf::from("/nonexistent/fastrace_filesize_test_xyz"))
            .expect_err("missing file should error");
        assert!(
            err.contains("could not read size"),
            "unexpected error: {err}"
        );
    }

    #[test]
    fn prepare_guard_rejects_concurrent_acquire() {
        let guard = PrepareGuard(Mutex::new(false));
        guard.try_acquire().expect("first acquire should succeed");
        let err = guard
            .try_acquire()
            .expect_err("second acquire should fail while busy");
        assert!(
            err.contains("already in progress"),
            "unexpected error: {err}"
        );
        guard.release();
        guard
            .try_acquire()
            .expect("acquire after release should succeed");
    }

    #[test]
    fn upsert_recent_moves_existing_entry_to_front() {
        let list = vec![
            RecentTraceEntry {
                blf_path: "a.blf".into(),
                opened_at: 1,
            },
            RecentTraceEntry {
                blf_path: "b.blf".into(),
                opened_at: 2,
            },
        ];
        let result = upsert_recent(list, "a.blf", 99);
        assert_eq!(result.len(), 2);
        assert_eq!(result[0].blf_path, "a.blf");
        assert_eq!(result[0].opened_at, 99);
        assert_eq!(result[1].blf_path, "b.blf");
    }

    #[test]
    fn upsert_recent_caps_at_max_entries() {
        let mut list = Vec::new();
        for i in 0..MAX_RECENT_TRACES {
            list = upsert_recent(list, &format!("{i}.blf"), i as i64);
        }
        assert_eq!(list.len(), MAX_RECENT_TRACES);
        list = upsert_recent(list, "new.blf", 999);
        assert_eq!(list.len(), MAX_RECENT_TRACES);
        assert_eq!(list[0].blf_path, "new.blf");
    }

    #[test]
    fn remove_recent_filters_matching_path() {
        let list = vec![
            RecentTraceEntry {
                blf_path: "a.blf".into(),
                opened_at: 1,
            },
            RecentTraceEntry {
                blf_path: "b.blf".into(),
                opened_at: 2,
            },
        ];
        let result = remove_recent(list, "a.blf");
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].blf_path, "b.blf");
    }

    #[test]
    fn check_existing_store_false_when_duckdb_missing() {
        assert!(!check_existing_store(
            "/nonexistent/path/does_not_exist.blf".to_string()
        ));
    }

    #[test]
    fn delete_trace_store_removes_the_duckdb_file() {
        let blf_path = std::env::temp_dir().join(format!(
            "fastrace_delete_store_test_{}.blf",
            std::process::id()
        ));
        let duckdb_path = blf_path.with_extension("duckdb");
        std::fs::write(&duckdb_path, b"not a real store").unwrap();
        assert!(duckdb_path.exists());
        delete_trace_store_file(&blf_path.to_string_lossy()).expect("delete should succeed");
        assert!(!duckdb_path.exists());
    }

    #[test]
    fn delete_trace_store_is_a_noop_when_file_missing() {
        let blf_path = "/nonexistent/path/does_not_exist.blf";
        assert!(delete_trace_store_file(blf_path).is_ok());
    }

    #[test]
    fn check_existing_store_true_for_valid_store() {
        let blf_path = std::env::temp_dir().join(format!(
            "fastrace_check_store_test_{}.blf",
            std::process::id()
        ));
        let duckdb_path = blf_path.with_extension("duckdb");
        let conn = trace_store::Connection::open(&duckdb_path).unwrap();
        conn.execute_batch(
            "CREATE TABLE meta (key VARCHAR, value VARCHAR);
             INSERT INTO meta VALUES ('schema_version', '1');",
        )
        .unwrap();
        drop(conn);
        assert!(check_existing_store(blf_path.to_string_lossy().to_string()));
        let _ = std::fs::remove_file(&duckdb_path);
    }
}
