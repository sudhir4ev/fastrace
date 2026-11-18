# native/signaldb

ARXML parsing (`ArxmlParser`) and signal decode (`SignalDecoder`): turns an AUTOSAR
ARXML file into an `ArDatabase` (ECUs, CAN/Ethernet messages, signal definitions with
bit layout and linear scaling), and extracts raw/decoded signal values from BLF
message bytes (`docs/adr/0005-signal-decode-on-plot.md`).

`SignalStatsTracker` builds an indexed per-signal summary during Prepare: for every
payload it updates samples/nonzero/changes/min/max (or a byte-span FNV-1a hash for
opaque signals with `bit_length > 64`). The CLI writes one `signal_stats` row per
`arxml_signal` at the end of Prepare. Signal IDs match `loadArxml`'s assignment order.

## Build and test

```
cmake -S . -B build && cmake --build build --target fastrace_signaldb_test
ctest --test-dir build -R fastrace_signaldb_test
```

No BLF file, DuckDB, Rust, or Tauri involved - this runs against the committed
`native/store/test/fixtures/fixture.arxml` and a small inline synthetic ARXML string.

## What the test covers

- `extractSignalRaw`: Intel (LSB-first) and Motorola (MSB-first) bit extraction.
- `ArxmlParser`'s COMPU-METHOD chain: `I-SIGNAL` → `SYSTEM-SIGNAL` → `COMPU-METHOD-REF`
  → `COMPU-RATIONAL-COEFFS`, against the fixture's `EngineRpm` signal (factor `0.25`,
  offset `0.0`, confirmed against the real tag shape found in a production ARXML
  sample).
- The no-`COMPU-METHOD-REF` fallback: a signal with no scaling info at all must leave
  `factor=1.0, offset=0.0`.
- `decodeAllSignals`' new `parentCanId`/`parentPduId` tagging on `DecodedSignal`, used
  by `decode-signals` to disambiguate same-named signals across different messages.
- `SignalStatsTracker`: constant signal → `changes == 0`; varying signal → correct
  counts/min/max; opaque (`bit_length > 64`) change detection via hash; Ethernet PDU
  with mismatched `dstIp` is not counted.

## Known gaps

- Only the **linear** `COMPU-RATIONAL-COEFFS` case is parsed (2 numerator
  coefficients, 1 denominator coefficient). A method with a non-zero second
  denominator coefficient (genuinely rational/non-linear) or a pure text-table
  (`COMPU-CONST`-only) method falls back to `factor=1.0, offset=0.0` rather than being
  misinterpreted - this is a deliberate scope limit (docs/adr/0005's "Signal ingestion,
  second pass" plan), not a bug. Revisit if real traces turn out to need non-linear
  scaling for signals that matter.
- When a `COMPU-METHOD` mixes a linear scale with `COMPU-CONST` text-table entries
  (common for enum-with-fallback signals, e.g. `0xFE`="Init"/`0xFF`="Error"), only the
  linear scale's factor/offset is used; the named special values are not surfaced
  anywhere yet.
