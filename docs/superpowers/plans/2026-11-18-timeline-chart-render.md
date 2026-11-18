# Timeline Chart Render Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render decoded signals as stacked small-multiples line charts in the Timeline panel, with a pill-based UI for controlling which decoded ("active") signals are actually plotted ("displayed"), and rename the Signals-tab decode action from "Apply changes" to "Read Payloads".

**Architecture:** Pure frontend change, zero backend/Rust/C++ changes. `SignalsList` already has everything needed (`SignalCatalogEntry.cached/changes/opaque`, `getSignalSamples(blfPath, signalId, limit)` with no server-side cap). Add one new Zustand slice (`displayedSignalIds`) for which active signals are plotted, a new `SignalPills` widget driven live off the signal catalog query (not a frozen snapshot), and rewrite `TimelinePanel` to render one ECharts instance with N stacked grids (small multiples) sharing a synced x-axis and `dataZoom`.

**Tech Stack:** React + TypeScript, Zustand, TanStack Query (`useQueries` for N parallel sample fetches), raw `echarts` (new dependency), existing shadcn/radix `Popover`/`Button`.

**Spec:** This plan's design was settled interactively in conversation (no separate spec file) - see the "Global Constraints" section below for the condensed, verbatim decision list.

## Global Constraints

- No backend/Rust/C++ changes in this plan - `getSignalSamples`'s `limit` is caller-controlled with no server cap (`crates/query/src/lib.rs:234-249`); client just passes a large number.
- "Apply changes" → **"Read Payloads"** in every user-facing string (button, `DecodeOverlay` text, `ActivityLog` kind label). Internal identifiers (`decodeSignals`, `useDecodeSignals`, `DecodeOverlay`, activity `kind: "decode"`) are unchanged.
- Pills are derived live from `SignalCatalogEntry.cached`, never from a frozen commit snapshot - if a signal stops being cached, its pill and chart disappear automatically with no extra code.
- New store state `displayedSignalIds: Set<number>` (subset of cached signals) controls what's actually plotted. Toggled per pill click.
- Auto-display rule: right after a successful Read Payloads that decoded ≥1 new signal, if `displayedSignalIds` was empty, auto-add exactly the first of the newly-decoded signal ids. Otherwise leave display state untouched - new pills start **hidden** (outline style).
- Pill style: **solid** = displayed, **outline** = active (cached) but hidden. No removal of active signals in this pass, no pill drag-reorder.
- "Show non-decodable" + new "Show constants" (`changes === 0`) toggles move into one `Popover` behind a filter-icon button next to the Signals-tab filter text input. Both default to hiding (matches existing `hideNonDecodable` default).
- Timeline: raw `echarts` (no `echarts-for-react` wrapper). One `echarts` instance, one grid/xAxis/yAxis triple per displayed signal (small multiples), x-axes linked via `axisPointer.link` + a single `dataZoom` spanning all `xAxisIndex`. Y-axis auto-fits to that signal's own sample min/max. No custom value readout - native tooltip/axisPointer only. No anomaly `markArea` in this pass.
- Per-signal color: stable, assigned by the signal's index in the catalog array (`catalog.data` order, which is itself stable - `ORDER BY cached DESC, changes DESC, name` in `list_signal_catalog`), cycling through the 8-color dataviz categorical palette below. Light mode only - `darkMode: "class"` is configured in `tailwind.config.ts` but nothing toggles it anywhere in the app yet, so no dark variant is needed.
  - `#2a78d6` (blue), `#1baf7a` (aqua), `#eda100` (yellow), `#008300` (green), `#4a3aa7` (violet), `#e34948` (red), `#e87ba4` (magenta), `#eb6834` (orange)
- Testing convention for this repo's frontend: there is no unit-test harness in `app/ui` (confirmed zero existing `*.test.tsx`/RTL/Jest setup, and every prior UI task in this project's history was verified via `npm run build --prefix app/ui` + manual review, by explicit standing instruction - "dont focus on unit tests for the first iteration"). Each task below is verified by a clean build plus an explicit manual check procedure, not fabricated unit tests.

## Review Focus

- **Zero cached signals**: `SignalPills` and `TimelinePanel` must render sensible empty states (no crash, no empty pill row taking up space) when `catalog.data` has nothing with `cached === true`.
- **Read Payloads with nothing new to decode**: re-applying an already-fully-cached selection (`toDecode.length === 0`) must NOT trigger the auto-display-first rule - only genuinely new decodes do.
- **A displayed signal's samples still loading/erroring**: `useQueries` per-signal `isPending`/`isError` must not blank out or crash the other already-loaded tracks - each grid's data independently reflects its own query state.
- **Catalog refetch drops a previously-displayed signal's cached flag**: `displayedSignalIds` must not keep stale ids - reconcile against the live catalog on every catalog update, not just on pill click.
- **Rapid pill clicking / toggling the same signal on and off**: `toggleDisplayedSignal` must be a pure set-toggle with no leftover partial state (e.g. a stale ECharts series) when a signal is removed then immediately re-added.

---

## File Structure

| File | Responsibility |
|---|---|
| `app/ui/src/app/store.ts` (modify) | Add `displayedSignalIds` set + `toggleDisplayedSignal` + `autoDisplayFirstIfEmpty` + reconciliation against catalog. |
| `app/ui/src/app/signalColors.ts` (create) | The 8-color categorical palette + `getSignalColor(index)`. |
| `app/ui/src/widgets/SignalPills.tsx` (create) | Renders the pill row for one trace's cached signals; owns no state beyond reading the store/catalog. |
| `app/ui/src/widgets/TimelinePanel.tsx` (rewrite) | Mounts `SignalPills` + the ECharts small-multiples chart for `displayedSignalIds`. |
| `app/ui/src/widgets/SignalsList.tsx` (modify) | Rename button, add filter popover, wire auto-display-first on successful decode. |
| `app/ui/src/widgets/WorkspaceLayout.tsx` (modify) | Pass `blfPath` into `TimelinePanel`. |
| `app/ui/src/widgets/DecodeOverlay.tsx` (modify) | Rename overlay copy. |
| `app/ui/src/widgets/ActivityLog.tsx` (modify) | Rename activity-log label. |
| `app/ui/package.json` (modify) | Add `echarts` dependency. |

---

### Task 1: Install `echarts` and add the signal color palette

**Files:**
- Modify: `app/ui/package.json`
- Create: `app/ui/src/app/signalColors.ts`

**Interfaces:**
- Produces: `PALETTE: readonly string[]` (8 hex strings), `getSignalColor(index: number): string`

- [ ] **Step 1: Install the dependency**

```bash
cd app/ui && npm install echarts
```

- [ ] **Step 2: Create the palette module**

```ts
// app/ui/src/app/signalColors.ts
// Validated categorical palette (8 slots, fixed order - see dataviz skill's
// references/palette.md). Cycles for a 9th+ signal rather than generating a
// new hue.
export const PALETTE = [
  "#2a78d6", // blue
  "#1baf7a", // aqua
  "#eda100", // yellow
  "#008300", // green
  "#4a3aa7", // violet
  "#e34948", // red
  "#e87ba4", // magenta
  "#eb6834", // orange
] as const;

export function getSignalColor(index: number): string {
  return PALETTE[index % PALETTE.length];
}
```

- [ ] **Step 3: Verify the build picks up the new dependency and file**

Run: `npm run build --prefix app/ui`
Expected: PASS (tsc + vite build clean; `echarts` resolves in `node_modules`).

- [ ] **Step 4: Commit**

```bash
git add app/ui/package.json app/ui/package-lock.json app/ui/src/app/signalColors.ts
git commit -m "feat(ui): add echarts dependency and signal color palette"
```

---

### Task 2: Store - `displayedSignalIds` slice

**Files:**
- Modify: `app/ui/src/app/store.ts`

**Interfaces:**
- Consumes: nothing new (existing `activeSignalIds`/`pendingSignalIds`/`commitActiveSignalIds` untouched).
- Produces: `displayedSignalIds: Set<number>`, `toggleDisplayedSignal(id: number): void`, `autoDisplayFirstIfEmpty(id: number): void`, `reconcileDisplayedSignals(cachedIds: Set<number>): void`.

- [ ] **Step 1: Add the new state and actions**

Replace the full contents of `app/ui/src/app/store.ts` with:

```ts
import { create } from "zustand";

export type LeftTab = "signals" | "messages" | "ecus";

export interface WorkspaceState {
  selectedGroupKey: string | null;
  selectedMessageId: number | null;
  leftTab: LeftTab;
  // Committed signal selection (post "Read Payloads") - what's pinned to the
  // top of the Signals tab and considered "active". `pendingSignalIds` is the
  // transient, not-yet-applied checkbox state local to the Signals tab; it
  // never touches the backend until Read Payloads is clicked.
  activeSignalIds: Set<number>;
  pendingSignalIds: Set<number>;
  // Subset of active (cached) signals currently plotted in the Timeline.
  // Toggled per pill click, independent of decoding.
  displayedSignalIds: Set<number>;
  setSelectedGroup: (key: string | null) => void;
  setSelectedMessage: (id: number | null) => void;
  setLeftTab: (tab: LeftTab) => void;
  setPendingSignalIds: (ids: Set<number>) => void;
  commitActiveSignalIds: (ids: Set<number>) => void;
  toggleDisplayedSignal: (id: number) => void;
  // Called once per signal right after a Read Payloads run that decoded it
  // for the first time. Only takes effect if nothing is displayed yet -
  // re-applying an already-cached selection must not trigger this.
  autoDisplayFirstIfEmpty: (id: number) => void;
  // Drops any displayed signal id that the live catalog no longer reports as
  // cached (e.g. after a catalog refetch) - keeps pills and chart in sync
  // without the caller having to know why a signal stopped being cached.
  reconcileDisplayedSignals: (cachedIds: Set<number>) => void;
}

export const useWorkspaceStore = create<WorkspaceState>((set, get) => ({
  selectedGroupKey: null,
  selectedMessageId: null,
  leftTab: "messages",
  activeSignalIds: new Set(),
  pendingSignalIds: new Set(),
  displayedSignalIds: new Set(),
  // Switching groups must drop any message selection from the previous
  // group - otherwise MessageDetails keeps showing a message that no
  // longer belongs to the group currently being browsed.
  setSelectedGroup: (key) => set({ selectedGroupKey: key, selectedMessageId: null }),
  setSelectedMessage: (id) => set({ selectedMessageId: id }),
  setLeftTab: (tab) => set({ leftTab: tab }),
  setPendingSignalIds: (ids) => set({ pendingSignalIds: ids }),
  commitActiveSignalIds: (ids) => set({ activeSignalIds: ids, pendingSignalIds: ids }),
  toggleDisplayedSignal: (id) =>
    set((s) => {
      const next = new Set(s.displayedSignalIds);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return { displayedSignalIds: next };
    }),
  autoDisplayFirstIfEmpty: (id) => {
    if (get().displayedSignalIds.size === 0) {
      set({ displayedSignalIds: new Set([id]) });
    }
  },
  reconcileDisplayedSignals: (cachedIds) =>
    set((s) => {
      let changed = false;
      const next = new Set<number>();
      for (const id of s.displayedSignalIds) {
        if (cachedIds.has(id)) {
          next.add(id);
        } else {
          changed = true;
        }
      }
      return changed ? { displayedSignalIds: next } : {};
    }),
}));
```

- [ ] **Step 2: Verify the build**

Run: `npm run build --prefix app/ui`
Expected: PASS (no type errors; `SignalsList.tsx`/`SignalPills.tsx` don't exist yet to reference the new fields, so nothing else should break).

- [ ] **Step 3: Commit**

```bash
git add app/ui/src/app/store.ts
git commit -m "feat(ui): add displayedSignalIds slice to workspace store"
```

---

### Task 3: `SignalPills` widget

**Files:**
- Create: `app/ui/src/widgets/SignalPills.tsx`

**Interfaces:**
- Consumes: `useSignalCatalog(blfPath)` (existing, returns `SignalCatalogEntry[]` with `signalId`/`name`/`cached`), `useWorkspaceStore` fields `displayedSignalIds`/`toggleDisplayedSignal`/`reconcileDisplayedSignals` (Task 2), `getSignalColor(index)` (Task 1).
- Produces: default export `SignalPills({ blfPath }: { blfPath: string })`, rendered by `TimelinePanel` (Task 4).

- [ ] **Step 1: Write the component**

```tsx
// app/ui/src/widgets/SignalPills.tsx
import { useEffect } from "react";
import { useSignalCatalog } from "@/shared/api/hooks";
import { useWorkspaceStore } from "@/app/store";
import { getSignalColor } from "@/app/signalColors";
import { cn } from "@/shared/ui/lib/utils";

interface SignalPillsProps {
  blfPath: string;
}

export default function SignalPills({ blfPath }: SignalPillsProps) {
  const catalog = useSignalCatalog(blfPath);
  const displayedSignalIds = useWorkspaceStore((s) => s.displayedSignalIds);
  const toggleDisplayedSignal = useWorkspaceStore((s) => s.toggleDisplayedSignal);
  const reconcileDisplayedSignals = useWorkspaceStore((s) => s.reconcileDisplayedSignals);

  const cachedEntries = catalog.data?.filter((s) => s.cached) ?? [];

  // Pills are a live view of the catalog's cached signals, never a frozen
  // snapshot - if a refetch stops reporting a signal as cached, both its
  // pill (this filter) and any chart for it (store reconciliation) drop out.
  useEffect(() => {
    if (catalog.data) {
      reconcileDisplayedSignals(new Set(cachedEntries.map((s) => s.signalId)));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [catalog.data]);

  if (cachedEntries.length === 0) return null;

  return (
    <div className="flex shrink-0 flex-wrap gap-1.5 border-b border-border p-2">
      {cachedEntries.map((s) => {
        const colorIndex = (catalog.data ?? []).findIndex((c) => c.signalId === s.signalId);
        const color = getSignalColor(colorIndex);
        const displayed = displayedSignalIds.has(s.signalId);
        return (
          <button
            key={s.signalId}
            onClick={() => toggleDisplayedSignal(s.signalId)}
            className={cn(
              "inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium transition-colors"
            )}
            style={
              displayed
                ? { backgroundColor: color, borderColor: color, color: "#fff" }
                : { backgroundColor: "transparent", borderColor: color, color }
            }
          >
            {s.name || `signal ${s.signalId}`}
          </button>
        );
      })}
    </div>
  );
}
```

- [ ] **Step 2: Verify the build**

Run: `npm run build --prefix app/ui`
Expected: PASS.

- [ ] **Step 3: Manual verification procedure**

Run `cargo tauri dev --manifest-path app/src-tauri/Cargo.toml`, open a prepared trace, go to the Signals tab, check a couple of decodable signals and click "Read Payloads" (still labelled "Apply changes" until Task 6 - that's expected at this point). Confirm:
- A row of pills appears above the Timeline panel (currently still the "coming soon" stub - that's expected until Task 4).
- Exactly one pill is solid-colored (the auto-displayed first signal); any others are outline-only.
- Clicking an outline pill turns it solid; clicking a solid pill turns it outline. No pill ever has a plain gray/default color - each has a distinct hue.

- [ ] **Step 4: Commit**

```bash
git add app/ui/src/widgets/SignalPills.tsx
git commit -m "feat(ui): add SignalPills widget"
```

---

### Task 4: `TimelinePanel` - ECharts small-multiples render

**Files:**
- Rewrite: `app/ui/src/widgets/TimelinePanel.tsx`

**Interfaces:**
- Consumes: `SignalPills` (Task 3), `useWorkspaceStore((s) => s.displayedSignalIds)` (Task 2), `useSignalCatalog(blfPath)` and `getTraceDataSource().getSignalSamples` via a new `useSignalSamplesMany` query-batching hook added to `shared/api/hooks.ts` in this task, `getSignalColor(index)` (Task 1), `echarts` (Task 1).
- Produces: default export `TimelinePanel({ blfPath }: { blfPath: string })`, consumed by `WorkspaceLayout` (Task 5).

- [ ] **Step 1: Add a multi-signal samples hook**

Add to `app/ui/src/shared/api/hooks.ts` (after `useSignalSamples`):

```ts
import { useQueries } from "@tanstack/react-query";

// Timeline-scale fetch: one query per displayed signal, each uncapped-ish
// (200k rows comfortably covers a full drive per docs/adr/0005's real-trace
// signal_stats numbers) with no server-side windowing - ECharts' own
// `large`/`sampling: 'lttb'` handles render-time density.
const TIMELINE_SAMPLE_LIMIT = 200_000;

export function useSignalSamplesMany(blfPath: string, signalIds: number[]) {
  return useQueries({
    queries: signalIds.map((signalId) => ({
      queryKey: ["signal-samples", blfPath, signalId, TIMELINE_SAMPLE_LIMIT],
      queryFn: () => getTraceDataSource().getSignalSamples(blfPath, signalId, TIMELINE_SAMPLE_LIMIT),
    })),
  });
}
```

- [ ] **Step 2: Write the chart component**

```tsx
// app/ui/src/widgets/TimelinePanel.tsx
import { useEffect, useRef } from "react";
import * as echarts from "echarts";
import { useSignalCatalog, useSignalSamplesMany } from "@/shared/api/hooks";
import { useWorkspaceStore } from "@/app/store";
import { getSignalColor } from "@/app/signalColors";
import SignalPills from "./SignalPills";

interface TimelinePanelProps {
  blfPath: string;
}

const GRID_GAP_PERCENT = 4;

export default function TimelinePanel({ blfPath }: TimelinePanelProps) {
  const catalog = useSignalCatalog(blfPath);
  const displayedSignalIds = Array.from(useWorkspaceStore((s) => s.displayedSignalIds));
  const samples = useSignalSamplesMany(blfPath, displayedSignalIds);

  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<echarts.ECharts | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;
    chartRef.current = echarts.init(containerRef.current);
    const resize = () => chartRef.current?.resize();
    window.addEventListener("resize", resize);
    return () => {
      window.removeEventListener("resize", resize);
      chartRef.current?.dispose();
      chartRef.current = null;
    };
  }, []);

  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;

    if (displayedSignalIds.length === 0) {
      chart.clear();
      return;
    }

    const n = displayedSignalIds.length;
    const trackHeight = (100 - GRID_GAP_PERCENT * (n - 1)) / n;

    const grids = displayedSignalIds.map((_, i) => ({
      top: `${i * (trackHeight + GRID_GAP_PERCENT)}%`,
      height: `${trackHeight}%`,
      left: 60,
      right: 20,
    }));

    const xAxes = displayedSignalIds.map((_, i) => ({
      type: "time" as const,
      gridIndex: i,
      axisLabel: { show: i === 0 },
      axisLine: { show: i === n - 1 },
    }));

    const yAxes = displayedSignalIds.map((_, i) => {
      const result = samples[i];
      const values = (result?.data ?? []).map(([, v]) => v);
      const min = values.length ? Math.min(...values) : 0;
      const max = values.length ? Math.max(...values) : 1;
      const pad = (max - min) * 0.1 || 1;
      return {
        type: "value" as const,
        gridIndex: i,
        min: min - pad,
        max: max + pad,
        name: catalog.data?.find((s) => s.signalId === displayedSignalIds[i])?.name ?? `signal ${displayedSignalIds[i]}`,
        nameLocation: "middle" as const,
        nameGap: 45,
        splitLine: { show: false },
      };
    });

    const series = displayedSignalIds.map((signalId, i) => {
      const colorIndex = (catalog.data ?? []).findIndex((c) => c.signalId === signalId);
      const color = getSignalColor(colorIndex);
      const result = samples[i];
      return {
        type: "line" as const,
        name: catalog.data?.find((s) => s.signalId === signalId)?.name ?? `signal ${signalId}`,
        xAxisIndex: i,
        yAxisIndex: i,
        data: result?.data ?? [],
        showSymbol: false,
        large: true,
        sampling: "lttb" as const,
        lineStyle: { color, width: 2 },
        areaStyle: { color, opacity: 0.15 },
      };
    });

    chart.setOption(
      {
        animation: false,
        grid: grids,
        xAxis: xAxes,
        yAxis: yAxes,
        axisPointer: { link: [{ xAxisIndex: "all" }] },
        tooltip: { trigger: "axis" },
        dataZoom: [
          { type: "inside", xAxisIndex: displayedSignalIds.map((_, i) => i) },
          { type: "slider", xAxisIndex: displayedSignalIds.map((_, i) => i), bottom: 0, height: 14 },
        ],
        series,
      },
      true
    );
  }, [displayedSignalIds, samples, catalog.data]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <SignalPills blfPath={blfPath} />
      <div className="min-h-0 flex-1">
        {displayedSignalIds.length === 0 ? (
          <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
            No signals displayed - click a pill above to plot a decoded signal.
          </div>
        ) : (
          <div ref={containerRef} className="h-full w-full" />
        )}
      </div>
    </div>
  );
}
```

Note: `getSignalSamples` returns `[number, number][]` (`[timestampUs, physValue]` pairs per `app/ui/src/shared/api/trace-source.ts:118-119`) - ECharts' `time` axis expects milliseconds, but since every displayed track uses the same `timestampUs` unit consistently and only relative positioning/zooming matters (no wall-clock label requirement was raised), feeding raw microseconds into a `time` xAxis would misrender absolute dates. Use `value` type on the shared axis instead of `time`, plotting raw `timestampUs` - this still allows `dataZoom`/pan/zoom and synced axisPointer, it just won't format ticks as calendar dates (no requirement asked for that). Apply this correction before Step 3:

Replace `type: "time" as const` with `type: "value" as const` in the `xAxes` mapping above, and add `axisLabel: { show: i === 0, formatter: (v: number) => `${(v / 1_000_000).toFixed(1)}s` }` (microseconds → seconds-from-zero is good enough without a trace-start epoch).

- [ ] **Step 3: Verify the build**

Run: `npm run build --prefix app/ui`
Expected: PASS.

- [ ] **Step 4: Manual verification procedure**

In the running dev app, with 2-3 signals read and displayed (pills solid): confirm the Timeline shows that many stacked line tracks, each with a distinct color matching its pill, each with its own auto-fit y-axis. Drag the bottom `dataZoom` slider and confirm all tracks zoom together (shared x). Hover over one track and confirm the tooltip/crosshair shows up synced across all displayed tracks at the same x position. Click a pill off (outline) and confirm its track disappears and the remaining tracks resize to fill the space; click it back on and confirm it reappears.

- [ ] **Step 5: Commit**

```bash
git add app/ui/src/widgets/TimelinePanel.tsx app/ui/src/shared/api/hooks.ts
git commit -m "feat(ui): render displayed signals as stacked ECharts tracks in TimelinePanel"
```

---

### Task 5: Wire `blfPath` into `TimelinePanel`

**Files:**
- Modify: `app/ui/src/widgets/WorkspaceLayout.tsx:70`

**Interfaces:**
- Consumes: `TimelinePanel({ blfPath })` (Task 4).

- [ ] **Step 1: Pass the prop**

In `app/ui/src/widgets/WorkspaceLayout.tsx`, change:

```tsx
                <TimelinePanel />
```

to:

```tsx
                <TimelinePanel blfPath={blfPath} />
```

- [ ] **Step 2: Verify the build**

Run: `npm run build --prefix app/ui`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add app/ui/src/widgets/WorkspaceLayout.tsx
git commit -m "feat(ui): pass blfPath into TimelinePanel"
```

---

### Task 6: Rename "Apply changes" → "Read Payloads", add the filter popover, wire auto-display

**Files:**
- Modify: `app/ui/src/widgets/SignalsList.tsx` (full rewrite of the component body - button rename, filter popover, auto-display wiring)

**Interfaces:**
- Consumes: `useWorkspaceStore((s) => s.autoDisplayFirstIfEmpty)` (Task 2), `Popover`/`PopoverTrigger`/`PopoverContent` (existing), `lucide-react`'s `Filter` icon (existing dependency).
- Produces: nothing new consumed elsewhere - this is a leaf widget.

- [ ] **Step 1: Rewrite the component**

Replace the full contents of `app/ui/src/widgets/SignalsList.tsx`:

```tsx
import { useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Filter } from "lucide-react";
import { useWorkspaceStore } from "@/app/store";
import { useDecodeSignals, useSignalCatalog, useSignalSamples } from "@/shared/api/hooks";
import { Badge } from "@/shared/ui/badge";
import { Button } from "@/shared/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/shared/ui/popover";
import { cn } from "@/shared/ui/lib/utils";

function setsEqual(a: Set<number>, b: Set<number>): boolean {
  if (a.size !== b.size) return false;
  for (const x of a) {
    if (!b.has(x)) return false;
  }
  return true;
}

interface SignalsListProps {
  blfPath: string;
}

export default function SignalsList({ blfPath }: SignalsListProps) {
  const catalog = useSignalCatalog(blfPath);
  const activeSignalIds = useWorkspaceStore((s) => s.activeSignalIds);
  const pendingSignalIds = useWorkspaceStore((s) => s.pendingSignalIds);
  const setPendingSignalIds = useWorkspaceStore((s) => s.setPendingSignalIds);
  const commitActiveSignalIds = useWorkspaceStore((s) => s.commitActiveSignalIds);
  const autoDisplayFirstIfEmpty = useWorkspaceStore((s) => s.autoDisplayFirstIfEmpty);
  const decodeSignals = useDecodeSignals(blfPath);
  const [signalFilter, setSignalFilter] = useState("");
  const [hideNonDecodable, setHideNonDecodable] = useState(true);
  const [hideConstants, setHideConstants] = useState(true);
  const [previewSignalId, setPreviewSignalId] = useState<number | null>(null);
  const samples = useSignalSamples(blfPath, previewSignalId);

  const nonDecodableCount = catalog.data?.filter((s) => !s.decodable).length ?? 0;
  const constantCount = catalog.data?.filter((s) => s.decodable && s.changes === 0).length ?? 0;
  const filtersActive = !hideNonDecodable || !hideConstants;
  const filteredSignals = catalog.data
    ?.filter((s) => !hideNonDecodable || s.decodable)
    .filter((s) => !hideConstants || s.changes > 0)
    .filter((s) => `${s.name} ${s.parentLabel}`.toLowerCase().includes(signalFilter.toLowerCase()));
  const hasPendingSignalChanges = !setsEqual(pendingSignalIds, activeSignalIds);

  const parentRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: filteredSignals?.length ?? 0,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 32,
    overscan: 10,
  });

  function toggleSignal(id: number) {
    const next = new Set(pendingSignalIds);
    if (next.has(id)) {
      next.delete(id);
    } else {
      next.add(id);
    }
    setPendingSignalIds(next);
  }

  function readPayloads() {
    const toDecode = (catalog.data ?? [])
      .filter((s) => pendingSignalIds.has(s.signalId) && !s.cached && !s.opaque)
      .map((s) => s.signalId);
    const nextActive = new Set(pendingSignalIds);
    if (toDecode.length > 0) {
      decodeSignals.mutate(toDecode, {
        onSuccess: () => {
          commitActiveSignalIds(nextActive);
          autoDisplayFirstIfEmpty(toDecode[0]);
        },
      });
    } else {
      commitActiveSignalIds(nextActive);
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {catalog.data && catalog.data.length > 0 && (
        <div className="flex shrink-0 items-center gap-2 p-2">
          <input
            type="text"
            value={signalFilter}
            onChange={(e) => setSignalFilter(e.target.value)}
            placeholder="Filter signals..."
            className="min-w-0 flex-1 rounded-md border border-input bg-background px-2 py-1 text-sm shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          />
          <Popover>
            <PopoverTrigger asChild>
              <Button variant={filtersActive ? "secondary" : "outline"} size="icon" className="relative shrink-0">
                <Filter className="h-4 w-4" />
                {filtersActive && (
                  <span className="absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-primary" />
                )}
              </Button>
            </PopoverTrigger>
            <PopoverContent align="end" className="w-64">
              <div className="flex flex-col gap-2 text-sm">
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={!hideNonDecodable}
                    onChange={(e) => setHideNonDecodable(!e.target.checked)}
                  />
                  Show non-decodable ({nonDecodableCount})
                </label>
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={!hideConstants}
                    onChange={(e) => setHideConstants(!e.target.checked)}
                  />
                  Show constants ({constantCount})
                </label>
              </div>
            </PopoverContent>
          </Popover>
        </div>
      )}
      <div className="min-h-0 flex-1">
        {catalog.isPending && <p className="p-3 text-sm text-muted-foreground">Loading...</p>}
        {catalog.isError && <p className="p-3 text-sm text-muted-foreground">Couldn't load signal catalog.</p>}
        {catalog.data?.length === 0 && (
          <p className="p-3 text-sm text-muted-foreground">No signals in this trace's ARXML.</p>
        )}
        {catalog.data && catalog.data.length > 0 && filteredSignals?.length === 0 && (
          <p className="p-3 text-sm text-muted-foreground">
            {signalFilter
              ? `No signals match "${signalFilter}".`
              : "No signals match the current filters."}
          </p>
        )}
        {filteredSignals && filteredSignals.length > 0 && (
          <div ref={parentRef} className="h-full overflow-auto">
            <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
              {virtualizer.getVirtualItems().map((item) => {
                const s = filteredSignals[item.index];
                return (
                  <div
                    key={s.signalId}
                    className={cn(
                      "absolute left-0 top-0 flex w-full items-center gap-2 px-3 text-sm",
                      !s.decodable && "opacity-50"
                    )}
                    style={{ height: item.size, transform: `translateY(${item.start}px)` }}
                  >
                    <input
                      type="checkbox"
                      checked={pendingSignalIds.has(s.signalId)}
                      disabled={!s.decodable}
                      onChange={() => toggleSignal(s.signalId)}
                    />
                    <button
                      className={cn("min-w-0 flex-1 truncate text-left", s.cached && "hover:underline")}
                      disabled={!s.cached}
                      onClick={() => setPreviewSignalId(s.signalId)}
                    >
                      {s.name || `signal ${s.signalId}`}
                    </button>
                    <span className="shrink-0 text-xs text-muted-foreground">{s.parentLabel}</span>
                    {s.cached && (
                      <Badge variant="secondary" className="px-1.5 py-0">
                        cached
                      </Badge>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>

      {previewSignalId !== null && (
        <div className="shrink-0 border-t border-border p-2">
          <div className="mb-1 flex items-center justify-between text-xs text-muted-foreground">
            <span>Preview: {catalog.data?.find((s) => s.signalId === previewSignalId)?.name}</span>
            <button onClick={() => setPreviewSignalId(null)} aria-label="Close preview">
              &times;
            </button>
          </div>
          {samples.isPending && <p className="text-xs text-muted-foreground">Loading...</p>}
          {samples.isError && <p className="text-xs text-muted-foreground">Couldn't load samples.</p>}
          {samples.data && samples.data.length === 0 && (
            <p className="text-xs text-muted-foreground">No decoded samples yet.</p>
          )}
          {samples.data && samples.data.length > 0 && (
            <table className="w-full text-xs">
              <thead>
                <tr className="text-muted-foreground">
                  <th className="text-left font-normal">Timestamp (us)</th>
                  <th className="text-left font-normal">Value</th>
                </tr>
              </thead>
              <tbody>
                {samples.data.map(([ts, value]) => (
                  <tr key={ts}>
                    <td>{ts}</td>
                    <td>{value}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {hasPendingSignalChanges && (
        <div className="shrink-0 border-t border-border p-2">
          <Button size="sm" className="w-full" onClick={readPayloads} disabled={decodeSignals.isPending}>
            Read Payloads
          </Button>
        </div>
      )}
    </div>
  );
}
```

(`filteredSignals?.[item.index]` empty-state copy also changed from "try showing non-decodable ones" to "match the current filters", since there are now two filters that could be the reason.)

- [ ] **Step 2: Verify the build**

Run: `npm run build --prefix app/ui`
Expected: PASS.

- [ ] **Step 3: Manual verification procedure**

In the dev app's Signals tab: confirm the two standalone toggle buttons are gone, replaced by a single filter icon button next to the text input. Click it - confirm a popover with two checkboxes ("Show non-decodable (N)", "Show constants (N)") appears, both unchecked by default. Toggling either updates the visible list and puts a small dot badge on the filter button. Check a never-before-decoded signal, confirm the button at the bottom reads "Read Payloads" (not "Apply changes"), click it, and confirm (from Task 3/4's wiring) that signal's pill appears solid and its track renders in the Timeline with no other pill interaction needed. Then check a second new signal and click "Read Payloads" again - confirm this time nothing new auto-displays (the first one stays the only solid pill until clicked).

- [ ] **Step 4: Commit**

```bash
git add app/ui/src/widgets/SignalsList.tsx
git commit -m "feat(ui): rename Apply changes to Read Payloads, add filter popover, wire auto-display"
```

---

### Task 7: Rename remaining "decode" copy to "read"/"reading"

**Files:**
- Modify: `app/ui/src/widgets/DecodeOverlay.tsx:34`
- Modify: `app/ui/src/widgets/ActivityLog.tsx:12`

**Interfaces:** none (leaf string changes only).

- [ ] **Step 1: Rename the overlay copy**

In `app/ui/src/widgets/DecodeOverlay.tsx`, change:

```tsx
      <p className="text-sm text-foreground">Decoding signals...</p>
```

to:

```tsx
      <p className="text-sm text-foreground">Reading payloads...</p>
```

- [ ] **Step 2: Rename the activity-log label**

In `app/ui/src/widgets/ActivityLog.tsx`, change:

```tsx
const KIND_LABELS: Record<string, string> = {
  prepare: "Ingestion",
  decode: "Decode signals",
};
```

to:

```tsx
const KIND_LABELS: Record<string, string> = {
  prepare: "Ingestion",
  decode: "Read payloads",
};
```

- [ ] **Step 3: Verify the build**

Run: `npm run build --prefix app/ui`
Expected: PASS.

- [ ] **Step 4: Manual verification procedure**

Trigger a Read Payloads run in the dev app and confirm the full-screen overlay says "Reading payloads..." while it runs, and that the status-bar activity-log popover's most recent entry reads "Read payloads (...)" afterward.

- [ ] **Step 5: Commit**

```bash
git add app/ui/src/widgets/DecodeOverlay.tsx app/ui/src/widgets/ActivityLog.tsx
git commit -m "feat(ui): rename remaining decode copy to read/reading payloads"
```

---

## Self-Review

**1. Spec coverage:** Rename Apply changes → Read Payloads (Task 6 + 7); pills solid/outline derived live from catalog, 1:1, inline-block row (Task 3); `displayedSignalIds` + toggle + auto-display-first-when-empty (Task 2, wired in Task 6); filter popover replacing inline toggle buttons (Task 6); TimelinePanel with raw ECharts, small multiples, shared/synced x + dataZoom, auto-fit y, native tooltip, stable palette color, no markArea, no server windowing (Task 4). All covered.

**2. Placeholder scan:** No TODOs; the one genuine open design point (timestamp axis type/units) was resolved inline in Task 4 with a concrete correction rather than left as a placeholder.

**3. Type consistency:** `getSignalColor(index: number): string` used identically in `SignalPills.tsx` and `TimelinePanel.tsx`. `displayedSignalIds`/`toggleDisplayedSignal`/`autoDisplayFirstIfEmpty`/`reconcileDisplayedSignals` signatures in Task 2 match every call site in Tasks 3, 4, 6. `useSignalSamplesMany(blfPath: string, signalIds: number[])` return shape (array of `UseQueryResult`-like objects with `.data`/`.isPending`/`.isError`) matches how Task 4 indexes `samples[i]`.

**4. Review Focus:** All five items map onto an owning task - empty-cached-signals (Tasks 3 & 4's `length === 0` branches), decode-nothing-new (Task 6's `toDecode.length > 0` guard before `autoDisplayFirstIfEmpty`), per-signal independent query state (Task 4 indexes `samples[i]` per signal, one `isError`/`isPending` never blanks another), catalog-drop reconciliation (Task 2's `reconcileDisplayedSignals`, called every catalog update in Task 3's `useEffect`), rapid toggle (Task 2's `toggleDisplayedSignal` is a pure set op, no derived/cached chart state kept outside the `displayedSignalIds` Set itself).
