-- TCP Connection Health analyzer - first instance of the generic Analyzer
-- Framework Contract (docs/superpowers/plans/2026-11-27-tcp-analyzer-wave1-ingest.md,
-- "Analyzer Framework Contract"). Defines exactly three fixed-name public
-- CTEs: findings, sessions, segments. Everything else here is internal
-- (`_`-prefixed), never read outside this file.
--
-- Not a standalone script: this is a `WITH` chain with no closing `SELECT`,
-- so it never creates catalog objects (CREATE VIEW would fail on the Trace
-- Store's read-only connection, docs/adr/0001 - duckdb-rs's AccessMode::
-- ReadOnly blocks all DDL, not just TEMP tables). The caller appends its own
-- `SELECT ... FROM findings` / `sessions` / `segments` and runs the result as
-- one statement (crates/query::list_findings/list_sessions/list_segments) -
-- the same "wrap arbitrary SQL as a subquery" pattern `run_detector_query`
-- already uses. For manual Explorer use, paste this file's text followed by
-- your own `SELECT * FROM findings` (etc.) in one go.

WITH
-- One row per TCP segment: join identity/time to flags, normalize the
-- address pair so both directions of one connection share a key regardless
-- of who sent which packet (LEAST/GREATEST).
_segments AS (
    SELECT m.msg_id, m.timestamp_us,
        m.src_ip || ':' || m.src_port AS src_node,
        m.dst_ip || ':' || m.dst_port AS dst_node,
        LEAST(m.src_ip || ':' || m.src_port, m.dst_ip || ':' || m.dst_port) AS ka,
        GREATEST(m.src_ip || ':' || m.src_port, m.dst_ip || ':' || m.dst_port) AS kb,
        t.flags, t.segment_len
    FROM messages m JOIN protocol_tcp t USING (msg_id)
),
-- Splits each address pair's segments into distinct connections and
-- measures idle gaps. stream_index = running count of pure-SYN segments
-- (SYN set, ACK clear - a fresh open, not a SYN-ACK reply) seen so far on
-- this pair: a reconnect on the same two ports bumps the count, so it never
-- merges with the earlier connection.
-- Known limitation (not fixed): a retransmitted SYN for the SAME connection
-- also counts here, inflating stream_index. No dedupe window applied.
_stream_segments AS (
    SELECT *,
        SUM(CASE WHEN flags & 2 <> 0 AND flags & 16 = 0 THEN 1 ELSE 0 END)
            OVER (PARTITION BY ka, kb ORDER BY timestamp_us) AS stream_index,
        timestamp_us - LAG(timestamp_us) OVER (PARTITION BY ka, kb ORDER BY timestamp_us) AS idle_us
    FROM _segments
),
-- One row per actual connection. GROUP BY ka, kb, stream_index - all three;
-- stream_index alone would merge "the Nth connection on pair A" with "the
-- Nth connection on pair B" whenever two different address pairs exist in
-- the same trace.
_sessions AS (
    SELECT ka, kb, stream_index,
        arg_min(src_node, timestamp_us) AS src_node, -- whoever sent first opened it
        arg_min(dst_node, timestamp_us) AS dst_node,
        min(timestamp_us) AS start_us, max(timestamp_us) AS end_us,
        min(msg_id) AS first_msg_id, max(msg_id) AS last_msg_id,
        count(*) AS packet_count,
        bool_or(flags & 2 <> 0 AND flags & 16 = 0) AS saw_syn,
        bool_or(flags & 2 <> 0 AND flags & 16 <> 0) AS saw_syn_ack,
        bool_or(flags & 1 <> 0) AS saw_fin,
        bool_or(flags & 4 <> 0) AS saw_rst,
        max(idle_us) AS max_idle_us
    FROM _stream_segments
    GROUP BY ka, kb, stream_index
),
-- Idle threshold for SILENCE_TIMEOUT, 15s in microseconds (spec's
-- <threshold_us>). Inlined as a literal - no config table to read from yet.
findings AS (
    SELECT 'tcp_connection_health' AS analyzer_name, src_node, dst_node, stream_index,
        'Error' AS severity, 'HANDSHAKE_NO_SYNACK' AS rule,
        'Connection attempt failed (no SYN-ACK)' AS summary,
        start_us, end_us, first_msg_id, last_msg_id
    FROM _sessions WHERE saw_syn AND NOT saw_syn_ack AND NOT saw_rst
    UNION ALL
    SELECT 'tcp_connection_health', src_node, dst_node, stream_index,
        'Warning', 'CONNECTION_REFUSED', 'Connection refused (RST)',
        start_us, end_us, first_msg_id, last_msg_id
    FROM _sessions WHERE saw_syn AND NOT saw_syn_ack AND saw_rst
    UNION ALL
    SELECT 'tcp_connection_health', src_node, dst_node, stream_index,
        'Warning', 'CONNECTION_RESET', 'Connection reset (RST)',
        start_us, end_us, first_msg_id, last_msg_id
    FROM _sessions WHERE saw_syn_ack AND saw_rst
    UNION ALL
    SELECT 'tcp_connection_health', src_node, dst_node, stream_index,
        'Warning', 'NEVER_CLOSED', 'Connection not closed (no FIN/RST)',
        start_us, end_us, first_msg_id, last_msg_id
    FROM _sessions WHERE saw_syn_ack AND NOT saw_fin AND NOT saw_rst
    UNION ALL
    SELECT 'tcp_connection_health', src_node, dst_node, stream_index,
        'Error', 'SILENCE_TIMEOUT', 'Idle ' || round(max_idle_us / 1e6, 1) || 's',
        start_us, end_us, first_msg_id, last_msg_id
    FROM _sessions WHERE max_idle_us > 15000000
),
sessions AS (
    SELECT 'tcp_connection_health' AS analyzer_name, src_node, dst_node, stream_index,
        packet_count, start_us, end_us, first_msg_id, last_msg_id
    FROM _sessions
),
-- info is a Wireshark-style flag string, e.g. "[SYN, ACK]", built in SQL so
-- the UI renders it verbatim and stays protocol-agnostic. concat_ws skips
-- NULL arguments, so only set flags appear.
segments AS (
    SELECT 'tcp_connection_health' AS analyzer_name, stream_index, msg_id, timestamp_us,
        src_node, dst_node,
        '[' || concat_ws(', ',
            CASE WHEN flags & 2 <> 0 THEN 'SYN' END,
            CASE WHEN flags & 16 <> 0 THEN 'ACK' END,
            CASE WHEN flags & 1 <> 0 THEN 'FIN' END,
            CASE WHEN flags & 4 <> 0 THEN 'RST' END,
            CASE WHEN flags & 8 <> 0 THEN 'PSH' END,
            CASE WHEN flags & 32 <> 0 THEN 'URG' END
        ) || ']' AS info,
        segment_len, coalesce(idle_us, 0) AS idle_us -- NULL for each stream's first segment (no prior LAG)
    FROM _stream_segments
)
