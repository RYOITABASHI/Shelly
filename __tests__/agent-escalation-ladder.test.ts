import {
  resolveEscalationLadder,
  attemptFailed,
  isLocalFallbackDigest,
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
});
