use std::path::{Path, PathBuf};

use sidecar::{spawn, Progress};

#[test]
fn spawn_parses_fake_progress() {
    let bin = PathBuf::from(env!("CARGO_BIN_EXE_fake_progress"));
    let mut seen = Vec::new();
    spawn(&bin, &[], |p| seen.push(p)).expect("fake_progress should exit 0");

    assert_eq!(seen.len(), 3);
    assert_eq!(
        seen[0],
        Progress::Running {
            containers: 1,
            messages: 10000,
            bytes_read: 500,
            bytes_total: 1000,
            elapsed_ms: 50
        }
    );
    assert_eq!(
        seen[2],
        Progress::Done {
            containers: 1,
            messages: 20000,
            protocol_rows: 15,
            bytes_read: 1000,
            bytes_total: 1000,
            elapsed_ms: 120
        }
    );
}

/// Points `spawn()` at a real, locally-built `fastrace_parse` and runs it
/// against the committed native/store fixture. Requires the C++ side to
/// already be built (`cmake --build build`) - skips with a message rather
/// than failing if that binary isn't present, so `cargo test` alone (fresh
/// clone, no cmake build yet) doesn't spuriously fail.
#[test]
fn spawn_runs_real_fastrace_parse_against_fixture() {
    let Some(bin) = locate_fastrace_parse() else {
        eprintln!("skipping: fastrace_parse not found (set FASTRACE_PARSE_BIN or run cmake --build build first)");
        return;
    };

    let manifest_dir = Path::new(env!("CARGO_MANIFEST_DIR"));
    let repo_root = manifest_dir.join("../..");
    let fixture_blf = repo_root.join("native/store/test/fixtures/fixture.blf");
    let fixture_arxml = repo_root.join("native/store/test/fixtures/fixture.arxml");
    assert!(
        fixture_blf.exists(),
        "missing committed fixture: {}",
        fixture_blf.display()
    );

    let mut saw_done = false;
    let result = spawn(
        &bin,
        &[
            "prepare".to_string(),
            fixture_blf.to_string_lossy().to_string(),
            fixture_arxml.to_string_lossy().to_string(),
        ],
        |p| {
            if matches!(p, Progress::Done { .. }) {
                saw_done = true;
            }
        },
    );

    let _ = std::fs::remove_file(fixture_blf.with_extension("duckdb"));
    let _ = std::fs::remove_file(format!(
        "{}.wal",
        fixture_blf.with_extension("duckdb").display()
    ));

    result.expect("fastrace_parse prepare should exit 0 against the fixture");
    assert!(
        saw_done,
        "expected a final {{\"done\":true,...}} progress line"
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
