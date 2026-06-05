import { detectCodexActiveTranscript, detectCodexApprovalPrompt } from '@/lib/codex-pty-detection';
import { bindVisibleCodexTerminalToSession } from '@/lib/codex-session-resume';
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
  | 'not_codex_terminal'
  | 'no_approval_prompt';

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

export type CodexApprovalDecision = 'allow' | 'deny';

const BUSY_CODEX_STATUSES = new Set(['THINKING', 'TOOL_RUNNING', 'WAITING_PERMISSION', 'ERROR']);
const APPROVAL_CODEX_STATUS = 'WAITING_PERMISSION';

export async function getCodexReplyReadiness(
  session: AgentChatSession | null | undefined,
): Promise<CodexReplyReadiness> {
  const readiness = await getBoundCodexTerminalReadiness(session);
  if (!readiness.ready) return readiness;

  if (BUSY_CODEX_STATUSES.has((session.currentStatus ?? '').trim().toUpperCase())) {
    return {
      ready: false,
      reason: 'busy',
      terminalSessionId: readiness.terminalSessionId,
      nativeSessionId: readiness.nativeSessionId,
    };
  }

  return readiness;
}

export async function getCodexApprovalReadiness(
  session: AgentChatSession | null | undefined,
): Promise<CodexReplyReadiness> {
  const readiness = await getBoundCodexTerminalReadiness(session);
  if (!readiness.ready) return readiness;

  if ((session.currentStatus ?? '').trim().toUpperCase() !== APPROVAL_CODEX_STATUS) {
    return {
      ready: false,
      reason: 'busy',
      terminalSessionId: readiness.terminalSessionId,
      nativeSessionId: readiness.nativeSessionId,
    };
  }

  return getBoundCodexTerminalReadiness(session, { requireApprovalPrompt: true });
}

export async function sendCodexReply(
  session: AgentChatSession | null | undefined,
  text: string,
): Promise<CodexReplySendResult> {
  const message = normalizeReplyText(text);
  if (!message.trim()) return { status: 'blocked', reason: 'empty_message' };

  const readiness = await getCodexReplyReadinessWithVisibleBind(session);
  if (readiness.ready === false) {
    return { status: 'blocked', reason: readiness.reason };
  }

  try {
    await TerminalEmulator.writeToSession(readiness.nativeSessionId, '\u0015');
    await TerminalEmulator.pasteToSession(readiness.nativeSessionId, message);
    await TerminalEmulator.writeToSession(readiness.nativeSessionId, '\r');
    return {
      status: 'sent',
      terminalSessionId: readiness.terminalSessionId,
      nativeSessionId: readiness.nativeSessionId,
    };
  } catch {
    return { status: 'failed', reason: 'screen_unavailable' };
  }
}

export async function sendCodexApproval(
  session: AgentChatSession | null | undefined,
  decision: CodexApprovalDecision,
): Promise<CodexReplySendResult> {
  const readiness = await getCodexApprovalReadinessWithVisibleBind(session);
  if (readiness.ready === false) {
    return { status: 'blocked', reason: readiness.reason };
  }

  try {
    await TerminalEmulator.writeToSession(readiness.nativeSessionId, decision === 'allow' ? 'y\r' : 'n\r');
    return {
      status: 'sent',
      terminalSessionId: readiness.terminalSessionId,
      nativeSessionId: readiness.nativeSessionId,
    };
  } catch {
    return { status: 'failed', reason: 'screen_unavailable' };
  }
}

async function getCodexReplyReadinessWithVisibleBind(
  session: AgentChatSession | null | undefined,
): Promise<CodexReplyReadiness> {
  let readiness = await getCodexReplyReadiness(session);
  if (readiness.ready === true) return readiness;
  if (!shouldTryVisibleCodexBind(readiness.reason)) return readiness;
  const visibleBind = await bindVisibleCodexTerminalToSession(session, { focus: false });
  if (!visibleBind) return readiness;
  return getCodexReplyReadiness(visibleBind.session);
}

async function getCodexApprovalReadinessWithVisibleBind(
  session: AgentChatSession | null | undefined,
): Promise<CodexReplyReadiness> {
  let readiness = await getCodexApprovalReadiness(session);
  if (readiness.ready === true) return readiness;
  if (!shouldTryVisibleCodexBind(readiness.reason)) return readiness;
  const visibleBind = await bindVisibleCodexTerminalToSession(session, { focus: false });
  if (!visibleBind) return readiness;
  return getCodexApprovalReadiness(visibleBind.session);
}

function shouldTryVisibleCodexBind(reason: CodexReplyBlockedReason): boolean {
  return reason === 'not_reliably_bound'
    || reason === 'terminal_missing'
    || reason === 'not_codex_terminal'
    || reason === 'native_exited'
    || reason === 'terminal_exited';
}

async function getBoundCodexTerminalReadiness(
  session: AgentChatSession | null | undefined,
  options: { requireApprovalPrompt?: boolean } = {},
): Promise<CodexReplyReadiness> {
  if (!session) return { ready: false, reason: 'no_session' };
  if (session.bindingConfidence !== 'reliable') {
    return { ready: false, reason: 'not_reliably_bound' };
  }

  const terminalSession = findBoundTerminalSession(session);
  if (!terminalSession) return { ready: false, reason: 'terminal_missing' };

  if (terminalSession.sessionStatus === 'exited') {
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
  if (options.requireApprovalPrompt && !detectCodexApprovalPrompt(screenText)) {
    return {
      ready: false,
      reason: 'no_approval_prompt',
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

function findBoundTerminalSession(session: AgentChatSession): TabSession | undefined {
  const terminalSessions = useTerminalStore.getState().sessions;
  const shellySessionId = session.shellySessionId?.trim();
  const shellyMatch = shellySessionId
    ? terminalSessions.find((candidate) => candidate.id === shellySessionId)
    : undefined;
  if (shellyMatch) return shellyMatch;

  const ptySessionId = session.ptySessionId?.trim();
  if (!ptySessionId) return undefined;
  return terminalSessions.find((candidate) => candidate.nativeSessionId === ptySessionId);
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
