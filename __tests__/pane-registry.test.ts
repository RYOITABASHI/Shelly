import { PANE_REGISTRY } from '@/components/multi-pane/pane-registry';

describe('PANE_REGISTRY', () => {
  it('registers every pane type used by the shell layout', () => {
    expect(Object.keys(PANE_REGISTRY).sort()).toEqual([
      'agent-chat',
      'ai',
      'ask',
      'browser',
      'markdown',
      'preview',
      'terminal',
    ]);
  });

  it('keeps each entry displayable and lazily loadable', () => {
    for (const [id, entry] of Object.entries(PANE_REGISTRY)) {
      expect(entry.title).toEqual(expect.any(String));
      expect(entry.title.length).toBeGreaterThan(0);
      expect(entry.icon).toEqual(expect.any(String));
      expect(entry.icon.length).toBeGreaterThan(0);
      expect(entry.getComponent).toEqual(expect.any(Function));
      expect(id).toBeTruthy();
    }
  });
});
