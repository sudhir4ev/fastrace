use serde::{Deserialize, Serialize};

mod config;
pub use config::*;

/// The two user-selectable Downsampling Algorithms (`CONTEXT.md`, `docs/adr/0009`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DownsamplingAlgorithm {
    MinMax,
    Lttb,
}

/// Point budget for a chart viewport: ~2 points per pixel, snapped up to the
/// next power of two so repeated requests at a similar zoom reuse the same
/// LOD Tier (`docs/adr/0009`). Clamped to `[LOD.min_lod_target_points,
/// LOD.max_lod_target_points]` (`config/config.json`) so a not-yet-laid-out
/// container (`pixel_width <= 0`) or a pathologically wide one can't
/// produce a degenerate or runaway budget.
pub fn lod_tier_point_budget(pixel_width: i64) -> i64 {
    let raw = (pixel_width.max(1) * 2) as f64;
    let tier_exp = raw.log2().ceil().max(0.0) as u32;
    let budget = 1i64 << tier_exp;
    budget.clamp(LOD.min_lod_target_points, LOD.max_lod_target_points)
}

/// Runs a `SELECT COUNT(*) ...`-shaped query and returns the single integer
/// result. Not a general query runner - just enough to drive the Wave 2
/// summary screen's fixed set of aggregate counts.
pub fn count(conn: &trace_store::Connection, sql: &str) -> Result<i64, String> {
    conn.query_row(sql, [], |row| row.get(0))
        .map_err(|e| e.to_string())
}

/// Total row count of `messages` - backs the message-ordinal trim slider's
/// max bound. Not trim-bound itself (it must report the trace's full count
/// regardless of the currently applied window, same as get_trace_time_range).
pub fn count_messages(conn: &trace_store::Connection) -> Result<i64, String> {
    conn.query_row("select count(*) from messages", [], |row| row.get(0))
        .map_err(|e| e.to_string())
}

/// Messages whose `timestamp_us` falls in the inclusive trim window - backs
/// the trim-rail live readout (throttled from the UI while dragging).
pub fn count_messages_in_range(
    conn: &trace_store::Connection,
    start_us: i64,
    end_us: i64,
) -> Result<i64, String> {
    let (lo, hi) = if start_us <= end_us {
        (start_us, end_us)
    } else {
        (end_us, start_us)
    };
    conn.query_row(
        "select count(*) from messages where timestamp_us between ? and ?",
        duckdb::params![lo, hi],
        |row| row.get(0),
    )
    .map_err(|e| e.to_string())
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContainerIndexEntry {
    pub container_ord: i64,
    pub byte_offset: i64,
    pub first_ts_us: i64,
    pub last_ts_us: i64,
    pub first_msg_id: i64,
    pub decoded: bool,
}

/// Coarse LOG_CONTAINER seek map + sticky `decoded` flag (containers that
/// overlapped a decode fringe). Trim-rail blue bands prefer [`list_signal_coverage`].
pub fn list_container_index(
    conn: &trace_store::Connection,
) -> Result<Vec<ContainerIndexEntry>, String> {
    let mut stmt = conn
        .prepare(
            "select container_ord, byte_offset, first_ts_us, last_ts_us, first_msg_id, decoded
             from container_index order by container_ord",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |row| {
            Ok(ContainerIndexEntry {
                container_ord: row.get(0)?,
                byte_offset: row.get(1)?,
                first_ts_us: row.get(2)?,
                last_ts_us: row.get(3)?,
                first_msg_id: row.get(4)?,
                decoded: row.get(5)?,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SignalCoverageEntry {
    pub signal_id: i64,
    pub start_us: i64,
    pub end_us: i64,
}

/// Per-signal cached sample extents - source of truth for the trim-rail cache band.
pub fn list_signal_coverage(
    conn: &trace_store::Connection,
) -> Result<Vec<SignalCoverageEntry>, String> {
    let mut stmt = conn
        .prepare("select signal_id, start_us, end_us from signal_coverage order by signal_id")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |row| {
            Ok(SignalCoverageEntry {
                signal_id: row.get(0)?,
                start_us: row.get(1)?,
                end_us: row.get(2)?,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())
}

/// Resolves a 1-based ordinal position (1..=count_messages) to that message's
/// timestamp_us, by msg_id order (msg_id assignment order matches time order -
/// Prepare assigns ids sequentially while iterating the BLF in time order).
/// position 1 maps to the earliest message's timestamp.
///
/// Prefer [`resolve_message_range`] for Trim Window bounds: endpoint timestamps
/// alone are wrong when the first/last messages have timestamp 0 (common on
/// merged traces) - the time window must be min/max over the whole ordinal slice.
pub fn resolve_message_position(
    conn: &trace_store::Connection,
    position: i64,
) -> Result<i64, String> {
    if position < 1 {
        return Err(format!("message position must be >= 1, got {position}"));
    }
    conn.query_row(
        "select timestamp_us from messages order by msg_id limit 1 offset ?",
        duckdb::params![position - 1],
        |row| row.get(0),
    )
    .map_err(|e| format!("position {position} not found: {e}"))
}

/// Resolves an inclusive 1-based message-ordinal slice to a `[start_us, end_us]`
/// time window = min/max `timestamp_us` over that slice. Swapped endpoints are
/// normalized. Prepare assigns contiguous `msg_id` values `0..n-1` in iteration
/// order, so position `p` maps to `msg_id = p - 1` (BETWEEN, not LIMIT/OFFSET).
/// Endpoint-only timestamps fail when a leading/trailing LOBJ has timestamp 0.
pub fn resolve_message_range(
    conn: &trace_store::Connection,
    start_pos: i64,
    end_pos: i64,
) -> Result<(i64, i64), String> {
    let (lo, hi) = if start_pos <= end_pos {
        (start_pos, end_pos)
    } else {
        (end_pos, start_pos)
    };
    if lo < 1 {
        return Err(format!("message position must be >= 1, got {lo}"));
    }
    let lo_id = lo - 1;
    let hi_id = hi - 1;
    conn.query_row(
        "select min(timestamp_us), max(timestamp_us) from messages where msg_id between ? and ?",
        duckdb::params![lo_id, hi_id],
        |row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?)),
    )
    .map_err(|e| format!("message range {lo}..={hi} not found: {e}"))
}

// CAN vs Ethernet object_type values (native/blf/include/BlfTypes.h),
// duplicated here because Rust has no visibility into the C++ header - keep
// in sync if that enum changes.
const CAN_OBJECT_TYPES: &str = "1,100,101";
const ETHERNET_OBJECT_TYPES: &str = "71,120,121";

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageGroup {
    pub key: String,
    pub bus_label: String,
    pub label: String,
    pub count: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageRow {
    pub msg_id: i64,
    pub timestamp_us: i64,
    pub bus_label: String,
    pub id_or_src: String,
    pub name: Option<String>,
    pub dlc: Option<i32>,
    pub payload_len: Option<i32>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MessagePage {
    pub rows: Vec<MessageRow>,
    pub next_cursor: Option<i64>,
}

/// One group per distinct CAN arb_id and per distinct Ethernet (dst_ip,
/// dst_port) pair. `key` is the opaque cursor `list_messages` parses back
/// apart - "can:<arb_id>" or "eth:<dst_ip>:<dst_port>".
pub fn list_message_groups(
    conn: &trace_store::Connection,
    start_us: i64,
    end_us: i64,
) -> Result<Vec<MessageGroup>, String> {
    let sql = format!(
        "select 'can:' || cast(arb_id as varchar) as key,
                'CAN' as bus_label,
                coalesce((select name from arxml_can where can_id = arb_id limit 1), cast(arb_id as varchar)) as label,
                count(*) as count
         from messages
         where object_type in ({CAN_OBJECT_TYPES}) and timestamp_us between ? and ?
         group by arb_id
         union all
         select 'eth:' || coalesce(dst_ip,'') || ':' || cast(coalesce(dst_port,0) as varchar) as key,
                'Ethernet' as bus_label,
                coalesce(dst_ip,'?') || ':' || cast(coalesce(dst_port,0) as varchar) as label,
                count(*) as count
         from messages
         where object_type in ({ETHERNET_OBJECT_TYPES}) and timestamp_us between ? and ?
         group by dst_ip, dst_port
         order by 2, 3"
    );
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(duckdb::params![start_us, end_us, start_us, end_us], |row| {
            Ok(MessageGroup {
                key: row.get(0)?,
                bus_label: row.get(1)?,
                label: row.get(2)?,
                count: row.get(3)?,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())
}

fn map_message_row(row: &duckdb::Row) -> duckdb::Result<MessageRow> {
    Ok(MessageRow {
        msg_id: row.get(0)?,
        timestamp_us: row.get(1)?,
        bus_label: row.get(2)?,
        id_or_src: row.get(3)?,
        name: row.get(4)?,
        dlc: row.get(5)?,
        payload_len: row.get(6)?,
    })
}

enum ParsedGroupKey {
    Can { arb_id: i64 },
    Eth { dst_ip: String, dst_port: i32 },
}

fn parse_group_key(group_key: &str) -> Result<ParsedGroupKey, String> {
    if let Some(arb_id) = group_key.strip_prefix("can:") {
        let arb_id: i64 = arb_id
            .parse()
            .map_err(|_| format!("bad group key: {group_key}"))?;
        Ok(ParsedGroupKey::Can { arb_id })
    } else if let Some(rest) = group_key.strip_prefix("eth:") {
        let (dst_ip, dst_port) = rest
            .rsplit_once(':')
            .ok_or_else(|| format!("bad group key: {group_key}"))?;
        let dst_port: i32 = dst_port
            .parse()
            .map_err(|_| format!("bad group key: {group_key}"))?;
        Ok(ParsedGroupKey::Eth {
            dst_ip: dst_ip.to_string(),
            dst_port,
        })
    } else {
        Err(format!("bad group key: {group_key}"))
    }
}

/// Keyset-paginates by `msg_id` across one or more groups (OR). `cursor` is
/// the last `msg_id` already seen (`None` for the first page); the returned
/// `next_cursor` is `None` once the selection is exhausted. Empty
/// `group_keys` yields an empty page (not an error).
pub fn list_messages(
    conn: &trace_store::Connection,
    group_keys: &[String],
    cursor: Option<i64>,
    limit: i64,
    start_us: i64,
    end_us: i64,
) -> Result<MessagePage, String> {
    if group_keys.is_empty() {
        return Ok(MessagePage {
            rows: Vec::new(),
            next_cursor: None,
        });
    }

    let parsed: Vec<ParsedGroupKey> = group_keys
        .iter()
        .map(|k| parse_group_key(k))
        .collect::<Result<Vec<_>, _>>()?;

    let cursor = cursor.unwrap_or(-1);
    let fetch = limit + 1;

    let mut predicates = Vec::with_capacity(parsed.len());
    let mut params: Vec<Box<dyn duckdb::ToSql>> = Vec::new();
    for key in &parsed {
        match key {
            ParsedGroupKey::Can { arb_id } => {
                predicates.push(format!(
                    "(object_type in ({CAN_OBJECT_TYPES}) and arb_id = ?)"
                ));
                params.push(Box::new(*arb_id));
            }
            ParsedGroupKey::Eth { dst_ip, dst_port } => {
                predicates.push(format!(
                    "(object_type in ({ETHERNET_OBJECT_TYPES}) and dst_ip = ? and dst_port = ?)"
                ));
                params.push(Box::new(dst_ip.clone()));
                params.push(Box::new(*dst_port));
            }
        }
    }
    params.push(Box::new(start_us));
    params.push(Box::new(end_us));
    params.push(Box::new(cursor));
    params.push(Box::new(fetch));

    let sql = format!(
        "select msg_id, timestamp_us,
                case when object_type in ({CAN_OBJECT_TYPES}) then 'CAN' else 'Ethernet' end as bus_label,
                case when object_type in ({CAN_OBJECT_TYPES}) then cast(arb_id as varchar)
                     else coalesce(dst_ip,'') || ':' || cast(coalesce(dst_port,0) as varchar) end as id_or_src,
                case when object_type in ({CAN_OBJECT_TYPES})
                     then (select name from arxml_can where can_id = arb_id limit 1)
                     else cast(null as varchar) end as name,
                dlc, payload_len
         from messages
         where ({}) and timestamp_us between ? and ? and msg_id > ?
         order by msg_id
         limit ?",
        predicates.join(" or ")
    );

    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let param_refs: Vec<&dyn duckdb::ToSql> = params.iter().map(|p| p.as_ref()).collect();
    let out = stmt
        .query_map(param_refs.as_slice(), map_message_row)
        .map_err(|e| e.to_string())?;
    let mut rows = out
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;

    let next_cursor = if rows.len() as i64 > limit {
        rows.truncate(limit as usize);
        rows.last().map(|r| r.msg_id)
    } else {
        None
    };
    Ok(MessagePage { rows, next_cursor })
}

pub fn get_message_detail(
    conn: &trace_store::Connection,
    msg_id: i64,
    start_us: i64,
    end_us: i64,
) -> Result<MessageRow, String> {
    let sql = format!(
        "select msg_id, timestamp_us,
                case when object_type in ({CAN_OBJECT_TYPES}) then 'CAN' else 'Ethernet' end as bus_label,
                case when object_type in ({CAN_OBJECT_TYPES}) then cast(arb_id as varchar)
                     else coalesce(dst_ip,'') || ':' || cast(coalesce(dst_port,0) as varchar) end as id_or_src,
                cast(null as varchar) as name,
                dlc, payload_len
         from messages where msg_id = ? and timestamp_us between ? and ?"
    );
    conn.query_row(
        &sql,
        duckdb::params![msg_id, start_us, end_us],
        map_message_row,
    )
    .map_err(|e| format!("message {msg_id} not found: {e}"))
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SignalCatalogEntry {
    pub signal_id: i64,
    pub name: String,
    pub parent_label: String,
    pub decodable: bool,
    pub cached: bool,
    pub samples: i64,
    pub changes: i64,
    pub nonzero: i64,
    pub opaque: bool,
}

/// ARXML signal dictionary joined to Prepare-time `signal_stats` (docs/adr/0005)
/// and to `signals` for cache status. `decodable` means the parent message/PDU
/// was observed at least once (`samples > 0`). Sort pins cached, then live
/// (most-changing) signals to the top of the UI list.
pub fn list_signal_catalog(
    conn: &trace_store::Connection,
) -> Result<Vec<SignalCatalogEntry>, String> {
    let sql = "select s.signal_id, s.name,
                case when s.parent_kind = 'can' then 'CAN ' || cast(s.parent_id as varchar)
                     else 'PDU ' || cast(s.parent_id as varchar) end as parent_label,
                coalesce(st.samples, 0) > 0 as decodable,
                exists (select 1 from signals sig where sig.signal_id = s.signal_id) as cached,
                coalesce(st.samples, 0) as samples,
                coalesce(st.changes, 0) as changes,
                coalesce(st.nonzero, 0) as nonzero,
                coalesce(st.opaque, false) as opaque
         from arxml_signal s
         left join signal_stats st on st.signal_id = s.signal_id
         order by cached desc, changes desc, s.name";
    let mut stmt = conn.prepare(sql).map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |row| {
            Ok(SignalCatalogEntry {
                signal_id: row.get(0)?,
                name: row.get(1)?,
                parent_label: row.get(2)?,
                decodable: row.get(3)?,
                cached: row.get(4)?,
                samples: row.get(5)?,
                changes: row.get(6)?,
                nonzero: row.get(7)?,
                opaque: row.get(8)?,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())
}

/// First `limit` decoded samples for one signal, ordered by time - backs the Signals
/// tab's minimal inline value preview (no charting, docs/adr/0005's "second pass").
pub fn list_signal_samples(
    conn: &trace_store::Connection,
    signal_id: i64,
    limit: i64,
    start_us: i64,
    end_us: i64,
) -> Result<Vec<(i64, f64)>, String> {
    let mut stmt = conn
        .prepare(
            "select timestamp_us, phys_value from signals
             where signal_id = ? and timestamp_us between ? and ?
             order by timestamp_us limit ?",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(duckdb::params![signal_id, start_us, end_us, limit], |row| {
            Ok((row.get(0)?, row.get(1)?))
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())
}

/// Min/Max decimation: groups a signal's samples in `[start_us, end_us]`
/// into `target_points` equal-width time buckets (same bucketing shape as
/// `compute_anomaly_bins`) and keeps each bucket's min- and max-valued
/// sample, chronologically ordered. A bucket with a single row contributes
/// one point, not a duplicate. Preserves outliers/spikes - the Downsampling
/// Algorithm default for every signal (`docs/adr/0009`).
pub fn list_signal_samples_minmax(
    conn: &trace_store::Connection,
    signal_id: i64,
    start_us: i64,
    end_us: i64,
    target_points: i64,
) -> Result<Vec<(i64, f64)>, String> {
    if target_points < 1 {
        return Err("target_points must be >= 1".to_string());
    }
    let (lo, hi) = if start_us <= end_us {
        (start_us, end_us)
    } else {
        (end_us, start_us)
    };
    let sql = format!(
        "with bucketed as (
           select timestamp_us, phys_value,
                  least({target_points} - 1,
                        greatest(0, cast(floor((timestamp_us - {lo})::double * {target_points}
                                               / ({hi} - {lo} + 1)) as bigint))) as bucket
           from signals
           where signal_id = ? and timestamp_us between ? and ?
         )
         select arg_min(timestamp_us, phys_value) as min_ts, min(phys_value) as min_val,
                arg_max(timestamp_us, phys_value) as max_ts, max(phys_value) as max_val
         from bucketed
         group by bucket
         order by bucket"
    );
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(duckdb::params![signal_id, lo, hi], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, f64>(1)?,
                row.get::<_, i64>(2)?,
                row.get::<_, f64>(3)?,
            ))
        })
        .map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for r in rows {
        let (min_ts, min_val, max_ts, max_val) = r.map_err(|e| e.to_string())?;
        match min_ts.cmp(&max_ts) {
            std::cmp::Ordering::Equal => out.push((min_ts, min_val)),
            std::cmp::Ordering::Less => {
                out.push((min_ts, min_val));
                out.push((max_ts, max_val));
            }
            std::cmp::Ordering::Greater => {
                out.push((max_ts, max_val));
                out.push((min_ts, min_val));
            }
        }
    }
    Ok(out)
}

/// Largest-Triangle-Three-Buckets downsampling (Sveinn Steinarsson, 2013).
/// Always keeps the first and last point. `target_points == 0` or `>= n`
/// returns the input unchanged; `target_points < 3` (with `n >= 2`) returns
/// just the first and last point, since LTTB's triangle-area selection needs
/// at least one point strictly between the two fixed endpoints.
pub fn lttb_downsample(points: &[(i64, f64)], target_points: usize) -> Vec<(i64, f64)> {
    let n = points.len();
    if target_points == 0 || target_points >= n || n <= 2 {
        return points.to_vec();
    }
    if target_points < 3 {
        return vec![points[0], points[n - 1]];
    }

    let mut sampled = Vec::with_capacity(target_points);
    sampled.push(points[0]);

    // Bucket size for the *middle* points only - first/last are fixed.
    let bucket_size = (n - 2) as f64 / (target_points - 2) as f64;
    let mut a = 0usize; // index of the last point actually selected

    for i in 0..(target_points - 2) {
        let bucket_start = ((i as f64) * bucket_size) as usize + 1;
        let bucket_end = ((((i + 1) as f64) * bucket_size) as usize + 1)
            .min(n - 1)
            .max(bucket_start + 1);

        let next_start = bucket_end;
        let next_end = ((((i + 2) as f64) * bucket_size) as usize + 1)
            .min(n)
            .max(next_start + 1);
        let slice = &points[next_start..next_end];
        let len = slice.len() as f64;
        let (avg_x, avg_y) = (
            slice.iter().map(|p| p.0 as f64).sum::<f64>() / len,
            slice.iter().map(|p| p.1).sum::<f64>() / len,
        );

        let (ax, ay) = (points[a].0 as f64, points[a].1);
        let mut best_area = -1.0;
        let mut best_idx = bucket_start;
        for idx in bucket_start..bucket_end {
            let (bx, by) = (points[idx].0 as f64, points[idx].1);
            let area = ((ax - avg_x) * (by - ay) - (ax - bx) * (avg_y - ay)).abs();
            if area > best_area {
                best_area = area;
                best_idx = idx;
            }
        }
        sampled.push(points[best_idx]);
        a = best_idx;
    }
    sampled.push(points[n - 1]);
    sampled
}

/// LTTB over a capped raw-row fetch - reuses `list_signal_samples`'s
/// existing `ORDER BY timestamp_us LIMIT` as the raw source, capped at
/// `LOD.detector_query_match_limit` (`config/config.json`) for the same
/// reason the Detector Query match extract is capped there (`docs/adr/0009`
/// decision 2).
pub fn list_signal_samples_lttb(
    conn: &trace_store::Connection,
    signal_id: i64,
    start_us: i64,
    end_us: i64,
    target_points: i64,
) -> Result<Vec<(i64, f64)>, String> {
    let raw = list_signal_samples(
        conn,
        signal_id,
        LOD.detector_query_match_limit,
        start_us,
        end_us,
    )?;
    Ok(lttb_downsample(&raw, target_points.max(0) as usize))
}

/// Dispatches to the signal's chosen Downsampling Algorithm - the one
/// function the Tauri `get_signal_samples` command calls.
pub fn list_signal_samples_for_viewport(
    conn: &trace_store::Connection,
    signal_id: i64,
    start_us: i64,
    end_us: i64,
    target_points: i64,
    algorithm: DownsamplingAlgorithm,
) -> Result<Vec<(i64, f64)>, String> {
    match algorithm {
        DownsamplingAlgorithm::MinMax => {
            list_signal_samples_minmax(conn, signal_id, start_us, end_us, target_points)
        }
        DownsamplingAlgorithm::Lttb => {
            list_signal_samples_lttb(conn, signal_id, start_us, end_us, target_points)
        }
    }
}

pub fn list_ecus(conn: &trace_store::Connection) -> Result<Vec<String>, String> {
    let mut stmt = conn
        .prepare("select name from arxml_ecu order by name")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TraceTimeRange {
    pub min_timestamp_us: i64,
    pub max_timestamp_us: i64,
}

/// The trace's overall time span (first/last `messages.timestamp_us`) - the
/// shared x-axis domain every Timeline chart (SignalChart, MatchLane) pins
/// to, instead of each auto-scaling to its own series' data extent. Errors
/// on an empty `messages` table (no range to report).
pub fn get_trace_time_range(conn: &trace_store::Connection) -> Result<TraceTimeRange, String> {
    conn.query_row(
        "select min(timestamp_us), max(timestamp_us) from messages",
        [],
        |row| Ok((row.get::<_, Option<i64>>(0)?, row.get::<_, Option<i64>>(1)?)),
    )
    .map_err(|e| e.to_string())
    .and_then(|(min, max)| match (min, max) {
        (Some(min_timestamp_us), Some(max_timestamp_us)) => Ok(TraceTimeRange {
            min_timestamp_us,
            max_timestamp_us,
        }),
        _ => Err("messages table is empty - no time range to report".to_string()),
    })
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DetectorMatch {
    pub msg_id: i64,
    pub timestamp_us: i64,
}

/// One of 500 equal-width bins over a Detector Query's run scope. Only active
/// bins (count > 0) are returned. `start_us`/`end_us` are the bin's absolute
/// time bounds so the UI never re-derives them.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AnomalyBin {
    pub bin: i64,
    pub count: i64,
    pub first_msg_id: i64,
    pub first_timestamp_us: i64,
    pub start_us: i64,
    pub end_us: i64,
}

/// A target signal whose `signal_coverage` does not fully cover the requested
/// `[need_start_us, need_end_us]` scope - returned by
/// [`missing_signal_coverage`] so the UI can confirm a decode before running.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MissingSignal {
    pub signal_id: i64,
    pub name: String,
    pub need_start_us: i64,
    pub need_end_us: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DetectorQueryResult {
    pub matches: Vec<DetectorMatch>,
    pub truncated: bool,
    pub bins: Vec<AnomalyBin>,
    pub scope_start_us: i64,
    pub scope_end_us: i64,
}

/// Absolute `[start, end]` bounds for bin `bin` (0-based) over
/// `[scope_start, scope_end]`. The last bin always ends at `scope_end`.
pub fn anomaly_bin_bounds(
    bin: i64,
    scope_start_us: i64,
    scope_end_us: i64,
    bin_count: i64,
) -> (i64, i64) {
    let denom = (scope_end_us - scope_start_us).saturating_add(1);
    let start = scope_start_us + (bin * denom) / bin_count;
    let end = if bin >= bin_count - 1 {
        scope_end_us
    } else {
        // Next bin's start minus one. When the scope is narrower than
        // `bin_count` microseconds some early bins share the same start;
        // clamp so end never falls below start.
        let next_start = scope_start_us + ((bin + 1) * denom) / bin_count;
        next_start.saturating_sub(1).max(start)
    };
    (start, end)
}

/// Returns every `target_ids` entry whose `signal_coverage` is missing or
/// does not fully cover `[start_us, end_us]`. Empty `target_ids` → empty Vec
/// (protocol-only queries need no decode precondition). Duplicate ids are
/// reported once.
pub fn missing_signal_coverage(
    conn: &trace_store::Connection,
    target_ids: &[i64],
    start_us: i64,
    end_us: i64,
) -> Result<Vec<MissingSignal>, String> {
    if target_ids.is_empty() {
        return Ok(Vec::new());
    }
    let (lo, hi) = if start_us <= end_us {
        (start_us, end_us)
    } else {
        (end_us, start_us)
    };
    let coverage: std::collections::HashMap<i64, (i64, i64)> = list_signal_coverage(conn)?
        .into_iter()
        .map(|c| (c.signal_id, (c.start_us, c.end_us)))
        .collect();
    let mut seen = std::collections::HashSet::new();
    let mut missing = Vec::new();
    for &id in target_ids {
        if !seen.insert(id) {
            continue;
        }
        let ok = coverage
            .get(&id)
            .map(|&(cs, ce)| cs <= lo && ce >= hi)
            .unwrap_or(false);
        if ok {
            continue;
        }
        let name = conn
            .query_row(
                "select name from arxml_signal where signal_id = ?",
                [id],
                |row| row.get::<_, String>(0),
            )
            .unwrap_or_else(|_| format!("signal {id}"));
        missing.push(MissingSignal {
            signal_id: id,
            name,
            need_start_us: lo,
            need_end_us: hi,
        });
    }
    Ok(missing)
}

fn normalize_detector_sql(sql: &str) -> Result<String, String> {
    let trimmed = sql.trim();
    let trimmed = trimmed.strip_suffix(';').unwrap_or(trimmed).trim();
    if trimmed.is_empty() {
        return Err("query is empty".to_string());
    }
    Ok(trimmed.to_string())
}

/// Scoped subquery shared by the Match extract and the anomaly-bin aggregate.
/// The trailing newline keeps a trailing `--` line comment from swallowing
/// the wrapper suffix.
fn detector_scoped_sql(trimmed: &str, start_us: i64, end_us: i64) -> String {
    format!(
        "select * from ({trimmed}\n) as detector_query_user_sql
         where timestamp_us between {start_us} and {end_us}"
    )
}

/// Groups scoped Detector Query rows into `LOD.anomaly_bin_count`
/// (`config/config.json`) equal-width bins. Only active bins are returned.
/// Runs the user SQL once (separate from
/// the Match extract - DuckDB read-only connections cannot create TEMP tables
/// to share the result set).
pub fn compute_anomaly_bins(
    conn: &trace_store::Connection,
    sql: &str,
    start_us: i64,
    end_us: i64,
    bin_count: i64,
) -> Result<Vec<AnomalyBin>, String> {
    let trimmed = normalize_detector_sql(sql)?;
    let (lo, hi) = if start_us <= end_us {
        (start_us, end_us)
    } else {
        (end_us, start_us)
    };
    if bin_count < 1 {
        return Err("bin_count must be >= 1".to_string());
    }
    let scoped = detector_scoped_sql(&trimmed, lo, hi);
    // Clamp the floor expression into [0, bin_count-1] so a floating-point
    // edge at hi never lands in bin `bin_count`.
    let bins_sql = format!(
        "select
           least({bin_count} - 1,
                 greatest(0, cast(floor((timestamp_us - {lo})::double * {bin_count}
                                        / ({hi} - {lo} + 1)) as bigint))) as bin,
           count(*)::bigint as cnt,
           arg_min(msg_id, timestamp_us) as first_msg_id,
           min(timestamp_us) as first_timestamp_us
         from ({scoped}) as detector_query_binned
         group by 1
         order by 1"
    );
    let mut stmt = conn.prepare(&bins_sql).map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |row| {
            let bin: i64 = row.get(0)?;
            let count: i64 = row.get(1)?;
            let first_msg_id: i64 = row.get(2)?;
            let first_timestamp_us: i64 = row.get(3)?;
            let (start_us, end_us) = anomaly_bin_bounds(bin, lo, hi, bin_count);
            Ok(AnomalyBin {
                bin,
                count,
                first_msg_id,
                first_timestamp_us,
                start_us,
                end_us,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())
}

/// Runs a user-authored Detector Query and extracts just `msg_id` /
/// `timestamp_us` from its result, for plotting as Matches on the Timeline,
/// plus the 500-bin anomaly segmentation over the same scope.
/// The query is run read-only (the connection itself is opened read-only) and
/// wrapped as a subquery rather than string-validated, so DuckDB's own
/// binder error - not custom validation code - is what reports a missing
/// required column.
pub fn run_detector_query(
    conn: &trace_store::Connection,
    sql: &str,
    limit: i64,
    start_us: i64,
    end_us: i64,
) -> Result<DetectorQueryResult, String> {
    let trimmed = normalize_detector_sql(sql)?;
    let (lo, hi) = if start_us <= end_us {
        (start_us, end_us)
    } else {
        (end_us, start_us)
    };
    // A trailing `--` line comment in the user's SQL would otherwise swallow
    // the `) as detector_query_result limit N` suffix appended on the same
    // line - the newline before the closing paren keeps that suffix outside
    // any comment the user's query ends with. start_us/end_us are interpolated
    // as literals (not bound params) since they're Rust-generated i64 values,
    // never user text - same trust boundary as the `limit + 1` interpolation
    // below.
    let scoped = detector_scoped_sql(&trimmed, lo, hi);
    let wrapped = format!(
        "select msg_id, timestamp_us from ({scoped}) as detector_query_result limit {}",
        limit + 1
    );
    let mut stmt = conn.prepare(&wrapped).map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |row| {
            Ok(DetectorMatch {
                msg_id: row.get(0)?,
                timestamp_us: row.get(1)?,
            })
        })
        .map_err(|e| e.to_string())?;
    let mut matches = rows
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    let truncated = matches.len() as i64 > limit;
    if truncated {
        matches.truncate(limit as usize);
    }
    // Second pass for bins - TEMP tables are unavailable on the read-only
    // Trace Store connection (AccessMode::ReadOnly). Acceptable for MVP.
    let bins = compute_anomaly_bins(conn, &trimmed, lo, hi, LOD.anomaly_bin_count)?;
    Ok(DetectorQueryResult {
        matches,
        truncated,
        bins,
        scope_start_us: lo,
        scope_end_us: hi,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use trace_store::Connection;

    #[test]
    fn lod_tier_point_budget_snaps_to_power_of_two() {
        assert_eq!(lod_tier_point_budget(400), 1024); // 400*2=800 -> next pow2 1024
        assert_eq!(lod_tier_point_budget(1), 16); // clamped to the minimum tier
    }

    #[test]
    fn lod_tier_point_budget_clamps_nonpositive_width_to_minimum() {
        assert_eq!(lod_tier_point_budget(0), LOD.min_lod_target_points);
        assert_eq!(lod_tier_point_budget(-50), LOD.min_lod_target_points);
    }

    #[test]
    fn lod_tier_point_budget_clamps_runaway_width_to_maximum() {
        assert_eq!(lod_tier_point_budget(1_000_000), LOD.max_lod_target_points);
    }

    #[test]
    fn lod_tier_point_budget_is_stable_within_a_tier() {
        // Two widths that both map to the same power-of-two tier must produce
        // the identical budget, so repeated requests at a similar zoom reuse it.
        assert_eq!(lod_tier_point_budget(260), lod_tier_point_budget(300));
    }

    #[test]
    fn list_signal_samples_lttb_reduces_to_target_points() {
        let conn = setup();
        conn.execute_batch(
            "INSERT INTO arxml_signal VALUES (0, 'EngineRpm', 'can', 100, 0, 16, false, 0.25, 0.0);",
        )
        .unwrap();
        for i in 0..200i64 {
            conn.execute(
                "INSERT INTO signals VALUES (0, 0, ?, 0, ?)",
                duckdb::params![i * 1000, i as f64],
            )
            .unwrap();
        }
        let out = list_signal_samples_lttb(&conn, 0, 0, 199_000, 20).unwrap();
        assert_eq!(out.len(), 20);
        assert_eq!(out[0], (0, 0.0));
        assert_eq!(out[19], (199_000, 199.0));
    }

    #[test]
    fn list_signal_samples_for_viewport_dispatches_minmax() {
        let conn = setup();
        conn.execute_batch(
            "INSERT INTO arxml_signal VALUES (0, 'EngineRpm', 'can', 100, 0, 16, false, 0.25, 0.0);
             INSERT INTO signals VALUES (0, 0, 1000, 0, 50.0);
             INSERT INTO signals VALUES (0, 0, 1100, 0, 200.0);",
        )
        .unwrap();
        let out = list_signal_samples_for_viewport(
            &conn,
            0,
            1000,
            1100,
            1,
            DownsamplingAlgorithm::MinMax,
        )
        .unwrap();
        assert_eq!(out.len(), 2);
    }

    #[test]
    fn list_signal_samples_for_viewport_dispatches_lttb() {
        let conn = setup();
        conn.execute_batch(
            "INSERT INTO arxml_signal VALUES (0, 'EngineRpm', 'can', 100, 0, 16, false, 0.25, 0.0);",
        )
        .unwrap();
        for i in 0..50i64 {
            conn.execute(
                "INSERT INTO signals VALUES (0, 0, ?, 0, ?)",
                duckdb::params![i * 1000, i as f64],
            )
            .unwrap();
        }
        let out =
            list_signal_samples_for_viewport(&conn, 0, 0, 49_000, 10, DownsamplingAlgorithm::Lttb)
                .unwrap();
        assert_eq!(out.len(), 10);
    }

    #[test]
    fn lttb_downsample_keeps_first_and_last_point() {
        let points: Vec<(i64, f64)> = (0..100).map(|i| (i * 1000, (i as f64).sin())).collect();
        let out = lttb_downsample(&points, 10);
        assert_eq!(out.first(), points.first());
        assert_eq!(out.last(), points.last());
    }

    #[test]
    fn lttb_downsample_returns_exactly_target_points_when_input_is_larger() {
        let points: Vec<(i64, f64)> = (0..1000).map(|i| (i * 1000, i as f64)).collect();
        let out = lttb_downsample(&points, 50);
        assert_eq!(out.len(), 50);
    }

    #[test]
    fn lttb_downsample_preserves_monotonic_timestamps() {
        let points: Vec<(i64, f64)> = (0..500).map(|i| (i * 1000, (i as f64).cos())).collect();
        let out = lttb_downsample(&points, 37);
        for pair in out.windows(2) {
            assert!(
                pair[0].0 < pair[1].0,
                "timestamps must stay strictly increasing: {pair:?}"
            );
        }
    }

    #[test]
    fn lttb_downsample_returns_input_unchanged_when_target_exceeds_input_len() {
        let points = vec![(0, 1.0), (1000, 2.0), (2000, 3.0)];
        assert_eq!(lttb_downsample(&points, 100), points);
    }

    #[test]
    fn lttb_downsample_empty_input_returns_empty() {
        assert_eq!(lttb_downsample(&[], 50), Vec::<(i64, f64)>::new());
    }

    #[test]
    fn lttb_downsample_single_point_input_returns_that_point() {
        let points = vec![(42, 3.14)];
        assert_eq!(lttb_downsample(&points, 50), points);
    }

    #[test]
    fn lttb_downsample_two_point_input_returns_both() {
        let points = vec![(0, 1.0), (1000, 2.0)];
        assert_eq!(lttb_downsample(&points, 50), points);
    }

    #[test]
    fn lttb_downsample_target_below_three_keeps_endpoints_only() {
        let points: Vec<(i64, f64)> = (0..20).map(|i| (i * 1000, i as f64)).collect();
        let out = lttb_downsample(&points, 2);
        assert_eq!(out, vec![points[0], points[19]]);
    }

    #[test]
    fn lttb_downsample_target_zero_returns_all_points_unchanged() {
        let points = vec![(0, 1.0), (1000, 2.0), (2000, 3.0)];
        assert_eq!(lttb_downsample(&points, 0), points);
    }

    #[test]
    fn list_signal_samples_minmax_keeps_extremes_per_bucket() {
        let conn = setup();
        conn.execute_batch(
            "INSERT INTO arxml_signal VALUES (0, 'EngineRpm', 'can', 100, 0, 16, false, 0.25, 0.0);
             INSERT INTO signals VALUES (0, 0, 1000, 0, 50.0);
             INSERT INTO signals VALUES (0, 0, 1100, 0, 200.0);
             INSERT INTO signals VALUES (0, 0, 1200, 0, 10.0);",
        )
        .unwrap();
        // One wide bucket covering all three samples: min=10 at 1200, max=200 at 1100.
        let out = list_signal_samples_minmax(&conn, 0, 1000, 1200, 1).unwrap();
        assert_eq!(out.len(), 2, "both extremes kept, chronologically ordered");
        assert_eq!(out[0], (1100, 200.0));
        assert_eq!(out[1], (1200, 10.0));
    }

    #[test]
    fn list_signal_samples_minmax_single_row_bucket_is_not_duplicated() {
        let conn = setup();
        conn.execute_batch(
            "INSERT INTO arxml_signal VALUES (0, 'EngineRpm', 'can', 100, 0, 16, false, 0.25, 0.0);
             INSERT INTO signals VALUES (0, 0, 1000, 0, 42.0);",
        )
        .unwrap();
        let out = list_signal_samples_minmax(&conn, 0, 1000, 1000, 500).unwrap();
        assert_eq!(out, vec![(1000, 42.0)]);
    }

    #[test]
    fn list_signal_samples_minmax_empty_range_returns_empty() {
        let conn = setup();
        conn.execute_batch(
            "INSERT INTO arxml_signal VALUES (0, 'EngineRpm', 'can', 100, 0, 16, false, 0.25, 0.0);
             INSERT INTO signals VALUES (0, 0, 9000, 0, 42.0);",
        )
        .unwrap();
        // Signal has samples, but none inside [0, 100] - must not panic, just empty.
        let out = list_signal_samples_minmax(&conn, 0, 0, 100, 500).unwrap();
        assert!(out.is_empty());
    }

    #[test]
    fn list_signal_samples_minmax_rejects_nonpositive_target_points() {
        let conn = setup();
        assert!(list_signal_samples_minmax(&conn, 0, 0, 1000, 0).is_err());
    }

    #[test]
    fn list_signal_samples_minmax_respects_many_buckets() {
        let conn = setup();
        conn.execute_batch(
            "INSERT INTO arxml_signal VALUES (0, 'EngineRpm', 'can', 100, 0, 16, false, 0.25, 0.0);
             INSERT INTO signals VALUES (0, 0, 0, 0, 1.0);
             INSERT INTO signals VALUES (0, 0, 1000, 0, 2.0);
             INSERT INTO signals VALUES (0, 0, 2000, 0, 3.0);",
        )
        .unwrap();
        // 3 buckets over [0,2000] each containing exactly one sample.
        let out = list_signal_samples_minmax(&conn, 0, 0, 2000, 3).unwrap();
        assert_eq!(out, vec![(0, 1.0), (1000, 2.0), (2000, 3.0)]);
    }

    #[test]
    fn count_returns_row_count() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("CREATE TABLE t (x INTEGER); INSERT INTO t VALUES (1), (2), (3);")
            .unwrap();
        assert_eq!(count(&conn, "select count(*) from t").unwrap(), 3);
    }

    #[test]
    fn count_surfaces_sql_errors() {
        let conn = Connection::open_in_memory().unwrap();
        assert!(count(&conn, "select count(*) from no_such_table").is_err());
    }

    fn setup() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE messages (msg_id BIGINT, timestamp_us BIGINT, object_type INTEGER, arb_id INTEGER, dst_ip VARCHAR, dst_port INTEGER, dlc INTEGER, payload_len INTEGER);
             CREATE TABLE arxml_can (can_id BIGINT, name VARCHAR);
             CREATE TABLE arxml_ecu (name VARCHAR);
             CREATE TABLE protocol_pdu (msg_id BIGINT, pdu_id BIGINT, length BIGINT);
             CREATE TABLE arxml_signal (signal_id BIGINT, name VARCHAR, parent_kind VARCHAR, parent_id BIGINT, start_bit INTEGER, bit_length INTEGER, big_endian BOOLEAN, factor DOUBLE, \"offset\" DOUBLE);
             CREATE TABLE signals (signal_id BIGINT, msg_id BIGINT, timestamp_us BIGINT, raw_value UBIGINT, phys_value DOUBLE);
             CREATE TABLE signal_stats (signal_id BIGINT PRIMARY KEY, samples BIGINT, nonzero BIGINT, changes BIGINT, min_raw UBIGINT, max_raw UBIGINT, first_ts_us BIGINT, last_ts_us BIGINT, opaque BOOLEAN);
             INSERT INTO arxml_can VALUES (100, 'EngineSpeed');
             -- Contiguous msg_id 0..n-1 matches Prepare (resolve_message_range uses BETWEEN).
             INSERT INTO messages VALUES (0, 1000, 1, 100, NULL, NULL, 8, 8);
             INSERT INTO messages VALUES (1, 2000, 1, 100, NULL, NULL, 8, 8);
             INSERT INTO messages VALUES (2, 3000, 1, 200, NULL, NULL, 4, 4);
             INSERT INTO messages VALUES (3, 4000, 71, NULL, '10.0.0.1', 30509, NULL, 64);",
        )
        .unwrap();
        conn
    }

    #[test]
    fn list_message_groups_aggregates_by_bus_and_id() {
        let conn = setup();
        let groups = list_message_groups(&conn, 0, 10_000).unwrap();
        let named = groups.iter().find(|g| g.key == "can:100").unwrap();
        assert_eq!(named.label, "EngineSpeed");
        assert_eq!(named.count, 2);
        let unnamed = groups.iter().find(|g| g.key == "can:200").unwrap();
        assert_eq!(unnamed.label, "200");
        let eth = groups
            .iter()
            .find(|g| g.key == "eth:10.0.0.1:30509")
            .unwrap();
        assert_eq!(eth.count, 1);
    }

    #[test]
    fn list_messages_paginates_with_keyset_cursor() {
        let conn = setup();
        let keys = vec!["can:100".to_string()];
        let page1 = list_messages(&conn, &keys, None, 1, 0, 10_000).unwrap();
        assert_eq!(page1.rows.len(), 1);
        assert_eq!(page1.rows[0].msg_id, 0);
        assert_eq!(page1.next_cursor, Some(0));

        let page2 = list_messages(&conn, &keys, page1.next_cursor, 1, 0, 10_000).unwrap();
        assert_eq!(page2.rows.len(), 1);
        assert_eq!(page2.rows[0].msg_id, 1);
        assert_eq!(
            page2.next_cursor, None,
            "last page must not return a cursor"
        );
    }

    #[test]
    fn list_messages_rejects_unrecognized_group_key() {
        let conn = setup();
        assert!(list_messages(&conn, &["bogus:1".to_string()], None, 10, 0, 10_000).is_err());
    }

    #[test]
    fn list_messages_empty_keys_returns_empty_page() {
        let conn = setup();
        let page = list_messages(&conn, &[], None, 10, 0, 10_000).unwrap();
        assert!(page.rows.is_empty());
        assert_eq!(page.next_cursor, None);
    }

    #[test]
    fn list_messages_ors_multiple_group_keys() {
        let conn = setup();
        let keys = vec!["can:100".to_string(), "can:200".to_string()];
        let page = list_messages(&conn, &keys, None, 10, 0, 10_000).unwrap();
        let ids: Vec<i64> = page.rows.iter().map(|r| r.msg_id).collect();
        assert!(ids.contains(&0), "can:100 rows present");
        assert!(ids.len() >= 2, "OR across groups returns rows from both");
    }

    #[test]
    fn get_message_detail_returns_row_by_id() {
        let conn = setup();
        let detail = get_message_detail(&conn, 0, 0, 10_000).unwrap();
        assert_eq!(detail.bus_label, "CAN");
        assert_eq!(detail.id_or_src, "100");
    }

    #[test]
    fn get_message_detail_errors_when_missing() {
        let conn = setup();
        assert!(get_message_detail(&conn, 999, 0, 10_000).is_err());
    }

    #[test]
    fn get_message_detail_errors_when_outside_trim_bound() {
        let conn = setup();
        // msg_id 0 is at timestamp_us 1000 - a bound of [2000, 4000] excludes it.
        assert!(get_message_detail(&conn, 0, 2000, 4000).is_err());
    }

    #[test]
    fn count_messages_returns_total_row_count() {
        let conn = setup();
        assert_eq!(count_messages(&conn).unwrap(), 4);
    }

    #[test]
    fn count_messages_in_range_counts_inclusive_window() {
        let conn = setup();
        assert_eq!(count_messages_in_range(&conn, 2000, 3000).unwrap(), 2);
        assert_eq!(count_messages_in_range(&conn, 3000, 1000).unwrap(), 3);
        assert_eq!(count_messages_in_range(&conn, 5000, 6000).unwrap(), 0);
    }

    #[test]
    fn list_container_index_returns_rows_in_ord_order() {
        let conn = setup();
        conn.execute_batch(
            "CREATE TABLE container_index (
               container_ord BIGINT PRIMARY KEY,
               byte_offset BIGINT,
               first_ts_us BIGINT,
               last_ts_us BIGINT,
               first_msg_id BIGINT,
               decoded BOOLEAN DEFAULT false
             );
             INSERT INTO container_index VALUES (1, 200, 3000, 4000, 2, true);
             INSERT INTO container_index VALUES (0, 100, 1000, 2000, 0, false);",
        )
        .unwrap();
        let rows = list_container_index(&conn).unwrap();
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].container_ord, 0);
        assert!(!rows[0].decoded);
        assert_eq!(rows[1].container_ord, 1);
        assert!(rows[1].decoded);
        assert_eq!(rows[1].first_msg_id, 2);
    }

    #[test]
    fn list_signal_coverage_returns_extents() {
        let conn = setup();
        conn.execute_batch(
            "CREATE TABLE signal_coverage (signal_id BIGINT PRIMARY KEY, start_us BIGINT, end_us BIGINT);
             INSERT INTO signal_coverage VALUES (7, 1000, 2000);
             INSERT INTO signal_coverage VALUES (3, 3000, 4000);",
        )
        .unwrap();
        let rows = list_signal_coverage(&conn).unwrap();
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].signal_id, 3);
        assert_eq!(rows[1].end_us, 2000);
    }

    #[test]
    fn resolve_message_position_maps_first_and_last_position() {
        let conn = setup();
        assert_eq!(
            resolve_message_position(&conn, 1).unwrap(),
            1000,
            "position 1 is the earliest message"
        );
        assert_eq!(
            resolve_message_position(&conn, 4).unwrap(),
            4000,
            "position 4 is the latest message"
        );
    }

    #[test]
    fn resolve_message_position_errors_when_out_of_range() {
        let conn = setup();
        assert!(resolve_message_position(&conn, 5).is_err());
    }

    #[test]
    fn resolve_message_position_rejects_position_below_one() {
        let conn = setup();
        assert!(resolve_message_position(&conn, 0).is_err());
    }

    #[test]
    fn resolve_message_range_uses_min_max_over_slice() {
        let conn = setup();
        assert_eq!(resolve_message_range(&conn, 1, 4).unwrap(), (1000, 4000));
        assert_eq!(resolve_message_range(&conn, 2, 3).unwrap(), (2000, 3000));
        assert_eq!(
            resolve_message_range(&conn, 3, 2).unwrap(),
            (2000, 3000),
            "swapped endpoints normalize"
        );
    }

    #[test]
    fn resolve_message_range_survives_trailing_zero_timestamp() {
        let conn = setup();
        // MFK5-style: last LOBJ is timestamp 0. Endpoint-only resolve of 1..=5
        // would yield (1000, 0) inverted; min/max over the slice stays sane.
        conn.execute(
            "INSERT INTO messages VALUES (4, 0, 1, 100, NULL, NULL, 8, 8)",
            [],
        )
        .unwrap();
        assert_eq!(resolve_message_position(&conn, 5).unwrap(), 0);
        assert_eq!(resolve_message_range(&conn, 1, 5).unwrap(), (0, 4000));
        // Endpoint-only would be (1000, 0); min/max over the slice is correct.
        assert_ne!(
            (
                resolve_message_position(&conn, 1).unwrap(),
                resolve_message_position(&conn, 5).unwrap()
            ),
            resolve_message_range(&conn, 1, 5).unwrap()
        );
    }

    #[test]
    fn list_ecus_returns_sorted_names() {
        let conn = setup();
        conn.execute_batch("INSERT INTO arxml_ecu VALUES ('Gateway'), ('BodyControl');")
            .unwrap();
        let ecus = list_ecus(&conn).unwrap();
        assert_eq!(ecus, vec!["BodyControl".to_string(), "Gateway".to_string()]);
    }

    #[test]
    fn list_ecus_returns_empty_vec_when_no_ecus() {
        let conn = setup();
        assert_eq!(list_ecus(&conn).unwrap(), Vec::<String>::new());
    }

    #[test]
    fn list_signal_catalog_reports_decodable_and_cached_flags() {
        let conn = setup();
        conn.execute_batch(
            "INSERT INTO arxml_signal VALUES (0, 'EngineRpm', 'can', 100, 0, 16, false, 0.25, 0.0);
             INSERT INTO arxml_signal VALUES (1, 'GhostSignal', 'can', 999, 0, 8, false, 1.0, 0.0);
             INSERT INTO protocol_pdu VALUES (3, 42, 64);
             INSERT INTO arxml_signal VALUES (2, 'PduSignal', 'pdu', 42, 0, 8, false, 1.0, 0.0);
             INSERT INTO signals VALUES (0, 0, 1000, 513, 128.25);
             INSERT INTO signal_stats VALUES (0, 10, 8, 3, 1, 99, 1000, 9000, false);
             INSERT INTO signal_stats VALUES (1, 0, 0, 0, NULL, NULL, NULL, NULL, false);
             INSERT INTO signal_stats VALUES (2, 5, 5, 4, 1, 7, 4000, 8000, false);",
        )
        .unwrap();
        let catalog = list_signal_catalog(&conn).unwrap();

        let engine = catalog.iter().find(|s| s.signal_id == 0).unwrap();
        assert_eq!(engine.parent_label, "CAN 100");
        assert!(engine.decodable, "EngineRpm samples > 0");
        assert!(engine.cached, "EngineRpm has a row in signals");
        assert_eq!(engine.changes, 3);

        let ghost = catalog.iter().find(|s| s.signal_id == 1).unwrap();
        assert!(!ghost.decodable, "GhostSignal samples == 0");
        assert!(!ghost.cached);

        let pdu = catalog.iter().find(|s| s.signal_id == 2).unwrap();
        assert_eq!(pdu.parent_label, "PDU 42");
        assert!(pdu.decodable, "PduSignal samples > 0");
        assert_eq!(pdu.changes, 4);

        // cached signal sorts first, then by changes desc.
        assert_eq!(catalog[0].signal_id, 0);
    }

    #[test]
    fn get_trace_time_range_returns_min_and_max_message_timestamp() {
        let conn = setup();
        let range = get_trace_time_range(&conn).unwrap();
        assert_eq!(range.min_timestamp_us, 1000);
        assert_eq!(range.max_timestamp_us, 4000);
    }

    #[test]
    fn get_trace_time_range_errors_on_empty_messages_table() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("CREATE TABLE messages (msg_id BIGINT, timestamp_us BIGINT);")
            .unwrap();
        assert!(get_trace_time_range(&conn).is_err());
    }

    #[test]
    fn list_message_groups_respects_time_bound() {
        let conn = setup();
        let groups = list_message_groups(&conn, 1000, 2000).unwrap();
        // can:200 is at timestamp_us=3000, outside the bound - must be excluded.
        assert!(groups.iter().all(|g| g.key != "can:200"));
        let can100 = groups.iter().find(|g| g.key == "can:100").unwrap();
        assert_eq!(
            can100.count, 2,
            "both can:100 rows (1000, 2000) are inside the bound"
        );
    }

    #[test]
    fn list_messages_respects_time_bound() {
        let conn = setup();
        let page = list_messages(&conn, &["can:100".to_string()], None, 10, 1000, 1000).unwrap();
        assert_eq!(
            page.rows.len(),
            1,
            "only the msg_id=0 row at timestamp_us=1000 is inside [1000,1000]"
        );
        assert_eq!(page.rows[0].msg_id, 0);
    }

    #[test]
    fn list_signal_samples_respects_time_bound() {
        let conn = setup();
        conn.execute_batch(
            "INSERT INTO arxml_signal VALUES (0, 'EngineRpm', 'can', 100, 0, 16, false, 0.25, 0.0);
             INSERT INTO signals VALUES (0, 0, 1000, 513, 128.25);
             INSERT INTO signals VALUES (0, 1, 2000, 600, 150.0);",
        )
        .unwrap();
        let samples = list_signal_samples(&conn, 0, 10, 1500, 2500).unwrap();
        assert_eq!(
            samples,
            vec![(2000, 150.0)],
            "only the 2000us sample is inside [1500,2500]"
        );
    }

    #[test]
    fn run_detector_query_respects_time_bound() {
        let conn = setup();
        let result = run_detector_query(
            &conn,
            "select msg_id, timestamp_us from messages",
            10,
            1000,
            2000,
        )
        .unwrap();
        assert_eq!(
            result.matches.len(),
            2,
            "only timestamp_us 1000 and 2000 are inside the bound"
        );
        assert!(result
            .matches
            .iter()
            .all(|m| m.timestamp_us >= 1000 && m.timestamp_us <= 2000));
    }

    #[test]
    fn run_detector_query_returns_matching_rows() {
        let conn = setup();
        let result = run_detector_query(
            &conn,
            "select msg_id, timestamp_us from messages where arb_id = 100",
            10,
            0,
            10_000,
        )
        .unwrap();
        assert_eq!(result.matches.len(), 2);
        assert_eq!(result.matches[0].msg_id, 0);
        assert_eq!(result.matches[0].timestamp_us, 1000);
        assert!(!result.truncated);
    }

    #[test]
    fn run_detector_query_truncates_at_limit_and_reports_it() {
        let conn = setup();
        let result = run_detector_query(
            &conn,
            "select msg_id, timestamp_us from messages",
            2,
            0,
            10_000,
        )
        .unwrap();
        assert_eq!(
            result.matches.len(),
            2,
            "capped to the limit, not the full 4 rows"
        );
        assert!(result.truncated);
    }

    #[test]
    fn run_detector_query_does_not_truncate_when_exactly_at_limit() {
        let conn = setup();
        let result = run_detector_query(
            &conn,
            "select msg_id, timestamp_us from messages",
            4,
            0,
            10_000,
        )
        .unwrap();
        assert_eq!(result.matches.len(), 4);
        assert!(!result.truncated, "exactly `limit` rows is not truncation");
    }

    #[test]
    fn run_detector_query_errors_when_msg_id_column_missing() {
        let conn = setup();
        let err = run_detector_query(&conn, "select timestamp_us from messages", 10, 0, 10_000)
            .unwrap_err();
        assert!(
            err.to_lowercase().contains("msg_id"),
            "error should mention the missing column, got: {err}"
        );
    }

    #[test]
    fn run_detector_query_errors_when_timestamp_us_column_missing() {
        let conn = setup();
        let err =
            run_detector_query(&conn, "select msg_id from messages", 10, 0, 10_000).unwrap_err();
        assert!(
            err.to_lowercase().contains("timestamp_us"),
            "error should mention the missing column, got: {err}"
        );
    }

    #[test]
    fn run_detector_query_errors_on_empty_sql() {
        let conn = setup();
        assert!(run_detector_query(&conn, "   ", 10, 0, 10_000).is_err());
    }

    #[test]
    fn run_detector_query_strips_one_trailing_semicolon() {
        let conn = setup();
        let result = run_detector_query(
            &conn,
            "select msg_id, timestamp_us from messages where arb_id = 100;",
            10,
            0,
            10_000,
        )
        .unwrap();
        assert_eq!(result.matches.len(), 2);
    }

    #[test]
    fn run_detector_query_handles_trailing_line_comment() {
        let conn = setup();
        let result = run_detector_query(
            &conn,
            "select msg_id, timestamp_us from messages where arb_id = 100 -- note",
            10,
            0,
            10_000,
        )
        .unwrap();
        assert_eq!(result.matches.len(), 2);
    }

    #[test]
    fn run_detector_query_surfaces_bad_sql_errors() {
        let conn = setup();
        assert!(run_detector_query(&conn, "select * from no_such_table", 10, 0, 10_000).is_err());
    }

    #[test]
    fn list_signal_samples_orders_by_timestamp_and_respects_limit() {
        let conn = setup();
        conn.execute_batch(
            "INSERT INTO arxml_signal VALUES (0, 'EngineRpm', 'can', 100, 0, 16, false, 0.25, 0.0);
             INSERT INTO signals VALUES (0, 2, 2000, 600, 150.0);
             INSERT INTO signals VALUES (0, 1, 1000, 513, 128.25);",
        )
        .unwrap();
        let samples = list_signal_samples(&conn, 0, 1, 0, 10_000).unwrap();
        assert_eq!(
            samples,
            vec![(1000, 128.25)],
            "earliest sample first, limited to 1"
        );
    }

    #[test]
    fn missing_signal_coverage_empty_targets_is_empty() {
        let conn = setup();
        assert!(missing_signal_coverage(&conn, &[], 1000, 4000)
            .unwrap()
            .is_empty());
    }

    #[test]
    fn missing_signal_coverage_reports_absent_and_partial() {
        let conn = setup();
        conn.execute_batch(
            "CREATE TABLE signal_coverage (signal_id BIGINT PRIMARY KEY, start_us BIGINT, end_us BIGINT);
             INSERT INTO arxml_signal VALUES (10, 'FullCover', 'can', 100, 0, 8, false, 1.0, 0.0);
             INSERT INTO arxml_signal VALUES (11, 'PartialCover', 'can', 100, 8, 8, false, 1.0, 0.0);
             INSERT INTO arxml_signal VALUES (12, 'NoCover', 'can', 100, 16, 8, false, 1.0, 0.0);
             INSERT INTO signal_coverage VALUES (10, 1000, 4000);
             INSERT INTO signal_coverage VALUES (11, 1000, 2000);",
        )
        .unwrap();
        let missing = missing_signal_coverage(&conn, &[10, 11, 12], 1000, 4000).unwrap();
        let ids: Vec<i64> = missing.iter().map(|m| m.signal_id).collect();
        assert!(!ids.contains(&10), "full cover must not be missing");
        assert!(ids.contains(&11), "partial cover must be missing");
        assert!(ids.contains(&12), "absent cover must be missing");
        let partial = missing.iter().find(|m| m.signal_id == 11).unwrap();
        assert_eq!(partial.name, "PartialCover");
        assert_eq!(partial.need_start_us, 1000);
        assert_eq!(partial.need_end_us, 4000);
    }

    #[test]
    fn missing_signal_coverage_accepts_exact_cover() {
        let conn = setup();
        conn.execute_batch(
            "CREATE TABLE signal_coverage (signal_id BIGINT PRIMARY KEY, start_us BIGINT, end_us BIGINT);
             INSERT INTO arxml_signal VALUES (10, 'Exact', 'can', 100, 0, 8, false, 1.0, 0.0);
             INSERT INTO signal_coverage VALUES (10, 1500, 2500);",
        )
        .unwrap();
        assert!(missing_signal_coverage(&conn, &[10], 1500, 2500)
            .unwrap()
            .is_empty());
    }

    #[test]
    fn missing_signal_coverage_dedupes_duplicate_ids() {
        let conn = setup();
        conn.execute_batch(
            "CREATE TABLE signal_coverage (signal_id BIGINT PRIMARY KEY, start_us BIGINT, end_us BIGINT);
             INSERT INTO arxml_signal VALUES (10, 'NoCover', 'can', 100, 0, 8, false, 1.0, 0.0);",
        )
        .unwrap();
        let missing = missing_signal_coverage(&conn, &[10, 10], 1000, 4000).unwrap();
        assert_eq!(missing.len(), 1);
    }

    #[test]
    fn anomaly_bin_bounds_last_bin_ends_at_scope_end() {
        let (s, e) = anomaly_bin_bounds(499, 1000, 4000, 500);
        assert_eq!(e, 4000);
        let (s0, _) = anomaly_bin_bounds(0, 1000, 4000, 500);
        assert_eq!(s0, 1000);
        assert!(s > 1000);
    }

    #[test]
    fn compute_anomaly_bins_places_endpoints_in_first_and_last_bin() {
        let conn = setup();
        // Scope [1000, 4000] - msg at 1000 → bin 0; msg at 4000 → bin 499.
        let bins = compute_anomaly_bins(
            &conn,
            "select msg_id, timestamp_us from messages",
            1000,
            4000,
            500,
        )
        .unwrap();
        assert!(
            bins.iter().any(|b| b.bin == 0),
            "first timestamp must land in bin 0, got {bins:?}"
        );
        assert!(
            bins.iter().any(|b| b.bin == 499),
            "last timestamp must land in bin 499, never 500; got {bins:?}"
        );
        assert!(bins.iter().all(|b| b.bin >= 0 && b.bin < 500));
        let last = bins.iter().find(|b| b.bin == 499).unwrap();
        assert_eq!(last.end_us, 4000);
        assert_eq!(last.first_timestamp_us, 4000);
    }

    #[test]
    fn compute_anomaly_bins_empty_result_returns_no_bins() {
        let conn = setup();
        let bins = compute_anomaly_bins(
            &conn,
            "select msg_id, timestamp_us from messages where arb_id = 999",
            1000,
            4000,
            500,
        )
        .unwrap();
        assert!(bins.is_empty());
    }

    #[test]
    fn compute_anomaly_bins_one_microsecond_scope() {
        let conn = setup();
        let bins = compute_anomaly_bins(
            &conn,
            "select msg_id, timestamp_us from messages",
            1000,
            1000,
            500,
        )
        .unwrap();
        assert_eq!(bins.len(), 1);
        assert_eq!(bins[0].bin, 0);
        assert_eq!(bins[0].count, 1);
        assert_eq!(bins[0].start_us, 1000);
        assert_eq!(bins[0].end_us, 1000);
    }

    #[test]
    fn compute_anomaly_bins_handles_trailing_line_comment() {
        let conn = setup();
        let bins = compute_anomaly_bins(
            &conn,
            "select msg_id, timestamp_us from messages where arb_id = 100 -- note",
            0,
            10_000,
            500,
        )
        .unwrap();
        assert!(!bins.is_empty());
    }

    #[test]
    fn run_detector_query_includes_bins_and_scope() {
        let conn = setup();
        let result = run_detector_query(
            &conn,
            "select msg_id, timestamp_us from messages",
            10,
            1000,
            4000,
        )
        .unwrap();
        assert_eq!(result.scope_start_us, 1000);
        assert_eq!(result.scope_end_us, 4000);
        assert!(!result.bins.is_empty());
        assert_eq!(
            result.bins.iter().map(|b| b.count).sum::<i64>(),
            result.matches.len() as i64
        );
    }
}
