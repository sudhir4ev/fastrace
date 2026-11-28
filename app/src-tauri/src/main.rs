#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::path::PathBuf;
use std::sync::Mutex;

use tauri::menu::{Menu, MenuItemBuilder, MenuItemKind, PredefinedMenuItem, SubmenuBuilder};
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

/// Rejects a second concurrent native write op against the same store.
/// Shared by `prepare_trace` and `apply_trim` - both spawn
/// `fastrace_parse` holding the store's DuckDB write lock for the duration
/// (docs/adr/0005), so letting one run while the other starts would corrupt
/// the file, not just confuse the UI. Shortcut: a JoinError from
/// spawn_blocking skips the `release()` call - acceptable for this wave
/// since a panicking fastrace_parse run is already an exceptional case the
/// user has to restart the app for.
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
            bytes_read,
            bytes_total,
            elapsed_ms,
        } => serde_json::json!({
            "done": false, "containers": containers, "messages": messages,
            "bytes_read": bytes_read, "bytes_total": bytes_total, "elapsed_ms": elapsed_ms
        }),
        sidecar::Progress::Done {
            containers,
            messages,
            protocol_rows,
            bytes_read,
            bytes_total,
            elapsed_ms,
        } => serde_json::json!({
            "done": true, "containers": containers, "messages": messages,
            "protocol_rows": protocol_rows, "bytes_read": bytes_read, "bytes_total": bytes_total,
            "elapsed_ms": elapsed_ms
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
    if let Err(e) = delete_project_file(&blf_path) {
        app.state::<PrepareGuard>().release();
        return Err(e);
    }
    let app_for_task = app.clone();
    let blf_path_for_save = blf_path.clone();
    let arxml_path_for_save = arxml_path.clone();
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
    // Records the ARXML pairing so the footer's trace-files popup can show
    // it after reopening a Trace, where the ARXML is never re-picked.
    // Best-effort: a failure here doesn't invalidate a successful Prepare.
    if joined.is_ok() {
        let path = project_path_for(&blf_path_for_save);
        if let Ok(project) = project_store::read_project(&path, &blf_path_for_save) {
            let _ = project_store::write_project(
                &path,
                &project_store::set_arxml_path(project, arxml_path_for_save),
            );
        }
    }
    joined
}

// Builds the apply-trim sidecar argv: the window bound, then every active
// signal id. An empty id list is a stats-only recompute (still valid).
fn build_apply_trim_args(
    blf_path: String,
    start_us: i64,
    end_us: i64,
    active_signal_ids: &[i64],
) -> Vec<String> {
    let mut args = vec![
        "apply-trim".to_string(),
        blf_path,
        start_us.to_string(),
        end_us.to_string(),
    ];
    args.extend(active_signal_ids.iter().map(|id| id.to_string()));
    args
}

// Indexed incremental decode of active signals' uncovered delta (and a no-op
// when nothing needs decoding). Holds the same PrepareGuard write lock as
// prepare so it can't overlap a store write.
#[tauri::command]
async fn apply_trim(
    app: tauri::AppHandle,
    blf_path: String,
    start_us: i64,
    end_us: i64,
    active_signal_ids: Vec<i64>,
) -> Result<serde_json::Value, String> {
    let bin = begin_prepare(app.state::<PrepareGuard>().inner(), fastrace_parse_bin())?;
    let app_for_task = app.clone();
    let joined: Result<serde_json::Value, String> =
        tauri::async_runtime::spawn_blocking(move || {
            let args = build_apply_trim_args(blf_path, start_us, end_us, &active_signal_ids);
            let mut ticks = Vec::new();
            sidecar::spawn(&bin, &args, |progress| {
                let _ = app_for_task.emit("apply-trim-progress", progress_to_json(&progress));
                ticks.push(progress);
            })
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
fn get_trace_summary(blf_path: String, start_us: i64, end_us: i64) -> Result<TraceSummary, String> {
    let duckdb_path = std::path::Path::new(&blf_path).with_extension("duckdb");
    let conn = trace_store::open(&duckdb_path)?;
    Ok(TraceSummary {
        can_messages: query::count(
            &conn,
            &format!(
                "select count(*) from messages where object_type in ({CAN_OBJECT_TYPES}) and timestamp_us between {start_us} and {end_us}"
            ),
        )?,
        ethernet_messages: query::count(
            &conn,
            &format!(
                "select count(*) from messages where object_type in ({ETHERNET_OBJECT_TYPES}) and timestamp_us between {start_us} and {end_us}"
            ),
        )?,
        protocol_pdu: query::count(
            &conn,
            &format!(
                "select count(*) from protocol_pdu p join messages m on m.msg_id = p.msg_id where m.timestamp_us between {start_us} and {end_us}"
            ),
        )?,
        protocol_someip: query::count(
            &conn,
            &format!(
                "select count(*) from protocol_someip p join messages m on m.msg_id = p.msg_id where m.timestamp_us between {start_us} and {end_us}"
            ),
        )?,
        protocol_someip_sd: query::count(
            &conn,
            &format!(
                "select count(*) from protocol_someip_sd p join messages m on m.msg_id = p.msg_id where m.timestamp_us between {start_us} and {end_us}"
            ),
        )?,
        protocol_doip: query::count(
            &conn,
            &format!(
                "select count(*) from protocol_doip p join messages m on m.msg_id = p.msg_id where m.timestamp_us between {start_us} and {end_us}"
            ),
        )?,
    })
}

#[tauri::command]
fn list_message_groups(
    blf_path: String,
    start_us: i64,
    end_us: i64,
) -> Result<Vec<query::MessageGroup>, String> {
    let duckdb_path = std::path::Path::new(&blf_path).with_extension("duckdb");
    let conn = trace_store::open(&duckdb_path)?;
    query::list_message_groups(&conn, start_us, end_us)
}

#[tauri::command]
fn list_messages(
    blf_path: String,
    group_keys: Vec<String>,
    cursor: Option<i64>,
    limit: i64,
    start_us: i64,
    end_us: i64,
) -> Result<query::MessagePage, String> {
    let duckdb_path = std::path::Path::new(&blf_path).with_extension("duckdb");
    let conn = trace_store::open(&duckdb_path)?;
    query::list_messages(&conn, &group_keys, cursor, limit, start_us, end_us)
}

#[tauri::command]
fn get_message_detail(
    blf_path: String,
    msg_id: i64,
    start_us: i64,
    end_us: i64,
) -> Result<query::MessageRow, String> {
    let duckdb_path = std::path::Path::new(&blf_path).with_extension("duckdb");
    let conn = trace_store::open(&duckdb_path)?;
    query::get_message_detail(&conn, msg_id, start_us, end_us)
}

#[tauri::command]
fn count_messages(blf_path: String) -> Result<i64, String> {
    let duckdb_path = std::path::Path::new(&blf_path).with_extension("duckdb");
    let conn = trace_store::open(&duckdb_path)?;
    query::count_messages(&conn)
}

#[tauri::command]
fn count_messages_in_range(blf_path: String, start_us: i64, end_us: i64) -> Result<i64, String> {
    let duckdb_path = std::path::Path::new(&blf_path).with_extension("duckdb");
    let conn = trace_store::open(&duckdb_path)?;
    query::count_messages_in_range(&conn, start_us, end_us)
}

#[tauri::command]
fn list_container_index(blf_path: String) -> Result<Vec<query::ContainerIndexEntry>, String> {
    let duckdb_path = std::path::Path::new(&blf_path).with_extension("duckdb");
    let conn = trace_store::open(&duckdb_path)?;
    query::list_container_index(&conn)
}

#[tauri::command]
fn list_signal_coverage(blf_path: String) -> Result<Vec<query::SignalCoverageEntry>, String> {
    let duckdb_path = std::path::Path::new(&blf_path).with_extension("duckdb");
    let conn = trace_store::open(&duckdb_path)?;
    query::list_signal_coverage(&conn)
}

#[tauri::command]
fn resolve_message_position(blf_path: String, position: i64) -> Result<i64, String> {
    let duckdb_path = std::path::Path::new(&blf_path).with_extension("duckdb");
    let conn = trace_store::open(&duckdb_path)?;
    query::resolve_message_position(&conn, position)
}

#[tauri::command]
fn resolve_message_range(
    blf_path: String,
    start_pos: i64,
    end_pos: i64,
) -> Result<(i64, i64), String> {
    let duckdb_path = std::path::Path::new(&blf_path).with_extension("duckdb");
    let conn = trace_store::open(&duckdb_path)?;
    query::resolve_message_range(&conn, start_pos, end_pos)
}

#[tauri::command]
fn list_signal_catalog(blf_path: String) -> Result<Vec<query::SignalCatalogEntry>, String> {
    let duckdb_path = std::path::Path::new(&blf_path).with_extension("duckdb");
    let conn = trace_store::open(&duckdb_path)?;
    query::list_signal_catalog(&conn)
}

#[tauri::command]
fn get_signal_samples(
    blf_path: String,
    signal_id: i64,
    start_us: i64,
    end_us: i64,
    pixel_width: i64,
    algorithm: query::DownsamplingAlgorithm,
) -> Result<Vec<(i64, f64)>, String> {
    let duckdb_path = std::path::Path::new(&blf_path).with_extension("duckdb");
    let conn = trace_store::open(&duckdb_path)?;
    let target_points = query::lod_tier_point_budget(pixel_width);
    query::list_signal_samples_for_viewport(
        &conn,
        signal_id,
        start_us,
        end_us,
        target_points,
        algorithm,
    )
}

/// Recomputes Anomaly Bins over just the currently-visible viewport, at the
/// current LOD Tier - feeds the Anomaly Overlay (`CONTEXT.md`). Distinct
/// from `run_detector_query`'s fixed-500-bin Anomaly Bins, which stay scoped
/// to the whole run and feed the Anomaly Heatmap unchanged (`docs/adr/0009`).
#[tauri::command]
fn get_anomaly_bins_for_viewport(
    blf_path: String,
    sql: String,
    start_us: i64,
    end_us: i64,
    pixel_width: i64,
) -> Result<Vec<query::AnomalyBin>, String> {
    let duckdb_path = std::path::Path::new(&blf_path).with_extension("duckdb");
    let conn = trace_store::open(&duckdb_path)?;
    let bin_count = query::lod_tier_point_budget(pixel_width);
    query::compute_anomaly_bins(&conn, &sql, start_us, end_us, bin_count)
}

#[tauri::command]
fn list_ecus(blf_path: String) -> Result<Vec<String>, String> {
    let duckdb_path = std::path::Path::new(&blf_path).with_extension("duckdb");
    let conn = trace_store::open(&duckdb_path)?;
    query::list_ecus(&conn)
}

#[tauri::command]
fn get_trace_time_range(blf_path: String) -> Result<query::TraceTimeRange, String> {
    let duckdb_path = std::path::Path::new(&blf_path).with_extension("duckdb");
    let conn = trace_store::open(&duckdb_path)?;
    query::get_trace_time_range(&conn)
}

/// Payload when target signals are not yet decoded for the run scope - the
/// UI confirms, runs apply-trim, then re-invokes.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct NeedsDecodeInfo {
    missing: Vec<query::MissingSignal>,
    whole_trace: bool,
    blf_bytes: u64,
    scope_start_us: i64,
    scope_end_us: i64,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct DetectorQueryRan {
    matches: Vec<query::DetectorMatch>,
    truncated: bool,
    bins: Vec<query::AnomalyBin>,
    scope_start_us: i64,
    scope_end_us: i64,
    whole_trace: bool,
    elapsed_ms: i64,
    target_signal_ids: Vec<i64>,
}

/// Adjacent-tagged response: exactly one of `needsDecode` / `ran` is set.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct DetectorQueryResponse {
    #[serde(skip_serializing_if = "Option::is_none")]
    needs_decode: Option<NeedsDecodeInfo>,
    #[serde(skip_serializing_if = "Option::is_none")]
    ran: Option<DetectorQueryRan>,
}

#[tauri::command]
fn run_explorer_table_page(
    blf_path: String,
    sql: String,
    page_size: i64,
    offset: i64,
    order_by_column: Option<String>,
    order_by_desc: bool,
) -> Result<query::ExplorerTablePage, String> {
    let duckdb_path = std::path::Path::new(&blf_path).with_extension("duckdb");
    let conn = trace_store::open(&duckdb_path)?;
    query::run_explorer_table_page(
        &conn,
        &sql,
        page_size,
        offset,
        order_by_column.as_deref(),
        order_by_desc,
    )
}

#[tauri::command]
fn run_explorer_chart_query(
    blf_path: String,
    base_sql: String,
    config: query::ExplorerChartConfig,
    metric: Option<query::ExplorerChartMetric>,
    row_limit: i64,
) -> Result<query::ExplorerChartResult, String> {
    let duckdb_path = std::path::Path::new(&blf_path).with_extension("duckdb");
    let conn = trace_store::open(&duckdb_path)?;
    match metric {
        Some(m) => query::run_explorer_chart_query_grouped(&conn, &base_sql, &config, &m, row_limit),
        None => query::run_explorer_chart_query_ungrouped(&conn, &base_sql, &config, row_limit),
    }
}

#[tauri::command]
fn run_detector_query(
    blf_path: String,
    sql: String,
    respect_trim: bool,
    start_us: i64,
    end_us: i64,
    target_signal_ids: Vec<i64>,
) -> Result<DetectorQueryResponse, String> {
    let duckdb_path = std::path::Path::new(&blf_path).with_extension("duckdb");
    let conn = trace_store::open(&duckdb_path)?;
    let whole_trace = !respect_trim;
    let (scope_start, scope_end) = if respect_trim {
        (start_us, end_us)
    } else {
        let range = query::get_trace_time_range(&conn)?;
        (range.min_timestamp_us, range.max_timestamp_us)
    };
    let missing =
        query::missing_signal_coverage(&conn, &target_signal_ids, scope_start, scope_end)?;
    if !missing.is_empty() {
        let blf_bytes = file_size(std::path::Path::new(&blf_path)).unwrap_or(0);
        return Ok(DetectorQueryResponse {
            needs_decode: Some(NeedsDecodeInfo {
                missing,
                whole_trace,
                blf_bytes,
                scope_start_us: scope_start,
                scope_end_us: scope_end,
            }),
            ran: None,
        });
    }
    let started = std::time::Instant::now();
    let result = query::run_detector_query(
        &conn,
        &sql,
        query::LOD.detector_query_match_limit,
        scope_start,
        scope_end,
    )?;
    let elapsed_ms = started.elapsed().as_millis() as i64;
    Ok(DetectorQueryResponse {
        needs_decode: None,
        ran: Some(DetectorQueryRan {
            matches: result.matches,
            truncated: result.truncated,
            bins: result.bins,
            scope_start_us: result.scope_start_us,
            scope_end_us: result.scope_end_us,
            whole_trace,
            elapsed_ms,
            target_signal_ids,
        }),
    })
}

/// Generic Analyzer Framework commands (docs/superpowers/plans/2026-11-27-tcp-analyzer-wave1-ingest.md,
/// "Analyzer Framework Contract"). Zero protocol-specific knowledge - all
/// four are parameterized by `analyzer_name`; adding a second analyzer adds
/// no new commands.
#[tauri::command]
fn list_analyzers() -> Vec<String> {
    query::list_analyzers().into_iter().map(str::to_string).collect()
}

#[tauri::command]
fn get_default_analyzer_config(analyzer_name: String) -> Result<String, String> {
    query::get_default_analyzer_config(&analyzer_name).map(str::to_string)
}

fn resolve_scope(
    conn: &trace_store::Connection,
    respect_trim: bool,
    start_us: i64,
    end_us: i64,
) -> Result<(i64, i64), String> {
    if respect_trim {
        Ok((start_us, end_us))
    } else {
        let range = query::get_trace_time_range(conn)?;
        Ok((range.min_timestamp_us, range.max_timestamp_us))
    }
}

#[tauri::command]
fn list_findings(
    blf_path: String,
    analyzer_name: String,
    config_json: String,
    respect_trim: bool,
    start_us: i64,
    end_us: i64,
) -> Result<Vec<query::Finding>, String> {
    let duckdb_path = std::path::Path::new(&blf_path).with_extension("duckdb");
    let conn = trace_store::open(&duckdb_path)?;
    let (scope_start, scope_end) = resolve_scope(&conn, respect_trim, start_us, end_us)?;
    query::list_findings(&conn, &analyzer_name, &config_json, scope_start, scope_end)
}

#[tauri::command]
fn list_sessions(
    blf_path: String,
    analyzer_name: String,
    config_json: String,
    respect_trim: bool,
    start_us: i64,
    end_us: i64,
) -> Result<Vec<query::Session>, String> {
    let duckdb_path = std::path::Path::new(&blf_path).with_extension("duckdb");
    let conn = trace_store::open(&duckdb_path)?;
    let (scope_start, scope_end) = resolve_scope(&conn, respect_trim, start_us, end_us)?;
    query::list_sessions(&conn, &analyzer_name, &config_json, scope_start, scope_end)
}

#[tauri::command]
fn list_segments(
    blf_path: String,
    analyzer_name: String,
    config_json: String,
    src_node: String,
    dst_node: String,
    stream_index: i64,
) -> Result<Vec<query::Segment>, String> {
    let duckdb_path = std::path::Path::new(&blf_path).with_extension("duckdb");
    let conn = trace_store::open(&duckdb_path)?;
    query::list_segments(&conn, &analyzer_name, &config_json, &src_node, &dst_node, stream_index)
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
fn get_path_size(path: String) -> Result<u64, String> {
    file_size(std::path::Path::new(&path))
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

/// Deletes `<stem>.fastrace-project.json` for `blf_path`, if present. Missing
/// file is not an error - same contract as `delete_trace_store_file`.
fn delete_project_file(blf_path: &str) -> Result<(), String> {
    let path = project_store::project_file_path(std::path::Path::new(blf_path));
    match std::fs::remove_file(&path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
fn delete_trace_store(blf_path: String) -> Result<(), String> {
    delete_project_file(&blf_path)?;
    delete_trace_store_file(&blf_path)
}

/// One row in a trace's activity log (initial ingestion, each signal-decode
/// run, ...) - shown in the footer's "last activity" popup.
#[derive(Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct ActivityEntry {
    kind: String,
    at: i64,
    elapsed_ms: i64,
    detail: String,
}

#[derive(Clone, serde::Serialize, serde::Deserialize)]
struct RecentTraceEntry {
    blf_path: String,
    opened_at: i64,
    #[serde(default)]
    messages: Option<i64>,
    #[serde(default)]
    protocol_rows: Option<i64>,
    #[serde(default)]
    elapsed_ms: Option<i64>,
    #[serde(default)]
    activities: Vec<ActivityEntry>,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct RecentTraceInfo {
    blf_path: String,
    opened_at: i64,
    duckdb_bytes: Option<u64>,
    messages: Option<i64>,
    protocol_rows: Option<i64>,
    elapsed_ms: Option<i64>,
}

const MAX_RECENT_TRACES: usize = 5;

/// Moves `blf_path` to the front, deduping by path, capped at
/// `MAX_RECENT_TRACES`. Pure so it's unit-testable without a Tauri app handle.
/// `messages`/`protocol_rows`/`elapsed_ms` of `None` keep the previous
/// entry's values (e.g. re-opening a trace from the recent list shouldn't
/// erase the ingestion stats recorded when it was first prepared).
fn upsert_recent(
    mut list: Vec<RecentTraceEntry>,
    blf_path: &str,
    now: i64,
    messages: Option<i64>,
    protocol_rows: Option<i64>,
    elapsed_ms: Option<i64>,
) -> Vec<RecentTraceEntry> {
    let previous = list.iter().find(|e| e.blf_path == blf_path).cloned();
    list.retain(|e| e.blf_path != blf_path);
    list.insert(
        0,
        RecentTraceEntry {
            blf_path: blf_path.to_string(),
            opened_at: now,
            messages: messages.or_else(|| previous.as_ref().and_then(|p| p.messages)),
            protocol_rows: protocol_rows
                .or_else(|| previous.as_ref().and_then(|p| p.protocol_rows)),
            elapsed_ms: elapsed_ms.or_else(|| previous.as_ref().and_then(|p| p.elapsed_ms)),
            // Re-opening a trace rebuilds this entry from scratch (see the
            // `retain` above) - without carrying the old activity log
            // forward, every reopen would silently wipe it.
            activities: previous
                .as_ref()
                .map(|p| p.activities.clone())
                .unwrap_or_default(),
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

/// Appends one activity entry to the matching trace, creating a minimal
/// entry if none exists yet (shouldn't normally happen - `record_recent_trace`
/// runs first on every Prepare - but keeps this pure function total rather
/// than silently dropping the activity).
fn push_activity(
    mut list: Vec<RecentTraceEntry>,
    blf_path: &str,
    entry: ActivityEntry,
) -> Vec<RecentTraceEntry> {
    match list.iter_mut().find(|e| e.blf_path == blf_path) {
        Some(e) => e.activities.push(entry),
        None => list.push(RecentTraceEntry {
            blf_path: blf_path.to_string(),
            opened_at: entry.at,
            messages: None,
            protocol_rows: None,
            elapsed_ms: None,
            activities: vec![entry],
        }),
    }
    list
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
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
fn record_recent_trace(
    app: tauri::AppHandle,
    blf_path: String,
    messages: Option<i64>,
    protocol_rows: Option<i64>,
    elapsed_ms: Option<i64>,
) -> Result<(), String> {
    let path = recent_traces_path(&app)?;
    let list = read_recent_traces(&path)?;
    let now = now_ms();
    let mut list = upsert_recent(list, &blf_path, now, messages, protocol_rows, elapsed_ms);
    // Only a genuine fresh-Prepare completion carries all three stats - this
    // command is also called when merely reopening an already-ingested trace
    // (with everything `None`), which must not log a bogus "prepare" entry.
    if let (Some(messages), Some(_), Some(elapsed_ms)) = (messages, protocol_rows, elapsed_ms) {
        list = push_activity(
            list,
            &blf_path,
            ActivityEntry {
                kind: "prepare".to_string(),
                at: now,
                elapsed_ms,
                detail: format!("{messages} messages"),
            },
        );
    }
    write_recent_traces(&path, &list)
}

#[tauri::command]
fn record_activity(
    app: tauri::AppHandle,
    blf_path: String,
    kind: String,
    elapsed_ms: i64,
    detail: String,
) -> Result<(), String> {
    let path = recent_traces_path(&app)?;
    let list = read_recent_traces(&path)?;
    let entry = ActivityEntry {
        kind,
        at: now_ms(),
        elapsed_ms,
        detail,
    };
    write_recent_traces(&path, &push_activity(list, &blf_path, entry))
}

#[tauri::command]
fn list_activities(app: tauri::AppHandle, blf_path: String) -> Result<Vec<ActivityEntry>, String> {
    let path = recent_traces_path(&app)?;
    let list = read_recent_traces(&path)?;
    Ok(list
        .into_iter()
        .find(|e| e.blf_path == blf_path)
        .map(|e| e.activities)
        .unwrap_or_default())
}

#[tauri::command]
fn remove_recent_trace(app: tauri::AppHandle, blf_path: String) -> Result<(), String> {
    delete_trace_store_file(&blf_path)?;
    delete_project_file(&blf_path)?;
    let path = recent_traces_path(&app)?;
    let list = read_recent_traces(&path)?;
    write_recent_traces(&path, &remove_recent(list, &blf_path))
}

fn project_path_for(blf_path: &str) -> PathBuf {
    project_store::project_file_path(std::path::Path::new(blf_path))
}

#[tauri::command]
fn get_project(blf_path: String) -> Result<project_store::ProjectFile, String> {
    let path = project_path_for(&blf_path);
    project_store::read_project(&path, &blf_path)
}

/// Single autosave entry point - one `read_project`/`write_project` cycle
/// for all three mutable fields together. The frontend's debounced autosave
/// (Task 5) calls this instead of three separate commands so concurrent
/// fire-and-forget writes can't race and clobber each other's read.
/// `trim_window: None` explicitly clears a previously-set Trim Window
/// (`resetTrimRange()` on the frontend) rather than leaving it untouched.
/// Residual gap (accepted): this still has no lock against concurrent
/// record_query/remove_query/clear_query_history read-modify-write cycles on
/// the same file; in practice the ~1s autosave debounce and near-instant file
/// ops make an actual race very unlikely.
#[tauri::command]
fn save_project(
    blf_path: String,
    displayed_signal_ids: Vec<i64>,
    trim_window: Option<project_store::TrimWindow>,
    downsampling_algorithms: std::collections::HashMap<i64, String>,
) -> Result<(), String> {
    let path = project_path_for(&blf_path);
    let mut project = project_store::read_project(&path, &blf_path)?;
    project = project_store::set_displayed_signals(project, displayed_signal_ids);
    project = match trim_window {
        Some(tw) => project_store::set_trim_window(project, tw.start_us, tw.end_us),
        None => project_store::clear_trim_window(project),
    };
    for (signal_id, algorithm) in downsampling_algorithms {
        project = project_store::set_downsampling_algorithm(project, signal_id, algorithm);
    }
    project_store::write_project(&path, &project)
}

#[tauri::command]
fn list_query_history(blf_path: String) -> Result<Vec<project_store::QueryHistoryEntry>, String> {
    let path = project_path_for(&blf_path);
    Ok(project_store::read_project(&path, &blf_path)?.query_history)
}

#[tauri::command]
fn record_query(
    blf_path: String,
    sql: String,
    target_signal_ids: Vec<i64>,
    respect_trim: bool,
    match_count: i64,
) -> Result<(), String> {
    let path = project_path_for(&blf_path);
    let project = project_store::read_project(&path, &blf_path)?;
    let entry = project_store::QueryHistoryEntry {
        sql,
        target_signal_ids,
        respect_trim,
        ran_at: now_ms(),
        match_count,
    };
    project_store::write_project(&path, &project_store::push_query(project, entry))
}

#[tauri::command]
fn remove_query(blf_path: String, sql: String) -> Result<(), String> {
    let path = project_path_for(&blf_path);
    let project = project_store::read_project(&path, &blf_path)?;
    project_store::write_project(&path, &project_store::remove_query(project, &sql))
}

#[tauri::command]
fn clear_query_history(blf_path: String) -> Result<(), String> {
    let path = project_path_for(&blf_path);
    let project = project_store::read_project(&path, &blf_path)?;
    project_store::write_project(&path, &project_store::clear_query_history(project))
}

#[tauri::command]
fn list_explorer_query_history(blf_path: String) -> Result<Vec<project_store::ExplorerQueryEntry>, String> {
    let path = project_path_for(&blf_path);
    Ok(project_store::read_project(&path, &blf_path)?.explorer_query_history)
}

#[tauri::command]
fn record_explorer_query(blf_path: String, sql: String, row_count: i64) -> Result<(), String> {
    let path = project_path_for(&blf_path);
    let project = project_store::read_project(&path, &blf_path)?;
    let entry = project_store::ExplorerQueryEntry { sql, ran_at: now_ms(), row_count };
    project_store::write_project(&path, &project_store::push_explorer_query(project, entry))
}

#[tauri::command]
fn remove_explorer_query(blf_path: String, sql: String) -> Result<(), String> {
    let path = project_path_for(&blf_path);
    let project = project_store::read_project(&path, &blf_path)?;
    project_store::write_project(&path, &project_store::remove_explorer_query(project, &sql))
}

#[tauri::command]
fn clear_explorer_query_history(blf_path: String) -> Result<(), String> {
    let path = project_path_for(&blf_path);
    let project = project_store::read_project(&path, &blf_path)?;
    project_store::write_project(&path, &project_store::clear_explorer_query_history(project))
}

#[tauri::command]
fn list_explorer_saved_queries(blf_path: String) -> Result<Vec<project_store::SavedExplorerQuery>, String> {
    let path = project_path_for(&blf_path);
    Ok(project_store::read_project(&path, &blf_path)?.explorer_saved_queries)
}

#[tauri::command]
fn save_explorer_query(blf_path: String, name: String, sql: String) -> Result<(), String> {
    let path = project_path_for(&blf_path);
    let project = project_store::read_project(&path, &blf_path)?;
    let entry = project_store::SavedExplorerQuery { name, sql, saved_at: now_ms() };
    project_store::write_project(&path, &project_store::save_explorer_query(project, entry))
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
                messages: e.messages,
                protocol_rows: e.protocol_rows,
                elapsed_ms: e.elapsed_ms,
            }
        })
        .collect())
}

fn main() {
    tauri::Builder::default()
        .manage(PrepareGuard(Mutex::new(false)))
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            // Keep Tauri's default menubar (Quit lives in the app menu on macOS)
            // and put Close Project under a separate File submenu.
            let menu = Menu::default(app.handle())?;
            let close_project =
                MenuItemBuilder::with_id("close-project", "Close Project").build(app)?;
            let mut file_found = false;
            for item in menu.items()? {
                if let MenuItemKind::Submenu(submenu) = item {
                    if submenu.text()? == "File" {
                        submenu.prepend(&PredefinedMenuItem::separator(app)?)?;
                        submenu.prepend(&close_project)?;
                        file_found = true;
                        break;
                    }
                }
            }
            if !file_found {
                // Linux default menu has no File submenu.
                let file_menu = SubmenuBuilder::new(app, "File")
                    .item(&close_project)
                    .build()?;
                menu.prepend(&file_menu)?;
            }
            app.set_menu(menu)?;
            app.on_menu_event(|app, event| {
                if event.id() == "close-project" {
                    let _ = app.emit("close-project", ());
                }
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            prepare_trace,
            apply_trim,
            get_trace_summary,
            list_message_groups,
            list_messages,
            get_message_detail,
            list_signal_catalog,
            get_signal_samples,
            get_anomaly_bins_for_viewport,
            list_ecus,
            get_trace_time_range,
            count_messages,
            count_messages_in_range,
            list_container_index,
            list_signal_coverage,
            resolve_message_position,
            resolve_message_range,
            run_explorer_table_page,
            run_explorer_chart_query,
            run_detector_query,
            list_analyzers,
            get_default_analyzer_config,
            list_findings,
            list_sessions,
            list_segments,
            get_file_sizes,
            get_path_size,
            check_existing_store,
            delete_trace_store,
            record_recent_trace,
            remove_recent_trace,
            list_recent_traces,
            record_activity,
            list_activities,
            list_query_history,
            record_query,
            remove_query,
            clear_query_history,
            list_explorer_query_history,
            record_explorer_query,
            remove_explorer_query,
            clear_explorer_query_history,
            list_explorer_saved_queries,
            save_explorer_query,
            get_project,
            save_project
        ])
        .run(tauri::generate_context!())
        .expect("error while running fastrace");
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write_minimal_store_for_signal_tests(path: &std::path::Path) {
        let conn = trace_store::Connection::open(path).unwrap();
        conn.execute_batch(
            "CREATE TABLE meta (key VARCHAR, value VARCHAR);
             INSERT INTO meta VALUES ('schema_version', '5');
             CREATE TABLE messages (msg_id BIGINT, timestamp_us BIGINT, object_type INTEGER, arb_id INTEGER, dst_ip VARCHAR, dst_port INTEGER, dlc INTEGER, payload_len INTEGER);
             CREATE TABLE arxml_signal (signal_id BIGINT, name VARCHAR, parent_kind VARCHAR, parent_id BIGINT, start_bit INTEGER, bit_length INTEGER, big_endian BOOLEAN, factor DOUBLE, \"offset\" DOUBLE);
             CREATE TABLE signals (signal_id BIGINT, msg_id BIGINT, timestamp_us BIGINT, raw_value UBIGINT, phys_value DOUBLE);
             INSERT INTO messages VALUES (0, 1000, 1, 100, NULL, NULL, 8, 8);
             INSERT INTO messages VALUES (1, 2000, 1, 100, NULL, NULL, 8, 8);
             INSERT INTO arxml_signal VALUES (0, 'EngineRpm', 'can', 100, 0, 16, false, 0.25, 0.0);
             INSERT INTO signals VALUES (0, 0, 1000, 0, 10.0);
             INSERT INTO signals VALUES (0, 1, 2000, 0, 20.0);",
        )
        .unwrap();
    }

    #[test]
    fn get_signal_samples_delegates_to_query_crate() {
        let dir = std::env::temp_dir().join(format!(
            "get_signal_samples_test_{}.duckdb",
            std::process::id()
        ));
        write_minimal_store_for_signal_tests(&dir);
        let blf_path = dir.with_extension("blf").to_string_lossy().to_string();
        let out = get_signal_samples(
            blf_path,
            0,
            0,
            3000,
            400,
            query::DownsamplingAlgorithm::MinMax,
        )
        .unwrap();
        assert_eq!(out.len(), 2);
        let _ = std::fs::remove_file(&dir);
    }

    #[test]
    fn get_anomaly_bins_for_viewport_delegates_to_query_crate() {
        let dir = std::env::temp_dir().join(format!(
            "get_anomaly_bins_viewport_test_{}.duckdb",
            std::process::id()
        ));
        write_minimal_store_for_signal_tests(&dir);
        let blf_path = dir.with_extension("blf").to_string_lossy().to_string();
        let bins = get_anomaly_bins_for_viewport(
            blf_path,
            "select msg_id, timestamp_us from messages".to_string(),
            0,
            3000,
            400,
        )
        .unwrap();
        assert!(!bins.is_empty());
        let _ = std::fs::remove_file(&dir);
    }

    #[test]
    fn get_anomaly_bins_for_viewport_surfaces_bad_sql_as_error() {
        let dir = std::env::temp_dir().join(format!(
            "get_anomaly_bins_viewport_err_test_{}.duckdb",
            std::process::id()
        ));
        write_minimal_store_for_signal_tests(&dir);
        let blf_path = dir.with_extension("blf").to_string_lossy().to_string();
        let err = get_anomaly_bins_for_viewport(
            blf_path,
            "select * from no_such_table".to_string(),
            0,
            3000,
            400,
        )
        .unwrap_err();
        assert!(!err.is_empty());
        let _ = std::fs::remove_file(&dir);
    }

    #[test]
    fn get_trace_summary_bounds_protocol_counts_via_join() {
        let conn = trace_store::Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE messages (msg_id BIGINT, timestamp_us BIGINT, object_type INTEGER, arb_id INTEGER, dst_ip VARCHAR, dst_port INTEGER);
             CREATE TABLE protocol_pdu (msg_id BIGINT, pdu_id BIGINT, length BIGINT);
             CREATE TABLE protocol_someip (msg_id BIGINT);
             CREATE TABLE protocol_someip_sd (msg_id BIGINT);
             CREATE TABLE protocol_doip (msg_id BIGINT);
             INSERT INTO messages VALUES (1, 1000, 1, 100, NULL, NULL);
             INSERT INTO messages VALUES (2, 2000, 1, 100, NULL, NULL);
             INSERT INTO protocol_pdu VALUES (1, 1, 4), (2, 1, 4);",
        )
        .unwrap();
        let bounded = query::count(
            &conn,
            "select count(*) from protocol_pdu p join messages m on m.msg_id = p.msg_id where m.timestamp_us between 1000 and 1000",
        )
        .unwrap();
        assert_eq!(
            bounded, 1,
            "only msg_id=1's protocol_pdu row is inside [1000,1000]"
        );
        let unbounded = query::count(
            &conn,
            "select count(*) from protocol_pdu p join messages m on m.msg_id = p.msg_id where m.timestamp_us between 0 and 10000",
        )
        .unwrap();
        assert_eq!(
            unbounded, 2,
            "both rows are inside the full span - the join doesn't drop/double-count rows"
        );
    }

    #[test]
    fn apply_trim_args_shape_appends_active_ids() {
        let args = build_apply_trim_args("trace.blf".to_string(), 100, 200, &[7, 9]);
        assert_eq!(
            args,
            vec!["apply-trim", "trace.blf", "100", "200", "7", "9"]
        );
        // No active signals: a stats-only recompute still passes start/end.
        let none = build_apply_trim_args("t.blf".to_string(), 0, 5, &[]);
        assert_eq!(none, vec!["apply-trim", "t.blf", "0", "5"]);
    }

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
    fn progress_to_json_includes_byte_progress() {
        let p = sidecar::Progress::Done {
            containers: 1,
            messages: 6,
            protocol_rows: 5,
            bytes_read: 2000,
            bytes_total: 2000,
            elapsed_ms: 78,
        };
        let v = progress_to_json(&p);
        assert_eq!(v["bytes_read"], 2000);
        assert_eq!(v["bytes_total"], 2000);
    }

    #[test]
    fn fold_final_done_picks_the_done_tick_not_the_last_running_one() {
        let ticks = vec![
            sidecar::Progress::Running {
                containers: 1,
                messages: 10000,
                bytes_read: 500_000,
                bytes_total: 1_000_000,
                elapsed_ms: 50,
            },
            sidecar::Progress::Done {
                containers: 1,
                messages: 20000,
                protocol_rows: 15,
                bytes_read: 1_000_000,
                bytes_total: 1_000_000,
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
            bytes_read: 500_000,
            bytes_total: 1_000_000,
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
                messages: None,
                protocol_rows: None,
                elapsed_ms: None,
                activities: vec![],
            },
            RecentTraceEntry {
                blf_path: "b.blf".into(),
                opened_at: 2,
                messages: None,
                protocol_rows: None,
                elapsed_ms: None,
                activities: vec![],
            },
        ];
        let result = upsert_recent(list, "a.blf", 99, None, None, None);
        assert_eq!(result.len(), 2);
        assert_eq!(result[0].blf_path, "a.blf");
        assert_eq!(result[0].opened_at, 99);
        assert_eq!(result[1].blf_path, "b.blf");
    }

    #[test]
    fn upsert_recent_keeps_previous_metadata_when_not_provided() {
        let list = vec![RecentTraceEntry {
            blf_path: "a.blf".into(),
            opened_at: 1,
            messages: Some(1000),
            protocol_rows: Some(5),
            elapsed_ms: Some(2500),
            activities: vec![],
        }];
        let result = upsert_recent(list, "a.blf", 99, None, None, None);
        assert_eq!(result[0].messages, Some(1000));
        assert_eq!(result[0].protocol_rows, Some(5));
        assert_eq!(result[0].elapsed_ms, Some(2500));
    }

    #[test]
    fn upsert_recent_preserves_activities_across_reopen() {
        let list = vec![RecentTraceEntry {
            blf_path: "a.blf".into(),
            opened_at: 1,
            messages: Some(1000),
            protocol_rows: Some(5),
            elapsed_ms: Some(2500),
            activities: vec![ActivityEntry {
                kind: "prepare".into(),
                at: 1,
                elapsed_ms: 2500,
                detail: "1000 messages".into(),
            }],
        }];
        let result = upsert_recent(list, "a.blf", 99, None, None, None);
        assert_eq!(
            result[0].activities.len(),
            1,
            "reopening must not wipe the activity log"
        );
    }

    #[test]
    fn push_activity_appends_to_existing_entry() {
        let list = vec![RecentTraceEntry {
            blf_path: "a.blf".into(),
            opened_at: 1,
            messages: Some(1000),
            protocol_rows: Some(5),
            elapsed_ms: Some(2500),
            activities: vec![],
        }];
        let result = push_activity(
            list,
            "a.blf",
            ActivityEntry {
                kind: "decode".into(),
                at: 2,
                elapsed_ms: 11,
                detail: "3 signals".into(),
            },
        );
        assert_eq!(result[0].activities.len(), 1);
        assert_eq!(result[0].activities[0].kind, "decode");
    }

    #[test]
    fn push_activity_creates_entry_when_missing() {
        let result = push_activity(
            Vec::new(),
            "a.blf",
            ActivityEntry {
                kind: "decode".into(),
                at: 2,
                elapsed_ms: 11,
                detail: "3 signals".into(),
            },
        );
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].blf_path, "a.blf");
        assert_eq!(result[0].activities.len(), 1);
    }

    #[test]
    fn upsert_recent_caps_at_max_entries() {
        let mut list = Vec::new();
        for i in 0..MAX_RECENT_TRACES {
            list = upsert_recent(list, &format!("{i}.blf"), i as i64, None, None, None);
        }
        assert_eq!(list.len(), MAX_RECENT_TRACES);
        list = upsert_recent(list, "new.blf", 999, None, None, None);
        assert_eq!(list.len(), MAX_RECENT_TRACES);
        assert_eq!(list[0].blf_path, "new.blf");
    }

    #[test]
    fn remove_recent_filters_matching_path() {
        let list = vec![
            RecentTraceEntry {
                blf_path: "a.blf".into(),
                opened_at: 1,
                messages: None,
                protocol_rows: None,
                elapsed_ms: None,
                activities: vec![],
            },
            RecentTraceEntry {
                blf_path: "b.blf".into(),
                opened_at: 2,
                messages: None,
                protocol_rows: None,
                elapsed_ms: None,
                activities: vec![],
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
             INSERT INTO meta VALUES ('schema_version', '5');",
        )
        .unwrap();
        drop(conn);
        assert!(check_existing_store(blf_path.to_string_lossy().to_string()));
        let _ = std::fs::remove_file(&duckdb_path);
    }

    #[test]
    fn get_project_returns_defaults_for_a_brand_new_trace() {
        let dir = std::env::temp_dir();
        let blf_path = dir.join(format!("project_test_fresh_{}.blf", std::process::id()));
        let blf_path = blf_path.to_string_lossy().to_string();
        let project = get_project(blf_path).unwrap();
        assert_eq!(project.displayed_signal_ids, Vec::<i64>::new());
        assert!(project.trim_window.is_none());
    }

    #[test]
    fn save_project_round_trips_displayed_signals_trim_window_and_algorithms() {
        let dir = std::env::temp_dir();
        let blf_path = dir.join(format!("project_test_roundtrip_{}.blf", std::process::id()));
        let blf_path = blf_path.to_string_lossy().to_string();
        let mut algorithms = std::collections::HashMap::new();
        algorithms.insert(1i64, "lttb".to_string());
        save_project(
            blf_path.clone(),
            vec![1, 2],
            Some(project_store::TrimWindow {
                start_us: 100,
                end_us: 200,
            }),
            algorithms,
        )
        .unwrap();
        let project = get_project(blf_path.clone()).unwrap();
        assert_eq!(project.displayed_signal_ids, vec![1, 2]);
        assert_eq!(
            project.trim_window,
            Some(project_store::TrimWindow {
                start_us: 100,
                end_us: 200
            })
        );
        assert_eq!(
            project.traces[0].downsampling_algorithms.get(&1),
            Some(&"lttb".to_string())
        );
        let _ = std::fs::remove_file(project_store::project_file_path(std::path::Path::new(
            &blf_path,
        )));
    }

    #[test]
    fn save_project_with_none_trim_window_clears_a_previously_set_one() {
        let dir = std::env::temp_dir();
        let blf_path = dir.join(format!(
            "project_test_clear_trim_{}.blf",
            std::process::id()
        ));
        let blf_path = blf_path.to_string_lossy().to_string();
        save_project(
            blf_path.clone(),
            vec![],
            Some(project_store::TrimWindow {
                start_us: 1,
                end_us: 2,
            }),
            std::collections::HashMap::new(),
        )
        .unwrap();
        save_project(
            blf_path.clone(),
            vec![],
            None,
            std::collections::HashMap::new(),
        )
        .unwrap();
        let project = get_project(blf_path.clone()).unwrap();
        assert!(project.trim_window.is_none());
        let _ = std::fs::remove_file(project_store::project_file_path(std::path::Path::new(
            &blf_path,
        )));
    }

    #[test]
    fn query_history_commands_persist_to_the_project_file_not_recent_traces() {
        let dir = std::env::temp_dir();
        let blf_path = dir.join(format!("project_test_queries_{}.blf", std::process::id()));
        let blf_path = blf_path.to_string_lossy().to_string();
        record_query(blf_path.clone(), "select 1".to_string(), vec![], true, 3).unwrap();
        let history = list_query_history(blf_path.clone()).unwrap();
        assert_eq!(history.len(), 1);
        assert_eq!(history[0].match_count, 3);
        remove_query(blf_path.clone(), "select 1".to_string()).unwrap();
        assert!(list_query_history(blf_path.clone()).unwrap().is_empty());
        let _ = std::fs::remove_file(project_store::project_file_path(std::path::Path::new(
            &blf_path,
        )));
    }

    #[test]
    fn delete_project_file_is_not_an_error_when_file_is_absent() {
        let dir = std::env::temp_dir();
        let blf_path = dir.join(format!(
            "project_test_delete_missing_{}.blf",
            std::process::id()
        ));
        assert!(delete_project_file(&blf_path.to_string_lossy()).is_ok());
    }

    #[test]
    fn delete_project_file_removes_an_existing_file() {
        let dir = std::env::temp_dir();
        let blf_path = dir.join(format!(
            "project_test_delete_existing_{}.blf",
            std::process::id()
        ));
        let blf_path_str = blf_path.to_string_lossy().to_string();
        save_project(
            blf_path_str.clone(),
            vec![1],
            None,
            std::collections::HashMap::new(),
        )
        .unwrap();
        let path = project_store::project_file_path(&blf_path);
        assert!(path.exists());
        delete_project_file(&blf_path_str).unwrap();
        assert!(!path.exists());
    }

    #[test]
    fn arxml_path_persist_sequence_is_visible_via_get_project() {
        // Exercises the same read/set/write sequence `prepare_trace` runs on
        // a successful Prepare - can't call `prepare_trace` itself here, it
        // shells out to the real sidecar binary.
        let dir = std::env::temp_dir();
        let blf_path = dir.join(format!("project_test_arxml_{}.blf", std::process::id()));
        let blf_path_str = blf_path.to_string_lossy().to_string();
        let path = project_path_for(&blf_path_str);
        let project = project_store::read_project(&path, &blf_path_str).unwrap();
        project_store::write_project(
            &path,
            &project_store::set_arxml_path(project, "/t.arxml".to_string()),
        )
        .unwrap();
        let project = get_project(blf_path_str).unwrap();
        assert_eq!(project.traces[0].arxml_path, Some("/t.arxml".to_string()));
        let _ = std::fs::remove_file(&path);
    }

    /// Builds a minimal real `.duckdb` Trace Store (right schema_version, a
    /// `messages` table) at a unique temp path, for commands that actually
    /// call `trace_store::open` and run SQL against it. `name` must be
    /// unique per test (same convention as the other fixture paths in this
    /// module, e.g. `project_test_queries_*`) so concurrently-run tests
    /// never collide on the same file. Returns the `.blf` path; the caller
    /// is responsible for removing the `.duckdb` file afterward, same as
    /// every other fixture-cleanup test in this module.
    fn fixture_trace_store(name: &str) -> String {
        let dir = std::env::temp_dir();
        let blf_path = dir.join(format!("explorer_fixture_{name}_{}.blf", std::process::id()));
        let duckdb_path = blf_path.with_extension("duckdb");
        let conn = trace_store::Connection::open(&duckdb_path).unwrap();
        conn.execute_batch(
            "CREATE TABLE meta (key VARCHAR, value VARCHAR);
             INSERT INTO meta VALUES ('schema_version', '5');
             CREATE TABLE messages (msg_id BIGINT, timestamp_us BIGINT);
             INSERT INTO messages VALUES (0, 1000), (1, 2000), (2, 3000);",
        )
        .unwrap();
        drop(conn);
        blf_path.to_string_lossy().to_string()
    }

    #[test]
    fn explorer_query_history_commands_persist_independently_of_analyzer_history() {
        let dir = std::env::temp_dir();
        let blf_path = dir.join(format!("project_test_explorer_queries_{}.blf", std::process::id()));
        let blf_path = blf_path.to_string_lossy().to_string();

        record_query(blf_path.clone(), "select 1".to_string(), vec![], true, 3).unwrap();
        record_explorer_query(blf_path.clone(), "select 2".to_string(), 7).unwrap();

        let analyzer_history = list_query_history(blf_path.clone()).unwrap();
        let explorer_history = list_explorer_query_history(blf_path.clone()).unwrap();
        assert_eq!(analyzer_history.len(), 1);
        assert_eq!(explorer_history.len(), 1);
        assert_eq!(explorer_history[0].sql, "select 2");
        assert_eq!(explorer_history[0].row_count, 7);

        remove_explorer_query(blf_path.clone(), "select 2".to_string()).unwrap();
        assert!(list_explorer_query_history(blf_path.clone()).unwrap().is_empty());
        assert_eq!(list_query_history(blf_path.clone()).unwrap().len(), 1, "Analyzer history untouched");

        record_explorer_query(blf_path.clone(), "select 3".to_string(), 1).unwrap();
        clear_explorer_query_history(blf_path.clone()).unwrap();
        assert!(list_explorer_query_history(blf_path.clone()).unwrap().is_empty());

        let _ = std::fs::remove_file(project_store::project_file_path(std::path::Path::new(&blf_path)));
    }

    #[test]
    fn explorer_saved_query_commands_persist_a_named_query() {
        let dir = std::env::temp_dir();
        let blf_path = dir.join(format!("project_test_explorer_saved_{}.blf", std::process::id()));
        let blf_path = blf_path.to_string_lossy().to_string();

        save_explorer_query(blf_path.clone(), "Idle gaps".to_string(), "select 1".to_string()).unwrap();
        let saved = list_explorer_saved_queries(blf_path.clone()).unwrap();
        assert_eq!(saved.len(), 1);
        assert_eq!(saved[0].name, "Idle gaps");
        assert_eq!(saved[0].sql, "select 1");

        let _ = std::fs::remove_file(project_store::project_file_path(std::path::Path::new(&blf_path)));
    }

    #[test]
    fn run_explorer_chart_query_reads_from_the_open_store() {
        let blf_path = fixture_trace_store("chart_query");
        let config = query::ExplorerChartConfig {
            x: "timestamp_us".to_string(),
            series_by: None,
            y: "timestamp_us".to_string(),
        };
        let result = run_explorer_chart_query(
            blf_path.clone(),
            "select * from messages".to_string(),
            config,
            None,
            1000,
        )
        .unwrap();
        assert!(!result.rows.is_empty());
        let _ = std::fs::remove_file(std::path::Path::new(&blf_path).with_extension("duckdb"));
    }

    #[test]
    fn run_explorer_table_page_reads_from_the_open_store() {
        let blf_path = fixture_trace_store("table_page");
        let page = run_explorer_table_page(
            blf_path.clone(),
            "select msg_id, timestamp_us from messages".to_string(),
            10,
            0,
            None,
            false,
        )
        .unwrap();
        assert!(!page.columns.is_empty());
        let _ = std::fs::remove_file(std::path::Path::new(&blf_path).with_extension("duckdb"));
    }
}
