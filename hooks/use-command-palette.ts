import { create } from 'zustand';

export type PaletteAction = {
  id: string;
  label: string;
  hint?: string;
  icon: string; // MaterialIcons name
  category: 'tab' | 'action' | 'snippet' | 'pane' | 'recent' | 'suggest';
  onExecute: () => void;
};

type CommandPaletteState = {
  isOpen: boolean;
  open: () => void;
  close: () => void;
  toggle: () => void;
};

export const useCommandPaletteStore = create<CommandPaletteState>((set, get) => ({
  isOpen: false,
  open: () => set({ isOpen: true }),
  close: () => set({ isOpen: false }),
  toggle: () => set({ isOpen: !get().isOpen }),
}));
