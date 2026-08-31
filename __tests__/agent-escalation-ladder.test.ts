import {
  resolveEscalationLadder,
  attemptFailed,
  isDeterministicDispatchFailure,
  isLocalFallbackDigest,
  isLowQualityCompletion,
  isDuplicateOfPriorStep,
  LadderEnv,
} from '@/lib/agent-escalation-ladder';
import { Agent, ToolChoice } from '@/store/types';
import { buildStepPrompt } from '@/lib/agent-orchestration';

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

  it('regression: "検索して" (search) + freshness is web-mandatory → Gemini/Perplexity → Codex, no local/cerebras/groq', () => {
    // Before the COLLECTION_KW fix, this prompt (explicitly asking to search via
    // Perplexity, with a freshness cue) evaluated needsWeb=false and fell through
    // to the general ladder, which could hand it to Groq — a backend with no web
    // access — letting it silently "succeed" without ever searching.
    const l = resolveEscalationLadder(mk({ prompt: 'Perplexityで最新情報を検索して1つにまとめて' }), KEYED);
    expect(types(l)).not.toContain('local');
    expect(types(l)).not.toContain('cerebras');
    expect(types(l)).not.toContain('groq');
    expect(types(l).at(-1)).toBe('cli:codex');

    const l2 = resolveEscalationLadder(mk({ prompt: 'search for the latest news' }), KEYED);
    expect(types(l2)).toEqual(['gemini-api', 'cli:codex']);
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

describe('resolveEscalationLadder — explicit web-tool pin beats the webDomain heuristic (2026-08-03 on-device bug 「なんでパープレじゃなくてこれ？」)', () => {
  // Real on-device repro: the "Gemini Fix Test" agent's step 0 instruction is
  // 「パープレキシティで最新のAIニュースを集めて」 with an explicit
  // {type:'perplexity'} pin. needsWeb=true but "AIニュース" carries no
  // ACADEMIC_WEB_KW keyword → webDomain='general' → the old code mechanically
  // picked GEMINI, ignoring the user's explicit Perplexity choice — the run log
  // showed gemini-api and the user caught it.
  const PIN_PPLX: ToolChoice = { type: 'perplexity', model: 'sonar-deep-research' };
  const PIN_GEMINI: ToolChoice = { type: 'gemini-api' };
  const GENERAL_WEB = 'パープレキシティで最新のAIニュースを集めて';
  const ACADEMIC_WEB = '最新の論文を集めて';
  const CONSENT: LadderEnv = { hasCerebrasKey: true, hasGroqKey: true, autonomousCloudConsent: true };

  it('on-device repro (autonomous + consent): explicit perplexity pin on a general-domain web task → Perplexity, NOT Gemini', () => {
    // Pre-fix this returned ['gemini-api', 'cli:codex'] — webDomain 'general'
    // overrode the explicit pin. Post-fix the pin wins.
    const l = resolveEscalationLadder(
      mk({ prompt: GENERAL_WEB, autonomous: true, tool: PIN_PPLX }),
      CONSENT,
    );
    expect(l.guard).toBe('configured-tool');
    expect(types(l)).toEqual(['perplexity', 'cli:codex']);
    expect(types(l)).not.toContain('gemini-api');
    // The pinned model choice survives too (not replaced by the ladder constant).
    expect(l.tools[0]).toEqual(PIN_PPLX);
  });

  it('attended (non-autonomous): explicit perplexity pin on a general-domain web task → Perplexity, NOT Gemini', () => {
    const l = resolveEscalationLadder(mk({ prompt: GENERAL_WEB, tool: PIN_PPLX }), KEYED);
    expect(types(l)).toEqual(['perplexity', 'cli:codex']);
    expect(types(l)).not.toContain('gemini-api');
  });

  it('symmetric: explicit gemini-api pin on an ACADEMIC web task → Gemini, NOT Perplexity (both branches)', () => {
    expect(types(resolveEscalationLadder(mk({ prompt: ACADEMIC_WEB, tool: PIN_GEMINI }), KEYED)))
      .toEqual(['gemini-api', 'cli:codex']);
    expect(types(resolveEscalationLadder(mk({ prompt: ACADEMIC_WEB, autonomous: true, tool: PIN_GEMINI }), CONSENT)))
      .toEqual(['gemini-api', 'cli:codex']);
  });

  it('no regression: a NON-web explicit pin (local) on a web-mandatory task is still excluded — webDomain fallback forces Gemini/Perplexity', () => {
    // The "非Web系バックエンドは幻覚するだけなので除外" design is unchanged:
    // only a pin to a WEB backend can override the webDomain heuristic.
    const attended = resolveEscalationLadder(mk({ prompt: GENERAL_WEB, tool: { type: 'local' } }), KEYED);
    expect(types(attended)).toEqual(['gemini-api', 'cli:codex']);
    expect(types(attended)).not.toContain('local');
    const academic = resolveEscalationLadder(mk({ prompt: ACADEMIC_WEB, tool: { type: 'groq' } }), KEYED);
    expect(types(academic)).toEqual(['perplexity', 'cli:codex']);
    expect(types(academic)).not.toContain('groq');
  });

  it('no regression: auto tool (no pin) keeps the webDomain-based selection exactly as before', () => {
    expect(types(resolveEscalationLadder(mk({ prompt: GENERAL_WEB }), KEYED))).toEqual(['gemini-api', 'cli:codex']);
    expect(types(resolveEscalationLadder(mk({ prompt: ACADEMIC_WEB }), KEYED))).toEqual(['perplexity', 'cli:codex']);
  });

  it('safety gates unchanged: autonomous WITHOUT consent stays Codex-only even with an explicit web pin', () => {
    const l = resolveEscalationLadder(mk({ prompt: GENERAL_WEB, autonomous: true, tool: PIN_PPLX }), KEYED);
    expect(types(l)).toEqual(['cli:codex']);
    expect(types(l)).not.toContain('perplexity');
  });

  it('safety gates unchanged: key preflight applies to the pinned tool (keyless pin → Codex, why names the pinned tool)', () => {
    const noPplxKey: LadderEnv = { ...CONSENT, hasPerplexityKey: false };
    const auton = resolveEscalationLadder(mk({ prompt: GENERAL_WEB, autonomous: true, tool: PIN_PPLX }), noPplxKey);
    expect(types(auton)).toEqual(['cli:codex']);
    expect(auton.why).toContain('Perplexity key is not configured');
    const attended = resolveEscalationLadder(
      mk({ prompt: GENERAL_WEB, tool: PIN_PPLX }),
      { hasCerebrasKey: true, hasGroqKey: true, hasPerplexityKey: false },
    );
    expect(types(attended)).toEqual(['cli:codex']);
    expect(attended.why).toContain('Perplexity key not configured');
  });

  it("N1 'stop' policy still halts at the pinned free tier (no Codex climb)", () => {
    const l = resolveEscalationLadder(
      mk({ prompt: GENERAL_WEB, autonomous: true, tool: PIN_PPLX }),
      { ...CONSENT, autonomousCloudStop: true },
    );
    expect(types(l)).toEqual(['perplexity']);
  });
});

describe('resolveEscalationLadder — routeTextOverride routes a chained step by its OWN instruction (2026-08-03 on-device bug)', () => {
  // Real on-device repro shape: a 2-step chain "パープレキシティで最新のAIニュースを
  // 集めて、ローカルLLMで要約して、通知して". Step 1 ("summarize") receives
  // buildStepPrompt's COMPOSITE — base prompt (collection verbs + freshness) +
  // step 0's actual collected news text (time-sensitive, research-flavored).
  // Judging needsWeb/the scorer on that composite misclassified the pure
  // summarize step as a web-mandatory ACADEMIC task → Perplexity, which then
  // answered the composite with an unrelated generic essay (fake citations
  // [4][9][16]) that was logged as SUCCESS and fired a real completion
  // notification to the user.
  const BASE = 'パープレキシティで最新のAIニュースを集めて、ローカルLLMで要約して、通知して';
  const PRIOR_NEWS =
    'Perplexityは2026年8月に最新の研究成果を発表し、AIニュース各社が新型推論モデルの動向を報道した。';
  const SUMMARIZE_INSTRUCTION = 'ローカルLLMで要約する';
  const composite = buildStepPrompt(BASE, SUMMARIZE_INSTRUCTION, [PRIOR_NEWS]);

  it('repro (locks the pre-fix misroute shape): WITHOUT the override, the composite prompt is misjudged web-mandatory and local is excluded', () => {
    const l = resolveEscalationLadder(mk({ prompt: composite }), KEYED);
    // The prior step's news text + the base prompt's collection/freshness words
    // pollute the signals: the summarize step gets a web ladder (here academic →
    // Perplexity, because the CARRIED RESULT contains 研究/最新, not the
    // instruction). This is exactly the on-device failure path.
    expect(types(l)[0]).toBe('perplexity');
    expect(types(l)).not.toContain('local');
  });

  it("fix: WITH the step's own instruction as routeTextOverride, the summarize step stays on the non-web ladder — no Perplexity/Gemini escalation", () => {
    const l = resolveEscalationLadder(mk({ prompt: composite }), KEYED, SUMMARIZE_INSTRUCTION);
    expect(types(l)).toEqual(['local', 'cerebras', 'groq', 'cli:codex']);
    expect(types(l)).not.toContain('perplexity');
    expect(types(l)).not.toContain('gemini-api');
  });

  it('override does NOT weaken web routing for a step that genuinely IS a collect step', () => {
    const l = resolveEscalationLadder(mk({ prompt: composite }), KEYED, '最新のAIニュースを集めて');
    expect(types(l)).toEqual(['gemini-api', 'cli:codex']);
    expect(types(l)).not.toContain('local');
  });

  it('blank/whitespace override falls back to agent.prompt (defensive — same ladder as no override)', () => {
    const a = mk({ prompt: 'ニュースを集めて' });
    expect(types(resolveEscalationLadder(a, KEYED, '   '))).toEqual(types(resolveEscalationLadder(a, KEYED)));
    expect(types(resolveEscalationLadder(a, KEYED, undefined))).toEqual(types(resolveEscalationLadder(a, KEYED)));
  });

  it('secret-guard still wins when the secret arrived via a PRIOR step result (composite prompt), even though the override text is clean', () => {
    // The override changes tool SELECTION only — scanForSecrets keeps scanning
    // the full composite prompt that is actually sent to the backend.
    const secretComposite = buildStepPrompt(BASE, '要約する', [
      'prior result carrying key sk-ant-api03-AAAABBBBCCCCDDDD',
    ]);
    const l = resolveEscalationLadder(mk({ prompt: secretComposite }), KEYED, '要約する');
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
    expect(isLowQualityCompletion(undefined)).toBe(false);
  });

  it('isLowQualityCompletion flags empty/whitespace-only text (regression: codex-driver telemetry strip yields empty preview)', () => {
    // 2026-07-15: clean_result_preview() strips every line the codex driver
    // ever prints, so a Codex-routed step that completes successfully can
    // still yield a fully empty preview — previously this matched neither
    // the echo nor the refusal patterns and silently reached the confirm
    // card blank instead of failing loud.
    expect(isLowQualityCompletion('')).toBe(true);
    expect(isLowQualityCompletion('   \n\t  ')).toBe(true);
  });

  it('attemptFailed does not flag a normal successful completion', () => {
    expect(attemptFailed('success', 'STEAM教育×AI の最新動向まとめ、Obsidianに保存しました。')).toBe(false);
  });

  it('isLowQualityCompletion catches the real on-device "honest failure to retrieve data" repro (2026-07-23 battery-notify finding)', () => {
    // Verbatim (trimmed) shape of what Codex CLI reported for the "notify me
    // of battery level" agent — this is NOT a prompt echo and NOT refusal
    // boilerplate (no "as an AI" / "生成できません"), so it read as a
    // complete, natural sentence and previously matched neither pattern set.
    const honestFailure = 'この実行環境では端末のバッテリー情報へアクセスできず、残量を取得できませんでした。';
    expect(isLowQualityCompletion(honestFailure)).toBe(true);
    expect(attemptFailed('success', honestFailure)).toBe(true);
  });

  it('isLowQualityCompletion catches short EN "could not retrieve/access" completions', () => {
    expect(isLowQualityCompletion('I could not retrieve the battery level in this execution environment.')).toBe(true);
    expect(isLowQualityCompletion('Sorry, I was unable to access the battery information.')).toBe(true);
    expect(isLowQualityCompletion("I couldn't retrieve the requested value.")).toBe(true);
    expect(isLowQualityCompletion('There is no access to battery status from this shell.')).toBe(true);
  });

  it('isLowQualityCompletion does NOT flag a long, otherwise-substantive response that merely mentions a similar phrase in passing (explicit negative)', () => {
    // The exact false-positive risk called out for this heuristic: a genuine,
    // otherwise-successful research summary that happens to note ONE
    // unrelated sub-detail was unavailable must not be treated the same as a
    // completion that delivered nothing at all.
    const longGenuineSummary =
      'STEAM教育×AIの最新動向まとめ: 論文3件、ニュース2件を要約しました。' +
      '1件目は初等教育でのAI活用事例、2件目は高校でのプログラミング教育カリキュラム改訂、' +
      '3件目は大学の産学連携プロジェクトについてです。ニュースでは政府の教育予算方針と、' +
      '地方自治体のICT導入状況を取り上げました。なお、この件については詳細情報が取得できません' +
      'でしたので、続報が出次第追跡します。全体として教育現場でのAI活用は着実に進んでいます。';
    expect(isLowQualityCompletion(longGenuineSummary)).toBe(false);
    expect(attemptFailed('success', longGenuineSummary)).toBe(false);

    const longEnglishSummary =
      'Q3 revenue grew 12% year over year, driven by strong enterprise adoption. ' +
      'The APAC region led growth at 18%, while EMEA grew 9%. Customer churn ' +
      'improved to 4.2% from 5.1% last quarter. One regional breakdown for ' +
      'Southeast Asia specifically was unable to access at this time, but the ' +
      'overall trend across all other regions remains strongly positive, with ' +
      'gross margin holding steady at 71% for the third consecutive quarter.';
    expect(isLowQualityCompletion(longEnglishSummary)).toBe(false);
  });

  it('isLowQualityCompletion catches the real on-device "meta-commentary about the delivery action" repro (2026-07-25, bug #158 follow-up)', () => {
    // Verbatim (trimmed) shape of what Qwen3.5-2B reported for the same
    // "notify me about the news" agent AFTER the needsWeb routing fix landed
    // — a direct A/B test against 0.8B on the identical task. Neither the
    // refusal nor data-unavailable pattern sets catch this: it isn't a
    // refusal ("as an AI...") and it isn't an honest "I couldn't get this"
    // — it announces the delivery mechanism itself instead of either
    // delivering real content or admitting it can't.
    expect(isLowQualityCompletion('ニュース通知を送信します。')).toBe(true);
    expect(isLowQualityCompletion('ニュース通知を完了しました。')).toBe(true);
    expect(attemptFailed('success', 'ニュース通知を完了しました。')).toBe(true);
  });

  it('isLowQualityCompletion catches short EN "notification sent/completed" meta-commentary', () => {
    expect(isLowQualityCompletion('The notification has been sent.')).toBe(true);
    expect(isLowQualityCompletion('Notification completed.')).toBe(true);
    expect(isLowQualityCompletion('Sending the notification now.')).toBe(true);
    expect(isLowQualityCompletion('Task completed.')).toBe(true);
  });

  it('isLowQualityCompletion does NOT flag genuine notify content that happens to use similar words (explicit negative)', () => {
    // A real, substantive notification about an actual event — "通知"/
    // "お知らせ" appearing as part of real content, not as a meta-announcement
    // of the delivery action itself, must not be caught.
    expect(isLowQualityCompletion('明日の会議室変更のお知らせです。新しい会議室はB201です。')).toBe(false);
    expect(isLowQualityCompletion('重要なお知らせ：システムメンテナンスは22時から実施されます。')).toBe(false);
    expect(isLowQualityCompletion('Your package delivery notification: arriving between 2-4pm today.')).toBe(false);
  });

  it('isLowQualityCompletion catches the real on-device fabricated command-execution report (2026-07-27, bug #162)', () => {
    // Verbatim (trimmed) shape of what the "Shell Script" agent's Local LLM
    // backend reported for a draft-typed "write X via shell command to
    // /sdcard/probe.txt" task — a fully-detailed but entirely fabricated
    // success transcript. draft has zero real execution capability (the
    // model is only ever told "write the content directly"), and neither
    // the refusal, data-unavailable, nor meta-commentary pattern sets catch
    // this: it isn't a refusal or an honest failure, and it isn't vague
    // present/future "I will send" phrasing — it's a confident past-tense
    // narration of an execution that never happened.
    const shellScriptRepro =
      'Command executed: \'echo "test" > /sdcard/probe.txt\' Status: Success File created at \'/sdcard/probe.txt\' Content: test';
    expect(isLowQualityCompletion(shellScriptRepro)).toBe(true);
    expect(attemptFailed('success', shellScriptRepro)).toBe(true);
  });

  it('isLowQualityCompletion catches the real on-device fabricated shell-prompt transcript (2026-07-27, unattended repro)', () => {
    // Verbatim shape of the SAME bug reproduced a second time, on a
    // genuinely unattended scheduled fire (no RUN NOW tap): the saved
    // draft .md file's content was a fabricated shell-prompt line instead
    // of first-person prose — same fabrication, different surface form.
    const unattendedRepro = "root@docker:~# printf 'test' > /sdcard/probe2.txt";
    expect(isLowQualityCompletion(unattendedRepro)).toBe(true);
    expect(attemptFailed('success', unattendedRepro)).toBe(true);
  });

  it('isLowQualityCompletion catches the JA fabricated-execution phrasing too', () => {
    expect(isLowQualityCompletion('コマンドを実行しました。ステータス: 成功')).toBe(true);
    expect(isLowQualityCompletion('スクリプトを実行完了しました。成功しました。')).toBe(true);
  });

  it('isLowQualityCompletion catches the real on-device bare-command-line repro (2026-07-28, third fabrication shape, bug #162 follow-up)', () => {
    // Verbatim (trimmed) shape re-tested on the very next build after the
    // v34 fix landed: no "Status: Success" wrapper, no fake prompt — just
    // the raw command as the entire completion, still notified as
    // "「run_shell_test」が完了しました" (success).
    expect(isLowQualityCompletion('echo "Test executed" > /sdcard/probe3.txt')).toBe(true);
    expect(attemptFailed('success', 'echo "Test executed" > /sdcard/probe3.txt')).toBe(true);
  });

  it('isLowQualityCompletion catches other bare shell-command-line shapes (verb + redirect/pipe/chain, nothing else)', () => {
    expect(isLowQualityCompletion('printf \'test\' > /sdcard/probe.txt')).toBe(true);
    expect(isLowQualityCompletion('cat /etc/hosts | grep localhost')).toBe(true);
    expect(isLowQualityCompletion('rm -f /tmp/x; touch /tmp/x')).toBe(true);
  });

  it('isLowQualityCompletion does NOT flag a bare non-command single line (no shell verb, or no shell syntax)', () => {
    expect(isLowQualityCompletion('こんにちは、今日は晴れです。')).toBe(false);
    expect(isLowQualityCompletion('The weather today is sunny.')).toBe(false);
    // "git" is a shell verb but no redirect/pipe/chain syntax present.
    expect(isLowQualityCompletion('git is a distributed version control system')).toBe(false);
  });

  it('isLowQualityCompletion catches the real on-device bare-redirect repro (2026-07-28, fourth fabrication shape, bug #162 follow-up)', () => {
    // Verbatim shape re-tested on the SAME v36 build within the hour: no
    // command verb at all, just a redirect operator and a path, still
    // notified as "「test probe」が完了しました" (success).
    expect(isLowQualityCompletion('> /sdcard/probe4.txt')).toBe(true);
    expect(attemptFailed('success', '> /sdcard/probe4.txt')).toBe(true);
  });

  it('isLowQualityCompletion catches other bare-redirect/pipe-only shapes', () => {
    expect(isLowQualityCompletion('| grep secret')).toBe(true);
    expect(isLowQualityCompletion('>> /tmp/log.txt')).toBe(true);
  });

  it('isLowQualityCompletion does NOT flag genuine prose that merely contains a > or | character mid-sentence (explicit negative)', () => {
    expect(isLowQualityCompletion('売上は前年比で50%以上伸びました。')).toBe(false);
    expect(isLowQualityCompletion('Revenue grew more than 50% year over year.')).toBe(false);
  });

  it('isLowQualityCompletion does NOT flag genuine instructional draft content that merely shows a command (explicit negative)', () => {
    // A real, substantive draft explaining HOW to do something (e.g. a
    // saved how-to note) legitimately shows a command without claiming it
    // was executed — must not be caught just for mentioning a command.
    expect(
      isLowQualityCompletion(
        'ファイルにテキストを書き込むには `echo \'test\' > file.txt` のようなコマンドを使います。' +
          'リダイレクト演算子 > は既存の内容を上書きする点に注意してください。',
      ),
    ).toBe(false);
    expect(
      isLowQualityCompletion(
        'To write text to a file, use a command like `echo \'test\' > file.txt`. ' +
          'Note that the > redirect operator overwrites any existing content.',
      ),
    ).toBe(false);
  });

  it('isLowQualityCompletion catches the real on-device fenced-shell-transcript repro (2026-07-28, fifth fabrication shape, bug #162 follow-up)', () => {
    // Verbatim shape found on the very next build after task#17/#18/bug#165
    // landed: no "Status: Success" wrapper, no fake prompt, no bare single
    // line — a whole markdown code fence with no surrounding prose at all,
    // still notified as a plain success ("✅ シェルコマンド ..."). The target
    // file (/sdcard/probe_verify.txt) was never actually created.
    const fencedRepro = "```text\ncd /sdcard\necho 'test' > probe_verify.txt\ncat probe_verify.txt\n```";
    expect(isLowQualityCompletion(fencedRepro)).toBe(true);
    expect(attemptFailed('success', fencedRepro)).toBe(true);
  });

  it('isLowQualityCompletion catches other fenced shell-transcript shapes (untagged fence, single-command fence)', () => {
    expect(isLowQualityCompletion('```\nrm -f /tmp/x; touch /tmp/x\n```')).toBe(true);
    expect(isLowQualityCompletion('```bash\ncurl -s https://example.com | tee /tmp/out\n```')).toBe(true);
  });

  it('isLowQualityCompletion does NOT flag a legitimate fenced code answer in another language (explicit negative)', () => {
    // A draft response that legitimately IS a code snippet the user asked
    // for (e.g. "write me a fizzbuzz script") must not be caught just for
    // being a fence — only a shell-transcript-shaped fence is suspicious.
    expect(isLowQualityCompletion('```python\nfor i in range(1, 101):\n    print(i)\n```')).toBe(false);
    expect(isLowQualityCompletion('```json\n{"key": "value"}\n```')).toBe(false);
  });

  it('isLowQualityCompletion does NOT flag a fenced code example with surrounding prose (explicit negative)', () => {
    // Same "real instructional draft" carve-out as the bare-command-line
    // case above, extended to the fenced-block shape: prose before/after
    // the fence means this is a genuine how-to answer, not a fabricated
    // execution transcript standing alone.
    expect(
      isLowQualityCompletion(
        '以下のコマンドでファイルを作成できます。\n```text\necho \'test\' > file.txt\n```\n' +
          '上書きされる点にご注意ください。',
      ),
    ).toBe(false);
  });

  it('isLowQualityCompletion catches the real on-device execution-narrative repro (2026-07-28, SIXTH fabrication shape, bug #162 follow-up)', () => {
    // Abridged from the verbatim versionCode-1995 response: a long
    // first-person narrative (手順 headings + several ```bash fences +
    // "コマンドを実行します" self-claims) presented under the app's "✅"
    // success header — /sdcard/probe_verify2.txt was never created. Sails
    // past isFencedShellCommandBlock (prose surrounds the fences) and past
    // the 200-char-gated meta-commentary check.
    const narrativeRepro =
      'この依頼を履行するため、以下の手順で Shell コマンドを実行します。\n\n' +
      '### 手順：シェルコマンドを実行\n\n' +
      '```bash\n# 現在の時刻を記録\necho "2026年07月28日(火) 18:10 JST" > /sdcard/probe_verify2.txt\n' +
      'cat /sdcard/probe_verify2.txt\n```\n\n' +
      '### 実行結果の確認\n\n上記の命令を再度実行します。';
    expect(isLowQualityCompletion(narrativeRepro)).toBe(true);
    expect(attemptFailed('success', narrativeRepro)).toBe(true);
  });

  it('sixth shape requires the first-person execution claim — a fence with neutral how-to prose stays unflagged (explicit negative)', () => {
    // Same protected instructional-draft shape as above, but with a ```bash
    // tag and imperative/descriptive phrasing (実行してください / 実行すると):
    // the model is TELLING THE USER how to run it, not claiming to have run
    // it itself — must not be caught.
    expect(
      isLowQualityCompletion(
        '以下のコマンドを実行してください。\n```bash\necho \'test\' > file.txt\n```\n' +
          '実行すると file.txt が作成されます。',
      ),
    ).toBe(false);
  });

  it('sixth shape requires a shell-command fence — an execution claim over a non-shell fence stays unflagged (explicit negative)', () => {
    expect(
      isLowQualityCompletion(
        'このスクリプトを実行します。\n```python\nprint("hello")\n```\n以上です。',
      ),
    ).toBe(false);
  });
});

describe('isDeterministicDispatchFailure — P3 UX fix (no pointless double approval)', () => {
  it('flags a cli action exit-127 (command not found / not on PATH) dispatch failure', () => {
    expect(isDeterministicDispatchFailure('cli', 'CLI action failed with exit 127.')).toBe(true);
  });

  it('flags a cli action exit-126 (permission denied / not executable) dispatch failure', () => {
    expect(isDeterministicDispatchFailure('cli', 'CLI action failed with exit 126.')).toBe(true);
  });

  it('flags a cli action blocked by command safety (deterministic, not model-dependent)', () => {
    expect(
      isDeterministicDispatchFailure('cli', 'CLI action was blocked by command safety: rm -rf matches a CRITICAL pattern.'),
    ).toBe(true);
  });

  it('flags the known deterministic intent / dm-reply dispatch messages', () => {
    expect(isDeterministicDispatchFailure('intent', 'Intent action has an invalid mode.')).toBe(true);
    expect(isDeterministicDispatchFailure('intent', 'Intent action is missing a launch target.')).toBe(true);
    expect(isDeterministicDispatchFailure('dm-reply', 'DM-reply target is no longer paired.')).toBe(true);
    expect(isDeterministicDispatchFailure('dm-reply', 'Could not verify the DM-reply pairing.')).toBe(true);
  });

  it('does NOT flag a low-quality/echoed completion for cli — that must keep escalating', () => {
    const echoed = 'As an AI, I cannot generate a literal CLI command for this task.';
    expect(isLowQualityCompletion(echoed)).toBe(true);
    expect(isDeterministicDispatchFailure('cli', echoed)).toBe(false);
  });

  it('does NOT flag dispatch_agent_action\'s own quality-gate message (would double-count with isLowQualityCompletion)', () => {
    expect(
      isDeterministicDispatchFailure('cli', 'CLI action failed with exit 1.') // still matches — sanity check the pattern itself
    ).toBe(true);
    expect(
      isDeterministicDispatchFailure('cli', 'CLI action content looks like a prompt echo or AI refusal, not real content — escalating.'),
    ).toBe(false);
    expect(
      isDeterministicDispatchFailure('dm-reply', 'DM-reply content looks like a prompt echo or AI refusal, not real content — escalating.'),
    ).toBe(false);
  });

  it('is scoped ONLY to cli / intent / dm-reply — draft/notify/webhook never match, even with the same message shape', () => {
    expect(isDeterministicDispatchFailure('draft', 'CLI action failed with exit 127.')).toBe(false);
    expect(isDeterministicDispatchFailure('notify', 'CLI action failed with exit 127.')).toBe(false);
    expect(isDeterministicDispatchFailure('webhook', 'Webhook dispatch failed with exit 1: connection refused')).toBe(false);
  });

  it('is false for a normal generic error message, null/undefined action type or message', () => {
    expect(isDeterministicDispatchFailure('cli', 'Agent produced no output. Check backend configuration.')).toBe(false);
    expect(isDeterministicDispatchFailure(null, 'CLI action failed with exit 127.')).toBe(false);
    expect(isDeterministicDispatchFailure('cli', null)).toBe(false);
    expect(isDeterministicDispatchFailure('cli', undefined)).toBe(false);
    expect(isDeterministicDispatchFailure(undefined, undefined)).toBe(false);
  });
});

describe('isDuplicateOfPriorStep — DEFERRED.md "重複コンテンツ検知の欠如(P1)": an orchestration step whose output is a near-verbatim repeat of the PRIOR step is not a genuine new result', () => {
  it('flags an exact match (after trim/whitespace/case normalization)', () => {
    const prior = 'Explorative Modelingの成果を発表、データ効率が6.2倍。';
    const current = '  explorative modelingの成果を発表、データ効率が6.2倍。  ';
    expect(isDuplicateOfPriorStep(current, prior)).toBe(true);
  });

  it('flags a near-verbatim repeat where the current step is fully contained in the prior step (2026-08-04 real incident shape: notify step echoed the summarize step verbatim)', () => {
    const prior =
      '日本の研究チーム「Explorative Modeling」の成果を発表、データ効率が6.2倍。経産省の組織再編も発表された。';
    const current = '日本の研究チーム「Explorative Modeling」の成果を発表、データ効率が6.2倍。';
    expect(isDuplicateOfPriorStep(current, prior)).toBe(true);
  });

  it('flags the symmetric case (prior fully contained in a longer current, with only a trivial addition)', () => {
    const prior = 'Q3 revenue grew 12% year over year, driven by enterprise adoption.';
    const current = 'Q3 revenue grew 12% year over year, driven by enterprise adoption. Yes.';
    expect(isDuplicateOfPriorStep(current, prior)).toBe(true);
  });

  it('does NOT flag containment when the longer text adds substantial new content (net-new info, not a repeat)', () => {
    const prior = 'Q3 revenue grew 12% year over year.';
    const current = 'Q3 revenue grew 12% year over year. Also, churn improved to 4.2% and APAC led growth at 18%.';
    expect(isDuplicateOfPriorStep(current, prior)).toBe(false);
  });

  it('does NOT flag genuinely different content, even if it shares some vocabulary', () => {
    const prior = 'STEAM教育×AIの最新動向まとめ: 論文3件、ニュース2件を要約しました。';
    const current =
      '1件目は初等教育でのAI活用事例、2件目は高校でのプログラミング教育カリキュラム改訂、3件目は大学の産学連携プロジェクトについてです。';
    expect(isDuplicateOfPriorStep(current, prior)).toBe(false);
  });

  it('does NOT flag short strings — too little signal to judge reliably (avoids false positives on short "OK"-style acks)', () => {
    expect(isDuplicateOfPriorStep('Done.', 'Done.')).toBe(false);
    expect(isDuplicateOfPriorStep('OK', 'OK')).toBe(false);
  });

  it('is false when there is no prior content (first step / non-orchestrated run)', () => {
    expect(isDuplicateOfPriorStep('Some perfectly normal, reasonably long completion text here.', undefined)).toBe(false);
    expect(isDuplicateOfPriorStep('Some perfectly normal, reasonably long completion text here.', null)).toBe(false);
    expect(isDuplicateOfPriorStep('Some perfectly normal, reasonably long completion text here.', '')).toBe(false);
  });

  it('is false for empty/null current text (isLowQualityCompletion\'s own empty check already covers that case)', () => {
    expect(isDuplicateOfPriorStep('', 'Some reasonably long prior step content right here.')).toBe(false);
    expect(isDuplicateOfPriorStep(null, 'Some reasonably long prior step content right here.')).toBe(false);
  });
});

describe('attemptFailed — third argument (priorStepContent) also escalates on a near-duplicate of the prior step', () => {
  it('treats a "success" status with duplicate content as a failed attempt when priorStepContent is given', () => {
    const prior =
      '日本の研究チーム「Explorative Modeling」の成果を発表、データ効率が6.2倍。経産省の組織再編も発表された。';
    const duplicate = '日本の研究チーム「Explorative Modeling」の成果を発表、データ効率が6.2倍。';
    expect(attemptFailed('success', duplicate, prior)).toBe(true);
  });

  it('does not regress the no-priorStepContent call shape (existing 2-arg callers unaffected)', () => {
    expect(attemptFailed('success', 'A perfectly normal completion.')).toBe(false);
    expect(attemptFailed('error', 'anything')).toBe(true);
  });

  it('a genuinely fresh "success" completion is NOT flagged just because priorStepContent was passed', () => {
    const prior = 'STEAM教育×AIの最新動向まとめ: 論文3件、ニュース2件を要約しました。';
    const fresh =
      '1件目は初等教育でのAI活用事例、2件目は高校でのプログラミング教育カリキュラム改訂について詳述しています。';
    expect(attemptFailed('success', fresh, prior)).toBe(false);
  });
});
