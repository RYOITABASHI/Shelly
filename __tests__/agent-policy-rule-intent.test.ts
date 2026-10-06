import {
  POLICY_RULE_JSON_SCHEMA,
  classifyYesNo,
  describePolicyRule,
  detectPolicyListRequest,
  detectPolicyRevokeRequest,
  detectPolicyRuleRequest,
  extractPolicyRule,
  parsePolicyRuleLlmResponse,
  parseRuleDeterministic,
} from '@/lib/agent-policy-rule-intent';

describe('detectPolicyRuleRequest — two markers, no questions', () => {
  it.each([
    'お金が絡む操作は必ず聞いて',
    'Xへの投稿は下書きまで',
    '~/work以外には書き込まないで',
    '勝手にメッセージを送信しないで',
    'git pushする前に必ず確認して',
    'always ask before running commands',
    'never post to slack',
    'posts to X stop at a draft',
  ])('detects %s', (text) => {
    expect(detectPolicyRuleRequest(text)).not.toBeNull();
  });

  it.each([
    '保存できたか確認して', // "check whether it saved" — not a rule
    'このファイルを確認して',
    '心配しないで、投稿はあとで',
    "don't post that yet", // no standing marker
    'お金が絡む操作は必ず聞いてくれる？',
    'can you always ask before running commands?',
    '@agent 毎朝ニュースを通知して',
    'こんにちは',
    '必ず聞いて', // no subject
    'ルールを見せて', // list, not a rule
    'さっきの許可を取り消して', // revoke, not a rule
  ])('ignores %s', (text) => {
    expect(detectPolicyRuleRequest(text)).toBeNull();
  });
});

describe('parseRuleDeterministic — the canonical phrasings', () => {
  it('「お金が絡む操作は必ず聞いて」 → ask payment', () => {
    expect(parseRuleDeterministic('お金が絡む操作は必ず聞いて')).toEqual({ effect: 'ask', match: { capability: 'payment' } });
  });

  it('「Xへの投稿は下書きまで」 → draft_only post @ x.com', () => {
    expect(parseRuleDeterministic('Xへの投稿は下書きまで')).toEqual({ effect: 'draft_only', match: { capability: 'post', domain: 'x.com' } });
  });

  it('「~/work以外には書き込まないで」 → deny fs-write outside ~/work', () => {
    expect(parseRuleDeterministic('~/work以外には書き込まないで')).toEqual({ effect: 'deny', match: { capability: 'fs-write', outsidePath: '~/work' } });
  });

  it('「勝手に…しないで」 is ask-first, not a hard deny', () => {
    expect(parseRuleDeterministic('勝手にメッセージを送信しないで')?.effect).toBe('ask');
  });

  it('English phrasings', () => {
    expect(parseRuleDeterministic('never post to slack')).toEqual({ effect: 'deny', match: { capability: 'post', domain: 'slack.com' } });
    expect(parseRuleDeterministic('always ask before running commands')).toEqual({ effect: 'ask', match: { capability: 'exec' } });
    expect(parseRuleDeterministic('never write outside /sdcard/Work')).toEqual({ effect: 'deny', match: { capability: 'fs-write', outsidePath: '/sdcard/Work' } });
    expect(parseRuleDeterministic('posts to example.org are drafts only')).toEqual({ effect: 'draft_only', match: { capability: 'post', domain: 'example.org' } });
  });

  it('returns null when nothing enforceable is found', () => {
    expect(parseRuleDeterministic('必ず聞いて')).toBeNull();
    expect(parseRuleDeterministic('いい感じにして')).toBeNull();
  });
});

describe('LLM pass — untrusted output, tighten-only', () => {
  it('declares a closed JSON schema without any allow effect', () => {
    const effectEnum = (POLICY_RULE_JSON_SCHEMA.properties as Record<string, { enum?: string[] }>).effect.enum;
    expect(effectEnum).not.toContain('allow');
    expect(POLICY_RULE_JSON_SCHEMA.additionalProperties).toBe(false);
  });

  it('accepts a valid tightening rule wrapped in prose / fences', () => {
    expect(parsePolicyRuleLlmResponse('```json\n{"effect":"ask","capability":"payment","keywords":["Invoice"]}\n```')).toEqual({
      effect: 'ask',
      match: { capability: 'payment', keywords: ['invoice'] },
    });
  });

  it('rejects grants, unknown keys, "none" and garbage', () => {
    expect(parsePolicyRuleLlmResponse('{"effect":"allow","capability":"exec"}')).toBeNull();
    expect(parsePolicyRuleLlmResponse('{"effect":"ask","capability":"exec","allow":true}')).toBeNull();
    expect(parsePolicyRuleLlmResponse('{"effect":"none"}')).toBeNull();
    expect(parsePolicyRuleLlmResponse('{"effect":"ask","capability":"none"}')).toBeNull(); // matches nothing
    expect(parsePolicyRuleLlmResponse('not json')).toBeNull();
    expect(parsePolicyRuleLlmResponse('')).toBeNull();
  });

  it('extractPolicyRule: deterministic first, LLM fallback, never throws', async () => {
    const chat = jest.fn(async () => ({ success: true, content: '{"effect":"deny","capability":"secret"}' }));
    const llm = { config: { baseUrl: 'http://127.0.0.1:8080', model: 'm', enabled: true }, enabled: true, chat };
    expect((await extractPolicyRule('Xへの投稿は下書きまで', llm)).via).toBe('deterministic');
    expect(chat).not.toHaveBeenCalled();
    const viaLlm = await extractPolicyRule('鍵ファイルは絶対に読まないこと', { ...llm, chat: jest.fn(async () => ({ success: true, content: '{"effect":"deny","capability":"secret"}' })) });
    // The deterministic parser handles this one too (secret capability, deny).
    expect(viaLlm.candidate).toEqual({ effect: 'deny', match: { capability: 'secret' } });
    const llmOnly = await extractPolicyRule('make sure it checks with me about that thing', llm);
    expect(llmOnly).toEqual({ candidate: { effect: 'deny', match: { capability: 'secret' } }, via: 'llm' });
    const throwing = await extractPolicyRule('make sure it checks with me about that thing', { ...llm, chat: jest.fn(async () => { throw new Error('down'); }) });
    expect(throwing).toEqual({ candidate: null, via: 'none' });
    const granting = await extractPolicyRule('make sure it checks with me about that thing', { ...llm, chat: jest.fn(async () => ({ success: true, content: '{"effect":"allow","capability":"exec"}' })) });
    expect(granting.candidate).toBeNull();
    expect((await extractPolicyRule('make sure it checks with me about that thing', null)).candidate).toBeNull();
  });
});

describe('classifyYesNo — strict whole-message', () => {
  it.each(['はい', 'OK', 'ok', 'yes', 'いいよ', 'うん', 'お願い', '確認なしでいい', 'yes please', 'はい。'])('%s ⇒ yes', (t) => {
    expect(classifyYesNo(t)).toBe('yes');
  });
  it.each(['いいえ', 'no', 'やめて', 'キャンセル', 'だめ', '毎回聞いて', 'not now', 'cancel'])('%s ⇒ no', (t) => {
    expect(classifyYesNo(t)).toBe('no');
  });
  it.each(['yes but only for git status', 'OK, wait', 'たぶん', 'うーん', 'はいはいでもやっぱり', 'maybe', '', 'okay?!?? sure no'])('%s ⇒ unclear', (t) => {
    expect(classifyYesNo(t)).toBe('unclear');
  });
});

describe('list / revoke intents', () => {
  it('detects listing requests', () => {
    for (const t of ['許可ルールを見せて', 'ルールの一覧', '権限を教えて', 'list my rules', 'show permissions']) {
      expect(detectPolicyListRequest(t)).toBe(true);
    }
    expect(detectPolicyListRequest('ニュースを見せて')).toBe(false);
  });

  it('detects revoke requests with target and scope', () => {
    expect(detectPolicyRevokeRequest('さっきの許可を取り消して')).toEqual({ target: 'latest', scope: 'allow' });
    expect(detectPolicyRevokeRequest('2番目のルールを取り消して')).toEqual({ target: 2, scope: 'rule' });
    expect(detectPolicyRevokeRequest('revoke rule 3')).toEqual({ target: 3, scope: 'rule' });
    expect(detectPolicyRevokeRequest('revoke the last permission')).toEqual({ target: 'latest', scope: 'allow' });
    // Agent deletion is NOT a policy revoke (no rule/permission object).
    expect(detectPolicyRevokeRequest('このエージェントを削除して')).toBeNull();
    expect(detectPolicyRevokeRequest('ファイルを消して')).toBeNull();
  });
});

describe('describePolicyRule — NL echo', () => {
  it('renders ja and en', () => {
    expect(describePolicyRule({ effect: 'ask', match: { capability: 'payment' } }, 'ja')).toBe('お金が絡む操作は、実行前に必ずあなたに確認します');
    expect(describePolicyRule({ effect: 'draft_only', match: { capability: 'post', domain: 'x.com' } }, 'ja')).toContain('x.com への投稿');
    expect(describePolicyRule({ effect: 'deny', match: { capability: 'fs-write', outsidePath: '~/work' } }, 'en')).toBe('Never do writing files outside ~/work (deny)');
  });
});
