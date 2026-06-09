const mockTerminalState = {
  sessions: [] as any[],
  activeSessionId: 'session-1',
};
const mockGetRecentOutput = jest.fn(() => '');

jest.mock('@/store/terminal-store', () => ({
  useTerminalStore: {
    getState: () => mockTerminalState,
  },
}));

jest.mock('@/store/execution-log-store', () => ({
  useExecutionLogStore: {
    getState: () => ({
      getRecentOutput: mockGetRecentOutput,
    }),
  },
}));

import {
  buildLocalAIPaneSystemPrompt,
  buildAIPaneSystemPrompt,
  compactTerminalContextForLocalLlm,
  getTerminalSnapshotForSession,
  sanitizeTerminalContext,
} from '@/lib/ai-pane-context';

beforeEach(() => {
  mockTerminalState.sessions = [];
  mockTerminalState.activeSessionId = 'session-1';
  mockGetRecentOutput.mockReset();
  mockGetRecentOutput.mockReturnValue('');
});

describe('AI pane terminal context', () => {
  it('preserves Codex version/status lines for local LLM prompts', () => {
    const lines = [
      '>_ OpenAI Codex (v0.135.0)',
      'model: gpt-5.5 /model to change',
      'directory: /data/data/dev.shelly.terminal/files/home',
      ...Array.from({ length: 90 }, (_, i) => `scrollback filler ${i + 1}`),
      '> Summarize recent commits',
      'gpt-5.5 default · /data/data/dev.shelly.terminal/files/home',
    ];

    const compacted = compactTerminalContextForLocalLlm(lines.join('\n'), 900);

    expect(compacted).toContain('OpenAI Codex (v0.135.0)');
    expect(compacted).toContain('model: gpt-5.5');
    expect(compacted).toContain('Summarize recent commits');
  });

  it('strips ANSI and cursor controls from terminal snapshots', () => {
    const raw = '\x1b[32mOpenAI Codex\x1b[0m\r\n\x1b[2Kcodex-cli 0.135.0';

    expect(sanitizeTerminalContext(raw)).toBe('OpenAI Codex\ncodex-cli 0.135.0');
  });

  it('strips OSC metadata and renders carriage-return line redraws', () => {
    const raw = '\x1b]0;invisible title\x07old status\r\x1b[Knew status';

    expect(sanitizeTerminalContext(raw)).toBe('new status');
  });

  it('reads full recent output instead of error-neighborhood snippets', () => {
    mockTerminalState.sessions = [
      { id: 'session-1', nativeSessionId: 'shelly-1', blocks: [] },
      { id: 'session-2', nativeSessionId: 'shelly-2', blocks: [] },
    ];
    mockGetRecentOutput.mockReturnValue('Error: old\nOpenAI Codex (v0.135.0)\nmodel: gpt-5.5');

    expect(getTerminalSnapshotForSession('session-2')).toContain('OpenAI Codex');
    expect(mockGetRecentOutput).toHaveBeenCalledWith(80, 0, 'shelly-2');
  });

  it('tells providers to answer from injected terminal output', () => {
    const prompt = buildAIPaneSystemPrompt('codex-cli 0.135.0', 'local', null);

    expect(prompt).toContain('[Terminal Output]');
    expect(prompt).toContain('the left terminal');
    expect(prompt).toContain('Do not say you cannot see the terminal');
    expect(prompt).toContain('untrusted data');
  });

  it('keeps terminal-aware instructions in the short local LLM prompt', () => {
    const prompt = buildLocalAIPaneSystemPrompt('codex-cli 0.135.0');

    expect(prompt).toContain('[Terminal Output]');
    expect(prompt).toContain('the left terminal');
    expect(prompt).toContain('Do not say you cannot see the terminal');
    expect(prompt).toContain('untrusted data');
  });
});
