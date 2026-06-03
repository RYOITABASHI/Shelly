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

import { getCodexReplyReadiness, sendCodexReply } from '@/lib/codex-session-reply';

const ACTIVE_CODEX_SCREEN = [
  '>_ OpenAI Codex (v0.135.0)',
  'directory: /data/data/dev.shelly.terminal/files/home',
  'gpt-5.5 default · /data/data/dev.shelly.terminal/files/home',
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

  it('writes a single-line reply through the bound native PTY', async () => {
    const result = await sendCodexReply(codexSession(), 'こんにちは');

    expect(result).toEqual({
      status: 'sent',
      terminalSessionId: 'terminal-a',
      nativeSessionId: 'shelly-1',
    });
    expect(mockWriteToSession).toHaveBeenCalledWith('shelly-1', 'こんにちは\n');
    expect(mockPasteToSession).not.toHaveBeenCalled();
  });

  it('pastes multiline replies before pressing enter', async () => {
    const result = await sendCodexReply(codexSession(), 'first line\nsecond line');

    expect(result.status).toBe('sent');
    expect(mockPasteToSession).toHaveBeenCalledWith('shelly-1', 'first line\nsecond line');
    expect(mockWriteToSession).toHaveBeenCalledWith('shelly-1', '\n');
  });

  it('blocks replies when the binding is only a candidate', async () => {
    const result = await sendCodexReply(codexSession({
      bindingConfidence: 'candidate',
    }), 'do it');

    expect(result).toEqual({ status: 'blocked', reason: 'not_reliably_bound' });
    expect(mockWriteToSession).not.toHaveBeenCalled();
    expect(mockPasteToSession).not.toHaveBeenCalled();
  });

  it('does not use a stale Shelly terminal id when the native PTY id has changed', async () => {
    mockTerminalState.sessions = [terminalSession('terminal-a', 'shelly-recreated')];

    const result = await sendCodexReply(codexSession({
      ptySessionId: 'shelly-1',
      shellySessionId: 'terminal-a',
    }), 'do it');

    expect(result).toEqual({ status: 'blocked', reason: 'terminal_missing' });
    expect(mockWriteToSession).not.toHaveBeenCalled();
    expect(mockPasteToSession).not.toHaveBeenCalled();
  });

  it('blocks replies while Codex is busy', async () => {
    const result = await sendCodexReply(codexSession({
      currentStatus: 'TOOL_RUNNING',
    }), 'next task');

    expect(result).toEqual({ status: 'blocked', reason: 'busy' });
    expect(mockWriteToSession).not.toHaveBeenCalled();
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
