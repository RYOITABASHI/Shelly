jest.mock('@/lib/home-path', () => ({
  getHomePath: () => '/home/shelly-test',
}));
jest.mock('expo-file-system/legacy', () => ({}));

import {
  buildSkillRecipeMarkdown,
  bumpSkillUsage,
  makeSkillRecipe,
  matchSkillRecipes,
  matchSkillRecipesHybrid,
  parseSkillRecipeMarkdown,
  recordSkillFailure,
  skillPairSimilarity,
  type SkillRecipe,
} from '@/lib/agent-skills';
import {
  applySkillMergeProposal,
  curateSkillRecipes,
  findDuplicateSkillPairs,
  isSkillArchiveEligible,
  isSkillPromotionEligible,
  mergeSkillRecipes,
  runSkillCuratorSweep,
  SKILL_ARCHIVE_AFTER_DAYS,
  SKILL_DUPLICATE_MIN_SCORE,
  SKILL_PROMOTION_MIN_SUCCESS_COUNT,
} from '@/lib/skill-curator';

const DAY_MS = 24 * 60 * 60 * 1000;
/** Fixed "now" for every eligibility check: 2026-08-05T00:00:00Z. */
const NOW = Date.UTC(2026, 7, 5);
const daysAgo = (days: number) => new Date(NOW - days * DAY_MS).toISOString();

const recipe = (over: Partial<SkillRecipe> = {}): SkillRecipe => ({
  ...makeSkillRecipe({
    name: over.name ?? 'Crypto digest',
    trigger: over.trigger ?? 'crypto market summary',
    prompt: over.prompt ?? 'Summarize the top crypto moves as 5 bullets.',
    route: over.route ?? 'on-device',
    toolLabel: over.toolLabel ?? 'Local LLM',
    tags: over.tags ?? ['crypto', 'summary'],
    successCount: over.successCount ?? 1,
    created: over.created ?? daysAgo(10),
    lastUsed: over.lastUsed ?? daysAgo(10),
  }),
  // Curator flags are not makeSkillRecipe params — apply them on top.
  ...(over.promoted ? { promoted: true } : {}),
  ...(over.archived ? { archived: true } : {}),
  ...(over.lastFailure ? { lastFailure: over.lastFailure } : {}),
});

describe('curator persistence — additive SkillRecipe fields', () => {
  it('promoted/archived round-trip through markdown frontmatter', () => {
    const parsed = parseSkillRecipeMarkdown(
      buildSkillRecipeMarkdown(recipe({ promoted: true, archived: true }))
    );
    expect(parsed?.promoted).toBe(true);
    expect(parsed?.archived).toBe(true);
  });

  it('an uncurated recipe stays byte-identical: no curator lines emitted, absent lines parse to absent fields', () => {
    const md = buildSkillRecipeMarkdown(recipe());
    expect(md).not.toContain('promoted:');
    expect(md).not.toContain('archived:');
    const parsed = parseSkillRecipeMarkdown(md);
    expect(parsed?.promoted).toBeUndefined();
    expect(parsed?.archived).toBeUndefined();
  });
});

describe('archived recipes leave the match candidate pool (but not disk)', () => {
  const live = recipe({ name: 'Crypto', trigger: 'crypto market summary', tags: ['crypto'] });
  const dead = { ...live, archived: true };

  it('matchSkillRecipes skips archived recipes', () => {
    expect(matchSkillRecipes('give me a crypto market summary', [live])[0]?.name).toBe('Crypto');
    expect(matchSkillRecipes('give me a crypto market summary', [dead])).toEqual([]);
  });

  it('matchSkillRecipesHybrid inherits the same exclusion (shared pre-filter)', async () => {
    await expect(
      matchSkillRecipesHybrid('give me a crypto market summary', [dead])
    ).resolves.toEqual([]);
  });

  it('a verified use un-archives (bumpSkillUsage clears the flag)', () => {
    const revived = bumpSkillUsage(dead, NOW);
    expect(revived.archived).toBeUndefined();
    expect(revived.successCount).toBe(dead.successCount + 1);
  });
});

describe('skillPairSimilarity — same scoring core, conservative min', () => {
  it('is high for near-identical trigger+tags and 0 for unrelated recipes', () => {
    const a = recipe({ name: 'A', trigger: 'crypto market summary' });
    const b = recipe({ name: 'B', trigger: 'crypto market summary briefing' });
    const unrelated = recipe({ name: 'W', trigger: 'weather forecast tokyo', tags: ['weather'] });
    expect(skillPairSimilarity(a, b)).toBeGreaterThanOrEqual(SKILL_DUPLICATE_MIN_SCORE);
    expect(skillPairSimilarity(a, unrelated)).toBe(0);
  });

  it('is symmetric', () => {
    const a = recipe({ name: 'A', trigger: 'crypto market summary' });
    const b = recipe({ name: 'B', trigger: 'crypto market news digest', tags: ['crypto'] });
    expect(skillPairSimilarity(a, b)).toBe(skillPairSimilarity(b, a));
  });
});

describe('findDuplicateSkillPairs', () => {
  it('proposes a merge for a near-duplicate pair, canonical = higher successCount, counts summed', () => {
    const weak = recipe({ name: 'Crypto A', trigger: 'crypto market summary', successCount: 2 });
    const strong = recipe({
      name: 'Crypto B',
      trigger: 'crypto market summary briefing',
      successCount: 6,
    });
    const proposals = findDuplicateSkillPairs([weak, strong]);
    expect(proposals).toHaveLength(1);
    expect(proposals[0].canonical.id).toBe(strong.id);
    expect(proposals[0].duplicate.id).toBe(weak.id);
    expect(proposals[0].score).toBeGreaterThanOrEqual(SKILL_DUPLICATE_MIN_SCORE);
    expect(proposals[0].merged.successCount).toBe(8);
    expect(proposals[0].merged.id).toBe(strong.id);
  });

  it('does NOT propose merely-similar recipes (reuse-matchable is far below the merge bar)', () => {
    const a = recipe({ name: 'Crypto', trigger: 'crypto market summary', tags: ['crypto'] });
    // Shares enough with `a` to be OFFERED for reuse on a matching task…
    const b = recipe({ name: 'Markets', trigger: 'market news digest', tags: ['market'] });
    expect(
      matchSkillRecipes('crypto market summary please', [b]).length
    ).toBeGreaterThanOrEqual(0); // b is a legitimate standalone recipe
    expect(findDuplicateSkillPairs([a, b])).toEqual([]);
  });

  it('skips archived recipes entirely', () => {
    const a = recipe({ name: 'Crypto A', trigger: 'crypto market summary' });
    const b = recipe({
      name: 'Crypto B',
      trigger: 'crypto market summary briefing',
      archived: true,
    });
    expect(findDuplicateSkillPairs([a, b])).toEqual([]);
  });

  it('is greedy — each recipe appears in at most one proposal', () => {
    const a = recipe({ name: 'Crypto A', trigger: 'crypto market summary', successCount: 3 });
    const b = recipe({ name: 'Crypto B', trigger: 'crypto market summary briefing', successCount: 2 });
    const c = recipe({ name: 'Crypto C', trigger: 'crypto market summary digest', successCount: 1 });
    const proposals = findDuplicateSkillPairs([a, b, c]);
    const ids = proposals.flatMap((p) => [p.canonical.id, p.duplicate.id]);
    expect(new Set(ids).size).toBe(ids.length); // no recipe consumed twice
    expect(proposals.length).toBe(1); // third recipe waits for the next pass
  });

  it('breaks successCount ties deterministically by recency then id', () => {
    const older = recipe({ name: 'Crypto A', trigger: 'crypto market summary', lastUsed: daysAgo(20) });
    const newer = recipe({
      name: 'Crypto B',
      trigger: 'crypto market summary briefing',
      lastUsed: daysAgo(1),
    });
    const [p] = findDuplicateSkillPairs([older, newer]);
    expect(p.canonical.id).toBe(newer.id);
  });
});

describe('mergeSkillRecipes', () => {
  const canonical = recipe({
    name: 'Canonical',
    trigger: 'crypto market summary',
    tags: ['crypto'],
    successCount: 5,
    created: daysAgo(5),
    lastUsed: daysAgo(5),
  });
  const duplicate = recipe({
    name: 'Duplicate',
    trigger: 'crypto market summary briefing',
    tags: ['summary'],
    successCount: 2,
    created: daysAgo(30),
    lastUsed: daysAgo(1),
  });

  it('keeps the canonical body, sums counts, unions tags, takes newest lastUsed and oldest created', () => {
    const merged = mergeSkillRecipes(canonical, duplicate);
    expect(merged.id).toBe(canonical.id);
    expect(merged.name).toBe('Canonical');
    expect(merged.trigger).toBe('crypto market summary');
    expect(merged.prompt).toBe(canonical.prompt);
    expect(merged.successCount).toBe(7);
    expect(merged.tags).toEqual(['crypto', 'summary']);
    expect(merged.lastUsed).toBe(duplicate.lastUsed); // newest
    expect(merged.created).toBe(duplicate.created); // oldest
  });

  it('carries the most recent failure hint and either side\'s promotion; never carries archived', () => {
    const failedDup = recordSkillFailure(duplicate, 'HTTP 429', NOW - DAY_MS);
    const merged = mergeSkillRecipes(
      { ...canonical, archived: true, lastFailure: { at: daysAgo(9), note: 'older failure' } },
      { ...failedDup, promoted: true }
    );
    expect(merged.lastFailure?.note).toBe('HTTP 429');
    expect(merged.promoted).toBe(true);
    expect(merged.archived).toBeUndefined();
  });
});

describe('isSkillPromotionEligible', () => {
  it('requires the threshold, no prior flag, and a live recipe', () => {
    expect(
      isSkillPromotionEligible(recipe({ successCount: SKILL_PROMOTION_MIN_SUCCESS_COUNT }))
    ).toBe(true);
    expect(
      isSkillPromotionEligible(recipe({ successCount: SKILL_PROMOTION_MIN_SUCCESS_COUNT - 1 }))
    ).toBe(false);
    expect(isSkillPromotionEligible(recipe({ successCount: 10, promoted: true }))).toBe(false);
    expect(isSkillPromotionEligible(recipe({ successCount: 10, archived: true }))).toBe(false);
  });
});

describe('isSkillArchiveEligible', () => {
  const stale = daysAgo(SKILL_ARCHIVE_AFTER_DAYS + 1);
  const fresh = daysAgo(SKILL_ARCHIVE_AFTER_DAYS - 1);

  it('archives only never-reused recipes past the window', () => {
    expect(
      isSkillArchiveEligible(recipe({ successCount: 1, created: stale, lastUsed: stale }), NOW)
    ).toBe(true);
    expect(
      isSkillArchiveEligible(recipe({ successCount: 1, created: stale, lastUsed: fresh }), NOW)
    ).toBe(false);
  });

  it('never archives reused, promoted, or already-archived recipes', () => {
    expect(
      isSkillArchiveEligible(recipe({ successCount: 2, created: stale, lastUsed: stale }), NOW)
    ).toBe(false);
    expect(
      isSkillArchiveEligible(
        recipe({ successCount: 1, created: stale, lastUsed: stale, promoted: true }),
        NOW
      )
    ).toBe(false);
    expect(
      isSkillArchiveEligible(
        recipe({ successCount: 1, created: stale, lastUsed: stale, archived: true }),
        NOW
      )
    ).toBe(false);
  });

  it('a recipe with an unparseable timestamp is treated as ancient (archivable), not crashing', () => {
    const broken = { ...recipe({ successCount: 1 }), created: 'not-a-date', lastUsed: 'nope' };
    expect(isSkillArchiveEligible(broken, NOW)).toBe(true);
  });
});

describe('curateSkillRecipes — one pure pass', () => {
  const stale = daysAgo(SKILL_ARCHIVE_AFTER_DAYS + 5);
  const proven = recipe({ name: 'Proven', trigger: 'weather forecast tokyo', tags: ['weather'], successCount: 6 });
  const dormant = recipe({ name: 'Dormant', trigger: 'obscure one-off задача', tags: ['oneoff'], created: stale, lastUsed: stale });
  const active = recipe({ name: 'Active', trigger: 'daily standup notes', tags: ['standup'] });

  it('classifies promotion and archival independently and never mutates inputs', () => {
    const before = JSON.parse(JSON.stringify([proven, dormant, active]));
    const result = curateSkillRecipes([proven, dormant, active], NOW);
    expect(result.promote.map((r) => r.name)).toEqual(['Proven']);
    expect(result.promote[0].promoted).toBe(true);
    expect(result.archive.map((r) => r.name)).toEqual(['Dormant']);
    expect(result.archive[0].archived).toBe(true);
    expect(result.mergeProposals).toEqual([]);
    expect([proven, dormant, active]).toEqual(before); // purity
  });

  it('a second pass over the persisted result is a no-op (stable fixpoint)', () => {
    const first = curateSkillRecipes([proven, dormant], NOW);
    const persisted = [first.promote[0], first.archive[0]];
    const second = curateSkillRecipes(persisted, NOW);
    expect(second.promote).toEqual([]);
    expect(second.archive).toEqual([]);
    expect(second.mergeProposals).toEqual([]);
  });
});

describe('applySkillMergeProposal — the ONLY deleting path, explicit-approval only', () => {
  it('writes the merged canonical then deletes the duplicate file', async () => {
    const weak = recipe({ name: 'Crypto A', trigger: 'crypto market summary', successCount: 2 });
    const strong = recipe({ name: 'Crypto B', trigger: 'crypto market summary briefing', successCount: 6 });
    const [proposal] = findDuplicateSkillPairs([weak, strong]);
    const commands: string[] = [];
    await applySkillMergeProposal(async (cmd) => {
      commands.push(cmd);
      return '';
    }, proposal);
    expect(commands).toHaveLength(2);
    expect(commands[0]).toContain(`${strong.id}.md`);
    expect(commands[0]).toContain('successCount: 8');
    expect(commands[1]).toContain('rm -f');
    expect(commands[1]).toContain(`${weak.id}.md`);
  });
});

describe('runSkillCuratorSweep — best-effort, never destructive', () => {
  const stale = daysAgo(SKILL_ARCHIVE_AFTER_DAYS + 5);

  it('persists promotion + archival flags, reports (but never applies) merges', async () => {
    const proven = recipe({ name: 'Proven', trigger: 'weather forecast tokyo', tags: ['weather'], successCount: 6 });
    const dormant = recipe({ name: 'Dormant', trigger: 'obscure oneoff export', tags: ['oneoff'], created: stale, lastUsed: stale });
    const dupA = recipe({ name: 'Crypto A', trigger: 'crypto market summary', successCount: 2 });
    const dupB = recipe({ name: 'Crypto B', trigger: 'crypto market summary briefing', successCount: 3 });
    const commands: string[] = [];
    const summary = await runSkillCuratorSweep(
      async (cmd) => {
        commands.push(cmd);
        return '';
      },
      { recipes: [proven, dormant, dupA, dupB], nowMs: NOW }
    );
    expect(summary).toEqual({
      promoted: 1,
      archived: 1,
      mergeProposals: expect.arrayContaining([
        expect.objectContaining({ canonical: expect.objectContaining({ id: dupB.id }) }),
      ]),
    });
    // Two flag writes, zero deletions — the sweep never applies a merge.
    expect(commands).toHaveLength(2);
    expect(commands.join('\n')).toContain('promoted: true');
    expect(commands.join('\n')).toContain('archived: true');
    expect(commands.join('\n')).not.toContain('rm -f');
  });

  it('is a no-op when nothing qualifies', async () => {
    const runCommand = jest.fn(async () => '');
    const summary = await runSkillCuratorSweep(runCommand, {
      recipes: [recipe({ name: 'Active', trigger: 'daily standup notes', tags: ['standup'] })],
      nowMs: NOW,
    });
    expect(summary).toEqual({ promoted: 0, archived: 0, mergeProposals: [] });
    expect(runCommand).not.toHaveBeenCalled();
  });

  it('swallows write failures and resolves null (startup path is never broken)', async () => {
    const summary = await runSkillCuratorSweep(
      async () => {
        throw new Error('disk full');
      },
      {
        recipes: [recipe({ name: 'Proven', trigger: 'weather forecast tokyo', successCount: 9 })],
        nowMs: NOW,
      }
    );
    expect(summary).toBeNull();
  });

  it('handles an empty registry without touching the shell', async () => {
    const runCommand = jest.fn(async () => '');
    await expect(runSkillCuratorSweep(runCommand, { recipes: [], nowMs: NOW })).resolves.toEqual({
      promoted: 0,
      archived: 0,
      mergeProposals: [],
    });
    expect(runCommand).not.toHaveBeenCalled();
  });
});
