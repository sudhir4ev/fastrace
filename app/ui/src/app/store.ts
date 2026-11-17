import { create } from "zustand";

export type LeftTab = "signals" | "messages" | "ecus";

export interface WorkspaceState {
  selectedGroupKey: string | null;
  selectedMessageId: number | null;
  leftTab: LeftTab;
  // Committed signal selection (post "Apply changes") - what's pinned to the
  // top of the Signals tab and considered "active". `pendingSignalIds` is the
  // transient, not-yet-applied checkbox state local to the Signals tab; it
  // never touches the backend until Apply is clicked.
  activeSignalIds: Set<number>;
  pendingSignalIds: Set<number>;
  setSelectedGroup: (key: string | null) => void;
  setSelectedMessage: (id: number | null) => void;
  setLeftTab: (tab: LeftTab) => void;
  setPendingSignalIds: (ids: Set<number>) => void;
  commitActiveSignalIds: (ids: Set<number>) => void;
}

export const useWorkspaceStore = create<WorkspaceState>((set) => ({
  selectedGroupKey: null,
  selectedMessageId: null,
  leftTab: "messages",
  activeSignalIds: new Set(),
  pendingSignalIds: new Set(),
  // Switching groups must drop any message selection from the previous
  // group - otherwise MessageDetails keeps showing a message that no
  // longer belongs to the group currently being browsed.
  setSelectedGroup: (key) => set({ selectedGroupKey: key, selectedMessageId: null }),
  setSelectedMessage: (id) => set({ selectedMessageId: id }),
  setLeftTab: (tab) => set({ leftTab: tab }),
  setPendingSignalIds: (ids) => set({ pendingSignalIds: ids }),
  commitActiveSignalIds: (ids) => set({ activeSignalIds: ids, pendingSignalIds: ids }),
}));
