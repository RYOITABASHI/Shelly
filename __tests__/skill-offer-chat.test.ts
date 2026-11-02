jest.mock('@/lib/debug-logger', () => ({ logInfo: jest.fn(), logWarn: jest.fn(), logError: jest.fn() }));

import {
  SKILL_OFFER_TTL_MS,
  __resetPendingSkillOffersForTests,
  getPendingSkillOffer,
  matchSkillOfferReply,
  postSkillOfferLine,
  setPendingSkillOffer,
  takeSkillOfferForReply,
} from '@/lib/skill-offer-chat';

const T0 = 1_000_000;
const offer = (kind: 'save' | 'improve', chatKey = 'pane-a', createdAt = T0) => ({
  kind,
  chatKey,
  createdAt,
  apply: jest.fn(async () => undefined),
});

describe('matchSkillOfferReply', () => {
  it.each(['save skill', 'Save it', 'SAVE SKILL.', '"save skill"', 'スキルとして保存', '保存して', '保存して！', 'スキルとして保存して。'])(
    'treats %p as a save reply',
    (text) => expect(matchSkillOfferReply(text)).toBe('save'),
  );
  it.each(['apply improvement', 'Apply improvement!', '改善を反映', '改善を反映して'])(
    'treats %p as an improvement reply',
    (text) => expect(matchSkillOfferReply(text)).toBe('improve'),
  );
  it.each(['', 'ok', 'save it later', '保存しないで', 'please save skill for me', 'スキルとして保存しないで', 'yes'])(
    'does not treat %p as a reply',
    (text) => expect(matchSkillOfferReply(text)).toBeNull(),
  );
});

describe('takeSkillOfferForReply', () => {
  beforeEach(() => __resetPendingSkillOffersForTests());

  it('resolves only a typed composer reply in the same conversation', () => {
    setPendingSkillOffer(offer('save'));
    expect(takeSkillOfferForReply({ chatKey: 'pane-a', text: 'save skill', now: T0 + 1, typedByUser: false })).toBeNull();
    expect(takeSkillOfferForReply({ chatKey: 'pane-a', text: 'save skill', now: T0 + 1, typedByUser: true, source: 'terminal-request' })).toBeNull();
    expect(takeSkillOfferForReply({ chatKey: 'pane-a', text: 'save skill', now: T0 + 1, typedByUser: true, source: 'widget-ask' })).toBeNull();
    expect(takeSkillOfferForReply({ chatKey: 'pane-b', text: 'save skill', now: T0 + 1, typedByUser: true })).toBeNull();
    const got = takeSkillOfferForReply({ chatKey: 'pane-a', text: 'save skill', now: T0 + 1, typedByUser: true });
    expect(got?.kind).toBe('save');
    expect(getPendingSkillOffer('pane-a', T0 + 2)).toBeNull();
  });

  it('leaves the offer pending on any other message (no re-ask)', () => {
    setPendingSkillOffer(offer('save'));
    expect(takeSkillOfferForReply({ chatKey: 'pane-a', text: 'what is the weather', now: T0 + 1, typedByUser: true })).toBeNull();
    expect(takeSkillOfferForReply({ chatKey: 'pane-a', text: '@agent save skill', now: T0 + 1, typedByUser: true })).toBeNull();
    expect(getPendingSkillOffer('pane-a', T0 + 2)).not.toBeNull();
  });

  it('yields to a newer open question', () => {
    setPendingSkillOffer(offer('save'));
    expect(takeSkillOfferForReply({ chatKey: 'pane-a', text: '保存して', now: T0 + 1, typedByUser: true, otherPromptOpen: true })).toBeNull();
    expect(getPendingSkillOffer('pane-a', T0 + 2)).not.toBeNull();
  });

  it('expires after the TTL', () => {
    setPendingSkillOffer(offer('save'));
    expect(takeSkillOfferForReply({ chatKey: 'pane-a', text: 'save skill', now: T0 + SKILL_OFFER_TTL_MS + 1, typedByUser: true })).toBeNull();
    expect(getPendingSkillOffer('pane-a', T0)).toBeNull();
  });

  it('keeps only the latest offer per conversation', () => {
    const first = offer('save', 'pane-a', T0);
    const second = offer('improve', 'pane-a', T0 + 10);
    setPendingSkillOffer(first);
    setPendingSkillOffer(second);
    expect(takeSkillOfferForReply({ chatKey: 'pane-a', text: 'save skill', now: T0 + 20, typedByUser: true })).toBeNull();
    expect(takeSkillOfferForReply({ chatKey: 'pane-a', text: 'apply improvement', now: T0 + 20, typedByUser: true })).toBe(second);
  });
});

describe('postSkillOfferLine', () => {
  it('logs and posts nothing when there is no conversation', () => {
    expect(postSkillOfferLine(null, 'hello')).toBe(false);
  });
});
