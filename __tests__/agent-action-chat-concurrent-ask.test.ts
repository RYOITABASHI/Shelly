/**
 * Review M1 (parallel CLI steps Inc3): when a 2nd ask of the same agent is
 * posted into its chat thread, the EARLIER ask line is rewritten in place to
 * the "answer by its code" text too (same message, same marker), so no line
 * still says a bare "OK" works. Another agent's ask is not touched.
 */
jest.mock('@/modules/terminal-emulator/src/TerminalEmulatorModule', () => ({ __esModule: true, default: {} }));
jest.mock('expo-notifications', () => ({}));
jest.mock('expo-file-system/legacy', () => ({}));
jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);

import { postEscalationAsk } from '@/lib/agent-action-chat-approval';
import { __resetPendingApprovalsForTest, getPendingApprovals } from '@/lib/agent-pending-approvals';
import { agentThreadKey, useAIPaneStore } from '@/store/ai-pane-store';

const sha = (hex: string) => hex + 'f'.repeat(56);
const thread = (agentId: string) => useAIPaneStore.getState().conversations[agentThreadKey(agentId)]?.messages ?? [];

describe('postEscalationAsk — concurrent asks of one agent', () => {
  beforeEach(() => __resetPendingApprovalsForTest());

  it('the 1st line switches to the code-only text when the 2nd arrives; markers stay', () => {
    useAIPaneStore.getState().getOrCreate(agentThreadKey('agent-c'));
    postEscalationAsk({ runId: 'run-a', reqId: 'req-1', agentId: 'agent-c', command: 'git push', requestSha256: sha('aaaaaaaa') });
    const firstBefore = thread('agent-c').find((m) => m.pendingActionApproval?.hash8 === 'aaaaaaaa')!;
    expect(firstBefore.content).not.toContain('OK aaaaaaaa');

    postEscalationAsk({ runId: 'run-b', reqId: 'req-2', agentId: 'agent-c', command: 'rm -rf build', requestSha256: sha('bbbbbbbb') });
    const msgs = thread('agent-c');
    const first = msgs.find((m) => m.id === firstBefore.id)!;
    const second = msgs.find((m) => m.pendingActionApproval?.hash8 === 'bbbbbbbb')!;
    expect(first.content).toContain('OK aaaaaaaa');
    expect(first.pendingActionApproval?.hash8).toBe('aaaaaaaa');
    expect(second.content).toContain('OK bbbbbbbb');
    // Edited in place: still two ask lines, nothing resolved.
    expect(msgs.filter((m) => m.pendingActionApproval)).toHaveLength(2);
    expect(getPendingApprovals().map((a) => a.marker.hash8).sort()).toEqual(['aaaaaaaa', 'bbbbbbbb']);
  });

  it("another agent's pending ask is not rewritten", () => {
    useAIPaneStore.getState().getOrCreate(agentThreadKey('agent-x'));
    useAIPaneStore.getState().getOrCreate(agentThreadKey('agent-y'));
    postEscalationAsk({ runId: 'run-x', reqId: 'req-1', agentId: 'agent-x', command: 'git push', requestSha256: sha('cccccccc') });
    postEscalationAsk({ runId: 'run-y', reqId: 'req-1', agentId: 'agent-y', command: 'git push', requestSha256: sha('dddddddd') });
    expect(thread('agent-x').find((m) => m.pendingActionApproval)!.content).not.toContain('OK cccccccc');
    expect(thread('agent-y').find((m) => m.pendingActionApproval)!.content).not.toContain('OK dddddddd');
  });
});
