//! Generic Analyzer Framework (docs/superpowers/plans/2026-11-27-tcp-analyzer-wave1-ingest.md,
//! "Analyzer Framework Contract"). Written once, zero protocol-specific
//! knowledge: every analyzer SQL file in `schema/rules/analyzers/` is a bare
//! `WITH` chain defining three fixed-name CTEs (`findings`/`sessions`/
//! `segments`); this module only knows those three column shapes and how to
//! run them. Adding analyzer #2 is one `.sql` file (+ optional `.config.json`)
//! + one `ANALYZERS` entry.

use serde::Serialize;

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Finding {
    pub analyzer_name: String,
    pub src_node: String,
    pub dst_node: String,
    pub stream_index: i64,
    pub severity: String,
    pub rule: String,
    pub summary: String,
    pub start_us: i64,
    pub end_us: i64,
    pub first_msg_id: i64,
    pub last_msg_id: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Session {
    pub analyzer_name: String,
    pub src_node: String,
    pub dst_node: String,
    pub stream_index: i64,
    pub packet_count: i64,
    pub start_us: i64,
    pub end_us: i64,
    pub first_msg_id: i64,
    pub last_msg_id: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Segment {
    pub analyzer_name: String,
    pub stream_index: i64,
    pub msg_id: i64,
    pub timestamp_us: i64,
    pub src_node: String,
    pub dst_node: String,
    pub info: String,
    pub segment_len: i64,
    pub idle_us: i64,
}

/// Adding analyzer #2 = one more entry here + one SQL file (+ config).
/// Nothing else.
const ANALYZERS: &[(&str, &str, &str)] = &[(
    "tcp_connection_health",
    include_str!("../../../schema/rules/analyzers/tcp_connection_health.sql"),
    include_str!("../../../schema/rules/analyzers/tcp_connection_health.config.json"),
)];

/// Names from `ANALYZERS`, backs the UI's analyzer picker.
pub fn list_analyzers() -> Vec<&'static str> {
    ANALYZERS.iter().map(|(name, _, _)| *name).collect()
}

fn analyzer_sql(analyzer_name: &str) -> Result<(&'static str, &'static str), String> {
    ANALYZERS
        .iter()
        .find(|(name, _, _)| *name == analyzer_name)
        .map(|(_, sql, default_config)| (*sql, *default_config))
        .ok_or_else(|| format!("unknown analyzer: {analyzer_name}"))
}

/// Default config JSON for an analyzer, backs the UI's JSON editor prefill.
pub fn get_default_analyzer_config(analyzer_name: &str) -> Result<&'static str, String> {
    analyzer_sql(analyzer_name).map(|(_, default_config)| default_config)
}

/// Substitutes `{{key}}` placeholders in `sql` with each key's value from
/// `config_json` (or `default_config_json` when `config_json` is empty -
/// the "use the analyzer's own default" case). Generic: this function has
/// no idea what any key means, it only turns JSON values into SQL literals.
/// Errors if the config isn't a JSON object, has an unsupported value type,
/// or leaves any `{{...}}` placeholder unresolved in the result.
fn apply_config(sql: &str, config_json: &str, default_config_json: &str) -> Result<String, String> {
    let json_text = if config_json.trim().is_empty() {
        default_config_json
    } else {
        config_json
    };
    let value: serde_json::Value =
        serde_json::from_str(json_text).map_err(|e| format!("invalid config JSON: {e}"))?;
    let obj = value
        .as_object()
        .ok_or_else(|| "config must be a JSON object".to_string())?;
    let mut out = sql.to_string();
    for (key, v) in obj {
        let literal = match v {
            serde_json::Value::Number(n) => n.to_string(),
            serde_json::Value::String(s) => format!("'{}'", s.replace('\'', "''")),
            serde_json::Value::Bool(b) => b.to_string(),
            _ => return Err(format!("unsupported config value type for key \"{key}\"")),
        };
        out = out.replace(&format!("{{{{{key}}}}}"), &literal);
    }
    if out.contains("{{") {
        return Err("config JSON is missing a key the analyzer SQL requires".to_string());
    }
    Ok(out)
}

pub fn list_findings(
    conn: &trace_store::Connection,
    analyzer_name: &str,
    config_json: &str,
    start_us: i64,
    end_us: i64,
) -> Result<Vec<Finding>, String> {
    let (sql, default_config) = analyzer_sql(analyzer_name)?;
    let sql = apply_config(sql, config_json, default_config)?;
    let (lo, hi) = (start_us.min(end_us), start_us.max(end_us));
    let query = format!(
        "{sql} select analyzer_name, src_node, dst_node, stream_index, severity, rule, summary,
                  start_us, end_us, first_msg_id, last_msg_id
         from findings where start_us between {lo} and {hi}"
    );
    let mut stmt = conn.prepare(&query).map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |row| {
            Ok(Finding {
                analyzer_name: row.get(0)?,
                src_node: row.get(1)?,
                dst_node: row.get(2)?,
                stream_index: row.get(3)?,
                severity: row.get(4)?,
                rule: row.get(5)?,
                summary: row.get(6)?,
                start_us: row.get(7)?,
                end_us: row.get(8)?,
                first_msg_id: row.get(9)?,
                last_msg_id: row.get(10)?,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())
}

pub fn list_sessions(
    conn: &trace_store::Connection,
    analyzer_name: &str,
    config_json: &str,
    start_us: i64,
    end_us: i64,
) -> Result<Vec<Session>, String> {
    let (sql, default_config) = analyzer_sql(analyzer_name)?;
    let sql = apply_config(sql, config_json, default_config)?;
    let (lo, hi) = (start_us.min(end_us), start_us.max(end_us));
    let query = format!(
        "{sql} select analyzer_name, src_node, dst_node, stream_index, packet_count,
                  start_us, end_us, first_msg_id, last_msg_id
         from sessions where start_us between {lo} and {hi}"
    );
    let mut stmt = conn.prepare(&query).map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |row| {
            Ok(Session {
                analyzer_name: row.get(0)?,
                src_node: row.get(1)?,
                dst_node: row.get(2)?,
                stream_index: row.get(3)?,
                packet_count: row.get(4)?,
                start_us: row.get(5)?,
                end_us: row.get(6)?,
                first_msg_id: row.get(7)?,
                last_msg_id: row.get(8)?,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())
}

/// Not time-scoped - a stream_index is a complete connection's worth of
/// segments, fetched in full for the "Follow Stream" drill-down.
///
/// stream_index alone is NOT a unique session key - it's only unique within
/// one (src_node, dst_node) pair (see tcp_connection_health.sql's _sessions
/// comment), so this must also filter on the pair or it returns segments
/// merged in from a different pair's same-numbered connection.
pub fn list_segments(
    conn: &trace_store::Connection,
    analyzer_name: &str,
    config_json: &str,
    src_node: &str,
    dst_node: &str,
    stream_index: i64,
) -> Result<Vec<Segment>, String> {
    let (sql, default_config) = analyzer_sql(analyzer_name)?;
    let sql = apply_config(sql, config_json, default_config)?;
    let query = format!(
        "{sql} select analyzer_name, stream_index, msg_id, timestamp_us, src_node, dst_node,
                  info, segment_len, idle_us
         from segments where stream_index = {stream_index} and src_node = ? and dst_node = ?
         order by timestamp_us"
    );
    let mut stmt = conn.prepare(&query).map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(duckdb::params![src_node, dst_node], |row| {
            Ok(Segment {
                analyzer_name: row.get(0)?,
                stream_index: row.get(1)?,
                msg_id: row.get(2)?,
                timestamp_us: row.get(3)?,
                src_node: row.get(4)?,
                dst_node: row.get(5)?,
                info: row.get(6)?,
                segment_len: row.get(7)?,
                idle_us: row.get(8)?,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use duckdb::Connection;

    fn seeded_conn() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE messages (msg_id BIGINT, timestamp_us BIGINT, src_ip VARCHAR, src_port INTEGER,
                                     dst_ip VARCHAR, dst_port INTEGER, channel INTEGER);
             CREATE TABLE protocol_tcp (msg_id BIGINT, flags INTEGER, segment_len INTEGER);
             INSERT INTO messages VALUES
                 (0, 1000, '10.0.0.1', 1000, '10.0.0.2', 2000, 1),
                 (1, 2000, '10.0.0.1', 1000, '10.0.0.2', 2000, 1);
             INSERT INTO protocol_tcp VALUES (0, 2, 0), (1, 8, 4);",
        )
        .unwrap();
        conn
    }

    #[test]
    fn apply_config_substitutes_a_number_placeholder() {
        let out = apply_config("WHERE m.channel = {{channel}}", "", r#"{"channel": 1}"#).unwrap();
        assert_eq!(out, "WHERE m.channel = 1");
    }

    #[test]
    fn apply_config_prefers_caller_config_over_default() {
        let out = apply_config(
            "WHERE m.channel = {{channel}}",
            r#"{"channel": 2}"#,
            r#"{"channel": 1}"#,
        )
        .unwrap();
        assert_eq!(out, "WHERE m.channel = 2");
    }

    #[test]
    fn apply_config_substitutes_a_bool_placeholder() {
        let out = apply_config(
            "{{includeAllChannels}} OR x",
            "",
            r#"{"includeAllChannels": true}"#,
        )
        .unwrap();
        assert_eq!(out, "true OR x");
    }

    #[test]
    fn apply_config_errors_on_invalid_json() {
        assert!(apply_config("{{channel}}", "not json", r#"{"channel": 1}"#).is_err());
    }

    #[test]
    fn apply_config_errors_when_a_placeholder_is_left_unresolved() {
        assert!(apply_config("{{channel}} {{missing}}", "", r#"{"channel": 1}"#).is_err());
    }

    #[test]
    fn list_analyzers_includes_tcp_connection_health() {
        assert_eq!(list_analyzers(), vec!["tcp_connection_health"]);
    }

    #[test]
    fn get_default_analyzer_config_returns_the_embedded_default() {
        let config = get_default_analyzer_config("tcp_connection_health").unwrap();
        assert!(config.contains("\"channel\""));
        assert!(config.contains("\"includeAllChannels\""));
    }

    #[test]
    fn list_findings_rejects_unknown_analyzer() {
        let conn = seeded_conn();
        assert!(list_findings(&conn, "no_such_analyzer", "", 0, 10_000).is_err());
    }

    #[test]
    fn list_findings_scopes_by_start_us() {
        let conn = seeded_conn();
        let found = list_findings(&conn, "tcp_connection_health", "", 0, 10_000).unwrap();
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].rule, "HANDSHAKE_NO_SYNACK");

        let out_of_range =
            list_findings(&conn, "tcp_connection_health", "", 5_000, 10_000).unwrap();
        assert!(out_of_range.is_empty());
    }

    #[test]
    fn list_sessions_returns_one_row_per_connection() {
        let conn = seeded_conn();
        let sessions = list_sessions(&conn, "tcp_connection_health", "", 0, 10_000).unwrap();
        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0].packet_count, 2);
    }

    #[test]
    fn list_sessions_with_wrong_channel_in_config_finds_nothing() {
        let conn = seeded_conn();
        let sessions = list_sessions(
            &conn,
            "tcp_connection_health",
            r#"{"channel": 2, "includeAllChannels": false}"#,
            0,
            10_000,
        )
        .unwrap();
        assert!(sessions.is_empty());
    }

    #[test]
    fn list_segments_is_scoped_by_stream_index_not_time() {
        let conn = seeded_conn();
        let segments = list_segments(
            &conn,
            "tcp_connection_health",
            "",
            "10.0.0.1:1000",
            "10.0.0.2:2000",
            1,
        )
        .unwrap();
        assert_eq!(segments.len(), 2);
        assert_eq!(segments[0].info, "[SYN]");
        assert_eq!(segments[1].info, "[PSH]");
    }
}
