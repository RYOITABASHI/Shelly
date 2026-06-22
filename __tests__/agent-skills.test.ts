jest.mock('@/lib/home-path', () => ({
  getHomePath: () => '/home/shelly-test',
}));
jest.mock('expo-file-system/legacy', () => ({}));

import {
  buildSkillDeleteCommand,
  buildSkillInjectionContext,
  buildSkillRecipeMarkdown,
  buildSkillWriteCommand,
  bumpSkillUsage,
  distillSkillFromRun,
  makeSkillRecipe,
  matchSkillRecipes,
  parseSkillRecipeMarkdown,
  skillRecipeId,
  VAULT_SKILLS_DIR,
  type SkillRecipe,
} from '@/lib/agent-skills';
import { scanForSecrets } from '@/lib/secret-guard';

const recipe = (over: Partial<SkillRecipe> = {}): SkillRecipe =>
  makeSkillRecipe({
    name: over.name ?? 'Crypto digest',
    trigger: over.trigger ?? 'crypto market summary',
    prompt: over.prompt ?? 'Summarize the top crypto moves as 5 bullets.',
    route: over.route ?? 'on-device',
    toolLabel: over.toolLabel ?? 'Local LLM',
    tags: over.tags ?? ['crypto', 'summary'],
    successCount: over.successCount ?? 1,
    created: over.created ?? '2026-06-22T00:00:00.000Z',
    lastUsed: over.lastUsed ?? '2026-06-22T00:00:00.000Z',
  });

describe('skill recipe id', () => {
  it('is stable and idempotent for the same name+trigger', () => {
    expect(skillRecipeId('A', 'b c')).toBe(skillRecipeId(' A ', ' b c '));
  });
  it('differs by name or trigger', () => {
    expect(skillRecipeId('A', 'x')).not.toBe(skillRecipeId('B', 'x'));
    expect(skillRecipeId('A', 'x')).not.toBe(skillRecipeId('A', 'y'));
  });
});

describe('markdown roundtrip', () => {
  it('build → parse preserves the recipe', () => {
    const r = recipe({ successCount: 4 });
    const parsed = parseSkillRecipeMarkdown(buildSkillRecipeMarkdown(r));
    expect(parsed).not.toBeNull();
    expect(parsed!.name).toBe('Crypto digest');
    expect(parsed!.trigger).toBe('crypto market summary');
    expect(parsed!.route).toBe('on-device');
    expect(parsed!.toolLabel).toBe('Local LLM');
    expect(parsed!.tags).toEqual(['crypto', 'summary']);
    expect(parsed!.successCount).toBe(4);
    expect(parsed!.prompt).toContain('5 bullets');
  });
  it('rejects malformed recipes', () => {
    expect(parseSkillRecipeMarkdown('no frontmatter')).toBeNull();
    expect(parseSkillRecipeMarkdown('---\nname: x\n---\n')).toBeNull(); // no trigger/body
  });
});

describe('buildSkillWriteCommand', () => {
  it('is crash-safe: set -e, mkdir, heredoc, verified [ -s ], Vault mirror', () => {
    const cmd = buildSkillWriteCommand(recipe());
    expect(cmd).toContain('set -e');
    expect(cmd).toContain(`mkdir -p '/home/shelly-test/.shelly/agents/skills'`);
    expect(cmd).toMatch(/<<'SHELLY_SKILL_/);
    expect(cmd).toMatch(/\[ -s '.*\.md' \]/);
    expect(cmd).toContain('exit 1');
    expect(cmd).toContain(VAULT_SKILLS_DIR);
    expect(cmd).toContain('|| true');
  });
  it('refuses unsafe ids', () => {
    expect(() => buildSkillWriteCommand({ ...recipe(), id: '../../etc' })).toThrow(/unsafe id/);
    expect(() => buildSkillDeleteCommand('../../etc')).toThrow(/unsafe id/);
  });
});

describe('matchSkillRecipes — conservative reuse', () => {
  const recipes = [
    recipe({ name: 'Crypto', trigger: 'crypto market summary', tags: ['crypto'] }),
    recipe({ name: 'Weather', trigger: 'weather forecast tokyo', tags: ['weather'] }),
  ];
  it('returns a strong match', () => {
    const out = matchSkillRecipes('give me a crypto market summary', recipes);
    expect(out[0].name).toBe('Crypto');
  });
  it('returns nothing when below the score threshold (no recency fallback)', () => {
    expect(matchSkillRecipes('completely unrelated zzz qqq', recipes)).toEqual([]);
  });
  it('respects empty input', () => {
    expect(matchSkillRecipes('crypto', [])).toEqual([]);
  });
});

describe('buildSkillInjectionContext', () => {
  it('returns empty for null', () => {
    expect(buildSkillInjectionContext(null)).toBe('');
  });
  it('includes the recipe under a reusable-skill header', () => {
    const ctx = buildSkillInjectionContext(recipe({ successCount: 3 }));
    expect(ctx).toContain('Reusable skill');
    expect(ctx).toContain('3×');
    expect(ctx).toContain('5 bullets');
  });
});

describe('distill + bump', () => {
  it('distills a run into a recipe with route/tool from the decision', () => {
    const r = distillSkillFromRun({
      name: 'News',
      taskText: 'summarize the morning news briefly',
      prompt: 'Summarize the morning news in 3 bullets.',
      routeDecision: { route: 'cloud', toolType: 'gemini-api', toolLabel: 'Gemini API', guard: 'default', why: '' },
      timestamp: Date.UTC(2026, 5, 22),
    });
    expect(r.route).toBe('cloud');
    expect(r.toolLabel).toBe('Gemini API');
    expect(r.trigger.length).toBeGreaterThan(0);
    expect(r.successCount).toBe(1);
  });
  it('bumpSkillUsage increments count and keeps the same id', () => {
    const r = recipe({ successCount: 2 });
    const bumped = bumpSkillUsage(r, Date.UTC(2026, 5, 23));
    expect(bumped.successCount).toBe(3);
    expect(bumped.id).toBe(r.id);
  });
});

describe('skill recipes never silently leak secrets to cloud', () => {
  it('a secret inside an injected skill is visible to secret-guard via the run prompt', () => {
    const ctx = buildSkillInjectionContext(
      recipe({ prompt: 'use token sk-ant-api03-AAAABBBBCCCCDDDDEEEE then summarize' })
    );
    const effectivePrompt = `${ctx}\n\n---\n\nSummarize the news`;
    expect(scanForSecrets(effectivePrompt).hasSecret).toBe(true);
  });
});
