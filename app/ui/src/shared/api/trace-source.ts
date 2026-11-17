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
}

export interface TraceDataSource {
  getTraceSummary(blfPath: string): Promise<TraceSummary>;
  listMessageGroups(blfPath: string): Promise<MessageGroup[]>;
  listMessages(blfPath: string, groupKey: string, cursor: number | null, limit: number): Promise<MessagePage>;
  getMessageDetail(blfPath: string, msgId: number): Promise<MessageDetail>;
  listEcus(blfPath: string): Promise<EcuInfo[]>;
  getFileSizes(blfPath: string): Promise<FileSizes>;
  checkExistingStore(blfPath: string): Promise<boolean>;
  deleteTraceStore(blfPath: string): Promise<void>;
  listRecentTraces(): Promise<RecentTraceInfo[]>;
  recordRecentTrace(blfPath: string): Promise<void>;
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

  getFileSizes(blfPath: string): Promise<FileSizes> {
    return invoke<FileSizes>("get_file_sizes", { blfPath });
  }

  checkExistingStore(blfPath: string): Promise<boolean> {
    return invoke<boolean>("check_existing_store", { blfPath });
  }

  deleteTraceStore(blfPath: string): Promise<void> {
    return invoke<void>("delete_trace_store", { blfPath });
  }

  listRecentTraces(): Promise<RecentTraceInfo[]> {
    return invoke<RecentTraceInfo[]>("list_recent_traces");
  }

  recordRecentTrace(blfPath: string): Promise<void> {
    return invoke<void>("record_recent_trace", { blfPath });
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
