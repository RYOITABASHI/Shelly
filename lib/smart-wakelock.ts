/**
 * smart-wakelock.ts — Intelligent wakelock management for Termux
 *
 * Auto-acquires wakelock when terminal sessions are active (ttyd running).
 * Auto-releases when all sessions are idle for IDLE_TIMEOUT.
 * Prevents unnecessary battery drain while keeping long-running processes alive.
 */

import { AppState, type AppStateStatus } from 'react-native';

type RunCommand = (cmd: string, opts: { timeoutMs: number; reason: string }) => Promise<any>;

const IDLE_TIMEOUT = 5 * 60 * 1000; // 5 minutes
const CHECK_INTERVAL = 30_000; // 30 seconds

let _checkTimer: ReturnType<typeof setInterval> | null = null;
let _idleTimer: ReturnType<typeof setTimeout> | null = null;
let _appStateSub: ReturnType<typeof AppState.addEventListener> | null = null;
let _wakelockHeld = false;
let _runCommand: RunCommand | null = null;

/** Check if any ttyd processes are active */
async function hasActiveProcesses(runRawCommand: RunCommand): Promise<boolean> {
  try {
    const result = await runRawCommand(
      'pgrep -f "ttyd -p" > /dev/null 2>&1 && echo ACTIVE || echo IDLE',
      { timeoutMs: 3000, reason: 'wakelock-check' },
    );
    const output = typeof result === 'string' ? result : result?.output || '';
    return output.includes('ACTIVE');
  } catch {
    return false;
  }
}

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

/** Periodic check: acquire if active, start idle timer if not */
async function checkAndManage(runRawCommand: RunCommand): Promise<void> {
  const active = await hasActiveProcesses(runRawCommand);

  if (active) {
    // Clear idle timer, ensure wakelock
    if (_idleTimer) {
      clearTimeout(_idleTimer);
      _idleTimer = null;
    }
    await acquireWakelock(runRawCommand);
  } else if (_wakelockHeld && !_idleTimer) {
    // Start idle countdown
    _idleTimer = setTimeout(async () => {
      _idleTimer = null;
      // Double-check before releasing
      const stillActive = await hasActiveProcesses(runRawCommand);
      if (!stillActive) {
        await releaseWakelock(runRawCommand);
      }
    }, IDLE_TIMEOUT);
  }
}

/** Start smart wakelock management */
export function startSmartWakelock(runRawCommand: RunCommand): void {
  stopSmartWakelock();
  _runCommand = runRawCommand;

  // Initial check
  checkAndManage(runRawCommand);

  // Periodic check
  _checkTimer = setInterval(() => {
    checkAndManage(runRawCommand);
  }, CHECK_INTERVAL);

  // App state: check on foreground resume, save on background
  _appStateSub = AppState.addEventListener('change', async (nextState: AppStateStatus) => {
    if (nextState === 'active') {
      checkAndManage(runRawCommand);
    }
  });
}

/** Stop smart wakelock management and release wakelock */
export function stopSmartWakelock(): void {
  if (_checkTimer) {
    clearInterval(_checkTimer);
    _checkTimer = null;
  }
  if (_idleTimer) {
    clearTimeout(_idleTimer);
    _idleTimer = null;
  }
  if (_appStateSub) {
    _appStateSub.remove();
    _appStateSub = null;
  }
  if (_wakelockHeld && _runCommand) {
    releaseWakelock(_runCommand);
  }
  _runCommand = null;
}

/** Check if wakelock is currently held */
export function isWakelockHeld(): boolean {
  return _wakelockHeld;
}
