use std::path::{Path, PathBuf};
use std::process::Command;

/// Runs the real `fastrace_parse prepare` against the committed Wave 1
/// fixture, then re-derives the Wave 2 summary screen's exact aggregate
/// queries and checks them against the row counts documented in
/// native/store/README.md ("What the fixture exercises") and asserted by
/// native/store/test/fixture_prepare_check.cpp. Requires the C++ side to
/// already be built (`cmake --build build`) - skips with a message rather
/// than failing if that binary isn't present, matching the precedent in
/// crates/sidecar/tests/sidecar_test.rs.
#[test]
fn summary_counts_match_fixture() {
    let Some(bin) = locate_fastrace_parse() else {
        eprintln!("skipping: fastrace_parse not found (set FASTRACE_PARSE_BIN or run cmake --build build first)");
        return;
    };

    let manifest_dir = Path::new(env!("CARGO_MANIFEST_DIR"));
    let repo_root = manifest_dir.join("../..");
    let fixture_blf = repo_root.join("native/store/test/fixtures/fixture.blf");
    let fixture_arxml = repo_root.join("native/store/test/fixtures/fixture.arxml");
    let fixture_duckdb = fixture_blf.with_extension("duckdb");
    assert!(
        fixture_blf.exists(),
        "missing committed fixture: {}",
        fixture_blf.display()
    );

    let status = Command::new(&bin)
        .args([
            "prepare",
            fixture_blf.to_str().expect("non-utf8 path"),
            fixture_arxml.to_str().expect("non-utf8 path"),
        ])
        .status()
        .expect("failed to run fastrace_parse");
    assert!(
        status.success(),
        "fastrace_parse prepare exited with {status}"
    );

    let result = (|| -> Result<(i64, i64, i64, i64, i64, i64, i64), String> {
        let conn = trace_store::open(&fixture_duckdb)?;
        Ok((
            query::count(
                &conn,
                "select count(*) from messages where object_type in (1,100,101)",
            )?,
            query::count(
                &conn,
                "select count(*) from messages where object_type in (71,120,121)",
            )?,
            query::count(&conn, "select count(*) from protocol_pdu")?,
            query::count(&conn, "select count(*) from protocol_someip")?,
            query::count(&conn, "select count(*) from protocol_someip_sd")?,
            query::count(&conn, "select count(*) from protocol_doip")?,
            query::count(&conn, "select count(*) from protocol_tcp")?,
        ))
    })();

    let _ = std::fs::remove_file(&fixture_duckdb);
    let _ = std::fs::remove_file(format!("{}.wal", fixture_duckdb.display()));

    let (can, eth, pdu, someip, sd, doip, tcp) = result.expect("summary queries should succeed");
    assert_eq!(
        (can, eth, pdu, someip, sd, doip, tcp),
        (2, 6, 2, 1, 1, 1, 2)
    );
}

fn locate_fastrace_parse() -> Option<PathBuf> {
    if let Ok(p) = std::env::var("FASTRACE_PARSE_BIN") {
        let p = PathBuf::from(p);
        if p.exists() {
            return Some(p);
        }
    }
    let manifest_dir = Path::new(env!("CARGO_MANIFEST_DIR"));
    let fallback = manifest_dir.join("../../build/native/cli/fastrace_parse");
    fallback.exists().then_some(fallback)
}
