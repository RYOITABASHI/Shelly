import {
  buildRegistrationSystemPrompt,
  parseConversationalTurnResponse,
  mergeConversationalExtractionIntoDraft,
  runConversationalRegistrationTurn,
  runConversationalRegistrationTurnLocal,
  normalizeRegistrationQuestion,
  isRepeatedRegistrationQuestion,
  buildConversationTranscript,
  type ConversationalRegistrationContext,
} from '@/lib/agent-conversational-registration';
import type { ParsedAgentDraft } from '@/lib/agent-nl-parser';
import type { SocialConnectorMeta } from '@/store/types';

jest.mock('@/lib/local-llm', () => ({
  ollamaChat: jest.fn(),
}));
jest.mock('@/lib/cerebras', () => ({
  cerebrasChatStream: jest.fn(),
  CEREBRAS_DEFAULT_MODEL: 'qwen-3-235b-a22b-instruct-2507',
}));
jest.mock('@/lib/groq', () => ({
  groqChatStream: jest.fn(),
  GROQ_DEFAULT_MODEL: 'llama-3.3-70b-versatile',
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { ollamaChat } = require('@/lib/local-llm') as { ollamaChat: jest.Mock };
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { cerebrasChatStream } = require('@/lib/cerebras') as { cerebrasChatStream: jest.Mock };
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { groqChatStream } = require('@/lib/groq') as { groqChatStream: jest.Mock };

const FENCE_TAG = '```shelly-agent-registration';
const FENCE_END = '```';

function fenced(json: string, opts: { close?: boolean } = {}): string {
  const close = opts.close === false ? '' : `\n${FENCE_END}`;
  return `${FENCE_TAG}\n${json}${close}`;
}

function baseDraft(overrides: Partial<ParsedAgentDraft> = {}): ParsedAgentDraft {
  return {
    name: 'Vague task',
    prompt: 'do something vague',
    schedule: null,
    scheduleConfident: false,
    scheduleLabel: '未設定（要選択）',
    action: { type: 'draft' },
    tool: { type: 'gemini-api' },
    toolLabel: 'Gemini API',
    rawText: 'do something vague',
    ...overrides,
  };
}

function connector(overrides: Partial<SocialConnectorMeta> = {}): SocialConnectorMeta {
  return {
    id: 'conn-secret-id-0001',
    platform: 'bluesky',
    label: 'My Bluesky',
    host: 'pds.example-secret-host.test',
    fields: ['handle', 'appPassword'],
    createdAt: 0,
    ...overrides,
  };
}

function ctx(overrides: Partial<ConversationalRegistrationContext> = {}): ConversationalRegistrationContext {
  return {
    locale: 'ja',
    deterministicHint: {},
    connectors: [],
    ...overrides,
  };
}

// ─── buildRegistrationSystemPrompt ─────────────────────────────────────────

describe('buildRegistrationSystemPrompt', () => {
  it('produces a Japanese prompt for locale "ja"', () => {
    const p = buildRegistrationSystemPrompt(ctx({ locale: 'ja' }));
    expect(p).toContain('自動化エージェント登録アシスタント');
    expect(p).toContain('日本語');
    // The conditional-JSON instruction (small models drop language instructions
    // when JSON is demanded unconditionally — see the module doc comment).
    expect(p).toContain('JSON を一切出力しないでください');
  });

  it('produces an English prompt for locale "en"', () => {
    const p = buildRegistrationSystemPrompt(ctx({ locale: 'en' }));
    expect(p).toContain("Shelly's automation-agent registration assistant");
    expect(p).toContain('Do NOT emit any JSON on such a turn');
    expect(p).not.toContain('自動化エージェント登録アシスタント');
  });

  it('documents the exact fence tag the model must use for a final proposal', () => {
    expect(buildRegistrationSystemPrompt(ctx({ locale: 'ja' }))).toContain(FENCE_TAG);
    expect(buildRegistrationSystemPrompt(ctx({ locale: 'en' }))).toContain(FENCE_TAG);
  });

  it('forbids raw cron and restricts actionType to draft/notify in BOTH locales', () => {
    const ja = buildRegistrationSystemPrompt(ctx({ locale: 'ja' }));
    expect(ja).toContain('cron 式は絶対に書かないでください');
    expect(ja).toContain('"draft"（結果をファイルに保存）か "notify"');
    expect(ja).toContain('webhook, cli, social-post など');

    const en = buildRegistrationSystemPrompt(ctx({ locale: 'en' }));
    expect(en).toContain('Never write a cron expression');
    expect(en).toContain('"actionType": either "draft"');
    expect(en).toContain('Do not write webhook, cli, social-post');
  });

  it('lists each registered connector by label and platform', () => {
    const p = buildRegistrationSystemPrompt(
      ctx({
        connectors: [
          connector({ id: 'a1', label: 'My Bluesky', platform: 'bluesky' }),
          connector({ id: 'b2', label: '会社Bot', platform: 'slack' }),
        ],
      }),
    );
    expect(p).toContain('- My Bluesky (bluesky)');
    expect(p).toContain('- 会社Bot (slack)');
  });

  it('NEVER leaks connector secrets/identifiers — no id, no host, no secret field names', () => {
    const c = connector({
      id: 'conn-secret-id-0001',
      label: 'My Bluesky',
      host: 'pds.example-secret-host.test',
      fields: ['handle', 'appPassword'],
    });
    for (const locale of ['ja', 'en'] as const) {
      const p = buildRegistrationSystemPrompt(ctx({ locale, connectors: [c] }));
      expect(p).toContain('My Bluesky');
      expect(p).not.toContain('conn-secret-id-0001');
      expect(p).not.toContain('pds.example-secret-host.test');
      expect(p).not.toContain('appPassword');
      // 'handle' is a common English word; assert the whole fields array shape
      // never appears rather than the bare token.
      expect(p).not.toContain('handle,appPassword');
      expect(p).not.toContain('["handle","appPassword"]');
    }
  });

  it('says so explicitly (and does not throw) when no connectors are registered', () => {
    expect(buildRegistrationSystemPrompt(ctx({ locale: 'ja', connectors: [] }))).toContain(
      '登録済みの投稿先はありません',
    );
    expect(buildRegistrationSystemPrompt(ctx({ locale: 'en', connectors: [] }))).toContain(
      'no destinations are registered',
    );
  });

  it('renders the deterministic hint as reference-only, and says so when it resolved nothing', () => {
    expect(buildRegistrationSystemPrompt(ctx({ locale: 'ja' }))).toContain(
      '(自動解析では何も取れませんでした)',
    );
    expect(buildRegistrationSystemPrompt(ctx({ locale: 'en' }))).toContain(
      '(the automatic parse resolved nothing)',
    );
  });

  it('includes the populated fields of the deterministic hint', () => {
    const p = buildRegistrationSystemPrompt(
      ctx({
        locale: 'ja',
        deterministicHint: {
          name: '量子ニュース',
          prompt: '量子コンピュータのニュースをまとめる',
          scheduleLabel: '毎日 08:00',
          scheduleConfident: true,
          action: { type: 'notify' },
          actionCaveat: 'LINE投稿は未対応',
        },
      }),
    );
    expect(p).toContain('- 名前: 量子ニュース');
    expect(p).toContain('- やること: 量子コンピュータのニュースをまとめる');
    expect(p).toContain('- スケジュール: 毎日 08:00 (確定)');
    expect(p).toContain('- 動作: notify');
    expect(p).toContain('- 注意: LINE投稿は未対応');
    expect(p).toContain('間違っていると思ったら従わなくてよい');
  });

  it('marks a non-confident hint schedule as such', () => {
    const p = buildRegistrationSystemPrompt(
      ctx({ locale: 'ja', deterministicHint: { scheduleLabel: '未設定', scheduleConfident: false } }),
    );
    expect(p).toContain('- スケジュール: 未設定 (未確定)');
  });
});

// ─── parseConversationalTurnResponse ───────────────────────────────────────

describe('parseConversationalTurnResponse', () => {
  it('treats a fence-less response as a question, trimmed', () => {
    const turn = parseConversationalTurnResponse('\n  何時に実行しますか？  \n');
    expect(turn).toEqual({ kind: 'question', text: '何時に実行しますか？' });
  });

  it('treats a fence-less response that merely MENTIONS json as a question, not a proposal (only 1 known key present, below MIN_SCHEMA_KEY_MATCHES)', () => {
    const turn = parseConversationalTurnResponse('```json\n{"name":"x"}\n```');
    expect(turn.kind).toBe('question');
  });

  // 2026-08-02 on-device finding (Qwen3.5-2B): the model reliably decides it
  // is done, but does not reliably reproduce the custom FENCE_TAG — it
  // defaults to a plain ```json fence, or no fence at all. Without this
  // schema-based fallback, a fully-formed final answer was silently rendered
  // to the user as if it were a question, and Tier 3 never reached its own
  // proposal->confirm handoff on-device.
  it('recognizes a ```json-fenced object as a proposal once it has >= 2 known proposal keys', () => {
    const turn = parseConversationalTurnResponse(
      '確認なしで勝手にやっておいて。\n\n```json\n' +
        JSON.stringify({
          name: '定期実行エージェント',
          scheduleText: '毎週月曜の9時',
          actionType: 'draft',
          prompt: '定期実行エージェントは、毎週月曜の9時に実行されます。',
          outputPath: '',
          platformHint: 'ブルースカイ',
          autonomousIntent: 'true',
        }) +
        '\n```',
    );
    expect(turn.kind).toBe('proposal');
    if (turn.kind !== 'proposal') throw new Error('unreachable');
    expect(turn.extraction.name).toBe('定期実行エージェント');
    expect(turn.extraction.autonomousIntent).toBe(true);
  });

  it('recognizes a completely unfenced JSON object as a proposal once it has >= 2 known proposal keys', () => {
    const turn = parseConversationalTurnResponse(
      JSON.stringify({ name: '朝ニュース', scheduleText: '毎朝8時', prompt: 'ニュースをまとめる' }),
    );
    expect(turn.kind).toBe('proposal');
    if (turn.kind !== 'proposal') throw new Error('unreachable');
    expect(turn.extraction.name).toBe('朝ニュース');
  });

  it('does NOT promote an unfenced/mistagged object with only 1 matching key (guards against incidental JSON)', () => {
    const turn = parseConversationalTurnResponse('例えばこんな感じです: ```json\n{"name":"例"}\n```');
    expect(turn.kind).toBe('question');
  });

  it('does NOT promote unfenced JSON with zero matching keys', () => {
    const turn = parseConversationalTurnResponse(JSON.stringify({ foo: 'bar', baz: 'qux' }));
    expect(turn.kind).toBe('question');
  });

  it('still prefers the canonical FENCE_TAG when both a tagged and an untagged JSON block are present', () => {
    const raw =
      '参考までにこんな形式もあります: ```json\n{"name":"decoy","scheduleText":"毎日","prompt":"x"}\n```\n\n' +
      fenced(JSON.stringify({ name: 'real', scheduleText: '毎日8時', prompt: 'y' }));
    const turn = parseConversationalTurnResponse(raw);
    expect(turn.kind).toBe('proposal');
    if (turn.kind !== 'proposal') throw new Error('unreachable');
    // extractJsonObjectSpan on the canonical-tag body only sees what's after
    // FENCE_TAG, so the decoy block never enters the parse at all.
    expect(turn.extraction.name).toBe('real');
  });

  it('parses a well-formed fenced block as a proposal', () => {
    const turn = parseConversationalTurnResponse(
      fenced(
        JSON.stringify({
          name: '量子ニュース',
          scheduleText: '毎日8時',
          actionType: 'notify',
          prompt: '量子コンピュータのニュースを要約する',
          outputPath: '',
          platformHint: '',
          autonomousIntent: null,
        }),
      ),
    );
    expect(turn.kind).toBe('proposal');
    if (turn.kind !== 'proposal') throw new Error('unreachable');
    expect(turn.extraction).toEqual({
      name: '量子ニュース',
      scheduleText: '毎日8時',
      actionType: 'notify',
      prompt: '量子コンピュータのニュースを要約する',
      outputPath: undefined,
      platformHint: undefined,
    });
  });

  it('extracts the JSON even when the model wraps the fence in prose', () => {
    const raw = `わかりました、こちらで登録します。\n${fenced('{"name":"朝ニュース"}')}\n以上です。`;
    const turn = parseConversationalTurnResponse(raw);
    expect(turn.kind).toBe('proposal');
    if (turn.kind !== 'proposal') throw new Error('unreachable');
    expect(turn.extraction.name).toBe('朝ニュース');
  });

  it('tolerates a truncated response with no closing fence', () => {
    const turn = parseConversationalTurnResponse(fenced('{"name":"朝ニュース"}', { close: false }));
    expect(turn.kind).toBe('proposal');
    if (turn.kind !== 'proposal') throw new Error('unreachable');
    expect(turn.extraction.name).toBe('朝ニュース');
  });

  it('returns unparseable for a fence containing broken JSON', () => {
    expect(parseConversationalTurnResponse(fenced('{"name": "oops",,,}')).kind).toBe('unparseable');
  });

  it('returns unparseable for a fence containing no object at all', () => {
    expect(parseConversationalTurnResponse(fenced('just some words')).kind).toBe('unparseable');
  });

  it('returns unparseable for a fenced JSON array with no object inside it', () => {
    expect(parseConversationalTurnResponse(fenced('[1, 2, 3]')).kind).toBe('unparseable');
  });

  // Documents the intentional salvage behavior of the first-{ ... last-} scan
  // (identical to lib/agent-llm-fallback.ts's): an object wrapped in an array
  // is recovered rather than discarded. Safe because every recovered field
  // still passes through the same validation + merge gates.
  it('salvages an object wrapped in an array', () => {
    const turn = parseConversationalTurnResponse(fenced('[{"name":"x"}]'));
    expect(turn.kind).toBe('proposal');
    if (turn.kind !== 'proposal') throw new Error('unreachable');
    expect(turn.extraction.name).toBe('x');
  });

  it('returns unparseable for an empty / whitespace-only response (fail closed)', () => {
    expect(parseConversationalTurnResponse('').kind).toBe('unparseable');
    expect(parseConversationalTurnResponse('   \n  ').kind).toBe('unparseable');
  });

  it('drops non-string and blank fields rather than passing them through', () => {
    const turn = parseConversationalTurnResponse(
      fenced(JSON.stringify({ name: '   ', scheduleText: 42, prompt: null, platformHint: 'X' })),
    );
    expect(turn.kind).toBe('proposal');
    if (turn.kind !== 'proposal') throw new Error('unreachable');
    expect(turn.extraction.name).toBeUndefined();
    expect(turn.extraction.scheduleText).toBeUndefined();
    expect(turn.extraction.prompt).toBeUndefined();
    expect(turn.extraction.platformHint).toBe('X');
  });

  it('accepts autonomousIntent as a boolean, or the exact strings "true"/"false" (2026-08-02 on-device: Qwen3.5-2B emits the latter)', () => {
    const t1 = parseConversationalTurnResponse(fenced('{"autonomousIntent": true}'));
    const t2 = parseConversationalTurnResponse(fenced('{"autonomousIntent": false}'));
    const t3 = parseConversationalTurnResponse(fenced('{"autonomousIntent": null}'));
    const t4 = parseConversationalTurnResponse(fenced('{"autonomousIntent": "true"}'));
    const t5 = parseConversationalTurnResponse(fenced('{"autonomousIntent": "false"}'));
    const t6 = parseConversationalTurnResponse(fenced('{"autonomousIntent": "  TRUE "}'));
    // A genuinely ambiguous string is still not guessed at.
    const t7 = parseConversationalTurnResponse(fenced('{"autonomousIntent": "yes"}'));
    const read = (t: ReturnType<typeof parseConversationalTurnResponse>) =>
      t.kind === 'proposal' ? t.extraction.autonomousIntent : 'not-a-proposal';
    expect(read(t1)).toBe(true);
    expect(read(t2)).toBe(false);
    expect(read(t3)).toBeUndefined();
    expect(read(t4)).toBe(true);
    expect(read(t5)).toBe(false);
    expect(read(t6)).toBe(true);
    expect(read(t7)).toBeUndefined();
  });

  it('caps over-long field values', () => {
    const longPrompt = 'あ'.repeat(2500);
    const turn = parseConversationalTurnResponse(fenced(JSON.stringify({ prompt: longPrompt })));
    if (turn.kind !== 'proposal') throw new Error('unreachable');
    expect(turn.extraction.prompt).toHaveLength(2000);
  });

  it('an all-empty fenced object is still a proposal (the merge decides it is a no-op)', () => {
    expect(parseConversationalTurnResponse(fenced('{}')).kind).toBe('proposal');
  });
});

// ─── mergeConversationalExtractionIntoDraft ────────────────────────────────

describe('mergeConversationalExtractionIntoDraft', () => {
  const noConnectors = { connectors: [] as SocialConnectorMeta[] };

  it('applies a scheduleText that parseSchedule resolves confidently', () => {
    const draft = baseDraft();
    const { draft: out, rejectedFields } = mergeConversationalExtractionIntoDraft(
      draft,
      { scheduleText: '毎日8時' },
      noConnectors,
    );
    expect(out.scheduleConfident).toBe(true);
    expect(out.schedule).toBe('0 8 * * *');
    expect(out.llmExtracted).toBe(true);
    expect(rejectedFields).toEqual([]);
  });

  it('REJECTS a scheduleText parseSchedule cannot resolve confidently, and records it', () => {
    const draft = baseDraft();
    const { draft: out, rejectedFields } = mergeConversationalExtractionIntoDraft(
      draft,
      { scheduleText: 'いつか気が向いたら' },
      noConnectors,
    );
    expect(out).toBe(draft);
    expect(out.scheduleConfident).toBe(false);
    expect(rejectedFields).toContain('scheduleText');
  });

  it('never accepts a raw cron string as a schedule (the model may not author cron)', () => {
    const draft = baseDraft();
    const { draft: out } = mergeConversationalExtractionIntoDraft(
      draft,
      { scheduleText: '0 8 * * *' },
      noConnectors,
    );
    expect(out.schedule).toBeNull();
    expect(out.scheduleConfident).toBe(false);
  });

  // ── actionType: the security-critical gate ──
  it('upgrades a draft action to notify', () => {
    const { draft: out, rejectedFields } = mergeConversationalExtractionIntoDraft(
      baseDraft(),
      { actionType: 'notify' },
      noConnectors,
    );
    expect(out.action).toEqual({ type: 'notify' });
    expect(out.llmExtracted).toBe(true);
    expect(rejectedFields).toEqual([]);
  });

  it('IGNORES actionType "webhook" — a privileged action type is never LLM-authorable', () => {
    const draft = baseDraft();
    const { draft: out, rejectedFields } = mergeConversationalExtractionIntoDraft(
      draft,
      { actionType: 'webhook' },
      noConnectors,
    );
    expect(out).toBe(draft);
    expect(out.action).toEqual({ type: 'draft' });
    expect(out.llmExtracted).toBeUndefined();
    expect(rejectedFields).toEqual(['actionType']);
  });

  it.each(['cli', 'app-act', 'api-call', 'intent', 'dm-reply', 'social-post', 'publish', 'DRAFT', ''])(
    'IGNORES the non-allowlisted actionType %p',
    (bad) => {
      const draft = baseDraft();
      const { draft: out } = mergeConversationalExtractionIntoDraft(
        draft,
        // '' is dropped by the parser, but the merge must also stand alone.
        { actionType: bad },
        noConnectors,
      );
      expect(out).toBe(draft);
      expect(out.action).toEqual({ type: 'draft' });
    },
  );

  it('treats a redundant actionType "draft" as a silent no-op, not a rejection', () => {
    const draft = baseDraft();
    const { draft: out, rejectedFields } = mergeConversationalExtractionIntoDraft(
      draft,
      { actionType: 'draft' },
      noConnectors,
    );
    expect(out).toBe(draft);
    expect(rejectedFields).toEqual([]);
  });

  // ── platformHint: existence-checked destination resolution ──
  it('REJECTS a platformHint matching ZERO registered connectors', () => {
    const draft = baseDraft();
    const { draft: out, rejectedFields } = mergeConversationalExtractionIntoDraft(
      draft,
      { platformHint: 'discord' },
      { connectors: [connector({ id: 'a1', platform: 'bluesky', label: 'My Bluesky' })] },
    );
    expect(out).toBe(draft);
    expect(out.action).toEqual({ type: 'draft' });
    expect(rejectedFields).toContain('platformHint');
  });

  it('REJECTS a platformHint matching TWO OR MORE registered connectors (genuinely ambiguous)', () => {
    const draft = baseDraft();
    const { draft: out, rejectedFields } = mergeConversationalExtractionIntoDraft(
      draft,
      { platformHint: 'bluesky' },
      {
        connectors: [
          connector({ id: 'a1', platform: 'bluesky', label: 'Personal' }),
          connector({ id: 'a2', platform: 'bluesky', label: 'Work' }),
        ],
      },
    );
    expect(out).toBe(draft);
    expect(out.action).toEqual({ type: 'draft' });
    expect(rejectedFields).toContain('platformHint');
  });

  it('promotes to social-post ONLY on a unique match, using the REAL connector id', () => {
    const { draft: out, rejectedFields } = mergeConversationalExtractionIntoDraft(
      baseDraft(),
      { platformHint: 'ブルースカイ' },
      {
        connectors: [
          connector({ id: 'real-bsky-id', platform: 'bluesky', label: 'My Bluesky' }),
          connector({ id: 'slack-id', platform: 'slack', label: '会社Bot' }),
        ],
      },
    );
    expect(out.action).toEqual({
      type: 'social-post',
      socialPost: { platform: 'bluesky', connectorId: 'real-bsky-id', text: '{{result}}' },
    });
    expect(out.llmExtracted).toBe(true);
    expect(rejectedFields).toEqual([]);
  });

  it('clears a stale caveat / candidate list once a destination genuinely resolves', () => {
    const { draft: out } = mergeConversationalExtractionIntoDraft(
      baseDraft({
        actionCaveat: 'LINE投稿は未対応のため下書きにします',
        socialPostCandidates: [connector({ id: 'x1' })],
      }),
      { platformHint: 'ブルースカイ' },
      { connectors: [connector({ id: 'real-bsky-id', platform: 'bluesky', label: 'My Bluesky' })] },
    );
    expect(out.action.type).toBe('social-post');
    expect(out.actionCaveat).toBeUndefined();
    expect(out.socialPostCandidates).toBeUndefined();
  });

  it('lets a local notify win over a destination when the model proposes BOTH', () => {
    const { draft: out, rejectedFields } = mergeConversationalExtractionIntoDraft(
      baseDraft(),
      { actionType: 'notify', platformHint: 'ブルースカイ' },
      { connectors: [connector({ id: 'real-bsky-id', platform: 'bluesky', label: 'My Bluesky' })] },
    );
    expect(out.action).toEqual({ type: 'notify' });
    expect(rejectedFields).toContain('platformHint');
  });

  // ── autonomousIntent ──
  it('stores autonomousIntent on llmAutonomousIntent and NEVER touches draft.autonomous', () => {
    const draft = baseDraft();
    const { draft: out } = mergeConversationalExtractionIntoDraft(
      draft,
      { autonomousIntent: true },
      noConnectors,
    );
    expect(out.llmAutonomousIntent).toBe(true);
    expect(out.autonomous).toBeUndefined();
    expect(draft.autonomous).toBeUndefined();
    expect(out.llmExtracted).toBe(true);
  });

  it('does not flip an existing draft.autonomous=false via autonomousIntent=true', () => {
    const { draft: out } = mergeConversationalExtractionIntoDraft(
      baseDraft({ autonomous: false }),
      { autonomousIntent: true },
      noConnectors,
    );
    expect(out.autonomous).toBe(false);
    expect(out.llmAutonomousIntent).toBe(true);
  });

  it('treats an autonomousIntent identical to the draft as a no-op', () => {
    const draft = baseDraft({ llmAutonomousIntent: true });
    const { draft: out } = mergeConversationalExtractionIntoDraft(
      draft,
      { autonomousIntent: true },
      noConnectors,
    );
    expect(out).toBe(draft);
    expect(out.llmExtracted).toBeUndefined();
  });

  // ── remaining fields ──
  it('applies name, prompt (re-routing the tool) and outputPath', () => {
    const { draft: out } = mergeConversationalExtractionIntoDraft(
      baseDraft(),
      { name: '朝ニュース', prompt: 'ニュースを検索して要約する', outputPath: '~/notes/news.md' },
      noConnectors,
    );
    expect(out.name).toBe('朝ニュース');
    expect(out.prompt).toBe('ニュースを検索して要約する');
    expect(out.outputPath).toBe('~/notes/news.md');
    expect(out.toolLabel).toBeTruthy();
    expect(out.llmExtracted).toBe(true);
  });

  it('drops outputPath once the action is no longer a local draft', () => {
    const { draft: out, rejectedFields } = mergeConversationalExtractionIntoDraft(
      baseDraft(),
      { actionType: 'notify', outputPath: '~/notes/news.md' },
      noConnectors,
    );
    expect(out.outputPath).toBeUndefined();
    expect(rejectedFields).toContain('outputPath');
  });

  // ── referential transparency ──
  it('returns the ORIGINAL draft object (same reference, no llmExtracted) when nothing applies', () => {
    const draft = baseDraft();
    const { draft: out, rejectedFields } = mergeConversationalExtractionIntoDraft(
      draft,
      {},
      noConnectors,
    );
    expect(out).toBe(draft);
    expect(out.llmExtracted).toBeUndefined();
    expect(rejectedFields).toEqual([]);
  });

  it('returns the ORIGINAL draft when EVERY proposed field is rejected', () => {
    const draft = baseDraft();
    const { draft: out, rejectedFields } = mergeConversationalExtractionIntoDraft(
      draft,
      { actionType: 'cli', scheduleText: 'いつか気が向いたら', platformHint: 'discord' },
      noConnectors,
    );
    expect(out).toBe(draft);
    expect(out.llmExtracted).toBeUndefined();
    expect(rejectedFields).toEqual(
      expect.arrayContaining(['actionType', 'scheduleText', 'platformHint']),
    );
  });

  it('does not mutate the input draft when it DOES apply something', () => {
    const draft = baseDraft();
    const snapshot = JSON.stringify(draft);
    const { draft: out } = mergeConversationalExtractionIntoDraft(
      draft,
      { name: '朝ニュース' },
      noConnectors,
    );
    expect(out).not.toBe(draft);
    expect(JSON.stringify(draft)).toBe(snapshot);
  });
});

// ─── runConversationalRegistrationTurn (impure, network mocked) ────────────

describe('runConversationalRegistrationTurn', () => {
  const history: Array<{ role: 'user' | 'assistant' | 'system'; content: string }> = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: '毎朝ニュースまとめて' },
  ];
  const enabled = { baseUrl: 'http://127.0.0.1:8080', model: 'Qwen3.5-2B-Q4_K_M', enabled: true };

  beforeEach(() => {
    ollamaChat.mockReset();
    cerebrasChatStream.mockReset();
    groqChatStream.mockReset();
  });

  it('fails closed WITHOUT calling the model when the local LLM is disabled', async () => {
    const res = await runConversationalRegistrationTurn(history, { ...enabled, enabled: false });
    expect(res.success).toBe(false);
    expect(res.raw).toBeUndefined();
    expect(res.error).toContain('local LLM not usable');
    expect(ollamaChat).not.toHaveBeenCalled();
  });

  it('fails closed WITHOUT calling the model when baseUrl/model are missing', async () => {
    const res = await runConversationalRegistrationTurn(history, {
      baseUrl: '',
      model: '',
      enabled: true,
    });
    expect(res.success).toBe(false);
    expect(ollamaChat).not.toHaveBeenCalled();
  });

  it('returns the raw content on success and calls the model exactly once', async () => {
    ollamaChat.mockResolvedValue({ success: true, content: '何時に実行しますか？' });
    const res = await runConversationalRegistrationTurn(history, enabled);
    expect(res).toEqual({ success: true, raw: '何時に実行しますか？' });
    expect(ollamaChat).toHaveBeenCalledTimes(1);
    const [cfg, msgs, timeoutMs] = ollamaChat.mock.calls[0];
    expect(cfg).toEqual({ baseUrl: enabled.baseUrl, model: enabled.model, enabled: true });
    expect(msgs).toBe(history);
    expect(timeoutMs).toBe(30_000);
  });

  it('honors a caller-supplied timeout', async () => {
    ollamaChat.mockResolvedValue({ success: true, content: 'ok' });
    await runConversationalRegistrationTurn(history, enabled, 5_000);
    expect(ollamaChat.mock.calls[0][2]).toBe(5_000);
  });

  it('fails closed when the model call reports failure (e.g. timeout/abort)', async () => {
    ollamaChat.mockResolvedValue({ success: false, content: '', error: 'The operation was aborted' });
    const res = await runConversationalRegistrationTurn(history, enabled);
    expect(res.success).toBe(false);
    expect(res.error).toBe('The operation was aborted');
    expect(res.raw).toBeUndefined();
  });

  it('fails closed on an empty/whitespace-only response', async () => {
    ollamaChat.mockResolvedValue({ success: true, content: '   \n ' });
    const res = await runConversationalRegistrationTurn(history, enabled);
    expect(res.success).toBe(false);
    expect(res.error).toBe('empty response');
  });

  it('never throws — a rejected network call becomes success:false', async () => {
    ollamaChat.mockRejectedValue(new Error('network down'));
    const res = await runConversationalRegistrationTurn(history, enabled);
    expect(res).toEqual({ success: false, error: 'network down' });
  });

  it('runConversationalRegistrationTurnLocal is the same local-only implementation runConversationalRegistrationTurn falls back to (no cloudConfig -> identical behavior)', async () => {
    ollamaChat.mockResolvedValue({ success: true, content: 'ローカルのみの応答' });
    const viaLocal = await runConversationalRegistrationTurnLocal(history, enabled);
    ollamaChat.mockResolvedValue({ success: true, content: 'ローカルのみの応答' });
    const viaDefault = await runConversationalRegistrationTurn(history, enabled);
    expect(viaLocal).toEqual(viaDefault);
  });
});

// ─── runConversationalRegistrationTurn cloud fallback (2026-08-02 Phase 1.5) ─
//
// Order matches lib/llm-interpreter.ts's interpretWithFallback: Cerebras ->
// Groq -> local. The local model is the OFFLINE FLOOR, never removed —
// every test here that reaches it still goes through the exact same
// ollamaChat call the local-only tests above assert on.

describe('runConversationalRegistrationTurn cloud fallback', () => {
  const history: Array<{ role: 'user' | 'assistant' | 'system'; content: string }> = [
    { role: 'system', content: 'sys prompt' },
    { role: 'user', content: '毎朝ニュースまとめて' },
    { role: 'assistant', content: '何時にしますか？' },
    { role: 'user', content: '8時' },
  ];
  const localCfg = { baseUrl: 'http://127.0.0.1:8080', model: 'Qwen3.5-2B-Q4_K_M', enabled: true };

  function streamingSuccess(text: string) {
    return jest.fn(
      (
        _apiKey: string,
        _prompt: string,
        onChunk: (text: string, done: boolean) => void,
      ) => {
        onChunk(text, true);
        return Promise.resolve({ success: true, content: text });
      },
    );
  }

  beforeEach(() => {
    ollamaChat.mockReset();
    cerebrasChatStream.mockReset();
    groqChatStream.mockReset();
  });

  it('with no cloud keys configured, goes straight to local without calling either cloud provider', async () => {
    ollamaChat.mockResolvedValue({ success: true, content: 'local answer' });
    const res = await runConversationalRegistrationTurn(history, localCfg, 30_000, {});
    expect(res).toEqual({ success: true, raw: 'local answer' });
    expect(cerebrasChatStream).not.toHaveBeenCalled();
    expect(groqChatStream).not.toHaveBeenCalled();
    expect(ollamaChat).toHaveBeenCalledTimes(1);
  });

  it('prefers Cerebras when configured, and never calls Groq or local', async () => {
    cerebrasChatStream.mockImplementation(streamingSuccess('Cerebrasの応答'));
    const res = await runConversationalRegistrationTurn(history, localCfg, 30_000, {
      cerebrasApiKey: 'csk_test',
    });
    expect(res).toEqual({ success: true, raw: 'Cerebrasの応答' });
    expect(groqChatStream).not.toHaveBeenCalled();
    expect(ollamaChat).not.toHaveBeenCalled();
  });

  it('splits history into systemPrompt / priorTurns / lastUserContent for the cloud call', async () => {
    cerebrasChatStream.mockImplementation(streamingSuccess('ok'));
    await runConversationalRegistrationTurn(history, localCfg, 30_000, { cerebrasApiKey: 'csk_test' });
    const [apiKey, prompt, , , priorTurns, , systemPromptOverride] = cerebrasChatStream.mock.calls[0];
    expect(apiKey).toBe('csk_test');
    expect(prompt).toBe('8時'); // the LAST user message
    expect(systemPromptOverride).toBe('sys prompt');
    expect(priorTurns).toEqual([
      { role: 'user', content: '毎朝ニュースまとめて' },
      { role: 'assistant', content: '何時にしますか？' },
    ]);
  });

  it('skips Cerebras when no key is present, and uses Groq instead', async () => {
    groqChatStream.mockImplementation(streamingSuccess('Groqの応答'));
    const res = await runConversationalRegistrationTurn(history, localCfg, 30_000, {
      groqApiKey: 'gsk_test',
    });
    expect(res).toEqual({ success: true, raw: 'Groqの応答' });
    expect(cerebrasChatStream).not.toHaveBeenCalled();
    expect(ollamaChat).not.toHaveBeenCalled();
  });

  it('falls through to Groq when Cerebras reports success:false', async () => {
    cerebrasChatStream.mockResolvedValue({ success: false, error: 'quota exceeded' });
    groqChatStream.mockImplementation(streamingSuccess('Groqが拾った'));
    const res = await runConversationalRegistrationTurn(history, localCfg, 30_000, {
      cerebrasApiKey: 'csk_test',
      groqApiKey: 'gsk_test',
    });
    expect(res).toEqual({ success: true, raw: 'Groqが拾った' });
  });

  it('falls through to Groq when Cerebras THROWS (never propagates)', async () => {
    cerebrasChatStream.mockRejectedValue(new Error('network down'));
    groqChatStream.mockImplementation(streamingSuccess('Groqが拾った'));
    const res = await runConversationalRegistrationTurn(history, localCfg, 30_000, {
      cerebrasApiKey: 'csk_test',
      groqApiKey: 'gsk_test',
    });
    expect(res).toEqual({ success: true, raw: 'Groqが拾った' });
  });

  it('falls all the way through to the LOCAL offline floor when both cloud providers fail', async () => {
    cerebrasChatStream.mockResolvedValue({ success: false, error: 'down' });
    groqChatStream.mockResolvedValue({ success: false, error: 'down' });
    ollamaChat.mockResolvedValue({ success: true, content: 'ローカルが最後の砦' });
    const res = await runConversationalRegistrationTurn(history, localCfg, 30_000, {
      cerebrasApiKey: 'csk_test',
      groqApiKey: 'gsk_test',
    });
    expect(res).toEqual({ success: true, raw: 'ローカルが最後の砦' });
    expect(ollamaChat).toHaveBeenCalledTimes(1);
  });

  it('treats an empty/whitespace-only cloud response as unusable and falls through', async () => {
    cerebrasChatStream.mockImplementation(streamingSuccess('   '));
    groqChatStream.mockImplementation(streamingSuccess('Groqが拾った'));
    const res = await runConversationalRegistrationTurn(history, localCfg, 30_000, {
      cerebrasApiKey: 'csk_test',
      groqApiKey: 'gsk_test',
    });
    expect(res).toEqual({ success: true, raw: 'Groqが拾った' });
  });

  it('never throws even when every provider fails, including a disabled local LLM', async () => {
    cerebrasChatStream.mockRejectedValue(new Error('down'));
    groqChatStream.mockRejectedValue(new Error('down'));
    const res = await runConversationalRegistrationTurn(
      history,
      { ...localCfg, enabled: false },
      30_000,
      { cerebrasApiKey: 'csk_test', groqApiKey: 'gsk_test' },
    );
    expect(res.success).toBe(false);
    expect(ollamaChat).not.toHaveBeenCalled();
  });
});

// ─── Repeated-question detection (2026-08-02 on-device finding) ────────────
//
// Qwen3.5-2B re-asked the SAME autonomous-confirmation question three turns
// running while the user answered it twice. The 5-turn cap eventually rescued
// the flow, so nothing was mis-registered — the fix is purely about not making
// the user answer the same question over and over.

describe('buildRegistrationSystemPrompt anti-repeat instruction', () => {
  it('tells the model not to repeat a question it already asked, in BOTH locales', () => {
    const jaPrompt = buildRegistrationSystemPrompt(ctx({ locale: 'ja' }));
    expect(jaPrompt).toContain('同じ質問を、二度と繰り返さないでください');
    expect(jaPrompt).toContain('会話を必ず一歩前に進めて');
    const enPrompt = buildRegistrationSystemPrompt(ctx({ locale: 'en' }));
    expect(enPrompt).toContain('Never repeat a question you have already asked');
    expect(enPrompt).toContain('move the conversation forward');
  });
});

// 2026-08-02 on-device finding: Qwen3.5-2B almost never reproduced the exact
// custom FENCE_TAG for its final proposal, defaulting to ```json instead —
// the parser's schema-based fallback (above) is the real fix, this prompt
// wording is a secondary mitigation only.
describe('buildRegistrationSystemPrompt fence-tag / boolean-type instruction', () => {
  it('explicitly forbids ```json / unfenced JSON and stringly-typed autonomousIntent, in BOTH locales', () => {
    const jaPrompt = buildRegistrationSystemPrompt(ctx({ locale: 'ja' }));
    expect(jaPrompt).toContain('一字一句そのまま使ってください');
    expect(jaPrompt).toContain('json や、フェンスなしの生JSONでは絶対に返さないでください');
    expect(jaPrompt).toContain('真偽値');
    const enPrompt = buildRegistrationSystemPrompt(ctx({ locale: 'en' }));
    expect(enPrompt).toContain('character for character');
    expect(enPrompt).toContain('Never use ```json or unfenced raw JSON');
    expect(enPrompt).toContain('never the strings "true"/"false"');
  });
});

describe('normalizeRegistrationQuestion', () => {
  it('drops surrounding/interior whitespace and sentence punctuation', () => {
    expect(normalizeRegistrationQuestion('  実行するたびに 確認しますか？  ')).toBe(
      '実行するたびに確認しますか',
    );
  });

  it('treats an ideographic space like any other whitespace', () => {
    expect(normalizeRegistrationQuestion('毎回　確認しますか？')).toBe(
      normalizeRegistrationQuestion('毎回 確認しますか?'),
    );
  });

  it('lowercases, so an English re-ask differing only in capitalization matches', () => {
    expect(normalizeRegistrationQuestion('What Time Should It Run?')).toBe(
      normalizeRegistrationQuestion('what time should it run'),
    );
  });

  it('keeps word-internal characters (long-vowel marks, hyphens, digits) intact', () => {
    expect(normalizeRegistrationQuestion('ユーザー名は 8 時で good-enough?')).toBe(
      'ユーザー名は8時でgood-enough',
    );
  });
});

describe('isRepeatedRegistrationQuestion', () => {
  const q = '実行するたびに確認しますか、それとも確認せずに実行しますか？';

  it('returns false when there is no previous question at all (first turn)', () => {
    expect(isRepeatedRegistrationQuestion(undefined, q)).toBe(false);
    expect(isRepeatedRegistrationQuestion(null, q)).toBe(false);
    expect(isRepeatedRegistrationQuestion('', q)).toBe(false);
  });

  it('detects a byte-for-byte repeat (the exact on-device repro)', () => {
    expect(isRepeatedRegistrationQuestion(q, q)).toBe(true);
  });

  it('detects a repeat that differs only in whitespace/punctuation', () => {
    expect(isRepeatedRegistrationQuestion(q, `  ${q.replace('？', '?')}  `)).toBe(true);
    expect(isRepeatedRegistrationQuestion('何時に実行しますか？', '何時に実行しますか')).toBe(true);
  });

  it('does NOT fire on a reworded re-ask — the model is still making progress', () => {
    expect(
      isRepeatedRegistrationQuestion('何時に実行しますか？', '実行する時刻を教えてください。'),
    ).toBe(false);
    expect(
      isRepeatedRegistrationQuestion('What time should it run?', 'Which hour should it run at?'),
    ).toBe(false);
  });

  it('does NOT fire on a question that merely CONTAINS the previous one', () => {
    expect(
      isRepeatedRegistrationQuestion('何時に実行しますか？', '何時に実行しますか？ 平日だけですか？'),
    ).toBe(false);
  });

  it('never claims a repeat when either side normalizes to nothing', () => {
    expect(isRepeatedRegistrationQuestion('？？？', '。。。')).toBe(false);
    expect(isRepeatedRegistrationQuestion('   ', '   ')).toBe(false);
  });
});

// ─── Conversation transcript for the Tier 2 handoff ───────────────────────

describe('buildConversationTranscript', () => {
  it('joins the opening utterance and every later user message, newline-separated', () => {
    expect(
      buildConversationTranscript('@agent 手伝って', ['名前は天気チェッカー', '毎朝8時']),
    ).toBe('@agent 手伝って\n名前は天気チェッカー\n毎朝8時');
  });

  it('trims each entry and skips blank ones', () => {
    expect(buildConversationTranscript('  開始  ', ['', '   ', ' 名前はA '])).toBe('開始\n名前はA');
  });

  it('drops an immediately repeated entry (the opening utterance re-recorded as a chat message)', () => {
    expect(buildConversationTranscript('手伝って', ['手伝って', '毎朝8時'])).toBe('手伝って\n毎朝8時');
  });

  it('returns an empty string when there is nothing at all to say', () => {
    expect(buildConversationTranscript('   ', ['', '  '])).toBe('');
  });

  it('keeps the opening utterance AND the newest answers when over budget', () => {
    const opening = 'OPEN';
    const later = ['a'.repeat(20), 'b'.repeat(20), 'NEWEST'];
    const out = buildConversationTranscript(opening, later, 20);
    expect(out.startsWith('OPEN')).toBe(true);
    expect(out).toContain('NEWEST');
    expect(out).not.toContain('a'.repeat(20));
    expect(out.length).toBeLessThanOrEqual(20);
  });

  it('truncates an over-budget opening utterance rather than returning nothing', () => {
    const out = buildConversationTranscript('x'.repeat(50), ['later'], 10);
    expect(out).toBe('x'.repeat(10));
  });
});
