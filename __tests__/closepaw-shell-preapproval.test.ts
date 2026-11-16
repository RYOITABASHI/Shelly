/**
 * "Run ClosePaw without Shelly's approval" (owner decision 2026-11-16).
 * The chat parser and handler run here; the native half (Kotlin) is pinned by
 * reading its source, like closepaw-draft-preapproval.test.ts.
 */
import * as fs from 'fs';
import * as path from 'path';

const mockNative: {
  setClosePawShellPreapproval?: jest.Mock;
  getClosePawShellPreapproval?: jest.Mock;
} = {};
jest.mock('@/modules/terminal-emulator/src/TerminalEmulatorModule', () => ({ __esModule: true, default: mockNative }));
jest.mock('@/lib/debug-logger', () => ({ logInfo: jest.fn(), logWarn: jest.fn(), logError: jest.fn() }));

import {
  canSetClosePawShellPreapprovalFrom,
  handleClosePawShellPreapprovalChat,
  isClosePawShellPreapprovalOn,
  parseClosePawShellPreapprovalIntent,
} from '@/lib/closepaw-shell-preapproval';
import { parseDraftPreapprovalIntent } from '@/lib/closepaw-draft-preapproval';

describe('parseClosePawShellPreapprovalIntent', () => {
  it.each([
    'ClosePawは承認なしで',
    '@agent ClosePawは承認なしで。',
    'ClosePawの操作は承認なしで',
    'ClosePawで操作するときは全部承認なしでいい',
    'closepawはshellyの承認なしで実行して',
    'run ClosePaw without approval',
    'Always run ClosePaw without Shelly approval, please.',
  ])('%s -> on', (text) => {
    expect(parseClosePawShellPreapprovalIntent(text)).toEqual({ kind: 'on' });
  });

  it.each([
    'ClosePawの承認なしをやめて',
    'ClosePawの承認なしを解除して',
    'stop running ClosePaw without approval',
  ])('%s -> off', (text) => {
    expect(parseClosePawShellPreapprovalIntent(text)).toEqual({ kind: 'off' });
  });

  it.each([
    '承認なしで',
    '承認なしをやめて',
    'note と Substack の下書き保存は承認なしで',
    '毎朝 ClosePaw で note を開いて、承認なしで投稿して',
    'ClosePawで決済を承認なしでやって',
    'run ClosePaw without approval and then post it',
    'ClosePawは承認なしで\nほかにも',
  ])('%s -> not this command', (text) => {
    expect(parseClosePawShellPreapprovalIntent(text)).toBeNull();
  });

  it('does not collide with the draft switch', () => {
    expect(parseDraftPreapprovalIntent('ClosePawの承認なしをやめて')).toBeNull();
    expect(parseDraftPreapprovalIntent('ClosePawは承認なしで')).toBeNull();
  });
});

describe('handleClosePawShellPreapprovalChat', () => {
  beforeEach(() => {
    mockNative.setClosePawShellPreapproval = jest.fn(async (on: boolean) =>
      JSON.stringify(on ? { ok: true, code: 'on', on: true, enabledAt: 1 } : { ok: true, code: 'off', on: false }));
    mockNative.getClosePawShellPreapproval = jest.fn(async () => JSON.stringify({ on: false }));
  });

  it('only the owner typing in the composer may set it', () => {
    expect(canSetClosePawShellPreapprovalFrom({ typedByUser: true })).toBe(true);
    for (const source of ['voice', 'terminal-request', 'widget', 'monitor-team', 'inbound']) {
      expect(canSetClosePawShellPreapprovalFrom({ typedByUser: true, source })).toBe(false);
    }
    expect(canSetClosePawShellPreapprovalFrom({ typedByUser: false })).toBe(false);
  });

  it('turns on from typed words and says what it means', async () => {
    const reply = await handleClosePawShellPreapprovalChat('ClosePawは承認なしで', 'ja', { typedByUser: true });
    expect(mockNative.setClosePawShellPreapproval).toHaveBeenCalledWith(true);
    expect(reply).toContain('承認なしで実行します');
    expect(reply).toContain('ClosePawの承認なしをやめて');
  });

  it('refuses a non-typed source without touching native', async () => {
    expect(await handleClosePawShellPreapprovalChat('ClosePawは承認なしで', 'ja', { typedByUser: true, source: 'voice' })).toBeNull();
    expect(await handleClosePawShellPreapprovalChat('run ClosePaw without approval', 'en', { typedByUser: false })).toBeNull();
    expect(mockNative.setClosePawShellPreapproval).not.toHaveBeenCalled();
  });

  it('turns off', async () => {
    const reply = await handleClosePawShellPreapprovalChat('stop running ClosePaw without approval', 'en', { typedByUser: true });
    expect(mockNative.setClosePawShellPreapproval).toHaveBeenCalledWith(false);
    expect(reply).toContain('every time again');
  });

  it('reports a failed ON instead of claiming it', async () => {
    mockNative.setClosePawShellPreapproval = jest.fn(async () => JSON.stringify({ ok: false, code: 'failed', on: false }));
    const reply = await handleClosePawShellPreapprovalChat('ClosePawは承認なしで', 'ja', { typedByUser: true });
    expect(reply).toContain('変更できませんでした');
  });

  it('isClosePawShellPreapprovalOn fails closed', async () => {
    mockNative.getClosePawShellPreapproval = jest.fn(async () => { throw new Error('x'); });
    expect(await isClosePawShellPreapprovalOn()).toBe(false);
    mockNative.getClosePawShellPreapproval = jest.fn(async () => 'not json');
    expect(await isClosePawShellPreapprovalOn()).toBe(false);
    mockNative.getClosePawShellPreapproval = jest.fn(async () => JSON.stringify({ on: true, enabledAt: 5 }));
    expect(await isClosePawShellPreapprovalOn()).toBe(true);
  });
});

describe('native half (source)', () => {
  const dir = path.join(__dirname, '../modules/terminal-emulator/android/src/main/java/expo/modules/terminalemulator');
  const read = (name: string) => fs.readFileSync(path.join(dir, name), 'utf8').replace(/\r\n/g, '\n');
  const pre = read('ClosePawShellPreapproval.kt');
  const approvals = read('ClosePawShellApprovals.kt');
  const handoff = read('ClosePawHandoff.kt');
  const drafts = read('ClosePawDrafts.kt');
  const mod = read('TerminalEmulatorModule.kt');
  const fn = (src: string, signature: string) => {
    const start = src.indexOf(signature);
    expect(start).toBeGreaterThanOrEqual(0);
    return src.slice(start, src.indexOf('\n    }\n', start));
  };

  it('keeps the state in Keystore-MACd prefs, re-keyed on every write, off when it does not verify', () => {
    expect(pre).toContain('KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_HMAC_SHA256, ANDROID_KEYSTORE)');
    expect(fn(pre, 'fun enable(')).toContain('val key = newKey()');
    expect(fn(pre, 'fun disable(')).toContain('keyStore().deleteEntry(KEY_ALIAS)');
    const read_ = fn(pre, 'fun enabledAt(context: Context)');
    expect(read_).toContain('MessageDigest.isEqual');
    expect(pre).not.toMatch(/getHomeDir|System\.getenv|File\(/);
  });

  it('only the module function turns it on; no shell, queue or file path', () => {
    const callers = fs.readdirSync(dir).filter((f) => f.endsWith('.kt') && f !== 'ClosePawShellPreapproval.kt')
      .filter((f) => /ClosePawShellPreapproval\.(enable|setFromRn)\(/.test(read(f)));
    expect(callers).toEqual(['TerminalEmulatorModule.kt']);
    expect(mod).toContain('AsyncFunction("setClosePawShellPreapproval")');
    for (const script of ['shelly-closepaw.js', 'shelly-save-draft.js']) {
      const p = path.join(__dirname, '../scripts', script);
      if (fs.existsSync(p)) expect(fs.readFileSync(p, 'utf8')).not.toMatch(/ShellPreapproval|setClosePawShellPreapproval/);
    }
  });

  it('shelly closepaw launches through the approved path when on, never without the trusted variant', () => {
    const handle = fn(handoff, 'fun handleLine(');
    expect(handle).toMatch(/isTrustedVariantInstalled\(context\.applicationContext\) &&\s*ClosePawShellPreapproval\.isOn\(context\.applicationContext\)/);
    expect(handle).toContain('ClosePawShellApprovals.runPreapproved(');
    expect(handle).toContain('!lifecycleWritten');
    const run = fn(approvals, 'fun runPreapproved(');
    expect(run).toContain('ClosePawHandoff.isStopAllOn(context)');
    expect(fn(handoff, 'fun isStopAllOn(')).toContain('.shelly/agents/.halted');
    expect(run).toContain('preapproved = true');
    expect(run).toContain('resolve(context, reqId, "approve", "preapproved", p.approveNonce, now)');
  });

  it('a notification or chat reply can never take the pre-approved branch', () => {
    const resolve = fn(approvals, 'fun resolve(');
    expect(resolve).toContain('"preapproved" -> p.preapproved && decision == "approve"');
    expect(resolve).toContain('"notification" -> !p.preapproved');
    expect(fn(approvals, 'fun listJson(')).toContain('filter { !it.preapproved }');
    expect(fn(approvals, 'fun create(')).toContain('if (preapproved) return p');
  });

  it('drafts go without a tap and without the daily cap while it is on', () => {
    expect(fn(drafts, 'private fun preapproved(')).toContain('if (ClosePawShellPreapproval.isOn(app)) return items');
    expect(drafts).toContain('open.auto && !ClosePawShellPreapproval.isOn(app) && !ClosePawDraftPreapproval.isOn(');
  });

  it("an agent's ClosePaw hand-off skips the Review only after the provenance check", () => {
    const layout = fs.readFileSync(path.join(__dirname, '../app/_layout.tsx'), 'utf8');
    const start = layout.indexOf('const closePawPreapprovedFor = async');
    const body = layout.slice(start, layout.indexOf('\n    };', start));
    const provenance = body.indexOf('closePawRunProvenanceOk(');
    const flag = body.indexOf('await isClosePawShellPreapprovalOn()');
    expect(provenance).toBeGreaterThan(0);
    expect(flag).toBeGreaterThan(provenance);
  });
});
