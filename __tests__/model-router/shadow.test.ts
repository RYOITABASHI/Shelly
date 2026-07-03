import { compareRouteDecision, RouteShadowResult } from '@/lib/model-router/shadow';
import { MODEL_ROUTER_ENABLED } from '@/lib/model-router';
import { Agent, ToolChoice } from '@/store/types';

// Same synthetic-agent helper shape as agent-router-scoring.test.ts — the
// comparator chain (resolveAgentRoute / detectRouteSignals / scanForSecrets /
// selectModel) is pure, so no fs/home-path mocks are needed.
const mkAgent = (over: Partial<Agent> = {}): Agent => ({
  id: 'a',
  name: 'A',
  description: '',
  prompt: 'summarize this',
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

// Fake keys that scanForSecrets catches (same fixtures as
// agent-router-scoring.test.ts:142 / wiring.test.ts:27 — never real secrets).
const FAKE_OPENAI_KEY = 'sk-ant-api03-AAAABBBBCCCCDDDD';
const FAKE_GITHUB_TOKEN = 'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

interface CorpusCase {
  name: string;
  agent: Agent;
  /** null = parity expected; else the documented intentional divergence. */
  expectKnown: string | null;
}

// The Phase A parity corpus: one agent per live guard branch plus the secret
// edge cases. Every case must satisfy the secret invariant and produce NO
// unexpected divergence — the known-divergent branches are classified, not hidden.
const CORPUS: CorpusCase[] = [
  {
    name: '(a) secret-bearing prompt → both sides local',
    agent: mkAgent({ prompt: `review github PR with key ${FAKE_OPENAI_KEY}` }),
    expectKnown: null,
  },
  {
    name: '(a2) secret in DESCRIPTION (non-prompt field) → replica scan must catch it too',
    agent: mkAgent({ prompt: 'say hello', description: `deploy token ${FAKE_GITHUB_TOKEN}` }),
    expectKnown: null,
  },
  {
    name: '(a3) secret + web-mandatory → shadow fail-closed deny (wiring §MIGRATION step 2)',
    agent: mkAgent({ prompt: `collect the latest news, api_key=${FAKE_OPENAI_KEY}` }),
    expectKnown: 'secret-fail-closed-deny',
  },
  {
    name: '(b) needsWeb general research → both sides Gemini (grounded)',
    agent: mkAgent({ prompt: 'collect the latest news' }),
    expectKnown: null,
  },
  {
    name: '(b2) needsWeb academic → live Perplexity vs shadow Gemini = ranking divergence, both web-eligible',
    agent: mkAgent({ prompt: '最新の論文を集めて' }),
    expectKnown: 'affinity-ranking',
  },
  {
    name: '(c) plain local transform → live local vs shadow free-cloud = ranking divergence',
    agent: mkAgent({ prompt: '要約して箇条書きにして' }),
    expectKnown: 'affinity-ranking',
  },
  {
    name: '(d) manual on-device pin',
    agent: mkAgent({ prompt: 'review the github pull request', runOn: 'on-device' }),
    expectKnown: 'manual-pin',
  },
  {
    name: '(d2) manual cloud pin',
    agent: mkAgent({ prompt: '要約して', runOn: 'cloud' }),
    expectKnown: 'manual-pin',
  },
  {
    name: '(e) autonomous + auto → OAuth Codex driver policy branch',
    agent: mkAgent({ prompt: '要約して', autonomous: true }),
    expectKnown: 'autonomous-policy',
  },
  {
    name: '(f) configured perplexity passthrough',
    agent: mkAgent({
      prompt: 'find research papers',
      tool: { type: 'perplexity', model: 'sonar-deep-research' },
    }),
    expectKnown: 'configured-tool',
  },
];

describe('MODEL-001 Phase A shadow comparator — corpus parity (dormant)', () => {
  it('stays dormant: the router flag ships false', () => {
    expect(MODEL_ROUTER_ENABLED).toBe(false);
  });

  it('THE invariant: secretInvariantHolds for EVERY corpus agent', () => {
    for (const c of CORPUS) {
      const r = compareRouteDecision(c.agent);
      expect({ name: c.name, holds: r.secretInvariantHolds })
        .toEqual({ name: c.name, holds: true });
    }
  });

  it('no unexpected divergence anywhere in the corpus', () => {
    for (const c of CORPUS) {
      const r = compareRouteDecision(c.agent);
      expect({ name: c.name, unexpected: r.unexpectedDivergence })
        .toEqual({ name: c.name, unexpected: null });
    }
  });

  it('known divergences are classified per branch; parity cases stay clean', () => {
    for (const c of CORPUS) {
      const r = compareRouteDecision(c.agent);
      expect({ name: c.name, known: r.knownDivergence })
        .toEqual({ name: c.name, known: c.expectKnown });
    }
  });

  it('secret prompt: live forces on-device AND shadow chooses the local candidate', () => {
    const r = compareRouteDecision(CORPUS[0].agent);
    expect(r.live.decision.guard).toBe('secret');
    expect(r.live.decision.route).toBe('on-device');
    expect(r.live.tool.type).toBe('local');
    expect(r.shadow.chosen?.isLocal).toBe(true);
    expect(r.shadow.chosen?.credentialClass).toBe('local');
    expect(r.requirements.touchesSecrets).toBe(true);
    // every cloud candidate was structurally barred, not merely down-ranked
    expect(r.shadow.rejected.every((rej) => rej.reason === 'secret-requires-local')).toBe(true);
  });

  it('secret + web-mandatory: shadow denies (chosen null) — never a cloud fallback', () => {
    const r = compareRouteDecision(CORPUS[2].agent);
    expect(r.requirements.touchesSecrets).toBe(true);
    expect(r.requirements.needsWeb).toBe(true);
    expect(r.shadow.chosen).toBeNull();
    expect(r.live.tool.type).toBe('local'); // live semantics: forced local fallback
    expect(r.secretInvariantHolds).toBe(true);
  });

  it('web-gap regression: general needsWeb agrees on gemini-api on BOTH sides', () => {
    // Pins the registry fix — before gemini-api was web-capable, the shadow's
    // only web-eligible candidate was perplexity, so this exact case reported
    // an unexpected eligibility divergence against the live ladder's
    // Gemini-grounded-for-general-web preference (agent-escalation-ladder.ts).
    const r = compareRouteDecision(CORPUS[3].agent);
    expect(r.live.tool.type).toBe('gemini-api');
    expect(r.shadow.chosen?.toolType).toBe('gemini-api');
    expect(r.unexpectedDivergence).toBeNull();
    expect(r.knownDivergence).toBeNull();
  });

  it('unattended (autonomous) requirements bar api-key backends in the shadow', () => {
    const r = compareRouteDecision(CORPUS[8].agent);
    expect(r.requirements.unattended).toBe(true);
    expect(r.shadow.rejected.some((rej) => rej.reason === 'unattended-credential')).toBe(true);
    expect(r.shadow.eligible.every((c) => c.credentialClass !== 'api-key')).toBe(true);
  });

  it('is pure/deterministic: identical result for repeated calls', () => {
    for (const c of CORPUS) {
      const a: RouteShadowResult = compareRouteDecision(c.agent);
      const b: RouteShadowResult = compareRouteDecision(c.agent);
      expect(a).toEqual(b);
    }
  });
});
