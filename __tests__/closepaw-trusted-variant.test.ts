/**
 * Shelly-trusted ClosePaw variant (2026-10-14): caller token only for the
 * pinned build, and a Shelly approval in front of `shelly closepaw` when the
 * variant (which skips ClosePaw's own dialog) is installed.
 */
jest.mock('@/lib/i18n', () => ({
  t: (key: string) => key,
  tFor: (locale: string, key: string) => `${locale}:${key}`,
}));

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn } from 'child_process';
import { parseAgentCtlLine, agentCtlResultFileName } from '@/lib/agent-add-queue';
import { __setAgentAddCryptoForTests } from '@/lib/agent-add-approval';
import { closePawShellHash8, parseClosePawShellPendingList } from '@/lib/closepaw-shell-approval';

const root = path.resolve(__dirname, '..');
const read = (p: string) => fs.readFileSync(path.join(root, p), 'utf8');
const KT = 'modules/terminal-emulator/android/src/main/java/expo/modules/terminalemulator';
const handoff = read(`${KT}/ClosePawHandoff.kt`);
const approvals = read(`${KT}/ClosePawShellApprovals.kt`);
const NOW = 1_760_000_000_000;
const REQ = `${NOW}-0123abcd`;

beforeAll(() => {
  __setAgentAddCryptoForTests({
    sha256Hex: async (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex'),
    randomBytes: (n) => new Uint8Array(crypto.randomBytes(n)),
  });
});

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

describe('caller token: only for the pinned variant', () => {
  it('pins the variant certificate and checks it with hasSigningCertificate(CERT_INPUT_SHA256)', () => {
    expect(handoff).toContain(
      'const val VARIANT_CERT_SHA256 = "D5:F4:39:23:A8:F6:0E:D3:41:82:02:DB:8D:77:47:11:0B:F6:91:47:99:54:DB:9B:31:E1:AC:FC:F2:74:72:58"',
    );
    const check = fn(handoff, 'fun isTrustedVariantInstalled(');
    expect(check).toContain('if (Build.VERSION.SDK_INT < Build.VERSION_CODES.P) return false');
    expect(check).toContain('hasSigningCertificate(');
    expect(check).toContain('PACKAGE,');
    expect(check).toContain('android.content.pm.PackageManager.CERT_INPUT_SHA256');
    expect(check).toContain('.getOrDefault(false)');
  });

  it('attaches the token only when the variant is verified; keeps the explicit component', () => {
    const build = fn(handoff, 'fun buildIntent(goal: String, context: Context? = null)');
    expect(build).toContain('component = ComponentName(PACKAGE, ACTIVITY)');
    expect(build).toMatch(/if \(context != null && isTrustedVariantInstalled\(context\)\) \{\s*putExtra\(EXTRA_CALLER_TOKEN, callerToken\(context\.applicationContext\)\)/);
    expect(handoff).toContain('const val EXTRA_CALLER_TOKEN = "shelly_caller_token"');
    const token = fn(handoff, 'private fun callerToken(');
    expect(token).toContain('PendingIntent.getBroadcast(');
    expect(token).toContain('Intent(CALLER_TOKEN_ACTION).setPackage(context.packageName)');
    expect(token).toContain('PendingIntent.FLAG_IMMUTABLE');
    expect(handoff).toContain('const val CALLER_TOKEN_ACTION = "dev.shelly.terminal.CLOSEPAW_TOKEN"');
    // Every launch builds with the context (token for the variant only).
    expect(fn(handoff, 'fun launch(context: Context, goal: String)')).toContain('val intent = buildIntent(clean, context)');
  });

  it('the installed-probe never builds a token', () => {
    expect(read(`${KT}/TerminalEmulatorModule.kt`)).toContain('ClosePawHandoff.buildIntent("probe").resolveActivity(context.packageManager)');
  });
});

describe('`shelly closepaw` needs a Shelly approval when the variant is installed', () => {
  it('handleLine registers an approval instead of launching for the variant; official ClosePaw unchanged', () => {
    const handle = fn(handoff, 'fun handleLine(');
    const variant = handle.indexOf('} else if (isTrustedVariantInstalled(context.applicationContext)) {');
    const launchCall = handle.indexOf('launch(context.applicationContext, parsed.goal)');
    expect(variant).toBeGreaterThan(0);
    expect(launchCall).toBeGreaterThan(variant);
    const branch = handle.slice(variant, launchCall);
    expect(branch).toContain('ClosePawShellApprovals.create(');
    expect(branch).toContain('Result(true, "approval-required"');
    expect(branch).not.toContain('launch(');
  });

  it('approvals: process memory only, single use, expiry, nonce/hash checks, attempt cap, launch only after', () => {
    expect(approvals).toContain('private val pending = ConcurrentHashMap<String, Pending>()');
    expect(approvals).not.toMatch(/SharedPreferences|writeText\(|File\(/);
    const resolve = fn(approvals, 'fun resolve(');
    const launchAt = resolve.indexOf('ClosePawHandoff.launch(');
    for (const guard of ['if (p.consumed)', 'if (now > p.expiresAt)', 'constantTimeEquals(secret, if (decision == "approve") p.approveNonce else p.rejectNonce)', 'if (p.attempts >= MAX_ATTEMPTS)', 'MIN_ATTEMPT_INTERVAL_MS', 'p.consumed = true']) {
      const at = resolve.indexOf(guard);
      expect(at).toBeGreaterThan(-1);
      expect(at).toBeLessThan(launchAt);
    }
    expect(approvals).toContain('const val TTL_MS = 10L * 60L * 1000L');
  });

  it('notification: Approve needs device unlock (API 31+ only), private with a title-only public version', () => {
    const post = fn(approvals, 'private fun postNotification(');
    expect(post).toContain('if (requireAuth && Build.VERSION.SDK_INT >= 31) b.setAuthenticationRequired(true)');
    expect(post).toMatch(/if \(Build\.VERSION\.SDK_INT >= 31\) \{\s*builder\.addAction\(\s*action\(context\.getString\(R\.string\.agent_add_action_approve\), viewIntent\("\$base&decision=approve&nonce=\$\{p\.approveNonce\}", REQUEST_CODE_APPROVE\), true\)/);
    expect(post).toContain('.setVisibility(Notification.VISIBILITY_PRIVATE)');
    expect(post).toContain('.setPublicVersion(publicVersion)');
  });

  it('hash8 parity: TS mirror == the native formula', async () => {
    const goal = '  Open Chrome and\nsearch Tokyo weather ';
    const expected = crypto.createHash('sha256').update('shelly-closepaw-shell-v1\nOpen Chrome and search Tokyo weather', 'utf8').digest('hex').slice(0, 8);
    await expect(closePawShellHash8(goal)).resolves.toBe(expected);
    expect(approvals).toContain('"shelly-closepaw-shell-v1\\n" + ClosePawHandoff.sanitizeGoal(goal)');
  });

  it('ChatGPT confirm: ctl ops parse strictly, the setting gates approve, an audit notification follows', () => {
    const ctl = `${NOW}-89abcdef`;
    expect(parseAgentCtlLine(`agentctl:${ctl}:${NOW}:closepaw-confirm:${REQ}:0a1b2c3d`, NOW)).toEqual({ ctlId: ctl, op: 'closepaw-confirm', reqId: REQ, hashPrefix: '0a1b2c3d' });
    expect(parseAgentCtlLine(`agentctl:${ctl}:${NOW}:closepaw-reject:${REQ}`, NOW)).toEqual({ ctlId: ctl, op: 'closepaw-reject', reqId: REQ });
    expect(parseAgentCtlLine(`agentctl:${ctl}:${NOW}:closepaw-confirm:${REQ}`, NOW)).toBeNull();
    const lib = read('lib/closepaw-shell-approval.ts');
    const ctlFn = fn(lib, 'export async function handleClosePawShellCtl(');
    const gate = ctlFn.indexOf("useSettingsStore.getState().settings.agentApproveFromChatGpt === false");
    const call = ctlFn.indexOf("resolveClosePawShellApproval(reqId, op, 'chatgpt', hash8)");
    expect(gate).toBeGreaterThan(0);
    expect(call).toBeGreaterThan(gate);
    expect(ctlFn).toContain('postAgentAddAuditNotification');
    expect(read('lib/agent-add-flow.ts')).toContain("if (ctl.op === 'closepaw-confirm') return handleClosePawShellCtl('approve', ctl.reqId, ctl.hashPrefix);");
  });

  it('in-app chat OK and the notification deep link (handled before URL logging)', () => {
    const dispatch = read('hooks/use-ai-pane-dispatch.ts');
    expect(dispatch).toContain("isConfirmPhrase(userText) ? 'approve' : 'reject'");
    expect(dispatch).toContain('const pendingShell = last?.role === \'assistant\' ? last.pendingClosePawShell : undefined;');
    const layout = read('app/_layout.tsx');
    expect(layout.indexOf("target === 'closepaw-decision'")).toBeGreaterThan(0);
    expect(layout.indexOf("target === 'closepaw-decision'")).toBeLessThan(layout.indexOf('`received: ${url}'));
    expect(fs.existsSync(path.join(root, 'app/closepaw-decision.tsx'))).toBe(true);
    expect(parseClosePawShellPendingList(JSON.stringify([{ reqId: REQ, goal: 'g', hash8: '0a1b2c3d', expiresAt: 1 }, { reqId: 'x', goal: 'g', hash8: 'z' }]))).toHaveLength(1);
  });
});

// ── Generated shim ─────────────────────────────────────────────────────────

function unescapeKotlin(lit: string): string {
  let out = '';
  for (let i = 0; i < lit.length; i++) {
    const ch = lit[i];
    if (ch === '\\' && i + 1 < lit.length) {
      const nx = lit[++i];
      out += nx === 'n' ? '\n' : nx === 't' ? '\t' : nx;
      continue;
    }
    if (ch === '$' && /[A-Za-z{]/.test(lit[i + 1] ?? '')) throw new Error(`unescaped Kotlin template: ${lit}`);
    out += ch;
  }
  return out;
}

function extractShimJs(): string {
  const lines = read(`${KT}/HomeInitializer.kt`).split(/\r?\n/);
  const body: string[] = [];
  let on = false;
  for (const line of lines) {
    const m = line.match(/^\s*sb\.appendLine\("(.*)"\)\s*$/);
    if (!m) continue;
    if (!on && m[1] === "const fs = require('fs');") on = true;
    if (!on) continue;
    const text = unescapeKotlin(m[1]);
    if (text === 'SHELLY_HELPER_NODE') break;
    body.push(text);
  }
  return body.join('\n') + '\n';
}

describe('generated shim: shelly closepaw confirm / reject', () => {
  let tmp: string;
  let shimPath: string;
  let home: string;
  beforeAll(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'shelly-cp-'));
    shimPath = path.join(tmp, 'shim.js');
    fs.writeFileSync(shimPath, extractShimJs());
  });
  afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(tmp, 'home-'));
  });

  function run(args: string[], app?: (home: string) => void) {
    return new Promise<{ code: number | null; out: string; err: string }>((resolve) => {
      const child = spawn(process.execPath, [shimPath, ...args], { env: { ...process.env, HOME: home } });
      let out = '';
      let err = '';
      child.stdout.on('data', (b) => (out += b));
      child.stderr.on('data', (b) => (err += b));
      const timer = app ? setInterval(() => app(home), 50) : null;
      child.on('close', (code) => {
        if (timer) clearInterval(timer);
        resolve({ code, out, err });
      });
    });
  }

  it('confirm relays the goal hash via the ctl queue and prints the answer', async () => {
    let line = '';
    const r = await run(['closepaw', 'confirm', REQ, '0A1B2C3D'], (h) => {
      for (const n of fs.readdirSync(h)) {
        const m = /^\.shelly-agent-ctl-([0-9]+-[0-9a-f]{8})$/.exec(n);
        if (!m) continue;
        line = fs.readFileSync(path.join(h, n), 'utf8');
        fs.unlinkSync(path.join(h, n));
        fs.writeFileSync(path.join(h, agentCtlResultFileName(m[1])), JSON.stringify({ ok: true, code: 'sent', message: 'Approved (chatgpt) — handed off to ClosePaw' }));
      }
    });
    expect(r.code).toBe(0);
    expect(line).toMatch(new RegExp(`^agentctl:[0-9]+-[0-9a-f]{8}:[0-9]+:closepaw-confirm:${REQ}:0a1b2c3d\\n$`));
    expect(r.out).toContain('handed off to ClosePaw');
    // Never a ClosePaw request file for a confirm.
    expect(fs.readdirSync(home).filter((n) => n.startsWith('.shelly-closepaw-req-'))).toEqual([]);
  }, 30_000);

  it('reject relays without a hash; refusals exit 1', async () => {
    const r = await run(['closepaw', 'reject', REQ], (h) => {
      for (const n of fs.readdirSync(h)) {
        const m = /^\.shelly-agent-ctl-([0-9]+-[0-9a-f]{8})$/.exec(n);
        if (!m) continue;
        expect(fs.readFileSync(path.join(h, n), 'utf8')).toMatch(/:closepaw-reject:[0-9]+-[0-9a-f]{8}\n$/);
        fs.unlinkSync(path.join(h, n));
        fs.writeFileSync(path.join(h, agentCtlResultFileName(m[1])), JSON.stringify({ ok: false, code: 'invalid', message: 'shelly closepaw: no pending request with that id' }));
      }
    });
    expect(r.code).toBe(1);
    expect(r.err).toContain('no pending request');
  }, 30_000);

  it('validates confirm arguments; a goal that merely starts with "confirm" stays a goal', async () => {
    expect((await run(['closepaw', 'confirm', REQ])).code).toBe(1);
    expect((await run(['closepaw', 'confirm', REQ, 'K7QX9M'])).code).toBe(1);
    // "confirm my booking" is not a ctl (no request id) → queued as a ClosePaw goal.
    const child = spawn(process.execPath, [shimPath, 'closepaw', 'confirm', 'my', 'booking'], { env: { ...process.env, HOME: home } });
    let name: string | undefined;
    for (let i = 0; i < 100 && !name; i++) {
      await new Promise((res) => setTimeout(res, 50));
      name = fs.readdirSync(home).find((n) => /^\.shelly-closepaw-req-[0-9]+-[0-9a-f]{8}$/.test(n));
    }
    child.kill();
    expect(name).toBeDefined();
  }, 30_000);
});
