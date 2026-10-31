/**
 * __tests__/agent-action-chat-reply.test.ts — the chat side of a per-run
 * action approval (lib/agent-action-chat-reply.ts): reply parsing, which
 * ask line a reply answers, and the decision path's safety rules (same
 * native read-then-resolve as the review screen; review-required types
 * never accept from chat; one answer wins).
 *
 * Pure (relative imports, no RN) so it also runs under plain Node with the
 * strip-types shim when Jest cannot start.
 */
import {
  ACTION_CHAT_REPLY_MIN_AGE_MS,
  decideActionApprovalFromChat,
  findActionApprovalReplyTarget,
  parseActionApprovalChatReply,
  type ChatApprovalDeps,
  type PendingActionApprovalMarker,
} from '../lib/agent-action-chat-reply';

const SHA = 'a'.repeat(56) + '1a2b3c4d';
const marker = (over: Partial<PendingActionApprovalMarker> = {}): PendingActionApprovalMarker => ({
  runId: 'run-1',
  requestSha256: SHA,
  hash8: SHA.slice(0, 8),
  reviewRequired: false,
  createdAt: 1_000_000,
  expiresAt: null,
  ...over,
});

describe('parseActionApprovalChatReply', () => {
  it('whole-message OK / NO, in English and Japanese, with or without the binding', () => {
    expect(parseActionApprovalChatReply('OK')).toEqual({ decision: 'accept', hash8: null });
    expect(parseActionApprovalChatReply(' yes. ')).toEqual({ decision: 'accept', hash8: null });
    expect(parseActionApprovalChatReply('許可')).toEqual({ decision: 'accept', hash8: null });
    expect(parseActionApprovalChatReply('NO')).toEqual({ decision: 'decline', hash8: null });
    expect(parseActionApprovalChatReply('拒否')).toEqual({ decision: 'decline', hash8: null });
    expect(parseActionApprovalChatReply('ok AAAAAAAA')).toEqual({ decision: 'accept', hash8: 'aaaaaaaa' });
    expect(parseActionApprovalChatReply('却下 1a2b3c4d')).toEqual({ decision: 'decline', hash8: '1a2b3c4d' });
  });

  it('never a substring match', () => {
    expect(parseActionApprovalChatReply('make it snappier, ok?')).toBeNull();
    expect(parseActionApprovalChatReply('ok then no')).toBeNull();
    expect(parseActionApprovalChatReply('')).toBeNull();
  });
});

describe('findActionApprovalReplyTarget', () => {
  const now = marker().createdAt + ACTION_CHAT_REPLY_MIN_AGE_MS + 1;
  const ask = { id: 'm-ask', role: 'assistant', pendingActionApproval: marker() };

  it('a bare OK answers the latest assistant line when it is the ask', () => {
    const t = findActionApprovalReplyTarget({ text: 'ok', messages: [ask], now, otherPromptOpen: false });
    expect(t).toMatchObject({ messageId: 'm-ask', decision: 'accept' });
  });

  it('a bare OK does NOT answer an ask that is no longer the latest assistant line', () => {
    const later = { id: 'm-later', role: 'assistant' };
    expect(findActionApprovalReplyTarget({ text: 'ok', messages: [ask, later], now, otherPromptOpen: false })).toBeNull();
    // Naming the binding still reaches it.
    expect(
      findActionApprovalReplyTarget({ text: 'ok aaaaaaaa', messages: [ask, later], now, otherPromptOpen: false }),
    ).toMatchObject({ messageId: 'm-ask' });
  });

  it('never steals while another question is open; ignores too-young and expired asks', () => {
    expect(findActionApprovalReplyTarget({ text: 'ok', messages: [ask], now, otherPromptOpen: true })).toBeNull();
    expect(findActionApprovalReplyTarget({ text: 'ok', messages: [ask], now: marker().createdAt + 10, otherPromptOpen: false })).toBeNull();
    const expired = { ...ask, pendingActionApproval: marker({ expiresAt: now - 1 }) };
    expect(findActionApprovalReplyTarget({ text: 'ok', messages: [expired], now, otherPromptOpen: false })).toBeNull();
  });

  it('a retired line (marker removed) is just text', () => {
    expect(findActionApprovalReplyTarget({ text: 'ok', messages: [{ id: 'm-ask', role: 'assistant' }], now, otherPromptOpen: false })).toBeNull();
  });
});

describe('decideActionApprovalFromChat', () => {
  function deps(over: Partial<ChatApprovalDeps> = {}) {
    const calls: string[] = [];
    const d: ChatApprovalDeps = {
      read: async (runId) => {
        calls.push(`read:${runId}`);
        return { runId, actionType: 'draft', requestSha256: SHA, actionNonce: 'nonce-1', expiresAt: null };
      },
      resolve: async (runId, decision, sha, nonce) => {
        calls.push(`resolve:${runId}:${decision}:${sha.slice(0, 8)}:${nonce}`);
      },
      requestReview: (runId) => {
        calls.push(`review:${runId}`);
      },
      now: () => 2_000_000,
      reviewRequired: (type) => ['cli', 'intent', 'dm-reply', 'browser-pane', 'social-post'].includes(type),
      ...over,
    };
    return { d, calls };
  }

  it('accept: re-reads (mints the nonce now) and resolves with that nonce and the shown hash', async () => {
    const { d, calls } = deps();
    expect(await decideActionApprovalFromChat(marker(), 'accept', d)).toBe('accepted');
    expect(calls).toEqual(['read:run-1', 'resolve:run-1:accept:aaaaaaaa:nonce-1']);
  });

  it('decline works for every type, including review-required ones', async () => {
    const { d, calls } = deps({
      read: async (runId) => ({ runId, actionType: 'cli', requestSha256: SHA, actionNonce: 'n', expiresAt: null }),
    });
    expect(await decideActionApprovalFromChat(marker({ reviewRequired: true }), 'decline', d)).toBe('declined');
    expect(calls).toEqual(['resolve:run-1:decline:aaaaaaaa:n']);
  });

  it('review-required + accept opens the review screen and never resolves (marker or minted type)', async () => {
    const a = deps();
    expect(await decideActionApprovalFromChat(marker({ reviewRequired: true }), 'accept', a.d)).toBe('review');
    expect(a.calls).toEqual(['review:run-1']);
    const b = deps({
      read: async (runId) => ({ runId, actionType: 'social-post', requestSha256: SHA, actionNonce: 'n', expiresAt: null }),
    });
    expect(await decideActionApprovalFromChat(marker(), 'accept', b.d)).toBe('review');
    // (the overriding read does not record itself) — reviewed, never resolved
    expect(b.calls).toEqual(['review:run-1']);
  });

  it('one answer wins: a request already consumed elsewhere is gone, nothing is resolved', async () => {
    const { d, calls } = deps({
      read: async () => {
        throw new Error('invalid agent action approval request');
      },
    });
    expect(await decideActionApprovalFromChat(marker(), 'accept', d)).toBe('gone');
    expect(calls).toEqual([]);
  });

  it('content binding: a request whose hash differs from the line is not answered', async () => {
    const { d, calls } = deps({
      read: async (runId) => ({ runId, actionType: 'draft', requestSha256: 'b'.repeat(64), actionNonce: 'n', expiresAt: null }),
    });
    expect(await decideActionApprovalFromChat(marker(), 'accept', d)).toBe('changed');
    expect(calls).toEqual([]); // nothing resolved, nothing reviewed
  });

  it('expired or nonce-less reads never resolve; a failing resolve reports failed', async () => {
    const e = deps({
      read: async (runId) => ({ runId, actionType: 'draft', requestSha256: SHA, actionNonce: 'n', expiresAt: 1 }),
    });
    expect(await decideActionApprovalFromChat(marker(), 'accept', e.d)).toBe('expired');
    const n = deps({ read: async (runId) => ({ runId, actionType: 'draft', requestSha256: SHA, actionNonce: null }) });
    expect(await decideActionApprovalFromChat(marker(), 'accept', n.d)).toBe('failed');
    const f = deps({
      resolve: async () => {
        throw new Error('action approval action is stale or unauthenticated');
      },
    });
    expect(await decideActionApprovalFromChat(marker(), 'decline', f.d)).toBe('failed');
  });
});
