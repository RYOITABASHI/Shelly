/**
 * lib/agent-user-policy-store.ts — POLICY-001 persistence for user rules (C)
 * and trust-ramp state (B).
 *
 * Stored in the EXISTING ~/.shelly/agents/policy.json (no new folder — the
 * project owner dislikes new persistent dirs). The codex boundary gate
 * hard-denies agent writes / deletes there ('policy-write'); the file has no
 * top-level `id`, so every agents-dir scanner (isAgentMetadata,
 * WidgetAgentRepository, ShellyNotificationListener) already skips it.
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
 * Seal (security review M1). Anything with the agent's uid can delete or
 * rewrite this file, and deleting a deny rule LOOSENS policy. So every write
 * also records sha256(file bytes) through a seal port — SecureStore on the RN
 * side, plus native SharedPreferences, which AgentRuntime exports to every run
 * as the readonly SHELLY_AGENT_POLICY_SEAL that the driver, the PlanSpec
 * executor and the generated .sh verify on their own. During a write the seal
 * briefly lists [new, old] so a crash between the two steps cannot lock the
 * user out; the old hash is a state the user themselves had a moment ago.
 *
 * Fail-closed semantics — `unavailable` (escalate every side effect, refuse
 * to overwrite) when: the file is unparseable; any stored rule is invalid
 * (L5: dropping a rule would silently loosen); the compiled block disagrees
 * with the rules; the file is missing or its hash is not sealed while a seal
 * exists; a non-empty file exists while nothing was ever sealed; or the seal
 * itself cannot be read. Only "no file and no seal" means "no rules".
 */
import {
  PolicyRule,
  USER_POLICY_RELATIVE_PATH,
  compilePolicyRuleLines,
  parseStoredRules,
} from '@/lib/agent-action-policy';
import { TrustState, parseTrustState } from '@/lib/agent-trust-ramp';
import { sha256Hex } from '@/lib/sha256';
import { logInfo, logWarn } from '@/lib/debug-logger';

export type ShellRunner = (cmd: string) => Promise<string>;

export interface UserPolicyData {
  rules: PolicyRule[];
  trust: TrustState;
}

export interface LoadedUserPolicy {
  data: UserPolicyData;
  /** true when the policy cannot be trusted (see module doc) — fail-closed. */
  unavailable: boolean;
}

/** Where the seal lives. read() resolves null when the seal is unreadable. */
export interface UserPolicySealPort {
  read: () => Promise<string[] | null>;
  write: (hashes: string[]) => Promise<void>;
}

export const MAX_USER_RULES = 50;
const SEAL_HASH_RE = /^[0-9a-f]{64}$/;

let sealPort: UserPolicySealPort | null = null;

/** Wire the seal (lib/agent-policy-device.ts on device; an in-memory fake in tests). */
export function configureUserPolicySealPort(port: UserPolicySealPort | null): void {
  sealPort = port;
}

export function emptyUserPolicy(): UserPolicyData {
  return { rules: [], trust: { counters: {}, allows: [] } };
}

/** Parse the raw file text (content check only; the seal is checked separately). */
export function parseUserPolicyFile(text: string): LoadedUserPolicy {
  const trimmed = (text || '').trim();
  if (!trimmed) return { data: emptyUserPolicy(), unavailable: false };
  const unavailable = { data: emptyUserPolicy(), unavailable: true };
  let raw: unknown;
  try {
    raw = JSON.parse(trimmed);
  } catch {
    return unavailable;
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return unavailable;
  const r = raw as Record<string, unknown>;
  if (r.kind !== 'shelly.user-policy') return unavailable;
  const up = r.userPolicy && typeof r.userPolicy === 'object' ? (r.userPolicy as Record<string, unknown>) : null;
  if (!up || !Array.isArray(up.rules)) return unavailable;
  const rules = parseStoredRules(up.rules);
  // L5: a rule that fails validation is NOT silently dropped (that loosens).
  if (rules.length !== up.rules.length || rules.length > MAX_USER_RULES) return unavailable;
  // The executors enforce the compiled block; it must say exactly what the rules say.
  const compiled = r.compiledActionRules;
  const expected = compilePolicyRuleLines(rules);
  if (!Array.isArray(compiled) || compiled.length !== expected.length || compiled.some((l, i) => l !== expected[i])) {
    return unavailable;
  }
  return { data: { rules, trust: parseTrustState(up.trust) }, unavailable: false };
}

/**
 * Seal verdict for a file state. `seal` null ⇒ unreadable ⇒ false. An empty
 * seal accepts only "no file / empty file" (nothing was ever written).
 */
export function isSealedPolicyState(exists: boolean, text: string, fileHash: string, seal: readonly string[] | null): boolean {
  if (!seal) return false;
  if (seal.length === 0) return !exists || !text.trim();
  if (!exists || !SEAL_HASH_RE.test(fileHash)) return false;
  return seal.includes(fileHash);
}

/** Parse a comma-separated seal value; invalid entries make the whole seal unreadable. */
export function parseSealValue(raw: string | null | undefined): string[] | null {
  const v = (raw || '').trim();
  if (!v) return [];
  const parts = v.split(',');
  return parts.every((p) => SEAL_HASH_RE.test(p)) ? parts : null;
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

const shaCmd = (f: string) => `{ sha256sum ${f} 2>/dev/null || toybox sha256sum ${f} 2>/dev/null; } | cut -c1-64`;

// "M" when the file does not exist; else "P" + the shell-computed sha256 of
// the exact on-disk bytes + newline + content. Hashing in the shell keeps the
// seal byte-exact regardless of how the bridge decodes / trims stdout.
function readCommand(): string {
  const f = `"$HOME/${USER_POLICY_RELATIVE_PATH}"`;
  return `if [ -e ${f} ]; then printf 'P'; ${shaCmd(f)}; cat ${f}; else printf 'M'; fi`;
}

/** Parse readCommand output (exported for tests). */
export function parsePolicyReadOutput(out: string): { exists: boolean; hash: string; text: string } {
  if (!out.startsWith('P')) return { exists: false, hash: '', text: '' };
  const nl = out.indexOf('\n');
  if (nl === -1) return { exists: true, hash: '', text: '' };
  return { exists: true, hash: out.slice(1, nl).trim().toLowerCase(), text: out.slice(nl + 1) };
}

function writeCommand(content: string): string {
  const marker = `SHELLY_POLICY_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
  const target = `"$HOME/${USER_POLICY_RELATIVE_PATH}"`;
  const tmp = `"$HOME/${USER_POLICY_RELATIVE_PATH}.${marker}.tmp"`;
  // Prints the written file's sha256 so the seal records the real bytes.
  return `set -e\nmkdir -p "$(dirname ${target})" && cat > ${tmp} <<'${marker}' && mv -f ${tmp} ${target} && ${shaCmd(target)}\n${content}${marker}`;
}

let cache: LoadedUserPolicy | null = null;
let lastFileHash: string | null = null;
let chain: Promise<unknown> = Promise.resolve();

/** Last loaded/written state, or null before the first load. */
export function getCachedUserPolicy(): LoadedUserPolicy | null {
  return cache;
}

/** Test hook. */
export function __resetUserPolicyCacheForTests(): void {
  cache = null;
  lastFileHash = null;
  chain = Promise.resolve();
}

export async function loadUserPolicy(run: ShellRunner): Promise<LoadedUserPolicy> {
  let out = '';
  try {
    out = await run(readCommand());
  } catch (e) {
    logWarn('Policy', 'policy.json read failed — treating as unavailable', e);
    cache = { data: emptyUserPolicy(), unavailable: true };
    return cache;
  }
  const { exists, hash, text } = parsePolicyReadOutput(out);
  let seal: string[] | null = null;
  try {
    seal = sealPort ? await sealPort.read() : null;
  } catch {
    seal = null;
  }
  const parsed = parseUserPolicyFile(text);
  lastFileHash = exists && SEAL_HASH_RE.test(hash) ? hash : null;
  if (!isSealedPolicyState(exists, text, hash, seal)) {
    logWarn('Policy', `policy.json does not match its seal (exists=${exists}, seal=${seal ? seal.length : 'unreadable'}) — escalating side effects`);
    cache = { data: parsed.data, unavailable: true };
    return cache;
  }
  cache = parsed;
  if (cache.unavailable) logWarn('Policy', 'policy.json is present but invalid — escalating side effects until fixed');
  return cache;
}

/**
 * Serialised read-modify-write. Always re-reads (and re-verifies) the file
 * first and refuses to write over an unavailable one — re-sealing an
 * attacker-edited file would launder the edit. Returns the new state.
 */
export function mutateUserPolicy(
  run: ShellRunner,
  mutate: (data: UserPolicyData) => UserPolicyData,
  now: number = Date.now(),
): Promise<UserPolicyData> {
  const next = chain.then(async () => {
    const loaded = await loadUserPolicy(run);
    if (loaded.unavailable) throw new Error('policy.json is unreadable or does not match its seal; refusing to overwrite it');
    if (!sealPort) throw new Error('policy seal is not configured; refusing to write');
    const previousHash = lastFileHash;
    const updated = mutate(loaded.data);
    const bounded: UserPolicyData = { rules: updated.rules.slice(0, MAX_USER_RULES), trust: updated.trust };
    const content = serializeUserPolicyFile(bounded, now);
    const newHash = sha256Hex(content);
    // [new, old] first so a crash between the two writes stays verifiable.
    await sealPort.write(previousHash && previousHash !== newHash ? [newHash, previousHash] : [newHash]);
    const written = (await run(writeCommand(content))).trim().toLowerCase();
    const actualHash = SEAL_HASH_RE.test(written) ? written : newHash;
    await sealPort.write([actualHash]);
    lastFileHash = actualHash;
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
