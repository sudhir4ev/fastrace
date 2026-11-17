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

export interface TraceDataSource {
  getTraceSummary(blfPath: string): Promise<TraceSummary>;
  listMessageGroups(blfPath: string): Promise<MessageGroup[]>;
  listMessages(blfPath: string, groupKey: string, cursor: number | null, limit: number): Promise<MessagePage>;
  getMessageDetail(blfPath: string, msgId: number): Promise<MessageDetail>;
  listEcus(blfPath: string): Promise<EcuInfo[]>;
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
}

let current: TraceDataSource = new TauriTraceDataSource();

export function setTraceDataSource(ds: TraceDataSource): void {
  current = ds;
}

export function getTraceDataSource(): TraceDataSource {
  return current;
}
