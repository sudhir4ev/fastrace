# native/store

Trace Store writer: embeds `schema/schema.sql` at build time (CMake `configure_file`,
see `include/SchemaEmbed.h.in`), wraps the DuckDB Appender, and maps ARXML/protocol
rows into the Trace Store (`docs/adr/0002-cpp-sidecar-writes-trace-store.md`).

DuckDB itself is fetched as a prebuilt `libduckdb` release (pinned version in
`CMakeLists.txt`, `FASTRACE_DUCKDB_VERSION`) rather than built from source or
installed system-wide.

## Build and test

```
cmake -S . -B build && cmake --build build --target fastrace_store_test fastrace_fixture_gen fastrace_fixture_check
ctest --test-dir build -R 'fastrace_store|fastrace_fixture'
```

This builds and runs three independent checks, none of which need Rust or the
Tauri app:

- `fastrace_store_roundtrip` - opens a temp DuckDB file, runs the embedded schema,
  appends a handful of hand-built rows via the `Appender` wrapper, and reads them
  back. No BLF file involved.
- `fastrace_fixture_gen_smoke` - runs the synthetic fixture generator
  (`test/fixtures/generate_fixture.cpp`) and checks it still produces non-empty
  output. It does not regenerate the committed `test/fixtures/fixture.blf` /
  `fixture.arxml` - re-run `fastrace_fixture_gen` by hand and commit the new
  output if the fixture needs to grow.
- `fastrace_store_fixture_prepare` (registered in `native/cli`, once
  `fastrace_parse` exists) - runs `fastrace_parse prepare` against the committed
  fixture and asserts exact row counts per table (`docs/adr/0007`), via
  `test/fixture_prepare_check.cpp`.

## What the fixture exercises

Two CAN frames and four Ethernet frames, chosen so each peeled protocol type gets
exactly one row: one packed-PDU-only frame, one SOME/IP message, one SOME/IP-SD
message, one DoIP message. See the comments in
`test/fixtures/generate_fixture.cpp` for the exact byte layout and in
`test/fixture_prepare_check.cpp` for the expected counts.

## Known gaps

- `appendProto()` (`src/ProtocolAppend.cpp`) keys `msg_id` off
  `ProtocolMessage::sourceIndices.front()`. Today `ProtocolParser` always emits
  exactly one source index per message; if multi-frame TCP reassembly is added
  later, this needs to become a loop writing one row per source index.
- `ProtocolParser` is constructed with no `ArDatabase*` (`nullptr`). Wiring the
  parsed ARXML into protocol peel is signal-decode territory (ADR 0005), not
  needed for the protocol tables this module populates.
- The DoIP fixture frame (E4) also produces one `protocol_pdu` row: its
  `payloadLength` field happens to also parse as a valid length when the same
  bytes are re-read by the generic packed-PDU walk (`indexEthernetPdus`). This
  is an existing quirk in how Ethernet payloads are peeled twice (once as a
  specific protocol, once as generic packed PDUs), not a bug introduced here;
  `fixture_prepare_check.cpp` asserts the resulting count (2, not 1) directly.
- The fixture's ARXML Ethernet PDU entry (`arxml_pdu`) has `pdu_id = 0` and no
  `dst_ip`/`dst_port`, because wiring up the `SOCKET-CONNECTION`/
  `NETWORK-ENDPOINT` ARXML chain needed to resolve those fields is unnecessary
  until a rule actually joins `arxml_pdu` against `protocol_pdu` by id.
