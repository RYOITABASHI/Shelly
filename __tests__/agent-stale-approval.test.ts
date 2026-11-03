jest.mock('@/lib/home-path', () => ({
  getHomePath: () => '/home/shelly-test',
}));

const mockTerminalEmulator = {
  cancelAgent: jest.fn(async () => undefined),
  execCommand: jest.fn(async () => ({ exitCode: 0, stdout: '', stderr: '' })),
  runAgent: jest.fn(async () => undefined),
};

jest.mock('@/modules/terminal-emulator/src/TerminalEmulatorModule', () => ({
  __esModule: true,
  default: mockTerminalEmulator,
}));
jest.mock('expo-notifications', () => ({}));
jest.mock('expo-file-system/legacy', () => ({}));

import * as fs from 'fs';
import * as path from 'path';
import { deleteAgent, isSafeAgentId } from '@/lib/agent-manager';
import {
  ACTION_APPROVAL_EXPIRY_GRACE_MS,
  LIVE_ESCALATION_MAX_WAIT_MS,
  STALE_APPROVAL_MAX_AGE_MS,
  actionApprovalStaleReason,
  dropStaleApprovalRequest,
  escalationStaleReason,
  resolveAgentGone,
  type StaleApprovalReason,
} from '@/lib/agent-stale-approval';
import { useAgentStore } from '@/store/agent-store';
import type { Agent } from '@/store/types';

const NOW = Date.parse('2026-11-01T10:00:00Z');
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();

const agent = (id: string): Agent => ({
  id,
  name: id,
  description: '',
  prompt: '',
  schedule: null,
  tool: { type: 'local' },
  outputPath: '~/out',
  outputTemplate: null,
  enabled: true,
  lastRun: null,
  lastResult: null,
  createdAt: 0,
  version: 1,
});

describe('deleteAgent approval-request cleanup', () => {
  beforeEach(() => {
    mockTerminalEmulator.execCommand.mockClear();
    mockTerminalEmulator.execCommand.mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' });
    useAgentStore.getState().setAgents([agent('agent-x'), agent('agent-x-2')]);
  });

  it('removes escalation and action-approval requests whose agentId is exactly this agent', async () => {
    await deleteAgent('agent-x');
    const calls = mockTerminalEmulator.execCommand.mock.calls as unknown as Array<[string, number?]>;
    // The final MONITOR progress read (PROGRESS_FINAL_READ) runs first.
    const command = calls.find(([cmd]) => cmd.includes('rm -rf "$d/logs/agent-x"'))?.[0] ?? '';
    expect(command).toContain('for f in "$d"/escalations/req-*.json; do');
    expect(command).toContain('for f in "$d"/action-approvals/action-*.json; do');
    // Exact agentId field match (closing quote included) — never a bare
    // prefix glob that would also hit agent-x-2's files.
    expect(command).toContain(`grep -qF -e '"agentId":"agent-x"' -e '"agentId": "agent-x"' "$f"`);
    expect(command).not.toContain('action-agent-x-*');
    expect(command).not.toContain('agent-x-2');
    expect(command).toContain('rm -f "$f" "$d/action-approval-replies/$b.reply.json"');
    // Cleanup runs inside the same batch, before the existence assertion.
    expect(command.indexOf('escalations/req-')).toBeLessThan(command.indexOf('delete failed:'));
  });
});

describe('escalationStaleReason', () => {
  it('drops a queued request of a deleted agent', () => {
    expect(escalationStaleReason({ state: 'queued', ts: iso(60_000) }, { agentGone: true, nowMs: NOW })).toBe('agent-gone');
  });

  it('drops an over-age request even for a live agent', () => {
    expect(
      escalationStaleReason({ state: 'queued', ts: iso(STALE_APPROVAL_MAX_AGE_MS + 1) }, { agentGone: false, nowMs: NOW }),
    ).toBe('expired');
  });

  it('drops a live-state request whose driver wait is long over', () => {
    expect(
      escalationStaleReason({ ts: iso(LIVE_ESCALATION_MAX_WAIT_MS + 1) }, { agentGone: false, nowMs: NOW }),
    ).toBe('run-not-live');
  });

  it('keeps a fresh live request and a recent queued one for a live agent', () => {
    expect(escalationStaleReason({ ts: iso(5_000) }, { agentGone: false, nowMs: NOW })).toBeNull();
    expect(escalationStaleReason({ state: 'queued', ts: iso(2 * 60 * 60_000) }, { agentGone: false, nowMs: NOW })).toBeNull();
  });

  it('never treats an unparseable timestamp as stale', () => {
    expect(escalationStaleReason({ ts: 'garbage' }, { agentGone: false, nowMs: NOW })).toBeNull();
  });
});

describe('actionApprovalStaleReason', () => {
  it('drops agent-gone, over-age and long-expired requests', () => {
    expect(actionApprovalStaleReason({ ts: iso(1000) }, { agentGone: true, nowMs: NOW })).toBe('agent-gone');
    // The 2026-08-07 leftover file shape (bash `date -Iseconds`).
    expect(actionApprovalStaleReason({ ts: '2026-08-07T12:00:00+09:00' }, { agentGone: false, nowMs: NOW })).toBe('expired');
    expect(
      actionApprovalStaleReason({ ts: iso(60 * 60_000), expiresAt: NOW - ACTION_APPROVAL_EXPIRY_GRACE_MS - 1 }, { agentGone: false, nowMs: NOW }),
    ).toBe('expired');
  });

  it('keeps a fresh request and one only just past expiresAt (executor cleanup wins)', () => {
    expect(actionApprovalStaleReason({ ts: iso(1000), expiresAt: NOW + 60_000 }, { agentGone: false, nowMs: NOW })).toBeNull();
    expect(actionApprovalStaleReason({ ts: iso(1000), expiresAt: NOW - 1000 }, { agentGone: false, nowMs: NOW })).toBeNull();
  });
});

describe('resolveAgentGone', () => {
  const base = {
    isSafeAgentId,
    storeLoaded: true,
    storeHasAgent: (id: string) => id === 'agent-live',
  };

  it('is true on the deleteAgent tombstone', async () => {
    const pathExists = jest.fn(async (rel: string) => rel === '.deleted/agent-mvvx3o28');
    await expect(resolveAgentGone('agent-mvvx3o28', { ...base, pathExists })).resolves.toBe(true);
  });

  it('is true when the loaded store lacks it and its json is confirmed absent', async () => {
    await expect(resolveAgentGone('agent-old', { ...base, pathExists: async () => false })).resolves.toBe(true);
  });

  it('is false for a live agent, an unloaded store, an unknown disk state or an unsafe id', async () => {
    await expect(resolveAgentGone('agent-live', { ...base, pathExists: async () => false })).resolves.toBe(false);
    await expect(resolveAgentGone('agent-old', { ...base, storeLoaded: false, pathExists: async () => false })).resolves.toBe(false);
    await expect(resolveAgentGone('agent-old', { ...base, pathExists: async () => null })).resolves.toBe(false);
    await expect(
      resolveAgentGone('agent-old', { ...base, pathExists: async (rel) => (rel.startsWith('.deleted/') ? false : true) }),
    ).resolves.toBe(false);
    await expect(resolveAgentGone('../x', { ...base, pathExists: async () => true })).resolves.toBe(false);
    await expect(
      resolveAgentGone('agent-old', { ...base, pathExists: async () => { throw new Error('io'); } }),
    ).resolves.toBe(false);
  });
});

/**
 * A minimal drain loop with the same order as app/_layout.tsx: stale
 * screening first, then (only for a non-stale request) auto-approval /
 * notification. Pins the contract that a stale request reaches neither.
 */
async function drainOnce(
  requests: Array<{ runId: string; reqId: string; agentId: string; state?: string; ts?: string }>,
  deps: { agentGone: (id: string) => boolean; notify: jest.Mock; autoApprove: jest.Mock; deleteFile: jest.Mock; cancel: jest.Mock; log: jest.Mock },
) {
  for (const r of requests) {
    const reason: StaleApprovalReason | null = escalationStaleReason(r, { agentGone: deps.agentGone(r.agentId), nowMs: NOW });
    if (reason) {
      await dropStaleApprovalRequest(`run=${r.runId} req=${r.reqId}`, reason, {
        deleteRequestFile: async () => deps.deleteFile(r.runId, r.reqId),
        cancelNotification: async () => deps.cancel(r.runId, r.reqId),
        noteGone: () => undefined,
        log: (line) => deps.log(`[Shelly][AgentEscalation] ${line}`),
      });
      continue;
    }
    if (await deps.autoApprove(r)) continue;
    await deps.notify(r);
  }
}

describe('escalation drain stale screening', () => {
  it('drops a queued request of a missing agent and an over-age request without notifying or approving; a fresh live one still notifies', async () => {
    const deps = {
      agentGone: (id: string) => id === 'agent-mvvx3o28',
      notify: jest.fn(async () => ({})),
      autoApprove: jest.fn(async () => false),
      deleteFile: jest.fn(),
      cancel: jest.fn(),
      log: jest.fn(),
    };
    await drainOnce(
      [
        { runId: 'r-gone', reqId: 'q1', agentId: 'agent-mvvx3o28', state: 'queued', ts: iso(60 * 60_000) },
        { runId: 'r-old', reqId: 'q2', agentId: 'agent-live', state: 'queued', ts: iso(STALE_APPROVAL_MAX_AGE_MS + 60_000) },
        { runId: 'r-new', reqId: 'q3', agentId: 'agent-live', ts: iso(3_000) },
      ],
      deps,
    );
    expect(deps.notify).toHaveBeenCalledTimes(1);
    expect(deps.notify).toHaveBeenCalledWith(expect.objectContaining({ runId: 'r-new' }));
    expect(deps.autoApprove).toHaveBeenCalledTimes(1);
    expect(deps.autoApprove).toHaveBeenCalledWith(expect.objectContaining({ runId: 'r-new' }));
    expect(deps.deleteFile.mock.calls).toEqual([['r-gone', 'q1'], ['r-old', 'q2']]);
    expect(deps.cancel.mock.calls).toEqual([['r-gone', 'q1'], ['r-old', 'q2']]);
    expect(deps.log.mock.calls.map((c) => c[0])).toEqual([
      '[Shelly][AgentEscalation] stale request dropped run=r-gone req=q1 reason=agent-gone',
      '[Shelly][AgentEscalation] stale request dropped run=r-old req=q2 reason=expired',
    ]);
  });

  it('dropStaleApprovalRequest still cancels and logs when the file delete fails', async () => {
    const cancel = jest.fn(async () => undefined);
    const log = jest.fn();
    await dropStaleApprovalRequest('run=a req=b', 'expired', {
      deleteRequestFile: async () => { throw new Error('gone'); },
      cancelNotification: cancel,
      noteGone: () => { throw new Error('x'); },
      log,
    });
    expect(cancel).toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith('stale request dropped run=a req=b reason=expired');
  });
});

describe('app/_layout.tsx wiring', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'app', '_layout.tsx'), 'utf8');

  it('screens escalations for staleness before auto-approval and notification', () => {
    const drain = src.slice(src.indexOf('const drainAgentEscalationRequests'));
    const stale = drain.indexOf('escalationStaleReason(parsed');
    expect(stale).toBeGreaterThan(0);
    expect(stale).toBeLessThan(drain.indexOf('await autoApproveEscalation(parsed)'));
    expect(stale).toBeLessThan(drain.indexOf('notifyAgentEscalationApprovalNeeded(parsed)'));
  });

  it('screens action approvals for staleness before any policy / auto resolve / notification', () => {
    const drain = src.slice(src.indexOf('const drainAgentActionApprovalRequests'));
    const stale = drain.indexOf('actionApprovalStaleReason(parsed');
    expect(stale).toBeGreaterThan(0);
    expect(stale).toBeLessThan(drain.indexOf('policyResolveActionApproval(parsed'));
    expect(stale).toBeLessThan(drain.indexOf('autoApproveActionForFlaggedAgent(parsed'));
    expect(stale).toBeLessThan(drain.indexOf('notifyAgentActionApprovalNeeded(parsed)'));
  });
});
