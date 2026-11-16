use std::path::Path;

/// Opens an existing Trace Store (`<stem>.duckdb`) read-only and checks
/// `meta.schema_version` against `schema/schema.sql` (docs/adr/0001, rule 1).
/// Stub: real implementation lands with the duckdb-rs integration.
pub fn open(_path: &Path) -> Result<(), String> {
    Err("trace_store::open: not implemented yet (see docs/adr/0002)".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    #[test]
    fn open_is_not_yet_implemented() {
        assert!(open(Path::new("nonexistent.duckdb")).is_err());
    }
}
