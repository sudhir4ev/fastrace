use std::path::Path;

pub use duckdb::Connection;

/// Must match `schema/schema.sql`'s `-- schema_version: N` comment and the
/// C++ side's embedded `kSchemaVersion` (docs/adr/0001 rule 1). Bump both
/// together when the DDL changes.
const EXPECTED_SCHEMA_VERSION: &str = "2";

/// Opens an existing Trace Store (`<stem>.duckdb`) read-only and checks
/// `meta.schema_version` against `EXPECTED_SCHEMA_VERSION`.
pub fn open(path: &Path) -> Result<Connection, String> {
    let config = duckdb::Config::default()
        .access_mode(duckdb::AccessMode::ReadOnly)
        .map_err(|e| e.to_string())?;
    let conn = Connection::open_with_flags(path, config).map_err(|e| e.to_string())?;
    let version: String = conn
        .query_row(
            "select value from meta where key = 'schema_version'",
            [],
            |row| row.get(0),
        )
        .map_err(|e| format!("could not read schema_version: {e}"))?;
    if version != EXPECTED_SCHEMA_VERSION {
        return Err(format!(
            "schema_version mismatch: store has {version}, expected {EXPECTED_SCHEMA_VERSION}"
        ));
    }
    Ok(conn)
}

#[cfg(test)]
mod tests {
    use super::*;
    use duckdb::Connection as RwConnection;

    fn write_store_with_version(path: &Path, version: &str) {
        let conn = RwConnection::open(path).unwrap();
        conn.execute_batch(
            "CREATE TABLE meta (key VARCHAR, value VARCHAR);
             CREATE TABLE messages (msg_id BIGINT);",
        )
        .unwrap();
        conn.execute("INSERT INTO meta VALUES ('schema_version', ?)", [version])
            .unwrap();
    }

    #[test]
    fn open_succeeds_when_version_matches() {
        let dir = std::env::temp_dir().join(format!("trace_store_test_ok_{}", std::process::id()));
        write_store_with_version(&dir, "2");
        assert!(open(&dir).is_ok());
        let _ = std::fs::remove_file(&dir);
    }

    #[test]
    fn open_fails_when_version_mismatches() {
        let dir = std::env::temp_dir().join(format!("trace_store_test_bad_{}", std::process::id()));
        write_store_with_version(&dir, "999");
        let err = open(&dir).expect_err("mismatched schema_version should error");
        assert!(
            err.contains("schema_version mismatch"),
            "unexpected error: {err}"
        );
        let _ = std::fs::remove_file(&dir);
    }

    #[test]
    fn open_fails_when_file_missing() {
        assert!(open(Path::new("/nonexistent/path/does_not_exist.duckdb")).is_err());
    }
}
