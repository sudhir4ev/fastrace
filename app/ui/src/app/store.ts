import { create } from "zustand";
import type { AnomalyBin, DetectorMatch, DetectorQueryRan, DownsamplingAlgorithm } from "@/shared/api/trace-source";

export type WorkspaceTab = "signals" | "messages";

export interface TrimRange {
  start: number;
  end: number;
}

export interface WorkspaceState {
  selectedGroupKeys: string[];
  selectedMessageId: number | null;
  workspaceTab: WorkspaceTab;
  // Committed signal selection (post Apply) - chips and timeline plot.
  // `pendingSignalIds` is the draft checkbox state in SignalSelect until Apply.
  activeSignalIds: Set<number>;
  pendingSignalIds: Set<number>;
  // Per-signal Downsampling Algorithm choice (CONTEXT.md) - defaults to
  // Min/Max for any signal not yet present in the map.
  signalDownsamplingAlgorithms: Record<number, DownsamplingAlgorithm>;
  setSignalDownsamplingAlgorithm: (signalId: number, algorithm: DownsamplingAlgorithm) => void;
  setSelectedGroupKeys: (keys: string[]) => void;
  setSelectedMessage: (id: number | null) => void;
  setWorkspaceTab: (tab: WorkspaceTab) => void;
  setPendingSignalIds: (ids: Set<number>) => void;
  commitActiveSignalIds: (ids: Set<number>) => void;
  removeActiveSignal: (id: number) => void;
  // Detector Query editor state (Analyzer panel). One query at a time -
  // every run replaces the previous result wholesale. `detectorQueryHasRun`
  // is distinct from `detectorMatches.length === 0`: a query that matched
  // nothing still "ran" and the Match lane should show (empty), not stay
  // hidden as if nothing happened yet.
  detectorQuerySql: string;
  // The SQL text of the last Detector Query that actually ran - distinct
  // from `detectorQuerySql`, which keeps changing as the user types a new
  // draft. The Anomaly Overlay keys off this, not the live draft, so it
  // never recomputes from an unrun/half-typed query (CONTEXT.md's Anomaly
  // Bin is defined over a Detector Query's *run* scope).
  detectorRanSql: string | null;
  detectorTargetSignalIds: number[];
  detectorRespectTrim: boolean;
  detectorMatches: DetectorMatch[];
  detectorQueryTruncated: boolean;
  detectorQueryError: string | null;
  detectorQueryHasRun: boolean;
  anomalyBins: AnomalyBin[];
  setDetectorQuerySql: (sql: string) => void;
  setDetectorTargetSignalIds: (ids: number[]) => void;
  setDetectorRespectTrim: (respect: boolean) => void;
  setDetectorQueryResult: (ran: DetectorQueryRan, sqlText: string) => void;
  setDetectorQueryError: (error: string) => void;
  resetDetectorQuery: () => void;
  // Shared dataZoom window (percent, 0-100) for TimelineChart/TimelineZoomControl.
  // Read/written imperatively via getState()/setTimelineZoomRange from echarts
  // event handlers, never via the `useWorkspaceStore(s => s.timelineZoomRange)`
  // hook form - that would re-render (and rebuild the whole chart option)
  // on every pixel of a drag.
  timelineZoomRange: { start: number; end: number };
  setTimelineZoomRange: (range: { start: number; end: number }) => void;
  // Global Trim Window (CONTEXT.md) - the [start, end] timestamp_us bound
  // scoping every trace-wide read for the session. `pendingTrimRange` is the
  // slider's local draft state; `appliedTrimRange` is what queries actually
  // use. Prefer commitTrimRange() on Apply so pending+applied update atomically
  // and timeline zoom resets for the new domain.
  appliedTrimRange: TrimRange | null;
  pendingTrimRange: TrimRange | null;
  setPendingTrimRange: (range: TrimRange) => void;
  applyTrim: () => void;
  commitTrimRange: (range: TrimRange) => void;
  initTrimRangeIfUnset: (start: number, end: number) => void;
  resetTrimRange: () => void;
  /** Clears all workspace UI state (Close Project). Does not touch on-disk stores. */
  resetWorkspace: () => void;
}

function sameKeys(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const set = new Set(a);
  return b.every((k) => set.has(k));
}

export const useWorkspaceStore = create<WorkspaceState>((set, get) => ({
  selectedGroupKeys: [],
  selectedMessageId: null,
  workspaceTab: "signals",
  activeSignalIds: new Set(),
  pendingSignalIds: new Set(),
  signalDownsamplingAlgorithms: {},
  setSignalDownsamplingAlgorithm: (signalId, algorithm) =>
    set((s) => ({
      signalDownsamplingAlgorithms: { ...s.signalDownsamplingAlgorithms, [signalId]: algorithm },
    })),
  setSelectedGroupKeys: (keys) => {
    if (sameKeys(keys, get().selectedGroupKeys)) return;
    set({ selectedGroupKeys: keys, selectedMessageId: null });
  },
  setSelectedMessage: (id) => set({ selectedMessageId: id }),
  setWorkspaceTab: (tab) => set({ workspaceTab: tab }),
  setPendingSignalIds: (ids) => set({ pendingSignalIds: ids }),
  commitActiveSignalIds: (ids) => set({ activeSignalIds: ids, pendingSignalIds: ids }),
  removeActiveSignal: (id) =>
    set((s) => {
      const active = new Set(s.activeSignalIds);
      active.delete(id);
      const pending = new Set(s.pendingSignalIds);
      pending.delete(id);
      return { activeSignalIds: active, pendingSignalIds: pending };
    }),
  detectorQuerySql: "",
  detectorRanSql: null,
  detectorTargetSignalIds: [],
  detectorRespectTrim: true,
  detectorMatches: [],
  detectorQueryTruncated: false,
  detectorQueryError: null,
  detectorQueryHasRun: false,
  anomalyBins: [],
  setDetectorQuerySql: (sql) => set({ detectorQuerySql: sql }),
  setDetectorTargetSignalIds: (ids) => set({ detectorTargetSignalIds: ids }),
  setDetectorRespectTrim: (respect) => set({ detectorRespectTrim: respect }),
  setDetectorQueryResult: (ran, sqlText) =>
    set((s) => {
      // Union targets into Active Signals (never remove other actives).
      const active = new Set(s.activeSignalIds);
      for (const id of ran.targetSignalIds) active.add(id);
      return {
        detectorMatches: ran.matches,
        detectorQueryTruncated: ran.truncated,
        detectorQueryError: null,
        detectorQueryHasRun: true,
        detectorRanSql: sqlText,
        anomalyBins: ran.bins,
        activeSignalIds: active,
        pendingSignalIds: new Set([...s.pendingSignalIds, ...ran.targetSignalIds]),
      };
    }),
  setDetectorQueryError: (error) =>
    set({
      detectorQueryError: error,
      detectorMatches: [],
      detectorQueryTruncated: false,
      detectorQueryHasRun: true,
      anomalyBins: [],
    }),
  resetDetectorQuery: () =>
    set({
      detectorQuerySql: "",
      detectorRanSql: null,
      detectorTargetSignalIds: [],
      detectorRespectTrim: true,
      detectorMatches: [],
      detectorQueryTruncated: false,
      detectorQueryError: null,
      detectorQueryHasRun: false,
      anomalyBins: [],
    }),
  timelineZoomRange: { start: 0, end: 100 },
  setTimelineZoomRange: (range) => {
    const cur = get().timelineZoomRange;
    if (cur.start === range.start && cur.end === range.end) return;
    set({ timelineZoomRange: range });
  },
  appliedTrimRange: null,
  pendingTrimRange: null,
  setPendingTrimRange: (range) => set({ pendingTrimRange: range }),
  applyTrim: () =>
    set((s) => (s.pendingTrimRange ? { appliedTrimRange: s.pendingTrimRange } : {})),
  commitTrimRange: (range) =>
    set({
      pendingTrimRange: range,
      appliedTrimRange: range,
      timelineZoomRange: { start: 0, end: 100 },
    }),
  // Only seeds the full-span default once per trace - re-opening the Signals
  // tab or re-fetching the time range must not stomp a user's in-progress
  // narrower trim back to full span.
  initTrimRangeIfUnset: (start, end) =>
    set((s) =>
      s.appliedTrimRange === null
        ? { appliedTrimRange: { start, end }, pendingTrimRange: { start, end } }
        : {}
    ),
  resetTrimRange: () => set({ appliedTrimRange: null, pendingTrimRange: null }),
  resetWorkspace: () =>
    set({
      selectedGroupKeys: [],
      selectedMessageId: null,
      workspaceTab: "signals",
      activeSignalIds: new Set(),
      pendingSignalIds: new Set(),
      detectorQuerySql: "",
      detectorRanSql: null,
      detectorTargetSignalIds: [],
      detectorRespectTrim: true,
      detectorMatches: [],
      detectorQueryTruncated: false,
      detectorQueryError: null,
      detectorQueryHasRun: false,
      anomalyBins: [],
      timelineZoomRange: { start: 0, end: 100 },
      signalDownsamplingAlgorithms: {},
      appliedTrimRange: null,
      pendingTrimRange: null,
    }),
}));
