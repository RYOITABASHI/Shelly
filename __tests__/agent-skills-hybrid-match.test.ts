// matchSkillRecipesHybrid with MEMORY_EMBEDDING_ENABLED forced on, so these
// tests exercise the embedding re-rank path (lib/agent-skills.ts) regardless
// of the flag's production value. The mock is kept even though the shipped
// flag is now also true (flipped 2026-08-05) — it makes this file's
// assumption explicit and keeps it green if the flag is ever rolled back.
// __tests__/agent-skills.test.ts deliberately does NOT mock lib/memory/wiring
// and covers the real-flag degradation path (single qualifying candidate →
// no embed call) instead.
jest.mock('@/lib/home-path', () => ({
  getHomePath: () => '/home/shelly-test',
}));
jest.mock('expo-file-system/legacy', () => ({}));
jest.mock('@/lib/memory/wiring', () => ({
  ...jest.requireActual('@/lib/memory/wiring'),
  MEMORY_EMBEDDING_ENABLED: true,
}));

import { makeSkillRecipe, matchSkillRecipes, matchSkillRecipesHybrid, type SkillRecipe } from '@/lib/agent-skills';
import type { EmbeddingPort } from '@/lib/memory/types';

const recipe = (over: Partial<SkillRecipe> & { trigger: string; tags: string[] }): SkillRecipe =>
  makeSkillRecipe({
    name: over.name ?? 'skill',
    trigger: over.trigger,
    prompt: over.prompt ?? 'do the thing',
    route: over.route ?? 'on-device',
    toolLabel: over.toolLabel ?? 'Local LLM',
    tags: over.tags,
    successCount: over.successCount ?? 1,
    created: '2026-08-04T00:00:00.000Z',
    lastUsed: '2026-08-04T00:00:00.000Z',
  });

/** Fixed lookup table keyed by the EXACT text matchSkillRecipesHybrid embeds
 *  (taskText, then each candidate's `${trigger} ${tags.join(' ')}`) — lets a
 *  test pin cosine ordering deterministically, same pattern as
 *  __tests__/memory/embedding.test.ts's fakePort. */
function fakePort(table: Record<string, number[]>): EmbeddingPort {
  return {
    async embed(texts: string[]): Promise<number[][]> {
      return texts.map((t) => table[t] ?? [0, 0, 0]);
    },
  };
}

describe('matchSkillRecipesHybrid — embedding re-rank (MEMORY_EMBEDDING_ENABLED=true)', () => {
  const taskText = 'i need to reset something support please';
  // Both recipes overlap the task on exactly the same tokens ("reset" +
  // the "support" tag), so they TIE on bigram score — the only thing that
  // differs is a filler word, which only shows up in the embedding text.
  const recipeA = recipe({
    name: 'Password reset',
    trigger: 'reset password blahblah',
    tags: ['support'],
    successCount: 1, // deliberately the WEAKER bigram tiebreak signal
  });
  const recipeB = recipe({
    name: 'Billing reset',
    trigger: 'reset billing zzzqqq',
    tags: ['support'],
    successCount: 5, // deliberately the STRONGER bigram tiebreak signal
  });

  it('sanity check: the two recipes really do tie on bigram score alone', () => {
    // Without a real tie, the re-rank test below would be meaningless.
    const bigramOnly = matchSkillRecipes(taskText, [recipeA, recipeB]);
    // successCount tiebreak puts the higher-successCount recipe first when
    // bigram scores are equal.
    expect(bigramOnly.map((r) => r.name)).toEqual(['Billing reset', 'Password reset']);
  });

  it('re-ranks tied bigram candidates by embedding cosine similarity, ahead of successCount', async () => {
    const port = fakePort({
      [taskText]: [1, 0, 0],
      'reset password blahblah support': [0.95, 0.05, 0], // near-parallel -> high cosine
      'reset billing zzzqqq support': [0, 1, 0], // orthogonal -> zero cosine
    });
    const hybrid = await matchSkillRecipesHybrid(taskText, [recipeA, recipeB], { embeddingPort: port });
    // Semantic similarity flips the order relative to the bigram-only
    // successCount tiebreak proven above.
    expect(hybrid.map((r) => r.name)).toEqual(['Password reset', 'Billing reset']);
  });

  it('falls back to the exact bigram-only ordering when embed() throws', async () => {
    const failingPort: EmbeddingPort = {
      embed: async () => {
        throw new Error('local LLM not running');
      },
    };
    const hybrid = await matchSkillRecipesHybrid(taskText, [recipeA, recipeB], { embeddingPort: failingPort });
    const bigramOnly = matchSkillRecipes(taskText, [recipeA, recipeB]);
    expect(hybrid.map((r) => r.id)).toEqual(bigramOnly.map((r) => r.id));
  });

  it('falls back to bigram-only ordering when embed() times out (never resolves in time)', async () => {
    const hangingPort: EmbeddingPort = {
      // Simulates a real timeout: the caller's embeddingPort is expected to
      // enforce its own short timeout (see DEFAULT_EMBEDDING_TIMEOUT_MS in
      // lib/memory/embedding-llama.ts) and reject rather than hang forever;
      // this fake models that contract directly instead of waiting on a
      // real timer in the test.
      embed: async () => {
        throw new Error('embedding request timed out');
      },
    };
    const hybrid = await matchSkillRecipesHybrid(taskText, [recipeA, recipeB], { embeddingPort: hangingPort });
    expect(hybrid.map((r) => r.id)).toEqual(matchSkillRecipes(taskText, [recipeA, recipeB]).map((r) => r.id));
  });

  it('falls back to bigram-only ordering when embed() returns a mismatched vector count', async () => {
    const malformedPort: EmbeddingPort = {
      embed: async (texts: string[]) => texts.slice(0, texts.length - 1).map(() => [1, 0, 0]),
    };
    const hybrid = await matchSkillRecipesHybrid(taskText, [recipeA, recipeB], { embeddingPort: malformedPort });
    expect(hybrid.map((r) => r.id)).toEqual(matchSkillRecipes(taskText, [recipeA, recipeB]).map((r) => r.id));
  });

  it('never surfaces a recipe that fails the bigram pre-filter, no matter how "similar" its embedding is', async () => {
    const unrelated = recipe({ name: 'Unrelated', trigger: 'zzz totally unrelated qqq', tags: ['nope'] });
    const port = fakePort({
      [taskText]: [1, 0, 0],
      'reset password blahblah support': [0.9, 0.1, 0],
      'reset billing zzzqqq support': [0.1, 0.9, 0],
      // If the pre-filter were bypassed, this would win every re-rank —
      // it must never even reach embed() as a candidate.
      'zzz totally unrelated qqq nope': [1, 0, 0],
    });
    const hybrid = await matchSkillRecipesHybrid(taskText, [recipeA, recipeB, unrelated], { embeddingPort: port });
    expect(hybrid.map((r) => r.name)).not.toContain('Unrelated');
    expect(hybrid).toHaveLength(2);
  });

  it('skips the embedding call entirely for a single qualifying candidate (nothing to re-rank)', async () => {
    const soleMatch = recipe({ name: 'Solo', trigger: 'reset support', tags: ['support'] });
    const port: EmbeddingPort = { embed: jest.fn(async (texts: string[]) => texts.map(() => [1, 0, 0])) };
    const hybrid = await matchSkillRecipesHybrid(taskText, [soleMatch], { embeddingPort: port });
    expect(hybrid.map((r) => r.name)).toEqual(['Solo']);
    expect(port.embed).not.toHaveBeenCalled();
  });

  it('falls back to bigram-only when no embeddingPort is injected, even with the flag on', async () => {
    const hybrid = await matchSkillRecipesHybrid(taskText, [recipeA, recipeB]);
    expect(hybrid.map((r) => r.id)).toEqual(matchSkillRecipes(taskText, [recipeA, recipeB]).map((r) => r.id));
  });
});
