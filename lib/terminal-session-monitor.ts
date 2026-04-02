/**
 * Simplified session health monitor. Replaces phantom-process-guard.ts.
 * Checks pty-helper TCP ports. Runs every 3 minutes.
 */

type RunCommand = (cmd: string, opts: { timeoutMs: number; reason: string }) => Promise<any>;

const CHECK_INTERVAL = 180_000; // 3 minutes (省バッテリー: 60s→180s)
let _timer: ReturnType<typeof setInterval> | null = null;
let _onSessionDied: ((tmuxName: string) => void) | null = null;
// Track consecutive failures to avoid false positives from transient errors
const _failCounts = new Map<string, number>();
const FAIL_THRESHOLD = 3; // require 3 consecutive failures before declaring dead

async function checkSessionAlive(name: string, runCmd: RunCommand): Promise<boolean> {
  try {
    const port = 18200 + ['shelly-1', 'shelly-2', 'shelly-3', 'shelly-4'].indexOf(name);
    if (port < 18200) return true; // Unknown session name — assume alive
    const result = await runCmd(
      `(echo >/dev/tcp/127.0.0.1/${port}) 2>/dev/null && echo ALIVE || echo DEAD`,
      { timeoutMs: 3000, reason: 'pty-health-check' }
    );
    const output = typeof result === 'string' ? result : result?.stdout || result?.output || '';
    return output.includes('ALIVE');
  } catch {
    // On error (bridge disconnected, timeout), assume alive to avoid false recovery
    return true;
  }
}

export function startSessionMonitor(
  tmuxNames: string[],
  runCmd: RunCommand,
  onDied: (tmuxName: string) => void
): void {
  stopSessionMonitor();
  _onSessionDied = onDied;
  _failCounts.clear();

  _timer = setInterval(async () => {
    for (const name of tmuxNames) {
      const alive = await checkSessionAlive(name, runCmd);
      if (alive) {
        _failCounts.set(name, 0);
      } else {
        const count = (_failCounts.get(name) || 0) + 1;
        _failCounts.set(name, count);
        // Only trigger recovery after FAIL_THRESHOLD consecutive failures
        if (count >= FAIL_THRESHOLD) {
          _failCounts.set(name, 0);
          _onSessionDied?.(name);
        }
      }
    }
  }, CHECK_INTERVAL);
}

export function stopSessionMonitor(): void {
  if (_timer) {
    clearInterval(_timer);
    _timer = null;
  }
  _onSessionDied = null;
  _failCounts.clear();
}
