/**
 * Wi-Fi connectivity guardian — native wiring and Kotlin/TS lockstep,
 * checked structurally (local jest does not compile Kotlin; CI is the first
 * Kotlin compile). Numbered describes map to wifi-guardian-design.md's test
 * plan; the behaviour itself is exercised in connectivity-guardian-core.test.ts.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as core from '@/lib/connectivity-guardian-core';

const root = path.resolve(__dirname, '..');
const read = (p: string) => fs.readFileSync(path.join(root, p), 'utf8').replace(/\r\n/g, '\n');
const KT = 'modules/terminal-emulator/android/src/main/java/expo/modules/terminalemulator';
const coreKt = read(`${KT}/ConnectivityGuardianCore.kt`);
const coreTs = read('lib/connectivity-guardian-core.ts');
const guardian = read(`${KT}/ConnectivityGuardian.kt`);
const store = read(`${KT}/ConnectivityGuardianStore.kt`);
const receiver = read(`${KT}/ConnectivityGuardianReceiver.kt`);
const service = read(`${KT}/ConnectivityGuardianService.kt`);
const wifiDebug = read(`${KT}/WifiDebugControl.kt`);
const tailscale = read(`${KT}/TailscaleControl.kt`);
const moduleKt = read(`${KT}/TerminalEmulatorModule.kt`);
const manifest = read('modules/terminal-emulator/android/src/main/AndroidManifest.xml');
const appConfig = read('app.config.ts');
const auditWriter = read(`${KT}/IngressAuditWriter.kt`);
const guardianSources: Record<string, string> = {
  'ConnectivityGuardianCore.kt': coreKt,
  'ConnectivityGuardian.kt': guardian,
  'ConnectivityGuardianStore.kt': store,
  'ConnectivityGuardianReceiver.kt': receiver,
  'ConnectivityGuardianService.kt': service,
  'WifiDebugControl.kt': wifiDebug,
  'TailscaleControl.kt': tailscale,
};
/** Code only (line and block comments removed), for "never calls X" checks. */
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\s\/\/.*$/gm, '');

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

function ktConst(name: string): number | string {
  const m = coreKt.match(new RegExp(`const val ${name} =\\s*([^\\n]+)`));
  expect(m).not.toBeNull();
  const raw = m![1].trim();
  if (raw.startsWith('"')) return JSON.parse(raw);
  const expr = raw.replace(/_/g, '').replace(/(\d)L\b/g, '$1');
  expect(expr).toMatch(/^[\d\s*]+$/);
  return expr.split('*').reduce((a, b) => a * Number(b.trim()), 1);
}

function ktList(name: string): string[] {
  const m = coreKt.match(new RegExp(`val ${name}: List<String> = listOf\\(([\\s\\S]*?)\\)`));
  expect(m).not.toBeNull();
  return [...m![1].matchAll(/"([^"]*)"/g)].map((x) => x[1]);
}

/** step / action / outcome literals of every r.audit(...) call, in source order. */
function auditCalls(src: string, quote: string): string[] {
  const out: string[] = [];
  const re = /r\.audit\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    let depth = 1;
    let j = m.index + m[0].length;
    for (; j < src.length && depth > 0; j++) {
      if (src[j] === '(') depth++;
      else if (src[j] === ')') depth--;
    }
    const args = src.slice(m.index + m[0].length, j - 1);
    const parts: string[] = [];
    let d = 0;
    let cur = '';
    for (const c of args) {
      if (c === '(') d++;
      if (c === ')') d--;
      if (c === ',' && d === 0) {
        parts.push(cur.trim());
        cur = '';
      } else cur += c;
    }
    parts.push(cur.trim());
    const norm = (s: string) => (s.startsWith(quote) ? s.slice(1, -1) : '<expr>');
    out.push([norm(parts[0]), norm(parts[1]), norm(parts[parts.length - 1])].join(':'));
  }
  return out;
}

describe('lockstep: ConnectivityGuardianCore.kt <-> lib/connectivity-guardian-core.ts', () => {
  it.each([
    'LOSS_DEBOUNCE_MS',
    'ADB_WIFI_VERIFY_MS',
    'ADB_WIFI_POLL_MS',
    'VPN_VERIFY_MS',
    'VPN_POLL_MS',
    'WATCHDOG_INTERVAL_MS',
    'CLOSEPAW_SETTLE_MS',
    'CLOSEPAW_SETTLE_POLL_MS',
    'AUDIT_FILE',
    'AUDIT_KIND',
    'GOAL_MAX_CODE_POINTS',
    'TAILSCALE_PACKAGE',
    'GOAL_TAILSCALE_CONNECT',
  ])('%s is identical', (name) => {
    expect(ktConst(name)).toEqual((core as any)[name]);
  });

  it('Tailscale is connect-only in both cores (owner decision 2026-11-17)', () => {
    expect((core as any).GOAL_TAILSCALE_DISCONNECT).toBeUndefined();
    expect(coreKt).not.toContain('GOAL_TAILSCALE_DISCONNECT');
    expect(core.ACTIONS).not.toContain('disconnect');
    expect(ktList('ACTIONS')).not.toContain('disconnect');
    expect(coreKt).toContain('fun goalFor(): String = GOAL_TAILSCALE_CONNECT');
    expect(coreKt).toContain('fun requestTailscale(): String?');
    expect(coreTs).toContain('requestTailscale(): string | null;');
  });

  it.each(['STEPS', 'ACTIONS', 'LEVELS', 'OUTCOMES', 'ASSIST_REASONS', 'AUDIT_KEYS', 'CLOSEPAW_SETTLED_STATUSES'])('%s is identical', (name) => {
    expect(ktList(name)).toEqual([...(core as any)[name]]);
  });

  it('every audit call (step, action, outcome) appears in the same order in both', () => {
    const kt = auditCalls(coreKt, '"');
    const ts = auditCalls(coreTs, "'");
    expect(kt.length).toBeGreaterThan(20);
    expect(kt).toEqual(ts);
  });

  it('every assist reason and sequence result literal matches', () => {
    const ktAssist = [...coreKt.matchAll(/r\.assist\("([a-z_]+)"\)/g)].map((m) => m[1]);
    const tsAssist = [...coreTs.matchAll(/r\.assist\('([a-z_]+)'\)/g)].map((m) => m[1]);
    expect(ktAssist).toEqual(tsAssist);
    const ktEnd = [...coreKt.matchAll(/r\.end\("([a-z_]+)"\)/g)].map((m) => m[1]);
    const tsEnd = [...coreTs.matchAll(/r\.end\('([a-z_]+)'\)/g)].map((m) => m[1]);
    expect(ktEnd).toEqual(tsEnd);
    expect(coreKt.match(/r\.end\(/g)!.length).toBe(coreTs.match(/r\.end\(/g)!.length);
  });

  it('the reducer handles the same transitions', () => {
    for (const [kt, ts] of [
      ['Mode.IDLE_OFFLINE -> startOn(s)', "case 'IDLE_OFFLINE':\n          return startOn(s);"],
      ['Mode.IDLE_ONLINE -> armLoss(s, e.now, s.pending == Pending.ON)', "case 'IDLE_ONLINE':\n          return armLoss(s, e.now, s.pending === 'ON');"],
      [
        'Mode.IDLE_ONLINE -> if (s.pending == Pending.ON) startOn(s) else same',
        "case 'IDLE_ONLINE':\n          return s.pending === 'ON' ? startOn(s) : same;",
      ],
      [
        'if (!e.wifiUp && s.mode == Mode.LOSS_PENDING) return recoverLoss(s, e.now)\n            return reduce(s, if (e.wifiUp) Event.WifiAvailable else Event.WifiLost(e.now))',
        "if (!e.wifiUp && s.mode === 'LOSS_PENDING') return recoverLoss(s, e.now);\n    return reduce(s, e.wifiUp ? { type: 'wifiAvailable' } : { type: 'wifiLost', now: e.now });",
      ],
      // Coordinator gate round 2: recovery keeps the loss's token and deadline.
      ['if (s.lossArmed) return Transition(s, emptyList())', "if (s.lossArmed === true) return { state: s, effects: [] };"],
      // Coordinator gate round 3: the remaining budget is monotonic (same boot
      // only); the wall clock is the one-time fallback of an older build's loss.
      ['remaining = lossMonotonicRemainingMs(monotonic, s.lossBootId, now)', 'remaining = lossMonotonicRemainingMs(s.lossElapsedMs, s.lossBootId ?? null, now);'],
      ['remaining = s.lossAtMs?.let { lossRemainingMs(it, now.wallMs) } ?: LOSS_DEBOUNCE_MS', 'remaining = s.lossAtMs === undefined ? LOSS_DEBOUNCE_MS : lossRemainingMs(s.lossAtMs, now.wallMs);'],
      ['base = withLossAnchor(s, now, remaining)', 'base = { ...cleared(s), ...lossAnchor(now, remaining) };'],
      ['if (lossBootId == null || now.bootId == null || lossBootId != now.bootId) return 0L', 'if (lossBootId === null || now.bootId === null || lossBootId !== now.bootId) return 0;'],
      ['val elapsed = now.elapsedMs - lossElapsedMs\n        if (elapsed < 0L) return 0L', 'const elapsed = now.elapsedMs - lossElapsedMs;\n  if (elapsed < 0) return 0;'],
      ['minOf(LOSS_DEBOUNCE_MS, maxOf(0L, LOSS_DEBOUNCE_MS - elapsed))', 'Math.min(LOSS_DEBOUNCE_MS, Math.max(0, LOSS_DEBOUNCE_MS - elapsed))'],
      ['val spent = LOSS_DEBOUNCE_MS - remainingMs', 'const spent = LOSS_DEBOUNCE_MS - remainingMs;'],
      ['lossAtMs = now.wallMs - spent, lossElapsedMs = now.elapsedMs - spent, lossBootId = now.bootId', 'lossAtMs: now.wallMs - spent,\n    lossElapsedMs: now.elapsedMs - spent,\n    ...(now.bootId === null ? {} : { lossBootId: now.bootId }),'],
      ['if (remaining <= 0L) return reduce(base, Event.DebounceExpired(s.lossToken, false))', "if (remaining <= 0) return reduce(base, { type: 'debounceExpired', token: s.lossToken, wifiUp: false });"],
      [
        'return Transition(base.copy(lossArmed = true), listOf(Effect.ArmDebounce(s.lossToken, remaining)))',
        "return { state: { ...base, lossArmed: true }, effects: [{ type: 'armDebounce', token: s.lossToken, delayMs: remaining }] };",
      ],
      ['minOf(LOSS_DEBOUNCE_MS, maxOf(0L, lossAtMs + LOSS_DEBOUNCE_MS - nowMs))', 'Math.min(LOSS_DEBOUNCE_MS, Math.max(0, lossAtMs + LOSS_DEBOUNCE_MS - nowMs))'],
      [
        'withLossAnchor(State(Mode.LOSS_PENDING, token, if (rerunOn) Pending.ON else Pending.NONE, lossArmed = true), now, LOSS_DEBOUNCE_MS)',
        "state: { mode: 'LOSS_PENDING', lossToken: token, pending: rerunOn ? 'ON' : 'NONE', ...lossAnchor(now, LOSS_DEBOUNCE_MS), lossArmed: true },",
      ],
      ['val t = recoverLoss(disarmed(s).copy(pending = Pending.ON), e.now)', "const t = recoverLoss({ ...disarmed(s), pending: 'ON' }, e.now);"],
      ['private fun disarmed(s: State): State = s.copy(lossArmed = false)', 'const { lossArmed: _a, ...rest } = s;'],
      [
        'private fun cleared(s: State): State = s.copy(lossAtMs = null, lossArmed = false, lossElapsedMs = null, lossBootId = null)',
        'const { lossArmed: _a, lossAtMs: _l, lossElapsedMs: _e, lossBootId: _b, ...rest } = s;',
      ],
      [
        'state.mode == Mode.ON_RUNNING || state.mode == Mode.OFF_RUNNING || (state.mode == Mode.IDLE_ONLINE && state.pending == Pending.ON)) {\n        "in_flight"',
        "if (state.mode === 'ON_RUNNING' || state.mode === 'OFF_RUNNING' || (state.mode === 'IDLE_ONLINE' && state.pending === 'ON')) return 'in_flight';",
      ],
      [
        'persisted == "in_flight" -> State(Mode.IDLE_ONLINE, lossToken, Pending.ON)',
        "if (persisted === 'in_flight') return { mode: 'IDLE_ONLINE', lossToken, pending: 'ON' };",
      ],
      [
        's.mode == Mode.IDLE_ONLINE || s.mode == Mode.LOSS_PENDING || s.mode == Mode.ON_RUNNING || s.mode == Mode.OFF_RUNNING',
        "return s.mode === 'IDLE_ONLINE' || s.mode === 'LOSS_PENDING' || s.mode === 'ON_RUNNING' || s.mode === 'OFF_RUNNING';",
      ],
      [
        'try {\n            return verifyTailscale(r, action, before)\n        } finally {\n            awaitSettle(r, reqId, dispatchedAt)\n        }',
        'try {\n    return verifyTailscale(r, action, before);\n  } finally {\n    awaitSettle(r, reqId, dispatchedAt);\n  }',
      ],
      [
        'Transition(cleared(t.state).copy(mode = Mode.IDLE_ONLINE, pending = Pending.ON), t.effects.filter { it !is Effect.RunOn })',
        "state: { ...cleared(t.state), mode: 'IDLE_ONLINE', pending: 'ON' },\n    effects: t.effects.filter((e) => e.type !== 'runOn'),",
      ],
      ['if (p.nowMs() - dispatchedAt >= CLOSEPAW_SETTLE_MS) {', 'if (p.nowMs() - dispatchedAt >= CLOSEPAW_SETTLE_MS) {'],
      [
        'withLossAnchor(s.copy(lossToken = token, pending = Pending.LOSS, lossArmed = true), e.now, LOSS_DEBOUNCE_MS),\n                            listOf(Effect.ArmDebounce(token, LOSS_DEBOUNCE_MS)),',
        "state: { ...cleared(s), lossToken: token, pending: 'LOSS', ...lossAnchor(e.now, LOSS_DEBOUNCE_MS), lossArmed: true },\n            effects: [{ type: 'armDebounce', token, delayMs: LOSS_DEBOUNCE_MS }],",
      ],
      [
        'if (s.pending == Pending.LOSS || s.pending == Pending.OFF) Transition(cleared(s).copy(pending = Pending.NONE), listOf(Effect.CancelDebounce))',
        "return { state: { ...cleared(s), pending: 'NONE' }, effects: [{ type: 'cancelDebounce' }] };",
      ],
      ['Mode.OFF_RUNNING -> Transition(s.copy(pending = Pending.ON)', "return { state: { ...s, pending: 'ON' }"],
      ['e.token != s.lossToken -> same', 'if (e.token !== s.lossToken) return same;'],
      ['else Transition(disarmed(s).copy(pending = Pending.OFF), emptyList())', "return { state: { ...disarmed(s), pending: 'OFF' }, effects: [] };"],
      [
        'Pending.LOSS -> Transition(s.copy(mode = Mode.LOSS_PENDING, pending = Pending.ON), emptyList())',
        "if (s.pending === 'LOSS') return { state: { ...s, mode: 'LOSS_PENDING', pending: 'ON' }, effects: [] };",
      ],
      [
        'if (s.pending == Pending.ON) startOn(cleared(s)).let { t -> Transition(t.state, listOf<Effect>(Effect.CancelDebounce) + t.effects) }',
        "return { state: t.state, effects: [{ type: 'cancelDebounce' }, ...t.effects] };",
      ],
      ['val t = armLoss(s, e.now, true)', 'const t = armLoss(s, e.now, true);'],
      [
        'State(Mode.LOSS_PENDING, lossToken, Pending.ON, lossAtMs, lossElapsedMs = lossElapsedMs, lossBootId = lossBootId?.takeIf { lossElapsedMs != null })',
        "if (persisted === 'loss_pending_on') return { mode: 'LOSS_PENDING', lossToken, pending: 'ON', ...anchor };",
      ],
      [
        'Pending.OFF -> Transition(cleared(s).copy(mode = Mode.OFF_RUNNING, pending = Pending.NONE), listOf(Effect.RunOff))',
        "if (s.pending === 'OFF') return { state: { ...cleared(s), mode: 'OFF_RUNNING', pending: 'NONE' }, effects: [{ type: 'runOff' }] };",
      ],
      ['if (s.pending == Pending.ON) startOn(cleared(s))', "if (s.pending === 'ON') return startOn(cleared(s));"],
      ['else -> if (e.interrupted) startOn(s)', 'if (e.interrupted === true) return startOn(s);'],
      [
        'else if (e.interrupted) Transition(s.copy(mode = Mode.OFF_RUNNING, pending = Pending.NONE), listOf(Effect.RunOff))',
        "if (e.interrupted === true) return { state: { ...s, mode: 'OFF_RUNNING', pending: 'NONE' }, effects: [{ type: 'runOff' }] };",
      ],
      ['if (s.mode == Mode.IDLE_ONLINE) {', "if (s.mode === 'IDLE_ONLINE') {"],
      ['if (s.mode == Mode.LOSS_PENDING) {', "if (s.mode === 'LOSS_PENDING') {"],
      ['p.superseded() -> "superseded"', "if (p.superseded()) return 'superseded';"],
      ['listOf(Effect.CancelDebounce, Effect.UnregisterCallbacks)', "effects: [{ type: 'cancelDebounce' }, { type: 'unregisterCallbacks' }]"],
    ]) {
      expect(coreKt).toContain(kt);
      expect(coreTs).toContain(ts);
    }
  });

  it('the Kotlin core stays android-free (TriggerDebouncer convention)', () => {
    expect(coreKt).not.toMatch(/^import android\./m);
    expect(coreKt).not.toMatch(/^import /m);
  });
});

describe('1 / 2 (native). sequence order in the Kotlin runner', () => {
  it('ON: wireless debugging verification precedes Tailscale', () => {
    const on = fn(coreKt, 'fun runOnSequence(');
    const write = on.indexOf('p.writeAdbWifi(1)');
    const verify = on.indexOf('pollUntil(p, ADB_WIFI_VERIFY_MS, ADB_WIFI_POLL_MS)');
    const connect = on.indexOf('tailscaleStep(r)');
    expect(write).toBeGreaterThan(on.indexOf('r.gated("wifi_debug")'));
    expect(verify).toBeGreaterThan(write);
    expect(connect).toBeGreaterThan(verify);
  });

  it('OFF: adb_wifi_enabled=0 only; no Tailscale step, no ClosePaw, no pre-approval read', () => {
    for (const [off, q] of [
      [fn(coreKt, 'fun runOffSequence('), '"'],
      [fn(coreTs, 'export function runOffSequence('), "'"],
    ] as const) {
      expect(off.indexOf(`r.gated(${q}wifi_debug${q})`)).toBeGreaterThan(-1);
      expect(off).toContain('p.writeAdbWifi(0)');
      expect(off).not.toContain('tailscaleStep');
      expect(off).not.toContain('requestTailscale');
      expect(off).not.toContain('closePawPreapproved');
      expect(off).not.toContain('vpnUp');
      expect(off).not.toContain(`${q}tailscale${q}`);
    }
  });
});

describe('5 (native). guardian lock: one worker thread runs every sequence', () => {
  it('a single-thread executor; drain is the only runner', () => {
    expect(guardian).toContain('Executors.newSingleThreadExecutor');
    const drain = fn(guardian, 'fun drain(');
    expect(drain).toContain('worker.execute');
    expect(drain).toContain('ConnectivityGuardianCore.runSequence(kind, AndroidPorts(app, kind), seq)');
    expect(drain).toContain('onEvent(app, Event.SequenceDone(kind, result == "superseded"))');
    expect(code(guardian).match(/runSequence\(/g)).toHaveLength(1);
    expect(fn(guardian, 'fun onEvent(')).toContain('ConnectivityGuardianCore.reduce(before, event)');
    expect(guardian).toMatch(/@Synchronized\s+fun onEvent\(/);
  });

  it('superseded comes from the core pending flag for the running kind', () => {
    expect(guardian).toContain('override fun superseded(): Boolean = ConnectivityGuardian.isSuperseded(kind)');
    expect(guardian).toContain('AndroidPorts(app, kind)');
  });

  it('the runner clock is monotonic (TriggerDebouncer contract)', () => {
    expect(guardian).toContain('override fun nowMs(): Long = SystemClock.elapsedRealtime()');
  });
});

describe('7 (native). ClosePaw dispatch: only the handleLine seam, only after reading the pre-approval', () => {
  it('TailscaleControl has one seam that builds the fixed line and calls handleLine', () => {
    expect(fn(tailscale, 'fun requestTailscale(')).toContain('dispatchViaClosePaw(context)');
    const d = fn(tailscale, 'private fun dispatchViaClosePaw(');
    expect(d).toContain('ConnectivityGuardianCore.closePawLine(reqId, now, ConnectivityGuardianCore.goalFor())');
        // Re-checked atomically against OFF (same lock order as handleLine), trusted variant only.
    const lock = d.indexOf('synchronized(ClosePawHandoff) {');
    const inner = d.indexOf('synchronized(ClosePawShellPreapproval) {');
    const check = d.indexOf('if (!ClosePawHandoff.isTrustedVariantInstalled(app) || !ClosePawShellPreapproval.isOn(app)) {');
    const call = d.indexOf('ClosePawHandoff.handleLine(app, line, now)');
    expect(lock).toBeGreaterThan(-1);
    expect(inner).toBeGreaterThan(lock);
    expect(check).toBeGreaterThan(inner);
    expect(call).toBeGreaterThan(check);
    // "approval-required" is still never counted as a hand-off.
    expect(d).toContain('code != "approval-required"');
    expect(d).toMatch(/"\$now-" \+ "%08x"\.format/);
  });

  it('the pre-approval is only READ, through isOn()', () => {
    expect(guardian).toContain('override fun closePawPreapproved(): Boolean = ClosePawShellPreapproval.isOn(app)');
    for (const [name, src] of Object.entries(guardianSources)) {
      const uses = code(src).match(/ClosePawShellPreapproval\.[a-zA-Z]+/g) ?? [];
      expect([name, uses.filter((u) => u !== 'ClosePawShellPreapproval.isOn')]).toEqual([name, []]);
    }
  });

  it('only TailscaleControl talks to ClosePawHandoff, and only handleLine / isStopAllOn', () => {
    for (const [name, src] of Object.entries(guardianSources)) {
      const uses = code(src).match(/ClosePawHandoff\.[a-zA-Z]+/g) ?? [];
      const allowed = name === 'TailscaleControl.kt' ? ['ClosePawHandoff.handleLine', 'ClosePawHandoff.isTrustedVariantInstalled'] : name === 'ConnectivityGuardian.kt' ? ['ClosePawHandoff.isStopAllOn'] : [];
      expect([name, uses.filter((u) => !allowed.includes(u))]).toEqual([name, []]);
    }
  });
});

describe('8 (native). fail closed: toggle OFF / unreadable mirror / STOP-ALL', () => {
  it('the store reads OFF on any error and accepts only exactly {v:1, enabled:true}', () => {
    const isOn = fn(store, 'fun isOn(');
    expect(isOn).toContain('json.optInt("v", -1) == VERSION && json.opt("enabled") == true');
    expect(store.slice(store.indexOf('fun isOn('))).toMatch(/\} catch \(e: Exception\) \{\s*Log\.w\(TAG, "mirror unreadable \(\$\{e\.javaClass\.simpleName\}\) - treating as OFF"\)\s*false\s*\}/);
    // The PR #158 pattern: AES-GCM, AAD, key re-created on every write.
    expect(store).toContain('"AES/GCM/NoPadding"');
    expect(store).toContain('cipher.updateAAD(AAD)');
    expect(fn(store, 'fun writeOn(')).toContain('val key = newKey()');
    expect(fn(store, 'private fun newKey(')).toContain('deleteEntry(KEY_ALIAS)');
    expect(store).toContain('PREFS = "shelly_connectivity_guardian"');
    expect(store).toContain('KEY_ALIAS = "shelly_connectivity_guardian_v1"');
  });

  it('every native entry checks the mirror before acting', () => {
    expect(fn(guardian, 'fun onBoot(')).toMatch(/if \(!enabled\) return/);
    expect(fn(guardian, 'fun onAppStart(')).toContain('if (!ConnectivityGuardianStore.isOn(app)) return');
    const internal = fn(guardian, 'fun onInternalBroadcast(');
    expect(internal.indexOf('if (!ConnectivityGuardianStore.isOn(app))')).toBeLessThan(internal.indexOf('when (intent.action)'));
    expect(guardian).toContain('override fun enabled(): Boolean = ConnectivityGuardianStore.isOn(app)');
    expect(guardian).toContain('override fun stopAll(): Boolean = ClosePawHandoff.isStopAllOn(app)');
  });

  it('turning it off clears the mirror, cancels the debounce and unregisters', () => {
    const set = fn(guardian, 'fun setFromRn(');
    expect(set).toContain('ConnectivityGuardianStore.clear(app, "settings off")');
    expect(set).toContain('onEvent(app, Event.Disable)');
    const unreg = fn(guardian, 'private fun unregisterAll(');
    expect(unreg).toContain('unregisterNetworkCallback(cb)');
    expect(unreg).toContain('unregisterNetworkCallback(pi)');
  });
});

describe('9 (native). the VPN probe is Shelly\'s own, never ClosePaw\'s report', () => {
  it('vpnUp is the TRANSPORT_VPN probe; ClosePaw\'s run is read only for its terminal status (sequencing)', () => {
    expect(guardian).toContain('override fun vpnUp(): Boolean? = TailscaleControl.isVpnUp(app)');
    expect(fn(tailscale, 'fun isVpnUp(')).toContain('hasTransport(NetworkCapabilities.TRANSPORT_VPN)');
    // The run-state file is read in exactly one place, for its status only.
    for (const [name, src] of Object.entries(guardianSources)) {
      const c = code(src);
      expect([name, /summary|"message"|shelly-closepaw-result-/.test(c)]).toEqual([name, false]);
      if (name !== 'TailscaleControl.kt') expect([name, /ClosePawRunResults/.test(c)]).toEqual([name, false]);
    }
    const settled = fn(tailscale, 'fun closePawRunSettled(');
    expect(settled).toContain('ClosePawRunResults.RUN_FILE_PREFIX + reqId + ClosePawRunResults.RUN_FILE_SUFFIX');
    expect(settled).toContain('ConnectivityGuardianCore.isClosePawSettled(JSONObject(f.readText()).optString("status", ""))');
    expect(settled).toContain('if (!ConnectivityGuardianCore.REQ_ID_RE.matches(reqId))');
    expect(code(tailscale).match(/ClosePawRunResults\.[A-Za-z_]+/g)).toEqual([
      'ClosePawRunResults.RUN_FILE_PREFIX',
      'ClosePawRunResults.RUN_FILE_SUFFIX',
    ]);
    expect(guardian).toContain('override fun closePawSettled(reqId: String): Boolean = TailscaleControl.closePawRunSettled(app, reqId)');
    // The seam hands back the request id only when the hand-off was accepted.
    expect(fn(tailscale, 'private fun dispatchViaClosePaw(')).toContain(
      'return if (result != null && result.ok && code != "approval-required") reqId else null',
    );
  });

  it('the settled statuses are exactly ClosePawRunResults\' terminal states (not running / approved / pending / untracked / queued)', () => {
    const runResults = read(`${KT}/ClosePawRunResults.kt`);
    const status = (n: string) => runResults.match(new RegExp(`const val ${n} = "([a-z-]+)"`))![1];
    const terminal = ['STATUS_COMPLETED', 'STATUS_FAILED', 'STATUS_CANCELLED', 'STATUS_TIMEOUT', 'STATUS_UNCERTAIN', 'STATUS_LOST', 'STATUS_REJECTED', 'STATUS_EXPIRED'].map(status);
    expect([...core.CLOSEPAW_SETTLED_STATUSES].sort()).toEqual(terminal.sort());
    for (const n of ['STATUS_RUNNING', 'STATUS_APPROVED', 'STATUS_PENDING_APPROVAL', 'STATUS_UNTRACKED', 'STATUS_QUEUED']) {
      expect(core.isClosePawSettled(status(n))).toBe(false);
    }
    expect(core.isClosePawSettled(null)).toBe(false);
  });

  it('adb_wifi_enabled writes are 0/1 only and behind the WRITE_SECURE_SETTINGS check', () => {
    const w = fn(wifiDebug, 'fun write(');
    expect(w.indexOf('if (!hasGrant(context)) return false')).toBeLessThan(w.indexOf('Settings.Global.putInt'));
    expect(w).toContain('if (value != 0 && value != 1) return false');
    expect(wifiDebug).toContain('Manifest.permission.WRITE_SECURE_SETTINGS');
    expect(wifiDebug).toContain('KEY_ADB_WIFI_ENABLED = "adb_wifi_enabled"');
  });
});

describe('10 (native). audit: IngressAuditWriter, agent-less file, fixed fields, no SSID', () => {
  it('the file name passes the writer\'s own FILE_NAME_RE', () => {
    const m = auditWriter.match(/private val FILE_NAME_RE = Regex\("(.+)"\)/);
    expect(m).not.toBeNull();
    const re = new RegExp(m![1].replace(/\\\\/g, '\\'));
    expect(re.test(core.AUDIT_FILE)).toBe(true);
  });

  it('lines are built by the core and appended agent-less', () => {
    expect(guardian).toContain('ConnectivityGuardianCore.buildAuditLine(');
    expect(guardian).toContain('IngressAuditWriter.append(app, null, ConnectivityGuardianCore.AUDIT_FILE, line)');
  });

  it('no guardian file reads Wi-Fi identity (SSID / BSSID)', () => {
    for (const [name, src] of Object.entries(guardianSources)) {
      expect([name, /ssid|bssid|WifiManager|WifiInfo|getConnectionInfo|transportInfo/i.test(code(src))]).toEqual([name, false]);
    }
  });
});

describe('11. source lockstep: manifest, FGS type, never main display, never launch()', () => {
  it('the boot receiver, the internal receiver and the service are in the MODULE manifest', () => {
    expect(manifest).toMatch(
      /<receiver\s+android:name="\.ConnectivityGuardianReceiver"\s+android:exported="true">\s*<intent-filter>\s*<action android:name="android\.intent\.action\.BOOT_COMPLETED" \/>\s*<action android:name="android\.intent\.action\.MY_PACKAGE_REPLACED" \/>/,
    );
    expect(manifest).toMatch(/<receiver\s+android:name="\.ConnectivityGuardianEventReceiver"\s+android:exported="false" \/>/);
    expect(manifest).toMatch(
      /<service\s+android:name="\.ConnectivityGuardianService"\s+android:exported="false"\s+android:stopWithTask="false"\s+android:foregroundServiceType="specialUse">\s*<property\s+android:name="android\.app\.PROPERTY_SPECIAL_USE_FGS_SUBTYPE"\s+android:value="connectivity_guardian" \/>/,
    );
  });

  it('the FGS starts as specialUse', () => {
    expect(fn(service, 'private fun startForegroundCompat(')).toContain('ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE');
    expect(service).toContain('START_NOT_STICKY');
  });

  it('the boot receiver ignores every other action', () => {
    expect(receiver).toContain(
      'if (action != Intent.ACTION_BOOT_COMPLETED && action != Intent.ACTION_MY_PACKAGE_REPLACED) return',
    );
    const ev = fn(receiver, 'class ConnectivityGuardianEventReceiver');
    expect(ev).toContain('else -> return');
  });

  it('no guardian file sends allow_main_display or calls ClosePawHandoff.launch(', () => {
    for (const [name, src] of Object.entries(guardianSources)) {
      const c = code(src);
      expect([name, /allow_main_display|ALLOW_MAIN_DISPLAY/i.test(c)]).toEqual([name, false]);
      expect([name, c.includes('ClosePawHandoff.launch(') || /\blaunch\(\s*context/.test(c)]).toEqual([name, false]);
      // No UI driving of any kind for consent dialogs.
      expect([name, /AccessibilityService|performGlobalAction|dispatchGesture|input tap/.test(c)]).toEqual([name, false]);
    }
  });

  it('app.config declares WRITE_SECURE_SETTINGS', () => {
    expect(appConfig).toContain('"WRITE_SECURE_SETTINGS",');
  });

  it('the internal PendingIntents are explicit and immutable', () => {
    expect(fn(guardian, 'private fun internalIntent(')).toContain('Intent(context, ConnectivityGuardianEventReceiver::class.java)');
    expect(fn(guardian, 'private fun wifiPendingIntent(')).toContain('PendingIntent.FLAG_IMMUTABLE');
    expect(fn(guardian, 'private fun alarmPendingIntent(')).toContain('PendingIntent.FLAG_IMMUTABLE');
  });

  it('Wi-Fi is tracked with a Wi-Fi-transport request, not the default network (VPN would mask it)', () => {
    expect(fn(guardian, 'private fun wifiRequest(')).toContain('addTransportType(NetworkCapabilities.TRANSPORT_WIFI)');
    expect(code(guardian)).not.toContain('registerDefaultNetworkCallback');
  });
});

describe('12 (native). boot / app start re-register; OFF = no-op', () => {
  it('the boot receiver goes to ConnectivityGuardian.onBoot, which posts Boot', () => {
    expect(receiver).toContain('ConnectivityGuardian.onBoot(context, reason)');
    expect(fn(guardian, 'fun onBoot(')).toContain('onEvent(app, Event.Boot(true, isWifiUp(app) == true, lossClock(app)))');
  });

  it('RegisterCallbacks registers the PendingIntent callback (survives process death) + in-process + watchdog', () => {
    expect(fn(guardian, 'fun onEvent(')).toContain('is Effect.RegisterCallbacks -> ensureRegistered(context)');
    const reg = fn(guardian, 'fun ensureRegistered(');
    expect(reg).toContain('cm.registerNetworkCallback(wifiRequest(), pi)');
    expect(reg).toContain('ensureInProcessCallback(app)');
    expect(reg).toContain('armWatchdog(app)');
  });

  it('app start re-registers (module OnCreate), and RN has the mirror function', () => {
    expect(moduleKt).toContain('runCatching { ConnectivityGuardian.onAppStart(context) }');
    expect(moduleKt).toContain('AsyncFunction("setConnectivityGuardianMirror") { enabled: Boolean ->');
    expect(read('modules/terminal-emulator/src/TerminalEmulatorModule.ts')).toContain(
      'setConnectivityGuardianMirror?(enabled: boolean): Promise<boolean>;',
    );
  });
});

describe('16 (native). coordinator gate round 1: settle, recovery reconcile, resident service', () => {
  const internal0 = () => fn(guardian, 'fun onInternalBroadcast(');

  it('the state checkpoint is durable (commit) and written BEFORE any effect; a failed one holds ON back', () => {
    const ev = fn(guardian, 'fun onEvent(');
    expect(ev).toContain('.commit()');
    expect(code(ev)).not.toContain('.apply()');
    const commitAt = ev.indexOf('.commit()');
    expect(commitAt).toBeLessThan(ev.indexOf('for (effect in t.effects)'));
    expect(ev).toContain('val t = if (durable) reduced else ConnectivityGuardianCore.withoutUndurableOn(reduced)');
    expect(ev.indexOf('state = t.state')).toBeGreaterThan(commitAt);
  });

  it('drain waits for the runner (which includes the settle wait) before SequenceDone; the drain is counted', () => {
    const drain = fn(guardian, 'fun drain(');
    expect(drain.indexOf('activeDrains.incrementAndGet()')).toBeLessThan(drain.indexOf('worker.execute'));
    expect(drain.indexOf('activeDrains.decrementAndGet()')).toBeLessThan(drain.indexOf('runCatching(onIdle)'));
    // The settle wait lives inside tailscaleStep, after every verify outcome, before return.
    const step = fn(coreKt, 'private fun tailscaleStep(');
    expect(step).toMatch(/try \{\s*return verifyTailscale\(r, action, before\)\s*\} finally \{\s*awaitSettle\(r, reqId, dispatchedAt\)\s*\}/);
    // No gate inside the settle wait: toggle off / STOP-ALL / superseded cannot cut it short.
    const settle = fn(coreKt, 'private fun awaitSettle(');
    expect(settle).not.toMatch(/gate\(|gated\(|superseded|enabled\(|stopAll\(/);
  });

  it('every recovery entry point reconciles against a fresh Wi-Fi probe', () => {
    const app = fn(guardian, 'fun onAppStart(');
    expect(app).toContain('reconcile(app)');
    expect(app).toContain('ensureResident(app, exemptNow = true)');
    expect(fn(guardian, 'fun onBoot(')).toContain('ensureResident(app, exemptNow = true)');
    // Cold process via the run hop: the loss callback is registered before reconcile.
    const svcStart = fn(guardian, 'fun onServiceStart(');
    expect(svcStart).toContain('if (!ConnectivityGuardianStore.isOn(app)) return');
    expect(svcStart.indexOf('ensureRegistered(app)')).toBeGreaterThan(-1);
    expect(svcStart.indexOf('ensureRegistered(app)')).toBeLessThan(svcStart.indexOf('reconcile(app)'));
    const runHop = internal0().slice(internal0().indexOf('ACTION_RUN ->'));
    expect(runHop.indexOf('ensureInProcessCallback(app)')).toBeLessThan(runHop.indexOf('startRunner(app, allowAlarmHop = false)'));
    expect(fn(service, 'override fun onStartCommand(')).toContain(
      'ConnectivityGuardian.drain(app, prelude = { ConnectivityGuardian.onServiceStart(app) }) { stopIfIdle() }',
    );
    const drain = fn(guardian, 'fun drain(');
    expect(drain.indexOf('prelude?.let { p -> runCatching(p) }')).toBeGreaterThan(drain.indexOf('worker.execute'));
    expect(drain.indexOf('prelude?.let { p -> runCatching(p) }')).toBeLessThan(drain.indexOf('val kind = takeQueued()'));
    const rec = fn(guardian, 'fun reconcile(');
    expect(rec).toContain('if (!ConnectivityGuardianStore.isOn(app)) return');
    expect(rec).toContain('true -> onEvent(app, Event.Reconcile(true, lossClock(app)))');
    expect(rec).toContain('false -> onEvent(app, Event.Reconcile(false, lossClock(app)))');
    expect(rec).toContain('null -> Unit');
    const internal = fn(guardian, 'fun onInternalBroadcast(');
    const wd = internal.slice(internal.indexOf('ACTION_WATCHDOG ->'));
    expect(wd).toContain('reconcile(app)');
    // The inexact watchdog is not an FGS-start exemption: residency only via the exact-alarm hop.
    expect(wd).toContain('ensureResident(app, exemptNow = false)');
  });

  it('residency starts only from exempt contexts or the existing exact-alarm hop', () => {
    const ens = fn(guardian, 'private fun ensureResident(');
    expect(ens).toContain('if (ConnectivityGuardianService.isRunning()) return');
    expect(ens).toContain('if (!keepResident(context)) return');
    expect(ens).toContain('if (exemptNow && ConnectivityGuardianService.start(context)) return');
    expect(ens).toContain('scheduleRunHop(context)');
    // Only these call sites start the service.
    expect(code(guardian).match(/ConnectivityGuardianService\.start\(/g)).toHaveLength(2);
    expect(code(guardian).match(/ensureResident\(app, exemptNow = true\)/g)).toHaveLength(2);
  });

  it('a resident service runs new sequences in place (no new start), under the stop-decision monitor', () => {
    const run = fn(guardian, 'private fun startRunner(');
    const sync = run.indexOf('synchronized(this) {');
    const check = run.indexOf('if (ConnectivityGuardianService.isRunning()) {');
    const drain = run.indexOf('drain(context) { ConnectivityGuardianService.stopIfIdle() }');
    expect(sync).toBeGreaterThan(-1);
    expect(check).toBeGreaterThan(sync);
    expect(drain).toBeGreaterThan(check);
    expect(drain).toBeLessThan(run.indexOf('ConnectivityGuardianService.start(context)'));
  });

  it('the service stops only when ConnectivityGuardian no longer needs it (decided under its monitor)', () => {
    const keep = fn(guardian, 'fun keepResident(');
    expect(guardian).toMatch(/@Synchronized\s+fun keepResident\(/);
    expect(keep).toContain('if (activeDrains.get() > 0 || queued != null) return true');
    expect(keep).toContain('if (!ConnectivityGuardianStore.isOn(context)) return false');
    expect(keep).toContain('return ConnectivityGuardianCore.wantsResident(currentState(context))');
    const stop = fn(service, 'fun stopIfIdle(');
    expect(stop).toContain('synchronized(ConnectivityGuardian) {');
    expect(stop).toContain('ConnectivityGuardian.keepResident(svc.applicationContext)');
    expect(stop.indexOf('running = false')).toBeLessThan(stop.indexOf('svc.stopSelf(svc.lastStartId)'));
    // After a drain the service no longer stops unconditionally.
    const start = fn(service, 'override fun onStartCommand(');
    expect(start).toContain('{ stopIfIdle() }');
    expect(start).not.toMatch(/post \{ if \(!destroyed\) stopSelf\(startId\) \}/);
    // Leaving the resident window (OFF done, toggle off) asks it to go.
    expect(fn(guardian, 'fun onEvent(')).toContain('if (!ConnectivityGuardianCore.wantsResident(t.state)) ConnectivityGuardianService.stopIfIdle()');
  });

  it('the service keeps its specialUse type, START_NOT_STICKY and the low-importance notification', () => {
    expect(fn(service, 'private fun startForegroundCompat(')).toContain('ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE');
    expect(service).toContain('NotificationManager.IMPORTANCE_LOW');
    expect(service).toContain('START_NOT_STICKY');
  });
});

describe('coordinator gate round 2 fix (native): the loss deadline is durable and recovery never restarts it', () => {
  it('the wall-clock loss anchor is part of the durable checkpoint and is restored', () => {
    const on = fn(guardian, 'fun onEvent(');
    expect(on).toContain('if (lossAt != null) edit.putLong(KEY_LOSS_AT, lossAt) else edit.remove(KEY_LOSS_AT)');
    // Written in the same commit, before any effect runs.
    expect(on.indexOf('edit.commit()')).toBeLessThan(on.indexOf('for (effect in t.effects)'));
    expect(on.indexOf('KEY_LOSS_AT')).toBeLessThan(on.indexOf('edit.commit()'));
    expect(fn(guardian, 'private fun currentState(')).toContain(
      'if (prefs.contains(KEY_LOSS_AT)) prefs.getLong(KEY_LOSS_AT, 0L) else null,',
    );
  });

  it('every loss / recovery event carries the loss clock (wall + elapsedRealtime + boot id)', () => {
    expect(guardian).toContain('onEvent(app, Event.WifiLost(lossClock(app)))');
    expect(guardian).not.toMatch(/Event\.WifiLost\)/);
    expect(guardian).not.toMatch(/Event\.(WifiLost|Reconcile|Boot)\([^)]*currentTimeMillis/);
  });

  it('an alarm that could not be armed is not believed outstanding (the next reconcile re-arms)', () => {
    const on = fn(guardian, 'fun onEvent(');
    expect(on).toContain('is Effect.ArmDebounce -> if (!armDebounce(context, effect.token, effect.delayMs)) {');
    expect(on).toContain('state = state?.copy(lossArmed = false)');
    const arm = fn(guardian, 'private fun armDebounce(');
    expect(arm).toContain('): Boolean = try {');
    expect(arm).toContain('SystemClock.elapsedRealtime() + delayMs');
  });

  it('lossArmed is never persisted (a fresh process always assumes the alarm may be gone)', () => {
    expect(guardian).not.toMatch(/putBoolean\([^)]*lossArmed/i);
    expect(guardian).not.toMatch(/KEY_LOSS_ARMED/);
  });
});

describe('coordinator gate round 3 fix (native): the loss anchor is monotonic with a boot identity', () => {
  it('lossClock reads wall clock, elapsedRealtime and Settings.Global.BOOT_COUNT (unreadable = null)', () => {
    const clock = fn(guardian, 'private fun lossClock(');
    expect(clock).toContain('Settings.Global.getInt(context.contentResolver, Settings.Global.BOOT_COUNT, -1)');
    expect(clock).toContain('}.getOrDefault(-1)');
    expect(clock).toContain('System.currentTimeMillis(),\n            SystemClock.elapsedRealtime(),');
    expect(clock).toContain('if (boot >= 0) boot.toLong() else null,');
    expect(guardian).toContain('import android.provider.Settings');
  });

  it('the monotonic anchor and boot id are in the durable checkpoint (same commit) and restored', () => {
    const on = fn(guardian, 'fun onEvent(');
    expect(on).toContain('if (lossElapsed != null) edit.putLong(KEY_LOSS_ELAPSED, lossElapsed) else edit.remove(KEY_LOSS_ELAPSED)');
    expect(on).toContain('if (lossBoot != null) edit.putLong(KEY_LOSS_BOOT, lossBoot) else edit.remove(KEY_LOSS_BOOT)');
    expect(on.indexOf('KEY_LOSS_ELAPSED')).toBeLessThan(on.indexOf('edit.commit()'));
    expect(on.indexOf('KEY_LOSS_BOOT')).toBeLessThan(on.indexOf('edit.commit()'));
    const restore = fn(guardian, 'private fun currentState(');
    expect(restore).toContain('if (prefs.contains(KEY_LOSS_ELAPSED)) prefs.getLong(KEY_LOSS_ELAPSED, 0L) else null,');
    expect(restore).toContain('if (prefs.contains(KEY_LOSS_BOOT)) prefs.getLong(KEY_LOSS_BOOT, 0L) else null,');
  });
});
