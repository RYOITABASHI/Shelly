jest.mock('@/lib/home-path', () => ({
  getHomePath: () => '/home/shelly-test',
}));

jest.mock('@/modules/terminal-emulator/src/TerminalEmulatorModule', () => ({
  __esModule: true,
  default: {
    cancelAgent: jest.fn(async () => undefined),
    execCommand: jest.fn(async () => ({ exitCode: 0, stdout: '', stderr: '' })),
    runAgent: jest.fn(async () => undefined),
  },
}));
jest.mock('expo-notifications', () => ({}));
jest.mock('expo-file-system/legacy', () => ({}));

import { createAgent } from '@/lib/agent-manager';

// Focused coverage for NOTIFY-001 Increment 2 step 2: createAgent() must accept
// an explicit notificationTrigger param and thread it through to the returned
// Agent, defaulting to null (not undefined) when the caller omits it.
describe('createAgent — notificationTrigger param', () => {
  const baseParams = {
    name: 'Test agent',
    description: 'desc',
    prompt: 'do the thing',
    schedule: null,
    tool: { type: 'cli' as const, cli: 'codex' as const },
    outputPath: '/tmp/out',
  };

  it('threads notificationTrigger through when provided', () => {
    const agent = createAgent({
      ...baseParams,
      notificationTrigger: { packageNames: ['com.example.app'] },
    });
    expect(agent.notificationTrigger).toEqual({ packageNames: ['com.example.app'] });
  });

  it('defaults notificationTrigger to null (not undefined) when omitted', () => {
    const agent = createAgent({ ...baseParams });
    expect(agent.notificationTrigger).toBeNull();
    expect(agent.notificationTrigger).not.toBeUndefined();
  });
});

// Deferred-start scheduling (2026-07-24): createAgent must thread startNotBefore
// through to the persisted Agent, same defaulting contract as notificationTrigger.
describe('createAgent — startNotBefore param', () => {
  const baseParams = {
    name: 'Test agent',
    description: 'desc',
    prompt: 'do the thing',
    schedule: '0 8 * * *',
    tool: { type: 'cli' as const, cli: 'codex' as const },
    outputPath: '/tmp/out',
  };

  it('threads startNotBefore through when provided', () => {
    const notBefore = new Date(2026, 6, 21, 0, 0, 0, 0).getTime();
    const agent = createAgent({ ...baseParams, startNotBefore: notBefore });
    expect(agent.startNotBefore).toBe(notBefore);
  });

  it('defaults startNotBefore to null (not undefined) when omitted', () => {
    const agent = createAgent({ ...baseParams });
    expect(agent.startNotBefore).toBeNull();
    expect(agent.startNotBefore).not.toBeUndefined();
  });
});

// Multi-destination fan-out (2026-07-28 — DEFERRED.md's "エージェント1件から
// 複数プラットフォームへ同時配信できない" authoring-side follow-up): createAgent
// must thread an explicit `actions` param through to the persisted Agent,
// same passthrough contract as notificationTrigger/startNotBefore above. See
// store/types.ts's Agent.actions doc comment for why this stays undefined
// (not null) when omitted — it's purely additive, unlike the other two
// fields which have an explicit "no value" sentinel.
describe('createAgent — actions param (multi-destination fan-out)', () => {
  const baseParams = {
    name: 'Test agent',
    description: 'desc',
    prompt: 'do the thing',
    schedule: '0 8 * * *',
    tool: { type: 'cli' as const, cli: 'codex' as const },
    outputPath: '/tmp/out',
  };

  it('threads actions through when provided', () => {
    const actions = [
      { type: 'social-post' as const, socialPost: { platform: 'bluesky' as const, connectorId: 'my-bluesky', text: '{{result}}' } },
      { type: 'app-act' as const, appActRecipeId: 'x.post', appActParams: { text: '{{result}}' } },
    ];
    const agent = createAgent({ ...baseParams, actions });
    expect(agent.actions).toEqual(actions);
  });

  it('leaves actions undefined when omitted (existing single-action agents unaffected)', () => {
    const agent = createAgent({ ...baseParams });
    expect(agent.actions).toBeUndefined();
  });
});
