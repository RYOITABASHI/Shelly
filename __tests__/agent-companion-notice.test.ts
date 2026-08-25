import {
  AgentRunLogNoticeTracker,
  agentRunLogIdentity,
  postAgentCompanionNotice,
  postAgentRunStartedNotice,
  postCompanionJournalDormancyNotice,
  postLatestAgentRunToCompanion,
} from '@/lib/agent-companion-notice';
import { COMPANION_CONVERSATION_KEY, useAIPaneStore } from '@/store/ai-pane-store';
import { useAgentStore } from '@/store/agent-store';
import type { AgentRunLog } from '@/store/types';
import * as fs from 'fs';
import * as path from 'path';

jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);

function runLog(agentId: string, timestamp: number, status: AgentRunLog['status'], outputPreview = ''): AgentRunLog {
  return { agentId, timestamp, status, outputPreview, durationMs: 10, toolUsed: 'test' };
}

beforeEach(() => {
  jest.clearAllMocks();
  useAIPaneStore.setState({ conversations: {}, isLoaded: true });
  useAgentStore.setState({ agents: [], runHistory: {} });
});

describe('attended Sidebar run completion', () => {
  it('posts a distinct starting notice before the Sidebar runAgentNow call', () => {
    postAgentRunStartedNotice('agent-a', 'Morning Brief');

    const messages = useAIPaneStore.getState().conversations[COMPANION_CONVERSATION_KEY].messages;
    expect(messages).toHaveLength(1);
    expect(messages[0]).toEqual(expect.objectContaining({
      role: 'assistant',
      content: 'Morning Brief: ⏳ Running',
    }));
    expect(messages[0].agentRunLogId).toBeUndefined();

    const source = fs.readFileSync(path.join(__dirname, '..', 'components', 'layout', 'Sidebar.tsx'), 'utf8');
    const handler = source.slice(
      source.indexOf('const handleRunScheduledAgent'),
      source.indexOf('// Task B STOP button'),
    );
    expect(handler).toMatch(/postAgentRunStartedNotice\(agentId, agentName\);\s*await runAgentNow\(agentId, runCommandForAgentSync\);/);
  });

  it('is wired immediately after the Sidebar runAgentNow success point', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'components', 'layout', 'Sidebar.tsx'), 'utf8');
    const handler = source.slice(
      source.indexOf('const handleRunScheduledAgent'),
      source.indexOf('// Task B STOP button'),
    );
    expect(handler).toMatch(/await runAgentNow\(agentId, runCommandForAgentSync\);\s*postLatestAgentRunToCompanion\(/);
  });

  it.each([
    ['error', '❌'],
    ['skipped', '⏭️'],
    ['success', '✅'],
    ['unavailable', '✅'],
  ] as const)('posts the latest %s result to the shared companion thread', (status, icon) => {
    const log = runLog('agent-a', 101, status, status === 'success' ? '' : 'result preview');
    useAgentStore.setState({ runHistory: { 'agent-a': [log] } });

    expect(postLatestAgentRunToCompanion('agent-a', 'Morning Brief', 'Done.')).toBe(true);

    const messages = useAIPaneStore.getState().conversations[COMPANION_CONVERSATION_KEY].messages;
    expect(messages).toHaveLength(1);
    expect(messages[0]).toEqual(expect.objectContaining({
      role: 'assistant',
      content: status === 'success' ? 'Morning Brief: ✅ Done.' : `Morning Brief: ${icon} result preview`,
      agentRunLogId: agentRunLogIdentity(log),
    }));
  });
});

describe('unattended run-log sync deduplication', () => {
  it('does not treat history present before the first sync as new', () => {
    const existing = runLog('agent-a', 100, 'success', 'old');
    const tracker = new AgentRunLogNoticeTracker();
    tracker.beginSync({ 'agent-a': [existing] });
    expect(tracker.completeSync({ 'agent-a': [existing] })).toEqual([]);
  });

  it('does not backfill disk history when the RN store is empty on the first sync', () => {
    const existingOnDisk = runLog('agent-a', 100, 'success', 'old');
    const tracker = new AgentRunLogNoticeTracker();
    tracker.beginSync({});
    expect(tracker.completeSync({ 'agent-a': [existingOnDisk] })).toEqual([]);
  });

  it('returns only logs introduced by the disk sync and only once', () => {
    const existing = runLog('agent-a', 100, 'success', 'old');
    const fresh = runLog('agent-a', 200, 'error', 'new');
    const tracker = new AgentRunLogNoticeTracker();
    tracker.beginSync({ 'agent-a': [existing] });
    expect(tracker.completeSync({ 'agent-a': [existing] })).toEqual([]);
    tracker.beginSync({ 'agent-a': [existing] });
    expect(tracker.completeSync({ 'agent-a': [existing, fresh] })).toEqual([fresh]);
    tracker.beginSync({ 'agent-a': [existing, fresh] });
    expect(tracker.completeSync({ 'agent-a': [existing, fresh] })).toEqual([]);
  });

  it('does not double-post a run already surfaced by the attended path', () => {
    const log = runLog('agent-a', 300, 'success', 'attended result');
    expect(postAgentCompanionNotice(log, 'Agent A', 'Done.')).toBe(true);

    const tracker = new AgentRunLogNoticeTracker();
    tracker.beginSync({});
    tracker.completeSync({});
    tracker.beginSync({});
    const [fresh] = tracker.completeSync({ 'agent-a': [log] });
    expect(postAgentCompanionNotice(fresh, 'Agent A', 'Done.')).toBe(false);
    expect(useAIPaneStore.getState().conversations[COMPANION_CONVERSATION_KEY].messages).toHaveLength(1);
  });
});

// Fable5 product-review Gap A (2026-08-25): companion journal dormancy
// notice. The one-time-across-app-restarts guarantee is
// AppSettings.companionJournalDormancyNoticeShown, checked by the caller
// (components/panes/AIPane.tsx) BEFORE calling this function; what this
// function itself guarantees is that a second post within the same session
// (e.g. a settings-flag write racing/failing between two switches) can
// never produce two lines in the companion thread.
describe('companion journal dormancy notice', () => {
  it('posts a single plain-chat-text line into the shared companion thread', () => {
    expect(postCompanionJournalDormancyNotice('no local LLM is configured yet')).toBe(true);

    const messages = useAIPaneStore.getState().conversations[COMPANION_CONVERSATION_KEY].messages;
    expect(messages).toHaveLength(1);
    expect(messages[0]).toEqual(expect.objectContaining({
      role: 'assistant',
      content: 'no local LLM is configured yet',
    }));
  });

  it('does not double-post within the same session', () => {
    postCompanionJournalDormancyNotice('first call');
    expect(postCompanionJournalDormancyNotice('second call')).toBe(false);

    const messages = useAIPaneStore.getState().conversations[COMPANION_CONVERSATION_KEY].messages;
    expect(messages).toHaveLength(1);
    expect(messages[0].content).toBe('first call');
  });
});
