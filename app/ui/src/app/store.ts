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
