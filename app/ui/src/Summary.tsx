import type { ProgressTick, TraceSummary } from "./types";

interface SummaryScreenProps {
  totals: ProgressTick & { done: true };
  breakdown: TraceSummary;
  onReset: () => void;
}

export default function SummaryScreen({ totals, breakdown, onReset }: SummaryScreenProps) {
  return (
    <div>
      <nav>
        <button aria-current="true">Summary</button>
        <button disabled>Signals</button>
        <button disabled>Anomaly Detection</button>
      </nav>
      <section>
        <h2>Summary</h2>
        <p>Messages: {totals.messages}</p>
        <p>Protocol rows: {totals.protocol_rows}</p>
        <p>Elapsed: {totals.elapsed_ms} ms</p>
        <p>CAN messages: {breakdown.can_messages}</p>
        <p>Ethernet messages: {breakdown.ethernet_messages}</p>
        <p>Packed PDU rows: {breakdown.protocol_pdu}</p>
        <p>SOME/IP rows: {breakdown.protocol_someip}</p>
        <p>SOME/IP-SD rows: {breakdown.protocol_someip_sd}</p>
        <p>DoIP rows: {breakdown.protocol_doip}</p>
      </section>
      <section>
        <p>Signal catalog and plots - coming soon.</p>
        <p>Anomaly detection - coming soon.</p>
      </section>
      <button onClick={onReset}>Process another trace</button>
    </div>
  );
}
