# 0005. Signal decode on plot

- Status: Accepted
- Date: 2026-11-16

## Context

The Trace Store does not keep payload bytes (0006), so signal values (e.g. engine RPM) cannot be read from it. Decoding every ARXML signal at ingest is too expensive: an earlier attempt projected about 3.2 billion signal rows and tens of GB for the 8.8 GB HCP2 trace.

Choosing a small whitelist up front is hard: the MFK5 benchmark has about 3,000 decodable signals. A second decode pass is cheap: the parallel `Analyzer` inflates and decodes the 1.46 GiB benchmark in about 1.0 s, so an on-demand pass is estimated at 2-5 s there and 10-30 s for an 8.8 GB trace.

## Decision

1. **Decode when the user plots, then cache.** No explicit whitelist step. The first plot of a signal runs `fastrace_parse decode-signals`, which re-reads the BLF and appends that signal's samples to a `signals` table. Later plots are plain SQL.
2. **Decode lives in C++** (`native/signaldb`, `native/cli`), because only C++ reads the BLF. Its only output is rows in a table defined in `schema/`.
3. **One store file in the MVP.** `signals` lives in the main Trace Store. Rust closes its connection while `decode-signals` (or Prepare) runs, so queries are blocked for those seconds.
4. **Signal dictionary in the store.** Prepare materializes an `arxml_signal` table (signal name, parent message or PDU, start bit, length, factor/offset). A SQL view joins it to `messages` / `protocol_pdu` to list which signals are decodable from the trace and how often their messages occur.
5. **Suggested defaults.** The UI offers a suggested list from that view: it excludes padding, CRC, counter and status fields, then ranks by domain and message frequency.

Cache rows: `(signal_id, msg_id, timestamp_us, raw_value, phys_value)`, every sample. The cache records the store's `schema_version` and the source BLF size and mtime. On mismatch it is ignored and rebuilt.

## Consequences

- Users choose signals by plotting them; the cached set grows from real use.
- "Decodable" is inferred from message IDs: a message's presence means its signals can be decoded, not that they hold valid or changing values (multiplexed and padding fields look the same at the ID level).
- Queries are unavailable during a decode. Acceptable for the MVP.

## Deferred

- Separate cache file (`<stem>.signals.duckdb`) attached read-only, so the main store stays queryable during decode.
- Change-only storage (one row per value change) to cut rows, typically 10-100x.
- Container index at ingest (file offset per container plus a container column on `messages`) so decode inflates only containers holding the target message. Near-instant for rare signals; no help for signals sent in nearly every container.

## Revisit when

- Query blackouts during decode become a UX problem.
- `signals` grows large enough to slow other queries.
