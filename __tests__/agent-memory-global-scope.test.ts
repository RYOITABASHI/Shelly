/**
 * User-scope (`_global`) memory namespace — roadmap item 3, part 1.
 *
 * Covers the pure surface: scope detection, note construction, merged recall
 * ranking across scopes, and the rendered recall block's shape (which must keep
 * the per-line format the MEMORY-001 parity checks depend on).
 */
jest.mock('expo-file-system/legacy', () => ({
  getInfoAsync: jest.fn(async () => ({ exists: false, isDirectory: false })),
  readDirectoryAsync: jest.fn(async () => []),
  readAsStringAsync: jest.fn(async () => ''),
}));
jest.mock('@/lib/home-path', () => ({ getHomePath: () => '/home/test' }));

import {
  GLOBAL_MEMORY_SCOPE,
  buildGlobalRecallContext,
  buildMemoryNoteMarkdown,
  buildMemoryWriteCommand,
  buildRecallContext,
  isGlobalMemoryScope,
  makeGlobalMemoryNote,
  makeMemoryNote,
  parseMemoryNoteMarkdown,
  recallMemoryNotes,
  type MemoryNote,
} from '@/lib/agent-memory';
import { detectGlobalMemoryWrite } from '@/lib/agent-global-memory-intent';
import { parseAgentNL } from '@/lib/agent-nl-parser';

const iso = (n: number) => new Date(Date.UTC(2026, 6, 28, 0, 0, n)).toISOString();

describe('the _global scope', () => {
  it('is a reserved id that cannot collide with a generated agent id', () => {
    expect(GLOBAL_MEMORY_SCOPE).toBe('_global');
    expect(isGlobalMemoryScope('_global')).toBe(true);
    expect(isGlobalMemoryScope('agent-ms4aagxz')).toBe(false);
    // createAgent generates `agent-<base36>`; the leading underscore is outside
    // that space, so no real agent can ever land in the global namespace.
    expect(GLOBAL_MEMORY_SCOPE.startsWith('agent-')).toBe(false);
  });

  it('builds a global note through the same normalization as an agent note', () => {
    const note = makeGlobalMemoryNote({
      type: 'preference',
      text: '  返信は日本語で  ',
      tags: ['Language', 'lang!!'],
      created: iso(0),
    });
    expect(note.agentId).toBe(GLOBAL_MEMORY_SCOPE);
    expect(note.text).toBe('返信は日本語で');
    expect(note.tags).toEqual(['language', 'lang']);
  });

  it('round-trips through the existing markdown format with no schema change', () => {
    const note = makeGlobalMemoryNote({ type: 'fact', text: 'user lives in Tokyo', created: iso(0) });
    const parsed = parseMemoryNoteMarkdown(buildMemoryNoteMarkdown(note));
    expect(parsed).not.toBeNull();
    expect(parsed!.agentId).toBe(GLOBAL_MEMORY_SCOPE);
    expect(parsed!.text).toBe('user lives in Tokyo');
  });
});

describe('merged recall across scopes', () => {
  const own: MemoryNote = makeMemoryNote({
    agentId: 'agent-a',
    type: 'result',
    text: 'yesterday the crypto digest covered ETH',
    tags: ['crypto'],
    created: iso(1),
  });
  const global: MemoryNote = makeGlobalMemoryNote({
    type: 'preference',
    text: 'always answer in Japanese',
    tags: ['language'],
    created: iso(2), // newer
  });

  // readMemoryNotesForRecall returns the union newest-first; mirror that here.
  const merged = [global, own];

  it('ranks a relevant global note above an irrelevant agent note', () => {
    const out = recallMemoryNotes(merged, 'language preference for the reply', 1);
    expect(out[0].agentId).toBe(GLOBAL_MEMORY_SCOPE);
  });

  it('still ranks a relevant agent note above an unrelated global one', () => {
    const out = recallMemoryNotes(merged, 'give me the crypto digest', 1);
    expect(out[0].agentId).toBe('agent-a');
  });

  it('can return both scopes together', () => {
    const out = recallMemoryNotes(merged, 'crypto digest in Japanese', 2);
    expect(out.map((n) => n.agentId).sort()).toEqual(['_global', 'agent-a']);
  });
});

describe('buildRecallContext with mixed scopes', () => {
  const own = makeMemoryNote({ agentId: 'agent-a', type: 'fact', text: 'agent fact', created: iso(1) });
  const global = makeGlobalMemoryNote({ type: 'preference', text: 'global pref', created: iso(2) });

  it('keeps the agent-scoped block byte-identical to before', () => {
    expect(buildRecallContext([own])).toBe(
      [
        '# Remembered context (on-device memory)',
        'These facts were saved from earlier runs or by the user. Use them if relevant.',
        '- [fact] agent fact',
      ].join('\n')
    );
  });

  it('emits shared context in its own labelled section', () => {
    const ctx = buildRecallContext([global, own]);
    expect(ctx).toContain('# Remembered context (on-device memory)');
    expect(ctx).toContain('# Shared context (applies to every agent)');
    expect(ctx).toContain('- [fact] agent fact');
    expect(ctx).toContain('- [preference] global pref');
    // The agent block comes first — this run's own context leads.
    expect(ctx.indexOf('# Remembered context')).toBeLessThan(ctx.indexOf('# Shared context'));
  });

  it('emits only the shared section when the agent has no notes of its own', () => {
    const ctx = buildRecallContext([global]);
    expect(ctx).not.toContain('# Remembered context (on-device memory)');
    expect(ctx).toContain('# Shared context (applies to every agent)');
  });

  it('is still empty for an agent with no memory at all', () => {
    expect(buildRecallContext([])).toBe('');
  });

  it('keeps the per-line format identical across scopes (MEMORY-001 parity)', () => {
    for (const line of buildRecallContext([global, own]).split('\n')) {
      if (!line.startsWith('- ')) continue;
      expect(line).toMatch(/^- \[(fact|preference|result)\] .+$/);
    }
  });
});

describe('buildGlobalRecallContext', () => {
  it('renders only global notes and ignores agent-scoped ones', () => {
    const own = makeMemoryNote({ agentId: 'agent-a', type: 'fact', text: 'agent fact', created: iso(1) });
    const global = makeGlobalMemoryNote({ type: 'fact', text: 'global fact', created: iso(2) });
    const ctx = buildGlobalRecallContext([own, global]);
    expect(ctx).toContain('- [fact] global fact');
    expect(ctx).not.toContain('agent fact');
  });

  it('is empty when there is nothing shared to say', () => {
    expect(buildGlobalRecallContext([])).toBe('');
    const own = makeMemoryNote({ agentId: 'agent-a', type: 'fact', text: 'x', created: iso(1) });
    expect(buildGlobalRecallContext([own])).toBe('');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Part 2 (2026-07-29): the WRITE entry point.
//
// Until now `_global` had a production READ path (applyMemoryAndSkills) but no
// production write path at all — writeGlobalMemoryNote had zero callers, so the
// only way to create a shared note was to seed the file by hand. These cover the
// confidence bar that guards the new NL entry point: a global note lands in
// EVERY agent's prompt, so the detector must be far harder to trip than the
// ordinary per-agent "覚えておいて" one it sits in front of.
// ─────────────────────────────────────────────────────────────────────────────

describe('detectGlobalMemoryWrite — hits', () => {
  it('recognizes the canonical JP phrasing and strips the scope clause', () => {
    const hit = detectGlobalMemoryWrite('全部のエージェントで、返信は日本語でということを覚えておいて');
    expect(hit).not.toBeNull();
    expect(hit!.type).toBe('preference');
    expect(hit!.text).not.toContain('エージェント');
    expect(hit!.text).toContain('日本語');
  });

  it.each([
    '全エージェント共通で、締切は毎週金曜だと覚えておいて',
    'すべてのエージェントで、単位はメートル法を使うことを記憶しておいて',
    'どのエージェントでも、返答は簡潔にすることを忘れないで',
    'エージェント共通の記憶として、作業ディレクトリは ~/work だとメモしておいて',
  ])('recognizes JP variant: %s', (utterance) => {
    expect(detectGlobalMemoryWrite(utterance)).not.toBeNull();
  });

  it.each([
    'remember for all agents that I prefer metric units',
    'remember this for every agent: always reply in Japanese',
    'keep in mind across all agents that my timezone is JST',
    "don't forget, for all my agents, that deploys happen on Fridays",
  ])('recognizes EN variant: %s', (utterance) => {
    expect(detectGlobalMemoryWrite(utterance)).not.toBeNull();
  });

  it('strips the EN scope phrase (including its preposition and "that")', () => {
    const hit = detectGlobalMemoryWrite('remember for all agents that I prefer metric units');
    expect(hit!.text).toBe('I prefer metric units');
  });

  it('strips a dangling "記憶として" left behind by the scope cut', () => {
    const hit = detectGlobalMemoryWrite(
      'エージェント共通の記憶として、作業ディレクトリは ~/work だとメモしておいて',
    );
    expect(hit!.text.startsWith('記憶')).toBe(false);
    expect(hit!.text).toContain('~/work');
  });

  it('is idempotent at the note level — the same fact maps to the same note id', () => {
    const a = detectGlobalMemoryWrite('全エージェントで、返信は日本語でということを覚えておいて')!;
    const b = detectGlobalMemoryWrite('すべてのエージェントで、返信は日本語でということを覚えておいて')!;
    expect(a.text).toBe(b.text);
    expect(makeGlobalMemoryNote(a).id).toBe(makeGlobalMemoryNote(b).id);
  });
});

describe('detectGlobalMemoryWrite — misses (a wrong global write is worse than a wrong per-agent one)', () => {
  it('does NOT fire on an ordinary per-agent memory request', () => {
    // No scope marker, so it must fall through untouched to the per-agent path
    // that parseAgentNL already implements.
    const utterance = '毎朝ニュースをまとめて、要点を覚えておいて';
    expect(detectGlobalMemoryWrite(utterance)).toBeNull();
    expect(parseAgentNL(utterance).memory?.remember).toBe(true);
  });

  it('does NOT fire on an all-agents command with no memory marker', () => {
    expect(detectGlobalMemoryWrite('全エージェントを今すぐ止めて')).toBeNull();
    expect(detectGlobalMemoryWrite('run all agents now')).toBeNull();
    expect(detectGlobalMemoryWrite('全部のエージェントの状態を教えて')).toBeNull();
  });

  it('does NOT fire on a negated "remember"', () => {
    expect(detectGlobalMemoryWrite("I don't remember what all agents were configured with")).toBeNull();
    expect(detectGlobalMemoryWrite('全エージェントの設定は覚えていない')).toBeNull();
  });

  it('does NOT fire on a question', () => {
    expect(detectGlobalMemoryWrite('do you remember what all agents do?')).toBeNull();
    expect(detectGlobalMemoryWrite('全エージェントで覚えておいてくれる？')).toBeNull();
  });

  it('does NOT fire when the payload is empty after the scope clause is stripped', () => {
    expect(detectGlobalMemoryWrite('全エージェントで覚えておいて')).toBeNull();
    expect(detectGlobalMemoryWrite('remember this for every agent')).toBeNull();
  });

  it('does NOT fire on a bare demonstrative whose referent this parser cannot see', () => {
    // "これ" points at an earlier message; storing the literal pronoun would put
    // a meaningless line in every agent's prompt forever.
    expect(detectGlobalMemoryWrite('これは全エージェントで覚えておいて')).toBeNull();
    expect(detectGlobalMemoryWrite('remember this for all agents: it')).toBeNull();
  });

  it('does NOT fire when the all-agents phrase is the sentence subject, not the scope', () => {
    // A musing ABOUT agents, not an instruction addressed TO all of them. The
    // adverbial-position rule (preposition / colon in EN, で・に・は in JP) is
    // what separates the two.
    expect(detectGlobalMemoryWrite('remember that every agent needs a schedule')).toBeNull();
    expect(detectGlobalMemoryWrite('全エージェントの設定をメモしておいて')).toBeNull();
  });

  it('does NOT treat the bare word "global" as an all-agents scope marker', () => {
    // The false positive this rule exists for: an ordinary note that merely
    // happens to mention a global config/variable.
    expect(detectGlobalMemoryWrite('remember to update the global config before deploying')).toBeNull();
    expect(detectGlobalMemoryWrite('グローバル変数を初期化することを覚えておいて')).toBeNull();
  });

  it('rejects empty / whitespace input', () => {
    expect(detectGlobalMemoryWrite('')).toBeNull();
    expect(detectGlobalMemoryWrite('   ')).toBeNull();
  });
});

describe('G2 secret-guard invariant through the global write path', () => {
  // DEFERRED.md's stated invariant: "globalノート内のsecretもagent別ノートと
  // 全く同じようにローカル実行を強制する". That holds because a global note is
  // stored, recalled and rendered through the SAME machinery as an agent note —
  // these assert the new entry point creates no exception to it.
  const SECRET = 'the deploy token is sk-live-ABCDEF1234567890';

  it('stores a secret verbatim (never redacted/mangled) so the route scan can see it', () => {
    const hit = detectGlobalMemoryWrite(`全エージェントで、${SECRET} ということを覚えておいて`);
    expect(hit).not.toBeNull();
    expect(hit!.text).toContain('sk-live-ABCDEF1234567890');
    expect(makeGlobalMemoryNote(hit!).text).toContain('sk-live-ABCDEF1234567890');
  });

  it('writes it into the _global namespace with the unchanged on-disk format', () => {
    const note = makeGlobalMemoryNote({ type: 'preference', text: SECRET, created: iso(0) });
    const cmd = buildMemoryWriteCommand(note);
    expect(cmd).toContain('/.shelly/agents/memory/_global/');
    // Same crash-safe shape as any agent note — no bespoke global write path.
    expect(cmd).toContain('set -e');
    expect(cmd).toContain('mkdir -p');
    expect(cmd).toMatch(/\[ -s .* \] \|\|/);
  });

  it('renders it into the run prompt through the same recall block as any note', () => {
    // applyMemoryAndSkills pools agent + global notes and feeds the rendered
    // block into the prompt BEFORE resolveAgentRoute scans it, so a secret here
    // forces the run on-device exactly like one in an agent-scoped note.
    const note = makeGlobalMemoryNote({ type: 'preference', text: SECRET, created: iso(0) });
    const ctx = buildRecallContext([note]);
    expect(ctx).toContain('# Shared context (applies to every agent)');
    expect(ctx).toContain(`- [preference] ${SECRET}`);
  });
});
