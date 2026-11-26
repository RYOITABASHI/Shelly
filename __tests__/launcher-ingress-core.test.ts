/**
 * C5 (fact sheet §1–§5, §8; D1, D6): the launcher ingress. The Kotlin JVM
 * tests (LauncherIngressCoreTest, LauncherCallerVerifierCoreTest,
 * TrustedCallerStoreTest) do not run in CI (build.gradle), so the contract
 * and the security properties are pinned here from the sources.
 */
import * as fs from 'fs';
import * as path from 'path';
import { INGRESS_OP_STAGES } from '@/lib/ingress-origin';
import {
  LAUNCHER_INGRESS_LIMITS,
  LAUNCHER_INGRESS_REASONS,
  normalizePin,
  parsePinList,
  parseTrustedCallerStatus,
  pinsLabel,
} from '@/lib/launcher-ingress';

jest.mock('@/modules/terminal-emulator/src/TerminalEmulatorModule', () => ({ __esModule: true, default: {} }));
jest.mock('@/lib/debug-logger', () => ({ logInfo: () => {}, logWarn: () => {}, logError: () => {} }));

const ROOT = path.join(__dirname, '..');
const KT_DIR = path.join(ROOT, 'modules/terminal-emulator/android/src/main/java/expo/modules/terminalemulator');
const kt = (name: string) => fs.readFileSync(path.join(KT_DIR, name), 'utf8');
const provider = kt('LauncherIngressProvider.kt');
const core = kt('LauncherIngressCore.kt');
const verifier = kt('LauncherCallerVerifierCore.kt');
const registry = kt('TrustedCallerStore.kt');
const manifest = fs.readFileSync(path.join(ROOT, 'modules/terminal-emulator/android/src/main/AndroidManifest.xml'), 'utf8');

describe('contract (fact sheet §1)', () => {
  it('the provider is exported on ${applicationId}.ingress with no Android permission', () => {
    const m = /<provider\s+android:name="\.LauncherIngressProvider"([\s\S]*?)\/>/.exec(manifest);
    expect(m).not.toBeNull();
    expect(m![1]).toContain('android:authorities="${applicationId}.ingress"');
    expect(m![1]).toContain('android:exported="true"');
    expect(m![1]).not.toMatch(/android:(read|write)?[pP]ermission/);
  });

  it('method names, keys and the target are the contract values', () => {
    expect(core).toContain('const val METHOD_SUBMIT = "submit_instruction"');
    expect(core).toContain('const val KEY_TEXT = "instruction_text"');
    expect(core).toContain('const val KEY_CORRELATION = "correlation_ref"');
    expect(core).toContain('const val KEY_NONCE = "submission_nonce"');
    expect(core).toContain('const val TARGET = "hayato"');
    for (const k of ['"status"', '"reason"', '"approval"', '"submission_id"', '"audit_event"', '"correlation_ref"', '"duplicate"']) {
      expect(core).toContain(`m[${k}]`);
    }
  });

  it('the reason values match the TS list', () => {
    const m = /enum class Reason \{([^}]*)\}/.exec(core);
    expect(m![1].split(',').map((s) => s.trim())).toEqual([...LAUNCHER_INGRESS_REASONS]);
  });

  it('the limits match LauncherIngressLimits.kt', () => {
    const limits = kt('LauncherIngressLimits.kt');
    const num = (name: string) => {
      const m = new RegExp(`const val ${name} = ([^\\n]+)`).exec(limits);
      if (!m) throw new Error(name);
      // eslint-disable-next-line no-new-func
      return Function(`return (${m[1].replace(/L\b/g, '').replace(/_/g, '')})`)() as number;
    };
    for (const [k, v] of Object.entries(LAUNCHER_INGRESS_LIMITS)) expect({ k, v: num(k) }).toEqual({ k, v });
  });

  it('call() never lets an exception reach the caller and always answers a Bundle', () => {
    const call = provider.slice(provider.indexOf('override fun call('), provider.indexOf('// ── submit_instruction'));
    expect(call).toMatch(/return try \{[\s\S]*\} catch \(t: Throwable\) \{[\s\S]*internalError\(\)/);
    expect(provider).toContain('override fun onCreate(): Boolean = true');
  });
});

describe('caller verification (fact sheet §2, F2/F3)', () => {
  it('identity comes from the Binder UID → exactly one package → pinned certificate; never getCallingPackage', () => {
    expect(provider).toContain('val uid = Binder.getCallingUid()');
    expect(provider).toContain('ctx.packageManager.getPackagesForUid(uid)');
    expect(provider).toContain('hasSigningCertificate(packageName, sha256, PackageManager.CERT_INPUT_SHA256)');
    expect(provider).not.toMatch(/getCallingPackage|callingPackage/);
    expect(verifier).toContain('pkgs.size != 1 -> Result.Failed("verify_shared_uid")');
    expect(verifier).toContain('const val MIN_SDK = 28');
    // Verification runs before the payload is even read.
    const submit = provider.slice(provider.indexOf('private fun submit('));
    expect(submit.indexOf('LauncherCallerVerifierCore.verify(')).toBeLessThan(submit.indexOf('checkPayload('));
  });

  it('VERIFY_FAILED carries no detail and no echo; the audit line carries the check', () => {
    expect(provider).toMatch(/denied\(LauncherIngressCore\.Reason\.VERIFY_FAILED, if \(audited\) "launcher_submit_denied" else null, null\)/);
  });

  it('A3 (failed caller + forged identity keys): VERIFY_FAILED is decided before extras are read, with no origin, principal or echo', () => {
    // The verifier cannot see the payload at all: its only inputs are the
    // Binder UID, the owner-registered entry and the PackageManager facts.
    expect(verifier).toMatch(/fun verify\(uid: Int, entry: TrustedCallerStore\.Entry\?, f: Facts\): Result/);
    const verifyBody = verifier.slice(verifier.indexOf('fun verify('));
    expect(verifyBody).not.toMatch(/Bundle|extras|instruction_text|origin"|"approved"|package_name|app_name/);
    // In submit(), the failed branch returns before `extras` is touched, so a
    // "correct" self-declared identity (package / origin / approval keys) in
    // extras cannot change the answer, the audit classification or issue an origin.
    const submit = provider.slice(provider.indexOf('private fun submit('));
    const failed = submit.slice(submit.indexOf('if (v !is LauncherCallerVerifierCore.Result.Verified)'), submit.indexOf('val principal = v.principal'));
    expect(failed).toContain('return toBundle(LauncherIngressCore.denied(LauncherIngressCore.Reason.VERIFY_FAILED');
    expect(failed).not.toMatch(/extras|principal|origin|corr/);
    // The failed audit line is the bare LauncherLine (kind, event, check code): no principal, no echo.
    expect(failed).toMatch(/IngressAuditWriter\.LauncherLine\("launcher_submit_denied", IngressAuditWriter\.LAUNCHER_EVENT_SUBMIT, code\)/);
    const afterSignature = submit.slice(submit.indexOf('{'));
    expect(afterSignature.indexOf('extras')).toBeGreaterThan(afterSignature.indexOf('val principal = v.principal'));
    // get_stream_feed never receives extras at all.
    expect(provider).toContain('private fun getFeed(ctx: Context): Bundle');
    expect(provider).toContain('private fun feedAnswer(ctx: Context): Bundle');
  });

  it('D6: no owner value is shipped (package, certificate pin, owner domain)', () => {
    // The repository must not even carry fingerprints of the owner values (a
    // hash of a package name is enough to confirm it). So the check here is
    // structural: the launcher sources name no package except the
    // com.example placeholder and contain no certificate-length hex. An
    // owner-side check with the real values can be run locally by pointing
    // SHELLY_D6_FORBIDDEN_FILE at a file outside the repository (one value
    // per line); it is skipped when unset.
    const files = [
      ...['LauncherIngressProvider.kt', 'LauncherIngressCore.kt', 'LauncherCallerVerifierCore.kt', 'LauncherIngressLimits.kt',
        'TrustedCallerStore.kt', 'IngressOrigin.kt', 'StreamFeedCore.kt', 'StreamFeedStore.kt'].map((f) => path.join(KT_DIR, f)),
      path.join(ROOT, 'lib/launcher-ingress.ts'),
      path.join(ROOT, 'lib/ingress-origin.ts'),
      path.join(ROOT, 'components/settings/LauncherIngressSection.tsx'),
      path.join(ROOT, 'modules/terminal-emulator/android/src/main/AndroidManifest.xml'),
    ];
    for (const f of files.filter((x) => fs.existsSync(x))) {
      const src = fs.readFileSync(f, 'utf8');
      const hex = src.replace(/:/g, '').match(/[0-9a-f]{40,}/gi) ?? [];
      expect({ f, hex }).toEqual({ f, hex: [] });
      const pkgs = (src.match(/\b(?:com|org|net|io|jp|ai)\.[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+\b/g) ?? [])
        .filter((p) => !p.startsWith('com.example.'));
      expect({ f, pkgs }).toEqual({ f, pkgs: [] });
    }
    const forbiddenFile = process.env.SHELLY_D6_FORBIDDEN_FILE;
    if (forbiddenFile && fs.existsSync(forbiddenFile)) {
      const values = fs.readFileSync(forbiddenFile, 'utf8').split('\n').map((v) => v.trim().toLowerCase()).filter(Boolean);
      const all = [...fs.readdirSync(KT_DIR).map((f) => path.join(KT_DIR, f)), ...files, path.join(ROOT, 'app.config.ts')].filter((x) => fs.existsSync(x));
      for (const f of all) {
        if (!fs.statSync(f).isFile()) continue;
        const src = fs.readFileSync(f, 'utf8').toLowerCase().replace(/:/g, '');
        expect({ f, hits: values.filter((v) => src.includes(v.replace(/:/g, ''))) }).toEqual({ f, hits: [] });
      }
    }
  });

});

describe('decision (fact sheet §3, D1)', () => {
  it('runs through the shared stage order with exactly the submit_instruction stages', () => {
    const body = core.slice(core.indexOf('fun decide('), core.indexOf('// ── end decide'));
    expect(body).toMatch(/IngressDecision\.evaluate\(IngressDecision\.OP_SUBMIT_INSTRUCTION, hooks\)/);
    const hooked = [...body.matchAll(/IngressDecision\.Stage\.([A-Z0-9_]+) to \{/g)].map((m) => m[1]);
    expect(hooked).toEqual([...INGRESS_OP_STAGES.submit_instruction]);
  });

  it('taint comes only from IngressOrigin.taintFor, and a tainted submission gets no rule or switch', () => {
    expect(core).toContain('taint = IngressOrigin.taintFor(');
    expect(core).toContain('val ruleId = if (taint.tainted) null else f.matchRule(principal.wire)');
    expect(core).toContain('if (!taint.tainted && f.approveAllOn())');
  });

  it('the approve-all switch is used under its decision token (STOP-ALL cannot race it)', () => {
    expect(provider).toMatch(/ApprovalSwitches\.withApproveAllToken\(ctx, token\) \{ attempt\(true\) \} \?: attempt\(false\)/);
    expect(provider).toContain('override fun halted(): Boolean = StopAllSwitches.halted(ctx)');
  });

  it('the exemption is bound to the current pin digest and op (D1); changing the identity drops it', () => {
    expect(registry).toMatch(/fun exemptionBound\(e: Entry\?, op: String\): Boolean/);
    expect(registry).toContain('if (identityChanged) null else old?.exemption');
    expect(registry).toContain('if (expectedDigest == null || expectedDigest != digest) return SetResult.Refused("digest_changed")');
  });

  it('A1: pending answers at once; nothing in the provider waits on RN, the UI or a person', () => {
    expect(provider).not.toMatch(/Thread\.sleep|\.await\(|CountDownLatch|runBlocking|wait\(/);
    expect(provider).not.toMatch(/McpApproval|ReactContext|sendEvent/);
  });

  it('the audit line is written before the record, and a failed one writes nothing (fail closed)', () => {
    const tx = kt('McpRunTickets.kt');
    const body = tx.slice(tx.indexOf('fun <T> submissionTransaction('), tx.indexOf('fun readSubmissionJson('));
    expect(body.indexOf('write.beforeWrite()')).toBeLessThan(body.indexOf('writePrivateAtomic(textFile'));
    expect(body).toContain('if (!write.beforeWrite()) return onResult(answer, SubmissionWriteResult.REFUSED_BY_AUDIT)');
  });
});

describe('no instruction text, pin or package in logs (§8 R9)', () => {
  /**
   * Index of the paren closing the call whose '(' is at [open]. A small Kotlin
   * lexer: parens inside string literals are text, and `${…}` templates (which
   * may hold strings of their own) are code again.
   */
  function callEnd(src: string, open: number): number {
    type Frame = { str: boolean; parens: number; braces: number };
    const stack: Frame[] = [{ str: false, parens: 0, braces: 0 }];
    for (let i = open; i < src.length; i++) {
      const f = stack[stack.length - 1];
      const c = src[i];
      if (f.str) {
        if (c === '\\') i++;
        else if (c === '"') stack.pop();
        else if (c === '$' && src[i + 1] === '{') { stack.push({ str: false, parens: 0, braces: 0 }); i++; }
        continue;
      }
      if (c === '"') stack.push({ str: true, parens: 0, braces: 0 });
      else if (c === '(') f.parens++;
      else if (c === ')') { f.parens--; if (stack.length === 1 && f.parens === 0) return i; }
      else if (c === '{') f.braces++;
      else if (c === '}') { if (f.braces === 0 && stack.length > 1) stack.pop(); else f.braces--; }
    }
    return src.length - 1;
  }

  it('the log extractor reads past parens in strings and nested templates', () => {
    const src = 'Log.w(TAG, "a) ${x.y("q)")} b") ; Log.i(TAG, "z")';
    expect(callEnd(src, 5)).toBe(src.indexOf(' ;') - 1);
  });

  function logStatements(source: string): string[] {
    const out: string[] = [];
    const re = /\bLog\.[dviwe]\(/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(source))) {
      // To the matching close paren (Kotlin has no `;`), ignoring parens inside string literals.
      const end = callEnd(source, m.index + m[0].length - 1);
      const stmt = source.slice(m.index, end + 1);
      expect(stmt.length).toBeGreaterThan(m[0].length + 1);
      out.push(stmt);
    }
    return out;
  }
  it.each(['LauncherIngressProvider.kt', 'LauncherIngressCore.kt', 'LauncherCallerVerifierCore.kt', 'TrustedCallerStore.kt'])('%s', (f) => {
    const stmts = logStatements(kt(f));
    if (f !== 'LauncherIngressCore.kt' && f !== 'LauncherCallerVerifierCore.kt') expect(stmts.length).toBeGreaterThan(0);
    for (const s of stmts) {
      expect({ s, bad: /\$\{?(text|payload|extras|p\.text|packageName|pins?|entry|e\.packageName|principal)\b/.test(s) }).toEqual({ s, bad: false });
    }
  });
});

describe('lib/launcher-ingress.ts', () => {
  const PIN = '0a'.repeat(32);
  it('pins: colon and plain forms round-trip; lists are bounded', () => {
    expect(normalizePin(Array(32).fill('0A').join(':'))).toBe(PIN);
    expect(normalizePin(PIN.toUpperCase())).toBe(PIN);
    expect(normalizePin('xyz')).toBeNull();
    expect(parsePinList(`${PIN}\n${'0b'.repeat(32)}, ${PIN}`)).toEqual([PIN, '0b'.repeat(32)]);
    expect(parsePinList('')).toBeNull();
    expect(parsePinList(Array.from({ length: 5 }, (_, i) => i.toString(16).padStart(64, '0')).join('\n'))).toBeNull();
    expect(parsePinList(`${PIN}\nnot-a-pin`)).toBeNull();
  });

  it('the status parser is strict', () => {
    const caller = {
      origin: 'launcher', packageName: 'com.example.launcher', pins: [PIN], enabled: true, updatedAt: 1,
      pinsDigest: 'c'.repeat(64), principal: `launcher:${'c'.repeat(32)}`, exemptionBound: false,
    };
    expect(parseTrustedCallerStatus(JSON.stringify({ version: 1, status: 'ok', callers: [caller], ok: true, code: 'set' }))).toEqual({
      status: 'ok', callers: [caller], ok: true, code: 'set',
    });
    for (const bad of [{ ...caller, principal: 'c'.repeat(32) }, { ...caller, pins: ['nope'] }, { ...caller, packageName: 'x' }]) {
      expect(parseTrustedCallerStatus(JSON.stringify({ version: 1, status: 'ok', callers: [bad] })).status).toBe('unreadable');
    }
    expect(parseTrustedCallerStatus('garbage').status).toBe('unreadable');
  });
});

describe('unverified callers and the exemption confirmation', () => {
  it('audit lines of callers that fail verification are throttled; the answer is unchanged', () => {
    expect(core).toMatch(/class AuditThrottle\(/);
    expect(provider).toContain('private val unverifiedAudit = LauncherIngressCore.AuditThrottle()');
    const submit = provider.slice(provider.indexOf('private fun submit('), provider.indexOf('val principal = v.principal'));
    expect(submit).toContain('unverifiedAudit.allow(System.currentTimeMillis()) && IngressAuditWriter.appendLauncherLine(');
    expect(submit).toMatch(/denied\(LauncherIngressCore\.Reason\.VERIFY_FAILED, if \(audited\) "launcher_submit_denied" else null, null\)/);
    const feed = provider.slice(provider.indexOf('private fun feedAnswer('));
    expect(feed).toContain('if (unverifiedAudit.allow(System.currentTimeMillis())) line((v as LauncherCallerVerifierCore.Result.Failed).code)');
    // Verified paths never go through the throttle.
    expect(provider.match(/unverifiedAudit\.allow/g)).toHaveLength(2);
  });

  it('the exemption confirmation shows the pins themselves (what the owner can check), not only the digest', () => {
    const PIN = '0123456789abcdef'.repeat(4);
    expect(pinsLabel([PIN, 'f'.repeat(64)])).toBe(
      `${'01234567 89abcdef '.repeat(4).trim()}\n${'ffffffff '.repeat(8).trim()}`,
    );
  });
});

describe('review fixes (Codex gate, 2026-11-26)', () => {
  const auditWriter = kt('IngressAuditWriter.kt');

  it('decision and commit run under the registry lock; a revoked rule is re-checked at commit', () => {
    const submit = provider.slice(provider.indexOf('private fun submit('), provider.indexOf('// ── get_stream_feed'));
    const lock = submit.indexOf('return synchronized(TrustedCallerStore) {');
    expect(lock).toBeGreaterThan(0);
    expect(submit.indexOf('ApprovalSwitches.approveAllToken(ctx)')).toBeGreaterThan(lock);
    // The registration is re-checked under the lock before any decision (nonce duplicates included).
    const recheck = submit.indexOf('if (TrustedCallerStore.entry(ctx, IngressOrigin.LAUNCHER) != v.entry) {', lock);
    expect(recheck).toBeGreaterThan(lock);
    expect(recheck).toBeLessThan(submit.indexOf('attempt(true)', lock));
    // The answer (duplicate audit lines included) is built inside the same lock.
    expect(submit.indexOf('line(kind, "duplicate", s, duplicate = true)', lock)).toBeGreaterThan(lock);
    // Phase 2 gate round 2: the INTERNAL_ERROR answer now goes through answerDenied (denial record first).
    expect(submit.indexOf('Answer.AuditFailed -> answerDenied(LauncherIngressCore.Reason.INTERNAL_ERROR, "audit_failed", null, corr)', lock)).toBeGreaterThan(lock);
    expect(submit.slice(lock).indexOf('return when (answer)')).toBe(-1);
    // The `when` sits one level inside the synchronized block (12 spaces), not after it (8).
    expect(submit.indexOf('\n            when (answer) {')).toBeGreaterThan(lock);
    expect(submit.indexOf('\n        when (answer)')).toBe(-1);
    expect(registry.match(/@Synchronized\s+fun (setCaller|setExemption|removeCaller)\(/g)).toHaveLength(3);
    expect(provider).toContain('d.via == "rule" && facts.matchRule(principal.wire) != d.ruleId -> { ruleChangedAtCommit = true; false }');
    expect(provider).toContain('ruleChangedAtCommit -> Answer.Deny(LauncherIngressCore.Reason.GATE_DENIED, "rule_changed")');
  });

  it('get_stream_feed re-checks the registration after the store read, and audits per caller', () => {
    const feed = provider.slice(provider.indexOf('private fun feedAnswer('));
    expect(feed.indexOf('val nowEntry = TrustedCallerStore.entry(ctx, IngressOrigin.LAUNCHER)')).toBeGreaterThan(feed.indexOf('StreamFeedStore.read(ctx)'));
    expect(feed.indexOf('if (nowEntry != v.entry)')).toBeLessThan(feed.indexOf('            toBundle(StreamFeedCore.readResponse(state))'));
    expect(feed).toContain('lastServed != "$principal|${state.stored.sha256}"');
    const locked = feed.indexOf('return synchronized(TrustedCallerStore) {');
    expect(locked).toBeGreaterThan(feed.indexOf('StreamFeedStore.read(ctx)'));
    expect(locked).toBeLessThan(feed.indexOf('val nowEntry ='));
  });

  it('the D1 rate brake also reads a history outside $HOME and fails closed when it cannot', () => {
    expect(core).toContain('fun rateHistory(): List<Long>? = emptyList()');
    expect(core).toContain('val human = bound && kept != null &&');
    expect(provider).toContain('override fun rateHistory(): List<Long>? = LauncherRateHistory.times(ctx)');
    // Kept before the audit line and the record, and a failure publishes nothing.
    const w = provider.slice(provider.indexOf('McpRunTickets.SubmissionWrite.Write(s, p.text) {'));
    const kept = w.indexOf('!LauncherRateHistory.record(ctx, s.acceptedAt) -> { rateNotKeptAtCommit = true; false }');
    expect(kept).toBeGreaterThan(0);
    // First, so its disk write is not between the STOP-ALL / registration / rule re-checks and the audit line.
    expect(kept).toBeLessThan(w.indexOf('StopAllSwitches.halted(ctx) -> { haltedAtCommit = true; false }'));
    expect(kept).toBeLessThan(w.indexOf('IngressAuditWriter.appendLauncherLine(ctx, line(kind, code, s))'));
    expect(provider).toContain('rateNotKeptAtCommit -> Answer.Deny(LauncherIngressCore.Reason.INTERNAL_ERROR, "rate_history_failed")');
    expect(provider).toContain('fun record(ctx: Context, t: Long): Boolean {');
    expect(provider).toContain('File(File(ctx.noBackupFilesDir, "launcher-ingress"), "rate-v1")');
  });

  it('the audit writer opens non-blocking and refuses anything but a regular file', () => {
    const append = auditWriter.slice(auditWriter.indexOf('fun append(context: Context'));
    expect(append).toContain('OsConstants.O_NONBLOCK');
    expect(append.indexOf('OsConstants.S_ISREG(Os.fstat(fd).st_mode)')).toBeLessThan(append.indexOf('out.write('));
  });

  it('launcher audit lines: origin only with a verified principal; join keys use the contract names', () => {
    expect(auditWriter).toContain('if (l.principal != null) out.put("origin", IngressOrigin.LAUNCHER)');
    expect(auditWriter).toContain('out.put("submission_id", l.submissionId)');
    expect(auditWriter).toContain('out.put("correlation_ref", l.correlationRef)');
  });
});

describe('review fixes (C5 gate)', () => {
  const K = path.join(__dirname, '..', 'modules/terminal-emulator/android/src/main/java/expo/modules/terminalemulator');
  const provider = fs.readFileSync(path.join(K, 'LauncherIngressProvider.kt'), 'utf8');
  const core = fs.readFileSync(path.join(K, 'LauncherIngressCore.kt'), 'utf8');

  it('STOP-ALL and the registration are re-checked at the commit boundary, before the audit line', () => {
    const w = provider.slice(provider.indexOf('McpRunTickets.SubmissionWrite.Write(s, p.text) {'));
    const halted = w.indexOf('StopAllSwitches.halted(ctx) -> { haltedAtCommit = true; false }');
    const entry = w.indexOf('TrustedCallerStore.entry(ctx, IngressOrigin.LAUNCHER) != v.entry');
    const audit = w.indexOf('IngressAuditWriter.appendLauncherLine(ctx, line(kind, code, s))');
    expect(halted).toBeGreaterThan(0);
    expect(entry).toBeGreaterThan(halted);
    expect(audit).toBeGreaterThan(entry);
    expect(provider).toContain('haltedAtCommit -> Answer.Deny(LauncherIngressCore.Reason.STOP_ALL_ACTIVE, "halted")');
  });

  it('correlation_ref: kept on verified denials; an existing submission answers with its own reference', () => {
    expect(provider).toContain('val corr = LauncherIngressCore.correlationOf(extras?.let { BundleExtras(it) })');
    expect(provider).toContain('correlationRef = if (duplicate == true) s?.correlationRef else corr');
    expect(provider).toContain('kind, s.correlationRef, true))');
  });

  it('nonce size counts code points', () => {
    expect(core).toContain('n.codePointCount(0, n.length) > 64');
  });

  it('get_stream_feed fails closed to the C7 error shape (exception or unwritten audit line)', () => {
    expect(provider).toMatch(/private fun getFeed\(ctx: Context\): Bundle = try \{\s*feedAnswer\(ctx\)/);
    expect(provider).toContain('toBundle(StreamFeedCore.readResponse(StreamFeedCore.State.Unreadable))');
  });
});

it('the shared audit writer closes its fd (the exported Provider reaches it on every denied call)', () => {
  const w = fs.readFileSync(path.join(__dirname, '..', 'modules/terminal-emulator/android/src/main/java/expo/modules/terminalemulator/IngressAuditWriter.kt'), 'utf8');
  const append = w.slice(w.indexOf('fun append(context: Context'));
  expect(append.indexOf('runCatching { Os.close(fd) }')).toBeGreaterThan(append.indexOf('val fd = Os.open('));
});
