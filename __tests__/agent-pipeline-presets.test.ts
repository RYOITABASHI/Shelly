import {
  buildSteamPipeline,
  enforceCharLimit,
  clampCharLimit,
  STEAM_DEFAULT_CRON,
  X_CHAR_LIMIT,
} from '@/lib/agent-pipeline-presets';
import { detectRouteSignals } from '@/lib/agent-router-scoring';
import { normalizeSteps } from '@/lib/agent-orchestration';
import type { AgentOrchestrationConfig } from '@/store/types';

// buildSteamPipeline only ever produces plain-string steps (no tool pins) —
// this preset predates and is untouched by the Phase 5 step-tool-pin schema
// change, so narrow AgentOrchestrationConfig.steps (now string | {instruction,
// tool?}) back down to plain instruction strings for these existing assertions.
const stepInstructions = (orchestration: AgentOrchestrationConfig) =>
  normalizeSteps(orchestration).map((s) => s.instruction);

describe('buildSteamPipeline — North Star collection pipeline', () => {
  it('produces a 4-step autonomous Mon/Fri pipeline with a char limit', () => {
    const p = buildSteamPipeline();
    expect(p.autonomous).toBe(true);
    expect(p.schedule).toBe(STEAM_DEFAULT_CRON); // 0 8 * * 1,5
    expect(p.orchestration.steps.length).toBe(4);
    expect(p.orchestration.charLimit).toBe(X_CHAR_LIMIT);
  });

  it('routes each step correctly via the existing scorer (collect=web, summarize=on-device)', () => {
    const p = buildSteamPipeline();
    const [collect, primary, summarize, resummarize] = stepInstructions(p.orchestration);
    // The base prompt is prepended to every step at runtime (buildStepPrompt), so
    // it MUST be neutral — no collection verb / freshness — or it would force
    // needsWeb on the transform steps too.
    expect(detectRouteSignals(p.prompt).needsWeb).toBe(false);
    // Collect + primary-source are web-mandatory → a web backend (Gemini/Perplexity).
    expect(detectRouteSignals(collect).needsWeb).toBe(true);
    expect(detectRouteSignals(primary).needsWeb).toBe(true);
    // Summarize / re-summarize are transforms (no collection verb) → on-device.
    expect(detectRouteSignals(summarize).needsWeb).toBe(false);
    expect(detectRouteSignals(resummarize).needsWeb).toBe(false);
    // Base + transform step combined still stays on-device (the base doesn't leak).
    expect(detectRouteSignals(`${p.prompt}\n\n# This step\n${summarize}`).needsWeb).toBe(false);
  });

  it('honours topic / count / charLimit / schedule overrides (clamped)', () => {
    const p = buildSteamPipeline({ topic: '宇宙生物学', count: 99, charLimit: 5, schedule: null });
    expect(p.name).toContain('宇宙生物学');
    expect(stepInstructions(p.orchestration)[0]).toContain('宇宙生物学');
    expect(stepInstructions(p.orchestration)[0]).toContain('10件'); // count clamped to 10
    expect(p.orchestration.charLimit).toBe(40); // 5 clamped up to the floor
    expect(p.schedule).toBeNull();
  });

  it('bakes the char limit into the final re-summarize instruction', () => {
    const p = buildSteamPipeline({ charLimit: 200 });
    expect(stepInstructions(p.orchestration)[3]).toContain('200文字以内');
  });
});

describe('clampCharLimit', () => {
  it('floors at 40, caps at 4000, defaults on NaN', () => {
    expect(clampCharLimit(5)).toBe(40);
    expect(clampCharLimit(999999)).toBe(4000);
    expect(clampCharLimit(280)).toBe(280);
    expect(clampCharLimit(NaN)).toBe(X_CHAR_LIMIT);
  });
});

describe('enforceCharLimit — hard guarantee', () => {
  it('passes through text already within the limit', () => {
    expect(enforceCharLimit('短い文', 280)).toBe('短い文');
  });

  it('result never exceeds the limit (code points), including CJK', () => {
    const long = 'あ'.repeat(500);
    const out = enforceCharLimit(long, 280);
    expect(Array.from(out).length).toBeLessThanOrEqual(280);
  });

  it('prefers a sentence boundary when one is reasonably placed', () => {
    const text = 'これは一文目です。' + 'あ'.repeat(400);
    const out = enforceCharLimit(text, 300);
    // The boundary at the first 。is too early (<60% of budget), so it hard-cuts.
    expect(Array.from(out).length).toBeLessThanOrEqual(300);
    // But a boundary near the end IS honoured:
    const text2 = 'あ'.repeat(250) + '。' + 'い'.repeat(100);
    const out2 = enforceCharLimit(text2, 300);
    expect(out2.endsWith('。')).toBe(true);
    expect(Array.from(out2).length).toBeLessThanOrEqual(300);
  });

  it('hard-cuts with an ellipsis when no boundary fits, staying within budget', () => {
    const out = enforceCharLimit('あ'.repeat(500), 100);
    expect(out.endsWith('…')).toBe(true);
    expect(Array.from(out).length).toBeLessThanOrEqual(100);
  });
});
