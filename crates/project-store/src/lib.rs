use std::collections::HashMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

pub const PROJECT_VERSION: u32 = 1;
pub const MAX_QUERY_HISTORY: usize = 25;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QueryHistoryEntry {
    pub sql: String,
    pub target_signal_ids: Vec<i64>,
    pub respect_trim: bool,
    pub ran_at: i64,
    pub match_count: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExplorerQueryEntry {
    pub sql: String,
    pub ran_at: i64,
    pub row_count: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrimWindow {
    pub start_us: i64,
    pub end_us: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TraceState {
    pub path: String,
    #[serde(default)]
    pub arxml_path: Option<String>,
    #[serde(default)]
    pub downsampling_algorithms: HashMap<i64, String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectFile {
    pub version: u32,
    pub traces: Vec<TraceState>,
    #[serde(default)]
    pub displayed_signal_ids: Vec<i64>,
    #[serde(default)]
    pub trim_window: Option<TrimWindow>,
    #[serde(default)]
    pub query_history: Vec<QueryHistoryEntry>,
    #[serde(default)]
    pub explorer_query_history: Vec<ExplorerQueryEntry>,
}

impl ProjectFile {
    pub fn new_for_trace(path: &str) -> Self {
        ProjectFile {
            version: PROJECT_VERSION,
            traces: vec![TraceState {
                path: path.to_string(),
                arxml_path: None,
                downsampling_algorithms: HashMap::new(),
            }],
            displayed_signal_ids: Vec::new(),
            trim_window: None,
            query_history: Vec::new(),
            explorer_query_history: Vec::new(),
        }
    }
}

/// `<stem>.fastrace-project.json` beside the Trace (`docs/adr/0010`).
pub fn project_file_path(blf_path: &Path) -> PathBuf {
    blf_path.with_extension("fastrace-project.json")
}

/// Loads the Project file, or a fresh default (one trace, everything else
/// empty) if none exists yet - a brand-new Trace is not an error.
pub fn read_project(path: &Path, default_trace_path: &str) -> Result<ProjectFile, String> {
    match std::fs::read_to_string(path) {
        Ok(contents) => serde_json::from_str(&contents).map_err(|e| e.to_string()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            Ok(ProjectFile::new_for_trace(default_trace_path))
        }
        Err(e) => Err(e.to_string()),
    }
}

pub fn write_project(path: &Path, project: &ProjectFile) -> Result<(), String> {
    let json = serde_json::to_string(project).map_err(|e| e.to_string())?;
    std::fs::write(path, json).map_err(|e| e.to_string())
}

fn normalize_query_sql(sql: &str) -> String {
    sql.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Inserts at the front, deduping by whitespace-normalized SQL, capped at
/// `MAX_QUERY_HISTORY` (`CONTEXT.md`'s Query History).
pub fn push_query(mut project: ProjectFile, entry: QueryHistoryEntry) -> ProjectFile {
    let norm = normalize_query_sql(&entry.sql);
    project
        .query_history
        .retain(|q| normalize_query_sql(&q.sql) != norm);
    project.query_history.insert(0, entry);
    project.query_history.truncate(MAX_QUERY_HISTORY);
    project
}

pub fn remove_query(mut project: ProjectFile, sql: &str) -> ProjectFile {
    let norm = normalize_query_sql(sql);
    project
        .query_history
        .retain(|q| normalize_query_sql(&q.sql) != norm);
    project
}

pub fn clear_query_history(mut project: ProjectFile) -> ProjectFile {
    project.query_history.clear();
    project
}

/// Same normalize-and-dedupe/cap behavior as `push_query`, applied to the
/// Explorer's own, separate history list.
pub fn push_explorer_query(mut project: ProjectFile, entry: ExplorerQueryEntry) -> ProjectFile {
    let norm = normalize_query_sql(&entry.sql);
    project
        .explorer_query_history
        .retain(|q| normalize_query_sql(&q.sql) != norm);
    project.explorer_query_history.insert(0, entry);
    project.explorer_query_history.truncate(MAX_QUERY_HISTORY);
    project
}

pub fn remove_explorer_query(mut project: ProjectFile, sql: &str) -> ProjectFile {
    let norm = normalize_query_sql(sql);
    project
        .explorer_query_history
        .retain(|q| normalize_query_sql(&q.sql) != norm);
    project
}

pub fn clear_explorer_query_history(mut project: ProjectFile) -> ProjectFile {
    project.explorer_query_history.clear();
    project
}

pub fn set_displayed_signals(mut project: ProjectFile, signal_ids: Vec<i64>) -> ProjectFile {
    project.displayed_signal_ids = signal_ids;
    project
}

pub fn set_trim_window(mut project: ProjectFile, start_us: i64, end_us: i64) -> ProjectFile {
    project.trim_window = Some(TrimWindow { start_us, end_us });
    project
}

pub fn clear_trim_window(mut project: ProjectFile) -> ProjectFile {
    project.trim_window = None;
    project
}

/// Records which ARXML a Trace was last Prepared with, so the UI can show
/// the pairing after reopening a Trace where the ARXML was never re-picked.
/// Writes to the first (and, for now, only) trace, same as
/// `set_downsampling_algorithm`.
pub fn set_arxml_path(mut project: ProjectFile, arxml_path: String) -> ProjectFile {
    if let Some(trace) = project.traces.first_mut() {
        trace.arxml_path = Some(arxml_path);
    }
    project
}

/// Writes to the first (and, for now, only) trace - multi-trace Projects
/// are future work (`docs/adr/0010`), not a lookup bug to fix here.
pub fn set_downsampling_algorithm(
    mut project: ProjectFile,
    signal_id: i64,
    algorithm: String,
) -> ProjectFile {
    if let Some(trace) = project.traces.first_mut() {
        trace.downsampling_algorithms.insert(signal_id, algorithm);
    }
    project
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_path(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "project_store_test_{}_{}.json",
            name,
            std::process::id()
        ))
    }

    #[test]
    fn project_file_path_replaces_extension() {
        let p = project_file_path(Path::new("/traces/run1.blf"));
        assert_eq!(p, PathBuf::from("/traces/run1.fastrace-project.json"));
    }

    #[test]
    fn read_project_returns_default_when_file_missing() {
        let path = temp_path("missing");
        let project = read_project(&path, "/traces/run1.blf").unwrap();
        assert_eq!(project.version, PROJECT_VERSION);
        assert_eq!(project.traces.len(), 1);
        assert_eq!(project.traces[0].path, "/traces/run1.blf");
        assert!(project.traces[0].arxml_path.is_none());
        assert!(project.displayed_signal_ids.is_empty());
        assert!(project.trim_window.is_none());
        assert!(project.query_history.is_empty());
    }

    #[test]
    fn write_then_read_round_trips() {
        let path = temp_path("roundtrip");
        let mut project = ProjectFile::new_for_trace("/traces/run1.blf");
        project.displayed_signal_ids = vec![1, 2, 3];
        project.trim_window = Some(TrimWindow {
            start_us: 100,
            end_us: 200,
        });
        project.traces[0].arxml_path = Some("/traces/run1.arxml".to_string());
        project.traces[0]
            .downsampling_algorithms
            .insert(7, "lttb".to_string());
        write_project(&path, &project).unwrap();
        let loaded = read_project(&path, "/traces/run1.blf").unwrap();
        assert_eq!(loaded, project);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn read_project_errors_on_corrupt_json() {
        let path = temp_path("corrupt");
        std::fs::write(&path, "{ not valid json").unwrap();
        assert!(read_project(&path, "/traces/run1.blf").is_err());
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn push_query_dedupes_by_normalized_sql_and_moves_to_front() {
        let project = ProjectFile::new_for_trace("/t.blf");
        let project = push_query(
            project,
            QueryHistoryEntry {
                sql: "select 1".to_string(),
                target_signal_ids: vec![],
                respect_trim: true,
                ran_at: 1,
                match_count: 0,
            },
        );
        let project = push_query(
            project,
            QueryHistoryEntry {
                sql: "select   1".to_string(), // same query, different whitespace
                target_signal_ids: vec![],
                respect_trim: true,
                ran_at: 2,
                match_count: 5,
            },
        );
        assert_eq!(
            project.query_history.len(),
            1,
            "re-running the same SQL replaces, not duplicates"
        );
        assert_eq!(project.query_history[0].ran_at, 2);
    }

    #[test]
    fn push_query_caps_at_max_query_history() {
        let mut project = ProjectFile::new_for_trace("/t.blf");
        for i in 0..(MAX_QUERY_HISTORY + 5) {
            project = push_query(
                project,
                QueryHistoryEntry {
                    sql: format!("select {i}"),
                    target_signal_ids: vec![],
                    respect_trim: true,
                    ran_at: i as i64,
                    match_count: 0,
                },
            );
        }
        assert_eq!(project.query_history.len(), MAX_QUERY_HISTORY);
    }

    #[test]
    fn remove_query_removes_by_normalized_sql() {
        let project = ProjectFile::new_for_trace("/t.blf");
        let project = push_query(
            project,
            QueryHistoryEntry {
                sql: "select 1".to_string(),
                target_signal_ids: vec![],
                respect_trim: true,
                ran_at: 1,
                match_count: 0,
            },
        );
        let project = remove_query(project, "select   1");
        assert!(project.query_history.is_empty());
    }

    #[test]
    fn clear_query_history_empties_the_list() {
        let project = ProjectFile::new_for_trace("/t.blf");
        let project = push_query(
            project,
            QueryHistoryEntry {
                sql: "select 1".to_string(),
                target_signal_ids: vec![],
                respect_trim: true,
                ran_at: 1,
                match_count: 0,
            },
        );
        assert!(clear_query_history(project).query_history.is_empty());
    }

    #[test]
    fn set_displayed_signals_replaces_the_list() {
        let project = ProjectFile::new_for_trace("/t.blf");
        let project = set_displayed_signals(project, vec![5, 6]);
        assert_eq!(project.displayed_signal_ids, vec![5, 6]);
    }

    #[test]
    fn set_trim_window_sets_start_and_end() {
        let project = ProjectFile::new_for_trace("/t.blf");
        let project = set_trim_window(project, 10, 20);
        assert_eq!(
            project.trim_window,
            Some(TrimWindow {
                start_us: 10,
                end_us: 20
            })
        );
    }

    #[test]
    fn clear_trim_window_unsets_it() {
        let project = ProjectFile::new_for_trace("/t.blf");
        let project = set_trim_window(project, 10, 20);
        let project = clear_trim_window(project);
        assert!(project.trim_window.is_none());
    }

    #[test]
    fn set_arxml_path_sets_it_on_the_first_trace() {
        let project = ProjectFile::new_for_trace("/t.blf");
        let project = set_arxml_path(project, "/t.arxml".to_string());
        assert_eq!(project.traces[0].arxml_path, Some("/t.arxml".to_string()));
    }

    #[test]
    fn set_downsampling_algorithm_inserts_into_the_first_trace() {
        let project = ProjectFile::new_for_trace("/t.blf");
        let project = set_downsampling_algorithm(project, 42, "min_max".to_string());
        assert_eq!(
            project.traces[0].downsampling_algorithms.get(&42),
            Some(&"min_max".to_string())
        );
    }

    #[test]
    fn push_explorer_query_dedupes_by_normalized_sql_and_moves_to_front() {
        let project = ProjectFile::new_for_trace("/t.blf");
        let project = push_explorer_query(
            project,
            ExplorerQueryEntry { sql: "select 1".to_string(), ran_at: 1, row_count: 0 },
        );
        let project = push_explorer_query(
            project,
            ExplorerQueryEntry { sql: "select   1".to_string(), ran_at: 2, row_count: 5 },
        );
        assert_eq!(project.explorer_query_history.len(), 1);
        assert_eq!(project.explorer_query_history[0].ran_at, 2);
    }

    #[test]
    fn push_explorer_query_caps_at_max_query_history() {
        let mut project = ProjectFile::new_for_trace("/t.blf");
        for i in 0..(MAX_QUERY_HISTORY + 5) {
            project = push_explorer_query(
                project,
                ExplorerQueryEntry { sql: format!("select {i}"), ran_at: i as i64, row_count: 0 },
            );
        }
        assert_eq!(project.explorer_query_history.len(), MAX_QUERY_HISTORY);
    }

    #[test]
    fn remove_explorer_query_removes_by_normalized_sql() {
        let project = ProjectFile::new_for_trace("/t.blf");
        let project = push_explorer_query(
            project,
            ExplorerQueryEntry { sql: "select 1".to_string(), ran_at: 1, row_count: 0 },
        );
        let project = remove_explorer_query(project, "select   1");
        assert!(project.explorer_query_history.is_empty());
    }

    #[test]
    fn clear_explorer_query_history_empties_the_list() {
        let project = ProjectFile::new_for_trace("/t.blf");
        let project = push_explorer_query(
            project,
            ExplorerQueryEntry { sql: "select 1".to_string(), ran_at: 1, row_count: 0 },
        );
        assert!(clear_explorer_query_history(project).explorer_query_history.is_empty());
    }

    #[test]
    fn explorer_query_history_round_trips_through_json() {
        let path = temp_path("explorer_roundtrip");
        let mut project = ProjectFile::new_for_trace("/traces/run1.blf");
        project = push_explorer_query(
            project,
            ExplorerQueryEntry { sql: "select 1".to_string(), ran_at: 1, row_count: 3 },
        );
        write_project(&path, &project).unwrap();
        let loaded = read_project(&path, "/traces/run1.blf").unwrap();
        assert_eq!(loaded, project);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn explorer_query_history_defaults_to_empty_for_old_project_files_without_the_field() {
        let path = temp_path("explorer_old_format");
        // A project file written before explorerQueryHistory existed.
        std::fs::write(
            &path,
            r#"{"version":1,"traces":[{"path":"/t.blf","arxmlPath":null,"downsamplingAlgorithms":{}}],
               "displayedSignalIds":[],"trimWindow":null,"queryHistory":[]}"#,
        )
        .unwrap();
        let loaded = read_project(&path, "/t.blf").unwrap();
        assert!(loaded.explorer_query_history.is_empty());
        let _ = std::fs::remove_file(&path);
    }
}
