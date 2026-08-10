/**
 * __tests__/terminal-store-block-session-routing.test.tsx
 *
 * Regression coverage for the "Block History overlay always empty" bug
 * found in on-device QA after the FAB was restored. Root cause:
 * `addEntryBlock` (store/terminal-store.ts) routed every new block to
 * whichever session had `id === get().activeSessionId` — the GLOBAL
 * "last focused" session — while `CommandBlock.sessionId` (the field the
 * caller, TerminalPane.tsx's `onBlockCompleted`, actually stamps on the
 * block) was written but never consulted. `components/terminal/BlockList.tsx`
 * is fed `activeSession.entries`, where `activeSession` is resolved
 * PER-PANE (bound via `useMultiPaneStore`'s slot.sessionId when set, else
 * falling back to the global active session — see TerminalPane.tsx's
 * `activeSessionRecordId`). Whenever a pane's own bound session differs
 * from the store's global `activeSessionId` (e.g. right after a cold
 * start where terminal-store's persisted activeSessionId and
 * multi-pane-store's persisted per-slot sessionId hydrate independently,
 * or after PaneCliTabs rebinds a pane's session without touching the
 * global active session by design), every completed command block was
 * silently appended to the wrong, invisible session — the overlay only
 * ever showed the always-present WelcomeBanner header.
 *
 * Fix: `addEntryBlock` now honors `block.sessionId` (falling back to the
 * global `activeSessionId` only when the block doesn't name a real
 * session), and TerminalPane.tsx's onBlockCompleted call sites stamp
 * `activeSessionRecordId` (this pane's own resolved session — the exact
 * same value BlockList's `activeSession` resolves to) instead of the
 * global `activeSessionId`.
 *
 * This file exercises the real store directly (not a re-implementation)
 * so a regression in the routing logic itself would be caught.
 */

jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);

// Same rationale as __tests__/ai-pane-dispatch-interaction-order.test.tsx:
// the real TerminalEmulatorModule's bottom-of-file `requireNativeModule`
// throws under Jest (no native module registered). terminal-store.ts only
// reaches it transitively (via hooks/use-native-exec.ts and
// lib/pseudo-shell.ts) — addEntryBlock itself never calls it.
jest.mock('@/modules/terminal-emulator/src/TerminalEmulatorModule', () => ({
  __esModule: true,
  default: {
    getHomeDir: jest.fn(async () => '/data/user/0/dev.shelly.terminal/files/home'),
    execCommand: jest.fn(async () => ({ exitCode: 0, stdout: '', stderr: '' })),
  },
}));

jest.mock('@/hooks/use-native-exec', () => ({
  execCommand: jest.fn(async () => ({ exitCode: 0, stdout: '', stderr: '' })),
}));

// Wholesale mock — addEntryBlock never touches the pseudo-shell / workflow /
// skill-import subsystem; only runCommand()'s `shelly ...` routing does, and
// no test below calls runCommand. Mocked to keep the import graph light.
jest.mock('@/lib/pseudo-shell', () => ({
  executeCommand: jest.fn(async () => ({ lines: [], newState: { cwd: '/', env: {}, history: [] } })),
}));

jest.mock('@/lib/user-profile', () => ({
  learnFromCommand: jest.fn(async () => {}),
}));

// terminal-store.ts -> store/settings-store.ts -> lib/secure-store.ts ->
// expo-secure-store -> expo-modules-core -> nativewind/jsx-runtime, which
// fails to resolve `react-native-css-interop/jsx-runtime` in this
// environment (pre-existing hoisted-node_modules gap, unrelated to this
// fix). addEntryBlock never touches API-key storage, so this I/O boundary
// is mocked wholesale rather than worked around.
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

import { useTerminalStore } from '@/store/terminal-store';
import type { CommandBlock } from '@/store/types';

function makeBlock(overrides: Partial<CommandBlock> & { id: string; sessionId: string }): CommandBlock {
  return {
    command: 'echo hi',
    output: [{ text: 'hi', type: 'stdout' }],
    timestamp: Date.now(),
    exitCode: 0,
    isRunning: false,
    blockStatus: 'done',
    connectionMode: 'native',
    ...overrides,
  };
}

describe('addEntryBlock — pane/session routing', () => {
  beforeEach(() => {
    // Reset to two known sessions with no entries, mirroring a two-pane
    // multi-pane setup where the globally "active" session (last focused
    // pane) is NOT the session this test's target pane is bound to.
    useTerminalStore.setState((state) => ({
      sessions: [
        { ...state.sessions[0], id: 'session-A', entries: [], blocks: [] },
        { ...state.sessions[0], id: 'session-B', entries: [], blocks: [] },
      ],
      activeSessionId: 'session-A', // globally-focused pane's session
    }));
  });

  it('appends the block to block.sessionId, not the global activeSessionId, when they differ', () => {
    // Simulate TerminalPane's onBlockCompleted firing for a pane bound to
    // session-B while some OTHER pane (session-A) is the global active one
    // — the exact scenario that used to leave Block History empty.
    useTerminalStore.getState().addEntryBlock(
      makeBlock({ id: 'block-1', sessionId: 'session-B' }),
    );

    const state = useTerminalStore.getState();
    const sessionA = state.sessions.find((s) => s.id === 'session-A')!;
    const sessionB = state.sessions.find((s) => s.id === 'session-B')!;

    // This is what components/terminal/BlockList.tsx actually renders for
    // the session-B pane (`activeSession.entries`) — it must contain the
    // block.
    expect(sessionB.entries).toHaveLength(1);
    expect(sessionB.entries[0].id).toBe('block-1');
    // And it must NOT have leaked into the globally-active-but-different
    // pane's session.
    expect(sessionA.entries).toHaveLength(0);
  });

  it('still lands on the correct session when block.sessionId matches the global activeSessionId', () => {
    useTerminalStore.getState().addEntryBlock(
      makeBlock({ id: 'block-2', sessionId: 'session-A' }),
    );

    const state = useTerminalStore.getState();
    expect(state.sessions.find((s) => s.id === 'session-A')!.entries).toHaveLength(1);
    expect(state.sessions.find((s) => s.id === 'session-B')!.entries).toHaveLength(0);
  });

  it('falls back to the global activeSessionId when block.sessionId is empty or unknown (legacy callers)', () => {
    useTerminalStore.getState().addEntryBlock(
      makeBlock({ id: 'block-3', sessionId: '' }),
    );
    useTerminalStore.getState().addEntryBlock(
      makeBlock({ id: 'block-4', sessionId: 'session-does-not-exist' }),
    );

    const state = useTerminalStore.getState();
    const sessionA = state.sessions.find((s) => s.id === 'session-A')!;
    expect(sessionA.entries.map((e) => e.id)).toEqual(['block-3', 'block-4']);
  });
});
