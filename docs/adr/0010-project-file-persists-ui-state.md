# 0010. Project file persists per-Trace UI state across restarts

- Status: Accepted
- Date: 2026-11-24

## Context

Today almost nothing survives closing the app: Displayed Signals, the Trim
Window, and Downsampling Algorithm choices (`docs/adr/0009`) live only in
frontend memory. The one exception, Query History, is stored on each entry in
`recent_traces.json` - coupling it to a 5-slot global Recents MRU, so a
Trace's query history vanishes if it simply falls out of that list. The user
wants to close and reopen a Trace and land back where they left off, the way
a code editor restores window/workspace state.

## Decision

1. **Introduce Project**: the persisted, resumable state for 1..N Traces -
   today always exactly 1. Multi-trace (one logical recording split across
   several BLF files, sharing an ARXML/signal catalog) is a named future
   direction, not built now.
2. **One JSON file per Project**, `<stem>.fastrace-project.json`, beside the
   primary Trace's Trace Store. Shape: `{ version, traces: [{ path,
   downsamplingAlgorithms }], displayedSignals, trimWindow, queryHistory }`.
   `traces` is an array from day one so multi-trace only grows that array
   later - nothing else needs restructuring. Fields that logically describe
   "where you are in the recording" (Displayed Signals, Trim Window, Query
   History) sit at the Project level, not nested per-trace; Downsampling
   Algorithm choices nest per-trace because `signal_id` is only stable within
   one Trace Store's lifetime (it's a positional counter reassigned on every
   Prepare, not a stable hash).
3. **Owned by a new `crates/project-store` crate**, not `crates/trace-store` -
   the Trace Store is opened read-only by design, and the Project file is a
   separate concern with its own `"version"` field, independent of the DuckDB
   `schema_version`. Loaded right after `crates/trace-store::open()` succeeds;
   `app/src-tauri` stays a thin command adapter. Autosaved debounced ~1s after
   a change, flushed on project-close/app-quit.
4. **Query History moves into the Project**, out of `recent_traces.json`.
   `recent_traces.json` keeps its own job (the Welcome screen's Recents MRU)
   but no longer carries a `queries` field.
5. **"Session" was considered and rejected** as the name for this concept -
   once multi-trace Projects exist, "Session" and "Project" would be two
   nouns for almost the same thing.
6. **The Timeline's client-side pan/zoom viewport (`timelineZoomRange`) is
   explicitly excluded** - it stays app-session-only. Only the Trim Window
   (which scopes what's queried) is persisted; the chart's pixel-level
   viewport is not.

## Considered Options

- A single global, cross-Trace preferences file keyed by ARXML+signal
  identity: rejected for now - `signal_id` instability makes this need
  careful namespacing (by ARXML source path) that isn't justified yet; revisit
  if Downsampling Algorithm preferences need to survive a re-Prepare or carry
  across different Traces of the same vehicle.
- Storing this state inside the Trace Store (`.duckdb`) itself: rejected -
  `crates/trace-store` opens the file read-only by design; adding a write path
  there breaks that invariant for state that isn't Detector-Query data anyway.

## Consequences

- Re-Preparing a Trace resets its whole Project file. Acceptable: Prepare
  already rebuilds the `.duckdb` from scratch, so keeping the Project file in
  lockstep is simpler than trying to selectively invalidate pieces of it.
- Where a *multi-trace* Project's manifest would live (it can't default to
  "beside one Trace" once there are several) is explicitly not solved here.
