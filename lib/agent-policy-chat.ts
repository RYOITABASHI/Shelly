/**
 * lib/agent-policy-chat.ts — POLICY-001 chat surface (plain natural-language
 * turns in the AI pane; project rule: NEVER a card/modal/button for agent
 * confirmation).
 *
 * Kept out of hooks/use-ai-pane-dispatch.ts so the dispatcher only has to
 * (1) route the reply to a pending question here and (2) offer each fresh
 * utterance to handlePolicyIntent before its normal routing. Everything this
 * module posts is a flowTurn (excluded from prompt history and journal
 * digestion, like the pendingGlobalMemory flow).
 *
 * Nothing is ever stored on a detection alone:
 *   - a custom rule needs the echoed interpretation + an exact confirm phrase,
 *     and is re-validated (tighten-only schema) at commit time;
 *   - a trust-ramp allow needs a strict whole-message yes (classifyYesNo);
 *     no/unclear adds nothing and suppresses re-asking for that class.
 */
import type { ChatMessage } from '@/store/types';
import { PolicyRule, validatePolicyRule } from '@/lib/agent-action-policy';
import {
  classifyYesNo,
  describePolicyRule,
  detectPolicyListRequest,
  detectPolicyRevokeRequest,
  detectPolicyRuleRequest,
  extractPolicyRule,
  type PolicyChatFn,
} from '@/lib/agent-policy-rule-intent';
import { grantTrustAllow, revokeTrustAllow, suppressTrustOffer, verifyTrustProposal } from '@/lib/agent-trust-ramp';
import { ShellRunner, loadUserPolicy, mutateUserPolicy, newPolicyId } from '@/lib/agent-user-policy-store';
import { isConfirmPhrase } from '@/lib/agent-confirm-phrase';
import { isCancelPhrase } from '@/lib/agent-slot-fill';
import type { LocalLlmConfig } from '@/lib/local-llm';
import { logInfo, logWarn } from '@/lib/debug-logger';
import en from '@/lib/i18n/locales/en';
import ja from '@/lib/i18n/locales/ja';

export type PolicyLocale = 'en' | 'ja';

export interface PolicyChatIO {
  /** Append an assistant flowTurn bubble (extra fields merged in). */
  post: (content: string, extra?: Partial<ChatMessage>) => void;
  run: ShellRunner;
  llm?: { config: LocalLlmConfig; enabled: boolean; chat?: PolicyChatFn } | null;
  now?: () => number;
  /** Trust-allow tamper seal (lib/agent-trust-allow-seal.ts). Deliberately a
   *  per-key add/remove, never "re-seal whatever the file says": a forged
   *  allow injected into policy.json must not get sealed by the next
   *  legitimate grant. Absent ⇒ allows stay unsealed ⇒ never honoured. */
  seal?: { add: (key: string) => Promise<void>; remove: (key: string) => Promise<void> };
}

function strings(locale: PolicyLocale): Record<string, string> {
  return locale === 'ja' ? ja : en;
}

function fill(template: string, params: Record<string, string | number>): string {
  return Object.entries(params).reduce((acc, [k, v]) => acc.split(`{{${k}}}`).join(String(v)), template);
}

// ─── Fresh utterances ────────────────────────────────────────────────────────

/**
 * Offer a fresh (non-pending) utterance to the policy surface. Returns true
 * when it was handled (the caller must stop routing), false to fall through.
 * The caller only calls this when the policy engine flag is ON.
 */
export async function handlePolicyIntent(text: string, locale: PolicyLocale, io: PolicyChatIO): Promise<boolean> {
  const s = strings(locale);
  if (detectPolicyListRequest(text)) {
    await postPolicyListing(locale, io);
    return true;
  }
  const revoke = detectPolicyRevokeRequest(text);
  if (revoke) {
    await revokeFromChat(revoke, locale, io);
    return true;
  }
  const req = detectPolicyRuleRequest(text);
  if (!req) return false;
  const { candidate, via } = await extractPolicyRule(req.text, io.llm ?? null);
  if (!candidate) {
    logInfo('Policy', 'rule utterance could not be parsed — nothing stored');
    io.post(s['policy.rule_parse_failed']);
    return true;
  }
  logInfo('Policy', `rule parsed via=${via} effect=${candidate.effect}`);
  io.post(fill(s['policy.rule_confirm'], { rule: describePolicyRule(candidate, locale) }), {
    pendingPolicyRule: { effect: candidate.effect, match: { ...candidate.match }, source: req.text.slice(0, 300), attempts: 0 },
  });
  return true;
}

async function postPolicyListing(locale: PolicyLocale, io: PolicyChatIO): Promise<void> {
  const s = strings(locale);
  const loaded = await loadUserPolicy(io.run);
  if (loaded.unavailable) {
    io.post(s['policy.unavailable']);
    return;
  }
  const { rules, trust } = loaded.data;
  if (!rules.length && !trust.allows.length) {
    io.post(s['policy.list_empty']);
    return;
  }
  const lines: string[] = [s['policy.list_header']];
  let n = 1;
  for (const r of rules) lines.push(fill(s['policy.list_rule_item'], { n: n++, rule: describePolicyRule(r, locale) }));
  for (const a of trust.allows) lines.push(fill(s['policy.list_allow_item'], { n: n++, label: a.label }));
  lines.push(s['policy.list_footer']);
  io.post(lines.join('\n'));
}

type ListedItem = { kind: 'rule'; rule: PolicyRule; at: number } | { kind: 'allow'; id: string; key: string; label: string; at: number };

async function revokeFromChat(
  req: { target: 'latest' | number; scope: 'allow' | 'rule' | 'any' },
  locale: PolicyLocale,
  io: PolicyChatIO,
): Promise<void> {
  const s = strings(locale);
  const loaded = await loadUserPolicy(io.run);
  if (loaded.unavailable) {
    io.post(s['policy.unavailable']);
    return;
  }
  // Same numbering as the listing: rules first, then trust allows.
  const items: ListedItem[] = [
    ...loaded.data.rules.map((rule) => ({ kind: 'rule' as const, rule, at: rule.createdAt })),
    ...loaded.data.trust.allows.map((a) => ({ kind: 'allow' as const, id: a.id, key: a.key, label: a.label, at: a.createdAt })),
  ];
  let pick: ListedItem | undefined;
  if (typeof req.target === 'number') {
    pick = items[req.target - 1];
  } else {
    const pool = items.filter((i) => req.scope === 'any' || i.kind === req.scope);
    pick = pool.sort((a, b) => b.at - a.at)[0];
  }
  if (!pick) {
    io.post(s['policy.revoke_none']);
    return;
  }
  if (pick.kind === 'rule') {
    // Security review L1: removing a rule LOOSENS policy — echo it and wait
    // for an exact confirm phrase (handlePendingPolicyRevokeReply).
    io.post(fill(s['policy.revoke_rule_confirm'], { rule: describePolicyRule(pick.rule, locale) }), {
      pendingPolicyRevoke: { ruleId: pick.rule.id, attempts: 0 },
    });
    return;
  }
  // Revoking a trust allow only TIGHTENS — done immediately.
  const allowId = pick.id;
  let removed: ListedItem | null = null;
  try {
    await mutateUserPolicy(
      io.run,
      (data) => {
        const out = revokeTrustAllow(data.trust, allowId);
        if (out.removed) removed = { kind: 'allow', id: out.removed.id, key: out.removed.key, label: out.removed.label, at: out.removed.createdAt };
        return { ...data, trust: out.state };
      },
      io.now ? io.now() : Date.now(),
    );
    // Revocation must also leave the seal: shrinking it is always safe.
    const gone = removed as ListedItem | null;
    if (gone && gone.kind === 'allow') await io.seal?.remove(gone.key);
  } catch (e) {
    logWarn('Policy', 'revoke failed', e);
    io.post(`${s['policy.revoke_failed']}: ${e instanceof Error ? e.message : String(e)}`);
    return;
  }
  const r = removed as ListedItem | null;
  if (!r) {
    io.post(s['policy.revoke_none']);
    return;
  }
  logInfo('Policy', `revoked ${r.kind}`);
  io.post(r.kind === 'rule'
    ? fill(s['policy.revoked_rule'], { rule: describePolicyRule(r.rule, locale) })
    : fill(s['policy.revoked_allow'], { label: r.label }));
}

// ─── Replies to a pending question ───────────────────────────────────────────

/**
 * Reply to a pending custom-rule confirmation. Returns true when consumed.
 * Only an exact confirm phrase commits; cancel discards; anything else
 * re-asks once and then drops (bounded, like pendingGlobalMemory).
 */
export async function handlePendingPolicyRuleReply(
  pending: NonNullable<ChatMessage['pendingPolicyRule']>,
  userText: string,
  locale: PolicyLocale,
  io: PolicyChatIO,
): Promise<boolean> {
  const s = strings(locale);
  if (isCancelPhrase(userText) || classifyYesNo(userText) === 'no') {
    io.post(s['policy.rule_cancelled']);
    return true;
  }
  if (isConfirmPhrase(userText) || classifyYesNo(userText) === 'yes') {
    // Re-validate: the pending payload round-tripped through AsyncStorage.
    const v = validatePolicyRule({ effect: pending.effect, match: pending.match });
    if (!v.ok) {
      io.post(s['policy.rule_parse_failed']);
      return true;
    }
    const now = io.now ? io.now() : Date.now();
    const rule: PolicyRule = { id: newPolicyId('r'), effect: v.rule.effect, match: v.rule.match, source: pending.source, createdAt: now };
    try {
      await mutateUserPolicy(io.run, (data) => ({ ...data, rules: [...data.rules, rule] }), now);
    } catch (e) {
      logWarn('Policy', 'rule save failed', e);
      io.post(`${s['policy.rule_failed']}: ${e instanceof Error ? e.message : String(e)}`);
      return true;
    }
    logInfo('Policy', `rule saved id=${rule.id} effect=${rule.effect}`);
    io.post(fill(s['policy.rule_saved'], { rule: describePolicyRule(rule, locale) }));
    return true;
  }
  if (pending.attempts >= 1) {
    io.post(s['policy.rule_discarded_unclear']);
    return true;
  }
  io.post(fill(s['policy.rule_confirm_unclear'], { rule: describePolicyRule(pending as Pick<PolicyRule, 'effect' | 'match'>, locale) }), {
    pendingPolicyRule: { ...pending, attempts: pending.attempts + 1 },
  });
  return true;
}

/**
 * Reply to a pending rule-removal confirmation (security review L1). Only an
 * exact confirm phrase removes the rule; anything else keeps it (re-asks once).
 */
export async function handlePendingPolicyRevokeReply(
  pending: NonNullable<ChatMessage['pendingPolicyRevoke']>,
  userText: string,
  locale: PolicyLocale,
  io: PolicyChatIO,
): Promise<boolean> {
  const s = strings(locale);
  if (isCancelPhrase(userText) || classifyYesNo(userText) === 'no') {
    io.post(s['policy.revoke_rule_kept']);
    return true;
  }
  if (isConfirmPhrase(userText) || classifyYesNo(userText) === 'yes') {
    let removed: PolicyRule | null = null;
    try {
      await mutateUserPolicy(
        io.run,
        (data) => {
          removed = data.rules.find((r) => r.id === pending.ruleId) ?? null;
          return removed ? { ...data, rules: data.rules.filter((r) => r.id !== pending.ruleId) } : data;
        },
        io.now ? io.now() : Date.now(),
      );
    } catch (e) {
      logWarn('Policy', 'rule revoke failed', e);
      io.post(`${s['policy.revoke_failed']}: ${e instanceof Error ? e.message : String(e)}`);
      return true;
    }
    const gone = removed as PolicyRule | null;
    if (!gone) {
      io.post(s['policy.revoke_none']);
      return true;
    }
    logInfo('Policy', `revoked rule id=${gone.id}`);
    io.post(fill(s['policy.revoked_rule'], { rule: describePolicyRule(gone, locale) }));
    return true;
  }
  if (pending.attempts >= 1) {
    io.post(s['policy.revoke_rule_kept']);
    return true;
  }
  io.post(s['policy.revoke_rule_confirm_unclear'], { pendingPolicyRevoke: { ...pending, attempts: pending.attempts + 1 } });
  return true;
}

/**
 * Reply to a pending trust-ramp proposal. A strict yes grants; a clear no
 * suppresses and is consumed. Anything unclear ALSO suppresses (it adds
 * nothing) but is NOT consumed — returns false so the message is routed
 * normally (the user was probably talking about something else).
 */
export async function handlePendingTrustReply(
  pending: NonNullable<ChatMessage['pendingTrustRule']>,
  userText: string,
  locale: PolicyLocale,
  io: PolicyChatIO,
): Promise<boolean> {
  const s = strings(locale);
  const answer = classifyYesNo(userText);
  const now = io.now ? io.now() : Date.now();
  try {
    if (answer === 'yes') {
      // Security review L2: the stored key must re-derive from the stored
      // exact command + agent, and that command must still be eligible.
      if (!verifyTrustProposal(pending)) {
        logWarn('Policy', 'trust proposal failed re-verification — nothing granted');
        io.post(s['policy.trust_failed']);
        return true;
      }
      await mutateUserPolicy(io.run, (data) => ({ ...data, trust: grantTrustAllow(data.trust, pending.key, pending.label, now, newPolicyId('a')) }), now);
      // The seal is what makes the allow effective (see agent-trust-allow-seal.ts).
      await io.seal?.add(pending.key);
      logInfo('Policy', `trust allow granted key=${pending.key}`);
      io.post(fill(s['policy.trust_granted'], { label: pending.label }));
      return true;
    }
    await mutateUserPolicy(io.run, (data) => ({ ...data, trust: suppressTrustOffer(data.trust, pending.key, now) }), now);
  } catch (e) {
    logWarn('Policy', 'trust reply persistence failed', e);
    if (answer === 'yes') {
      io.post(`${s['policy.trust_failed']}: ${e instanceof Error ? e.message : String(e)}`);
      return true;
    }
  }
  if (answer === 'no') {
    io.post(s['policy.trust_declined']);
    return true;
  }
  logInfo('Policy', `trust offer reply unclear — suppressed key=${pending.key}`);
  return false;
}
