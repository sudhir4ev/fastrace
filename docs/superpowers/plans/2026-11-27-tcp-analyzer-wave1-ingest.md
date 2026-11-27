# Protocol Analyzer Framework - Wave Roadmap + Wave 1 (Ingest) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a *generic protocol-analyzer framework* whose first instance is
TCP Connection Health. Wave 1 (this document) unblocks everything by peeling
network identity (`src_ip`/`src_port` on `messages`) and per-segment TCP header
fields (`flags`/`segment_len` in a new `protocol_tcp` table) during Prepare.
TCP is analyzer #1 of several planned; the stack above the peel (findings /
sessions / segments contract, Rust registry, Tauri commands, UI) is designed so
a second protocol is **one SQL file + one registry line**, touching no Rust,
Tauri, or UI. See "Analyzer Framework Contract" below.

**Architecture:** Same inflate pass that already peels PDU/SOME-IP/DoIP (`native/protocol`), fed by TCP header parsing added to `native/blf`'s existing Ethernet frame decode. No new I/O pass, no Rust/UI byte parsing (ADR 0001, ADR 0003). Detection + session reconstruction is pure SQL per analyzer file (ADR 0003); Rust/Tauri only load, scope, and shape a fixed generic row contract.

**Tech Stack:** C++23 (native/blf, native/protocol, native/store), Rust (crates/query, crates/trace-store, app/src-tauri), React/TS (app/ui).

**Spec:** `docs/superpowers/specs/2026-11-26-tcp-analyzer-design.md` - note this
plan **supersedes the spec's "Execution model (plugin contract)" section and
its IP-hardcoded `Finding` struct** with the generic contract below (agreed
2026-11-27: the spec deferred the plugin abstraction to "when analyzer #2
exists"; we are locking a lightweight generic contract now because it is *less*
code than per-analyzer Rust functions, not more). Everything else in the spec
(ingest schema, session-reconstruction SQL logic, UI mocks) still stands.

## Wave Roadmap (full feature, this plan covers Wave 1 only)

Each wave ends in something the user can check themselves - mostly via the
already-shipped Explorer tab (arbitrary read-only SQL against the Trace
Store). **Do not start wave N+1 until the user has reviewed wave N's
verification and given explicit go-ahead.** Findings from one wave may
change the plan for the next - re-plan rather than forcing the original
shape.

1. **Wave 1 - Ingest** (this document). `messages.src_ip`/`src_port` +
   `protocol_tcp` table populated. This layer is already generic: it extends
   the existing 4-protocol peel pattern (`protocol_pdu`/`someip`/`someip_sd`/
   `doip`), adding `protocol_tcp` and a `ProtocolType::Tcp` variant, nothing
   TCP-shaped leaks upward. `src_ip`/`src_port` is a network-spine fix that
   helps every IP protocol, not just TCP. Verify: Explorer query against the
   rebuilt fixture store, by hand against a real TCP-bearing trace.
2. **Wave 2 - Analyzer SQL to the fixed contract**.
   `schema/rules/analyzers/tcp_connection_health.sql` exposing the three
   **fixed-name public views** `findings` / `sessions` / `segments` (see
   contract below); protocol-specific intermediate views (`_segments` ->
   `_stream_segments` -> `_sessions`) stay internal to the file. Seeded
   `crates/query` tests per finding type + the stream-reuse case. Verify:
   paste the file's view chain (as `WITH ... SELECT`, since Explorer runs one
   `SELECT`) into Explorer against a trace with known handshake-fail/reset/
   idle patterns; eyeball `findings`/`sessions`/`segments` rows.
3. **Wave 3 - Generic Rust registry + Tauri commands** (written ONCE, zero
   TCP knowledge). `ANALYZERS: &[(name, sql)]` registry, generic `Finding` /
   `Session` / `Segment` structs, generic `list_findings` / `list_sessions` /
   `list_segments` functions + Tauri commands, all parameterized by
   `analyzer_name`. Verify: `cargo test` (seeded store) + manual `invoke()`
   from the Tauri dev console with `analyzer_name: "tcp_connection_health"`.
4. **Wave 4 - Topology UI** (mock image 1). New "Protocol Analyzer" workspace
   tab with an analyzer picker (populated from a `list_analyzers` command);
   topology table over `sessions` + client-side error/warning counts joined
   from `findings`. Verify: visually in the running app.
5. **Wave 5 - Violation Explorer UI** (mock image 2). `destructive`/`warning`
   badge variants, severity filter, drill-down from topology. Reads the
   generic `findings` rows; the "Plugin Analyzer" chip in the mock is the
   active `analyzer_name`. Verify: visually.
6. **Wave 6 - Timeline + evidence detail** (mock image 3). "Follow TCP
   Stream" keyed by `stream_index` over `segments`; `info` flag-string comes
   from SQL (UI renders it verbatim, stays protocol-agnostic); idle-gap
   divider row driven by `segments.idle_us`; `MessageDetails`
   Ethernet/IP/TCP grouping joins `protocol_tcp` by `msg_id` (the existing
   per-protocol detail path, not the generic contract). Verify: visually.

Only the generic contract (the row shapes + view names + registry + command
signatures in "Analyzer Framework Contract" below) is locked now. Waves 2-6
are sketched at goal level; each gets its own detailed task-by-task plan once
the prior wave is green-lit, since results may reshape the internals (never
the contract - a contract change is itself a re-plan trigger).

## Analyzer Framework Contract (locked 2026-11-27)

This is the generic foundation. It is protocol-agnostic: a CAN, SOME/IP, or
DoIP analyzer later reuses all of it. **It supersedes the spec's
execution-model section.** Three pieces: a fixed SQL view contract, generic
Rust structs + registry, generic Tauri commands.

### SQL contract: every analyzer file exposes three fixed-name views

Each `schema/rules/analyzers/<name>.sql` file creates exactly three public
views with these **fixed names and columns**. Protocol-specific intermediate
views are prefixed `_` and are never read outside the file.

```
findings(analyzer_name, src_node, dst_node, stream_index,
         severity, rule, summary,
         start_us, end_us, first_msg_id, last_msg_id)

sessions(analyzer_name, src_node, dst_node, stream_index,
         packet_count, start_us, end_us, first_msg_id, last_msg_id)

segments(analyzer_name, stream_index, msg_id, timestamp_us,
         src_node, dst_node, info, segment_len, idle_us)
```

- `src_node` / `dst_node` are **opaque VARCHAR identity strings** (TCP emits
  `ip || ':' || port`; a CAN analyzer would emit `'CAN 0x1A0'`; a SOME/IP one
  `'svc 0x1234'`). This is the key genericity decision - the spec's four
  typed `src_ip/src_port/dst_ip/dst_port` columns are replaced by two opaque
  strings, because the UI mocks only ever show a string label and a non-IP
  protocol has no ports. ARXML friendly names remain a UI display overlay on
  the node string, never a dependency of the SQL.
- `severity` is `'Error'` | `'Warning'`. `rule` is the machine name
  (`HANDSHAKE_NO_SYNACK`, `UNEXPECTED_RST_AFTER_SILENCE`, ...); `summary` is
  the human line. Both appear in mock image 2's RULE/FINDING column.
- `info` (segments) is the Wireshark-style flag string (`[SYN]`, `[SYN, ACK]`,
  `[RST]`) generated **in SQL**, so the UI renders it verbatim and stays
  protocol-agnostic. `idle_us` drives the timeline's idle-gap divider row.
- `stream_index` is the join key from a finding/session to its ordered
  `segments` (the "Follow TCP Stream" drill-down).
- Topology error/warning counts (mock image 1) are a **client-side** join of
  `findings` onto `sessions` by `stream_index` - not a view column.
- Per-protocol raw evidence (hex bytes, decoded header fields, mock image 3's
  right panel) is fetched by the existing `MessageDetails` widget joining
  `protocol_tcp` by `msg_id` - that is the per-protocol detail path and is
  deliberately **outside** this generic contract.

### Rust contract (`crates/query`, written once in Wave 3)

```rust
pub struct Finding {
    pub analyzer_name: String,
    pub src_node: String, pub dst_node: String,
    pub stream_index: i64,
    pub severity: String, pub rule: String, pub summary: String,
    pub start_us: i64, pub end_us: i64,
    pub first_msg_id: i64, pub last_msg_id: i64,
}
pub struct Session {
    pub analyzer_name: String,
    pub src_node: String, pub dst_node: String,
    pub stream_index: i64, pub packet_count: i64,
    pub start_us: i64, pub end_us: i64,
    pub first_msg_id: i64, pub last_msg_id: i64,
}
pub struct Segment {
    pub analyzer_name: String,
    pub stream_index: i64, pub msg_id: i64, pub timestamp_us: i64,
    pub src_node: String, pub dst_node: String,
    pub info: String, pub segment_len: i64, pub idle_us: i64,
}

// Adding analyzer #2 = one more entry here + one SQL file. Nothing else.
const ANALYZERS: &[(&str, &str)] = &[
    ("tcp_connection_health",
     include_str!("../../../schema/rules/analyzers/tcp_connection_health.sql")),
];

// All three: create the file's views on the (read-only) conn in-session, then
// SELECT the fixed public view, scoped by time the same way
// `detector_scoped_sql` already scopes `run_detector_query`.
pub fn list_findings(conn, analyzer_name, start_us, end_us) -> Result<Vec<Finding>, String>;
pub fn list_sessions(conn, analyzer_name, start_us, end_us) -> Result<Vec<Session>, String>;
pub fn list_segments(conn, analyzer_name, stream_index)     -> Result<Vec<Segment>, String>;
pub fn list_analyzers() -> Vec<&'static str>; // names from ANALYZERS, backs the UI picker
```

Read-only connections can't persist views, so each call runs the analyzer SQL
to (re)create its views in-session before the `SELECT` - the same constraint
`run_detector_query` already lives with. Acceptable for MVP; revisit only if
profiling shows the view-creation per call matters.

### Tauri contract (`app/src-tauri`, written once in Wave 3)

```rust
#[tauri::command] fn list_analyzers() -> Vec<String>
#[tauri::command] fn list_findings(blf_path, analyzer_name, respect_trim, start_us, end_us) -> Vec<Finding>
#[tauri::command] fn list_sessions(blf_path, analyzer_name, respect_trim, start_us, end_us) -> Vec<Session>
#[tauri::command] fn list_segments(blf_path, analyzer_name, stream_index) -> Vec<Segment>
```

Same `trace_store::open` + `respect_trim`/scope pattern as `run_detector_query`
(`app/src-tauri/src/main.rs`). Findings are ephemeral - cached in the UI
workspace store until the next run, never written back to `.duckdb` (spec's
"Findings are ephemeral" decision, unchanged).

### What adding a second protocol analyzer costs

- One file `schema/rules/analyzers/<name>.sql` exposing `findings`/`sessions`/
  `segments`.
- One line in `ANALYZERS`.
- Zero Rust, zero Tauri, zero UI (it appears in the picker automatically).

## Global Constraints

- `schema_version` bumps 5 -> 6; update `schema/schema.sql`'s header comment
  (the C++ embed derives its version from that comment via CMake regex - no
  separate C++ edit needed) and `crates/trace-store/src/lib.rs`'s
  `EXPECTED_SCHEMA_VERSION` in the same change (AGENTS.md, docs/adr/0001 rule 1).
- `protocol_tcp` has exactly `msg_id`, `flags`, `segment_len` - no
  `seq_num`/`ack_num`/`window_size` (reliability tier, deferred, its own
  future `schema_version` bump).
- No extra I/O pass: TCP header parsing reuses the same mapped Ethernet
  frame buffer `extractUdpInfo` (renamed `extractTransportInfo`) already
  reads for UDP.
- `crates/query` and `crates/sidecar` get zero TCP logic in this wave - it's
  ingest-only. Detection SQL is Wave 2's job (ADR 0003).
- `clang-format -i` every modified `.cpp`/`.h`; `cargo fmt` every modified
  `.rs`.
- Update `native/protocol/CMakeLists.txt` and `native/store/CMakeLists.txt`
  for new source/test files (AGENTS.md "Always" rules).
- `native/protocol` currently has no test entry point or README - AGENTS.md
  requires one per module; this wave is where it's added, since this wave is
  the first to add real behavior to `ProtocolParser`.

## Review Focus

- **Pure control segments (SYN, SYN-ACK, FIN, RST with zero payload bytes)
  must still produce a `protocol_tcp` row.** `ProtocolParser::parse()`
  currently early-returns on `tm.data.empty()` before any protocol is
  checked; TCP flag detection must be hoisted above that guard, or every
  handshake/reset/close segment - the exact events Connection Health exists
  to see - gets silently dropped. Covered in Task 3.
- **IPv6 TCP/UDP frames never had `srcIp` wired, only `dstIp`.** Adding
  `src_ip` only on the IPv4 branch would leave it silently NULL for an
  entire address family. Covered in Task 2.
- **A TCP header with a malformed `dataOffset` (< 5, i.e. header < 20
  bytes) must not underflow the payload length or read out of bounds** -
  clamp the header length and bounds-check before slicing. Covered in Task 2.
- **VLAN-tagged (0x8100/0x88A8) TCP frames must still resolve** - the
  existing etherType-unwrap runs before the new TCP branch, same as it
  already does for UDP; Task 2's assertions reuse that same code path so no
  separate test is needed, but don't special-case TCP detection before the
  unwrap.
- **Known side effect, not a bug to fix here:** `ProtocolParser.cpp`'s
  existing `tm.dstPort == 13400` DoIP-over-TCP stream-reassembly branch
  (lines 30-61) has been dead code until now, because `dstPort` was never
  set for real TCP frames. Once Task 2 starts setting `dstPort` for TCP,
  that branch becomes live for the first time on any trace with TCP traffic
  to port 13400. It is untouched and untested by this plan - flag it to the
  user after Wave 1 lands; it may need its own test or a guard in a later
  wave.

---

## File Structure (Wave 1)

- Modify `schema/schema.sql` - add `src_ip`/`src_port` to `messages`, add
  `protocol_tcp` table, bump version comment.
- Modify `crates/trace-store/src/lib.rs` - bump `EXPECTED_SCHEMA_VERSION`,
  update its own tests' seeded version strings.
- Modify `native/blf/include/TraceMessage.h` - add `srcIp`/`srcPort`/`isTcp`/`tcpFlags`.
- Modify `native/blf/src/BlfIngestReader.cpp` - rename/extend
  `extractUdpInfo` -> `extractTransportInfo` to also parse TCP (IPv4 + IPv6),
  and to fill `srcIp`/`srcPort` for both UDP and TCP.
- Modify `native/blf/include/ProtocolMessage.h` - add `ProtocolType::Tcp` +
  `TcpSegmentInfo`.
- Modify `native/protocol/src/ProtocolParser.cpp` - emit a `Tcp`
  `ProtocolMessage` for every TCP segment, before the empty-payload guard.
- Create `native/protocol/test/protocol_parser_test.cpp` + modify
  `native/protocol/CMakeLists.txt` + create `native/protocol/README.md`.
- Modify `native/store/include/Store.h` + `native/store/src/ProtocolAppend.cpp` -
  `appendProto` grows a `tcp` Appender param and a `Tcp` case.
- Modify `native/cli/src/main.cpp` - add `protocol_tcp` Appender, pass
  `src_ip`/`src_port` into the `messages` row, pass `tcp` Appender through.
- Modify `native/store/test/fixtures/generate_fixture.cpp` - add two TCP
  Ethernet frames (a pure-SYN control segment, a PSH+ACK data segment).
- Modify `native/store/test/fixture_prepare_check.cpp` - update row-count
  expectations, add a `protocol_tcp` count + a flags/segment_len value check.
- Modify `native/store/README.md` - document the two new fixture frames.
- Modify `crates/query/tests/fixture_summary_test.rs` - update the hardcoded
  Ethernet count and add a `protocol_tcp` count to the asserted tuple.

## Task 1: Schema bump

**Files:**
- Modify: `schema/schema.sql`
- Modify: `crates/trace-store/src/lib.rs:8` (`EXPECTED_SCHEMA_VERSION`),
  `crates/trace-store/src/lib.rs:51,59` (test seed versions)

**Interfaces:**
- Produces: `messages.src_ip VARCHAR`, `messages.src_port INTEGER` (new
  columns, inserted between `dlc` and `dst_ip`); `protocol_tcp(msg_id BIGINT,
  flags INTEGER, segment_len INTEGER)` table. Every later task's `messages`
  Appender calls and `protocol_tcp` Appender calls must match this exact
  column order.

- [ ] **Step 1: Edit schema.sql**

```sql
-- schema_version: 6
...
CREATE TABLE messages (
  msg_id       BIGINT PRIMARY KEY,
  timestamp_us BIGINT,
  object_type  INTEGER,
  channel      INTEGER,
  arb_id       INTEGER,
  extended_id  BOOLEAN,
  dlc          INTEGER,
  src_ip       VARCHAR,
  src_port     INTEGER,
  dst_ip       VARCHAR,
  dst_port     INTEGER,
  payload_len  INTEGER
);
```

Add, right after `protocol_doip`:

```sql
CREATE TABLE protocol_tcp (
  msg_id      BIGINT,   -- join key to messages
  flags       INTEGER,  -- raw TCP flags byte: FIN=0x01 SYN=0x02 RST=0x04 PSH=0x08 ACK=0x10 URG=0x20
  segment_len INTEGER   -- TCP payload length; 0 for pure control segments
);
```

- [ ] **Step 2: Bump the Rust version check**

`crates/trace-store/src/lib.rs:8`:
```rust
const EXPECTED_SCHEMA_VERSION: &str = "6";
```

And its two `write_store_with_version(&dir, "5")` calls in the `#[cfg(test)]`
block (lines 51 and 59 today) both become `"6"` - they assert "matches
`EXPECTED_SCHEMA_VERSION`", so they must track the bump.

- [ ] **Step 3: Run the existing trace-store tests**

Run: `cargo test --manifest-path crates/Cargo.toml -p trace-store`
Expected: PASS (three tests: version matches / mismatches / file missing).

- [ ] **Step 4: Commit**

```bash
git add schema/schema.sql crates/trace-store/src/lib.rs
git commit -m "feat(schema): bump schema_version to 6, add messages src_ip/src_port and protocol_tcp"
```

## Task 2: TCP peel in native/blf

**Files:**
- Modify: `native/blf/include/TraceMessage.h`
- Modify: `native/blf/src/BlfIngestReader.cpp`

**Interfaces:**
- Consumes: `TCPHeader` (`native/blf/include/NetTypes.h:41`, already defined,
  unused until now), `IPv4Header::protocol`/`IPv6Header::nextHeader == 6`.
- Produces: `TraceMessage::srcIp` (`std::string`), `srcPort` (`uint16_t`),
  `isTcp` (`bool`), `tcpFlags` (`uint8_t`) - Task 3 reads these.
  `TraceMessage::data` for a TCP message becomes the TCP *payload only* (post
  header), matching how `dstIp`/`dstPort`/`data` already work for UDP.

- [ ] **Step 1: Add fields to TraceMessage**

`native/blf/include/TraceMessage.h`, after the existing `dstPort` field:

```cpp
    std::string dstIp; // destination IP address string
    uint16_t dstPort = 0; // destination port
    std::string srcIp; // source IP address string
    uint16_t srcPort = 0; // source port
    bool isTcp = false; // true when this Ethernet frame carried a TCP segment
    uint8_t tcpFlags = 0; // raw TCP flags byte (FIN|SYN|RST|PSH|ACK|URG), valid iff isTcp
```

- [ ] **Step 2: Rename and extend `extractUdpInfo` to `extractTransportInfo`**

Replace the whole function (`native/blf/src/BlfIngestReader.cpp:45-121`) with
a version that fills source IP/port for both protocols, and adds a TCP
branch next to each existing UDP branch:

```cpp
bool extractTransportInfo(const char* frame, size_t frameLen, std::string& srcIpOut, uint16_t& srcPortOut,
    std::string& dstIpOut, uint16_t& dstPortOut, bool& isTcpOut, uint8_t& tcpFlagsOut, const char*& payloadOut,
    size_t& payloadLenOut)
{
    isTcpOut = false;
    if (frameLen < sizeof(EthernetWireHeader)) {
        return false;
    }
    const auto* eth = reinterpret_cast<const EthernetWireHeader*>(frame);
    size_t offset = sizeof(EthernetWireHeader);
    uint16_t etherType = beToHost16(eth->etherType);
    if ((etherType == 0x8100u || etherType == 0x88A8u) && frameLen >= offset + 4) {
        uint16_t inner;
        std::memcpy(&inner, frame + offset + 2, 2);
        etherType = beToHost16(inner);
        offset += 4;
    }
    if (etherType == 0x0800u) {
        if (frameLen < offset + sizeof(IPv4Header)) {
            return false;
        }
        const auto* ip = reinterpret_cast<const IPv4Header*>(frame + offset);
        const size_t ihlBytes = static_cast<size_t>(ip->versionIHL & 0x0Fu) * 4u;
        if (ihlBytes < 20u || frameLen < offset + ihlBytes) {
            return false;
        }
        offset += ihlBytes;
        srcIpOut = std::format("{}.{}.{}.{}", ip->srcIP[0], ip->srcIP[1], ip->srcIP[2], ip->srcIP[3]);
        dstIpOut = std::format("{}.{}.{}.{}", ip->dstIP[0], ip->dstIP[1], ip->dstIP[2], ip->dstIP[3]);
        if (ip->protocol == 17u && frameLen >= offset + sizeof(UDPHeader)) {
            const auto* udp = reinterpret_cast<const UDPHeader*>(frame + offset);
            srcPortOut = beToHost16(udp->srcPort);
            dstPortOut = beToHost16(udp->dstPort);
            payloadOut = frame + offset + sizeof(UDPHeader);
            uint16_t udpLen = beToHost16(udp->length);
            payloadLenOut = udpLen > 8u ? udpLen - 8u : 0u;
            if (payloadLenOut > frameLen - offset - sizeof(UDPHeader)) {
                payloadLenOut = frameLen - offset - sizeof(UDPHeader);
            }
            return true;
        }
        if (ip->protocol == 6u && frameLen >= offset + sizeof(TCPHeader)) {
            const auto* tcp = reinterpret_cast<const TCPHeader*>(frame + offset);
            size_t tcpHdrLen = static_cast<size_t>((tcp->dataOffset >> 4u) & 0x0Fu) * 4u;
            if (tcpHdrLen < sizeof(TCPHeader)) {
                tcpHdrLen = sizeof(TCPHeader);
            }
            if (frameLen < offset + tcpHdrLen) {
                return false;
            }
            srcPortOut = beToHost16(tcp->srcPort);
            dstPortOut = beToHost16(tcp->dstPort);
            isTcpOut = true;
            tcpFlagsOut = tcp->flags;
            payloadOut = frame + offset + tcpHdrLen;
            payloadLenOut = frameLen - offset - tcpHdrLen;
            return true;
        }
    } else if (etherType == 0x86DDu) {
        if (frameLen < offset + sizeof(IPv6Header)) {
            return false;
        }
        const auto* ip6 = reinterpret_cast<const IPv6Header*>(frame + offset);
        srcIpOut = fmtIPv6(ip6->srcAddr);
        dstIpOut = fmtIPv6(ip6->dstAddr);
        offset += sizeof(IPv6Header);
        uint8_t nextHdr = ip6->nextHeader;
        while (nextHdr == 0u || nextHdr == 43u || nextHdr == 60u) {
            if (frameLen < offset + 2) {
                return false;
            }
            const uint8_t extLen = static_cast<uint8_t>(frame[offset + 1]);
            nextHdr = static_cast<uint8_t>(frame[offset]);
            offset += static_cast<size_t>(extLen + 1) * 8u;
            if (frameLen < offset) {
                return false;
            }
        }
        if (nextHdr == 44u) {
            if (frameLen < offset + 8) {
                return false;
            }
            nextHdr = static_cast<uint8_t>(frame[offset]);
            offset += 8u;
        }
        if (nextHdr == 17u && frameLen >= offset + sizeof(UDPHeader)) {
            const auto* udp = reinterpret_cast<const UDPHeader*>(frame + offset);
            srcPortOut = beToHost16(udp->srcPort);
            dstPortOut = beToHost16(udp->dstPort);
            payloadOut = frame + offset + sizeof(UDPHeader);
            uint16_t udpLen = beToHost16(udp->length);
            payloadLenOut = udpLen > 8u ? udpLen - 8u : 0u;
            if (payloadLenOut > frameLen - offset - sizeof(UDPHeader)) {
                payloadLenOut = frameLen - offset - sizeof(UDPHeader);
            }
            return true;
        }
        if (nextHdr == 6u && frameLen >= offset + sizeof(TCPHeader)) {
            const auto* tcp = reinterpret_cast<const TCPHeader*>(frame + offset);
            size_t tcpHdrLen = static_cast<size_t>((tcp->dataOffset >> 4u) & 0x0Fu) * 4u;
            if (tcpHdrLen < sizeof(TCPHeader)) {
                tcpHdrLen = sizeof(TCPHeader);
            }
            if (frameLen < offset + tcpHdrLen) {
                return false;
            }
            srcPortOut = beToHost16(tcp->srcPort);
            dstPortOut = beToHost16(tcp->dstPort);
            isTcpOut = true;
            tcpFlagsOut = tcp->flags;
            payloadOut = frame + offset + tcpHdrLen;
            payloadLenOut = frameLen - offset - tcpHdrLen;
            return true;
        }
    }
    return false;
}
```

(`fmtIPv6` already exists above this function and is unchanged.)

- [ ] **Step 3: Update both call sites**

`native/blf/src/BlfIngestReader.cpp`'s `ETHERNET_FRAME_EX` and
`ETHERNET_FRAME_FORWARDED` cases (currently ~lines 292-303 and ~379-390) both
change from:

```cpp
            std::string dstIp;
            uint16_t dstPort = 0;
            const char* udpPayload = nullptr;
            size_t udpPayloadLen = 0;
            if (extractUdpInfo(frameData, frameLen, dstIp, dstPort, udpPayload, udpPayloadLen)) {
                tm.dstIp = std::move(dstIp);
                tm.dstPort = dstPort;
                tm.data.assign(udpPayload, udpPayload + udpPayloadLen);
                fillEthernetPdus(tm, udpPayload, udpPayloadLen);
            } else {
                tm.data.assign(frameData, frameData + frameLen);
            }
```

to:

```cpp
            std::string srcIp, dstIp;
            uint16_t srcPort = 0, dstPort = 0;
            bool isTcp = false;
            uint8_t tcpFlags = 0;
            const char* payload = nullptr;
            size_t payloadLen = 0;
            if (extractTransportInfo(
                    frameData, frameLen, srcIp, srcPort, dstIp, dstPort, isTcp, tcpFlags, payload, payloadLen)) {
                tm.srcIp = std::move(srcIp);
                tm.srcPort = srcPort;
                tm.dstIp = std::move(dstIp);
                tm.dstPort = dstPort;
                tm.isTcp = isTcp;
                tm.tcpFlags = tcpFlags;
                tm.data.assign(payload, payload + payloadLen);
                if (!isTcp) {
                    fillEthernetPdus(tm, payload, payloadLen);
                }
            } else {
                tm.data.assign(frameData, frameData + frameLen);
            }
```

- [ ] **Step 4: Format**

Run: `clang-format -i native/blf/include/TraceMessage.h native/blf/src/BlfIngestReader.cpp`

- [ ] **Step 5: Build (no behavior test yet - Task 5 wires an end-to-end
  assertion through the fixture; this step just confirms it compiles)**

Run: `cmake --build build --target fastrace_blf`
Expected: builds clean.

- [ ] **Step 6: Commit**

```bash
git add native/blf/include/TraceMessage.h native/blf/src/BlfIngestReader.cpp
git commit -m "feat(blf): peel TCP header fields and bidirectional IP/port into TraceMessage"
```

## Task 3: `ProtocolType::Tcp` + ProtocolParser emission + new ctest target

**Files:**
- Modify: `native/blf/include/ProtocolMessage.h`
- Modify: `native/protocol/src/ProtocolParser.cpp`
- Create: `native/protocol/test/protocol_parser_test.cpp`
- Modify: `native/protocol/CMakeLists.txt`
- Create: `native/protocol/README.md`

**Interfaces:**
- Consumes: `TraceMessage::isTcp`/`tcpFlags`/`data` (Task 2).
- Produces: `ProtocolMessage{type: Tcp, data.tcp: {flags, length}}` - Task 4
  reads `pm.data.tcp.flags`/`pm.data.tcp.length`.

- [ ] **Step 1: Add the type**

`native/blf/include/ProtocolMessage.h`:

```cpp
enum class ProtocolType { SomeIp, SomeIpSd, DoIp, Pdu, Tcp };

struct TcpSegmentInfo {
    uint32_t flags;
    uint32_t length;
};
```

Add `TcpSegmentInfo tcp;` to the `union Data`.

- [ ] **Step 2: Write the failing test**

`native/protocol/test/protocol_parser_test.cpp`:

```cpp
#include "ProtocolParser.h"
#include <cstdio>

namespace {
int gFailures = 0;
void expect(bool cond, const char* msg)
{
    if (!cond) {
        std::fprintf(stderr, "FAIL: %s\n", msg);
        ++gFailures;
    }
}
}

int main()
{
    ProtocolParser parser;

    // A pure-SYN control segment: zero payload bytes. Must still emit a Tcp
    // ProtocolMessage - this is the handshake-open event Connection Health
    // exists to see, and the pre-existing empty-payload early return must
    // not swallow it.
    {
        fastrace::TraceMessage tm;
        tm.isTcp = true;
        tm.tcpFlags = 0x02; // SYN
        tm.data.clear();
        auto out = parser.parse(tm, 0);
        expect(out.size() == 1, "pure SYN emits exactly one ProtocolMessage");
        if (out.size() == 1) {
            expect(out[0].type == ProtocolType::Tcp, "pure SYN message type is Tcp");
            expect(out[0].data.tcp.flags == 0x02, "pure SYN flags round-trip");
            expect(out[0].data.tcp.length == 0, "pure SYN segment_len is 0");
        }
    }

    // A PSH+ACK data segment: non-empty payload.
    {
        fastrace::TraceMessage tm;
        tm.isTcp = true;
        tm.tcpFlags = 0x18; // PSH|ACK
        tm.data = { 0xAA, 0xBB, 0xCC };
        auto out = parser.parse(tm, 1);
        expect(out.size() == 1, "PSH+ACK emits exactly one ProtocolMessage");
        if (out.size() == 1) {
            expect(out[0].data.tcp.flags == 0x18, "PSH+ACK flags round-trip");
            expect(out[0].data.tcp.length == 3, "PSH+ACK segment_len matches payload size");
        }
    }

    // Non-TCP messages (isTcp=false) must be unaffected - existing SOME/IP
    // detection still runs.
    {
        fastrace::TraceMessage tm;
        tm.isTcp = false;
        tm.data.assign(16, 0);
        tm.data[0] = 0x12;
        tm.data[1] = 0x34; // serviceId
        auto out = parser.parse(tm, 2);
        expect(out.size() == 1, "non-TCP message still produces its existing peel");
        if (out.size() == 1) {
            expect(out[0].type == ProtocolType::SomeIp, "non-TCP path untouched by Tcp branch");
        }
    }

    if (gFailures > 0) {
        std::fprintf(stderr, "%d assertion(s) failed\n", gFailures);
        return 1;
    }
    std::printf("protocol_parser_test: OK\n");
    return 0;
}
```

- [ ] **Step 3: Run it to confirm it fails to build/link (Tcp doesn't exist yet in parser output)**

Run: `cmake --build build --target fastrace_protocol_test` (target added in
Step 5 below - if building before Step 5, this step is "doesn't exist yet",
which is the expected red state).

- [ ] **Step 4: Implement the emission**

`native/protocol/src/ProtocolParser.cpp`, inside `parse()`, immediately
after `if (tm.data.empty()) { return results; }` is currently the first
check (`ProtocolParser.cpp:26-28`) - replace that guard's position: the Tcp
check must run first, unconditionally of payload emptiness:

```cpp
std::vector<ProtocolMessage> ProtocolParser::parse(const fastrace::TraceMessage& tm, size_t globalMsgIndex)
{
    std::vector<ProtocolMessage> results;

    if (tm.isTcp) {
        ProtocolMessage msg;
        msg.timestampUs = tm.timestampUs;
        msg.sourceIndices.push_back(globalMsgIndex);
        msg.type = ProtocolType::Tcp;
        msg.data.tcp.flags = tm.tcpFlags;
        msg.data.tcp.length = static_cast<uint32_t>(tm.data.size());
        results.push_back(msg);
    }

    if (tm.data.empty()) {
        return results;
    }

    if (tm.dstPort == 13400 || (tm.data.size() >= 8 && tm.data[0] == 0x02 && tm.data[1] == 0xFD)) {
        // ... existing DoIP-over-TCP body, unchanged ...
```

(Keep everything below unchanged - the existing `if`/`else if` chain and the
PDU loop at the bottom still run exactly as before, on the same `tm`.)

- [ ] **Step 5: Wire the new ctest target**

`native/protocol/CMakeLists.txt`, append:

```cmake
enable_testing()

add_executable(fastrace_protocol_test test/protocol_parser_test.cpp)
target_link_libraries(fastrace_protocol_test PRIVATE fastrace_protocol)
add_test(NAME fastrace_protocol_test COMMAND fastrace_protocol_test)
```

- [ ] **Step 6: Run the test and confirm it passes**

Run: `cmake --build build --target fastrace_protocol_test && ctest --test-dir build -R fastrace_protocol_test --output-on-failure`
Expected: `protocol_parser_test: OK`, exit 0.

- [ ] **Step 7: Add the module README**

`native/protocol/README.md`:

```markdown
# native/protocol

Protocol peel: PDU, SOME/IP, SOME/IP-SD, DoIP, TCP. Pure byte-in,
`ProtocolMessage`-out - no file I/O, no database knowledge (docs/adr/0001).

## Build + test

    cmake -S . -B build && cmake --build build --target fastrace_protocol_test
    ctest --test-dir build -R fastrace_protocol_test --output-on-failure

No fixture file needed - `protocol_parser_test.cpp` constructs `TraceMessage`
values directly.
```

- [ ] **Step 8: Format + commit**

```bash
clang-format -i native/blf/include/ProtocolMessage.h native/protocol/src/ProtocolParser.cpp native/protocol/test/protocol_parser_test.cpp
git add native/blf/include/ProtocolMessage.h native/protocol/src/ProtocolParser.cpp native/protocol/test/protocol_parser_test.cpp native/protocol/CMakeLists.txt native/protocol/README.md
git commit -m "feat(protocol): emit Tcp ProtocolMessage for every TCP segment, add protocol ctest target"
```

## Task 4: Append `protocol_tcp` + `messages.src_ip`/`src_port` (native/store, native/cli)

**Files:**
- Modify: `native/store/include/Store.h`
- Modify: `native/store/src/ProtocolAppend.cpp`
- Modify: `native/cli/src/main.cpp`

**Interfaces:**
- Consumes: `ProtocolMessage{type: Tcp, data.tcp}` (Task 3),
  `TraceMessage::srcIp`/`srcPort` (Task 2).
- Produces: a `protocol_tcp` row per TCP segment, `messages.src_ip`/`src_port`
  populated for every message.

- [ ] **Step 1: Grow `appendProto`'s signature**

`native/store/include/Store.h`:

```cpp
bool appendProto(const ProtocolMessage& pm, Appender& pdu, Appender& someip, Appender& sd, Appender& doip,
    Appender& tcp);
```

- [ ] **Step 2: Add the `Tcp` case**

`native/store/src/ProtocolAppend.cpp`:

```cpp
bool appendProto(const ProtocolMessage& pm, Appender& pdu, Appender& someip, Appender& sd, Appender& doip,
    Appender& tcp)
{
    const int64_t msgId = pm.sourceIndices.empty() ? -1 : static_cast<int64_t>(pm.sourceIndices.front());
    switch (pm.type) {
    // ... existing Pdu/SomeIp/SomeIpSd/DoIp cases, unchanged ...
    case ProtocolType::Tcp:
        tcp.i64(msgId);
        tcp.i32(static_cast<int32_t>(pm.data.tcp.flags));
        tcp.i32(static_cast<int32_t>(pm.data.tcp.length));
        return tcp.endRow();
    }
    return true;
}
```

- [ ] **Step 3: Wire it into `runPrepare`**

`native/cli/src/main.cpp`:

`appendProtocolRows` (line ~60) grows a `tcp` param:

```cpp
bool appendProtocolRows(const std::vector<ProtocolMessage>& protos, fastrace::Appender& pdu,
    fastrace::Appender& someip, fastrace::Appender& sd, fastrace::Appender& doip, fastrace::Appender& tcp)
{
    for (const auto& pm : protos) {
        if (!fastrace::appendProto(pm, pdu, someip, sd, doip, tcp)) {
            return false;
        }
    }
    return true;
}
```

In `runPrepare` (line ~534), add the appender and validity check:

```cpp
        fastrace::Appender msgApp(db.con(), "messages");
        fastrace::Appender pduApp(db.con(), "protocol_pdu");
        fastrace::Appender someipApp(db.con(), "protocol_someip");
        fastrace::Appender sdApp(db.con(), "protocol_someip_sd");
        fastrace::Appender doipApp(db.con(), "protocol_doip");
        fastrace::Appender tcpApp(db.con(), "protocol_tcp");
        fastrace::Appender ciApp(db.con(), "container_index");
        failed = !msgApp.valid() || !pduApp.valid() || !someipApp.valid() || !sdApp.valid() || !doipApp.valid()
            || !tcpApp.valid() || !ciApp.valid();
```

Update the `messages` row write (line ~570-579) to insert `src_ip`/`src_port`
in the same order as the Task 1 schema change, and pass `tcpApp` through:

```cpp
            msgApp.i64(static_cast<int64_t>(msgId));
            msgApp.i64(static_cast<int64_t>(msg.timestampUs));
            msgApp.i32(static_cast<int32_t>(msg.objectType));
            msgApp.i32(static_cast<int32_t>(msg.channel));
            msgApp.i32(static_cast<int32_t>(msg.arbId));
            msgApp.b(msg.extendedId);
            msgApp.i32(static_cast<int32_t>(msg.dlc));
            msgApp.str(msg.srcIp);
            msgApp.i32(msg.srcPort);
            msgApp.str(msg.dstIp);
            msgApp.i32(msg.dstPort);
            msgApp.i32(static_cast<int32_t>(msg.data.size()));
            if (!msgApp.endRow() || !appendProtocolRows(protos, pduApp, someipApp, sdApp, doipApp, tcpApp)) {
                failed = true;
                return;
            }
```

- [ ] **Step 4: Build**

Run: `cmake --build build --target fastrace_parse`
Expected: builds clean (Task 5 adds the row-count assertions that prove
correctness).

- [ ] **Step 5: Format + commit**

```bash
clang-format -i native/store/include/Store.h native/store/src/ProtocolAppend.cpp native/cli/src/main.cpp
git add native/store/include/Store.h native/store/src/ProtocolAppend.cpp native/cli/src/main.cpp
git commit -m "feat(store): append protocol_tcp rows and messages src_ip/src_port"
```

## Task 5: Extend the shared fixture + update dependent assertions

**Files:**
- Modify: `native/store/test/fixtures/generate_fixture.cpp`
- Modify: `native/store/test/fixture_prepare_check.cpp`
- Modify: `native/store/README.md`
- Modify: `crates/query/tests/fixture_summary_test.rs`

**Interfaces:**
- Consumes: everything from Tasks 1-4.
- Produces: the committed `fixture.blf` now contains 2 CAN + 6 Ethernet
  frames (was 2 + 4); `messages` row count 8 (was 6); `protocol_tcp` row
  count 2 (new).

- [ ] **Step 1: Add a TCP frame builder next to `appendEthernetFrame`**

`native/store/test/fixtures/generate_fixture.cpp`, after the existing
`appendEthernetFrame` function:

```cpp
// Builds one Ethernet II + IPv4 + TCP frame. Mirrors appendEthernetFrame's
// shape but with a TCP header (flags byte at the position NetTypes.h's
// TCPHeader::flags expects) instead of UDP.
void appendEthernetTcpFrame(Bytes& b, uint64_t timestampNs, uint16_t channel, uint16_t srcPort, uint16_t dstPort,
    uint8_t flags, const Bytes& tcpPayload)
{
    Bytes frame;
    bytes(frame, { 0x02, 0x00, 0x00, 0x00, 0x00, 0x01 }); // dst MAC
    bytes(frame, { 0x02, 0x00, 0x00, 0x00, 0x00, 0x02 }); // src MAC
    be16(frame, 0x0800); // etherType = IPv4

    u8(frame, 0x45); // version 4, IHL 5 (20 bytes)
    u8(frame, 0); // DSCP/ECN
    be16(frame, static_cast<uint16_t>(20 + 20 + tcpPayload.size())); // total length
    be16(frame, 0); // identification
    be16(frame, 0); // flags/fragment
    u8(frame, 64); // TTL
    u8(frame, 6); // protocol = TCP
    be16(frame, 0); // header checksum (unchecked by reader)
    bytes(frame, { 192, 168, 1, 20 }); // src IP
    bytes(frame, { 192, 168, 1, 10 }); // dst IP

    be16(frame, srcPort);
    be16(frame, dstPort);
    be32(frame, 0); // seq
    be32(frame, 0); // ack
    u8(frame, 0x50); // dataOffset = 5 (20-byte header), upper nibble
    u8(frame, flags);
    be16(frame, 0); // window
    be16(frame, 0); // checksum (unchecked by reader)
    be16(frame, 0); // urgent ptr
    frame.insert(frame.end(), tcpPayload.begin(), tcpPayload.end());

    Bytes payload;
    le16(payload, 32);
    le16(payload, 0);
    le16(payload, channel);
    le16(payload, 0);
    le64(payload, 0);
    le16(payload, 0);
    le16(payload, 0);
    le16(payload, 0);
    le64(payload, 0);
    payload.insert(payload.end(), frame.begin(), frame.end());

    innerHeader(b, kEthernetFrameEx, static_cast<uint32_t>(payload.size()), timestampNs);
    b.insert(b.end(), payload.begin(), payload.end());
}
```

- [ ] **Step 2: Add two TCP frames to `buildInnerStream`**

After the existing E4 block, before `return inner;`:

```cpp
    // E5: a pure-SYN TCP control segment (zero payload) - proves control
    // segments with no data still peel into protocol_tcp.
    appendEthernetTcpFrame(inner, 7000, 2, 51000, 30490, 0x02, {});

    // E6: a PSH+ACK TCP data segment on the same stream - proves segment_len
    // tracks actual payload size.
    appendEthernetTcpFrame(inner, 7100, 2, 51000, 30490, 0x18, { 0xDE, 0xAD, 0xBE, 0xEF });
```

- [ ] **Step 3: Update `fixture_prepare_check.cpp`'s expectations**

```cpp
    expectCount(con, "messages", 8); // 2 CAN + 6 Ethernet
    expectCount(con, "protocol_pdu", 2); // E1's packed PDU + E4's incidental PDU-walk hit
    expectCount(con, "protocol_someip", 1); // E2
    expectCount(con, "protocol_someip_sd", 1); // E3
    expectCount(con, "protocol_doip", 1); // E4
    expectCount(con, "protocol_tcp", 2); // E5 (SYN) + E6 (PSH+ACK)
```

Add a value-level check (not just a count) right after, using the same
`queryScalarInt`-style helper already used elsewhere in this file:

```cpp
    // E5 is a pure SYN: flags 0x02, segment_len 0.
    expect(queryScalarInt(con, "select flags from protocol_tcp order by msg_id limit 1") == 0x02,
        "E5 SYN flags == 0x02");
    expect(queryScalarInt(con, "select segment_len from protocol_tcp order by msg_id limit 1") == 0,
        "E5 SYN segment_len == 0");
    // E6 is PSH+ACK with a 4-byte payload: flags 0x18, segment_len 4.
    expect(queryScalarInt(con, "select flags from protocol_tcp order by msg_id desc limit 1") == 0x18,
        "E6 PSH+ACK flags == 0x18");
    expect(queryScalarInt(con, "select segment_len from protocol_tcp order by msg_id desc limit 1") == 4,
        "E6 PSH+ACK segment_len == 4");
    expect(
        queryScalarInt(con, "select count(*) from messages where src_ip is not null and src_port is not null") >= 6,
        "src_ip/src_port populated for every Ethernet message (UDP + TCP)");
```

(Match whatever the existing file's exact helper names/signatures are -
read `fixture_prepare_check.cpp` in full before editing; the names above
are illustrative of the assertions needed, not a guaranteed byte-for-byte
match to the current helper signatures.)

- [ ] **Step 4: Update `native/store/README.md`**

In the "What the fixture exercises" section, after the E4 bullet, add:

```markdown
- E5/E6 are two segments of one TCP stream (port 51000 -> 30490): a pure
  SYN control segment and a PSH+ACK data segment, chosen so `protocol_tcp`
  gets both a zero-length control row and a real-payload row.
```

- [ ] **Step 5: Update `crates/query/tests/fixture_summary_test.rs`**

```rust
    let result = (|| -> Result<(i64, i64, i64, i64, i64, i64, i64), String> {
        let conn = trace_store::open(&fixture_duckdb)?;
        Ok((
            query::count(&conn, "select count(*) from messages where object_type in (1,100,101)")?,
            query::count(&conn, "select count(*) from messages where object_type in (71,120,121)")?,
            query::count(&conn, "select count(*) from protocol_pdu")?,
            query::count(&conn, "select count(*) from protocol_someip")?,
            query::count(&conn, "select count(*) from protocol_someip_sd")?,
            query::count(&conn, "select count(*) from protocol_doip")?,
            query::count(&conn, "select count(*) from protocol_tcp")?,
        ))
    })();

    let _ = std::fs::remove_file(&fixture_duckdb);
    let _ = std::fs::remove_file(format!("{}.wal", fixture_duckdb.display()));

    let (can, eth, pdu, someip, sd, doip, tcp) = result.expect("summary queries should succeed");
    assert_eq!((can, eth, pdu, someip, sd, doip, tcp), (2, 6, 2, 1, 1, 1, 2));
```

- [ ] **Step 6: Regenerate the fixture and run everything**

Run:
```bash
cmake --build build --target generate_fixture
./build/native/store/test/fixtures/generate_fixture   # overwrites fixture.blf/.arxml in place - confirm path matches the existing smoke script
ctest --test-dir build --output-on-failure
cargo test --manifest-path crates/Cargo.toml
```
Expected: all green, including `fastrace_store_fixture_prepare_check`,
`fastrace_protocol_test`, and `summary_counts_match_fixture`.

- [ ] **Step 7: Format + commit**

```bash
clang-format -i native/store/test/fixtures/generate_fixture.cpp native/store/test/fixture_prepare_check.cpp
cargo fmt --manifest-path crates/Cargo.toml
git add native/store/test/fixtures/generate_fixture.cpp native/store/test/fixtures/fixture.blf native/store/test/fixtures/fixture.arxml native/store/test/fixture_prepare_check.cpp native/store/README.md crates/query/tests/fixture_summary_test.rs
git commit -m "test: extend fixture with a TCP stream, update dependent row-count assertions"
```

## Task 6: Manual verification via the Explorer tab (the wave gate)

**Files:** none - this task only runs the app.

- [ ] **Step 1: Prepare a real or fixture trace**

Either rebuild the fixture (`fastrace_parse prepare native/store/test/fixtures/fixture.blf native/store/test/fixtures/fixture.arxml`)
or point at any real BLF with TCP traffic.

- [ ] **Step 2: Launch the app**

Run: `cargo tauri dev --manifest-path app/src-tauri/Cargo.toml`

- [ ] **Step 3: Open the Explorer tab, run these two queries**

```sql
select msg_id, src_ip, src_port, dst_ip, dst_port, payload_len
from messages
where src_port is not null
order by msg_id
```

```sql
select * from protocol_tcp order by msg_id
```

- [ ] **Step 4: Confirm with the user**

Expected on the fixture: the first query shows rows for E1-E6 with
`src_ip`/`src_port` populated (E1-E4 at UDP src port 40000, E5/E6 at TCP src
port 51000); the second shows exactly 2 rows, `flags` 2 and 24
(0x02/0x18), `segment_len` 0 and 4.

**Do not start Wave 2 until the user has run these queries themselves and
confirmed the results look right - on the fixture and ideally on one real
trace with TCP traffic.**

- [ ] **Step 5 (optional, context for the user): preview Wave 2's `findings`
  contract early, straight from Explorer**

Wave 1's columns are all Wave 2's internal `_segments`/`_stream_segments`/
`_sessions` views need - Explorer already runs arbitrary `SELECT` SQL, so the
whole chain can be pasted in as one `WITH ... SELECT` right now, emitting the
locked **`findings` contract columns**, before the `.sql` file or any Rust
wrapper exists. This is a faithful dry-run of what Wave 2's `findings` view
returns. See "Sample SQL: detecting TCP violations" below for the query
itself, a stage-by-stage explanation, and known limitations - discussed and
corrected 2026-11-27 before being folded in here.

Not a required gate for Wave 1; Wave 1's actual pass/fail is Steps 1-4 above.

## Sample SQL: detecting TCP violations

Runs entirely on Wave 1's columns (`messages.src_ip/src_port/dst_ip/dst_port`
+ `protocol_tcp.flags`) - paste straight into Explorer. This is what Wave 2's
`findings` view will implement; nothing here depends on Wave 2 existing.
Verified 2026-11-27 against the prepared Wave 1 fixture: the fixture's
SYN -> PSH+ACK stream (no SYN-ACK) returns one `HANDSHAKE_NO_SYNACK` finding
keyed `192.168.1.20:51000 -> 192.168.1.10:30490`.

```sql
WITH seg AS (
  SELECT m.msg_id, m.timestamp_us,
    m.src_ip||':'||m.src_port AS src_node,
    m.dst_ip||':'||m.dst_port AS dst_node,
    LEAST(m.src_ip||':'||m.src_port, m.dst_ip||':'||m.dst_port) AS ka,
    GREATEST(m.src_ip||':'||m.src_port, m.dst_ip||':'||m.dst_port) AS kb,
    t.flags
  FROM messages m JOIN protocol_tcp t USING (msg_id)
),
streamed AS (
  SELECT *,
    SUM(CASE WHEN flags&2<>0 AND flags&16=0 THEN 1 ELSE 0 END)
      OVER (PARTITION BY ka, kb ORDER BY timestamp_us) AS stream_index,
    timestamp_us - LAG(timestamp_us)
      OVER (PARTITION BY ka, kb ORDER BY timestamp_us) AS idle_us
  FROM seg
),
sess AS (
  SELECT ka, kb, stream_index,
    arg_min(src_node, timestamp_us) AS src_node,
    arg_min(dst_node, timestamp_us) AS dst_node,
    min(timestamp_us) AS start_us, max(timestamp_us) AS end_us,
    min(msg_id) AS first_msg_id, max(msg_id) AS last_msg_id,
    bool_or(flags&2<>0 AND flags&16=0)  AS saw_syn,
    bool_or(flags&2<>0 AND flags&16<>0) AS saw_syn_ack,
    bool_or(flags&1<>0)                 AS saw_fin,
    bool_or(flags&4<>0)                 AS saw_rst,
    max(idle_us)                        AS max_idle_us
  FROM streamed GROUP BY ka, kb, stream_index
)
SELECT src_node, dst_node, stream_index, first_msg_id, last_msg_id, 'Error' AS severity,
       'HANDSHAKE_NO_SYNACK' AS rule, 'Connection attempt failed (no SYN-ACK)' AS summary, start_us
FROM sess WHERE saw_syn AND NOT saw_syn_ack AND NOT saw_rst
UNION ALL
SELECT src_node, dst_node, stream_index, first_msg_id, last_msg_id, 'Warning', 'CONNECTION_REFUSED',
       'Connection refused (RST)', start_us
FROM sess WHERE saw_syn AND NOT saw_syn_ack AND saw_rst
UNION ALL
SELECT src_node, dst_node, stream_index, first_msg_id, last_msg_id, 'Warning', 'CONNECTION_RESET',
       'Connection reset (RST)', start_us
FROM sess WHERE saw_syn_ack AND saw_rst
UNION ALL
SELECT src_node, dst_node, stream_index, first_msg_id, last_msg_id, 'Warning', 'NEVER_CLOSED',
       'Connection not closed (no FIN/RST)', start_us
FROM sess WHERE saw_syn_ack AND NOT saw_fin AND NOT saw_rst
UNION ALL
SELECT src_node, dst_node, stream_index, first_msg_id, last_msg_id, 'Error', 'SILENCE_TIMEOUT',
       'Idle '||round(max_idle_us/1e6,1)||'s', start_us
FROM sess WHERE max_idle_us > 15000000
ORDER BY start_us
```

(`15000000` = the spec's `<threshold_us>` config value, 15s in microseconds,
inlined as a literal for ad-hoc Explorer use; the real Wave 2 `.sql` file
reads it from config. One session can trip multiple rules - each `UNION ALL`
block is independent, so a session appears once per rule it matches, not
squashed into a single row.)

### Stage by stage

**`seg` - join + normalize identity.** One row per TCP segment: joins
`messages` (identity, time) to `protocol_tcp` (flags) on `msg_id`.
`src_node`/`dst_node` are `ip:port` strings. `ka`/`kb` sort the two endpoints
(`LEAST`/`GREATEST`) so both directions of one connection - A->B and B->A -
share the same grouping key regardless of who sent which packet. Internal
plumbing only, never shown to the user.

**`streamed` - split into connections, measure idle gaps.** Two window
functions, both `PARTITION BY ka, kb ORDER BY timestamp_us` (walk each address
pair's segments in time order):
- `stream_index` = running count of pure-SYN segments (`flags&2` set,
  `flags&16` clear - SYN without ACK, i.e. a fresh open, not a SYN-ACK reply)
  seen so far on this address pair. Same two ports talk, stop, reconnect
  later -> second SYN bumps the count -> second conversation gets its own
  `stream_index`, never merged with the first.
- `idle_us` = gap since the previous segment on this address pair
  (`LAG(timestamp_us)`), feeds the silence-timeout rule.

**`sess` - one row per actual connection.** `GROUP BY ka, kb, stream_index` -
**all three columns**, not `stream_index` alone (an earlier draft of this
query grouped by `stream_index` only, which would silently merge "the 1st
connection on pair A" with "the 1st connection on pair B" anywhere two
different address pairs existed in the same trace - caught and fixed before
this landed here). For each connection: `arg_min(..., timestamp_us)` picks
the earliest segment's direction as `src_node` (whoever sent first opened
it); `bool_or` answers "did any segment in this connection have this flag" -
`saw_syn`/`saw_syn_ack`/`saw_fin`/`saw_rst`; `max(idle_us)` is the worst gap
anywhere in the connection.

**The `UNION ALL` blocks - name the flag combinations.** Each is a `WHERE`
over `sess`:

| rule | condition | plain words |
|------|-----------|-------------|
| `HANDSHAKE_NO_SYNACK` | SYN, no SYN-ACK, no RST | sent SYN, peer never answered - dropped/unreachable |
| `CONNECTION_REFUSED` | SYN, no SYN-ACK, but RST | peer actively said no (port closed) |
| `CONNECTION_RESET` | SYN-ACK seen, then RST | established, then killed hard |
| `NEVER_CLOSED` | SYN-ACK, no FIN, no RST | opened fine, no clean close seen in the capture |
| `SILENCE_TIMEOUT` | worst gap > 15s | established stream went quiet |

Flag bits in `protocol_tcp.flags`: `FIN=1 SYN=2 RST=4 PSH=8 ACK=16`. Pure SYN
= `flags&2 && !(flags&16)`; SYN-ACK = `flags&2 && flags&16`.

### Known limitations (not fixed, flagged)

- **SYN retransmission inflates `stream_index`.** A lost-and-resent SYN for
  the *same* connection also matches "pure SYN" in `streamed`, incrementing
  the counter and wrongly splitting one real connection into two fake
  sessions. No dedupe/debounce window applied. Likely low-impact on local
  automotive Ethernet captures (little packet loss), but present and
  untested. Fix direction: only count a SYN if the previous segment in its
  partition wasn't also a SYN within some small time window.
- **`NEVER_CLOSED` is noisy on a live/still-open trace** - any connection
  still open when the capture ends matches it, which is normal, not a defect.
  Expect many hits on a live trace; consider requiring the connection to also
  be idle before flagging, if this proves too chatty in practice.
- **`first_msg_id`/`last_msg_id` bound the whole session**, not the specific
  segment that tripped the rule (e.g. not the RST's own `msg_id`). Good
  enough for "jump to this session in Timeline," not for "show me the exact
  packet that caused this."

---

## Self-Review

**Spec coverage:** Spec's "Ingest-time schema changes" section is fully
covered (src_ip/src_port, protocol_tcp, schema_version bump, same-inflate-pass
peel). Session reconstruction, execution model, and UI are explicitly Wave
2+ and sketched only at goal level above.

**Placeholder scan:** none found - every step has concrete code or an exact
command.

**Type consistency:** `TcpSegmentInfo{flags: u32, length: u32}` used
consistently from Task 3's emission through Task 4's `appendProto`;
`extractTransportInfo`'s out-params match their call-site variable names in
Task 2 Step 3.

**Review Focus:** all five items above are either covered by a specific test
step (control-segment emptiness, IPv6 src_ip, malformed dataOffset) or
explicitly flagged as an out-of-scope risk for the user (VLAN path reuses
existing code, dead DoIP-over-TCP branch going live).
