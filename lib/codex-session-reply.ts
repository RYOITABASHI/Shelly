import { detectCodexActiveTranscript } from '@/lib/codex-pty-detection';
import TerminalEmulator from '@/modules/terminal-emulator/src/TerminalEmulatorModule';
import type { AgentChatSession } from '@/store/agent-chat-store';
import { useTerminalStore } from '@/store/terminal-store';
import type { TabSession } from '@/store/types';

export type CodexReplyReadinessReason =
  | 'ready'
  | 'empty_message'
  | 'no_session'
  | 'not_reliably_bound'
  | 'terminal_missing'
  | 'terminal_exited'
  | 'native_exited'
  | 'busy'
  | 'screen_unavailable'
  | 'not_codex_terminal';

export type CodexReplyBlockedReason = Exclude<CodexReplyReadinessReason, 'ready'>;

export type CodexReplyReadyReadiness = {
  ready: true;
  reason: 'ready';
  terminalSessionId: string;
  nativeSessionId: string;
};

export type CodexReplyBlockedReadiness = {
  ready: false;
  reason: CodexReplyBlockedReason;
  terminalSessionId?: string;
  nativeSessionId?: string;
};

export type CodexReplyReadiness = CodexReplyReadyReadiness | CodexReplyBlockedReadiness;

export type CodexReplySendResult =
  | {
      status: 'sent';
      terminalSessionId: string;
      nativeSessionId: string;
    }
  | {
      status: 'blocked' | 'failed';
      reason: CodexReplyBlockedReason;
    };

const BUSY_CODEX_STATUSES = new Set(['THINKING', 'TOOL_RUNNING', 'WAITING_PERMISSION', 'ERROR']);

export async function getCodexReplyReadiness(
  session: AgentChatSession | null | undefined,
): Promise<CodexReplyReadiness> {
  if (!session) return { ready: false, reason: 'no_session' };
  if (session.bindingConfidence !== 'reliable') {
    return { ready: false, reason: 'not_reliably_bound' };
  }

  const terminalSession = findBoundTerminalSession(session);
  if (!terminalSession) return { ready: false, reason: 'terminal_missing' };

  if (terminalSession.sessionStatus !== 'alive' || !terminalSession.isAlive) {
    return {
      ready: false,
      reason: 'terminal_exited',
      terminalSessionId: terminalSession.id,
      nativeSessionId: terminalSession.nativeSessionId,
    };
  }

  if (!await isNativeSessionAlive(terminalSession)) {
    return {
      ready: false,
      reason: 'native_exited',
      terminalSessionId: terminalSession.id,
      nativeSessionId: terminalSession.nativeSessionId,
    };
  }

  const screenText = await TerminalEmulator.getScreenText(terminalSession.nativeSessionId).catch(() => null);
  if (typeof screenText !== 'string') {
    return {
      ready: false,
      reason: 'screen_unavailable',
      terminalSessionId: terminalSession.id,
      nativeSessionId: terminalSession.nativeSessionId,
    };
  }
  if (!detectCodexActiveTranscript(screenText)) {
    return {
      ready: false,
      reason: 'not_codex_terminal',
      terminalSessionId: terminalSession.id,
      nativeSessionId: terminalSession.nativeSessionId,
    };
  }

  if (BUSY_CODEX_STATUSES.has((session.currentStatus ?? '').trim().toUpperCase())) {
    return {
      ready: false,
      reason: 'busy',
      terminalSessionId: terminalSession.id,
      nativeSessionId: terminalSession.nativeSessionId,
    };
  }

  return {
    ready: true,
    reason: 'ready',
    terminalSessionId: terminalSession.id,
    nativeSessionId: terminalSession.nativeSessionId,
  };
}

export async function sendCodexReply(
  session: AgentChatSession | null | undefined,
  text: string,
): Promise<CodexReplySendResult> {
  const message = normalizeReplyText(text);
  if (!message.trim()) return { status: 'blocked', reason: 'empty_message' };

  const readiness = await getCodexReplyReadiness(session);
  if (readiness.ready === false) {
    return { status: 'blocked', reason: readiness.reason };
  }

  try {
    if (message.includes('\n')) {
      await TerminalEmulator.pasteToSession(readiness.nativeSessionId, message);
      await TerminalEmulator.writeToSession(readiness.nativeSessionId, '\r');
    } else {
      await TerminalEmulator.writeToSession(readiness.nativeSessionId, `${message}\r`);
    }
    return {
      status: 'sent',
      terminalSessionId: readiness.terminalSessionId,
      nativeSessionId: readiness.nativeSessionId,
    };
  } catch {
    return { status: 'failed', reason: 'screen_unavailable' };
  }
}

function findBoundTerminalSession(session: AgentChatSession): TabSession | undefined {
  const terminalSessions = useTerminalStore.getState().sessions;
  const ptySessionId = session.ptySessionId?.trim();
  if (ptySessionId) {
    return terminalSessions.find((candidate) => candidate.nativeSessionId === ptySessionId);
  }

  const shellySessionId = session.shellySessionId?.trim();
  if (!shellySessionId) return undefined;
  return terminalSessions.find((candidate) => candidate.id === shellySessionId);
}

async function isNativeSessionAlive(session: TabSession): Promise<boolean> {
  const alive = await TerminalEmulator.isSessionAlive(session.nativeSessionId).catch(() => session.isAlive);
  if (!alive) {
    markTerminalSessionExited(session.id);
  }
  return alive;
}

function markTerminalSessionExited(sessionId: string): void {
  useTerminalStore.setState((state) => ({
    sessions: state.sessions.map((session) =>
      session.id === sessionId
        ? {
            ...session,
            activeCli: null,
            sessionStatus: 'exited' as const,
            isAlive: false,
          }
        : session
    ),
  }));
}

function normalizeReplyText(value: string): string {
  return value.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trimEnd();
}
