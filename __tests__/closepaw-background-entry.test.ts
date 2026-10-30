/**
 * Shelly-trusted ClosePaw variant v0.1.0-4+ background entry (2026-10-14):
 * explicit ordered broadcast instead of an activity start, result-code
 * mapping, fallback on 0 / timeout, share-identity on API 34+, and the
 * outcome plumbing into the shim, the agent run result and the chat.
 */
jest.mock('@/lib/i18n', () => ({
  t: (key: string) => key,
  tFor: (locale: string, key: string) => `${locale}:${key}`,
}));
jest.mock('@/modules/terminal-emulator/src/TerminalEmulatorModule', () => ({ __esModule: true, default: {} }));
jest.mock('@/store/ai-pane-store', () => ({
  COMPANION_CONVERSATION_KEY: 'companion',
  useAIPaneStore: { getState: () => ({ addMessage: jest.fn() }) },
}));

import * as fs from 'fs';
import * as path from 'path';
import {
  CLOSEPAW_REFUSAL_CODES,
  asClosePawRefusal,
  closePawOutcomeKey,
  closePawRefusalFromError,
  closePawRefusalKey,
  mapClosePawBroadcastResultCode,
} from '@/lib/closepaw-background';
import { closePawApprovalOutcomeLine } from '@/lib/closepaw-shell-approval';
import en from '@/lib/i18n/locales/en';
import ja from '@/lib/i18n/locales/ja';

const root = path.resolve(__dirname, '..');
const read = (p: string) => fs.readFileSync(path.join(root, p), 'utf8');
const KT = 'modules/terminal-emulator/android/src/main/java/expo/modules/terminalemulator';
const handoff = read(`${KT}/ClosePawHandoff.kt`);
const approvals = read(`${KT}/ClosePawShellApprovals.kt`);

function fn(src: string, signature: string): string {
  const i = src.indexOf(signature);
  expect(i).toBeGreaterThan(-1);
  let depth = 0;
  for (let j = src.indexOf('{', i); j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}' && --depth === 0) return src.slice(i, j + 1);
  }
  return src.slice(i);
}

describe('variant -> broadcast path', () => {
  const launch = fn(handoff, 'fun launch(context: Context, goal: String');

  it('launch() tries the broadcast first, only for the pinned variant and off the main thread', () => {
    const guard = launch.indexOf('if (isTrustedVariantInstalled(context) && Looper.myLooper() != Looper.getMainLooper()) {');
    const send = launch.indexOf('sendVariantBroadcast(context, clean, reqId, nonce)');
    const activity = launch.indexOf('val intent = buildIntent(clean, context)');
    expect(guard).toBeGreaterThan(-1);
    expect(send).toBeGreaterThan(guard);
    expect(activity).toBeGreaterThan(send);
    // The broadcast path never touches the BAL check or the notification.
    const branch = launch.slice(guard, activity);
    expect(branch).not.toContain('canStartActivityNow');
    expect(branch).not.toContain('postHandoffNotification');
    expect(branch).not.toContain('startActivity');
    expect(branch).toContain('is VariantResult.Started -> {');
    expect(branch).toContain('throw ClosePawRefusedException(r.refusal)');
    expect(branch).toContain('VariantResult.NoResponse -> Unit');
  });

  it('the broadcast is explicit (component + action) and carries goal + caller token, never allow_main_display', () => {
    expect(handoff).toContain('const val VARIANT_GOAL_ACTION = "ai.closepaw.action.SHELLY_RUN_GOAL"');
    expect(handoff).toContain('const val VARIANT_GOAL_RECEIVER = "ai.closepaw.app.ShellyGoalReceiver"');
    const build = fn(handoff, 'internal fun buildVariantBroadcast(');
    expect(build).toContain('Intent(VARIANT_GOAL_ACTION)');
    expect(build).toContain('component = ComponentName(PACKAGE, VARIANT_GOAL_RECEIVER)');
    expect(build).toContain('putExtra(EXTRA_GOAL, wireGoal(goal))');
    expect(build).toContain('putExtra(EXTRA_CALLER_TOKEN, callerToken(context.applicationContext))');
    expect(handoff).not.toMatch(/putExtra\(EXTRA_ALLOW_MAIN_DISPLAY/);
    expect(handoff).not.toMatch(/putExtra\("allow_main_display"/);
  });

  it('the token-bearing broadcast is only built from the variant-guarded launch branch', () => {
    const uses = handoff.split('buildVariantBroadcast(context, goal, reqId, resultNonce)').length - 1;
    expect(uses).toBe(1);
    expect(fn(handoff, 'private fun sendVariantBroadcast(')).toContain('buildVariantBroadcast(context, goal, reqId, resultNonce)');
    expect(handoff.split('sendVariantBroadcast(context, clean, reqId, nonce)').length - 1).toBe(1);
    // Non-variant: the activity intent still carries no token.
    expect(fn(handoff, 'fun buildIntent(goal: String, context: Context? = null)')).toMatch(
      /if \(context != null && isTrustedVariantInstalled\(context\)\) \{\s*putExtra\(EXTRA_CALLER_TOKEN/,
    );
  });

  it('ordered broadcast: initial code 0, result on a dedicated thread, bounded wait with fallback on timeout', () => {
    const send = fn(handoff, 'private fun sendVariantBroadcast(');
    expect(send).toContain('context.sendOrderedBroadcast(intent, null, receiver, scheduler, RC_NO_RESPONSE, null, null)');
    expect(send).toContain('Handler(resultThread.looper)');
    expect(send).toContain('latch.await(VARIANT_BROADCAST_TIMEOUT_MS, TimeUnit.MILLISECONDS)');
    expect(send).toMatch(/if \(!answered\) \{[\s\S]*?return VariantResult\.NoResponse/);
    expect(handoff).toContain('const val VARIANT_BROADCAST_TIMEOUT_MS = 5_000L');
    expect(handoff).toContain('const val RC_NO_RESPONSE = 0');
  });

  it('API 34+: shares the sender identity via BroadcastOptions; below 34 the plain call', () => {
    const send = fn(handoff, 'private fun sendVariantBroadcast(');
    const gate = send.indexOf('if (Build.VERSION.SDK_INT >= 34) {');
    const share = send.indexOf('BroadcastOptions.makeBasic().apply { setShareIdentityEnabled(true) }.toBundle()');
    const withOpts = send.indexOf('context.sendOrderedBroadcast(intent, null, opts, receiver, scheduler, RC_NO_RESPONSE, null, null)');
    const plain = send.indexOf('context.sendOrderedBroadcast(intent, null, receiver, scheduler, RC_NO_RESPONSE, null, null)');
    expect(gate).toBeGreaterThan(-1);
    expect(share).toBeGreaterThan(gate);
    expect(withOpts).toBeGreaterThan(share);
    expect(plain).toBeGreaterThan(withOpts);
    expect(send.slice(withOpts, plain)).toContain('} else {');
    expect(handoff).toContain('import android.app.BroadcastOptions');
  });
});

describe('result-code mapping', () => {
  it('TS reference mapping', () => {
    expect(mapClosePawBroadcastResultCode(1)).toEqual({ kind: 'started', outcome: 'background' });
    expect(mapClosePawBroadcastResultCode(2)).toEqual({ kind: 'started', outcome: 'main-display' });
    expect(mapClosePawBroadcastResultCode(16)).toEqual({ kind: 'refused', refusal: 'vd-unavailable' });
    expect(mapClosePawBroadcastResultCode(15)).toEqual({ kind: 'refused', refusal: 'busy' });
    for (const code of [0, 3, 9, 17, -1]) expect(mapClosePawBroadcastResultCode(code)).toEqual({ kind: 'fallback' });
  });

  it('Kotlin mapVariantResultCode matches: 1/2 started, 10-16 refused, anything else (incl. 0) -> NoResponse', () => {
    const map = fn(handoff, 'fun mapVariantResultCode(code: Int): VariantResult');
    expect(map).toContain('RC_STARTED_VIRTUAL_DISPLAY -> VariantResult.Started(Outcome.BACKGROUND)');
    expect(map).toContain('RC_STARTED_MAIN_DISPLAY -> VariantResult.Started(Outcome.MAIN_DISPLAY)');
    expect(map).toContain('?: VariantResult.NoResponse');
    expect(handoff).toContain('const val RC_STARTED_VIRTUAL_DISPLAY = 1');
    expect(handoff).toContain('const val RC_STARTED_MAIN_DISPLAY = 2');
  });

  it('Kotlin Refusal table == TS CLOSEPAW_REFUSAL_CODES', () => {
    const rows = [...handoff.matchAll(/^\s+[A-Z_]+\((\d+), "([a-z-]+)", "/gm)].map((m) => [Number(m[1]), m[2]] as const);
    expect(Object.fromEntries(rows)).toEqual(CLOSEPAW_REFUSAL_CODES);
    expect(rows).toHaveLength(7);
  });

  it('actionable messages: 16 says start Shizuku, 15 says busy', () => {
    expect(handoff).toMatch(/VD_UNAVAILABLE\(16, "vd-unavailable", "[^"]*start Shizuku, then retry"\)/);
    expect(handoff).toMatch(/BUSY\(15, "busy", "ClosePaw is busy/);
    expect(handoff).toContain("const val MSG_BACKGROUND = \"Handed off - ClosePaw is working in the background; you can keep using your phone (avoid the app it's using)\"");
    expect(handoff).toContain('const val MSG_MAIN_DISPLAY = "Handed off - ClosePaw is controlling the screen"');
  });

  it('native refusal errors and resolve codes parse back to the refusal', () => {
    expect(closePawRefusalFromError(new Error('CLOSEPAW_REFUSED:vd-unavailable'))).toBe('vd-unavailable');
    expect(closePawRefusalFromError({ message: 'Call failed: CLOSEPAW_REFUSED:busy' })).toBe('busy');
    expect(closePawRefusalFromError(new Error('CLOSEPAW_REFUSED:nope'))).toBeNull();
    expect(closePawRefusalFromError(new Error('CLOSEPAW_NOT_INSTALLED'))).toBeNull();
    expect(asClosePawRefusal('accessibility-off')).toBe('accessibility-off');
    expect(asClosePawRefusal('handed-off')).toBeNull();
    expect(handoff).toContain('const val REFUSED_MARKER_PREFIX = "CLOSEPAW_REFUSED:"');
    expect(handoff).toContain('IllegalStateException(REFUSED_MARKER_PREFIX + refusal.wire)');
  });

  it('every outcome / refusal has en + ja strings', () => {
    const keys = [
      ...['background', 'main-display', 'launched', 'notified'].map((o) => closePawOutcomeKey(o) as string),
      ...Object.values(CLOSEPAW_REFUSAL_CODES).map(closePawRefusalKey),
    ];
    for (const key of keys) {
      expect((en as Record<string, string>)[key]).toBeTruthy();
      expect((ja as Record<string, string>)[key]).toBeTruthy();
    }
    expect((ja as Record<string, string>)['closepaw.refused_vd_unavailable']).toContain('Shizuku');
    expect(closePawOutcomeKey('weird')).toBeNull();
  });
});

describe('0 / no answer -> existing activity path', () => {
  it('NoResponse falls through to the unchanged activity launch (BAL check + notification fallback kept)', () => {
    const launch = fn(handoff, 'fun launch(context: Context, goal: String');
    const after = launch.slice(launch.indexOf('VariantResult.NoResponse -> Unit'));
    expect(after).toContain('if (canStartActivityNow(context)) {');
    expect(after).toContain('context.startActivity(intent)');
    expect(after).toContain('postHandoffNotification(context, clean, tapIntent)');
  });

  it('a broadcast send failure also falls back', () => {
    const send = fn(handoff, 'private fun sendVariantBroadcast(');
    expect(send).toMatch(/\} catch \(e: Exception\) \{[\s\S]*?return VariantResult\.NoResponse/);
  });
});

describe('outcome plumbing', () => {
  it('shim: handleLine maps background / main-display / refusals', () => {
    const result = fn(handoff, 'fun resultFor(outcome: Outcome): Result');
    expect(result).toContain('Outcome.BACKGROUND -> Result(true, "background", MSG_BACKGROUND)');
    expect(result).toContain('Outcome.MAIN_DISPLAY -> Result(true, "main-display", MSG_MAIN_DISPLAY)');
    const handle = fn(handoff, 'fun handleLine(');
    expect(handle).toContain('resultFor(launch(context.applicationContext, parsed.goal))');
    expect(handle).toContain('} catch (e: ClosePawRefusedException) {');
  });

  it('approvals: resolve() reports background / main-display / refusal codes', () => {
    const resolve = fn(approvals, 'fun resolve(');
    expect(resolve).toContain('ClosePawHandoff.Outcome.BACKGROUND -> Outcome(true, "background"');
    expect(resolve).toContain('ClosePawHandoff.Outcome.MAIN_DISPLAY -> Outcome(true, "main-display"');
    expect(resolve).toContain('} catch (e: ClosePawHandoff.ClosePawRefusedException) {');
    expect(resolve).toContain('Outcome(false, e.refusal.wire,');
  });

  it('chat line for an approval outcome', () => {
    expect(closePawApprovalOutcomeLine(JSON.stringify({ ok: true, code: 'background', message: 'x' }), 'ja')).toBe('ja:closepaw.outcome_background');
    expect(closePawApprovalOutcomeLine(JSON.stringify({ ok: false, code: 'vd-unavailable', message: 'x' }), 'en')).toBe('en:closepaw.refused_vd_unavailable');
    expect(closePawApprovalOutcomeLine(JSON.stringify({ ok: true, code: 'handed-off', message: 'x' }), 'en')).toBeNull();
    expect(closePawApprovalOutcomeLine('not json', 'en')).toBeNull();
  });

  it('agent run result: both executors read the recorded outcome', () => {
    expect(handoff).toContain('const val OUTCOME_FILE = ".shelly-closepaw-outcome.json"');
    const launch = fn(handoff, 'fun launch(context: Context, goal: String');
    expect(launch).toContain('recordOutcome(context, r.refusal.wire, r.refusal.message)');
    const script = read('lib/agent-executor.ts');
    expect(script).toContain('closepaw_read_outcome() {');
    expect(script).toContain('ACTION_DISPATCH_MESSAGE="ClosePaw did not start the task: $CLOSEPAW_OUTCOME_MESSAGE"');
    expect(script).toContain('const AGENT_SCRIPT_VERSION = 73;');
    const plan = read('scripts/shelly-plan-executor.js');
    expect(plan).toContain('function readClosePawOutcome(home)');
    expect(plan).toContain('ClosePaw did not start the task: ${outcome.message}');
    expect(read('modules/terminal-emulator/android/src/main/assets/shelly-plan-executor.js')).toBe(plan);
  });

  it('RN Review accept posts the outcome line and shows the refusal reason', () => {
    const layout = read('app/_layout.tsx');
    expect(layout).toContain('const outcome = await fireReviewedAgentIntent(request, TerminalEmulator.fireAgentIntent);');
    expect(layout).toContain('postClosePawChatLine(t(closePawRefusalKey(refusal)));');
    expect(layout).toContain('Alert.alert(t(closePawRefusalKey(refusal)));');
  });
});
