/// Runs a `SELECT COUNT(*) ...`-shaped query and returns the single integer
/// result. Not a general query runner - just enough to drive the Wave 2
/// summary screen's fixed set of aggregate counts.
pub fn count(conn: &trace_store::Connection, sql: &str) -> Result<i64, String> {
    conn.query_row(sql, [], |row| row.get(0)).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use trace_store::Connection;

    #[test]
    fn count_returns_row_count() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("CREATE TABLE t (x INTEGER); INSERT INTO t VALUES (1), (2), (3);").unwrap();
        assert_eq!(count(&conn, "select count(*) from t").unwrap(), 3);
    }

    #[test]
    fn count_surfaces_sql_errors() {
        let conn = Connection::open_in_memory().unwrap();
        assert!(count(&conn, "select count(*) from no_such_table").is_err());
    }
}
