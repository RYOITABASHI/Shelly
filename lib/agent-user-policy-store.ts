/**
 * lib/agent-user-policy-store.ts — POLICY-001 persistence for user rules (C)
 * and trust-ramp state (B).
 *
 * Stored in the EXISTING ~/.shelly/agents/policy.json (no new folder — the
 * project owner dislikes new persistent dirs). That exact path is already the
 * boundary gate's hard-denied 'policy-write' target, so a codex-driven agent
 * cannot rewrite its own rules; the file has no top-level `id`, so every
 * agents-dir scanner (isAgentMetadata, WidgetAgentRepository,
 * ShellyNotificationListener) already skips it.
 *
 * Single writer: the RN app. Executors only READ it:
 *   - `compiledActionRules` — coarse `effect|actionType|domain|keyword` lines
 *     (lib/agent-action-policy.ts compilePolicyRuleLines), one JSON string per
 *     line at a fixed 4-space indent so the generated .sh can extract them with
 *     a plain `sed` range without a JSON parser.
 *   - `userPolicy.rules` — the full rules, for the codex gate (driver).
 * Trust allows are deliberately NOT given to any executor: they are only ever
 * honoured at the RN approval choke point.
 *
 * Fail-closed semantics: a MISSING file is "no rules" (the normal first-run
 * state); a PRESENT-but-unparseable file is `unavailable`, which the evaluator
 * turns into "escalate every side effect", and mutations refuse to overwrite
 * it (the user's real rules might be in there).
 */
import {
  PolicyRule,
  USER_POLICY_RELATIVE_PATH,
  compilePolicyRuleLines,
  parseStoredRules,
} from '@/lib/agent-action-policy';
import { TrustState, parseTrustState } from '@/lib/agent-trust-ramp';
import { logInfo, logWarn } from '@/lib/debug-logger';

export type ShellRunner = (cmd: string) => Promise<string>;

export interface UserPolicyData {
  rules: PolicyRule[];
  trust: TrustState;
}

export interface LoadedUserPolicy {
  data: UserPolicyData;
  /** true when the file exists but could not be parsed (fail-closed). */
  unavailable: boolean;
}

export const MAX_USER_RULES = 50;

export function emptyUserPolicy(): UserPolicyData {
  return { rules: [], trust: { counters: {}, allows: [] } };
}

/** Parse the raw file text. Empty/whitespace ⇒ no file ⇒ empty policy. */
export function parseUserPolicyFile(text: string): LoadedUserPolicy {
  const trimmed = (text || '').trim();
  if (!trimmed) return { data: emptyUserPolicy(), unavailable: false };
  let raw: unknown;
  try {
    raw = JSON.parse(trimmed);
  } catch {
    return { data: emptyUserPolicy(), unavailable: true };
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { data: emptyUserPolicy(), unavailable: true };
  const r = raw as Record<string, unknown>;
  const up = r.userPolicy && typeof r.userPolicy === 'object' ? (r.userPolicy as Record<string, unknown>) : {};
  return {
    data: {
      rules: parseStoredRules(up.rules).slice(0, MAX_USER_RULES),
      trust: parseTrustState(up.trust),
    },
    unavailable: false,
  };
}

/** Serialise with the fixed layout the .sh `sed` range relies on. */
export function serializeUserPolicyFile(data: UserPolicyData, now: number): string {
  return `${JSON.stringify(
    {
      version: 1,
      kind: 'shelly.user-policy',
      updatedAt: now,
      compiledActionRules: compilePolicyRuleLines(data.rules),
      userPolicy: { rules: data.rules, trust: data.trust },
    },
    null,
    2,
  )}\n`;
}

function readCommand(): string {
  return `cat "$HOME/${USER_POLICY_RELATIVE_PATH}" 2>/dev/null || true`;
}

function writeCommand(content: string): string {
  const marker = `SHELLY_POLICY_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
  const target = `"$HOME/${USER_POLICY_RELATIVE_PATH}"`;
  const tmp = `"$HOME/${USER_POLICY_RELATIVE_PATH}.${marker}.tmp"`;
  return `set -e\nmkdir -p "$(dirname ${target})" && cat > ${tmp} <<'${marker}' && mv -f ${tmp} ${target}\n${content}${marker}`;
}

let cache: LoadedUserPolicy | null = null;
let chain: Promise<unknown> = Promise.resolve();

/** Last loaded/written state, or null before the first load. */
export function getCachedUserPolicy(): LoadedUserPolicy | null {
  return cache;
}

/** Test hook. */
export function __resetUserPolicyCacheForTests(): void {
  cache = null;
  chain = Promise.resolve();
}

export async function loadUserPolicy(run: ShellRunner): Promise<LoadedUserPolicy> {
  let text = '';
  try {
    text = await run(readCommand());
  } catch (e) {
    logWarn('Policy', 'policy.json read failed — treating as unavailable', e);
    cache = { data: emptyUserPolicy(), unavailable: true };
    return cache;
  }
  cache = parseUserPolicyFile(text);
  if (cache.unavailable) logWarn('Policy', 'policy.json is present but unparseable — escalating side effects until fixed');
  return cache;
}

/**
 * Serialised read-modify-write. Always re-reads the file first (another app
 * process / a restore may have changed it) and refuses to write over an
 * unparseable file. Returns the new state.
 */
export function mutateUserPolicy(
  run: ShellRunner,
  mutate: (data: UserPolicyData) => UserPolicyData,
  now: number = Date.now(),
): Promise<UserPolicyData> {
  const next = chain.then(async () => {
    const loaded = await loadUserPolicy(run);
    if (loaded.unavailable) throw new Error('policy.json is unreadable; refusing to overwrite it');
    const updated = mutate(loaded.data);
    const bounded: UserPolicyData = { rules: updated.rules.slice(0, MAX_USER_RULES), trust: updated.trust };
    await run(writeCommand(serializeUserPolicyFile(bounded, now)));
    cache = { data: bounded, unavailable: false };
    logInfo('Policy', `policy.json written rules=${bounded.rules.length} allows=${bounded.trust.allows.length}`);
    return bounded;
  });
  chain = next.catch(() => undefined);
  return next;
}

/** Short random id for rules / allows. */
export function newPolicyId(prefix: 'r' | 'a'): string {
  return `${prefix}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}
