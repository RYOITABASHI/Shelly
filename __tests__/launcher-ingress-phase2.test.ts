/**
 * Launcher ingress Phase 2 (docs/superpowers/launcher-ingress-phase2-fact-sheet.md):
 * C6 asynchronous approval through the EXISTING approval store / modal (D8),
 * the read-only inbox, the derived `stale` state, `consumed`, and the D2
 * reader typed ops. Kotlin does not run in CI, so the native properties are
 * pinned from the sources; the RN half runs here.
 */
import * as fs from 'fs';
import * as path from 'path';

const toast = jest.fn();
jest.mock('react-native', () => ({ Platform: { OS: 'android' }, ToastAndroid: { show: (...a: unknown[]) => toast(...a), LONG: 1 } }));
jest.mock('@/lib/i18n', () => ({ t: (k: string) => k }));
jest.mock('@/lib/debug-logger', () => ({ logInfo: jest.fn(), logWarn: jest.fn(), logError: jest.fn() }));
const native: Record<string, jest.Mock> = {};
jest.mock('@/modules/terminal-emulator/src/TerminalEmulatorModule', () => ({ __esModule: true, default: new Proxy({}, { get: (_t, k: string) => native[k] }) }));

import {
  __resetLauncherApprovalForTests,
  decideLauncherSubmission,
  formatRemaining,
  maybePromptLauncherSubmission,
  parseLauncherDecisionResult,
  parseLauncherInbox,
  parseLauncherPending,
  parseLauncherPrompt,
} from '@/lib/launcher-approval';
import { useMcpApprovalStore } from '@/store/mcp-approval-store';

const ROOT = path.join(__dirname, '..');
const KT_DIR = path.join(ROOT, 'modules/terminal-emulator/android/src/main/java/expo/modules/terminalemulator');
const kt = (name: string) => fs.readFileSync(path.join(KT_DIR, name), 'utf8');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const ID_A = `ls_${'a'.repeat(32)}`;
const ID_B = `ls_${'b'.repeat(32)}`;
const SECRET = 'buy milk and call mom';

const prompt = (id: string, over: object = {}) => JSON.stringify({
  v: 1, id, text: SECRET, acceptedAt: 1_000, expiresAt: Date.now() + 600_000, untrusted: true, codePoints: 21, ...over,
});

const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  for (const k of Object.keys(native)) delete native[k];
  useMcpApprovalStore.setState({ current: null, queue: [] });
  __resetLauncherApprovalForTests();
  toast.mockReset();
});

describe('parsers (strict, fail to nothing, never text in the inbox)', () => {
  it('inbox items are validated; one carrying text is dropped', () => {
    const inbox = parseLauncherInbox(JSON.stringify({
      v: 1, now: 5, halted: false, items: [
        { kind: 'record', id: ID_A, state: 'pending_approval', at: 1, expiresAt: 601, untrusted: true, codePoints: 3, reason: 'awaiting_approval' },
        { kind: 'record', id: ID_B, state: 'stale', at: 1, decidedAt: 2, approvedVia: 'user' },
        { kind: 'denied', state: 'denied', at: 2, code: 'halted', reason: 'STOP_ALL_ACTIVE' },
        { kind: 'record', id: ID_A, state: 'approved', at: 1, text: SECRET },
        { kind: 'record', state: 'approved', at: 1 },
        { kind: 'record', id: ID_A, state: 'running', at: 1 },
      ],
    }));
    expect(inbox.ok).toBe(true);
    expect(inbox.items.map((i) => i.state)).toEqual(['pending_approval', 'stale', 'denied']);
    expect(JSON.stringify(inbox)).not.toContain(SECRET);
    expect(parseLauncherInbox('{"v":2}').ok).toBe(false);
    expect(parseLauncherInbox('nope').ok).toBe(false);
  });

  it('prompt / pending / decision results', () => {
    expect(parseLauncherPrompt(prompt(ID_A))?.text).toBe(SECRET);
    expect(parseLauncherPrompt(prompt('mr_' + 'a'.repeat(32)))).toBeNull();
    expect(parseLauncherPending('{"v":1,"halted":false,"ids":["' + ID_A + '"]}')).toEqual({ ok: true, halted: false, ids: [ID_A] });
    expect(parseLauncherPending('{"v":1,"halted":false,"ids":["x"]}').ok).toBe(false);
    expect(parseLauncherDecisionResult('{"ok":true,"code":"approved_always","state":"approved","rule":"added"}'))
      .toEqual({ ok: true, code: 'approved_always', state: 'approved', rule: 'added' });
    expect(parseLauncherDecisionResult('garbage')).toEqual({ ok: false, code: 'failed' });
    expect(formatRemaining(61_000)).toBe('1:01');
    expect(formatRemaining(-5)).toBe('0:00');
  });

  it('decide sends only the existing decision kinds', async () => {
    native.launcherSubmissionDecide = jest.fn(async () => '{"ok":true,"code":"denied_user","state":"denied_by_user"}');
    await decideLauncherSubmission(ID_A, 'deny');
    expect(native.launcherSubmissionDecide).toHaveBeenCalledWith(ID_A, 'deny');
    expect(await decideLauncherSubmission(ID_A, 'dismiss' as never)).toEqual({ ok: false, code: 'invalid' });
    expect(await decideLauncherSubmission('bad', 'once')).toEqual({ ok: false, code: 'unavailable' });
  });
});

describe('the foreground prompt (P2-A1/A2, P2-B1/B2/B4, P2-A5)', () => {
  function setPending(ids: string[], halted = false) {
    native.launcherSubmissionPending = jest.fn(async () => JSON.stringify({ v: 1, halted, ids }));
    native.launcherSubmissionPrompt = jest.fn(async (id: string) => prompt(id));
  }

  it('shows the OLDEST pending one in the existing approval store, one at a time, then the next', async () => {
    setPending([ID_A, ID_B]);
    native.launcherSubmissionDecide = jest.fn(async () => '{"ok":true,"code":"approved_user","state":"approved"}');
    expect(await maybePromptLauncherSubmission('foreground')).toBe(true);
    const cur = useMcpApprovalStore.getState().current!;
    expect(cur.kind).toBe('submit_instruction');
    expect(cur.launcher?.submissionId).toBe(ID_A);
    expect(cur.detail).toBe(SECRET);
    expect(cur.alwaysAllowable).toEqual({ op: 'submit_instruction', targetLabel: 'hayato' });
    // A second trigger while it is shown does nothing (one at a time).
    expect(await maybePromptLauncherSubmission('poll')).toBe(false);
    setPending([ID_B]);
    useMcpApprovalStore.getState().respond(cur.id, 'once');
    await flush(); await flush(); await flush();
    expect(native.launcherSubmissionDecide).toHaveBeenCalledWith(ID_A, 'once');
    expect(useMcpApprovalStore.getState().current?.launcher?.submissionId).toBe(ID_B);
  });

  it('"always" goes to native as the existing kind (native writes the C3 rule)', async () => {
    setPending([ID_A]);
    native.launcherSubmissionDecide = jest.fn(async () => '{"ok":true,"code":"approved_always","state":"approved","rule":"added"}');
    await maybePromptLauncherSubmission('foreground');
    setPending([]);
    useMcpApprovalStore.getState().respond(useMcpApprovalStore.getState().current!.id, 'always');
    await flush(); await flush();
    expect(native.launcherSubmissionDecide).toHaveBeenCalledWith(ID_A, 'always');
  });

  it('closing decides nothing and suppresses polling prompts until the next foreground', async () => {
    setPending([ID_A]);
    native.launcherSubmissionDecide = jest.fn();
    await maybePromptLauncherSubmission('foreground');
    useMcpApprovalStore.getState().dismiss(useMcpApprovalStore.getState().current!.id);
    expect(native.launcherSubmissionDecide).not.toHaveBeenCalled();
    expect(useMcpApprovalStore.getState().current).toBeNull();
    expect(await maybePromptLauncherSubmission('poll')).toBe(false);
    expect(await maybePromptLauncherSubmission('foreground')).toBe(true);
  });

  it('the inbox can reopen a specific pending one; a non-pending id prompts nothing', async () => {
    setPending([ID_A, ID_B]);
    expect(await maybePromptLauncherSubmission('inbox', ID_B)).toBe(true);
    expect(useMcpApprovalStore.getState().current?.launcher?.submissionId).toBe(ID_B);
    useMcpApprovalStore.setState({ current: null, queue: [] });
    expect(await maybePromptLauncherSubmission('inbox', `ls_${'c'.repeat(32)}`)).toBe(false);
  });

  it('nothing is prompted while STOP-ALL is on', async () => {
    setPending([ID_A], true);
    expect(await maybePromptLauncherSubmission('foreground')).toBe(false);
    expect(native.launcherSubmissionPrompt).not.toHaveBeenCalled();
  });

  it('MCP token revocation (denyAll) closes a launcher prompt without denying it', async () => {
    setPending([ID_A]);
    native.launcherSubmissionDecide = jest.fn();
    await maybePromptLauncherSubmission('foreground');
    useMcpApprovalStore.getState().denyAll();
    await flush();
    expect(native.launcherSubmissionDecide).not.toHaveBeenCalled();
  });

  it('a decision that was not recorded is shown and does not re-prompt at once', async () => {
    setPending([ID_A]);
    native.launcherSubmissionDecide = jest.fn(async () => '{"ok":false,"code":"halted"}');
    await maybePromptLauncherSubmission('foreground');
    useMcpApprovalStore.getState().respond(useMcpApprovalStore.getState().current!.id, 'once');
    await flush(); await flush();
    expect(toast).toHaveBeenCalledWith('launcher_approval.err.halted', 1);
    expect(useMcpApprovalStore.getState().current).toBeNull();
  });
});

describe('D8: no new approval store, decision kind or rule format', () => {
  it('the decision kinds are still exactly deny | once | always', () => {
    expect(read('store/mcp-approval-store.ts')).toContain("export type McpApprovalDecision = 'deny' | 'once' | 'always';");
    const core = kt('LauncherSubmissionCore.kt');
    expect(core).toContain('enum class UserDecision { DENY, ONCE, ALWAYS }');
    expect(core).toMatch(/"deny" -> UserDecision\.DENY\s+"once" -> UserDecision\.ONCE\s+"always" -> UserDecision\.ALWAYS\s+else -> null/);
  });

  it('"always" writes the existing C3 rule into McpAlwaysAllowStore (no bind), after the approval was written', () => {
    const io = kt('LauncherSubmissions.kt');
    const decide = io.slice(io.indexOf('fun decide('), io.indexOf('// ── What RN shows'));
    expect(decide).toMatch(/McpAlwaysAllowStore\.add\(\s*context, p\.next\.principal, IngressDecision\.OP_SUBMIT_INSTRUCTION, LauncherIngressCore\.TARGET, null,/);
    expect(decide.indexOf('SubmissionWriteResult.WRITTEN ->')).toBeLessThan(decide.indexOf('McpAlwaysAllowStore.add('));
    // Lock order as the Provider: TrustedCallerStore → McpRunTickets → McpAlwaysAllowStore.
    expect(decide.indexOf('synchronized(TrustedCallerStore)')).toBeLessThan(decide.indexOf('McpRunTickets.submissionUpdate'));
    // No store of its own.
    for (const f of ['LauncherSubmissions.kt', 'LauncherSubmissionCore.kt', 'LauncherApprovalNotifier.kt']) {
      expect(kt(f)).not.toMatch(/SharedPreferences|getSharedPreferences|KeyStore/);
    }
    expect(read('store/launcher-inbox-store.ts')).not.toMatch(/persist\(|resolve|decision:/);
  });

  it('the decision is audited before the record is rewritten (fail closed), with the existing launcher kinds', () => {
    const tickets = kt('McpRunTickets.kt');
    const upd = tickets.slice(tickets.indexOf('fun <T> submissionUpdate('), tickets.indexOf('fun allSubmissionsCurrent('));
    expect(upd).toContain('if (!change.beforeWrite()) return onResult(answer, SubmissionWriteResult.REFUSED_BY_AUDIT)');
    expect(upd.indexOf('change.beforeWrite()')).toBeLessThan(upd.indexOf('writePrivateAtomic('));
    const core = kt('LauncherSubmissionCore.kt');
    expect(core).toContain('"launcher_submit_user_denied", "denied_user"');
    expect(core).toContain('"launcher_submit_approved", "approved_always"');
    expect(core).toContain('"launcher_submit_approved", "approved_user"');
    const writer = kt('IngressAuditWriter.kt');
    for (const k of ['launcher_submit_approved', 'launcher_submit_user_denied', 'launcher_submit_expired']) expect(writer).toContain(`"${k}"`);
    // Expiry is audited too (Phase 1 wrote none).
    expect(tickets).toContain('LauncherSubmissionCore.recordLine("launcher_submit_expired", "expired", s)');
  });

  it('only a pending, not expired submission can be decided; approving needs STOP-ALL off and the same registration', () => {
    const core = kt('LauncherSubmissionCore.kt');
    const plan = core.slice(core.indexOf('fun planUserDecision('), core.indexOf('fun decisionResult('));
    expect(plan.indexOf('!= McpRunTickets.SUB_PENDING) return DecisionPlan.Refuse("not_pending")')).toBeGreaterThan(-1);
    expect(plan.indexOf('UserDecision.DENY')).toBeLessThan(plan.indexOf('if (halted) return DecisionPlan.Refuse("halted")'));
    expect(core).toContain('entry != null && entry.origin == IngressOrigin.LAUNCHER && entry.enabled && s.certDigest in entry.pins');
  });

  it('the tainted invariant is unchanged: a rule / the switch never approves tainted input', () => {
    expect(kt('LauncherIngressCore.kt')).toContain('val ruleId = if (taint.tainted) null else f.matchRule(principal.wire)');
    expect(kt('McpRunTickets.kt')).toContain('!(s.untrusted && s.approvedVia != null && s.approvedVia != "user")');
  });
});

describe('background notification (P2-A1 (b))', () => {
  it('the Provider hands a pending submission to the notifier, which posts off the Binder thread and carries no text', () => {
    const provider = kt('LauncherIngressProvider.kt');
    expect(provider).toContain('if (answer.s.state == McpRunTickets.SUB_PENDING) LauncherApprovalNotifier.onPending(ctx)');
    const n = kt('LauncherApprovalNotifier.kt');
    expect(n).toContain('Executors.newSingleThreadExecutor');
    expect(n).toMatch(/fun onPending\(context: Context\) \{[\s\S]*executor\.execute \{[\s\S]*if \(!AgentAddHandoff\.isForeground\(\)\) post\(app\)/);
    expect(n).toContain('setTimeoutAfter(LauncherIngressLimits.APPROVAL_WINDOW_MS)');
    expect(n).toContain('.setVisibility(Notification.VISIBILITY_PRIVATE)');
    expect(n).not.toMatch(/Submission|submissionText|readSubmission|\.text\b/);
    // Cancelled when nothing is pending (after a decision or an expiry).
    expect(n).toContain('if (McpRunTickets.pendingTotal(app) == 0) cancel(app)');
  });

  it('the review strings exist in English and Japanese', () => {
    const res = path.join(ROOT, 'modules/terminal-emulator/android/src/main/res');
    for (const dir of ['values', 'values-ja']) {
      const xml = fs.readFileSync(path.join(res, dir, 'launcher_ingress_strings.xml'), 'utf8');
      for (const k of ['launcher_review_channel_name', 'launcher_review_channel_description', 'launcher_review_notification_title', 'launcher_review_notification_body', 'launcher_review_rule_label']) {
        expect({ dir, k, has: xml.includes(`name="${k}"`) }).toEqual({ dir, k, has: true });
      }
    }
  });
});

describe('states: consumed and stale (§3, R7)', () => {
  const tickets = kt('McpRunTickets.kt');
  const core = kt('LauncherSubmissionCore.kt');

  it('consumed is a stored state; stale is derived from the approval time and never written', () => {
    expect(tickets).toContain('const val SUB_CONSUMED = "consumed"');
    expect(tickets).toContain('val SUBMISSION_STATES: Set<String> = setOf(SUB_PENDING, SUB_APPROVED, SUB_DENIED_BY_USER, SUB_EXPIRED, SUB_CONSUMED)');
    expect(tickets).not.toMatch(/SUB_STALE|"stale"\)/);
    expect(core).toContain('now - (cur.decidedAt ?: cur.acceptedAt) > LauncherIngressLimits.STALE_AFTER_MS');
    expect(tickets).toMatch(/fun withConsumed\(s: Submission, now: Long\): Submission\? \{\s+if \(LauncherSubmissionCore\.viewState\(s, now\) != SUB_APPROVED\) return null/);
  });

  it('retention is the inbox one (50 / 7 days, no deletion at 24 h stale), not the run tickets 24 h', () => {
    const prune = tickets.slice(tickets.indexOf('fun submissionsToPrune('), tickets.indexOf('// I/O (device only)'));
    expect(prune).toContain('LauncherIngressLimits.INBOX_MAX_AGE_MS');
    expect(prune).toContain('LauncherIngressLimits.INBOX_MAX_RECORDS');
    expect(prune).not.toMatch(/RETENTION_MS\)|MAX_PER_PRINCIPAL/);
  });

  it('submissions still never count as live runs or go through the run stale rule', () => {
    const live = tickets.slice(tickets.indexOf('fun liveCount('), tickets.indexOf('fun liveCount(') + 400);
    expect(live).not.toMatch(/SUB_|Submission/);
    const stale = tickets.slice(tickets.indexOf('fun applyStale('), tickets.indexOf('fun withCancelled('));
    expect(stale).not.toMatch(/SUB_|Submission/);
  });

  it('the text is deleted once nobody may read it (denied, expired, consumed)', () => {
    expect(core).toContain('DecisionPlan.Write(next, "launcher_submit_user_denied", "denied_user", addRule = false, dropText = true)');
    expect(tickets).toMatch(/afterExpired[\s\S]*submissionTextFile\(context, s\.id\)\.delete\(\)/);
    expect(kt('LauncherSubmissions.kt')).toContain('McpRunTickets.SubmissionChange.Rewrite(n, true) { line("consumed") }');
  });
});

describe('the D2 reader (§4)', () => {
  const core = kt('LauncherSubmissionCore.kt');
  const io = kt('LauncherSubmissions.kt');
  const consumer = kt('McpTypedOpConsumer.kt');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const server = require('../scripts/shelly-mcp-server.js');
  const OPS = ['get_launcher_submission', 'list_launcher_submissions', 'mark_launcher_submission_consumed'];

  it('listed only with typed ops; routed to the native typed-op consumer; no approval tap', () => {
    for (const op of OPS) {
      expect(server.TYPED_OP_TOOLS.has(op)).toBe(true);
      expect(server.TYPED_REQUEST_TOOLS.has(op)).toBe(true);
      expect(server.APPROVAL_TOOLS.has(op)).toBe(false);
      expect(server.requestDirName(op)).toBe('typed-requests');
      expect(server.availableTools({ exec: true }).map((t: { name: string }) => t.name)).not.toContain(op);
      const tool = server.TOOLS.find((t: { name: string }) => t.name === op);
      expect(tool.inputSchema.additionalProperties).toBe(false);
    }
    expect(server.TOOLS.find((t: { name: string }) => t.name === 'get_launcher_submission').inputSchema.properties.submissionId.pattern).toBe('^ls_[0-9a-f]{32}$');
    expect(server.TOOLS.find((t: { name: string }) => t.name === 'list_launcher_submissions').inputSchema.properties.limit).toMatchObject({ type: 'integer', minimum: 1, maximum: 50 });
    // The script and its APK asset stay byte-identical.
    expect(read('modules/terminal-emulator/android/src/main/assets/shelly-mcp-server.js')).toBe(read('scripts/shelly-mcp-server.js'));
  });

  it('the consumer answers reader ops itself (never a handoff), before run_agent\'s decision', () => {
    const proc = consumer.slice(consumer.indexOf('private fun process(name: String'), consumer.indexOf('private fun refuse('));
    expect(proc.indexOf('request.tool in LauncherSubmissionCore.READER_OPS')).toBeGreaterThan(-1);
    expect(proc.indexOf('request.tool in LauncherSubmissionCore.READER_OPS')).toBeLessThan(proc.indexOf('McpTypedOpDecision.decide(request, steps, now)'));
    const reader = consumer.slice(consumer.indexOf('private fun processSubmissionReader('), consumer.indexOf('private val readerSteps'));
    expect(reader).not.toMatch(/handOff|matchRule|McpAlwaysAllowStore/);
    expect(reader).toContain('readerSteps.halted() -> LauncherSubmissionCore.HALTED');
    expect(reader).toContain('McpTypedOpDecision.isExpired(request.receivedAtMs, System.currentTimeMillis()) -> LauncherSubmissionCore.EXPIRED');
  });

  it('the text only for approved, and only after its audit line was written', () => {
    const item = core.slice(core.indexOf('fun readerItem('), core.indexOf('fun okResult('));
    expect(item).toMatch(/if \(state == McpRunTickets\.SUB_APPROVED\) \{[\s\S]*if \(text != null\) o\.put\("instruction_text", text\)[\s\S]*\} else \{\s+o\.put\("reason", reasonFor\(state\)\)/);
    expect((core.match(/"instruction_text"/g) ?? []).length).toBe(1);
    const get = io.slice(io.indexOf('is LauncherSubmissionCore.ReaderArgs.Get -> McpRunTickets.submissionUpdate'), io.indexOf('is LauncherSubmissionCore.ReaderArgs.Consume -> {'));
    expect(get.indexOf('!line("ok_text")')).toBeLessThan(get.indexOf('readerItem(cur, now, t)'));
    // Any other state is answered with null text.
    expect(get).toContain('readerItem(cur, now, null)');
    // A list never carries text.
    const list = core.slice(core.indexOf('fun listData('), core.indexOf('fun consumeData('));
    expect(list).toContain('readerItem(s, now, null)');
    expect(core.slice(core.indexOf('fun consumeData('))).toContain('readerItem(s, now, null)');
  });

  it('consumed is idempotent per id and never returns the text', () => {
    const consume = io.slice(io.indexOf('is LauncherSubmissionCore.ReaderArgs.Consume -> {'), io.indexOf('} catch (e: Exception) {\n            Log.w(TAG, "reader failed'));
    expect(consume).toMatch(/cur\.state == McpRunTickets\.SUB_CONSUMED ->\s+Pair\(Reply\("already_consumed"/);
    expect(consume).not.toMatch(/text\(\)/);
  });

  it('every reader answer is audited with principal, submission id and code only (fail closed)', () => {
    expect(io).toContain('if (!reply.audited && !line(reply.code)) {');
    const writer = kt('IngressAuditWriter.kt');
    expect(writer).toContain('"launcher_submission_get", "launcher_submission_list", "launcher_submission_consume"');
    const b = writer.slice(writer.indexOf('fun buildSubmissionReaderLine('), writer.indexOf('fun appendSubmissionReaderLine('));
    expect(b).toContain('fun buildSubmissionReaderLine(ts: Long, kind: String, principal: String?, submissionId: String?, code: String, count: Int?)');
    expect(b).not.toMatch(/text|correlation/i);
  });
});
