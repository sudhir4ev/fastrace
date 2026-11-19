import { create } from "zustand";
import type { DetectorMatch } from "@/shared/api/trace-source";

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
  // Detector Query editor state (Analyzer panel). One query at a time -
  // every run replaces the previous result wholesale. `detectorQueryHasRun`
  // is distinct from `detectorMatches.length === 0`: a query that matched
  // nothing still "ran" and the Match lane should show (empty), not stay
  // hidden as if nothing happened yet.
  detectorQuerySql: string;
  detectorMatches: DetectorMatch[];
  detectorQueryTruncated: boolean;
  detectorQueryError: string | null;
  detectorQueryHasRun: boolean;
  setDetectorQuerySql: (sql: string) => void;
  setDetectorQueryResult: (matches: DetectorMatch[], truncated: boolean) => void;
  setDetectorQueryError: (error: string) => void;
  resetDetectorQuery: () => void;
  // Shared dataZoom window (percent, 0-100) for TimelineChart/TimelineZoomControl.
  // Read/written imperatively via getState()/setTimelineZoomRange from echarts
  // event handlers, never via the `useWorkspaceStore(s => s.timelineZoomRange)`
  // hook form - that would re-render (and rebuild the whole chart option)
  // on every pixel of a drag.
  timelineZoomRange: { start: number; end: number };
  setTimelineZoomRange: (range: { start: number; end: number }) => void;
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
  detectorQuerySql: "",
  detectorMatches: [],
  detectorQueryTruncated: false,
  detectorQueryError: null,
  detectorQueryHasRun: false,
  setDetectorQuerySql: (sql) => set({ detectorQuerySql: sql }),
  setDetectorQueryResult: (matches, truncated) =>
    set({
      detectorMatches: matches,
      detectorQueryTruncated: truncated,
      detectorQueryError: null,
      detectorQueryHasRun: true,
    }),
  setDetectorQueryError: (error) =>
    set({
      detectorQueryError: error,
      detectorMatches: [],
      detectorQueryTruncated: false,
      detectorQueryHasRun: true,
    }),
  resetDetectorQuery: () =>
    set({
      detectorQuerySql: "",
      detectorMatches: [],
      detectorQueryTruncated: false,
      detectorQueryError: null,
      detectorQueryHasRun: false,
    }),
  timelineZoomRange: { start: 0, end: 100 },
  setTimelineZoomRange: (range) => set({ timelineZoomRange: range }),
}));
