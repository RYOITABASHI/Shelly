jest.mock('@/lib/home-path', () => ({
  getHomePath: () => '/home/shelly-test',
}));
jest.mock('@/modules/terminal-emulator/src/TerminalEmulatorModule', () => ({
  __esModule: true,
  default: {},
}));
jest.mock('expo-notifications', () => ({}));
jest.mock('expo-file-system/legacy', () => ({}));

import {
  DELETED_AGENT_MARKER_DIR,
  filterDeletedAgentMetadata,
} from '@/lib/agent-manager';
import { Agent } from '@/store/types';

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

describe('agent deletion tombstones', () => {
  it('uses the native/shared deleted-agent marker directory', () => {
    expect(DELETED_AGENT_MARKER_DIR).toBe('.deleted');
  });

  it('filters tombstoned agents so deleted seed agents cannot reappear in the sidebar', () => {
    expect(filterDeletedAgentMetadata(
      [agent('x-casual-draft'), agent('codex-article-draft')],
      new Set(['x-casual-draft']),
    ).map((a) => a.id)).toEqual(['codex-article-draft']);
  });
});
