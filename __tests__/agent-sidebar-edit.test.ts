import type { Agent } from '@/store/types';
import { agentToParsedAgentDraft, persistAgentDraft } from '@/lib/agent-draft-patch';

const agent = (overrides: Partial<Agent> = {}): Agent => ({
  id: 'agent-edit-me',
  name: 'Morning brief',
  description: 'brief',
  prompt: 'Summarize the morning news',
  schedule: '30 8 * * *',
  tool: { type: 'cli', cli: 'codex' },
  outputPath: '$HOME/out.md',
  outputTemplate: null,
  action: { type: 'notify' },
  enabled: true,
  lastRun: null,
  lastResult: null,
  createdAt: 1,
  version: 1,
  ...overrides,
});

describe('Sidebar chat-native agent editing', () => {
  it('maps the persisted schedule, action, name, and prompt without reinterpretation', () => {
    const draft = agentToParsedAgentDraft(agent());
    expect(draft.schedule).toBe('30 8 * * *');
    expect(draft.scheduleConfident).toBe(true);
    expect(draft.action).toEqual({ type: 'notify' });
    expect(draft.name).toBe('Morning brief');
    expect(draft.prompt).toBe('Summarize the morning news');
  });

  it('updates instead of creating when editingAgentId is present', async () => {
    const create = jest.fn(() => agent());
    const update = jest.fn(async () => agent({ name: 'Edited' }));
    const runCommand = jest.fn(async () => '');
    const result = await persistAgentDraft({
      editingAgentId: 'agent-edit-me', createParams: { name: 'new' },
      updatePartial: { name: 'Edited' }, runCommand, create, update,
    });
    expect(update).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledWith('agent-edit-me', { name: 'Edited' }, runCommand);
    expect(create).not.toHaveBeenCalled();
    expect(result.edited).toBe(true);
  });

  it('keeps the create path unchanged without editingAgentId', async () => {
    const created = agent();
    const create = jest.fn(() => created);
    const update = jest.fn(async () => agent());
    const runCommand = jest.fn(async () => '');
    const createParams = { name: 'new' };
    const result = await persistAgentDraft({
      createParams, updatePartial: { name: 'unused' }, runCommand, create, update,
    });
    expect(create).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledWith(createParams);
    expect(update).not.toHaveBeenCalled();
    expect(result).toEqual({ agent: created, edited: false });
  });
});
