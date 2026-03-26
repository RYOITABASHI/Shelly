/**
 * ttyd-manager — launch/kill ttyd processes per session port
 *
 * Each Shelly terminal session runs its own ttyd on ports 7681-7682.
 * This module provides lifecycle management for those processes.
 * Limited to 2 sessions to avoid Android's phantom process killer (32 child process limit).
 */

const TTYD_PORT_BASE = 7681;
const MAX_SESSIONS = 2;

type RunCommand = (cmd: string, opts: { timeoutMs: number; reason: string }) => Promise<any>;

/** Launch ttyd on a specific port via tmux (idempotent — skips if already running) */
export async function launchTtyd(port: number, runRawCommand: RunCommand): Promise<boolean> {
  try {
    const running = await isTtydRunning(port, runRawCommand);
    if (running) return true;

    const n = port - TTYD_PORT_BASE + 1;
    const sessionName = `shelly-${n}`;
    await runRawCommand(
      `tmux has-session -t "${sessionName}" 2>/dev/null || tmux new-session -d -s "${sessionName}"; nohup ttyd -p ${port} -W tmux attach-session -t "${sessionName}" > /dev/null 2>&1 &`,
      { timeoutMs: 10000, reason: 'ttyd-launch' },
    );
    await new Promise((r) => setTimeout(r, 1500));
    return true;
  } catch {
    return false;
  }
}

/** Kill ttyd on a specific port */
export async function killTtyd(port: number, runRawCommand: RunCommand): Promise<void> {
  try {
    await runRawCommand(
      `pkill -f "ttyd -p ${port}" 2>/dev/null; true`,
      { timeoutMs: 5000, reason: 'ttyd-kill' },
    );
  } catch {
    // Best-effort
  }
}

/** Kill all ttyd instances managed by Shelly (ports 7681-7686) */
export async function killAllTtyd(runRawCommand: RunCommand): Promise<void> {
  try {
    const ports = Array.from({ length: MAX_SESSIONS }, (_, i) => TTYD_PORT_BASE + i);
    const cmds = ports.map((p) => `pkill -f "ttyd -p ${p}" 2>/dev/null`).join('; ');
    await runRawCommand(`${cmds}; true`, { timeoutMs: 5000, reason: 'ttyd-kill-all' });
  } catch {
    // Best-effort
  }
}

/** Check if ttyd is running on a specific port */
export async function isTtydRunning(port: number, runRawCommand: RunCommand): Promise<boolean> {
  try {
    const check = await runRawCommand(
      `pgrep -f "ttyd -p ${port}" > /dev/null 2>&1 && echo YES || echo NO`,
      { timeoutMs: 3000, reason: 'ttyd-status' },
    );
    const output = typeof check === 'string' ? check : check?.output || '';
    return output.includes('YES');
  } catch {
    return false;
  }
}
