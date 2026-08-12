/**
 * __tests__/terminal-pane-agent-mention-confirm.test.ts
 *
 * Regression coverage for the on-device QA finding: typing
 * `@agent when I get a notification from Gmail, notify me with a summary`
 * directly into the terminal pane materialized a brand-new agent
 * IMMEDIATELY, with zero confirmation — a direct violation of the
 * 2026-07-24 standing policy that every `@agent <NL>` registration must go
 * through a confirm card / chat confirm (see hooks/use-ai-pane-dispatch.ts's
 * dispatch(), whose own comment says "EVERY `@agent <NL>` goes through the
 * confirm card... Nothing is created/run until the human taps Confirm").
 * The old terminal path also derived the agent's name by truncating the
 * raw utterance to its first whitespace-delimited word (e.g. "when"),
 * instead of the real parseAgentNL-derived name.
 *
 * Root cause: components/panes/TerminalPane.tsx's onBlockCompleted handler
 * (bug #59 `@mention` intercept) called `createAgent()` + `installAgent()`
 * directly for `parseAgentCommand()`'s 'create' result, entirely bypassing
 * the AI Pane's confirm-card/chat-confirm flow that every other @agent
 * registration surface (AI-Pane-typed input, the 2026-07-29 widget ASK
 * handoff) goes through.
 *
 * Fix: the 'create' branch no longer calls createAgent/installAgent at all.
 * It hands the raw `@agent ...` text off to a mounted AI Pane via the SAME
 * mechanism the widget ASK handoff uses — lib/pane-focus.ts's
 * focusPaneByTab('ai') to make an AI pane visible, then
 * useAIPaneStore.getState().setPendingExternalPrompt(rawCommand) (with NO
 * 'source' tag, so the widget's OFF-by-default no-confirm opt-in can never
 * apply) so the AIPane component's claim effect runs the text through its
 * normal dispatch() → parseAgentCommand → parseAgentNL → confirm-card/chat-
 * confirm → confirmAgentDraft → installAgent chain, identical to typing the
 * same text directly into the AI pane. 'run'/'stop' subcommands are
 * unaffected — they act on an already-registered agent and require no
 * confirmation in the AI pane's own dispatch() either.
 *
 * This file mocks the same native/UI import surface
 * __tests__/terminal-pane-block-exit-code.test.tsx already established
 * (TerminalPane.tsx pulls in several native modules that throw under Jest
 * with no native module registered) purely so the module can be imported
 * to reach the exported `resolveTerminalAgentMention` helper. None of the
 * mocks need real behavior — this test never renders <TerminalScreen/>.
 */

jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);

jest.mock('@/modules/terminal-emulator/src/TerminalEmulatorModule', () => ({
  __esModule: true,
  default: {
    getHomeDir: jest.fn(async () => '/data/user/0/dev.shelly.terminal/files/home'),
    execCommand: jest.fn(async () => ({ exitCode: 0, stdout: '', stderr: '' })),
    addListener: jest.fn(() => ({ remove: jest.fn() })),
    createSession: jest.fn(async () => ({ resumed: false })),
    destroySession: jest.fn(async () => {}),
    isSessionAlive: jest.fn(async () => false),
    startSessionService: jest.fn(async () => {}),
    writeToEmulator: jest.fn(async () => {}),
    isIgnoringBatteryOptimizations: jest.fn(async () => true),
    requestBatteryOptimizationExemption: jest.fn(async () => {}),
    pasteToSession: jest.fn(async () => {}),
    writeToSession: jest.fn(async () => {}),
  },
}));

jest.mock('@/modules/terminal-view/src', () => ({
  __esModule: true,
  NativeTerminalView: 'NativeTerminalView',
}));

jest.mock('@/modules/terminal-view/src/TerminalViewModule', () => ({
  __esModule: true,
  default: {
    focus: jest.fn(async () => {}),
    scrollToBottom: jest.fn(async () => {}),
    refreshScreen: jest.fn(async () => {}),
  },
}));

const mockExecCommand = jest.fn(async (..._args: unknown[]) => ({ exitCode: 0, stdout: '', stderr: '' }));
jest.mock('@/hooks/use-native-exec', () => ({
  execCommand: (...args: unknown[]) => mockExecCommand(...args),
}));

jest.mock('@/lib/pseudo-shell', () => ({
  executeCommand: jest.fn(async () => ({ lines: [], newState: { cwd: '/', env: {}, history: [] } })),
}));

jest.mock('@/lib/user-profile', () => ({
  learnFromCommand: jest.fn(async () => {}),
}));

jest.mock('@/lib/secure-store', () => ({
  saveApiKey: jest.fn(async () => {}),
  loadApiKeys: jest.fn(async () => ({})),
  isApiKeyField: jest.fn(() => false),
  stripApiKeys: jest.fn((settings: unknown) => settings),
  deleteLegacySecrets: jest.fn(async () => {}),
  saveConnectorSecret: jest.fn(async () => {}),
  deleteAllConnectorSecrets: jest.fn(async () => {}),
}));

jest.mock('@/lib/sounds', () => ({
  useSoundStore: { getState: () => ({ profile: 'silent' }) },
  playSound: jest.fn(),
}));

jest.mock('expo-file-system/legacy', () => ({}));

jest.mock('@expo/vector-icons/MaterialIcons', () => 'MaterialIcons');

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

jest.mock('@/hooks/use-terminal-output', () => ({
  useTerminalOutput: jest.fn(),
}));

jest.mock('@/hooks/use-theme', () => ({
  useTheme: () => ({ colors: {} }),
}));

jest.mock('@/lib/i18n', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

jest.mock('@/hooks/use-device-layout', () => ({
  useDeviceLayout: () => ({ isWide: false, isCompact: false, isStandard: true }),
}));

jest.mock('@/hooks/use-multi-pane', () => ({
  useMultiPaneStore: Object.assign(
    (selector: (s: any) => any) => selector({ slots: [], isMultiPane: false }),
    { getState: () => ({ slots: [], isMultiPane: false }) },
  ),
}));

jest.mock('@/components/multi-pane/PaneSlot', () => ({
  MultiPaneContext: { Provider: 'MultiPaneContext.Provider' },
  PaneIdContext: { Provider: 'PaneIdContext.Provider' },
}));

jest.mock('@/store/focus-store', () => ({
  useFocusStore: Object.assign(
    (selector: (s: any) => any) => selector({ refocusTick: 0, requestTerminalRefocus: jest.fn() }),
    { getState: () => ({ refocusTick: 0, requestTerminalRefocus: jest.fn() }) },
  ),
}));

jest.mock('@/store/pane-store', () => ({
  usePaneStore: Object.assign(
    (selector: (s: any) => any) => selector({ focusedPaneId: null, setFocusedPane: jest.fn() }),
    { getState: () => ({ focusedPaneId: null, setFocusedPane: jest.fn() }) },
  ),
}));

jest.mock('@/components/terminal/CommandKeyBar', () => ({
  CommandKeyBar: 'CommandKeyBar',
}));

jest.mock('@/hooks/use-ai-pane-dispatch', () => ({
  useAIPaneDispatch: () => ({}),
}));

jest.mock('@/components/VoiceChat', () => ({
  VoiceChat: 'VoiceChat',
}));

jest.mock('@/components/terminal/PreviewBanner', () => ({
  PreviewBanner: 'PreviewBanner',
}));

jest.mock('@/components/preview/PreviewTabs', () => ({
  PreviewTabs: 'PreviewTabs',
}));

jest.mock('@/store/preview-store', () => ({
  usePreviewStore: Object.assign(
    (selector: (s: any) => any) =>
      selector({ isOpen: false, bannerVisible: false, bannerUrl: '', splitRatio: 0.5 }),
    {
      getState: () => ({
        isOpen: false,
        bannerVisible: false,
        bannerUrl: '',
        splitRatio: 0.5,
        openPreview: jest.fn(),
        closePreview: jest.fn(),
        dismissBanner: jest.fn(),
      }),
    },
  ),
}));

jest.mock('@/components/terminal/ProcessGuardModal', () => ({
  ProcessGuardModal: 'ProcessGuardModal',
}));

jest.mock('@/components/terminal/FirstMateOverlay', () => ({
  FirstMateOverlay: 'FirstMateOverlay',
}));

jest.mock('@/lib/process-guard', () => ({
  isProcessKill: jest.fn(() => false),
}));

jest.mock('@/lib/terminal-theme', () => ({
  getTerminalTheme: jest.fn(() => ({
    red: '#f00', green: '#0f0', yellow: '#ff0', blue: '#00f',
    magenta: '#f0f', cyan: '#0ff', white: '#fff', brightBlack: '#888',
    brightRed: '#f88', brightGreen: '#8f8', brightYellow: '#ff8',
    brightBlue: '#88f', brightMagenta: '#f8f', brightCyan: '#8ff',
    brightWhite: '#fff', foreground: '#fff', cursor: '#fff',
  })),
}));

jest.mock('@/components/terminal/BlockList', () => ({
  BlockList: 'BlockList',
}));

jest.mock('@/lib/input-router', () => ({
  parseInput: jest.fn((cmd: string) => ({ layer: 'shell', raw: cmd })),
}));

const mockParseAgentCommand = jest.fn();
const mockCreateAgent = jest.fn();
const mockInstallAgent = jest.fn();
const mockRunAgentNow = jest.fn(async (..._args: unknown[]) => {});
const mockStopAgent = jest.fn(async (..._args: unknown[]) => {});
jest.mock('@/lib/agent-manager', () => ({
  parseAgentCommand: (...args: unknown[]) => mockParseAgentCommand(...args),
  createAgent: (...args: unknown[]) => mockCreateAgent(...args),
  installAgent: (...args: unknown[]) => mockInstallAgent(...args),
  runAgentNow: (...args: unknown[]) => mockRunAgentNow(...args),
  stopAgent: (...args: unknown[]) => mockStopAgent(...args),
}));

jest.mock('@/lib/agent-tool-router', () => ({
  suggestTool: jest.fn(),
}));

jest.mock('@/lib/first-launch-setup', () => ({
  runFirstLaunchSetup: jest.fn(),
}));

const mockFocusPaneByTab = jest.fn((..._args: unknown[]) => true);
jest.mock('@/lib/pane-focus', () => ({
  focusPaneByTab: (...args: unknown[]) => mockFocusPaneByTab(...args),
}));

const mockSetPendingExternalPrompt = jest.fn();
jest.mock('@/store/ai-pane-store', () => ({
  useAIPaneStore: {
    getState: () => ({ setPendingExternalPrompt: (...args: unknown[]) => mockSetPendingExternalPrompt(...args) }),
  },
}));

jest.mock('@/hooks/use-panel-background', () => ({
  usePaneContentBackground: () => '#000000',
}));

import { resolveTerminalAgentMention } from '@/components/panes/TerminalPane';

describe('resolveTerminalAgentMention — terminal @agent registration confirmation', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockFocusPaneByTab.mockReturnValue(true);
  });

  it('does NOT create or install an agent when the parsed command is a registration ("create")', async () => {
    const rawUtterance = 'when I get a notification from Gmail, notify me with a summary';
    mockParseAgentCommand.mockReturnValue({
      type: 'create',
      message: rawUtterance,
      data: { suggestion: { tool: { type: 'auto' }, label: 'Auto' } },
    });

    await resolveTerminalAgentMention(rawUtterance, `@agent ${rawUtterance}`);

    // The exact regression: this used to call createAgent + installAgent
    // synchronously, right here, with no human confirmation anywhere.
    expect(mockCreateAgent).not.toHaveBeenCalled();
    expect(mockInstallAgent).not.toHaveBeenCalled();
  });

  it('hands the raw command off to the AI pane confirm flow instead of registering directly', async () => {
    const rawUtterance = 'when I get a notification from Gmail, notify me with a summary';
    const rawCommand = `@agent ${rawUtterance}`;
    mockParseAgentCommand.mockReturnValue({ type: 'create', message: rawUtterance });

    const result = await resolveTerminalAgentMention(rawUtterance, rawCommand);

    expect(mockFocusPaneByTab).toHaveBeenCalledWith('ai');
    expect(mockSetPendingExternalPrompt).toHaveBeenCalledWith(rawCommand);
    // Confirmation policy guard: passing 'widget-ask' as the second arg
    // would let the OFF-by-default widget no-confirm opt-in apply here.
    // A terminal-typed @agent must always confirm — verify no such tag
    // is ever passed.
    const call = mockSetPendingExternalPrompt.mock.calls[0];
    expect(call).toHaveLength(1);
    expect(result).toMatch(/confirm/i);
    expect(result).not.toMatch(/installed/i);
  });

  it('surfaces a distinct error when no AI pane could be opened, but still hands off if a pane already existed', async () => {
    mockParseAgentCommand.mockReturnValue({ type: 'create', message: 'do a thing' });
    mockFocusPaneByTab.mockReturnValue(false);

    const result = await resolveTerminalAgentMention('do a thing', '@agent do a thing');

    expect(result).toMatch(/could not open the ai pane/i);
    expect(mockCreateAgent).not.toHaveBeenCalled();
    expect(mockInstallAgent).not.toHaveBeenCalled();
  });

  it('still runs an already-registered agent immediately for "run" (no confirmation needed)', async () => {
    mockParseAgentCommand.mockReturnValue({
      type: 'run',
      message: 'Running my-agent...',
      data: { agentId: 'agent-abc' },
    });

    const result = await resolveTerminalAgentMention('run my-agent', '@agent run my-agent');

    expect(mockRunAgentNow).toHaveBeenCalledWith('agent-abc', expect.any(Function));
    expect(mockFocusPaneByTab).not.toHaveBeenCalled();
    expect(mockSetPendingExternalPrompt).not.toHaveBeenCalled();
    expect(result).toBe('Running my-agent...');
  });

  it('still stops an already-registered agent immediately for "stop" (no confirmation needed)', async () => {
    mockParseAgentCommand.mockReturnValue({
      type: 'stop',
      message: 'Stopping my-agent...',
      data: { agentId: 'agent-abc' },
    });

    const result = await resolveTerminalAgentMention('stop my-agent', '@agent stop my-agent');

    expect(mockStopAgent).toHaveBeenCalledWith('agent-abc', expect.any(Function));
    expect(mockFocusPaneByTab).not.toHaveBeenCalled();
    expect(result).toBe('Stopping my-agent...');
  });

  it('passes through informational results (list/status/error) unchanged', async () => {
    mockParseAgentCommand.mockReturnValue({ type: 'list', message: 'No agents configured.' });
    const result = await resolveTerminalAgentMention('list', '@agent list');
    expect(result).toBe('No agents configured.');
    expect(mockFocusPaneByTab).not.toHaveBeenCalled();
  });
});
