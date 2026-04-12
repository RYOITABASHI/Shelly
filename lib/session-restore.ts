/**
 * tmux/screen session detection and auto-attach.
 * Runs `tmux ls` on shell reconnect to detect existing sessions.
 */

export type TmuxSession = {
  name: string;
  windows: number;
  attached: boolean;
  created: string;
};

/**
 * Parse `tmux ls` output into structured session list.
 * Format: "session_name: N windows (created Day Mon DD HH:MM:SS YYYY) (attached)"
 */
export function parseTmuxList(output: string): TmuxSession[] {
  const sessions: TmuxSession[] = [];
  const lines = output.split('\n').filter((l) => l.trim());

  for (const line of lines) {
    const match = line.match(
      /^([^:]+):\s+(\d+)\s+windows?\s+\(created\s+(.+?)\)(\s+\(attached\))?/,
    );
    if (match) {
      sessions.push({
        name: match[1].trim(),
        windows: parseInt(match[2], 10),
        attached: !!match[4],
        created: match[3],
      });
    }
  }

  return sessions;
}

/**
 * Build the command to attach to a tmux session.
 */
export function buildTmuxAttachCommand(sessionName: string): string {
  return `tmux attach-session -t ${sessionName}`;
}

/**
 * Build the command to list tmux sessions.
 */
export function buildTmuxListCommand(): string {
  return 'tmux ls 2>/dev/null || echo "no-tmux-sessions"';
}

/**
 * Build a screen session list command.
 */
export function buildScreenListCommand(): string {
  return 'screen -ls 2>/dev/null || echo "no-screen-sessions"';
}

export type ScreenSession = {
  pid: string;
  name: string;
  state: 'Detached' | 'Attached' | string;
};

/**
 * Parse `screen -ls` output.
 * Format: "	12345.session_name	(MM/DD/YYYY HH:MM:SS PM)	(Detached)"
 */
export function parseScreenList(output: string): ScreenSession[] {
  const sessions: ScreenSession[] = [];
  const lines = output.split('\n');

  for (const line of lines) {
    const match = line.match(/\s+(\d+)\.(\S+)\s+.*\((Detached|Attached)\)/);
    if (match) {
      sessions.push({
        pid: match[1],
        name: match[2],
        state: match[3],
      });
    }
  }

  return sessions;
}

/**
 * Build the command to reattach a screen session.
 */
export function buildScreenAttachCommand(sessionName: string): string {
  return `screen -r ${sessionName}`;
}
