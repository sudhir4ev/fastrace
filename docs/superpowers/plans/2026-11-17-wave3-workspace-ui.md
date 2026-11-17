# Wave 3: Workspace UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the placeholder `SummaryScreen` with a real multi-pane workspace - resizable Trace Rail / Timeline / Message List / Message Details / Analyzer panes, backed by a swappable DuckDB-reading data layer - once a trace finishes Prepare.

**Architecture:** `crates/query` gains message-browsing queries (groups, paginated messages, single-message detail, ECU list) returned as `camelCase`-serialized structs; `app/src-tauri` exposes them as four new thin `#[tauri::command]`s alongside the existing `get_trace_summary`. `app/ui` adopts Tailwind + hand-written shadcn-style primitives (Radix underneath) themed from the project's existing design tokens, a Zustand store for pane-selection UI state, React Query + a `TraceDataSource` interface for all DB reads, and `react-resizable-panels` for every pane boundary. Widgets are built one at a time, each confirmed with the user (interface + JSX) before being written.

**Tech Stack:** Tailwind CSS v3 + `tailwindcss-animate`, Radix primitives (`@radix-ui/react-slot`, `-tabs`, `-scroll-area`, `-separator`) wrapped shadcn-style, `class-variance-authority` + `clsx` + `tailwind-merge`, `zustand`, `@tanstack/react-query` + `@tanstack/react-virtual`, `react-resizable-panels`, `lucide-react`.

**Spec:** Design agreed directly with the user in conversation (see this plan's task bodies for the agreed shapes - no separate spec doc for this wave).

## Global Constraints

- No automated frontend tests this wave, per the user's explicit instruction - every `app/ui` task ends in a manual verification step instead of a test cycle. Rust additions (`crates/query`, `app/src-tauri`) still get real `cargo test` coverage per `AGENTS.md`.
- Every struct returned by a Tauri command to the frontend uses `#[serde(rename_all = "camelCase")]` - Rust fields are `snake_case`, the TypeScript side is `camelCase`, and Tauri does not convert struct field casing for you (it only camelCases command *argument* names).
- Error feedback for async work is centralized: failed React Query reads are caught once, globally, by `QueryCache`'s `onError` (Task 6) and pushed onto a stacking, bottom-right toast list. Panes do not each render their own full error-message banner - five redundant banners on screen at once is bad UX. A pane's own `isError` check only decides whether to fall back to a neutral empty state locally; the actual error text lives in the toast.
- `app/src-tauri` stays a thin adapter layer (`docs/adr/0001` boundary rule 6): all new SQL and row-mapping logic lives in `crates/query`, never inlined in `main.rs`.
- Design tokens are copied verbatim from `/Users/sudhir/Downloads/automotive-trace-analysis/project/tokens.css` into `app/ui/src/app/theme.css` - do not invent new color values.
- Naming collision to get right: this project's own token file uses `--accent` for the brand/primary action color (indigo, `#3F49C7`/`#4F5BE0` - this is the "purple" the user means to match to shadcn's `--primary`). shadcn's own convention uses `--accent` for a *different* thing (hover/subtle-highlight background). `theme.css` must alias the project's `--accent` to shadcn's `--primary`, and use a renamed `--accent-bg`/`--accent-bg-foreground` pair for shadcn's hover-highlight concept, so the two meanings never collide under the same CSS variable name.
- `react-resizable-panels`' `getNextPageParam`/pagination is not involved, but its own pane-resize must not break `@tanstack/react-virtual` row measurement (see Review Focus).
- Path alias `@/*` -> `app/ui/src/*` is added once (tsconfig + vite config) and used by every new frontend file; existing top-level screens (`Welcome.tsx`, `Progress.tsx`, `ErrorScreen.tsx`) are left importing by relative path - no mass rewrite of working files.
- Widgets are confirmed with the user (interface + JSX shown, explicit approval given) before being written. This is a hard checkpoint baked into each widget task below - do not skip it even when the shape seems obvious.

## Review Focus

- A trace with zero CAN/Ethernet messages after the bus-type filter - `TraceRail`'s Messages tab and `MessageList` must show an explicit empty state, not an infinite spinner or a blank pane.
- `useMessages`'s `getNextPageParam` must turn a `nextCursor: null` (last page) into `undefined`, not pass `null` through - React Query's infinite-query pagination only stops fetching on `undefined`, so a naive pass-through of `null` loops forever re-requesting the last page.
- Switching the selected message group while a message was already selected in the old group - `selectedMessageId` must reset to `null` so `MessageDetails` never shows a message that belongs to a different group than the one currently browsed.
- `get_trace_summary`/`list_message_groups`/etc. called against a `.duckdb` whose `schema_version` doesn't match (same failure mode Wave 2 guarded against) - the failure must surface as a toast in the global, stacking, bottom-right error list (Task 6), not crash the whole workspace; the pane itself falls back to a neutral empty state rather than duplicating the error text inline.
- Dragging a `react-resizable-panels` handle while `MessageList` is mid-scroll - `@tanstack/react-virtual`'s row measurements must stay correct against the resized scroll container (verified manually, see Task 10).

---

## Task 1: `crates/query` - message-group and paginated-message queries

**Files:**
- Modify: `crates/query/Cargo.toml`
- Modify: `crates/query/src/lib.rs`

**Interfaces:**
- Consumes: `trace_store::Connection` (existing).
- Produces: `pub struct MessageGroup { key: String, bus_label: String, label: String, count: i64 }`, `pub struct MessageRow { msg_id: i64, timestamp_us: i64, bus_label: String, id_or_src: String, name: Option<String>, dlc: Option<i32>, payload_len: Option<i32> }`, `pub struct MessagePage { rows: Vec<MessageRow>, next_cursor: Option<i64> }`, `pub fn list_message_groups(conn: &trace_store::Connection) -> Result<Vec<MessageGroup>, String>`, `pub fn list_messages(conn: &trace_store::Connection, group_key: &str, cursor: Option<i64>, limit: i64) -> Result<MessagePage, String>`. All three structs derive `serde::Serialize` with `#[serde(rename_all = "camelCase")]`.

- [ ] **Step 1: Add the `serde` dependency**

Edit `crates/query/Cargo.toml`:

```toml
[package]
name = "query"
version = "0.1.0"
edition = "2021"

[dependencies]
trace-store = { path = "../trace-store" }
serde = { version = "1", features = ["derive"] }
```

- [ ] **Step 2: Write the failing tests**

Replace `crates/query/src/lib.rs` entirely with:

```rust
use serde::Serialize;

/// Runs a `SELECT COUNT(*) ...`-shaped query and returns the single integer
/// result. Not a general query runner - just enough to drive the Wave 2
/// summary screen's fixed set of aggregate counts.
pub fn count(conn: &trace_store::Connection, sql: &str) -> Result<i64, String> {
    conn.query_row(sql, [], |row| row.get(0)).map_err(|e| e.to_string())
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
pub fn list_message_groups(conn: &trace_store::Connection) -> Result<Vec<MessageGroup>, String> {
    let sql = format!(
        "select 'can:' || cast(arb_id as varchar) as key,
                'CAN' as bus_label,
                coalesce((select name from arxml_can where can_id = arb_id limit 1), cast(arb_id as varchar)) as label,
                count(*) as count
         from messages
         where object_type in ({CAN_OBJECT_TYPES})
         group by arb_id
         union all
         select 'eth:' || coalesce(dst_ip,'') || ':' || cast(coalesce(dst_port,0) as varchar) as key,
                'Ethernet' as bus_label,
                coalesce(dst_ip,'?') || ':' || cast(coalesce(dst_port,0) as varchar) as label,
                count(*) as count
         from messages
         where object_type in ({ETHERNET_OBJECT_TYPES})
         group by dst_ip, dst_port
         order by 2, 3"
    );
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |row| {
            Ok(MessageGroup {
                key: row.get(0)?,
                bus_label: row.get(1)?,
                label: row.get(2)?,
                count: row.get(3)?,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
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

/// Keyset-paginates by `msg_id` within one group. `cursor` is the last
/// `msg_id` already seen (`None` for the first page); the returned
/// `next_cursor` is `None` once the group is exhausted.
pub fn list_messages(
    conn: &trace_store::Connection,
    group_key: &str,
    cursor: Option<i64>,
    limit: i64,
) -> Result<MessagePage, String> {
    let cursor = cursor.unwrap_or(-1);
    let fetch = limit + 1;

    let mut rows: Vec<MessageRow> = if let Some(arb_id) = group_key.strip_prefix("can:") {
        let arb_id: i64 = arb_id.parse().map_err(|_| format!("bad group key: {group_key}"))?;
        let sql = format!(
            "select msg_id, timestamp_us, 'CAN' as bus_label, cast(arb_id as varchar) as id_or_src,
                    (select name from arxml_can where can_id = arb_id limit 1) as name, dlc, payload_len
             from messages
             where object_type in ({CAN_OBJECT_TYPES}) and arb_id = ? and msg_id > ?
             order by msg_id
             limit ?"
        );
        let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
        let out = stmt
            .query_map(duckdb::params![arb_id, cursor, fetch], map_message_row)
            .map_err(|e| e.to_string())?;
        out.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())?
    } else if let Some(rest) = group_key.strip_prefix("eth:") {
        let (dst_ip, dst_port) = rest
            .rsplit_once(':')
            .ok_or_else(|| format!("bad group key: {group_key}"))?;
        let dst_port: i32 = dst_port.parse().map_err(|_| format!("bad group key: {group_key}"))?;
        let sql = format!(
            "select msg_id, timestamp_us, 'Ethernet' as bus_label,
                    coalesce(dst_ip,'') || ':' || cast(coalesce(dst_port,0) as varchar) as id_or_src,
                    cast(null as varchar) as name, dlc, payload_len
             from messages
             where object_type in ({ETHERNET_OBJECT_TYPES}) and dst_ip = ? and dst_port = ? and msg_id > ?
             order by msg_id
             limit ?"
        );
        let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
        let out = stmt
            .query_map(duckdb::params![dst_ip, dst_port, cursor, fetch], map_message_row)
            .map_err(|e| e.to_string())?;
        out.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())?
    } else {
        return Err(format!("bad group key: {group_key}"));
    };

    let next_cursor = if rows.len() as i64 > limit {
        rows.truncate(limit as usize);
        rows.last().map(|r| r.msg_id)
    } else {
        None
    };
    Ok(MessagePage { rows, next_cursor })
}

#[cfg(test)]
mod tests {
    use super::*;
    use trace_store::Connection;

    #[test]
    fn count_returns_row_count() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("CREATE TABLE t (x INTEGER); INSERT INTO t VALUES (1), (2), (3);").unwrap();
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
             INSERT INTO arxml_can VALUES (100, 'EngineSpeed');
             INSERT INTO messages VALUES (1, 1000, 1, 100, NULL, NULL, 8, 8);
             INSERT INTO messages VALUES (2, 2000, 1, 100, NULL, NULL, 8, 8);
             INSERT INTO messages VALUES (3, 3000, 1, 200, NULL, NULL, 4, 4);
             INSERT INTO messages VALUES (4, 4000, 71, NULL, '10.0.0.1', 30509, NULL, 64);",
        )
        .unwrap();
        conn
    }

    #[test]
    fn list_message_groups_aggregates_by_bus_and_id() {
        let conn = setup();
        let groups = list_message_groups(&conn).unwrap();
        let named = groups.iter().find(|g| g.key == "can:100").unwrap();
        assert_eq!(named.label, "EngineSpeed");
        assert_eq!(named.count, 2);
        let unnamed = groups.iter().find(|g| g.key == "can:200").unwrap();
        assert_eq!(unnamed.label, "200");
        let eth = groups.iter().find(|g| g.key == "eth:10.0.0.1:30509").unwrap();
        assert_eq!(eth.count, 1);
    }

    #[test]
    fn list_messages_paginates_with_keyset_cursor() {
        let conn = setup();
        let page1 = list_messages(&conn, "can:100", None, 1).unwrap();
        assert_eq!(page1.rows.len(), 1);
        assert_eq!(page1.rows[0].msg_id, 1);
        assert_eq!(page1.next_cursor, Some(1));

        let page2 = list_messages(&conn, "can:100", page1.next_cursor, 1).unwrap();
        assert_eq!(page2.rows.len(), 1);
        assert_eq!(page2.rows[0].msg_id, 2);
        assert_eq!(page2.next_cursor, None, "last page must not return a cursor");
    }

    #[test]
    fn list_messages_rejects_unrecognized_group_key() {
        let conn = setup();
        assert!(list_messages(&conn, "bogus:1", None, 10).is_err());
    }
}
```

- [ ] **Step 3: Run the tests to verify they pass**

Run: `cargo test --manifest-path crates/Cargo.toml -p query`
Expected: PASS (5 tests).

- [ ] **Step 4: Commit**

```bash
git add crates/query/Cargo.toml crates/query/src/lib.rs
git commit -m "feat(query): add message-group and paginated-message queries"
```

---

## Task 2: `crates/query` - message-detail and ECU-list queries

**Files:**
- Modify: `crates/query/src/lib.rs`

**Interfaces:**
- Consumes: `MessageRow`, `map_message_row` (Task 1).
- Produces: `pub fn get_message_detail(conn: &trace_store::Connection, msg_id: i64) -> Result<MessageRow, String>`, `pub fn list_ecus(conn: &trace_store::Connection) -> Result<Vec<String>, String>`.

- [ ] **Step 1: Write the failing tests**

Add to `crates/query/src/lib.rs`'s `tests` module (after `list_messages_rejects_unrecognized_group_key`):

```rust
    #[test]
    fn get_message_detail_returns_row_by_id() {
        let conn = setup();
        let detail = get_message_detail(&conn, 1).unwrap();
        assert_eq!(detail.bus_label, "CAN");
        assert_eq!(detail.id_or_src, "100");
    }

    #[test]
    fn get_message_detail_errors_when_missing() {
        let conn = setup();
        assert!(get_message_detail(&conn, 999).is_err());
    }

    #[test]
    fn list_ecus_returns_sorted_names() {
        let conn = setup();
        conn.execute_batch("INSERT INTO arxml_ecu VALUES ('Gateway'), ('BodyControl');").unwrap();
        let ecus = list_ecus(&conn).unwrap();
        assert_eq!(ecus, vec!["BodyControl".to_string(), "Gateway".to_string()]);
    }

    #[test]
    fn list_ecus_returns_empty_vec_when_no_ecus() {
        let conn = setup();
        assert_eq!(list_ecus(&conn).unwrap(), Vec::<String>::new());
    }
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cargo test --manifest-path crates/Cargo.toml -p query get_message_detail`
Expected: FAIL with "cannot find function `get_message_detail`".

- [ ] **Step 3: Implement both functions**

Add to `crates/query/src/lib.rs`, below `list_messages`:

```rust
pub fn get_message_detail(conn: &trace_store::Connection, msg_id: i64) -> Result<MessageRow, String> {
    let sql = format!(
        "select msg_id, timestamp_us,
                case when object_type in ({CAN_OBJECT_TYPES}) then 'CAN' else 'Ethernet' end as bus_label,
                case when object_type in ({CAN_OBJECT_TYPES}) then cast(arb_id as varchar)
                     else coalesce(dst_ip,'') || ':' || cast(coalesce(dst_port,0) as varchar) end as id_or_src,
                cast(null as varchar) as name,
                dlc, payload_len
         from messages where msg_id = ?"
    );
    conn.query_row(&sql, duckdb::params![msg_id], map_message_row)
        .map_err(|e| format!("message {msg_id} not found: {e}"))
}

pub fn list_ecus(conn: &trace_store::Connection) -> Result<Vec<String>, String> {
    let mut stmt = conn
        .prepare("select name from arxml_ecu order by name")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cargo test --manifest-path crates/Cargo.toml -p query`
Expected: PASS (9 tests).

- [ ] **Step 5: Commit**

```bash
git add crates/query/src/lib.rs
git commit -m "feat(query): add single-message detail and ECU-list queries"
```

---

## Task 3: `app/src-tauri` - register the four new commands

**Files:**
- Modify: `app/src-tauri/src/main.rs`

**Interfaces:**
- Consumes: `query::{MessageGroup, MessageRow, MessagePage, list_message_groups, list_messages, get_message_detail, list_ecus}` (Tasks 1-2), `trace_store::open` (existing).
- Produces: `#[tauri::command] fn list_message_groups(blf_path: String) -> Result<Vec<query::MessageGroup>, String>`, `#[tauri::command] fn list_messages(blf_path: String, group_key: String, cursor: Option<i64>, limit: i64) -> Result<query::MessagePage, String>`, `#[tauri::command] fn get_message_detail(blf_path: String, msg_id: i64) -> Result<query::MessageRow, String>`, `#[tauri::command] fn list_ecus(blf_path: String) -> Result<Vec<String>, String>`.

- [ ] **Step 1: Add the four thin command wrappers**

Insert into `app/src-tauri/src/main.rs`, above `fn main()`:

```rust
#[tauri::command]
fn list_message_groups(blf_path: String) -> Result<Vec<query::MessageGroup>, String> {
    let duckdb_path = std::path::Path::new(&blf_path).with_extension("duckdb");
    let conn = trace_store::open(&duckdb_path)?;
    query::list_message_groups(&conn)
}

#[tauri::command]
fn list_messages(
    blf_path: String,
    group_key: String,
    cursor: Option<i64>,
    limit: i64,
) -> Result<query::MessagePage, String> {
    let duckdb_path = std::path::Path::new(&blf_path).with_extension("duckdb");
    let conn = trace_store::open(&duckdb_path)?;
    query::list_messages(&conn, &group_key, cursor, limit)
}

#[tauri::command]
fn get_message_detail(blf_path: String, msg_id: i64) -> Result<query::MessageRow, String> {
    let duckdb_path = std::path::Path::new(&blf_path).with_extension("duckdb");
    let conn = trace_store::open(&duckdb_path)?;
    query::get_message_detail(&conn, msg_id)
}

#[tauri::command]
fn list_ecus(blf_path: String) -> Result<Vec<String>, String> {
    let duckdb_path = std::path::Path::new(&blf_path).with_extension("duckdb");
    let conn = trace_store::open(&duckdb_path)?;
    query::list_ecus(&conn)
}
```

- [ ] **Step 2: Register the four commands**

Change the `invoke_handler` line in `fn main()`:

```rust
        .invoke_handler(tauri::generate_handler![
            prepare_trace,
            get_trace_summary,
            list_message_groups,
            list_messages,
            get_message_detail,
            list_ecus
        ])
```

- [ ] **Step 3: Verify it builds and existing tests still pass**

Run: `cargo test --manifest-path app/src-tauri/Cargo.toml`
Expected: PASS (existing 5 tests, unchanged - these four commands are thin passthroughs with no new branching logic, so no new Rust test is needed here; their behavior is covered by Task 1-2's `crates/query` tests).

- [ ] **Step 4: Commit**

```bash
git add app/src-tauri/src/main.rs
git commit -m "feat(app): expose message-group, message-list, message-detail, and ECU-list commands"
```

---

## Task 4: `app/ui` - Tailwind + shadcn-style primitives, themed from the project's design tokens

**Files:**
- Modify: `app/ui/package.json`
- Modify: `app/ui/tsconfig.json`
- Modify: `app/ui/vite.config.ts`
- Modify: `app/ui/src/main.tsx`
- Create: `app/ui/tailwind.config.ts`
- Create: `app/ui/postcss.config.js`
- Create: `app/ui/src/app/theme.css`
- Create: `app/ui/src/shared/ui/lib/utils.ts`
- Create: `app/ui/src/shared/ui/button.tsx`
- Create: `app/ui/src/shared/ui/badge.tsx`
- Create: `app/ui/src/shared/ui/card.tsx`
- Create: `app/ui/src/shared/ui/tabs.tsx`
- Create: `app/ui/src/shared/ui/scroll-area.tsx`
- Create: `app/ui/src/shared/ui/separator.tsx`
- Create: `app/ui/src/shared/ui/resizable.tsx`

**Interfaces:**
- Produces: `cn()` util; `Button`, `Badge`, `Card`/`CardHeader`/`CardTitle`/`CardContent`, `Tabs`/`TabsList`/`TabsTrigger`/`TabsContent`, `ScrollArea`, `Separator`, `ResizablePanelGroup`/`ResizablePanel`/`ResizableHandle` - all imported via the `@/shared/ui/*` alias from Task 7 onward.

- [ ] **Step 1: Install dependencies**

```bash
npm install --prefix app/ui react-resizable-panels @radix-ui/react-slot @radix-ui/react-tabs @radix-ui/react-scroll-area @radix-ui/react-separator class-variance-authority clsx tailwind-merge lucide-react
npm install --prefix app/ui -D tailwindcss postcss autoprefixer tailwindcss-animate
```

- [ ] **Step 2: Add the `@/*` path alias**

In `app/ui/tsconfig.json`, add inside `compilerOptions`:

```json
    "baseUrl": ".",
    "paths": { "@/*": ["./src/*"] },
```

In `app/ui/vite.config.ts`, replace entirely with:

```ts
import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  server: {
    port: 5173,
    strictPort: true,
  },
});
```

- [ ] **Step 3: Create the Tailwind and PostCSS configs**

Create `app/ui/tailwind.config.ts`:

```ts
import type { Config } from "tailwindcss";

export default {
  darkMode: "class",
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        background: "var(--background)",
        foreground: "var(--foreground)",
        card: { DEFAULT: "var(--card)", foreground: "var(--card-foreground)" },
        popover: { DEFAULT: "var(--popover)", foreground: "var(--popover-foreground)" },
        primary: {
          DEFAULT: "var(--primary)",
          foreground: "var(--primary-foreground)",
          hover: "var(--primary-hover)",
        },
        secondary: { DEFAULT: "var(--secondary)", foreground: "var(--secondary-foreground)" },
        muted: { DEFAULT: "var(--muted)", foreground: "var(--muted-foreground)" },
        accent: { DEFAULT: "var(--accent-bg)", foreground: "var(--accent-bg-foreground)" },
        destructive: { DEFAULT: "var(--destructive)", foreground: "var(--destructive-foreground)" },
        border: "var(--border)",
        input: "var(--input)",
        ring: "var(--ring)",
      },
      borderRadius: {
        lg: "var(--radius)",
        md: "calc(var(--radius) - 2px)",
        sm: "calc(var(--radius) - 4px)",
      },
      fontFamily: {
        sans: ["var(--font-body)", "system-ui", "sans-serif"],
        display: ["var(--font-display)", "system-ui", "sans-serif"],
        mono: ["var(--font-mono)", "ui-monospace", "monospace"],
      },
    },
  },
  plugins: [require("tailwindcss-animate")],
} satisfies Config;
```

Create `app/ui/postcss.config.js`:

```js
export default {
  plugins: {
    tailwindcss: {},
    autoprefixer: {},
  },
};
```

- [ ] **Step 4: Create the theme file (tokens.css values, remapped to shadcn's expected variable names)**

Create `app/ui/src/app/theme.css`:

```css
@import url('https://fonts.googleapis.com/css2?family=DM+Sans:ital,opsz,wght@0,9..40,400;0,9..40,500;0,9..40,600;0,9..40,700;1,9..40,400&family=Lato:wght@400;700&family=JetBrains+Mono:wght@400;500;700&display=swap');

@tailwind base;
@tailwind components;
@tailwind utilities;

:root {
  /* ---- Copied from automotive-trace-analysis/project/tokens.css ---- */
  --slate-0: #FFFFFF;
  --slate-50: #F7F9FB;
  --slate-100: #EEF2F6;
  --slate-200: #D7DEE7;
  --slate-400: #94A3B4;
  --slate-500: #697587;
  --slate-900: #141A22;

  --indigo-50: #EEF0FE;
  --indigo-500: #4F5BE0;
  --indigo-600: #3F49C7;

  --red-500: #E23B40;

  --bg-app: var(--slate-50);
  --bg-surface: var(--slate-0);
  --fg-primary: var(--slate-900);
  --fg-secondary: var(--slate-500);
  --fg-inverse: #FFFFFF;

  --border-default: var(--slate-100);
  --border-strong: var(--slate-200);
  --border-focus: var(--indigo-500);

  --accent: var(--indigo-600);
  --accent-hover: var(--indigo-500);
  --accent-soft: var(--indigo-50);

  --font-display: 'DM Sans', system-ui, sans-serif;
  --font-body: 'Lato', system-ui, sans-serif;
  --font-mono: 'JetBrains Mono', ui-monospace, monospace;

  --radius-md: 7px;

  /* ---- shadcn semantic aliases ----
     This project's --accent (brand/primary action color, the "purple" the
     user asked to match) maps to shadcn's --primary. shadcn's OWN --accent
     (hover/subtle-highlight background) is a different concept with the
     same name - it is aliased to --accent-bg below to avoid a collision. */
  --background: var(--bg-app);
  --foreground: var(--fg-primary);
  --card: var(--bg-surface);
  --card-foreground: var(--fg-primary);
  --popover: var(--bg-surface);
  --popover-foreground: var(--fg-primary);
  --primary: var(--accent);
  --primary-foreground: var(--fg-inverse);
  --primary-hover: var(--accent-hover);
  --secondary: var(--slate-100);
  --secondary-foreground: var(--fg-primary);
  --muted: var(--slate-100);
  --muted-foreground: var(--fg-secondary);
  --accent-bg: var(--accent-soft);
  --accent-bg-foreground: var(--fg-primary);
  --destructive: var(--red-500);
  --destructive-foreground: var(--fg-inverse);
  --border: var(--border-default);
  --input: var(--border-strong);
  --ring: var(--border-focus);
  --radius: var(--radius-md);
}

@layer base {
  body {
    @apply bg-background text-foreground font-sans;
    margin: 0;
  }
}
```

- [ ] **Step 5: Import the theme file**

In `app/ui/src/main.tsx`, add the import at the top (above the `App` import):

```ts
import "./app/theme.css";
```

- [ ] **Step 6: Create the `cn` helper**

Create `app/ui/src/shared/ui/lib/utils.ts`:

```ts
import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
```

- [ ] **Step 7: Create the primitives**

Create `app/ui/src/shared/ui/button.tsx`:

```tsx
import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/shared/ui/lib/utils";

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground shadow hover:bg-primary-hover",
        outline: "border border-input bg-background shadow-sm hover:bg-accent hover:text-accent-foreground",
        secondary: "bg-secondary text-secondary-foreground shadow-sm hover:bg-secondary/80",
        ghost: "hover:bg-accent hover:text-accent-foreground",
      },
      size: {
        default: "h-9 px-4 py-2",
        sm: "h-8 rounded-md px-3 text-xs",
        icon: "h-9 w-9",
      },
    },
    defaultVariants: { variant: "default", size: "default" },
  }
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : "button";
    return <Comp className={cn(buttonVariants({ variant, size, className }))} ref={ref} {...props} />;
  }
);
Button.displayName = "Button";

export { Button, buttonVariants };
```

Create `app/ui/src/shared/ui/badge.tsx`:

```tsx
import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/shared/ui/lib/utils";

const badgeVariants = cva(
  "inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-medium",
  {
    variants: {
      variant: {
        default: "border-transparent bg-primary text-primary-foreground",
        secondary: "border-transparent bg-secondary text-secondary-foreground",
      },
    },
    defaultVariants: { variant: "default" },
  }
);

export interface BadgeProps extends React.HTMLAttributes<HTMLDivElement>, VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, ...props }: BadgeProps) {
  return <div className={cn(badgeVariants({ variant }), className)} {...props} />;
}

export { Badge, badgeVariants };
```

Create `app/ui/src/shared/ui/card.tsx`:

```tsx
import * as React from "react";
import { cn } from "@/shared/ui/lib/utils";

const Card = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div ref={ref} className={cn("rounded-lg border border-border bg-card text-card-foreground shadow-sm", className)} {...props} />
  )
);
Card.displayName = "Card";

const CardHeader = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => <div ref={ref} className={cn("flex flex-col gap-1.5 p-4", className)} {...props} />
);
CardHeader.displayName = "CardHeader";

const CardTitle = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => <div ref={ref} className={cn("text-sm font-semibold leading-none", className)} {...props} />
);
CardTitle.displayName = "CardTitle";

const CardContent = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => <div ref={ref} className={cn("p-4 pt-0", className)} {...props} />
);
CardContent.displayName = "CardContent";

export { Card, CardHeader, CardTitle, CardContent };
```

Create `app/ui/src/shared/ui/tabs.tsx`:

```tsx
import * as React from "react";
import * as TabsPrimitive from "@radix-ui/react-tabs";
import { cn } from "@/shared/ui/lib/utils";

const Tabs = TabsPrimitive.Root;

const TabsList = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.List>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.List>
>(({ className, ...props }, ref) => (
  <TabsPrimitive.List
    ref={ref}
    className={cn("inline-flex h-9 items-center justify-center rounded-lg bg-muted p-1 text-muted-foreground", className)}
    {...props}
  />
));
TabsList.displayName = TabsPrimitive.List.displayName;

const TabsTrigger = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.Trigger>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.Trigger>
>(({ className, ...props }, ref) => (
  <TabsPrimitive.Trigger
    ref={ref}
    className={cn(
      "inline-flex items-center justify-center whitespace-nowrap rounded-md px-3 py-1 text-sm font-medium transition-all disabled:pointer-events-none disabled:opacity-50 data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow",
      className
    )}
    {...props}
  />
));
TabsTrigger.displayName = TabsPrimitive.Trigger.displayName;

const TabsContent = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.Content>
>(({ className, ...props }, ref) => (
  <TabsPrimitive.Content ref={ref} className={cn("mt-2 focus-visible:outline-none", className)} {...props} />
));
TabsContent.displayName = TabsPrimitive.Content.displayName;

export { Tabs, TabsList, TabsTrigger, TabsContent };
```

Create `app/ui/src/shared/ui/scroll-area.tsx`:

```tsx
import * as React from "react";
import * as ScrollAreaPrimitive from "@radix-ui/react-scroll-area";
import { cn } from "@/shared/ui/lib/utils";

const ScrollArea = React.forwardRef<
  React.ElementRef<typeof ScrollAreaPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof ScrollAreaPrimitive.Root>
>(({ className, children, ...props }, ref) => (
  <ScrollAreaPrimitive.Root ref={ref} className={cn("relative overflow-hidden", className)} {...props}>
    <ScrollAreaPrimitive.Viewport className="h-full w-full rounded-[inherit]">{children}</ScrollAreaPrimitive.Viewport>
    <ScrollAreaPrimitive.ScrollAreaScrollbar
      orientation="vertical"
      className="flex w-2.5 touch-none select-none border-l border-l-transparent p-[1px] transition-colors"
    >
      <ScrollAreaPrimitive.ScrollAreaThumb className="relative flex-1 rounded-full bg-border" />
    </ScrollAreaPrimitive.ScrollAreaScrollbar>
    <ScrollAreaPrimitive.Corner />
  </ScrollAreaPrimitive.Root>
));
ScrollArea.displayName = ScrollAreaPrimitive.Root.displayName;

export { ScrollArea };
```

Create `app/ui/src/shared/ui/separator.tsx`:

```tsx
import * as React from "react";
import * as SeparatorPrimitive from "@radix-ui/react-separator";
import { cn } from "@/shared/ui/lib/utils";

const Separator = React.forwardRef<
  React.ElementRef<typeof SeparatorPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof SeparatorPrimitive.Root>
>(({ className, orientation = "horizontal", decorative = true, ...props }, ref) => (
  <SeparatorPrimitive.Root
    ref={ref}
    decorative={decorative}
    orientation={orientation}
    className={cn("shrink-0 bg-border", orientation === "horizontal" ? "h-[1px] w-full" : "h-full w-[1px]", className)}
    {...props}
  />
));
Separator.displayName = SeparatorPrimitive.Root.displayName;

export { Separator };
```

Create `app/ui/src/shared/ui/resizable.tsx`:

```tsx
import * as React from "react";
import { GripVertical } from "lucide-react";
import * as ResizablePrimitive from "react-resizable-panels";
import { cn } from "@/shared/ui/lib/utils";

const ResizablePanelGroup = ({
  className,
  ...props
}: React.ComponentProps<typeof ResizablePrimitive.PanelGroup>) => (
  <ResizablePrimitive.PanelGroup
    className={cn("flex h-full w-full data-[panel-group-direction=vertical]:flex-col", className)}
    {...props}
  />
);

const ResizablePanel = ResizablePrimitive.Panel;

const ResizableHandle = ({
  withHandle,
  className,
  ...props
}: React.ComponentProps<typeof ResizablePrimitive.PanelResizeHandle> & { withHandle?: boolean }) => (
  <ResizablePrimitive.PanelResizeHandle
    className={cn(
      "relative flex w-px items-center justify-center bg-border data-[panel-group-direction=vertical]:h-px data-[panel-group-direction=vertical]:w-full",
      className
    )}
    {...props}
  >
    {withHandle && (
      <div className="z-10 flex h-4 w-3 items-center justify-center rounded-sm border border-border bg-border">
        <GripVertical className="h-2.5 w-2.5" />
      </div>
    )}
  </ResizablePrimitive.PanelResizeHandle>
);

export { ResizablePanelGroup, ResizablePanel, ResizableHandle };
```

- [ ] **Step 8: Manual verification**

Temporarily replace the body of `app/ui/src/main.tsx`'s render call with a demo (`<Button>Primary</Button> <Button variant="outline">Outline</Button> <Badge>12</Badge> <Card><CardHeader><CardTitle>Trace Info</CardTitle></CardHeader><CardContent>Hello</CardContent></Card>`), run `npm run dev --prefix app/ui`, and open the dev server in a browser. Confirm: the default Button is indigo/purple (`#3F49C7`) with white text, not generic blue; the Card has a `7px` border radius and a hairline border (`#EEF2F6`); the font is DM Sans headings / Lato body, not the browser default sans. Revert the demo change afterward - `app/ui/src/main.tsx` should end this task back at its Task 4 Step 5 state (just the new `theme.css` import added).

- [ ] **Step 9: Confirm the full build still passes and commit**

Run: `npm run build --prefix app/ui`
Expected: `tsc && vite build` succeeds.

```bash
git add app/ui/package.json app/ui/package-lock.json app/ui/tsconfig.json app/ui/vite.config.ts app/ui/main.tsx app/ui/tailwind.config.ts app/ui/postcss.config.js app/ui/src/main.tsx app/ui/src/app/theme.css app/ui/src/shared/ui
git commit -m "feat(ui): add Tailwind and shadcn-style primitives themed from the project's design tokens"
```

---

## Task 5: `app/ui` - Zustand workspace-selection store

**Files:**
- Create: `app/ui/src/app/store.ts`

**Interfaces:**
- Produces: `export type LeftTab = "signals" | "messages" | "ecus"`, `export interface WorkspaceState { selectedGroupKey: string | null; selectedMessageId: number | null; leftTab: LeftTab; setSelectedGroup(key: string | null): void; setSelectedMessage(id: number | null): void; setLeftTab(tab: LeftTab): void; }`, `export const useWorkspaceStore`.

- [ ] **Step 1: Install Zustand**

```bash
npm install --prefix app/ui zustand
```

- [ ] **Step 2: Create the store**

Create `app/ui/src/app/store.ts`:

```ts
import { create } from "zustand";

export type LeftTab = "signals" | "messages" | "ecus";

export interface WorkspaceState {
  selectedGroupKey: string | null;
  selectedMessageId: number | null;
  leftTab: LeftTab;
  setSelectedGroup: (key: string | null) => void;
  setSelectedMessage: (id: number | null) => void;
  setLeftTab: (tab: LeftTab) => void;
}

export const useWorkspaceStore = create<WorkspaceState>((set) => ({
  selectedGroupKey: null,
  selectedMessageId: null,
  leftTab: "messages",
  // Switching groups must drop any message selection from the previous
  // group - otherwise MessageDetails keeps showing a message that no
  // longer belongs to the group currently being browsed.
  setSelectedGroup: (key) => set({ selectedGroupKey: key, selectedMessageId: null }),
  setSelectedMessage: (id) => set({ selectedMessageId: id }),
  setLeftTab: (tab) => set({ leftTab: tab }),
}));
```

- [ ] **Step 3: Manual verification**

Temporarily add, in `app/ui/src/main.tsx`, after the existing imports: `import { useWorkspaceStore } from "./app/store"; console.log(useWorkspaceStore.getState());` and in a throwaway script tag or by calling `useWorkspaceStore.getState().setSelectedGroup("can:100")` then `useWorkspaceStore.getState().setSelectedMessage(42)` then `useWorkspaceStore.getState().setSelectedGroup("can:200")` from the browser dev console while `npm run dev --prefix app/ui` is running - confirm the final `getState()` printout shows `selectedMessageId: null` (the group switch cleared it). Revert the temporary console.log line afterward.

- [ ] **Step 4: Confirm the build passes and commit**

Run: `npm run build --prefix app/ui`
Expected: succeeds.

```bash
git add app/ui/src/app/store.ts
git commit -m "feat(ui): add the workspace pane-selection store"
```

---

## Task 6: `app/ui` - React Query provider + global toast error stack

**Files:**
- Create: `app/ui/src/app/toast-store.ts`
- Create: `app/ui/src/widgets/Toaster.tsx`
- Create: `app/ui/src/app/query-client.ts`
- Modify: `app/ui/src/App.tsx`

**Interfaces:**
- Produces: `export interface Toast { id: number; message: string }`, `export const useToastStore` (`pushError(message: string): void`, `dismiss(id: number): void`, `toasts: Toast[]`); `export default function Toaster()` (renders the stack, mounted by `WorkspaceLayout` in Task 7); `export const queryClient: QueryClient`, wired so every failed query/mutation calls `useToastStore.getState().pushError(...)` exactly once, globally - no widget pushes its own toasts.

- [ ] **Step 1: Install React Query**

```bash
npm install --prefix app/ui @tanstack/react-query
```

- [ ] **Step 2: Create the toast store**

Create `app/ui/src/app/toast-store.ts`:

```ts
import { create } from "zustand";

export interface Toast {
  id: number;
  message: string;
}

interface ToastState {
  toasts: Toast[];
  pushError: (message: string) => void;
  dismiss: (id: number) => void;
}

let nextId = 1;

export const useToastStore = create<ToastState>((set) => ({
  toasts: [],
  pushError: (message) => set((state) => ({ toasts: [...state.toasts, { id: nextId++, message }] })),
  dismiss: (id) => set((state) => ({ toasts: state.toasts.filter((t) => t.id !== id) })),
}));
```

- [ ] **Step 3: Create the query client, wired to push every query error into the toast store**

Create `app/ui/src/app/query-client.ts`:

```ts
import { QueryCache, QueryClient } from "@tanstack/react-query";
import { useToastStore } from "./toast-store";

export const queryClient = new QueryClient({
  // Single, global catch for every failed query (including each page of
  // an infinite query) - this is the one place that turns a rejected
  // TraceDataSource call into user-visible feedback, so individual
  // widgets don't each need their own error-banner rendering.
  queryCache: new QueryCache({
    onError: (error) => {
      useToastStore.getState().pushError(String(error));
    },
  }),
  defaultOptions: {
    queries: {
      retry: 1,
      staleTime: 30_000,
    },
  },
});
```

- [ ] **Step 4: Create the Toaster widget**

Create `app/ui/src/widgets/Toaster.tsx`:

```tsx
import { useToastStore } from "@/app/toast-store";

export default function Toaster() {
  const toasts = useToastStore((s) => s.toasts);
  const dismiss = useToastStore((s) => s.dismiss);

  if (toasts.length === 0) return null;

  return (
    <div className="pointer-events-none fixed bottom-4 right-4 z-50 flex flex-col gap-2">
      {toasts.map((t) => (
        <div
          key={t.id}
          className="pointer-events-auto flex max-w-sm items-start gap-2 rounded-md border border-destructive bg-card px-3 py-2 text-sm text-destructive shadow-lg"
        >
          <span className="flex-1">{t.message}</span>
          <button onClick={() => dismiss(t.id)} className="text-muted-foreground hover:text-foreground" aria-label="Dismiss">
            &times;
          </button>
        </div>
      ))}
    </div>
  );
}
```

- [ ] **Step 5: Wrap `App.tsx` in the provider**

In `app/ui/src/App.tsx`, add the import:

```tsx
import { QueryClientProvider } from "@tanstack/react-query";
import { queryClient } from "./app/query-client";
```

Wrap the function's return value in `<QueryClientProvider client={queryClient}>...</QueryClientProvider>` - no other change in this task; the existing `if (screen === ...)` branches stay as they are, each `return` statement becomes `return <QueryClientProvider client={queryClient}>{existingJsx}</QueryClientProvider>;`. (`Toaster` itself is not mounted here - it's mounted inside `WorkspaceLayout` in Task 7, since it only has anything to show once the workspace's own queries exist.)

- [ ] **Step 6: Manual verification**

Run `npm run dev --prefix app/ui` and confirm the Welcome -> Progress -> Summary/Error flow still works exactly as before (this task adds a provider and an unmounted toast widget, so behavior must be unchanged). Separately, in the browser console, run `useToastStore.getState().pushError("test error")` (temporarily expose it via `window.__toastStore = useToastStore` in `main.tsx`, call it, then revert) and confirm nothing renders yet - `Toaster` isn't mounted until Task 7.

- [ ] **Step 7: Confirm the build passes and commit**

Run: `npm run build --prefix app/ui`
Expected: succeeds.

```bash
git add app/ui/package.json app/ui/package-lock.json app/ui/src/app/toast-store.ts app/ui/src/widgets/Toaster.tsx app/ui/src/app/query-client.ts app/ui/src/App.tsx
git commit -m "feat(ui): add a React Query provider with a global, stacking toast error display"
```

---

## Task 7: `app/ui` - `WorkspaceLayout` widget (resizable pane shell)

**Files:**
- Create: `app/ui/src/widgets/WorkspaceLayout.tsx`

**Interfaces:**
- Consumes: `ResizablePanelGroup`/`ResizablePanel`/`ResizableHandle` (Task 4), `Toaster` (Task 6).
- Produces: `interface WorkspaceLayoutProps { blfPath: string; prepareTotals: { messages: number; protocol_rows: number; elapsed_ms: number }; onOpenTrace: () => void }`, `export default function WorkspaceLayout(props: WorkspaceLayoutProps)`. This task's panes are plain placeholder `<div>`s; Tasks 9-13 replace each placeholder with the real widget, and Task 14 wires `WorkspaceLayout` into `App.tsx`.

- [ ] **Step 1: CHECKPOINT - present the interface and JSX, wait for approval**

Before creating `WorkspaceLayout.tsx`, show the user this task's **Interfaces** block and the JSX in Step 2 below, and wait for their explicit go-ahead. Do not proceed to Step 2 until they approve (adjust the layout per their feedback if they ask for changes, then re-confirm).

- [ ] **Step 2: Create the widget**

Create `app/ui/src/widgets/WorkspaceLayout.tsx`:

```tsx
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/shared/ui/resizable";
import Toaster from "./Toaster";

interface WorkspaceLayoutProps {
  blfPath: string;
  prepareTotals: { messages: number; protocol_rows: number; elapsed_ms: number };
  onOpenTrace: () => void;
}

export default function WorkspaceLayout({ blfPath, prepareTotals, onOpenTrace }: WorkspaceLayoutProps) {
  return (
    <div className="flex h-screen flex-col">
      <div className="flex h-[50px] shrink-0 items-center border-b border-border bg-card px-4 text-sm font-semibold">
        Top Bar
      </div>
      <div className="flex-1">
        <ResizablePanelGroup direction="horizontal">
          <ResizablePanel defaultSize={20} minSize={15}>
            <div className="flex h-full items-center justify-center text-sm text-muted-foreground">Trace Rail</div>
          </ResizablePanel>
          <ResizableHandle withHandle />
          <ResizablePanel defaultSize={55}>
            <ResizablePanelGroup direction="vertical">
              <ResizablePanel defaultSize={40} minSize={20}>
                <div className="flex h-full items-center justify-center text-sm text-muted-foreground">Timeline</div>
              </ResizablePanel>
              <ResizableHandle withHandle />
              <ResizablePanel defaultSize={35} minSize={15}>
                <div className="flex h-full items-center justify-center text-sm text-muted-foreground">Message List</div>
              </ResizablePanel>
              <ResizableHandle withHandle />
              <ResizablePanel defaultSize={25} minSize={15}>
                <div className="flex h-full items-center justify-center text-sm text-muted-foreground">Message Details</div>
              </ResizablePanel>
            </ResizablePanelGroup>
          </ResizablePanel>
          <ResizableHandle withHandle />
          <ResizablePanel defaultSize={25} minSize={15}>
            <div className="flex h-full items-center justify-center text-sm text-muted-foreground">Analyzer</div>
          </ResizablePanel>
        </ResizablePanelGroup>
      </div>
      <Toaster />
    </div>
  );
}
```

- [ ] **Step 3: Manual verification**

This widget isn't mounted anywhere until Task 14. Temporarily render it from `app/ui/src/main.tsx` (`<WorkspaceLayout blfPath="" prepareTotals={{ messages: 0, protocol_rows: 0, elapsed_ms: 0 }} onOpenTrace={() => {}} />`), run `npm run dev --prefix app/ui`, and confirm: five labeled panes fill the window, every pane boundary (including the two nested ones inside the center column) can be dragged to resize, and no pane collapses to zero width/height when dragged to its `minSize`. Revert the temporary render in `main.tsx` afterward.

- [ ] **Step 4: Confirm the build passes and commit**

Run: `npm run build --prefix app/ui`
Expected: succeeds (the file is unused until Task 14, so `tsc`'s "unused" checks must stay off, which they already are - no `noUnusedLocals` in `tsconfig.json`).

```bash
git add app/ui/src/widgets/WorkspaceLayout.tsx
git commit -m "feat(ui): add the resizable WorkspaceLayout pane shell"
```

---

## Task 8: `app/ui` - `shared/api` data-source layer

**Files:**
- Create: `app/ui/src/shared/api/trace-source.ts`
- Create: `app/ui/src/shared/api/hooks.ts`

**Interfaces:**
- Consumes: `TraceSummary` (`app/ui/src/types.ts`, existing), Tauri commands `get_trace_summary`, `list_message_groups`, `list_messages`, `get_message_detail`, `list_ecus` (Task 3).
- Produces: `MessageGroup`, `MessageRow`, `MessagePage`, `MessageDetail`, `EcuInfo` types; `TraceDataSource` interface; `TauriTraceDataSource` class; `setTraceDataSource`/`getTraceDataSource`; hooks `useTraceSummary`, `useMessageGroups`, `useEcus`, `useMessages`, `useMessageDetail` - all consumed starting Task 9.

- [ ] **Step 1: Create the data-source interface and Tauri implementation**

Create `app/ui/src/shared/api/trace-source.ts`:

```ts
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
```

- [ ] **Step 2: Create the React Query hooks**

Create `app/ui/src/shared/api/hooks.ts`:

```ts
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { getTraceDataSource } from "./trace-source";

const MESSAGE_PAGE_SIZE = 200;

export function useTraceSummary(blfPath: string) {
  return useQuery({
    queryKey: ["trace-summary", blfPath],
    queryFn: () => getTraceDataSource().getTraceSummary(blfPath),
  });
}

export function useMessageGroups(blfPath: string) {
  return useQuery({
    queryKey: ["message-groups", blfPath],
    queryFn: () => getTraceDataSource().listMessageGroups(blfPath),
  });
}

export function useEcus(blfPath: string) {
  return useQuery({
    queryKey: ["ecus", blfPath],
    queryFn: () => getTraceDataSource().listEcus(blfPath),
  });
}

export function useMessages(blfPath: string, groupKey: string | null) {
  return useInfiniteQuery({
    queryKey: ["messages", blfPath, groupKey],
    queryFn: ({ pageParam }) =>
      getTraceDataSource().listMessages(blfPath, groupKey as string, pageParam, MESSAGE_PAGE_SIZE),
    initialPageParam: null as number | null,
    // React Query's infinite-query pagination only stops fetching when this
    // returns `undefined` - a `null` passed straight through (the API
    // contract's "no more pages" value) would be treated as a valid next
    // param and loop forever re-requesting the last page.
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    enabled: groupKey !== null,
  });
}

export function useMessageDetail(blfPath: string, msgId: number | null) {
  return useQuery({
    queryKey: ["message-detail", blfPath, msgId],
    queryFn: () => getTraceDataSource().getMessageDetail(blfPath, msgId as number),
    enabled: msgId !== null,
  });
}
```

- [ ] **Step 3: Manual verification**

Run `npm run build --prefix app/ui` and confirm it type-checks cleanly. Separately, cross-check by hand that every field name in `MessageGroup`/`MessageRow`/`MessagePage` here matches, character-for-character, the `#[serde(rename_all = "camelCase")]`-ed field names in `crates/query/src/lib.rs` (Tasks 1-2) - `tsc` cannot catch a mismatch here since the Tauri bridge is untyped at the boundary; a typo would silently deserialize to `undefined` at runtime.

- [ ] **Step 4: Commit**

```bash
git add app/ui/src/shared/api
git commit -m "feat(ui): add the TraceDataSource abstraction and its React Query hooks"
```

---

## Task 9: `app/ui` - `TraceRail` widget

**Files:**
- Create: `app/ui/src/widgets/TraceRail.tsx`

**Interfaces:**
- Consumes: `useTraceSummary`, `useMessageGroups`, `useEcus` (Task 8); `useWorkspaceStore` (Task 5); `Card`/`CardHeader`/`CardTitle`/`CardContent`, `Tabs`/`TabsList`/`TabsTrigger`/`TabsContent`, `ScrollArea`, `Badge`, `cn` (Task 4).
- Produces: `interface TraceRailProps { blfPath: string }`, `export default function TraceRail(props: TraceRailProps)`.

- [ ] **Step 1: CHECKPOINT - present the interface and JSX, wait for approval**

Before creating `TraceRail.tsx`, show the user the **Interfaces** block above and the JSX in Step 2, and wait for explicit approval before proceeding.

- [ ] **Step 2: Create the widget**

Create `app/ui/src/widgets/TraceRail.tsx`:

```tsx
import { useWorkspaceStore, type LeftTab } from "@/app/store";
import { useEcus, useMessageGroups, useTraceSummary } from "@/shared/api/hooks";
import { Badge } from "@/shared/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/shared/ui/card";
import { cn } from "@/shared/ui/lib/utils";
import { ScrollArea } from "@/shared/ui/scroll-area";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/shared/ui/tabs";

interface TraceRailProps {
  blfPath: string;
}

export default function TraceRail({ blfPath }: TraceRailProps) {
  const summary = useTraceSummary(blfPath);
  const groups = useMessageGroups(blfPath);
  const ecus = useEcus(blfPath);
  const leftTab = useWorkspaceStore((s) => s.leftTab);
  const setLeftTab = useWorkspaceStore((s) => s.setLeftTab);
  const selectedGroupKey = useWorkspaceStore((s) => s.selectedGroupKey);
  const setSelectedGroup = useWorkspaceStore((s) => s.setSelectedGroup);

  return (
    <div className="flex h-full flex-col gap-3 p-3">
      <Card>
        <CardHeader>
          <CardTitle>Trace Info</CardTitle>
        </CardHeader>
        <CardContent className="space-y-1 text-sm text-muted-foreground">
          {summary.isPending && <p>Loading summary...</p>}
          {summary.isError && <p>Couldn't load trace summary - see error notification.</p>}
          {summary.data && (
            <>
              <p>CAN messages: {summary.data.can_messages}</p>
              <p>Ethernet messages: {summary.data.ethernet_messages}</p>
            </>
          )}
        </CardContent>
      </Card>

      <Tabs value={leftTab} onValueChange={(v) => setLeftTab(v as LeftTab)} className="flex min-h-0 flex-1 flex-col">
        <TabsList className="w-full">
          <TabsTrigger value="signals" disabled>
            Signals
          </TabsTrigger>
          <TabsTrigger value="messages">Messages</TabsTrigger>
          <TabsTrigger value="ecus">ECUs</TabsTrigger>
        </TabsList>

        <TabsContent value="signals">
          <p className="p-3 text-sm text-muted-foreground">Signal catalog - coming soon.</p>
        </TabsContent>

        <TabsContent value="messages" className="min-h-0 flex-1">
          <ScrollArea className="h-full">
            {groups.isPending && <p className="p-3 text-sm text-muted-foreground">Loading...</p>}
            {groups.isError && <p className="p-3 text-sm text-muted-foreground">Couldn't load message groups.</p>}
            {groups.data?.length === 0 && (
              <p className="p-3 text-sm text-muted-foreground">No messages in this trace.</p>
            )}
            {groups.data?.map((g) => (
              <button
                key={g.key}
                onClick={() => setSelectedGroup(g.key)}
                className={cn(
                  "flex w-full items-center justify-between px-3 py-2 text-left text-sm hover:bg-accent",
                  selectedGroupKey === g.key && "bg-accent"
                )}
              >
                <span>
                  {g.busLabel} - {g.label}
                </span>
                <Badge variant="secondary">{g.count}</Badge>
              </button>
            ))}
          </ScrollArea>
        </TabsContent>

        <TabsContent value="ecus" className="min-h-0 flex-1">
          <ScrollArea className="h-full">
            {ecus.isPending && <p className="p-3 text-sm text-muted-foreground">Loading...</p>}
            {ecus.isError && <p className="p-3 text-sm text-muted-foreground">Couldn't load ECUs.</p>}
            {ecus.data?.length === 0 && (
              <p className="p-3 text-sm text-muted-foreground">No ECUs in this trace's ARXML.</p>
            )}
            {ecus.data?.map((e) => (
              <div key={e.name} className="px-3 py-2 text-sm">
                {e.name}
              </div>
            ))}
          </ScrollArea>
        </TabsContent>
      </Tabs>
    </div>
  );
}
```

- [ ] **Step 3: Wire into `WorkspaceLayout`'s left pane**

In `app/ui/src/widgets/WorkspaceLayout.tsx`, replace the `Trace Rail` placeholder `<div>` with `<TraceRail blfPath={blfPath} />`, and add the import `import TraceRail from "./TraceRail";`.

- [ ] **Step 4: Manual verification**

Not runnable end-to-end until Task 14 wires a real `blfPath` from `App.tsx` - for now, re-read the component against the Review Focus list: an empty `groups.data` array renders "No messages in this trace." rather than nothing (Review Focus item 1); `groups.isError`/`ecus.isError`/`summary.isError` each fall back to a neutral local message while the actual error text goes to the global toast stack from Task 6's `QueryCache.onError` (Review Focus item 4). Run `npm run build --prefix app/ui` to confirm it type-checks.

- [ ] **Step 5: Commit**

```bash
git add app/ui/src/widgets/TraceRail.tsx app/ui/src/widgets/WorkspaceLayout.tsx
git commit -m "feat(ui): add the TraceRail widget (trace info, message groups, ECUs)"
```

---

## Task 10: `app/ui` - `MessageList` widget

**Files:**
- Create: `app/ui/src/widgets/MessageList.tsx`
- Modify: `app/ui/src/widgets/WorkspaceLayout.tsx`

**Interfaces:**
- Consumes: `useMessages` (Task 8); `useWorkspaceStore` (Task 5); `useVirtualizer` (`@tanstack/react-virtual`).
- Produces: `interface MessageListProps { blfPath: string }`, `export default function MessageList(props: MessageListProps)`.

- [ ] **Step 1: CHECKPOINT - present the interface and JSX, wait for approval**

Before creating `MessageList.tsx`, show the user the **Interfaces** block above and the JSX in Step 3, and wait for explicit approval before proceeding.

- [ ] **Step 2: Install `@tanstack/react-virtual`**

```bash
npm install --prefix app/ui @tanstack/react-virtual
```

- [ ] **Step 3: Create the widget**

Create `app/ui/src/widgets/MessageList.tsx`:

```tsx
import { useRef } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useWorkspaceStore } from "@/app/store";
import { useMessages } from "@/shared/api/hooks";
import { cn } from "@/shared/ui/lib/utils";

interface MessageListProps {
  blfPath: string;
}

export default function MessageList({ blfPath }: MessageListProps) {
  const selectedGroupKey = useWorkspaceStore((s) => s.selectedGroupKey);
  const selectedMessageId = useWorkspaceStore((s) => s.selectedMessageId);
  const setSelectedMessage = useWorkspaceStore((s) => s.setSelectedMessage);
  const { data, isPending, isError, fetchNextPage, hasNextPage, isFetchingNextPage } = useMessages(
    blfPath,
    selectedGroupKey
  );

  const rows = data ? data.pages.flatMap((p) => p.rows) : [];
  const parentRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 28,
    overscan: 10,
  });

  if (selectedGroupKey === null) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        Select a message group from the left rail.
      </div>
    );
  }
  if (isPending) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        Loading messages...
      </div>
    );
  }
  if (isError) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        Couldn't load messages - see error notification.
      </div>
    );
  }
  if (rows.length === 0) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        No messages in this group.
      </div>
    );
  }

  function onScroll() {
    const el = parentRef.current;
    if (!el || isFetchingNextPage || !hasNextPage) return;
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 200) {
      fetchNextPage();
    }
  }

  return (
    <div ref={parentRef} onScroll={onScroll} className="h-full overflow-auto">
      <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
        {virtualizer.getVirtualItems().map((item) => {
          const row = rows[item.index];
          return (
            <div
              key={row.msgId}
              onClick={() => setSelectedMessage(row.msgId)}
              className={cn(
                "absolute left-0 top-0 flex w-full items-center gap-4 border-b border-border px-3 font-mono text-xs",
                selectedMessageId === row.msgId && "bg-accent"
              )}
              style={{ height: item.size, transform: `translateY(${item.start}px)` }}
            >
              <span className="w-24 shrink-0">{row.timestampUs}</span>
              <span className="w-16 shrink-0">{row.idOrSrc}</span>
              <span className="flex-1 truncate">{row.name ?? "-"}</span>
              <span className="w-10 shrink-0 text-right">{row.dlc ?? row.payloadLen ?? "-"}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Wire into `WorkspaceLayout`'s center pane**

In `app/ui/src/widgets/WorkspaceLayout.tsx`, replace the `Message List` placeholder `<div>` with `<MessageList blfPath={blfPath} />`, and add the import `import MessageList from "./MessageList";`.

- [ ] **Step 5: Manual verification**

After Task 14 wires a real trace in: scroll to the bottom of a group with more than 200 messages and confirm the next page loads automatically without a visible jump; scroll to the actual end of the group and confirm it stops requesting (Review Focus item 2 - watch the Network/console for repeated `list_messages` calls with the same cursor, which would indicate the `null`/`undefined` bug resurfaced). Then, while scrolled partway down a long list, drag the handle between the Timeline and Message List panes to resize the Message List pane - confirm the visible rows stay correctly aligned with no blank gap or overlap after the resize (Review Focus item 5).

- [ ] **Step 6: Commit**

```bash
git add app/ui/package.json app/ui/package-lock.json app/ui/src/widgets/MessageList.tsx app/ui/src/widgets/WorkspaceLayout.tsx
git commit -m "feat(ui): add the virtualized, paginated MessageList widget"
```

---

## Task 11: `app/ui` - `MessageDetails` widget

**Files:**
- Create: `app/ui/src/widgets/MessageDetails.tsx`
- Modify: `app/ui/src/widgets/WorkspaceLayout.tsx`

**Interfaces:**
- Consumes: `useMessageDetail` (Task 8); `useWorkspaceStore` (Task 5); `Card`/`CardHeader`/`CardTitle`/`CardContent`, `Tabs`/`TabsList`/`TabsTrigger`/`TabsContent` (Task 4).
- Produces: `interface MessageDetailsProps { blfPath: string }`, `export default function MessageDetails(props: MessageDetailsProps)`.

- [ ] **Step 1: CHECKPOINT - present the interface and JSX, wait for approval**

Before creating `MessageDetails.tsx`, show the user the **Interfaces** block above and the JSX in Step 2, and wait for explicit approval before proceeding.

- [ ] **Step 2: Create the widget**

Create `app/ui/src/widgets/MessageDetails.tsx`:

```tsx
import { useWorkspaceStore } from "@/app/store";
import { useMessageDetail } from "@/shared/api/hooks";
import { Card, CardContent, CardHeader, CardTitle } from "@/shared/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/shared/ui/tabs";

interface MessageDetailsProps {
  blfPath: string;
}

export default function MessageDetails({ blfPath }: MessageDetailsProps) {
  const selectedMessageId = useWorkspaceStore((s) => s.selectedMessageId);
  const { data, isPending, isError } = useMessageDetail(blfPath, selectedMessageId);

  if (selectedMessageId === null) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        Select a message to see its details.
      </div>
    );
  }
  if (isPending) {
    return <div className="flex h-full items-center justify-center text-sm text-muted-foreground">Loading...</div>;
  }
  if (isError || !data) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        Couldn't load message details - see error notification.
      </div>
    );
  }

  return (
    <Card className="h-full rounded-none border-0 shadow-none">
      <CardHeader>
        <CardTitle>Message {data.msgId}</CardTitle>
      </CardHeader>
      <CardContent>
        <Tabs defaultValue="details">
          <TabsList>
            <TabsTrigger value="details">Details</TabsTrigger>
            <TabsTrigger value="raw" disabled>
              Raw
            </TabsTrigger>
            <TabsTrigger value="signals" disabled>
              Signal Decoding
            </TabsTrigger>
          </TabsList>
          <TabsContent value="details" className="space-y-1 text-sm">
            <p>Bus: {data.busLabel}</p>
            <p>ID/Source: {data.idOrSrc}</p>
            <p>Timestamp (us): {data.timestampUs}</p>
            <p>DLC: {data.dlc ?? "-"}</p>
            <p>Payload length: {data.payloadLen ?? "-"}</p>
          </TabsContent>
        </Tabs>
      </CardContent>
    </Card>
  );
}
```

- [ ] **Step 3: Wire into `WorkspaceLayout`'s center pane**

In `app/ui/src/widgets/WorkspaceLayout.tsx`, replace the `Message Details` placeholder `<div>` with `<MessageDetails blfPath={blfPath} />`, and add the import `import MessageDetails from "./MessageDetails";`.

- [ ] **Step 4: Manual verification**

After Task 14 wires a real trace in: click a row in `MessageList` and confirm `MessageDetails` updates to show that message's bus/ID/timestamp/DLC; switch to a different message group in `TraceRail` and confirm `MessageDetails` reverts to "Select a message to see its details." rather than showing stale data from the old group (Review Focus item 3, enforced by `setSelectedGroup` in Task 5's store).

- [ ] **Step 5: Commit**

```bash
git add app/ui/src/widgets/MessageDetails.tsx app/ui/src/widgets/WorkspaceLayout.tsx
git commit -m "feat(ui): add the MessageDetails widget"
```

---

## Task 12: `app/ui` - `TopBar` widget

**Files:**
- Create: `app/ui/src/widgets/TopBar.tsx`
- Modify: `app/ui/src/widgets/WorkspaceLayout.tsx`

**Interfaces:**
- Consumes: `Button` (Task 4).
- Produces: `interface TopBarProps { traceName: string; onOpenTrace: () => void }`, `export default function TopBar(props: TopBarProps)`.

- [ ] **Step 1: CHECKPOINT - present the interface and JSX, wait for approval**

Before creating `TopBar.tsx`, show the user the **Interfaces** block above and the JSX in Step 2, and wait for explicit approval before proceeding.

- [ ] **Step 2: Create the widget**

Create `app/ui/src/widgets/TopBar.tsx`:

```tsx
import { Button } from "@/shared/ui/button";

interface TopBarProps {
  traceName: string;
  onOpenTrace: () => void;
}

export default function TopBar({ traceName, onOpenTrace }: TopBarProps) {
  return (
    <header className="flex h-[50px] shrink-0 items-center justify-between border-b border-border bg-card px-4">
      <span className="truncate text-sm font-semibold">{traceName}</span>
      <div className="flex items-center gap-2">
        <Button variant="outline" size="sm" disabled>
          Play
        </Button>
        <Button variant="outline" size="sm" disabled>
          Pause
        </Button>
        <Button variant="secondary" size="sm" onClick={onOpenTrace}>
          Open Trace
        </Button>
      </div>
    </header>
  );
}
```

- [ ] **Step 3: Wire into `WorkspaceLayout`'s header**

In `app/ui/src/widgets/WorkspaceLayout.tsx`, replace the `Top Bar` placeholder `<div>` with `<TopBar traceName={blfPath.split(/[\\/]/).pop() ?? blfPath} onOpenTrace={onOpenTrace} />`, and add the import `import TopBar from "./TopBar";`.

- [ ] **Step 4: Manual verification**

After Task 14 wires a real trace in: confirm the top bar shows the trace's filename (not the full path), "Play"/"Pause" render visibly disabled, and clicking "Open Trace" returns to the Welcome screen.

- [ ] **Step 5: Commit**

```bash
git add app/ui/src/widgets/TopBar.tsx app/ui/src/widgets/WorkspaceLayout.tsx
git commit -m "feat(ui): add the TopBar widget"
```

---

## Task 13: `app/ui` - `TimelinePanel` and `AnalyzerPanel` stub widgets

**Files:**
- Create: `app/ui/src/widgets/TimelinePanel.tsx`
- Create: `app/ui/src/widgets/AnalyzerPanel.tsx`
- Modify: `app/ui/src/widgets/WorkspaceLayout.tsx`

**Interfaces:**
- Produces: `export default function TimelinePanel()`, `export default function AnalyzerPanel()` - both take no props.

- [ ] **Step 1: CHECKPOINT - present the interfaces and JSX, wait for approval**

Before creating either file, show the user the **Interfaces** block above and the JSX in Step 2, and wait for explicit approval before proceeding.

- [ ] **Step 2: Create the stub widgets**

Create `app/ui/src/widgets/TimelinePanel.tsx`:

```tsx
export default function TimelinePanel() {
  return (
    <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
      Timeline - coming soon.
    </div>
  );
}
```

Create `app/ui/src/widgets/AnalyzerPanel.tsx`:

```tsx
export default function AnalyzerPanel() {
  return (
    <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
      Analyzer script - coming soon.
    </div>
  );
}
```

- [ ] **Step 3: Wire into `WorkspaceLayout`**

In `app/ui/src/widgets/WorkspaceLayout.tsx`, replace the `Timeline` placeholder `<div>` with `<TimelinePanel />` and the `Analyzer` placeholder `<div>` with `<AnalyzerPanel />`; add both imports.

- [ ] **Step 4: Manual verification**

Confirm both panes show their "coming soon" text and are still independently resizable (no layout break from removing the placeholder text wrapper).

- [ ] **Step 5: Commit**

```bash
git add app/ui/src/widgets/TimelinePanel.tsx app/ui/src/widgets/AnalyzerPanel.tsx app/ui/src/widgets/WorkspaceLayout.tsx
git commit -m "feat(ui): add Timeline and Analyzer stub panes"
```

---

## Task 14: `app/ui` - wire `WorkspaceLayout` into `App.tsx`, retire `Summary.tsx`

**Files:**
- Modify: `app/ui/src/App.tsx`
- Delete: `app/ui/src/Summary.tsx`

**Interfaces:**
- Consumes: `WorkspaceLayout` (Tasks 7, 9-13), Tauri command `prepare_trace` (existing, returns the run's final `Done` tick directly per the Wave 2 race fix).

- [ ] **Step 1: Replace `App.tsx`**

Replace `app/ui/src/App.tsx` entirely with:

```tsx
import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { QueryClientProvider } from "@tanstack/react-query";
import Welcome from "./Welcome";
import ProgressScreen from "./Progress";
import ErrorScreen from "./ErrorScreen";
import WorkspaceLayout from "./widgets/WorkspaceLayout";
import { queryClient } from "./app/query-client";
import type { ProgressTick } from "./types";

type Screen = "welcome" | "progress" | "summary" | "error";

export default function App() {
  const [screen, setScreen] = useState<Screen>("welcome");
  const [tick, setTick] = useState<ProgressTick | null>(null);
  const [prepareTotals, setPrepareTotals] = useState<(ProgressTick & { done: true }) | null>(null);
  const [blfPath, setBlfPath] = useState("");
  const [errorMessage, setErrorMessage] = useState("");

  useEffect(() => {
    const unlisten = listen<ProgressTick>("prepare-progress", (event) => {
      setTick(event.payload);
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  }, []);

  async function handleStart(startBlfPath: string, arxmlPath: string) {
    setTick(null);
    setBlfPath(startBlfPath);
    setScreen("progress");
    try {
      // prepare_trace resolves with the run's final Done tick directly, so
      // the summary transition never races the "prepare-progress" event
      // listener - the event stream is only for the live counters on the
      // Progress screen. The workspace's own data (trace summary, message
      // groups, ECUs) is now fetched independently by TraceRail via React
      // Query, so App.tsx no longer calls get_trace_summary itself.
      const doneTick = await invoke<ProgressTick & { done: true }>("prepare_trace", {
        blfPath: startBlfPath,
        arxmlPath,
      });
      setPrepareTotals(doneTick);
      setScreen("summary");
    } catch (e) {
      setErrorMessage(String(e));
      setScreen("error");
    }
  }

  function reset() {
    setScreen("welcome");
    setTick(null);
    setPrepareTotals(null);
    setBlfPath("");
    setErrorMessage("");
  }

  return (
    <QueryClientProvider client={queryClient}>
      {screen === "welcome" && <Welcome onStart={handleStart} />}
      {screen === "progress" && <ProgressScreen tick={tick} />}
      {screen === "error" && <ErrorScreen message={errorMessage} onRetry={reset} />}
      {screen === "summary" && prepareTotals && (
        <WorkspaceLayout blfPath={blfPath} prepareTotals={prepareTotals} onOpenTrace={reset} />
      )}
    </QueryClientProvider>
  );
}
```

- [ ] **Step 2: Delete the retired Summary screen**

```bash
rm app/ui/src/Summary.tsx
```

- [ ] **Step 3: Manual verification - happy path**

Build the C++ CLI first if not already built: `cmake -S . -B build && cmake --build build` from the repo root. Then:

```bash
cd app/src-tauri
FASTRACE_PARSE_BIN=../../build/native/cli/fastrace_parse cargo tauri dev
```

In the app window: pick `native/store/test/fixtures/fixture.blf` and `native/store/test/fixtures/fixture.arxml`, click "Start Processing". Confirm the Progress screen appears, then the workspace appears with: the top bar showing `fixture.blf`; the Trace Rail's Trace Info card showing `CAN messages: 2`, `Ethernet messages: 4` (per `native/store/README.md`'s documented fixture counts); the Messages tab listing CAN and Ethernet groups; clicking a group populates the Message List; clicking a row populates Message Details; the ECUs tab (likely empty for this fixture - confirm it shows "No ECUs in this trace's ARXML." rather than erroring). Click "Open Trace" and confirm it returns cleanly to the Welcome screen.

Delete the generated `native/store/test/fixtures/fixture.duckdb`/`.wal` afterward so `git status` stays clean.

- [ ] **Step 4: Manual verification - error path**

Repeat the flow with `FASTRACE_PARSE_BIN=/tmp/does-not-exist cargo tauri dev` and confirm the Error screen still appears cleanly (this path is unchanged from Wave 2, but must be re-checked since `App.tsx` was rewritten).

- [ ] **Step 5: Commit**

```bash
git add app/ui/src/App.tsx
git rm app/ui/src/Summary.tsx
git commit -m "feat(ui): wire the WorkspaceLayout into App.tsx, retire the Summary screen"
```

---

## Task 15: Full end-to-end verification and cleanup

**Files:** none (verification only)

- [ ] **Step 1: Run every automated test**

```bash
cargo test --manifest-path crates/Cargo.toml
cargo test --manifest-path app/src-tauri/Cargo.toml
ctest --test-dir build --output-on-failure
```

Expected: all pass.

- [ ] **Step 2: Confirm no stray fixture artifacts**

```bash
git status --short
```

Expected: no untracked/modified files under `native/store/test/fixtures/`.

- [ ] **Step 3: Confirm the frontend type-checks and builds**

```bash
npm run build --prefix app/ui
```

Expected: `tsc && vite build` succeeds with no type errors.

- [ ] **Step 4: Final commit if cleanup was needed**

```bash
git add -A
git commit -m "chore: clean up fixture artifacts from manual verification"
```

(Skip this step entirely if `git status --short` was already clean.)
