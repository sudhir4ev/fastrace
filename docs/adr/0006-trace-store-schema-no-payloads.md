# 0006. Trace Store schema without payloads

- Status: Accepted
- Date: 2026-11-16

## Context

An early ingest stored every payload as hex text plus all decoded signals. On the 8.8 GB HCP2 trace it reached a 43+ GB partial database at about 57M of 101M messages before being abandoned. Anomaly SQL needs protocol header fields, not raw bytes.

## Decision

The Trace Store ("Option B") contains:

| Table | Contents |
|-------|----------|
| `messages` | One row per frame: `msg_id`, `timestamp_us`, `object_type`, `channel`, CAN fields (`arb_id`, `extended_id`, `dlc`), Ethernet fields (`dst_ip`, `dst_port`), `payload_len` |
| `protocol_pdu` | Peeled PDUs: `msg_id`, `pdu_id`, `length` |
| `protocol_someip` | SOME/IP header fields |
| `protocol_someip_sd` | SOME/IP-SD fields (flags today; fuller entries later) |
| `protocol_doip` | DoIP header fields and addresses |
| `arxml_pdu`, `arxml_can`, `arxml_ecu`, `arxml_signal` | Signal Database dictionary when ARXML is provided (`arxml_signal` per 0005) |
| `signals` | Decoded signal cache, filled on demand (0005) |
| `meta` | `schema_version`, source paths, counts, timings |

Not stored: payload bytes, decoded signals at Prepare, persisted detections (detections are query results).

After Prepare, Detector Queries never reopen the BLF or ARXML.

## Consequences

- The HCP2 trace produced a 5.7 GB store with this schema; the 1.46 GiB MFK5 benchmark produces about 1.0 GB.
- Raw-byte inspection and signal values need the BLF (0005).
- Peel coverage limits what rules can check; new rules may need new peeled columns and a `schema_version` bump.

## Revisit when

- A rule class needs payload bytes that cannot reasonably be peeled into columns.
