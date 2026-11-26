import { invoke } from "@tauri-apps/api/core";
import type { TraceSummary } from "../../types";

export interface MessageGroup {
  key: string;
  busLabel: string;
  label: string;
  count: number;
}

export interface MessageRow {
  msgId: number;
  timestampUs: number;
  busLabel: string;
  idOrSrc: string;
  name: string | null;
  dlc: number | null;
  payloadLen: number | null;
}

export interface MessagePage {
  rows: MessageRow[];
  nextCursor: number | null;
}

export type MessageDetail = MessageRow;

export interface EcuInfo {
  name: string;
}

export interface FileSizes {
  blfBytes: number;
  duckdbBytes: number;
}

export interface RecentTraceInfo {
  blfPath: string;
  openedAt: number;
  duckdbBytes: number | null;
  messages: number | null;
  protocolRows: number | null;
  elapsedMs: number | null;
}

export interface PrepareMeta {
  messages: number;
  protocolRows: number;
  elapsedMs: number;
}

export interface ActivityEntry {
  kind: string;
  at: number;
  elapsedMs: number;
  detail: string;
}

export interface DecodeResult {
  elapsedMs: number;
  decodedCount: number;
}

export interface SignalCatalogEntry {
  signalId: number;
  name: string;
  parentLabel: string;
  decodable: boolean;
  cached: boolean;
  samples: number;
  changes: number;
  nonzero: number;
  opaque: boolean;
}

export interface DetectorMatch {
  msgId: number;
  timestampUs: number;
}

export type DownsamplingAlgorithm = "min_max" | "lttb";

export interface AnomalyBin {
  bin: number;
  count: number;
  firstMsgId: number;
  firstTimestampUs: number;
  startUs: number;
  endUs: number;
}

export interface MissingSignal {
  signalId: number;
  name: string;
  needStartUs: number;
  needEndUs: number;
}

export interface NeedsDecodeInfo {
  missing: MissingSignal[];
  wholeTrace: boolean;
  blfBytes: number;
  scopeStartUs: number;
  scopeEndUs: number;
}

export interface DetectorQueryRan {
  matches: DetectorMatch[];
  truncated: boolean;
  bins: AnomalyBin[];
  scopeStartUs: number;
  scopeEndUs: number;
  wholeTrace: boolean;
  elapsedMs: number;
  targetSignalIds: number[];
}

/** Adjacent-tagged: exactly one of `needsDecode` / `ran` is set. */
export interface DetectorQueryResponse {
  needsDecode?: NeedsDecodeInfo;
  ran?: DetectorQueryRan;
}

/** 5 GiB whole-trace decode confirmation threshold (matches the plan). */
export const WHOLE_TRACE_DECODE_WARN_BYTES = 5 * 1024 * 1024 * 1024;

export interface QueryHistoryEntry {
  sql: string;
  targetSignalIds: number[];
  respectTrim: boolean;
  ranAt: number;
  matchCount: number;
}

export interface ExplorerColumn {
  name: string;
  numeric: boolean;
}

export interface ExplorerTablePage {
  columns: ExplorerColumn[];
  rows: string[][];
  totalRows: number;
}

export interface ProjectFile {
  version: number;
  traces: { path: string; arxmlPath: string | null; downsamplingAlgorithms: Record<number, string> }[];
  displayedSignalIds: number[];
  trimWindow: { startUs: number; endUs: number } | null;
  queryHistory: QueryHistoryEntry[];
}

export interface TraceTimeRange {
  minTimestampUs: number;
  maxTimestampUs: number;
}

export interface ContainerIndexEntry {
  containerOrd: number;
  byteOffset: number;
  firstTsUs: number;
  lastTsUs: number;
  firstMsgId: number;
  decoded: boolean;
}

export interface SignalCoverageEntry {
  signalId: number;
  startUs: number;
  endUs: number;
}

export interface TraceDataSource {
  getTraceSummary(blfPath: string, startUs: number, endUs: number): Promise<TraceSummary>;
  listMessageGroups(blfPath: string, startUs: number, endUs: number): Promise<MessageGroup[]>;
  listMessages(
    blfPath: string,
    groupKeys: string[],
    cursor: number | null,
    limit: number,
    startUs: number,
    endUs: number
  ): Promise<MessagePage>;
  getMessageDetail(blfPath: string, msgId: number, startUs: number, endUs: number): Promise<MessageDetail>;
  countMessages(blfPath: string): Promise<number>;
  countMessagesInRange(blfPath: string, startUs: number, endUs: number): Promise<number>;
  listContainerIndex(blfPath: string): Promise<ContainerIndexEntry[]>;
  listSignalCoverage(blfPath: string): Promise<SignalCoverageEntry[]>;
  resolveMessagePosition(blfPath: string, position: number): Promise<number>;
  /** Inclusive 1-based ordinal slice → [min_ts, max_ts] over that msg_id range. */
  resolveMessageRange(blfPath: string, startPos: number, endPos: number): Promise<[number, number]>;
  listEcus(blfPath: string): Promise<EcuInfo[]>;
  listSignalCatalog(blfPath: string): Promise<SignalCatalogEntry[]>;
  getSignalSamples(
    blfPath: string,
    signalId: number,
    startUs: number,
    endUs: number,
    pixelWidth: number,
    algorithm: DownsamplingAlgorithm
  ): Promise<[number, number][]>;
  getAnomalyBinsForViewport(
    blfPath: string,
    sql: string,
    startUs: number,
    endUs: number,
    pixelWidth: number
  ): Promise<AnomalyBin[]>;
  runDetectorQuery(
    blfPath: string,
    sql: string,
    respectTrim: boolean,
    startUs: number,
    endUs: number,
    targetSignalIds: number[]
  ): Promise<DetectorQueryResponse>;
  getTraceTimeRange(blfPath: string): Promise<TraceTimeRange>;
  applyTrim(blfPath: string, startUs: number, endUs: number, activeSignalIds: number[]): Promise<DecodeResult>;
  recordActivity(blfPath: string, kind: string, elapsedMs: number, detail: string): Promise<void>;
  listActivities(blfPath: string): Promise<ActivityEntry[]>;
  getFileSizes(blfPath: string): Promise<FileSizes>;
  checkExistingStore(blfPath: string): Promise<boolean>;
  deleteTraceStore(blfPath: string): Promise<void>;
  getPathSize(path: string): Promise<number>;
  listRecentTraces(): Promise<RecentTraceInfo[]>;
  recordRecentTrace(blfPath: string, meta?: PrepareMeta): Promise<void>;
  removeRecentTrace(blfPath: string): Promise<void>;
  listQueryHistory(blfPath: string): Promise<QueryHistoryEntry[]>;
  runExplorerTablePage(
    blfPath: string,
    sql: string,
    pageSize: number,
    offset: number,
    orderByColumn: string | null,
    orderByDesc: boolean
  ): Promise<ExplorerTablePage>;
  recordQuery(
    blfPath: string,
    sql: string,
    targetSignalIds: number[],
    respectTrim: boolean,
    matchCount: number
  ): Promise<void>;
  removeQuery(blfPath: string, sql: string): Promise<void>;
  clearQueryHistory(blfPath: string): Promise<void>;
  getProject(blfPath: string): Promise<ProjectFile>;
  saveProject(
    blfPath: string,
    signalIds: number[],
    trimWindow: { startUs: number; endUs: number } | null,
    downsamplingAlgorithms: Record<number, string>
  ): Promise<void>;
}

export class TauriTraceDataSource implements TraceDataSource {
  getTraceSummary(blfPath: string, startUs: number, endUs: number): Promise<TraceSummary> {
    return invoke<TraceSummary>("get_trace_summary", { blfPath, startUs, endUs });
  }

  listMessageGroups(blfPath: string, startUs: number, endUs: number): Promise<MessageGroup[]> {
    return invoke<MessageGroup[]>("list_message_groups", { blfPath, startUs, endUs });
  }

  listMessages(
    blfPath: string,
    groupKeys: string[],
    cursor: number | null,
    limit: number,
    startUs: number,
    endUs: number
  ): Promise<MessagePage> {
    return invoke<MessagePage>("list_messages", { blfPath, groupKeys, cursor, limit, startUs, endUs });
  }

  getMessageDetail(blfPath: string, msgId: number, startUs: number, endUs: number): Promise<MessageDetail> {
    return invoke<MessageDetail>("get_message_detail", { blfPath, msgId, startUs, endUs });
  }

  countMessages(blfPath: string): Promise<number> {
    return invoke<number>("count_messages", { blfPath });
  }

  countMessagesInRange(blfPath: string, startUs: number, endUs: number): Promise<number> {
    return invoke<number>("count_messages_in_range", { blfPath, startUs, endUs });
  }

  listContainerIndex(blfPath: string): Promise<ContainerIndexEntry[]> {
    return invoke<ContainerIndexEntry[]>("list_container_index", { blfPath });
  }

  listSignalCoverage(blfPath: string): Promise<SignalCoverageEntry[]> {
    return invoke<SignalCoverageEntry[]>("list_signal_coverage", { blfPath });
  }

  resolveMessagePosition(blfPath: string, position: number): Promise<number> {
    return invoke<number>("resolve_message_position", { blfPath, position });
  }

  resolveMessageRange(blfPath: string, startPos: number, endPos: number): Promise<[number, number]> {
    return invoke<[number, number]>("resolve_message_range", { blfPath, startPos, endPos });
  }

  async listEcus(blfPath: string): Promise<EcuInfo[]> {
    const names = await invoke<string[]>("list_ecus", { blfPath });
    return names.map((name) => ({ name }));
  }

  listSignalCatalog(blfPath: string): Promise<SignalCatalogEntry[]> {
    return invoke<SignalCatalogEntry[]>("list_signal_catalog", { blfPath });
  }

  getSignalSamples(
    blfPath: string,
    signalId: number,
    startUs: number,
    endUs: number,
    pixelWidth: number,
    algorithm: DownsamplingAlgorithm
  ): Promise<[number, number][]> {
    return invoke<[number, number][]>("get_signal_samples", {
      blfPath,
      signalId,
      startUs,
      endUs,
      pixelWidth,
      algorithm,
    });
  }

  getAnomalyBinsForViewport(
    blfPath: string,
    sql: string,
    startUs: number,
    endUs: number,
    pixelWidth: number
  ): Promise<AnomalyBin[]> {
    return invoke<AnomalyBin[]>("get_anomaly_bins_for_viewport", {
      blfPath,
      sql,
      startUs,
      endUs,
      pixelWidth,
    });
  }

  runDetectorQuery(
    blfPath: string,
    sql: string,
    respectTrim: boolean,
    startUs: number,
    endUs: number,
    targetSignalIds: number[]
  ): Promise<DetectorQueryResponse> {
    return invoke<DetectorQueryResponse>("run_detector_query", {
      blfPath,
      sql,
      respectTrim,
      startUs,
      endUs,
      targetSignalIds,
    });
  }

  getTraceTimeRange(blfPath: string): Promise<TraceTimeRange> {
    return invoke<TraceTimeRange>("get_trace_time_range", { blfPath });
  }

  async applyTrim(
    blfPath: string,
    startUs: number,
    endUs: number,
    activeSignalIds: number[]
  ): Promise<DecodeResult> {
    // apply-trim's Done tick reuses the sidecar progress shape; protocol_rows
    // here carries the count of signal rows decoded this pass (the delta).
    const tick = await invoke<{ elapsed_ms: number; protocol_rows: number }>("apply_trim", {
      blfPath,
      startUs,
      endUs,
      activeSignalIds,
    });
    return { elapsedMs: tick.elapsed_ms, decodedCount: tick.protocol_rows };
  }

  recordActivity(blfPath: string, kind: string, elapsedMs: number, detail: string): Promise<void> {
    return invoke<void>("record_activity", { blfPath, kind, elapsedMs, detail });
  }

  listActivities(blfPath: string): Promise<ActivityEntry[]> {
    return invoke<ActivityEntry[]>("list_activities", { blfPath });
  }

  getFileSizes(blfPath: string): Promise<FileSizes> {
    return invoke<FileSizes>("get_file_sizes", { blfPath });
  }

  checkExistingStore(blfPath: string): Promise<boolean> {
    return invoke<boolean>("check_existing_store", { blfPath });
  }

  deleteTraceStore(blfPath: string): Promise<void> {
    return invoke<void>("delete_trace_store", { blfPath });
  }

  getPathSize(path: string): Promise<number> {
    return invoke<number>("get_path_size", { path });
  }

  listRecentTraces(): Promise<RecentTraceInfo[]> {
    return invoke<RecentTraceInfo[]>("list_recent_traces");
  }

  recordRecentTrace(blfPath: string, meta?: PrepareMeta): Promise<void> {
    return invoke<void>("record_recent_trace", {
      blfPath,
      messages: meta?.messages,
      protocolRows: meta?.protocolRows,
      elapsedMs: meta?.elapsedMs,
    });
  }

  removeRecentTrace(blfPath: string): Promise<void> {
    return invoke<void>("remove_recent_trace", { blfPath });
  }

  listQueryHistory(blfPath: string): Promise<QueryHistoryEntry[]> {
    return invoke<QueryHistoryEntry[]>("list_query_history", { blfPath });
  }

  runExplorerTablePage(
    blfPath: string,
    sql: string,
    pageSize: number,
    offset: number,
    orderByColumn: string | null,
    orderByDesc: boolean
  ): Promise<ExplorerTablePage> {
    return invoke<ExplorerTablePage>("run_explorer_table_page", {
      blfPath,
      sql,
      pageSize,
      offset,
      orderByColumn,
      orderByDesc,
    });
  }

  recordQuery(
    blfPath: string,
    sql: string,
    targetSignalIds: number[],
    respectTrim: boolean,
    matchCount: number
  ): Promise<void> {
    return invoke<void>("record_query", {
      blfPath,
      sql,
      targetSignalIds,
      respectTrim,
      matchCount,
    });
  }

  removeQuery(blfPath: string, sql: string): Promise<void> {
    return invoke<void>("remove_query", { blfPath, sql });
  }

  clearQueryHistory(blfPath: string): Promise<void> {
    return invoke<void>("clear_query_history", { blfPath });
  }

  getProject(blfPath: string): Promise<ProjectFile> {
    return invoke<ProjectFile>("get_project", { blfPath });
  }

  saveProject(
    blfPath: string,
    signalIds: number[],
    trimWindow: { startUs: number; endUs: number } | null,
    downsamplingAlgorithms: Record<number, string>
  ): Promise<void> {
    return invoke<void>("save_project", {
      blfPath,
      displayedSignalIds: signalIds,
      trimWindow,
      downsamplingAlgorithms,
    });
  }
}

let current: TraceDataSource = new TauriTraceDataSource();

export function setTraceDataSource(ds: TraceDataSource): void {
  current = ds;
}

export function getTraceDataSource(): TraceDataSource {
  return current;
}
