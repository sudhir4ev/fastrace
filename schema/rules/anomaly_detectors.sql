-- SQL ports of the C++ detectors (cpp/detectors/*.cpp) over the Trace Store schema
-- (messages, protocol_*, arxml_*; see cpp/sql/schema.sql).
--
-- Every view emits the Detection shape from cpp/include/Detection.h:
--   timestamp_us, detector_name, severity, message, message_index (= messages.msg_id)
-- `detections` is the UNION ALL of the per-detector views.
--
-- On-demand only (not installed by ingest). After ingest:
--   duckdb trace.duck.db -c ".read cpp/sql/anomaly_detectors.sql"
-- Optional CAN rule: also .read cpp/sql/signal_anomaly_detectors.sql
--   SELECT detector_name, message, count(*) FROM detections GROUP BY ALL;

-- arxml_pdu / arxml_can only exist when a Signal DB was materialized. Create empty
-- ones so the views below always bind (empty == "no DB", which disables DB checks).
CREATE TABLE IF NOT EXISTS arxml_pdu (pdu_id BIGINT, name VARCHAR, dst_ip VARCHAR, dst_port INTEGER);
CREATE TABLE IF NOT EXISTS arxml_can (can_id BIGINT, name VARCHAR, extended BOOLEAN, dlc INTEGER);

-- PduDetector: zero-length PDU (Error)
CREATE OR REPLACE VIEW det_pdu_zero_length AS
SELECT m.timestamp_us, 'PduDetector' AS detector_name, 'Error' AS severity,
       'Zero length PDU' AS message, p.msg_id AS message_index
FROM protocol_pdu p
JOIN messages m USING (msg_id)
WHERE p.length = 0;

-- PduDetector: PDU id not in Signal DB (Warning). Skipped when the DB is empty.
CREATE OR REPLACE VIEW det_pdu_unknown_id AS
SELECT m.timestamp_us, 'PduDetector', 'Warning', 'Unknown PDU ID', p.msg_id
FROM protocol_pdu p
JOIN messages m USING (msg_id)
WHERE (EXISTS (SELECT 1 FROM arxml_pdu) OR EXISTS (SELECT 1 FROM arxml_can))
  AND NOT EXISTS (SELECT 1 FROM arxml_pdu a WHERE a.pdu_id = p.pdu_id);

-- PduDetector: "high frequency" -- faithful port: >1000 occurrences of one PDU id in the
-- WHOLE trace (a count, not a rate). One row per PDU id, stamped with its last occurrence.
CREATE OR REPLACE VIEW det_pdu_high_frequency AS
SELECT max(m.timestamp_us) AS timestamp_us, 'PduDetector', 'Warning',
       'High frequency PDU detected', NULL::BIGINT AS message_index
FROM protocol_pdu p
JOIN messages m USING (msg_id)
GROUP BY p.pdu_id
HAVING count(*) > 1000;

-- SomeIpSdDetector: flags byte outside {0x00, 0x80, 0xC0} (Warning)
CREATE OR REPLACE VIEW det_someip_sd_flags AS
SELECT m.timestamp_us, 'SomeIpSdDetector', 'Warning', 'Unexpected SD flags', s.msg_id
FROM protocol_someip_sd s
JOIN messages m USING (msg_id)
WHERE s.flags NOT IN (0, 128, 192);  -- 0x00, 0x80, 0xC0

-- DoipDetector: protocol version not 0x02/0x03 (Error)
CREATE OR REPLACE VIEW det_doip_version AS
SELECT m.timestamp_us, 'DoipDetector', 'Error', 'Invalid DoIP Protocol Version', d.msg_id
FROM protocol_doip d
JOIN messages m USING (msg_id)
WHERE d.protocol_version NOT IN (2, 3);  -- 0x02, 0x03

-- DoipDetector: inverse version != (uint8_t)~version (Warning)
CREATE OR REPLACE VIEW det_doip_inverse_version AS
SELECT m.timestamp_us, 'DoipDetector', 'Warning', 'DoIP Inverse Version mismatch', d.msg_id
FROM protocol_doip d
JOIN messages m USING (msg_id)
WHERE d.inverse_version <> ((~d.protocol_version) & 255);  -- 0xFF

CREATE OR REPLACE VIEW detections AS
SELECT * FROM det_pdu_zero_length
UNION ALL SELECT * FROM det_pdu_unknown_id
UNION ALL SELECT * FROM det_pdu_high_frequency
UNION ALL SELECT * FROM det_someip_sd_flags
UNION ALL SELECT * FROM det_doip_version
UNION ALL SELECT * FROM det_doip_inverse_version;
