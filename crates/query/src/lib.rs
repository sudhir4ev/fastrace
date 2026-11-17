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
}
