const setNotificationCategoryAsync = jest.fn();
const scheduleNotificationAsync = jest.fn();
const readSkillRecipesMock = jest.fn(async () => [] as unknown[]);

jest.mock('expo-notifications', () => ({
  setNotificationCategoryAsync,
  scheduleNotificationAsync,
}));
jest.mock('expo-file-system/legacy', () => ({}));
jest.mock('@/lib/home-path', () => ({
  getHomePath: () => '/home/shelly-test',
}));
jest.mock('@/lib/agent-skills', () => {
  const actual = jest.requireActual('@/lib/agent-skills');
  return {
    ...actual,
    readSkillRecipes: (...args: unknown[]) => readSkillRecipesMock(...(args as [])),
  };
});

import {
  MAX_SKILL_LEARNINGS,
  MAX_SKILL_LEARNING_NOTE_CHARS,
  buildSkillInjectionContext,
  buildSkillRecipeMarkdown,
  makeSkillRecipe,
  parseSkillRecipeMarkdown,
  type SkillRecipe,
} from '@/lib/agent-skills';
import {
  REVERT_SKILL_IMPROVEMENT_ACTION,
  SKILL_IMPROVED_NOTIFICATION_CATEGORY,
  WITHHELD_FAILURE_NOTE,
  appendSkillLearning,
  applyUnattendedSkillImprovement,
  buildSkillImprovementAuditCommand,
  consumeSkillImprovementProposal,
  clearSkillImprovementProposal,
  persistSkillImprovement,
  proposeSkillImprovement,
  revertSkillImprovement,
  skillImproveMode,
  skillImprovementAuditLogPath,
  stageSkillImprovementProposal,
} from '@/lib/skill-self-improve';

const T0 = Date.UTC(2026, 7, 1); // 2026-08-01
const T1 = Date.UTC(2026, 7, 10); // 2026-08-10
const T2 = Date.UTC(2026, 7, 13); // 2026-08-13

const recipe = (over: Partial<SkillRecipe> = {}): SkillRecipe => ({
  ...makeSkillRecipe({
    name: 'Crypto digest',
    trigger: 'crypto market summary',
    prompt: 'Summarize the top crypto moves as 5 bullets.',
    route: 'on-device',
    toolLabel: 'Local LLM',
    tags: ['crypto', 'summary'],
    successCount: 2,
    created: new Date(T0).toISOString(),
    lastUsed: new Date(T0).toISOString(),
  }),
  ...over,
});

const notificationText = {
  title: 'Skill improved',
  body: 'Learned from an unattended run',
  revertButton: 'Undo improvement',
};

beforeEach(() => {
  jest.clearAllMocks();
  readSkillRecipesMock.mockResolvedValue([]);
});

describe('skillImproveMode', () => {
  it('mirrors skillSaveMode: attended=confirm, unattended=auto', () => {
    expect(skillImproveMode({ status: 'success', hasSkillId: true })).toBe('confirm');
    expect(skillImproveMode({ status: 'error', hasSkillId: true })).toBe('confirm');
    expect(
      skillImproveMode({ status: 'success', hasSkillId: true, unattended: true })
    ).toBe('auto');
  });
  it('is none without a reused skill or a learnable outcome', () => {
    expect(skillImproveMode({ status: 'success', hasSkillId: false })).toBe('none');
    expect(skillImproveMode({ status: 'skipped', hasSkillId: true })).toBe('none');
    expect(skillImproveMode({ status: 'unavailable', hasSkillId: true })).toBe('none');
    expect(skillImproveMode({ status: undefined, hasSkillId: true })).toBe('none');
  });
});

describe('proposeSkillImprovement — trigger conditions', () => {
  it('success without a pending failure is a plain metadata bump', () => {
    const p = proposeSkillImprovement({ recipe: recipe(), status: 'success', timestamp: T2 });
    expect(p.kind).toBe('bump');
    expect(p.improved.successCount).toBe(3);
    expect(p.improved.lastUsed).toBe(new Date(T2).toISOString());
    expect(p.improved.learnings).toBeUndefined();
    expect(p.improved.lastImprovedAt).toBeUndefined();
  });

  it('success that resolves a failure hint promotes it into a body learning', () => {
    const r = recipe({
      lastFailure: { at: new Date(T1).toISOString(), note: 'API quota exceeded on step 2' },
    });
    const p = proposeSkillImprovement({ recipe: r, status: 'success', timestamp: T2 });
    expect(p.kind).toBe('bump-with-learning');
    expect(p.improved.successCount).toBe(3);
    // The bump cleared the hint; the lesson survives as a learning.
    expect(p.improved.lastFailure).toBeUndefined();
    expect(p.improved.learnings).toHaveLength(1);
    expect(p.improved.learnings![0].note).toContain('API quota exceeded on step 2');
    expect(p.improved.learnings![0].note).toContain('resolved 2026-08-13');
    expect(p.improved.lastImprovedAt).toBe(new Date(T2).toISOString());
    expect(p.improved.improveCount).toBe(1);
    expect(p.learning).toEqual(p.improved.learnings![0]);
  });

  it('failure records a hint (existing learning loop) via the engine', () => {
    const p = proposeSkillImprovement({
      recipe: recipe(),
      status: 'error',
      outputPreview: 'timeout\nafter 300s',
      timestamp: T2,
    });
    expect(p.kind).toBe('failure-hint');
    expect(p.improved.lastFailure).toEqual({
      at: new Date(T2).toISOString(),
      note: 'timeout after 300s',
    });
    // Failure never demotes the verified history or touches the body.
    expect(p.improved.successCount).toBe(2);
    expect(p.improved.learnings).toBeUndefined();
  });

  it('an identical lesson is never stacked twice', () => {
    const first = proposeSkillImprovement({
      recipe: recipe({ lastFailure: { at: new Date(T1).toISOString(), note: 'same pitfall' } }),
      status: 'success',
      timestamp: T2,
    });
    expect(first.kind).toBe('bump-with-learning');
    // Same failure note resurfaces later and is again resolved the same day.
    const again = proposeSkillImprovement({
      recipe: {
        ...first.improved,
        lastUsed: new Date(T2).toISOString(),
        lastFailure: { at: new Date(T2 + 1000).toISOString(), note: 'same pitfall' },
      },
      status: 'success',
      timestamp: T2 + 2000,
    });
    expect(again.kind).toBe('bump');
    expect(again.improved.learnings).toHaveLength(1);
  });
});

describe('proposeSkillImprovement — idempotence (repeat log-sync polls)', () => {
  it('success already applied for this run proposes nothing', () => {
    const r = recipe({ lastUsed: new Date(T2).toISOString() });
    expect(
      proposeSkillImprovement({ recipe: r, status: 'success', timestamp: T2 }).kind
    ).toBe('noop');
    expect(
      proposeSkillImprovement({ recipe: r, status: 'success', timestamp: T1 }).kind
    ).toBe('noop');
  });
  it('failure already recorded for this run proposes nothing', () => {
    const r = recipe({ lastFailure: { at: new Date(T2).toISOString(), note: 'x' } });
    expect(
      proposeSkillImprovement({ recipe: r, status: 'error', outputPreview: 'x', timestamp: T2 }).kind
    ).toBe('noop');
  });
});

describe('proposeSkillImprovement — secret/PII gate on updates', () => {
  it('withholds a failure note the scanner flags', () => {
    const p = proposeSkillImprovement({
      recipe: recipe(),
      status: 'error',
      outputPreview: 'failed with api_key=abcdefghijklmnop123456',
      timestamp: T2,
    });
    expect(p.kind).toBe('failure-hint');
    expect(p.improved.lastFailure!.note).toBe(WITHHELD_FAILURE_NOTE);
    expect(p.improved.lastFailure!.note).not.toContain('abcdefghijklmnop123456');
  });

  it('never promotes a secret-bearing failure hint into the body', () => {
    // A hint written by an OLDER build (pre-gate) could carry a secret.
    const r = recipe({
      lastFailure: {
        at: new Date(T1).toISOString(),
        note: 'retry with token=abcdefghijklmnop123456 next time',
      },
    });
    const p = proposeSkillImprovement({ recipe: r, status: 'success', timestamp: T2 });
    expect(p.kind).toBe('bump'); // downgraded — bump still applies, body untouched
    expect(p.improved.learnings).toBeUndefined();
    expect(buildSkillRecipeMarkdown(p.improved)).not.toContain('shelly-skill-learnings');
  });
});

describe('bloat caps', () => {
  it('learnings are FIFO-capped at MAX_SKILL_LEARNINGS', () => {
    let r = recipe();
    for (let i = 0; i < MAX_SKILL_LEARNINGS + 2; i++) {
      r = appendSkillLearning(r, { at: new Date(T1 + i).toISOString(), note: `lesson ${i}` });
    }
    expect(r.learnings).toHaveLength(MAX_SKILL_LEARNINGS);
    expect(r.learnings![0].note).toBe('lesson 2'); // oldest two dropped
    expect(r.learnings!.at(-1)!.note).toBe(`lesson ${MAX_SKILL_LEARNINGS + 1}`);
    expect(r.improveCount).toBe(MAX_SKILL_LEARNINGS + 2); // audit counts every add
  });

  it('a learning note is flattened and hard-capped', () => {
    const r = appendSkillLearning(recipe(), {
      at: new Date(T2).toISOString(),
      note: `line1\nline2   spaced ${'x'.repeat(500)}`,
    });
    const note = r.learnings![0].note;
    expect(note.length).toBeLessThanOrEqual(MAX_SKILL_LEARNING_NOTE_CHARS);
    expect(note).not.toMatch(/[\r\n]/);
    expect(note).toContain('line1 line2 spaced');
  });
});

describe('markdown round-trip + injection', () => {
  it('learnings, lastImprovedAt and improveCount survive build → parse', () => {
    const r = appendSkillLearning(recipe(), {
      at: new Date(T2).toISOString(),
      note: 'Past failure (resolved 2026-08-13): API quota exceeded',
    });
    const parsed = parseSkillRecipeMarkdown(buildSkillRecipeMarkdown(r));
    expect(parsed).not.toBeNull();
    expect(parsed!.prompt).toBe(r.prompt);
    expect(parsed!.learnings).toEqual(r.learnings);
    expect(parsed!.lastImprovedAt).toBe(r.lastImprovedAt);
    expect(parsed!.improveCount).toBe(1);
  });

  it('learnings and an executable planSpec round-trip together', () => {
    const plan = {
      kind: 'shelly.agent.plan',
      schemaVersion: 1,
      generatedAt: T0,
      agent: { id: 'src', name: 'Src', autonomous: false, autonomyLevel: 'L2' },
      prompt: 'old task',
      tool: { type: 'groq', label: 'Groq', model: 'llama-3.3-70b-versatile', authRef: 'groq' },
      action: { type: 'draft' },
      paths: { home: '/home', envFile: '', tmpDir: '', locksDir: '', logsDir: '', resultFile: '', lockFile: '', logDir: '' },
      output: { outputDir: '/out', outputNameTemplate: '', slug: 'src', useGlobalOutput: true, suggestedRoots: [] },
      limits: { timeoutSeconds: 600, maxConcurrent: 2 },
      policy: {},
      routeDecision: { route: 'cloud', toolType: 'groq', toolLabel: 'Groq', guard: 'configured-tool', why: '' },
      steps: {
        list: [{ instruction: 'collect' }, { instruction: 'summarize' }],
        budget: { maxSteps: 2, totalTimeoutMs: 120_000 },
      },
    };
    const r = appendSkillLearning(
      recipe({ planSpec: plan as SkillRecipe['planSpec'] }),
      { at: new Date(T2).toISOString(), note: 'watch the quota' }
    );
    const parsed = parseSkillRecipeMarkdown(buildSkillRecipeMarkdown(r));
    expect(parsed?.learnings).toEqual(r.learnings);
    expect(parsed?.planSpec?.steps?.list.map((s) => s.instruction)).toEqual([
      'collect',
      'summarize',
    ]);
    expect(parsed?.prompt).toContain('5 bullets');
    expect(parsed?.prompt).not.toContain('watch the quota');
  });

  it('a never-improved recipe emits byte-identical pre-improvement markdown', () => {
    const md = buildSkillRecipeMarkdown(recipe());
    expect(md).not.toContain('shelly-skill-learnings');
    expect(md).not.toContain('lastImprovedAt');
    expect(md).not.toContain('improveCount');
  });

  it('a malformed learnings payload degrades to the prompt-only skill', () => {
    const md = buildSkillRecipeMarkdown(recipe()).replace(
      /\n$/,
      '\n\n<!-- shelly-skill-learnings\nnot json\n-->\n'
    );
    const parsed = parseSkillRecipeMarkdown(md);
    expect(parsed).not.toBeNull();
    expect(parsed!.learnings).toBeUndefined();
    expect(parsed!.prompt).toContain('5 bullets');
  });

  it('injection context surfaces learned cautions (most recent, bounded)', () => {
    let r = recipe();
    for (let i = 0; i < 5; i++) {
      r = appendSkillLearning(r, { at: new Date(T1 + i).toISOString(), note: `lesson ${i}` });
    }
    const ctx = buildSkillInjectionContext(r);
    expect(ctx).toContain('Learned cautions');
    expect(ctx).toContain('- lesson 4');
    expect(ctx).toContain('- lesson 2');
    expect(ctx).not.toContain('- lesson 1'); // only the most recent 3 injected
  });
});

describe('audit log', () => {
  it('appends one JSONL line to improvements.log with rotation', () => {
    const cmd = buildSkillImprovementAuditCommand({
      at: new Date(T2).toISOString(),
      skillId: 'skill-abc',
      action: 'learning-added',
      note: 'lesson',
    });
    expect(skillImprovementAuditLogPath()).toBe(
      '/home/shelly-test/.shelly/agents/skills/improvements.log'
    );
    expect(cmd).toContain(">> '/home/shelly-test/.shelly/agents/skills/improvements.log'");
    expect(cmd).toContain('"action":"learning-added"');
    expect(cmd).toContain('"skillId":"skill-abc"');
    expect(cmd).toContain('tail -n 500'); // self-rotation
  });

  it('persistSkillImprovement writes the recipe then the audit line', async () => {
    const commands: string[] = [];
    const runCommand = jest.fn(async (cmd: string) => {
      commands.push(cmd);
      return '';
    });
    const p = proposeSkillImprovement({
      recipe: recipe({ lastFailure: { at: new Date(T1).toISOString(), note: 'pitfall' } }),
      status: 'success',
      timestamp: T2,
    });
    await persistSkillImprovement(runCommand, p);
    expect(commands).toHaveLength(2);
    expect(commands[0]).toContain('shelly-skill-learnings'); // recipe write
    expect(commands[1]).toContain('improvements.log'); // audit append
  });

  it('a plain bump writes the recipe without an audit line', async () => {
    const runCommand = jest.fn(async () => '');
    await persistSkillImprovement(
      runCommand,
      proposeSkillImprovement({ recipe: recipe(), status: 'success', timestamp: T2 })
    );
    expect(runCommand).toHaveBeenCalledTimes(1);
  });
});

describe('attended staging (confirm flow)', () => {
  it('stage → consume is single-shot; clear retires a stale proposal', () => {
    const p = proposeSkillImprovement({
      recipe: recipe({ lastFailure: { at: new Date(T1).toISOString(), note: 'pitfall' } }),
      status: 'success',
      timestamp: T2,
    });
    stageSkillImprovementProposal('agent-1', p);
    expect(consumeSkillImprovementProposal('agent-1')).toEqual(p);
    expect(consumeSkillImprovementProposal('agent-1')).toBeNull();

    stageSkillImprovementProposal('agent-2', p);
    clearSkillImprovementProposal('agent-2');
    expect(consumeSkillImprovementProposal('agent-2')).toBeNull();
  });
});

describe('unattended flow (auto + notify + revert)', () => {
  it('a body improvement notifies with a one-tap revert action', async () => {
    const runCommand = jest.fn(async () => '');
    const p = proposeSkillImprovement({
      recipe: recipe({ lastFailure: { at: new Date(T1).toISOString(), note: 'pitfall' } }),
      status: 'success',
      timestamp: T2,
    });
    await applyUnattendedSkillImprovement(runCommand, p, notificationText);
    expect(runCommand).toHaveBeenCalled();
    expect(setNotificationCategoryAsync).toHaveBeenCalledWith(
      SKILL_IMPROVED_NOTIFICATION_CATEGORY,
      [expect.objectContaining({ identifier: REVERT_SKILL_IMPROVEMENT_ACTION })]
    );
    expect(scheduleNotificationAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.objectContaining({
          data: { skillId: p.improved.id, learningAt: p.learning!.at },
        }),
      })
    );
  });

  it('metadata-only updates stay silent (bump and failure hint)', async () => {
    const runCommand = jest.fn(async () => '');
    await applyUnattendedSkillImprovement(
      runCommand,
      proposeSkillImprovement({ recipe: recipe(), status: 'success', timestamp: T2 }),
      notificationText
    );
    await applyUnattendedSkillImprovement(
      runCommand,
      proposeSkillImprovement({ recipe: recipe(), status: 'error', outputPreview: 'boom', timestamp: T2 }),
      notificationText
    );
    expect(runCommand).toHaveBeenCalled();
    expect(scheduleNotificationAsync).not.toHaveBeenCalled();
  });

  it('a noop applies nothing and notifies nothing', async () => {
    const runCommand = jest.fn(async () => '');
    await applyUnattendedSkillImprovement(
      runCommand,
      proposeSkillImprovement({
        recipe: recipe({ lastUsed: new Date(T2).toISOString() }),
        status: 'success',
        timestamp: T2,
      }),
      notificationText
    );
    expect(runCommand).not.toHaveBeenCalled();
    expect(scheduleNotificationAsync).not.toHaveBeenCalled();
  });

  it('revert removes exactly the notified learning (bump stays)', async () => {
    const improved = appendSkillLearning(
      recipe({ successCount: 3 }),
      { at: new Date(T2).toISOString(), note: 'lesson to revert' }
    );
    readSkillRecipesMock.mockResolvedValue([improved]);
    const commands: string[] = [];
    const runCommand = jest.fn(async (cmd: string) => {
      commands.push(cmd);
      return '';
    });
    const ok = await revertSkillImprovement(runCommand, improved.id, new Date(T2).toISOString());
    expect(ok).toBe(true);
    const write = commands.find((c) => c.includes(`${improved.id}.md`));
    expect(write).toBeDefined();
    expect(write).not.toContain('lesson to revert');
    expect(write).toContain('successCount: 3');
    expect(commands.some((c) => c.includes('"action":"learning-reverted"'))).toBe(true);
  });

  it('revert is a safe no-op when the learning is already gone', async () => {
    readSkillRecipesMock.mockResolvedValue([recipe()]);
    const runCommand = jest.fn(async () => '');
    expect(await revertSkillImprovement(runCommand, recipe().id, 'nope')).toBe(false);
    expect(runCommand).not.toHaveBeenCalled();
  });
});
