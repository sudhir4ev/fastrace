//! Spawns the bundled `fastrace_parse` sidecar (docs/adr/0001) and parses its
//! progress/error protocol (docs/adr/0002). Knows nothing about Tauri or
//! DuckDB - just a child process and its stdout/stderr.

use std::io::{BufRead, BufReader, Read};
use std::path::Path;
use std::process::{Command, Stdio};

#[derive(Debug, Clone, PartialEq)]
pub enum Progress {
    Running {
        containers: u64,
        messages: u64,
        elapsed_ms: u64,
    },
    Done {
        containers: u64,
        messages: u64,
        protocol_rows: u64,
        elapsed_ms: u64,
    },
}

impl Progress {
    /// Parses one stdout line of `fastrace_parse prepare`'s progress protocol.
    /// Returns None for lines that aren't recognized progress JSON.
    pub fn parse(line: &str) -> Option<Progress> {
        let v: serde_json::Value = serde_json::from_str(line).ok()?;
        if v.get("done").is_some() {
            Some(Progress::Done {
                containers: v.get("containers")?.as_u64()?,
                messages: v.get("messages")?.as_u64()?,
                protocol_rows: v.get("protocol_rows")?.as_u64()?,
                elapsed_ms: v.get("elapsed_ms")?.as_u64()?,
            })
        } else {
            Some(Progress::Running {
                containers: v.get("containers")?.as_u64()?,
                messages: v.get("messages")?.as_u64()?,
                elapsed_ms: v.get("elapsed_ms")?.as_u64()?,
            })
        }
    }
}

/// Spawns `binary_path` with `args`, calling `on_progress` for each parsed
/// stdout progress line. On nonzero exit, returns Err with the child's
/// stderr (expected to be one `{"error":"..."}` line per the protocol).
pub fn spawn(
    binary_path: &Path,
    args: &[String],
    mut on_progress: impl FnMut(Progress),
) -> Result<(), String> {
    let mut child = Command::new(binary_path)
        .args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("failed to spawn {}: {}", binary_path.display(), e))?;

    let stdout = child.stdout.take().ok_or("sidecar: no stdout pipe")?;
    for line in BufReader::new(stdout).lines() {
        let line = line.map_err(|e| e.to_string())?;
        if let Some(progress) = Progress::parse(&line) {
            on_progress(progress);
        }
    }

    let status = child.wait().map_err(|e| e.to_string())?;
    if !status.success() {
        let mut stderr_out = String::new();
        if let Some(mut stderr) = child.stderr.take() {
            let _ = stderr.read_to_string(&mut stderr_out);
        }
        return Err(format!(
            "{} exited with {}: {}",
            binary_path.display(),
            status,
            stderr_out.trim()
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_running_line() {
        let p = Progress::parse(r#"{"containers":1,"messages":10000,"elapsed_ms":42}"#).unwrap();
        assert_eq!(
            p,
            Progress::Running {
                containers: 1,
                messages: 10000,
                elapsed_ms: 42
            }
        );
    }

    #[test]
    fn parse_done_line() {
        let p = Progress::parse(
            r#"{"done":true,"containers":1,"messages":6,"protocol_rows":5,"elapsed_ms":78}"#,
        )
        .unwrap();
        assert_eq!(
            p,
            Progress::Done {
                containers: 1,
                messages: 6,
                protocol_rows: 5,
                elapsed_ms: 78
            }
        );
    }

    #[test]
    fn parse_rejects_non_progress_json() {
        assert!(Progress::parse(r#"{"unrelated":true}"#).is_none());
        assert!(Progress::parse("not json").is_none());
    }
}
