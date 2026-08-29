/**
 * __tests__/agent-action-type-schema-parity.test.ts
 *
 * Codex + Fable5 review (2026-08-29, Hermes Agent parity audit): the agent
 * action-approval type schema is hand-duplicated across TS, a bundled JS
 * asset, and Kotlin, with no codegen tying them together. This drifted
 * twice already — `social-post` (added 2026-07-22) was accepted by the
 * PlanSpec executor and Kotlin's own approval-bridge allowlist docs referred
 * to it as required, yet was silently absent from app/_layout.tsx's parser
 * for over a month, so a non-allowlisted social-post's mandatory approval
 * request could only ever time out; `api-call` had the identical gap.
 *
 * These are source-assertion tests (matching this project's existing
 * pattern in __tests__/plan-executor-parity.test.ts and
 * __tests__/agent-action-approval-bridge-hardening.test.ts): none of these
 * files compile in this environment (no Android toolchain, and the .js is a
 * bundled asset, not a Jest module), so each list is extracted from the
 * real source text with a regex shaped to that file's own syntax and
 * compared as a Set against lib/agent-action-types.ts's canonical lists.
 * A missing/extra/misspelled entry in ANY of these files fails here
 * immediately, instead of silently shipping a dead approval path.
 */
import * as fs from 'fs';
import * as path from 'path';
import {
  ALL_APPROVAL_ACTION_TYPES,
  REVIEW_REQUIRED_ACTION_TYPES,
  UNATTENDED_SAFE_ACTION_TYPES,
} from '@/lib/agent-action-types';

const root = path.resolve(__dirname, '..');
const scouterDir = path.join(
  root,
  'modules/terminal-emulator/android/src/main/java/expo/modules/terminalemulator/scouter',
);
const nativeDir = path.join(root, 'modules/terminal-emulator/android/src/main/java/expo/modules/terminalemulator');

const rootLayout = fs.readFileSync(path.join(root, 'app/_layout.tsx'), 'utf8');
const terminalEmulatorModule = fs.readFileSync(
  path.join(root, 'modules/terminal-emulator/src/TerminalEmulatorModule.ts'),
  'utf8',
);
const actionBridge = fs.readFileSync(path.join(scouterDir, 'AgentActionApprovalBridge.kt'), 'utf8');
const notificationDispatcher = fs.readFileSync(path.join(scouterDir, 'NotificationDispatcher.kt'), 'utf8');
const agentRuntime = fs.readFileSync(path.join(nativeDir, 'AgentRuntime.kt'), 'utf8');
const planExecutorAsset = fs.readFileSync(
  path.join(root, 'modules/terminal-emulator/android/src/main/assets/shelly-plan-executor.js'),
  'utf8',
);

const ALL_SET = new Set<string>(ALL_APPROVAL_ACTION_TYPES);
const REVIEW_SET = new Set<string>(REVIEW_REQUIRED_ACTION_TYPES);
const UNATTENDED_SET = new Set<string>(UNATTENDED_SAFE_ACTION_TYPES);

/** Extract every `'foo'` / `"foo"` action-type-like literal from a matched block. */
function literalsIn(block: string): Set<string> {
  const out = new Set<string>();
  for (const m of block.matchAll(/['"]([a-z_][a-z_-]*[a-z_])['"]/g)) out.add(m[1]);
  return out;
}

/** Find the smallest run of `<needle> op '<lit>'` chained with `&&`/`||` starting at `anchor`. */
function extractChainAfter(source: string, anchor: string): string {
  const start = source.indexOf(anchor);
  if (start === -1) throw new Error(`anchor not found: ${anchor}`);
  // A generous bound — every real chain here is well under 800 chars.
  return source.slice(start, start + 800);
}

describe('agent action-type schema parity (lib/agent-action-types.ts vs. every duplicate)', () => {
  it('app/_layout.tsx: AgentActionApprovalRequest.actionType union matches ALL_APPROVAL_ACTION_TYPES', () => {
    const chain = extractChainAfter(rootLayout, "actionType: 'draft' | 'notify'");
    const unionOnly = chain.slice(0, chain.indexOf(';'));
    expect(literalsIn(unionOnly)).toEqual(ALL_SET);
  });

  it("app/_layout.tsx: parseActionApprovalRequest's allowlist matches ALL_APPROVAL_ACTION_TYPES", () => {
    const chain = extractChainAfter(rootLayout, "actionType !== 'draft'");
    const ifBlock = chain.slice(0, chain.indexOf(') {'));
    expect(literalsIn(ifBlock)).toEqual(ALL_SET);
  });

  it("app/_layout.tsx: handleAgentActionConfirm's review-required bucket matches REVIEW_REQUIRED_ACTION_TYPES", () => {
    const chain = extractChainAfter(rootLayout, "request.actionType !== 'cli'");
    const ifBlock = chain.slice(0, chain.indexOf(')'));
    expect(literalsIn(ifBlock)).toEqual(REVIEW_SET);
  });

  it('TerminalEmulatorModule.ts: both actionType unions match ALL_APPROVAL_ACTION_TYPES', () => {
    const unions = [...terminalEmulatorModule.matchAll(/actionType: ('draft'[^;]+);/g)];
    expect(unions.length).toBeGreaterThanOrEqual(2);
    for (const [, union] of unions) {
      expect(literalsIn(union)).toEqual(ALL_SET);
    }
  });

  it("AgentActionApprovalBridge.kt: fromJson's allowlist matches ALL_APPROVAL_ACTION_TYPES", () => {
    const chain = extractChainAfter(actionBridge, 'it == "draft"');
    const takeIfBlock = chain.slice(0, chain.indexOf('}'));
    expect(literalsIn(takeIfBlock)).toEqual(ALL_SET);
  });

  it('NotificationDispatcher.kt: requiresReview matches REVIEW_REQUIRED_ACTION_TYPES', () => {
    const chain = extractChainAfter(notificationDispatcher, 'val requiresReview =');
    const line = chain.slice(0, chain.indexOf('\n'));
    expect(literalsIn(line)).toEqual(REVIEW_SET);
  });

  it('AgentRuntime.kt: PLAN_EXECUTOR_ACTIONS matches ALL_APPROVAL_ACTION_TYPES plus the internal __suppressed__ sentinel', () => {
    const chain = extractChainAfter(agentRuntime, 'private val PLAN_EXECUTOR_ACTIONS = setOf(');
    const line = chain.slice(0, chain.indexOf('\n'));
    const found = literalsIn(line);
    // __suppressed__ isn't a real action type an approval request ever
    // carries (see AgentRuntime.kt's own usage) — it's an internal marker
    // for a step whose output was already consumed upstream, so it is
    // deliberately excluded from lib/agent-action-types.ts's schema.
    expect(found.has('__suppressed__')).toBe(true);
    found.delete('__suppressed__');
    expect(found).toEqual(ALL_SET);
  });

  it('shelly-plan-executor.js: the full actionType allowlist matches ALL_APPROVAL_ACTION_TYPES', () => {
    const chain = extractChainAfter(planExecutorAsset, "actionType !== 'draft' && actionType !== 'notify' && actionType !== 'webhook' && actionType !== 'cli' && actionType !== 'intent'");
    const ifBlock = chain.slice(0, chain.indexOf(') {'));
    expect(literalsIn(ifBlock)).toEqual(ALL_SET);
  });

  it('shelly-plan-executor.js: the unattended-safe subset matches UNATTENDED_SAFE_ACTION_TYPES', () => {
    const chain = extractChainAfter(planExecutorAsset, "actionType !== 'draft' && actionType !== 'notify' && actionType !== 'webhook' && actionType !== 'cli' && actionType !== 'api-call'");
    const ifBlock = chain.slice(0, chain.indexOf(') {'));
    expect(literalsIn(ifBlock)).toEqual(UNATTENDED_SET);
  });

  it('scripts/ copy and the bundled APK asset stay byte-identical (pre-existing invariant, re-asserted here since this suite reads the asset copy)', () => {
    const scriptCopy = fs.readFileSync(path.join(root, 'scripts', 'shelly-plan-executor.js'), 'utf8');
    expect(planExecutorAsset).toBe(scriptCopy);
  });

  it("lib/signed-approval/types.ts re-exports ApprovalActionType from this file instead of restating it (Codex review, 2026-08-29 — the dormant restatement had already drifted once, missing api-call)", () => {
    const signedApprovalTypes = fs.readFileSync(path.join(root, 'lib/signed-approval/types.ts'), 'utf8');
    expect(signedApprovalTypes).toContain("export type { ApprovalActionType } from '@/lib/agent-action-types';");
    // Belt-and-braces: fail loudly, not silently, if a future edit reverts to
    // a hand-restated union literal instead of the re-export.
    expect(signedApprovalTypes).not.toMatch(/export type ApprovalActionType = '/);
  });
});
