/**
 * Simplified session health monitor. Replaces phantom-process-guard.ts.
 * Only checks tmux sessions. Runs every 60s.
 */

type RunCommand = (cmd: string, opts: { timeoutMs: number; reason: string }) => Promise<any>;

const CHECK_INTERVAL = 180_000; // 3 minutes (省バッテリー: 60s→180s)
let _timer: ReturnType<typeof setInterval> | null = null;
let _onSessionDied: ((tmuxName: string) => void) | null = null;
// Track consecutive failures to avoid false positives from transient errors
const _failCounts = new Map<string, number>();
const FAIL_THRESHOLD = 3; // require 3 consecutive failures before declaring dead

async function checkTmuxSession(name: string, runCmd: RunCommand): Promise<boolean> {
  try {
    const result = await runCmd(
      `tmux has-session -t "${name}" 2>/dev/null && echo ALIVE || echo DEAD`,
      { timeoutMs: 5000, reason: 'tmux-check' }
    );
    // runRawCommand returns { stdout, stderr, exitCode }
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
      const alive = await checkTmuxSession(name, runCmd);
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
