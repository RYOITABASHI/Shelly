/**
 * lib/skill-offer-chat.ts — the "save this run as a skill?" / "apply this
 * skill improvement?" offers, asked as plain chat text (owner decision
 * 2026-11-02: 「チャットの文で尋ねる形に変える」 — no Alert / card / modal).
 *
 * hooks/use-skill-save-offer.ts posts the offer line into an AI chat
 * conversation and registers ONE pending offer for that conversation here
 * (a newer offer replaces the older one: only the latest is valid). The
 * user's own typed reply in that conversation (hooks/use-ai-pane-dispatch.ts)
 * resolves it when it is exactly a save / apply phrase; any other message
 * leaves it alone (no re-ask, no nagging) and it simply expires after
 * SKILL_OFFER_TTL_MS. Voice transcripts, terminal requests, inbound
 * messages and MONITOR never resolve it (same rule as role changes).
 *
 * In-memory only on purpose: an offer does not survive an app restart.
 */
import { logInfo } from '@/lib/debug-logger';

export const SKILL_OFFER_TTL_MS = 10 * 60_000;

export type SkillOfferKind = 'save' | 'improve';

export interface PendingSkillOffer {
  kind: SkillOfferKind;
  /** Conversation key (store/ai-pane-store.ts) the offer was posted in. */
  chatKey: string;
  createdAt: number;
  /** Performs the save / improvement and posts its own result line. */
  apply: () => Promise<void>;
}

const pendingByChat = new Map<string, PendingSkillOffer>();

export function setPendingSkillOffer(offer: PendingSkillOffer): void {
  pendingByChat.set(offer.chatKey, offer);
}

export function getPendingSkillOffer(chatKey: string, now: number = Date.now()): PendingSkillOffer | null {
  const offer = pendingByChat.get(chatKey);
  if (!offer) return null;
  if (now - offer.createdAt > SKILL_OFFER_TTL_MS || now < offer.createdAt - 60_000) {
    pendingByChat.delete(chatKey);
    return null;
  }
  return offer;
}

/** Test-only. */
export function __resetPendingSkillOffersForTests(): void {
  pendingByChat.clear();
}

function normalizeReply(text: string): string {
  return text
    .normalize('NFKC')
    .trim()
    .toLowerCase()
    .replace(/["'“”「」]/g, '')
    .replace(/[\s.!?。！？、,]+$/u, '')
    .replace(/\s+/g, ' ');
}

const SAVE_PHRASES = new Set([
  'save skill',
  'save it',
  'save as skill',
  'save as a skill',
  'save the skill',
  'save this skill',
  'スキルとして保存',
  'スキルとして保存して',
  'スキルとして保存する',
  'スキル保存',
  'スキルを保存',
  'スキルを保存して',
  '保存して',
  '保存する',
]);

const IMPROVE_PHRASES = new Set([
  'apply improvement',
  'apply the improvement',
  'apply it',
  'improve skill',
  'improve the skill',
  '改善を反映',
  '改善を反映して',
  '改善を反映する',
  'スキルを改善',
  'スキルを改善して',
  '反映して',
]);

/** Whole-message match only: "save it later" or "保存しないで" is not a reply. */
export function matchSkillOfferReply(text: string): SkillOfferKind | null {
  const n = normalizeReply(text);
  if (!n) return null;
  if (SAVE_PHRASES.has(n)) return 'save';
  if (IMPROVE_PHRASES.has(n)) return 'improve';
  return null;
}

export interface SkillOfferReplyInput {
  chatKey: string;
  text: string;
  now?: number;
  /** True only for the user's own typing in the composer. */
  typedByUser: boolean;
  /** Set for non-composer origins (terminal, inbound, MONITOR, widget …). */
  source?: string;
  /** Another question (draft confirm, slot-fill, memory / role / policy
   *  confirm, approval …) is the newest open prompt: it wins this turn. */
  otherPromptOpen?: boolean;
}

/**
 * Consume and return the pending offer this reply answers, or null (the
 * offer, if any, stays pending). Never resolves from anything but typing.
 */
export function takeSkillOfferForReply(input: SkillOfferReplyInput): PendingSkillOffer | null {
  if (input.typedByUser !== true || input.source) return null;
  if (input.otherPromptOpen) return null;
  if (input.text.trim().startsWith('@')) return null;
  const kind = matchSkillOfferReply(input.text);
  if (!kind) return null;
  const offer = getPendingSkillOffer(input.chatKey, input.now ?? Date.now());
  if (!offer || offer.kind !== kind) return null;
  pendingByChat.delete(input.chatKey);
  return offer;
}

/**
 * Conversation key of the AI pane a Sidebar / Runs-pane offer goes to: the
 * focused slot when it is an AI pane, else the first visible AI pane. Null
 * when no AI pane is open (the caller logs and does nothing — no Alert).
 * Lazy requires keep this module importable from node unit tests.
 */
export function findSkillOfferChatKey(): string | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { useMultiPaneStore, PRESET_CAPACITY } = require('@/hooks/use-multi-pane');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { resolveAiPaneStoreKey } = require('@/store/ai-pane-store');
    const s = useMultiPaneStore.getState();
    const capacity: number = PRESET_CAPACITY[s.preset] ?? s.slots.length;
    const visible = (s.slots as Array<{ id: string; tab: string } | null>).slice(0, capacity);
    const focused = visible[s.focusedSlot];
    const pick = focused?.tab === 'ai' ? focused : visible.find((slot) => slot?.tab === 'ai');
    return pick ? resolveAiPaneStoreKey(pick.id) : null;
  } catch (error) {
    logInfo('SkillOffer', `no AI pane lookup: ${String((error as Error)?.message || error)}`);
    return null;
  }
}

/** Post one plain SHELLY line into a conversation. Returns false (and logs)
 *  when there is no conversation to post into. */
export function postSkillOfferLine(chatKey: string | null, content: string): boolean {
  if (!chatKey) {
    logInfo('SkillOffer', `no AI pane open; not posted: ${content.slice(0, 80)}`);
    return false;
  }
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { useAIPaneStore } = require('@/store/ai-pane-store');
  const now = Date.now();
  useAIPaneStore.getState().addMessage(chatKey, {
    id: `skill-offer-${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    role: 'assistant',
    content,
    timestamp: now,
    // Part of an app-driven confirmation flow: kept out of the model's
    // history so it never imitates "Reply save skill" on its own.
    flowTurn: true,
  });
  return true;
}
