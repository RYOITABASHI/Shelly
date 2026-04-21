import { useExecutionLogStore } from '@/store/execution-log-store';
import { useTerminalStore } from '@/store/terminal-store';

function formatSessionOutput(sessionId: string, output: string): string {
  return `=== Session: ${sessionId} ===\n${output}`;
}

function formatLegacyTerminalOutput(): string {
  const sessions = useTerminalStore.getState().sessions;
  return sessions
    .map((session: any) =>
      session.entries
        .map((entry: any) => `$ ${entry.command ?? ''}\n${(entry.output ?? []).map((line: any) => line.text).join('\n')}`)
        .join('\n\n'),
    )
    .filter(Boolean)
    .join('\n---\n');
}

export function buildRecentTerminalLogsText(lines = 500): string {
  const logStore = useExecutionLogStore.getState();

  const sessionOutputs = logStore.getRecentOutputForAllSessions(lines);
  if (sessionOutputs.length > 0) {
    const text = sessionOutputs
      .map((session) => formatSessionOutput(session.sessionId, session.output))
      .join('\n\n');
    if (text.trim()) return text;
  }

  const combined = logStore.getRecentOutput(lines, 0);
  if (combined.trim()) return combined;

  const legacy = formatLegacyTerminalOutput();
  if (legacy.trim()) return legacy;

  return 'No terminal output to export.';
}
