// store/ai-pane-store.ts imports @react-native-async-storage/async-storage —
// mocked exactly like __tests__/ai-pane-pending-session.test.ts does so this
// file can run in the plain "unit" ts-jest project without an RN transform.
const mockAsyncStorageValues = new Map<string, string>();
jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: {
    getItem: jest.fn((key: string) => Promise.resolve(mockAsyncStorageValues.get(key) ?? null)),
    setItem: jest.fn((key: string, value: string) => {
      mockAsyncStorageValues.set(key, value);
      return Promise.resolve();
    }),
  },
}));

import { useAIPaneStore, EXTERNAL_PROMPT_STALE_MS } from '@/store/ai-pane-store';

// Widget ASK → `@agent …` handoff (2026-07-29): the deep-link handler in
// app/_layout.tsx queues the widget-typed command here, and the first mounted
// AIPane claims it via takePendingExternalPrompt() and feeds it through the
// SAME dispatch() a typed submission uses. These tests pin the handoff slot's
// contract: trimmed non-empty set, atomic single claim, staleness expiry
// (mirroring the native ScouterStateStore 2-minute window), and no
// persistence (a killed app must not replay a half-delivered registration
// seed on restart).
describe('ai-pane-store — pendingExternalPrompt (widget ASK → @agent handoff)', () => {
  beforeEach(() => {
    mockAsyncStorageValues.clear();
    useAIPaneStore.setState({ conversations: {}, isLoaded: true, pendingExternalPrompt: null });
    jest.useRealTimers();
  });

  it('starts with no pending external prompt', () => {
    expect(useAIPaneStore.getState().pendingExternalPrompt).toBeNull();
    expect(useAIPaneStore.getState().takePendingExternalPrompt()).toBeNull();
  });

  it('setPendingExternalPrompt stores trimmed text with a timestamp', () => {
    const before = Date.now();
    useAIPaneStore.getState().setPendingExternalPrompt('  @agent 毎朝7時にニュースをまとめて  ');
    const pending = useAIPaneStore.getState().pendingExternalPrompt;
    expect(pending?.text).toBe('@agent 毎朝7時にニュースをまとめて');
    expect(pending?.createdAt).toBeGreaterThanOrEqual(before);
  });

  it('ignores blank/whitespace-only text', () => {
    useAIPaneStore.getState().setPendingExternalPrompt('   ');
    expect(useAIPaneStore.getState().pendingExternalPrompt).toBeNull();
  });

  it('takePendingExternalPrompt claims exactly once (second taker gets null)', () => {
    useAIPaneStore.getState().setPendingExternalPrompt('@agent list');
    const first = useAIPaneStore.getState().takePendingExternalPrompt();
    const second = useAIPaneStore.getState().takePendingExternalPrompt();
    expect(first?.text).toBe('@agent list');
    expect(second).toBeNull();
    expect(useAIPaneStore.getState().pendingExternalPrompt).toBeNull();
  });

  it('drops (and still clears) a stale entry older than the native 2-minute window', () => {
    useAIPaneStore.setState({
      pendingExternalPrompt: {
        text: '@agent 毎朝要約して',
        createdAt: Date.now() - EXTERNAL_PROMPT_STALE_MS - 1_000,
      },
    });
    expect(useAIPaneStore.getState().takePendingExternalPrompt()).toBeNull();
    // Expired entries are cleared, never redelivered on a later take.
    expect(useAIPaneStore.getState().pendingExternalPrompt).toBeNull();
  });

  it('a fresh entry just inside the window is still delivered', () => {
    useAIPaneStore.setState({
      pendingExternalPrompt: {
        text: '@agent status',
        createdAt: Date.now() - EXTERNAL_PROMPT_STALE_MS + 5_000,
      },
    });
    expect(useAIPaneStore.getState().takePendingExternalPrompt()?.text).toBe('@agent status');
  });

  it('is never persisted: the AsyncStorage snapshot only contains conversations', async () => {
    useAIPaneStore.getState().setPendingExternalPrompt('@agent secret errand');
    // Force a persist through the public API (addMessage schedules the
    // debounced save; run it out).
    jest.useFakeTimers();
    useAIPaneStore.getState().addMessage('pane-x', {
      id: 'm1',
      role: 'user',
      content: 'hello',
      timestamp: Date.now(),
    } as never);
    jest.runOnlyPendingTimers();
    // flush the async persist
    jest.useRealTimers();
    await Promise.resolve();
    await Promise.resolve();
    const persisted = [...mockAsyncStorageValues.values()].join('\n');
    expect(persisted).not.toContain('pendingExternalPrompt');
    expect(persisted).not.toContain('secret errand');
  });
});
