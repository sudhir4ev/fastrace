// Tiny canned-output stand-in for fastrace_parse, used by
// sidecar_test.rs::spawn_parses_fake_progress so parsing is testable without
// needing the C++ toolchain built at all. Portable (plain Rust binary, no
// shell script) across Linux/Mac/Windows CI.
fn main() {
    println!("{{\"containers\":1,\"messages\":10000,\"bytes_read\":500,\"bytes_total\":1000,\"elapsed_ms\":50}}");
    println!("{{\"containers\":1,\"messages\":20000,\"bytes_read\":1000,\"bytes_total\":1000,\"elapsed_ms\":100}}");
    println!(
        "{{\"done\":true,\"containers\":1,\"messages\":20000,\"protocol_rows\":15,\"bytes_read\":1000,\"bytes_total\":1000,\"elapsed_ms\":120}}"
    );
}
