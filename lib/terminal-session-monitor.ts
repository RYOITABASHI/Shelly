/**
 * Simplified session health monitor. Replaces phantom-process-guard.ts.
 * Checks pty-helper TCP ports. Runs every 3 minutes (normal) or 10s (after recovery).
 */

type RunCommand = (cmd: string, opts: { timeoutMs: number; reason: string }) => Promise<any>;

const NORMAL_INTERVAL = 180_000; // 3 minutes (省バッテリー)
const RECOVERY_INTERVAL = 10_000; // 10 seconds (after bridge reconnect)
const RECOVERY_FAST_CHECKS = 6; // fast-check 6 times, then revert to normal
let _timer: ReturnType<typeof setInterval> | null = null;
let _onSessionDied: ((tmuxName: string) => void) | null = null;
let _runCmd: RunCommand | null = null;
let _tmuxNames: string[] = [];
let _fastChecksRemaining = 0;
// Track consecutive failures to avoid false positives from transient errors
const _failCounts = new Map<string, number>();
const FAIL_THRESHOLD = 2; // require 2 consecutive failures (was 3 — faster recovery)

async function checkSessionAlive(name: string, runCmd: RunCommand): Promise<boolean> {
  try {
    const port = 18200 + ['shelly-1', 'shelly-2', 'shelly-3', 'shelly-4'].indexOf(name);
    if (port < 18200) return true; // Unknown session name — assume alive
    const result = await runCmd(
      `(echo >/dev/tcp/127.0.0.1/${port}) 2>/dev/null && echo ALIVE || echo DEAD`,
      { timeoutMs: 3000, reason: 'pty-health-check' }
    );
    const output = typeof result === 'string' ? result : result?.stdout || result?.output || '';
    const alive = output.includes('ALIVE');
    if (!alive) console.log('[SessionMonitor] health check DEAD:', name, 'port=', port);
    return alive;
  } catch (e) {
    // On error (bridge disconnected, timeout), assume alive to avoid false recovery
    console.warn('[SessionMonitor] health check error (assuming alive):', name, e);
    return true;
  }
}

async function runCheck() {
  for (const name of _tmuxNames) {
    const alive = await checkSessionAlive(name, _runCmd!);
    if (alive) {
      _failCounts.set(name, 0);
    } else {
      const count = (_failCounts.get(name) || 0) + 1;
      _failCounts.set(name, count);
      // Only trigger recovery after FAIL_THRESHOLD consecutive failures
      console.log('[SessionMonitor] fail count:', name, count, '/', FAIL_THRESHOLD);
      if (count >= FAIL_THRESHOLD) {
        console.log('[SessionMonitor] triggering recovery for:', name);
        _failCounts.set(name, 0);
        _onSessionDied?.(name);
      }
    }
  }

  // Transition from fast-check to normal interval
  if (_fastChecksRemaining > 0) {
    _fastChecksRemaining--;
    if (_fastChecksRemaining === 0) {
      // Switch back to normal interval
      restartTimer(NORMAL_INTERVAL);
    }
  }
}

function restartTimer(interval: number) {
  if (_timer) clearInterval(_timer);
  _timer = setInterval(runCheck, interval);
}

export function startSessionMonitor(
  tmuxNames: string[],
  runCmd: RunCommand,
  onDied: (tmuxName: string) => void
): void {
  stopSessionMonitor();
  _onSessionDied = onDied;
  _runCmd = runCmd;
  _tmuxNames = tmuxNames;
  _failCounts.clear();
  _fastChecksRemaining = 0;
  console.log('[SessionMonitor] started monitoring:', tmuxNames.join(', '));

  restartTimer(NORMAL_INTERVAL);
}

/**
 * Trigger immediate health check + switch to fast polling for a short period.
 * Call this after bridge reconnection to quickly detect dead pty-helpers.
 */
export function triggerImmediateCheck(): void {
  if (!_runCmd || _tmuxNames.length === 0) return;
  console.log('[SessionMonitor] triggerImmediateCheck — fast polling for', RECOVERY_FAST_CHECKS, 'rounds');

  _fastChecksRemaining = RECOVERY_FAST_CHECKS;
  _failCounts.clear(); // Reset counts — fresh start after recovery

  // Run check immediately
  runCheck();

  // Switch to fast interval
  restartTimer(RECOVERY_INTERVAL);
}

export function stopSessionMonitor(): void {
  if (_timer) {
    clearInterval(_timer);
    _timer = null;
  }
  _onSessionDied = null;
  _runCmd = null;
  _tmuxNames = [];
  _failCounts.clear();
  _fastChecksRemaining = 0;
}
