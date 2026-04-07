import { playSound } from '@/lib/sounds';

export type CompletionEvent = {
  paneId: string;
  command: string;
  exitCode: number;
  durationMs: number;
};

const listeners = new Set<(event: CompletionEvent) => void>();

export function onCommandComplete(cb: (event: CompletionEvent) => void) {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}

export function emitCommandComplete(event: CompletionEvent) {
  // Only notify for commands that took >5 seconds
  if (event.durationMs < 5000) return;
  try { playSound(event.exitCode === 0 ? 'success' : 'error'); } catch {}
  listeners.forEach(cb => cb(event));
}
