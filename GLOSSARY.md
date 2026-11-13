# Glossary

Domain and product terms as used in Fastrace. Product-pipeline vocabulary is authoritative in [`CONTEXT.md`](CONTEXT.md); this file covers the wider automotive / wire / storage jargon those terms sit on.

---

## Product pipeline (see also CONTEXT.md)

| Term | Meaning |
|------|---------|
| **Trace** | Source capture file (typically BLF). Input to Parse only; Detect after Ingest uses the Trace Store. |
| **Parse** | C++ Sidecar turns Trace bytes into structured records (protocol peel included). Does not write DuckDB. |
| **Parse Artifact** | On-disk handoff from Parse (Parquet / Arrow IPC), e.g. `<stem>.parse.parquet`. Staging, not the Trace Store. |
| **Ingest** | Load Parse Artifact (+ optional Signal Database) into the Trace Store. No BLF/protocol decoding. |
| **Trace Store** | Local DuckDB file for anomaly SQL after Prepare. Beside the Trace; owned by the Shell (Rust). |
| **Prepare Trace Store** | One user action: Parse → Ingest (fail-fast; no half store). |
| **Sidecar** | C++ CLI `fastrace_parse`. |
| **Shell** | Tauri `/app` UI: Prepare, Detector Query, results. |
| **Detector Query** | User-authored SQL against the Trace Store; v1 returns raw columns. |
| **Detection** | Product-shaped anomaly finding (time, severity, message, message index, …). Not forced as v1 SQL shape. |
| **Signal Database** | ARXML (later DBC) describing the vehicle network. Optional; materialised into Trace Store when provided. |
| **Peel** | Extract typed protocol headers/fields from a frame into columns/structs (SOME/IP, SD, DoIP, PDU) so SQL need not re-parse payloads. |

---

## Vehicle network & buses

| Term | Meaning |
|------|---------|
| **AUTOSAR** | Automotive Open System Architecture — standards for ECU software and (via ARXML) network descriptions. |
| **ECU** | Electronic Control Unit — a node on the vehicle network. |
| **CAN** | Controller Area Network — classic automotive bus; frames identified by arbitration ID. |
| **CAN FD** | CAN with Flexible Data-rate — longer payloads (up to 64 B) and faster data phase. |
| **Arbitration ID / arb ID** | CAN frame identifier (11-bit standard or 29-bit extended). Bit 31 set in BLF often marks extended. |
| **DLC** | Data Length Code — encoded length field on CAN/CAN FD (not always equal to byte count on FD). |
| **Channel** | Logical bus/index in the capture (BLF channel field; often 1-based). |
| **Ethernet (vehicle)** | In-vehicle Ethernet carrying AUTOSAR PDUs, SOME/IP, DoIP, etc., typically over UDP/TCP. |
| **PDU** | Protocol Data Unit — named payload unit with a **PDU ID** and length. On Ethernet, several PDUs may be packed in one UDP datagram as `[id:4][len:4][bytes…]…`. Ethernet peer of a CAN ID for Signal Database lookup. |
| **Signal** | Named value packed inside a PDU/CAN frame (bit position, scale, unit) defined in ARXML/DBC. |
| **Payload** | Raw bytes of a frame or protocol body. Trace Store v1 prefers peeled columns over storing payload BLOBs. |

---

## Protocols Fastrace peels

| Term | Meaning |
|------|---------|
| **SOME/IP** | Scalable service-Oriented MiddlewarE over IP (AUTOSAR). RPC/event messaging over UDP/TCP. Header: service, method, length, client, session, versions, message type, return code. |
| **Service ID / Method ID** | SOME/IP addressing of a service and an operation/event within it. |
| **Client ID / Session ID** | SOME/IP request/response correlation; session sequencing used for lifecycle/gap checks. |
| **SOME/IP-SD (SD)** | Service Discovery — offers/finds/subscribes services. Identified on wire as service `0xFFFF`, method `0x8100`. Default UDP port **30490**. |
| **SD flags** | First byte of SD header (e.g. reboot/unicast bits). Unexpected values are a common structural check. |
| **SD entry** | FindService / OfferService / Subscribe / StopSubscribe records inside an SD message. |
| **DoIP** | Diagnostics over IP (ISO 13400). Vehicle diagnostics sessions over TCP (and UDP for discovery). |
| **DoIP protocol version / inverse version** | Header bytes that must be complements (`inverse == ~version` as `uint8`). Common versions: `0x02`, `0x03`. |
| **DoIP payload type** | Message kind (e.g. routing activation, diagnostic message `0x8001`, alive check). |
| **Source / target address (DoIP)** | Logical diagnostic addresses of tester and ECU (not IP addresses). |
| **Routing activation** | DoIP handshake before diagnostic traffic. |
| **Alive check** | DoIP keepalive; timeouts are a classic anomaly class. |
| **NACK** | Negative acknowledgement — protocol rejection / error response. |

---

## Description files

| Term | Meaning |
|------|---------|
| **ARXML** | AUTOSAR XML — machine-readable network/software description (PDUs, signals, ECUs, IPs/ports, …). |
| **DBC** | CAN database format (Vector) mapping IDs → messages/signals. Later Signal Database option. |
| **Unknown PDU ID / unknown address** | Anomaly: ID or DoIP address not present in the loaded Signal Database (skipped if no DB). |

---

## Trace file format (BLF)

| Term | Meaning |
|------|---------|
| **BLF** | Binary Log File (Vector) — compressed automotive capture format. |
| **LOBJ** | Log object — sized record in a BLF (`"LOBJ"` signature + type + size). Sequence of records, not a linked list. |
| **LOG_CONTAINER / CONTAINER** | Compressed LOBJ whose payload is another stream of LOBJs after inflate. |
| **Object type** | LOBJ kind (e.g. CAN_MESSAGE, CAN_FD_MESSAGE, ETHERNET_FRAME, CONTAINER). |
| **File offset / container index** | Location keys to jump from a store row back into the BLF for deep-dive. |
| **Stitcher** | Parser path that reassembles an LOBJ split across two adjacent containers. |
| **Chunk** | Analyzer unit of work (decode window); streaming DetectionEngine walked chunks. |

---

## Fastrace internals / Trace Store

| Term | Meaning |
|------|---------|
| **TraceMessage** | Unified in-memory row from a decoded LOBJ (timestamp, channel, CAN/Ethernet fields, optional PDU map). |
| **ProtocolMessage** | Peeled protocol variant (SOME/IP, SD, DoIP, PDU) with `sourceIndices` into TraceMessages. |
| **ProtocolParser** | Builds ProtocolMessages (UDP peel, TCP reassembly for DoIP). |
| **messages** | Trace Store table: one row per TraceMessage (no payload BLOB in target architecture). |
| **protocol_pdu / protocol_someip / protocol_someip_sd / protocol_doip** | Peeled protocol tables keyed by `msg_id`. |
| **arxml_*** | Materialised Signal Database tables for joins (e.g. `arxml_pdu`, `arxml_can`, `arxml_ecu`). |
| **msg_id / message index** | Stable row id in the store / Detection link back to a message. |
| **timestamp_us** | Message time in microseconds (series key for windows, gaps, rates). |
| **Anomaly** | Anything that deviates from expected protocol or fleet behaviour (structural or DB-relative). |
| **Severity** | Detection level: Info / Warning / Error. |
| **Stateful vs stateless detector** | Legacy C++: stateful keeps cross-message state (sessions, rates); stateless is per-message. Query path expresses state with SQL windows/aggregates instead. |
| **DetectionEngine / `*Detector` (C++)** | Legacy streaming anomaly path over `decodeChunk`. Product direction is Detector Query over Trace Store only. |

---

## Related docs

- [`CONTEXT.md`](CONTEXT.md) — locked product language (Trace / Parse / Ingest / Store / Shell).
- [`cpp/doc/query_store_architecture.md`](cpp/doc/query_store_architecture.md) — Trace Store target architecture.
- [`cpp/doc/blf_batch_ingest_architecture.md`](cpp/doc/blf_batch_ingest_architecture.md) — BLF → batch ingest.
- [`cpp/doc/design.md`](cpp/doc/design.md) — BLF parallel parse / stitcher.
- [`specs/006-anomaly-detection/`](specs/006-anomaly-detection/) — anomaly FR set (PDU / SD / DoIP).
- [`cpp/sql/anomaly_detectors.sql`](cpp/sql/anomaly_detectors.sql) — SQL ports of the current C++ detector rules.
