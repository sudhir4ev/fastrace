# TCP Analyzer (Connection Health) - Design

- Status: **Paused** - design agreed, implementation deferred until the
  Trace Explorer / query notebook (prerequisite, separate brainstorming
  session) exists. Resume with `writing-plans` when that lands.
- Date: 2026-11-26

## Goal

A protocol analyzer that reads ingested TCP traffic from the Trace Store,
reconstructs TCP sessions, detects connection-health violations, and
produces findings - without adding TCP-specific columns to the generic
`messages` spine. First of several planned protocol-analyzer plugins; the
architecture must not assume TCP is the only one.

User-facing goal (drill-down UI): answer "which two nodes stopped
communicating, when, why does the analyzer believe that, and what evidence
proves it" - prioritizing explanation and causality over raw packet dumps.

## Scope (v1)

Connection health only: handshake failure, refused connections, resets,
sessions never closed, and idle/silence gaps. Explicitly out of scope for
this pass: retransmissions, out-of-order segments, window/flow-control
anomalies (reliability tier - revisit with its own `schema_version` bump
once this ships).

Findings are **ephemeral**: computed on demand per run, cached in the UI
workspace store until the next run, never written back into the
`.duckdb` file. Matches the existing `run_detector_query` pattern - no new
persistence/invalidation machinery needed.

`confidence` and `capture_quality` (named in the original UI brief as
desired filter dimensions) are deferred - only `severity` ships in v1.
Revisit once there's a second analyzer to compare them against.

## Ingest-time schema changes

- `messages` gains `src_ip VARCHAR`, `src_port INTEGER` (joins the
  existing `dst_ip`/`dst_port`). Network-layer, not TCP-specific - the
  spine was missing bidirectional node identity entirely.
- New peel table, same role as `protocol_someip`/`protocol_doip`:

  ```sql
  CREATE TABLE protocol_tcp (
    msg_id      BIGINT,   -- join key to messages
    flags       INTEGER,  -- raw TCP flags byte: FIN=0x01 SYN=0x02 RST=0x04 PSH=0x08 ACK=0x10 URG=0x20
    segment_len INTEGER   -- TCP payload length; 0 for pure control segments
  );
  ```

  Deliberately missing `seq_num`/`ack_num`/`window_size` - those belong to
  the reliability tier, not connection health. Add them with their own
  `schema_version` bump when that tier is built (ADR 0006 already
  sanctions this: new rule class -> new peeled column -> version bump).
- `schema_version` -> 6. Update both the C++ embed (`native/store`) and
  the Rust open-time check (`crates/trace-store`) in the same change.
- Peel happens in `native/protocol`, same inflate pass as the existing
  PDU/SOME-IP/DoIP peel (architecture.md: peeling already walks into
  transport payloads for UDP PDU IDs; TCP header is in the same mapped
  buffer). No extra I/O pass, no Rust/UI byte parsing.
- Cost: compute is marginal (same inflate loop, a few more field reads +
  one more Appender column batch). Storage is small relative to
  `protocol_someip` (3 low-cardinality columns vs. 7, and only one row per
  TCP segment, not per message) - verify with `ctest` + a size check
  against the MFK5/HCP2 fixtures once `native/protocol` has the TCP peel.

## Node identity

Node = IP:port at the network level (works with no Signal DB loaded).
When ARXML is present, join to `arxml_ecu`/`arxml_pdu` to show a friendly
name over the IP - the underlying key stays IP-based so TCP analysis
never depends on ARXML being loaded.

## Session reconstruction + findings (pure SQL, per ADR 0003)

New file: `schema/rules/analyzers/tcp_connection_health.sql`.

Terminology: **session** = one reconstructed TCP connection (one row of
`tcp_sessions`); **stream** / `stream_index` = the Wireshark-equivalent
identifier (`tcp.stream`) tying a session to its ordered segment sequence
- this is also the join key for the "Follow TCP Stream" UI action.
`src`/`dst` = the SYN sender (initiator) and its peer, derived via
`arg_min(..., timestamp_us)` - this also naturally handles a capture that
starts mid-stream (no special case needed: it just picks whoever sent the
earliest captured segment).

```sql
CREATE OR REPLACE VIEW tcp_segments AS
SELECT
  m.msg_id, m.timestamp_us, m.src_ip, m.src_port, m.dst_ip, m.dst_port,
  LEAST(m.src_ip || ':' || m.src_port, m.dst_ip || ':' || m.dst_port)    AS address_key_a,
  GREATEST(m.src_ip || ':' || m.src_port, m.dst_ip || ':' || m.dst_port) AS address_key_b,
  t.flags, t.segment_len
FROM messages m JOIN protocol_tcp t USING (msg_id);

CREATE OR REPLACE VIEW tcp_stream_segments AS
SELECT *,
  SUM(CASE WHEN flags & 2 <> 0 AND flags & 16 = 0 THEN 1 ELSE 0 END)      -- pure SYN opens a new stream
    OVER (PARTITION BY address_key_a, address_key_b ORDER BY timestamp_us) AS stream_index,
  timestamp_us - LAG(timestamp_us)
    OVER (PARTITION BY address_key_a, address_key_b ORDER BY timestamp_us) AS idle_us
FROM tcp_segments;

CREATE OR REPLACE VIEW tcp_sessions AS
SELECT
  address_key_a, address_key_b, stream_index,
  min(timestamp_us) AS start_us, max(timestamp_us) AS end_us,
  min(msg_id) AS first_msg_id, max(msg_id) AS last_msg_id,
  arg_min(src_ip, timestamp_us) AS src_ip, arg_min(src_port, timestamp_us) AS src_port,
  arg_min(dst_ip, timestamp_us) AS dst_ip, arg_min(dst_port, timestamp_us) AS dst_port,
  bool_or(flags & 2 <> 0 AND flags & 16 = 0) AS saw_syn,
  bool_or(flags & 2 <> 0 AND flags & 16 <> 0) AS saw_syn_ack,
  bool_or(flags & 1 <> 0) AS saw_fin,
  bool_or(flags & 4 <> 0) AS saw_rst,
  max(idle_us) AS max_idle_us
FROM tcp_stream_segments GROUP BY ALL;

CREATE OR REPLACE VIEW tcp_findings AS
SELECT 'tcp_connection_health' AS analyzer_name, src_ip, src_port, dst_ip, dst_port,
       start_us, end_us, first_msg_id, last_msg_id, 'Error' AS severity,
       'Connection attempt failed (no SYN-ACK)' AS summary
FROM tcp_sessions WHERE saw_syn AND NOT saw_syn_ack AND NOT saw_rst
UNION ALL
SELECT 'tcp_connection_health', src_ip, src_port, dst_ip, dst_port, start_us, end_us, first_msg_id, last_msg_id,
       'Warning', 'Connection refused (RST)'
FROM tcp_sessions WHERE saw_syn AND NOT saw_syn_ack AND saw_rst
UNION ALL
SELECT 'tcp_connection_health', src_ip, src_port, dst_ip, dst_port, start_us, end_us, first_msg_id, last_msg_id,
       'Warning', 'Connection reset (RST)'
FROM tcp_sessions WHERE saw_syn_ack AND saw_rst
UNION ALL
SELECT 'tcp_connection_health', src_ip, src_port, dst_ip, dst_port, start_us, end_us, first_msg_id, last_msg_id,
       'Warning', 'Connection not closed (no FIN/RST)'
FROM tcp_sessions WHERE saw_syn_ack AND NOT saw_fin AND NOT saw_rst
UNION ALL
SELECT 'tcp_connection_health', src_ip, src_port, dst_ip, dst_port, start_us, end_us, first_msg_id, last_msg_id,
       'Error', 'Connection idle for ' || (max_idle_us / 1e6) || 's'
FROM tcp_sessions WHERE max_idle_us > <threshold_us>;
```

`<threshold_us>` is a config value, same pattern as `config/config.json`'s
LOD tunables - one knob, not hardcoded.

`address_key_a/b` (LEAST/GREATEST) exist only to group both directions of
one connection into the same stream; they are internal plumbing, never
exposed past this file.

## Execution model (plugin contract)

`crates/query` gets one new function:

```rust
fn run_tcp_connection_health(conn: &Connection, scope: (i64, i64)) -> Result<Vec<Finding>, String>
```

It embeds `tcp_connection_health.sql` via `include_str!` (same pattern as
`config.rs` embedding `config.json`), creates the views, scopes by time
the same way `detector_scoped_sql` already scopes `run_detector_query`,
and returns rows shaped as a **generic** `Finding`:

```rust
struct Finding {
    analyzer_name: String,
    src_ip: String, src_port: i32, dst_ip: String, dst_port: i32,
    severity: String,       // "Error" | "Warning"
    start_us: i64, end_us: i64,
    first_msg_id: i64, last_msg_id: i64,
    summary: String,
}
```

Rust contains zero TCP logic - it only loads and scopes a named SQL
module (ADR 0003: detection logic is SQL, Rust orchestrates). A second
protocol analyzer later is a second `.sql` file + a second one-line Rust
function with the same `Finding` shape; no shared "plugin trait"
machinery is built now since there is only one analyzer - add that
abstraction when a second one actually exists.

New Tauri commands (same `trace_store::open` + scope pattern as
`run_detector_query`):

- `list_tcp_findings(blf_path, start_us, end_us) -> Vec<Finding>`
- `list_tcp_sessions(blf_path, start_us, end_us) -> Vec<TcpSession>`
- `list_tcp_session_segments(blf_path, src_ip, src_port, dst_ip, dst_port, stream_index) -> Vec<TcpSegment>`

No separate "topology" command - topology is a client-side `GROUP BY`
over the (session-count-sized, not message-count-sized) results of the
first two.

## UI (Wireshark-inspired drill-down)

New "TCP Analyzer" workspace tab, same `respectTrim`/trim-window pattern
as the existing `AnalyzerPanel`. One "Run" action fetches
`list_tcp_sessions` + `list_tcp_findings` for the current scope; results
cache in the workspace store until the next Run.

1. **Topology view** - columns modeled on Wireshark's *Statistics ->
   Conversations*: `Src:Port`, `Dst:Port`, `Packets`, `Duration`, plus
   `Errors`/`Warnings` (Wireshark has no violation concept, so these two
   are new). Click a row -> drills to Violation Explorer filtered to that
   pair.
2. **Violation Explorer** - modeled on *Analyze -> Expert Information*:
   grouped/colored by severity (Error = red, Warning = amber - Wireshark's
   own convention). Needs two new `Badge` variants (`destructive`,
   `warning`) added to `badge.tsx` - real gap, not scope creep. Click a
   finding -> drills to that session's stream in the timeline.
3. **Flow/Exchange Timeline** - entry point is "Follow TCP Stream"
   (Wireshark's own wording), keyed by `stream_index`. Packet-list style
   rows: `No.`, `Time`, `Src -> Dst`, `Info`, where `Info` is a generated
   Wireshark-style flag string (`[SYN]`, `[SYN, ACK]`, `[ACK]`,
   `[FIN, ACK]`, `[RST]`) - one small pure function, same pattern as the
   existing `formatUs`/`formatBytes` helpers in `AnalyzerPanel.tsx`. RST
   rows get Wireshark's "bad TCP" red highlight. Idle-time findings get a
   visible gap-divider row ("Idle 12.4s") inserted in the stream itself,
   since Wireshark has no equivalent and causality needs to be visible
   in-line, not just in a separate list.
4. **Evidence detail** - extend the existing `MessageDetails` widget
   (currently a flat field list under its `Details` tab) with grouped
   `Ethernet`/`IP`/`TCP` sub-sections pulling from `messages` +
   `protocol_tcp`, echoing Wireshark's expandable protocol tree. Does not
   need to be a collapsible tree for v1 - grouped sub-headings are enough.

## Testing

Follow the existing per-module convention (AGENTS.md "Always" rule - own
test entry point + README per module):

- `native/protocol`: TCP peel correctness against seeded BLF fixtures
  (ADR 0007 style), verified via `ctest`.
- `crates/query`: unit tests over a seeded DuckDB connection (same style
  as the existing `run_detector_query_*` tests in `crates/query/src/lib.rs`)
  covering each `tcp_findings` case (handshake failure, refused, reset,
  not-closed, idle) plus the stream-reuse case (same 4-tuple opening a new
  connection later in the trace must get a new `stream_index`).
- No dedicated frontend test target exists yet (matches the rest of
  `app/ui`) - verify the four views manually against a fixture trace once
  implemented.

## Open items for when this resumes

- Reliability tier (retransmission/out-of-order/window) - needs
  `seq_num`/`ack_num`/`window_size` peeled, its own `schema_version` bump.
- `confidence`/`capture_quality` columns on `Finding` - deferred pending a
  second analyzer to design them against.
- Depends on the Trace Explorer / query notebook (separate design) for
  iterating on `tcp_segments`/`tcp_stream_segments` during development -
  right now there's no UI to inspect intermediate views directly.
