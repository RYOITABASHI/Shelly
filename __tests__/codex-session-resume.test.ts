import type { AgentChatSession } from '@/store/agent-chat-store';
import type { TabSession } from '@/store/types';

type Slot = { id: string; tab: string; sessionId?: string } | null;

let mockTerminalState: {
  sessions: TabSession[];
  activeSessionId: string;
  pendingCommand: null | { command: string; sessionId: string | null };
  insertCommand: jest.Mock<void, [string, string | null | undefined, { durable?: boolean } | undefined]>;
  setActiveSession: jest.Mock<void, [string]>;
};

let mockMultiPaneState: {
  preset: 'p1' | 'p2h' | 'p2v' | 'p3l' | 'p3r' | 'p3t' | 'p3b' | 'p4';
  slots: [Slot, Slot, Slot, Slot];
  focusedSlot: 0 | 1 | 2 | 3;
  maximizedSlot: 0 | 1 | 2 | 3 | null;
  setSlotSessionId: jest.Mock<void, [string, string | null]>;
  setSlotTab: jest.Mock<void, [0 | 1 | 2 | 3, string]>;
  focusSlot: jest.Mock<void, [0 | 1 | 2 | 3]>;
};

const mockSetFocusedPane = jest.fn();
const mockRequestTerminalRefocus = jest.fn();
const mockCreateTerminalSessionForFocusedPane = jest.fn();
const mockIsSessionAlive = jest.fn();
const mockGetScreenText = jest.fn();

jest.mock('@/store/terminal-store', () => ({
  useTerminalStore: {
    getState: () => mockTerminalState,
  },
}));

jest.mock('@/hooks/use-multi-pane', () => ({
  PRESET_CAPACITY: {
    p1: 1,
    p2h: 2,
    p2v: 2,
    p3l: 3,
    p3r: 3,
    p3t: 3,
    p3b: 3,
    p4: 4,
  },
  useMultiPaneStore: {
    getState: () => mockMultiPaneState,
  },
}));

jest.mock('@/store/pane-store', () => ({
  usePaneStore: {
    getState: () => ({
      setFocusedPane: mockSetFocusedPane,
    }),
  },
}));

jest.mock('@/store/focus-store', () => ({
  useFocusStore: {
    getState: () => ({
      requestTerminalRefocus: mockRequestTerminalRefocus,
    }),
  },
}));

jest.mock('@/lib/terminal-session-actions', () => ({
  createTerminalSessionForFocusedPane: () => mockCreateTerminalSessionForFocusedPane(),
}));

jest.mock('@/modules/terminal-emulator/src/TerminalEmulatorModule', () => ({
  __esModule: true,
  default: {
    isSessionAlive: (sessionId: string) => mockIsSessionAlive(sessionId),
    getScreenText: (sessionId: string) => mockGetScreenText(sessionId),
  },
}));

import { resumeCodexSession } from '@/lib/codex-session-resume';

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
    activeCli: null,
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
    currentStatus: 'IDLE',
    lastEventAt: 1_811_200_000_000,
    sessionStartAt: 1_811_199_000_000,
    cwd: '/data/data/dev.shelly.terminal/files/home',
    ptySessionId: null,
    shellySessionId: null,
    bindingConfidence: 'none',
    ...overrides,
  };
}

function resetMocks(): void {
  mockTerminalState = {
    sessions: [terminalSession('terminal-a', 'shelly-1')],
    activeSessionId: 'terminal-a',
    pendingCommand: null,
    insertCommand: jest.fn((command, sessionId, _options) => {
      mockTerminalState.pendingCommand = { command, sessionId: sessionId ?? null };
    }),
    setActiveSession: jest.fn((sessionId) => {
      mockTerminalState.activeSessionId = sessionId;
    }),
  };
  mockMultiPaneState = {
    preset: 'p2h',
    slots: [
      { id: 'pane-terminal', tab: 'terminal', sessionId: 'terminal-a' },
      { id: 'pane-agent-chat', tab: 'agent-chat' },
      null,
      null,
    ],
    focusedSlot: 1,
    maximizedSlot: null,
    setSlotSessionId: jest.fn((paneId, sessionId) => {
      mockMultiPaneState.slots = mockMultiPaneState.slots.map((slot) => (
        slot?.id === paneId ? { ...slot, sessionId: sessionId ?? undefined } : slot
      )) as [Slot, Slot, Slot, Slot];
    }),
    setSlotTab: jest.fn((slotIndex, tab) => {
      const slot = mockMultiPaneState.slots[slotIndex];
      if (!slot) return;
      mockMultiPaneState.slots[slotIndex] = { ...slot, tab };
    }),
    focusSlot: jest.fn((slotIndex) => {
      mockMultiPaneState.focusedSlot = slotIndex;
    }),
  };
  mockSetFocusedPane.mockClear();
  mockRequestTerminalRefocus.mockClear();
  mockCreateTerminalSessionForFocusedPane.mockReset();
  mockIsSessionAlive.mockReset();
  mockIsSessionAlive.mockResolvedValue(true);
  mockGetScreenText.mockReset();
  mockGetScreenText.mockResolvedValue('~$');
}

describe('codex session resume', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    resetMocks();
  });

  afterEach(() => {
    jest.runOnlyPendingTimers();
    jest.useRealTimers();
  });

  it('focuses the existing foreground terminal when the Codex session is reliably bound', async () => {
    mockTerminalState.sessions = [terminalSession('terminal-a', 'shelly-1', { activeCli: 'codex' })];
    mockGetScreenText.mockResolvedValue('gpt-5.5 default · /data/data/dev.shelly.terminal/files/home\n');
    const addTerminalPane = jest.fn();

    const result = await resumeCodexSession(codexSession({
      ptySessionId: 'shelly-1',
      shellySessionId: 'terminal-a',
      bindingConfidence: 'reliable',
    }), { addTerminalPane });

    expect(result).toEqual({ status: 'focused', sessionId: 'terminal-a' });
    expect(addTerminalPane).not.toHaveBeenCalled();
    expect(mockCreateTerminalSessionForFocusedPane).not.toHaveBeenCalled();
    expect(mockTerminalState.pendingCommand).toBeNull();
    expect(mockTerminalState.activeSessionId).toBe('terminal-a');
    expect(mockMultiPaneState.focusedSlot).toBe(0);
    expect(mockSetFocusedPane).toHaveBeenCalledWith('pane-terminal');
  });

  it('queues resume when a stale reliable binding has returned to the shell', async () => {
    mockTerminalState.sessions = [terminalSession('terminal-a', 'shelly-1', { activeCli: 'codex' })];
    mockGetScreenText.mockResolvedValue([
      'gpt-5.5 default · /data/data/dev.shelly.terminal/files/home',
      'Use /skills to list available skills',
      '~$',
    ].join('\n'));
    mockCreateTerminalSessionForFocusedPane.mockReturnValue(undefined);
    const addTerminalPane = jest.fn();

    const result = await resumeCodexSession(codexSession({
      ptySessionId: 'shelly-1',
      shellySessionId: 'terminal-a',
      bindingConfidence: 'reliable',
    }), { addTerminalPane });

    expect(result).toEqual({ status: 'queued', sessionId: 'terminal-a' });
    expect(mockTerminalState.pendingCommand?.command).toContain("codex resume 'codex-jsonl-session'");
    expect(mockTerminalState.insertCommand).toHaveBeenCalledWith(
      expect.stringContaining("codex resume 'codex-jsonl-session'"),
      'terminal-a',
      { durable: true },
    );
  });

  it('focuses a restored live Codex PTY even when activeCli was not persisted', async () => {
    mockTerminalState.sessions = [terminalSession('terminal-a', 'shelly-1', { activeCli: null })];
    mockGetScreenText.mockResolvedValue('gpt-5.5 default · /data/data/dev.shelly.terminal/files/home\n');
    const addTerminalPane = jest.fn();

    const result = await resumeCodexSession(codexSession({
      ptySessionId: 'shelly-1',
      shellySessionId: 'terminal-a',
      bindingConfidence: 'reliable',
    }), { addTerminalPane });

    expect(result).toEqual({ status: 'focused', sessionId: 'terminal-a' });
    expect(mockTerminalState.pendingCommand).toBeNull();
  });

  it('does not focus-only a stale reliable binding when the terminal is no longer live Codex', async () => {
    mockTerminalState.sessions = [terminalSession('terminal-a', 'shelly-1', {
      activeCli: 'codex',
      sessionStatus: 'starting',
      isAlive: false,
    })];
    mockCreateTerminalSessionForFocusedPane.mockReturnValue(undefined);
    const addTerminalPane = jest.fn();

    const result = await resumeCodexSession(codexSession({
      ptySessionId: 'shelly-1',
      shellySessionId: 'terminal-a',
      bindingConfidence: 'reliable',
    }), { addTerminalPane });

    expect(result).toEqual({ status: 'queued', sessionId: 'terminal-a' });
    expect(mockTerminalState.pendingCommand?.command).toContain("codex resume 'codex-jsonl-session'");
  });

  it('does not queue into a starting session that is actually a live Codex PTY', async () => {
    mockTerminalState.sessions = [terminalSession('terminal-a', 'shelly-1', {
      activeCli: null,
      sessionStatus: 'starting',
      isAlive: false,
    })];
    mockIsSessionAlive.mockResolvedValue(true);
    mockGetScreenText.mockResolvedValue('gpt-5.5 default · /data/data/dev.shelly.terminal/files/home\n');
    mockCreateTerminalSessionForFocusedPane.mockReturnValue(undefined);
    const addTerminalPane = jest.fn();

    const result = await resumeCodexSession(codexSession({
      codexSessionId: 'codex-live-during-reattach',
      bindingConfidence: 'none',
    }), { addTerminalPane });

    expect(result).toEqual(expect.objectContaining({ status: 'failed' }));
    expect(mockTerminalState.pendingCommand).toBeNull();
  });

  it('queues codex resume into a visible terminal when new terminal sessions are capped', async () => {
    mockTerminalState.sessions = [
      terminalSession('terminal-a', 'shelly-1'),
      terminalSession('terminal-b', 'shelly-2'),
      terminalSession('terminal-c', 'shelly-3'),
      terminalSession('terminal-d', 'shelly-4'),
    ];
    mockTerminalState.activeSessionId = 'terminal-b';
    mockCreateTerminalSessionForFocusedPane.mockReturnValue(undefined);
    const addTerminalPane = jest.fn();

    const result = await resumeCodexSession(codexSession({
      codexSessionId: 'codex-old-session',
      bindingConfidence: 'none',
    }), { addTerminalPane });

    expect(result).toEqual({ status: 'queued', sessionId: 'terminal-a' });
    expect(addTerminalPane).not.toHaveBeenCalled();
    expect(mockTerminalState.pendingCommand).toEqual({
      command: "cd '/data/data/dev.shelly.terminal/files/home' && codex resume 'codex-old-session'\n",
      sessionId: 'terminal-a',
    });
    expect(mockMultiPaneState.focusedSlot).toBe(0);
  });

  it('does not queue resume into a live terminal that is already inside Codex', async () => {
    mockTerminalState.sessions = [terminalSession('terminal-a', 'shelly-1', { activeCli: 'codex' })];
    mockGetScreenText.mockResolvedValue('gpt-5.5 default · /data/data/dev.shelly.terminal/files/home\n');
    mockCreateTerminalSessionForFocusedPane.mockReturnValue(undefined);
    const addTerminalPane = jest.fn();

    const result = await resumeCodexSession(codexSession(), { addTerminalPane });

    expect(result).toEqual(expect.objectContaining({ status: 'failed' }));
    expect(mockTerminalState.pendingCommand).toBeNull();
  });

  it('queues resume into a newly added terminal pane when none is visible', async () => {
    mockMultiPaneState.preset = 'p2h';
    mockMultiPaneState.slots = [
      { id: 'pane-agent-chat', tab: 'agent-chat' },
      null,
      null,
      null,
    ];
    mockMultiPaneState.focusedSlot = 0;
    const addTerminalPane = jest.fn(() => {
      mockTerminalState.sessions = [
        ...mockTerminalState.sessions,
        terminalSession('terminal-new', 'shelly-2', {
          sessionStatus: 'starting',
          isAlive: false,
        }),
      ];
      mockTerminalState.activeSessionId = 'terminal-new';
      mockMultiPaneState.slots[1] = { id: 'pane-terminal-new', tab: 'terminal', sessionId: 'terminal-new' };
      mockMultiPaneState.focusedSlot = 1;
      return null;
    });

    const result = await resumeCodexSession(codexSession({
      codexSessionId: 'codex-from-agent-pane',
    }), { addTerminalPane });

    expect(result).toEqual({ status: 'queued', sessionId: 'terminal-new' });
    expect(addTerminalPane).toHaveBeenCalledWith('terminal', { silent: true });
    expect(mockTerminalState.pendingCommand).toEqual({
      command: "cd '/data/data/dev.shelly.terminal/files/home' && codex resume 'codex-from-agent-pane'\n",
      sessionId: 'terminal-new',
    });
    expect(mockMultiPaneState.focusedSlot).toBe(1);
  });

  it('keeps a maximized Agent Chat pane from consuming a newly added resume terminal', async () => {
    mockMultiPaneState.preset = 'p2h';
    mockMultiPaneState.slots = [
      { id: 'pane-agent-chat', tab: 'agent-chat' },
      null,
      null,
      null,
    ];
    mockMultiPaneState.focusedSlot = 0;
    mockMultiPaneState.maximizedSlot = 0;
    const addTerminalPane = jest.fn(() => {
      mockTerminalState.sessions = [
        ...mockTerminalState.sessions,
        terminalSession('terminal-new', 'shelly-2', {
          sessionStatus: 'starting',
          isAlive: false,
        }),
      ];
      mockTerminalState.activeSessionId = 'terminal-new';
      mockMultiPaneState.slots[1] = { id: 'pane-terminal-new', tab: 'terminal', sessionId: 'terminal-new' };
      mockMultiPaneState.focusedSlot = 1;
      mockMultiPaneState.maximizedSlot = null;
      return null;
    });

    const result = await resumeCodexSession(codexSession({
      codexSessionId: 'codex-from-maximized-agent-pane',
    }), { addTerminalPane });

    expect(result).toEqual({ status: 'queued', sessionId: 'terminal-new' });
    expect(mockMultiPaneState.slots[0]?.tab).toBe('agent-chat');
    expect(mockMultiPaneState.slots[1]?.sessionId).toBe('terminal-new');
    expect(mockMultiPaneState.setSlotTab).not.toHaveBeenCalled();
    expect(mockMultiPaneState.maximizedSlot).toBeNull();
  });

  it('reports terminal cap when a resume needs a new terminal but none can be created', async () => {
    mockTerminalState.sessions = [];
    mockMultiPaneState.slots = [
      { id: 'pane-agent-chat', tab: 'agent-chat' },
      null,
      null,
      null,
    ];
    const addTerminalPane = jest.fn(() => 'terminal_cap' as const);

    const result = await resumeCodexSession(codexSession({
      codexSessionId: 'codex-needs-terminal',
    }), { addTerminalPane });

    expect(result).toEqual({ status: 'failed', reason: 'terminal_cap' });
    expect(mockTerminalState.pendingCommand).toBeNull();
  });

  it('converts a visible pane instead of focusing a hidden terminal slot', async () => {
    mockTerminalState.sessions = [terminalSession('terminal-hidden', 'shelly-2')];
    mockTerminalState.activeSessionId = 'terminal-hidden';
    mockMultiPaneState.preset = 'p1';
    mockMultiPaneState.slots = [
      { id: 'pane-agent-chat', tab: 'agent-chat' },
      { id: 'pane-hidden-terminal', tab: 'terminal', sessionId: 'terminal-hidden' },
      null,
      null,
    ];
    mockMultiPaneState.focusedSlot = 0;
    mockCreateTerminalSessionForFocusedPane.mockReturnValue(undefined);
    const addTerminalPane = jest.fn();

    const result = await resumeCodexSession(codexSession({
      codexSessionId: 'codex-hidden-slot',
    }), { addTerminalPane });

    expect(result).toEqual({ status: 'queued', sessionId: 'terminal-hidden' });
    expect(mockMultiPaneState.setSlotTab).toHaveBeenCalledWith(0, 'terminal');
    expect(mockMultiPaneState.setSlotSessionId).toHaveBeenCalledWith('pane-agent-chat', 'terminal-hidden');
    expect(mockMultiPaneState.focusedSlot).toBe(0);
    expect(mockSetFocusedPane).toHaveBeenCalledWith('pane-agent-chat');
  });

  it('normalizes Codex rollout JSONL filenames to UUIDs when queueing resume', async () => {
    mockCreateTerminalSessionForFocusedPane.mockReturnValue(undefined);
    const addTerminalPane = jest.fn();

    const result = await resumeCodexSession(codexSession({
      codexSessionId: 'rollout-2026-06-03T11-42-51-019e8b5c-bc3f-7582-88f6-e8a26ba24d66',
    }), { addTerminalPane });

    expect(result).toEqual({ status: 'queued', sessionId: 'terminal-a' });
    expect(mockTerminalState.pendingCommand).toEqual({
      command: "cd '/data/data/dev.shelly.terminal/files/home' && codex resume '019e8b5c-bc3f-7582-88f6-e8a26ba24d66'\n",
      sessionId: 'terminal-a',
    });
  });

  it('respects the maximized pane when choosing where to queue resume', async () => {
    mockTerminalState.sessions = [
      terminalSession('terminal-hidden', 'shelly-2'),
      terminalSession('terminal-max', 'shelly-3'),
    ];
    mockTerminalState.activeSessionId = 'terminal-hidden';
    mockMultiPaneState.preset = 'p2h';
    mockMultiPaneState.slots = [
      { id: 'pane-hidden-terminal', tab: 'terminal', sessionId: 'terminal-hidden' },
      { id: 'pane-max-terminal', tab: 'terminal', sessionId: 'terminal-max' },
      null,
      null,
    ];
    mockMultiPaneState.focusedSlot = 0;
    mockMultiPaneState.maximizedSlot = 1;
    mockCreateTerminalSessionForFocusedPane.mockReturnValue(undefined);
    const addTerminalPane = jest.fn();

    const result = await resumeCodexSession(codexSession({
      codexSessionId: 'codex-maximized',
    }), { addTerminalPane });

    expect(result).toEqual({ status: 'queued', sessionId: 'terminal-max' });
    expect(mockTerminalState.pendingCommand).toEqual(expect.objectContaining({
      sessionId: 'terminal-max',
    }));
    expect(mockMultiPaneState.focusedSlot).toBe(1);
    expect(mockSetFocusedPane).toHaveBeenCalledWith('pane-max-terminal');
  });
});
