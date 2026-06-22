import {
  buildGetUpdatesUrl,
  isAuthorizedChat,
  isInboundConfigured,
  MAX_INBOUND_TEXT,
  normalizeInboundUtterance,
  processGetUpdates,
  type TelegramGetUpdates,
} from '@/lib/telegram-inbound';

describe('isAuthorizedChat', () => {
  it('accepts only an exact match to the single authorized id', () => {
    expect(isAuthorizedChat('123', '123')).toBe(true);
    expect(isAuthorizedChat(123, '123')).toBe(true); // numeric chat id
    expect(isAuthorizedChat('  123 ', '123')).toBe(true);
    expect(isAuthorizedChat('124', '123')).toBe(false);
    expect(isAuthorizedChat('-1001', '-1001')).toBe(true); // group id
  });
  it('rejects when unconfigured (empty authorized id never matches)', () => {
    expect(isAuthorizedChat('123', '')).toBe(false);
    expect(isAuthorizedChat('123', undefined)).toBe(false);
    expect(isAuthorizedChat(undefined, '123')).toBe(false);
  });
});

describe('normalizeInboundUtterance', () => {
  it('strips a leading @agent and trims', () => {
    expect(normalizeInboundUtterance('@agent summarize the news')).toBe('summarize the news');
    expect(normalizeInboundUtterance('  @Agent  まとめて  ')).toBe('まとめて');
    expect(normalizeInboundUtterance('summarize')).toBe('summarize');
  });
  it('bounds length', () => {
    expect(normalizeInboundUtterance('x'.repeat(5000)).length).toBe(MAX_INBOUND_TEXT);
  });
  it('returns empty for whitespace/marker-only', () => {
    expect(normalizeInboundUtterance('   ')).toBe('');
    expect(normalizeInboundUtterance('@agent')).toBe('');
  });
});

describe('processGetUpdates — authz + offset', () => {
  const authorized = '-100777';
  const resp = (updates: unknown[]): TelegramGetUpdates => ({ ok: true, result: updates as any });

  it('keeps only authorized, non-bot, non-empty messages', () => {
    const out = processGetUpdates(
      resp([
        { update_id: 10, message: { text: '@agent do A', chat: { id: '-100777' } } },
        { update_id: 11, message: { text: 'do B', chat: { id: '-999' } } }, // unauthorized
        { update_id: 12, message: { text: 'bot msg', chat: { id: '-100777' }, from: { is_bot: true } } },
        { update_id: 13, message: { text: '   ', chat: { id: '-100777' } } }, // empty
        { update_id: 14, message: { text: 'do C', chat: { id: -100777 } } }, // numeric id ok
      ]),
      authorized,
      null
    );
    expect(out.utterances.map((u) => u.text)).toEqual(['do A', 'do C']);
  });

  it('advances the offset past dropped (unauthorized/bot) updates — no replay', () => {
    const out = processGetUpdates(
      resp([
        { update_id: 50, message: { text: 'x', chat: { id: '-999' } } }, // dropped
        { update_id: 51, message: { text: 'ok', chat: { id: authorized } } },
      ]),
      authorized,
      null
    );
    expect(out.nextOffset).toBe(52); // max(update_id)+1, even though 50 was dropped
  });

  it('never returns text for an unauthorized chat (no leak channel)', () => {
    const out = processGetUpdates(
      resp([{ update_id: 1, message: { text: 'sudo rm -rf /', chat: { id: '-evil' } } }]),
      authorized,
      null
    );
    expect(out.utterances).toEqual([]);
  });

  it('handles malformed / empty responses without throwing', () => {
    expect(processGetUpdates(null, authorized, null)).toEqual({ utterances: [], nextOffset: null });
    // result null but a prior offset exists → preserve the baseline offset.
    expect(processGetUpdates({ ok: true, result: null as any }, authorized, 5)).toEqual({
      utterances: [],
      nextOffset: 5,
    });
    expect(processGetUpdates({ ok: false }, authorized, null).utterances).toEqual([]);
  });

  it('keeps the prior offset baseline when no new updates arrive', () => {
    const out = processGetUpdates(resp([]), authorized, 100);
    expect(out.utterances).toEqual([]);
    expect(out.nextOffset).toBe(100); // (currentOffset-1)+1
  });
});

describe('buildGetUpdatesUrl', () => {
  it('builds a long-poll url with offset', () => {
    const url = buildGetUpdatesUrl('TOKEN', 42);
    expect(url).toContain('https://api.telegram.org/botTOKEN/getUpdates');
    expect(url).toContain('timeout=30');
    expect(url).toContain('offset=42');
    expect(url).toContain('allowed_updates');
  });
  it('omits offset on the first poll', () => {
    expect(buildGetUpdatesUrl('TOKEN', null)).not.toContain('offset=');
  });
});

describe('isInboundConfigured', () => {
  it('requires enabled + token + chat id', () => {
    expect(isInboundConfigured({ enabled: true, token: 't', authorizedChatId: '1' })).toBe(true);
    expect(isInboundConfigured({ enabled: false, token: 't', authorizedChatId: '1' })).toBe(false);
    expect(isInboundConfigured({ enabled: true, token: '', authorizedChatId: '1' })).toBe(false);
    expect(isInboundConfigured({ enabled: true, token: 't', authorizedChatId: ' ' })).toBe(false);
  });
});
