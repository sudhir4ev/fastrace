# native/protocol

Protocol peel: PDU, SOME/IP, SOME/IP-SD, DoIP, TCP. Pure byte-in,
`ProtocolMessage`-out - no file I/O, no database knowledge (docs/adr/0001).

## Build + test

    cmake -S . -B build && cmake --build build --target fastrace_protocol_test
    ctest --test-dir build -R fastrace_protocol_test --output-on-failure

No fixture file needed - `test/protocol_parser_test.cpp` constructs
`TraceMessage` values directly.
