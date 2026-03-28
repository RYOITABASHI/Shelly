/**
 * Simplified session health monitor. Replaces phantom-process-guard.ts.
 * Only checks tmux sessions. Runs every 60s.
 */

type RunCommand = (cmd: string, opts: { timeoutMs: number; reason: string }) => Promise<any>;

const CHECK_INTERVAL = 60_000;
let _timer: ReturnType<typeof setInterval> | null = null;
let _onSessionDied: ((tmuxName: string) => void) | null = null;

async function checkTmuxSession(name: string, runCmd: RunCommand): Promise<boolean> {
  try {
    const result = await runCmd(
      `tmux has-session -t "${name}" 2>/dev/null && echo ALIVE || echo DEAD`,
      { timeoutMs: 3000, reason: 'tmux-check' }
    );
    const output = typeof result === 'string' ? result : result?.output || '';
    return output.includes('ALIVE');
  } catch {
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

  _timer = setInterval(async () => {
    for (const name of tmuxNames) {
      const alive = await checkTmuxSession(name, runCmd);
      if (!alive) {
        _onSessionDied?.(name);
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
}
