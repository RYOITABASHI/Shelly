// store/focus-store.ts
//
// Small event bus for forcing the active terminal view to regain focus.
// On Android edge-to-edge with RN Modals (LayoutAddSheet, ConfigTUI,
// CommandPalette, VoiceChat), dismissing the modal can leave the
// activity's window focus unset (`mCurrentFocus=null` in dumpsys
// window). The soft keyboard stays visible but no view receives
// commitText, so the user sees a keyboard that does nothing until
// they tap the terminal manually. This store exposes a counter that
// TerminalPane watches; bumping it triggers a native
// `TerminalView.focus(tag)` call which calls requestFocus + showSoftInput
// and resumes typing without a tap.
//
// Intentionally not persisted — this is ephemeral UI-state only.
import { create } from 'zustand';

type FocusStore = {
  /** Monotonic counter. Any increment triggers a refocus on the active terminal view. */
  refocusTick: number;
  /** Call from a Modal close handler (or anywhere focus should return). */
  requestTerminalRefocus: () => void;
};

export const useFocusStore = create<FocusStore>((set) => ({
  refocusTick: 0,
  requestTerminalRefocus: () => set((s) => ({ refocusTick: s.refocusTick + 1 })),
}));
