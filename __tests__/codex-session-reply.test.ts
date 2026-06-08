import type { AgentChatSession } from '@/store/agent-chat-store';
import type { TabSession } from '@/store/types';

let mockTerminalState: {
  sessions: TabSession[];
};

const mockSetTerminalState = jest.fn();
const mockIsSessionAlive = jest.fn();
const mockGetScreenText = jest.fn();
const mockWriteToSession = jest.fn();
const mockPasteToSession = jest.fn();
const mockFocusTerminalSession = jest.fn();
const mockBindVisibleCodexTerminalToSession = jest.fn();

jest.mock('@/store/terminal-store', () => ({
  useTerminalStore: {
    getState: () => mockTerminalState,
    setState: (updater: unknown) => {
      mockSetTerminalState(updater);
      if (typeof updater === 'function') {
        mockTerminalState = {
          ...mockTerminalState,
          ...(updater as (state: typeof mockTerminalState) => Partial<typeof mockTerminalState>)(mockTerminalState),
        };
      }
    },
  },
}));

jest.mock('@/modules/terminal-emulator/src/TerminalEmulatorModule', () => ({
  __esModule: true,
  default: {
    isSessionAlive: (sessionId: string) => mockIsSessionAlive(sessionId),
    getScreenText: (sessionId: string) => mockGetScreenText(sessionId),
    writeToSession: (sessionId: string, data: string) => mockWriteToSession(sessionId, data),
    pasteToSession: (sessionId: string, text: string) => mockPasteToSession(sessionId, text),
  },
}));

jest.mock('@/lib/codex-session-resume', () => ({
  bindVisibleCodexTerminalToSession: (session: AgentChatSession | null | undefined, options: { focus?: boolean }) =>
    mockBindVisibleCodexTerminalToSession(session, options),
  focusTerminalSession: (sessionId: string) => mockFocusTerminalSession(sessionId),
}));

import { getCodexApprovalReadiness, getCodexReplyReadiness, sendCodexApproval, sendCodexReply } from '@/lib/codex-session-reply';

const ACTIVE_CODEX_SCREEN = [
  '>_ OpenAI Codex (v0.135.0)',
  'directory: /data/data/dev.shelly.terminal/files/home',
  'gpt-5.5 default · /data/data/dev.shelly.terminal/files/home',
].join('\n');

const APPROVAL_CODEX_SCREEN = [
  ACTIVE_CODEX_SCREEN,
  'Approval requested',
  'Allow this command? yes/no',
].join('\n');

const INTERACTIVE_CODEX_SCREEN = [
  ACTIVE_CODEX_SCREEN,
  'Approaching rate limits',
  'Switch to gpt-5.4-mini for lower credit usage?',
  '> 1. Switch to gpt-5.4-mini',
  '2. Keep current model',
  '3. Keep current model (never show again)',
  'Press enter to confirm or esc to go back',
].join('\n');

function terminalSession(
  id: string,
  nativeSessionId: string,
  overrides: Partial<TabSession> = {},
): TabSession {
  return {
    id,
    name: id,
    currentDir: '/data/data/dev.shelly.terminal/files/home',
    blocks: [],
    entries: [],
    commandHistory: [],
    historyIndex: -1,
    activeCli: 'codex',
    tmuxSession: nativeSessionId,
    nativeSessionId,
    sessionStatus: 'alive',
    isAlive: true,
    ...overrides,
  };
}

function codexSession(overrides: Partial<AgentChatSession> = {}): AgentChatSession {
  return {
    codexSessionId: 'codex-jsonl-session',
    projectName: 'home',
    currentStatus: 'COMPLETED',
    lastEventAt: 1_811_200_000_000,
    sessionStartAt: 1_811_199_000_000,
    cwd: '/data/data/dev.shelly.terminal/files/home',
    ptySessionId: 'shelly-1',
    shellySessionId: 'terminal-a',
    bindingConfidence: 'reliable',
    ...overrides,
  };
}

function resetMocks(): void {
  mockTerminalState = {
    sessions: [terminalSession('terminal-a', 'shelly-1')],
  };
  mockSetTerminalState.mockClear();
  mockIsSessionAlive.mockReset();
  mockIsSessionAlive.mockResolvedValue(true);
  mockGetScreenText.mockReset();
  mockGetScreenText.mockResolvedValue(ACTIVE_CODEX_SCREEN);
  mockWriteToSession.mockReset();
  mockWriteToSession.mockResolvedValue(undefined);
  mockPasteToSession.mockReset();
  mockPasteToSession.mockResolvedValue(undefined);
  mockFocusTerminalSession.mockReset();
  mockFocusTerminalSession.mockReturnValue(true);
  mockBindVisibleCodexTerminalToSession.mockReset();
  mockBindVisibleCodexTerminalToSession.mockResolvedValue(null);
}

describe('codex session replies', () => {
  beforeEach(() => {
    resetMocks();
  });

  it('reports ready for a reliably bound live Codex PTY', async () => {
    const readiness = await getCodexReplyReadiness(codexSession());

    expect(readiness).toEqual({
      ready: true,
      reason: 'ready',
      terminalSessionId: 'terminal-a',
      nativeSessionId: 'shelly-1',
    });
  });

  it('reports ready for a native-alive Codex PTY while Shelly is still reattaching', async () => {
    mockTerminalState.sessions = [terminalSession('terminal-a', 'shelly-1', {
      sessionStatus: 'starting',
      isAlive: false,
    })];

    const readiness = await getCodexReplyReadiness(codexSession());

    expect(readiness).toEqual({
      ready: true,
      reason: 'ready',
      terminalSessionId: 'terminal-a',
      nativeSessionId: 'shelly-1',
    });
  });

  it('clears the composer then pastes a single-line reply through the bound native PTY before pressing enter', async () => {
    const result = await sendCodexReply(codexSession(), 'こんにちは');

    expect(result).toEqual({
      status: 'sent',
      terminalSessionId: 'terminal-a',
      nativeSessionId: 'shelly-1',
    });
    expect(mockWriteToSession).toHaveBeenNthCalledWith(1, 'shelly-1', '\u0015');
    expect(mockPasteToSession).toHaveBeenCalledWith('shelly-1', 'こんにちは');
    expect(mockWriteToSession).toHaveBeenNthCalledWith(2, 'shelly-1', '\r');
  });

  it('pastes multiline replies before pressing enter', async () => {
    const result = await sendCodexReply(codexSession(), 'first line\nsecond line');

    expect(result.status).toBe('sent');
    expect(mockWriteToSession).toHaveBeenNthCalledWith(1, 'shelly-1', '\u0015');
    expect(mockPasteToSession).toHaveBeenCalledWith('shelly-1', 'first line\nsecond line');
    expect(mockWriteToSession).toHaveBeenNthCalledWith(2, 'shelly-1', '\r');
  });

  it('blocks replies when the binding is only a candidate', async () => {
    const result = await sendCodexReply(codexSession({
      bindingConfidence: 'candidate',
    }), 'do it');

    expect(result).toEqual({ status: 'blocked', reason: 'not_reliably_bound' });
    expect(mockWriteToSession).not.toHaveBeenCalled();
    expect(mockPasteToSession).not.toHaveBeenCalled();
  });

  it('uses the current native PTY when the bound Shelly terminal id is stable', async () => {
    mockTerminalState.sessions = [terminalSession('terminal-a', 'shelly-recreated')];

    const result = await sendCodexReply(codexSession({
      ptySessionId: 'shelly-1',
      shellySessionId: 'terminal-a',
    }), 'do it');

    expect(result).toEqual({
      status: 'sent',
      terminalSessionId: 'terminal-a',
      nativeSessionId: 'shelly-recreated',
    });
    expect(mockWriteToSession).toHaveBeenNthCalledWith(1, 'shelly-recreated', '\u0015');
    expect(mockPasteToSession).toHaveBeenCalledWith('shelly-recreated', 'do it');
    expect(mockWriteToSession).toHaveBeenNthCalledWith(2, 'shelly-recreated', '\r');
  });

  it('does not use a stale native PTY id without a Shelly terminal binding', async () => {
    mockTerminalState.sessions = [terminalSession('terminal-a', 'shelly-recreated')];

    const result = await sendCodexReply(codexSession({
      ptySessionId: 'shelly-1',
      shellySessionId: undefined,
    }), 'do it');

    expect(result).toEqual({ status: 'blocked', reason: 'terminal_missing' });
    expect(mockWriteToSession).not.toHaveBeenCalled();
    expect(mockPasteToSession).not.toHaveBeenCalled();
  });

  it('rebinds to a visible Codex PTY when the stored terminal is marked exited', async () => {
    const reboundSession = codexSession({
      ptySessionId: 'shelly-2',
      shellySessionId: 'terminal-b',
      bindingConfidence: 'reliable',
    });
    mockTerminalState.sessions = [
      terminalSession('terminal-a', 'shelly-1', {
        sessionStatus: 'exited',
        isAlive: false,
      }),
      terminalSession('terminal-b', 'shelly-2'),
    ];
    mockBindVisibleCodexTerminalToSession.mockResolvedValue({
      terminalSessionId: 'terminal-b',
      nativeSessionId: 'shelly-2',
      session: reboundSession,
    });

    const result = await sendCodexReply(codexSession(), 'do it');

    expect(mockBindVisibleCodexTerminalToSession).toHaveBeenCalledWith(codexSession(), { focus: false });
    expect(result).toEqual({
      status: 'sent',
      terminalSessionId: 'terminal-b',
      nativeSessionId: 'shelly-2',
    });
    expect(mockWriteToSession).toHaveBeenNthCalledWith(1, 'shelly-2', '\u0015');
    expect(mockPasteToSession).toHaveBeenCalledWith('shelly-2', 'do it');
    expect(mockWriteToSession).toHaveBeenNthCalledWith(2, 'shelly-2', '\r');
  });

  it('blocks replies while Codex is busy', async () => {
    const result = await sendCodexReply(codexSession({
      currentStatus: 'TOOL_RUNNING',
    }), 'next task');

    expect(result).toEqual({ status: 'blocked', reason: 'busy' });
    expect(mockWriteToSession).not.toHaveBeenCalled();
  });

  it('blocks replies while Codex is waiting for an interactive terminal choice', async () => {
    mockGetScreenText.mockResolvedValue(INTERACTIVE_CODEX_SCREEN);

    const result = await sendCodexReply(codexSession(), 'next task');

    expect(result).toEqual({ status: 'blocked', reason: 'interactive_prompt' });
    expect(mockWriteToSession).not.toHaveBeenCalled();
    expect(mockPasteToSession).not.toHaveBeenCalled();
  });

  it('allows approval decisions only while Codex is waiting for permission', async () => {
    mockGetScreenText.mockResolvedValue(APPROVAL_CODEX_SCREEN);

    const readiness = await getCodexApprovalReadiness(codexSession({
      currentStatus: 'WAITING_PERMISSION',
    }));

    expect(readiness).toEqual({
      ready: true,
      reason: 'ready',
      terminalSessionId: 'terminal-a',
      nativeSessionId: 'shelly-1',
    });
  });

  it('sends allow approval through the bound native PTY', async () => {
    mockGetScreenText.mockResolvedValue(APPROVAL_CODEX_SCREEN);

    const result = await sendCodexApproval(codexSession({
      currentStatus: 'WAITING_PERMISSION',
    }), 'allow');

    expect(result.status).toBe('sent');
    expect(mockFocusTerminalSession).not.toHaveBeenCalled();
    expect(mockWriteToSession).toHaveBeenCalledWith('shelly-1', 'y\r');
  });

  it('sends deny approval through the bound native PTY', async () => {
    mockGetScreenText.mockResolvedValue(APPROVAL_CODEX_SCREEN);

    const result = await sendCodexApproval(codexSession({
      currentStatus: 'WAITING_PERMISSION',
    }), 'deny');

    expect(result.status).toBe('sent');
    expect(mockFocusTerminalSession).not.toHaveBeenCalled();
    expect(mockWriteToSession).toHaveBeenCalledWith('shelly-1', 'n\r');
  });

  it('blocks approval decisions when Codex is not waiting for permission', async () => {
    const result = await sendCodexApproval(codexSession(), 'allow');

    expect(result).toEqual({ status: 'blocked', reason: 'busy' });
    expect(mockWriteToSession).not.toHaveBeenCalled();
  });

  it('blocks stale approval status when the terminal does not show an approval prompt', async () => {
    const result = await sendCodexApproval(codexSession({
      currentStatus: 'WAITING_PERMISSION',
    }), 'allow');

    expect(result).toEqual({ status: 'blocked', reason: 'no_approval_prompt' });
    expect(mockWriteToSession).not.toHaveBeenCalled();
  });

  it('checks the terminal screen before treating a busy session as interruptible Codex', async () => {
    mockGetScreenText.mockResolvedValue('~$');

    const readiness = await getCodexReplyReadiness(codexSession({
      currentStatus: 'TOOL_RUNNING',
    }));

    expect(readiness).toEqual({
      ready: false,
      reason: 'not_codex_terminal',
      terminalSessionId: 'terminal-a',
      nativeSessionId: 'shelly-1',
    });
  });

  it('blocks replies when the bound terminal has returned to the shell', async () => {
    mockGetScreenText.mockResolvedValue([
      ACTIVE_CODEX_SCREEN,
      '~$',
    ].join('\n'));

    const result = await sendCodexReply(codexSession(), 'next task');

    expect(result).toEqual({ status: 'blocked', reason: 'not_codex_terminal' });
    expect(mockWriteToSession).not.toHaveBeenCalled();
  });

  it('blocks replies with a launch failure reason after Codex crashes back to shell', async () => {
    mockGetScreenText.mockResolvedValue([
      'Bus error        LD_LIBRARY_PATH="$SHELLY_LD_LIBRARY_PATH" /system/bin/linker64 "$@"',
      '~$',
    ].join('\n'));

    const result = await sendCodexReply(codexSession(), 'next task');

    expect(result).toEqual({ status: 'blocked', reason: 'codex_launch_failed' });
    expect(mockWriteToSession).not.toHaveBeenCalled();
    expect(mockPasteToSession).not.toHaveBeenCalled();
  });

  it('allows replies after an app-data crash successfully falls back to bundled Codex', async () => {
    mockGetScreenText.mockResolvedValue([
      'Bus error        LD_LIBRARY_PATH="$SHELLY_LD_LIBRARY_PATH" /system/bin/linker64 "$@"',
      '[shelly] Codex app-data runtime crashed during startup; retrying bundled runtime.',
      ACTIVE_CODEX_SCREEN,
    ].join('\n'));

    const result = await sendCodexReply(codexSession(), 'next task');

    expect(result).toEqual({
      status: 'sent',
      terminalSessionId: 'terminal-a',
      nativeSessionId: 'shelly-1',
    });
    expect(mockPasteToSession).toHaveBeenCalledWith('shelly-1', 'next task');
  });

  it('treats a native-alive Codex PTY with a blank screen as busy instead of missing', async () => {
    mockGetScreenText.mockResolvedValue('');

    const result = await sendCodexReply(codexSession(), 'next task');

    expect(result).toEqual({ status: 'blocked', reason: 'busy' });
    expect(mockBindVisibleCodexTerminalToSession).not.toHaveBeenCalled();
    expect(mockWriteToSession).not.toHaveBeenCalled();
  });

  it('marks the terminal exited when the native PTY is gone', async () => {
    mockIsSessionAlive.mockResolvedValue(false);

    const result = await sendCodexReply(codexSession(), 'next task');

    expect(result).toEqual({ status: 'blocked', reason: 'native_exited' });
    expect(mockSetTerminalState).toHaveBeenCalled();
    expect(mockTerminalState.sessions[0]).toMatchObject({
      sessionStatus: 'exited',
      isAlive: false,
      activeCli: null,
    });
  });
});
