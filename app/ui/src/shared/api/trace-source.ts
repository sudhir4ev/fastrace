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
}

export interface TraceDataSource {
  getTraceSummary(blfPath: string): Promise<TraceSummary>;
  listMessageGroups(blfPath: string): Promise<MessageGroup[]>;
  listMessages(blfPath: string, groupKey: string, cursor: number | null, limit: number): Promise<MessagePage>;
  getMessageDetail(blfPath: string, msgId: number): Promise<MessageDetail>;
  listEcus(blfPath: string): Promise<EcuInfo[]>;
  listSignalCatalog(blfPath: string): Promise<SignalCatalogEntry[]>;
  getSignalSamples(blfPath: string, signalId: number, limit: number): Promise<[number, number][]>;
  decodeSignals(blfPath: string, signalIds: number[]): Promise<DecodeResult>;
  recordActivity(blfPath: string, kind: string, elapsedMs: number, detail: string): Promise<void>;
  listActivities(blfPath: string): Promise<ActivityEntry[]>;
  getFileSizes(blfPath: string): Promise<FileSizes>;
  checkExistingStore(blfPath: string): Promise<boolean>;
  deleteTraceStore(blfPath: string): Promise<void>;
  getPathSize(path: string): Promise<number>;
  listRecentTraces(): Promise<RecentTraceInfo[]>;
  recordRecentTrace(blfPath: string, meta?: PrepareMeta): Promise<void>;
  removeRecentTrace(blfPath: string): Promise<void>;
}

export class TauriTraceDataSource implements TraceDataSource {
  getTraceSummary(blfPath: string): Promise<TraceSummary> {
    return invoke<TraceSummary>("get_trace_summary", { blfPath });
  }

  listMessageGroups(blfPath: string): Promise<MessageGroup[]> {
    return invoke<MessageGroup[]>("list_message_groups", { blfPath });
  }

  listMessages(blfPath: string, groupKey: string, cursor: number | null, limit: number): Promise<MessagePage> {
    return invoke<MessagePage>("list_messages", { blfPath, groupKey, cursor, limit });
  }

  getMessageDetail(blfPath: string, msgId: number): Promise<MessageDetail> {
    return invoke<MessageDetail>("get_message_detail", { blfPath, msgId });
  }

  async listEcus(blfPath: string): Promise<EcuInfo[]> {
    const names = await invoke<string[]>("list_ecus", { blfPath });
    return names.map((name) => ({ name }));
  }

  listSignalCatalog(blfPath: string): Promise<SignalCatalogEntry[]> {
    return invoke<SignalCatalogEntry[]>("list_signal_catalog", { blfPath });
  }

  getSignalSamples(blfPath: string, signalId: number, limit: number): Promise<[number, number][]> {
    return invoke<[number, number][]>("get_signal_samples", { blfPath, signalId, limit });
  }

  async decodeSignals(blfPath: string, signalIds: number[]): Promise<DecodeResult> {
    // decode_signals resolves with the run's raw Done tick (same shape as
    // prepare_trace's), snake_case because it's forwarded as-is from the
    // sidecar's progress protocol - reused here as "signal rows decoded"
    // rather than widening the native progress protocol for one new field.
    const tick = await invoke<{ elapsed_ms: number; protocol_rows: number }>("decode_signals", {
      blfPath,
      signalIds,
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
}

let current: TraceDataSource = new TauriTraceDataSource();

export function setTraceDataSource(ds: TraceDataSource): void {
  current = ds;
}

export function getTraceDataSource(): TraceDataSource {
  return current;
}
