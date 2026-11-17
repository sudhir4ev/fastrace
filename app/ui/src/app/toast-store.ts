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

const AUTO_DISMISS_MS = 5000;

let nextId = 1;

export const useToastStore = create<ToastState>((set, get) => ({
  toasts: [],
  pushError: (message) => {
    const id = nextId++;
    set((state) => ({ toasts: [...state.toasts, { id, message }] }));
    setTimeout(() => get().dismiss(id), AUTO_DISMISS_MS);
  },
  dismiss: (id) => set((state) => ({ toasts: state.toasts.filter((t) => t.id !== id) })),
}));
