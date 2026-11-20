export type ProgressTick =
  | { done: false; containers: number; messages: number; bytes_read: number; bytes_total: number; elapsed_ms: number }
  | {
      done: true;
      containers: number;
      messages: number;
      protocol_rows: number;
      bytes_read: number;
      bytes_total: number;
      elapsed_ms: number;
    };

export interface TraceSummary {
  can_messages: number;
  ethernet_messages: number;
  protocol_pdu: number;
  protocol_someip: number;
  protocol_someip_sd: number;
  protocol_doip: number;
}
