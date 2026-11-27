use duckdb::Connection;

/// Seeded-store tests for the TCP Connection Health analyzer SQL
/// (schema/rules/analyzers/tcp_connection_health.sql), per ADR 0007: a
/// minimal messages/protocol_tcp schema built with INSERT statements, not
/// the C++ fixture. Flags: FIN=1 SYN=2 RST=4 PSH=8 ACK=16.
const ANALYZER_SQL: &str =
    include_str!("../../../schema/rules/analyzers/tcp_connection_health.sql");

fn seeded_conn() -> Connection {
    let conn = Connection::open_in_memory().unwrap();
    conn.execute_batch(
        "CREATE TABLE messages (msg_id BIGINT, timestamp_us BIGINT, src_ip VARCHAR, src_port INTEGER,
                                 dst_ip VARCHAR, dst_port INTEGER);
         CREATE TABLE protocol_tcp (msg_id BIGINT, flags INTEGER, segment_len INTEGER);",
    )
    .unwrap();
    conn.execute_batch(ANALYZER_SQL).unwrap();
    conn
}

/// `from_client` picks which side is sending: true = 10.0.0.1:client_port ->
/// 10.0.0.2:server_port, false = the reverse. Both IP and port swap together,
/// matching how a real reply flips both.
fn seg(
    conn: &Connection,
    msg_id: i64,
    ts: i64,
    from_client: bool,
    client_port: i32,
    server_port: i32,
    flags: i32,
) {
    let (src_ip, src_port, dst_ip, dst_port) = if from_client {
        ("10.0.0.1", client_port, "10.0.0.2", server_port)
    } else {
        ("10.0.0.2", server_port, "10.0.0.1", client_port)
    };
    conn.execute(
        "INSERT INTO messages VALUES (?, ?, ?, ?, ?, ?)",
        duckdb::params![msg_id, ts, src_ip, src_port, dst_ip, dst_port],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO protocol_tcp VALUES (?, ?, 0)",
        duckdb::params![msg_id, flags],
    )
    .unwrap();
}

fn findings_rules(conn: &Connection, port: i32) -> Vec<String> {
    let sql = format!(
        "SELECT rule FROM findings WHERE src_node LIKE '%:{port}' OR dst_node LIKE '%:{port}' ORDER BY rule"
    );
    let mut stmt = conn.prepare(&sql).unwrap();
    stmt.query_map([], |row| row.get::<_, String>(0))
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap()
}

#[test]
fn handshake_no_synack() {
    let conn = seeded_conn();
    seg(&conn, 0, 1_000, true, 1000, 2000, 0x02); // SYN, no reply
    assert_eq!(findings_rules(&conn, 1000), vec!["HANDSHAKE_NO_SYNACK"]);
}

#[test]
fn connection_refused() {
    let conn = seeded_conn();
    seg(&conn, 0, 1_000, true, 1001, 2001, 0x02); // SYN
    seg(&conn, 1, 1_100, false, 1001, 2001, 0x04); // RST from server
    assert_eq!(findings_rules(&conn, 1001), vec!["CONNECTION_REFUSED"]);
}

#[test]
fn connection_reset() {
    let conn = seeded_conn();
    seg(&conn, 0, 1_000, true, 1002, 2002, 0x02); // SYN
    seg(&conn, 1, 1_100, false, 1002, 2002, 0x12); // SYN-ACK
    seg(&conn, 2, 1_200, true, 1002, 2002, 0x10); // ACK
    seg(&conn, 3, 1_300, false, 1002, 2002, 0x04); // RST
    assert_eq!(findings_rules(&conn, 1002), vec!["CONNECTION_RESET"]);
}

#[test]
fn never_closed() {
    let conn = seeded_conn();
    seg(&conn, 0, 1_000, true, 1003, 2003, 0x02); // SYN
    seg(&conn, 1, 1_100, false, 1003, 2003, 0x12); // SYN-ACK
    seg(&conn, 2, 1_200, true, 1003, 2003, 0x10); // ACK, no FIN/RST ever
    assert_eq!(findings_rules(&conn, 1003), vec!["NEVER_CLOSED"]);
}

#[test]
fn silence_timeout() {
    let conn = seeded_conn();
    seg(&conn, 0, 0, true, 1004, 2004, 0x02); // SYN
    seg(&conn, 1, 1, false, 1004, 2004, 0x12); // SYN-ACK
    seg(&conn, 2, 2, true, 1004, 2004, 0x10); // ACK
    seg(&conn, 3, 2 + 16_000_000, true, 1004, 2004, 0x10); // ACK after a 16s gap
    let rules = findings_rules(&conn, 1004);
    assert!(
        rules.contains(&"SILENCE_TIMEOUT".to_string()),
        "expected SILENCE_TIMEOUT in {rules:?}"
    );
}

#[test]
fn reconnect_on_same_address_pair_gets_a_distinct_stream_index() {
    let conn = seeded_conn();
    // Connection 1: full handshake + clean close.
    seg(&conn, 0, 0, true, 1005, 2005, 0x02); // SYN
    seg(&conn, 1, 1, false, 1005, 2005, 0x12); // SYN-ACK
    seg(&conn, 2, 2, true, 1005, 2005, 0x10); // ACK
    seg(&conn, 3, 3, true, 1005, 2005, 0x11); // FIN+ACK
                                              // Connection 2: same two ports reconnect later.
    seg(&conn, 4, 1_000, true, 1005, 2005, 0x02); // SYN
    seg(&conn, 5, 1_001, false, 1005, 2005, 0x12); // SYN-ACK
    seg(&conn, 6, 1_002, true, 1005, 2005, 0x10); // ACK

    let mut stmt = conn
        .prepare(
            "SELECT DISTINCT stream_index FROM sessions
             WHERE src_node LIKE '%:1005' OR dst_node LIKE '%:1005' ORDER BY stream_index",
        )
        .unwrap();
    let indices: Vec<i64> = stmt
        .query_map([], |row| row.get(0))
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap();
    assert_eq!(
        indices.len(),
        2,
        "two separate conversations on the same address pair must not merge into one session"
    );
}

#[test]
fn segments_view_renders_wireshark_style_flag_strings() {
    let conn = seeded_conn();
    seg(&conn, 0, 0, true, 1006, 2006, 0x02); // SYN
    seg(&conn, 1, 1, false, 1006, 2006, 0x12); // SYN-ACK
    let mut stmt = conn
        .prepare("SELECT info FROM segments WHERE msg_id = 1")
        .unwrap();
    let info: String = stmt.query_row([], |row| row.get(0)).unwrap();
    assert_eq!(info, "[SYN, ACK]");
}
