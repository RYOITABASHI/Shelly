/**
 * PR 6: the RN bridge's drain loop writes .shelly-mcp-queue/bridge-heartbeat
 * (epoch ms) every cycle; the native typed-op consumer hands a no-match
 * run_agent to RN only while it is fresh. Stopping the poller writes 0.
 * Dummy values only.
 */
jest.mock('expo-file-system/legacy', () => require('./helpers/mcp-typed-ops-harness').fsMock);
jest.mock('@/modules/terminal-emulator/src/TerminalEmulatorModule', () => require('./helpers/mcp-typed-ops-harness').nativeMock);
jest.mock('@/store/agent-store', () => require('./helpers/mcp-typed-ops-harness').agentStoreMock);
jest.mock('@/store/settings-store', () => require('./helpers/mcp-typed-ops-harness').settingsStoreMock);
jest.mock('@/store/sidebar-store', () => ({ useSidebarStore: { getState: () => ({ repoPaths: [] }), subscribe: () => () => {} } }));
jest.mock('@/store/terminal-store', () => ({ useTerminalStore: { getState: () => ({ sessions: [], activeSessionId: null }) } }));
jest.mock('@/lib/agent-user-policy-store', () => require('./helpers/mcp-typed-ops-harness').policyStoreMock);
jest.mock('@/lib/debug-logger', () => require('./helpers/mcp-typed-ops-harness').loggerMock);
jest.mock('@/lib/secure-store', () => ({ getConnectorSecret: async () => 'dummy-token' }));
jest.mock('@/hooks/use-native-exec', () => ({ execCommand: jest.fn(async () => ({ stdout: '', stderr: '', exitCode: 0 })) }));
jest.mock('react-native', () => require('./helpers/mcp-typed-ops-harness').reactNativeMock);
jest.mock('@/lib/i18n', () => ({ t: (k: string) => k, tFor: (_l: string, k: string) => k }));

import { BRIDGE_HEARTBEAT_FILE, startMCPPoller, stopMCPPoller } from '@/lib/mcp-server-bridge';
import { h, QUEUE, resetHarness, waitFor } from './helpers/mcp-typed-ops-harness';

jest.setTimeout(15_000);

beforeEach(() => resetHarness());
afterEach(() => stopMCPPoller());

describe('bridge heartbeat', () => {
  it('lives at .shelly-mcp-queue/bridge-heartbeat', () => {
    expect(BRIDGE_HEARTBEAT_FILE).toBe(`${QUEUE}/bridge-heartbeat`);
  });

  it('each drain cycle writes the current time, and it keeps advancing', async () => {
    const before = Date.now();
    startMCPPoller();
    await waitFor(() => h.files.has(BRIDGE_HEARTBEAT_FILE));
    const first = Number(h.files.get(BRIDGE_HEARTBEAT_FILE));
    expect(String(first)).toMatch(/^\d+$/);
    expect(first).toBeGreaterThanOrEqual(before);
    await waitFor(() => Number(h.files.get(BRIDGE_HEARTBEAT_FILE)) > first);
    expect(Date.now() - Number(h.files.get(BRIDGE_HEARTBEAT_FILE))).toBeLessThan(2000);
  });

  it('is written even when no request is queued, and stopping writes 0', async () => {
    startMCPPoller();
    await waitFor(() => h.files.has(BRIDGE_HEARTBEAT_FILE));
    stopMCPPoller();
    await waitFor(() => h.files.get(BRIDGE_HEARTBEAT_FILE) === '0');
  });
});

describe('bridge heartbeat is foreground-only (PR 6, Codex review)', () => {
  it('writes 0 while Shelly is not in the foreground', async () => {
    h.appState.currentState = 'background';
    startMCPPoller();
    await waitFor(() => h.files.get(BRIDGE_HEARTBEAT_FILE) === '0');
    h.appState.currentState = 'active';
    await waitFor(() => Number(h.files.get(BRIDGE_HEARTBEAT_FILE)) > 0);
  });
});
