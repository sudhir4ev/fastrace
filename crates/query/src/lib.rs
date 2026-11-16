/// Runs a Detector Query (raw SQL, docs/adr/0003) against an opened Trace
/// Store and returns rows/columns. Stub: real implementation lands with the
/// duckdb-rs query execution.
pub fn run(_sql: &str) -> Result<(), String> {
    Err("query::run: not implemented yet (see docs/adr/0003)".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn run_is_not_yet_implemented() {
        assert!(run("select 1").is_err());
    }
}
