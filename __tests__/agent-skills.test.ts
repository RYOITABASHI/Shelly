jest.mock('@/lib/home-path', () => ({
  getHomePath: () => '/home/shelly-test',
}));
jest.mock('expo-file-system/legacy', () => ({}));

import {
  buildSkillDeleteCommand,
  applyExecutableSkillPlan,
  buildSkillInjectionContext,
  buildSkillRecipeMarkdown,
  buildSkillWriteCommand,
  bumpSkillUsage,
  deriveTrigger,
  distillSkillFromRun,
  makeSkillRecipe,
  matchSkillRecipes,
  matchSkillRecipesHybrid,
  parseSkillRecipeMarkdown,
  recordSkillFailure,
  skillRecipeId,
  VAULT_SKILLS_DIR,
  type SkillRecipe,
} from '@/lib/agent-skills';
import type { AgentPlanSpecV1 } from '@/lib/agent-plan-spec';
import type { Agent } from '@/store/types';
import { scanForSecrets } from '@/lib/secret-guard';
import type { EmbeddingPort } from '@/lib/memory/types';

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
    planSpec: over.planSpec,
  });

const executablePlan = {
  kind: 'shelly.agent.plan',
  schemaVersion: 1,
  generatedAt: Date.UTC(2026, 6, 28),
  agent: { id: 'source', name: 'Source', autonomous: false, autonomyLevel: 'L2' },
  prompt: 'old task',
  tool: { type: 'groq', label: 'Groq', model: 'llama-3.3-70b-versatile', authRef: 'groq' },
  action: { type: 'draft' },
  paths: { home: '/home', envFile: '', tmpDir: '', locksDir: '', logsDir: '', resultFile: '', lockFile: '', logDir: '' },
  output: { outputDir: '/out', outputNameTemplate: '', slug: 'source', useGlobalOutput: true, suggestedRoots: [] },
  limits: { timeoutSeconds: 600, maxConcurrent: 2, charLimit: 280 },
  policy: {} as AgentPlanSpecV1['policy'],
  routeDecision: { route: 'cloud', toolType: 'groq', toolLabel: 'Groq', guard: 'configured-tool', why: '' },
  steps: {
    list: [{ instruction: 'collect sources' }, { instruction: 'write summary' }],
    budget: { maxSteps: 2, totalTimeoutMs: 120_000 },
  },
} as AgentPlanSpecV1;

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

  it('round-trips an executable multi-step PlanSpec payload', () => {
    const parsed = parseSkillRecipeMarkdown(
      buildSkillRecipeMarkdown(recipe({ planSpec: executablePlan })),
    );
    expect(parsed?.planSpec?.steps?.list.map((step) => step.instruction)).toEqual([
      'collect sources',
      'write summary',
    ]);
    expect(parsed?.prompt).toContain('5 bullets');
  });
});

describe('executable PlanSpec reuse', () => {
  it('rehydrates steps/provider/charLimit while preserving the new task and action', () => {
    const agent = {
      id: 'future',
      name: 'Future task',
      description: '',
      prompt: 'Summarize this new topic',
      schedule: null,
      tool: { type: 'local' },
      outputPath: '/out',
      outputTemplate: null,
      action: { type: 'notify' },
      enabled: true,
      lastRun: null,
      lastResult: null,
      createdAt: 1,
      version: 1,
    } as Agent;
    const reused = applyExecutableSkillPlan(agent, recipe({ planSpec: executablePlan }));

    expect(reused.prompt).toBe(agent.prompt);
    expect(reused.action).toEqual({ type: 'notify' });
    expect(reused.tool).toEqual({ type: 'groq', model: 'llama-3.3-70b-versatile' });
    expect(reused.orchestration).toEqual({
      steps: [
        { instruction: 'collect sources' },
        { instruction: 'write summary' },
      ],
      maxSteps: 2,
      totalTimeoutMs: 120_000,
      charLimit: 280,
    });
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

  it('matches a similar Japanese task via CJK bigrams (no word spaces)', () => {
    const jp = [
      recipe({ name: 'mem-test', trigger: '私は簡潔な箇条書き要約が好みだと覚えておいて', tags: [] }),
    ];
    const out = matchSkillRecipes('ニュースを簡潔な箇条書きで要約', jp);
    expect(out).toHaveLength(1);
    expect(out[0].name).toBe('mem-test');
    // An unrelated Japanese task must not match.
    expect(matchSkillRecipes('明日の天気を教えて', jp)).toEqual([]);
  });

  // 2026-08-24 Fable5 product review, real on-device false positive: a
  // WEATHER agent's registration draft reported "Reuses the existing skill
  // 'draft one short haiku'". Both trigger and tags for a short, generic
  // task like this are just its own raw tokens verbatim ("draft", "one",
  // "short", "haiku") with no salience weighting, so generic-word overlap
  // alone could clear MIN_SKILL_MATCH_SCORE against an unrelated task.
  it('does not reuse a short generic-word skill for an unrelated task (2026-08-24 false-positive repro)', () => {
    const haiku = [
      recipe({
        name: 'draft one short haiku',
        trigger: deriveTrigger('draft one short haiku'),
        tags: [...deriveTrigger('draft one short haiku').split(' ')],
      }),
    ];
    expect(matchSkillRecipes('every morning at 7 check the weather and tell me', haiku)).toEqual([]);
    expect(matchSkillRecipes('毎朝8時に天気を確認して教えて', haiku)).toEqual([]);
    // The skill still matches a genuinely similar request — the fix must not
    // make matching impossible, only stop generic-word false positives.
    expect(matchSkillRecipes('draft another short haiku for me', haiku)).not.toEqual([]);
  });

  it('deriveTrigger excludes generic filler words, keeping the distinctive ones', () => {
    expect(deriveTrigger('draft one short haiku')).toBe('haiku');
    expect(deriveTrigger('every morning check the weather and tell me')).not.toContain('tell');
    expect(deriveTrigger('every morning check the weather and tell me')).toContain('weather');
  });
});

describe('matchSkillRecipesHybrid — real production flag state (MEMORY_EMBEDDING_ENABLED on since 2026-08-05)', () => {
  // This file does NOT mock lib/memory/wiring, so MEMORY_EMBEDDING_ENABLED is
  // whatever it really is in wiring.ts today (true since the 2026-08-05
  // flip). These tests prove the hybrid matcher stays byte-identical to the
  // plain bigram matcher under the actual shipped flag state whenever there
  // is nothing to re-rank: here only ONE recipe ever clears the bigram
  // pre-filter (the Weather recipe shares no tokens with the crypto task),
  // and a single qualifying candidate skips the embedding call entirely —
  // i.e. the "additive, never a hard dependency" contract holds without
  // needing to mock anything. The actual re-rank behavior (ties, throwing/
  // hanging/malformed ports) lives in agent-skills-hybrid-match.test.ts.
  const recipes = [
    recipe({ name: 'Crypto', trigger: 'crypto market summary', tags: ['crypto'] }),
    recipe({ name: 'Weather', trigger: 'weather forecast tokyo', tags: ['weather'] }),
  ];
  const neverCalledPort: EmbeddingPort = {
    embed: jest.fn(async () => {
      throw new Error('must not be called when fewer than 2 candidates clear the bigram pre-filter');
    }),
  };

  it('returns exactly matchSkillRecipes\' output, port injected or not', async () => {
    const expected = matchSkillRecipes('give me a crypto market summary', recipes);
    await expect(
      matchSkillRecipesHybrid('give me a crypto market summary', recipes),
    ).resolves.toEqual(expected);
    await expect(
      matchSkillRecipesHybrid('give me a crypto market summary', recipes, {
        embeddingPort: neverCalledPort,
      }),
    ).resolves.toEqual(expected);
    expect(neverCalledPort.embed).not.toHaveBeenCalled();
  });

  it('still returns nothing below the bigram score threshold', async () => {
    await expect(
      matchSkillRecipesHybrid('completely unrelated zzz qqq', recipes, {
        embeddingPort: neverCalledPort,
      }),
    ).resolves.toEqual([]);
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

describe('learning loop — failure hints (2026-08-03)', () => {
  it('recordSkillFailure flattens newlines, collapses whitespace, and caps the note', () => {
    const failed = recordSkillFailure(
      recipe(),
      `line one\nline   two\r\n${'x'.repeat(400)}`,
      Date.UTC(2026, 7, 3),
    );
    expect(failed.lastFailure).toBeDefined();
    expect(failed.lastFailure!.at).toBe('2026-08-03T00:00:00.000Z');
    expect(failed.lastFailure!.note).toContain('line one line two');
    expect(failed.lastFailure!.note).not.toContain('\n');
    expect(failed.lastFailure!.note.length).toBeLessThanOrEqual(200);
    // The recipe body and verified history are untouched — no auto-rewrite.
    expect(failed.prompt).toBe(recipe().prompt);
    expect(failed.successCount).toBe(recipe().successCount);
    expect(failed.id).toBe(recipe().id);
  });

  it('recordSkillFailure falls back to a placeholder for empty output', () => {
    const failed = recordSkillFailure(recipe(), '   ');
    expect(failed.lastFailure!.note).toBe('run failed with no output');
  });

  it('round-trips lastFailure through the markdown frontmatter', () => {
    const failed = recordSkillFailure(recipe(), 'HTTP 429 from provider', Date.UTC(2026, 7, 3));
    const parsed = parseSkillRecipeMarkdown(buildSkillRecipeMarkdown(failed));
    expect(parsed?.lastFailure).toEqual({
      at: '2026-08-03T00:00:00.000Z',
      note: 'HTTP 429 from provider',
    });
    // A recipe without a failure hint stays clean after a roundtrip.
    const clean = parseSkillRecipeMarkdown(buildSkillRecipeMarkdown(recipe()));
    expect(clean?.lastFailure).toBeUndefined();
  });

  it('injection context carries the caution only while a failure is stored', () => {
    const failed = recordSkillFailure(recipe(), 'output was in English, user wanted Japanese');
    const ctx = buildSkillInjectionContext(failed);
    expect(ctx).toContain('Caution: the most recent run using this skill FAILED');
    expect(ctx).toContain('output was in English, user wanted Japanese');
    expect(ctx).toContain('avoid repeating that failure');
    expect(buildSkillInjectionContext(recipe())).not.toContain('Caution:');
  });

  it('a later verified success clears the failure hint (bumpSkillUsage)', () => {
    const failed = recordSkillFailure(recipe({ successCount: 2 }), 'transient parse error');
    const healed = bumpSkillUsage(failed, Date.UTC(2026, 7, 4));
    expect(healed.lastFailure).toBeUndefined();
    expect(healed.successCount).toBe(3);
    expect(buildSkillInjectionContext(healed)).not.toContain('Caution:');
    // And it no longer persists after the next write.
    const parsed = parseSkillRecipeMarkdown(buildSkillRecipeMarkdown(healed));
    expect(parsed?.lastFailure).toBeUndefined();
  });

  it('a secret inside a failure note is visible to secret-guard via the run prompt', () => {
    const failed = recordSkillFailure(
      recipe(),
      'auth failed for token sk-ant-api03-AAAABBBBCCCCDDDDEEEE',
    );
    const effectivePrompt = `${buildSkillInjectionContext(failed)}\n\n---\n\nSummarize the news`;
    expect(scanForSecrets(effectivePrompt).hasSecret).toBe(true);
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
