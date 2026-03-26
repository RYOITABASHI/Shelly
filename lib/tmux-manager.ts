/**
 * lib/tmux-manager.ts — tmuxセッション管理ユーティリティ
 *
 * Shellyの各ターミナルタブに対応するtmuxセッション(shelly-1〜6)を管理する。
 * 全てのコマンドはbridgeのrunRawCommand経由で実行する。
 */

type RunCommand = (cmd: string, opts: { timeoutMs: number; reason: string }) => Promise<any>;

/** CLI復帰コマンドマップ */
export const CLI_RESUME_COMMANDS: Record<string, string | null> = {
  claude: 'claude --continue',
  gemini: 'gemini --resume latest',
  codex: null,
  cody: null,
};

/** ポート番号からtmuxセッション名を導出 */
export function tmuxSessionName(port: number): string {
  return `shelly-${port - 7681 + 1}`;
}

/** セッションが生きているか確認 */
export async function isSessionAlive(
  name: string,
  runCmd: RunCommand,
): Promise<boolean> {
  try {
    const result = await runCmd(
      `tmux has-session -t "${name}" 2>/dev/null && echo "ALIVE" || echo "DEAD"`,
      { timeoutMs: 5000, reason: 'tmux-check' },
    );
    const output = typeof result === 'string' ? result : result?.output || '';
    return output.trim().includes('ALIVE');
  } catch {
    return false;
  }
}

/** セッションが存在しなければ作成 */
export async function ensureSession(
  name: string,
  runCmd: RunCommand,
): Promise<void> {
  try {
    await runCmd(
      `tmux has-session -t "${name}" 2>/dev/null || tmux new-session -d -s "${name}"`,
      { timeoutMs: 5000, reason: 'tmux-ensure' },
    );
  } catch {
    // best-effort
  }
}

/** セッション削除（タブ閉じ時） */
export async function killSession(
  name: string,
  runCmd: RunCommand,
): Promise<void> {
  try {
    await runCmd(
      `tmux kill-session -t "${name}" 2>/dev/null`,
      { timeoutMs: 5000, reason: 'tmux-kill' },
    );
  } catch {
    // best-effort
  }
}

/**
 * tmuxが死んでいた場合の復帰コマンドを組み立てる。
 * cwdに移動し、activeCliに応じた復帰コマンドを実行する。
 */
export function buildRecoveryCommand(
  cwd: string,
  activeCli: string | null,
): string | null {
  if (!cwd) return null;

  const escaped = cwd.replace(/'/g, "'\\''");
  const cdCmd = `cd '${escaped}'`;

  if (!activeCli) return cdCmd;

  const resumeCmd = CLI_RESUME_COMMANDS[activeCli];
  if (resumeCmd) {
    return `${cdCmd} && ${resumeCmd}`;
  }
  // CLI without resume support — just launch it
  return `${cdCmd} && ${activeCli}`;
}

/**
 * tmuxセッション内でコマンドを送信する（復帰時に使用）。
 * tmux send-keys でセッション内のbashにコマンドを送る。
 */
export async function sendKeysToSession(
  name: string,
  command: string,
  runCmd: RunCommand,
): Promise<void> {
  const escaped = command.replace(/"/g, '\\"');
  try {
    await runCmd(
      `tmux send-keys -t "${name}" "${escaped}" Enter`,
      { timeoutMs: 5000, reason: 'tmux-send-keys' },
    );
  } catch {
    // best-effort
  }
}
