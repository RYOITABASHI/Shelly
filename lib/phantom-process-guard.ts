/**
 * phantom-process-guard.ts — Detect and recover from Android Phantom Process Killer
 *
 * Android 12+ limits child processes to 32. When exceeded, processes are killed
 * with signal 9. This module monitors ttyd health and shows recovery guidance.
 */

import { Alert, Linking, Platform } from 'react-native';

type RunCommand = (cmd: string, opts: { timeoutMs: number; reason: string }) => Promise<any>;

const HEALTH_CHECK_INTERVAL = 15_000; // 15 seconds
const INITIAL_DELAY = 30_000; // Wait 30s before first check (let ttyd finish starting)
const CONSECUTIVE_FAILURES_REQUIRED = 2; // Require 2 consecutive failures before declaring killed

let _healthTimer: ReturnType<typeof setInterval> | null = null;
let _initialDelayTimer: ReturnType<typeof setTimeout> | null = null;
let _monitoredPorts: Set<number> = new Set();
let _onProcessKilled: ((port: number) => void) | null = null;
let _failureCounts: Map<number, number> = new Map();
let _recovering: Set<number> = new Set(); // Ports currently in recovery — skip checks

/** Check if a ttyd process on a given port is still alive */
async function checkPort(port: number, runRawCommand: RunCommand): Promise<boolean> {
  try {
    const result = await runRawCommand(
      `pgrep -f "ttyd -p ${port}" > /dev/null 2>&1 && echo ALIVE || echo DEAD`,
      { timeoutMs: 3000, reason: 'phantom-check' },
    );
    const output = typeof result === 'string' ? result : result?.output || '';
    return output.includes('ALIVE');
  } catch {
    // Can't run command (bridge not ready, etc.) — don't count as a kill
    return true;
  }
}

/** Run health check on all monitored ports */
async function healthCheck(runRawCommand: RunCommand): Promise<void> {
  for (const port of _monitoredPorts) {
    // Skip ports that are currently recovering
    if (_recovering.has(port)) continue;

    const alive = await checkPort(port, runRawCommand);
    if (alive) {
      // Reset failure count on success
      _failureCounts.set(port, 0);
    } else {
      const count = (_failureCounts.get(port) || 0) + 1;
      _failureCounts.set(port, count);
      if (count >= CONSECUTIVE_FAILURES_REQUIRED) {
        _monitoredPorts.delete(port);
        _failureCounts.delete(port);
        _onProcessKilled?.(port);
      }
    }
  }
}

/** Show recovery dialog when a process is killed */
export function showPhantomKillerRecovery(
  sessionName: string,
  onRestart: () => void,
): void {
  const androidVersion = Platform.Version;
  const hasDevOption = typeof androidVersion === 'number' && androidVersion >= 34; // Android 14+

  const buttons: any[] = [
    { text: 'Restart Session', onPress: onRestart },
  ];

  if (hasDevOption) {
    buttons.push({
      text: 'Disable Process Limit',
      onPress: () => {
        Alert.alert(
          'Disable Phantom Process Killer',
          'Go to:\nSettings → Developer Options → "Disable child process restrictions"\n\nThis prevents Android from killing background processes.',
          [{ text: 'Open Settings', onPress: () => Linking.openSettings() }, { text: 'OK' }],
        );
      },
    });
  }

  buttons.push({
    text: 'Learn More',
    onPress: () => {
      Alert.alert(
        'About Phantom Process Killer',
        'Android 12+ limits apps to 32 child processes. When you run multiple terminal sessions (ttyd, Claude Code, Gemini CLI), you may hit this limit.\n\n' +
        'Solutions:\n' +
        '• Android 14+: Disable "child process restrictions" in Developer Options\n' +
        '• Android 12-13: Run via ADB:\n  adb shell device_config put activity_manager max_phantom_processes 2147483647\n' +
        '• Reduce number of concurrent sessions',
        [{ text: 'OK' }],
      );
    },
  });

  Alert.alert(
    `⚠️ ${sessionName} was killed by Android`,
    'The terminal session was terminated by Android\'s process killer. This typically happens when too many background processes are running.',
    buttons,
  );
}

/** Start monitoring ttyd processes for unexpected kills */
export function startPhantomGuard(
  ports: number[],
  runRawCommand: RunCommand,
  onKilled: (port: number) => void,
): void {
  stopPhantomGuard();
  _monitoredPorts = new Set(ports);
  _onProcessKilled = onKilled;
  _failureCounts = new Map();
  _recovering = new Set();

  // Delay the first health check to let ttyd fully start
  _initialDelayTimer = setTimeout(() => {
    _initialDelayTimer = null;
    _healthTimer = setInterval(() => {
      healthCheck(runRawCommand);
    }, HEALTH_CHECK_INTERVAL);
  }, INITIAL_DELAY);
}

/** Stop monitoring */
export function stopPhantomGuard(): void {
  if (_initialDelayTimer) {
    clearTimeout(_initialDelayTimer);
    _initialDelayTimer = null;
  }
  if (_healthTimer) {
    clearInterval(_healthTimer);
    _healthTimer = null;
  }
  _monitoredPorts.clear();
  _onProcessKilled = null;
  _failureCounts = new Map();
  _recovering = new Set();
}

/** Add a port to monitor (e.g., when new session created) */
export function monitorPort(port: number): void {
  _monitoredPorts.add(port);
}

/** Remove a port from monitoring (e.g., when session intentionally closed) */
export function unmonitorPort(port: number): void {
  _monitoredPorts.delete(port);
  _failureCounts.delete(port);
  _recovering.delete(port);
}

/** Mark a port as recovering — phantom guard will skip checks until resumed */
export function pauseMonitorForRecovery(port: number): void {
  _recovering.add(port);
  _failureCounts.delete(port);
}

/** Resume monitoring after recovery is complete */
export function resumeMonitorAfterRecovery(port: number): void {
  _recovering.delete(port);
  _failureCounts.set(port, 0);
  _monitoredPorts.add(port);
}
