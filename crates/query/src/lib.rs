use serde::Serialize;

/// Runs a `SELECT COUNT(*) ...`-shaped query and returns the single integer
/// result. Not a general query runner - just enough to drive the Wave 2
/// summary screen's fixed set of aggregate counts.
pub fn count(conn: &trace_store::Connection, sql: &str) -> Result<i64, String> {
    conn.query_row(sql, [], |row| row.get(0))
        .map_err(|e| e.to_string())
}

// CAN vs Ethernet object_type values (native/blf/include/BlfTypes.h),
// duplicated here because Rust has no visibility into the C++ header - keep
// in sync if that enum changes.
const CAN_OBJECT_TYPES: &str = "1,100,101";
const ETHERNET_OBJECT_TYPES: &str = "71,120,121";

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageGroup {
    pub key: String,
    pub bus_label: String,
    pub label: String,
    pub count: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageRow {
    pub msg_id: i64,
    pub timestamp_us: i64,
    pub bus_label: String,
    pub id_or_src: String,
    pub name: Option<String>,
    pub dlc: Option<i32>,
    pub payload_len: Option<i32>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MessagePage {
    pub rows: Vec<MessageRow>,
    pub next_cursor: Option<i64>,
}

/// One group per distinct CAN arb_id and per distinct Ethernet (dst_ip,
/// dst_port) pair. `key` is the opaque cursor `list_messages` parses back
/// apart - "can:<arb_id>" or "eth:<dst_ip>:<dst_port>".
pub fn list_message_groups(conn: &trace_store::Connection) -> Result<Vec<MessageGroup>, String> {
    let sql = format!(
        "select 'can:' || cast(arb_id as varchar) as key,
                'CAN' as bus_label,
                coalesce((select name from arxml_can where can_id = arb_id limit 1), cast(arb_id as varchar)) as label,
                count(*) as count
         from messages
         where object_type in ({CAN_OBJECT_TYPES})
         group by arb_id
         union all
         select 'eth:' || coalesce(dst_ip,'') || ':' || cast(coalesce(dst_port,0) as varchar) as key,
                'Ethernet' as bus_label,
                coalesce(dst_ip,'?') || ':' || cast(coalesce(dst_port,0) as varchar) as label,
                count(*) as count
         from messages
         where object_type in ({ETHERNET_OBJECT_TYPES})
         group by dst_ip, dst_port
         order by 2, 3"
    );
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |row| {
            Ok(MessageGroup {
                key: row.get(0)?,
                bus_label: row.get(1)?,
                label: row.get(2)?,
                count: row.get(3)?,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())
}

fn map_message_row(row: &duckdb::Row) -> duckdb::Result<MessageRow> {
    Ok(MessageRow {
        msg_id: row.get(0)?,
        timestamp_us: row.get(1)?,
        bus_label: row.get(2)?,
        id_or_src: row.get(3)?,
        name: row.get(4)?,
        dlc: row.get(5)?,
        payload_len: row.get(6)?,
    })
}

/// Keyset-paginates by `msg_id` within one group. `cursor` is the last
/// `msg_id` already seen (`None` for the first page); the returned
/// `next_cursor` is `None` once the group is exhausted.
pub fn list_messages(
    conn: &trace_store::Connection,
    group_key: &str,
    cursor: Option<i64>,
    limit: i64,
) -> Result<MessagePage, String> {
    let cursor = cursor.unwrap_or(-1);
    let fetch = limit + 1;

    let mut rows: Vec<MessageRow> = if let Some(arb_id) = group_key.strip_prefix("can:") {
        let arb_id: i64 = arb_id
            .parse()
            .map_err(|_| format!("bad group key: {group_key}"))?;
        let sql = format!(
            "select msg_id, timestamp_us, 'CAN' as bus_label, cast(arb_id as varchar) as id_or_src,
                    (select name from arxml_can where can_id = arb_id limit 1) as name, dlc, payload_len
             from messages
             where object_type in ({CAN_OBJECT_TYPES}) and arb_id = ? and msg_id > ?
             order by msg_id
             limit ?"
        );
        let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
        let out = stmt
            .query_map(duckdb::params![arb_id, cursor, fetch], map_message_row)
            .map_err(|e| e.to_string())?;
        out.collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?
    } else if let Some(rest) = group_key.strip_prefix("eth:") {
        let (dst_ip, dst_port) = rest
            .rsplit_once(':')
            .ok_or_else(|| format!("bad group key: {group_key}"))?;
        let dst_port: i32 = dst_port
            .parse()
            .map_err(|_| format!("bad group key: {group_key}"))?;
        let sql = format!(
            "select msg_id, timestamp_us, 'Ethernet' as bus_label,
                    coalesce(dst_ip,'') || ':' || cast(coalesce(dst_port,0) as varchar) as id_or_src,
                    cast(null as varchar) as name, dlc, payload_len
             from messages
             where object_type in ({ETHERNET_OBJECT_TYPES}) and dst_ip = ? and dst_port = ? and msg_id > ?
             order by msg_id
             limit ?"
        );
        let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
        let out = stmt
            .query_map(
                duckdb::params![dst_ip, dst_port, cursor, fetch],
                map_message_row,
            )
            .map_err(|e| e.to_string())?;
        out.collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?
    } else {
        return Err(format!("bad group key: {group_key}"));
    };

    let next_cursor = if rows.len() as i64 > limit {
        rows.truncate(limit as usize);
        rows.last().map(|r| r.msg_id)
    } else {
        None
    };
    Ok(MessagePage { rows, next_cursor })
}

pub fn get_message_detail(
    conn: &trace_store::Connection,
    msg_id: i64,
) -> Result<MessageRow, String> {
    let sql = format!(
        "select msg_id, timestamp_us,
                case when object_type in ({CAN_OBJECT_TYPES}) then 'CAN' else 'Ethernet' end as bus_label,
                case when object_type in ({CAN_OBJECT_TYPES}) then cast(arb_id as varchar)
                     else coalesce(dst_ip,'') || ':' || cast(coalesce(dst_port,0) as varchar) end as id_or_src,
                cast(null as varchar) as name,
                dlc, payload_len
         from messages where msg_id = ?"
    );
    conn.query_row(&sql, duckdb::params![msg_id], map_message_row)
        .map_err(|e| format!("message {msg_id} not found: {e}"))
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SignalCatalogEntry {
    pub signal_id: i64,
    pub name: String,
    pub parent_label: String,
    pub decodable: bool,
    pub cached: bool,
    pub samples: i64,
    pub changes: i64,
    pub nonzero: i64,
    pub opaque: bool,
}

/// ARXML signal dictionary joined to Prepare-time `signal_stats` (docs/adr/0005)
/// and to `signals` for cache status. `decodable` means the parent message/PDU
/// was observed at least once (`samples > 0`). Sort pins cached, then live
/// (most-changing) signals to the top of the UI list.
pub fn list_signal_catalog(
    conn: &trace_store::Connection,
) -> Result<Vec<SignalCatalogEntry>, String> {
    let sql = "select s.signal_id, s.name,
                case when s.parent_kind = 'can' then 'CAN ' || cast(s.parent_id as varchar)
                     else 'PDU ' || cast(s.parent_id as varchar) end as parent_label,
                coalesce(st.samples, 0) > 0 as decodable,
                exists (select 1 from signals sig where sig.signal_id = s.signal_id) as cached,
                coalesce(st.samples, 0) as samples,
                coalesce(st.changes, 0) as changes,
                coalesce(st.nonzero, 0) as nonzero,
                coalesce(st.opaque, false) as opaque
         from arxml_signal s
         left join signal_stats st on st.signal_id = s.signal_id
         order by cached desc, changes desc, s.name";
    let mut stmt = conn.prepare(sql).map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |row| {
            Ok(SignalCatalogEntry {
                signal_id: row.get(0)?,
                name: row.get(1)?,
                parent_label: row.get(2)?,
                decodable: row.get(3)?,
                cached: row.get(4)?,
                samples: row.get(5)?,
                changes: row.get(6)?,
                nonzero: row.get(7)?,
                opaque: row.get(8)?,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())
}

/// First `limit` decoded samples for one signal, ordered by time - backs the Signals
/// tab's minimal inline value preview (no charting, docs/adr/0005's "second pass").
pub fn list_signal_samples(
    conn: &trace_store::Connection,
    signal_id: i64,
    limit: i64,
) -> Result<Vec<(i64, f64)>, String> {
    let mut stmt = conn
        .prepare("select timestamp_us, phys_value from signals where signal_id = ? order by timestamp_us limit ?")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(duckdb::params![signal_id, limit], |row| {
            Ok((row.get(0)?, row.get(1)?))
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())
}

pub fn list_ecus(conn: &trace_store::Connection) -> Result<Vec<String>, String> {
    let mut stmt = conn
        .prepare("select name from arxml_ecu order by name")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TraceTimeRange {
    pub min_timestamp_us: i64,
    pub max_timestamp_us: i64,
}

/// The trace's overall time span (first/last `messages.timestamp_us`) - the
/// shared x-axis domain every Timeline chart (SignalChart, MatchLane) pins
/// to, instead of each auto-scaling to its own series' data extent. Errors
/// on an empty `messages` table (no range to report).
pub fn get_trace_time_range(conn: &trace_store::Connection) -> Result<TraceTimeRange, String> {
    conn.query_row(
        "select min(timestamp_us), max(timestamp_us) from messages",
        [],
        |row| Ok((row.get::<_, Option<i64>>(0)?, row.get::<_, Option<i64>>(1)?)),
    )
    .map_err(|e| e.to_string())
    .and_then(|(min, max)| match (min, max) {
        (Some(min_timestamp_us), Some(max_timestamp_us)) => Ok(TraceTimeRange {
            min_timestamp_us,
            max_timestamp_us,
        }),
        _ => Err("messages table is empty - no time range to report".to_string()),
    })
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DetectorMatch {
    pub msg_id: i64,
    pub timestamp_us: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DetectorQueryResult {
    pub matches: Vec<DetectorMatch>,
    pub truncated: bool,
}

/// Default Match cap for the Analyzer's Detector Query editor - same order of
/// magnitude as `TIMELINE_SAMPLE_LIMIT` on the frontend (both already proven
/// at this scale via `large: true` echarts rendering).
pub const DETECTOR_QUERY_MATCH_LIMIT: i64 = 200_000;

/// Runs a user-authored Detector Query and extracts just `msg_id` /
/// `timestamp_us` from its result, for plotting as Matches on the Timeline.
/// The query is run read-only (the connection itself is opened read-only) and
/// wrapped as a subquery rather than string-validated, so DuckDB's own
/// binder error - not custom validation code - is what reports a missing
/// required column.
pub fn run_detector_query(
    conn: &trace_store::Connection,
    sql: &str,
    limit: i64,
) -> Result<DetectorQueryResult, String> {
    let trimmed = sql.trim();
    let trimmed = trimmed.strip_suffix(';').unwrap_or(trimmed).trim();
    if trimmed.is_empty() {
        return Err("query is empty".to_string());
    }
    // A trailing `--` line comment in the user's SQL would otherwise swallow
    // the `) as detector_query_result limit N` suffix appended on the same
    // line - the newline before the closing paren keeps that suffix outside
    // any comment the user's query ends with.
    let wrapped = format!(
        "select msg_id, timestamp_us from ({trimmed}\n) as detector_query_result limit {}",
        limit + 1
    );
    let mut stmt = conn.prepare(&wrapped).map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |row| {
            Ok(DetectorMatch {
                msg_id: row.get(0)?,
                timestamp_us: row.get(1)?,
            })
        })
        .map_err(|e| e.to_string())?;
    let mut matches = rows
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    let truncated = matches.len() as i64 > limit;
    if truncated {
        matches.truncate(limit as usize);
    }
    Ok(DetectorQueryResult { matches, truncated })
}

#[cfg(test)]
mod tests {
    use super::*;
    use trace_store::Connection;

    #[test]
    fn count_returns_row_count() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("CREATE TABLE t (x INTEGER); INSERT INTO t VALUES (1), (2), (3);")
            .unwrap();
        assert_eq!(count(&conn, "select count(*) from t").unwrap(), 3);
    }

    #[test]
    fn count_surfaces_sql_errors() {
        let conn = Connection::open_in_memory().unwrap();
        assert!(count(&conn, "select count(*) from no_such_table").is_err());
    }

    fn setup() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE messages (msg_id BIGINT, timestamp_us BIGINT, object_type INTEGER, arb_id INTEGER, dst_ip VARCHAR, dst_port INTEGER, dlc INTEGER, payload_len INTEGER);
             CREATE TABLE arxml_can (can_id BIGINT, name VARCHAR);
             CREATE TABLE arxml_ecu (name VARCHAR);
             CREATE TABLE protocol_pdu (msg_id BIGINT, pdu_id BIGINT, length BIGINT);
             CREATE TABLE arxml_signal (signal_id BIGINT, name VARCHAR, parent_kind VARCHAR, parent_id BIGINT, start_bit INTEGER, bit_length INTEGER, big_endian BOOLEAN, factor DOUBLE, \"offset\" DOUBLE);
             CREATE TABLE signals (signal_id BIGINT, msg_id BIGINT, timestamp_us BIGINT, raw_value UBIGINT, phys_value DOUBLE);
             CREATE TABLE signal_stats (signal_id BIGINT PRIMARY KEY, samples BIGINT, nonzero BIGINT, changes BIGINT, min_raw UBIGINT, max_raw UBIGINT, first_ts_us BIGINT, last_ts_us BIGINT, opaque BOOLEAN);
             INSERT INTO arxml_can VALUES (100, 'EngineSpeed');
             INSERT INTO messages VALUES (1, 1000, 1, 100, NULL, NULL, 8, 8);
             INSERT INTO messages VALUES (2, 2000, 1, 100, NULL, NULL, 8, 8);
             INSERT INTO messages VALUES (3, 3000, 1, 200, NULL, NULL, 4, 4);
             INSERT INTO messages VALUES (4, 4000, 71, NULL, '10.0.0.1', 30509, NULL, 64);",
        )
        .unwrap();
        conn
    }

    #[test]
    fn list_message_groups_aggregates_by_bus_and_id() {
        let conn = setup();
        let groups = list_message_groups(&conn).unwrap();
        let named = groups.iter().find(|g| g.key == "can:100").unwrap();
        assert_eq!(named.label, "EngineSpeed");
        assert_eq!(named.count, 2);
        let unnamed = groups.iter().find(|g| g.key == "can:200").unwrap();
        assert_eq!(unnamed.label, "200");
        let eth = groups
            .iter()
            .find(|g| g.key == "eth:10.0.0.1:30509")
            .unwrap();
        assert_eq!(eth.count, 1);
    }

    #[test]
    fn list_messages_paginates_with_keyset_cursor() {
        let conn = setup();
        let page1 = list_messages(&conn, "can:100", None, 1).unwrap();
        assert_eq!(page1.rows.len(), 1);
        assert_eq!(page1.rows[0].msg_id, 1);
        assert_eq!(page1.next_cursor, Some(1));

        let page2 = list_messages(&conn, "can:100", page1.next_cursor, 1).unwrap();
        assert_eq!(page2.rows.len(), 1);
        assert_eq!(page2.rows[0].msg_id, 2);
        assert_eq!(
            page2.next_cursor, None,
            "last page must not return a cursor"
        );
    }

    #[test]
    fn list_messages_rejects_unrecognized_group_key() {
        let conn = setup();
        assert!(list_messages(&conn, "bogus:1", None, 10).is_err());
    }

    #[test]
    fn get_message_detail_returns_row_by_id() {
        let conn = setup();
        let detail = get_message_detail(&conn, 1).unwrap();
        assert_eq!(detail.bus_label, "CAN");
        assert_eq!(detail.id_or_src, "100");
    }

    #[test]
    fn get_message_detail_errors_when_missing() {
        let conn = setup();
        assert!(get_message_detail(&conn, 999).is_err());
    }

    #[test]
    fn list_ecus_returns_sorted_names() {
        let conn = setup();
        conn.execute_batch("INSERT INTO arxml_ecu VALUES ('Gateway'), ('BodyControl');")
            .unwrap();
        let ecus = list_ecus(&conn).unwrap();
        assert_eq!(ecus, vec!["BodyControl".to_string(), "Gateway".to_string()]);
    }

    #[test]
    fn list_ecus_returns_empty_vec_when_no_ecus() {
        let conn = setup();
        assert_eq!(list_ecus(&conn).unwrap(), Vec::<String>::new());
    }

    #[test]
    fn list_signal_catalog_reports_decodable_and_cached_flags() {
        let conn = setup();
        conn.execute_batch(
            "INSERT INTO arxml_signal VALUES (0, 'EngineRpm', 'can', 100, 0, 16, false, 0.25, 0.0);
             INSERT INTO arxml_signal VALUES (1, 'GhostSignal', 'can', 999, 0, 8, false, 1.0, 0.0);
             INSERT INTO protocol_pdu VALUES (4, 42, 64);
             INSERT INTO arxml_signal VALUES (2, 'PduSignal', 'pdu', 42, 0, 8, false, 1.0, 0.0);
             INSERT INTO signals VALUES (0, 1, 1000, 513, 128.25);
             INSERT INTO signal_stats VALUES (0, 10, 8, 3, 1, 99, 1000, 9000, false);
             INSERT INTO signal_stats VALUES (1, 0, 0, 0, NULL, NULL, NULL, NULL, false);
             INSERT INTO signal_stats VALUES (2, 5, 5, 4, 1, 7, 4000, 8000, false);",
        )
        .unwrap();
        let catalog = list_signal_catalog(&conn).unwrap();

        let engine = catalog.iter().find(|s| s.signal_id == 0).unwrap();
        assert_eq!(engine.parent_label, "CAN 100");
        assert!(engine.decodable, "EngineRpm samples > 0");
        assert!(engine.cached, "EngineRpm has a row in signals");
        assert_eq!(engine.changes, 3);

        let ghost = catalog.iter().find(|s| s.signal_id == 1).unwrap();
        assert!(!ghost.decodable, "GhostSignal samples == 0");
        assert!(!ghost.cached);

        let pdu = catalog.iter().find(|s| s.signal_id == 2).unwrap();
        assert_eq!(pdu.parent_label, "PDU 42");
        assert!(pdu.decodable, "PduSignal samples > 0");
        assert_eq!(pdu.changes, 4);

        // cached signal sorts first, then by changes desc.
        assert_eq!(catalog[0].signal_id, 0);
    }

    #[test]
    fn get_trace_time_range_returns_min_and_max_message_timestamp() {
        let conn = setup();
        let range = get_trace_time_range(&conn).unwrap();
        assert_eq!(range.min_timestamp_us, 1000);
        assert_eq!(range.max_timestamp_us, 4000);
    }

    #[test]
    fn get_trace_time_range_errors_on_empty_messages_table() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("CREATE TABLE messages (msg_id BIGINT, timestamp_us BIGINT);")
            .unwrap();
        assert!(get_trace_time_range(&conn).is_err());
    }

    #[test]
    fn run_detector_query_returns_matching_rows() {
        let conn = setup();
        let result = run_detector_query(
            &conn,
            "select msg_id, timestamp_us from messages where arb_id = 100",
            10,
        )
        .unwrap();
        assert_eq!(result.matches.len(), 2);
        assert_eq!(result.matches[0].msg_id, 1);
        assert_eq!(result.matches[0].timestamp_us, 1000);
        assert!(!result.truncated);
    }

    #[test]
    fn run_detector_query_truncates_at_limit_and_reports_it() {
        let conn = setup();
        let result =
            run_detector_query(&conn, "select msg_id, timestamp_us from messages", 2).unwrap();
        assert_eq!(
            result.matches.len(),
            2,
            "capped to the limit, not the full 4 rows"
        );
        assert!(result.truncated);
    }

    #[test]
    fn run_detector_query_does_not_truncate_when_exactly_at_limit() {
        let conn = setup();
        let result =
            run_detector_query(&conn, "select msg_id, timestamp_us from messages", 4).unwrap();
        assert_eq!(result.matches.len(), 4);
        assert!(!result.truncated, "exactly `limit` rows is not truncation");
    }

    #[test]
    fn run_detector_query_errors_when_msg_id_column_missing() {
        let conn = setup();
        let err = run_detector_query(&conn, "select timestamp_us from messages", 10).unwrap_err();
        assert!(
            err.to_lowercase().contains("msg_id"),
            "error should mention the missing column, got: {err}"
        );
    }

    #[test]
    fn run_detector_query_errors_when_timestamp_us_column_missing() {
        let conn = setup();
        let err = run_detector_query(&conn, "select msg_id from messages", 10).unwrap_err();
        assert!(
            err.to_lowercase().contains("timestamp_us"),
            "error should mention the missing column, got: {err}"
        );
    }

    #[test]
    fn run_detector_query_errors_on_empty_sql() {
        let conn = setup();
        assert!(run_detector_query(&conn, "   ", 10).is_err());
    }

    #[test]
    fn run_detector_query_strips_one_trailing_semicolon() {
        let conn = setup();
        let result = run_detector_query(
            &conn,
            "select msg_id, timestamp_us from messages where arb_id = 100;",
            10,
        )
        .unwrap();
        assert_eq!(result.matches.len(), 2);
    }

    #[test]
    fn run_detector_query_handles_trailing_line_comment() {
        let conn = setup();
        let result = run_detector_query(
            &conn,
            "select msg_id, timestamp_us from messages where arb_id = 100 -- note",
            10,
        )
        .unwrap();
        assert_eq!(result.matches.len(), 2);
    }

    #[test]
    fn run_detector_query_surfaces_bad_sql_errors() {
        let conn = setup();
        assert!(run_detector_query(&conn, "select * from no_such_table", 10).is_err());
    }

    #[test]
    fn list_signal_samples_orders_by_timestamp_and_respects_limit() {
        let conn = setup();
        conn.execute_batch(
            "INSERT INTO arxml_signal VALUES (0, 'EngineRpm', 'can', 100, 0, 16, false, 0.25, 0.0);
             INSERT INTO signals VALUES (0, 2, 2000, 600, 150.0);
             INSERT INTO signals VALUES (0, 1, 1000, 513, 128.25);",
        )
        .unwrap();
        let samples = list_signal_samples(&conn, 0, 1).unwrap();
        assert_eq!(
            samples,
            vec![(1000, 128.25)],
            "earliest sample first, limited to 1"
        );
    }
}
