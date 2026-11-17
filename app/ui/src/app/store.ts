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
