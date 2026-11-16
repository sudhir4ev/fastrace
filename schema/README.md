# schema/

Shared Trace Store contract between `native/` (C++ writer) and `crates/` (Rust reader). See `docs/adr/0001-monorepo-layout-and-boundaries.md` boundary rule 1 and 5.

- `schema.sql` — DDL for `<stem>.duckdb`. Carried over from the pre-migration `cpp/sql/schema.sql` as a starting point; **not yet verified** against `docs/adr/0006-trace-store-schema-no-payloads.md`'s table list (`messages`, `protocol_pdu`, `protocol_someip`, `protocol_someip_sd`, `protocol_doip`, `arxml_pdu`, `arxml_can`, `arxml_ecu`, `arxml_signal`, `signals`, `meta`). Reconcile before `native/store` embeds it.
- `rules/` — Detector Query SQL (`docs/adr/0003-anomaly-detection-is-duckdb-sql.md`). Carried over from `cpp/sql/`; not yet verified to run against the schema above with no C++ detector involved.
- `schema_version` bumps must be reflected in both the C++ embed step (`native/store`) and the Rust open-time check (`crates/trace-store`).
