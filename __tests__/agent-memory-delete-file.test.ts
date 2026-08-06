// deleteMemoryNoteFile — the G2 on-disk removal primitive the Memory
// Workbench delete/edit path uses (via lib/memory/shadow.ts) so a deleted
// note cannot resurrect through the per-session G2 mirror-import.
jest.mock('expo-file-system/legacy', () => ({ deleteAsync: jest.fn() }));
jest.mock('@/lib/home-path', () => ({ getHomePath: () => '/home/shelly-test' }));

import * as FileSystem from 'expo-file-system/legacy';
import { deleteMemoryNoteFile } from '@/lib/agent-memory';

const deleteAsync = (FileSystem as unknown as { deleteAsync: jest.Mock }).deleteAsync;

beforeEach(() => {
  deleteAsync.mockReset();
  deleteAsync.mockResolvedValue(undefined);
});

describe('deleteMemoryNoteFile', () => {
  it('deletes the note file idempotently under the agent memory dir', async () => {
    const ok = await deleteMemoryNoteFile('agent-7', 'fact-abc');
    expect(ok).toBe(true);
    expect(deleteAsync).toHaveBeenCalledWith(
      'file:///home/shelly-test/.shelly/agents/memory/agent-7/fact-abc.md',
      { idempotent: true }
    );
  });

  it('returns false when the filesystem delete throws', async () => {
    deleteAsync.mockRejectedValue(new Error('EACCES'));
    const ok = await deleteMemoryNoteFile('agent-7', 'fact-abc');
    expect(ok).toBe(false);
  });

  it('never touches the filesystem for an unsafe agentId (no traversal), reporting nothing-to-delete', async () => {
    // An unsafe id can never name an on-disk G2 note (buildMemoryWriteCommand
    // refuses them at write time), so there is nothing to delete — true.
    const ok = await deleteMemoryNoteFile('../evil', 'fact-abc');
    expect(ok).toBe(true);
    expect(deleteAsync).not.toHaveBeenCalled();
  });

  it('never touches the filesystem for an unsafe noteId', async () => {
    const ok = await deleteMemoryNoteFile('agent-7', '../../etc/passwd');
    expect(ok).toBe(true);
    expect(deleteAsync).not.toHaveBeenCalled();
  });
});
