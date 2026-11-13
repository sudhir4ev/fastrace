-- Optional on-demand anomaly views that need arxml_* (install manually after ingest):
--   duckdb trace.duck.db -c ".read cpp/sql/anomaly_detectors.sql"
--   duckdb trace.duck.db -c ".read cpp/sql/signal_anomaly_detectors.sql"
--
-- Extends protocol detections with CAN unknown-ID. Does not require a signals table.

-- Unknown CAN arbitration ID vs Signal Database (Warning). Skipped if arxml_can empty.
CREATE OR REPLACE VIEW det_can_unknown_id AS
SELECT m.timestamp_us, 'CanDetector' AS detector_name, 'Warning' AS severity,
       'Unknown CAN ID' AS message, m.msg_id AS message_index
FROM messages m
WHERE m.arb_id <> 0
  AND EXISTS (SELECT 1 FROM arxml_can)
  AND NOT EXISTS (SELECT 1 FROM arxml_can a WHERE a.can_id = m.arb_id);

-- Rebuild unified detections to include protocol + CAN rules.
CREATE OR REPLACE VIEW detections AS
SELECT * FROM det_pdu_zero_length
UNION ALL SELECT * FROM det_pdu_unknown_id
UNION ALL SELECT * FROM det_pdu_high_frequency
UNION ALL SELECT * FROM det_someip_sd_flags
UNION ALL SELECT * FROM det_doip_version
UNION ALL SELECT * FROM det_doip_inverse_version
UNION ALL SELECT * FROM det_can_unknown_id;
