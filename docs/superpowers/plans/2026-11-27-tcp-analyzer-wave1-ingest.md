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
6. **Wave 6 - Analyzer Configuration** (added 2026-11-27, after a real trace
   surfaced a dual-channel-tap duplication bug in `tcp_connection_health` -
   see "Config contract" below). A per-analyzer default config JSON file +
   generic `{{key}}` substitution into the SQL text, a JSON-editor UI with
   an Apply button, and the TCP analyzer's first config key: `channel`.
   Verify: visually + Explorer, same `findings` count before/after picking
   the correct channel on a trace with the duplication bug.
7. **Wave 7 - Timeline + evidence detail** (mock image 3). "Follow TCP
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

**Implementation note (added after Wave 2/3 landed):** the SQL file is
actually a bare `WITH` chain with no closing `SELECT`, not real `CREATE
VIEW` statements - DuckDB blocks all DDL on the Trace Store's read-only
connection, not just TEMP tables, so `CREATE VIEW` would fail there. Callers
concatenate their own `SELECT ... FROM findings/sessions/segments` onto the
file's text and run the result as one statement (see
`schema/rules/analyzers/tcp_connection_health.sql`'s header comment). The
three CTE names and column shapes above are unchanged; only the mechanism
differs from how this contract was first drafted.

### Config contract (added Wave 6 2026-11-27)

A 4th piece per analyzer, alongside the SQL file: a default config JSON,
`schema/rules/analyzers/<name>.config.json`. Keys are analyzer-specific
(the Rust/Tauri layer never inspects them); values are substituted into
the SQL text as `{{key}}` placeholders before the final `SELECT` is
appended - a generic textual substitution, same spirit as how `start_us`/
`end_us` already get interpolated into `list_findings`/`list_sessions`.

```
schema/rules/analyzers/tcp_connection_health.sql           # {{channel}} placeholder in _segments
schema/rules/analyzers/tcp_connection_health.config.json   # { "channel": 1 }
```

No config value is ever protocol-aware on the Rust side - `apply_config`
(Wave 6 Task 1) only knows "replace `{{key}}` with `value`'s literal SQL
form," nothing about what "channel" means. This keeps "adding analyzer #2"
at zero Rust/Tauri/UI cost even when that analyzer needs config: it ships
its own `.config.json`, and the same generic substitution code handles it.

### Rust contract (`crates/query`, written once in Wave 3, extended Wave 6)

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

// Adding analyzer #2 = one more entry here + one SQL file (+ optional
// config). Nothing else.
const ANALYZERS: &[(&str, &str, &str)] = &[
    ("tcp_connection_health",
     include_str!("../../../schema/rules/analyzers/tcp_connection_health.sql"),
     include_str!("../../../schema/rules/analyzers/tcp_connection_health.config.json")),
];

// All three: apply_config substitutes {{key}} -> value into the SQL text
// (config_json empty -> use the analyzer's own default), then the caller's
// own SELECT is appended and run as one statement - the analyzer SQL is a
// bare WITH chain with no closing SELECT (no DDL, works on the Trace
// Store's read-only connection). Time-scoped the same way
// `detector_scoped_sql` already scopes `run_detector_query`.
pub fn list_findings(conn, analyzer_name, config_json, start_us, end_us) -> Result<Vec<Finding>, String>;
pub fn list_sessions(conn, analyzer_name, config_json, start_us, end_us) -> Result<Vec<Session>, String>;
pub fn list_segments(conn, analyzer_name, config_json, stream_index)     -> Result<Vec<Segment>, String>;
pub fn list_analyzers() -> Vec<&'static str>; // names from ANALYZERS, backs the UI picker
pub fn get_default_analyzer_config(analyzer_name) -> Result<&'static str, String>; // backs the JSON editor's prefill
```

### Tauri contract (`app/src-tauri`, written once in Wave 3, extended Wave 6)

```rust
#[tauri::command] fn list_analyzers() -> Vec<String>
#[tauri::command] fn get_default_analyzer_config(analyzer_name) -> String
#[tauri::command] fn list_findings(blf_path, analyzer_name, config_json, respect_trim, start_us, end_us) -> Vec<Finding>
#[tauri::command] fn list_sessions(blf_path, analyzer_name, config_json, respect_trim, start_us, end_us) -> Vec<Session>
#[tauri::command] fn list_segments(blf_path, analyzer_name, config_json, stream_index) -> Vec<Segment>
```

Same `trace_store::open` + `respect_trim`/scope pattern as `run_detector_query`
(`app/src-tauri/src/main.rs`). Findings are ephemeral - cached in the UI
workspace store until the next run, never written back to `.duckdb` (spec's
"Findings are ephemeral" decision, unchanged).

### What adding a second protocol analyzer costs

- One file `schema/rules/analyzers/<name>.sql` exposing `findings`/`sessions`/
  `segments`.
- One file `schema/rules/analyzers/<name>.config.json` (or `{}` if it needs
  no config).
- One line in `ANALYZERS`.
- Zero Rust, zero Tauri, zero UI (it appears in the picker automatically,
  config editor prefills from its own default JSON automatically).

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

## Wave 2 + 3 status (implemented, out of band of this doc's original task list)

Both landed directly rather than through a written task-by-task plan (the
roadmap only required one per wave once green-lit; these were small enough
to implement straight from the "Analyzer Framework Contract" above):

- `schema/rules/analyzers/tcp_connection_health.sql` - a bare `WITH` chain
  (no `CREATE VIEW`: DuckDB blocks all DDL on the Trace Store's read-only
  connection, not just TEMP tables) defining `_segments` -> `_stream_segments`
  -> `_sessions` internally, then the three fixed public CTEs `findings`/
  `sessions`/`segments`. Callers concatenate their own `SELECT ... FROM
  <view>` onto the file's text and run the result as one statement - the
  same "wrap arbitrary SQL as a subquery" pattern `run_detector_query`
  already uses. `crates/query/tests/tcp_connection_health_test.rs` seeds a
  minimal store and asserts all 5 rules, the stream-reuse case, and the
  `segments.info` flag-string format (7 tests).
- `crates/query/src/analyzer.rs` - `Finding`/`Session`/`Segment` structs,
  the `ANALYZERS: &[(&str, &str)]` registry, and
  `list_findings`/`list_sessions`/`list_segments`/`list_analyzers`, written
  once with zero TCP knowledge (5 unit tests, seeded in-memory store).
- `app/src-tauri/src/main.rs` - `list_analyzers`/`list_findings`/
  `list_sessions`/`list_segments` Tauri commands, same `respect_trim`/scope
  pattern as `run_detector_query`.

**Verify yourself before Wave 4** (if not already done): `cargo tauri dev`,
then from the dev console, `invoke('list_analyzers')` should return
`["tcp_connection_health"]`, and `invoke('list_findings', { blfPath, analyzerName: "tcp_connection_health", respectTrim: false, startUs: 0, endUs: 0 })`
should return one `HANDSHAKE_NO_SYNACK` row against the fixture.

## Wave 4: Topology UI - detailed task plan

**Goal:** a new "Protocol Analyzer" workspace tab showing one row per TCP
session (mock image 1 - "TCP streams UI"), with per-session error/warning
counts joined client-side from `findings`. No drill-down, no severity
filter, no "Follow Stream" yet - those are Wave 5/6. No trim-range toggle:
MVP always queries the whole trace (`respectTrim: false`), matching "keep
the UI simple" from the original ask.

**Files:**
- Modify `app/ui/src/shared/api/trace-source.ts` - add `Finding`/`Session`
  types, 3 new `TraceDataSource` methods + their `TauriTraceDataSource`
  implementations.
- Modify `app/ui/src/shared/api/hooks.ts` - add `useListAnalyzers`,
  `useListFindings`, `useListSessions`.
- Modify `app/ui/src/app/store.ts` - add `"protocol"` to `WorkspaceTab`.
- Modify `app/ui/src/widgets/WorkspaceLayout.tsx` - add the nav item and the
  always-mounted tab pane (same "mount all, hide with CSS" pattern the
  other three tabs use, so the analyzer picker survives tab switches for
  free - no new global state needed for it).
- Create `app/ui/src/widgets/ProtocolAnalyzerPanel.tsx` - the tab's content:
  a plain `<select>` analyzer picker (matches `ExplorerPanel`'s page-size
  `<select>` - a `Combobox` is overkill for one analyzer today) + a plain
  `<table>` (matches `ExplorerPanel`'s table styling exactly) of sessions
  with Errors/Warnings columns.

**Interfaces:**
- Consumes: `query::Finding`/`Session` shapes (Wave 3, already shipped) via
  the new Tauri commands.
- Produces: nothing downstream yet - Wave 5 reads `findings` again for the
  Violation Explorer drill-down, independently.

### Task 1: `trace-source.ts` types + data-source methods

- [ ] **Step 1: Add the types** (camelCase, matching `query::Finding`/
  `Session`'s `#[serde(rename_all = "camelCase")]`), right after
  `SignalCoverageEntry`:

```typescript
export interface Finding {
  analyzerName: string;
  srcNode: string;
  dstNode: string;
  streamIndex: number;
  severity: string;
  rule: string;
  summary: string;
  startUs: number;
  endUs: number;
  firstMsgId: number;
  lastMsgId: number;
}

export interface Session {
  analyzerName: string;
  srcNode: string;
  dstNode: string;
  streamIndex: number;
  packetCount: number;
  startUs: number;
  endUs: number;
  firstMsgId: number;
  lastMsgId: number;
}
```

- [ ] **Step 2: Add 3 methods to the `TraceDataSource` interface**, after
  `runDetectorQuery`:

```typescript
listAnalyzers(): Promise<string[]>;
listFindings(
  blfPath: string,
  analyzerName: string,
  respectTrim: boolean,
  startUs: number,
  endUs: number
): Promise<Finding[]>;
listSessions(
  blfPath: string,
  analyzerName: string,
  respectTrim: boolean,
  startUs: number,
  endUs: number
): Promise<Session[]>;
```

- [ ] **Step 3: Implement them on `TauriTraceDataSource`**, after
  `runDetectorQuery`'s implementation:

```typescript
listAnalyzers(): Promise<string[]> {
  return invoke<string[]>("list_analyzers");
}

listFindings(
  blfPath: string,
  analyzerName: string,
  respectTrim: boolean,
  startUs: number,
  endUs: number
): Promise<Finding[]> {
  return invoke<Finding[]>("list_findings", { blfPath, analyzerName, respectTrim, startUs, endUs });
}

listSessions(
  blfPath: string,
  analyzerName: string,
  respectTrim: boolean,
  startUs: number,
  endUs: number
): Promise<Session[]> {
  return invoke<Session[]>("list_sessions", { blfPath, analyzerName, respectTrim, startUs, endUs });
}
```

- [ ] **Step 4: Typecheck**

Run: `npm run build --prefix app/ui` (or the project's `tsc --noEmit` script
if one exists - check `app/ui/package.json`).
Expected: no new type errors (Tasks 2-4 still need to exist for anything to
call these, so this step just confirms the interface/impl pair is self
-consistent).

- [ ] **Step 5: Commit**

```bash
git add app/ui/src/shared/api/trace-source.ts
git commit -m "feat(ui): add Finding/Session types and analyzer data-source methods"
```

### Task 2: `hooks.ts`

- [ ] **Step 1: Add the three hooks**, after `useRunDetectorQuery`:

```typescript
export function useListAnalyzers() {
  return useQuery({
    queryKey: ["list-analyzers"],
    queryFn: () => getTraceDataSource().listAnalyzers(),
  });
}

export function useListSessions(blfPath: string, analyzerName: string | null) {
  return useQuery({
    queryKey: ["list-sessions", blfPath, analyzerName],
    queryFn: () => getTraceDataSource().listSessions(blfPath, analyzerName!, false, 0, 0),
    enabled: analyzerName !== null,
  });
}

export function useListFindings(blfPath: string, analyzerName: string | null) {
  return useQuery({
    queryKey: ["list-findings", blfPath, analyzerName],
    queryFn: () => getTraceDataSource().listFindings(blfPath, analyzerName!, false, 0, 0),
    enabled: analyzerName !== null,
  });
}
```

(`respectTrim: false` + `startUs`/`endUs: 0` - the backend's `resolve_scope`
ignores both when `respectTrim` is false and substitutes the trace's real
time range; see `app/src-tauri/src/main.rs:resolve_scope`.)

- [ ] **Step 2: Commit**

```bash
git add app/ui/src/shared/api/hooks.ts
git commit -m "feat(ui): add useListAnalyzers/useListSessions/useListFindings hooks"
```

### Task 3: wire the new workspace tab

- [ ] **Step 1: Add `"protocol"` to `WorkspaceTab`**

`app/ui/src/app/store.ts`:
```typescript
export type WorkspaceTab = "signals" | "messages" | "explorer" | "protocol";
```

- [ ] **Step 2: Add the nav item**

`app/ui/src/widgets/WorkspaceLayout.tsx`, import a `Network` icon from
`lucide-react` alongside the existing `Activity, List, Terminal` import,
then:
```typescript
const NAV_ITEMS: { id: WorkspaceTab; label: string; icon: typeof Activity }[] = [
  { id: "signals", label: "Signals", icon: Activity },
  { id: "messages", label: "Messages", icon: List },
  { id: "explorer", label: "Explorer", icon: Terminal },
  { id: "protocol", label: "Protocol Analyzer", icon: Network },
];
```

- [ ] **Step 3: Add the always-mounted pane**

Import `ProtocolAnalyzerPanel` (created in Task 4) and add, right after the
`explorer` pane's closing `</div>`:
```tsx
<div className={cn("absolute inset-0", workspaceTab !== "protocol" && "hidden")} aria-hidden={workspaceTab !== "protocol"}>
  <ProtocolAnalyzerPanel blfPath={blfPath} />
</div>
```

- [ ] **Step 4: Commit** (after Task 4 exists - this step and Task 4 land
  together since `WorkspaceLayout.tsx` won't compile without the new
  component. Do Task 4 first, then commit both.)

### Task 4: `ProtocolAnalyzerPanel.tsx`

- [ ] **Step 1: Write the component**

```tsx
import { useState } from "react";
import { useListAnalyzers, useListFindings, useListSessions } from "@/shared/api/hooks";
import type { Finding, Session } from "@/shared/api/trace-source";

function formatUs(us: number): string {
  return `${(us / 1_000_000).toFixed(3)}s`;
}

function countBySeverity(findings: Finding[], streamIndex: number, severity: string): number {
  return findings.filter((f) => f.streamIndex === streamIndex && f.severity === severity).length;
}

interface ProtocolAnalyzerPanelProps {
  blfPath: string;
}

export default function ProtocolAnalyzerPanel({ blfPath }: ProtocolAnalyzerPanelProps) {
  const analyzers = useListAnalyzers();
  const [analyzerName, setAnalyzerName] = useState<string | null>(null);
  const activeAnalyzer = analyzerName ?? analyzers.data?.[0] ?? null;

  const sessions = useListSessions(blfPath, activeAnalyzer);
  const findings = useListFindings(blfPath, activeAnalyzer);

  if (analyzers.isLoading) {
    return <div className="p-3 text-sm text-muted-foreground">Loading analyzers...</div>;
  }
  if (!activeAnalyzer) {
    return <div className="p-3 text-sm text-muted-foreground">No analyzers available.</div>;
  }

  const sessionRows: Session[] = sessions.data ?? [];
  const findingRows: Finding[] = findings.data ?? [];

  return (
    <div className="flex h-full min-h-0 flex-col gap-2 p-3">
      <div className="flex items-center gap-2">
        <label htmlFor="analyzer-picker" className="text-sm font-medium">
          Analyzer
        </label>
        <select
          id="analyzer-picker"
          className="rounded-md border border-input bg-background px-2 py-1 text-sm"
          value={activeAnalyzer}
          onChange={(e) => setAnalyzerName(e.target.value)}
        >
          {(analyzers.data ?? []).map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </select>
      </div>
      {sessions.isLoading ? (
        <div className="p-3 text-sm text-muted-foreground">Loading sessions...</div>
      ) : sessionRows.length === 0 ? (
        <div className="p-3 text-sm text-muted-foreground">No sessions found.</div>
      ) : (
        <div className="min-h-0 flex-1 overflow-auto">
          <table className="w-full text-left text-xs">
            <thead className="sticky top-0 bg-muted">
              <tr>
                <th className="whitespace-nowrap px-2 py-1 font-medium">Source</th>
                <th className="whitespace-nowrap px-2 py-1 font-medium">Destination</th>
                <th className="whitespace-nowrap px-2 py-1 font-medium">Packets</th>
                <th className="whitespace-nowrap px-2 py-1 font-medium">Duration</th>
                <th className="whitespace-nowrap px-2 py-1 font-medium">Errors</th>
                <th className="whitespace-nowrap px-2 py-1 font-medium">Warnings</th>
              </tr>
            </thead>
            <tbody>
              {sessionRows.map((s) => (
                <tr key={s.streamIndex} className="border-t border-border/60">
                  <td className="whitespace-nowrap px-2 py-1 font-mono">{s.srcNode}</td>
                  <td className="whitespace-nowrap px-2 py-1 font-mono">{s.dstNode}</td>
                  <td className="whitespace-nowrap px-2 py-1 font-mono">{s.packetCount}</td>
                  <td className="whitespace-nowrap px-2 py-1 font-mono">{formatUs(s.endUs - s.startUs)}</td>
                  <td className="whitespace-nowrap px-2 py-1 font-mono">
                    {countBySeverity(findingRows, s.streamIndex, "Error")}
                  </td>
                  <td className="whitespace-nowrap px-2 py-1 font-mono">
                    {countBySeverity(findingRows, s.streamIndex, "Warning")}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
```

(`countBySeverity` matches by `streamIndex` alone, not `srcNode`/`dstNode` -
fine within one analyzer run, since `stream_index` is already unique per
connection there; would need `analyzerName` in the match too only once a
second analyzer exists and both are shown at once, which Wave 4 doesn't do.)

- [ ] **Step 2: Wire it into `WorkspaceLayout.tsx`** (Task 3 Step 3) and
  commit both together:

```bash
git add app/ui/src/app/store.ts app/ui/src/widgets/WorkspaceLayout.tsx app/ui/src/widgets/ProtocolAnalyzerPanel.tsx
git commit -m "feat(ui): add Protocol Analyzer topology tab (Wave 4)"
```

### Task 5: Manual verification (the wave gate)

- [ ] **Step 1:** `npm run dev --prefix app/ui` or `cargo tauri dev
  --manifest-path app/src-tauri/Cargo.toml`, open a trace with TCP traffic
  (or the fixture).
- [ ] **Step 2:** Click the new "Protocol Analyzer" tab.
- [ ] **Step 3:** Confirm: the analyzer picker shows `tcp_connection_health`;
  the table shows one row per TCP session with plausible Source/Destination/
  Packets/Duration; the Errors/Warnings columns match what the same session
  shows when queried directly in Explorer (`select * from findings`).

**Do not start Wave 5 until you've done this and confirmed the table
matches what Explorer shows for the same trace.**

### Review Focus (Wave 4)

- **Zero sessions on a trace with no TCP traffic** must render "No sessions
  found," not an error or a blank screen - covered by the `sessionRows.length
  === 0` branch above.
- **Switching analyzers mid-session** (once a second one exists) must not
  show stale findings from the previous analyzer while the new query is
  in flight - `useListFindings`'s query key includes `analyzerName`, so
  react-query treats it as a different query and clears/refetches rather
  than showing cached data under the new key. Not independently tested
  here since only one analyzer exists today; revisit when analyzer #2 lands.
- **A session with zero findings** must show `0`/`0`, not blank cells -
  `countBySeverity` returns `0` from `.filter().length` on an empty match,
  covered by construction, not by a dedicated test.

## Wave 5: Violation Explorer UI - detailed task plan

**Goal:** drill down from a Wave 4 session row into that session's
`findings` (mock image 2 - "TCP Violation Explorer"): severity-colored
badges, an All/Error/Warning filter, the active analyzer shown as a chip.
Stays inside the same "Protocol Analyzer" tab - no new route, no new
workspace tab.

**Files:**
- Modify `app/ui/src/app/theme.css` - add a `--warning`/`--warning-foreground`
  token pair (amber), next to the existing `--destructive` pair.
- Modify `app/ui/tailwind.config.ts` - register `warning` as a color, next
  to `destructive`.
- Modify `app/ui/src/shared/ui/badge.tsx` - add `destructive`/`warning`
  variants to `badgeVariants`.
- Modify `app/ui/src/widgets/ProtocolAnalyzerPanel.tsx` - add
  `selectedStreamIndex`/`severityFilter` state, a resizable split (sessions
  table on top, violations list below), severity Badges, and the analyzer
  chip.

**Interfaces:**
- Consumes: `Finding`/`Session` (already shipped, Wave 3/4) - no backend or
  Rust changes this wave.

### Task 1: `warning` color token

- [ ] **Step 1:** `app/ui/src/app/theme.css`, add right after `--red-500:
  #E23B40;`:

```css
--amber-500: #D97706;
```

And right after `--destructive-foreground: var(--fg-inverse);`:

```css
--warning: var(--amber-500);
--warning-foreground: var(--fg-inverse);
```

- [ ] **Step 2:** `app/ui/tailwind.config.ts`, right after the
  `destructive` line:

```typescript
warning: { DEFAULT: "var(--warning)", foreground: "var(--warning-foreground)" },
```

- [ ] **Step 3: Commit**

```bash
git add app/ui/src/app/theme.css app/ui/tailwind.config.ts
git commit -m "feat(ui): add warning color token"
```

### Task 2: Badge variants

- [ ] **Step 1:** `app/ui/src/shared/ui/badge.tsx`, add two entries to
  `badgeVariants`' `variant` map, after `outline`:

```typescript
destructive: "border-transparent bg-destructive text-destructive-foreground",
warning: "border-transparent bg-warning text-warning-foreground",
```

- [ ] **Step 2: Typecheck**

Run: `cd app/ui && npx tsc --noEmit`
Expected: no errors (nothing consumes the new variants until Task 3).

- [ ] **Step 3: Commit**

```bash
git add app/ui/src/shared/ui/badge.tsx
git commit -m "feat(ui): add destructive/warning Badge variants"
```

### Task 3: drill-down in `ProtocolAnalyzerPanel.tsx`

- [ ] **Step 1: Add state and a severity-to-badge-variant helper**, right
  after the existing `countBySeverity` helper:

```typescript
function severityVariant(severity: string): "destructive" | "warning" | "secondary" {
  if (severity === "Error") return "destructive";
  if (severity === "Warning") return "warning";
  return "secondary";
}
```

Inside the component, after the existing `const [analyzerName, ...]` line:

```typescript
const [selectedStreamIndex, setSelectedStreamIndex] = useState<number | null>(null);
const [severityFilter, setSeverityFilter] = useState<"all" | "Error" | "Warning">("all");
```

- [ ] **Step 2: Reset the selection when the analyzer changes**

Right after the `activeAnalyzer` line, add:

```typescript
useEffect(() => {
  setSelectedStreamIndex(null);
}, [activeAnalyzer]);
```

(Import `useEffect` from `"react"` alongside the existing `useState`
import.) Without this, switching analyzers could leave
`selectedStreamIndex` pointing at a `stream_index` that doesn't exist (or
means something different) under the new analyzer.

- [ ] **Step 3: Add the analyzer chip next to the picker**

Right after the `<select id="analyzer-picker" ...>` closing tag, still
inside the same `flex items-center gap-2` row:

```tsx
<Badge variant="secondary">{activeAnalyzer}</Badge>
```

(Import `Badge` from `"@/shared/ui/badge"`.)

- [ ] **Step 4: Wrap the sessions table + make rows selectable**

Replace the sessions `<table>`'s wrapping `<div className="min-h-0 flex-1
overflow-auto">` and the component's outer return with a vertical
`ResizablePanelGroup` (same import already used by `WorkspaceLayout.tsx`
and `SignalsTab`: `ResizableHandle, ResizablePanel, ResizablePanelGroup`
from `"@/shared/ui/resizable"`):

```tsx
return (
  <div className="flex h-full min-h-0 flex-col gap-2 p-3">
    <div className="flex items-center gap-2">
      {/* ...picker + chip, unchanged from Step 3... */}
    </div>
    <div className="min-h-0 flex-1">
      <ResizablePanelGroup direction="vertical">
        <ResizablePanel defaultSize={60} minSize={25}>
          {sessions.isLoading ? (
            <div className="p-3 text-sm text-muted-foreground">Loading sessions...</div>
          ) : sessionRows.length === 0 ? (
            <div className="p-3 text-sm text-muted-foreground">No sessions found.</div>
          ) : (
            <div className="h-full overflow-auto">
              <table className="w-full text-left text-xs">
                <thead className="sticky top-0 bg-muted">
                  <tr>
                    <th className="whitespace-nowrap px-2 py-1 font-medium">Source</th>
                    <th className="whitespace-nowrap px-2 py-1 font-medium">Destination</th>
                    <th className="whitespace-nowrap px-2 py-1 font-medium">Packets</th>
                    <th className="whitespace-nowrap px-2 py-1 font-medium">Duration</th>
                    <th className="whitespace-nowrap px-2 py-1 font-medium">Errors</th>
                    <th className="whitespace-nowrap px-2 py-1 font-medium">Warnings</th>
                  </tr>
                </thead>
                <tbody>
                  {sessionRows.map((s) => (
                    <tr
                      key={s.streamIndex}
                      onClick={() => setSelectedStreamIndex(s.streamIndex)}
                      className={cn(
                        "cursor-pointer border-t border-border/60 hover:bg-accent",
                        selectedStreamIndex === s.streamIndex && "bg-accent"
                      )}
                    >
                      <td className="whitespace-nowrap px-2 py-1 font-mono">{s.srcNode}</td>
                      <td className="whitespace-nowrap px-2 py-1 font-mono">{s.dstNode}</td>
                      <td className="whitespace-nowrap px-2 py-1 font-mono">{s.packetCount}</td>
                      <td className="whitespace-nowrap px-2 py-1 font-mono">{formatUs(s.endUs - s.startUs)}</td>
                      <td className="whitespace-nowrap px-2 py-1 font-mono">
                        {countBySeverity(findingRows, s.streamIndex, "Error")}
                      </td>
                      <td className="whitespace-nowrap px-2 py-1 font-mono">
                        {countBySeverity(findingRows, s.streamIndex, "Warning")}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </ResizablePanel>
        <ResizableHandle withHandle />
        <ResizablePanel defaultSize={40} minSize={15}>
          {/* ...violations list, Step 5... */}
        </ResizablePanel>
      </ResizablePanelGroup>
    </div>
  </div>
);
```

(Import `cn` from `"@/shared/ui/lib/utils"` - already the pattern
`WorkspaceLayout.tsx` uses for the same conditional-class job.)

- [ ] **Step 5: The violations panel**

Fills the second `ResizablePanel` from Step 4:

```tsx
{selectedStreamIndex === null ? (
  <div className="p-3 text-sm text-muted-foreground">Select a session to see its violations.</div>
) : (
  <div className="flex h-full min-h-0 flex-col gap-2 p-2">
    <div className="flex items-center gap-1">
      {(["all", "Error", "Warning"] as const).map((sev) => (
        <Button
          key={sev}
          size="sm"
          variant={severityFilter === sev ? "secondary" : "outline"}
          onClick={() => setSeverityFilter(sev)}
        >
          {sev === "all" ? "All" : sev}
        </Button>
      ))}
    </div>
    <div className="min-h-0 flex-1 overflow-auto">
      <table className="w-full text-left text-xs">
        <thead className="sticky top-0 bg-muted">
          <tr>
            <th className="whitespace-nowrap px-2 py-1 font-medium">Severity</th>
            <th className="whitespace-nowrap px-2 py-1 font-medium">Rule</th>
            <th className="whitespace-nowrap px-2 py-1 font-medium">Summary</th>
          </tr>
        </thead>
        <tbody>
          {findingRows
            .filter((f) => f.streamIndex === selectedStreamIndex)
            .filter((f) => severityFilter === "all" || f.severity === severityFilter)
            .map((f, i) => (
              <tr key={i} className="border-t border-border/60">
                <td className="whitespace-nowrap px-2 py-1">
                  <Badge variant={severityVariant(f.severity)}>{f.severity}</Badge>
                </td>
                <td className="whitespace-nowrap px-2 py-1 font-mono">{f.rule}</td>
                <td className="px-2 py-1">{f.summary}</td>
              </tr>
            ))}
        </tbody>
      </table>
    </div>
  </div>
)}
```

(Import `Button` from `"@/shared/ui/button"`. A session's `findings` rows
are a handful at most - 5 rules max per session per the SQL - so no
pagination/virtualization needed.)

- [ ] **Step 6: Typecheck + build**

Run: `cd app/ui && npx tsc --noEmit && npm run build`
Expected: both clean.

- [ ] **Step 7: Commit**

```bash
git add app/ui/src/widgets/ProtocolAnalyzerPanel.tsx
git commit -m "feat(ui): drill down from a session into its violations (Wave 5)"
```

### Task 4: Manual verification (the wave gate)

- [ ] **Step 1:** `cargo tauri dev --manifest-path app/src-tauri/Cargo.toml`,
  open a trace with a known handshake failure (or the fixture).
- [ ] **Step 2:** Protocol Analyzer tab -> click the session row with a
  non-zero Errors count.
- [ ] **Step 3:** Confirm: the violations panel below shows that session's
  findings with a red "Error" badge on `HANDSHAKE_NO_SYNACK` (or whichever
  rule fired); clicking "Error"/"Warning"/"All" filters the list correctly;
  clicking a different session row swaps the violations list to match.

**Do not start Wave 6 until you've done this and the filter + drill-down
both behave as described.**

### Review Focus (Wave 5)

- **A session with zero findings, after being selected,** must show an
  empty violations table (header row only), not an error - the `.filter()`
  chain degrades to an empty array by construction; no dedicated test.
- **Switching the severity filter while a session with findings of only
  one severity is selected** (e.g. filter set to "Warning" on a session
  with only an Error finding) must show an empty table, not stale rows from
  before the filter changed - covered by construction (`.filter()` re-runs
  on every render, no stale cached list).
- **Selecting a session, then switching analyzers** must not show the old
  analyzer's violations under the new one's `stream_index` numbering (two
  different analyzers can both have a `stream_index = 1`, meaning different
  things) - covered by Task 3 Step 2's `useEffect` reset.

---

## Wave 6: Analyzer Configuration - detailed task plan

**Goal:** fix the real bug found running this analyzer against
`MFK5_VAP_X50_drive_078.blf` - a dual-channel-tap capture logs every TCP
packet twice (once per channel), which the SQL's SYN-counting window
mistakes for new connections, flooding `findings` with spurious
`HANDSHAKE_NO_SYNACK` rows (verified: 20,395 of 40,790 TCP segments in that
trace are exact channel-1/channel-2 duplicates, zero unmatched on either
side, max 117us apart). The fix (`_segments` filters to one `channel`) has
to be user-configurable, since a different trace's channel numbering for
its mirror pair won't always be 1 - and the generic mechanism for that
config has to work for any future analyzer, not just this one.

**Files:**
- Create `schema/rules/analyzers/tcp_connection_health.config.json`.
- Modify `schema/rules/analyzers/tcp_connection_health.sql` - `_segments`
  gets a `WHERE m.channel = {{channel}}` filter.
- Modify `crates/query/src/analyzer.rs` - `ANALYZERS` grows a 3rd field
  (default config), `apply_config` substitution function,
  `get_default_analyzer_config`, `list_findings`/`list_sessions`/
  `list_segments` grow a `config_json: &str` parameter.
- Modify `app/src-tauri/src/main.rs` - the 3 commands grow `config_json:
  String`; new `get_default_analyzer_config` command.
- Modify `app/ui/src/shared/api/trace-source.ts` - `listFindings`/
  `listSessions`/`listSegments` grow a `configJson` parameter; new
  `getDefaultAnalyzerConfig` method.
- Modify `app/ui/src/shared/api/hooks.ts` - `useListFindings`/
  `useListSessions` take `configJson`; new `useDefaultAnalyzerConfig`.
- Modify `app/ui/src/widgets/ProtocolAnalyzerPanel.tsx` - JSON `<textarea>`
  + Apply button.

**Interfaces:**
- Consumes: nothing new from earlier waves except the already-shipped
  `Finding`/`Session`/`Segment` plumbing, which this wave extends in place.
- Produces: `config_json` is now a required-but-often-empty parameter on
  every analyzer-reading function/command/hook from this wave forward -
  Wave 7 (Timeline) must pass it through too when it adds its own
  `list_segments` call.

### Task 1: default config file + SQL placeholder

- [ ] **Step 1: Write the default config**

`schema/rules/analyzers/tcp_connection_health.config.json`:
```json
{
  "channel": 1
}
```

- [ ] **Step 2: Add the placeholder to `_segments`**

In `schema/rules/analyzers/tcp_connection_health.sql`, change:
```sql
_segments AS (
    SELECT m.msg_id, m.timestamp_us,
        m.src_ip || ':' || m.src_port AS src_node,
        m.dst_ip || ':' || m.dst_port AS dst_node,
        LEAST(m.src_ip || ':' || m.src_port, m.dst_ip || ':' || m.dst_port) AS ka,
        GREATEST(m.src_ip || ':' || m.src_port, m.dst_ip || ':' || m.dst_port) AS kb,
        t.flags, t.segment_len
    FROM messages m JOIN protocol_tcp t USING (msg_id)
),
```
to:
```sql
-- {{channel}}: a dual-tap capture logs every packet once per mirrored
-- channel; picking one channel here is the fix, not a timestamp-proximity
-- heuristic - see docs/superpowers/plans/2026-11-27-tcp-analyzer-wave1-ingest.md,
-- "Wave 6: Analyzer Configuration" for the verification that this is a
-- lossless, zero-coincidence 1:1 mirror on the trace that surfaced it.
_segments AS (
    SELECT m.msg_id, m.timestamp_us,
        m.src_ip || ':' || m.src_port AS src_node,
        m.dst_ip || ':' || m.dst_port AS dst_node,
        LEAST(m.src_ip || ':' || m.src_port, m.dst_ip || ':' || m.dst_port) AS ka,
        GREATEST(m.src_ip || ':' || m.src_port, m.dst_ip || ':' || m.dst_port) AS kb,
        t.flags, t.segment_len
    FROM messages m JOIN protocol_tcp t USING (msg_id)
    WHERE m.channel = {{channel}}
),
```

- [ ] **Step 3: Commit**

```bash
git add schema/rules/analyzers/tcp_connection_health.sql schema/rules/analyzers/tcp_connection_health.config.json
git commit -m "feat(analyzer): add channel config to tcp_connection_health, fix dual-tap duplication"
```

### Task 2: generic config substitution in `crates/query`

- [ ] **Step 1: Write the failing tests** (in
  `crates/query/src/analyzer.rs`'s existing `#[cfg(test)] mod tests`):

```rust
#[test]
fn apply_config_substitutes_a_number_placeholder() {
    let out = apply_config("WHERE m.channel = {{channel}}", "", r#"{"channel": 1}"#).unwrap();
    assert_eq!(out, "WHERE m.channel = 1");
}

#[test]
fn apply_config_prefers_caller_config_over_default() {
    let out = apply_config("WHERE m.channel = {{channel}}", r#"{"channel": 2}"#, r#"{"channel": 1}"#).unwrap();
    assert_eq!(out, "WHERE m.channel = 2");
}

#[test]
fn apply_config_errors_on_invalid_json() {
    assert!(apply_config("{{channel}}", "not json", r#"{"channel": 1}"#).is_err());
}

#[test]
fn apply_config_errors_when_a_placeholder_is_left_unresolved() {
    assert!(apply_config("{{channel}} {{missing}}", "", r#"{"channel": 1}"#).is_err());
}
```

- [ ] **Step 2: Run to confirm they fail**

Run: `cargo test --manifest-path crates/Cargo.toml -p query apply_config`
Expected: compile error (`apply_config` doesn't exist yet).

- [ ] **Step 3: Implement `apply_config`**, above `analyzer_sql` in
  `crates/query/src/analyzer.rs`:

```rust
fn apply_config(sql: &str, config_json: &str, default_config_json: &str) -> Result<String, String> {
    let json_text = if config_json.trim().is_empty() { default_config_json } else { config_json };
    let value: serde_json::Value =
        serde_json::from_str(json_text).map_err(|e| format!("invalid config JSON: {e}"))?;
    let obj = value.as_object().ok_or_else(|| "config must be a JSON object".to_string())?;
    let mut out = sql.to_string();
    for (key, v) in obj {
        let literal = match v {
            serde_json::Value::Number(n) => n.to_string(),
            serde_json::Value::String(s) => format!("'{}'", s.replace('\'', "''")),
            serde_json::Value::Bool(b) => b.to_string(),
            _ => return Err(format!("unsupported config value type for key \"{key}\"")),
        };
        out = out.replace(&format!("{{{{{key}}}}}"), &literal);
    }
    if out.contains("{{") {
        return Err("config JSON is missing a key the analyzer SQL requires".to_string());
    }
    Ok(out)
}
```

- [ ] **Step 4: Run to confirm they pass**

Run: `cargo test --manifest-path crates/Cargo.toml -p query apply_config`
Expected: 4/4 pass.

- [ ] **Step 5: Wire it into the registry and the 4 public functions**

`ANALYZERS` grows a 3rd field; `analyzer_sql` returns both strings; each
`list_*` function calls `apply_config` before concatenating its `SELECT`:

```rust
const ANALYZERS: &[(&str, &str, &str)] = &[(
    "tcp_connection_health",
    include_str!("../../../schema/rules/analyzers/tcp_connection_health.sql"),
    include_str!("../../../schema/rules/analyzers/tcp_connection_health.config.json"),
)];

fn analyzer_sql(analyzer_name: &str) -> Result<(&'static str, &'static str), String> {
    ANALYZERS
        .iter()
        .find(|(name, _, _)| *name == analyzer_name)
        .map(|(_, sql, default_config)| (*sql, *default_config))
        .ok_or_else(|| format!("unknown analyzer: {analyzer_name}"))
}

pub fn get_default_analyzer_config(analyzer_name: &str) -> Result<&'static str, String> {
    analyzer_sql(analyzer_name).map(|(_, default_config)| default_config)
}
```

Each of `list_findings`/`list_sessions`/`list_segments` gains a
`config_json: &str` parameter right after `analyzer_name`, and their first
two lines become:

```rust
let (sql, default_config) = analyzer_sql(analyzer_name)?;
let sql = apply_config(sql, config_json, default_config)?;
```

(the rest of each function is unchanged - `sql` was already a local
binding they build the final query string from).

- [ ] **Step 6: Update the 3 existing seeded tests that call these
  functions** (`list_findings_rejects_unknown_analyzer`,
  `list_findings_scopes_by_start_us`, `list_sessions_returns_one_row_per_connection`,
  `list_segments_is_scoped_by_stream_index_not_time`) - each call site adds
  `""` as the new `config_json` argument (empty string = use the
  analyzer's default, which for `tcp_connection_health.config.json` is
  `channel: 1`; the existing seeded test fixtures in this file don't set a
  `channel` column at all, so they also need one added to their `INSERT
  INTO messages` statements - add `, channel INTEGER` to the `CREATE TABLE
  messages` in `seeded_conn()` and `, 1` to every `INSERT INTO messages`
  values list, matching the default).

- [ ] **Step 7: Update `crates/query/tests/tcp_connection_health_test.rs`**
  the same way - its `seeded_conn()`'s `CREATE TABLE messages` needs a
  `channel INTEGER` column, every `seg()` call's `INSERT INTO messages`
  needs a `, 1` for it, and every `format!("{ANALYZER_SQL} SELECT ...")`
  concatenation needs to go through `apply_config` first (or, simpler
  since this test file calls the raw SQL text directly rather than
  `crates/query`'s functions: just string-replace `{{channel}}` with `1`
  before concatenating, e.g. `ANALYZER_SQL.replace("{{channel}}", "1")`
  in place of the bare `ANALYZER_SQL` constant everywhere it's used).

- [ ] **Step 8: Run everything**

Run: `cargo test --manifest-path crates/Cargo.toml -p query`
Expected: all green (the 4 new `apply_config` tests + every updated
existing test).

- [ ] **Step 9: Format + commit**

```bash
cargo fmt --manifest-path crates/Cargo.toml -p query
git add crates/query/src/analyzer.rs crates/query/tests/tcp_connection_health_test.rs
git commit -m "feat(query): generic per-analyzer config substitution (Wave 6)"
```

### Task 3: Tauri commands

- [ ] **Step 1: Add `get_default_analyzer_config`** in
  `app/src-tauri/src/main.rs`, right after `list_analyzers`:

```rust
#[tauri::command]
fn get_default_analyzer_config(analyzer_name: String) -> Result<String, String> {
    query::get_default_analyzer_config(&analyzer_name).map(str::to_string)
}
```

- [ ] **Step 2: Thread `config_json` through the other 3 commands**

Each of `list_findings`/`list_sessions`/`list_segments` gains a
`config_json: String` parameter (right after `analyzer_name`) and passes
it through to the matching `query::list_*` call, e.g.:

```rust
#[tauri::command]
fn list_findings(
    blf_path: String,
    analyzer_name: String,
    config_json: String,
    respect_trim: bool,
    start_us: i64,
    end_us: i64,
) -> Result<Vec<query::Finding>, String> {
    let duckdb_path = std::path::Path::new(&blf_path).with_extension("duckdb");
    let conn = trace_store::open(&duckdb_path)?;
    let (scope_start, scope_end) = resolve_scope(&conn, respect_trim, start_us, end_us)?;
    query::list_findings(&conn, &analyzer_name, &config_json, scope_start, scope_end)
}
```

(same shape for `list_sessions`; `list_segments` drops `respect_trim`/
`start_us`/`end_us` as before, keeping just `config_json` added.)

- [ ] **Step 3: Register the new command**

In the `generate_handler!` list, add `get_default_analyzer_config,` right
after `list_analyzers,`.

- [ ] **Step 4: Build**

Run: `cargo build --manifest-path app/src-tauri/Cargo.toml`
Expected: clean (Task 2 already lands `query`'s side of this signature
change first).

- [ ] **Step 5: Commit**

```bash
git add app/src-tauri/src/main.rs
git commit -m "feat(tauri): wire analyzer config through list_findings/sessions/segments"
```

### Task 4: `trace-source.ts` + `hooks.ts`

- [ ] **Step 1: Add `configJson` to the 3 existing methods + a new
  `getDefaultAnalyzerConfig`**, in the `TraceDataSource` interface:

```typescript
getDefaultAnalyzerConfig(analyzerName: string): Promise<string>;
listFindings(
  blfPath: string,
  analyzerName: string,
  configJson: string,
  respectTrim: boolean,
  startUs: number,
  endUs: number
): Promise<Finding[]>;
listSessions(
  blfPath: string,
  analyzerName: string,
  configJson: string,
  respectTrim: boolean,
  startUs: number,
  endUs: number
): Promise<Session[]>;
```

(`listSegments` isn't called from the UI until Wave 7, but add its
`configJson` parameter now too, so Wave 7 doesn't have to touch this
signature again.)

- [ ] **Step 2: Implement on `TauriTraceDataSource`**:

```typescript
getDefaultAnalyzerConfig(analyzerName: string): Promise<string> {
  return invoke<string>("get_default_analyzer_config", { analyzerName });
}

listFindings(
  blfPath: string,
  analyzerName: string,
  configJson: string,
  respectTrim: boolean,
  startUs: number,
  endUs: number
): Promise<Finding[]> {
  return invoke<Finding[]>("list_findings", { blfPath, analyzerName, configJson, respectTrim, startUs, endUs });
}
```

(same shape for `listSessions`.)

- [ ] **Step 3: Add the hook + update the existing two**, in
  `app/ui/src/shared/api/hooks.ts`:

```typescript
export function useDefaultAnalyzerConfig(analyzerName: string | null) {
  return useQuery({
    queryKey: ["default-analyzer-config", analyzerName],
    queryFn: () => getTraceDataSource().getDefaultAnalyzerConfig(analyzerName!),
    enabled: analyzerName !== null,
  });
}

export function useListSessions(blfPath: string, analyzerName: string | null, configJson: string) {
  return useQuery({
    queryKey: ["list-sessions", blfPath, analyzerName, configJson],
    queryFn: () => getTraceDataSource().listSessions(blfPath, analyzerName!, configJson, false, 0, 0),
    enabled: analyzerName !== null,
  });
}

export function useListFindings(blfPath: string, analyzerName: string | null, configJson: string) {
  return useQuery({
    queryKey: ["list-findings", blfPath, analyzerName, configJson],
    queryFn: () => getTraceDataSource().listFindings(blfPath, analyzerName!, configJson, false, 0, 0),
    enabled: analyzerName !== null,
  });
}
```

(`configJson` joins the query key - editing the draft text doesn't refetch,
only clicking Apply, which is what changes the `appliedConfig` state the
panel passes in here, does.)

- [ ] **Step 4: Typecheck**

Run: `cd app/ui && npx tsc --noEmit`
Expected: errors at `ProtocolAnalyzerPanel.tsx`'s existing call sites
(Task 5 fixes them) - confirms the signature change is actually being
enforced, not silently ignored.

- [ ] **Step 5: Commit** (together with Task 5, since the typecheck won't
  pass standalone - see Task 5's commit step).

### Task 5: JSON editor in `ProtocolAnalyzerPanel.tsx`

- [ ] **Step 1: Add state**, after the existing
  `severityFilter`/`setSeverityFilter` line:

```typescript
const defaultConfig = useDefaultAnalyzerConfig(activeAnalyzer);
const [configDraft, setConfigDraft] = useState("");
const [appliedConfig, setAppliedConfig] = useState("");

useEffect(() => {
  if (defaultConfig.data !== undefined) {
    setConfigDraft(defaultConfig.data);
    setAppliedConfig(defaultConfig.data);
  }
}, [defaultConfig.data, activeAnalyzer]);

let configDraftError: string | null = null;
try {
  if (configDraft.trim().length > 0) JSON.parse(configDraft);
} catch (e) {
  configDraftError = e instanceof Error ? e.message : "invalid JSON";
}
```

(Import `useDefaultAnalyzerConfig` from `"@/shared/api/hooks"` alongside
the existing imports.)

- [ ] **Step 2: Pass `appliedConfig` into the two existing hook calls**

```typescript
const sessions = useListSessions(blfPath, activeAnalyzer, appliedConfig);
const findings = useListFindings(blfPath, activeAnalyzer, appliedConfig);
```

- [ ] **Step 3: Add the editor UI**, right after the picker/chip row (the
  `<div className="flex items-center gap-2">...</div>` containing the
  `<select>` and `<Badge>`):

```tsx
<div className="flex items-center gap-2">
  <textarea
    className="h-16 flex-1 rounded-md border border-input bg-background px-2 py-1 font-mono text-xs"
    value={configDraft}
    onChange={(e) => setConfigDraft(e.target.value)}
  />
  <Button size="sm" disabled={configDraftError !== null} onClick={() => setAppliedConfig(configDraft)}>
    Apply
  </Button>
</div>
{configDraftError !== null && <div className="text-xs text-destructive">{configDraftError}</div>}
```

- [ ] **Step 4: Typecheck + build**

Run: `cd app/ui && npx tsc --noEmit && npm run build`
Expected: both clean.

- [ ] **Step 5: Commit** (Task 4 + Task 5 together, since
  `ProtocolAnalyzerPanel.tsx` is what actually uses the new hook
  signatures):

```bash
git add app/ui/src/shared/api/trace-source.ts app/ui/src/shared/api/hooks.ts app/ui/src/widgets/ProtocolAnalyzerPanel.tsx
git commit -m "feat(ui): per-analyzer JSON config editor with Apply (Wave 6)"
```

### Task 6: Manual verification (the wave gate)

- [ ] **Step 1:** `cargo tauri dev --manifest-path app/src-tauri/Cargo.toml`,
  open `MFK5_VAP_X50_drive_078.blf` (or any trace with the dual-tap
  duplication symptom).
- [ ] **Step 2:** Protocol Analyzer tab - confirm the config editor is
  prefilled with `{ "channel": 1 }` and the sessions table looks sane
  (no more 1-packet sessions flooding with `HANDSHAKE_NO_SYNACK`).
- [ ] **Step 3:** Edit the JSON to `{ "channel": 2 }`, click Apply -
  confirm the table re-renders with the *other* channel's view of the
  same traffic (should look equivalent, since both channels are a full
  mirror on this trace - same session count, same finding count).
- [ ] **Step 4:** Edit the JSON to something invalid (e.g. delete a
  closing brace) - confirm Apply disables and the inline error shows,
  without the table changing or an unhandled exception.
- [ ] **Step 5:** In Explorer, run `select count(*) from findings where
  rule = 'HANDSHAKE_NO_SYNACK'` (after `.read`-ing the analyzer file with
  `{{channel}}` manually substituted to `1`) and confirm the count is
  dramatically lower than before this wave - it should now only include
  genuine failed handshakes, not channel-duplication artifacts.

**Do not start Wave 7 until you've done this and the error count on a real
dual-tap trace looks sane.**

### Review Focus (Wave 6)

- **A config value of the wrong JSON type for its placeholder** (e.g.
  `{"channel": "1"}` as a string instead of a number) must not silently
  produce broken SQL - `apply_config` quotes strings as SQL string
  literals, so `WHERE m.channel = '1'` would still run (DuckDB coerces),
  but a future analyzer expecting a bare identifier substitution, not a
  value, would break. Not fully solved here - flagged as a limitation of
  "every value becomes a SQL literal," not a design that supports
  substituting raw SQL fragments (deliberately - allowing that would reopen
  SQL injection from user-edited config text).
- **An empty-but-present config key the SQL doesn't reference** (e.g. user
  adds `{"channel": 1, "extra": 2}`) must not error - `apply_config` only
  errors on *unresolved placeholders*, never on *unused config keys*,
  covered by construction (the loop just doesn't find `{{extra}}` to
  replace, and the final "any `{{` left?" check only looks at the SQL
  text, not the config object).
- **Switching analyzers while the editor has unapplied edits in the
  textarea** must not silently apply the stale draft to the new analyzer -
  Task 5 Step 1's `useEffect` resets `configDraft`/`appliedConfig` to the
  new analyzer's own default whenever `activeAnalyzer` changes, discarding
  any unapplied edit for the old one. Acceptable for MVP; not a documented
  "are you sure" prompt.

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
