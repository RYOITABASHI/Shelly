/**
 * store/teach-store.ts — in-memory `shelly teach` recording state.
 *
 * Deliberately NOT persisted: a recording is a short-lived, foreground
 * activity, and the only on-disk artifact is the bash hook's single
 * `$HOME/.shelly-teach.jsonl` log (deleted on stop/cancel). If the app
 * process dies mid-recording, lib/teach-controller.ts's startup sweep
 * removes the orphaned log so bash stops appending to it.
 */
import { create } from 'zustand';

export type TeachRecording = {
  name?: string;
  startedAt: number;
};

type TeachState = {
  recording: TeachRecording | null;
  /** true while stop() is converting/saving — rejects a second stop. */
  finishing: boolean;
  setRecording: (r: TeachRecording | null) => void;
  setFinishing: (v: boolean) => void;
};

export const useTeachStore = create<TeachState>((set) => ({
  recording: null,
  finishing: false,
  setRecording: (recording) => set({ recording }),
  setFinishing: (finishing) => set({ finishing }),
}));
