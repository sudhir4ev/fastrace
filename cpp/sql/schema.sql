-- Trace Store DDL for fastrace_ingest (external duckdb CLI).
-- Payloads stay in the BLF (source of truth). Signals/detections are on-demand.

CREATE TABLE messages (
  msg_id       BIGINT PRIMARY KEY,
  timestamp_us BIGINT,
  object_type  INTEGER,
  channel      INTEGER,
  arb_id       INTEGER,
  extended_id  BOOLEAN,
  dlc          INTEGER,
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
