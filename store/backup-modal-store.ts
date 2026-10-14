/**
 * store/backup-modal-store.ts — global open/close state for BackupRestoreModal
 * (mounted once in ShellLayout). Opened from Settings and from the
 * `shelly://backup` / `shelly://restore` deep links. Holds NO secrets — the
 * passphrase only ever lives in the modal's component state.
 */
import { create } from 'zustand';

export type BackupModalMode = 'backup' | 'restore';

type BackupModalState = {
  visible: boolean;
  mode: BackupModalMode;
  /** bumps on every open so the modal resets to its first step */
  openSeq: number;
  open: (mode: BackupModalMode) => void;
  close: () => void;
};

export const useBackupModalStore = create<BackupModalState>((set) => ({
  visible: false,
  mode: 'backup',
  openSeq: 0,
  open: (mode) => set((s) => ({ visible: true, mode, openSeq: s.openSeq + 1 })),
  close: () => set({ visible: false }),
}));
