-- Trace Store DDL for fastrace_ingest (external duckdb CLI).
-- Payloads stay in the BLF (source of truth). Signals/detections are on-demand.
-- schema_version: 6

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

CREATE TABLE meta (
  key   VARCHAR PRIMARY KEY,
  value VARCHAR
);

CREATE TABLE protocol_pdu (
  msg_id BIGINT,
  pdu_id BIGINT,
  length BIGINT
);

CREATE TABLE protocol_someip (
  msg_id BIGINT,
  service_id BIGINT,
  method_id BIGINT,
  length BIGINT,
  client_id BIGINT,
  session_id BIGINT,
  protocol_version INTEGER,
  interface_version INTEGER,
  message_type INTEGER,
  return_code INTEGER
);

CREATE TABLE protocol_someip_sd (
  msg_id BIGINT,
  flags INTEGER
);

CREATE TABLE protocol_doip (
  msg_id BIGINT,
  protocol_version INTEGER,
  inverse_version INTEGER,
  payload_type BIGINT,
  payload_length BIGINT,
  source_address BIGINT,
  target_address BIGINT
);

CREATE TABLE protocol_tcp (
  msg_id      BIGINT,   -- join key to messages
  flags       INTEGER,  -- raw TCP flags byte: FIN=0x01 SYN=0x02 RST=0x04 PSH=0x08 ACK=0x10 URG=0x20
  segment_len INTEGER   -- TCP payload length; 0 for pure control segments
);

CREATE TABLE arxml_pdu (
  pdu_id BIGINT,
  name VARCHAR,
  dst_ip VARCHAR,
  dst_port INTEGER
);

CREATE TABLE arxml_ecu (
  name VARCHAR
);

CREATE TABLE arxml_can (
  can_id BIGINT,
  name VARCHAR,
  extended BOOLEAN,
  dlc INTEGER
);

CREATE TABLE arxml_signal (
  signal_id   BIGINT PRIMARY KEY,
  name        VARCHAR,
  parent_kind VARCHAR,   -- 'can' or 'pdu'
  parent_id   BIGINT,    -- can_id or pdu_id depending on parent_kind
  start_bit   INTEGER,
  bit_length  INTEGER,
  big_endian  BOOLEAN,
  factor      DOUBLE,    -- from ARXML COMPU-RATIONAL-COEFFS; 1.0 if no COMPU-METHOD or non-linear
  "offset"    DOUBLE     -- from ARXML COMPU-RATIONAL-COEFFS; 0.0 if no COMPU-METHOD or non-linear;
                         -- quoted: OFFSET is a reserved keyword in DuckDB's SQL dialect
);

-- Decoded signal samples, populated on demand by fastrace_parse decode-signals (docs/adr/0005).
CREATE TABLE signals (
  signal_id    BIGINT,
  msg_id       BIGINT,
  timestamp_us BIGINT,
  raw_value    UBIGINT,
  phys_value   DOUBLE     -- raw_value * factor + "offset"
);

-- Per-signal summary written during Prepare (docs/adr/0005). One row per arxml_signal.
-- Opaque (bit_length > 64) signals track change/nonzero via a byte-span hash; min/max stay NULL.
CREATE TABLE signal_stats (
  signal_id    BIGINT PRIMARY KEY,
  samples      BIGINT,   -- times the parent message/PDU was seen
  nonzero      BIGINT,   -- samples with raw != 0 (opaque: any byte != 0)
  changes      BIGINT,   -- samples whose value differs from the previous one
  min_raw      UBIGINT,  -- NULL when opaque
  max_raw      UBIGINT,  -- NULL when opaque
  first_ts_us  BIGINT,
  last_ts_us   BIGINT,
  opaque       BOOLEAN   -- bit_length > 64: tracked by byte hash only
);

-- Coarse per-LOG_CONTAINER time index, written during Prepare's inflate loop.
-- Lets windowed reads (apply-trim) seek to only the containers a [start,end]
-- window overlaps, instead of inflating the whole file. byte_offset is the file
-- offset of the container's "LOBJ" signature; one row per non-empty container.
CREATE TABLE container_index (
  container_ord BIGINT PRIMARY KEY,  -- 0-based inflate order
  byte_offset   BIGINT,              -- file offset of the LOBJ signature
  first_ts_us   BIGINT,              -- min message timestamp in the container
  last_ts_us    BIGINT,              -- max message timestamp in the container
  first_msg_id  BIGINT,              -- global msg_id of the container's first message
  decoded       BOOLEAN DEFAULT false -- true after apply-trim inflated this container for signal decode
);

-- Per-signal decoded coverage: the single contiguous [start,end] window a
-- signal's samples currently cover in the `signals` table. Lets apply-trim
-- decode only the uncovered delta on expand and skip decoding entirely on
-- shrink. One row per signal that has been decoded at least once.
CREATE TABLE signal_coverage (
  signal_id BIGINT PRIMARY KEY,
  start_us  BIGINT,
  end_us    BIGINT
);
