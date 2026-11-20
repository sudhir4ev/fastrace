# BLF object model: container, LOBJ, message, signal

Vocabulary matches [`GLOSSARY.md`](../GLOSSARY.md). Layout narrative: [`ingestion-pipeline.html`](ingestion-pipeline.html).

```mermaid
flowchart TB
  subgraph BLF["BLF file on disk"]
    H[LOGG header]
    C0[LOG_CONTAINER 0<br/>zlib blob]
    C1[LOG_CONTAINER 1<br/>zlib blob]
    C2[LOG_CONTAINER …]
  end

  H --> C0
  H --> C1
  H --> C2

  subgraph Inflated["After inflate of one container"]
    L1[LOBJ<br/>CAN / ETH frame header + payload]
    L2[LOBJ]
    L3[LOBJ]
  end

  C1 -->|inflate| Inflated

  L1 -.->|is a| M[Message / TraceMessage<br/>one row in messages<br/>msg_id + timestamp_us]
  L2 -.->|is a| M2[Message]
  L3 -.->|is a| M3[Message]

  M --> P[Payload bytes<br/>CAN data or UDP PDU stream]

  P --> S1[Signal A<br/>start_bit / bit_length]
  P --> S2[Signal B]
  P --> S3[Signal C]

  AR[(ARXML dictionary<br/>arxml_signal)] -.->|defines layout| S1
  AR -.-> S2
  AR -.-> S3
```

## Cardinalities

| From → To | Relation |
|---|---|
| Container → LOBJ | **1 : N** — one compressed blob holds many LOBJs |
| LOBJ ↔ Message | **1 : 1** — same thing; LOBJ is the BLF wire object, Message is the in-memory / store row |
| Message → Signal samples | **1 : 0..N** — a message carries zero or more signals (per ARXML parent); each decoded value is one `signals` row |
| Signal def → Messages | **1 : many over time** — same `signal_id` appears whenever its parent CAN id / PDU is seen |

**One-liner:** Container wraps LOBJs; each LOBJ *is* a Message; Signals are bit-fields *inside* that message’s payload, laid out by ARXML — not separate BLF objects.
