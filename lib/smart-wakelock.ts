/**
 * smart-wakelock.ts — Event-driven wakelock management for Termux
 *
 * Acquires wakelock when a CLI session starts (activeCli changes to non-null).
 * Releases with a 5-minute grace period after CLI exits.
 * No polling — purely event-driven via acquireWakelockForCli / releaseWakelockForCli.
 */

import { AppState, type AppStateStatus } from 'react-native';

type RunCommand = (cmd: string, opts: { timeoutMs: number; reason: string }) => Promise<any>;

const RELEASE_GRACE_MS = 2 * 60_000; // 2 minutes (省バッテリー: 5m→2m)

let _appStateSub: ReturnType<typeof AppState.addEventListener> | null = null;
let _wakelockHeld = false;
let _runCommand: RunCommand | null = null;
let _releaseTimer: ReturnType<typeof setTimeout> | null = null;
let _activeCliCount = 0;

/** Acquire Termux wakelock */
async function acquireWakelock(runRawCommand: RunCommand): Promise<void> {
  if (_wakelockHeld) return;
  try {
    await runRawCommand('termux-wake-lock 2>/dev/null; true', { timeoutMs: 5000, reason: 'wakelock-acquire' });
    _wakelockHeld = true;
    console.log('[SmartWakelock] acquired');
  } catch {
    // termux-wake-lock may not be available
  }
}

/** Release Termux wakelock */
async function releaseWakelock(runRawCommand: RunCommand): Promise<void> {
  if (!_wakelockHeld) return;
  try {
    await runRawCommand('termux-wake-unlock 2>/dev/null; true', { timeoutMs: 5000, reason: 'wakelock-release' });
    _wakelockHeld = false;
    console.log('[SmartWakelock] released');
  } catch {
    // Best-effort
  }
}

/**
 * Called when a CLI session starts (activeCli changes from null to a value).
 * Immediately acquires wakelock and cancels any pending release timer.
 */
export function acquireWakelockForCli(): void {
  _activeCliCount++;
  // Cancel any pending grace-period release
  if (_releaseTimer) {
    clearTimeout(_releaseTimer);
    _releaseTimer = null;
  }
  if (_runCommand) {
    acquireWakelock(_runCommand);
  }
}

/**
 * Called when a CLI session exits (activeCli changes to null).
 * Starts a 5-minute grace period before releasing wakelock,
 * in case the user restarts a CLI session quickly.
 */
export function releaseWakelockForCli(): void {
  _activeCliCount = Math.max(0, _activeCliCount - 1);
  if (_activeCliCount > 0) return; // Other CLI sessions still active

  // Clear any existing timer
  if (_releaseTimer) {
    clearTimeout(_releaseTimer);
  }

  _releaseTimer = setTimeout(() => {
    _releaseTimer = null;
    if (_activeCliCount === 0 && _runCommand) {
      releaseWakelock(_runCommand);
    }
  }, RELEASE_GRACE_MS);
}

/** Start smart wakelock management */
export function startSmartWakelock(runRawCommand: RunCommand): void {
  stopSmartWakelock();
  _runCommand = runRawCommand;

  // App state: re-acquire on foreground resume if CLI is active
  _appStateSub = AppState.addEventListener('change', async (nextState: AppStateStatus) => {
    if (nextState === 'active' && _activeCliCount > 0 && _runCommand) {
      await acquireWakelock(_runCommand);
    }
  });
}

/** Stop smart wakelock management and release wakelock */
export function stopSmartWakelock(): void {
  if (_releaseTimer) {
    clearTimeout(_releaseTimer);
    _releaseTimer = null;
  }
  if (_appStateSub) {
    _appStateSub.remove();
    _appStateSub = null;
  }
  if (_wakelockHeld && _runCommand) {
    releaseWakelock(_runCommand);
  }
  _runCommand = null;
  _activeCliCount = 0;
}

/** Check if wakelock is currently held */
export function isWakelockHeld(): boolean {
  return _wakelockHeld;
}
