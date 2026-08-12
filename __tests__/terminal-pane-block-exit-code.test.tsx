/**
 * __tests__/terminal-pane-block-exit-code.test.tsx
 *
 * Regression coverage for the "successful commands show a ✗ -1 failure
 * badge in Block History" on-device QA finding (Track V follow-up,
 * docs/superpowers/DEFERRED.md).
 *
 * Root cause: modules/terminal-view/.../ShellyTerminalView.kt's
 * onBlockCompleted bridge sends `"exitCode" to (block.exitCode ?: -1)` —
 * Kotlin's BlockDetector legitimately produces a null exitCode whenever a
 * block completes without having observed an OSC 133;D;<code> marker
 * (idle-timeout fallback, or a new prompt arriving before D was parsed),
 * and the bridge collapses that null to a -1 sentinel before it reaches
 * JS. components/panes/TerminalPane.tsx's onBlockCompleted handler used
 * to store that -1 verbatim as the block's real exitCode, which
 * components/terminal/TerminalBlock.tsx then rendered as a literal "✗ -1"
 * failure badge — even for commands (pwd, date, ...) that actually
 * succeeded.
 *
 * Fix: TerminalPane.tsx now exports a pure helper,
 * `resolveNativeBlockExitCode`, that maps the -1 sentinel (and any other
 * negative value — real process exit codes are always 0..255) to
 * `exitCode: null` / `blockStatus: undefined`, matching this codebase's
 * existing "not yet determined" convention (see terminal-store.ts's
 * initial `exitCode: null` in runCommand(), and the identical
 * `b.exitCode === 0 ? 'done' : b.exitCode !== null ? 'error' : undefined`
 * derivation in that store's saveSessionState()). TerminalBlock.tsx
 * already treats `exitCode === null` as "unknown" (no ✓/✗ badge), so this
 * suppresses the misleading failure indicator instead of guessing.
 *
 * TerminalPane.tsx is a large screen component wired directly to several
 * custom native modules (NativeTerminalView / TerminalViewModule /
 * TerminalEmulatorModule) that call expo-modules-core's
 * requireNativeViewManager/requireNativeModule at import time — those
 * throw under Jest with no native module registered, so this file mocks
 * the same import surface the existing
 * terminal-store-block-session-routing.test.tsx mocks for terminal-store,
 * plus TerminalPane's own additional native/UI dependencies, purely so
 * the module can be imported to reach the pure exported helper. None of
 * the mocks need real behavior — this test never renders <TerminalScreen/>.
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

jest.mock('@/hooks/use-native-exec', () => ({
  execCommand: jest.fn(async () => ({ exitCode: 0, stdout: '', stderr: '' })),
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

jest.mock('@/lib/agent-manager', () => ({
  parseAgentCommand: jest.fn(),
  createAgent: jest.fn(),
  installAgent: jest.fn(),
  runAgentNow: jest.fn(),
  stopAgent: jest.fn(),
}));

jest.mock('@/lib/agent-tool-router', () => ({
  suggestTool: jest.fn(),
}));

jest.mock('@/lib/first-launch-setup', () => ({
  runFirstLaunchSetup: jest.fn(),
}));

jest.mock('@/hooks/use-panel-background', () => ({
  usePaneContentBackground: () => '#000000',
}));

import { resolveNativeBlockExitCode } from '@/components/panes/TerminalPane';

describe('resolveNativeBlockExitCode', () => {
  it('treats the native -1 "no exit code observed" sentinel as unknown, not a failure', () => {
    // This is the exact regression: ShellyTerminalView.kt sends -1 for a
    // block that completed without an OSC 133;D marker (e.g. a successful
    // `pwd` whose D sequence raced a new prompt). Must NOT render as ✗ -1.
    expect(resolveNativeBlockExitCode(-1)).toEqual({ exitCode: null, blockStatus: undefined });
  });

  it('passes through a genuine successful exit code (0) as done', () => {
    expect(resolveNativeBlockExitCode(0)).toEqual({ exitCode: 0, blockStatus: 'done' });
  });

  it('passes through a genuine failing exit code as error', () => {
    expect(resolveNativeBlockExitCode(1)).toEqual({ exitCode: 1, blockStatus: 'error' });
    expect(resolveNativeBlockExitCode(127)).toEqual({ exitCode: 127, blockStatus: 'error' });
  });

  it('treats a SIGKILL-range exit code (128+signal, e.g. 137) as a real failure, not unknown', () => {
    // Real process exit codes span 0..255, including the 128+signal
    // convention — only strictly negative values are the native sentinel.
    expect(resolveNativeBlockExitCode(137)).toEqual({ exitCode: 137, blockStatus: 'error' });
  });

  it('treats any other negative value defensively as unknown as well', () => {
    expect(resolveNativeBlockExitCode(-2)).toEqual({ exitCode: null, blockStatus: undefined });
  });
});
