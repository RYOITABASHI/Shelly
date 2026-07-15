import {
  resolveEscalationLadder,
  attemptFailed,
  isLocalFallbackDigest,
  isLowQualityCompletion,
  LadderEnv,
} from '@/lib/agent-escalation-ladder';
import { Agent, ToolChoice } from '@/store/types';

const KEYED: LadderEnv = { hasCerebrasKey: true, hasGroqKey: true };
const NO_KEYS: LadderEnv = { hasCerebrasKey: false, hasGroqKey: false };

const mk = (over: Partial<Agent> = {}): Agent => ({
  id: 'a',
  name: 'A',
  description: '',
  prompt: 'summarize this note',
  schedule: null,
  tool: { type: 'auto' } as ToolChoice,
  outputPath: '~/out',
  outputTemplate: null,
  enabled: true,
  lastRun: null,
  lastResult: null,
  createdAt: 0,
  version: 1,
  ...over,
});

const types = (l: { tools: ToolChoice[] }) => l.tools.map((t) => (t.type === 'cli' ? `cli:${t.cli}` : t.type));

describe('resolveEscalationLadder — hard stops never climb', () => {
  it('secret-guard match → on-device only, no escalation', () => {
    const l = resolveEscalationLadder(mk({ prompt: 'use key sk-ant-api03-AAAABBBBCCCCDDDD now' }), KEYED);
    expect(l.guard).toBe('secret');
    expect(l.noEscalation).toBe(true);
    expect(types(l)).toEqual(['local']);
  });

  it('manual on-device pin → local only, no climb', () => {
    const l = resolveEscalationLadder(mk({ runOn: 'on-device' }), KEYED);
    expect(l.guard).toBe('manual-pin');
    expect(l.noEscalation).toBe(true);
    expect(types(l)).toEqual(['local']);
  });

  it('manual cloud pin → single pinned tool, no climb', () => {
    const l = resolveEscalationLadder(mk({ runOn: 'cloud' }), KEYED);
    expect(l.guard).toBe('manual-pin');
    expect(l.noEscalation).toBe(true);
    expect(l.tools.length).toBe(1);
  });
});

describe('resolveEscalationLadder — autonomous is local → Codex ONLY', () => {
  it('autonomous auto → [local, codex], no key backends', () => {
    const l = resolveEscalationLadder(mk({ autonomous: true }), KEYED);
    expect(l.noEscalation).toBe(false);
    expect(types(l)).toEqual(['local', 'cli:codex']);
  });

  it('autonomous with a configured api-key tool still drops it → [local, codex]', () => {
    const l = resolveEscalationLadder(mk({ autonomous: true, tool: { type: 'perplexity' } }), KEYED);
    expect(types(l)).toEqual(['local', 'cli:codex']);
    expect(types(l)).not.toContain('perplexity');
    expect(types(l)).not.toContain('cerebras');
    expect(types(l)).not.toContain('groq');
  });
});

describe('resolveEscalationLadder — attended ladder (primary → local → free cloud → Codex)', () => {
  it('transform task primary=local, then free cloud (keyed), Codex last', () => {
    const l = resolveEscalationLadder(mk({ prompt: '要約して箇条書きにして' }), KEYED);
    expect(types(l)).toEqual(['local', 'cerebras', 'groq', 'cli:codex']);
    expect(types(l).at(-1)).toBe('cli:codex'); // Codex always terminal (quota-preserving)
  });

  it('academic task tries Perplexity (domain) first, then climbs', () => {
    const l = resolveEscalationLadder(mk({ prompt: 'find the latest research paper with citations' }), KEYED);
    expect(types(l)[0]).toBe('perplexity');
    expect(types(l).at(-1)).toBe('cli:codex');
  });

  it('omits Cerebras/Groq when their key is absent (no wasted hop)', () => {
    const l = resolveEscalationLadder(mk({ prompt: '要約して' }), NO_KEYS);
    expect(types(l)).not.toContain('cerebras');
    expect(types(l)).not.toContain('groq');
    expect(types(l)).toEqual(['local', 'cli:codex']);
  });

  it('only the keyed free-cloud tier is included', () => {
    const l = resolveEscalationLadder(mk({ prompt: '要約して' }), { hasCerebrasKey: false, hasGroqKey: true });
    expect(types(l)).toEqual(['local', 'groq', 'cli:codex']);
  });
});

describe('resolveEscalationLadder — web-mandatory tasks exclude non-web backends', () => {
  it('general collect-news (attended) → Gemini → Codex, no local/cerebras/groq', () => {
    const l = resolveEscalationLadder(mk({ prompt: 'ニュースを集めて' }), KEYED);
    expect(types(l)).toEqual(['gemini-api', 'cli:codex']);
    expect(types(l)).not.toContain('local');
    expect(types(l)).not.toContain('cerebras');
    expect(types(l)).not.toContain('groq');
  });

  it('academic collect (attended) → Perplexity → Codex', () => {
    const l = resolveEscalationLadder(mk({ prompt: '最新の論文を集めて出典付きで' }), KEYED);
    expect(types(l)).toEqual(['perplexity', 'cli:codex']);
  });

  it('autonomous web-mandatory → Codex ONLY (api-key web backends fail-closed)', () => {
    const l = resolveEscalationLadder(mk({ prompt: 'ニュースを集めて', autonomous: true }), KEYED);
    expect(types(l)).toEqual(['cli:codex']);
    expect(types(l)).not.toContain('gemini-api');
    expect(types(l)).not.toContain('local');
  });

  it('N1: autonomous + cloud consent → Gemini→Codex (general) / Perplexity→Codex (academic)', () => {
    const consent: LadderEnv = { hasCerebrasKey: true, hasGroqKey: true, autonomousCloudConsent: true };
    expect(types(resolveEscalationLadder(mk({ prompt: 'ニュースを集めて', autonomous: true }), consent)))
      .toEqual(['gemini-api', 'cli:codex']);
    expect(types(resolveEscalationLadder(mk({ prompt: '最新の論文を集めて', autonomous: true }), consent)))
      .toEqual(['perplexity', 'cli:codex']);
  });

  it("N1: 'stop' policy halts at the free tier (no Codex climb on 429)", () => {
    const consentStop: LadderEnv = { hasCerebrasKey: true, hasGroqKey: true, autonomousCloudConsent: true, autonomousCloudStop: true };
    expect(types(resolveEscalationLadder(mk({ prompt: 'ニュースを集めて', autonomous: true }), consentStop)))
      .toEqual(['gemini-api']);
  });

  it('N1: consent does NOT widen non-web autonomous tasks (still local→Codex)', () => {
    const consent: LadderEnv = { hasCerebrasKey: true, hasGroqKey: true, autonomousCloudConsent: true };
    expect(types(resolveEscalationLadder(mk({ prompt: '要約して', autonomous: true }), consent)))
      .toEqual(['local', 'cli:codex']);
  });

  it('N1: secret-guard still wins over autonomous cloud consent', () => {
    const consent: LadderEnv = { hasCerebrasKey: true, hasGroqKey: true, autonomousCloudConsent: true };
    const l = resolveEscalationLadder(mk({ prompt: 'ニュースを集めて key sk-ant-api03-AAAABBBBCCCCDDDD', autonomous: true }), consent);
    expect(l.guard).toBe('secret');
    expect(types(l)).toEqual(['local']);
  });

  it('secret-guard still wins over a web-mandatory task (no cloud climb)', () => {
    const l = resolveEscalationLadder(mk({ prompt: 'ニュースを集めて key sk-ant-api03-AAAABBBBCCCCDDDD' }), KEYED);
    expect(l.guard).toBe('secret');
    expect(l.noEscalation).toBe(true);
    expect(types(l)).toEqual(['local']);
  });
});

describe('resolveEscalationLadder — key preflight (G4 P1: keyless cloud degrades upfront)', () => {
  const NO_CLOUD_KEYS: LadderEnv = {
    hasCerebrasKey: false,
    hasGroqKey: false,
    hasPerplexityKey: false,
    hasGeminiKey: false,
  };

  it('auto-scorer research task with no Perplexity key → degrades to local first (no wasted hop)', () => {
    const l = resolveEscalationLadder(
      mk({ prompt: 'find the latest research paper with citations' }),
      NO_CLOUD_KEYS,
    );
    expect(types(l)[0]).toBe('local');
    expect(types(l)).not.toContain('perplexity');
    expect(types(l).at(-1)).toBe('cli:codex');
    expect(l.why).toContain('key not configured');
  });

  it('unknown key state (fields absent) keeps the scorer primary — never wrongly skipped', () => {
    const l = resolveEscalationLadder(
      mk({ prompt: 'find the latest research paper with citations' }),
      NO_KEYS, // hasPerplexityKey/hasGeminiKey absent → unknown → assumed present
    );
    expect(types(l)[0]).toBe('perplexity');
  });

  it('EXPLICITLY configured keyless tool is kept (its missing-key error is the signal)', () => {
    const l = resolveEscalationLadder(
      mk({ tool: { type: 'perplexity', model: 'sonar-deep-research' } }),
      NO_CLOUD_KEYS,
    );
    expect(types(l)[0]).toBe('perplexity');
  });

  it('web-mandatory general task with no Gemini key → Codex directly, local still excluded', () => {
    const l = resolveEscalationLadder(mk({ prompt: 'ニュースを集めて' }), NO_CLOUD_KEYS);
    expect(types(l)).toEqual(['cli:codex']);
    expect(types(l)).not.toContain('local');
  });

  it('web-mandatory academic task with no Perplexity key → Codex directly', () => {
    const l = resolveEscalationLadder(mk({ prompt: '最新の論文を集めて' }), NO_CLOUD_KEYS);
    expect(types(l)).toEqual(['cli:codex']);
  });

  it('N1: autonomous cloud consent with a keyless backend falls to the fail-closed Codex path', () => {
    const consentNoKeys: LadderEnv = { ...NO_CLOUD_KEYS, autonomousCloudConsent: true };
    const l = resolveEscalationLadder(mk({ prompt: 'ニュースを集めて', autonomous: true }), consentNoKeys);
    expect(types(l)).toEqual(['cli:codex']);
    // The why must diagnose the missing key, not suggest enabling the (already
    // enabled) cloud opt-in.
    expect(l.why).toContain('key is not configured');
  });

  it('N1: stop policy does not keep a keyless consented backend (missing key ≠ 429)', () => {
    const consentStopNoKeys: LadderEnv = {
      ...NO_CLOUD_KEYS,
      autonomousCloudConsent: true,
      autonomousCloudStop: true,
    };
    const l = resolveEscalationLadder(mk({ prompt: 'ニュースを集めて', autonomous: true }), consentStopNoKeys);
    expect(types(l)).toEqual(['cli:codex']);
  });

  it('keyed web primary is unchanged by the preflight', () => {
    const l = resolveEscalationLadder(
      mk({ prompt: 'ニュースを集めて' }),
      { ...NO_CLOUD_KEYS, hasGeminiKey: true },
    );
    expect(types(l)).toEqual(['gemini-api', 'cli:codex']);
  });
});

describe('failure detection', () => {
  it('isLocalFallbackDigest matches the shell digest marker', () => {
    expect(isLocalFallbackDigest('# Local Context Fallback\n\nLocal LLM was unavailable...')).toBe(true);
    expect(isLocalFallbackDigest('Here is your summary.')).toBe(false);
    expect(isLocalFallbackDigest(null)).toBe(false);
  });

  it('attemptFailed on an error status OR a fallback digest', () => {
    expect(attemptFailed('error', 'anything')).toBe(true);
    expect(attemptFailed('success', '# Local Context Fallback ...')).toBe(true);
    expect(attemptFailed('success', 'a real answer')).toBe(false);
    expect(attemptFailed('skipped', 'x')).toBe(false);
  });

  it("attemptFailed climbs on a transient 'unavailable' (busy web backend hands off)", () => {
    // 'unavailable' still escalates the ladder (try the next tool) even though it
    // is excluded from the circuit breaker.
    expect(attemptFailed('unavailable', 'a real answer')).toBe(true);
  });

  it('isLowQualityCompletion catches a real on-device prompt-echo failure (regression)', () => {
    // Verbatim (trimmed) shape of what a weak on-device model produced for an
    // orchestrated x.post step on 2026-07-15: it echoed the buildStepPrompt
    // scaffold back instead of answering it, then refused.
    const echoed =
      '# Results from previous steps\n## Step 1\nパープレで STEAM 教育×AI に関する最新の論文やニュースを検索して\n\n' +
      '## Step 2\nローカル LLM で一次ソースと要約を Obsidian の「日付フォルダ」に保存する。\n\n---\n\n' +
      '# This step\nX 用に文字数内で再要約して X に投稿して\n\n---\n\n**Note:** This action requires generating ' +
      'text within a word limit (typically ~1000 characters) for X\'s submission. As an AI, I cannot generate a ' +
      'literal "X" post with a';
    expect(isLowQualityCompletion(echoed)).toBe(true);
    expect(attemptFailed('success', echoed)).toBe(true);
  });

  it('isLowQualityCompletion still catches the echo after whitespace-collapse (regression)', () => {
    // clean_result_preview() in the shell (lib/agent-executor.ts) runs
    // `tr '\n' ' '` on the run preview before anything sees it — a literal
    // '\n' in a marker can never match the real preview shape. This is
    // what an actual whitespace-collapsed on-device preview looks like.
    const collapsed =
      '# Results from previous steps ## Step 1 パープレで検索して ## Step 2 保存する。 --- ' +
      '# This step X用に再要約して投稿して --- Note: As an AI, I cannot generate a literal X post with a';
    expect(isLowQualityCompletion(collapsed)).toBe(true);
  });

  it('isLowQualityCompletion catches a bare refusal with no prompt echo', () => {
    expect(isLowQualityCompletion('As an AI, I cannot generate a literal social media post.')).toBe(true);
    expect(isLowQualityCompletion('私はAIなので、実際の投稿はできません。')).toBe(true);
  });

  it('isLowQualityCompletion does not flag real content', () => {
    expect(isLowQualityCompletion('STEAM教育×AI の最新動向まとめ: 論文3件、ニュース2件を要約しました。')).toBe(false);
    expect(isLowQualityCompletion('This step forward for AI in education looks promising.')).toBe(false);
    expect(isLowQualityCompletion(null)).toBe(false);
    expect(isLowQualityCompletion('')).toBe(false);
  });

  it('attemptFailed does not flag a normal successful completion', () => {
    expect(attemptFailed('success', 'STEAM教育×AI の最新動向まとめ、Obsidianに保存しました。')).toBe(false);
  });
});
