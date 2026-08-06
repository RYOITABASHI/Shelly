// Pure search/filter + tag-input parsing logic for the Memory Workbench pane.
// lib/memory-workbench.ts is deliberately dependency-free (structural note
// type, no expo imports) so this unit project can import it directly —
// same pattern as lib/agent-data-sync.ts.
import {
  filterMemoryNotes,
  parseTagsInput,
  type WorkbenchNote,
} from '@/lib/memory-workbench';

function note(id: string, text: string, tags: string[] = [], type = 'fact'): WorkbenchNote {
  return { id, agentId: 'agent-7', type, created: '2026-07-01T00:00:00Z', tags, text };
}

const NOTES: WorkbenchNote[] = [
  note('n1', 'deploy target is the fold6 device', ['deploy']),
  note('n2', 'user prefers concise answers', ['style'], 'preference'),
  note('n3', 'API base URL is example.com', ['api', 'backend']),
];

describe('filterMemoryNotes', () => {
  it('returns all notes for an empty or whitespace-only query', () => {
    expect(filterMemoryNotes(NOTES, '')).toEqual(NOTES);
    expect(filterMemoryNotes(NOTES, '   ')).toEqual(NOTES);
  });

  it('matches text content case-insensitively', () => {
    expect(filterMemoryNotes(NOTES, 'FOLD6').map((n) => n.id)).toEqual(['n1']);
    expect(filterMemoryNotes(NOTES, 'api base').map((n) => n.id)).toEqual(['n3']);
  });

  it('matches tags by substring', () => {
    expect(filterMemoryNotes(NOTES, 'backend').map((n) => n.id)).toEqual(['n3']);
    expect(filterMemoryNotes(NOTES, 'sty').map((n) => n.id)).toEqual(['n2']);
  });

  it('matches the note type exactly', () => {
    expect(filterMemoryNotes(NOTES, 'preference').map((n) => n.id)).toEqual(['n2']);
  });

  it('returns an empty array when nothing matches', () => {
    expect(filterMemoryNotes(NOTES, 'zzz-not-here')).toEqual([]);
  });

  it('preserves the input order of matches', () => {
    expect(filterMemoryNotes(NOTES, 'e').map((n) => n.id)).toEqual(['n1', 'n2', 'n3']);
  });
});

describe('parseTagsInput', () => {
  it('splits on commas and trims whitespace', () => {
    expect(parseTagsInput('api, backend , deploy')).toEqual(['api', 'backend', 'deploy']);
  });

  it('drops empty segments', () => {
    expect(parseTagsInput(' , api,, ')).toEqual(['api']);
  });

  it('returns an empty array for empty input', () => {
    expect(parseTagsInput('')).toEqual([]);
    expect(parseTagsInput('   ')).toEqual([]);
  });
});
