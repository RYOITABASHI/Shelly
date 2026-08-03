jest.mock('@/lib/home-path', () => ({
  getHomePath: () => '/home/shelly-test',
}));
jest.mock('expo-file-system/legacy', () => ({}));

import {
  buildMemoryNoteMarkdown,
  buildMemoryWriteCommand,
  buildRecallContext,
  extractRunDigest,
  makeMemoryNote,
  memoryNoteId,
  parseMemoryNoteMarkdown,
  recallMemoryNotes,
  VAULT_MEMORY_DIR,
  type MemoryNote,
} from '@/lib/agent-memory';
import { scanForSecrets } from '@/lib/secret-guard';

describe('memory note id', () => {
  it('is stable and idempotent for the same agent/type/text', () => {
    const a = memoryNoteId('agent-1', 'fact', 'birthday is May 5');
    const b = memoryNoteId('agent-1', 'fact', '  birthday is May 5  ');
    expect(a).toBe(b);
  });

  it('differs by agent, type, and text', () => {
    expect(memoryNoteId('agent-1', 'fact', 'x')).not.toBe(memoryNoteId('agent-2', 'fact', 'x'));
    expect(memoryNoteId('agent-1', 'fact', 'x')).not.toBe(memoryNoteId('agent-1', 'result', 'x'));
    expect(memoryNoteId('agent-1', 'fact', 'x')).not.toBe(memoryNoteId('agent-1', 'fact', 'y'));
  });
});

describe('markdown roundtrip', () => {
  it('build → parse preserves the note', () => {
    const note = makeMemoryNote({
      agentId: 'agent-news',
      type: 'preference',
      text: 'User prefers concise bullet summaries.',
      tags: ['Style', 'summary!!'],
      created: '2026-06-22T00:00:00.000Z',
    });
    const md = buildMemoryNoteMarkdown(note);
    const parsed = parseMemoryNoteMarkdown(md);
    expect(parsed).not.toBeNull();
    expect(parsed!.agentId).toBe('agent-news');
    expect(parsed!.type).toBe('preference');
    expect(parsed!.created).toBe('2026-06-22T00:00:00.000Z');
    expect(parsed!.tags).toEqual(['style', 'summary']); // normalized
    expect(parsed!.text).toBe('User prefers concise bullet summaries.');
  });

  it('rejects malformed / unsafe notes', () => {
    expect(parseMemoryNoteMarkdown('no frontmatter here')).toBeNull();
    expect(parseMemoryNoteMarkdown('---\nagentId: bad id\ntype: fact\n---\nx')).toBeNull();
    expect(parseMemoryNoteMarkdown('---\nagentId: a\ntype: bogus\n---\nx')).toBeNull();
    expect(parseMemoryNoteMarkdown('---\nagentId: a\ntype: fact\n---\n')).toBeNull();
  });
});

describe('buildMemoryWriteCommand', () => {
  const note = makeMemoryNote({ agentId: 'agent-1', type: 'fact', text: 'hello', created: '2026-06-22T00:00:00.000Z' });

  it('is crash-safe: set -e, mkdir, heredoc, and a verified [ -s ] assert', () => {
    const cmd = buildMemoryWriteCommand(note);
    expect(cmd).toContain('set -e');
    expect(cmd).toContain(`mkdir -p '/home/shelly-test/.shelly/agents/memory/agent-1'`);
    expect(cmd).toMatch(/<<'SHELLY_MEMORY_/);
    expect(cmd).toContain(`[ -s '/home/shelly-test/.shelly/agents/memory/agent-1/${note.id}.md' ]`);
    expect(cmd).toContain('exit 1');
  });

  it('mirrors to the Obsidian Vault best-effort (never fails the write)', () => {
    const cmd = buildMemoryWriteCommand(note);
    expect(cmd).toContain('OBSIDIAN_VAULT_PATH');
    expect(cmd).toContain(`${VAULT_MEMORY_DIR}/agent-1`);
    expect(cmd).toContain('|| true');
  });

  it('refuses unsafe agent ids (no path traversal / shell metachars)', () => {
    const evil = { ...note, agentId: '../../etc' };
    expect(() => buildMemoryWriteCommand(evil)).toThrow(/unsafe agentId/);
  });
});

describe('recall scoring', () => {
  const notes: MemoryNote[] = [
    makeMemoryNote({ agentId: 'a', type: 'fact', text: 'The user lives in Tokyo', tags: ['location'], created: '2026-06-01T00:00:00.000Z' }),
    makeMemoryNote({ agentId: 'a', type: 'preference', text: 'Prefers concise crypto summaries', tags: ['crypto'], created: '2026-06-20T00:00:00.000Z' }),
    makeMemoryNote({ agentId: 'a', type: 'result', text: 'Weather was sunny yesterday', tags: ['weather'], created: '2026-06-21T00:00:00.000Z' }),
  ];
  // readMemoryNotes returns newest-first; mirror that for scoring input.
  const newestFirst = [...notes].sort((x, y) => y.created.localeCompare(x.created));

  it('ranks tag/keyword overlap above recency', () => {
    const out = recallMemoryNotes(newestFirst, 'Give me a crypto market summary', 2);
    expect(out[0].tags).toContain('crypto');
  });

  it('falls back to recency when nothing overlaps', () => {
    const out = recallMemoryNotes(newestFirst, 'completely unrelated zzz', 1);
    expect(out[0].text).toContain('Weather'); // newest
  });

  it('respects the limit and empty input', () => {
    expect(recallMemoryNotes(newestFirst, 'x', 0)).toEqual([]);
    expect(recallMemoryNotes([], 'x', 5)).toEqual([]);
    expect(recallMemoryNotes(newestFirst, 'x', 2).length).toBe(2);
  });
});

// BM25 + recency-decay scoring (2026-08-03 Stage 1 upgrade, replacing the
// original flat "+2 per tag, +1 per body token" scheme). These tests exercise
// specifically what BM25 adds over the old scheme: real IDF term-weighting
// (a token common across most of an agent's OWN notes contributes almost
// nothing) and a bounded recency multiplier — not just "does relevant still
// rank above irrelevant," which the suite above already covers and which any
// reasonable scoring scheme would pass.
describe('recall scoring — BM25 term-weighting (2026-08-03)', () => {
  it('down-weights a token common across most notes, so a note matching only on it does NOT beat a note matching a rare, distinguishing term', () => {
    // "エージェント" (agent) appears in every note's body — a routine word for
    // this corpus, not a real relevance signal. "為替" (foreign exchange) is
    // rare, appearing in exactly one note, and IS what the query is actually
    // asking about.
    const notes: MemoryNote[] = [
      makeMemoryNote({ agentId: 'a', type: 'fact', text: 'このエージェントは毎朝ニュースをまとめるエージェントです', created: '2026-06-01T00:00:00.000Z' }),
      makeMemoryNote({ agentId: 'a', type: 'fact', text: 'このエージェントは為替レートを記録するエージェントです', created: '2026-06-01T00:00:00.000Z' }),
      makeMemoryNote({ agentId: 'a', type: 'fact', text: 'このエージェントは天気を報告するエージェントです', created: '2026-06-01T00:00:00.000Z' }),
    ];
    const out = recallMemoryNotes(notes, '為替レートを教えて', 1);
    expect(out[0].text).toContain('為替');
  });

  it('a note matching MULTIPLE query terms outranks one matching only one, even when both share the common corpus term', () => {
    const notes: MemoryNote[] = [
      makeMemoryNote({ agentId: 'a', type: 'fact', text: 'ニュースをまとめるエージェント', created: '2026-06-01T00:00:00.000Z' }),
      makeMemoryNote({ agentId: 'a', type: 'fact', text: '為替のニュースをまとめて記録するエージェント', created: '2026-06-01T00:00:00.000Z' }),
    ];
    const out = recallMemoryNotes(notes, '為替のニュースをまとめて', 2);
    expect(out[0].text).toContain('為替');
  });

  it('tag matches still outweigh a body-only match, same spirit as the original scoring', () => {
    const notes: MemoryNote[] = [
      makeMemoryNote({ agentId: 'a', type: 'fact', text: 'crypto is mentioned once here in passing', created: '2026-06-01T00:00:00.000Z' }),
      makeMemoryNote({ agentId: 'a', type: 'fact', text: 'daily digest', tags: ['crypto'], created: '2026-06-01T00:00:00.000Z' }),
    ];
    const out = recallMemoryNotes(notes, 'crypto summary', 2);
    expect(out[0].tags).toContain('crypto');
  });

  it('an OLD note that is still the best relevance match outranks a BRAND NEW note that is a worse match — recency never dominates real relevance', () => {
    const notes: MemoryNote[] = [
      makeMemoryNote({ agentId: 'a', type: 'preference', text: 'always summarize crypto prices in JPY', tags: ['crypto'], created: '2020-01-01T00:00:00.000Z' }),
      makeMemoryNote({ agentId: 'a', type: 'fact', text: 'the weather today is sunny', created: '2026-08-03T00:00:00.000Z' }),
    ];
    const out = recallMemoryNotes(notes, 'crypto price summary', 1, Date.parse('2026-08-03T00:00:00.000Z'));
    expect(out[0].tags).toContain('crypto');
  });

  it('among equally-irrelevant notes, whichever the caller lists first wins (same index-tiebreak contract as before BM25 — callers pass notes newest-first, see readMemoryNotes)', () => {
    const older = makeMemoryNote({ agentId: 'a', type: 'fact', text: 'alpha', created: '2026-01-01T00:00:00.000Z' });
    const newer = makeMemoryNote({ agentId: 'a', type: 'fact', text: 'beta', created: '2026-06-01T00:00:00.000Z' });
    // Both score 0 (no term overlap at all) -- the recency MULTIPLIER can only
    // ever narrow a nonzero score, so a genuinely zero-relevance tie still
    // resolves by input order, exactly like the pre-BM25 scoring's index
    // tiebreak did. Passing newest-first (`newer` before `older`) is the real
    // production contract every caller (readMemoryNotes's own return order)
    // already honors.
    const out = recallMemoryNotes([newer, older], 'completely unrelated zzz', 2, Date.parse('2026-08-03T00:00:00.000Z'));
    expect(out[0].text).toBe('beta');
  });

  it('accepts an explicit `now` for deterministic testing, and defaults to Date.now() when omitted', () => {
    const notes: MemoryNote[] = [
      makeMemoryNote({ agentId: 'a', type: 'fact', text: 'test note', created: '2026-01-01T00:00:00.000Z' }),
    ];
    // No throw, no NaN-corrupted ordering, whichever `now` is used.
    expect(recallMemoryNotes(notes, 'test note', 1).length).toBe(1);
    expect(recallMemoryNotes(notes, 'test note', 1, Date.parse('2026-08-03T00:00:00.000Z')).length).toBe(1);
  });

  it('never throws or produces NaN ordering on a malformed `created` timestamp', () => {
    const notes: MemoryNote[] = [
      { id: 'x', agentId: 'a', type: 'fact', created: 'not-a-real-date', tags: [], text: 'test content' },
    ];
    const out = recallMemoryNotes(notes, 'test content', 1);
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe('x');
  });
});

describe('buildRecallContext', () => {
  it('returns empty string when there are no notes', () => {
    expect(buildRecallContext([])).toBe('');
  });

  it('lists notes under an on-device memory header', () => {
    const ctx = buildRecallContext([
      makeMemoryNote({ agentId: 'a', type: 'fact', text: 'remember X' }),
    ]);
    expect(ctx).toContain('on-device memory');
    expect(ctx).toContain('[fact] remember X');
  });
});

describe('memory never silently leaks secrets to cloud', () => {
  it('a secret inside a recalled note is visible to secret-guard via the run prompt', () => {
    // The recall block is prepended to agent.prompt, which resolveAgentRoute scans.
    // So a secret in memory must be detectable by scanForSecrets exactly like a
    // secret in the task text — proving the forced-local path covers memory.
    const ctx = buildRecallContext([
      makeMemoryNote({ agentId: 'a', type: 'fact', text: 'my key is sk-ant-api03-AAAABBBBCCCCDDDDEEEE' }),
    ]);
    const effectivePrompt = `${ctx}\n\n---\n\nSummarize the news`;
    expect(scanForSecrets(effectivePrompt).hasSecret).toBe(true);
  });
});

describe('extractRunDigest', () => {
  it('collapses whitespace, strips code fences, and bounds length', () => {
    const digest = extractRunDigest('Result:\n```\ncode\n```\n  many   spaces   here  ');
    expect(digest).not.toContain('```');
    expect(digest).toBe('Result: many spaces here');
    expect(extractRunDigest('x'.repeat(500)).length).toBe(280);
  });
});
