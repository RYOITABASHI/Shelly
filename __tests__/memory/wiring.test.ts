jest.mock('@/lib/home-path', () => ({ getHomePath: () => '/home/shelly-test' }));
jest.mock('expo-file-system/legacy', () => ({}));

import {
  MEMORY_ENABLED,
  MEMORY_EMBEDDING_ENABLED,
  agentNamespace,
  g2NoteToRecord,
  recordsToRecallContext,
  MEMORY_SCHEMA_VERSION,
} from '@/lib/memory';
import { buildRecallContext, type MemoryNote } from '@/lib/agent-memory';

describe('MEMORY-001 dormancy + G2 mapping', () => {
  it('ships disabled (queue + embedding both off)', () => {
    expect(MEMORY_ENABLED).toBe(false);
    expect(MEMORY_EMBEDDING_ENABLED).toBe(false);
  });

  it('agentNamespace is deterministic/stable', () => {
    expect(agentNamespace('agent-7')).toBe('agent-7');
    expect(agentNamespace('agent-7')).toBe(agentNamespace('agent-7'));
  });

  it('g2NoteToRecord maps a G2 note onto a MemoryRecord', () => {
    const note: MemoryNote = {
      id: 'fact-abc',
      agentId: 'agent-7',
      type: 'preference',
      created: '2026-07-03T00:00:00.000Z',
      tags: ['t1', 't2'],
      text: 'prefers dark mode',
    };
    const rec = g2NoteToRecord(note);
    expect(rec).toEqual({
      namespace: 'agent-7',
      key: 'fact-abc',
      schemaVersion: MEMORY_SCHEMA_VERSION,
      kind: 'preference',
      text: 'prefers dark mode',
      tags: ['t1', 't2'],
      createdAt: Date.parse('2026-07-03T00:00:00.000Z'),
      updatedAt: Date.parse('2026-07-03T00:00:00.000Z'),
    });
  });

  it('g2NoteToRecord tolerates a bad timestamp (createdAt=0, no throw)', () => {
    const rec = g2NoteToRecord({
      id: 'x', agentId: 'a', type: 'fact', created: 'not-a-date', tags: [], text: 't',
    });
    expect(rec.createdAt).toBe(0);
  });

  it('recordsToRecallContext reproduces buildRecallContext format', () => {
    const notes: MemoryNote[] = [
      { id: 'n1', agentId: 'a', type: 'fact', created: '2026-07-03T00:00:02Z', tags: [], text: 'the api base url is example.com' },
      { id: 'n2', agentId: 'a', type: 'preference', created: '2026-07-03T00:00:01Z', tags: [], text: 'concise answers' },
    ];
    const g2 = buildRecallContext(notes);
    const mine = recordsToRecallContext(notes.map((n) => ({ record: g2NoteToRecord(n), score: 0 })));
    expect(mine).toBe(g2);
  });

  it('recordsToRecallContext returns empty for no hits (prompt unchanged)', () => {
    expect(recordsToRecallContext([])).toBe('');
  });
});
