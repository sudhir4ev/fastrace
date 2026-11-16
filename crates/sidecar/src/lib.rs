/// Spawns the bundled `fastrace_parse` sidecar (docs/adr/0001) and parses its
/// progress/error protocol. Stub: real implementation lands with the Tauri
/// sidecar process wiring.
pub fn spawn(_args: &[String]) -> Result<(), String> {
    Err("sidecar::spawn: not implemented yet (see docs/adr/0002)".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn spawn_is_not_yet_implemented() {
        assert!(spawn(&["prepare".to_string()]).is_err());
    }
}
