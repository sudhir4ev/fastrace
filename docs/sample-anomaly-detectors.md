# Sample anomaly Detector Queries

Paste into the Analyzer. Each query must return `msg_id` and `timestamp_us` (Matches + anomaly bins). One statement only. Ctrl+Space inserts signal names.

Tune thresholds per signal / PDU. The cycle-time example uses a dual-channel capture — always `PARTITION BY channel` for Ethernet PDUs that appear on more than one tap.

---

## Cycle time variance

Flags parent-PDU intervals outside a tight band around the expected cycle (here ~5 ms ± 200 µs). Resolve the parent via `arxml_signal.name`.

```sql
WITH ordered AS (
  SELECT m.msg_id, m.timestamp_us, m.channel,
         m.timestamp_us - LAG(m.timestamp_us)
           OVER (PARTITION BY m.channel ORDER BY m.timestamp_us) AS dt_us
  FROM protocol_pdu pp
  JOIN messages m ON m.msg_id = pp.msg_id
  WHERE pp.pdu_id = (
    SELECT parent_id FROM arxml_signal
    WHERE name = 'VDSO_04_BZ_XIX_VDSO_04_XIX_VLAN_FAS'
  )
)
SELECT msg_id, timestamp_us
FROM ordered
WHERE dt_us IS NOT NULL
  AND (dt_us < 4800 OR dt_us > 5200)
```

---

## Zero-length PDU

```sql
SELECT m.msg_id, m.timestamp_us
FROM protocol_pdu p
JOIN messages m ON m.msg_id = p.msg_id
WHERE p.length = 0
```

---

## Unknown PDU ID (vs ARXML)

```sql
SELECT m.msg_id, m.timestamp_us
FROM protocol_pdu p
JOIN messages m ON m.msg_id = p.msg_id
WHERE EXISTS (SELECT 1 FROM arxml_pdu)
  AND NOT EXISTS (SELECT 1 FROM arxml_pdu a WHERE a.pdu_id = p.pdu_id)
```

---

## SOME/IP-SD unexpected flags

Flags byte outside `{0x00, 0x80, 0xC0}`.

```sql
SELECT m.msg_id, m.timestamp_us
FROM protocol_someip_sd s
JOIN messages m ON m.msg_id = s.msg_id
WHERE s.flags NOT IN (0, 128, 192)
```

---

## DoIP protocol version / inverse mismatch

```sql
SELECT m.msg_id, m.timestamp_us
FROM protocol_doip d
JOIN messages m ON m.msg_id = d.msg_id
WHERE d.protocol_version NOT IN (2, 3)
   OR d.inverse_version <> ((~d.protocol_version) & 255)
```

---

## Unknown CAN ID (vs ARXML)

```sql
SELECT m.msg_id, m.timestamp_us
FROM messages m
WHERE m.arb_id <> 0
  AND EXISTS (SELECT 1 FROM arxml_can)
  AND NOT EXISTS (SELECT 1 FROM arxml_can a WHERE a.can_id = m.arb_id)
```

---

## Signal value jump (needs Target Signals + decode)

Select the signal as a Target before Run. Flags consecutive samples whose physical delta exceeds a threshold.

```sql
WITH s AS (
  SELECT msg_id, timestamp_us, phys_value,
         phys_value - LAG(phys_value) OVER (ORDER BY timestamp_us) AS d_phys
  FROM signals
  WHERE signal_id = (
    SELECT signal_id FROM arxml_signal
    WHERE name = 'VDSO_04_BZ_XIX_VDSO_04_XIX_VLAN_FAS'
  )
)
SELECT msg_id, timestamp_us
FROM s
WHERE d_phys IS NOT NULL
  AND abs(d_phys) > 1.0
```
