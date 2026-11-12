/**
 * "Save drafts without approval" per destination (owner decision 2026-11-08).
 * The chat parser and handler run here; the native half (Kotlin) is pinned by
 * reading its source, like closepaw-save-draft-native.test.ts.
 */
import * as fs from 'fs';
import * as path from 'path';

const mockNative: {
  setDraftPreapproval?: jest.Mock;
  disableDraftPreapproval?: jest.Mock;
  getDraftPreapproval?: jest.Mock;
} = {};
jest.mock('@/modules/terminal-emulator/src/TerminalEmulatorModule', () => ({ __esModule: true, default: mockNative }));
jest.mock('@/lib/debug-logger', () => ({ logInfo: jest.fn(), logWarn: jest.fn(), logError: jest.fn() }));

import {
  canSetDraftPreapprovalFrom,
  entriesToTurnOff,
  handleDraftPreapprovalChat,
  parseDraftPreapprovalIntent,
} from '@/lib/closepaw-draft-preapproval';

describe('parseDraftPreapprovalIntent', () => {
  it.each([
    ['note と Substack の下書き保存は承認なしで', ['note', 'substack'], 5],
    ['@agent note と Substack の下書き保存は承認なしで。', ['note', 'substack'], 5],
    ['noteの下書き保存は承認なしでいい', ['note'], 5],
    ['note、substack:garden の下書き保存は1日3件まで承認なしで', ['note', 'substack:garden'], 3],
    ['garden.substack.com への下書き保存は承認なしでお願いします', ['substack:garden'], 5],
    ['save drafts to note and Substack without approval', ['note', 'substack'], 5],
    ['Save drafts to note without approval, up to 2 a day.', ['note'], 2],
    ['save drafts to substack:garden up to 10 drafts per day without approval', ['substack:garden'], 10],
  ])('%s -> on', (text, dests, cap) => {
    expect(parseDraftPreapprovalIntent(text)).toEqual({ kind: 'on', destinations: dests, dailyCap: cap });
  });

  it.each([
    ['承認なしをやめて', null, false],
    ['下書き保存の承認なしをやめて', null, true],
    ['note の承認なしをやめて', ['note'], true],
    ['stop saving drafts without approval', null, true],
    ['stop saving drafts to Substack without approval', ['substack'], true],
  ])('%s -> off', (text, dests, explicit) => {
    expect(parseDraftPreapprovalIntent(text)).toEqual({ kind: 'off', destinations: dests, explicit });
  });

  it.each([
    // An agent request that only mentions drafts and approval.
    '@agent 毎朝 7 時に記事を書いて note に下書き保存、承認なしで実行',
    'note の下書き保存は承認なしでいいかな？',
    'save drafts to note without approval and publish them',
    'publish to note without approval',
    'note の記事を承認なしで公開して',
    'note と Substack の下書き保存は1日50件まで承認なしで',
    'save drafts to note without approval, up to 0 a day',
    'save drafts to example.com without approval',
    '「note の下書き保存は承認なしで」と言うとどうなる？',
    '',
  ])('%s -> nothing', (text) => {
    expect(parseDraftPreapprovalIntent(text)).toBeNull();
  });
});

describe('entriesToTurnOff', () => {
  const entries = [
    { dest: 'note', cap: 5, enabledAt: 1, usedToday: 0, remainingToday: 5 },
    { dest: 'substack:a', cap: 5, enabledAt: 1, usedToday: 0, remainingToday: 5 },
    { dest: 'substack:b', cap: 5, enabledAt: 1, usedToday: 0, remainingToday: 5 },
  ];
  it('null is everything, a bare substack is every Substack entry', () => {
    expect(entriesToTurnOff(null, entries)).toEqual(['note', 'substack:a', 'substack:b']);
    expect(entriesToTurnOff(['substack'], entries)).toEqual(['substack:a', 'substack:b']);
    expect(entriesToTurnOff(['substack:b'], entries)).toEqual(['substack:b']);
  });
});

describe('handleDraftPreapprovalChat', () => {
  beforeEach(() => {
    mockNative.setDraftPreapproval = jest.fn(async () =>
      JSON.stringify({ ok: true, code: 'on', enabled: ['note', 'substack:garden'], entries: [] }));
    mockNative.disableDraftPreapproval = jest.fn(async () => JSON.stringify({ entries: [] }));
    mockNative.getDraftPreapproval = jest.fn(async () =>
      JSON.stringify({ entries: [{ dest: 'note', cap: 5, enabledAt: 1, usedToday: 1, remainingToday: 4 }] }));
  });

  it('only the owner typing in the composer may set it', () => {
    expect(canSetDraftPreapprovalFrom({ typedByUser: true })).toBe(true);
    expect(canSetDraftPreapprovalFrom({ typedByUser: false })).toBe(false);
    for (const source of ['terminal-request', 'widget-ask', 'monitor-team']) {
      expect(canSetDraftPreapprovalFrom({ typedByUser: true, source })).toBe(false);
    }
  });

  it('turns destinations on from typed text and says what it did', async () => {
    const reply = await handleDraftPreapprovalChat('note と Substack の下書き保存は承認なしで', 'ja', { typedByUser: true });
    expect(mockNative.setDraftPreapproval).toHaveBeenCalledWith(['note', 'substack'], 5);
    expect(reply).toContain('note, Substack (garden)');
    expect(reply).toContain('公開はしません');
  });

  it.each([
    [{ typedByUser: false }],
    [{ typedByUser: true, source: 'terminal-request' }],
    [{ typedByUser: true, source: 'monitor-team' }],
    [{ typedByUser: true, source: 'widget-ask' }],
  ])('never calls native for %j', async (src) => {
    expect(await handleDraftPreapprovalChat('save drafts to note without approval', 'en', src)).toBeNull();
    expect(await handleDraftPreapprovalChat('stop saving drafts without approval', 'en', src)).toBeNull();
    expect(mockNative.setDraftPreapproval).not.toHaveBeenCalled();
    expect(mockNative.disableDraftPreapproval).not.toHaveBeenCalled();
  });

  it('reports the native refusal and turns nothing on', async () => {
    mockNative.setDraftPreapproval = jest.fn(async () =>
      JSON.stringify({ ok: false, code: 'ambiguous-substack', subdomains: ['a', 'b'] }));
    const reply = await handleDraftPreapprovalChat('save drafts to substack without approval', 'en', { typedByUser: true });
    expect(reply).toContain('substack:a');
    expect(reply).toContain('nothing was turned on');
  });

  it('turns off, and a bare 承認なしをやめて with nothing on is left to route', async () => {
    const reply = await handleDraftPreapprovalChat('承認なしをやめて', 'ja', { typedByUser: true });
    expect(mockNative.disableDraftPreapproval).toHaveBeenCalledWith([]);
    expect(reply).toContain('note');
    mockNative.getDraftPreapproval = jest.fn(async () => JSON.stringify({ entries: [] }));
    expect(await handleDraftPreapprovalChat('承認なしをやめて', 'ja', { typedByUser: true })).toBeNull();
    expect(await handleDraftPreapprovalChat('stop saving drafts without approval', 'en', { typedByUser: true }))
      .toContain('No destination');
  });

  it('unrelated text is not handled', async () => {
    expect(await handleDraftPreapprovalChat('hello', 'en', { typedByUser: true })).toBeNull();
  });
});

describe('native half (source)', () => {
  const dir = path.join(__dirname, '../modules/terminal-emulator/android/src/main/java/expo/modules/terminalemulator');
  const read = (name: string) => fs.readFileSync(path.join(dir, name), 'utf8').replace(/\r\n/g, '\n');
  const pre = read('ClosePawDraftPreapproval.kt');
  const drafts = read('ClosePawDrafts.kt');
  const mod = read('TerminalEmulatorModule.kt');
  const fn = (src: string, signature: string) => {
    const start = src.indexOf(signature);
    expect(start).toBeGreaterThanOrEqual(0);
    return src.slice(start, src.indexOf('\n    }\n', start));
  };

  it('keeps the state in Keystore-MACd prefs, re-keyed on every write, off when it does not verify', () => {
    expect(pre).toContain('KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_HMAC_SHA256, ANDROID_KEYSTORE)');
    const write = fn(pre, 'private fun write(');
    expect(write).toContain('val key = newKey()');
    expect(write).toContain('keyStore().deleteEntry(KEY_ALIAS)');
    const read_ = fn(pre, 'fun read(context: Context)');
    expect(read_).toContain('MessageDigest.isEqual');
    expect(read_).toContain('emptyList()');
    // No file, env or plan reaches it.
    expect(pre).not.toMatch(/getHomeDir|System\.getenv|File\(/);
  });

  it('caps each destination per day and stores the count before sending', () => {
    expect(pre).toContain('const val DEFAULT_DAILY_CAP = 5');
    expect(pre).toContain('const val MAX_DAILY_CAP = 20');
    expect(fn(pre, 'fun remaining(')).toContain('today < entry.day -> 0');
    const reserve = fn(pre, 'fun reserve(');
    expect(reserve).toContain('write(context, next)');
    expect(reserve).toContain('BooleanArray(dests.size)');
  });

  it('turns substack on only for a subdomain the destinations file allows', () => {
    const enable = fn(pre, 'fun enableFromChat(');
    expect(enable).toContain('ClosePawDrafts.allowedSubdomains(context)');
    expect(enable).toContain('ClosePawDrafts.resolveSubdomain(sub, allowed) == null');
    expect(enable).toContain('"ambiguous-substack"');
  });

  it('only the module functions call enable; ON has no shell or queue path', () => {
    const javaDir = dir;
    const callers = fs.readdirSync(javaDir).filter((f) => f.endsWith('.kt') && f !== 'ClosePawDraftPreapproval.kt')
      .filter((f) => /ClosePawDraftPreapproval\.(enable|enableFromChat)\(/.test(read(f)));
    expect(callers).toEqual(['TerminalEmulatorModule.kt']);
    expect(mod).toContain('AsyncFunction("setDraftPreapproval")');
    expect(fs.readFileSync(path.join(__dirname, '../scripts/shelly-save-draft.js'), 'utf8')).not.toMatch(/preapprov|without.approval/i);
  });

  it('splits the queue at unlock: pre-approved drafts go through the same send, the rest are asked', () => {
    // 2026-11-13 owner decision: drafts with image hosts go without a tap too; the
    // hosts are checked against the destinations file by fit() and shown in the notice.
    expect(fn(drafts, 'private fun preapproved(')).toContain('val keys = items.map { destinationKey(it.draft) }');
    expect(fn(drafts, 'private fun noticeLabel(')).toContain('" images: "');
    expect(drafts).toContain('!destinations.imageHosts.containsAll(imageHosts) -> Fit.REFUSED');
    const unlock = fn(drafts, 'private fun unlockStep(');
    expect(unlock).toContain('val auto = preapproved(app, items)');
    expect(unlock).toContain('if (auto.isNotEmpty()) startAutoBatch(app, auto) else requestApproval(app, items)');
    expect(fn(drafts, 'private fun startAutoBatch(')).toContain('sendNext(app)');
    // Re-checked per draft: turned off mid-batch leaves the item queued.
    expect(fn(drafts, 'private fun sendNext(')).toContain('open.auto && !ClosePawDraftPreapproval.isOn(app, destinationKey(draft))');
    // The key binds the destination the destinations file resolved.
    expect(pre).toContain('platform == "substack" && subdomain != null -> "substack:$subdomain"');
  });

  it('nothing in the path can publish', () => {
    for (const src of [pre, drafts]) {
      expect(src).not.toMatch(/publish\s*\(|ACTION_PUBLISH|EXTRA_ALLOW_MAIN_DISPLAY|ClosePawHandoff\.launch|startActivity/);
    }
    expect(fn(drafts, 'private fun send(')).toContain('ClosePawHandoff.buildSaveDraftBroadcast(');
  });

  it('tells the owner afterwards with fixed draft links', () => {
    expect(fn(drafts, 'private fun finishBatch(')).toContain('autoNotice(app, open)');
    const url = fn(drafts, 'fun draftsUrl(');
    expect(url).toContain('"https://note.com/notes"');
    expect(url).toContain('.substack.com/publish/posts/drafts');
  });
});
